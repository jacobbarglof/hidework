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

use crate::banded::{BandedCholesky, SymBuilder};
use crate::bend::Bender;
use crate::compute::{compute, ComputedPiece};
use crate::geom::{offset_closed, point_at, v, Vec2};
use crate::mesh::triangulate;
use crate::model::Project;
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
    pub stitches: Vec<StitchLine>,
    pub hardware: Vec<HardwareInfo>,
    pub seams: usize,
    pub fasteners: usize,
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

struct Weld {
    a: usize,
    b: usize,
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

/// Evenly spaced points along the stitch line of some edges (matching how holes were placed).
fn stitch_points(cp: &ComputedPiece, margin: f64, edges: &[usize]) -> Vec<Vec2> {
    let inset = offset_closed(&cp.outline, margin);
    let m = cp.outline.len();
    let mut line: Vec<Vec2> = Vec::new();
    for i in 0..m {
        if cp.outline_edges[i].is_some_and(|e| edges.contains(&e)) {
            if line.last().map_or(true, |l| l.dist(inset[i]) > 1e-9) {
                line.push(inset[i]);
            }
            line.push(inset[(i + 1) % m]);
        }
    }
    let holes: usize = edges.iter().filter_map(|&e| cp.edges.get(e)).map(|e| e.hole_count).sum();
    if line.len() < 2 || holes == 0 {
        return vec![];
    }
    let total: f64 = line.windows(2).map(|w| w[0].dist(w[1])).sum();
    let n = holes.max(2);
    (0..n).map(|k| point_at(&line, total * k as f64 / (n - 1) as f64)).collect()
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

fn cot(a: Vec2, b: Vec2) -> f64 {
    a.dot(b) / (a.x * b.y - a.y * b.x).abs().max(1e-12)
}

impl Sim {
    pub fn new(project: &Project, spec: SimSpec) -> Result<Sim, String> {
        let computed = compute(project);
        let mut info = SimInfo { pieces: vec![], rest: vec![], indices: vec![], boundary: vec![], stitches: vec![], hardware: vec![], seams: 0, fasteners: 0, warnings: computed.warnings.clone() };
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
            let mesh = triangulate(&cp.outline, spec.resolution.clamp(80, 4000));
            if mesh.triangles.is_empty() {
                info.warnings.push(format!("{}: could not mesh", pc.name));
                continue;
            }
            let bender = Bender::new(cp, spec.fold_angle_deg);
            let v0 = x.len();
            let t0 = tris.len();
            for &p in &mesh.points {
                let (q, _) = bender.map(p, 0.0);
                x.push([(q[0] + pc.position.x) / 1000.0, (q[1] + pc.position.y) / 1000.0, q[2] / 1000.0]);
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
            for run in &cp.stitch_runs {
                let holes = run.holes.iter().filter_map(|&hp| locate(hp, &rest2d, &tris, trange.clone())).collect();
                info.stitches.push(StitchLine { piece_id: cp.id.clone(), closed: run.closed, holes });
            }
            for hd in &cp.holes {
                if let Some(at) = locate(hd.center, &rest2d, &tris, trange.clone()) {
                    info.hardware.push(HardwareInfo { piece_id: cp.id.clone(), at, diameter_mm: hd.diameter_mm, slot_mm: hd.length_mm, angle_deg: hd.angle_deg, label: hd.label.clone() });
                }
            }
            piece_ranges.insert(cp.id.clone(), (range, trange, cp));
        }
        if x.is_empty() {
            return Err("Nothing to simulate: add a piece first.".into());
        }
        // Sit on the floor.
        let min_z = x.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
        let lift = spec.lift_mm / 1000.0 + half_t.iter().cloned().fold(0.0, f64::max) - min_z;
        for p in x.iter_mut() {
            p[2] += lift;
        }
        let h = hs.iter().sum::<f64>() / hs.len() as f64 / 1000.0;
        let m_avg = mass.iter().sum::<f64>() / mass.len() as f64;
        let cap = STIFF_CAP * m_avg / (DT * DT);
        for s in springs.iter_mut() {
            s.w = s.w.min(cap);
        }

        // Seams: pair stitch points of joined edges; fasten coinciding round holes.
        let mut welds: Vec<Weld> = Vec::new();
        for j in &project.joins {
            let (Some((ra, _, ca)), Some((rb, _, cb))) = (piece_ranges.get(&j.a.piece_id), piece_ranges.get(&j.b.piece_id)) else { continue };
            let (pa, pb) = (project.piece(&j.a.piece_id).unwrap(), project.piece(&j.b.piece_id).unwrap());
            let sa = stitch_points(ca, pa.stitch.margin_mm, &j.a.edges);
            let sb = stitch_points(cb, pb.stitch.margin_mm, &j.b.edges);
            if sa.is_empty() || sb.is_empty() {
                info.warnings.push("A seam has no stitching on one side, so it is not sewn in 3D.".into());
                continue;
            }
            let va: Vec<usize> = sa.iter().map(|&p| nearest(p, &rest2d, ra.clone())).collect();
            let vb: Vec<usize> = sb.iter().map(|&p| nearest(p, &rest2d, rb.clone())).collect();
            let n = va.len().min(vb.len());
            let cost = |rev: bool| -> f64 {
                (0..n).map(|k| norm(sub(x[va[k * va.len() / n]], x[vb[if rev { vb.len() - 1 - k * vb.len() / n } else { k * vb.len() / n }]]))).sum()
            };
            let rev = cost(true) < cost(false);
            let t_min = (ca.thickness_mm.min(cb.thickness_mm)) / 1000.0;
            let ligament = ((pa.stitch.pitch_mm - pa.stitch.hole_mm).max(0.5)) / 1000.0;
            let ph_a = project.material(&pa.material_id).map(physics_of).unwrap_or_else(|| crate::physics::default_physics(crate::model::MaterialKind::Leather));
            let allow = (2.0 * spec.thread_break_n).min(ph_a.tensile_strength_mpa * 1e6 * t_min * ligament);
            let mut seen = std::collections::HashSet::new();
            for k in 0..n {
                let a = va[k * va.len() / n];
                let b = vb[if rev { vb.len() - 1 - k * vb.len() / n } else { k * vb.len() / n }];
                if a != b && seen.insert((a, b)) {
                    // Within one folded piece keep the designed spacing; separate pieces are
                    // drawn together until their faces touch, like sewing in CLO.
                    let rest = if piece_of[a] == piece_of[b] { norm(sub(x[a], x[b])).max(half_t[a] + half_t[b]) } else { half_t[a] + half_t[b] };
                    welds.push(Weld { a, b, rest, w: cap * 0.5, allow, seam: true, base: 0.0 });
                }
            }
            info.seams += 1;
        }
        let round_holes: Vec<(usize, P3)> = info
            .hardware
            .iter()
            .filter(|hw| hw.slot_mm <= hw.diameter_mm)
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
                    welds.push(Weld { a, b, rest: half_t[a] + half_t[b], w: cap, allow: 400.0, seam: false, base: 0.0 });
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
        for wd in &welds {
            base.add(wd.a, wd.a, wd.w);
            base.add(wd.b, wd.b, wd.w);
            base.add(wd.a, wd.b, -wd.w);
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
        let mut sim = Sim {
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

    fn fixed_set(&self) -> Vec<bool> {
        let mut f = vec![false; self.x.len()];
        for &i in self.pins.values() {
            f[i] = true;
        }
        if let Some((i, _)) = self.drag {
            f[i] = true;
        }
        f
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

    /// Hang `grams` from the cloth around a vertex (spread over a few millimetres).
    pub fn add_weight(&mut self, id: &str, vertex: usize, grams: f64) {
        let p = self.rest2d[vertex];
        let piece = self.piece_of[vertex];
        let near: Vec<usize> = (0..self.x.len()).filter(|&i| self.piece_of[i] == piece && self.rest2d[i].dist(p) < 8.0).collect();
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
                // Split the correction between the point and the triangle.
                self.x[i] = add(self.x[i], scale(nrm, corr * 0.5));
                for &k in &t {
                    if !fixed[k] {
                        self.x[k] = sub(self.x[k], scale(nrm, corr * 0.5 / 3.0));
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
            for wd in &self.welds {
                add_proj(wd.a, wd.b, wd.rest, wd.w, &self.x);
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
                wd.base = (wd.w * (norm(sub(self.x[wd.b], self.x[wd.a])) - wd.rest)).max(0.0);
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
            let f = wd.w * (norm(sub(self.x[wd.b], self.x[wd.a])) - wd.rest);
            let r = (f.max(0.0) / wd.allow) as f32;
            u[wd.a] = u[wd.a].max(r);
            u[wd.b] = u[wd.b].max(r);
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
            let f = (wd.w * (norm(sub(self.x[wd.b], self.x[wd.a])) - wd.rest)).max(0.0);
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
        let fixed = self.fixed_set();
        let mut pull: HashMap<usize, P3> = HashMap::new();
        for (a, b, rest, w) in self.springs.iter().map(|s| (s.a, s.b, s.rest, s.w)).chain(self.welds.iter().map(|wd| (wd.a, wd.b, wd.rest, wd.w))) {
            if !(fixed[a] || fixed[b]) {
                continue;
            }
            let d = sub(self.x[b], self.x[a]);
            let l = norm(d).max(1e-12);
            let f = scale(d, w * (l - rest) / l);
            if fixed[a] {
                let e = pull.entry(a).or_insert([0.0; 3]);
                *e = add(*e, f);
            }
            if fixed[b] {
                let e = pull.entry(b).or_insert([0.0; 3]);
                *e = sub(*e, f);
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
