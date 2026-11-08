//! Development bridge: the same commands as src-tauri/src/lib.rs, served over plain HTTP so the
//! interface can run in a browser for design reviews and screenshots. POST /invoke/<command> with
//! the command's arguments as a JSON object; the reply is JSON, or raw little-endian f32 bytes for
//! the simulation buffers. Errors come back as status 400 with the message as a JSON string.
//!
//! Run: cargo run --manifest-path tools/devbridge/Cargo.toml   (listens on 127.0.0.1:1430)

use hidework_core::bags::{self, BagParams, BagStyle};
use hidework_core::bom;
use hidework_core::drape::{self, DrapeRequest};
use hidework_core::generators::{self, StrapParams};
use hidework_core::geom::Vec2;
use hidework_core::model::{Piece, Project};
use hidework_core::pdf::{self, PageSize};
use hidework_core::physics;
use hidework_core::print::PrintLayout;
use hidework_core::sim::{ObjectSpec, Prop, Sim, SimSpec};
use hidework_core::{arrange, compute, craft, templates};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

type Res = Result<Reply, String>;

fn arg<T: DeserializeOwned>(a: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(a.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("argument {key}: {e}"))
}

fn ok<T: serde::Serialize>(v: T) -> Res {
    serde_json::to_value(v).map(Reply::Json).map_err(|e| e.to_string())
}

fn f32_bytes(v: &[f32]) -> Reply {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    Reply::Bytes(out)
}

fn resolve(s: &Sim, t: &Value) -> Result<usize, String> {
    if let Some(v) = t.get("vertex").and_then(|v| v.as_u64()) {
        return Ok(v as usize);
    }
    if let (Some(p), Some(at)) = (t.get("pieceId").and_then(|v| v.as_str()), t.get("at")) {
        let at: Vec2 = serde_json::from_value(at.clone()).map_err(|e| e.to_string())?;
        return s.vertex_at(p, at).ok_or_else(|| format!("No piece {p} in the simulation"));
    }
    if let Some(w) = t.get("world") {
        let w: [f64; 3] = serde_json::from_value(w.clone()).map_err(|e| e.to_string())?;
        return Ok(s.nearest_vertex(w));
    }
    Err("Give a vertex, a piece point or a world point".into())
}

struct Bridge {
    sim: Option<Sim>,
}

impl Bridge {
    fn sim(&mut self) -> Result<&mut Sim, String> {
        self.sim.as_mut().ok_or_else(|| "The simulation is not running. Press Simulate first.".to_string())
    }

