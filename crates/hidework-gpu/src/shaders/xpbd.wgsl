// Hidework XPBD substep kernels. One module, one shared bind group layout; each stage of the
// CPU pipeline in crates/hidework-core/src/sim.rs is one or more entry points here.
//
// Units are metres and seconds. Per-vertex vectors are vec4 with w unused.

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

struct Range {
    start: u32,
    count: u32,
    pad0: u32,
    pad1: u32,
}

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
    pad0: f32,
    pad1: f32,
    pad2: f32,
}

struct Spring {
    a: u32,
    b: u32,
    rest: f32,
    k: f32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> X: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> PREV: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> VEL: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> ACC: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> VP: array<VProp>;
@group(0) @binding(6) var<storage, read_write> SPR: array<Spring>;
@group(0) @binding(7) var<storage, read_write> SLAM: array<f32>;
// 12 words per weld: six vertex indices, then six coefficients as f32 bits.
@group(0) @binding(8) var<storage, read_write> WELD: array<u32>;
// rest, start length, stiffness, unused.
@group(0) @binding(9) var<storage, read_write> WPAR: array<vec4f>;
@group(0) @binding(10) var<storage, read_write> WLAM: array<f32>;
@group(0) @binding(11) var<storage, read_write> BV: array<vec4u>;
@group(0) @binding(12) var<storage, read_write> BW: array<vec4f>;
@group(0) @binding(13) var<storage, read_write> BK: array<f32>;
// Stencils solved as constraints too (touching a seam point), ordered by colour.
@group(0) @binding(14) var<storage, read_write> CBEND: array<u32>;
// n + 1 offsets, then entries (stencil * 4 + corner), for every vertex's stencils.
@group(0) @binding(15) var<storage, read_write> INC: array<u32>;
// Conjugate gradient scratch: r, p, d (the correction), Ap; n entries each.
@group(0) @binding(16) var<storage, read_write> CG: array<vec4f>;
// Per stencil: its curvature vector of the current CG vector.
@group(0) @binding(17) var<storage, read_write> BC: array<vec4f>;
// Per piece, two entries: (first vertex, vertex count, first stencil, stencil count) and
// (CG reference residual as f32 bits, 0, 0, 0): one substep of gravity, sum (m g)^2 / diag.
@group(0) @binding(18) var<storage, read_write> PIECE: array<vec4u>;
@group(0) @binding(19) var<storage, read_write> TRI: array<vec4u>;
// n + 1 offsets, then piece ids.
@group(0) @binding(20) var<storage, read_write> PART: array<u32>;
// Spatial hash: `table` counts, `table + 1` starts, then n vertex ids.
@group(0) @binding(21) var<storage, read_write> HASH: array<atomic<u32>>;
// Point-triangle candidates: kslots per vertex (triangle | side bit), new set then old set.
@group(0) @binding(22) var<storage, read_write> CAND: array<u32>;
// Candidate counts: new (n), then old (n).
@group(0) @binding(23) var<storage, read_write> CCOUNT: array<atomic<u32>>;
// Positions at the last contact search.
@group(0) @binding(24) var<storage, read_write> SX: array<vec4f>;
// Contact corrections in fixed point (x, y, z, count) per vertex.
@group(0) @binding(25) var<storage, read_write> DELTA: array<atomic<i32>>;
// 0 top speed (f32 bits), 1 search needed, 2 time (f32 bits), 3 margin, 4 pad, 5 cell,
// 6 candidate overflow count, 7 searches run, 8 most CG iterations, 9 most candidates at a point.
@group(0) @binding(26) var<storage, read_write> ST: array<atomic<u32>>;
// Two vec4 per prop: (kind, p0, p1, p2), (p3, p4, p5, p6).
@group(0) @binding(27) var<storage, read_write> PROPS: array<vec4f>;
@group(1) @binding(0) var<uniform> R: Range;

const SIDE_BIT: u32 = 0x80000000u;

fn stf(k: u32) -> f32 {
    return bitcast<f32>(atomicLoad(&ST[k]));
}

fn searching() -> bool {
    return atomicLoad(&ST[1]) != 0u;
}

// ---------------------------------------------------------------- contact search

fn cell_of(p: vec3f, cell: f32) -> vec3i {
    return vec3i(floor(p / cell));
}

fn bucket(c: vec3i) -> u32 {
    let h = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u);
    return h & (P.table - 1u);
}

