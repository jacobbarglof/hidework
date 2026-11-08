//! Desktop shell: exposes the core to the interface as Tauri commands, and runs the local control
//! channel that the MCP bridge talks to.

mod control;

use hidework_core::bags::{self, BagParams, BagStyle};
use hidework_core::bom::{self, Bom};
use hidework_core::{arrange, craft};
use hidework_core::drape::{self, DrapeRequest, DrapeResult};
use hidework_core::fab::{self, FabOptions};
use hidework_core::generators::{self, StrapParams};
use hidework_core::geom::Vec2;
use hidework_core::model::{Piece, Project, FORMAT};
use hidework_core::pdf::{self, PageSize};
use hidework_core::physics::{self, MaterialStats, Preset};
use hidework_core::sim::{ObjectSpec, Prop, Sim, SimInfo, SimMetrics, SimSpec};
use hidework_core::templates::{self, TemplateInfo};
use hidework_core::{compute, sheet, svg, ComputedProject};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

type Res<T> = Result<T, String>;

#[tauri::command]
fn compute_project(project: Project) -> ComputedProject {
    compute(&project)
}

#[tauri::command]
fn list_templates() -> Vec<TemplateInfo> {
    templates::list()
}

#[tauri::command]
fn from_template(id: String) -> Res<Project> {
    templates::by_id(&id).ok_or_else(|| format!("No template called {id}"))
}

#[tauri::command]
fn save_project(project: Project, path: String) -> Res<()> {
    let json = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not save {path}: {e}"))
}

#[tauri::command]
fn load_project(path: String) -> Res<Project> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    let project: Project = serde_json::from_str(&text).map_err(|e| format!("{path} is not a Hidework project: {e}"))?;
    if project.format != FORMAT {
        return Err(format!("{path} is not a Hidework project"));
    }
    Ok(project)
}

fn render_pdf(project: &Project, page: PageSize) -> (Vec<u8>, usize) {
    let c = compute(project);
    pdf::to_pdf(&sheet::build_sheet(project, &c), page)
}

fn write(path: &str, bytes: &[u8]) -> Res<()> {
    std::fs::write(path, bytes).map_err(|e| format!("Could not write {path}: {e}"))
}

#[tauri::command]
fn export_svg(project: Project, path: String) -> Res<()> {
    let c = compute(&project);
    write(&path, svg::to_svg(&sheet::build_sheet(&project, &c)).as_bytes())
}

#[tauri::command]
fn export_pdf(project: Project, path: String, page: PageSize) -> Res<usize> {
    let (bytes, pages) = render_pdf(&project, page);
    write(&path, &bytes)?;
    Ok(pages)
}

#[tauri::command]
fn export_laser_svg(project: Project, path: String, options: FabOptions) -> Res<()> {
    write(&path, fab::laser_svg(&project, &options).as_bytes())
}

#[tauri::command]
fn export_dxf(project: Project, path: String, options: FabOptions) -> Res<()> {
    write(&path, fab::dxf(&project, &options).as_bytes())
}

#[tauri::command]
fn export_stl(project: Project, path: String, options: FabOptions) -> Res<usize> {
    let bytes = fab::stl(&project, &options);
    write(&path, &bytes)?;
    Ok((bytes.len().saturating_sub(84)) / 50)
}

