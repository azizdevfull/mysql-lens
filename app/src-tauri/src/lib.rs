use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use lens_core::engine::Engine;
use lens_core::error::LensError;
use lens_core::history::{HistoryEntry, HistoryStore};
use lens_core::store::{ConnStore, SecretStore};
use lens_core::types::*;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

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
    engine: Engine,
    history: HistoryStore,
    /// Open tabs and their state, written by the UI (`session.json`).
    session_path: PathBuf,
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
async fn query(s: State<'_, AppState>, id: String, db: Option<String>, sql: String, statements: Option<Vec<String>>, run_id: Option<String>) -> R<Vec<ResultSet>> {
    // The editor sends statements it already split (so procedure bodies stay whole) and a run id for Cancel.
    let (res, sql) = match statements {
        Some(list) => (s.engine.run_statements(&id, db.as_deref(), &list, run_id.as_deref()).await, lens_core::history::join_statements(&list)),
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
            let engine = Engine::new(ConnStore::new(dir.join("connections.json")), Arc::new(KeychainSecrets));
            let history = HistoryStore::new(dir.join("history.jsonl"), HISTORY_CAP);
            app.manage(AppState { engine, history, session_path: dir.join("session.json") });

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
