use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use lens_core::engine::Engine;
use lens_core::error::LensError;
use lens_core::store::{ConnStore, SecretStore};
use lens_core::types::*;
use tauri::{Emitter, Manager, State};

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
}

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
async fn table_page(s: State<'_, AppState>, id: String, db: String, table: String, req: PageRequest) -> R<TablePage> {
    s.engine.table_page(&id, &db, &table, req).await
}

#[tauri::command]
async fn query(s: State<'_, AppState>, id: String, db: Option<String>, sql: String) -> R<Vec<ResultSet>> {
    s.engine.query(&id, db.as_deref(), &sql).await
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
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let engine = Engine::new(ConnStore::new(dir.join("connections.json")), Arc::new(KeychainSecrets));
            app.manage(AppState { engine });
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
            query,
            preview_changes,
            apply_changes,
            export_data,
            dump_database,
            import_sql,
            import_preview,
            import_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running MySQL Lens");
}
