//! Web access: serves the app's UI and its commands over HTTP, so the app can be
//! used from a browser (on this computer, or on other devices when allowed).
//!
//! - Off by default. Listens on 127.0.0.1, or on every interface when `lan` is on.
//! - Every request needs the access token. Opening `/login?token=…` stores it in an
//!   HttpOnly cookie; API calls also need the `x-lens` header and, when the browser
//!   sends one, a same-origin `Origin`, so other web sites cannot drive the app.
//! - The browser never names a file on this computer: uploads go to a private
//!   folder, and files the app writes for the browser are streamed back once and deleted.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use futures_util::stream;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as J};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, watch};

use crate::error::{msg, Result};
use crate::mcp::{local_host, new_token, same};

/// Largest JSON body of one command call (cell values travel as hex).
const MAX_CALL_BODY: usize = 256 * 1024 * 1024;
/// Largest uploaded file (SQL dumps can be big).
const MAX_UPLOAD: u64 = 8 * 1024 * 1024 * 1024;
/// Name of the cookie that carries the access token.
const COOKIE: &str = "lens_web";
/// How often an idle event stream gets a comment, so proxies keep it open.
const PING: Duration = Duration::from_secs(25);

type Body = UnsyncBoxBody<Bytes, std::io::Error>;

/* ----------------------------- settings ----------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    /// Listen on every network interface, not only on 127.0.0.1.
    #[serde(default)]
    pub lan: bool,
    #[serde(default)]
    pub token: String,
}

fn default_port() -> u16 {
    7431
}

impl Default for WebSettings {
    fn default() -> Self {
        Self { enabled: false, port: default_port(), lan: false, token: new_token() }
    }
}

pub struct WebSettingsStore {
    path: PathBuf,
}

impl WebSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Saved settings, or defaults (off, with a fresh token) when there are none.
    pub fn load(&self) -> WebSettings {
        let mut s: WebSettings = std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if s.token.len() < 32 {
            s.token = new_token();
        }
        s
    }

    pub fn save(&self, s: &WebSettings) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

/// What the settings screen shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebStatus {
    pub settings: WebSettings,
    pub running: bool,
    pub port: Option<u16>,
    pub error: Option<String>,
    /// Addresses to open in a browser (this computer first).
    pub urls: Vec<String>,
}

impl WebStatus {
    pub fn new(settings: WebSettings, port: Option<u16>, error: Option<String>) -> Self {
        let mut urls = Vec::new();
        if let Some(p) = port {
            urls.push(format!("http://127.0.0.1:{p}"));
            if settings.lan {
                if let Some(ip) = lan_ip() {
                    urls.push(format!("http://{ip}:{p}"));
                }
            }
        }
        Self { settings, running: port.is_some(), port, error, urls }
    }
}

/// This computer's address on the local network, if it has one.
pub fn lan_ip() -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // Connecting a UDP socket only picks a route; nothing is sent.
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/* ----------------------------- host ----------------------------- */

/// The app behind the web server.
#[async_trait::async_trait]
pub trait WebHost: Send + Sync {
    /// Runs one app command with its JSON arguments, as the desktop UI would.
    /// Arguments named `path` are already local paths chosen by the server.
    async fn call(&self, cmd: &str, args: J) -> std::result::Result<J, String>;
    /// A file of the built UI (`index.html`, `assets/…`) and its media type.
    fn asset(&self, path: &str) -> Option<(Vec<u8>, String)>;
}

pub struct WebServer {
    host: Arc<dyn WebHost>,
    token: RwLock<String>,
    lan: bool,
    events: broadcast::Sender<Bytes>,
    /// Uploads and files waiting to be downloaded, one folder per id.
    files: PathBuf,
}

impl WebServer {
    pub fn new(host: Arc<dyn WebHost>, settings: &WebSettings, files: PathBuf) -> Arc<Self> {
        Arc::new(Self { host, token: RwLock::new(settings.token.clone()), lan: settings.lan, events: broadcast::channel(256).0, files })
    }

