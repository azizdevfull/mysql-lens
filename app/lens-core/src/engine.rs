//! The backend behind the UI: connections, schema, data pages, queries and edits.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mysql_async::prelude::*;
use mysql_async::{Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, SslOpts};
use serde_json::Value as J;
use tokio::sync::Mutex;

use crate::error::{msg, LensError, Result};
use crate::splitter::split_sql;
use crate::store::{secret_key, ConnStore, SecretStore};
use crate::tunnel::{open_tunnel, Tunnel};
use crate::types::*;
use crate::value::{cell_literal, column_from_field, qid, qualified, to_cell};

const SYSTEM_DBS: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

struct Session {
    pool: Pool,
    _tunnel: Option<Tunnel>,
}

pub struct Engine {
    store: ConnStore,
    secrets: Arc<dyn SecretStore>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Passwords typed at connect time for connections that do not save them.
    pub max_rows: usize,
}

fn numeric_type(data_type: &str) -> bool {
    matches!(data_type.to_ascii_lowercase().as_str(), "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal" | "numeric" | "float" | "double" | "real" | "year")
}

fn parse_enum(column_type: &str) -> Option<Vec<String>> {
    let lower = column_type.to_ascii_lowercase();
    if !(lower.starts_with("enum(") || lower.starts_with("set(")) {
        return None;
    }
    let inner = &column_type[column_type.find('(')? + 1..column_type.rfind(')')?];
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let chars: Vec<char> = inner.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_q {
            if c == '\'' && chars.get(i + 1) == Some(&'\'') {
                cur.push('\'');
                i += 1;
            } else if c == '\'' {
                in_q = false;
                out.push(std::mem::take(&mut cur));
            } else {
                cur.push(c);
            }
        } else if c == '\'' {
            in_q = true;
        }
        i += 1;
    }
    Some(out)
}