// Has some point moved half the search margin since the last search?
@compute @workgroup_size(64)
fn stale(@builtin(global_invocation_id) g: vec3u) {
    let i = g.x;
    if (i >= P.n) {
        return;
    }
    let m = stf(3u);
    let d = X[i].xyz - SX[i].xyz;
    if (dot(d, d) > 0.25 * m * m) {
        atomicStore(&ST[1], 1u);
    }
}

// Start a search: new margin from the top speed, keep the old candidates (for their sides),
// clear the counts and the hash table.
@compute @workgroup_size(64)
fn begin(@builtin(global_invocation_id) g: vec3u) {
    if (!searching()) {
        return;
    }
    let i = g.x;
    if (i == 0u) {
        let vm = min(stf(0u), P.vcap);
        let margin = max(P.look * vm, P.min_margin);
        let pad = P.tmax + margin;
        atomicStore(&ST[3], bitcast<u32>(margin));
        atomicStore(&ST[4], bitcast<u32>(pad));
        atomicStore(&ST[5], bitcast<u32>(max(pad, P.h)));
        atomicAdd(&ST[7], 1u);
    }
    if (i < P.table) {
        atomicStore(&HASH[i], 0u);
    }
    if (i < P.n) {
        let k = P.kslots;
        let old = P.n * k;
        let c = min(atomicLoad(&CCOUNT[i]), k);
        for (var j = 0u; j < c; j++) {
            CAND[old + i * k + j] = CAND[i * k + j];
        }
        atomicStore(&CCOUNT[P.n + i], c);
        atomicStore(&CCOUNT[i], 0u);
        SX[i] = X[i];
    }
}

@compute @workgroup_size(64)
fn hash_count(@builtin(global_invocation_id) g: vec3u) {
    if (!searching()) {
        return;
    }
    let i = g.x;
    if (i >= P.n) {
        return;
    }
    atomicAdd(&HASH[bucket(cell_of(clamp(X[i].xyz, vec3f(-1e4), vec3f(1e4)), stf(5u)))], 1u);
}

var<workgroup> part: array<u32, 256>;
var<workgroup> wflag: u32;

// Exclusive prefix sum of the bucket counts (one workgroup), counts reset to serve as cursors.
@compute @workgroup_size(256)
fn hash_scan(@builtin(local_invocation_index) t: u32) {
    if (t == 0u) {
        wflag = atomicLoad(&ST[1]);
    }
    let f = workgroupUniformLoad(&wflag);
    if (f == 0u) {
        return;
    }
    let tb = P.table;
    let chunk = (tb + 255u) / 256u;
    let s = min(t * chunk, tb);
    let e = min(s + chunk, tb);
    var sum = 0u;
    for (var k = s; k < e; k++) {
        sum += atomicLoad(&HASH[k]);
    }
    part[t] = sum;
    workgroupBarrier();
    for (var off = 1u; off < 256u; off = off * 2u) {
        var v = 0u;
        if (t >= off) {
            v = part[t - off];
        }
        workgroupBarrier();
        part[t] += v;
        workgroupBarrier();
    }
    var run = part[t] - sum;
    for (var k = s; k < e; k++) {
        let c = atomicLoad(&HASH[k]);
        atomicStore(&HASH[tb + k], run);
        run += c;
        atomicStore(&HASH[k], 0u);
    }
    if (t == 255u) {
        atomicStore(&HASH[2u * tb], part[255]);
    }
}