    /// Whether it listens on every interface.
    pub fn lan(&self) -> bool {
        self.lan
    }

    /// A new token signs every browser out.
    pub fn set_token(&self, token: &str) {
        *self.token.write().unwrap() = token.to_string();
    }

    /// Sends an app event (progress, AI approvals …) to every open browser.
    pub fn emit(&self, event: &str, payload: &impl Serialize) {
        if self.events.receiver_count() == 0 {
            return;
        }
        let data = json!({ "event": event, "payload": payload });
        let _ = self.events.send(Bytes::from(format!("data: {data}\n\n")));
    }

    fn authorized(&self, req: &Request<Incoming>) -> bool {
        let token = self.token.read().unwrap().clone();
        cookie(req, COOKIE).map(|c| same(&c, &token)).unwrap_or(false)
    }
}

pub struct WebHandle {
    pub port: u16,
    stop: Option<watch::Sender<bool>>,
    files: PathBuf,
}

impl WebHandle {
    /// Stops listening, closes open browser connections and deletes pending files.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(true);
            let _ = std::fs::remove_dir_all(&self.files);
        }
    }
}

impl Drop for WebHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts listening on `port` (0 picks a free port): 127.0.0.1 only, or every interface with `lan`.
pub async fn serve(server: Arc<WebServer>, port: u16) -> Result<WebHandle> {
    let ip: IpAddr = if server.lan { [0, 0, 0, 0].into() } else { [127, 0, 0, 1].into() };
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(ip, port)).await.map_err(|e| msg(format!("Could not open port {port} for web access ({e}). Choose another port.")))?;
    let port = listener.local_addr()?.port();
    // Files left by an earlier run are not wanted any more.
    let _ = std::fs::remove_dir_all(&server.files);
    std::fs::create_dir_all(&server.files)?;
    let (tx, rx) = watch::channel(false);
    let files = server.files.clone();
    tokio::spawn(async move {
        let mut stopped = rx.clone();
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let server = server.clone();
                    let mut stop = rx.clone();
                    tokio::spawn(async move {
                        let io = hyper_util::rt::TokioIo::new(stream);
                        let svc = hyper::service::service_fn(move |req| {
                            let server = server.clone();
                            async move { Ok::<_, std::convert::Infallible>(respond(&server, req, port).await) }
                        });
                        let conn = hyper::server::conn::http1::Builder::new().serve_connection(io, svc);
                        tokio::select! {
                            _ = conn => {}
                            _ = stop.changed() => {}
                        }
                    });
                }
            }
        }
    });
    Ok(WebHandle { port, stop: Some(tx), files })
}

/* ----------------------------- responses ----------------------------- */

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).map_err(|never| match never {}).boxed_unsync()
}

fn reply(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> Response<Body> {
    Response::builder().status(status).header("content-type", content_type).header("cache-control", "no-store").body(full(body)).unwrap()
}

fn plain(status: StatusCode, text: &str) -> Response<Body> {
    reply(status, "text/plain; charset=utf-8", text.to_string())
}

fn json_reply(status: StatusCode, v: &J) -> Response<Body> {
    reply(status, "application/json", v.to_string())
}

fn error(status: StatusCode, text: &str) -> Response<Body> {
    json_reply(status, &json!({ "error": text }))
}

fn redirect(to: &str) -> Response<Body> {
    Response::builder().status(StatusCode::SEE_OTHER).header("location", to).header("cache-control", "no-store").body(full(Bytes::new())).unwrap()
}

/// Headers every page gets: no framing, no sniffing, no token in a Referer.
fn harden(mut r: Response<Body>) -> Response<Body> {
    let h = r.headers_mut();
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert("x-frame-options", "DENY".parse().unwrap());
    h.insert("referrer-policy", "no-referrer".parse().unwrap());
    h.insert(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'".parse().unwrap(),
    );
    r
}

fn header(req: &Request<Incoming>, name: &str) -> Option<String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
}

