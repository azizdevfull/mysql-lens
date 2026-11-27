//! MCP server: lets AI assistants (Claude Code, Cursor, VS Code, Zed …) use the
//! connections saved in the app, within limits the user sets.
//!
//! - Listens on 127.0.0.1 only and requires a bearer token.
//! - Each connection is off, read-only or read-write for AI. Read queries run inside
//!   `START TRANSACTION READ ONLY` (the server rejects writes) and are rolled back.
//! - Every write is shown to the user by the host (the app) and runs only if approved.
//!
//! Transport: MCP "Streamable HTTP" with plain JSON responses (no server-sent events).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as J};

use crate::engine::Engine;
use crate::error::{msg, Result};
use crate::splitter::split_sql;
use crate::types::{Connection, ResultSet};
use crate::value::qid;

/// Protocol versions this server speaks, newest first.
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// Largest request body accepted.
const MAX_BODY: usize = 1024 * 1024;
/// Longest text kept per cell in results sent to the AI.
const MAX_CELL_CHARS: usize = 2000;

/* ----------------------------- settings ----------------------------- */

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    #[default]
    Off,
    Read,
    Write,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub token: String,
    /// Access per connection id; connections not listed are off.
    #[serde(default)]
    pub access: HashMap<String, Access>,
    #[serde(default = "default_rows")]
    pub max_rows: usize,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_port() -> u16 {
    7421
}
fn default_rows() -> usize {
    200
}
fn default_timeout() -> u64 {
    30
}

impl Default for McpSettings {
    fn default() -> Self {
        Self { enabled: false, port: default_port(), token: new_token(), access: HashMap::new(), max_rows: default_rows(), timeout_secs: default_timeout() }
    }
}

/// A random 64-character token.
pub fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub struct McpSettingsStore {
    path: PathBuf,
}

impl McpSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Saved settings, or defaults (off, with a fresh token) when there are none.
    pub fn load(&self) -> McpSettings {
        let mut s: McpSettings = std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if s.token.len() < 32 {
            s.token = new_token();
        }
        s
    }

    pub fn save(&self, s: &McpSettings) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

/* ----------------------------- host ----------------------------- */

/// A write the AI wants to run, shown to the user for approval.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub client: String,
    pub conn_id: String,
    pub conn_name: String,
    pub db: Option<String>,
    pub statements: Vec<String>,
}

/// What the AI did, for the history and the activity list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub client: String,
    pub tool: String,
    pub conn_id: String,
    pub conn_name: String,
    pub db: Option<String>,
    pub sql: String,
    pub ok: bool,
    pub error: Option<String>,
    pub ms: u64,
}

/// The app side: asks the user about writes and records what happened.
#[async_trait::async_trait]
pub trait McpHost: Send + Sync {
    /// True when the user allowed the write.
    async fn approve(&self, request: Approval) -> bool;
    fn activity(&self, activity: &Activity, results: &[ResultSet]);
}

/* ----------------------------- read-only check ----------------------------- */

/// Why `sql` may not run as a read query, or None when it is one plain read statement.
pub fn read_only_problem(sql: &str) -> Option<String> {
    let statements = split_sql(sql);
    if statements.len() != 1 {
        return Some(format!("Send exactly one statement (got {}).", statements.len()));
    }
    let text = strip_comments(&statements[0].sql);
    let first = text.split(|c: char| !c.is_ascii_alphabetic()).find(|w| !w.is_empty()).unwrap_or("").to_ascii_lowercase();
    if !matches!(first.as_str(), "select" | "show" | "describe" | "desc" | "explain" | "with" | "table" | "values") {
        return Some(format!("`{}` is not a read statement. Use the execute tool to change data.", first.to_uppercase()));
    }
    // Keywords inside string literals (e.g. 'for update') do not count.
    let lower = blank_strings(&text).to_ascii_lowercase();
    let squashed: String = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    for bad in ["into outfile", "into dumpfile", "for update", "lock in share mode", "for share"] {
        if squashed.contains(bad) {
            return Some(format!("`{}` is not allowed in a read query.", bad.to_uppercase()));
        }
    }
    None
}

/// Replaces the contents of '…' and "…" literals with nothing, keeping identifiers.
fn blank_strings(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars();
    while let Some(c) = chars.next() {
        if c == '\'' || c == '"' {
            out.push(c);
            while let Some(n) = chars.next() {
                if n == '\\' {
                    chars.next();
                } else if n == c {
                    out.push(c);
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The SQL without comments (`--`, `#`, `/* */`), keeping strings intact.
fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => {
                quote = Some(c);
                out.push(c);
            }
            '#' => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        break;
                    }
                }
                out.push(' ');
            }
            '-' if chars.peek() == Some(&'-') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        break;
                    }
                }
                out.push(' ');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    out
}

