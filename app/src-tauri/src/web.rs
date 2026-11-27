//! Web access: runs the app's commands for browsers (see `lens_core::web`).

use std::sync::Arc;

use lens_core::error::LensError;
use lens_core::web::{self, WebHandle, WebHost, WebServer, WebSettings, WebSettingsStore, WebStatus};
use serde::de::DeserializeOwned;
use serde_json::Value as J;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::*;

pub struct WebState {
    store: WebSettingsStore,
    running: tokio::sync::Mutex<Option<(Arc<WebServer>, WebHandle)>>,
    /// The running server, for forwarding events without awaiting `running`.
    live: std::sync::Mutex<Option<Arc<WebServer>>>,
    error: std::sync::Mutex<Option<String>>,
    files: std::path::PathBuf,
}

impl WebState {
    pub fn new(dir: &std::path::Path) -> Self {
        Self {
            store: WebSettingsStore::new(dir.join("web.json")),
            running: tokio::sync::Mutex::new(None),
            live: std::sync::Mutex::new(None),
            error: std::sync::Mutex::new(None),
            files: std::env::temp_dir().join("mysql-lens-web"),
        }
    }
}

/// Emits an app event to the desktop window and to every browser using web access.
pub(crate) fn emit<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) -> tauri::Result<()> {
    if let Some(w) = app.try_state::<WebState>() {
        if let Some(server) = w.live.lock().unwrap().as_ref() {
            server.emit(event, &payload);
        }
    }
    app.emit(event, payload)
}

struct AppWebHost {
    app: AppHandle,
}

#[async_trait::async_trait]
impl WebHost for AppWebHost {
    async fn call(&self, cmd: &str, args: J) -> Result<J, String> {
        dispatch(&self.app, cmd, args).await
    }

    fn asset(&self, path: &str) -> Option<(Vec<u8>, String)> {
        self.app.asset_resolver().get(path.to_string()).map(|a| (a.bytes, a.mime_type))
    }
}

fn arg<T: DeserializeOwned>(args: &J, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(J::Null)).map_err(|e| format!("Argument {key}: {e}"))
}

fn out<T: serde::Serialize>(r: Result<T, LensError>) -> Result<J, String> {
    r.map_err(|e| e.to_string()).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Runs a command for a browser. Argument names match the desktop UI's `invoke` calls.
/// Commands that change web access itself, or open things on this computer, are not offered.
async fn dispatch(app: &AppHandle, cmd: &str, a: J) -> Result<J, String> {
    let s = move || app.state::<AppState>();
    match cmd {
        "list_connections" => out(list_connections(s()).await),
        "save_connection" => out(save_connection(s(), arg(&a, "c")?, arg(&a, "password")?, arg(&a, "sshPassword")?, arg(&a, "sshPassphrase")?).await),
        "delete_connection" => out(delete_connection(s(), arg(&a, "id")?).await),
        "move_connections" => out(move_connections(s(), arg(&a, "ids")?, arg(&a, "folder")?).await),
        "test_connection" => out(test_connection(s(), arg(&a, "c")?, arg(&a, "password")?).await),
        "connect" => out(connect(s(), arg(&a, "id")?).await),
        "disconnect" => out(disconnect(s(), arg(&a, "id")?).await),
        "databases" => out(databases(s(), arg(&a, "id")?).await),
        "objects" => out(objects(s(), arg(&a, "id")?, arg(&a, "db")?).await),
        "columns" => out(columns(s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "table")?).await),
        "schema" => out(schema(s(), arg(&a, "id")?, arg(&a, "db")?).await),
        "table_page" => out(table_page(s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "table")?, arg(&a, "req")?).await),
        "foreign_keys" => out(foreign_keys(s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "table")?).await),
        "count_rows" => out(count_rows(s(), arg(&a, "id")?, arg(&a, "items")?, arg(&a, "cap")?).await),
        "cell_bytes" => out(cell_bytes(s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "table")?, arg(&a, "column")?, arg(&a, "columns")?, arg(&a, "key")?).await),
        "save_cell" => out(save_cell(s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "table")?, arg(&a, "column")?, arg(&a, "columns")?, arg(&a, "key")?, arg(&a, "path")?).await),
        "file_hex" => out(file_hex(arg(&a, "path")?).await),
        "query" => out(query(s(), arg(&a, "id")?, arg(&a, "db")?, arg::<Option<String>>(&a, "sql")?.unwrap_or_default(), arg(&a, "statements")?, arg(&a, "runId")?, arg(&a, "tx")?).await),
        "tx_end" => out(tx_end(s(), arg(&a, "id")?, arg(&a, "tx")?, arg(&a, "commit")?).await),
        "tx_close" => out(tx_close(s(), arg(&a, "tx")?).await),
        "db_foreign_keys" => out(db_foreign_keys(s(), arg(&a, "id")?, arg(&a, "db")?).await),
        "snippets_list" => out(snippets_list(s()).await),
        "snippets_save" => out(snippets_save(s(), arg(&a, "snippet")?).await),
        "snippets_delete" => out(snippets_delete(s(), arg(&a, "id")?).await),
        "mcp_status" => out(mcp_status(s()).await),
        "mcp_approve" => out(mcp_approve(s(), arg(&a, "id")?, arg(&a, "allow")?).await),
        "cancel_query" => out(cancel_query(s(), arg(&a, "runId")?).await),
        "preview_changes" => out(preview_changes(s(), arg(&a, "db")?, arg(&a, "table")?, arg(&a, "columns")?, arg(&a, "changes")?).await),
        "apply_changes" => out(apply_changes(s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "table")?, arg(&a, "columns")?, arg(&a, "changes")?).await),
        "export_data" => out(export_data(app.clone(), s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "table")?, arg(&a, "sql")?, arg(&a, "format")?, arg(&a, "path")?).await),
        "dump_database" => out(dump_database(app.clone(), s(), arg(&a, "id")?, arg(&a, "opts")?, arg(&a, "path")?).await),
        "import_sql" => out(import_sql(app.clone(), s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "path")?, arg(&a, "continueOnError")?).await),
        "import_preview" => out(import_preview(arg(&a, "path")?, arg(&a, "opts")?).await),
        "import_data" => out(import_data(app.clone(), s(), arg(&a, "id")?, arg(&a, "db")?, arg(&a, "path")?, arg(&a, "opts")?, arg(&a, "plan")?).await),
        "history_list" => out(history_list(s()).await),
        "history_delete" => out(history_delete(s(), arg(&a, "id")?).await),
        "history_clear" => out(history_clear(s()).await),
        "export_connections" => out(export_connections(s(), arg(&a, "path")?).await),
        "import_connections" => out(import_connections(s(), arg(&a, "path")?).await),
        _ => Err(format!("\"{cmd}\" is only available in the desktop app.")),
    }
}

