use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use lens_core::engine::Engine;
use lens_core::error::LensError;
use lens_core::history::{HistoryEntry, HistoryStore};
use lens_core::mcp::{self, Activity, Approval, McpHandle, McpHost, McpServer, McpSettings, McpSettingsStore};
use lens_core::snippets::{Snippet, SnippetStore};
use lens_core::store::{ConnStore, SecretStore};
use lens_core::types::*;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

type R<T> = Result<T, LensError>;

/// Passwords in the OS keychain (Windows Credential Manager / macOS Keychain).
struct KeychainSecrets;

#[cfg(any(windows, target_os = "macos"))]
impl SecretStore for KeychainSecrets {
    fn get(&self, key: &str) -> Option<String> {
        keyring::Entry::new("MySQL Lens", key).ok()?.get_password().ok()
    }
    fn set(&self, key: &str, value: Option<&str>) {
        if let Ok(e) = keyring::Entry::new("MySQL Lens", key) {
            let _ = match value {
                Some(v) => e.set_password(v),
                None => e.delete_credential(),
            };
        }
    }
}

/// Other platforms (development builds): secrets live in memory for the session only.
#[cfg(not(any(windows, target_os = "macos")))]
static MEM: std::sync::LazyLock<lens_core::store::MemorySecrets> = std::sync::LazyLock::new(Default::default);

#[cfg(not(any(windows, target_os = "macos")))]
impl SecretStore for KeychainSecrets {
    fn get(&self, key: &str) -> Option<String> {
        MEM.get(key)
    }
    fn set(&self, key: &str, value: Option<&str>) {
        MEM.set(key, value)
    }
}

struct AppState {
    engine: Arc<Engine>,
    mcp: McpState,
    history: HistoryStore,
    snippets: SnippetStore,
    /// Open tabs and their state, written by the UI (`session.json`).
    session_path: PathBuf,
}

/* ----------------------------- MCP (AI access) ----------------------------- */

/// How long the app waits for the user to allow or reject an AI write.
const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

type Approvals = Arc<std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>;

struct McpState {
    store: McpSettingsStore,
    running: tokio::sync::Mutex<Option<(Arc<McpServer>, McpHandle)>>,
    error: std::sync::Mutex<Option<String>>,
    approvals: Approvals,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct McpStatus {
    settings: McpSettings,
    running: bool,
    port: Option<u16>,
    error: Option<String>,
}

/// Shows AI writes to the user (an event the UI answers with `mcp_approve`) and
/// records every AI request in the query history.
struct AppMcpHost {
    app: AppHandle,
    approvals: Approvals,
}

#[async_trait::async_trait]
impl McpHost for AppMcpHost {
    async fn approve(&self, request: Approval) -> bool {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = request.id.clone();
        self.approvals.lock().unwrap().insert(id.clone(), tx);
        // The user is usually in their AI tool: bring the app forward so the request is seen.
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
        if self.app.emit("mcp-approval", &request).is_err() {
            self.approvals.lock().unwrap().remove(&id);
            return false;
        }
        let answer = tokio::time::timeout(APPROVAL_TIMEOUT, rx).await;
        self.approvals.lock().unwrap().remove(&id);
        if answer.is_err() {
            let _ = self.app.emit("mcp-approval-expired", &id);
        }
        matches!(answer, Ok(Ok(true)))
    }