fn cookie(req: &Request<Incoming>, name: &str) -> Option<String> {
    req.headers().get_all("cookie").iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

fn query_param(req: &Request<Incoming>, name: &str) -> Option<String> {
    form_value(req.uri().query()?, name)
}

/// One value of an `a=1&b=2` string, decoded.
fn form_value(form: &str, name: &str) -> Option<String> {
    form.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (pct_decode(k) == name).then(|| pct_decode(v))
    })
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() => {
                let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
                out.push(hex(b[i + 1]) << 4 | hex(b[i + 2]));
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn pct_encode(s: &str) -> String {
    s.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-._~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect()
}

/// A file name safe to create: no folders, no control characters, not too long.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control() && !"<>:\"|?*".contains(*c)).take(120).collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "file".into() } else { clean }
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit())
}

/* ----------------------------- routing ----------------------------- */

pub(crate) async fn respond(s: &WebServer, req: Request<Incoming>, port: u16) -> Response<Body> {
    // Bound to 127.0.0.1, only local names are accepted (blocks DNS rebinding).
    if !s.lan && !header(&req, "host").map(|h| local_host(&h, port)).unwrap_or(false) {
        return plain(StatusCode::FORBIDDEN, "Only local requests are accepted.");
    }
    let path = req.uri().path().to_string();
    if path == "/login" {
        return harden(login(s, req).await);
    }
    if !s.authorized(&req) {
        return if path.starts_with("/api/") { error(StatusCode::UNAUTHORIZED, "Not signed in. Open the address shown in MySQL Lens -> Settings -> Web access.") } else { redirect("/login") };
    }
    if path.starts_with("/api/") && req.method() == Method::POST {
        // A custom header cannot be sent cross-site without a CORS preflight, which is never allowed.
        if header(&req, "x-lens").is_none() {
            return error(StatusCode::FORBIDDEN, "Missing x-lens header.");
        }
        if let (Some(origin), Some(host)) = (header(&req, "origin"), header(&req, "host")) {
            if origin != format!("http://{host}") {
                return error(StatusCode::FORBIDDEN, "Requests from other web sites are not accepted.");
            }
        }
    }
    let method = req.method().clone();
    match (method, path.as_str()) {
        (Method::POST, p) if p.starts_with("/api/call/") => {
            let cmd = p["/api/call/".len()..].to_string();
            call(s, &cmd, req).await
        }
        (Method::POST, "/api/upload") => upload(s, req).await,
        (Method::GET, p) if p.starts_with("/api/download/") => download(s, &p["/api/download/".len()..]).await,
        (Method::GET, "/api/events") => events(s),
        (Method::POST, "/api/logout") => {
            let mut r = json_reply(StatusCode::OK, &json!({}));
            r.headers_mut().insert("set-cookie", format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0").parse().unwrap());
            r
        }
        (Method::GET | Method::HEAD, p) if !p.starts_with("/api/") => harden(asset(s, p)),
        _ => error(StatusCode::NOT_FOUND, "Not found."),
    }
}

const LOGIN_PAGE: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MySQL Lens</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;background:Canvas;color:CanvasText}
form{width:min(360px,calc(100vw - 32px));display:grid;gap:12px}h1{font-size:18px;margin:0}p{margin:0;opacity:.7}input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid #8886}
button{background:#2563eb;color:#fff;border:0;cursor:pointer}.err{color:#dc2626;opacity:1}</style></head>
<body><form method="post" action="/login"><h1>MySQL Lens</h1><p>Enter the access token shown in the desktop app under Settings &rarr; Web access.</p>{error}
<input name="token" type="password" placeholder="Access token" autocomplete="current-password" autofocus required><button type="submit">Sign in</button></form></body></html>"#;

fn login_page(error: bool) -> Response<Body> {
    let err = if error { r#"<p class="err">That token is not valid.</p>"# } else { "" };
    reply(if error { StatusCode::UNAUTHORIZED } else { StatusCode::OK }, "text/html; charset=utf-8", LOGIN_PAGE.replace("{error}", err))
}

/// `GET /login?token=…` (the link from the app) or the login form's `POST`.
async fn login(s: &WebServer, req: Request<Incoming>) -> Response<Body> {
    let given = match *req.method() {
        Method::POST => match Limited::new(req.into_body(), 8 * 1024).collect().await {
            Ok(b) => form_value(&String::from_utf8_lossy(&b.to_bytes()), "token"),
            Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request too large."),
        },
        _ => query_param(&req, "token"),
    };
    let Some(given) = given else { return login_page(false) };
    let token = s.token.read().unwrap().clone();
    if !same(given.trim(), &token) {
        return login_page(true);
    }
    let mut r = redirect("/");
    r.headers_mut().insert("set-cookie", format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000").parse().unwrap());
    r
}

/// Replaces the browser's file references in `args`: `{"upload": id}` becomes the uploaded
/// file, `{"download": name}` a new file to send back. A plain path string is refused.
fn resolve_paths(s: &WebServer, args: &mut J) -> std::result::Result<Option<String>, String> {
    let Some(obj) = args.as_object_mut() else { return Ok(None) };
    let Some(v) = obj.get_mut("path") else { return Ok(None) };
    if let Some(id) = v.get("upload").and_then(J::as_str) {
        *v = json!(upload_path(&s.files, id).ok_or("The uploaded file is gone. Choose it again.")?);
        Ok(None)
    } else if let Some(name) = v.get("download").and_then(J::as_str) {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = s.files.join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        *v = json!(dir.join(safe_name(name)));
        Ok(Some(id))
    } else if v.is_null() {
        Ok(None)
    } else {
        Err("Files are chosen in the browser, not by path.".into())
    }
}

fn upload_path(files: &Path, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    std::fs::read_dir(files.join(id)).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.is_file())
}

/// `POST /api/call/<command>` with the command's arguments as a JSON object.
async fn call(s: &WebServer, cmd: &str, req: Request<Incoming>) -> Response<Body> {
    let body = match Limited::new(req.into_body(), MAX_CALL_BODY).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request too large."),
    };
    let mut args: J = if body.is_empty() { json!({}) } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")),
        }
    };
    let download = match resolve_paths(s, &mut args) {
        Ok(d) => d,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    match s.host.call(cmd, args).await {
        Ok(result) => json_reply(StatusCode::OK, &json!({ "result": result, "download": download.map(|id| format!("/api/download/{id}")) })),
        Err(e) => {
            if let Some(id) = download {
                let _ = std::fs::remove_dir_all(s.files.join(id));
            }
            error(StatusCode::BAD_REQUEST, &e)
        }
    }
}

