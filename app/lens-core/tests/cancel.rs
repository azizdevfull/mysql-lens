//! Needs a MySQL server: MYSQL_LENS_TEST_HOST=127.0.0.1 [MYSQL_LENS_TEST_USER=root MYSQL_LENS_TEST_PASSWORD=…] cargo test --test cancel
//! Without MYSQL_LENS_TEST_HOST the tests return early (CI has no server).

use std::sync::Arc;
use std::time::{Duration, Instant};

use lens_core::engine::{Engine, CANCELLED};
use lens_core::store::{ConnStore, MemorySecrets};
use lens_core::types::Connection;

async fn engine() -> Option<(Arc<Engine>, String)> {
    let host = std::env::var("MYSQL_LENS_TEST_HOST").ok()?;
    let dir = std::env::temp_dir().join(format!("lens-cancel-{}", uuid::Uuid::new_v4()));
    let e = Engine::new(ConnStore::new(dir.join("connections.json")), Arc::new(MemorySecrets::default()));
    let c = Connection {
        id: String::new(),
        name: "test".into(),
        color: String::new(),
        host,
        port: std::env::var("MYSQL_LENS_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3306),
        user: std::env::var("MYSQL_LENS_TEST_USER").unwrap_or_else(|_| "root".into()),
        database: None,
        read_only: None,
        ssh: None,
        ssl: None,
        folder: None,
    };
    let saved = e.save_connection(c, std::env::var("MYSQL_LENS_TEST_PASSWORD").ok()).await.unwrap();
    Some((Arc::new(e), saved.id))
}

#[tokio::test]
async fn cancel_kills_the_running_statement_and_skips_the_rest() {
    let Some((e, id)) = engine().await else { return };
    let run = {
        let e = e.clone();
        let id = id.clone();
        tokio::spawn(async move { e.run_statements(&id, None, &["SELECT SLEEP(20)".into(), "SELECT 'not reached'".into()], Some("run-1")).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = Instant::now();
    assert!(e.cancel("run-1").await.unwrap());
    let out = run.await.unwrap().unwrap();
    assert!(started.elapsed() < Duration::from_secs(5), "query kept running after cancel");
    // SLEEP() returns 1 when interrupted, so the first statement may come back as rows.
    let last = out.last().unwrap();
    assert_eq!(last.error.as_deref(), Some(CANCELLED), "{out:?}");
    assert!(out.iter().all(|r| !r.sql.contains("not reached") || r.kind == "error"));
    // The run is forgotten once finished.
    assert!(!e.cancel("run-1").await.unwrap());
}

#[tokio::test]
async fn statements_run_verbatim_so_procedure_bodies_stay_whole() {
    let Some((e, id)) = engine().await else { return };
    let db = format!("lens_test_{}", uuid::Uuid::new_v4().simple());
    let stmts: Vec<String> = vec![
        format!("CREATE DATABASE `{db}`"),
        format!("CREATE PROCEDURE `{db}`.p() BEGIN SELECT 1 AS a; SELECT 2 AS b; END"),
        format!("CALL `{db}`.p()"),
        format!("DROP DATABASE `{db}`"),
    ];
    let out = e.run_statements(&id, None, &stmts, None).await.unwrap();
    assert!(out.iter().all(|r| r.kind != "error"), "{out:?}");
    assert_eq!(out.iter().filter(|r| r.kind == "rows").count(), 2);
}