    fn activity(&self, a: &Activity, results: &[ResultSet]) {
        let mut entry = HistoryEntry::from_results(&a.conn_id, &a.conn_name, a.db.as_deref(), &a.sql, results);
        entry.source = Some(format!("AI · {}", a.client));
        entry.ms = a.ms;
        if entry.error.is_none() {
            entry.error = a.error.clone();
        }
        // History is a convenience: a failed write must not fail the request.
        let _ = self.app.state::<AppState>().history.add(entry);
        let _ = self.app.emit("mcp-activity", a);
    }
}

async fn mcp_status_of(s: &AppState) -> McpStatus {
    let running = s.mcp.running.lock().await;
    McpStatus { settings: s.mcp.store.load(), running: running.is_some(), port: running.as_ref().map(|(_, h)| h.port), error: s.mcp.error.lock().unwrap().clone() }
}

/// Starts, stops or updates the MCP server to match the saved settings.
async fn mcp_apply(app: &AppHandle) -> R<()> {
    let s = app.state::<AppState>();
    let settings = s.mcp.store.load();
    let mut running = s.mcp.running.lock().await;
    *s.mcp.error.lock().unwrap() = None;
    // Same port: new permissions, limits and token apply without reopening the port.
    if let Some((server, handle)) = running.as_ref() {
        if settings.enabled && handle.port == settings.port {
            server.update_settings(settings);
            return Ok(());
        }
    }
    if let Some((_, handle)) = running.take() {
        handle.stop();
    }
    if !settings.enabled {
        return Ok(());
    }
    let host = Arc::new(AppMcpHost { app: app.clone(), approvals: s.mcp.approvals.clone() });
    let server = McpServer::new(s.engine.clone(), settings.clone(), host);
    // The port of a server that was just stopped can take a moment to be released.
    let mut last = None;
    for _ in 0..10 {
        match mcp::serve(server.clone(), settings.port).await {
            Ok(handle) => {
                *running = Some((server, handle));
                return Ok(());
            }
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
        }
    }
    let e = last.unwrap();
    *s.mcp.error.lock().unwrap() = Some(e.to_string());
    Err(e)
}

#[tauri::command]
async fn mcp_status(s: State<'_, AppState>) -> R<McpStatus> {
    Ok(mcp_status_of(&s).await)
}

/// Saves the settings (an empty token gets a new one) and applies them.
#[tauri::command]
async fn mcp_save(app: AppHandle, s: State<'_, AppState>, mut settings: McpSettings) -> R<McpStatus> {
    if settings.token.len() < 32 {
        settings.token = mcp::new_token();
    }
    s.mcp.store.save(&settings)?;
    // A failed start (port in use) is reported in the status, not as an error.
    let _ = mcp_apply(&app).await;
    Ok(mcp_status_of(&s).await)
}

#[tauri::command]
async fn mcp_approve(s: State<'_, AppState>, id: String, allow: bool) -> R<()> {
    if let Some(tx) = s.mcp.approvals.lock().unwrap().remove(&id) {
        let _ = tx.send(allow);
    }
    Ok(())
}

/// Executed batches kept in the history file.
const HISTORY_CAP: usize = 1000;

#[tauri::command]
async fn list_connections(s: State<'_, AppState>) -> R<Vec<Connection>> {
    Ok(s.engine.list_connections())
}

#[tauri::command]
async fn save_connection(s: State<'_, AppState>, c: Connection, password: Option<String>, ssh_password: Option<String>, ssh_passphrase: Option<String>) -> R<Connection> {
    let saved = s.engine.save_connection(c, password).await?;
    if let Some(p) = ssh_password.filter(|p| !p.is_empty()) {
        s.engine.set_secret(&saved.id, "sshPassword", Some(&p));
    }
    if let Some(p) = ssh_passphrase.filter(|p| !p.is_empty()) {
        s.engine.set_secret(&saved.id, "sshPassphrase", Some(&p));
    }
    Ok(saved)
}

#[tauri::command]
async fn delete_connection(s: State<'_, AppState>, id: String) -> R<()> {
    s.engine.delete_connection(&id).await
}

#[tauri::command]
async fn test_connection(s: State<'_, AppState>, c: Connection, password: Option<String>) -> R<String> {
    s.engine.test_connection(c, password).await
}

#[tauri::command]
async fn connect(s: State<'_, AppState>, id: String) -> R<()> {
    s.engine.connect(&id).await
}

#[tauri::command]
async fn disconnect(s: State<'_, AppState>, id: String) -> R<()> {
    s.engine.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
async fn databases(s: State<'_, AppState>, id: String) -> R<Vec<String>> {
    s.engine.databases(&id).await
}

#[tauri::command]
async fn objects(s: State<'_, AppState>, id: String, db: String) -> R<DbObjects> {
    s.engine.objects(&id, &db).await
}

#[tauri::command]
async fn columns(s: State<'_, AppState>, id: String, db: String, table: String) -> R<Vec<Column>> {
    s.engine.columns(&id, &db, &table).await
}

#[tauri::command]
async fn schema(s: State<'_, AppState>, id: String, db: String) -> R<HashMap<String, Vec<Column>>> {
    s.engine.schema(&id, &db).await
}

#[tauri::command]
async fn foreign_keys(s: State<'_, AppState>, id: String, db: String, table: String) -> R<Relations> {
    s.engine.foreign_keys(&id, &db, &table).await
}

#[tauri::command]
async fn count_rows(s: State<'_, AppState>, id: String, items: Vec<CountRequest>, cap: u64) -> R<Vec<Option<u64>>> {
    s.engine.count_rows(&id, &items, cap).await
}

/// One cell's full bytes as base64 (the grid only holds a preview of large values).
#[tauri::command]
async fn cell_bytes(s: State<'_, AppState>, id: String, db: String, table: String, column: String, columns: Vec<Column>, key: serde_json::Map<String, Cell>) -> R<String> {
    Ok(lens_core::value::base64(&s.engine.cell_bytes(&id, &db, &table, &column, &columns, &key).await?))
}

/// Writes one cell's full bytes to `path` (Save to file in the value editor).
#[tauri::command]
async fn save_cell(s: State<'_, AppState>, id: String, db: String, table: String, column: String, columns: Vec<Column>, key: serde_json::Map<String, Cell>, path: PathBuf) -> R<u64> {
    let bytes = s.engine.cell_bytes(&id, &db, &table, &column, &columns, &key).await?;
    std::fs::write(&path, &bytes)?;
    Ok(bytes.len() as u64)
}

/// A file's contents as a `0x…` hex literal, to load it into a binary cell.
#[tauri::command]
async fn file_hex(path: PathBuf) -> R<String> {
    let len = std::fs::metadata(&path)?.len();
    if len > lens_core::engine::MAX_CELL_BYTES {
        return Err(lens_core::error::msg(format!("File is {} MB; the limit is {} MB.", len / 1_048_576, lens_core::engine::MAX_CELL_BYTES / 1_048_576)));
    }
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(path)).await.map_err(|e| lens_core::error::msg(e.to_string()))??;
    Ok(lens_core::value::hex(&bytes))
}

#[tauri::command]
async fn table_page(s: State<'_, AppState>, id: String, db: String, table: String, req: PageRequest) -> R<TablePage> {
    s.engine.table_page(&id, &db, &table, req).await
}

#[tauri::command]
async fn query(s: State<'_, AppState>, id: String, db: Option<String>, sql: String, statements: Option<Vec<String>>, run_id: Option<String>, tx: Option<String>) -> R<Vec<ResultSet>> {
    // The editor sends statements it already split (so procedure bodies stay whole), a run id
    // for Cancel, and in manual-commit mode the key of its transaction.
    let (res, sql) = match statements {
        Some(list) => (s.engine.run_statements(&id, db.as_deref(), &list, run_id.as_deref(), tx.as_deref()).await, lens_core::history::join_statements(&list)),
        None => (s.engine.query(&id, db.as_deref(), &sql).await, sql),
    };
    let name = s.engine.list_connections().into_iter().find(|c| c.id == id).map(|c| c.name).unwrap_or_default();
    let entry = match &res {
        Ok(results) => HistoryEntry::from_results(&id, &name, db.as_deref(), &sql, results),
        Err(e) => HistoryEntry { error: Some(e.to_string()), ..HistoryEntry::from_results(&id, &name, db.as_deref(), &sql, &[]) },
    };
    // History is a convenience: a failed write must not fail the query.
    let _ = s.history.add(entry);
    res
}

#[tauri::command]
async fn tx_end(s: State<'_, AppState>, id: String, tx: String, commit: bool) -> R<()> {
    s.engine.tx_end(&id, &tx, commit).await
}

#[tauri::command]
async fn tx_close(s: State<'_, AppState>, tx: String) -> R<()> {
    s.engine.tx_close(&tx).await;
    Ok(())
}

#[tauri::command]
async fn db_foreign_keys(s: State<'_, AppState>, id: String, db: String) -> R<Vec<ForeignKey>> {
    s.engine.db_foreign_keys(&id, &db).await
}

#[tauri::command]
async fn snippets_list(s: State<'_, AppState>) -> R<Vec<Snippet>> {
    Ok(s.snippets.list())
}

#[tauri::command]
async fn snippets_save(s: State<'_, AppState>, snippet: Snippet) -> R<Snippet> {
    s.snippets.save(snippet)
}

#[tauri::command]
async fn snippets_delete(s: State<'_, AppState>, id: String) -> R<()> {
    s.snippets.delete(&id)
}

#[tauri::command]
async fn cancel_query(s: State<'_, AppState>, run_id: String) -> R<bool> {
    s.engine.cancel(&run_id).await
}

#[tauri::command]
async fn session_load(s: State<'_, AppState>) -> R<Option<String>> {
    match std::fs::read_to_string(&s.session_path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Written through a temporary file, so a crash mid-write keeps the previous session.
#[tauri::command]
async fn session_save(s: State<'_, AppState>, data: String) -> R<()> {
    if let Some(dir) = s.session_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = s.session_path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(tmp, &s.session_path)?;
    Ok(())
}

#[tauri::command]
async fn history_list(s: State<'_, AppState>) -> R<Vec<HistoryEntry>> {
    Ok(s.history.list())
}

#[tauri::command]
async fn history_delete(s: State<'_, AppState>, id: String) -> R<()> {
    s.history.delete(&id)
}

#[tauri::command]
async fn history_clear(s: State<'_, AppState>) -> R<()> {
    s.history.clear()
}

#[tauri::command]
async fn export_connections(s: State<'_, AppState>, path: PathBuf) -> R<usize> {
    s.engine.export_connections(&path)
}

#[tauri::command]
async fn import_connections(s: State<'_, AppState>, path: PathBuf) -> R<lens_core::conn_io::ImportSummary> {
    s.engine.import_connections(&path)
}

#[tauri::command]
async fn preview_changes(s: State<'_, AppState>, db: String, table: String, columns: Vec<Column>, changes: Vec<RowChange>) -> R<Vec<String>> {
    Ok(s.engine.preview_changes(&db, &table, &columns, &changes))
}

#[tauri::command]
async fn apply_changes(s: State<'_, AppState>, id: String, db: String, table: String, columns: Vec<Column>, changes: Vec<RowChange>) -> R<()> {
    s.engine.apply_changes(&id, &db, &table, &columns, &changes).await
}

#[tauri::command]
async fn export_data(app: tauri::AppHandle, s: State<'_, AppState>, id: String, db: String, table: String, sql: String, format: String, path: PathBuf) -> R<u64> {
    s.engine
        .export(&id, &db, &table, &sql, &format, &path, |n| {
            let _ = app.emit("export-progress", n);
            true
        })
        .await
}

#[tauri::command]
async fn dump_database(app: tauri::AppHandle, s: State<'_, AppState>, id: String, opts: lens_core::dump::DumpOptions, path: PathBuf) -> R<lens_core::dump::DumpResult> {
    s.engine
        .dump(&id, &opts, &path, |table, i, n, rows| {
            let _ = app.emit("dump-progress", serde_json::json!({ "table": table, "index": i, "count": n, "rows": rows }));
            true
        })
        .await
}

#[tauri::command]
async fn import_sql(app: tauri::AppHandle, s: State<'_, AppState>, id: String, db: Option<String>, path: PathBuf, continue_on_error: bool) -> R<lens_core::dump::ImportResult> {
    s.engine
        .import_sql(&id, db.as_deref(), &path, continue_on_error, |read, total, statements| {
            let _ = app.emit("import-progress", serde_json::json!({ "read": read, "total": total, "statements": statements }));
            true
        })
        .await
}

#[tauri::command]
async fn import_preview(path: PathBuf, opts: Option<lens_core::data_import::SourceOptions>) -> R<lens_core::data_import::Preview> {
    tokio::task::spawn_blocking(move || lens_core::data_import::preview(&path, opts)).await.map_err(|e| lens_core::error::msg(e.to_string()))?
}

#[tauri::command]
async fn import_data(app: tauri::AppHandle, s: State<'_, AppState>, id: String, db: String, path: PathBuf, opts: lens_core::data_import::SourceOptions, plan: lens_core::data_import::ImportPlan) -> R<u64> {
    s.engine
        .import_data(&id, &db, &path, &opts, &plan, |n| {
            let _ = app.emit("data-import-progress", n);
            true
        })
        .await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let engine = Arc::new(Engine::new(ConnStore::new(dir.join("connections.json")), Arc::new(KeychainSecrets)));
            let history = HistoryStore::new(dir.join("history.jsonl"), HISTORY_CAP);
            let snippets = SnippetStore::new(dir.join("snippets.json"));
            let mcp = McpState { store: McpSettingsStore::new(dir.join("mcp.json")), running: tokio::sync::Mutex::new(None), error: std::sync::Mutex::new(None), approvals: Arc::new(std::sync::Mutex::new(HashMap::new())) };
            app.manage(AppState { engine, mcp, history, snippets, session_path: dir.join("session.json") });
            // AI access starts with the app when it was left on.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = mcp_apply(&handle).await;
            });

            // Same flags Tauri uses by default; the smoke test can additionally
            // ask for a DevTools port (never enabled for normal starts).
            let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
            if let Ok(port) = std::env::var("MYSQL_LENS_REMOTE_DEBUG_PORT") {
                if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() {
                    args.push_str(&format!(" --remote-debugging-port={port}"));
                }
            }
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("MySQL Lens")
                .inner_size(1400.0, 880.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .disable_drag_drop_handler()
                .additional_browser_args(&args)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            delete_connection,
            test_connection,
            connect,
            disconnect,
            databases,
            objects,
            columns,
            schema,
            table_page,
            foreign_keys,
            count_rows,
            cell_bytes,
            save_cell,
            file_hex,
            query,
            preview_changes,
            apply_changes,
            export_data,
            dump_database,
            import_sql,
            import_preview,
            import_data,
            cancel_query,
            tx_end,
            tx_close,
            db_foreign_keys,
            snippets_list,
            snippets_save,
            snippets_delete,
            mcp_status,
            mcp_save,
            mcp_approve,
            session_load,
            session_save,
            history_list,
            history_delete,
            history_clear,
            export_connections,
            import_connections
        ])
        .run(tauri::generate_context!())
        .expect("error while running MySQL Lens");
}
