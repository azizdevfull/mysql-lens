//! Export and import of the connection list. Passwords are never written.
//!
//! The file uses the same shape as the MySQL Lens VS Code extension
//! (`{"format":"mysql-lens-connections","version":1,"connections":[…]}`), so a
//! file exported by either one can be imported by the other. Import also
//! accepts a bare array and the desktop app's own connection shape.

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::error::{msg, Result};
use crate::types::{Connection, SshConfig};

pub const FORMAT: &str = "mysql-lens-connections";

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: usize,
    /// Already in the list (same name, host, port and user).
    pub skipped: usize,
}

/// The export file for `list`, without ids or secrets.
pub fn export_json(list: &[Connection]) -> Value {
    let items: Vec<Value> = list
        .iter()
        .map(|c| {
            let mut o = json!({
                "name": c.name,
                "color": if c.color.is_empty() { String::new() } else { format!("charts.{}", c.color) },
                "host": c.host,
                "port": c.port,
                "user": c.user,
                "database": c.database.clone().unwrap_or_default(),
                "readOnly": c.read_only.unwrap_or(false),
                "ssl": { "enabled": c.ssl.unwrap_or(false), "rejectUnauthorized": true },
            });
            if let Some(f) = c.folder.as_ref().filter(|f| !f.is_empty()) {
                o["folder"] = json!(f);
            }
            if let Some(s) = &c.ssh {
                let mut ssh = json!({
                    "enabled": true,
                    "host": s.host,
                    "port": s.port,
                    "user": s.user,
                    "auth": if s.auth == "key" { "privateKey" } else { s.auth.as_str() },
                });
                if let Some(k) = s.key_path.as_ref().filter(|k| !k.is_empty()) {
                    ssh["privateKeyPath"] = json!(k);
                }
                o["ssh"] = ssh;
            }
            o
        })
        .collect();
    json!({ "format": FORMAT, "version": 1, "connections": items })
}

fn str_of(o: &Map<String, Value>, key: &str) -> Option<String> {
    o.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn port_of(o: &Map<String, Value>, key: &str, default: u16) -> u16 {
    match o.get(key) {
        Some(Value::Number(n)) => n.as_u64().and_then(|n| u16::try_from(n).ok()),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|p| *p > 0)
    .unwrap_or(default)
}

fn ssh_of(v: Option<&Value>) -> Option<SshConfig> {
    let o = v?.as_object()?;
    // The extension keeps a disabled SSH block around; the app omits it.
    if o.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let auth = match o.get("auth").and_then(Value::as_str).unwrap_or("password") {
        "privateKey" | "key" => "key",
        "agent" => "agent",
        _ => "password",
    };
    Some(SshConfig {
        host: str_of(o, "host")?,
        port: port_of(o, "port", 22),
        user: str_of(o, "user").unwrap_or_default(),
        auth: auth.to_string(),
        key_path: if auth == "key" { str_of(o, "privateKeyPath").or_else(|| str_of(o, "keyPath")) } else { None },
    })
}

/// Connections described by an export file. Ids are left empty; entries without a host are ignored.
pub fn parse_import(text: &str) -> Result<Vec<Connection>> {
    let raw: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| msg(format!("Not a valid JSON file: {e}")))?;
    let items = match &raw {
        Value::Array(a) => a.as_slice(),
        Value::Object(o) => match o.get("connections") {
            Some(Value::Array(a)) => a.as_slice(),
            _ => return Err(msg("This file does not contain a connection list.")),
        },
        _ => return Err(msg("This file does not contain a connection list.")),
    };
    Ok(items
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|o| {
            let host = str_of(o, "host")?;
            let user = str_of(o, "user").unwrap_or_else(|| "root".into());
            let ssl = match o.get("ssl") {
                Some(Value::Bool(b)) => *b,
                Some(Value::Object(s)) => s.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                _ => false,
            };
            let color = str_of(o, "color").map(|c| c.trim_start_matches("charts.").to_string()).unwrap_or_default();
            Some(Connection {
                id: String::new(),
                name: str_of(o, "name").unwrap_or_else(|| format!("{user}@{host}")),
                color,
                port: port_of(o, "port", 3306),
                database: str_of(o, "database"),
                read_only: o.get("readOnly").and_then(Value::as_bool).filter(|b| *b),
                ssh: ssh_of(o.get("ssh")),
                ssl: ssl.then_some(true),
                folder: str_of(o, "folder"),
                host,
                user,
            })
        })
        .collect())
}