/// `POST /api/upload?name=<file name>` with the file as the body. Returns its id.
async fn upload(s: &WebServer, req: Request<Incoming>) -> Response<Body> {
    let name = safe_name(&query_param(&req, "name").unwrap_or_default());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = s.files.join(&id);
    let result: std::result::Result<u64, String> = async {
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let mut file = tokio::fs::File::create(dir.join(&name)).await.map_err(|e| e.to_string())?;
        let mut body = req.into_body();
        let mut total = 0u64;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|e| e.to_string())?;
            if let Ok(data) = frame.into_data() {
                total += data.len() as u64;
                if total > MAX_UPLOAD {
                    return Err(format!("The file is larger than {} GB.", MAX_UPLOAD >> 30));
                }
                file.write_all(&data).await.map_err(|e| e.to_string())?;
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok(total)
    }
    .await;
    match result {
        Ok(bytes) => json_reply(StatusCode::OK, &json!({ "id": id, "name": name, "bytes": bytes })),
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            error(StatusCode::BAD_REQUEST, &e)
        }
    }
}

/// `GET /api/download/<id>`: streams a file the app wrote, then deletes it.
async fn download(s: &WebServer, id: &str) -> Response<Body> {
    let Some(path) = upload_path(&s.files, id) else { return error(StatusCode::NOT_FOUND, "This download is no longer available.") };
    let dir = s.files.join(id);
    let Ok(file) = tokio::fs::File::open(&path).await else { return error(StatusCode::NOT_FOUND, "This download is no longer available.") };
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // hyper stops reading once `content-length` bytes went out, so the end is counted, not awaited.
    let chunks = stream::unfold(Some((file, dir, len)), |state| async move {
        let (mut file, dir, left) = state?;
        let mut buf = vec![0u8; 256 * 1024];
        match file.read(&mut buf).await {
            Ok(n) if n > 0 && (n as u64) < left => {
                buf.truncate(n);
                Some((Ok(Frame::data(Bytes::from(buf))), Some((file, dir, left - n as u64))))
            }
            Ok(n) => {
                drop(file);
                let _ = tokio::fs::remove_dir_all(&dir).await;
                buf.truncate(n.min(left as usize));
                (n > 0).then(|| (Ok(Frame::data(Bytes::from(buf))), None))
            }
            Err(e) => Some((Err(e), None)),
        }
    });
    Response::builder()
        .header("content-type", "application/octet-stream")
        .header("content-length", len)
        .header("content-disposition", format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", name.replace(|c: char| !c.is_ascii() || c == '"', "_"), pct_encode(&name)))
        .header("cache-control", "no-store")
        .body(StreamBody::new(chunks).boxed_unsync())
        .unwrap()
}

/// `GET /api/events`: app events as server-sent events, one JSON object per message.
fn events(s: &WebServer) -> Response<Body> {
    let rx = s.events.subscribe();
    let chunks = stream::unfold(rx, |mut rx| async move {
        loop {
            match tokio::time::timeout(PING, rx.recv()).await {
                Ok(Ok(data)) => return Some((Ok(Frame::data(data)), rx)),
                // Missed events are only progress updates; carry on.
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => return None,
                Err(_) => return Some((Ok(Frame::data(Bytes::from_static(b": ping\n\n"))), rx)),
            }
        }
    });
    Response::builder()
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-store")
        .body(StreamBody::new(chunks).boxed_unsync())
        .unwrap()
}

/// The built UI. Paths without a file fall back to `index.html` (single-page app).
fn asset(s: &WebServer, path: &str) -> Response<Body> {
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if rel.split('/').any(|p| p == "..") {
        return plain(StatusCode::BAD_REQUEST, "Bad path.");
    }
    let found = s.host.asset(rel).map(|a| (rel, a)).or_else(|| (!rel.rsplit('/').next().unwrap_or("").contains('.')).then(|| s.host.asset("index.html").map(|a| ("index.html", a))).flatten());
    let Some((name, (bytes, mime))) = found else {
        return plain(StatusCode::NOT_FOUND, if rel == "index.html" { "The UI is not built into this copy of the app." } else { "Not found." });
    };
    if name == "index.html" {
        // Tells the UI to talk to this server instead of the desktop bridge.
        let html = String::from_utf8_lossy(&bytes).replacen("<head>", "<head><meta name=\"lens-web\" content=\"1\">", 1);
        return reply(StatusCode::OK, "text/html; charset=utf-8", html);
    }
    // Built files have content hashes in their names, so they never change.
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    Response::builder().header("content-type", mime).header("cache-control", cache).body(full(bytes)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeHost;

    #[async_trait::async_trait]
    impl WebHost for FakeHost {
        async fn call(&self, cmd: &str, args: J) -> std::result::Result<J, String> {
            match cmd {
                "echo" => Ok(args),
                "write" => {
                    let path = args["path"].as_str().unwrap();
                    std::fs::write(path, b"hello").unwrap();
                    Ok(json!(5))
                }
                "read" => Ok(json!(std::fs::read_to_string(args["path"].as_str().unwrap()).unwrap())),
                _ => Err(format!("{cmd} is not available")),
            }
        }
        fn asset(&self, path: &str) -> Option<(Vec<u8>, String)> {
            match path {
                "index.html" => Some((b"<html><head><title>x</title></head></html>".to_vec(), "text/html".into())),
                "assets/app.js" => Some((b"console.log(1)".to_vec(), "text/javascript".into())),
                _ => None,
            }
        }
    }

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    async fn start() -> (Arc<WebServer>, WebHandle) {
        let settings = WebSettings { enabled: true, port: 0, lan: false, token: TOKEN.into() };
        let files = std::env::temp_dir().join(format!("lens-web-{}", uuid::Uuid::new_v4()));
        let server = WebServer::new(Arc::new(FakeHost), &settings, files);
        let handle = serve(server.clone(), 0).await.unwrap();
        (server, handle)
    }

    /// Sends a raw HTTP/1.1 request and returns the whole response as text.
    async fn http(port: u16, head: &str, body: &[u8]) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!("{head}\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n", body.len());
        s.write_all(req.as_bytes()).await.unwrap();
        s.write_all(body).await.unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn body_of(resp: &str) -> &str {
        resp.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("")
    }

    const AUTH: &str = "Cookie: lens_web=0123456789abcdef0123456789abcdef0123456789abcdef\r\nx-lens: 1";

    #[tokio::test]
    async fn login_sets_the_cookie_and_wrong_tokens_are_refused() {
        let (_s, h) = start().await;
        let r = http(h.port, "GET / HTTP/1.1", b"").await;
        assert!(r.starts_with("HTTP/1.1 303") && r.contains("location: /login"), "{r}");
        let r = http(h.port, &format!("GET /login?token={TOKEN} HTTP/1.1"), b"").await;
        assert!(r.starts_with("HTTP/1.1 303") && r.contains(&format!("set-cookie: lens_web={TOKEN}; Path=/; HttpOnly")), "{r}");
        let r = http(h.port, "POST /login HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded", b"token=wrong").await;
        assert!(r.starts_with("HTTP/1.1 401") && r.contains("not valid"), "{r}");
        let r = http(h.port, "POST /api/call/echo HTTP/1.1\r\nx-lens: 1\r\nCookie: lens_web=wrong", b"{}").await;
        assert!(r.starts_with("HTTP/1.1 401"), "{r}");
    }

    #[tokio::test]
    async fn calls_need_the_header_and_a_same_origin() {
        let (_s, h) = start().await;
        let r = http(h.port, "POST /api/call/echo HTTP/1.1\r\nCookie: lens_web=0123456789abcdef0123456789abcdef0123456789abcdef", b"{}").await;
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");
        let r = http(h.port, &format!("POST /api/call/echo HTTP/1.1\r\n{AUTH}\r\nOrigin: http://evil.example"), b"{}").await;
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");
        let r = http(h.port, &format!("POST /api/call/echo HTTP/1.1\r\n{AUTH}\r\nOrigin: http://127.0.0.1:{}", h.port), br#"{"a":1}"#).await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        assert_eq!(serde_json::from_str::<J>(body_of(&r)).unwrap(), json!({ "result": { "a": 1 }, "download": null }));
        let r = http(h.port, &format!("POST /api/call/nope HTTP/1.1\r\n{AUTH}"), b"{}").await;
        assert!(r.starts_with("HTTP/1.1 400") && r.contains("nope is not available"), "{r}");
    }

    #[tokio::test]
    async fn other_host_names_are_refused_when_local_only() {
        let (_s, h) = start().await;
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
        s.write_all(b"GET /login HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 403"), "{out}");
    }

    #[tokio::test]
    async fn paths_come_only_from_uploads_and_downloads() {
        let (s, h) = start().await;
        let r = http(h.port, &format!("POST /api/call/read HTTP/1.1\r\n{AUTH}"), br#"{"path":"/etc/passwd"}"#).await;
        assert!(r.starts_with("HTTP/1.1 400") && r.contains("not by path"), "{r}");

        let r = http(h.port, &format!("POST /api/upload?name=..%2F..%2Fdata%20file.csv HTTP/1.1\r\n{AUTH}"), b"a,b\n1,2\n").await;
        let up: J = serde_json::from_str(body_of(&r)).unwrap();
        assert_eq!(up["name"], "data file.csv");
        let r = http(h.port, &format!("POST /api/call/read HTTP/1.1\r\n{AUTH}"), json!({ "path": { "upload": up["id"] } }).to_string().as_bytes()).await;
        assert_eq!(serde_json::from_str::<J>(body_of(&r)).unwrap()["result"], "a,b\n1,2\n");
        let r = http(h.port, &format!("POST /api/call/read HTTP/1.1\r\n{AUTH}"), br#"{"path":{"upload":"../../etc"}}"#).await;
        assert!(r.starts_with("HTTP/1.1 400"), "{r}");

        let r = http(h.port, &format!("POST /api/call/write HTTP/1.1\r\n{AUTH}"), br#"{"path":{"download":"out.sql"}}"#).await;
        let res: J = serde_json::from_str(body_of(&r)).unwrap();
        assert_eq!(res["result"], 5);
        let url = res["download"].as_str().unwrap().to_string();
        let r = http(h.port, &format!("GET {url} HTTP/1.1\r\n{AUTH}"), b"").await;
        assert!(r.contains("filename=\"out.sql\"") && r.ends_with("hello"), "{r}");
        // Sent once, then deleted.
        let r = http(h.port, &format!("GET {url} HTTP/1.1\r\n{AUTH}"), b"").await;
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
        let files = s.files.clone();
        h.stop();
        assert!(!files.exists());
    }

    #[tokio::test]
    async fn serves_the_ui_with_the_web_marker() {
        let (_s, h) = start().await;
        let r = http(h.port, &format!("GET /some/route HTTP/1.1\r\n{AUTH}"), b"").await;
        assert!(r.contains("<head><meta name=\"lens-web\" content=\"1\"><title>"), "{r}");
        assert!(r.contains("content-security-policy"), "{r}");
        let r = http(h.port, &format!("GET /assets/app.js HTTP/1.1\r\n{AUTH}"), b"").await;
        assert!(r.contains("immutable") && r.ends_with("console.log(1)"), "{r}");
        let r = http(h.port, &format!("GET /assets/missing.js HTTP/1.1\r\n{AUTH}"), b"").await;
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
    }

    #[tokio::test]
    async fn events_reach_the_browser() {
        let (s, h) = start().await;
        let mut c = tokio::net::TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
        c.write_all(format!("GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{AUTH}\r\n\r\n", h.port).as_bytes()).await.unwrap();
        // Wait until the stream is subscribed.
        for _ in 0..50 {
            if s.events.receiver_count() > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        s.emit("dump-progress", &json!({ "table": "t" }));
        let mut buf = vec![0u8; 4096];
        let mut got = String::new();
        while !got.contains("dump-progress") {
            let n = tokio::time::timeout(Duration::from_secs(5), c.read(&mut buf)).await.unwrap().unwrap();
            assert!(n > 0);
            got.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        assert!(got.contains(r#"data: {"event":"dump-progress","payload":{"table":"t"}}"#), "{got}");
    }

    #[test]
    fn names_and_decoding() {
        assert_eq!(safe_name("C:\\Users\\a\\dump.sql.gz"), "dump.sql.gz");
        assert_eq!(safe_name("../.."), "file");
        assert_eq!(pct_decode("a%20b+c%2"), "a b c%2");
        assert_eq!(pct_encode("ö a.csv"), "%C3%B6%20a.csv");
    }
}
