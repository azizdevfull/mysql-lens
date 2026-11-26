//! Data shapes shared with the UI (serialized as camelCase JSON).

use serde::{Deserialize, Serialize};

/// A grid cell: string, number or NULL.
pub type Cell = serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pk: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_increment: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub numeric: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Binary column: values are shown as 0x… hex.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "password" | "key" | "agent"
    pub auth: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub name: String,
    pub kind: String,
    pub rows: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Routine {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbObjects {
    pub tables: Vec<TableMeta>,
    pub routines: Vec<Routine>,
    pub triggers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortSpec {
    pub column: String,
    pub dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub page: u64,
    pub page_size: u64,
    pub sort: Option<SortSpec>,
    pub filter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    pub total: u64,
    pub key_columns: Vec<String>,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    /// "rows" | "ok" | "error"
    pub kind: String,
    pub sql: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    pub total_rows: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RowChange {
    Update { key: serde_json::Map<String, Cell>, values: serde_json::Map<String, Cell> },
    Insert { values: serde_json::Map<String, Cell> },
    Delete { key: serde_json::Map<String, Cell> },
}

/// A foreign key: `columns` of `db.table` point at `ref_columns` of `ref_db.ref_table`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub db: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_db: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// The foreign keys of one table: the ones it declares and the ones pointing at it.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relations {
    pub outgoing: Vec<ForeignKey>,
    pub incoming: Vec<ForeignKey>,
}

/// Rows of `db.table` matching `filter` (a SQL condition) are counted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountRequest {
    pub db: String,
    pub table: String,
    pub filter: String,
}