fn s(row: &Row, i: usize) -> String {
    match row.as_ref(i) {
        Some(mysql_async::Value::Bytes(b)) => String::from_utf8_lossy(b).into_owned(),
        Some(mysql_async::Value::Int(n)) => n.to_string(),
        Some(mysql_async::Value::UInt(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn opt_s(row: &Row, i: usize) -> Option<String> {
    match row.as_ref(i) {
        None | Some(mysql_async::Value::NULL) => None,
        _ => Some(s(row, i)),
    }
}

fn u(row: &Row, i: usize) -> u64 {
    s(row, i).parse().unwrap_or(0)
}

impl Engine {
    pub fn new(store: ConnStore, secrets: Arc<dyn SecretStore>) -> Self {
        Self { store, secrets, sessions: Mutex::new(HashMap::new()), max_rows: 5000 }
    }

    /* ----------------------------- connections ----------------------------- */

    pub fn list_connections(&self) -> Vec<Connection> {
        self.store.list()
    }

    pub async fn save_connection(&self, mut c: Connection, password: Option<String>) -> Result<Connection> {
        if c.id.is_empty() {
            c.id = uuid::Uuid::new_v4().to_string();
        }
        if c.name.trim().is_empty() {
            c.name = format!("{}@{}", c.user, c.host);
        }
        let mut all = self.store.list();
        match all.iter_mut().find(|x| x.id == c.id) {
            Some(x) => *x = c.clone(),
            None => all.push(c.clone()),
        }
        self.store.write(&all)?;
        // An empty password while editing means "keep the saved one".
        if let Some(p) = password.filter(|p| !p.is_empty()) {
            self.secrets.set(&secret_key("password", &c.id), Some(&p));
        }
        self.disconnect(&c.id).await;
        Ok(c)
    }

    pub async fn delete_connection(&self, id: &str) -> Result<()> {
        self.disconnect(id).await;
        let all: Vec<Connection> = self.store.list().into_iter().filter(|c| c.id != id).collect();
        self.store.write(&all)?;
        for k in ["password", "sshPassword", "sshPassphrase"] {
            self.secrets.set(&secret_key(k, id), None);
        }
        Ok(())
    }

    pub fn set_secret(&self, id: &str, kind: &str, value: Option<&str>) {
        self.secrets.set(&secret_key(kind, id), value.filter(|v| !v.is_empty()));
    }

    fn config(&self, id: &str) -> Result<Connection> {
        self.store.get(id).ok_or_else(|| msg("Connection no longer exists."))
    }

    async fn build(&self, c: &Connection, password: Option<String>) -> Result<(Opts, Option<Tunnel>)> {
        let password = password.or_else(|| self.secrets.get(&secret_key("password", &c.id)));
        let timeout = Duration::from_secs(10);
        let tunnel = match &c.ssh {
            Some(ssh) => Some(
                open_tunnel(
                    ssh,
                    self.secrets.get(&secret_key("sshPassword", &c.id)).as_deref(),
                    self.secrets.get(&secret_key("sshPassphrase", &c.id)).as_deref(),
                    &c.host,
                    c.port,
                    timeout,
                )
                .await?,
            ),
            None => None,
        };
        let (host, port) = match &tunnel {
            Some(t) => ("127.0.0.1".to_string(), t.local_port),
            None => (c.host.clone(), c.port),
        };
        let mut init = vec!["SET NAMES utf8mb4".to_string()];
        if c.read_only == Some(true) {
            init.push("SET SESSION TRANSACTION READ ONLY".into());
        }
        let mut b = OptsBuilder::default()
            .ip_or_hostname(host)
            .tcp_port(port)
            .user(Some(c.user.clone()))
            .pass(password)
            .db_name(c.database.clone().filter(|d| !d.is_empty()))
            .init(init)
            .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(0, 4).unwrap()).with_inactive_connection_ttl(Duration::from_secs(60)))
            .prefer_socket(false);
        if c.ssl == Some(true) {
            b = b.ssl_opts(SslOpts::default());
        }
        Ok((Opts::from(b), tunnel))
    }

    pub async fn test_connection(&self, c: Connection, password: Option<String>) -> Result<String> {
        let (opts, _tunnel) = self.build(&c, password.filter(|p| !p.is_empty())).await?;
        let mut conn = tokio::time::timeout(Duration::from_secs(10), Conn::new(opts)).await.map_err(|_| msg("Connection timed out. Check host, port and firewall."))??;
        let v: Option<String> = conn.query_first("SELECT VERSION()").await?;
        let _ = conn.disconnect().await;
        Ok(v.unwrap_or_default())
    }

    async fn session(&self, id: &str) -> Result<Arc<Session>> {
        if let Some(s) = self.sessions.lock().await.get(id) {
            if s._tunnel.as_ref().map(|t| !t.is_closed()).unwrap_or(true) {
                return Ok(s.clone());
            }
        }
        let c = self.config(id)?;
        let (opts, tunnel) = self.build(&c, None).await?;
        let pool = Pool::new(opts);
        // Fail fast with a useful message instead of on the first query.
        let mut conn = tokio::time::timeout(Duration::from_secs(10), pool.get_conn()).await.map_err(|_| msg("Connection timed out. Check host, port and firewall."))??;
        conn.query_drop("SELECT 1").await?;
        drop(conn);
        let s = Arc::new(Session { pool, _tunnel: tunnel });
        self.sessions.lock().await.insert(id.to_string(), s.clone());
        Ok(s)
    }

    pub async fn connect(&self, id: &str) -> Result<()> {
        self.session(id).await.map(|_| ())
    }

    pub async fn disconnect(&self, id: &str) {
        if let Some(s) = self.sessions.lock().await.remove(id) {
            let _ = s.pool.clone().disconnect().await;
        }
    }

    async fn conn(&self, id: &str, db: Option<&str>) -> Result<Conn> {
        let s = self.session(id).await?;
        let mut conn = s.pool.get_conn().await?;
        if let Some(db) = db.filter(|d| !d.is_empty()) {
            conn.query_drop(format!("USE {}", qid(db))).await?;
        }
        Ok(conn)
    }

    /* ----------------------------- schema ----------------------------- */

    pub async fn databases(&self, id: &str) -> Result<Vec<String>> {
        let mut conn = self.conn(id, None).await?;
        let dbs: Vec<String> = conn.query("SHOW DATABASES").await?;
        Ok(dbs.into_iter().filter(|d| !SYSTEM_DBS.contains(&d.to_ascii_lowercase().as_str())).collect())
    }

    pub async fn objects(&self, id: &str, db: &str) -> Result<DbObjects> {
        let mut conn = self.conn(id, None).await?;
        let rows: Vec<Row> = conn
            .exec("SELECT TABLE_NAME, TABLE_TYPE, COALESCE(TABLE_ROWS,0), COALESCE(DATA_LENGTH,0)+COALESCE(INDEX_LENGTH,0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", (db,))
            .await?;
        let tables = rows
            .iter()
            .map(|r| TableMeta { name: s(r, 0), kind: if s(r, 1).contains("VIEW") { "view".into() } else { "table".into() }, rows: u(r, 2), bytes: u(r, 3) })
            .collect();
        let routines: Vec<Row> = conn.exec("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME", (db,)).await?;
        let triggers: Vec<String> = conn.exec("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME", (db,)).await?;
        Ok(DbObjects {
            tables,
            routines: routines.iter().map(|r| Routine { name: s(r, 0), kind: s(r, 1).to_ascii_lowercase() }).collect(),
            triggers,
        })
    }

    async fn columns_with(&self, conn: &mut Conn, db: &str, table: Option<&str>) -> Result<Vec<(String, Column)>> {
        let sql = "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND (? IS NULL OR TABLE_NAME = ?) ORDER BY TABLE_NAME, ORDINAL_POSITION";
        let rows: Vec<Row> = conn.exec(sql, (db, table, table)).await?;
        Ok(rows
            .iter()
            .map(|r| {
                let column_type = s(r, 2);
                let extra = s(r, 7);
                let comment = s(r, 8);
                (
                    s(r, 0),
                    Column {
                        name: s(r, 1),
                        options: parse_enum(&column_type),
                        numeric: Some(numeric_type(&s(r, 3))),
                        binary: if s(r, 3).contains("binary") || s(r, 3).contains("blob") || s(r, 3) == "bit" { Some(true) } else { None },
                        col_type: column_type,
                        nullable: Some(s(r, 4) == "YES"),
                        pk: Some(s(r, 5) == "PRI"),
                        default_value: opt_s(r, 6),
                        auto_increment: Some(extra.contains("auto_increment")),
                        comment: if comment.is_empty() { None } else { Some(comment) },
                    },
                )
            })
            .collect())
    }

    pub async fn columns(&self, id: &str, db: &str, table: &str) -> Result<Vec<Column>> {
        let mut conn = self.conn(id, None).await?;
        Ok(self.columns_with(&mut conn, db, Some(table)).await?.into_iter().map(|(_, c)| c).collect())
    }

    pub async fn schema(&self, id: &str, db: &str) -> Result<HashMap<String, Vec<Column>>> {
        let mut conn = self.conn(id, None).await?;
        let mut out: HashMap<String, Vec<Column>> = HashMap::new();
        for (t, c) in self.columns_with(&mut conn, db, None).await? {
            out.entry(t).or_default().push(c);
        }
        Ok(out)
    }

    async fn key_columns(&self, conn: &mut Conn, db: &str, table: &str, cols: &[Column]) -> Result<Vec<String>> {
        let rows: Vec<Row> = conn
            .exec("SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX", (db, table))
            .await?;
        let mut indexes: Vec<(String, bool, Vec<String>)> = Vec::new();
        for r in &rows {
            let name = s(r, 0);
            match indexes.iter_mut().find(|i| i.0 == name) {
                Some(i) => i.2.push(s(r, 2)),
                None => indexes.push((name, u(r, 1) == 0, vec![s(r, 2)])),
            }
        }
        let not_null = |c: &String| cols.iter().any(|x| &x.name == c && x.nullable == Some(false));
        Ok(indexes.into_iter().find(|(n, unique, cs)| n == "PRIMARY" || (*unique && cs.iter().all(not_null))).map(|i| i.2).unwrap_or_default())
    }

    /* ----------------------------- data ----------------------------- */

    pub async fn table_page(&self, id: &str, db: &str, table: &str, req: PageRequest) -> Result<TablePage> {
        let started = Instant::now();
        let mut conn = self.conn(id, None).await?;
        let cols = self.columns_with(&mut conn, db, Some(table)).await?.into_iter().map(|(_, c)| c).collect::<Vec<_>>();
        let is_view = {
            let t: Option<String> = conn.exec_first("SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", (db, table)).await?;
            t.map(|t| t.contains("VIEW")).unwrap_or(false)
        };
        let keys = if is_view { vec![] } else { self.key_columns(&mut conn, db, table, &cols).await? };
        let from = qualified(db, table);
        let filter = req.filter.trim();
        let wh = if filter.is_empty() { String::new() } else { format!(" WHERE {filter}") };
        let order = match &req.sort {
            Some(s) => format!(" ORDER BY {} {}", qid(&s.column), if s.dir == "desc" { "DESC" } else { "ASC" }),
            None => String::new(),
        };
        let size = req.page_size.clamp(1, 100_000);
        let sql = format!("SELECT * FROM {from}{wh}{order} LIMIT {}, {size}", req.page * size);
        let mut result = conn.query_iter(sql).await?;
        let fields = result.columns().map(|c| c.to_vec()).unwrap_or_default();
        let mut rows = Vec::new();
        while let Some(row) = result.next().await? {
            rows.push(fields.iter().enumerate().map(|(i, f)| to_cell(row.as_ref(i).unwrap_or(&mysql_async::Value::NULL), f)).collect());
        }
        drop(result);
        let total: Option<u64> = conn.query_first(format!("SELECT COUNT(*) FROM {from}{wh}")).await?;
        // Grid columns come from information_schema (full types, defaults, enum options).
        let columns = if cols.len() == fields.len() { cols } else { fields.iter().map(column_from_field).collect() };
        Ok(TablePage { columns, rows, total: total.unwrap_or(0), key_columns: keys, ms: started.elapsed().as_millis() as u64 })
    }

    /// Runs one or more statements. Stops at the first error.
    pub async fn query(&self, id: &str, db: Option<&str>, sql: &str) -> Result<Vec<ResultSet>> {
        let mut conn = self.conn(id, db).await?;
        let mut out = Vec::new();
        for st in split_sql(sql) {
            let started = Instant::now();
            match self.run_one(&mut conn, &st.sql).await {
                Ok(mut sets) => {
                    let ms = started.elapsed().as_millis() as u64;
                    for r in sets.iter_mut() {
                        r.ms = ms;
                    }
                    out.extend(sets);
                }
                Err(e) => {
                    out.push(ResultSet { kind: "error".into(), sql: st.sql, columns: vec![], rows: vec![], total_rows: 0, affected_rows: None, error: Some(e.to_string()), ms: started.elapsed().as_millis() as u64 });
                    break;
                }
            }
        }
        Ok(out)
    }

    async fn run_one(&self, conn: &mut Conn, sql: &str) -> Result<Vec<ResultSet>> {
        let mut result = conn.query_iter(sql).await?;
        let mut sets = Vec::new();
        loop {
            let fields = result.columns();
            match fields {
                Some(fields) if !fields.is_empty() => {
                    let fields = fields.to_vec();
                    let mut rows = Vec::new();
                    let mut total = 0u64;
                    while let Some(row) = result.next().await? {
                        total += 1;
                        if rows.len() < self.max_rows {
                            rows.push(fields.iter().enumerate().map(|(i, f)| to_cell(row.as_ref(i).unwrap_or(&mysql_async::Value::NULL), f)).collect());
                        }
                    }
                    sets.push(ResultSet { kind: "rows".into(), sql: sql.into(), columns: fields.iter().map(column_from_field).collect(), rows, total_rows: total, affected_rows: None, error: None, ms: 0 });
                }
                _ => {
                    let affected = result.affected_rows();
                    // Drain the (empty) set so the next one becomes current.
                    let _: Vec<Row> = result.collect().await?;
                    sets.push(ResultSet { kind: "ok".into(), sql: sql.into(), columns: vec![], rows: vec![], total_rows: 0, affected_rows: Some(affected), error: None, ms: 0 });
                }
            }
            if result.is_empty() {
                break;
            }
        }
        // A CALL ends with an OK packet after its result sets; hide it.
        if sets.len() > 1 && sets.last().map(|s| s.kind == "ok").unwrap_or(false) && sets[sets.len() - 2].kind == "rows" {
            sets.pop();
        }
        Ok(sets)
    }

    /* ----------------------------- edits ----------------------------- */

    fn change_sql(db: &str, table: &str, cols: &[Column], c: &RowChange) -> String {
        let t = qualified(db, table);
        let col = |name: &str| cols.iter().find(|c| c.name == name);
        let wh = |key: &serde_json::Map<String, Cell>| {
            key.iter().map(|(k, v)| if v.is_null() { format!("{} IS NULL", qid(k)) } else { format!("{} = {}", qid(k), cell_literal(v, col(k))) }).collect::<Vec<_>>().join(" AND ")
        };
        match c {
            RowChange::Update { key, values } => format!(
                "UPDATE {t} SET {} WHERE {} LIMIT 1;",
                values.iter().map(|(k, v)| format!("{} = {}", qid(k), cell_literal(v, col(k)))).collect::<Vec<_>>().join(", "),
                wh(key)
            ),
            RowChange::Delete { key } => format!("DELETE FROM {t} WHERE {} LIMIT 1;", wh(key)),
            RowChange::Insert { values } if values.is_empty() => format!("INSERT INTO {t} () VALUES ();"),
            RowChange::Insert { values } => format!(
                "INSERT INTO {t} ({}) VALUES ({});",
                values.keys().map(|k| qid(k)).collect::<Vec<_>>().join(", "),
                values.iter().map(|(k, v)| cell_literal(v, col(k))).collect::<Vec<_>>().join(", ")
            ),
        }
    }

    /// Exports a query (or a whole table when `sql` is empty) to a file.
    pub async fn export(&self, id: &str, db: &str, table: &str, sql: &str, format: &str, path: &std::path::Path, progress: impl FnMut(u64) -> bool) -> Result<u64> {
        let mut conn = self.conn(id, Some(db)).await?;
        let sql = if sql.trim().is_empty() { format!("SELECT * FROM {}", qualified(db, table)) } else { sql.to_string() };
        crate::export::export_query(&mut conn, &sql, crate::export::Format::parse(format)?, path, table, progress).await
    }

    pub async fn dump(&self, id: &str, o: &crate::dump::DumpOptions, path: &std::path::Path, progress: impl FnMut(&str, usize, usize, u64) -> bool) -> Result<crate::dump::DumpResult> {
        let c = self.config(id)?;
        let (opts, _tunnel) = self.build(&c, None).await?;
        // A dedicated connection: the dump changes the session time zone.
        let mut conn = Conn::new(opts).await?;
        let r = crate::dump::dump(&mut conn, o, path, progress).await;
        let _ = conn.disconnect().await;
        r
    }

    pub async fn import_sql(&self, id: &str, db: Option<&str>, path: &std::path::Path, continue_on_error: bool, progress: impl FnMut(u64, u64, u64) -> bool) -> Result<crate::dump::ImportResult> {
        let c = self.config(id)?;
        if c.read_only == Some(true) {
            return Err(msg("This connection is read-only."));
        }
        let (opts, _tunnel) = self.build(&c, None).await?;
        let mut conn = Conn::new(opts).await?;
        if let Some(db) = db.filter(|d| !d.is_empty()) {
            conn.query_drop(format!("USE {}", qid(db))).await?;
        }
        let r = crate::dump::import_sql(&mut conn, path, continue_on_error, progress).await;
        let _ = conn.disconnect().await;
        r
    }

    pub fn preview_changes(&self, db: &str, table: &str, cols: &[Column], changes: &[RowChange]) -> Vec<String> {
        changes.iter().map(|c| Self::change_sql(db, table, cols, c)).collect()
    }

    /// Applies all changes in one transaction; a missing row rolls everything back.
    pub async fn apply_changes(&self, id: &str, db: &str, table: &str, cols: &[Column], changes: &[RowChange]) -> Result<()> {
        if self.config(id)?.read_only == Some(true) {
            return Err(msg("This connection is read-only."));
        }
        let mut conn = self.conn(id, None).await?;
        let mut tx = conn.start_transaction(mysql_async::TxOpts::default()).await?;
        for (i, c) in changes.iter().enumerate() {
            let sql = Self::change_sql(db, table, cols, c);
            tx.query_drop(&sql).await.map_err(|e| msg(format!("{} (change {} of {})", LensError::from(e), i + 1, changes.len())))?;
            if !matches!(c, RowChange::Insert { .. }) && tx.affected_rows() == 0 {
                return Err(msg("Row was not found. It may have been changed or deleted by someone else. Reload and try again."));
            }
        }
        tx.commit().await?;
        Ok(())
    }
}

/// Keeps a JSON value from the UI as a plain value (helper for callers).
pub fn cell(v: impl Into<J>) -> Cell {
    v.into()
}