@compute @workgroup_size(64)
fn hash_scatter(@builtin(global_invocation_id) g: vec3u) {
    if (!searching()) {
        return;
    }
    let i = g.x;
    if (i >= P.n) {
        return;
    }
    let b = bucket(cell_of(clamp(X[i].xyz, vec3f(-1e4), vec3f(1e4)), stf(5u)));
    let slot = atomicAdd(&HASH[b], 1u);
    let at = atomicLoad(&HASH[P.table + b]) + slot;
    atomicStore(&HASH[2u * P.table + 1u + at], i);
}

fn is_partner(i: u32, piece: u32) -> bool {
    let a = PART[i];
    let b = PART[i + 1u];
    for (var k = a; k < b; k++) {
        if (PART[P.n + 1u + k] == piece) {
            return true;
        }
    }
    return false;
}

// Per triangle: every point within the search pad of it, with the side it is on (kept from the
// last search while the pair stays close, so a point is always pushed back the way it came).
@compute @workgroup_size(64)
fn find(@builtin(global_invocation_id) g: vec3u) {
    if (!searching()) {
        return;
    }
    let ti = g.x;
    if (ti >= P.n_tris) {
        return;
    }
    let t = TRI[ti].xyz;
    let a = X[t.x].xyz;
    let b = X[t.y].xyz;
    let c = X[t.z].xyz;
    var nrm = cross(b - a, c - a);
    let nl = length(nrm);
    if (nl < 1e-14) {
        return;
    }
    nrm = nrm / nl;
    let pt = VP[t.x].piece;
    let tc = (vec2f(VP[t.x].rx, VP[t.x].ry) + vec2f(VP[t.y].rx, VP[t.y].ry) + vec2f(VP[t.z].rx, VP[t.z].ry)) / 3.0;
    let tri_free = VP[t.x].inv > 0.0 || VP[t.y].inv > 0.0 || VP[t.z].inv > 0.0;
    let pad = stf(4u);
    let cell = stf(5u);
    let lo = min(min(a, b), c) - vec3f(pad);
    let hi = max(max(a, b), c) + vec3f(pad);
    // Non-finite or far-off positions (a frame the guard will undo) are not searched.
    if (!(all(abs(lo) < vec3f(1e4)) && all(abs(hi) < vec3f(1e4)) && cell > 0.0)) {
        return;
    }
    let clo = cell_of(lo, cell);
    let span = clamp(cell_of(hi, cell) - clo, vec3i(0), vec3i(5));
    let k = P.kslots;
    let old = P.n * k;
    let tb = P.table;
    var seen: array<u32, 64>;
    var nseen = 0u;
    for (var ix = 0; ix <= span.x; ix++) {
        for (var iy = 0; iy <= span.y; iy++) {
            for (var iz = 0; iz <= span.z; iz++) {
                let bk = bucket(clo + vec3i(ix, iy, iz));
                var dup = false;
                for (var q = 0u; q < nseen; q++) {
                    if (seen[q] == bk) {
                        dup = true;
                        break;
                    }
                }
                if (dup) {
                    continue;
                }
                if (nseen < 64u) {
                    seen[nseen] = bk;
                    nseen++;
                }
                let s0 = atomicLoad(&HASH[tb + bk]);
                let s1 = min(atomicLoad(&HASH[tb + bk + 1u]), s0 + P.n);
                for (var e = s0; e < s1; e++) {
                    let iu = atomicLoad(&HASH[2u * tb + 1u + e]);
                    if (iu == t.x || iu == t.y || iu == t.z) {
                        continue;
                    }
                    let vp = VP[iu];
                    if (vp.piece == pt) {
                        let r = vec2f(vp.rx, vp.ry) - tc;
                        if (dot(r, r) < P.far2) {
                            continue;
                        }
                    }
                    let p = X[iu].xyz;
                    if (any(p < lo) || any(p > hi)) {
                        continue;
                    }
                    if (!tri_free && vp.inv == 0.0) {
                        continue;
                    }
                    if (is_partner(iu, pt) && (is_partner(t.x, vp.piece) || is_partner(t.y, vp.piece) || is_partner(t.z, vp.piece))) {
                        continue;
                    }
                    let dist = dot(p - a, nrm);
                    if (abs(dist) > pad) {
                        continue;
                    }
                    var neg = dist < 0.0;
                    let oc = atomicLoad(&CCOUNT[P.n + iu]);
                    for (var j = 0u; j < oc; j++) {
                        let ent = CAND[old + iu * k + j];
                        if ((ent & ~SIDE_BIT) == ti) {
                            neg = (ent & SIDE_BIT) != 0u;
                            break;
                        }
                    }
                    let slot = atomicAdd(&CCOUNT[iu], 1u);
                    atomicMax(&ST[9], slot + 1u);
                    if (slot < k) {
                        CAND[iu * k + slot] = ti | select(0u, SIDE_BIT, neg);
                    } else {
                        atomicAdd(&ST[6], 1u);
                    }
                }
            }
        }
    }
}

