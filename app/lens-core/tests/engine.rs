//! Integration tests against a real MySQL server (local test user, see README).
use std::sync::Arc;

use lens_core::engine::Engine;
use lens_core::store::{ConnStore, MemorySecrets};
use lens_core::types::*;
use serde_json::{json, Map, Value};

const DB: &str = "mstudio_test";

async fn engine() -> (Engine, String) {
    let dir = std::env::temp_dir().join(format!("lens-test-{}", uuid_like()));
    let e = Engine::new(ConnStore::new(dir.join("connections.json")), Arc::new(MemorySecrets::default()));
    let c = Connection { id: String::new(), name: "test".into(), color: String::new(), host: "127.0.0.1".into(), port: 3306, user: "mstudio".into(), database: Some(DB.into()), read_only: None, ssh: None, ssl: None };
    let saved = e.save_connection(c, Some("Mstudio_pass1".into())).await.unwrap();
    (e, saved.id)
}

fn uuid_like() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn end_to_end() {
    let (e, id) = engine().await;
    assert!(e.test_connection(e.list_connections()[0].clone(), None).await.unwrap().starts_with('8'));
    e.query(&id, Some(DB), "DROP TABLE IF EXISTS lens_items; DROP PROCEDURE IF EXISTS lens_two").await.unwrap();
    let setup = e
        .query(
            &id,
            Some(DB),
            "CREATE TABLE lens_items (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL, price DECIMAL(10,2), big BIGINT, flag TINYINT(1) NOT NULL DEFAULT 0, kind ENUM('a','b','c''q') DEFAULT 'a', data VARBINARY(8), meta JSON, created DATETIME(3));
             INSERT INTO lens_items (name, price, big, flag, kind, data, meta, created) VALUES ('Coffee', 3.50, 9007199254740993, 1, 'b', 0x00FF, '{\"a\": 1}', '2025-01-02 03:04:05.123'), ('it''s \\\\ \"quoted\"', NULL, 5, 0, 'c''q', NULL, NULL, NULL);
             DELIMITER $$
             CREATE PROCEDURE lens_two() BEGIN SELECT 1 AS a; SELECT 'x' AS b; END$$
             DELIMITER ;",
        )
        .await
        .unwrap();
    assert!(setup.iter().all(|r| r.kind != "error"), "{setup:?}");

    assert!(e.databases(&id).await.unwrap().contains(&DB.to_string()));
    let objs = e.objects(&id, DB).await.unwrap();
    assert!(objs.tables.iter().any(|t| t.name == "lens_items"));
    assert!(objs.routines.iter().any(|r| r.name == "lens_two" && r.kind == "procedure"));

    let schema = e.schema(&id, DB).await.unwrap();
    let cols = &schema["lens_items"];
    assert_eq!(cols[0].pk, Some(true));
    assert_eq!(cols[0].auto_increment, Some(true));
    assert_eq!(cols.iter().find(|c| c.name == "kind").unwrap().options.as_deref(), Some(&["a".to_string(), "b".into(), "c'q".into()][..]));
    assert_eq!(cols.iter().find(|c| c.name == "flag").unwrap().default_value.as_deref(), Some("0"));

    let page = e.table_page(&id, DB, "lens_items", PageRequest { page: 0, page_size: 50, sort: Some(SortSpec { column: "id".into(), dir: "asc".into() }), filter: String::new() }).await.unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.key_columns, vec!["id".to_string()]);
    let r0 = &page.rows[0];
    assert_eq!(r0[0], json!(1));
    assert_eq!(r0[2], json!("3.50"), "decimal keeps precision as text");
    assert_eq!(r0[3], json!("9007199254740993"), "unsafe bigint stays a string");
    assert_eq!(r0[4], json!(1));
    assert_eq!(r0[6], json!("0x00FF"));
    assert_eq!(r0[7], json!("{\"a\": 1}"));
    assert_eq!(r0[8], json!("2025-01-02 03:04:05.123"));
    assert_eq!(page.rows[1][1], json!("it's \\ \"quoted\""));
    assert_eq!(page.rows[1][2], Value::Null);

    // Filter + sort
    let f = e.table_page(&id, DB, "lens_items", PageRequest { page: 0, page_size: 50, sort: None, filter: "kind = 'b'".into() }).await.unwrap();
    assert_eq!(f.total, 1);
    assert!(e.table_page(&id, DB, "lens_items", PageRequest { page: 0, page_size: 50, sort: None, filter: "nope = 1".into() }).await.is_err());

    // Queries: multi statements, CALL, OK packets, error stops.
    let res = e.query(&id, Some(DB), "SELECT name FROM lens_items ORDER BY id; UPDATE lens_items SET flag = 1 - flag WHERE id > 0; CALL lens_two(); SELECT * FROM nope; SELECT 1").await.unwrap();
    let kinds: Vec<&str> = res.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(kinds, vec!["rows", "ok", "rows", "rows", "error"], "{res:?}");
    assert_eq!(res[1].affected_rows, Some(2));
    assert!(res[4].error.as_ref().unwrap().contains("1146"));

    // Edits in one transaction.
    let changes = vec![
        RowChange::Update { key: obj(json!({"id": 1})), values: obj(json!({"name": "Espresso", "price": "4.25", "data": "0xABCD"})) },
        RowChange::Insert { values: obj(json!({"name": "Tea", "kind": "a"})) },
        RowChange::Delete { key: obj(json!({"id": 2})) },
    ];
    let preview = e.preview_changes(DB, "lens_items", &page.columns, &changes);
    assert!(preview[0].contains("`price` = 4.25") && preview[0].contains("X'ABCD'"), "{preview:?}");
    e.apply_changes(&id, DB, "lens_items", &page.columns, &changes).await.unwrap();
    let after = e.query(&id, Some(DB), "SELECT name, price, HEX(data) FROM lens_items ORDER BY id").await.unwrap();
    assert_eq!(after[0].rows, vec![vec![json!("Espresso"), json!("4.25"), json!("ABCD")], vec![json!("Tea"), Value::Null, Value::Null]]);

    // A missing row rolls back the whole batch.
    let bad = vec![
        RowChange::Update { key: obj(json!({"id": 1})), values: obj(json!({"name": "Should not stay"})) },
        RowChange::Delete { key: obj(json!({"id": 999})) },
    ];
    assert!(e.apply_changes(&id, DB, "lens_items", &page.columns, &bad).await.is_err());
    let still = e.query(&id, Some(DB), "SELECT name FROM lens_items WHERE id = 1").await.unwrap();
    assert_eq!(still[0].rows[0][0], json!("Espresso"));

    // Wrong password gives a clear error.
    let mut wrong = e.list_connections()[0].clone();
    wrong.user = "nobody_here".into();
    let err = e.test_connection(wrong, Some("x".into())).await.unwrap_err().to_string();
    assert!(err.contains("1045"), "{err}");

    e.query(&id, Some(DB), "DROP TABLE lens_items; DROP PROCEDURE lens_two").await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn exports() {
    let (e, id) = engine().await;
    e.query(&id, Some(DB), "DROP TABLE IF EXISTS lens_exp; CREATE TABLE lens_exp (id INT PRIMARY KEY, name VARCHAR(40), price DECIMAL(8,2), note TEXT); INSERT INTO lens_exp VALUES (1, 'a,b \"q\"', 1.50, 'line1\nline2'), (2, NULL, 20, 'x|y')").await.unwrap();
    let dir = std::env::temp_dir().join(format!("lens-exp-{}", uuid_like()));
    std::fs::create_dir_all(&dir).unwrap();
    for f in ["csv", "tsv", "json", "sql", "markdown", "xlsx"] {
        let path = dir.join(format!("out.{f}"));
        let n = e.export(&id, DB, "lens_exp", "", f, &path, |_| true).await.unwrap();
        assert_eq!(n, 2, "{f}");
        assert!(std::fs::metadata(&path).unwrap().len() > 20, "{f}");
    }
    let csv = std::fs::read_to_string(dir.join("out.csv")).unwrap();
    assert!(csv.starts_with("\u{feff}id,name,price,note\n1,\"a,b \"\"q\"\"\",1.50,\"line1\nline2\"\n2,,20.00,x|y"), "{csv:?}");
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("out.json")).unwrap()).unwrap();
    assert_eq!(json[1]["name"], serde_json::Value::Null);
    let sql = std::fs::read_to_string(dir.join("out.sql")).unwrap();
    // The SQL export must load back into an identical table.
    e.query(&id, Some(DB), "DROP TABLE IF EXISTS lens_exp2; CREATE TABLE lens_exp2 LIKE lens_exp").await.unwrap();
    let res = e.query(&id, Some(DB), &sql.replace("`lens_exp`", "`lens_exp2`")).await.unwrap();
    assert!(res.iter().all(|r| r.kind != "error"), "{res:?}");
    let a = e.query(&id, Some(DB), "SELECT * FROM lens_exp ORDER BY id").await.unwrap();
    let b = e.query(&id, Some(DB), "SELECT * FROM lens_exp2 ORDER BY id").await.unwrap();
    assert_eq!(a[0].rows, b[0].rows);
    e.query(&id, Some(DB), "DROP TABLE lens_exp; DROP TABLE lens_exp2").await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}
