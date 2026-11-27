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
    /// For dedicated connections outside the pool (manual-commit query tabs).
    opts: Opts,
    _tunnel: Option<Tunnel>,
}

/// A query tab in manual-commit mode keeps one connection with `autocommit = 0`,
/// so its uncommitted changes stay in one transaction across runs.
struct Pinned {
    conn_id: String,
    /// None while a run is using it.
    conn: Option<Conn>,
    /// Database selected with `USE` on this connection.
    db: Option<String>,
}

pub struct Engine {
    store: ConnStore,
    secrets: Arc<dyn SecretStore>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Queries in flight by run id: their connection and server thread id, and a stop flag.
    running: std::sync::Mutex<HashMap<String, Running>>,
    /// Manual-commit connections by transaction key (the query tab).
    pinned: Mutex<HashMap<String, Pinned>>,
    pub max_rows: usize,
}

struct Running {
    conn_id: String,
    thread_id: u32,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

/// Removes a run from `Engine::running` when the query ends, however it ends.
struct RunGuard<'a> {
    running: &'a std::sync::Mutex<HashMap<String, Running>>,
    run_id: Option<String>,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = &self.run_id {
            self.running.lock().unwrap().remove(id);
        }
    }
}

/// Error text shown for statements stopped by `Engine::cancel`.
pub const CANCELLED: &str = "Query cancelled.";

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
        Self { store, secrets, sessions: Mutex::new(HashMap::new()), running: std::sync::Mutex::new(HashMap::new()), pinned: Mutex::new(HashMap::new()), max_rows: 5000 }
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

    /// Writes every connection (without ids or secrets) to `path`. Returns how many were written.
    pub fn export_connections(&self, path: &std::path::Path) -> Result<usize> {
        let list = self.store.list();
        std::fs::write(path, serde_json::to_vec_pretty(&crate::conn_io::export_json(&list))?)?;
        Ok(list.len())
    }

    /// Adds the connections described in `path`, skipping ones already in the list.
    pub fn import_connections(&self, path: &std::path::Path) -> Result<crate::conn_io::ImportSummary> {
        let text = std::fs::read_to_string(path)?;
        let mut all = self.store.list();
        let mut summary = crate::conn_io::ImportSummary::default();
        for mut c in crate::conn_io::parse_import(&text)? {
            if crate::conn_io::is_duplicate(&all, &c) {
                summary.skipped += 1;
                continue;
            }
            c.id = uuid::Uuid::new_v4().to_string();
            all.push(c);
            summary.added += 1;
        }
        if summary.added > 0 {
            self.store.write(&all)?;
        }
        Ok(summary)
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
        let pool = Pool::new(opts.clone());
        // Fail fast with a useful message instead of on the first query.
        let mut conn = tokio::time::timeout(Duration::from_secs(10), pool.get_conn()).await.map_err(|_| msg("Connection timed out. Check host, port and firewall."))??;
        conn.query_drop("SELECT 1").await?;
        drop(conn);
        let s = Arc::new(Session { pool, opts, _tunnel: tunnel });
        self.sessions.lock().await.insert(id.to_string(), s.clone());
        Ok(s)
    }

    pub async fn connect(&self, id: &str) -> Result<()> {
        self.session(id).await.map(|_| ())
    }

    pub async fn disconnect(&self, id: &str) {
        // Open transactions of this connection end with it (the server rolls them back).
        let keys: Vec<String> = self.pinned.lock().await.iter().filter(|(_, p)| p.conn_id == id).map(|(k, _)| k.clone()).collect();
        for k in keys {
            self.tx_close(&k).await;
        }
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

    /* ----------------------------- relations ----------------------------- */

    /// Foreign keys declared by `db.table` and the ones in other tables that point at it.
    pub async fn foreign_keys(&self, id: &str, db: &str, table: &str) -> Result<Relations> {
        let mut conn = self.conn(id, None).await?;
        // Two queries with plain equality: information_schema in MySQL 5.7 only skips
        // reading every table's metadata when the schema and table names are constants.
        const COLS: &str = "SELECT CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE";
        const ORDER: &str = "ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION";
        let outgoing: Vec<Row> = conn.exec(format!("{COLS} WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL {ORDER}"), (db, table)).await?;
        let incoming: Vec<Row> = conn.exec(format!("{COLS} WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? {ORDER}"), (db, table)).await?;
        let rows = |rs: Vec<Row>| rs.iter().map(|r| std::array::from_fn(|i| s(r, i))).collect::<Vec<[String; 7]>>();
        Ok(Relations { outgoing: group_foreign_keys(rows(outgoing)), incoming: group_foreign_keys(rows(incoming)) })
    }

    /// Every foreign key declared by the tables of `db` (for the ER diagram).
    pub async fn db_foreign_keys(&self, id: &str, db: &str) -> Result<Vec<ForeignKey>> {
        let mut conn = self.conn(id, None).await?;
        let rows: Vec<Row> = conn
            .exec(
                "SELECT CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION",
                (db,),
            )
            .await?;
        Ok(group_foreign_keys(rows.iter().map(|r| std::array::from_fn(|i| s(r, i))).collect()))
    }

    /// Counts the rows matching each request, stopping at `cap` (so a huge table costs
    /// at most `cap` index reads). A request that fails gives `None` instead of failing all.
    pub async fn count_rows(&self, id: &str, items: &[CountRequest], cap: u64) -> Result<Vec<Option<u64>>> {
        let mut conn = self.conn(id, None).await?;
        let cap = cap.clamp(1, 1_000_000);
        let mut out = Vec::with_capacity(items.len());
        for it in items {
            let filter = it.filter.trim();
            let wh = if filter.is_empty() { String::new() } else { format!(" WHERE {filter}") };
            let sql = format!("SELECT COUNT(*) FROM (SELECT 1 FROM {}{wh} LIMIT {cap}) AS x", qualified(&it.db, &it.table));
            out.push(conn.query_first::<u64, _>(sql).await.ok().flatten());
        }
        Ok(out)
    }

    /* ----------------------------- binary values ----------------------------- */

    /// The full bytes of one cell, for values the grid only shows as "(binary N bytes)".
    pub async fn cell_bytes(&self, id: &str, db: &str, table: &str, column: &str, cols: &[Column], key: &serde_json::Map<String, Cell>) -> Result<Vec<u8>> {
        if key.is_empty() {
            return Err(msg("This row has no key, so the value cannot be read again."));
        }
        let mut conn = self.conn(id, None).await?;
        let from = qualified(db, table);
        let wh = Self::key_where(cols, key);
        let len: Option<Option<u64>> = conn.query_first(format!("SELECT LENGTH({}) FROM {from} WHERE {wh} LIMIT 1", qid(column))).await?;
        let len = len.ok_or_else(|| msg("Row was not found. Reload and try again."))?.unwrap_or(0);
        if len > MAX_CELL_BYTES {
            return Err(msg(format!("Value is {} MB; values over {} MB are not loaded.", len / 1_048_576, MAX_CELL_BYTES / 1_048_576)));
        }
        let v: Option<Option<Vec<u8>>> = conn.query_first(format!("SELECT {} FROM {from} WHERE {wh} LIMIT 1", qid(column))).await?;
        Ok(v.flatten().unwrap_or_default())
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
    /// Splits `sql` into statements and runs them in order on one connection.
    pub async fn query(&self, id: &str, db: Option<&str>, sql: &str) -> Result<Vec<ResultSet>> {
        let statements: Vec<String> = split_sql(sql).into_iter().map(|s| s.sql).collect();
        self.run_statements(id, db, &statements, None, None).await
    }

    /// Runs already split statements as they are (a procedure body keeps its `;`).
    /// With a `run_id`, `cancel(run_id)` stops it. Stops at the first error.
    /// With a `tx` key the statements run on that tab's manual-commit connection.
    pub async fn run_statements(&self, id: &str, db: Option<&str>, statements: &[String], run_id: Option<&str>, tx: Option<&str>) -> Result<Vec<ResultSet>> {
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _guard = RunGuard { running: &self.running, run_id: run_id.map(str::to_string) };
        // Registered before connecting, so a cancel during a slow connect still stops the run.
        if let Some(rid) = run_id {
            self.running.lock().unwrap().insert(rid.to_string(), Running { conn_id: id.to_string(), thread_id: 0, cancelled: cancelled.clone() });
        }
        let mut conn = match tx {
            Some(key) => self.pinned_take(id, key, db).await?,
            None => self.conn(id, db).await?,
        };
        if let Some(rid) = run_id {
            if let Some(r) = self.running.lock().unwrap().get_mut(rid) {
                r.thread_id = conn.id();
            }
        }
        let out = self.run_on(&mut conn, statements, &cancelled).await;
        if let Some(key) = tx {
            self.pinned_put(key, conn).await;
        }
        Ok(out)
    }

    async fn run_on(&self, conn: &mut Conn, statements: &[String], cancelled: &std::sync::atomic::AtomicBool) -> Vec<ResultSet> {
        let mut out = Vec::new();
        for st in statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let started = Instant::now();
            if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                out.push(ResultSet { kind: "error".into(), sql: st.to_string(), columns: vec![], rows: vec![], total_rows: 0, affected_rows: None, error: Some(CANCELLED.into()), ms: 0 });
                break;
            }
            match self.run_one(conn, st).await {
                Ok(mut sets) => {
                    let ms = started.elapsed().as_millis() as u64;
                    for r in sets.iter_mut() {
                        r.ms = ms;
                    }
                    out.extend(sets);
                }
                Err(e) => {
                    let error = if cancelled.load(std::sync::atomic::Ordering::SeqCst) { CANCELLED.to_string() } else { e.to_string() };
                    out.push(ResultSet { kind: "error".into(), sql: st.to_string(), columns: vec![], rows: vec![], total_rows: 0, affected_rows: None, error: Some(error), ms: started.elapsed().as_millis() as u64 });
                    break;
                }
            }
        }
        out
    }

    /* ----------------------------- manual commit ----------------------------- */

    /// Takes the tab's manual-commit connection (opening it on first use) and selects `db`.
    async fn pinned_take(&self, id: &str, key: &str, db: Option<&str>) -> Result<Conn> {
        let existing = {
            let mut map = self.pinned.lock().await;
            match map.get_mut(key) {
                Some(p) if p.conn_id == id => match p.conn.take() {
                    Some(c) => Some((c, p.db.clone())),
                    None => return Err(msg("A query is still running in this tab.")),
                },
                // The tab switched connections: the old transaction cannot continue.
                Some(_) => return Err(msg("This tab has an open transaction on another connection. Commit or roll it back first.")),
                None => None,
            }
        };
        let (mut conn, current) = match existing {
            Some(x) => x,
            None => {
                let s = self.session(id).await?;
                let mut conn = tokio::time::timeout(Duration::from_secs(10), Conn::new(s.opts.clone())).await.map_err(|_| msg("Connection timed out. Check host, port and firewall."))??;
                conn.query_drop("SET autocommit = 0").await?;
                self.pinned.lock().await.insert(key.to_string(), Pinned { conn_id: id.to_string(), conn: None, db: None });
                (conn, None)
            }
        };
        let want = db.filter(|d| !d.is_empty());
        if want.is_some() && want != current.as_deref() {
            if let Err(e) = conn.query_drop(format!("USE {}", qid(want.unwrap()))).await {
                self.pinned_put(key, conn).await;
                return Err(e.into());
            }
            if let Some(p) = self.pinned.lock().await.get_mut(key) {
                p.db = want.map(str::to_string);
            }
        }
        Ok(conn)
    }

    async fn pinned_put(&self, key: &str, conn: Conn) {
        match self.pinned.lock().await.get_mut(key) {
            Some(p) => p.conn = Some(conn),
            // Closed while the run was going on: end it here.
            None => drop(tokio::spawn(async move {
                let _ = conn.disconnect().await;
            })),
        }
    }

    /// Commits or rolls back the tab's transaction. The connection stays in manual-commit mode.
    pub async fn tx_end(&self, id: &str, key: &str, commit: bool) -> Result<()> {
        if !self.pinned.lock().await.contains_key(key) {
            return Ok(()); // nothing ran yet, so nothing is open
        }
        let mut conn = self.pinned_take(id, key, None).await?;
        let r = conn.query_drop(if commit { "COMMIT" } else { "ROLLBACK" }).await;
        self.pinned_put(key, conn).await;
        Ok(r?)
    }

    /// Ends the tab's manual-commit connection, rolling back anything not committed.
    pub async fn tx_close(&self, key: &str) {
        let p = self.pinned.lock().await.remove(key);
        if let Some(Pinned { conn: Some(mut conn), .. }) = p {
            let _ = conn.query_drop("ROLLBACK").await;
            let _ = conn.disconnect().await;
        }
    }

    /// Runs statements for an AI assistant (MCP). With `read_only` they run inside
    /// `START TRANSACTION READ ONLY`, so the server itself rejects any write, and the
    /// transaction is always rolled back. `cancel(run_id)` stops it like a normal run.
    pub async fn run_ai(&self, id: &str, db: Option<&str>, statements: &[String], read_only: bool, run_id: &str) -> Result<Vec<ResultSet>> {
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _guard = RunGuard { running: &self.running, run_id: Some(run_id.to_string()) };
        self.running.lock().unwrap().insert(run_id.to_string(), Running { conn_id: id.to_string(), thread_id: 0, cancelled: cancelled.clone() });
        let mut conn = self.conn(id, db).await?;
        if let Some(r) = self.running.lock().unwrap().get_mut(run_id) {
            r.thread_id = conn.id();
        }
        if read_only {
            conn.query_drop("START TRANSACTION READ ONLY").await?;
        }
        let out = self.run_on(&mut conn, statements, &cancelled).await;
        if read_only {
            // Always, so the pooled connection never goes back with the transaction open.
            let _ = conn.query_drop("ROLLBACK").await;
        }
        Ok(out)
    }

    /// Stops the run started with `run_id`: the statement executing on the server
    /// is killed (`KILL QUERY` from a second connection) and no further statements run.
    /// Returns false when that run already finished.
    pub async fn cancel(&self, run_id: &str) -> Result<bool> {
        let target = self.running.lock().unwrap().get(run_id).map(|r| {
            r.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
            (r.conn_id.clone(), r.thread_id)
        });
        let Some((conn_id, thread_id)) = target else { return Ok(false) };
        if thread_id == 0 {
            return Ok(true); // still connecting: the flag stops it before the first statement
        }
        let mut killer = self.conn(&conn_id, None).await?;
        match killer.query_drop(format!("KILL QUERY {thread_id}")).await {
            Ok(()) => Ok(true),
            // 1094 Unknown thread id: the statement ended between lookup and kill.
            Err(mysql_async::Error::Server(e)) if e.code == 1094 => Ok(true),
            Err(e) => Err(e.into()),
        }
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

    /// `a = 1 AND b IS NULL` for a row key.
    fn key_where(cols: &[Column], key: &serde_json::Map<String, Cell>) -> String {
        let col = |name: &str| cols.iter().find(|c| c.name == name);
        key.iter().map(|(k, v)| if v.is_null() { format!("{} IS NULL", qid(k)) } else { format!("{} = {}", qid(k), cell_literal(v, col(k))) }).collect::<Vec<_>>().join(" AND ")
    }

    fn change_sql(db: &str, table: &str, cols: &[Column], c: &RowChange) -> String {
        let t = qualified(db, table);
        let col = |name: &str| cols.iter().find(|c| c.name == name);
        let wh = |key: &serde_json::Map<String, Cell>| Self::key_where(cols, key);
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

    pub async fn import_data(&self, id: &str, db: &str, path: &std::path::Path, o: &crate::data_import::SourceOptions, plan: &crate::data_import::ImportPlan, progress: impl FnMut(u64) -> bool) -> Result<u64> {
        if self.config(id)?.read_only == Some(true) {
            return Err(msg("This connection is read-only."));
        }
        let mut conn = self.conn(id, None).await?;
        crate::data_import::run(&mut conn, db, path, o, plan, progress).await
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

/// Largest cell value loaded into the value editor or read from a file.
pub const MAX_CELL_BYTES: u64 = 32 * 1024 * 1024;

/// Groups `KEY_COLUMN_USAGE` rows (constraint, schema, table, column, ref schema,
/// ref table, ref column; ordered by constraint and position) into foreign keys.
pub fn group_foreign_keys(rows: Vec<[String; 7]>) -> Vec<ForeignKey> {
    let mut out: Vec<ForeignKey> = Vec::new();
    for [name, db, table, column, ref_db, ref_table, ref_column] in rows {
        match out.last_mut() {
            Some(fk) if fk.name == name && fk.db == db && fk.table == table => {
                fk.columns.push(column);
                fk.ref_columns.push(ref_column);
            }
            _ => out.push(ForeignKey { name, db, table, columns: vec![column], ref_db, ref_table, ref_columns: vec![ref_column] }),
        }
    }
    out
}

/// Keeps a JSON value from the UI as a plain value (helper for callers).
pub fn cell(v: impl Into<J>) -> Cell {
    v.into()
}

/// Tauri runs commands on a thread pool, so every engine future must be `Send`.
/// This never runs; it fails to compile if a future stops being `Send`.
#[allow(dead_code, unreachable_code, clippy::diverging_sub_expression)]
fn _futures_are_send(e: &Engine) {
    fn send<T: Send>(_: T) {}
    let p = std::path::Path::new("");
    send(e.connect(""));
    send(e.databases(""));
    send(e.objects("", ""));
    send(e.schema("", ""));
    send(e.table_page("", "", "", PageRequest { page: 0, page_size: 1, sort: None, filter: String::new() }));
    send(e.query("", None, ""));
    send(e.apply_changes("", "", "", &[], &[]));
    send(e.export("", "", "", "", "csv", p, |_| true));
    send(e.dump("", todo!(), p, |_, _, _, _| true));
    send(e.import_sql("", None, p, false, |_, _, _| true));
    send(e.import_data("", "", p, todo!(), todo!(), |_| true));
    send(e.test_connection(todo!(), None));
    send(e.save_connection(todo!(), None));
    send(e.foreign_keys("", "", ""));
    send(e.count_rows("", &[], 1));
    send(e.cell_bytes("", "", "", "", &[], todo!()));
    send(e.db_foreign_keys("", ""));
    send(e.run_statements("", None, &[], None, Some("")));
    send(e.tx_end("", "", true));
    send(e.tx_close(""));
    send(e.run_ai("", None, &[], true, ""));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(c: &str, t: &str, col: &str, rt: &str, rc: &str) -> [String; 7] {
        [c, "shop", t, col, "shop", rt, rc].map(String::from)
    }

    #[test]
    fn foreign_keys_group_by_constraint() {
        let fks = group_foreign_keys(vec![
            row("fk_line_order", "order_lines", "order_id", "orders", "id"),
            row("fk_line_order", "order_lines", "shop_id", "orders", "shop_id"),
            row("fk_line_product", "order_lines", "product_id", "products", "id"),
            // Same constraint name in another table is another key.
            row("fk_line_product", "returns", "product_id", "products", "id"),
        ]);
        assert_eq!(fks.len(), 3);
        assert_eq!(fks[0].columns, ["order_id", "shop_id"]);
        assert_eq!(fks[0].ref_columns, ["id", "shop_id"]);
        assert_eq!(fks[1].ref_table, "products");
        assert_eq!(fks[2].table, "returns");
        assert!(group_foreign_keys(vec![]).is_empty());
    }

    #[test]
    fn key_where_quotes_and_handles_null() {
        let cols = vec![Column { name: "id".into(), numeric: Some(true), ..Default::default() }, Column { name: "code".into(), ..Default::default() }];
        let mut key = serde_json::Map::new();
        key.insert("id".into(), J::from(7));
        key.insert("code".into(), J::Null);
        assert_eq!(Engine::key_where(&cols, &key), "`code` IS NULL AND `id` = 7");
    }
}