@compute @workgroup_size(1)
fn search_done() {
    atomicStore(&ST[1], 0u);
}

// ---------------------------------------------------------------- predict

@compute @workgroup_size(64)
fn predict(@builtin(global_invocation_id) g: vec3u) {
    let i = g.x;
    if (i == 0u) {
        atomicStore(&ST[0], 0u);
    }
    if (i >= P.n) {
        return;
    }
    let x = X[i];
    PREV[i] = x;
    if (VP[i].inv > 0.0) {
        let v = VEL[i].xyz * P.damp + ACC[i].xyz * P.dt;
        VEL[i] = vec4f(v, 0.0);
        X[i] = vec4f(x.xyz + v * P.dt, 0.0);
    }
}

// ---------------------------------------------------------------- implicit bending

var<workgroup> red: array<f32, 256>;
var<workgroup> wsum: f32;
var<workgroup> wrange: vec4u;
var<workgroup> wref: f32;

fn reduce(t: u32, v: f32) -> f32 {
    red[t] = v;
    workgroupBarrier();
    for (var s = 128u; s > 0u; s = s >> 1u) {
        if (t < s) {
            red[t] += red[t + s];
        }
        workgroupBarrier();
    }
    if (t == 0u) {
        wsum = red[0];
    }
    return workgroupUniformLoad(&wsum);
}

// Curvature vector of a stencil for the vector field `base` (an offset into CG) or, with
// base = 0xffffffff, for the positions.
fn curvature(k: u32, base: u32) -> vec3f {
    let id = BV[k];
    let w = BW[k];
    if (base == 0xffffffffu) {
        let x0 = X[id.x].xyz;
        return w.y * (X[id.y].xyz - x0) + w.z * (X[id.z].xyz - x0) + w.w * (X[id.w].xyz - x0) + (w.x + w.y + w.z + w.w) * x0;
    }
    if (base == 0xfffffffeu) {
        // Positions plus the current correction d.
        let o = 2u * P.n;
        let x0 = X[id.x].xyz;
        return w.y * (X[id.y].xyz - x0) + w.z * (X[id.z].xyz - x0) + w.w * (X[id.w].xyz - x0) + (w.x + w.y + w.z + w.w) * x0
            + w.x * CG[o + id.x].xyz + w.y * CG[o + id.y].xyz + w.z * CG[o + id.z].xyz + w.w * CG[o + id.w].xyz;
    }
    return w.x * CG[base + id.x].xyz + w.y * CG[base + id.y].xyz + w.z * CG[base + id.z].xyz + w.w * CG[base + id.w].xyz;
}

// Q applied to the field whose stencil curvatures are in BC, at vertex i.
fn gather(i: u32) -> vec3f {
    var s = vec3f(0.0);
    let a = INC[i];
    let b = INC[i + 1u];
    for (var e = a; e < b; e++) {
        let code = INC[P.n + 1u + e];
        let k = code >> 2u;
        s += (BK[k] * BW[k][code & 3u]) * BC[k].xyz;
    }
    return s;
}