async fn status_of(w: &WebState) -> WebStatus {
    let running = w.running.lock().await;
    WebStatus::new(w.store.load(), running.as_ref().map(|(_, h)| h.port), w.error.lock().unwrap().clone())
}

/// Starts, stops or updates the web server to match the saved settings.
pub(crate) async fn apply(app: &AppHandle) -> Result<(), LensError> {
    let w = app.state::<WebState>();
    let settings: WebSettings = w.store.load();
    let mut running = w.running.lock().await;
    *w.error.lock().unwrap() = None;
    // Same address: a new token applies (and signs browsers out) without reopening the port.
    if let Some((server, handle)) = running.as_ref() {
        if settings.enabled && handle.port == settings.port && server.lan() == settings.lan {
            server.set_token(&settings.token);
            return Ok(());
        }
    }
    *w.live.lock().unwrap() = None;
    if let Some((_, handle)) = running.take() {
        handle.stop();
    }
    if !settings.enabled {
        return Ok(());
    }
    let server = WebServer::new(Arc::new(AppWebHost { app: app.clone() }), &settings, w.files.clone());
    // The port of a server that was just stopped can take a moment to be released.
    let mut last = None;
    for _ in 0..10 {
        match web::serve(server.clone(), settings.port).await {
            Ok(handle) => {
                *w.live.lock().unwrap() = Some(server.clone());
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
    *w.error.lock().unwrap() = Some(e.to_string());
    Err(e)
}

#[tauri::command]
pub async fn web_status(w: State<'_, WebState>) -> Result<WebStatus, LensError> {
    Ok(status_of(&w).await)
}

/// Saves the settings (an empty token gets a new one) and applies them.
#[tauri::command]
pub async fn web_save(app: AppHandle, w: State<'_, WebState>, mut settings: WebSettings) -> Result<WebStatus, LensError> {
    if settings.token.len() < 32 {
        settings.token = lens_core::mcp::new_token();
    }
    w.store.save(&settings)?;
    // A failed start (port in use) is reported in the status, not as an error.
    let _ = apply(&app).await;
    Ok(status_of(&w).await)
}
