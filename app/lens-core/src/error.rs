use thiserror::Error;

#[derive(Debug, Error)]
pub enum LensError {
    #[error("{0}")]
    Msg(String),
    #[error("{}", mysql_message(.0))]
    Mysql(#[from] mysql_async::Error),
    #[error("SSH: {0}")]
    Ssh(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, LensError>;

pub fn msg(s: impl Into<String>) -> LensError {
    LensError::Msg(s.into())
}

fn mysql_message(e: &mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(s) => format!("Error {} ({}): {}", s.code, s.state, s.message),
        mysql_async::Error::Io(io) => {
            let t = io.to_string();
            if t.contains("refused") {
                format!("Connection refused ({t}). Is the server running and the port open?")
            } else if t.contains("timed out") {
                "Connection timed out. Check host, port and firewall.".into()
            } else {
                t
            }
        }
        other => other.to_string(),
    }
}

impl serde::Serialize for LensError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