/// Write the template to a temporary PDF and open it in the system viewer for printing.
#[tauri::command]
fn print_pdf(project: Project, page: PageSize) -> Res<usize> {
    let (bytes, pages) = render_pdf(&project, page);
    let safe: String = project.name.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    let path: PathBuf = std::env::temp_dir().join(format!("hidework-{safe}.pdf"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
    Ok(pages)
}

#[tauri::command]
fn page_count(project: Project, page: PageSize) -> usize {
    let c = compute(&project);
    let t = pdf::tiling(&sheet::build_sheet(&project, &c), page);
    t.cols * t.rows
}

#[tauri::command]
fn material_presets() -> Vec<Preset> {
    physics::presets()
}

#[tauri::command]
fn material_stats(project: Project) -> Vec<MaterialStats> {
    project.materials.iter().map(physics::stats).collect()
}

/// Bending modulus (MPa) from a strip test: the overhang that droops to 41.5 degrees.
#[tauri::command]
fn calibrate_bending(thickness: f64, density: f64, overhang: f64) -> f64 {
    physics::bending_modulus_from_overhang(thickness, density, overhang)
}

#[tauri::command]
fn density_from_weight(oz: f64, thickness: f64) -> f64 {
    physics::density_from_oz_yd2(oz, thickness)
}

#[tauri::command]
async fn simulate_drape(request: DrapeRequest) -> Res<DrapeResult> {
    tauri::async_runtime::spawn_blocking(move || drape::simulate(&request)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn bill_of_materials(project: Project, waste: f64) -> Bom {
    let c = compute(&project);
    bom::bom(&project, &c, waste)
}

#[tauri::command]
fn make_strap(params: StrapParams, material: String, at: Vec2, id: String) -> Piece {
    generators::strap(&params, &material, at, &id)
}

#[tauri::command]
fn make_gusset(name: String, length: f64, width: f64, material: String, at: Vec2, id: String) -> Piece {
    generators::gusset(&name, length, width, &material, at, &id)
}

#[tauri::command]
fn make_lining(project: Project, piece: String, inset: f64, id: String) -> Res<Piece> {
    let c = compute(&project);
    let src = project.piece(&piece).ok_or("No such piece")?;
    let cp = c.pieces.iter().find(|p| p.id == piece).ok_or("That piece has no outline yet")?;
    Ok(generators::lining(src, &cp.outline, inset, &id))
}

/// Everything a leatherworker picks from: stitches, threads, seam constructions, glues, edge
/// finishes and hardware.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Catalogue {
    stitches: Vec<craft::StitchInfo>,
    threads: Vec<craft::ThreadInfo>,
    constructions: Vec<craft::ConstructionInfo>,
    adhesives: Vec<craft::AdhesiveInfo>,
    finishes: Vec<craft::FinishInfo>,
    hardware: Vec<craft::HardwareInfo>,
}

#[tauri::command]
fn craft_catalogue() -> Catalogue {
    Catalogue {
        stitches: craft::stitches(),
        threads: craft::threads(),
        constructions: craft::constructions(),
        adhesives: craft::adhesives(),
        finishes: craft::finishes(),
        hardware: craft::hardware(),
    }
}

#[tauri::command]
fn make_bag(params: BagParams) -> Project {
    bags::bag(&params)
}

#[tauri::command]
fn bag_defaults(style: BagStyle) -> BagParams {
    BagParams::style_defaults(style)
}

#[tauri::command]
fn round_corner(mut piece: Piece, vertex: usize, radius: f64) -> Res<Piece> {
    generators::round_corner(&mut piece, vertex, radius)?;
    Ok(piece)
}

#[tauri::command]
fn add_dart(mut piece: Piece, edge: usize, at: f64, width: f64, depth: f64) -> Res<(Piece, (usize, usize))> {
    let e = generators::add_dart(&mut piece, edge, at, width, depth)?;
    Ok((piece, e))
}

/// Where a pattern point lands in 3D (for placing matching hardware through two pieces).
#[tauri::command]
fn arrange_point(project: Project, piece: String, at: Vec2) -> Res<[f64; 3]> {
    let c = compute(&project);
    let pc = project.piece(&piece).ok_or("No such piece")?;
    let cp = c.pieces.iter().find(|p| p.id == piece).ok_or("That piece has no outline yet")?;
    Ok(arrange::frame(&project, pc, cp).map([at.x, at.y, 0.0]))
}

/// The pattern point of a piece nearest a 3D point.
#[tauri::command]
fn arrange_inverse(project: Project, piece: String, world: [f64; 3]) -> Res<Vec2> {
    let c = compute(&project);
    let pc = project.piece(&piece).ok_or("No such piece")?;
    let cp = c.pieces.iter().find(|p| p.id == piece).ok_or("That piece has no outline yet")?;
    Ok(arrange::frame(&project, pc, cp).inverse(world))
}

// ---------- live simulation ----------

type SimState = std::sync::Mutex<Option<Sim>>;

fn with_sim<T>(state: &SimState, f: impl FnOnce(&mut Sim) -> Res<T>) -> Res<T> {
    let mut guard = state.lock().map_err(|_| "simulation lock poisoned")?;
    let sim = guard.as_mut().ok_or("The simulation is not running. Press Simulate first.")?;
    f(sim)
}

fn f32_bytes(v: &[f32]) -> tauri::ipc::Response {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    tauri::ipc::Response::new(out)
}

#[tauri::command]
async fn sim_start(state: State<'_, Arc<SimState>>, project: Project, spec: SimSpec) -> Res<SimInfo> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sim = Sim::new(&project, spec)?;
        let info = sim.info.clone();
        *st.lock().map_err(|_| "lock")? = Some(sim);
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn sim_stop(state: State<'_, Arc<SimState>>) {
    if let Ok(mut g) = state.lock() {
        *g = None;
    }
}

#[tauri::command]
async fn sim_step(state: State<'_, Arc<SimState>>, frames: usize) -> Res<tauri::ipc::Response> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_sim(&st, |s| {
        s.step(frames.clamp(0, 600));
        Ok(f32_bytes(&s.positions()))
    }))
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn sim_utilisation(state: State<'_, Arc<SimState>>) -> Res<tauri::ipc::Response> {
    with_sim(&state, |s| Ok(f32_bytes(&s.utilisation())))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SimStatus {
    metrics: SimMetrics,
    pins: Vec<(String, [f64; 3])>,
    objects: Vec<ObjectSpec>,
    object_positions: Vec<(String, [f64; 3])>,
    weights: Vec<(String, f64, [f64; 3])>,
    props: Vec<Prop>,
}

#[tauri::command]
fn sim_status(state: State<'_, Arc<SimState>>) -> Res<SimStatus> {
    with_sim(&state, |s| {
        Ok(SimStatus { metrics: s.metrics(), pins: s.pins(), objects: s.object_specs(), object_positions: s.objects(), weights: s.weights(), props: s.props().to_vec() })
    })
}

/// Resolve a target: a vertex index, a pattern point on a piece, or a world point (mm).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    vertex: Option<usize>,
    piece_id: Option<String>,
    at: Option<Vec2>,
    world: Option<[f64; 3]>,
}

fn resolve(s: &Sim, t: &Target) -> Res<usize> {
    if let Some(v) = t.vertex {
        return Ok(v);
    }
    if let (Some(p), Some(at)) = (&t.piece_id, t.at) {
        return s.vertex_at(p, at).ok_or_else(|| format!("No piece {p} in the simulation"));
    }
    if let Some(w) = t.world {
        return Ok(s.nearest_vertex(w));
    }
    Err("Give a vertex, a piece point or a world point".into())
}

#[tauri::command]
fn sim_pin(state: State<'_, Arc<SimState>>, id: String, target: Target) -> Res<usize> {
    with_sim(&state, |s| {
        let v = resolve(s, &target)?;
        s.pin(&id, v)?;
        Ok(v)
    })
}

#[tauri::command]
fn sim_remove(state: State<'_, Arc<SimState>>, id: String) -> Res<()> {
    with_sim(&state, |s| s.remove(&id))
}

#[tauri::command]
fn sim_drag(state: State<'_, Arc<SimState>>, vertex: Option<usize>, target: [f64; 3]) -> Res<()> {
    with_sim(&state, |s| s.drag(vertex, target))
}

#[tauri::command]
fn sim_add_object(state: State<'_, Arc<SimState>>, object: ObjectSpec) -> Res<()> {
    with_sim(&state, |s| {
        s.add_object(object);
        Ok(())
    })
}

#[tauri::command]
fn sim_add_weight(state: State<'_, Arc<SimState>>, id: String, target: Target, grams: f64) -> Res<usize> {
    with_sim(&state, |s| {
        let v = resolve(s, &target)?;
        s.add_weight(&id, v, grams);
        Ok(v)
    })
}

#[tauri::command]
fn sim_set_props(state: State<'_, Arc<SimState>>, props: Vec<Prop>) -> Res<()> {
    with_sim(&state, |s| {
        s.set_props(props);
        Ok(())
    })
}

#[tauri::command]
fn sim_reset(state: State<'_, Arc<SimState>>) -> Res<()> {
    with_sim(&state, |s| {
        s.reset();
        Ok(())
    })
}

#[tauri::command]
fn sim_nearest(state: State<'_, Arc<SimState>>, world: [f64; 3]) -> Res<usize> {
    with_sim(&state, |s| Ok(s.nearest_vertex(world)))
}

#[tauri::command]
fn save_png(path: String, data: String) -> Res<()> {
    let bytes = decode_base64(&data).ok_or("bad image data")?;
    write(&path, &bytes)
}

fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let table = |c: u8| -> Option<u8> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let clean: Vec<u8> = s.bytes().filter(|&c| c != b'=' && !c.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let vals: Vec<u8> = chunk.iter().map(|&c| table(c)).collect::<Option<_>>()?;
        let n = vals.iter().enumerate().fold(0u32, |acc, (i, &v)| acc | (v as u32) << (18 - 6 * i));
        out.push((n >> 16) as u8);
        if vals.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if vals.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

#[tauri::command]
fn control_reply(pending: State<'_, Arc<control::Pending>>, id: u64, value: serde_json::Value) {
    control::reply(&pending, id, value);
}

/// The interface has started listening for agent calls.
#[tauri::command]
fn control_ready() {
    control::set_ready();
}

/// A .hidework file the app was opened with (double-click in Explorer), if any.
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| a.to_lowercase().ends_with(".hidework") && std::path::Path::new(a).is_file())
}

/// Where hidework-mcp.exe sits next to this app, for the "Connect an AI agent" help.
#[tauri::command]
fn mcp_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let p = dir.join("hidework-mcp.exe");
    p.exists().then(|| p.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending = Arc::new(control::Pending::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(pending.clone())
        .manage(Arc::new(SimState::default()))
        .setup(move |app| {
            control::start(app.handle().clone(), pending.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.app_handle().webview_windows().is_empty() {
                    control::stop();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            compute_project,
            list_templates,
            from_template,
            save_project,
            load_project,
            export_svg,
            export_pdf,
            export_laser_svg,
            export_dxf,
            export_stl,
            print_pdf,
            page_count,
            material_presets,
            material_stats,
            calibrate_bending,
            density_from_weight,
            simulate_drape,
            bill_of_materials,
            make_strap,
            make_gusset,
            make_lining,
            craft_catalogue,
            make_bag,
            bag_defaults,
            round_corner,
            add_dart,
            arrange_point,
            arrange_inverse,
            startup_file,
            mcp_path,
            control_ready,
            sim_start,
            sim_stop,
            sim_step,
            sim_utilisation,
            sim_status,
            sim_pin,
            sim_remove,
            sim_drag,
            sim_add_object,
            sim_add_weight,
            sim_set_props,
            sim_reset,
            sim_nearest,
            save_png,
            control_reply
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hidework");
}
