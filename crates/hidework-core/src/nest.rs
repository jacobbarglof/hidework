//! Nesting: lay a project's cut outlines onto a hide or panel to see how many items fit and
//! where to cut.
//!
//! Method: raster bottom-left fill. The leather is rasterised (1 mm cells by default) into a
//! grid that marks the outside (eroded by the edge margin), flaws (grown by the flaw margin) and
//! the A/B/C quality zones. Each piece, at each allowed rotation (and mirrored for the second of
//! a pair), is rasterised conservatively (every cell it touches) and grown by half the spacing.
//! For every grid row we keep the length of the free run (or blocked run) starting at each
//! cell, so testing a position costs one lookup per piece row and a failed test tells us how far
//! to jump. Pieces go in order (visible parts first, then largest first) to the first free spot
//! scanning from one corner; the best of several runs (each from a different corner and axis,
//! then with shuffled orders) within a time budget wins. To count items, we fill greedily, then
//! try one more complete set at a time until no order fits it.
//!
//! The raster is conservative, so placed pieces never overlap and always keep the spacing,
//! margins and flaw clearance (to within the cell size, on the generous side).

use crate::compute::ComputedProject;
use crate::geom::{signed_area, v, Rect, Vec2};
use crate::hide::{Grade, Hide, HideKind, MM2_PER_M2, MM2_PER_SQFT};
use crate::model::{MaterialKind, Project};
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GrainMode {
    /// Every piece follows the backbone with its own grain direction (`Piece::grain_deg`).
    All,
    /// Long, narrow pieces (3:1 or more: straps, belts, gussets, handles) run along the backbone;
    /// the rest may turn to any right angle.
    #[default]
    Long,
    /// Ignore the backbone.
    None,
}

/// Per-piece choices from the maker.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PieceRule {
    pub piece_id: String,
    /// Shows on the finished item, so it gets the best leather and stays clear of minor flaws.
    pub visible: Option<bool>,
    /// Must follow the backbone (with `Piece::grain_deg`).
    pub grain: Option<bool>,
    /// Leave this piece out of the layout.
    pub skip: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NestOptions {
    /// Gap between neighbouring pieces (knife or laser kerf plus a little).
    pub spacing_mm: f64,
    /// Keep this far in from the edge of the leather.
    pub edge_margin_mm: f64,
    /// Keep this far from flaws.
    pub flaw_margin_mm: f64,
    /// Complete sets to lay out; 0 means as many as fit.
    pub sets: u32,
    /// Only pieces cut from this material; none means the main leather (the leather with the
    /// most area); "*" means every piece.
    pub material_id: Option<String>,
    pub grain: GrainMode,
    /// How far a grain-bound piece may turn off the backbone (needs `fine_step_deg`).
    pub grain_tolerance_deg: f64,
    /// Extra rotation step in degrees (0 = right angles only). Pieces without a grain rule may
    /// turn by any multiple of it.
    pub fine_step_deg: f64,
    /// Cut the second of a pair (cut count 2, 4...) mirrored, as a left and a right.
    pub mirror_pairs: bool,
    pub rules: Vec<PieceRule>,
    /// Raster cell size; 0 picks 1 mm, coarser only for very large leather.
    pub resolution_mm: f64,
    /// Time budget for trying different layouts.
    pub time_ms: u64,
    pub seed: u64,
    /// Also return the layout as an SVG drawing.
    pub include_svg: bool,
    /// Upper limit on complete sets when filling.
    pub max_sets: u32,
}

impl Default for NestOptions {
    fn default() -> Self {
        NestOptions {
            spacing_mm: 3.0,
            edge_margin_mm: 5.0,
            flaw_margin_mm: 3.0,
            sets: 0,
            material_id: None,
            grain: GrainMode::Long,
            grain_tolerance_deg: 0.0,
            fine_step_deg: 0.0,
            mirror_pairs: true,
            rules: vec![],
            resolution_mm: 0.0,
            time_ms: 1500,
            seed: 1,
            include_svg: false,
            max_sets: 500,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub piece_id: String,
    pub name: String,
    /// Which complete item (set) this piece belongs to, from 1.
    pub item: u32,
    /// Which copy of the piece within its set (0 for the first).
    pub copy: u32,
    /// Rotation applied to the piece's cut outline, degrees (after mirroring).
    pub angle_deg: f64,
    /// Mirrored left-to-right before rotating (the other half of a pair).
    pub mirrored: bool,
    /// Hide point = rotate(mirror(piece point)) + offset.
    pub offset: Vec2,
    /// The cut outline on the hide.
    pub outline: Vec<Vec2>,
    /// The poorest leather grade under the piece.
    pub grade: Grade,
    pub visible: bool,
    pub area_mm2: f64,
    /// Index into `NestResult::pieces` (for colouring).
    pub shape: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unplaced {
    pub piece_id: String,
    pub name: String,
    pub count: u32,
    pub reason: String,
}

/// One kind of piece in the layout.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestPiece {
    pub piece_id: String,
    pub name: String,
    pub per_set: u32,
    pub area_mm2: f64,
    pub visible: bool,
    pub follows_backbone: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestResult {
    pub hide_name: String,
    pub material_id: String,
    pub material_name: String,
    pub pieces: Vec<NestPiece>,
    pub placements: Vec<Placement>,
    pub unplaced: Vec<Unplaced>,
    /// Complete items (every piece of the set placed).
    pub complete_items: u32,
    pub sets_requested: u32,
    pub hide_area_mm2: f64,
    /// Area left once the edge margin and flaws are taken out.
    pub usable_area_mm2: f64,
    pub used_area_mm2: f64,
    pub waste_area_mm2: f64,
    /// Used area as a share of the whole hide.
    pub yield_pct: f64,
    pub leftover_pct: f64,
    /// Leather in one set of pieces.
    pub item_area_mm2: f64,
    /// Hide area divided by complete items: what one item really costs in leather.
    pub leather_per_item_mm2: f64,
    pub sentence: String,
    pub notes: Vec<String>,
    pub runs: u32,
    pub elapsed_ms: u64,
    pub resolution_mm: f64,
    pub svg: Option<String>,
}

// ---------- shapes ----------

struct Shape {
    id: String,
    name: String,
    poly: Vec<Vec2>,
    area: f64,
    visible: bool,
    /// Grain direction in piece coordinates (degrees) when the piece must follow the backbone.
    grain: Option<f64>,
    per_set: u32,
    /// (angle, mirrored) variants.
    variants: Vec<(f64, bool)>,
}

const HIDDEN_WORDS: [&str; 9] = ["lining", "liner", "stiffener", "reinforc", "backer", "filler", "welt", "interfacing", "inner"];

fn default_visible(name: &str) -> bool {
    let n = name.to_lowercase();
    !HIDDEN_WORDS.iter().any(|w| n.contains(w))
}

fn norm_deg(a: f64) -> f64 {
    let r = a.rem_euclid(360.0);
    if (r - 360.0).abs() < 1e-9 {
        0.0
    } else {
        r
    }
}

fn angle_set(grain: Option<f64>, backbone: Option<f64>, mirrored: bool, opts: &NestOptions) -> Vec<f64> {
    let step = if opts.fine_step_deg > 0.0 { opts.fine_step_deg.clamp(1.0, 90.0) } else { 0.0 };
    let mut out: Vec<f64> = Vec::new();
    match (grain, backbone) {
        (Some(g), Some(b)) => {
            let g = if mirrored { 180.0 - g } else { g };
            let base = b - g;
            let mut offs = vec![0.0];
            if step > 0.0 && opts.grain_tolerance_deg > 0.0 {
                let mut k = step;
                while k <= opts.grain_tolerance_deg + 1e-9 {
                    offs.push(k);
                    offs.push(-k);
                    k += step;
                }
            }
            for half in [0.0, 180.0] {
                for o in &offs {
                    out.push(norm_deg(base + half + o));
                }
            }
        }
        _ => {
            if step > 0.0 {
                let mut a = 0.0;
                while a < 360.0 - 1e-9 {
                    out.push(a);
                    a += step;
                }
                for r in [90.0, 180.0, 270.0] {
                    out.push(r);
                }
            } else {
                out = vec![0.0, 90.0, 180.0, 270.0];
            }
        }
    }
    let mut dedup: Vec<f64> = Vec::new();
    for a in out {
        if !dedup.iter().any(|d| (d - a).abs() < 1e-6) {
            dedup.push(a);
        }
    }
    dedup
}

fn pick_material(project: &Project, computed: &ComputedProject, want: Option<&str>) -> Option<String> {
    if let Some(w) = want {
        return Some(w.to_string());
    }
    let mut totals: Vec<(String, f64, bool)> = Vec::new();
    for cp in &computed.pieces {
        let Some(pc) = project.piece(&cp.id) else { continue };
        let a = signed_area(&cp.cut).abs() * pc.cut_count.max(1) as f64;
        let leather = project.material(&pc.material_id).is_none_or(|m| m.kind == MaterialKind::Leather);
        match totals.iter_mut().find(|t| t.0 == pc.material_id) {
            Some(t) => t.1 += a,
            None => totals.push((pc.material_id.clone(), a, leather)),
        }
    }
    totals.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)));
    totals.first().map(|t| t.0.clone())
}