// One piece per workgroup: (M / dt^2 + Q) d = -Q x for the correction d to the predicted
// positions of its free points (pins and seam points held), by Jacobi-preconditioned
// conjugate gradients. This is the CPU's prefactored banded solve done iteratively.
@compute @workgroup_size(256)
fn bend_cg(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32) {
    if (t == 0u) {
        wrange = PIECE[2u * wg.x];
        wref = bitcast<f32>(PIECE[2u * wg.x + 1u].x);
    }
    let rg = workgroupUniformLoad(&wrange);
    let cg_ref = workgroupUniformLoad(&wref);
    if (rg.w == 0u) {
        return;
    }
    let n = P.n;
    let v0 = rg.x;
    let vn = rg.y;
    let s0 = rg.z;
    let sn = rg.w;
    // Warm start from the last substep's correction (still in d): in a slow drape the
    // correction barely changes between substeps, and plain CG is slow on the smooth modes.
    for (var s = t; s < sn; s += 256u) {
        BC[s0 + s] = vec4f(curvature(s0 + s, 0xfffffffeu), 0.0);
    }
    storageBarrier();
    var part_rz = 0.0;
    for (var j = t; j < vn; j += 256u) {
        let i = v0 + j;
        let vp = VP[i];
        var r = vec3f(0.0);
        var d0 = vec3f(0.0);
        if (vp.held == 0u) {
            d0 = CG[2u * n + i].xyz;
            r = -gather(i) - vp.mass * P.inv_dt2 * d0;
        }
        let z = r / vp.diag;
        CG[i] = vec4f(r, 0.0);
        CG[n + i] = vec4f(z, 0.0);
        CG[2u * n + i] = vec4f(d0, 0.0);
        part_rz += dot(r, z);
    }
    let rz0 = reduce(t, part_rz);
    var rz = rz0;
    storageBarrier();
    var used = 0u;
    for (var it = 0u; it < P.cg_iters; it++) {
        if (!(rz > P.cg_tol2 * cg_ref)) {
            break;
        }
        used = it + 1u;
        for (var s = t; s < sn; s += 256u) {
            BC[s0 + s] = vec4f(curvature(s0 + s, n), 0.0);
        }
        storageBarrier();
        var part_pap = 0.0;
        for (var j = t; j < vn; j += 256u) {
            let i = v0 + j;
            let vp = VP[i];
            var ap = vec3f(0.0);
            if (vp.held == 0u) {
                let p = CG[n + i].xyz;
                ap = vp.mass * P.inv_dt2 * p + gather(i);
                part_pap += dot(p, ap);
            }
            CG[3u * n + i] = vec4f(ap, 0.0);
        }
        let pap = reduce(t, part_pap);
        if (!(pap > 0.0)) {
            break;
        }
        let alpha = rz / pap;
        var part_rzn = 0.0;
        for (var j = t; j < vn; j += 256u) {
            let i = v0 + j;
            let r = CG[i].xyz - alpha * CG[3u * n + i].xyz;
            CG[i] = vec4f(r, 0.0);
            CG[2u * n + i] = vec4f(CG[2u * n + i].xyz + alpha * CG[n + i].xyz, 0.0);
            part_rzn += dot(r, r / VP[i].diag);
        }
        let rzn = reduce(t, part_rzn);
        let beta = rzn / rz;
        rz = rzn;
        for (var j = t; j < vn; j += 256u) {
            let i = v0 + j;
            CG[n + i] = vec4f(CG[i].xyz / VP[i].diag + beta * CG[n + i].xyz, 0.0);
        }
        storageBarrier();
    }
    for (var j = t; j < vn; j += 256u) {
        let i = v0 + j;
        if (VP[i].held == 0u) {
            X[i] = vec4f(X[i].xyz + CG[2u * n + i].xyz, 0.0);
        }
    }
    if (t == 0u) {
        atomicMax(&ST[8], used);
    }
}

// ---------------------------------------------------------------- constraints (one colour per dispatch)

