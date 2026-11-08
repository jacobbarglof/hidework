//! The live 3D simulation (the "Simulate" switch): every piece as a deformable leather shell,
//! folded into its finished shape, sewn along its seams, resting on or hanging from props,
//! carrying objects and weights, and reporting where it is stressed and what it can carry.
//!
//! Solver: projective dynamics (implicit Euler, local/global) with a banded Cholesky that is
//! refactored only when pins change. Bending is the isometric quadratic model with stiffness
//! from flexural rigidity; fold allowances are softened (a creased fold) and the folded shape is
//! held by its stitching, like the real thing. Seams are springs between matching stitch holes;
//! coinciding round holes (rivets, snaps) are fastened the same way. Forces in seams and panels
//! give stitch loads and stresses; capacity scales the applied load to the first limit reached,
//! divided by a safety factor. Strength numbers are estimates unless calibrated.

use crate::arrange;
use crate::banded::{BandedCholesky, SymBuilder};
use crate::bend::Bender;
use crate::compute::{compute, ComputedPiece};
use crate::craft;
use crate::geom::{offset_closed, point_at, signed_area, v, Vec2};
use crate::mesh::triangulate;
use crate::model::{Adhesive, Construction, EdgeFinish, Project, StitchKind};
use crate::physics::{flexural_rigidity, physics_of, G};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