fn build_shapes(project: &Project, computed: &ComputedProject, material: &str, backbone: Option<f64>, opts: &NestOptions) -> Vec<Shape> {
    let mut out = Vec::new();
    for cp in &computed.pieces {
        let Some(pc) = project.piece(&cp.id) else { continue };
        if material != "*" && pc.material_id != material {
            continue;
        }
        let rule = opts.rules.iter().find(|r| r.piece_id == pc.id);
        if rule.is_some_and(|r| r.skip) || cp.cut.len() < 3 {
            continue;
        }
        let area = signed_area(&cp.cut).abs();
        if area < 1.0 {
            continue;
        }
        let visible = rule.and_then(|r| r.visible).unwrap_or_else(|| default_visible(&pc.name));
        let b = Rect::of(&cp.cut);
        let (w, h) = (b.width(), b.height());
        let long = w.max(h) >= 3.0 * w.min(h).max(1e-6);
        let grain = match rule.and_then(|r| r.grain) {
            Some(true) => Some(pc.grain_deg),
            Some(false) => None,
            None => match opts.grain {
                GrainMode::All => Some(pc.grain_deg),
                // A long piece follows its length, whatever its grain arrow says.
                GrainMode::Long if long => Some(if w >= h { 0.0 } else { 90.0 }),
                _ => None,
            },
        };
        let grain = if backbone.is_some() { grain } else { None };
        let per_set = pc.cut_count.max(1);
        let variants = variants_for(grain, backbone, per_set, opts);
        out.push(Shape { id: pc.id.clone(), name: pc.name.clone(), poly: cp.cut.clone(), area, visible, grain, per_set, variants });
    }
    out
}

fn variants_for(grain: Option<f64>, backbone: Option<f64>, per_set: u32, opts: &NestOptions) -> Vec<(f64, bool)> {
    let mut variants = Vec::new();
    let mirror = opts.mirror_pairs && per_set >= 2;
    for m in [false, true] {
        if m && !mirror {
            continue;
        }
        for a in angle_set(grain, backbone, m, opts) {
            variants.push((a, m));
        }
    }
    variants
}

fn place_point(q: Vec2, angle_deg: f64, mirrored: bool) -> Vec2 {
    let q = if mirrored { v(-q.x, q.y) } else { q };
    let (s, c) = angle_deg.to_radians().sin_cos();
    v(q.x * c - q.y * s, q.x * s + q.y * c)
}

// ---------- raster ----------

/// The 8 symmetries of the square: (a, b, c, d) maps (x, y) to (a x + b y, c x + d y).
const TRANSFORMS: [[f64; 4]; 8] = [
    [1.0, 0.0, 0.0, 1.0],
    [0.0, 1.0, 1.0, 0.0],
    [-1.0, 0.0, 0.0, 1.0],
    [0.0, -1.0, 1.0, 0.0],
    [1.0, 0.0, 0.0, -1.0],
    [0.0, 1.0, -1.0, 0.0],
    [-1.0, 0.0, 0.0, -1.0],
    [0.0, -1.0, -1.0, 0.0],
];

fn tf(t: &[f64; 4], p: Vec2) -> Vec2 {
    v(t[0] * p.x + t[1] * p.y, t[2] * p.x + t[3] * p.y)
}

fn tf_inv(t: &[f64; 4], p: Vec2) -> Vec2 {
    v(t[0] * p.x + t[2] * p.y, t[1] * p.x + t[3] * p.y)
}

struct Bitmap {
    w: usize,
    h: usize,
    bits: Vec<u8>,
}

