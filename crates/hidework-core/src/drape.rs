//! Drape tests: drop a triangulated piece into a bench scene and let it settle under gravity.
//!
//! Solver: projective dynamics (implicit Euler, local/global iterations, Bouaziz et al. 2014) with
//! a prefactored banded Cholesky. Bending uses the quadratic isometric bending model (Bergou et
//! al. 2006), exact for nearly inextensible sheets like leather, with stiffness from the
//! material's flexural rigidity `E t^3 / 12`. So thickness and tannage change the result the way
//! they do on the bench. Scenes mirror the standard tests: the cantilever strip (ASTM D1388), the
//! Cusick drape over a pedestal, and hanging from one edge. No self-collision yet.

use crate::banded::{BandedCholesky, SymBuilder};
use crate::geom::{v, Vec2};
use crate::mesh::triangulate;
use crate::physics::{bending_length_mm, flexural_rigidity, Physics, G};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Scene {
    /// Lay the piece on a table with `overhangMm` sticking out past the edge on `side`.
    #[serde(rename_all = "camelCase")]
    Cantilever { side: Side, overhang_mm: f64 },
    /// Centre the piece on a round pedestal (Cusick drape test).
    #[serde(rename_all = "camelCase")]
    Pedestal { radius_mm: f64 },
    /// Pin the edge on `side` and let the rest hang.
    #[serde(rename_all = "camelCase")]
    Hang { side: Side },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    pub label: String,
    pub thickness_mm: f64,
    pub physics: Physics,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrapeRequest {
    /// Closed outline in millimetres (piece-local, y down).
    pub outline: Vec<Vec2>,
    #[serde(default)]
    pub grain_deg: f64,
    pub scene: Scene,
    pub variants: Vec<Variant>,
    /// Target vertex count (default 600).
    #[serde(default)]
    pub resolution: Option<usize>,
    /// Simulated seconds (default 4).
    #[serde(default)]
    pub seconds: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Support {
    #[serde(rename_all = "camelCase")]
    Table { side: Side, edge_mm: f64 },
    #[serde(rename_all = "camelCase")]
    Disc { center: Vec2, radius_mm: f64 },
    #[serde(rename_all = "camelCase")]
    Pins { side: Side },
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub bending_length_mm: f64,
    pub flexural_rigidity_unm: f64,
    pub mass_g: f64,
    pub area_cm2: f64,
    /// How far the lowest point ends up below the support, in mm (cantilever: the free tip).
    pub tip_drop_mm: f64,
    /// Cantilever: angle from the table edge down to the tip (41.5 degrees at overhang = 2c).
    pub droop_deg: Option<f64>,
    /// Pedestal: (shadow area - disc) / (flat area - disc). 1 is rigid, near 0 hangs straight down.
    pub drape_coefficient: Option<f64>,
    pub max_stretch_pct: f64,
    pub settled: bool,
    pub seconds_simulated: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantResult {
    pub label: String,
    /// Each frame: x, y, z per vertex in millimetres (z up; x, y as on the pattern).
    pub frames: Vec<Vec<f32>>,
    pub metrics: Metrics,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrapeResult {
    pub rest: Vec<Vec2>,
    pub triangles: Vec<[u32; 3]>,
    pub support: Support,
    pub variants: Vec<VariantResult>,
}

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
fn norm(a: P3) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}

/// Scales the discrete bending energy to the continuum `D/2 * integral(kappa^2)`. Checked by the
/// cantilever test below (overhang 2c should droop about 41.5 degrees).
const BEND_CALIBRATION: f64 = 1.0;
const FPS: f64 = 60.0;
const ITERATIONS: usize = 40;

/// Signed distance toward `side` (larger = further out on that side).
fn along(p: Vec2, side: Side) -> f64 {
    match side {
        Side::Right => p.x,
        Side::Left => -p.x,
        Side::Bottom => p.y,
        Side::Top => -p.y,
    }
}

fn centroid(poly: &[Vec2]) -> Vec2 {
    let n = poly.len();
    let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        let c = p.x * q.y - q.x * p.y;
        a += c;
        cx += (p.x + q.x) * c;
        cy += (p.y + q.y) * c;
    }
    if a.abs() < 1e-12 {
        return poly.iter().fold(v(0.0, 0.0), |s, &p| s + p) * (1.0 / n.max(1) as f64);
    }
    v(cx / (3.0 * a), cy / (3.0 * a))
}

pub fn simulate(req: &DrapeRequest) -> Result<DrapeResult, String> {
    if req.outline.len() < 3 {
        return Err("The piece needs at least three corners.".into());
    }
    if req.variants.is_empty() {
        return Err("Choose at least one material to test.".into());
    }
    let mesh = triangulate(&req.outline, req.resolution.unwrap_or(600).clamp(60, 3000));
    if mesh.triangles.is_empty() {
        return Err("Could not mesh this outline.".into());
    }
    let ext_max = |side: Side| mesh.points.iter().map(|&p| along(p, side)).fold(f64::NEG_INFINITY, f64::max);
    let support = match req.scene {
        Scene::Cantilever { side, overhang_mm } => Support::Table { side, edge_mm: ext_max(side) - overhang_mm.max(1.0) },
        Scene::Pedestal { radius_mm } => Support::Disc { center: centroid(&req.outline), radius_mm: radius_mm.max(1.0) },
        Scene::Hang { side } => Support::Pins { side },
    };
    let results: Vec<Result<VariantResult, String>> = std::thread::scope(|s| {
        let handles: Vec<_> = req
            .variants
            .iter()
            .map(|var| {
                let (mesh, support) = (&mesh, &support);
                s.spawn(move || run_variant(mesh, support, req, var))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("simulation crashed".into()))).collect()
    });
    let variants = results.into_iter().collect::<Result<Vec<_>, _>>()?;
    Ok(DrapeResult {
        rest: mesh.points.clone(),
        triangles: mesh.triangles.iter().map(|t| [t[0] as u32, t[1] as u32, t[2] as u32]).collect(),
        support,
        variants,
    })
}

fn cot(a: Vec2, b: Vec2) -> f64 {
    let c = (a.x * b.y - a.y * b.x).abs();
    a.dot(b) / c.max(1e-12)
}

fn run_variant(mesh: &crate::mesh::Mesh, support: &Support, req: &DrapeRequest, var: &Variant) -> Result<VariantResult, String> {
    let pts = &mesh.points;
    let tris = &mesh.triangles;
    let n = pts.len();
    let t_m = var.thickness_mm.max(0.05) / 1000.0;
    let ph = &var.physics;
    let grain = v(req.grain_deg.to_radians().cos(), req.grain_deg.to_radians().sin());
    let rest_m: Vec<Vec2> = pts.iter().map(|&p| p * 0.001).collect();

    // Lumped masses.
    let mut mass = vec![0.0; n];
    let mut area_mm2 = 0.0;
    let tri_area_m = |a: usize, b: usize, c: usize| {
        let (p, q, r) = (rest_m[a], rest_m[b], rest_m[c]);
        ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)).abs() / 2.0
    };
    for t in tris {
        let ar = tri_area_m(t[0], t[1], t[2]);
        area_mm2 += ar * 1e6;
        for &k in t {
            mass[k] += ph.density_kg_m3 * t_m * ar / 3.0;
        }
    }
    let h_m = (area_mm2 / (n as f64 * 0.866)).sqrt() / 1000.0;

    // Edges with their opposite vertices.
    let mut edge_map: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    for t in tris {
        for k in 0..3 {
            let (a, b, o) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
            edge_map.entry((a.min(b), a.max(b))).or_default().push(o);
        }
    }
    let mut keys: Vec<(usize, usize)> = edge_map.keys().copied().collect();
    keys.sort_unstable();

    // Fixed points for the scene.
    let mut fixed = vec![false; n];
    match *support {
        Support::Table { side, edge_mm } => {
            for i in 0..n {
                fixed[i] = along(pts[i], side) <= edge_mm;
            }
        }
        Support::Pins { side } => {
            let top = pts.iter().map(|&p| along(p, side)).fold(f64::NEG_INFINITY, f64::max);
            for i in 0..n {
                fixed[i] = along(pts[i], side) > top - 0.6 * h_m * 1000.0;
            }
        }
        Support::Disc { center, radius_mm } => {
            // Cusick drape: the specimen is clamped between two discs.
            for i in 0..n {
                fixed[i] = pts[i].dist(center) <= radius_mm;
            }
        }
    }

    // System matrix: M/h^2 + stretch springs + isometric bending.
    let dt = 1.0 / FPS;
    let mut a = SymBuilder::new(n);
    for i in 0..n {
        a.add(i, i, mass[i] / (dt * dt));
    }
    let d_along = flexural_rigidity(ph, var.thickness_mm);
    let d_across = d_along * ph.anisotropy;
    struct Spring {
        a: usize,
        b: usize,
        rest: f64,
        w: f64,
    }
    let mut springs = Vec::with_capacity(keys.len());
    for &(i, j) in &keys {
        let e = rest_m[j] - rest_m[i];
        let len = e.len();
        let dir = e.normalized();
        let c = dir.dot(grain);
        let s2 = 4.0 * c * c * (1.0 - c * c); // sin^2(2 theta): bias direction
        let e_t = ph.tensile_modulus_mpa * 1e6 * (1.0 - (1.0 - ph.bias_stiffness) * s2);
        let w = e_t * t_m * h_m / len;
        a.add(i, i, w);
        a.add(j, j, w);
        a.add(i, j, -w);
        springs.push(Spring { a: i, b: j, rest: len, w });
        let opp = &edge_map[&(i, j)];
        if opp.len() == 2 {
            let (x0, x1, x2, x3) = (rest_m[i], rest_m[j], rest_m[opp[0]], rest_m[opp[1]]);
            let e0 = x1 - x0;
            let (e1, e2, e3, e4) = (x2 - x0, x3 - x0, x2 - x1, x3 - x1);
            let (c01, c02, c03, c04) = (cot(e0, e1), cot(e0, e2), cot(-e0, e3), cot(-e0, e4));
            let k = [c03 + c04, c01 + c02, -c01 - c03, -c02 - c04];
            let area = tri_area_m(i, j, opp[0]) + tri_area_m(i, j, opp[1]);
            let perp = dir.left();
            let cg = perp.dot(grain);
            let d = d_along * cg * cg + d_across * (1.0 - cg * cg);
            let kb = BEND_CALIBRATION * d * 3.0 / area.max(1e-14);
            let idx = [i, j, opp[0], opp[1]];
            for r in 0..4 {
                for s in 0..=r {
                    a.add(idx[r], idx[s], kb * k[r] * k[s]);
                }
            }
        }
    }

    // Reduce to free points; couplings to fixed points move to the right-hand side.
    let free: Vec<usize> = (0..n).filter(|&i| !fixed[i]).collect();
    let mut slot = vec![usize::MAX; n];
    for (k, &i) in free.iter().enumerate() {
        slot[i] = k;
    }
    let mut af = SymBuilder::new(free.len());
    let mut coupling: Vec<(usize, usize, f64)> = Vec::new(); // (free slot, fixed index, value)
    for (i, j, val) in a.entries() {
        match (fixed[i], fixed[j]) {
            (false, false) => af.add(slot[i], slot[j], val),
            (false, true) => coupling.push((slot[i], j, val)),
            (true, false) => coupling.push((slot[j], i, val)),
            (true, true) => {}
        }
    }
    let chol = BandedCholesky::factor(&af)?;

    // State.
    let mut x: Vec<P3> = rest_m.iter().map(|p| [p.x, p.y, 0.0]).collect();
    if let Support::Disc { .. } = support {
        // Break the perfect symmetry so folds can form, as on a real pedestal.
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        for p in x.iter_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            p[2] += ((seed % 1000) as f64 / 1000.0 - 0.5) * 2e-5;
        }
    }
    let mut vel = vec![[0.0; 3]; n];
    let mut fixed_rhs = vec![[0.0; 3]; free.len()];
    for &(k, j, val) in &coupling {
        for c in 0..3 {
            fixed_rhs[k][c] -= val * x[j][c];
        }
    }

    // Long-range attachments keep free points within their rest distance of the nearest pin.
    let pinned: Vec<usize> = (0..n).filter(|&i| fixed[i]).collect();
    let tethers: Vec<(usize, usize, f64)> = if pinned.is_empty() {
        Vec::new()
    } else {
        free.iter()
            .map(|&i| {
                let (p, d) = pinned
                    .iter()
                    .map(|&p| (p, rest_m[p].dist(rest_m[i])))
                    .min_by(|x, y| x.1.partial_cmp(&y.1).unwrap())
                    .unwrap();
                (i, p, d)
            })
            .collect()
    };

    let in_support = |px: f64, py: f64| -> bool {
        match *support {
            Support::Table { side, edge_mm } => along(v(px * 1000.0, py * 1000.0), side) <= edge_mm,
            Support::Disc { center, radius_mm } => v(px * 1000.0, py * 1000.0).dist(center) <= radius_mm,
            Support::Pins { .. } => false,
        }
    };
    let friction = ph.friction.clamp(0.0, 1.0);
    let damping = (-1.5 * dt).exp();
    let seconds = req.seconds.unwrap_or(4.0).clamp(0.5, 20.0);
    let frames_total = (seconds * FPS) as usize;
    let record_every = (frames_total / 60).max(1);
    let mut frames = vec![pack(&x)];
    let mut settled = false;
    let mut frames_run = 0;
    let mut rhs = vec![0.0; free.len()];

    for frame in 0..frames_total {
        let old = x.clone();
        // Inertial target.
        let s: Vec<P3> = (0..n)
            .map(|i| if fixed[i] { x[i] } else { add(add(x[i], scale(vel[i], dt)), [0.0, 0.0, -G * dt * dt]) })
            .collect();
        for i in &free {
            x[*i] = s[*i];
        }
        for _ in 0..ITERATIONS {
            // Local step: each spring's best rest-length direction.
            let mut proj = vec![[0.0; 3]; free.len()];
            for sp in &springs {
                let d = sub(x[sp.b], x[sp.a]);
                let l = norm(d).max(1e-12);
                let p = scale(d, sp.rest / l * sp.w);
                if !fixed[sp.b] {
                    proj[slot[sp.b]] = add(proj[slot[sp.b]], p);
                }
                if !fixed[sp.a] {
                    proj[slot[sp.a]] = sub(proj[slot[sp.a]], p);
                }
            }
            // Global step, one solve per axis.
            for c in 0..3 {
                for (k, &i) in free.iter().enumerate() {
                    rhs[k] = mass[i] / (dt * dt) * s[i][c] + proj[k][c] + fixed_rhs[k][c];
                }
                let sol = chol.solve(&rhs);
                for (k, &i) in free.iter().enumerate() {
                    x[i][c] = sol[k];
                }
            }
            // Contacts and tethers.
            for &i in &free {
                if x[i][2] < 0.0 && old[i][2] >= -2e-4 && in_support(x[i][0], x[i][1]) {
                    x[i][2] = 0.0;
                    x[i][0] = old[i][0] + (x[i][0] - old[i][0]) * (1.0 - friction);
                    x[i][1] = old[i][1] + (x[i][1] - old[i][1]) * (1.0 - friction);
                }
            }
            for &(i, p, rest) in &tethers {
                let d = sub(x[i], x[p]);
                let l = norm(d);
                if l > rest {
                    x[i] = add(x[p], scale(d, rest / l));
                }
            }
        }
        for &i in &free {
            vel[i] = scale(sub(x[i], old[i]), damping / dt);
        }
        frames_run = frame + 1;
        if frame % record_every == 0 {
            frames.push(pack(&x));
        }
        let vmax = free.iter().map(|&i| norm(vel[i])).fold(0.0, f64::max);
        if frame as f64 > FPS * 0.8 && vmax < 0.002 {
            settled = true;
            break;
        }
    }
    frames.push(pack(&x));

    let mut m = Metrics {
        bending_length_mm: bending_length_mm(ph, var.thickness_mm),
        flexural_rigidity_unm: d_along * 1e6,
        mass_g: mass.iter().sum::<f64>() * 1000.0,
        area_cm2: area_mm2 / 100.0,
        settled,
        seconds_simulated: frames_run as f64 / FPS,
        ..Default::default()
    };
    m.max_stretch_pct = springs
        .iter()
        .map(|s| (norm(sub(x[s.b], x[s.a])) / s.rest - 1.0) * 100.0)
        .fold(0.0, f64::max);
    m.tip_drop_mm = -x.iter().map(|q| q[2]).fold(f64::INFINITY, f64::min) * 1000.0;
    match *support {
        Support::Table { side, edge_mm } => {
            let far = pts.iter().map(|&p| along(p, side)).fold(f64::NEG_INFINITY, f64::max);
            let tips: Vec<usize> = (0..n).filter(|&i| along(pts[i], side) > far - 0.6 * h_m * 1000.0).collect();
            let (mut dz, mut dh) = (0.0, 0.0);
            for &i in &tips {
                dz += -x[i][2] * 1000.0;
                dh += along(v(x[i][0] * 1000.0, x[i][1] * 1000.0), side) - edge_mm;
            }
            let k = tips.len().max(1) as f64;
            m.tip_drop_mm = dz / k;
            m.droop_deg = Some((dz / k).atan2((dh / k).max(1e-6)).to_degrees());
        }
        Support::Disc { radius_mm, .. } => {
            let shadow = shadow_area_mm2(&x, tris);
            let disc = std::f64::consts::PI * radius_mm * radius_mm;
            if area_mm2 > disc * 1.05 {
                m.drape_coefficient = Some(((shadow - disc) / (area_mm2 - disc)).clamp(0.0, 1.2));
            }
        }
        Support::Pins { .. } => {}
    }
    Ok(VariantResult { label: var.label.clone(), frames, metrics: m })
}

