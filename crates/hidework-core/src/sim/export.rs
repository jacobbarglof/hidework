//! A flat snapshot of the solver state for an outside backend (the GPU solver in
//! `crates/hidework-gpu`), and the way back in.
//!
//! `Sim::solver_data` copies everything one frame of the XPBD substep loop needs into plain
//! arrays (f32 and u32, metres and seconds). The backend runs the frame and hands positions and
//! velocities back with `Sim::set_positions`; `Sim::finish_gpu_frame` then does the per-frame
//! bookkeeping the CPU `step` does after its substeps (time, force readouts, "settled").
//!
//! Take a new snapshot whenever pins, the hand, objects, weights or props change: the snapshot
//! is a copy, not a view.

use super::*;

/// The solver state as flat arrays. Per-vertex arrays have one entry per vertex (three for
/// vectors: x y z); per-constraint arrays one entry per constraint (or a fixed stride).
#[derive(Clone, Debug, Default)]
pub struct SolverData {
    /// Seconds per frame (1/90) and substeps per frame.
    pub frame_dt: f32,
    pub substeps: u32,
    /// Velocity damping rate (1/s): each substep multiplies velocity by exp(-damping dt).
    pub damping: f32,
    /// Speed limit, m/s.
    pub vmax: f32,
    /// Seams draw closed over this many seconds from the start (the sewing ramp).
    pub sew_s: f32,
    /// Simulated time so far, s (for the sewing ramp).
    pub time: f32,
    /// Mean mesh edge length, m.
    pub h: f32,
    /// Points of one piece closer than this in the pattern (mm) never collide with each other.
    pub contact_far_mm: f32,

    /// Positions and velocities, m and m/s, x y z per vertex.
    pub x: Vec<f32>,
    pub v: Vec<f32>,
    /// Acceleration from gravity and hung weights, m/s^2, x y z per vertex.
    pub acc: Vec<f32>,
    pub mass: Vec<f32>,
    /// Inverse mass; zero for points held by a pin or the hand.
    pub inv_mass: Vec<f32>,
    pub half_t: Vec<f32>,
    pub friction: Vec<f32>,
    pub piece_of: Vec<u32>,
    /// Pattern position (mm), x y per vertex.
    pub rest2d: Vec<f32>,
    /// 1 where the implicit bending solve keeps the point fixed (pins and seam points).
    pub bend_held: Vec<u32>,

    /// Triangles, three vertex indices each.
    pub tris: Vec<u32>,
    /// Each piece's first vertex and vertex count.
    pub piece_vertices: Vec<u32>,

    /// Edge springs: vertex pairs (a b), rest length (m), stiffness (N/m).
    pub spring_ab: Vec<u32>,
    pub spring_rest: Vec<f32>,
    pub spring_k: Vec<f32>,

    /// Welds (seams, braces, glue, laminates, fasteners): six (vertex, coefficient) pairs each,
    /// so that `sum c x` is the vector from one surface point to the other. Unused slots have
    /// coefficient 0.
    pub weld_v: Vec<u32>,
    pub weld_c: Vec<f32>,
    pub weld_rest: Vec<f32>,
    /// Length when the simulation started (seams close from here over `sew_s`).
    pub weld_start: Vec<f32>,
    pub weld_k: Vec<f32>,

    /// Isometric bending stencils: four vertices, four weights, stiffness. `bend_implicit` is 1
    /// for stencils left to the implicit solve only, 0 for those also solved as constraints.
    pub bend_v: Vec<u32>,
    pub bend_w: Vec<f32>,
    pub bend_k: Vec<f32>,
    pub bend_implicit: Vec<u32>,

    /// Per vertex, the pieces it is sewn, riveted or glued to nearby (contact is not checked
    /// there): `partner_piece[partner_start[i]..partner_start[i + 1]]`.
    pub partner_start: Vec<u32>,
    pub partner_piece: Vec<u32>,

    /// Props, eight numbers each (metres): kind 0 box (min xyz, max xyz), 1 pedestal (centre x
    /// y, radius, top), 2 bar (a xyz, b xyz, radius).
    pub props: Vec<f32>,

    /// Parts of the scene in use that this snapshot does not carry (left to the CPU).
    pub cpu_only: Vec<String>,
}

impl SolverData {
    pub fn vertices(&self) -> usize {
        self.mass.len()
    }
}

fn push3(out: &mut Vec<f32>, p: P3) {
    out.extend([p[0] as f32, p[1] as f32, p[2] as f32]);
}