impl Bitmap {
    fn new(w: usize, h: usize) -> Bitmap {
        Bitmap { w, h, bits: vec![0; w * h] }
    }
    /// Set cells whose centres are inside the polygon (even-odd).
    fn fill_centres(&mut self, poly: &[Vec2], origin: Vec2, res: f64, val: u8) {
        let n = poly.len();
        if n < 3 {
            return;
        }
        let b = Rect::of(poly);
        let j0 = (((b.min.y - origin.y) / res - 0.5).floor().max(0.0)) as usize;
        let j1 = (((b.max.y - origin.y) / res).ceil().max(0.0) as usize).min(self.h);
        let mut xs: Vec<f64> = Vec::new();
        for j in j0..j1 {
            let y = origin.y + (j as f64 + 0.5) * res;
            xs.clear();
            for i in 0..n {
                let (p, q) = (poly[i], poly[(i + 1) % n]);
                if (p.y <= y) != (q.y <= y) {
                    xs.push(p.x + (y - p.y) * (q.x - p.x) / (q.y - p.y));
                }
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            for pair in xs.chunks(2) {
                if pair.len() < 2 {
                    break;
                }
                let i0 = ((pair[0] - origin.x) / res - 0.5).ceil().max(0.0) as usize;
                let i1 = ((pair[1] - origin.x) / res - 0.5).floor();
                if i1 < 0.0 {
                    continue;
                }
                let i1 = (i1 as usize).min(self.w.saturating_sub(1));
                let row = &mut self.bits[j * self.w..(j + 1) * self.w];
                for c in row.iter_mut().take(i1 + 1).skip(i0) {
                    *c = val;
                }
            }
        }
    }
    /// Set every cell an edge of the polygon passes through.
    fn mark_edges(&mut self, poly: &[Vec2], origin: Vec2, res: f64, val: u8) {
        let n = poly.len();
        let (wf, hf) = (self.w as f64, self.h as f64);
        for i in 0..n {
            let (p, q) = (poly[i], poly[(i + 1) % n]);
            let (p, q) = (v((p.x - origin.x) / res, (p.y - origin.y) / res), v((q.x - origin.x) / res, (q.y - origin.y) / res));
            let (ylo, yhi) = (p.y.min(q.y), p.y.max(q.y));
            let j0 = ylo.floor().max(0.0) as usize;
            let j1 = (yhi.floor().min(hf - 1.0)).max(-1.0);
            if j1 < 0.0 {
                continue;
            }
            for j in j0..=(j1 as usize) {
                let (s0, s1) = (j as f64, j as f64 + 1.0);
                // Part of the segment inside this row's strip.
                let (xa, xb) = if (q.y - p.y).abs() < 1e-12 {
                    (p.x.min(q.x), p.x.max(q.x))
                } else {
                    let ta = ((s0 - p.y) / (q.y - p.y)).clamp(0.0, 1.0);
                    let tb = ((s1 - p.y) / (q.y - p.y)).clamp(0.0, 1.0);
                    let (xa, xb) = (p.x + (q.x - p.x) * ta, p.x + (q.x - p.x) * tb);
                    (xa.min(xb), xa.max(xb))
                };
                let i0 = xa.floor().max(0.0) as usize;
                let i1 = xb.floor().min(wf - 1.0);
                if i1 < 0.0 {
                    continue;
                }
                let row = &mut self.bits[j * self.w..(j + 1) * self.w];
                for c in row.iter_mut().take(i1 as usize + 1).skip(i0) {
                    *c = val;
                }
            }
        }
    }
    /// Grow set cells by `k` cells in every direction (square).
    fn dilate(&mut self, k: usize) {
        if k == 0 {
            return;
        }
        let (w, h) = (self.w, self.h);
        let mut tmp = vec![0u8; w * h];
        let mut pre = vec![0u32; w.max(h) + 1];
        for y in 0..h {
            for x in 0..w {
                pre[x + 1] = pre[x] + (self.bits[y * w + x] != 0) as u32;
            }
            for x in 0..w {
                let (a, b) = (x.saturating_sub(k), (x + k + 1).min(w));
                tmp[y * w + x] = (pre[b] > pre[a]) as u8;
            }
        }
        // Vertical pass row by row: count of set cells in rows y-k..=y+k for every column.
        let mut count = vec![0u32; w];
        for y in 0..k.min(h) {
            for x in 0..w {
                count[x] += tmp[y * w + x] as u32;
            }
        }
        for y in 0..h {
            if y + k < h {
                let r = (y + k) * w;
                for x in 0..w {
                    count[x] += tmp[r + x] as u32;
                }
            }
            if y > k {
                let r = (y - k - 1) * w;
                for x in 0..w {
                    count[x] -= tmp[r + x] as u32;
                }
            }
            let r = y * w;
            for x in 0..w {
                self.bits[r + x] = (count[x] > 0) as u8;
            }
        }
    }
}

/// A piece at one rotation in one world, as rows of cell spans (row, first, last).
struct Raster {
    spans: Vec<(u32, u32, u32)>,
    w: usize,
    h: usize,
    /// World-space position of the raster's cell (0, 0) corner minus the piece transform origin.
    shift: Vec2,
}

fn raster_piece(poly: &[Vec2], angle: f64, mirrored: bool, t: &[f64; 4], res: f64, grow: usize) -> Raster {
    let pts: Vec<Vec2> = poly.iter().map(|&q| tf(t, place_point(q, angle, mirrored))).collect();
    let b = Rect::of(&pts);
    let pad = grow as f64 * res;
    let local: Vec<Vec2> = pts.iter().map(|&p| p - b.min + v(pad, pad)).collect();
    let w = (b.width() / res).floor() as usize + 1 + 2 * grow;
    let h = (b.height() / res).floor() as usize + 1 + 2 * grow;
    let mut bm = Bitmap::new(w, h);
    bm.fill_centres(&local, v(0.0, 0.0), res, 1);
    bm.mark_edges(&local, v(0.0, 0.0), res, 1);
    bm.dilate(grow);
    let mut spans = Vec::new();
    for y in 0..h {
        let row = &bm.bits[y * w..(y + 1) * w];
        let mut x = 0;
        while x < w {
            if row[x] != 0 {
                let a = x;
                while x + 1 < w && row[x + 1] != 0 {
                    x += 1;
                }
                spans.push((y as u32, a as u32, x as u32));
            }
            x += 1;
        }
    }
    // Wide spans fail first, which makes rejecting a position cheaper.
    spans.sort_by(|a, b| (b.2 - b.1).cmp(&(a.2 - a.1)));
    Raster { spans, w, h, shift: v(pad, pad) - b.min }
}

const OUT: u8 = 0x80;
const MINOR: u8 = 0x10;

/// The leather in one orientation of the plane.
struct World {
    t: [f64; 4],
    origin: Vec2,
    w: usize,
    h: usize,
    /// 64-bit words per row in the tables.
    wpr: usize,
    class: Vec<u8>,
    /// Blocked-cell bitmaps for each distinct tier.
    tables: Vec<Vec<u64>>,
    /// Tier (0: A only, 1: A or B, 2: any grade, all three clear of minor flaws; 3: anything
    /// usable) to table index.
    tier_table: [usize; 4],
    rasters: Vec<Vec<Raster>>,
}

fn blocked(c: u8, tier: usize) -> bool {
    if c & OUT != 0 {
        return true;
    }
    let grade = c & 0x3;
    match tier {
        0 => c & MINOR != 0 || grade > 0,
        1 => c & MINOR != 0 || grade > 1,
        2 => c & MINOR != 0,
        _ => false,
    }
}

/// One bit per cell, set when blocked; bits past the row end are set too.
fn bit_row(row_class: &[u8], tier: usize, out: &mut [u64]) {
    out.iter_mut().for_each(|w| *w = 0);
    for (x, &c) in row_class.iter().enumerate() {
        if blocked(c, tier) {
            out[x >> 6] |= 1u64 << (x & 63);
        }
    }
    let w = row_class.len();
    for x in w..out.len() * 64 {
        out[x >> 6] |= 1u64 << (x & 63);
    }
}

/// First blocked cell in `lo..=hi`.
#[inline]
fn first_set(row: &[u64], lo: usize, hi: usize) -> Option<usize> {
    let (wl, wh) = (lo >> 6, hi >> 6);
    for wi in wl..=wh {
        let mut word = row[wi];
        if wi == wl {
            word &= !0u64 << (lo & 63);
        }
        if wi == wh && (hi & 63) != 63 {
            word &= (1u64 << ((hi & 63) + 1)) - 1;
        }
        if word != 0 {
            return Some((wi << 6) + word.trailing_zeros() as usize);
        }
    }
    None
}

/// First free cell at or after `x` (the row length when there is none).
#[inline]
fn first_free(row: &[u64], x: usize) -> usize {
    let mut wi = x >> 6;
    if wi >= row.len() {
        return row.len() * 64;
    }
    let mut word = !row[wi] & (!0u64 << (x & 63));
    loop {
        if word != 0 {
            return (wi << 6) + word.trailing_zeros() as usize;
        }
        wi += 1;
        if wi >= row.len() {
            return row.len() * 64;
        }
        word = !row[wi];
    }
}

#[inline]
fn set_bits(row: &mut [u64], lo: usize, hi: usize) {
    let (wl, wh) = (lo >> 6, hi >> 6);
    for wi in wl..=wh {
        let mut m = !0u64;
        if wi == wl {
            m &= !0u64 << (lo & 63);
        }
        if wi == wh && (hi & 63) != 63 {
            m &= (1u64 << ((hi & 63) + 1)) - 1;
        }
        row[wi] |= m;
    }
}

struct Ctx<'a> {
    hide: &'a Hide,
    res: f64,
    grow: usize,
    edge_k: usize,
    flaw_k: usize,
}

/// The leather rasterised once, in its own orientation.
struct Base {
    origin: Vec2,
    w: usize,
    h: usize,
    class: Vec<u8>,
    has: [bool; 3],
    usable_cells: usize,
}

fn build_base(ctx: &Ctx) -> Base {
    let res = ctx.res;
    let outline = &ctx.hide.outline;
    let b = Rect::of(outline);
    let pad = 2.0 * res;
    let origin = b.min - v(pad, pad);
    let w = ((b.width() + 2.0 * pad) / res).ceil() as usize + 1;
    let h = ((b.height() + 2.0 * pad) / res).ceil() as usize + 1;
    // Usable: cell centre inside and no edge through the cell.
    let mut inside = Bitmap::new(w, h);
    inside.fill_centres(outline, origin, res, 1);
    inside.mark_edges(outline, origin, res, 0);
    let mut outside = Bitmap { w, h, bits: inside.bits.iter().map(|&c| (c == 0) as u8).collect() };
    outside.dilate(ctx.edge_k);
    let mut major = Bitmap::new(w, h);
    let mut minor = Bitmap::new(w, h);
    for f in &ctx.hide.flaws {
        let poly = f.polygon();
        let bm = if f.blocks_everything() { &mut major } else { &mut minor };
        bm.fill_centres(&poly, origin, res, 1);
        bm.mark_edges(&poly, origin, res, 1);
    }
    major.dilate(ctx.flaw_k);
    minor.dilate(ctx.flaw_k);
    // Grades: paint zones last to first so the first listed zone wins.
    let mut grade = Bitmap::new(w, h);
    if !ctx.hide.zones.is_empty() {
        grade.bits.iter_mut().for_each(|c| *c = 2);
        for z in ctx.hide.zones.iter().rev() {
            grade.fill_centres(&z.polygon, origin, res, z.grade as u8);
        }
    }
    let mut class = vec![0u8; w * h];
    let (mut has_b, mut has_c, mut has_minor, mut usable) = (false, false, false, 0usize);
    for i in 0..w * h {
        let mut c = grade.bits[i];
        if outside.bits[i] != 0 || major.bits[i] != 0 {
            c |= OUT;
        } else {
            usable += 1;
            if minor.bits[i] != 0 {
                c |= MINOR;
                has_minor = true;
            }
            has_b |= grade.bits[i] == 1;
            has_c |= grade.bits[i] == 2;
        }
        class[i] = c;
    }
    Base { origin, w, h, class, has: [has_b, has_c, has_minor], usable_cells: usable }
}

