//! Runs the MCP server without the app, for testing with an AI client.
//!
//! cargo run -p lens-core --example mcp_dev -- <config-dir>
//!
//! <config-dir> holds connections.json and mcp.json (the same files the app writes).
//! Writes are approved or rejected by MCP_DEV_APPROVE=yes|no (default: no);
//! MCP_DEV_PASSWORD is the password of every connection.

use std::sync::Arc;

use lens_core::engine::Engine;
use lens_core::mcp::{self, Activity, Approval, McpHost, McpServer, McpSettingsStore};
use lens_core::store::{secret_key, ConnStore, MemorySecrets, SecretStore};
use lens_core::types::ResultSet;

struct ConsoleHost {
    approve: bool,
}

#[async_trait::async_trait]
impl McpHost for ConsoleHost {
    async fn approve(&self, a: Approval) -> bool {
        eprintln!("[approval] {} wants to run on {} ({:?}):\n  {}\n  -> {}", a.client, a.conn_name, a.db, a.statements.join(";\n  "), if self.approve { "ALLOWED" } else { "REJECTED" });
        self.approve
    }
    fn activity(&self, a: &Activity, results: &[ResultSet]) {
        eprintln!("[activity] {} {} on {}/{:?} ok={} {}ms: {}{}", a.client, a.tool, a.conn_name, a.db, a.ok, a.ms, a.sql.replace('\n', " "), a.error.as_ref().map(|e| format!(" ERROR: {e}")).unwrap_or_default());
        let _ = results;
    }
}

#[tokio::main]
async fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("config dir"));
    let store = ConnStore::new(dir.join("connections.json"));
    let secrets = MemorySecrets::default();
    // MCP_DEV_PASSWORD is used for every connection (test databases only).
    if let Ok(pw) = std::env::var("MCP_DEV_PASSWORD") {
        for c in store.list() {
            secrets.set(&secret_key("password", &c.id), Some(&pw));
        }
    }
    let engine = Arc::new(Engine::new(store, Arc::new(secrets)));
    let settings = McpSettingsStore::new(dir.join("mcp.json")).load();
    let host = Arc::new(ConsoleHost { approve: std::env::var("MCP_DEV_APPROVE").map(|v| v == "yes").unwrap_or(false) });
    let port = settings.port;
    let server = McpServer::new(engine, settings, host);
    let handle = mcp::serve(server, port).await.expect("serve");
    eprintln!("MCP dev server on http://127.0.0.1:{}/mcp", handle.port);
    tokio::signal::ctrl_c().await.ok();
}