/* ----------------------------- server ----------------------------- */

pub struct McpServer {
    engine: Arc<Engine>,
    settings: RwLock<McpSettings>,
    host: Arc<dyn McpHost>,
    /// Client name per session id (from `initialize`).
    sessions: Mutex<HashMap<String, String>>,
}

/// A tool call that failed in a way the AI should see (not a protocol error).
struct ToolError(String);

impl From<crate::error::LensError> for ToolError {
    fn from(e: crate::error::LensError) -> Self {
        ToolError(e.to_string())
    }
}

type ToolResult = std::result::Result<J, ToolError>;

impl McpServer {
    pub fn new(engine: Arc<Engine>, settings: McpSettings, host: Arc<dyn McpHost>) -> Arc<Self> {
        Arc::new(Self { engine, settings: RwLock::new(settings), host, sessions: Mutex::new(HashMap::new()) })
    }

    /// New permissions, limits or token take effect for the next request.
    pub fn update_settings(&self, s: McpSettings) {
        *self.settings.write().unwrap() = s;
    }

    fn settings(&self) -> McpSettings {
        self.settings.read().unwrap().clone()
    }

    /// Handles one JSON-RPC message. Returns the response (None for notifications)
    /// and, for `initialize`, the new session id.
    pub async fn handle(&self, message: &J, session: Option<&str>) -> (Option<J>, Option<String>) {
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(J::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(J::Null);
        let Some(id) = id else {
            return (None, None); // notification (e.g. notifications/initialized)
        };
        let reply = |result: std::result::Result<J, (i64, String)>| match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id.clone(), "result": r }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id.clone(), "error": { "code": code, "message": message } }),
        };
        match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(J::as_str).unwrap_or("");
                let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
                let client = params.pointer("/clientInfo/name").and_then(J::as_str).unwrap_or("AI assistant").to_string();
                let sid = uuid::Uuid::new_v4().simple().to_string();
                self.sessions.lock().unwrap().insert(sid.clone(), client);
                let result = json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "mysql-lens", "title": "MySQL Lens", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Use list_connections first. Only connections the user enabled for AI are available. Read with `query`; change data with `execute` (the user approves each write in MySQL Lens). Prefer describe_table before writing SQL against a table."
                });
                (Some(reply(Ok(result))), Some(sid))
            }
            "ping" => (Some(reply(Ok(json!({})))), None),
            "tools/list" => (Some(reply(Ok(json!({ "tools": tools() })))), None),
            "tools/call" => {
                let name = params.get("name").and_then(J::as_str).unwrap_or("").to_string();
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let client = session.and_then(|s| self.sessions.lock().unwrap().get(s).cloned()).unwrap_or_else(|| "AI assistant".into());
                let out = match self.call(&name, &args, &client).await {
                    Ok(v) => json!({ "content": [{ "type": "text", "text": text_of(&v) }], "structuredContent": v, "isError": false }),
                    Err(ToolError(e)) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                };
                (Some(reply(Ok(out))), None)
            }
            _ => (Some(reply(Err((-32601, format!("Method not found: {method}"))))), None),
        }
    }

    pub fn end_session(&self, session: &str) {
        self.sessions.lock().unwrap().remove(session);
    }

    /* ----------------------------- tools ----------------------------- */

    async fn call(&self, tool: &str, args: &J, client: &str) -> ToolResult {
        let s = self.settings();
        match tool {
            "list_connections" => {
                let list: Vec<J> = self
                    .engine
                    .list_connections()
                    .into_iter()
                    .filter_map(|c| {
                        let access = s.access.get(&c.id).copied().unwrap_or_default();
                        (access != Access::Off).then(|| {
                            json!({
                                "id": c.id,
                                "name": c.name,
                                "access": if access == Access::Write && c.read_only != Some(true) { "read-write (each write needs the user's approval)" } else { "read-only" },
                                "defaultDatabase": c.database,
                                "production": c.color == "red",
                            })
                        })
                    })
                    .collect();
                Ok(json!({ "connections": list }))
            }
            "list_databases" => {
                let (c, _) = self.connection(args, &s, Access::Read)?;
                Ok(json!({ "databases": self.engine.databases(&c.id).await? }))
            }
            "list_tables" => {
                let (c, _) = self.connection(args, &s, Access::Read)?;
                let db = self.database(args, &c)?;
                let objects = self.engine.objects(&c.id, &db).await?;
                let tables: Vec<J> = objects.tables.iter().map(|t| json!({ "name": t.name, "type": t.kind, "approxRows": t.rows })).collect();
                Ok(json!({ "database": db, "tables": tables }))
            }
            "describe_table" => {
                let (c, _) = self.connection(args, &s, Access::Read)?;
                let db = self.database(args, &c)?;
                let table = str_arg(args, "table")?;
                let columns = self.engine.columns(&c.id, &db, &table).await?;
                if columns.is_empty() {
                    return Err(ToolError(format!("Table `{db}`.`{table}` was not found.")));
                }
                let ddl = self.engine.query(&c.id, Some(&db), &format!("SHOW CREATE TABLE {}", qid(&table))).await?;
                let create = ddl.first().and_then(|r| r.rows.first()).and_then(|row| row.get(1)).and_then(J::as_str).map(str::to_string);
                let rel = self.engine.foreign_keys(&c.id, &db, &table).await.unwrap_or_default();
                let cols: Vec<J> = columns.iter().map(|c| json!({ "name": c.name, "type": c.col_type, "nullable": c.nullable, "primaryKey": c.pk, "default": c.default_value, "comment": c.comment })).collect();
                let referenced_by: Vec<J> = rel.incoming.iter().map(|f| json!({ "table": f.table, "columns": f.columns, "references": f.ref_columns })).collect();
                Ok(json!({ "database": db, "table": table, "columns": cols, "createStatement": create, "referencedBy": referenced_by }))
            }
            "query" => {
                let (c, _) = self.connection(args, &s, Access::Read)?;
                let db = self.database(args, &c).ok();
                let sql = str_arg(args, "sql")?;
                if let Some(problem) = read_only_problem(&sql) {
                    return Err(ToolError(problem));
                }
                self.run(client, "query", &c, db, vec![split_sql(&sql).remove(0).sql], true, &s).await
            }
            "execute" => {
                let (c, access) = self.connection(args, &s, Access::Read)?;
                if access != Access::Write || c.read_only == Some(true) {
                    return Err(ToolError(format!("Connection “{}” is read-only for AI. The user can allow writes in MySQL Lens → AI access (MCP).", c.name)));
                }
                let db = self.database(args, &c).ok();
                let sql = str_arg(args, "sql")?;
                let statements: Vec<String> = split_sql(&sql).into_iter().map(|s| s.sql).collect();
                if statements.is_empty() {
                    return Err(ToolError("No SQL statement given.".into()));
                }
                let request = Approval { id: uuid::Uuid::new_v4().to_string(), client: client.to_string(), conn_id: c.id.clone(), conn_name: c.name.clone(), db: db.clone(), statements: statements.clone() };
                if !self.host.approve(request).await {
                    let a = Activity { client: client.into(), tool: "execute".into(), conn_id: c.id.clone(), conn_name: c.name.clone(), db, sql: crate::history::join_statements(&statements), ok: false, error: Some("Rejected by the user".into()), ms: 0 };
                    self.host.activity(&a, &[]);
                    return Err(ToolError("The user rejected this change in MySQL Lens. Do not retry it unchanged; ask the user what to do instead.".into()));
                }
                self.run(client, "execute", &c, db, statements, false, &s).await
            }
            _ => Err(ToolError(format!("Unknown tool: {tool}"))),
        }
    }

    /// Runs statements with the timeout and row limit, reports the activity, and
    /// shapes the results for the AI.
    #[allow(clippy::too_many_arguments)]
    async fn run(&self, client: &str, tool: &str, c: &Connection, db: Option<String>, statements: Vec<String>, read_only: bool, s: &McpSettings) -> ToolResult {
        let run_id = format!("mcp-{}", uuid::Uuid::new_v4().simple());
        let started = Instant::now();
        let engine = self.engine.clone();
        let rid = run_id.clone();
        let timeout = Duration::from_secs(s.timeout_secs.clamp(1, 3600));
        let watchdog = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            let _ = engine.cancel(&rid).await;
        });
        let res = self.engine.run_ai(&c.id, db.as_deref(), &statements, read_only, &run_id).await;
        watchdog.abort();
        let timed_out = started.elapsed() >= timeout;
        let sql = crate::history::join_statements(&statements);
        let mut results = match res {
            Ok(r) => r,
            Err(e) => {
                let a = Activity { client: client.into(), tool: tool.into(), conn_id: c.id.clone(), conn_name: c.name.clone(), db, sql, ok: false, error: Some(e.to_string()), ms: started.elapsed().as_millis() as u64 };
                self.host.activity(&a, &[]);
                return Err(ToolError(e.to_string()));
            }
        };
        // A killed statement may still report success (SLEEP returns 1), so the
        // timeout itself decides: partial results are never passed on as complete.
        if timed_out {
            let stop = format!("Stopped after the {}-second limit set in MySQL Lens. Make the query cheaper (filters, LIMIT, indexes) or ask the user to raise the limit.", timeout.as_secs());
            match results.iter_mut().find(|r| r.kind == "error") {
                Some(r) => r.error = Some(stop),
                None => results.push(ResultSet { kind: "error".into(), sql: String::new(), columns: vec![], rows: vec![], total_rows: 0, affected_rows: None, error: Some(stop), ms: 0 }),
            }
        }
        let error = results.iter().find_map(|r| r.error.clone());
        let a = Activity { client: client.into(), tool: tool.into(), conn_id: c.id.clone(), conn_name: c.name.clone(), db, sql, ok: error.is_none(), error: error.clone(), ms: started.elapsed().as_millis() as u64 };
        self.host.activity(&a, &results);
        if let Some(e) = error {
            return Err(ToolError(e));
        }
        Ok(json!({ "results": results.iter().map(|r| shape(r, s.max_rows)).collect::<Vec<_>>() }))
    }

    /// The connection named in `args` (id or name), if AI may use it at least at `need`.
    fn connection(&self, args: &J, s: &McpSettings, need: Access) -> std::result::Result<(Connection, Access), ToolError> {
        let key = str_arg(args, "connection")?;
        let all = self.engine.list_connections();
        let c = all
            .iter()
            .find(|c| c.id == key)
            .or_else(|| all.iter().find(|c| c.name.eq_ignore_ascii_case(&key)))
            .cloned()
            .ok_or_else(|| ToolError(format!("No connection “{key}”. Call list_connections to see the available ones.")))?;
        let access = s.access.get(&c.id).copied().unwrap_or_default();
        if access == Access::Off || (need == Access::Write && access != Access::Write) {
            return Err(ToolError(format!("Connection “{}” is not enabled for AI. The user can enable it in MySQL Lens → AI access (MCP).", c.name)));
        }
        Ok((c, access))
    }

    /// The `database` argument, or the connection's default database.
    fn database(&self, args: &J, c: &Connection) -> std::result::Result<String, ToolError> {
        args.get("database")
            .and_then(J::as_str)
            .filter(|d| !d.trim().is_empty())
            .map(str::to_string)
            .or_else(|| c.database.clone().filter(|d| !d.is_empty()))
            .ok_or_else(|| ToolError("This connection has no default database: pass `database` (see list_databases).".into()))
    }
}