    fn call(&mut self, cmd: &str, a: &Value) -> Res {
        let project = || arg::<Project>(a, "project");
        match cmd {
            "compute_project" => ok(compute(&project()?)),
            "check_project" => ok(hidework_core::check::check(&project()?)),
            "list_templates" => ok(templates::list()),
            "from_template" => {
                let id: String = arg(a, "id")?;
                ok(templates::by_id(&id).ok_or_else(|| format!("No template called {id}"))?)
            }
            "save_project" => {
                let path: String = arg(a, "path")?;
                let text = serde_json::to_string_pretty(&project()?).map_err(|e| e.to_string())?;
                std::fs::write(&path, text).map_err(|e| format!("Could not save {path}: {e}"))?;
                ok(())
            }
            "load_project" => {
                let path: String = arg(a, "path")?;
                let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
                ok(serde_json::from_str::<Project>(&text).map_err(|e| format!("{path} is not a Hidework project: {e}"))?)
            }
            "autosave_path" => {
                let dir = std::env::temp_dir().join("hidework-devbridge");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                ok(dir.join("recovery.hidework").to_string_lossy().into_owned())
            }
            "page_count" | "print_pdf" | "export_pdf" => {
                let p = project()?;
                let page: PageSize = arg(a, "page")?;
                let layout: Option<PrintLayout> = arg(a, "layout").unwrap_or(None);
                ok(pdf::page_count(&p, &compute(&p), page, layout.unwrap_or_default()))
            }
            "material_presets" => ok(physics::presets()),
            "material_stats" => ok(project()?.materials.iter().map(physics::stats).collect::<Vec<_>>()),
            "calibrate_bending" => ok(physics::bending_modulus_from_overhang(arg(a, "thickness")?, arg(a, "density")?, arg(a, "overhang")?)),
            "density_from_weight" => ok(physics::density_from_oz_yd2(arg(a, "oz")?, arg(a, "thickness")?)),
            "simulate_drape" => ok(drape::simulate(&arg::<DrapeRequest>(a, "request")?)?),
            "bill_of_materials" => {
                let p = project()?;
                ok(bom::bom(&p, &compute(&p), arg(a, "waste")?))
            }
            "make_strap" => ok(generators::strap(&arg::<StrapParams>(a, "params")?, &arg::<String>(a, "material")?, arg(a, "at")?, &arg::<String>(a, "id")?)),
            "make_gusset" => ok(generators::gusset(&arg::<String>(a, "name")?, arg(a, "length")?, arg(a, "width")?, &arg::<String>(a, "material")?, arg(a, "at")?, &arg::<String>(a, "id")?)),
            "make_lining" => {
                let p = project()?;
                let id: String = arg(a, "piece")?;
                let c = compute(&p);
                let src = p.piece(&id).ok_or("No such piece")?;
                let cp = c.pieces.iter().find(|x| x.id == id).ok_or("That piece has no outline yet")?;
                ok(generators::lining(src, &cp.outline, arg(a, "inset")?, &arg::<String>(a, "id")?))
            }
            "craft_catalogue" => ok(json!({
                "stitches": craft::stitches(),
                "threads": craft::threads(),
                "constructions": craft::constructions(),
                "adhesives": craft::adhesives(),
                "finishes": craft::finishes(),
                "hardware": craft::hardware(),
            })),
            "make_bag" => ok(bags::bag(&arg::<BagParams>(a, "params")?)),
            "bag_defaults" => ok(BagParams::style_defaults(arg::<BagStyle>(a, "style")?)),
            "round_corner" => {
                let mut pc: Piece = arg(a, "piece")?;
                generators::round_corner(&mut pc, arg(a, "vertex")?, arg(a, "radius")?)?;
                ok(pc)
            }
            "add_dart" => {
                let mut pc: Piece = arg(a, "piece")?;
                let e = generators::add_dart(&mut pc, arg(a, "edge")?, arg(a, "at")?, arg(a, "width")?, arg(a, "depth")?)?;
                ok((pc, e))
            }
            "arrange_point" | "arrange_inverse" => {
                let p = project()?;
                let id: String = arg(a, "piece")?;
                let c = compute(&p);
                let pc = p.piece(&id).ok_or("No such piece")?;
                let cp = c.pieces.iter().find(|x| x.id == id).ok_or("That piece has no outline yet")?;
                let f = arrange::frame(&p, pc, cp);
                if cmd == "arrange_point" {
                    let at: Vec2 = arg(a, "at")?;
                    ok(f.map([at.x, at.y, 0.0]))
                } else {
                    ok(f.inverse(arg(a, "world")?))
                }
            }
            "startup_file" | "mcp_path" => ok(Value::Null),
            "control_ready" | "control_reply" | "save_png" | "export_svg" | "export_laser_svg" | "export_dxf" | "export_stl" => ok(()),
            "sim_start" => {
                let carry = a.get("carry").and_then(|v| v.as_bool()).unwrap_or(false);
                let sim = match (carry, self.sim.as_ref()) {
                    (true, Some(old)) => Sim::carry_over(&project()?, arg::<SimSpec>(a, "spec")?, old)?,
                    _ => Sim::new(&project()?, arg::<SimSpec>(a, "spec")?)?,
                };
                let info = sim.info.clone();
                self.sim = Some(sim);
                ok(info)
            }
            "sim_stop" => {
                self.sim = None;
                ok(())
            }
            "sim_step" => {
                let frames: usize = arg(a, "frames")?;
                let s = self.sim()?;
                s.step(frames.clamp(0, 600));
                Ok(f32_bytes(&s.positions()))
            }
            "sim_utilisation" => Ok(f32_bytes(&self.sim()?.utilisation())),
            "sim_status" => {
                let s = self.sim()?;
                ok(json!({
                    "metrics": s.metrics(),
                    "pins": s.pins(),
                    "objects": s.object_specs(),
                    "objectPositions": s.objects(),
                    "weights": s.weights(),
                    "props": s.props().to_vec(),
                }))
            }
            "sim_pin" => {
                let id: String = arg(a, "id")?;
                let t = a.get("target").cloned().unwrap_or(Value::Null);
                let s = self.sim()?;
                let v = resolve(s, &t)?;
                s.pin(&id, v)?;
                ok(v)
            }
            "sim_remove" => {
                let id: String = arg(a, "id")?;
                self.sim()?.remove(&id)?;
                ok(())
            }
            "sim_drag" => {
                let vertex: Option<usize> = arg(a, "vertex").unwrap_or(None);
                let target: [f64; 3] = arg(a, "target")?;
                let r: Option<f64> = arg(a, "radiusMm").unwrap_or(None);
                self.sim()?.drag(vertex, target, r.unwrap_or(12.0))?;
                ok(())
            }
            "sim_add_object" => {
                let o: ObjectSpec = arg(a, "object")?;
                self.sim()?.add_object(o);
                ok(())
            }
            "sim_add_weight" => {
                let id: String = arg(a, "id")?;
                let grams: f64 = arg(a, "grams")?;
                let t = a.get("target").cloned().unwrap_or(Value::Null);
                let s = self.sim()?;
                let v = resolve(s, &t)?;
                s.add_weight(&id, v, grams);
                ok(v)
            }
            "sim_set_props" => {
                let props: Vec<Prop> = arg(a, "props")?;
                self.sim()?.set_props(props);
                ok(())
            }
            "sim_reset" => {
                self.sim()?.reset();
                ok(())
            }
            "sim_nearest" => {
                let w: [f64; 3] = arg(a, "world")?;
                ok(self.sim()?.nearest_vertex(w))
            }
            _ => Err(format!("The dev bridge does not know the command {cmd}.")),
        }
    }
}