// Seams, braces, glue, laminates and fasteners: distance constraints between surface points.
@compute @workgroup_size(64)
fn welds(@builtin(global_invocation_id) g: vec3u) {
    if (g.x >= R.count) {
        return;
    }
    let k = R.start + g.x;
    let par = WPAR[k];
    let sewing = max(1.0 - stf(2u) / P.sew_s, 0.0);
    var rest = par.x;
    if (sewing > 0.0 && par.y > par.x) {
        rest = par.x + (par.y - par.x) * sewing;
    }
    var ws = 0.0;
    var d = vec3f(0.0);
    for (var q = 0u; q < 6u; q++) {
        let c = bitcast<f32>(WELD[k * 12u + 6u + q]);
        if (c != 0.0) {
            let u = WELD[k * 12u + q];
            ws += VP[u].inv * c * c;
            d += c * X[u].xyz;
        }
    }
    if (ws == 0.0) {
        return;
    }
    let l = length(d);
    if (l < 1e-12) {
        return;
    }
    let alpha = 1.0 / (par.z * P.dt * P.dt);
    let dl = -(l - rest) / (ws + alpha);
    let gv = d * (dl / l);
    for (var q = 0u; q < 6u; q++) {
        let c = bitcast<f32>(WELD[k * 12u + 6u + q]);
        let u = WELD[k * 12u + q];
        let w = VP[u].inv;
        if (c != 0.0 && w != 0.0) {
            X[u] = vec4f(X[u].xyz + gv * (w * c), 0.0);
        }
    }
    WLAM[k] += dl;
}

// Isometric bending of stencils that touch a seam point, as constraints.
@compute @workgroup_size(64)
fn cbends(@builtin(global_invocation_id) g: vec3u) {
    if (g.x >= R.count) {
        return;
    }
    let k = CBEND[R.start + g.x];
    let id = BV[k];
    let w = BW[k];
    let inv = vec4f(VP[id.x].inv, VP[id.y].inv, VP[id.z].inv, VP[id.w].inv);
    let den = 1.0 / (BK[k] * P.dt * P.dt) + dot(inv, w * w);
    if (den <= 0.0) {
        return;
    }
    let c = curvature(k, 0xffffffffu);
    let dl = c * (-1.0 / den);
    let s = inv * w;
    if (s.x != 0.0) { X[id.x] = vec4f(X[id.x].xyz + dl * s.x, 0.0); }
    if (s.y != 0.0) { X[id.y] = vec4f(X[id.y].xyz + dl * s.y, 0.0); }
    if (s.z != 0.0) { X[id.z] = vec4f(X[id.z].xyz + dl * s.z, 0.0); }
    if (s.w != 0.0) { X[id.w] = vec4f(X[id.w].xyz + dl * s.w, 0.0); }
}

// Edge stretch, as XPBD distance constraints.
@compute @workgroup_size(64)
fn springs(@builtin(global_invocation_id) g: vec3u) {
    if (g.x >= R.count) {
        return;
    }
    let k = R.start + g.x;
    let s = SPR[k];
    let wa = VP[s.a].inv;
    let wb = VP[s.b].inv;
    let ws = wa + wb;
    if (ws == 0.0) {
        return;
    }
    let xa = X[s.a].xyz;
    let xb = X[s.b].xyz;
    let d = xb - xa;
    let l = length(d);
    if (l < 1e-12) {
        return;
    }
    let alpha = 1.0 / (s.k * P.dt * P.dt);
    let dl = -(l - s.rest) / (ws + alpha);
    let gv = d * (dl / l);
    X[s.a] = vec4f(xa - gv * wa, 0.0);
    X[s.b] = vec4f(xb + gv * wb, 0.0);
    SLAM[k] += dl;
}

// ---------------------------------------------------------------- leather against leather

fn add_fx(i: u32, d: vec3f) {
    let q = clamp(d, vec3f(-0.05), vec3f(0.05)) * P.fx;
    atomicAdd(&DELTA[4u * i], i32(round(q.x)));
    atomicAdd(&DELTA[4u * i + 1u], i32(round(q.y)));
    atomicAdd(&DELTA[4u * i + 2u], i32(round(q.z)));
    atomicAdd(&DELTA[4u * i + 3u], 1);
}