fn pack(x: &[P3]) -> Vec<f32> {
    let mut out = Vec::with_capacity(x.len() * 3);
    for p in x {
        for c in p {
            out.push(((c * 1000.0 * 100.0).round() / 100.0) as f32);
        }
    }
    out
}

/// Area of the piece's shadow on the ground, by rasterising projected triangles on a 1 mm grid.
fn shadow_area_mm2(x: &[P3], tris: &[[usize; 3]]) -> f64 {
    let pts: Vec<Vec2> = x.iter().map(|p| v(p[0] * 1000.0, p[1] * 1000.0)).collect();
    let (mut lo, mut hi) = (v(f64::INFINITY, f64::INFINITY), v(f64::NEG_INFINITY, f64::NEG_INFINITY));
    for p in &pts {
        lo = v(lo.x.min(p.x), lo.y.min(p.y));
        hi = v(hi.x.max(p.x), hi.y.max(p.y));
    }
    let cell = 1.0;
    let w = ((hi.x - lo.x) / cell).ceil() as usize + 1;
    let h = ((hi.y - lo.y) / cell).ceil() as usize + 1;
    let mut grid = vec![false; w * h];
    let edge = |p: Vec2, q: Vec2, r: Vec2| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    for t in tris {
        let (a, b, c) = (pts[t[0]], pts[t[1]], pts[t[2]]);
        let area = edge(a, b, c);
        if area.abs() < 1e-12 {
            continue;
        }
        let x0 = ((a.x.min(b.x).min(c.x) - lo.x) / cell).floor().max(0.0) as usize;
        let x1 = (((a.x.max(b.x).max(c.x) - lo.x) / cell).ceil() as usize).min(w - 1);
        let y0 = ((a.y.min(b.y).min(c.y) - lo.y) / cell).floor().max(0.0) as usize;
        let y1 = (((a.y.max(b.y).max(c.y) - lo.y) / cell).ceil() as usize).min(h - 1);
        for gy in y0..=y1 {
            for gx in x0..=x1 {
                let q = v(lo.x + (gx as f64 + 0.5) * cell, lo.y + (gy as f64 + 0.5) * cell);
                let (w0, w1, w2) = (edge(b, c, q), edge(c, a, q), edge(a, b, q));
                let inside = if area > 0.0 { w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0 } else { w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0 };
                if inside {
                    grid[gy * w + gx] = true;
                }
            }
        }
    }
    grid.iter().filter(|&&g| g).count() as f64 * cell * cell
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::presets;

    fn strip(len: f64, width: f64) -> Vec<Vec2> {
        vec![v(0.0, 0.0), v(len, 0.0), v(len, width), v(0.0, width)]
    }

    fn preset(id: &str) -> Physics {
        presets().into_iter().find(|p| p.id == id).unwrap().physics
    }

    #[test]
    fn cantilever_at_twice_bending_length_droops_about_41_degrees() {
        let ph = preset("vegtan-soft");
        let t = 1.6;
        let c = bending_length_mm(&ph, t);
        let req = DrapeRequest {
            outline: strip(2.0 * c + 60.0, 25.0),
            grain_deg: 0.0,
            scene: Scene::Cantilever { side: Side::Right, overhang_mm: 2.0 * c },
            variants: vec![Variant { label: "x".into(), thickness_mm: t, physics: ph }],
            resolution: Some(500),
            seconds: Some(6.0),
        };
        let r = simulate(&req).unwrap();
        let m = &r.variants[0].metrics;
        let deg = m.droop_deg.unwrap();
        eprintln!("bending length {c:.1} mm, droop {deg:.1} deg, settled {} after {:.1}s, stretch {:.3}%", m.settled, m.seconds_simulated, m.max_stretch_pct);
        assert!((deg - 41.5).abs() < 5.0, "droop {deg}");
        assert!(m.max_stretch_pct < 3.0);
    }

    #[test]
    fn thicker_and_firmer_droop_less() {
        let run = |id: &str, t: f64| {
            let req = DrapeRequest {
                outline: strip(220.0, 30.0),
                grain_deg: 0.0,
                scene: Scene::Cantilever { side: Side::Right, overhang_mm: 150.0 },
                variants: vec![Variant { label: id.into(), thickness_mm: t, physics: preset(id) }],
                resolution: Some(300),
                seconds: Some(4.0),
            };
            simulate(&req).unwrap().variants[0].metrics.droop_deg.unwrap()
        };
        let goat3 = run("goat-veg", 3.0 * crate::model::OZ_MM);
        let goat7 = run("goat-veg", 7.0 * crate::model::OZ_MM);
        let deer3 = run("deer", 3.0 * crate::model::OZ_MM);
        eprintln!("goat 3oz {goat3:.1}, goat 7oz {goat7:.1}, deer 3oz {deer3:.1}");
        assert!(goat7 + 5.0 < goat3 && goat3 + 5.0 < deer3);
    }

    #[test]
    fn pedestal_drape_coefficient_orders_materials() {
        let circle: Vec<Vec2> = (0..64)
            .map(|i| {
                let a = i as f64 / 64.0 * std::f64::consts::TAU;
                v(150.0 * a.cos(), 150.0 * a.sin())
            })
            .collect();
        let req = DrapeRequest {
            outline: circle,
            grain_deg: 0.0,
            scene: Scene::Pedestal { radius_mm: 90.0 },
            variants: vec![
                Variant { label: "deer".into(), thickness_mm: 1.2, physics: preset("deer") },
                Variant { label: "vegtan".into(), thickness_mm: 2.0, physics: preset("vegtan-firm") },
            ],
            resolution: Some(600),
            seconds: Some(4.0),
        };
        let r = simulate(&req).unwrap();
        let dc: Vec<f64> = r.variants.iter().map(|v| v.metrics.drape_coefficient.unwrap()).collect();
        eprintln!("drape coefficients {dc:?}");
        assert!(dc[0] + 0.1 < dc[1]);
    }
}
