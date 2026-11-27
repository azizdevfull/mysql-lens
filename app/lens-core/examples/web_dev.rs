//! Runs web access without the desktop app, to try the browser UI during development.
//!
//! npm run build && cargo run -p lens-core --example web_dev -- <config-dir> [port]
//!
//! Serves `dist/` and a subset of the app's commands (connections, browsing, queries).
//! <config-dir> holds connections.json (the file the app writes); MYSQL_DEV_PASSWORD is
//! the password of every connection. The sign-in link is printed at start.

use std::path::PathBuf;
use std::sync::Arc;

use lens_core::engine::Engine;
use lens_core::store::{secret_key, ConnStore, MemorySecrets, SecretStore};
use lens_core::types::{Connection, PageRequest};
use lens_core::web::{self, WebHost, WebServer, WebSettings};
use serde_json::{json, Value as J};

struct DevHost {
    engine: Arc<Engine>,
    dist: PathBuf,
}

fn arg<T: serde::de::DeserializeOwned>(a: &J, k: &str) -> Result<T, String> {
    serde_json::from_value(a.get(k).cloned().unwrap_or(J::Null)).map_err(|e| format!("{k}: {e}"))
}

fn out<T: serde::Serialize>(r: lens_core::error::Result<T>) -> Result<J, String> {
    r.map(|v| serde_json::to_value(v).unwrap()).map_err(|e| e.to_string())
}

#[async_trait::async_trait]
impl WebHost for DevHost {
    async fn call(&self, cmd: &str, a: J) -> Result<J, String> {
        let e = &self.engine;
        match cmd {
            "list_connections" => out(Ok(e.list_connections())),
            "save_connection" => out(e.save_connection(arg::<Connection>(&a, "c")?, arg(&a, "password")?).await),
            "move_connections" => out(e.move_connections(&arg::<Vec<String>>(&a, "ids")?, arg::<Option<String>>(&a, "folder")?.as_deref())),
            "delete_connection" => out(e.delete_connection(&arg::<String>(&a, "id")?).await),
            "connect" => out(e.connect(&arg::<String>(&a, "id")?).await),
            "disconnect" => {
                e.disconnect(&arg::<String>(&a, "id")?).await;
                Ok(J::Null)
            }
            "databases" => out(e.databases(&arg::<String>(&a, "id")?).await),
            "objects" => out(e.objects(&arg::<String>(&a, "id")?, &arg::<String>(&a, "db")?).await),
            "columns" => out(e.columns(&arg::<String>(&a, "id")?, &arg::<String>(&a, "db")?, &arg::<String>(&a, "table")?).await),
            "schema" => out(e.schema(&arg::<String>(&a, "id")?, &arg::<String>(&a, "db")?).await),
            "table_page" => out(e.table_page(&arg::<String>(&a, "id")?, &arg::<String>(&a, "db")?, &arg::<String>(&a, "table")?, arg::<PageRequest>(&a, "req")?).await),
            "query" => {
                let (id, db): (String, Option<String>) = (arg(&a, "id")?, arg(&a, "db")?);
                match arg::<Option<Vec<String>>>(&a, "statements")? {
                    Some(list) => out(e.run_statements(&id, db.as_deref(), &list, arg::<Option<String>>(&a, "runId")?.as_deref(), None).await),
                    None => out(e.query(&id, db.as_deref(), &arg::<String>(&a, "sql")?).await),
                }
            }
            "export_connections" => out(e.export_connections(&arg::<PathBuf>(&a, "path")?)),
            "import_connections" => out(e.import_connections(&arg::<PathBuf>(&a, "path")?)),
            "history_list" | "snippets_list" => Ok(json!([])),
            "mcp_status" => Ok(json!({ "settings": { "enabled": false, "port": 7421, "token": "", "access": {}, "maxRows": 200, "timeoutSecs": 30 }, "running": false, "port": null, "error": null })),
            _ => Err(format!("\"{cmd}\" is not in web_dev")),
        }
    }

    fn asset(&self, path: &str) -> Option<(Vec<u8>, String)> {
        let bytes = std::fs::read(self.dist.join(path)).ok()?;
        let mime = match path.rsplit('.').next() {
            Some("html") => "text/html",
            Some("js") => "text/javascript",
            Some("css") => "text/css",
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("woff2") => "font/woff2",
            _ => "application/octet-stream",
        };
        Some((bytes, mime.into()))
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("usage: web_dev <config-dir> [port]"));
    let port: u16 = args.next().and_then(|p| p.parse().ok()).unwrap_or(7431);
    let secrets = Arc::new(MemorySecrets::default());
    let store = ConnStore::new(dir.join("connections.json"));
    if let Ok(pw) = std::env::var("MYSQL_DEV_PASSWORD") {
        for c in store.list() {
            secrets.set(&secret_key("password", &c.id), Some(&pw));
        }
    }
    let engine = Arc::new(Engine::new(store, secrets));
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    let settings = WebSettings { enabled: true, port, lan: false, token: lens_core::mcp::new_token() };
    let server = WebServer::new(Arc::new(DevHost { engine, dist }), &settings, std::env::temp_dir().join("mysql-lens-web-dev"));
    let handle = web::serve(server, port).await.expect("could not listen");
    eprintln!("Sign in: http://127.0.0.1:{}/login?token={}", handle.port, settings.token);
    tokio::signal::ctrl_c().await.ok();
    handle.stop();
}