/// The base grid seen through one of the square's symmetries (cells map exactly onto cells),
/// with its tier bitmaps and the piece rasters for that orientation.
fn build_world(ctx: &Ctx, shapes: &[Shape], base: &Base, t: [f64; 4]) -> World {
    let res = ctx.res;
    let (bw, bh) = (base.w, base.h);
    let swap = t[0] == 0.0;
    let (w, h) = if swap { (bh, bw) } else { (bw, bh) };
    let corners = [base.origin, base.origin + v(bw as f64 * res, 0.0), base.origin + v(0.0, bh as f64 * res), base.origin + v(bw as f64 * res, bh as f64 * res)];
    let origin = Rect::of(&corners.iter().map(|&c| tf(&t, c)).collect::<Vec<_>>()).min;
    let axis = |coef_i: f64, coef_j: f64, i: usize, j: usize| -> usize {
        if coef_i > 0.0 {
            i
        } else if coef_i < 0.0 {
            bw - 1 - i
        } else if coef_j > 0.0 {
            j
        } else {
            bh - 1 - j
        }
    };
    let class = if t == TRANSFORMS[0] {
        base.class.clone()
    } else {
        let mut c = vec![0u8; w * h];
        for j in 0..bh {
            for i in 0..bw {
                let (ni, nj) = (axis(t[0], t[1], i, j), axis(t[2], t[3], i, j));
                c[nj * w + ni] = base.class[j * bw + i];
            }
        }
        c
    };
    let [has_b, has_c, has_minor] = base.has;
    // Tiers that would give identical tables share one.
    let mut tier_table = [0usize; 4];
    let wpr = w.div_ceil(64);
    let mut tables: Vec<Vec<u64>> = Vec::new();
    for tier in 0..4 {
        let same_as_prev = match tier {
            1 => !has_b,
            2 => !has_c,
            3 => !has_minor,
            _ => false,
        };
        if same_as_prev {
            tier_table[tier] = tier_table[tier - 1];
        } else {
            let mut tab = vec![0u64; wpr * h];
            for y in 0..h {
                bit_row(&class[y * w..(y + 1) * w], tier, &mut tab[y * wpr..(y + 1) * wpr]);
            }
            tables.push(tab);
            tier_table[tier] = tables.len() - 1;
        }
    }
    let rasters = shapes.iter().map(|s| s.variants.iter().map(|&(a, m)| raster_piece(&s.poly, a, m, &t, res, ctx.grow)).collect()).collect();
    World { t, origin, w, h, wpr, class, tables, tier_table, rasters }
}

/// First position (row-major from the top-left) where the raster fits, starting at `start`.
/// A blocked span moves the candidate past the blocked run it hit.
fn find(tab: &[u64], wpr: usize, w: usize, h: usize, r: &Raster, start: (usize, usize), hint: &mut usize) -> Option<(usize, usize)> {
    if r.w > w || r.h > h || r.spans.is_empty() {
        return None;
    }
    let n = r.spans.len();
    let mut y = start.0;
    let mut x = start.1;
    while y + r.h <= h {
        'cand: while x + r.w <= w {
            for k in 0..n {
                let idx = (*hint + k) % n;
                let (sr, a, b) = r.spans[idx];
                let row = &tab[(y + sr as usize) * wpr..(y + sr as usize + 1) * wpr];
                if let Some(bx) = first_set(row, x + a as usize, x + b as usize) {
                    *hint = idx;
                    x = first_free(row, bx) - a as usize;
                    continue 'cand;
                }
            }
            return Some((y, x));
        }
        y += 1;
        x = 0;
    }
    None
}

#[derive(Clone, Copy)]
struct Inst {
    shape: usize,
    item: u32,
    copy: u32,
    mirrored: bool,
}

#[derive(Clone)]
struct Placed {
    inst: Inst,
    variant: usize,
    y: usize,
    x: usize,
}

#[derive(Clone)]
struct Layout {
    world: usize,
    placed: Vec<Placed>,
    failed: Vec<Inst>,
}