fn str_arg(args: &J, name: &str) -> std::result::Result<String, ToolError> {
    args.get(name).and_then(J::as_str).map(str::to_string).filter(|v| !v.trim().is_empty()).ok_or_else(|| ToolError(format!("Missing argument `{name}`.")))
}

/// One result set as JSON for the AI, with the row limit and long cells cut.
fn shape(r: &ResultSet, max_rows: usize) -> J {
    match r.kind.as_str() {
        "rows" => {
            let rows: Vec<Vec<J>> = r.rows.iter().take(max_rows).map(|row| row.iter().map(cut_cell).collect()).collect();
            let shown = rows.len() as u64;
            json!({
                "columns": r.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
                "rows": rows,
                "rowCount": r.total_rows,
                "truncated": r.total_rows > shown,
                "note": if r.total_rows > shown { Some(format!("Only the first {shown} of {} rows are included (limit set in MySQL Lens). Narrow the query or use LIMIT/aggregates.", r.total_rows)) } else { None },
            })
        }
        _ => json!({ "statement": r.sql, "affectedRows": r.affected_rows.unwrap_or(0) }),
    }
}

fn cut_cell(v: &J) -> J {
    match v {
        J::String(s) if s.chars().count() > MAX_CELL_CHARS => {
            let cut: String = s.chars().take(MAX_CELL_CHARS).collect();
            J::String(format!("{cut}… ({} characters in total)", s.chars().count()))
        }
        other => other.clone(),
    }
}

