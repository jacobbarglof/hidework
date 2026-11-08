//! The GPU solver: buffers built from a `SolverData` snapshot, every substep of a frame recorded
//! into one command encoder, positions read back once per frame.

use crate::colour::colour;
use crate::GpuContext;
use bytemuck::{Pod, Zeroable};
use hidework_core::sim::{Sim, SolverData};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;

/// Candidate slots per vertex for point-triangle contact.
const K_SLOTS: u32 = 128;
/// Fixed-point scale for summed contact corrections (about 4 nanometres a step).
const FX: f32 = (1u32 << 28) as f32;
/// The CPU's limit on how far a deep overlap is undone in one substep, m.
const MAX_PUSH: f32 = 0.0015;
/// Conjugate gradient iterations per substep for the implicit bending solve, at most, and the
/// residual (squared, preconditioned norm, relative to one substep of gravity) that ends it.
const CG_ITERS: u32 = 64;
const CG_TOL2: f32 = 1e-6;
/// Minimum contact search margin, m (as the CPU).
const MIN_MARGIN: f32 = 0.002;
const WG: u32 = 64;
const RANGE_STRIDE: u64 = 256;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Params {
    n: u32,
    n_tris: u32,
    table: u32,
    kslots: u32,
    dt: f32,
    damp: f32,
    vcap: f32,
    inv_dt2: f32,
    sew_s: f32,
    far2: f32,
    h: f32,
    tmax: f32,
    max_push: f32,
    fx: f32,
    min_margin: f32,
    look: f32,
    cg_iters: u32,
    cg_tol2: f32,
    n_props: u32,
    pad0: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct VProp {
    inv: f32,
    mass: f32,
    half_t: f32,
    mu: f32,
    piece: u32,
    held: u32,
    rx: f32,
    ry: f32,
    diag: f32,
    pad: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SpringRec {
    a: u32,
    b: u32,
    rest: f32,
    k: f32,
}

struct Pipes {
    stale: wgpu::ComputePipeline,
    begin: wgpu::ComputePipeline,
    hash_count: wgpu::ComputePipeline,
    hash_scan: wgpu::ComputePipeline,
    hash_scatter: wgpu::ComputePipeline,
    find: wgpu::ComputePipeline,
    search_done: wgpu::ComputePipeline,
    predict: wgpu::ComputePipeline,
    bend_cg: wgpu::ComputePipeline,
    welds: wgpu::ComputePipeline,
    cbends: wgpu::ComputePipeline,
    springs: wgpu::ComputePipeline,
    contacts: wgpu::ComputePipeline,
    contact_apply: wgpu::ComputePipeline,
    floor_props: wgpu::ComputePipeline,
    velocity: wgpu::ComputePipeline,
}

/// The XPBD substep loop on the GPU. Build it from `Sim::solver_data`, call `step` (or
/// `step_sim`) once per frame, and build a new one whenever pins, weights or props change.
pub struct GpuSolver {
    device: wgpu::Device,
    queue: wgpu::Queue,
    error: Arc<Mutex<Option<String>>>,
    pipes: Pipes,
    bg0: wgpu::BindGroup,
    bg1: wgpu::BindGroup,
    x_buf: wgpu::Buffer,
    prev_buf: wgpu::Buffer,
    vel_buf: wgpu::Buffer,
    slam_buf: wgpu::Buffer,
    wlam_buf: wgpu::Buffer,
    st_buf: wgpu::Buffer,
    staging: wgpu::Buffer,
    n: usize,
    n_tris: u32,
    n_pieces: u32,
    has_stencils: bool,
    table: u32,
    subs: u32,
    /// Range slots (index into the dynamic uniform buffer) for each colour.
    spring_cols: Vec<(u32, u32)>,
    weld_cols: Vec<(u32, u32)>,
    cbend_cols: Vec<(u32, u32)>,
    /// GPU order to snapshot order.
    spring_order: Vec<u32>,
    weld_order: Vec<u32>,
    spring_ab: Vec<[u32; 2]>,
    spring_rest: Vec<f64>,
    x: Vec<[f64; 3]>,
    v: Vec<[f64; 3]>,
    good_x: Vec<[f64; 3]>,
    spring_lambda: Vec<f64>,
    weld_lambda: Vec<f64>,
    vmax: f64,
    recovered: bool,
    overflow: u32,
    searches: u32,
    cg_most: u32,
    cand_most: u32,
    cpu_only: Vec<String>,
}

fn groups(n: u32) -> u32 {
    n.div_ceil(WG).max(1)
}

fn vec4s(v: &[f32], stride: usize) -> Vec<[f32; 4]> {
    v.chunks(stride).map(|c| [c[0], c.get(1).copied().unwrap_or(0.0), c.get(2).copied().unwrap_or(0.0), 0.0]).collect()
}

impl GpuSolver {
    pub fn new(ctx: &GpuContext, d: &SolverData) -> Result<GpuSolver, String> {
        let n = d.vertices();
        if n == 0 {
            return Err("nothing to simulate".into());
        }
        let device = ctx.device.clone();
        let queue = ctx.queue.clone();
        let _ = ctx.take_error();
        let subs = d.substeps.max(1);
        let dt = d.frame_dt / subs as f32;
        let inv_dt2 = 1.0 / (dt * dt);

        // Bending stencils grouped by piece (the implicit solve runs one piece per workgroup).
        let nb = d.bend_k.len();
        let mut border: Vec<usize> = (0..nb).collect();
        border.sort_by_key(|&k| d.piece_of[d.bend_v[4 * k] as usize]);
        let bv: Vec<[u32; 4]> = border.iter().map(|&k| [d.bend_v[4 * k], d.bend_v[4 * k + 1], d.bend_v[4 * k + 2], d.bend_v[4 * k + 3]]).collect();
        let bw: Vec<[f32; 4]> = border.iter().map(|&k| [d.bend_w[4 * k], d.bend_w[4 * k + 1], d.bend_w[4 * k + 2], d.bend_w[4 * k + 3]]).collect();
        let bk: Vec<f32> = border.iter().map(|&k| d.bend_k[k]).collect();
        let bimp: Vec<u32> = border.iter().map(|&k| d.bend_implicit[k]).collect();

        // Per-vertex incidence of stencils (for Q applied at a vertex), and the CG diagonal.
        let mut inc_count = vec![0u32; n];
        for s in &bv {
            for &v in s {
                inc_count[v as usize] += 1;
            }
        }
        let mut inc = Vec::with_capacity(n + 1 + 4 * nb);
        let mut acc = 0u32;
        inc.push(0);
        for &c in &inc_count {
            acc += c;
            inc.push(acc);
        }
        let mut fill: Vec<u32> = inc[..n].to_vec();
        let mut entries = vec![0u32; 4 * nb];
        let mut diag: Vec<f32> = d.mass.iter().map(|&m| m * inv_dt2).collect();
        for (k, s) in bv.iter().enumerate() {
            for r in 0..4 {
                let v = s[r] as usize;
                entries[fill[v] as usize] = (k as u32) << 2 | r as u32;
                fill[v] += 1;
                diag[v] += bk[k] * bw[k][r] * bw[k][r];
            }
        }
        inc.extend(entries);

        // Pieces: vertex range and stencil range.
        let npieces = d.piece_vertices.len() / 2;
        // Two vec4 per piece: ranges, then the CG reference residual (one substep of gravity).
        let mut pieces = vec![[0u32; 4]; 2 * npieces.max(1)];
        let mut k = 0;
        for p in 0..npieces {
            let (v0, vn) = (d.piece_vertices[2 * p], d.piece_vertices[2 * p + 1]);
            pieces[2 * p][0] = v0;
            pieces[2 * p][1] = vn;
            pieces[2 * p][2] = k as u32;
            while k < nb && d.piece_of[bv[k][0] as usize] as usize == p {
                k += 1;
            }
            pieces[2 * p][3] = k as u32 - pieces[2 * p][2];
            let g = 9.81f64;
            let r: f64 = (v0..v0 + vn).map(|i| i as usize).filter(|&i| d.bend_held[i] == 0).map(|i| (d.mass[i] as f64 * g).powi(2) / diag[i] as f64).sum();
            pieces[2 * p + 1][0] = (r as f32).to_bits();
        }

        let vprops: Vec<VProp> = (0..n)
            .map(|i| VProp {
                inv: d.inv_mass[i],
                mass: d.mass[i],
                half_t: d.half_t[i],
                mu: d.friction[i],
                piece: d.piece_of[i],
                held: d.bend_held[i],
                rx: d.rest2d[2 * i],
                ry: d.rest2d[2 * i + 1],
                diag: diag[i],
                pad: [0.0; 3],
            })
            .collect();
        let moves = |v: u32| d.inv_mass[v as usize] > 0.0;

        // Springs, by colour.
        let ns = d.spring_rest.len();
        let (spring_order, s_ranges) = colour(ns, n, |k, out| {
            for v in [d.spring_ab[2 * k], d.spring_ab[2 * k + 1]] {
                if moves(v) {
                    out.push(v);
                }
            }
        });
        let springs: Vec<SpringRec> = spring_order
            .iter()
            .map(|&k| {
                let k = k as usize;
                SpringRec { a: d.spring_ab[2 * k], b: d.spring_ab[2 * k + 1], rest: d.spring_rest[k], k: d.spring_k[k] }
            })
            .collect();

        // Welds, by colour.
        let nw = d.weld_rest.len();
        let (weld_order, w_ranges) = colour(nw, n, |k, out| {
            for q in 0..6 {
                let (v, c) = (d.weld_v[6 * k + q], d.weld_c[6 * k + q]);
                if c != 0.0 && moves(v) && !out.contains(&v) {
                    out.push(v);
                }
            }
        });
        let mut welds: Vec<u32> = Vec::with_capacity(12 * nw);
        let mut wpar: Vec<[f32; 4]> = Vec::with_capacity(nw);
        for &k in &weld_order {
            let k = k as usize;
            welds.extend(&d.weld_v[6 * k..6 * k + 6]);
            welds.extend(d.weld_c[6 * k..6 * k + 6].iter().map(|c| c.to_bits()));
            wpar.push([d.weld_rest[k], d.weld_start[k], d.weld_k[k], 0.0]);
        }

        // Stencils solved as constraints as well (those touching a seam point), by colour.
        let cb: Vec<u32> = (0..nb as u32).filter(|&k| bimp[k as usize] == 0).collect();
        let (cb_order, cb_ranges) = colour(cb.len(), n, |j, out| {
            let k = cb[j] as usize;
            for r in 0..4 {
                let v = bv[k][r];
                if bw[k][r] != 0.0 && moves(v) && !out.contains(&v) {
                    out.push(v);
                }
            }
        });
        let cbend: Vec<u32> = cb_order.iter().map(|&j| cb[j as usize]).collect();

        // Contact data.
        let tris: Vec<[u32; 4]> = d.tris.chunks(3).map(|t| [t[0], t[1], t[2], 0]).collect();
        let mut part = d.partner_start.clone();
        part.extend(&d.partner_piece);
        let table = (2 * n).max(1024).next_power_of_two() as u32;
        let tmax = 2.0 * d.half_t.iter().cloned().fold(0.0f32, f32::max);
        let props: Vec<[f32; 4]> = d.props.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();

        let params = Params {
            n: n as u32,
            n_tris: tris.len() as u32,
            table,
            kslots: K_SLOTS,
            dt,
            damp: (-d.damping * dt).exp(),
            vcap: d.vmax,
            inv_dt2,
            sew_s: d.sew_s,
            far2: d.contact_far_mm * d.contact_far_mm,
            h: d.h,
            tmax,
            max_push: MAX_PUSH,
            fx: FX,
            min_margin: MIN_MARGIN,
            look: 2.0 * 4.0 * dt,
            cg_iters: CG_ITERS,
            cg_tol2: CG_TOL2,
            n_props: (d.props.len() / 8) as u32,
            pad0: 0,
        };

        // Dynamic ranges: slot 0 is unused, then one per colour.
        let mut ranges: Vec<[u32; 64]> = vec![[0; 64]];
        let mut slots = |rs: &[(u32, u32)]| -> Vec<(u32, u32)> {
            rs.iter()
                .map(|&(s, c)| {
                    let mut r = [0u32; 64];
                    r[0] = s;
                    r[1] = c;
                    ranges.push(r);
                    ((ranges.len() - 1) as u32, c)
                })
                .collect()
        };
        let spring_cols = slots(&s_ranges);
        let weld_cols = slots(&w_ranges);
        let cbend_cols = slots(&cb_ranges);

        let usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC;
        let make = |label: &str, bytes: &[u8]| -> wgpu::Buffer {
            let mut data = bytes.to_vec();
            if data.len() < 16 {
                data.resize(16, 0);
            }
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: &data, usage })
        };
        let zeros = |label: &str, bytes: usize| -> wgpu::Buffer { make(label, &vec![0u8; bytes]) };
        let x4 = vec4s(&d.x, 3);
        let v4 = vec4s(&d.v, 3);
        let mut st = [0u32; 16];
        st[1] = 1;
        st[2] = d.time.to_bits();

        let p_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("params"), contents: bytemuck::bytes_of(&params), usage: wgpu::BufferUsages::UNIFORM });
        let x_buf = make("x", bytemuck::cast_slice(&x4));
        let prev_buf = make("prev", bytemuck::cast_slice(&x4));
        let vel_buf = make("vel", bytemuck::cast_slice(&v4));
        let acc_buf = make("acc", bytemuck::cast_slice(&vec4s(&d.acc, 3)));
        let vp_buf = make("vprops", bytemuck::cast_slice(&vprops));
        let spr_buf = make("springs", bytemuck::cast_slice(&springs));
        let slam_buf = zeros("spring lambda", 4 * ns);
        let weld_buf = make("welds", bytemuck::cast_slice(&welds));
        let wpar_buf = make("weld params", bytemuck::cast_slice(&wpar));
        let wlam_buf = zeros("weld lambda", 4 * nw);
        let bv_buf = make("bend vertices", bytemuck::cast_slice(&bv));
        let bw_buf = make("bend weights", bytemuck::cast_slice(&bw));
        let bk_buf = make("bend stiffness", bytemuck::cast_slice(&bk));
        let cb_buf = make("constraint bends", bytemuck::cast_slice(&cbend));
        let inc_buf = make("incidence", bytemuck::cast_slice(&inc));
        let cg_buf = zeros("cg", 16 * 4 * n);
        let bc_buf = zeros("stencil curvature", 16 * nb);
        let piece_buf = make("pieces", bytemuck::cast_slice(&pieces));
        let tri_buf = make("tris", bytemuck::cast_slice(&tris));
        let part_buf = make("partners", bytemuck::cast_slice(&part));
        let hash_buf = zeros("hash", 4 * (2 * table as usize + 1 + n));
        let cand_buf = zeros("candidates", 4 * 2 * n * K_SLOTS as usize);
        let ccount_buf = zeros("candidate counts", 4 * 2 * n);
        let sx_buf = make("search x", bytemuck::cast_slice(&x4));
        let delta_buf = zeros("contact delta", 16 * n);
        let st_buf = make("state", bytemuck::cast_slice(&st));
        let props_buf = make("props", bytemuck::cast_slice(&props));
        let range_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("ranges"), contents: bytemuck::cast_slice(&ranges), usage: wgpu::BufferUsages::UNIFORM });
        let storage: [&wgpu::Buffer; crate::STORAGE_BUFFERS as usize] = [
            &x_buf, &prev_buf, &vel_buf, &acc_buf, &vp_buf, &spr_buf, &slam_buf, &weld_buf, &wpar_buf, &wlam_buf, &bv_buf, &bw_buf, &bk_buf, &cb_buf, &inc_buf, &cg_buf, &bc_buf, &piece_buf, &tri_buf, &part_buf, &hash_buf, &cand_buf, &ccount_buf, &sx_buf, &delta_buf, &st_buf, &props_buf,
        ];

        let mut entries0 = vec![wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        }];
        for b in 0..storage.len() {
            entries0.push(wgpu::BindGroupLayoutEntry {
                binding: b as u32 + 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            });
        }
        let bgl0 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("solver"), entries: &entries0 });
        let bgl1 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("range"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(16) },
                count: None,
            }],
        });
        let mut bind0 = vec![wgpu::BindGroupEntry { binding: 0, resource: p_buf.as_entire_binding() }];
        for (b, buf) in storage.iter().enumerate() {
            bind0.push(wgpu::BindGroupEntry { binding: b as u32 + 1, resource: buf.as_entire_binding() });
        }
        let bg0 = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("solver"), layout: &bgl0, entries: &bind0 });
        let bg1 = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("range"),
            layout: &bgl1,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &range_buf, offset: 0, size: wgpu::BufferSize::new(16) }) }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("solver"), bind_group_layouts: &[Some(&bgl0), Some(&bgl1)], immediate_size: 0 });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("xpbd"), source: wgpu::ShaderSource::Wgsl(include_str!("shaders/xpbd.wgsl").into()) });
        let pipe = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&layout),
                module: &module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let pipes = Pipes {
            stale: pipe("stale"),
            begin: pipe("begin"),
            hash_count: pipe("hash_count"),
            hash_scan: pipe("hash_scan"),
            hash_scatter: pipe("hash_scatter"),
            find: pipe("find"),
            search_done: pipe("search_done"),
            predict: pipe("predict"),
            bend_cg: pipe("bend_cg"),
            welds: pipe("welds"),
            cbends: pipe("cbends"),
            springs: pipe("springs"),
            contacts: pipe("contacts"),
            contact_apply: pipe("contact_apply"),
            floor_props: pipe("floor_props"),
            velocity: pipe("velocity"),
        };
        let read_bytes = 32 * n + 4 * ns + 4 * nw + 64;
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: read_bytes as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        if let Some(e) = ctx.take_error() {
            return Err(format!("GPU solver setup failed: {e}"));
        }
        let x: Vec<[f64; 3]> = d.x.chunks(3).map(|c| [c[0] as f64, c[1] as f64, c[2] as f64]).collect();
        let v: Vec<[f64; 3]> = d.v.chunks(3).map(|c| [c[0] as f64, c[1] as f64, c[2] as f64]).collect();
        Ok(GpuSolver {
            error: ctx.error.clone(),
            device,
            queue,
            pipes,
            bg0,
            bg1,
            x_buf,
            prev_buf,
            vel_buf,
            slam_buf,
            wlam_buf,
            st_buf,
            staging,
            n,
            n_tris: tris.len() as u32,
            n_pieces: npieces as u32,
            has_stencils: nb > 0,
            table,
            subs,
            spring_cols,
            weld_cols,
            cbend_cols,
            spring_order,
            weld_order,
            spring_ab: (0..ns).map(|k| [d.spring_ab[2 * k], d.spring_ab[2 * k + 1]]).collect(),
            spring_rest: d.spring_rest.iter().map(|&r| r as f64).collect(),
            good_x: x.clone(),
            x,
            v,
            spring_lambda: vec![0.0; ns],
            weld_lambda: vec![0.0; nw],
            vmax: 0.0,
            recovered: false,
            overflow: 0,
            searches: 0,
            cg_most: 0,
            cand_most: 0,
            cpu_only: d.cpu_only.clone(),
        })
    }

    fn record_substep(&self, pass: &mut wgpu::ComputePass<'_>) {
        let n = self.n as u32;
        let p = &self.pipes;
        let mut run = |pipe: &wgpu::ComputePipeline, slot: u32, wgs: u32| {
            pass.set_pipeline(pipe);
            pass.set_bind_group(1, &self.bg1, &[(slot as u64 * RANGE_STRIDE) as u32]);
            pass.dispatch_workgroups(wgs, 1, 1);
        };
        // 1. Contact search, only when something has moved half the margin.
        run(&p.stale, 0, groups(n));
        run(&p.begin, 0, groups(n.max(self.table)));
        run(&p.hash_count, 0, groups(n));
        run(&p.hash_scan, 0, 1);
        run(&p.hash_scatter, 0, groups(n));
        if self.n_tris > 0 {
            run(&p.find, 0, groups(self.n_tris));
        }
        run(&p.search_done, 0, 1);
        // 2. Predict.
        run(&p.predict, 0, groups(n));
        // 3. Implicit bending, one piece per workgroup.
        if self.has_stencils {
            run(&p.bend_cg, 0, self.n_pieces.max(1));
        }
        // 4. Seams, braces, glue, laminates, fasteners.
        for &(slot, c) in &self.weld_cols {
            run(&p.welds, slot, groups(c));
        }
        // 5. Bending at seam points, then stretch.
        for &(slot, c) in &self.cbend_cols {
            run(&p.cbends, slot, groups(c));
        }
        for &(slot, c) in &self.spring_cols {
            run(&p.springs, slot, groups(c));
        }
        // 6. Leather against leather, stretch again, floor and props.
        run(&p.contacts, 0, groups(n));
        run(&p.contact_apply, 0, groups(n));
        for &(slot, c) in &self.spring_cols {
            run(&p.springs, slot, groups(c));
        }
        run(&p.floor_props, 0, groups(n));
        // 7. Velocities, capped.
        run(&p.velocity, 0, groups(n));
    }

    /// One frame (all substeps) on the GPU; then positions, velocities, multipliers and the
    /// top speed are read back. A frame that produced non-finite numbers is undone, and one
    /// with runaway stretch has its velocities halved, as the CPU's guard does.
    pub fn step(&mut self) -> Result<(), String> {
        let n = self.n;
        let (ns, nw) = (self.spring_lambda.len(), self.weld_lambda.len());
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        enc.clear_buffer(&self.slam_buf, 0, None);
        enc.clear_buffer(&self.wlam_buf, 0, None);
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("substeps"), timestamp_writes: None });
            pass.set_bind_group(0, &self.bg0, &[]);
            for _ in 0..self.subs {
                self.record_substep(&mut pass);
            }
        }
        let xb = 16 * n as u64;
        enc.copy_buffer_to_buffer(&self.x_buf, 0, &self.staging, 0, xb);
        enc.copy_buffer_to_buffer(&self.vel_buf, 0, &self.staging, xb, xb);
        let mut off = 2 * xb;
        if ns > 0 {
            enc.copy_buffer_to_buffer(&self.slam_buf, 0, &self.staging, off, 4 * ns as u64);
        }
        off += 4 * ns as u64;
        if nw > 0 {
            enc.copy_buffer_to_buffer(&self.wlam_buf, 0, &self.staging, off, 4 * nw as u64);
        }
        off += 4 * nw as u64;
        enc.copy_buffer_to_buffer(&self.st_buf, 0, &self.staging, off, 64);
        self.queue.submit([enc.finish()]);
        let ok = Arc::new(AtomicBool::new(false));
        let flag = ok.clone();
        self.staging.slice(..).map_async(wgpu::MapMode::Read, move |r| flag.store(r.is_ok(), Ordering::SeqCst));
        self.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("GPU wait failed: {e}"))?;
        if let Some(e) = self.error.lock().ok().and_then(|mut e| e.take()) {
            return Err(format!("GPU error: {e}"));
        }
        if !ok.load(Ordering::SeqCst) {
            return Err("GPU readback failed".into());
        }
        {
            let data = self.staging.slice(..).get_mapped_range().map_err(|e| format!("GPU readback failed: {e:?}"))?;
            let f: &[f32] = bytemuck::cast_slice(&data[..]);
            for i in 0..n {
                self.x[i] = [f[4 * i] as f64, f[4 * i + 1] as f64, f[4 * i + 2] as f64];
                let j = 4 * n + 4 * i;
                self.v[i] = [f[j] as f64, f[j + 1] as f64, f[j + 2] as f64];
            }
            let sl = 8 * n;
            for (j, &k) in self.spring_order.iter().enumerate() {
                self.spring_lambda[k as usize] = f[sl + j] as f64;
            }
            let wl = sl + ns;
            for (j, &k) in self.weld_order.iter().enumerate() {
                self.weld_lambda[k as usize] = f[wl + j] as f64;
            }
            let st: &[u32] = bytemuck::cast_slice(&data[(off as usize)..(off as usize + 64)]);
            self.vmax = f32::from_bits(st[0]) as f64;
            self.overflow = st[6];
            self.searches = st[7];
            self.cg_most = st[8];
            self.cand_most = st[9];
        }
        self.staging.unmap();
        // The guard.
        self.recovered = false;
        let finite = self.x.iter().chain(self.v.iter()).all(|p| p.iter().all(|c| c.is_finite()));
        if !finite {
            self.x = self.good_x.clone();
            self.v = vec![[0.0; 3]; n];
            self.upload();
            self.recovered = true;
        } else {
            let stretch = self
                .spring_ab
                .iter()
                .zip(&self.spring_rest)
                .map(|(&[a, b], &r)| {
                    let (p, q) = (self.x[a as usize], self.x[b as usize]);
                    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt() / r
                })
                .fold(0.0, f64::max);
            if stretch > 1.5 {
                for v in self.v.iter_mut() {
                    *v = [v[0] * 0.5, v[1] * 0.5, v[2] * 0.5];
                }
                let v4: Vec<[f32; 4]> = self.v.iter().map(|v| [v[0] as f32, v[1] as f32, v[2] as f32, 0.0]).collect();
                self.queue.write_buffer(&self.vel_buf, 0, bytemuck::cast_slice(&v4));
                self.recovered = true;
            }
            self.good_x.clone_from(&self.x);
        }
        Ok(())
    }

    /// Replace positions and velocities on the GPU (after the CPU moved something) and search
    /// for contacts afresh.
    pub fn set_state(&mut self, x: &[[f64; 3]], v: &[[f64; 3]]) {
        let n = self.n.min(x.len()).min(v.len());
        self.x[..n].copy_from_slice(&x[..n]);
        self.v[..n].copy_from_slice(&v[..n]);
        self.good_x.clone_from(&self.x);
        self.upload();
    }

    fn upload(&self) {
        let x4: Vec<[f32; 4]> = self.x.iter().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32, 0.0]).collect();
        let v4: Vec<[f32; 4]> = self.v.iter().map(|v| [v[0] as f32, v[1] as f32, v[2] as f32, 0.0]).collect();
        self.queue.write_buffer(&self.x_buf, 0, bytemuck::cast_slice(&x4));
        self.queue.write_buffer(&self.prev_buf, 0, bytemuck::cast_slice(&x4));
        self.queue.write_buffer(&self.vel_buf, 0, bytemuck::cast_slice(&v4));
        self.queue.write_buffer(&self.st_buf, 4, bytemuck::bytes_of(&1u32));
    }

    /// Run `frames` frames on the GPU, writing each back into the Sim (positions, velocities,
    /// clock, force readouts, "settled").
    pub fn step_sim(&mut self, sim: &mut Sim, frames: usize) -> Result<(), String> {
        for _ in 0..frames {
            self.step()?;
            sim.set_positions(&self.x, &self.v);
            sim.finish_gpu_frame(&self.spring_lambda, &self.weld_lambda, self.vmax, self.recovered);
        }
        Ok(())
    }

    /// Positions after the last frame, m.
    pub fn positions(&self) -> &[[f64; 3]] {
        &self.x
    }

    /// Velocities after the last frame, m/s.
    pub fn velocities(&self) -> &[[f64; 3]] {
        &self.v
    }

    /// Spring and weld multipliers summed over the last frame's substeps, in snapshot order.
    pub fn spring_lambda(&self) -> &[f64] {
        &self.spring_lambda
    }
    pub fn weld_lambda(&self) -> &[f64] {
        &self.weld_lambda
    }

    /// Top speed in the last substep, m/s.
    pub fn vmax(&self) -> f64 {
        self.vmax
    }

    /// Whether the guard had to undo or calm the last frame.
    pub fn recovered(&self) -> bool {
        self.recovered
    }

    /// Contact searches run so far, and candidate pairs dropped because a point had more than
    /// the slots allow (should stay 0).
    pub fn contact_stats(&self) -> (u32, u32) {
        (self.searches, self.overflow)
    }

    /// Most CG iterations any piece took in one substep, and most contact candidates any point
    /// had at one search, so far.
    pub fn solver_stats(&self) -> (u32, u32) {
        (self.cg_most, self.cand_most)
    }

    /// Colours (dispatches per pass) for welds, seam-point bends and springs.
    pub fn colours(&self) -> (usize, usize, usize) {
        (self.weld_cols.len(), self.cbend_cols.len(), self.spring_cols.len())
    }

    /// Parts of the scene the snapshot left to the CPU (for example "hand", "objects").
    pub fn cpu_only(&self) -> &[String] {
        &self.cpu_only
    }
}