impl Sim {
    /// A flat copy of the solver state for an outside backend.
    pub fn solver_data(&self) -> SolverData {
        let n = self.x.len();
        let mut d = SolverData {
            frame_dt: DT as f32,
            substeps: self.subs as u32,
            damping: DAMPING as f32,
            vmax: VMAX as f32,
            sew_s: SEW_S as f32,
            time: self.time as f32,
            h: self.h as f32,
            contact_far_mm: (3.0 * self.h * 1000.0) as f32,
            ..Default::default()
        };
        let mut acc = vec![[0.0, 0.0, -G]; n];
        for (_, _, vs) in &self.weights {
            for &(i, f) in vs {
                acc[i][2] -= f / self.mass[i];
            }
        }
        for i in 0..n {
            push3(&mut d.x, self.x[i]);
            push3(&mut d.v, self.vel[i]);
            push3(&mut d.acc, acc[i]);
            d.mass.push(self.mass[i] as f32);
            d.inv_mass.push(self.inv[i] as f32);
            d.half_t.push(self.half_t[i] as f32);
            d.friction.push(self.friction[i] as f32);
            d.piece_of.push(self.piece_of[i]);
            d.rest2d.extend([self.rest2d[i].x as f32, self.rest2d[i].y as f32]);
        }
        let mut held = self.held_set();
        for u in self.seam_points() {
            held[u] = true;
        }
        d.bend_held = held.iter().map(|&h| h as u32).collect();
        for t in &self.tris {
            d.tris.extend([t[0] as u32, t[1] as u32, t[2] as u32]);
        }
        for p in &self.info.pieces {
            d.piece_vertices.extend([p.vertex_start, p.vertex_count]);
        }
        for s in &self.springs {
            d.spring_ab.extend([s.a as u32, s.b as u32]);
            d.spring_rest.push(s.rest as f32);
            d.spring_k.push(s.w as f32);
        }
        for (k, (wd, cs)) in self.welds.iter().zip(self.weld_c.iter()).enumerate() {
            for j in 0..6 {
                let (u, c) = cs.get(j).copied().unwrap_or((0, 0.0));
                d.weld_v.push(u as u32);
                d.weld_c.push(c as f32);
            }
            d.weld_rest.push(wd.rest as f32);
            d.weld_start.push(self.weld_start.get(k).copied().unwrap_or(wd.rest) as f32);
            d.weld_k.push(wd.w as f32);
        }
        let implicit = if self.bend_implicit.len() == self.bends.len() { self.bend_implicit.clone() } else { self.implicit_stencils() };
        for (bi, (idx, w, kb)) in self.bends.iter().enumerate() {
            d.bend_v.extend(idx.iter().map(|&v| v as u32));
            d.bend_w.extend(w.iter().map(|&v| v as f32));
            d.bend_k.push(*kb as f32);
            d.bend_implicit.push(implicit[bi] as u32);
        }
        d.partner_start.push(0);
        for i in 0..n {
            if let Some(ps) = self.partners.get(i) {
                d.partner_piece.extend(ps.iter().copied());
            }
            d.partner_start.push(d.partner_piece.len() as u32);
        }
        for prop in &self.spec.props {
            let rec: [f64; 8] = match *prop {
                Prop::Box { min, max } => {
                    let (lo, hi) = (mm(min), mm(max));
                    [0.0, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], 0.0]
                }
                Prop::Pedestal { center, radius, top } => [1.0, center[0] / 1000.0, center[1] / 1000.0, radius / 1000.0, top / 1000.0, 0.0, 0.0, 0.0],
                Prop::Bar { a, b, radius } => {
                    let (a, b) = (mm(a), mm(b));
                    [2.0, a[0], a[1], a[2], b[0], b[1], b[2], radius / 1000.0]
                }
            };
            d.props.extend(rec.iter().map(|&v| v as f32));
        }
        if self.drag.is_some() {
            d.cpu_only.push("hand".into());
        }
        if !self.objects.is_empty() {
            d.cpu_only.push("objects".into());
        }
        d
    }

    /// Positions (m) and velocities (m/s) from an outside backend. The start-of-substep
    /// positions are set to match, and the next contact search starts afresh.
    pub fn set_positions(&mut self, x: &[[f64; 3]], v: &[[f64; 3]]) {
        let n = self.x.len().min(x.len()).min(v.len());
        self.x[..n].copy_from_slice(&x[..n]);
        self.vel[..n].copy_from_slice(&v[..n]);
        self.prev.clone_from(&self.x);
        self.search_x.clear();
    }

    /// The bookkeeping `step` does after a frame's substeps, for a frame run elsewhere:
    /// advances the clock, turns the frame's constraint multipliers (summed over its substeps,
    /// in snapshot order) into smoothed tensions for the readouts, and updates "settled" from
    /// the frame's top speed (m/s). `recovered` says the backend had to undo or calm the frame
    /// (the divergence guard). Call after `set_positions`.
    pub fn finish_gpu_frame(&mut self, spring_lambda: &[f64], weld_lambda: &[f64], vmax: f64, recovered: bool) {
        self.frame += 1;
        if recovered {
            self.recoveries += 1;
        }
        let dt = DT / self.subs as f64;
        self.time += DT;
        let to_n = -1.0 / (self.subs as f64 * dt * dt);
        let k = if self.frame <= 1 { 1.0 } else { 1.0 - (-DT / FORCE_SMOOTH_S).exp() };
        for (s, &l) in self.springs.iter_mut().zip(spring_lambda) {
            s.f += (l * to_n - s.f) * k;
        }
        for (w, &l) in self.welds.iter_mut().zip(weld_lambda) {
            w.f += (l * to_n - w.f) * k;
        }
        if self.objects.is_empty() && self.weights.is_empty() {
            for wd in self.welds.iter_mut() {
                wd.base = wd.f.max(0.0);
            }
        }
        self.settled = self.time > 0.5 && vmax < 0.003;
    }
}