/// Text content for clients that do not read structured content.
fn text_of(v: &J) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

fn tools() -> J {
    let conn = json!({ "type": "string", "description": "Connection id or name from list_connections." });
    let db = json!({ "type": "string", "description": "Database (schema). Defaults to the connection's default database." });
    json!([
        {
            "name": "list_connections",
            "title": "List connections",
            "description": "MySQL/MariaDB connections the user enabled for AI in MySQL Lens, with their access level.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "list_databases",
            "title": "List databases",
            "description": "Databases (schemas) on a connection, without the system schemas.",
            "inputSchema": { "type": "object", "properties": { "connection": conn }, "required": ["connection"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "list_tables",
            "title": "List tables",
            "description": "Tables and views of a database with approximate row counts.",
            "inputSchema": { "type": "object", "properties": { "connection": conn, "database": db }, "required": ["connection"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "describe_table",
            "title": "Describe table",
            "description": "Columns, CREATE TABLE statement (indexes, foreign keys) and the tables that reference this one.",
            "inputSchema": { "type": "object", "properties": { "connection": conn, "database": db, "table": { "type": "string" } }, "required": ["connection", "table"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "query",
            "title": "Run a read query",
            "description": "Runs one read statement (SELECT, SHOW, DESCRIBE, EXPLAIN, WITH … SELECT) in a read-only transaction. Results are limited to the row limit set by the user.",
            "inputSchema": { "type": "object", "properties": { "connection": conn, "database": db, "sql": { "type": "string" } }, "required": ["connection", "sql"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "execute",
            "title": "Change data or schema",
            "description": "Runs INSERT/UPDATE/DELETE/DDL statements. Only on connections the user made read-write for AI; the user sees the SQL in MySQL Lens and must approve it before it runs.",
            "inputSchema": { "type": "object", "properties": { "connection": conn, "database": db, "sql": { "type": "string", "description": "One or more statements separated by ;" } }, "required": ["connection", "sql"] },
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        }
    ])
}

/* ----------------------------- HTTP ----------------------------- */

/// A running server; dropping it (or `stop`) closes the port.
pub struct McpHandle {
    pub port: u16,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl McpHandle {
    pub fn stop(mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for McpHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
    }
}

/// Starts listening on 127.0.0.1:`port` (0 picks a free port).
pub async fn serve(server: Arc<McpServer>, port: u16) -> Result<McpHandle> {
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
        .await
        .map_err(|e| msg(format!("Could not open port {port} for the MCP server ({e}). Choose another port.")))?;
    let port = listener.local_addr()?.port();
    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let server = server.clone();
                    tokio::spawn(async move {
                        let io = hyper_util::rt::TokioIo::new(stream);
                        let svc = hyper::service::service_fn(move |req| {
                            let server = server.clone();
                            async move { Ok::<_, std::convert::Infallible>(respond(&server, req, port).await) }
                        });
                        let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
                    });
                }
            }
        }
    });
    Ok(McpHandle { port, stop: Some(tx) })
}

fn plain(status: StatusCode, text: &str) -> Response<Full<Bytes>> {
    Response::builder().status(status).header("content-type", "text/plain; charset=utf-8").body(Full::new(Bytes::from(text.to_string()))).unwrap()
}

/// Only local pages may call (blocks DNS-rebinding attacks from web sites).
fn local_origin(origin: &str) -> bool {
    ["http://localhost", "http://127.0.0.1", "https://localhost", "https://127.0.0.1"].iter().any(|o| origin == *o || origin.starts_with(&format!("{o}:")))
}

fn local_host(host: &str, port: u16) -> bool {
    [format!("127.0.0.1:{port}"), format!("localhost:{port}"), "127.0.0.1".into(), "localhost".into()].contains(&host.to_ascii_lowercase())
}

/// Compares in constant time, so the token cannot be guessed from response times.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub(crate) async fn respond(server: &McpServer, req: Request<Incoming>, port: u16) -> Response<Full<Bytes>> {
    let header = |name: &str| req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    if req.uri().path() != "/mcp" {
        return plain(StatusCode::NOT_FOUND, "MySQL Lens MCP server: use the /mcp endpoint.");
    }
    if !header("host").map(|h| local_host(&h, port)).unwrap_or(false) {
        return plain(StatusCode::FORBIDDEN, "Only local requests are accepted.");
    }
    if let Some(origin) = header("origin") {
        if !local_origin(&origin) {
            return plain(StatusCode::FORBIDDEN, "Requests from web pages are not accepted.");
        }
    }
    let token = server.settings().token;
    let auth = header("authorization").unwrap_or_default();
    if !auth.strip_prefix("Bearer ").map(|t| same(t.trim(), &token)).unwrap_or(false) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("www-authenticate", "Bearer")
            .body(Full::new(Bytes::from_static(b"Missing or wrong token. Copy the configuration from MySQL Lens -> AI access (MCP).")))
            .unwrap();
    }
    let session = header("mcp-session-id");
    match *req.method() {
        Method::DELETE => {
            if let Some(s) = &session {
                server.end_session(s);
            }
            plain(StatusCode::OK, "")
        }
        Method::POST => {
            let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
                Ok(b) => b.to_bytes(),
                Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request too large."),
            };
            let Ok(message) = serde_json::from_slice::<J>(&body) else {
                return json_response(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }), None);
            };
            let (reply, new_session) = if let J::Array(batch) = &message {
                let mut out = Vec::new();
                for m in batch {
                    if let (Some(r), _) = server.handle(m, session.as_deref()).await {
                        out.push(r);
                    }
                }
                ((!out.is_empty()).then_some(J::Array(out)), None)
            } else {
                server.handle(&message, session.as_deref()).await
            };
            match reply {
                Some(r) => json_response(r, new_session),
                None => Response::builder().status(StatusCode::ACCEPTED).body(Full::new(Bytes::new())).unwrap(),
            }
        }
        // No server-initiated stream: clients fall back to plain request/response.
        _ => Response::builder().status(StatusCode::METHOD_NOT_ALLOWED).header("allow", "POST, DELETE").body(Full::new(Bytes::new())).unwrap(),
    }
}

