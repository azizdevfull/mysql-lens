//! SSH local port forwarding: 127.0.0.1:<random> -> ssh -> db host:port.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::error::{LensError, Result};
use crate::types::SshConfig;

struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _key: &russh::keys::PublicKeyOrCertificate) -> std::result::Result<bool, Self::Error> {
        // Like `ssh -o StrictHostKeyChecking=accept-new` without a known_hosts file.
        Ok(true)
    }
}

pub struct Tunnel {
    pub local_port: u16,
    task: JoinHandle<()>,
    handle: Arc<Handle<Client>>,
}

impl Tunnel {
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
        let h = self.handle.clone();
        tokio::spawn(async move {
            let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        });
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

pub fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        home().join(rest)
    } else if p == "~" {
        home()
    } else {
        PathBuf::from(p)
    }
}

const DEFAULT_KEYS: [&str; 4] = ["id_ed25519", "id_rsa", "id_ecdsa", "id_ed25519_sk"];

async fn authenticate(h: &mut Handle<Client>, ssh: &SshConfig, password: Option<&str>, passphrase: Option<&str>) -> Result<()> {
    let mut tried: Vec<String> = Vec::new();
    if ssh.auth == "password" {
        let r = h.authenticate_password(ssh.user.clone(), password.unwrap_or_default()).await.map_err(|e| LensError::Ssh(e.to_string()))?;
        if r.success() {
            return Ok(());
        }
        tried.push("password".into());
    } else {
        // Chosen key first, then the default keys in ~/.ssh, the way `ssh` does it.
        let mut files: Vec<PathBuf> = Vec::new();
        if let Some(k) = ssh.key_path.as_deref().filter(|k| !k.trim().is_empty()) {
            files.push(expand_home(k.trim()));
        }
        for k in DEFAULT_KEYS {
            let f = home().join(".ssh").join(k);
            if !files.contains(&f) {
                files.push(f);
            }
        }
        for f in files {
            if !f.exists() {
                continue;
            }
            let key = match load_secret_key(&f, passphrase) {
                Ok(k) => k,
                Err(e) => {
                    if Some(f.as_path()) == ssh.key_path.as_deref().map(expand_home).as_deref() {
                        return Err(LensError::Ssh(format!("cannot use key {}: {e}", f.display())));
                    }
                    continue;
                }
            };
            let hash = h.best_supported_rsa_hash().await.ok().flatten().flatten();
            let r = h
                .authenticate_publickey(ssh.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| LensError::Ssh(e.to_string()))?;
            if r.success() {
                return Ok(());
            }
            tried.push(f.display().to_string());
        }
    }
    Err(LensError::Ssh(format!(
        "server {}@{} rejected {}",
        ssh.user,
        ssh.host,
        if tried.is_empty() { "all methods (no usable key found)".to_string() } else { tried.join(", ") }
    )))
}

pub async fn open_tunnel(ssh: &SshConfig, password: Option<&str>, passphrase: Option<&str>, dst_host: &str, dst_port: u16, timeout: Duration) -> Result<Tunnel> {
    let config = Arc::new(client::Config { inactivity_timeout: None, keepalive_interval: Some(Duration::from_secs(15)), ..Default::default() });
    let mut handle = tokio::time::timeout(timeout, client::connect(config, (ssh.host.as_str(), ssh.port), Client))
        .await
        .map_err(|_| LensError::Ssh(format!("connection to {}:{} timed out", ssh.host, ssh.port)))?
        .map_err(|e| LensError::Ssh(e.to_string()))?;
    authenticate(&mut handle, ssh, password, passphrase).await?;
    let handle = Arc::new(handle);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_port = listener.local_addr()?.port();
    let h = handle.clone();
    let dst = dst_host.to_string();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let h = h.clone();
            let dst = dst.clone();
            tokio::spawn(async move {
                if let Ok(ch) = h.channel_open_direct_tcpip(dst, dst_port as u32, "127.0.0.1", 0).await {
                    let mut stream = ch.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                }
            });
        }
    });
    Ok(Tunnel { local_port, task, handle })
}
