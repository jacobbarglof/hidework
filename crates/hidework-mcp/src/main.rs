//! hidework-mcp: a Model Context Protocol server (stdio, JSON-RPC 2.0) for the Hidework app.
//!
//! It finds the running app through `~/.hidework/control.json`, starting Hidework if needed, and
//! forwards each tool call to the app's loopback control channel. Tools that change the pattern
//! return a screenshot of the result unless `screenshot: false` is passed.

mod tools;

use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const PROTOCOL: &str = "2025-06-18";

fn discovery_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default();
    PathBuf::from(home).join(".hidework").join("control.json")
}

struct Endpoint {
    port: u16,
    token: String,
}

fn endpoint() -> Option<Endpoint> {
    let v: Value = serde_json::from_slice(&std::fs::read(discovery_path()).ok()?).ok()?;
    Some(Endpoint { port: v["port"].as_u64()? as u16, token: v["token"].as_str()?.to_string() })
}

fn post(ep: &Endpoint, body: &Value, timeout: Duration) -> Result<Value, String> {
    let mut s = TcpStream::connect(("127.0.0.1", ep.port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(timeout)).ok();
    let bytes = serde_json::to_vec(body).unwrap();
    write!(s, "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Hidework-Token: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", ep.token, bytes.len())
        .map_err(|e| e.to_string())?;
    s.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut resp = Vec::new();
    s.read_to_end(&mut resp).map_err(|e| e.to_string())?;
    let split = resp.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad response")?;
    serde_json::from_slice(&resp[split + 4..]).map_err(|e| e.to_string())
}

fn app_alive() -> Option<Endpoint> {
    let ep = endpoint()?;
    post(&ep, &json!({"method": "ping"}), Duration::from_secs(3)).ok()?;
    Some(ep)
}

fn app_executable() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HIDEWORK_APP") {
        return Some(PathBuf::from(p));
    }
    let me = std::env::current_exe().ok()?;
    let dir = me.parent()?;
    let name = if cfg!(windows) { "hidework.exe" } else { "hidework" };
    let candidate = dir.join(name);
    candidate.exists().then_some(candidate)
}

fn ensure_app() -> Result<Endpoint, String> {
    if let Some(ep) = app_alive() {
        return Ok(ep);
    }
    let exe = app_executable().ok_or("Hidework is not running and its executable was not found next to hidework-mcp. Start Hidework, or set HIDEWORK_APP to its path.")?;
    std::process::Command::new(&exe).spawn().map_err(|e| format!("Could not start {}: {e}", exe.display()))?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        std::thread::sleep(Duration::from_millis(400));
        if let Some(ep) = app_alive() {
            // Give the interface a moment to load its first project.
            std::thread::sleep(Duration::from_millis(800));
            return Ok(ep);
        }
    }
    Err("Started Hidework but it did not answer within 30 seconds.".into())
}

fn call_tool(name: &str, args: Value) -> Value {
    let result = (|| -> Result<Value, String> {
        if name == "launch_app" {
            ensure_app()?;
            return Ok(json!({"ok": true, "result": {"running": true}}));
        }
        let ep = ensure_app()?;
        post(&ep, &json!({"method": name, "params": args}), Duration::from_secs(180))
    })();
    match result {
        Err(e) => json!({"content": [{"type": "text", "text": e}], "isError": true}),
        Ok(reply) => {
            let mut content = Vec::new();
            let ok = reply["ok"].as_bool().unwrap_or(false);
            if ok {
                let r = &reply["result"];
                if !r.is_null() {
                    content.push(json!({"type": "text", "text": serde_json::to_string_pretty(r).unwrap_or_default()}));
                }
            } else {
                content.push(json!({"type": "text", "text": reply["error"].as_str().unwrap_or("The app reported an error.")}));
            }
            if let Some(img) = reply["image"].as_str() {
                content.push(json!({"type": "image", "data": img, "mimeType": "image/png"}));
            }
            if content.is_empty() {
                content.push(json!({"type": "text", "text": "Done."}));
            }
            json!({"content": content, "isError": !ok})
        }
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            let _ = writeln!(out, "{}", json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "parse error"}}));
            continue;
        };
        let Some(id) = msg.get("id").cloned() else { continue }; // notification
        let method = msg["method"].as_str().unwrap_or("");
        let reply = match method {
            "initialize" => json!({"result": {
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL),
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "hidework", "version": env!("CARGO_PKG_VERSION")},
                "instructions": tools::INSTRUCTIONS,
            }}),
            "ping" => json!({"result": {}}),
            "tools/list" => json!({"result": {"tools": tools::list()}}),
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("");
                if tools::list().iter().any(|t| t["name"] == name) {
                    json!({"result": call_tool(name, msg["params"]["arguments"].clone())})
                } else {
                    json!({"error": {"code": -32602, "message": format!("Unknown tool {name}")}})
                }
            }
            _ => json!({"error": {"code": -32601, "message": format!("Method not found: {method}")}}),
        };
        let mut full = reply;
        full["jsonrpc"] = json!("2.0");
        full["id"] = id;
        let _ = writeln!(out, "{full}");
        let _ = out.flush();
    }
}