fn json_response(v: J, session: Option<String>) -> Response<Full<Bytes>> {
    let mut b = Response::builder().status(StatusCode::OK).header("content-type", "application/json");
    if let Some(s) = session {
        b = b.header("mcp-session-id", s);
    }
    b.body(Full::new(Bytes::from(serde_json::to_vec(&v).unwrap_or_default()))).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_check() {
        for ok in ["SELECT 1", "  select * from t where a = 'x; y'", "-- note\nSHOW TABLES", "/* c */ explain select 1", "WITH x AS (SELECT 1) SELECT * FROM x", "desc t", "select 'into outfile' as s"] {
            assert_eq!(read_only_problem(ok), None, "{ok}");
        }
        for bad in ["UPDATE t SET a = 1", "select 1; select 2", "DROP TABLE t", "select * from t for update", "select * from t into  outfile '/tmp/x'", "", "/* select */ delete from t", "# select\ninsert into t values (1)"] {
            assert!(read_only_problem(bad).is_some(), "{bad}");
        }
    }

    #[test]
    fn strips_comments_but_not_strings() {
        assert_eq!(strip_comments("a -- x\nb # y\nc /* z */ d 'e -- f'").split_whitespace().collect::<Vec<_>>(), ["a", "b", "c", "d", "'e", "--", "f'"]);
    }

    #[test]
    fn host_and_origin_checks() {
        assert!(local_host("127.0.0.1:7421", 7421));
        assert!(local_host("LOCALHOST:7421", 7421));
        assert!(!local_host("evil.com:7421", 7421));
        assert!(!local_host("127.0.0.1:80", 7421));
        assert!(local_origin("http://localhost:3000"));
        assert!(!local_origin("http://localhost.evil.com"));
        assert!(!local_origin("https://example.com"));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
    }

    #[test]
    fn settings_defaults_and_roundtrip() {
        let path = std::env::temp_dir().join(format!("lens-mcp-{}.json", uuid::Uuid::new_v4()));
        let store = McpSettingsStore::new(path.clone());
        let s = store.load();
        assert!(!s.enabled);
        assert_eq!(s.token.len(), 64);
        let mut s2 = s.clone();
        s2.access.insert("c1".into(), Access::Write);
        store.save(&s2).unwrap();
        assert_eq!(store.load(), s2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rows_are_limited_and_cells_cut() {
        let r = ResultSet { kind: "rows".into(), sql: "select".into(), columns: vec![], rows: (0..5).map(|i| vec![J::from(i)]).collect(), total_rows: 5, affected_rows: None, error: None, ms: 0 };
        let v = shape(&r, 2);
        assert_eq!(v["rows"].as_array().unwrap().len(), 2);
        assert_eq!(v["truncated"], true);
        let long = J::String("x".repeat(MAX_CELL_CHARS + 10));
        assert!(cut_cell(&long).as_str().unwrap().ends_with(&format!("({} characters in total)", MAX_CELL_CHARS + 10)));
    }
}