/// True when `c` is already in `list` (same name, host, port and user).
pub fn is_duplicate(list: &[Connection], c: &Connection) -> bool {
    list.iter().any(|x| x.name == c.name && x.host.eq_ignore_ascii_case(&c.host) && x.port == c.port && x.user == c.user)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(name: &str) -> Connection {
        Connection {
            id: "id-1".into(),
            name: name.into(),
            color: "red".into(),
            host: "db.example.com".into(),
            port: 3307,
            user: "app".into(),
            database: Some("shop".into()),
            read_only: Some(true),
            ssh: Some(SshConfig { host: "bastion".into(), port: 2222, user: "ubuntu".into(), auth: "key".into(), key_path: Some("~/.ssh/id_ed25519".into()) }),
            ssl: Some(true),
            folder: Some("Production".into()),
        }
    }

    #[test]
    fn round_trip_keeps_everything_but_the_id() {
        let text = export_json(&[conn("Prod")]).to_string();
        assert!(!text.contains("id-1"));
        let back = parse_import(&text).unwrap();
        assert_eq!(back, vec![Connection { id: String::new(), ..conn("Prod") }]);
    }

    #[test]
    fn export_matches_the_extension_shape() {
        let v = export_json(&[conn("Prod")]);
        assert_eq!(v["format"], FORMAT);
        let c = &v["connections"][0];
        assert_eq!(c["color"], "charts.red");
        assert_eq!(c["ssh"]["auth"], "privateKey");
        assert_eq!(c["ssh"]["privateKeyPath"], "~/.ssh/id_ed25519");
        assert_eq!(c["ssl"]["enabled"], true);
        assert!(c.get("password").is_none());
    }

    #[test]
    fn reads_an_extension_export() {
        let text = r#"{"format":"mysql-lens-connections","version":1,"connections":[
          {"name":"Local","color":"","host":"127.0.0.1","port":3306,"user":"root","database":"","savePassword":true,"readOnly":false,"connectTimeout":10,
           "ssl":{"enabled":false,"rejectUnauthorized":true},"ssh":{"enabled":false,"host":"","port":22,"user":"","auth":"password"}},
          {"name":"Via agent","host":"10.0.0.5","port":"3306","user":"app","ssh":{"enabled":true,"host":"jump","port":22,"user":"me","auth":"agent","privateKeyPath":"/k"}},
          {"name":"No host"},
          42
        ]}"#;
        let list = parse_import(text).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].ssh.clone(), list[0].ssl, list[0].database.clone(), list[0].read_only), (None, None, None, None));
        let ssh = list[1].ssh.clone().unwrap();
        assert_eq!((ssh.auth.as_str(), ssh.key_path), ("agent", None));
        assert_eq!(list[1].port, 3306);
    }

    #[test]
    fn reads_a_bare_array_and_fills_the_name() {
        let list = parse_import("\u{feff}[{\"host\":\"h\",\"user\":\"u\",\"port\":0}]").unwrap();
        assert_eq!((list[0].name.as_str(), list[0].port), ("u@h", 3306));
    }

    #[test]
    fn rejects_other_files() {
        assert!(parse_import("{\"a\":1}").is_err());
        assert!(parse_import("nope").is_err());
    }

    #[test]
    fn duplicates_match_on_name_host_port_user() {
        let list = vec![conn("Prod")];
        assert!(is_duplicate(&list, &Connection { host: "DB.example.com".into(), ..conn("Prod") }));
        assert!(!is_duplicate(&list, &conn("Prod 2")));
    }
}