type P3 = [f64; 3];
fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: P3, b: P3) -> P3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: P3, s: f64) -> P3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: P3, b: P3) -> P3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: P3) -> f64 {
    dot(a, a).sqrt()
}
fn mm(a: [f64; 3]) -> P3 {
    [a[0] / 1000.0, a[1] / 1000.0, a[2] / 1000.0]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimSpec {
    /// Pieces to simulate; empty means all.
    pub pieces: Vec<String>,
    /// How far folds start closed (0 flat, 180 shut).
    pub fold_angle_deg: f64,
    /// Bending stiffness left in a creased fold, as a fraction of the leather's.
    pub fold_strength: f64,
    /// Target vertices per piece.
    pub resolution: usize,
    /// Breaking load of one strand of thread, newtons (a saddle stitch has two).
    pub thread_break_n: f64,
    pub safety_factor: f64,
    pub props: Vec<Prop>,
    /// Start this far above the floor (mm).
    pub lift_mm: f64,
}

impl Default for SimSpec {
    fn default() -> Self {
        SimSpec {
            pieces: vec![],
            fold_angle_deg: 180.0,
            fold_strength: 0.05,
            resolution: 900,
            thread_break_n: 60.0,
            safety_factor: 2.0,
            props: vec![],
            lift_mm: 0.0,
        }
    }
}

/// Fixed scenery (millimetres, z up). The floor is always at z = 0.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Prop {
    #[serde(rename_all = "camelCase")]
    Box { min: [f64; 3], max: [f64; 3] },
    #[serde(rename_all = "camelCase")]
    Pedestal { center: [f64; 2], radius: f64, top: f64 },
    /// A round bar or hook from a to b (hang things over it).
    #[serde(rename_all = "camelCase")]
    Bar { a: [f64; 3], b: [f64; 3], radius: f64 },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Shape {
    Box { size: [f64; 3] },
    Sphere { radius: f64 },
    /// Vertical axis.
    Cylinder { radius: f64, height: f64 },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSpec {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub shape: Shape,
    pub grams: f64,
    /// Centre, millimetres.
    pub pos: [f64; 3],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceInfo {
    pub id: String,
    pub name: String,
    pub material_id: String,
    pub vertex_start: u32,
    pub vertex_count: u32,
    pub index_start: u32,
    pub index_count: u32,
    pub thickness_mm: f64,
}

/// A point on the cloth by triangle and barycentric weights (for stitches and hardware).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePoint {
    pub tri: u32,
    pub bary: [f32; 3],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchLine {
    pub piece_id: String,
    pub closed: bool,
    pub holes: Vec<SurfacePoint>,
    pub kind: StitchKind,
    pub lace: bool,
    /// The thread wraps over the edge; `edge` holds the edge point next to each hole.
    pub wraps_edge: bool,
    pub edge: Vec<SurfacePoint>,
    /// Holes inside a turned seam, where the stitching does not show.
    pub hidden: Vec<u32>,
    pub row: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub piece_id: String,
    pub at: SurfacePoint,
    pub diameter_mm: f64,
    pub slot_mm: f64,
    pub angle_deg: f64,
    pub label: String,
    /// Catalogue id for set hardware; empty for a plain punched hole or slot.
    pub kind: String,
    /// A second surface point a little along the piece's x, to orient the hardware.
    pub toward: Option<SurfacePoint>,
}

/// Something along a seam drawn in 3D: welt, piping, binding or a zipper.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeamDecor {
    pub construction: Construction,
    /// Vertex pairs along the two edges.
    pub pairs: Vec<[u32; 2]>,
    pub width_mm: f64,
    pub thickness_mm: f64,
    pub material_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimInfo {
    pub pieces: Vec<PieceInfo>,
    /// Pattern (piece-local, fold-compensated) x, y per vertex, for texturing.
    pub rest: Vec<f32>,
    pub indices: Vec<u32>,
    /// Boundary edges (vertex pairs) for drawing the cut edge.
    pub boundary: Vec<[u32; 2]>,
    /// Edge finish of each boundary edge.
    pub boundary_finish: Vec<EdgeFinish>,
    pub stitches: Vec<StitchLine>,
    pub hardware: Vec<HardwareInfo>,
    pub decor: Vec<SeamDecor>,
    pub seams: usize,
    pub fasteners: usize,
    pub laminated: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimMetrics {
    pub time_s: f64,
    pub load_g: f64,
    pub cloth_g: f64,
    pub max_stress_mpa: f64,
    /// Physical strain implied by the stress (leather is nearly inextensible).
    pub max_strain_pct: f64,
    pub max_stitch_n: f64,
    pub stitch_capacity_n: f64,
    /// Heaviest pull on any pin (hand, hook or strap anchor), newtons.
    pub max_pin_n: f64,
    /// Tear-out allowance at a pin: strength x thickness x 10 mm of leather.
    pub pin_capacity_n: f64,
    pub panel_strength_mpa: f64,
    /// Load the item could carry before the first limit, divided by the safety factor.
    pub capacity_kg: Option<f64>,
    pub limited_by: String,
    pub sag_mm: f64,
    pub settled: bool,
    pub pins: usize,
}

struct Spring {
    a: usize,
    b: usize,
    rest: f64,
    w: f64,
    /// Cross-section for stress: thickness x width share (m^2).
    area: f64,
    strength_pa: f64,
}

/// A point on the cloth: up to three vertices with weights (a vertex, or a point in a triangle).
#[derive(Clone, Copy, Debug)]
struct Pt {
    v: [usize; 3],
    w: [f64; 3],
}

impl From<usize> for Pt {
    fn from(i: usize) -> Pt {
        Pt { v: [i, i, i], w: [1.0, 0.0, 0.0] }
    }
}

impl Pt {
    fn on(sp: &SurfacePoint, tris: &[[usize; 3]]) -> Pt {
        let t = tris[sp.tri as usize];
        Pt { v: t, w: [sp.bary[0] as f64, sp.bary[1] as f64, sp.bary[2] as f64] }
    }
    fn pos(&self, x: &[P3]) -> P3 {
        (0..3).fold([0.0; 3], |acc, k| add(acc, scale(x[self.v[k]], self.w[k])))
    }
    /// The vertex carrying most of the weight.
    fn main(&self) -> usize {
        let k = (0..3).max_by(|&a, &b| self.w[a].partial_cmp(&self.w[b]).unwrap()).unwrap();
        self.v[k]
    }
}

/// Coefficients of `b - a` per vertex, merged.
fn coeffs(a: &Pt, b: &Pt) -> Vec<(usize, f64)> {
    let mut c: Vec<(usize, f64)> = Vec::with_capacity(6);
    for (p, s) in [(a, -1.0), (b, 1.0)] {
        for k in 0..3 {
            if p.w[k] == 0.0 {
                continue;
            }
            match c.iter_mut().find(|e| e.0 == p.v[k]) {
                Some(e) => e.1 += s * p.w[k],
                None => c.push((p.v[k], s * p.w[k])),
            }
        }
    }
    c
}

struct Weld {
    a: Pt,
    b: Pt,
    rest: f64,
    w: f64,
    /// Allowable newtons for this stitch.
    allow: f64,
    #[allow(dead_code)]
    seam: bool,
    /// Tension with no load applied (a folded piece springing against its stitches).
    base: f64,
}

struct Obj {
    spec: ObjectSpec,
    pos: P3,
    vel: P3,
    mass: f64,
    touching: bool,
}

struct Factor {
    chol: BandedCholesky,
    free: Vec<usize>,
    slot: Vec<usize>,
    coupling: Vec<(usize, usize, f64)>,
}

pub struct Sim {
    spec: SimSpec,
    x: Vec<P3>,
    start: Vec<P3>,
    vel: Vec<P3>,
    mass: Vec<f64>,
    half_t: Vec<f64>,
    friction: Vec<f64>,
    rest2d: Vec<Vec2>,
    piece_of: Vec<u32>,
    tris: Vec<[usize; 3]>,
    springs: Vec<Spring>,
    welds: Vec<Weld>,
    /// Bending stencils (four vertices, weights, stiffness), kept for force readouts.
    bends: Vec<([usize; 4], [f64; 4], f64)>,
    /// Vertices resting on the floor, held by the solver this frame.
    floor: std::collections::BTreeSet<usize>,
    frame: u64,
    /// Length of each weld when the simulation starts (seams close from here).
    weld_start: Vec<f64>,
    /// Per weld, the vertices it moves and their coefficients (b minus a).
    weld_c: Vec<Vec<(usize, f64)>>,
    base: Vec<(usize, usize, f64)>,
    pins: HashMap<String, usize>,
    drag: Option<(usize, P3)>,
    objects: Vec<Obj>,
    weights: Vec<(String, f64, Vec<(usize, f64)>)>,
    factor: Option<Factor>,
    h: f64,
    time: f64,
    settled: bool,
    pub info: SimInfo,
}

const DT: f64 = 1.0 / 90.0;
const ITERATIONS: usize = 14;
/// Seconds over which seams pull closed.
const SEW_S: f64 = 0.6;
/// Stiffness ceiling relative to inertia, for convergence; forces (and so stresses) still come
/// out right at equilibrium because they balance the loads.
const STIFF_CAP: f64 = 3.0e4;

fn locate(p: Vec2, rest: &[Vec2], tris: &[[usize; 3]], range: std::ops::Range<usize>) -> Option<SurfacePoint> {
    let mut best: Option<(f64, SurfacePoint)> = None;
    for ti in range {
        let t = tris[ti];
        let (a, b, c) = (rest[t[0]], rest[t[1]], rest[t[2]]);
        let d = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if d.abs() < 1e-14 {
            continue;
        }
        let l1 = ((b.x - p.x) * (c.y - p.y) - (b.y - p.y) * (c.x - p.x)) / d;
        let l2 = ((c.x - p.x) * (a.y - p.y) - (c.y - p.y) * (a.x - p.x)) / d;
        let l3 = 1.0 - l1 - l2;
        let outside = (-l1).max(-l2).max(-l3).max(0.0);
        let sp = SurfacePoint { tri: ti as u32, bary: [l1 as f32, l2 as f32, l3 as f32] };
        if outside == 0.0 {
            return Some(sp);
        }
        if best.as_ref().map_or(true, |(o, _)| outside < *o) {
            best = Some((outside, sp));
        }
    }
    best.map(|(_, sp)| sp)
}

fn nearest(p: Vec2, rest: &[Vec2], range: std::ops::Range<usize>) -> usize {
    range.min_by(|&a, &b| rest[a].dist(p).partial_cmp(&rest[b].dist(p)).unwrap()).unwrap_or(0)
}

/// The line `d` inside the outline along some edges (d = 0: the edge itself).
fn edge_line(cp: &ComputedPiece, d: f64, edges: &[usize]) -> Vec<Vec2> {
    let inset = offset_closed(&cp.outline, d);
    let m = cp.outline.len();
    // Start after a segment that is not on these edges, so a run that wraps past vertex 0 stays
    // in one piece.
    let start = (0..m).find(|&i| !cp.outline_edges[i].is_some_and(|e| edges.contains(&e))).map_or(0, |s| (s + 1) % m);
    let mut line: Vec<Vec2> = Vec::new();
    for k in 0..m {
        let i = (start + k) % m;
        if cp.outline_edges[i].is_some_and(|e| edges.contains(&e)) {
            if line.last().map_or(true, |l| l.dist(inset[i]) > 1e-9) {
                line.push(inset[i]);
            }
            line.push(inset[(i + 1) % m]);
        }
    }
    line
}

fn line_len(line: &[Vec2]) -> f64 {
    line.windows(2).map(|w| w[0].dist(w[1])).sum()
}

/// `n` evenly spaced points along a line.
fn spread(line: &[Vec2], n: usize) -> Vec<Vec2> {
    if line.len() < 2 || n == 0 {
        return vec![];
    }
    let total = line_len(line);
    let n = n.max(2);
    (0..n).map(|k| point_at(line, total * k as f64 / (n - 1) as f64)).collect()
}

/// Evenly spaced points along the stitch line of some edges (matching how holes were placed).
fn stitch_points(cp: &ComputedPiece, margin: f64, edges: &[usize]) -> Vec<Vec2> {
    let holes: usize = edges.iter().filter_map(|&e| cp.edges.get(e)).map(|e| e.hole_count).sum();
    if holes == 0 {
        return vec![];
    }
    spread(&edge_line(cp, margin, edges), holes)
}

/// Nearest point on a closed outline.
fn nearest_on_outline(p: Vec2, outline: &[Vec2]) -> (Vec2, usize) {
    let n = outline.len();
    let mut best = (f64::INFINITY, p, 0);
    for i in 0..n {
        let (a, b) = (outline[i], outline[(i + 1) % n]);
        let ab = b - a;
        let t = ((p - a).dot(ab) / ab.dot(ab).max(1e-12)).clamp(0.0, 1.0);
        let q = a + ab * t;
        let d = q.dist(p);
        if d < best.0 {
            best = (d, q, i);
        }
    }
    (best.1, best.2)
}

fn sdf_shape(shape: &Shape, p: P3) -> f64 {
    match *shape {
        Shape::Sphere { radius } => norm(p) - radius / 1000.0,
        Shape::Box { size } => {
            let q = [p[0].abs() - size[0] / 2000.0, p[1].abs() - size[1] / 2000.0, p[2].abs() - size[2] / 2000.0];
            let out = norm([q[0].max(0.0), q[1].max(0.0), q[2].max(0.0)]);
            out + q[0].max(q[1]).max(q[2]).min(0.0)
        }
        Shape::Cylinder { radius, height } => {
            let d = [(p[0] * p[0] + p[1] * p[1]).sqrt() - radius / 1000.0, p[2].abs() - height / 2000.0];
            d[0].max(d[1]).min(0.0) + (d[0].max(0.0).powi(2) + d[1].max(0.0).powi(2)).sqrt()
        }
    }
}

fn sdf_prop(prop: &Prop, p: P3) -> f64 {
    match *prop {
        Prop::Box { min, max } => {
            let (lo, hi) = (mm(min), mm(max));
            let c = scale(add(lo, hi), 0.5);
            let size = [(hi[0] - lo[0]) * 1000.0, (hi[1] - lo[1]) * 1000.0, (hi[2] - lo[2]) * 1000.0];
            sdf_shape(&Shape::Box { size }, sub(p, c))
        }
        Prop::Pedestal { center, radius, top } => {
            let h = 2.0;
            let c = [center[0] / 1000.0, center[1] / 1000.0, top / 1000.0 - h / 2.0];
            sdf_shape(&Shape::Cylinder { radius, height: h * 1000.0 }, sub(p, c))
        }
        Prop::Bar { a, b, radius } => {
            let (a, b) = (mm(a), mm(b));
            let ab = sub(b, a);
            let t = (dot(sub(p, a), ab) / dot(ab, ab).max(1e-12)).clamp(0.0, 1.0);
            norm(sub(p, add(a, scale(ab, t)))) - radius / 1000.0
        }
    }
}

fn gradient(f: impl Fn(P3) -> f64, p: P3) -> P3 {
    let e = 1e-5;
    let g = [
        f([p[0] + e, p[1], p[2]]) - f([p[0] - e, p[1], p[2]]),
        f([p[0], p[1] + e, p[2]]) - f([p[0], p[1] - e, p[2]]),
        f([p[0], p[1], p[2] + e]) - f([p[0], p[1], p[2] - e]),
    ];
    let l = norm(g).max(1e-12);
    scale(g, 1.0 / l)
}

/// Mesh vertices along a line (sampled every 2 mm), without repeats.
fn line_vertices(line: &[Vec2], rest: &[Vec2], range: std::ops::Range<usize>) -> Vec<usize> {
    let n = (line_len(line) / 2.0).ceil() as usize + 2;
    let mut v: Vec<usize> = spread(line, n).into_iter().map(|p| nearest(p, rest, range.clone())).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Closest point to `p` on a piece's triangles.
fn closest_on(x: &[P3], tris: &[[usize; 3]], range: std::ops::Range<usize>, p: P3) -> Pt {
    let mut best = (f64::INFINITY, Pt::from(tris[range.start][0]));
    for ti in range {
        let t = tris[ti];
        let (a, b, c) = (x[t[0]], x[t[1]], x[t[2]]);
        // Project onto the plane, clamp barycentrics, renormalise (good enough for nearby points).
        let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
        let (d00, d01, d11, d20, d21) = (dot(ab, ab), dot(ab, ac), dot(ac, ac), dot(ap, ab), dot(ap, ac));
        let den = (d00 * d11 - d01 * d01).max(1e-18);
        let mut v = ((d11 * d20 - d01 * d21) / den).max(0.0);
        let mut w = ((d00 * d21 - d01 * d20) / den).max(0.0);
        let s = v + w;
        if s > 1.0 {
            v /= s;
            w /= s;
        }
        let u = 1.0 - v - w;
        let q = add(a, add(scale(ab, v), scale(ac, w)));
        let d = norm(sub(q, p));
        if d < best.0 {
            best = (d, Pt { v: t, w: [u, v, w] });
        }
    }
    best.1
}

fn nearest_3d(x: &[P3], a: usize, cands: &[usize]) -> usize {
    *cands.iter().min_by(|&&p, &&q| norm(sub(x[p], x[a])).partial_cmp(&norm(sub(x[q], x[a]))).unwrap()).unwrap_or(&a)
}

fn run_kind(cp: &ComputedPiece) -> StitchKind {
    cp.stitch_runs.first().map_or(StitchKind::Saddle, |r| r.kind)
}

fn cot(a: Vec2, b: Vec2) -> f64 {
    a.dot(b) / (a.x * b.y - a.y * b.x).abs().max(1e-12)
}

impl Sim {
    pub fn new(project: &Project, spec: SimSpec) -> Result<Sim, String> {
        let computed = compute(project);
        let mut info = SimInfo {
            pieces: vec![],
            rest: vec![],
            indices: vec![],
            boundary: vec![],
            boundary_finish: vec![],
            stitches: vec![],
            hardware: vec![],
            decor: vec![],
            seams: 0,
            fasteners: 0,
            laminated: 0,
            warnings: computed.warnings.clone(),
        };
        let arranged = arrange::arranged(project);
        let form = arrange::form_of(project);
        // Pieces left flat in an arranged project lie on the floor beside the form.
        let mut flat_min = v(f64::INFINITY, f64::INFINITY);
        for cp in &computed.pieces {
            if let Some(pc) = project.piece(&cp.id) {
                if pc.place.as_ref().map_or(true, |p| p.face == crate::model::Face::Flat) {
                    flat_min = v(flat_min.x.min(cp.bounds.min.x + pc.position.x), flat_min.y.min(cp.bounds.min.y + pc.position.y));
                }
            }
        }
        let flat_shift = if arranged && flat_min.x.is_finite() { [form.width_mm / 2.0 + 120.0 - flat_min.x, -form.depth_mm / 2.0 - flat_min.y, 0.0] } else { [0.0; 3] };
        // Share the vertex budget by area when there are several pieces.
        let areas: Vec<f64> = computed.pieces.iter().filter(|cp| spec.pieces.is_empty() || spec.pieces.contains(&cp.id)).map(|cp| signed_area(&cp.outline).abs()).collect();
        let total_area: f64 = areas.iter().sum::<f64>().max(1.0);
        let many = areas.len() > 1;
        let mut stitch_rest: Vec<Vec<Vec2>> = Vec::new();
        let mut hw_vertex: Vec<(String, Pt, crate::model::HardwarePlacement, P3)> = Vec::new();
        let mut placed: HashMap<String, bool> = HashMap::new();
        let mut x: Vec<P3> = Vec::new();
        let mut rest2d: Vec<Vec2> = Vec::new();
        let mut piece_of: Vec<u32> = Vec::new();
        let mut tris: Vec<[usize; 3]> = Vec::new();
        let mut mass: Vec<f64> = Vec::new();
        let mut half_t: Vec<f64> = Vec::new();
        let mut friction: Vec<f64> = Vec::new();
        let mut springs: Vec<Spring> = Vec::new();
        let mut base: SymBuilder;
        let mut bend_terms: Vec<([usize; 4], [f64; 4], f64)> = Vec::new();
        let mut piece_ranges: HashMap<String, (std::ops::Range<usize>, std::ops::Range<usize>, &ComputedPiece)> = HashMap::new();
        let mut hs = Vec::new();

        for cp in &computed.pieces {
            if !spec.pieces.is_empty() && !spec.pieces.contains(&cp.id) {
                continue;
            }
            let pc = project.piece(&cp.id).ok_or("missing piece")?;
            let mat = project.material(&pc.material_id);
            let ph = mat.map(physics_of).unwrap_or_else(|| crate::physics::default_physics(crate::model::MaterialKind::Leather));
            let t_mm = cp.thickness_mm.max(0.1);
            let t = t_mm / 1000.0;
            // Narrow pieces (straps, handles) need a few rows of triangles across their width.
            let area_mm2 = signed_area(&cp.outline).abs();
            let narrow = cp.bounds.width().min(cp.bounds.height()) / 3.5;
            let for_width = (area_mm2 / (narrow * narrow * 0.866)).min(700.0);
            let target = if many { ((spec.resolution as f64 * 2.6) * area_mm2 / total_area).max(140.0).max(for_width) as usize } else { spec.resolution };
            let mesh = triangulate(&cp.outline, target.clamp(80, 4000));
            if mesh.triangles.is_empty() {
                info.warnings.push(format!("{}: could not mesh", pc.name));
                continue;
            }
            let bender = Bender::new(cp, spec.fold_angle_deg);
            let frame = arrange::frame(project, pc, cp);
            let shift = if frame.is_flat() { flat_shift } else { [0.0; 3] };
            placed.insert(cp.id.clone(), !frame.is_flat());
            let v0 = x.len();
            let t0 = tris.len();
            for &p in &mesh.points {
                let (q, _) = bender.map(p, 0.0);
                let w = frame.map(q);
                x.push([(w[0] + shift[0]) / 1000.0, (w[1] + shift[1]) / 1000.0, (w[2] + shift[2]) / 1000.0]);
                rest2d.push(p);
                piece_of.push(info.pieces.len() as u32);
                mass.push(0.0);
                half_t.push(t / 2.0);
                friction.push(ph.friction);
                info.rest.extend([p.x as f32, p.y as f32]);
            }
            let mut area_mm2 = 0.0;
            for tr in &mesh.triangles {
                let (a, b, c) = (mesh.points[tr[0]], mesh.points[tr[1]], mesh.points[tr[2]]);
                let ar = ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() / 2.0;
                area_mm2 += ar;
                for &k in tr {
                    mass[v0 + k] += ph.density_kg_m3 * t * ar * 1e-6 / 3.0;
                }
                tris.push([v0 + tr[0], v0 + tr[1], v0 + tr[2]]);
                info.indices.extend([(v0 + tr[0]) as u32, (v0 + tr[1]) as u32, (v0 + tr[2]) as u32]);
            }
            let h_mm = (area_mm2 / (mesh.points.len() as f64 * 0.866)).sqrt();
            hs.push(h_mm);
            // Edges.
            let mut emap: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
            for tr in &mesh.triangles {
                for k in 0..3 {
                    let (a, b, o) = (tr[k], tr[(k + 1) % 3], tr[(k + 2) % 3]);
                    emap.entry((a.min(b), a.max(b))).or_default().push(o);
                }
            }
            let mut keys: Vec<_> = emap.keys().copied().collect();
            keys.sort_unstable();
            let grain = v(pc.grain_deg.to_radians().cos(), pc.grain_deg.to_radians().sin());
            let d_along = flexural_rigidity(&ph, t_mm);
            let d_across = d_along * ph.anisotropy;
            let in_band = |p: Vec2| {
                cp.folds.iter().any(|f| {
                    let c = if f.orientation == crate::model::Orientation::Horizontal { p.y } else { p.x };
                    c > f.at - 0.5 && c < f.at + f.shift_mm + 0.5
                })
            };
            for (a, b) in keys {
                let (pa, pb) = (mesh.points[a], mesh.points[b]);
                let e = pb - pa;
                let len = e.len() / 1000.0;
                let dir = e.normalized();
                let c = dir.dot(grain);
                let s2 = 4.0 * c * c * (1.0 - c * c);
                let e_t = ph.tensile_modulus_mpa * 1e6 * (1.0 - (1.0 - ph.bias_stiffness) * s2);
                springs.push(Spring {
                    a: v0 + a,
                    b: v0 + b,
                    rest: len,
                    w: e_t * t * (h_mm / 1000.0) / len,
                    area: t * h_mm / 1000.0,
                    strength_pa: ph.tensile_strength_mpa * 1e6,
                });
                let opp = &emap[&(a, b)];
                if opp.len() == 1 {
                    info.boundary.push([(v0 + a) as u32, (v0 + b) as u32]);
                    let (_, seg) = nearest_on_outline((pa + pb) * 0.5, &cp.outline);
                    let m = cp.outline.len();
                    let tag = cp.outline_edges[seg].or(cp.outline_edges[(seg + m - 1) % m]);
                    info.boundary_finish.push(tag.map_or(EdgeFinish::Raw, |e| pc.edges[e].finish));
                } else if opp.len() == 2 {
                    let (x0, x1, x2, x3) = (pa * 0.001, pb * 0.001, mesh.points[opp[0]] * 0.001, mesh.points[opp[1]] * 0.001);
                    let e0 = x1 - x0;
                    let k = [cot(-e0, x2 - x1) + cot(-e0, x3 - x1), cot(e0, x2 - x0) + cot(e0, x3 - x0), -cot(e0, x2 - x0) - cot(-e0, x2 - x1), -cot(e0, x3 - x0) - cot(-e0, x3 - x1)];
                    let tri_a = |p: Vec2, q: Vec2, r: Vec2| ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)).abs() / 2.0;
                    let area = tri_a(x0, x1, x2) + tri_a(x0, x1, x3);
                    let cg = dir.left().dot(grain);
                    let mut d = d_along * cg * cg + d_across * (1.0 - cg * cg);
                    if in_band((pa + pb) * 0.5) {
                        d *= spec.fold_strength.clamp(0.0, 1.0);
                    }
                    let kb = d * 3.0 / area.max(1e-14);
                    bend_terms.push(([v0 + a, v0 + b, v0 + opp[0], v0 + opp[1]], k, kb));
                }
            }
            let range = v0..x.len();
            let trange = t0..tris.len();
            info.pieces.push(PieceInfo {
                id: cp.id.clone(),
                name: pc.name.clone(),
                material_id: pc.material_id.clone(),
                vertex_start: v0 as u32,
                vertex_count: mesh.points.len() as u32,
                index_start: (t0 * 3) as u32,
                index_count: (mesh.triangles.len() * 3) as u32,
                thickness_mm: t_mm,
            });
            let sinfo = craft::stitch_info(run_kind(cp));
            for run in &cp.stitch_runs {
                let holes = run.holes.iter().filter_map(|&hp| locate(hp, &rest2d, &tris, trange.clone())).collect();
                let edge = if sinfo.wraps_edge {
                    run.holes.iter().filter_map(|&hp| {
                        // Just inside the cut edge so the point lands on the mesh.
                        let (q, _) = nearest_on_outline(hp, &cp.outline);
                        let inward = (hp - q).normalized();
                        locate(q + inward * 0.2, &rest2d, &tris, trange.clone())
                    }).collect()
                } else {
                    vec![]
                };
                info.stitches.push(StitchLine { piece_id: cp.id.clone(), closed: run.closed, holes, kind: run.kind, lace: run.lace, wraps_edge: sinfo.wraps_edge, edge, hidden: vec![], row: run.row });
                stitch_rest.push(run.holes.clone());
            }
            // Plain holes and slots, plus the visible cut-outs hardware needs.
            let covered = |id: &str| -> bool {
                let Some(hw) = id.split('#').next().and_then(|h| cp.hardware.iter().find(|x| x.id == h)) else { return false };
                !matches!(hw.kind.as_str(), "zipper" | "grommet-10" | "eyelet-5" | "turnlock-eyelet" | "buckle" | "sam-browne")
            };
            for hd in &cp.holes {
                if covered(&hd.id) {
                    continue;
                }
                if let Some(at) = locate(hd.center, &rest2d, &tris, trange.clone()) {
                    let from_hw = hd.id.contains('#');
                    let label = if from_hw && hd.id.split('#').next().is_some_and(|h| cp.hardware.iter().any(|x| x.id == h && x.kind == "buckle")) { "Tongue slot".into() } else { hd.label.clone() };
                    info.hardware.push(HardwareInfo { piece_id: cp.id.clone(), at, diameter_mm: hd.diameter_mm, slot_mm: hd.length_mm, angle_deg: hd.angle_deg, label, kind: String::new(), toward: None });
                }
            }
            for hw in &cp.hardware {
                let Some(hi) = craft::hardware_info(&hw.kind) else { continue };
                let Some(at) = locate(hw.at, &rest2d, &tris, trange.clone()) else { continue };
                let dir = v(hw.angle_deg.to_radians().cos(), hw.angle_deg.to_radians().sin());
                let toward = locate(hw.at + dir * 3.0, &rest2d, &tris, trange.clone());
                let size = if hw.size_mm > 0.0 { hw.size_mm } else { hi.default_size_mm };
                let label = if hw.label.is_empty() { hi.name.to_string() } else { hw.label.clone() };
                info.hardware.push(HardwareInfo { piece_id: cp.id.clone(), at: at.clone(), diameter_mm: size, slot_mm: 0.0, angle_deg: hw.angle_deg, label, kind: hw.kind.clone(), toward });
                let vi = nearest(hw.at, &rest2d, range.clone());
                mass[vi] += hi.grams / 1000.0;
                let t = tris[at.tri as usize];
                let w = (0..3).fold([0.0; 3], |acc, k| add(acc, scale(x[t[k]], at.bary[k] as f64)));
                hw_vertex.push((cp.id.clone(), Pt::on(&at, &tris), hw.clone(), w));
            }
            piece_ranges.insert(cp.id.clone(), (range, trange, cp));
        }
        if x.is_empty() {
            return Err("Nothing to simulate: add a piece first.".into());
        }
        // Sit on the floor.
        let min_z = x.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
        let lift = spec.lift_mm / 1000.0 + half_t.iter().cloned().fold(0.0, f64::max) + 0.0006 - min_z;
        for p in x.iter_mut() {
            p[2] += lift;
        }
        let h = hs.iter().sum::<f64>() / hs.len() as f64 / 1000.0;
        let m_avg = mass.iter().sum::<f64>() / mass.len() as f64;
        let cap = STIFF_CAP * m_avg / (DT * DT);
        for s in springs.iter_mut() {
            s.w = s.w.min(cap);
        }

        // Seams: pair points along joined edges (stitch holes, glue band, or the edges themselves
        // for zippers and butt seams) and weld them; fasten coinciding rivets and snaps.
        let mut welds: Vec<Weld> = Vec::new();
        let mut turned_pts: HashMap<String, Vec<Vec2>> = HashMap::new();
        let leather = || crate::physics::default_physics(crate::model::MaterialKind::Leather);
        for j in &project.joins {
            let Some((ra, _, ca)) = piece_ranges.get(&j.a.piece_id) else { continue };
            let pa = project.piece(&j.a.piece_id).unwrap();
            let sinfo = craft::stitch_info(pa.stitch.kind);
            let thread = craft::thread(project.thread.as_deref(), sinfo.lace);
            let glue = craft::adhesive_info(j.glue);
            let glue_w = if j.glue_width_mm > 0.0 { j.glue_width_mm } else { (2.0 * pa.stitch.margin_mm).max(6.0) };
            let edge_seam = matches!(j.construction, Construction::Zipper | Construction::Butt);
            let stitched_a = !stitch_points(ca, pa.stitch.margin_mm, &j.a.edges).is_empty();
            // Points on side a, and how to find the matching points on side b.
            let (sa, offset_a) = if edge_seam {
                let line = edge_line(ca, 0.3, &j.a.edges);
                (spread(&line, ((line_len(&line) / 4.0).round() as usize).max(3)), 0.3)
            } else if stitched_a {
                (stitch_points(ca, pa.stitch.margin_mm, &j.a.edges), pa.stitch.margin_mm)
            } else if j.glue != Adhesive::None {
                let line = edge_line(ca, glue_w / 2.0, &j.a.edges);
                (spread(&line, ((line_len(&line) / 4.0).round() as usize).max(3)), glue_w / 2.0)
            } else {
                info.warnings.push(format!("The seam on {} has no stitching, glue or zipper, so it is not joined in 3D.", pa.name));
                continue;
            };
            if sa.len() < 2 {
                continue;
            }
            let spacing = line_len(&edge_line(ca, offset_a, &j.a.edges)) / (sa.len() - 1) as f64 / 1000.0;
            let ta = piece_ranges[&j.a.piece_id].1.clone();
            let at = |p: Vec2, tr: std::ops::Range<usize>| locate(p, &rest2d, &tris, tr).map(|sp| Pt::on(&sp, &tris));
            let pts_a: Vec<Pt> = sa.iter().filter_map(|&p| at(p, ta.clone())).collect();
            let Some((rb, tb, cb)) = piece_ranges.get(&j.b.piece_id) else { continue };
            let pb = project.piece(&j.b.piece_id).unwrap();
            // Pieces arranged on the form start where they will be sewn, so each point pairs
            // with the nearest point of the other line; flat pieces pair hole for hole.
            let both_placed = placed.get(&j.a.piece_id).copied().unwrap_or(false) && placed.get(&j.b.piece_id).copied().unwrap_or(false);
            let mut aligned = j.onto_face();
            let pts_b: Vec<Pt> = if j.onto_face() {
                // Sewn onto a face: each point catches the nearest point of the other piece.
                pts_a.iter().map(|p| closest_on(&x, &tris, tb.clone(), p.pos(&x))).collect()
            } else {
                let off_b = if edge_seam || !stitched_a { offset_a } else { pb.stitch.margin_mm };
                let sb = if edge_seam || !stitched_a {
                    spread(&edge_line(cb, offset_a, &j.b.edges), sa.len())
                } else {
                    stitch_points(cb, pb.stitch.margin_mm, &j.b.edges)
                };
                if sb.is_empty() {
                    info.warnings.push(format!("The seam between {} and {} has stitching on one side only, so it is not sewn in 3D.", pa.name, pb.name));
                    continue;
                }
                if both_placed && j.a.piece_id != j.b.piece_id {
                    aligned = true;
                    let line = edge_line(cb, off_b, &j.b.edges);
                    let cands: Vec<(Pt, P3)> = spread(&line, (line_len(&line) / 0.8).ceil() as usize + 2).into_iter().filter_map(|p| at(p, tb.clone())).map(|p| (p, p.pos(&x))).collect();
                    pts_a.iter().map(|p| {
                        let q = p.pos(&x);
                        cands.iter().min_by(|a, b| norm(sub(a.1, q)).partial_cmp(&norm(sub(b.1, q))).unwrap()).map_or(*p, |c| c.0)
                    }).collect()
                } else {
                    sb.iter().filter_map(|&p| at(p, tb.clone())).collect()
                }
            };
            let _ = (ra, rb);
            let n = pts_a.len().min(pts_b.len());
            if n == 0 {
                continue;
            }
            let pick = |k: usize, rev: bool| -> (Pt, Pt) {
                let a = pts_a[k * pts_a.len() / n];
                let b = if aligned { pts_b[k * pts_b.len() / n] } else if rev { pts_b[pts_b.len() - 1 - k * pts_b.len() / n] } else { pts_b[k * pts_b.len() / n] };
                (a, b)
            };
            let cost = |rev: bool| -> f64 { (0..n).map(|k| { let (a, b) = pick(k, rev); norm(sub(a.pos(&x), b.pos(&x))) }).sum() };
            let rev = !aligned && cost(true) < cost(false);
            // Strength of one weld.
            let t_min = (ca.thickness_mm.min(cb.thickness_mm)) / 1000.0;
            let ligament = ((pa.stitch.pitch_mm - pa.stitch.hole_mm).max(0.5)) / 1000.0;
            let ph_a = project.material(&pa.material_id).map(physics_of).unwrap_or_else(leather);
            let mut allow = 0.0;
            if stitched_a && !edge_seam {
                allow += (sinfo.strands * thread.break_n).min(ph_a.tensile_strength_mpa * 1e6 * t_min * ligament);
            }
            allow += glue.shear_mpa * 1e6 * (glue_w / 1000.0) * spacing;
            if j.construction == Construction::Zipper {
                allow = 12_000.0 * spacing;
            }
            if j.construction == Construction::Butt && stitched_a {
                allow += (sinfo.strands * thread.break_n).min(ph_a.tensile_strength_mpa * 1e6 * t_min * ligament);
            }
            let allow = allow.max(1.0);
            let insert_t = j.insert_material_id.as_deref().and_then(|m| project.material(m)).map_or(ca.thickness_mm, |m| m.thickness_mm);
            let extra = match j.construction {
                Construction::Welted => insert_t / 1000.0,
                Construction::Piped => 2.0 * insert_t.min(1.0) / 1000.0,
                _ => 0.0,
            };
            let mut seen = std::collections::HashSet::new();
            let mut pairs = Vec::new();
            for k in 0..n {
                let (pa_, pb_) = pick(k, rev);
                let (a, b) = (pa_.main(), pb_.main());
                let d = norm(sub(pa_.pos(&x), pb_.pos(&x)));
                if a != b || d > 1e-6 {
                    // Within one folded piece keep the designed spacing; separate pieces are
                    // drawn together until their faces touch, like sewing in CLO.
                    let rest = match j.construction {
                        Construction::Zipper => 0.007,
                        Construction::Butt => 0.0008,
                        _ if j.a.piece_id == j.b.piece_id && !j.onto_face() && d < 0.03 => d.max(half_t[a] + half_t[b]),
                        // Arranged pieces start sewn: where the stitch lines already meet (a corner),
                        // keep them there rather than pushing them apart in no particular direction.
                        _ if both_placed => d.min(half_t[a] + half_t[b] + extra),
                        _ => half_t[a] + half_t[b] + extra,
                    };
                    welds.push(Weld { a: pa_, b: pb_, rest, w: cap * 0.5, allow, seam: true, base: 0.0 });
                    // Zipper teeth and tape weigh about 0.11 g per millimetre.
                    if j.construction == Construction::Zipper {
                        mass[a] += 0.11 * spacing * 1000.0 / 1000.0;
                    }
                    if seen.insert((a, b)) {
                        pairs.push([a as u32, b as u32]);
                    }
                }
            }
            if matches!(j.construction, Construction::Welted | Construction::Piped | Construction::Bound | Construction::Zipper) {
                // Draw along the outer edges, not the stitch line.
                let ea = spread(&edge_line(ca, 0.3, &j.a.edges), n);
                let eb = spread(&edge_line(cb, 0.3, &j.b.edges), n);
                let mut dp = Vec::new();
                for k in 0..ea.len().min(eb.len()) {
                    let a = nearest(ea[k], &rest2d, ra.clone());
                    let b = nearest(eb[if rev { eb.len() - 1 - k } else { k }], &rest2d, rb.clone());
                    dp.push([a as u32, b as u32]);
                }
                let width = if j.insert_mm > 0.0 { j.insert_mm } else { match j.construction { Construction::Piped => 4.0, Construction::Bound => 2.0 * pa.stitch.margin_mm + 2.0, Construction::Zipper => 6.0, _ => pa.stitch.margin_mm * 2.0 + 1.5 } };
                info.decor.push(SeamDecor { construction: j.construction, pairs: if dp.is_empty() { pairs } else { dp }, width_mm: width, thickness_mm: insert_t, material_id: j.insert_material_id.clone().or_else(|| Some(pa.material_id.clone())) });
            }
            // A glued seam is bonded across its margin, not just at the stitch line: a second row
            // at the cut edges clamps the corner instead of leaving a hinge.
            let clamps = j.glue != Adhesive::None && !edge_seam && !j.onto_face() && j.a.piece_id != j.b.piece_id;
            // The seam flange (two layers stitched, often glued) holds the angle the pieces meet
            // at, which a line of stitches on a coarse mesh would not: brace each stitch with a
            // spring between points a little way into each piece.
            if !j.onto_face() && j.a.piece_id != j.b.piece_id && j.construction != Construction::Zipper {
                let depth = (h * 1000.0 * 1.6).max(12.0);
                let ia = spread(&edge_line(ca, offset_a + depth, &j.a.edges), n);
                let lb = edge_line(cb, offset_a + depth, &j.b.edges);
                let ib = spread(&lb, n);
                let k_brace = match (j.construction, clamps) {
                    (Construction::Turned, _) | (Construction::Butt, false) => 0.03,
                    (_, true) => 0.35,
                    _ => 0.12,
                };
                let cands = line_vertices(&lb, &rest2d, rb.clone());
                let mut braced = std::collections::HashSet::new();
                for k in 0..ia.len().min(ib.len()) {
                    let a = nearest(ia[k], &rest2d, ra.clone());
                    let b = if both_placed { nearest_3d(&x, a, &cands) } else { nearest(ib[if rev { ib.len() - 1 - k } else { k }], &rest2d, rb.clone()) };
                    if a != b && braced.insert((a, b)) {
                        welds.push(Weld { a: a.into(), b: b.into(), rest: norm(sub(x[a], x[b])), w: cap * k_brace, allow: 1e12, seam: false, base: 0.0 });
                    }
                }
            }
            if clamps {
                let ea = spread(&edge_line(ca, 0.4, &j.a.edges), n);
                let lb = edge_line(cb, 0.4, &j.b.edges);
                let eb = spread(&lb, n);
                let cands: Vec<(Pt, P3)> = spread(&lb, (line_len(&lb) / 0.8).ceil() as usize + 2).into_iter().filter_map(|p| at(p, tb.clone())).map(|p| (p, p.pos(&x))).collect();
                let glue_allow = (glue.shear_mpa * 1e6 * (glue_w / 2000.0) * spacing).max(1.0);
                for k in 0..ea.len().min(eb.len()) {
                    let Some(a) = at(ea[k], ta.clone()) else { continue };
                    let b = if both_placed {
                        let q = a.pos(&x);
                        cands.iter().min_by(|u, w| norm(sub(u.1, q)).partial_cmp(&norm(sub(w.1, q))).unwrap()).map(|c| c.0)
                    } else {
                        at(eb[if rev { eb.len() - 1 - k } else { k }], tb.clone())
                    };
                    let Some(b) = b else { continue };
                    let (ma, mb) = (a.main(), b.main());
                    let d0 = norm(sub(a.pos(&x), b.pos(&x)));
                    let rest = if both_placed && d0 < 0.012 { d0 } else { half_t[ma] + half_t[mb] + extra };
                    welds.push(Weld { a, b, rest, w: cap * 0.5, allow: glue_allow, seam: true, base: 0.0 });
                }
            }
            if j.construction == Construction::Turned {
                turned_pts.entry(j.a.piece_id.clone()).or_default().extend(sa.iter().copied());
                if !j.onto_face() {
                    turned_pts.entry(j.b.piece_id.clone()).or_default().extend(stitch_points(cb, pb.stitch.margin_mm, &j.b.edges));
                }
            }
            info.seams += 1;
        }
        // Stitching inside turned seams does not show.
        for (line, rest) in info.stitches.iter_mut().zip(stitch_rest.iter()) {
            if let Some(pts) = turned_pts.get(&line.piece_id) {
                line.hidden = rest.iter().enumerate().filter(|(_, h)| pts.iter().any(|p| p.dist(**h) < 0.8)).map(|(k, _)| k as u32).collect();
            }
        }
        // Laminates: glue two pieces face to face wherever they overlap.
        for lam in &project.laminates {
            let (Some((ra, ta, _)), Some((rb, tb, _))) = (piece_ranges.get(&lam.a), piece_ranges.get(&lam.b)) else { continue };
            let ((small, st), big) = if ra.len() <= rb.len() { ((ra.clone(), ta.clone()), rb.clone()) } else { ((rb.clone(), tb.clone()), ra.clone()) };
            let glue = craft::adhesive_info(if lam.glue == Adhesive::None { Adhesive::ContactCement } else { lam.glue });
            let area_m2: f64 = st
                .map(|ti| {
                    let t = tris[ti];
                    let (a, b, c) = (rest2d[t[0]], rest2d[t[1]], rest2d[t[2]]);
                    ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() / 2.0 * 1e-6
                })
                .sum();
            let per_vertex = area_m2 / small.len().max(1) as f64;
            let reach = 0.02;
            let mut glued = 0;
            for i in small {
                let j = big.clone().min_by(|&p, &q| norm(sub(x[p], x[i])).partial_cmp(&norm(sub(x[q], x[i]))).unwrap()).unwrap();
                if norm(sub(x[j], x[i])) < reach {
                    welds.push(Weld { a: i.into(), b: j.into(), rest: half_t[i] + half_t[j], w: cap * 0.3, allow: (glue.shear_mpa * 1e6 * per_vertex).max(1.0), seam: false, base: 0.0 });
                    glued += 1;
                }
            }
            if glued == 0 {
                info.warnings.push("A laminate's two pieces do not overlap in 3D: arrange them on the same face.".into());
            }
            info.laminated += 1;
        }
        // Set hardware that holds layers together: matching fasteners within a few millimetres.
        for i in 0..hw_vertex.len() {
            for k in i + 1..hw_vertex.len() {
                let (ref pa, a, ref ha, wa) = hw_vertex[i];
                let (ref pb, b, ref hb, wb) = hw_vertex[k];
                let (Some(ia), Some(ib)) = (craft::hardware_info(&ha.kind), craft::hardware_info(&hb.kind)) else { continue };
                if !(ia.fastens && ib.fastens) || wa == wb {
                    continue;
                }
                // Compare where the hardware really is, not the nearest mesh vertex.
                let close = norm(sub(wa, wb)) < if pa == pb { 0.012 } else { 0.0065 };
                if close {
                    welds.push(Weld { a, b, rest: half_t[a.main()] + half_t[b.main()], w: cap, allow: ia.hold_n.min(ib.hold_n), seam: false, base: 0.0 });
                    info.fasteners += 1;
                }
            }
        }
        let round_holes: Vec<(usize, P3)> = info
            .hardware
            .iter()
            .filter(|hw| hw.kind.is_empty() && hw.slot_mm <= hw.diameter_mm)
            .map(|hw| {
                let t = tris[hw.at.tri as usize];
                let b = hw.at.bary;
                let p = add(add(scale(x[t[0]], b[0] as f64), scale(x[t[1]], b[1] as f64)), scale(x[t[2]], b[2] as f64));
                let near = t.iter().copied().max_by(|&i, &j| {
                    let wi = b[t.iter().position(|&q| q == i).unwrap()];
                    let wj = b[t.iter().position(|&q| q == j).unwrap()];
                    wi.partial_cmp(&wj).unwrap()
                });
                (near.unwrap_or(t[0]), p)
            })
            .collect();
        for i in 0..round_holes.len() {
            for j in i + 1..round_holes.len() {
                let (a, pa) = round_holes[i];
                let (b, pb) = round_holes[j];
                if a != b && norm(sub(pa, pb)) < 0.012 && piece_of[a] == piece_of[b] || a != b && norm(sub(pa, pb)) < 0.004 {
                    welds.push(Weld { a: a.into(), b: b.into(), rest: half_t[a] + half_t[b], w: cap, allow: 400.0, seam: false, base: 0.0 });
                    info.fasteners += 1;
                }
            }
        }

        base = SymBuilder::new(x.len());
        for i in 0..x.len() {
            base.add(i, i, mass[i] / (DT * DT));
        }
        for s in &springs {
            base.add(s.a, s.a, s.w);
            base.add(s.b, s.b, s.w);
            base.add(s.a, s.b, -s.w);
        }
        let weld_c: Vec<Vec<(usize, f64)>> = welds.iter().map(|wd| coeffs(&wd.a, &wd.b)).collect();
        for (wd, c) in welds.iter().zip(weld_c.iter()) {
            for r in 0..c.len() {
                for s in 0..=r {
                    base.add(c[r].0, c[s].0, wd.w * c[r].1 * c[s].1);
                }
            }
        }
        for (idx, k, kb) in &bend_terms {
            for r in 0..4 {
                for s in 0..=r {
                    base.add(idx[r], idx[s], kb * k[r] * k[s]);
                }
            }
        }
        let base_entries: Vec<(usize, usize, f64)> = base.entries().collect();
        let n = x.len();
        let weld_start: Vec<f64> = welds.iter().map(|w| norm(sub(w.b.pos(&x), w.a.pos(&x)))).collect();
        let mut sim = Sim {
            weld_start,
            weld_c,
            spec,
            start: x.clone(),
            x,
            vel: vec![[0.0; 3]; n],
            mass,
            half_t,
            friction,
            rest2d,
            piece_of,
            tris,
            springs,
            welds,
            bends: bend_terms,
            floor: Default::default(),
            frame: 0,
            base: base_entries,
            pins: HashMap::new(),
            drag: None,
            objects: vec![],
            weights: vec![],
            factor: None,
            h,
            time: 0.0,
            settled: false,
            info,
        };
        sim.refactor()?;
        Ok(sim)
    }

    /// Vertices held by a person: pins and the dragged point.
    fn held_set(&self) -> Vec<bool> {
        let mut f = vec![false; self.x.len()];
        for &i in self.pins.values() {
            f[i] = true;
        }
        if let Some((i, _)) = self.drag {
            f[i] = true;
        }
        f
    }

    /// Everything the solver keeps still this frame: held vertices and points resting on the floor.
    fn fixed_set(&self) -> Vec<bool> {
        let mut f = self.held_set();
        for &i in &self.floor {
            f[i] = true;
        }
        f
    }

    /// Internal force on every vertex (stretch, seams, bending), newtons.
    fn internal_forces(&self) -> Vec<P3> {
        let mut out = vec![[0.0; 3]; self.x.len()];
        for sp in &self.springs {
            let d = sub(self.x[sp.b], self.x[sp.a]);
            let l = norm(d).max(1e-12);
            let f = scale(d, sp.w * (l - sp.rest) / l);
            out[sp.a] = add(out[sp.a], f);
            out[sp.b] = sub(out[sp.b], f);
        }
        for (wd, cs) in self.welds.iter().zip(self.weld_c.iter()) {
            let d = sub(wd.b.pos(&self.x), wd.a.pos(&self.x));
            let l = norm(d).max(1e-12);
            let f = scale(d, wd.w * (l - wd.rest) / l);
            for &(u, cu) in cs {
                out[u] = sub(out[u], scale(f, cu));
            }
        }
        for (idx, k, kb) in &self.bends {
            let mut s = [0.0; 3];
            for r in 0..4 {
                s = add(s, scale(self.x[idx[r]], k[r]));
            }
            for r in 0..4 {
                out[idx[r]] = sub(out[idx[r]], scale(s, kb * k[r]));
            }
        }
        out
    }

    /// Floor contact inside the solve: points resting on the floor are held still (static
    /// friction) until the structure lifts them or pulls them sideways harder than friction
    /// allows. Without this the floor only pushes after each solve, so a standing bag sinks a
    /// little every frame and folds up. Returns whether the set changed.
    fn update_floor(&mut self) -> bool {
        let mut changed = false;
        if !self.floor.is_empty() {
            let f = self.internal_forces();
            let mut ext = vec![[0.0, 0.0, 0.0]; self.x.len()];
            for (_, _, vs) in &self.weights {
                for &(i, force) in vs {
                    ext[i][2] -= force;
                }
            }
            let release: Vec<usize> = self
                .floor
                .iter()
                .copied()
                .filter(|&i| {
                    // What the floor has to supply to hold this point.
                    let total = add(f[i], [ext[i][0], ext[i][1], ext[i][2] - self.mass[i] * G]);
                    let r = scale(total, -1.0);
                    let side = (r[0] * r[0] + r[1] * r[1]).sqrt();
                    r[2] < -1e-5 || side > self.friction[i] * r[2].max(0.0) + 1e-5
                })
                .collect();
            for i in release {
                self.floor.remove(&i);
                changed = true;
            }
        }
        let held = self.held_set();
        for i in 0..self.x.len() {
            if held[i] || self.floor.contains(&i) {
                continue;
            }
            let r = self.half_t[i] + 0.0005;
            if self.x[i][2] <= r + 0.00005 && self.vel[i][2] <= 0.02 {
                self.x[i][2] = r;
                self.vel[i] = [0.0; 3];
                self.floor.insert(i);
                changed = true;
            }
        }
        changed
    }

    fn refactor(&mut self) -> Result<(), String> {
        let fixed = self.fixed_set();
        let free: Vec<usize> = (0..self.x.len()).filter(|&i| !fixed[i]).collect();
        let mut slot = vec![usize::MAX; self.x.len()];
        for (k, &i) in free.iter().enumerate() {
            slot[i] = k;
        }
        let mut a = SymBuilder::new(free.len());
        let mut coupling = Vec::new();
        for &(i, j, val) in &self.base {
            match (fixed[i], fixed[j]) {
                (false, false) => a.add(slot[i], slot[j], val),
                (false, true) => coupling.push((slot[i], j, val)),
                (true, false) => coupling.push((slot[j], i, val)),
                _ => {}
            }
        }
        self.factor = Some(Factor { chol: BandedCholesky::factor(&a)?, free, slot, coupling });
        Ok(())
    }

    pub fn reset(&mut self) {
        self.x = self.start.clone();
        self.vel = vec![[0.0; 3]; self.x.len()];
        for o in self.objects.iter_mut() {
            o.pos = mm(o.spec.pos);
            o.vel = [0.0; 3];
        }
        self.time = 0.0;
        self.settled = false;
        if !self.floor.is_empty() {
            self.floor.clear();
            let _ = self.refactor();
        }
    }

    pub fn set_props(&mut self, props: Vec<Prop>) {
        self.spec.props = props;
        self.settled = false;
    }

    pub fn props(&self) -> &[Prop] {
        &self.spec.props
    }

    /// Nearest cloth vertex to a world point (mm).
    pub fn nearest_vertex(&self, p: [f64; 3]) -> usize {
        let q = mm(p);
        (0..self.x.len()).min_by(|&a, &b| norm(sub(self.x[a], q)).partial_cmp(&norm(sub(self.x[b], q))).unwrap()).unwrap_or(0)
    }

    /// Vertex of a piece nearest a pattern point (piece-local mm).
    pub fn vertex_at(&self, piece_id: &str, p: Vec2) -> Option<usize> {
        let k = self.info.pieces.iter().position(|q| q.id == piece_id)?;
        let pi = &self.info.pieces[k];
        let r = pi.vertex_start as usize..(pi.vertex_start + pi.vertex_count) as usize;
        Some(nearest(p, &self.rest2d, r))
    }

    pub fn pin(&mut self, id: &str, vertex: usize) -> Result<(), String> {
        if vertex >= self.x.len() {
            return Err("No such vertex".into());
        }
        self.pins.insert(id.to_string(), vertex);
        self.settled = false;
        self.refactor()
    }

    pub fn unpin(&mut self, id: &str) -> Result<(), String> {
        if self.pins.remove(id).is_some() {
            self.refactor()?;
        }
        self.settled = false;
        Ok(())
    }

    pub fn pins(&self) -> Vec<(String, [f64; 3])> {
        self.pins.iter().map(|(k, &i)| (k.clone(), scale(self.x[i], 1000.0))).collect()
    }

    /// Start, move or end dragging a vertex toward a world point (mm).
    pub fn drag(&mut self, vertex: Option<usize>, target: [f64; 3]) -> Result<(), String> {
        let before = self.drag.map(|d| d.0);
        self.drag = vertex.map(|i| (i, mm(target)));
        self.settled = false;
        if before != vertex {
            self.refactor()?;
        }
        Ok(())
    }

    pub fn add_object(&mut self, spec: ObjectSpec) {
        self.objects.retain(|o| o.spec.id != spec.id);
        let mass = (spec.grams / 1000.0).max(0.001);
        self.objects.push(Obj { pos: mm(spec.pos), vel: [0.0; 3], mass, spec, touching: false });
        self.settled = false;
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        self.objects.retain(|o| o.spec.id != id);
        self.weights.retain(|w| w.0 != id);
        self.unpin(id)
    }

    /// Hang `grams` from the cloth around a vertex (spread over a 20 mm radius, like a strap or hook).
    pub fn add_weight(&mut self, id: &str, vertex: usize, grams: f64) {
        let p = self.rest2d[vertex];
        let piece = self.piece_of[vertex];
        let near: Vec<usize> = (0..self.x.len()).filter(|&i| self.piece_of[i] == piece && self.rest2d[i].dist(p) < 20.0).collect();
        let near = if near.is_empty() { vec![vertex] } else { near };
        let f = grams / 1000.0 * G / near.len() as f64;
        self.weights.retain(|w| w.0 != id);
        self.weights.push((id.to_string(), grams, near.into_iter().map(|i| (i, f)).collect()));
        self.settled = false;
    }

    pub fn objects(&self) -> Vec<(String, [f64; 3])> {
        self.objects.iter().map(|o| (o.spec.id.clone(), scale(o.pos, 1000.0))).collect()
    }

    pub fn object_specs(&self) -> Vec<ObjectSpec> {
        self.objects.iter().map(|o| o.spec.clone()).collect()
    }

    pub fn weights(&self) -> Vec<(String, f64, [f64; 3])> {
        self.weights.iter().map(|(id, g, vs)| (id.clone(), *g, scale(self.x[vs[0].0], 1000.0))).collect()
    }

    /// Floor and props. Returns true when the point is resting on something.
    fn contact_cloth(&mut self, i: usize, old: P3) -> bool {
        let r = self.half_t[i] + 0.0005;
        let mut p = self.x[i];
        let mut touched = false;
        if p[2] < r {
            p[2] = r;
            touched = true;
        }
        for prop in &self.spec.props {
            let d = sdf_prop(prop, p);
            if d < r {
                let n = gradient(|q| sdf_prop(prop, q), p);
                p = add(p, scale(n, r - d));
                touched = true;
            }
        }
        if touched {
            let mu = self.friction[i];
            let mut dpos = sub(p, old);
            // Keep motion along the contact normal, damp sliding.
            dpos[0] *= 1.0 - mu;
            dpos[1] *= 1.0 - mu;
            p = [old[0] + dpos[0], old[1] + dpos[1], p[2]];
        }
        self.x[i] = p;
        touched
    }

    /// Objects against cloth. A point resting on the floor or a prop cannot give way, so the
    /// object takes the whole correction there; elsewhere it is shared by mass.
    fn contact_objects(&mut self, i: usize, supported: bool) {
        let r = self.half_t[i] + 0.0008;
        for o in self.objects.iter_mut() {
            let local = sub(self.x[i], o.pos);
            let d = sdf_shape(&o.spec.shape, local);
            if d < r {
                let n = gradient(|q| sdf_shape(&o.spec.shape, q), local);
                let m = self.mass[i];
                let push = r - d;
                o.touching = true;
                if supported {
                    // The floor stops the leather going down, nothing more: the object takes the
                    // upward part of the correction, the leather the sideways part.
                    let up = [0.0, 0.0, n[2] * push];
                    let side = [n[0] * push, n[1] * push, 0.0];
                    o.pos = sub(o.pos, up);
                    let share = o.mass / (o.mass + m);
                    self.x[i] = add(self.x[i], scale(side, share));
                    o.pos = sub(o.pos, scale(side, 1.0 - share));
                } else {
                    let share_cloth = o.mass / (o.mass + m);
                    self.x[i] = add(self.x[i], scale(n, push * share_cloth));
                    o.pos = sub(o.pos, scale(n, push * (1.0 - share_cloth)));
                }
            }
        }
    }

    fn self_collide(&mut self, old: &[P3]) {
        let n = self.x.len();
        let cell = (self.h * 1.5).max(0.002);
        let key = |p: P3| ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64, (p[2] / cell).floor() as i64);
        let mut grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
        for (ti, t) in self.tris.iter().enumerate() {
            let (a, b, c) = (self.x[t[0]], self.x[t[1]], self.x[t[2]]);
            let lo = [a[0].min(b[0]).min(c[0]), a[1].min(b[1]).min(c[1]), a[2].min(b[2]).min(c[2])];
            let hi = [a[0].max(b[0]).max(c[0]), a[1].max(b[1]).max(c[1]), a[2].max(b[2]).max(c[2])];
            let (k0, k1) = (key(lo), key(hi));
            for ix in k0.0..=k1.0 {
                for iy in k0.1..=k1.1 {
                    for iz in k0.2..=k1.2 {
                        grid.entry((ix, iy, iz)).or_default().push(ti);
                    }
                }
            }
        }
        let fixed = self.fixed_set();
        let far = 3.0 * self.h * 1000.0;
        for i in 0..n {
            if fixed[i] {
                continue;
            }
            let p = self.x[i];
            let Some(cands) = grid.get(&key(p)) else { continue };
            for &ti in cands {
                let t = self.tris[ti];
                if t.contains(&i) {
                    continue;
                }
                if self.piece_of[t[0]] == self.piece_of[i] {
                    let c = (self.rest2d[t[0]] + self.rest2d[t[1]] + self.rest2d[t[2]]) * (1.0 / 3.0);
                    if c.dist(self.rest2d[i]) < far {
                        continue;
                    }
                }
                let (a, b, c) = (self.x[t[0]], self.x[t[1]], self.x[t[2]]);
                let nrm = cross(sub(b, a), sub(c, a));
                let nl = norm(nrm);
                if nl < 1e-14 {
                    continue;
                }
                let nrm = scale(nrm, 1.0 / nl);
                let dist = dot(sub(p, a), nrm);
                let d = self.half_t[i] + self.half_t[t[0]];
                if dist.abs() >= d {
                    continue;
                }
                // Inside the triangle's prism?
                let q = sub(p, scale(nrm, dist));
                let inside = [(a, b), (b, c), (c, a)].iter().all(|&(u, w)| dot(cross(sub(w, u), sub(q, u)), nrm) >= -1e-12);
                if !inside {
                    continue;
                }
                let (oa, ob, oc) = (old[t[0]], old[t[1]], old[t[2]]);
                let on = cross(sub(ob, oa), sub(oc, oa));
                let side = if dot(sub(old[i], oa), on) >= 0.0 { 1.0 } else { -1.0 };
                let target = side * d;
                let corr = target - dist;
                // Split the correction between the point and the triangle; a triangle held still
                // (pinned, or resting on the floor) leaves it all to the point.
                let movable = t.iter().filter(|&&k| !fixed[k]).count();
                let to_point = if movable == 0 { 1.0 } else { 0.5 };
                self.x[i] = add(self.x[i], scale(nrm, corr * to_point));
                for &k in &t {
                    if !fixed[k] {
                        self.x[k] = sub(self.x[k], scale(nrm, corr * (1.0 - to_point) / movable as f64));
                    }
                }
            }
        }
    }

    pub fn step(&mut self, frames: usize) {
        for _ in 0..frames {
            self.step_once();
        }
    }

    fn step_once(&mut self) {
        // Re-check floor contacts every few frames (each change refactors the solver).
        if self.frame % 5 == 0 && self.update_floor() {
            let _ = self.refactor();
        }
        self.frame += 1;
        let Some(f) = self.factor.take() else { return };
        let n = self.x.len();
        let old = self.x.clone();
        let fixed = self.fixed_set();
        if let Some((i, target)) = self.drag {
            self.x[i] = target;
        }
        let mut fext = vec![[0.0, 0.0, 0.0]; n];
        for (_, _, vs) in &self.weights {
            for &(i, force) in vs {
                fext[i][2] -= force;
            }
        }
        let s: Vec<P3> = (0..n)
            .map(|i| {
                if fixed[i] {
                    self.x[i]
                } else {
                    let acc = [fext[i][0] / self.mass[i], fext[i][1] / self.mass[i], -G + fext[i][2] / self.mass[i]];
                    add(add(self.x[i], scale(self.vel[i], DT)), scale(acc, DT * DT))
                }
            })
            .collect();
        for &i in &f.free {
            self.x[i] = s[i];
        }
        let obj_old: Vec<P3> = self.objects.iter().map(|o| o.pos).collect();
        for o in self.objects.iter_mut() {
            o.vel[2] -= G * DT;
            o.pos = add(o.pos, scale(o.vel, DT));
            o.touching = false;
        }
        let mut fixed_rhs = vec![[0.0; 3]; f.free.len()];
        for &(k, j, val) in &f.coupling {
            for c in 0..3 {
                fixed_rhs[k][c] -= val * self.x[j][c];
            }
        }
        let mut rhs = vec![0.0; f.free.len()];
        for _ in 0..ITERATIONS {
            let mut proj = vec![[0.0; 3]; f.free.len()];
            let mut add_proj = |a: usize, b: usize, rest: f64, w: f64, x: &[P3]| {
                let d = sub(x[b], x[a]);
                let l = norm(d).max(1e-12);
                let p = scale(d, rest / l * w);
                if f.slot[b] != usize::MAX {
                    proj[f.slot[b]] = add(proj[f.slot[b]], p);
                }
                if f.slot[a] != usize::MAX {
                    proj[f.slot[a]] = sub(proj[f.slot[a]], p);
                }
            };
            for sp in &self.springs {
                add_proj(sp.a, sp.b, sp.rest, sp.w, &self.x);
            }
            // Seams draw closed over the first moments, like sewing in CLO, instead of snapping
            // shut and throwing the pieces about.
            let sewing = (1.0 - self.time / SEW_S).max(0.0);
            for ((wd, &start), cs) in self.welds.iter().zip(self.weld_start.iter()).zip(self.weld_c.iter()) {
                let rest = if sewing > 0.0 && start > wd.rest { wd.rest + (start - wd.rest) * sewing } else { wd.rest };
                let d = sub(wd.b.pos(&self.x), wd.a.pos(&self.x));
                let l = norm(d).max(1e-12);
                let p = scale(d, rest / l * wd.w);
                for &(u, cu) in cs {
                    if f.slot[u] != usize::MAX {
                        proj[f.slot[u]] = add(proj[f.slot[u]], scale(p, cu));
                    }
                }
            }
            for c in 0..3 {
                for (k, &i) in f.free.iter().enumerate() {
                    rhs[k] = self.mass[i] / (DT * DT) * s[i][c] + proj[k][c] + fixed_rhs[k][c];
                }
                let sol = f.chol.solve(&rhs);
                for (k, &i) in f.free.iter().enumerate() {
                    self.x[i][c] = sol[k];
                }
            }
            for k in 0..f.free.len() {
                let i = f.free[k];
                let supported = self.contact_cloth(i, old[i]);
                self.contact_objects(i, supported);
            }
            // Points resting on the floor still hold objects up.
            let resting: Vec<usize> = self.floor.iter().copied().collect();
            for i in resting {
                let keep = self.x[i];
                self.contact_objects(i, true);
                self.x[i] = keep;
            }
        }
        self.self_collide(&old);
        let damping = (-1.2 * DT).exp();
        let mut vmax: f64 = 0.0;
        for &i in &f.free {
            self.vel[i] = scale(sub(self.x[i], old[i]), damping / DT);
            vmax = vmax.max(norm(self.vel[i]));
        }
        // Objects: floor and props, then velocity.
        let props = self.spec.props.clone();
        for (k, o) in self.objects.iter_mut().enumerate() {
            let bottom = -sdf_shape(&o.spec.shape, [0.0, 0.0, -10.0]) + 10.0; // distance from centre to bottom
            let mut grounded = false;
            if o.pos[2] - bottom < 0.0 {
                o.pos[2] = bottom;
                grounded = true;
            }
            for prop in &props {
                let probe = [o.pos[0], o.pos[1], o.pos[2] - bottom];
                let d = sdf_prop(prop, probe);
                if d < 0.0 {
                    let n = gradient(|q| sdf_prop(prop, q), probe);
                    o.pos = add(o.pos, scale(n, -d));
                    grounded = true;
                }
            }
            o.vel = scale(sub(o.pos, obj_old[k]), damping / DT);
            if grounded || o.touching {
                o.vel[0] *= 0.6;
                o.vel[1] *= 0.6;
            }
            vmax = vmax.max(norm(o.vel));
        }
        // Remember seam tension while nothing is loaded, so capacity counts only the load.
        if self.objects.is_empty() && self.weights.is_empty() {
            for wd in self.welds.iter_mut() {
                wd.base = (wd.w * (norm(sub(wd.b.pos(&self.x), wd.a.pos(&self.x))) - wd.rest)).max(0.0);
            }
        }
        self.time += DT;
        self.settled = self.time > 0.5 && vmax < 0.003;
        self.factor = Some(f);
    }

    /// Positions (mm, f32, x y z per vertex) followed by object centres.
    pub fn positions(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.x.len() * 3 + self.objects.len() * 3);
        for p in &self.x {
            out.extend([(p[0] * 1000.0) as f32, (p[1] * 1000.0) as f32, (p[2] * 1000.0) as f32]);
        }
        for o in &self.objects {
            out.extend([(o.pos[0] * 1000.0) as f32, (o.pos[1] * 1000.0) as f32, (o.pos[2] * 1000.0) as f32]);
        }
        out
    }

    /// Per-vertex stress as a fraction of the panel's strength (0 = none, 1 = at strength), for
    /// the stress map, and seam utilisation folded into the stitched vertices.
    pub fn utilisation(&self) -> Vec<f32> {
        let mut u = vec![0.0f32; self.x.len()];
        for s in &self.springs {
            let f = s.w * (norm(sub(self.x[s.b], self.x[s.a])) - s.rest);
            let r = (f.max(0.0) / s.area / s.strength_pa) as f32;
            u[s.a] = u[s.a].max(r);
            u[s.b] = u[s.b].max(r);
        }
        for wd in &self.welds {
            let f = wd.w * (norm(sub(wd.b.pos(&self.x), wd.a.pos(&self.x))) - wd.rest);
            let r = (f.max(0.0) / wd.allow) as f32;
            u[wd.a.main()] = u[wd.a.main()].max(r);
            u[wd.b.main()] = u[wd.b.main()].max(r);
        }
        u
    }

    pub fn metrics(&self) -> SimMetrics {
        let mut m = SimMetrics { time_s: self.time, settled: self.settled, pins: self.pins.len(), ..Default::default() };
        m.load_g = self.objects.iter().map(|o| o.mass * 1000.0).sum::<f64>() + self.weights.iter().map(|w| w.1).sum::<f64>();
        m.cloth_g = self.mass.iter().sum::<f64>() * 1000.0;
        let mut util_panel: f64 = 0.0;
        for s in &self.springs {
            let f = s.w * (norm(sub(self.x[s.b], self.x[s.a])) - s.rest);
            let stress = f.max(0.0) / s.area;
            if stress / 1e6 > m.max_stress_mpa {
                m.max_stress_mpa = stress / 1e6;
                m.panel_strength_mpa = s.strength_pa / 1e6;
            }
            util_panel = util_panel.max(stress / s.strength_pa);
        }
        let mut util_seam: f64 = 0.0;
        for wd in &self.welds {
            let f = (wd.w * (norm(sub(wd.b.pos(&self.x), wd.a.pos(&self.x))) - wd.rest)).max(0.0);
            if f > m.max_stitch_n {
                m.max_stitch_n = f;
                m.stitch_capacity_n = wd.allow;
            }
            // Share of the remaining strength used by the load (built-in tension excluded).
            if f > wd.base {
                util_seam = util_seam.max((f - wd.base) / (wd.allow - wd.base).max(1e-6));
            }
        }
        // Pull at each pin: the springs and seams attached to it.
        let fixed = self.held_set();
        let mut pull: HashMap<usize, P3> = HashMap::new();
        let pairs = self.springs.iter().map(|s| (Pt::from(s.a), Pt::from(s.b), s.rest, s.w)).chain(self.welds.iter().map(|wd| (wd.a, wd.b, wd.rest, wd.w)));
        for (a, b, rest, w) in pairs {
            if !a.v.iter().chain(b.v.iter()).any(|&i| fixed[i]) {
                continue;
            }
            let d = sub(b.pos(&self.x), a.pos(&self.x));
            let l = norm(d).max(1e-12);
            let f = scale(d, w * (l - rest) / l);
            for (u, cu) in coeffs(&a, &b) {
                if fixed[u] {
                    let e = pull.entry(u).or_insert([0.0; 3]);
                    *e = sub(*e, scale(f, cu));
                }
            }
        }
        let mut util_pin: f64 = 0.0;
        for (&i, f) in &pull {
            let n = norm(*f);
            let p = self.info.pieces.iter().find(|p| (p.vertex_start as usize..(p.vertex_start + p.vertex_count) as usize).contains(&i));
            let t = p.map_or(1.0, |p| p.thickness_mm) / 1000.0;
            let allow = self.springs.first().map_or(20e6, |s| s.strength_pa) * t * 0.010;
            if n > m.max_pin_n {
                m.max_pin_n = n;
                m.pin_capacity_n = allow;
            }
            util_pin = util_pin.max(n / allow);
        }
        // Physical strain from stress; tensile modulus taken from the stiffest-loaded panel.
        m.max_strain_pct = if m.panel_strength_mpa > 0.0 { m.max_stress_mpa / (m.panel_strength_mpa * 4.0) } else { 0.0 };
        m.sag_mm = (0..self.x.len()).map(|i| norm(sub(self.x[i], self.start[i]))).fold(0.0, f64::max) * 1000.0;
        // Capacity: seam and pin forces scale with the load, so scale the load to the first
        // limit. Panel stress is shown on the map but is too mesh-dependent to rate by.
        let _ = util_panel;
        let total_load = m.load_g + m.cloth_g;
        let worst = util_seam.max(util_pin);
        if m.load_g > 0.0 && self.pins.is_empty() {
            m.limited_by = "pin or hang the piece to rate what it can carry (now the floor or props hold the load)".into();
        } else if m.load_g > 0.0 && worst > 1e-9 {
            let factor = 1.0 / worst / self.spec.safety_factor.max(1.0);
            m.capacity_kg = Some(((total_load * factor) - m.cloth_g).max(0.0) / 1000.0);
            m.limited_by = if util_seam >= util_pin { "stitching".into() } else { "leather tearing at a pin or handle".into() };
        } else {
            m.limited_by = "add a load to estimate capacity".into();
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::templates::card_wallet;

    fn wallet_sim() -> Sim {
        Sim::new(&card_wallet(), SimSpec { resolution: 500, ..Default::default() }).unwrap()
    }

    fn hanging_wallet() -> Sim {
        Sim::new(&card_wallet(), SimSpec { resolution: 500, lift_mm: 400.0, ..Default::default() }).unwrap()
    }

    #[test]
    fn folded_wallet_is_sewn_and_stays_closed() {
        let mut s = wallet_sim();
        assert_eq!(s.info.seams, 2);
        assert!(s.info.stitches.iter().map(|l| l.holes.len()).sum::<usize>() == 64);
        s.step(120);
        let m = s.metrics();
        // Still folded: some points well above the floor (the front layer over the back).
        // Still folded: the front layer lies on the back (two thicknesses), not beside it.
        let t = s.info.pieces[0].thickness_mm;
        let top = s.x.iter().map(|p| p[2]).fold(0.0, f64::max) * 1000.0;
        assert!(top > 1.5 * t, "front layer at {top} mm");
        let width = (s.x.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max) - s.x.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min)) * 1000.0;
        assert!(width < 100.0, "unfolded? spans {width} mm");
        assert!(m.capacity_kg.is_none());
    }

    #[test]
    fn hanging_load_finds_capacity_and_more_load_more_stress() {
        let run = |grams: f64| {
            let mut s = hanging_wallet();
            // Hang from the two back corners.
            let a = s.vertex_at("body", v(2.0, 141.0)).unwrap();
            let b = s.vertex_at("body", v(98.0, 141.0)).unwrap();
            s.pin("p1", a).unwrap();
            s.pin("p2", b).unwrap();
            let mid = s.vertex_at("body", v(50.0, 20.0)).unwrap();
            s.add_weight("w", mid, grams);
            s.step(420);
            s.metrics()
        };
        let light = run(200.0);
        let heavy = run(1000.0);
        eprintln!("light {light:?}\nheavy {heavy:?}");
        assert!(heavy.max_stitch_n > light.max_stitch_n * 3.0);
        assert!(heavy.max_pin_n > light.max_pin_n * 3.0);
        let (a, b) = (light.capacity_kg.unwrap(), heavy.capacity_kg.unwrap());
        assert!(b > 0.5 && b < 500.0, "capacity {b} kg");
        // The estimate should not depend much on the probe load.
        assert!((a / b - 1.0).abs() < 0.35, "{a} vs {b}");
    }

    #[test]
    fn tote_assembles_and_carries_from_its_handles() {
        use crate::bags::{bag, BagParams};
        let p = bag(&BagParams::default());
        let mut s = Sim::new(&p, SimSpec { resolution: 300, ..Default::default() }).unwrap();
        eprintln!("seams {} fasteners {} warnings {:?}", s.info.seams, s.info.fasteners, s.info.warnings);
        assert!(s.info.seams >= 3, "{}", s.info.seams);
        // Eight handle rivets plus the closure magnets when they meet.
        assert!(s.info.fasteners >= 8, "{}", s.info.fasteners);
        s.step(200);
        let top = s.x.iter().map(|q| q[2]).fold(0.0, f64::max) * 1000.0;
        let m = s.metrics();
        eprintln!("standing: top {top:.0} mm, {m:?}");
        // It stands up rather than collapsing flat, and the handles rise above the body.
        assert!(top > 250.0, "top {top}");
        // Carry it: start off the floor hanging from both handle tops, books in the bottom.
        let mut s = Sim::new(&p, SimSpec { resolution: 300, lift_mm: 300.0, ..Default::default() }).unwrap();
        let a = s.vertex_at("handle1", v(280.0, 12.5)).unwrap();
        let b = s.vertex_at("handle2", v(280.0, 12.5)).unwrap();
        s.pin("h1", a).unwrap();
        s.pin("h2", b).unwrap();
        s.step(150);
        let mid = s.vertex_at("gusset", v(p.piece("gusset").unwrap().vertices[1].x / 2.0, 55.0)).unwrap();
        s.add_weight("books", mid, 2000.0);
        s.step(300);
        let m = s.metrics();
        eprintln!("carried: {m:?}");
        let cap = m.capacity_kg.expect("rated when hung");
        assert!(cap > 0.8 && cap < 500.0, "{cap}");
        assert!(s.x.iter().all(|q| q.iter().all(|c| c.is_finite())));
    }

    #[test]
    fn every_construction_builds() {
        use crate::bags::{bag, BagParams, BagStyle};
        for (k, c) in [Construction::Turned, Construction::Welted, Construction::Piped, Construction::Bound, Construction::Butt, Construction::Lapped].into_iter().enumerate() {
            let mut bp = BagParams::style_defaults(BagStyle::BoxedTote);
            bp.construction = c;
            bp.glue = if k % 2 == 0 { Adhesive::None } else { Adhesive::WaterContact };
            bp.stitch = if k == 1 { StitchKind::LaceSingleLoop } else { StitchKind::Saddle };
            let p = bag(&bp);
            let mut s = Sim::new(&p, SimSpec { resolution: 200, ..Default::default() }).unwrap();
            s.step(30);
            assert!(s.info.seams >= 8, "{c:?}: {} seams {:?}", s.info.seams, s.info.warnings);
            assert!(s.x.iter().all(|q| q.iter().all(|c| c.is_finite())), "{c:?} blew up");
            if matches!(c, Construction::Welted | Construction::Piped | Construction::Bound) {
                assert!(!s.info.decor.is_empty());
            }
        }
        // A zip pouch closes with its zipper.
        let p = bag(&BagParams::style_defaults(BagStyle::ZipPouch));
        let s = Sim::new(&p, SimSpec { resolution: 200, ..Default::default() }).unwrap();
        assert!(s.info.decor.iter().any(|d| d.construction == Construction::Zipper));
    }

    #[test]
    fn object_rests_on_the_wallet() {
        let mut s = wallet_sim();
        s.add_object(ObjectSpec { id: "phone".into(), name: "Phone".into(), shape: Shape::Box { size: [72.0, 147.0, 8.0] }, grams: 190.0, pos: [70.0, 124.0, 31.0] });
        s.step(270);
        let p = s.objects()[0].1;
        let z = p[2];
        eprintln!("phone centre {p:?}");
        // It stays on the wallet instead of sliding off it.
        assert!((p[0] - 70.0).abs() < 25.0, "slid to x = {}", p[0]);
        // Lands on the folded wallet (at least two layers) rather than the floor (z = 4).
        assert!(z > 4.0 + 2.0 && z < 40.0, "{z}");
    }
}
