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
    let c = Connection { id: String::new(), name: "test".into(), color: String::new(), host: "127.0.0.1".into(), port: 3306, user: "mstudio".into(), database: Some(DB.into()), read_only: None, ssh: None, ssl: None, folder: None };
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

#[tokio::test(flavor = "multi_thread")]
async fn dump_and_import_roundtrip() {
    use lens_core::dump::DumpOptions;
    let (e, id) = engine().await;
    e.query(&id, Some(DB), "DROP TABLE IF EXISTS lens_d1; DROP VIEW IF EXISTS lens_dv; DROP FUNCTION IF EXISTS lens_f").await.unwrap();
    let setup = e
        .query(
            &id,
            Some(DB),
            "CREATE TABLE lens_d1 (id INT PRIMARY KEY, name VARCHAR(50), price DECIMAL(10,2), data BLOB, j JSON, created TIMESTAMP NULL, gen INT AS (id * 2) VIRTUAL);
             INSERT INTO lens_d1 (id, name, price, data, j, created) VALUES (1, 'it''s; -- not a comment', 1.50, 0x00FF27, '{\"k\": [1, 2]}', '2025-03-04 05:06:07'), (2, 'emoji 😀 Oʻzbek', NULL, NULL, NULL, NULL);
             CREATE VIEW lens_dv AS SELECT id, name FROM lens_d1;
             DELIMITER //
             CREATE FUNCTION lens_f(x INT) RETURNS INT DETERMINISTIC RETURN x + 1//
             DELIMITER ;",
        )
        .await
        .unwrap();
    assert!(setup.iter().all(|r| r.kind != "error"), "{setup:?}");
    let dir = std::env::temp_dir().join(format!("lens-dump-{}", uuid_like()));
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["dump.sql", "dump.sql.gz"] {
        let path = dir.join(name);
        let o = DumpOptions { database: DB.into(), tables: vec!["lens_d1".into(), "lens_dv".into()], structure: true, data: true, drop_objects: true, create_database: false, views: true, routines: true, triggers: true };
        let r = e.dump(&id, &o, &path, |_, _, _, _| true).await.unwrap();
        assert_eq!((r.tables, r.rows), (1, 2), "{name}");
        let before = e.query(&id, Some(DB), "SELECT id, name, price, HEX(data), j, created, gen FROM lens_d1 ORDER BY id").await.unwrap();
        e.query(&id, Some(DB), "DROP VIEW lens_dv; DROP TABLE lens_d1; DROP FUNCTION lens_f").await.unwrap();
        let imp = e.import_sql(&id, Some(DB), &path, false, |_, _, _| true).await.unwrap();
        assert!(imp.errors.is_empty() && imp.statements > 5, "{imp:?}");
        let after = e.query(&id, Some(DB), "SELECT id, name, price, HEX(data), j, created, gen FROM lens_d1 ORDER BY id").await.unwrap();
        assert_eq!(before[0].rows, after[0].rows, "{name}");
        let f = e.query(&id, Some(DB), "SELECT lens_f(41), (SELECT COUNT(*) FROM lens_dv)").await.unwrap();
        assert_eq!(f[0].rows[0], vec![json!(42), json!(2)]);
    }
    // continue_on_error collects failures
    let bad = dir.join("bad.sql");
    std::fs::write(&bad, "CREATE TABLE IF NOT EXISTS lens_d2 (id INT);\nINSERT INTO nope VALUES (1);\nINSERT INTO lens_d2 VALUES (1),(2);\n").unwrap();
    assert!(e.import_sql(&id, Some(DB), &bad, false, |_, _, _| true).await.is_err());
    let r = e.import_sql(&id, Some(DB), &bad, true, |_, _, _| true).await.unwrap();
    assert_eq!((r.statements, r.errors.len()), (2, 1));
    e.query(&id, Some(DB), "DROP VIEW lens_dv; DROP TABLE lens_d1; DROP TABLE lens_d2; DROP FUNCTION lens_f").await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn data_import() {
    use lens_core::data_import::{preview, ImportPlan, Mapping, NewColumn};
    let (e, id) = engine().await;
    let dir = std::env::temp_dir().join(format!("lens-imp-{}", uuid_like()));
    std::fs::create_dir_all(&dir).unwrap();
    e.query(&id, Some(DB), "DROP TABLE IF EXISTS lens_people; DROP TABLE IF EXISTS lens_kv; DROP TABLE IF EXISTS lens_xl").await.unwrap();

    // CSV with ; delimiter, quotes, newlines -> new table
    let csv = dir.join("people.csv");
    std::fs::write(&csv, "Full Name;Age;Joined;Note\n\"Ali; Valiyev\";30;2024-01-02;\"multi\nline \"\"quoted\"\"\"\nOʻlmas;;2024-02-03;\n").unwrap();
    let p = preview(&csv, None).unwrap();
    assert_eq!(p.options.delimiter, ";");
    assert_eq!(p.source_columns, vec!["Full Name", "Age", "Joined", "Note"]);
    assert_eq!(p.rows.len(), 2);
    assert_eq!(&p.inferred_types[1..3], &["INT".to_string(), "DATE".to_string()]);
    let plan = ImportPlan {
        create_table: true,
        table: "lens_people".into(),
        new_columns: vec![
            NewColumn { name: "full_name".into(), col_type: "VARCHAR(100)".into(), source: 0 },
            NewColumn { name: "age".into(), col_type: "INT".into(), source: 1 },
            NewColumn { name: "joined".into(), col_type: "DATE".into(), source: 2 },
            NewColumn { name: "note".into(), col_type: "TEXT".into(), source: 3 },
        ],
        mapping: vec![],
        mode: "insert".into(),
        truncate_first: false,
        empty_as_null: true,
        batch_size: 1,
    };
    assert_eq!(e.import_data(&id, DB, &csv, &p.options, &plan, |_| true).await.unwrap(), 2);
    let rows = e.query(&id, Some(DB), "SELECT * FROM lens_people ORDER BY joined").await.unwrap();
    assert_eq!(rows[0].rows, vec![vec![json!("Ali; Valiyev"), json!(30), json!("2024-01-02"), json!("multi\nline \"quoted\"")], vec![json!("Oʻlmas"), Value::Null, json!("2024-02-03"), Value::Null]]);

    // JSON into an existing table: mapping, REPLACE, and full rollback on failure
    e.query(&id, Some(DB), "CREATE TABLE lens_kv (id INT PRIMARY KEY, v VARCHAR(10) NOT NULL); INSERT INTO lens_kv VALUES (1, 'old'), (9, 'keep')").await.unwrap();
    let js = dir.join("rows.json");
    std::fs::write(&js, r#"[{"ID": 1, "value": "one"}, {"ID": 2, "value": "two", "extra": true}]"#).unwrap();
    let p = preview(&js, None).unwrap();
    assert_eq!(p.source_columns, vec!["ID", "value", "extra"]);
    let map = |trunc: bool| ImportPlan { create_table: false, table: "lens_kv".into(), new_columns: vec![], mapping: vec![Mapping { column: "id".into(), source: 0 }, Mapping { column: "v".into(), source: 1 }], mode: "replace".into(), truncate_first: trunc, empty_as_null: true, batch_size: 1 };
    e.import_data(&id, DB, &js, &p.options, &map(false), |_| true).await.unwrap();
    assert_eq!(kv(&e, &id).await, vec![vec![json!(1), json!("one")], vec![json!(2), json!("two")], vec![json!(9), json!("keep")]]);
    std::fs::write(&js, r#"[{"ID": 5, "value": "ok"}, {"ID": 6, "value": "this value is far too long"}]"#).unwrap();
    assert!(e.import_data(&id, DB, &js, &p.options, &map(true), |_| true).await.is_err());
    assert_eq!(kv(&e, &id).await.len(), 3, "failed import must not delete or insert anything");

    // Excel produced by our own exporter
    e.query(&id, Some(DB), "CREATE TABLE lens_src (id INT PRIMARY KEY, name VARCHAR(30), price DECIMAL(8,2), day DATE); INSERT INTO lens_src VALUES (1, 'Tea', 2.50, '2025-01-01'), (2, 'Coffee', 3.75, NULL)").await.unwrap();
    let xl = dir.join("src.xlsx");
    e.export(&id, DB, "lens_src", "", "xlsx", &xl, |_| true).await.unwrap();
    let p = preview(&xl, None).unwrap();
    assert_eq!(p.source_columns, vec!["id", "name", "price", "day"]);
    assert_eq!(p.row_count, Some(2));
    let plan = ImportPlan {
        create_table: true,
        table: "lens_xl".into(),
        new_columns: p.source_columns.iter().enumerate().map(|(i, n)| NewColumn { name: n.clone(), col_type: if i == 1 { "VARCHAR(30)".into() } else { p.inferred_types[i].clone() }, source: i }).collect(),
        mapping: vec![],
        mode: "insert".into(),
        truncate_first: false,
        empty_as_null: true,
        batch_size: 500,
    };
    e.import_data(&id, DB, &xl, &p.options, &plan, |_| true).await.unwrap();
    let a = e.query(&id, Some(DB), "SELECT id, name, CAST(price AS DOUBLE) FROM lens_src ORDER BY id").await.unwrap();
    let b = e.query(&id, Some(DB), "SELECT id, name, CAST(price AS DOUBLE) FROM lens_xl ORDER BY id").await.unwrap();
    assert_eq!(a[0].rows, b[0].rows);
    e.query(&id, Some(DB), "DROP TABLE lens_people; DROP TABLE lens_kv; DROP TABLE lens_src; DROP TABLE lens_xl").await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

async fn kv(e: &Engine, id: &str) -> Vec<Vec<Value>> {
    e.query(id, Some(DB), "SELECT * FROM lens_kv ORDER BY id").await.unwrap()[0].rows.clone()
}