// Each close point-triangle pair kept the two half thicknesses apart on the point's own side,
// with Coulomb friction; Jacobi (corrections summed, then averaged in `contact_apply`).
@compute @workgroup_size(64)
fn contacts(@builtin(global_invocation_id) g: vec3u) {
    let i = g.x;
    if (i >= P.n) {
        return;
    }
    let cnt = min(atomicLoad(&CCOUNT[i]), P.kslots);
    if (cnt == 0u) {
        return;
    }
    let vi = VP[i];
    let p = X[i].xyz;
    for (var j = 0u; j < cnt; j++) {
        let ent = CAND[i * P.kslots + j];
        let ti = ent & ~SIDE_BIT;
        let side = select(1.0, -1.0, (ent & SIDE_BIT) != 0u);
        let t = TRI[ti].xyz;
        let a = X[t.x].xyz;
        let b = X[t.y].xyz;
        let c = X[t.z].xyz;
        let e1 = b - a;
        let e2 = c - a;
        let nrm = cross(e1, e2);
        let nl = length(nrm);
        if (nl < 1e-14) {
            continue;
        }
        let nv = nrm * (side / nl);
        let ap = p - a;
        let dist = dot(ap, nv);
        let d = vi.half_t + VP[t.x].half_t;
        if (dist >= d) {
            continue;
        }
        let d00 = dot(e1, e1);
        let d01 = dot(e1, e2);
        let d11 = dot(e2, e2);
        let d20 = dot(ap, e1);
        let d21 = dot(ap, e2);
        let den = d00 * d11 - d01 * d01;
        if (den <= 0.0) {
            continue;
        }
        let bv = (d11 * d20 - d01 * d21) / den;
        let bw = (d00 * d21 - d01 * d20) / den;
        let bu = 1.0 - bv - bw;
        if (bu < -0.01 || bv < -0.01 || bw < -0.01) {
            continue;
        }
        var bary = max(vec3f(bu, bv, bw), vec3f(0.0));
        bary = bary / (bary.x + bary.y + bary.z);
        let wt = vec3f(VP[t.x].inv, VP[t.y].inv, VP[t.z].inv);
        let wp = vi.inv;
        let wsum = wp + dot(bary * bary, wt);
        if (wsum <= 0.0) {
            continue;
        }
        var push = d - dist;
        if (push > P.max_push) {
            let pa = PREV[t.x].xyz;
            let pn = cross(PREV[t.y].xyz - pa, PREV[t.z].xyz - pa);
            let was = side * dot(PREV[i].xyz - pa, pn) / max(length(pn), 1e-18);
            if (was <= -d) {
                push = P.max_push;
            }
        }
        let dl = push / wsum;
        var dp = nv * (wp * dl);
        var da = -nv * (wt.x * bary.x * dl);
        var db = -nv * (wt.y * bary.y * dl);
        var dc = -nv * (wt.z * bary.z * dl);
        let mu = 0.5 * (vi.mu + VP[t.x].mu);
        let rel = (p + dp - PREV[i].xyz) - bary.x * (a + da - PREV[t.x].xyz) - bary.y * (b + db - PREV[t.y].xyz) - bary.z * (c + dc - PREV[t.z].xyz);
        let tng = rel - nv * dot(rel, nv);
        let lt = length(tng);
        if (lt > 1e-15) {
            let s = min(mu * push / lt, 1.0) / wsum;
            dp -= tng * (s * wp);
            da += tng * (s * wt.x * bary.x);
            db += tng * (s * wt.y * bary.y);
            dc += tng * (s * wt.z * bary.z);
        }
        add_fx(i, dp);
        add_fx(t.x, da);
        add_fx(t.y, db);
        add_fx(t.z, dc);
    }
}

@compute @workgroup_size(64)
fn contact_apply(@builtin(global_invocation_id) g: vec3u) {
    let i = g.x;
    if (i >= P.n) {
        return;
    }
    let c = atomicExchange(&DELTA[4u * i + 3u], 0);
    if (c == 0) {
        return;
    }
    let dx = atomicExchange(&DELTA[4u * i], 0);
    let dy = atomicExchange(&DELTA[4u * i + 1u], 0);
    let dz = atomicExchange(&DELTA[4u * i + 2u], 0);
    let d = vec3f(f32(dx), f32(dy), f32(dz)) / (P.fx * f32(c));
    X[i] = vec4f(X[i].xyz + d, 0.0);
}