fn respond(mut s: TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
}

fn handle(bridge: &mut Bridge, stream: TcpStream) -> std::io::Result<()> {
    let mut r = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    if method == "OPTIONS" {
        respond(stream, "204 No Content", "text/plain", b"");
        return Ok(());
    }
    let cmd = path.trim_start_matches("/invoke/").to_string();
    let args: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).unwrap_or(json!({})) };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bridge.call(&cmd, &args)))
        .unwrap_or_else(|_| Err(format!("{cmd} panicked in the core")));
    match result {
        Ok(Reply::Json(v)) => respond(stream, "200 OK", "application/json", v.to_string().as_bytes()),
        Ok(Reply::Bytes(b)) => respond(stream, "200 OK", "application/octet-stream", &b),
        Err(e) => {
            eprintln!("{cmd}: {e}");
            respond(stream, "400 Bad Request", "application/json", Value::String(e).to_string().as_bytes())
        }
    }
    Ok(())
}

fn main() {
    let addr = "127.0.0.1:1430";
    let listener = TcpListener::bind(addr).expect("port 1430 is busy");
    println!("Hidework dev bridge on http://{addr}");
    let mut bridge = Bridge { sim: None };
    for s in listener.incoming().flatten() {
        if let Err(e) = handle(&mut bridge, s) {
            eprintln!("request failed: {e}");
        }
    }
}
