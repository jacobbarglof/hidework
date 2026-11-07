//! Local control channel for AI agents. A loopback-only HTTP endpoint (random port, random token)
//! receives `{method, params}` calls, hands them to the interface, and returns its reply. The
//! port and token live in `~/.hidework/control.json` (readable only by this user) so the
//! `hidework-mcp` bridge can find a running app.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Sender<Value>>>,
}

pub fn discovery_path() -> std::path::PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default();
    std::path::PathBuf::from(home).join(".hidework").join("control.json")
}

fn token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    (0..4)
        .map(|_| {
            let mut h = RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
            format!("{:016x}", h.finish())
        })
        .collect()
}

pub fn start(app: AppHandle, pending: Arc<Pending>) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("control channel unavailable: {e}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let secret = token();
    let path = discovery_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let info = json!({ "port": port, "token": secret, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION") });
    let _ = std::fs::write(&path, serde_json::to_vec_pretty(&info).unwrap_or_default());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (app, pending, secret) = (app.clone(), pending.clone(), secret.clone());
            std::thread::spawn(move || {
                let _ = handle(stream, &app, &pending, &secret);
            });
        }
    });
}

/// Remove the discovery file if it still points at this process.
pub fn stop() {
    let path = discovery_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if v["pid"].as_u64() == Some(std::process::id() as u64) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len())?;
    stream.write_all(&bytes)
}

fn handle(mut stream: TcpStream, app: &AppHandle, pending: &Pending, secret: &str) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let (mut length, mut auth) = (0usize, String::new());
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = v.trim().parse().unwrap_or(0),
                "x-hidework-token" => auth = v.trim().to_string(),
                _ => {}
            }
        }
    }
    if !line.starts_with("POST /rpc ") {
        return respond(&mut stream, "404 Not Found", &json!({"error": "POST /rpc only"}));
    }
    if auth != secret {
        return respond(&mut stream, "403 Forbidden", &json!({"error": "bad token"}));
    }
    let mut body = vec![0; length.min(64 << 20)];
    reader.read_exact(&mut body)?;
    let call: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let method = call["method"].as_str().unwrap_or("").to_string();
    if method == "ping" {
        return respond(&mut stream, "200 OK", &json!({"ok": true, "result": {"app": "Hidework", "version": env!("CARGO_PKG_VERSION")}}));
    }
    let id = pending.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = channel();
    pending.waiting.lock().unwrap().insert(id, tx);
    let _ = app.emit("hw-control", json!({"id": id, "method": method, "params": call["params"]}));
    let reply = rx.recv_timeout(Duration::from_secs(120)).unwrap_or_else(|_| json!({"ok": false, "error": "The app did not answer in time."}));
    pending.waiting.lock().unwrap().remove(&id);
    respond(&mut stream, "200 OK", &reply)
}

pub fn reply(pending: &Pending, id: u64, value: Value) {
    if let Some(tx) = pending.waiting.lock().unwrap().remove(&id) {
        let _ = tx.send(value);
    }
}