// ---------------------------------------------------------------- floor and props

fn sdf_prop(k: u32, p: vec3f) -> f32 {
    let a = PROPS[2u * k];
    let b = PROPS[2u * k + 1u];
    let kind = u32(a.x + 0.5);
    if (kind == 0u) {
        let lo = a.yzw;
        let hi = b.xyz;
        let q = abs(p - (lo + hi) * 0.5) - (hi - lo) * 0.5;
        return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
    }
    if (kind == 1u) {
        let l = p - vec3f(a.y, a.z, b.x - 1.0);
        let d = vec2f(length(l.xy) - a.w, abs(l.z) - 1.0);
        return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
    }
    let pa = a.yzw;
    let ab = b.xyz - pa;
    let tt = clamp(dot(p - pa, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
    return length(p - (pa + ab * tt)) - b.w;
}

fn prop_normal(k: u32, p: vec3f) -> vec3f {
    let e = 1e-4;
    let gr = vec3f(
        sdf_prop(k, p + vec3f(e, 0.0, 0.0)) - sdf_prop(k, p - vec3f(e, 0.0, 0.0)),
        sdf_prop(k, p + vec3f(0.0, e, 0.0)) - sdf_prop(k, p - vec3f(0.0, e, 0.0)),
        sdf_prop(k, p + vec3f(0.0, 0.0, e)) - sdf_prop(k, p - vec3f(0.0, 0.0, e)));
    return gr / max(length(gr), 1e-12);
}

// Coulomb friction on a position step: the sliding since `prev` (tangent to `n`) is cancelled
// while it is within mu times the normal correction, otherwise reduced by that much.
fn friction(p: vec3f, prev: vec3f, n: vec3f, push: f32, mu: f32) -> vec3f {
    let d = p - prev;
    let t = d - n * dot(d, n);
    let lt = length(t);
    if (lt < 1e-15) {
        return p;
    }
    return p - t * min(mu * push / lt, 1.0);
}

// One-sided, with friction, never held: leather can lift off and slide.
@compute @workgroup_size(64)
fn floor_props(@builtin(global_invocation_id) g: vec3u) {
    let i = g.x;
    if (i >= P.n) {
        return;
    }
    let vp = VP[i];
    if (vp.inv <= 0.0) {
        return;
    }
    let r = vp.half_t;
    let prev = PREV[i].xyz;
    var p = X[i].xyz;
    var touched = false;
    if (p.z < r) {
        let push = r - p.z;
        p.z = r;
        p = friction(p, prev, vec3f(0.0, 0.0, 1.0), push, vp.mu);
        touched = true;
    }
    for (var k = 0u; k < P.n_props; k++) {
        let d = sdf_prop(k, p);
        if (d < r) {
            let nn = prop_normal(k, p);
            p = p + nn * (r - d);
            p = friction(p, prev, nn, r - d, vp.mu);
            touched = true;
        }
    }
    if (touched) {
        X[i] = vec4f(p, 0.0);
    }
}

// ---------------------------------------------------------------- velocity

@compute @workgroup_size(64)
fn velocity(@builtin(global_invocation_id) g: vec3u) {
    let i = g.x;
    if (i == 0u) {
        atomicStore(&ST[2], bitcast<u32>(stf(2u) + P.dt));
    }
    if (i >= P.n) {
        return;
    }
    if (VP[i].inv == 0.0) {
        return;
    }
    let prev = PREV[i].xyz;
    var v = (X[i].xyz - prev) / P.dt;
    let s = length(v);
    if (s > P.vcap) {
        v = v * (P.vcap / s);
        X[i] = vec4f(prev + v * P.dt, 0.0);
    }
    VEL[i] = vec4f(v, 0.0);
    atomicMax(&ST[0], bitcast<u32>(min(s, P.vcap)));
}