fn run_pass(world: &World, shapes: &[Shape], order: &[Inst], stop_on_fail: bool) -> (Vec<Placed>, Vec<Inst>) {
    let mut tables = world.tables.clone();
    let (w, h, wpr) = (world.w, world.h, world.wpr);
    // Per (shape, variant, table): where the last search ended (feasibility only shrinks as
    // pieces go down) or None once nothing fits.
    let nt = tables.len();
    let offsets: Vec<usize> = shapes
        .iter()
        .scan(0usize, |acc, s| {
            let o = *acc;
            *acc += s.variants.len() * nt;
            Some(o)
        })
        .collect();
    let total: usize = shapes.iter().map(|s| s.variants.len() * nt).sum();
    let mut cache: Vec<Option<(usize, usize)>> = vec![Some((0, 0)); total];
    let mut hints = vec![0usize; total];
    let mut placed = Vec::new();
    let mut failed = Vec::new();
    for &inst in order {
        let s = &shapes[inst.shape];
        let tiers: &[usize] = if s.visible { &[0, 1, 2] } else { &[3] };
        let mut best: Option<(usize, usize, usize, usize)> = None; // (bottom, x, variant, y)
        let mut tried_tables: Vec<usize> = Vec::new();
        for &tier in tiers {
            let ti = world.tier_table[tier];
            if tried_tables.contains(&ti) {
                continue;
            }
            tried_tables.push(ti);
            for (vi, &(_, m)) in s.variants.iter().enumerate() {
                if m != inst.mirrored {
                    continue;
                }
                let key = offsets[inst.shape] + vi * nt + ti;
                let Some(start) = cache[key] else { continue };
                let r = &world.rasters[inst.shape][vi];
                let found = find(&tables[ti], wpr, w, h, r, start, &mut hints[key]);
                cache[key] = found;
                if let Some((y, x)) = found {
                    let cand = (y + r.h, x, vi, y);
                    if best.is_none_or(|b| (cand.0, cand.1) < (b.0, b.1)) {
                        best = Some(cand);
                    }
                }
            }
            if best.is_some() {
                break;
            }
        }
        match best {
            Some((_, x, vi, y)) => {
                let r = &world.rasters[inst.shape][vi];
                for &(sr, a, b) in &r.spans {
                    let row = y + sr as usize;
                    for tab in tables.iter_mut() {
                        set_bits(&mut tab[row * wpr..(row + 1) * wpr], x + a as usize, x + b as usize);
                    }
                }
                placed.push(Placed { inst, variant: vi, y, x });
            }
            None => {
                failed.push(inst);
                if stop_on_fail {
                    break;
                }
            }
        }
    }
    (placed, failed)
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn instances(shapes: &[Shape], sets: u32, mirror: bool) -> Vec<Inst> {
    let mut out = Vec::new();
    for item in 1..=sets {
        for (si, s) in shapes.iter().enumerate() {
            for c in 0..s.per_set {
                out.push(Inst { shape: si, item, copy: c, mirrored: mirror && s.per_set >= 2 && c % 2 == 1 });
            }
        }
    }
    out
}

/// Visible parts first, then biggest first; `jitter` scales areas randomly to vary the order.
fn order(shapes: &[Shape], mut insts: Vec<Inst>, rng: Option<&mut Rng>) -> Vec<Inst> {
    let mut keys: Vec<f64> = shapes.iter().map(|s| s.area).collect();
    if let Some(r) = rng {
        for k in &mut keys {
            *k *= 0.6 + 0.8 * r.unit();
        }
    }
    insts.sort_by(|a, b| {
        let (sa, sb) = (&shapes[a.shape], &shapes[b.shape]);
        sb.visible
            .cmp(&sa.visible)
            .then(keys[b.shape].partial_cmp(&keys[a.shape]).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.shape.cmp(&b.shape))
            .then(a.item.cmp(&b.item))
            .then(a.copy.cmp(&b.copy))
    });
    insts
}

/// Items with every piece placed, renumbered from 1, and the placements of those items only.
fn complete(shapes: &[Shape], placed: &[Placed]) -> (u32, Vec<Placed>) {
    let need: u32 = shapes.iter().map(|s| s.per_set).sum();
    let mut counts: std::collections::BTreeMap<u32, u32> = Default::default();
    for p in placed {
        *counts.entry(p.inst.item).or_default() += 1;
    }
    let done: Vec<u32> = counts.iter().filter(|(_, &c)| c == need).map(|(&i, _)| i).collect();
    let out = placed
        .iter()
        .filter_map(|p| {
            done.iter().position(|&i| i == p.inst.item).map(|k| {
                let mut q = p.clone();
                q.inst.item = k as u32 + 1;
                q
            })
        })
        .collect();
    (done.len() as u32, out)
}

fn spread(world: &World, placed: &[Placed]) -> f64 {
    let mut r = Rect::empty();
    for p in placed {
        let ras = &world.rasters[p.inst.shape][p.variant];
        r.include(v(p.x as f64, p.y as f64));
        r.include(v((p.x + ras.w) as f64, (p.y + ras.h) as f64));
    }
    if r.is_empty() {
        0.0
    } else {
        r.width() * r.height()
    }
}

fn plural(name: &str, n: u32) -> String {
    let mut s = name.trim().to_string();
    let mut chars = s.chars();
    if let (Some(a), Some(b)) = (chars.next(), chars.next()) {
        if a.is_uppercase() && b.is_lowercase() {
            s = a.to_lowercase().collect::<String>() + &s[a.len_utf8()..];
        }
    }
    if s.is_empty() {
        s = "item".into();
    }
    if n == 1 {
        return s;
    }
    let lower = s.to_lowercase();
    if lower.ends_with('s') || lower.ends_with('x') || lower.ends_with("ch") || lower.ends_with("sh") {
        s + "es"
    } else if lower.ends_with('y') && !lower.ends_with("ay") && !lower.ends_with("ey") && !lower.ends_with("oy") {
        s[..s.len() - 1].to_string() + "ies"
    } else {
        s + "s"
    }
}

fn hide_label(hide: &Hide) -> String {
    let n = hide.name.trim();
    if n.is_empty() {
        return match hide.kind {
            HideKind::Panel => "panel".into(),
            _ => "leather".into(),
        };
    }
    let mut c = n.chars();
    match (c.next(), c.next()) {
        (Some(a), Some(b)) if a.is_uppercase() && b.is_lowercase() => a.to_lowercase().collect::<String>() + &n[a.len_utf8()..],
        _ => n.to_string(),
    }
}

/// Lay the project's pieces out on the leather.
pub fn nest(project: &Project, computed: &ComputedProject, hide: &Hide, opts: &NestOptions) -> Result<NestResult, String> {
    let started = Instant::now();
    let budget = std::time::Duration::from_millis(opts.time_ms.clamp(50, 60_000));
    let hide = hide.normalized();
    let hide_area = hide.area_mm2();
    if hide.outline.len() < 3 || hide_area < 100.0 {
        return Err("The leather needs an outline around some area.".into());
    }
    let material = pick_material(project, computed, opts.material_id.as_deref()).ok_or("The pattern has no pieces to lay out.")?;
    let backbone = hide.backbone_deg();
    let mut shapes = build_shapes(project, computed, &material, backbone, opts);
    if shapes.is_empty() {
        return Err("No pieces of that material to lay out.".into());
    }
    let b = hide.bounds();
    let res = if opts.resolution_mm > 0.0 {
        opts.resolution_mm.clamp(0.25, 20.0)
    } else {
        (b.width() * b.height() / 4.0e6).sqrt().max(1.0)
    };
    // Keep grids to a sensible size for very large leather.
    let res = res.max(b.width().max(b.height()) / 30_000.0);
    let half_gap = opts.spacing_mm.max(0.0) / 2.0;
    let cells = |mm: f64| (mm.max(0.0) / res - 1e-9).ceil() as usize;
    let ctx = Ctx { hide: &hide, res, grow: cells(half_gap), edge_k: cells(opts.edge_margin_mm - half_gap), flaw_k: cells(opts.flaw_margin_mm - half_gap) };
    let mut worlds: Vec<Option<World>> = (0..8).map(|_| None).collect();
    let mut rng = Rng(opts.seed.max(1).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut runs = 0u32;
    let base = build_base(&ctx);
    let mut notes = Vec::new();
    // A grain-bound piece that cannot follow the backbone anywhere on this leather (a gusset
    // longer than a shoulder is deep) is allowed to turn, and the maker is told.
    if shapes.iter().any(|s| s.grain.is_some()) {
        let w0 = build_world(&ctx, &shapes, &base, TRANSFORMS[0]);
        let ti = w0.tier_table[3];
        let mut turned = Vec::new();
        for (si, s) in shapes.iter_mut().enumerate() {
            if s.grain.is_none() {
                continue;
            }
            let fits = w0.rasters[si].iter().any(|r| find(&w0.tables[ti], w0.wpr, w0.w, w0.h, r, (0, 0), &mut 0).is_some());
            if !fits {
                s.grain = None;
                s.variants = variants_for(None, backbone, s.per_set, opts);
                turned.push(s.name.clone());
            }
        }
        if !turned.is_empty() {
            notes.push(format!("{} {} too long to run along the backbone on this leather, so {} laid across it.", turned.join(", "), if turned.len() == 1 { "is" } else { "are" }, if turned.len() == 1 { "it is" } else { "they are" }));
        }
    }
    let shapes = shapes;
    let get_world = |worlds: &mut Vec<Option<World>>, k: usize| {
        if worlds[k].is_none() {
            worlds[k] = Some(build_world(&ctx, &shapes, &base, TRANSFORMS[k]));
        }
    };
    get_world(&mut worlds, 0);
    let usable_area = base.usable_cells as f64 * res * res;
    let set_area: f64 = shapes.iter().map(|s| s.area * s.per_set as f64).sum();
    let mirror = opts.mirror_pairs;

    let mut best: Option<Layout> = None;
    let mut best_items = 0u32;
    let sets_requested = opts.sets;
    if opts.sets == 0 {
        let hi = ((usable_area / set_area).floor() as u32).clamp(1, opts.max_sets.max(1));
        // Greedy fill for a first count.
        get_world(&mut worlds, 0);
        let (placed, failed) = run_pass(worlds[0].as_ref().unwrap(), &shapes, &order(&shapes, instances(&shapes, hi, mirror), None), false);
        runs += 1;
        let (n, kept) = complete(&shapes, &placed);
        best_items = n;
        best = Some(Layout { world: 0, placed: kept, failed });
        // Can `n` complete sets be laid out? Tries `tries` layouts (corners first, then shuffled
        // orders), each abandoned at its first piece that does not fit.
        let mut attempt_no = 0usize;
        let mut try_sets = |n: u32, tries: usize, worlds: &mut Vec<Option<World>>, runs: &mut u32| -> Option<Layout> {
            let insts = instances(&shapes, n, mirror);
            for i in 0..tries {
                if started.elapsed() > budget {
                    return None;
                }
                let k = (attempt_no + i) % 8;
                get_world(worlds, k);
                let world = worlds[k].as_ref().unwrap();
                let ord = if i < 8 { order(&shapes, insts.clone(), None) } else { order(&shapes, insts.clone(), Some(&mut rng)) };
                let (placed, failed) = run_pass(world, &shapes, &ord, true);
                *runs += 1;
                if failed.is_empty() {
                    attempt_no += i;
                    return Some(Layout { world: k, placed, failed });
                }
            }
            None
        };
        // Binary search between what fits and the area limit, a few layouts per count...
        let mut fails = hi + 1;
        while best_items + 1 < fails && started.elapsed() < budget {
            let n = (best_items + fails) / 2;
            match try_sets(n, 4, &mut worlds, &mut runs) {
                Some(l) => {
                    best_items = n;
                    best = Some(l);
                }
                None => fails = n,
            }
        }
        // ...then keep trying one more with the time left.
        while best_items < hi && started.elapsed() < budget {
            match try_sets(best_items + 1, 64, &mut worlds, &mut runs) {
                Some(l) => {
                    best_items += 1;
                    best = Some(l);
                }
                None => break,
            }
        }
    }
    if best_items == 0 {
        // Fixed number of sets (or not even one complete set fits): best partial layout.
        let sets = opts.sets.max(1);
        let insts = instances(&shapes, sets, mirror);
        let mut best_key: Option<(f64, f64)> = None;
        best = None;
        for attempt in 0..64usize {
            if attempt > 0 && started.elapsed() > budget {
                break;
            }
            let k = attempt % 8;
            get_world(&mut worlds, k);
            let world = worlds[k].as_ref().unwrap();
            let ord = if attempt < 8 { order(&shapes, insts.clone(), None) } else { order(&shapes, insts.clone(), Some(&mut rng)) };
            let (placed, failed) = run_pass(world, &shapes, &ord, false);
            runs += 1;
            let area: f64 = placed.iter().map(|p| shapes[p.inst.shape].area).sum();
            let key = (area, -spread(world, &placed));
            if best_key.is_none_or(|b| key.0 > b.0 + 1e-6 || ((key.0 - b.0).abs() <= 1e-6 && key.1 > b.1)) {
                best_key = Some(key);
                best = Some(Layout { world: k, placed, failed });
            }
            if attempt >= 7 && best.as_ref().is_some_and(|b| b.failed.is_empty()) {
                break;
            }
        }
        let l = best.as_ref().unwrap();
        best_items = if l.failed.is_empty() { sets } else { complete(&shapes, &l.placed).0 };
    }
    let layout = best.unwrap();
    let world = worlds[layout.world].as_ref().unwrap();

    // Placements in hide coordinates.
    let mut placements = Vec::new();
    for p in &layout.placed {
        let s = &shapes[p.inst.shape];
        let (angle, mirrored) = s.variants[p.variant];
        let r = &world.rasters[p.inst.shape][p.variant];
        let t_world = world.origin + v(p.x as f64 * res, p.y as f64 * res) + r.shift;
        let offset = tf_inv(&world.t, t_world);
        let outline: Vec<Vec2> = s.poly.iter().map(|&q| place_point(q, angle, mirrored) + offset).collect();
        let mut g = 0u8;
        for &(sr, a, b) in &r.spans {
            let row = (p.y + sr as usize) * world.w;
            for x in (p.x + a as usize)..=(p.x + b as usize) {
                let c = world.class[row + x];
                if c & OUT == 0 {
                    g = g.max(c & 3);
                }
            }
        }
        let grade = match g {
            0 => Grade::A,
            1 => Grade::B,
            _ => Grade::C,
        };
        placements.push(Placement {
            piece_id: s.id.clone(),
            name: s.name.clone(),
            item: p.inst.item,
            copy: p.inst.copy,
            angle_deg: angle,
            mirrored,
            offset,
            outline,
            grade,
            visible: s.visible,
            area_mm2: s.area,
            shape: p.inst.shape,
        });
    }
    placements.sort_by(|a, b| a.item.cmp(&b.item).then(a.shape.cmp(&b.shape)).then(a.copy.cmp(&b.copy)));
    let mut unplaced: Vec<Unplaced> = Vec::new();
    if sets_requested > 0 || best_items == 0 {
        for f in &layout.failed {
            let s = &shapes[f.shape];
            let too_big = world.rasters[f.shape].iter().all(|r| r.w > world.w || r.h > world.h);
            let reason = if too_big { "bigger than this leather" } else { "no room left that is clear of flaws and the edge" };
            match unplaced.iter_mut().find(|u| u.piece_id == s.id) {
                Some(u) => u.count += 1,
                None => unplaced.push(Unplaced { piece_id: s.id.clone(), name: s.name.clone(), count: 1, reason: reason.into() }),
            }
        }
    }
    let used: f64 = placements.iter().map(|p| p.area_mm2).sum();
    let waste = (hide_area - used).max(0.0);
    let yield_pct = 100.0 * used / hide_area;
    let leftover_pct = 100.0 - yield_pct;
    let item = if project.name.trim().is_empty() { "item".to_string() } else { project.name.clone() };
    let label = hide_label(&hide);
    let sentence = if best_items == 0 {
        let missing: Vec<String> = unplaced.iter().map(|u| u.name.clone()).collect();
        format!("This {label} is too small for one complete {}: {} will not fit.", plural(&item, 1), missing.join(", "))
    } else if sets_requested == 0 {
        format!("This {label} fits {best_items} complete {} with {:.0}% left over.", plural(&item, best_items), leftover_pct)
    } else if unplaced.is_empty() {
        format!("All the pieces for {best_items} {} fit on this {label} with {:.0}% left over.", plural(&item, best_items), leftover_pct)
    } else {
        let n: u32 = unplaced.iter().map(|u| u.count).sum();
        format!("{n} piece{} will not fit on this {label}: {}.", if n == 1 { "" } else { "s" }, unplaced.iter().map(|u| u.name.clone()).collect::<Vec<_>>().join(", "))
    };
    if shapes.iter().any(|s| s.grain.is_some()) {
        let names: Vec<&str> = shapes.iter().filter(|s| s.grain.is_some()).map(|s| s.name.as_str()).collect();
        notes.push(format!("{} {} along the backbone.", names.join(", "), if names.len() == 1 { "runs" } else { "run" }));
    }
    let low: Vec<String> = placements.iter().filter(|p| p.visible && p.grade == Grade::C).map(|p| format!("{} (item {})", p.name, p.item)).collect();
    if !low.is_empty() {
        let more = if low.len() > 4 { format!(" and {} more", low.len() - 4) } else { String::new() };
        notes.push(format!(
            "{} outside {} on belly (grade C) leather: {}{more}. Check {} before cutting.",
            low.len(),
            if low.len() == 1 { "part is" } else { "parts are" },
            low[..low.len().min(4)].join(", "),
            if low.len() == 1 { "it" } else { "them" }
        ));
    }
    if backbone.is_none() && opts.grain != GrainMode::None {
        notes.push("This leather has no backbone marked, so pieces may turn any way.".into());
    }
    let material_name = project.material(&material).map_or_else(|| if material == "*" { "All materials".into() } else { material.clone() }, |m| m.name.clone());
    let pieces = shapes
        .iter()
        .map(|s| NestPiece { piece_id: s.id.clone(), name: s.name.clone(), per_set: s.per_set, area_mm2: s.area, visible: s.visible, follows_backbone: s.grain.is_some() })
        .collect();
    let mut result = NestResult {
        hide_name: hide.name.clone(),
        material_id: material,
        material_name,
        pieces,
        placements,
        unplaced,
        complete_items: best_items,
        sets_requested,
        hide_area_mm2: hide_area,
        usable_area_mm2: usable_area,
        used_area_mm2: used,
        waste_area_mm2: waste,
        yield_pct,
        leftover_pct,
        item_area_mm2: set_area,
        leather_per_item_mm2: if best_items > 0 { hide_area / best_items as f64 } else { 0.0 },
        sentence,
        notes,
        runs,
        elapsed_ms: started.elapsed().as_millis() as u64,
        resolution_mm: res,
        svg: None,
    };
    if opts.include_svg {
        result.svg = Some(layout_svg(&hide, &result));
    }
    Ok(result)
}

const PALETTE: [&str; 10] = ["#7aa6d8", "#e0a458", "#8cc084", "#d47f8c", "#b49ad8", "#6cc4c0", "#d8c35a", "#c98d6b", "#9fb2c4", "#e58f5a"];

fn path_d(pts: &[Vec2]) -> String {
    let mut d = String::with_capacity(pts.len() * 16);
    for (i, p) in pts.iter().enumerate() {
        d.push_str(if i == 0 { "M" } else { "L" });
        d.push_str(&format!("{:.1} {:.1}", p.x, p.y));
    }
    d.push('Z');
    d
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The cutting layout as an SVG drawing in millimetres: leather, zones, flaws, backbone, each
/// piece coloured by kind and numbered by item, a 100 mm scale bar and the summary sentence.
pub fn layout_svg(hide: &Hide, r: &NestResult) -> String {
    let hide = hide.normalized();
    let b = hide.bounds();
    let m = 20.0;
    let head = 40.0;
    let (w, h) = (b.width() + 2.0 * m, b.height() + 2.0 * m + head);
    let mut s = String::new();
    s.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w:.1}mm\" height=\"{h:.1}mm\" viewBox=\"{:.1} {:.1} {w:.1} {h:.1}\" font-family=\"Georgia, serif\">",
        b.min.x - m,
        b.min.y - m - head
    ));
    s.push_str(&format!("<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"14\" fill=\"#2b1d0e\">{}</text>", b.min.x, b.min.y - head + 10.0, esc(&r.sentence)));
    s.push_str(&format!(
        "<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"9\" fill=\"#5a4630\">{} · {:.1} sq ft ({:.2} m²) · yield {:.0}%</text>",
        b.min.x,
        b.min.y - head + 24.0,
        esc(&r.hide_name),
        r.hide_area_mm2 / MM2_PER_SQFT,
        r.hide_area_mm2 / MM2_PER_M2,
        r.yield_pct
    ));
    s.push_str(&format!("<path d=\"{}\" fill=\"#efe2c4\" stroke=\"#2b1d0e\" stroke-width=\"1\"/>", path_d(&hide.outline)));
    for z in &hide.zones {
        let (fill, label) = match z.grade {
            Grade::A => continue,
            Grade::B => ("#d9c9a3", "B"),
            Grade::C => ("#c9b48a", "C"),
        };
        let _ = label;
        s.push_str(&format!("<path d=\"{}\" fill=\"{fill}\" fill-opacity=\"0.45\" stroke=\"none\"/>", path_d(&z.polygon)));
    }
    // Paint A zones back on top so the order (first zone wins) reads right.
    for z in hide.zones.iter().filter(|z| z.grade == Grade::A) {
        s.push_str(&format!("<path d=\"{}\" fill=\"#efe2c4\" stroke=\"#8a7a5a\" stroke-width=\"0.6\" stroke-dasharray=\"6 4\"/>", path_d(&z.polygon)));
    }
    if let Some(bb) = hide.backbone {
        s.push_str(&format!(
            "<line x1=\"{:.1}\" y1=\"{:.1}\" x2=\"{:.1}\" y2=\"{:.1}\" stroke=\"#8a2620\" stroke-width=\"1\" stroke-dasharray=\"12 6\"/>",
            bb.from.x, bb.from.y, bb.to.x, bb.to.y
        ));
    }
    for f in &hide.flaws {
        let fill = if f.blocks_everything() { "#c0392b" } else { "#e67e22" };
        s.push_str(&format!("<path d=\"{}\" fill=\"{fill}\" fill-opacity=\"0.55\" stroke=\"{fill}\" stroke-width=\"0.8\"/>", path_d(&f.polygon())));
    }
    for p in &r.placements {
        let col = PALETTE[p.shape % PALETTE.len()];
        s.push_str(&format!("<path d=\"{}\" fill=\"{col}\" fill-opacity=\"0.75\" stroke=\"#1b120a\" stroke-width=\"0.7\"/>", path_d(&p.outline)));
        let c = Rect::of(&p.outline);
        let fs = (c.width().min(c.height()) * 0.35).clamp(6.0, 28.0);
        s.push_str(&format!(
            "<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"{fs:.1}\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"#1b120a\">{}</text>",
            c.center().x,
            c.center().y,
            p.item
        ));
    }
    let (sx, sy) = (b.max.x - 100.0, b.max.y + m * 0.6);
    s.push_str(&format!("<rect x=\"{sx:.1}\" y=\"{sy:.1}\" width=\"100\" height=\"4\" fill=\"#2b1d0e\"/>"));
    s.push_str(&format!("<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"8\" text-anchor=\"end\" fill=\"#2b1d0e\">100 mm</text>", sx - 3.0, sy + 4.0));
    s.push_str("</svg>");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::compute;
    use crate::hide::{preset, Flaw, FlawKind, Severity};

    fn seg_dist(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> f64 {
        let cross = |o: Vec2, p: Vec2, q: Vec2| (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
        let (d1, d2, d3, d4) = (cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d));
        if ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0)) {
            return 0.0;
        }
        let pt = |p: Vec2, a: Vec2, b: Vec2| {
            let ab = b - a;
            let t = ((p - a).dot(ab) / ab.dot(ab).max(1e-12)).clamp(0.0, 1.0);
            p.dist(a + ab * t)
        };
        pt(a, c, d).min(pt(b, c, d)).min(pt(c, a, b)).min(pt(d, a, b))
    }

    fn poly_dist(p: &[Vec2], q: &[Vec2]) -> f64 {
        let (bp, bq) = (Rect::of(p), Rect::of(q));
        let gap = (bq.min.x - bp.max.x).max(bp.min.x - bq.max.x).max(bq.min.y - bp.max.y).max(bp.min.y - bq.max.y);
        if gap > 50.0 {
            return gap;
        }
        if crate::hide::point_in_polygon(p[0], q) || crate::hide::point_in_polygon(q[0], p) {
            return 0.0;
        }
        let mut m = f64::INFINITY;
        for i in 0..p.len() {
            for j in 0..q.len() {
                m = m.min(seg_dist(p[i], p[(i + 1) % p.len()], q[j], q[(j + 1) % q.len()]));
            }
        }
        m
    }

    fn boundary_dist(p: &[Vec2], q: &[Vec2]) -> f64 {
        let mut m = f64::INFINITY;
        for i in 0..p.len() {
            for j in 0..q.len() {
                m = m.min(seg_dist(p[i], p[(i + 1) % p.len()], q[j], q[(j + 1) % q.len()]));
            }
        }
        m
    }

    /// Every placement inside the leather by the edge margin, clear of flaws, and spaced.
    fn check_layout(hide: &Hide, r: &NestResult, o: &NestOptions) {
        let hide = hide.normalized();
        for (i, p) in r.placements.iter().enumerate() {
            assert!(p.outline.iter().all(|&q| crate::hide::point_in_polygon(q, &hide.outline)), "{} outside the hide", p.name);
            let e = boundary_dist(&p.outline, &hide.outline);
            assert!(e >= o.edge_margin_mm - 1e-6, "{} is {e} mm from the edge", p.name);
            for f in &hide.flaws {
                let d = poly_dist(&p.outline, &f.polygon());
                assert!(d >= o.flaw_margin_mm - 1e-6 || (!f.blocks_everything() && !p.visible), "{} item {} is {d} mm from a flaw", p.name, p.item);
            }
            for q in &r.placements[i + 1..] {
                let d = poly_dist(&p.outline, &q.outline);
                assert!(d >= o.spacing_mm - 1e-6, "{} and {} are {d} mm apart", p.name, q.name);
            }
        }
    }

    fn rect_project(name: &str, pieces: &[(&str, f64, f64, u32)]) -> Project {
        let mut p = crate::templates::blank();
        p.name = name.into();
        for (i, &(n, w, h, count)) in pieces.iter().enumerate() {
            let mut pc = crate::generators::panel(&format!("p{i}"), n, "m1", w, h);
            pc.cut_count = count;
            p.pieces.push(pc);
        }
        p
    }

    #[test]
    fn nest_rectangles_on_a_panel() {
        // 12 x 12 in panel: 100 x 60 mm pieces with 3 mm gaps and 5 mm margins leave a 294.8 mm
        // square: a 2 x 4 grid plus a rotated column of 2 beside it makes 10.
        let p = rect_project("Card sleeve", &[("Sleeve", 100.0, 60.0, 1)]);
        let c = compute(&p);
        let hide = preset("panel-12x12").unwrap();
        let o = NestOptions { time_ms: 800, ..Default::default() };
        let r = nest(&p, &c, &hide, &o).unwrap();
        assert!(r.complete_items >= 10, "{}", r.sentence);
        assert_eq!(r.placements.len() as u32, r.complete_items);
        check_layout(&hide, &r, &o);
        assert!(r.sentence.contains("card sleeves"), "{}", r.sentence);
        assert!(r.yield_pct > 60.0 && r.yield_pct < 100.0);
    }

    #[test]
    fn nest_avoids_flaws_and_keeps_straps_on_the_backbone() {
        let p = rect_project("Bifold", &[("Outer", 220.0, 95.0, 1), ("Card pocket", 100.0, 70.0, 2), ("Lining", 210.0, 90.0, 1), ("Strap", 300.0, 20.0, 1)]);
        let c = compute(&p);
        let mut hide = preset("side").unwrap();
        let b = hide.bounds();
        for (fx, fy, r, sev) in [(0.2, 0.2, 40.0, Severity::Major), (0.5, 0.3, 25.0, Severity::Major), (0.7, 0.15, 60.0, Severity::Minor), (0.35, 0.6, 30.0, Severity::Major)] {
            hide.flaws.push(Flaw::circle(FlawKind::Scar, v(b.min.x + fx * b.width(), b.min.y + fy * b.height()), r, sev));
        }
        hide.flaws.push(Flaw::circle(FlawKind::Hole, v(b.min.x + 0.45 * b.width(), b.min.y + 0.45 * b.height()), 8.0, Severity::Minor));
        let o = NestOptions { time_ms: 1500, include_svg: true, ..Default::default() };
        let t = Instant::now();
        let r = nest(&p, &c, &hide, &o).unwrap();
        let ms = t.elapsed().as_millis();
        assert!(r.complete_items >= 25, "{}", r.sentence);
        check_layout(&hide, &r, &o);
        for pl in r.placements.iter().filter(|p| p.name == "Strap") {
            let a = pl.angle_deg.rem_euclid(180.0);
            assert!(a.min(180.0 - a) <= 10.0, "strap at {}", pl.angle_deg);
        }
        // The pair of card pockets is cut as a left and a right.
        assert!(r.placements.iter().any(|p| p.name == "Card pocket" && p.mirrored));
        // Outside parts get the best leather first: the first item's outer is on grade A.
        assert_eq!(r.placements.iter().find(|p| p.name == "Outer" && p.item == 1).unwrap().grade, Grade::A);
        assert!(r.svg.as_ref().unwrap().contains("<svg"));
        assert!(ms < 2500, "{ms} ms");
        eprintln!("bifold on a flawed side: {} in {} ms over {} runs, yield {:.1}%", r.sentence, ms, r.runs, r.yield_pct);
    }

    #[test]
    fn nest_fixed_set_reports_unplaced() {
        let p = rect_project("Big tote", &[("Body", 500.0, 400.0, 2), ("Strap", 900.0, 30.0, 1)]);
        let c = compute(&p);
        let hide = preset("panel-12x24").unwrap();
        let o = NestOptions { sets: 1, time_ms: 300, ..Default::default() };
        let r = nest(&p, &c, &hide, &o).unwrap();
        assert_eq!(r.complete_items, 0);
        assert!(r.unplaced.iter().any(|u| u.name == "Body" && u.count == 2 && u.reason.contains("bigger")), "{:?}", r.unplaced);
        assert!(r.sentence.contains("too small"), "{}", r.sentence);
    }

    #[test]
    fn nest_templates_on_a_double_shoulder() {
        let hide = preset("double-shoulder").unwrap();
        for id in ["card-wallet", "tote"] {
            let p = crate::templates::by_id(id).unwrap();
            let c = compute(&p);
            let o = NestOptions { time_ms: 1500, ..Default::default() };
            let t = Instant::now();
            let r = nest(&p, &c, &hide, &o).unwrap();
            let ms = t.elapsed().as_millis();
            check_layout(&hide, &r, &o);
            assert!(r.complete_items >= 1, "{id}: {}", r.sentence);
            assert!(ms < 2500, "{id}: {ms} ms");
            eprintln!("{id} on a double shoulder: {} ({} pieces/set, yield {:.1}%, {} runs, {} ms)", r.sentence, r.pieces.iter().map(|p| p.per_set).sum::<u32>(), r.yield_pct, r.runs, ms);
        }
    }

    #[test]
    fn nest_twenty_pieces_on_a_side_is_fast() {
        let mut list: Vec<(String, f64, f64, u32)> = Vec::new();
        for i in 0..20 {
            list.push((format!("Part {i}"), 60.0 + (i * 37 % 200) as f64, 40.0 + (i * 53 % 160) as f64, 1));
        }
        let refs: Vec<(&str, f64, f64, u32)> = list.iter().map(|(n, w, h, c)| (n.as_str(), *w, *h, *c)).collect();
        let p = rect_project("Sampler", &refs);
        let c = compute(&p);
        let hide = preset("side").unwrap();
        let o = NestOptions { sets: 1, time_ms: 1500, ..Default::default() };
        let t = Instant::now();
        let r = nest(&p, &c, &hide, &o).unwrap();
        let ms = t.elapsed().as_millis();
        assert!(r.unplaced.is_empty());
        assert_eq!(r.placements.len(), 20);
        check_layout(&hide, &r, &o);
        assert!(ms < 2000, "{ms} ms");
        eprintln!("20 pieces on a side: {ms} ms, {} runs", r.runs);
    }

    #[test]
    fn nest_angles_follow_grain() {
        let o = NestOptions::default();
        assert_eq!(angle_set(None, Some(0.0), false, &o), vec![0.0, 90.0, 180.0, 270.0]);
        assert_eq!(angle_set(Some(90.0), Some(0.0), false, &o), vec![270.0, 90.0]);
        let fine = NestOptions { fine_step_deg: 5.0, grain_tolerance_deg: 10.0, ..Default::default() };
        let a = angle_set(Some(0.0), Some(-90.0), false, &fine);
        assert_eq!(a.len(), 10);
        assert!(a.iter().all(|x| { let d = (x - 270.0).rem_euclid(180.0); d.min(180.0 - d) <= 10.0 + 1e-9 }));
        assert_eq!(plural("Fold-over card wallet", 3), "fold-over card wallets");
        assert_eq!(plural("Tote", 2), "totes");
        assert_eq!(plural("A5 journal cover", 2), "A5 journal covers");
        assert_eq!(plural("Pouch", 2), "pouches");
    }

    #[test]
    fn nest_bit_rows() {
        // Cells 3, 10, 20 and 63..=70 blocked in a 100-cell row.
        let class: Vec<u8> = (0..100).map(|i| if i == 3 || i == 10 || i == 20 || (63..=70).contains(&i) { OUT } else { 0 }).collect();
        let mut row = vec![0u64; 2];
        bit_row(&class, 3, &mut row);
        assert_eq!(first_set(&row, 0, 2), None);
        assert_eq!(first_set(&row, 0, 3), Some(3));
        assert_eq!(first_set(&row, 21, 62), None);
        assert_eq!(first_set(&row, 21, 64), Some(63));
        assert_eq!(first_free(&row, 63), 71);
        assert_eq!(first_free(&row, 99), 99);
        assert_eq!(first_free(&row, 100), 128);
        set_bits(&mut row, 30, 40);
        assert_eq!(first_set(&row, 21, 62), Some(30));
        assert_eq!(first_free(&row, 30), 41);
        set_bits(&mut row, 0, 127);
        assert_eq!(first_free(&row, 0), 128);
    }
}
