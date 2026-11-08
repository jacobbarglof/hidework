//! Print layout: arranges a template's pieces on as few printer pages as possible. This only
//! affects printing; the project keeps its own layout.
//!
//! Every piece becomes an item: its printed shapes (cut line, stitching, folds, holes, labels) in
//! piece coordinates. Items that fit on one page at some angle are nested with a raster
//! bottom-left fill: each page and each turned item is a grid of cells (about 2 mm) covering the
//! cut outline and every label, and an item goes where its grid, grown by a 4 mm gap, meets no
//! occupied cell, so shapes nest by outline rather than by bounding box. An item that fits on a
//! page is never split; if its labels make it too big, shorter labels are used.
//!
//! Items bigger than any page go on one shared sheet that is tiled into pages; only tiles that
//! something touches are printed, and the small items fill the free space on those pages too. The
//! big items are placed (turned a quarter if that helps) to touch as few tiles as possible, or
//! kept where they were drawn, whichever prints fewer pages. Both page orientations and a few
//! packing orders are tried. Each page carries its own scale squares; the legend goes on page 1.

use crate::compute::ComputedProject;
use crate::geom::{v, Vec2};
use crate::model::Project;
use crate::pdf::{PageSize, PAGE_MARGIN_MM};
use crate::sheet::{legend_lines, piece_shapes, scale_squares, shape_points, Align, Labels, Shape, Style};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// How pieces are put on the printed pages.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrintLayout {
    /// Where they sit on the design sheet, tiled across pages (the original behaviour).
    AsDrawn,
    /// Re-arranged and turned to use the fewest pages; a piece that fits on a page stays whole.
    #[default]
    FewestPages,
}

/// Target raster cell size; the real cells divide the printable area exactly.
const CELL: f64 = 2.0;
/// Gap kept between items, in cells (4 mm or a little less).
const GAP: usize = 2;

/// A page of the printout. Shapes are in paper coordinates (mm, y down, origin top-left).
pub struct Page {
    pub shapes: Vec<Shape>,
    /// For a page that shows part of the shared sheet of pieces bigger than a page.
    pub tile: Option<TileRef>,
    pub header: String,
    pub footer: String,
}

/// Which part of the big-piece sheet a page shows: [col * tile_w, (col + 1) * tile_w) across.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TileRef {
    pub row: usize,
    pub col: usize,
}

/// Pieces bigger than a page, drawn once on a shared sheet and shown through the tile pages.
pub struct Canvas {
    pub shapes: Vec<Shape>,
    /// Printed tiles and their page index.
    pub tiles: Vec<(TileRef, usize)>,
}

/// Where a piece was printed.
#[derive(Clone, Debug)]
pub struct Placement {
    pub piece_id: String,
    pub angle_deg: f64,
    /// Printed across more than one page.
    pub split: bool,
    /// The cut outline on each page it appears on, in paper coordinates.
    pub outlines: Vec<(usize, Vec<Vec2>)>,
}

pub struct Printout {
    pub paper: (f64, f64),
    pub landscape: bool,
    /// Printable area of each page, starting at (PAGE_MARGIN_MM, PAGE_MARGIN_MM).
    pub tile: (f64, f64),
    pub pages: Vec<Page>,
    pub canvas: Option<Canvas>,
    pub placements: Vec<Placement>,
    /// Pages whose scale squares had to be drawn over a piece (in grey, labelled).
    pub overlaid_scales: usize,
    /// False when no page had room for the legend and it went into page 1's footer.
    pub legend_on_page: bool,
}

/// Lay the template out on the fewest pages of `page` paper.
pub fn fewest_pages(project: &Project, computed: &ComputedProject, page: PageSize) -> Printout {
    let items = piece_items(project, computed);
    let mut best: Option<Printout> = None;
    for landscape in [false, true] {
        let ctx = Ctx::new(page, landscape);
        let (small, big) = classify(&items, &ctx);
        let mut strategies = vec![None];
        if !big.is_empty() {
            let k0 = big.iter().map(|&i| [0.0, 90.0].iter().map(|&a| ctx.tiles_across(&items[i].variants[0], a)).min().unwrap()).max().unwrap();
            strategies = (k0..=k0 + 2).map(Some).collect();
            strategies.push(None);
        }
        for strategy in strategies {
            let canvas = if big.is_empty() { Vec::new() } else { place_big(&items, &big, &ctx, strategy) };
            // Orders 3 to 5 also put the scale squares on the tiled pages before the small pieces.
            for order in 0..6 {
                let p = pack(project, &items, &ctx, &small, &canvas, order);
                let better = match &best {
                    None => true,
                    Some(b) => (p.pages.len(), !p.legend_on_page, p.overlaid_scales) < (b.pages.len(), !b.legend_on_page, b.overlaid_scales),
                };
                if better {
                    best = Some(p);
                }
            }
        }
    }
    best.unwrap()
}

// ---------- items ----------

/// Shapes in local coordinates, with what they cover.
#[derive(Clone)]
struct Geom {
    shapes: Vec<Shape>,
    /// Filled areas (cut outline, label boxes, closed shapes).
    fill: Vec<Vec<Vec2>>,
    /// Open lines.
    lines: Vec<Vec<Vec2>>,
}

impl Geom {
    fn of(shapes: Vec<Shape>) -> Geom {
        let (mut fill, mut lines) = (Vec::new(), Vec::new());
        for s in &shapes {
            match s {
                Shape::Poly { pts, closed: true, .. } => fill.push(pts.clone()),
                Shape::Poly { pts, closed: false, .. } => lines.push(pts.clone()),
                Shape::Circle { .. } | Shape::Text { .. } => {
                    let p = shape_points(s);
                    if p.len() == 2 {
                        fill.push(vec![p[0], v(p[1].x, p[0].y), p[1], v(p[0].x, p[1].y)]);
                    } else {
                        fill.push(p);
                    }
                }
            }
        }
        Geom { shapes, fill, lines }
    }
    fn points(&self) -> impl Iterator<Item = Vec2> + '_ {
        self.fill.iter().chain(self.lines.iter()).flatten().copied()
    }
}

struct PieceItem {
    id: String,
    name: String,
    cut: Vec<Vec2>,
    /// Where the piece's local origin sits on the design sheet.
    position: Vec2,
    /// Full labels, then shorter ones.
    variants: Vec<Geom>,
}

fn piece_items(project: &Project, computed: &ComputedProject) -> Vec<PieceItem> {
    let mut out = Vec::new();
    for cp in &computed.pieces {
        let Some(piece) = project.piece(&cp.id) else { continue };
        let mut variants = vec![Geom::of(piece_shapes(piece, cp, Labels::FULL))];
        for l in Labels::COMPACT {
            variants.push(Geom::of(piece_shapes(piece, cp, l)));
        }
        out.push(PieceItem { id: cp.id.clone(), name: piece.name.clone(), cut: cp.cut.clone(), position: piece.position, variants });
    }
    out
}

fn rot(p: Vec2, deg: f64) -> Vec2 {
    let (c, s) = (deg.to_radians().cos(), deg.to_radians().sin());
    v(p.x * c - p.y * s, p.x * s + p.y * c)
}

/// Bounding box (min, size) of points turned by `deg`.
fn turned_box(pts: impl Iterator<Item = Vec2>, deg: f64) -> (Vec2, Vec2) {
    let (mut lo, mut hi) = (v(f64::INFINITY, f64::INFINITY), v(f64::NEG_INFINITY, f64::NEG_INFINITY));
    for p in pts {
        let q = rot(p, deg);
        lo = v(lo.x.min(q.x), lo.y.min(q.y));
        hi = v(hi.x.max(q.x), hi.y.max(q.y));
    }
    (lo, hi - lo)
}

/// Page geometry for one paper size and orientation.
struct Ctx {
    paper: (f64, f64),
    landscape: bool,
    tile: (f64, f64),
    /// Cells per page and the cell size, which divides the printable area exactly.
    gw: usize,
    gh: usize,
    cell: Vec2,
}

impl Ctx {
    fn new(page: PageSize, landscape: bool) -> Ctx {
        let (pw, ph) = page.mm();
        let paper = if landscape { (ph, pw) } else { (pw, ph) };
        let tile = (paper.0 - 2.0 * PAGE_MARGIN_MM, paper.1 - 2.0 * PAGE_MARGIN_MM);
        let (gw, gh) = ((tile.0 / CELL).round() as usize, (tile.1 / CELL).round() as usize);
        Ctx { paper, landscape, tile, gw, gh, cell: v(tile.0 / gw as f64, tile.1 / gh as f64) }
    }
    fn cells(&self, size: Vec2) -> (usize, usize) {
        let c = |mm: f64, cell: f64| (mm / cell - 1e-9).ceil().max(1.0) as usize;
        (c(size.x, self.cell.x), c(size.y, self.cell.y))
    }
    fn fits(&self, pts: &[Vec2], deg: f64) -> bool {
        let (_, s) = turned_box(pts.iter().copied(), deg);
        let (w, h) = self.cells(s);
        w <= self.gw && h <= self.gh
    }
    /// The angles at which points fit on a page: quarter turns first, otherwise the single
    /// angle (and its half turn) with the most room to spare, if any fits.
    fn fitting_angles(&self, pts: &[Vec2]) -> Vec<f64> {
        let quarter: Vec<f64> = [0.0, 90.0, 180.0, 270.0].into_iter().filter(|&a| self.fits(pts, a)).collect();
        if !quarter.is_empty() {
            return quarter;
        }
        let mut best: Option<(f64, f64)> = None;
        let mut a = 0.25;
        while a < 180.0 {
            if self.fits(pts, a) {
                let (_, s) = turned_box(pts.iter().copied(), a);
                let slack = (self.tile.0 - s.x).min(self.tile.1 - s.y);
                if best.map_or(true, |b| slack > b.1) {
                    best = Some((a, slack));
                }
            }
            a += 0.25;
        }
        best.map_or(vec![], |(a, _)| vec![a, a + 180.0])
    }
    fn tiles_across(&self, g: &Geom, deg: f64) -> usize {
        let (_, s) = turned_box(g.points(), deg);
        self.cells(s).0.div_ceil(self.gw)
    }
    /// From local mm to cell units, after turning and moving by `t` (mm).
    fn to_cells(&self, deg: f64, t: Vec2) -> impl Fn(Vec2) -> Vec2 + '_ {
        move |p| {
            let q = rot(p, deg) + t;
            v(q.x / self.cell.x, q.y / self.cell.y)
        }
    }
}

// ---------- raster ----------

struct Grid {
    w: usize,
    h: usize,
    on: Vec<bool>,
}

impl Grid {
    fn new(w: usize, h: usize) -> Grid {
        Grid { w, h, on: vec![false; w * h] }
    }
    fn set(&mut self, x: f64, y: f64) {
        let (x, y) = (x.floor(), y.floor());
        if x >= 0.0 && y >= 0.0 && (x as usize) < self.w && (y as usize) < self.h {
            self.on[y as usize * self.w + x as usize] = true;
        }
    }
    fn get(&self, x: usize, y: usize) -> bool {
        self.on[y * self.w + x]
    }
    /// Mark every cell a polyline passes through.
    fn stroke(&mut self, pts: &[Vec2], closed: bool) {
        let n = pts.len();
        if n == 0 {
            return;
        }
        if n == 1 {
            self.set(pts[0].x, pts[0].y);
        }
        let segs = if closed { n } else { n - 1 };
        for i in 0..segs {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            let steps = (a.dist(b) / 0.2).ceil().max(1.0) as usize;
            for k in 0..=steps {
                let p = a + (b - a) * (k as f64 / steps as f64);
                self.set(p.x, p.y);
            }
        }
    }
    /// Mark every cell a polygon touches: cells whose centre is inside, plus its boundary.
    fn fill(&mut self, pts: &[Vec2]) {
        let n = pts.len();
        if n < 3 {
            self.stroke(pts, false);
            return;
        }
        let (lo, hi) = pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p.y), hi.max(p.y)));
        let j0 = lo.floor().max(0.0) as usize;
        let j1 = (hi.ceil().max(0.0) as usize).min(self.h);
        let mut xs = Vec::new();
        for j in j0..j1 {
            let yc = j as f64 + 0.5;
            xs.clear();
            for i in 0..n {
                let (a, b) = (pts[i], pts[(i + 1) % n]);
                if (a.y <= yc) != (b.y <= yc) {
                    xs.push(a.x + (yc - a.y) / (b.y - a.y) * (b.x - a.x));
                }
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for pair in xs.chunks(2) {
                if pair.len() < 2 || self.w == 0 {
                    continue;
                }
                let i0 = (pair[0] - 0.5).ceil().max(0.0) as usize;
                let i1 = (pair[1] - 0.5).floor();
                if i1 < 0.0 {
                    continue;
                }
                for i in i0..=(i1 as usize).min(self.w - 1) {
                    self.on[j * self.w + i] = true;
                }
            }
        }
        self.stroke(pts, true);
    }
    fn draw(&mut self, g: &Geom, f: &dyn Fn(Vec2) -> Vec2) {
        for poly in &g.fill {
            let p: Vec<Vec2> = poly.iter().map(|&q| f(q)).collect();
            self.fill(&p);
        }
        for line in &g.lines {
            let p: Vec<Vec2> = line.iter().map(|&q| f(q)).collect();
            self.stroke(&p, false);
        }
    }
    fn any(&self) -> bool {
        self.on.iter().any(|&b| b)
    }
}

/// A turned item as cell spans, and the same grown by the gap for collision tests.
struct Mask {
    w: usize,
    h: usize,
    /// Turned local coordinates of cell corner (0, 0).
    min: Vec2,
    angle: f64,
    /// Spans [a, b) per row; `grown` row r is mask row r - GAP, column a is mask column a - GAP.
    spans: Vec<Vec<(usize, usize)>>,
    grown: Vec<Vec<(usize, usize)>>,
}

fn spans_of(g: &Grid) -> Vec<Vec<(usize, usize)>> {
    (0..g.h)
        .map(|y| {
            let mut out = Vec::new();
            let mut x = 0;
            while x < g.w {
                if g.get(x, y) {
                    let a = x;
                    while x < g.w && g.get(x, y) {
                        x += 1;
                    }
                    out.push((a, x));
                } else {
                    x += 1;
                }
            }
            out
        })
        .collect()
}

fn mask(g: &Geom, angle: f64, ctx: &Ctx) -> Mask {
    let (min, size) = turned_box(g.points(), angle);
    let (w, h) = ctx.cells(size);
    let mut grid = Grid::new(w, h);
    grid.draw(g, &ctx.to_cells(angle, -min));
    let mut grown = Grid::new(w + 2 * GAP, h + 2 * GAP);
    for y in 0..h {
        for x in 0..w {
            if grid.get(x, y) {
                for dy in 0..=2 * GAP {
                    let row = (y + dy) * grown.w + x;
                    grown.on[row..=row + 2 * GAP].iter_mut().for_each(|c| *c = true);
                }
            }
        }
    }
    Mask { w, h, min, angle, spans: spans_of(&grid), grown: spans_of(&grown) }
}

/// Free space on a page (or on the big-piece sheet).
struct Bin {
    grid: Grid,
    /// Per row prefix counts of occupied cells.
    pre: Vec<Vec<u32>>,
    tile: Option<TileRef>,
    /// (what, angle, translation in mm): local p lands at rot(p, angle) + t on the page.
    placed: Vec<(What, f64, Vec2)>,
    overlay_scale: Option<Vec2>,
}

#[derive(Clone, Copy, PartialEq)]
enum What {
    Piece(usize, usize),
    Scale,
    MiniScale,
    Legend(usize),
}

impl Bin {
    fn new(w: usize, h: usize, tile: Option<TileRef>) -> Bin {
        Bin { grid: Grid::new(w, h), pre: vec![vec![0; w + 1]; h], tile, placed: Vec::new(), overlay_scale: None }
    }
    fn refresh(&mut self) {
        let w = self.grid.w;
        for y in 0..self.grid.h {
            let row = &mut self.pre[y];
            for x in 0..w {
                row[x + 1] = row[x] + self.grid.on[y * w + x] as u32;
            }
        }
    }
    fn free(&self, m: &Mask, ox: usize, oy: usize) -> bool {
        let (w, h) = (self.grid.w as isize, self.grid.h as isize);
        for (r, spans) in m.grown.iter().enumerate() {
            let y = oy as isize + r as isize - GAP as isize;
            if y < 0 || y >= h {
                continue;
            }
            let row = &self.pre[y as usize];
            for &(a, b) in spans {
                let xa = (ox as isize + a as isize - GAP as isize).max(0);
                let xb = (ox as isize + b as isize - GAP as isize).min(w);
                if xa < xb && row[xb as usize] > row[xa as usize] {
                    return false;
                }
            }
        }
        true
    }
    /// Top-most, then left-most free position.
    fn find(&self, m: &Mask) -> Option<(usize, usize)> {
        if m.w > self.grid.w || m.h > self.grid.h {
            return None;
        }
        for oy in 0..=self.grid.h - m.h {
            for ox in 0..=self.grid.w - m.w {
                if self.free(m, ox, oy) {
                    return Some((ox, oy));
                }
            }
        }
        None
    }
    fn mark(&mut self, m: &Mask, ox: usize, oy: usize) {
        for (r, spans) in m.spans.iter().enumerate() {
            for &(a, b) in spans {
                for x in a..b {
                    let (px, py) = (ox + x, oy + r);
                    if px < self.grid.w && py < self.grid.h {
                        self.grid.on[py * self.grid.w + px] = true;
                    }
                }
            }
        }
        self.refresh();
    }
    fn put(&mut self, what: What, m: &Mask, ox: usize, oy: usize, ctx: &Ctx) {
        self.mark(m, ox, oy);
        self.placed.push((what, m.angle, v(ox as f64 * ctx.cell.x, oy as f64 * ctx.cell.y) - m.min));
    }
    /// Best of several masks on this page: the lowest bottom edge, then the left-most.
    fn best(&self, masks: &[Mask]) -> Option<(usize, usize, usize)> {
        masks.iter().enumerate().filter_map(|(k, m)| self.find(m).map(|(x, y)| (k, x, y))).min_by_key(|&(k, x, y)| (y + masks[k].h, x))
    }
}

// ---------- sorting pieces out ----------

/// A piece that fits on one page, with the labels and turns that let it.
struct Small {
    item: usize,
    variant: usize,
    masks: Vec<Mask>,
    area: usize,
}

fn classify(items: &[PieceItem], ctx: &Ctx) -> (Vec<Small>, Vec<usize>) {
    let (mut small, mut big) = (Vec::new(), Vec::new());
    for (i, it) in items.iter().enumerate() {
        if ctx.fitting_angles(&it.cut).is_empty() {
            big.push(i);
            continue;
        }
        let mut chosen = None;
        for (k, g) in it.variants.iter().enumerate() {
            let pts: Vec<Vec2> = g.points().collect();
            let angles = ctx.fitting_angles(&pts);
            if !angles.is_empty() {
                chosen = Some((k, angles, None));
                break;
            }
        }
        if chosen.is_none() {
            // Even the shortest labels are too long: if the cut line fits, nest by the cut line and
            // let the labels overhang.
            let angles = ctx.fitting_angles(&it.cut);
            if !angles.is_empty() {
                let k = it.variants.len() - 1;
                chosen = Some((k, angles, Some(Geom { shapes: vec![], fill: vec![it.cut.clone()], lines: vec![] })));
            }
        }
        match chosen {
            Some((k, angles, cut_only)) => {
                let g = cut_only.as_ref().unwrap_or(&it.variants[k]);
                let masks: Vec<Mask> = angles.iter().map(|&a| mask(g, a, ctx)).collect();
                let area = masks[0].spans.iter().flatten().map(|s| s.1 - s.0).sum();
                small.push(Small { item: i, variant: k, masks, area });
            }
            None => big.push(i),
        }
    }
    (small, big)
}

/// Places the pieces bigger than a page on the shared sheet: `Some(k)` packs them `k` pages wide
/// touching as few pages as possible, `None` keeps them where they were drawn. Returns
/// (item, angle, translation in mm).
fn place_big(items: &[PieceItem], big: &[usize], ctx: &Ctx, columns: Option<usize>) -> Vec<(usize, f64, Vec2)> {
    let Some(k) = columns else {
        // As drawn, moved so the top-left one starts at (1, 1) mm.
        let mut lo = v(f64::INFINITY, f64::INFINITY);
        for &i in big {
            let (min, _) = turned_box(items[i].variants[0].points(), 0.0);
            let p = items[i].position + min;
            lo = v(lo.x.min(p.x), lo.y.min(p.y));
        }
        return big.iter().map(|&i| (i, 0.0, items[i].position - lo + v(1.0, 1.0))).collect();
    };
    let mut order: Vec<usize> = big.to_vec();
    let area = |i: usize| {
        let (_, s) = turned_box(items[i].cut.iter().copied(), 0.0);
        s.x * s.y
    };
    order.sort_by(|&a, &b| area(b).partial_cmp(&area(a)).unwrap());
    let masks: Vec<Vec<Mask>> = order.iter().map(|&i| [0.0, 90.0].iter().map(|&a| mask(&items[i].variants[0], a, ctx)).collect()).collect();
    let rows = 1 + masks.iter().map(|ms| ms.iter().map(|m| m.h.div_ceil(ctx.gh)).max().unwrap()).sum::<usize>();
    let mut sheet = Bin::new(k * ctx.gw, rows * ctx.gh, None);
    let mut touched: BTreeSet<(usize, usize)> = BTreeSet::new();
    let tiles_of = |m: &Mask, ox: usize, oy: usize| {
        let mut t = BTreeSet::new();
        for (r, spans) in m.spans.iter().enumerate() {
            let ty = (oy + r) / ctx.gh;
            for &(a, b) in spans {
                for tx in (ox + a) / ctx.gw..=(ox + b - 1) / ctx.gw {
                    t.insert((ty, tx));
                }
            }
        }
        t
    };
    let mut out = Vec::new();
    // Cell boxes of what is placed, so new pieces can also go hard against them.
    let mut boxes: Vec<(usize, usize, usize, usize)> = Vec::new();
    for (n, &i) in order.iter().enumerate() {
        let mut best: Option<((usize, usize, usize), usize, usize, usize)> = None;
        for (ai, m) in masks[n].iter().enumerate() {
            if m.w > sheet.grid.w {
                continue;
            }
            // Tile corners (left or right, top or bottom aligned) and next to placed pieces.
            let mut xs: Vec<usize> = (0..k).map(|c| c * ctx.gw).chain((1..=k).filter_map(|c| (c * ctx.gw).checked_sub(m.w))).collect();
            let mut ys: Vec<usize> = (0..rows).map(|r| r * ctx.gh).chain((1..=rows).filter_map(|r| (r * ctx.gh).checked_sub(m.h))).collect();
            for &(x0, y0, x1, y1) in &boxes {
                xs.extend([x0, x1 + GAP]);
                ys.extend([y0, y1 + GAP]);
            }
            xs.sort();
            xs.dedup();
            ys.sort();
            ys.dedup();
            let cands: Vec<(usize, usize)> = ys.iter().flat_map(|&y| xs.iter().map(move |&x| (x, y))).collect();
            for (ox, oy) in cands {
                if ox + m.w > sheet.grid.w || oy + m.h > sheet.grid.h || !sheet.free(m, ox, oy) {
                    continue;
                }
                let mut all = touched.clone();
                all.extend(tiles_of(m, ox, oy));
                let score = (all.len(), oy + m.h, ox);
                if best.map_or(true, |b| score < b.0) {
                    best = Some((score, ai, ox, oy));
                }
            }
        }
        let (_, ai, ox, oy) = best.expect("the sheet has room below everything placed");
        let m = &masks[n][ai];
        touched.extend(tiles_of(m, ox, oy));
        sheet.mark(m, ox, oy);
        boxes.push((ox, oy, ox + m.w, oy + m.h));
        out.push((i, m.angle, v(ox as f64 * ctx.cell.x, oy as f64 * ctx.cell.y) - m.min));
    }
    out
}

// ---------- packing ----------

fn scale_geom(style: Style) -> Geom {
    Geom::of(scale_squares(v(0.0, 0.0), style).0)
}

fn mini_scale_geom() -> Geom {
    let (s, _) = scale_squares(v(0.0, 0.0), Style::Cut);
    Geom::of(s.into_iter().take(2).collect())
}

/// The legend, full or (`compact`) in three short lines.
fn legend_geom(project: &Project, compact: bool) -> Geom {
    let lines = if compact {
        vec![
            (3.6, true, project.name.clone()),
            (2.4, false, "Print at 100% and measure the squares. Solid: cut. Dots: stitch holes.".to_string()),
            (2.4, false, "Dash-dot: fold. Crossed circles: punch. Dotted: glue. Dashed: skive, crease.".to_string()),
        ]
    } else {
        legend_lines(project)
    };
    let mut shapes = Vec::new();
    let mut y = 5.0;
    for (size, bold, text) in lines {
        shapes.push(Shape::Text { at: v(0.0, y), size, text, align: Align::Left, bold, angle: 0.0 });
        y += size + 3.0;
    }
    Geom::of(shapes)
}

fn pack(project: &Project, items: &[PieceItem], ctx: &Ctx, small: &[Small], canvas: &[(usize, f64, Vec2)], order: usize) -> Printout {
    let (gw, gh) = (ctx.gw, ctx.gh);
    let (tw, th) = ctx.tile;
    // Pages of the big-piece sheet that something touches, in reading order.
    let mut tiles: BTreeMap<TileRef, Bin> = BTreeMap::new();
    for &(i, angle, t) in canvas {
        let g = &items[i].variants[0];
        let (min, size) = turned_box(g.points(), angle);
        let (lo, hi) = (min + t, min + t + size);
        for row in (lo.y / th).floor().max(0.0) as usize..=(hi.y / th).floor() as usize {
            for col in (lo.x / tw).floor().max(0.0) as usize..=(hi.x / tw).floor() as usize {
                let tr = TileRef { row, col };
                let bin = tiles.entry(tr).or_insert_with(|| Bin::new(gw, gh, Some(tr)));
                bin.grid.draw(g, &ctx.to_cells(angle, t - v(col as f64 * tw, row as f64 * th)));
            }
        }
    }
    let mut bins: Vec<Bin> = tiles.into_values().filter(|b| b.grid.any()).collect();
    for b in bins.iter_mut() {
        b.refresh();
    }
    let scale = scale_geom(Style::Cut);
    let scale_masks = vec![mask(&scale, 0.0, ctx), mask(&scale, 90.0, ctx)];
    let mini = mini_scale_geom();
    let mini_masks = vec![mask(&mini, 0.0, ctx)];
    let has_scale = |bin: &Bin| bin.placed.iter().any(|p| matches!(p.0, What::Scale | What::MiniScale));
    if order >= 3 {
        for bin in bins.iter_mut() {
            if let Some((k, x, y)) = bin.best(&scale_masks) {
                bin.put(What::Scale, &scale_masks[k], x, y, ctx);
            } else if let Some((k, x, y)) = bin.best(&mini_masks) {
                bin.put(What::MiniScale, &mini_masks[k], x, y, ctx);
            }
        }
    }
    // Everything that fits a page: the first page with room, the best turn there.
    let mut sorted: Vec<&Small> = small.iter().collect();
    match order % 3 {
        0 => sorted.sort_by_key(|s| std::cmp::Reverse(s.area)),
        1 => sorted.sort_by_key(|s| std::cmp::Reverse((s.masks.iter().map(|m| m.w.max(m.h)).max().unwrap_or(0), s.area))),
        _ => sorted.sort_by_key(|s| std::cmp::Reverse((s.masks.iter().map(|m| m.w.min(m.h)).min().unwrap_or(0), s.area))),
    }
    for s in sorted {
        let what = What::Piece(s.item, s.variant);
        let found = bins.iter().enumerate().find_map(|(b, bin)| bin.best(&s.masks).map(|(k, x, y)| (b, k, x, y)));
        match found {
            Some((b, k, x, y)) => bins[b].put(what, &s.masks[k], x, y, ctx),
            None => {
                let mut bin = Bin::new(gw, gh, None);
                let (k, x, y) = bin.best(&s.masks).expect("a piece that fits a page fits an empty page");
                bin.put(what, &s.masks[k], x, y, ctx);
                bins.push(bin);
            }
        }
    }
    if bins.is_empty() {
        bins.push(Bin::new(gw, gh, None));
    }
    // The legend, on the first page with room for it; else a shorter one; else in page 1's footer.
    let legends = [legend_geom(project, false), legend_geom(project, true)];
    let mut legend_page = None;
    'legend: for (n, legend) in legends.iter().enumerate() {
        let masks = vec![mask(legend, 0.0, ctx), mask(legend, 90.0, ctx)];
        for (b, bin) in bins.iter_mut().enumerate() {
            if let Some((k, x, y)) = bin.best(&masks) {
                bin.put(What::Legend(n), &masks[k], x, y, ctx);
                legend_page = Some(b);
                break 'legend;
            }
        }
    }
    // Scale squares on every page: both, else the inch square, else drawn over a corner in grey.
    let mut overlaid = 0;
    for bin in bins.iter_mut() {
        if has_scale(bin) {
            continue;
        }
        if let Some((k, x, y)) = bin.best(&scale_masks) {
            bin.put(What::Scale, &scale_masks[k], x, y, ctx);
        } else if let Some((k, x, y)) = bin.best(&mini_masks) {
            bin.put(What::MiniScale, &mini_masks[k], x, y, ctx);
        } else {
            let (bw, bh) = (scale_masks[0].w.min(gw), scale_masks[0].h.min(gh));
            let corners = [(0, 0), (gw - bw, 0), (0, gh - bh), (gw - bw, gh - bh)];
            let busy = |&(x0, y0): &(usize, usize)| (y0..y0 + bh).map(|y| bin.pre[y][x0 + bw] - bin.pre[y][x0]).sum::<u32>();
            let &(x0, y0) = corners.iter().min_by_key(|c| busy(c)).unwrap();
            bin.overlay_scale = Some(v(x0 as f64 * ctx.cell.x, y0 as f64 * ctx.cell.y));
            overlaid += 1;
        }
    }

    // Page order: the page with the legend first, the rest as packed.
    let mut order_of: Vec<usize> = (0..bins.len()).collect();
    if let Some(l) = legend_page {
        order_of.retain(|&b| b != l);
        order_of.insert(0, l);
    }
    let mut number = vec![0; bins.len()];
    for (n, &b) in order_of.iter().enumerate() {
        number[b] = n;
    }
    let tile_page: BTreeMap<TileRef, usize> = bins.iter().enumerate().filter_map(|(b, bin)| bin.tile.map(|t| (t, number[b]))).collect();
    let total = bins.len();
    let origin = v(PAGE_MARGIN_MM, PAGE_MARGIN_MM);

    let mut placements: Vec<Placement> = Vec::new();
    let mut canvas_shapes = Vec::new();
    let mut parts: BTreeMap<TileRef, Vec<String>> = BTreeMap::new();
    for &(i, angle, t) in canvas {
        let it = &items[i];
        canvas_shapes.extend(it.variants[0].shapes.iter().map(|s| s.transformed(angle, t)));
        let (min, size) = turned_box(it.cut.iter().copied(), angle);
        let (lo, hi) = (min + t, min + t + size);
        let mut outlines = Vec::new();
        for (&tr, &page) in &tile_page {
            let (x0, y0) = (tr.col as f64 * tw, tr.row as f64 * th);
            if hi.x < x0 || lo.x > x0 + tw || hi.y < y0 || lo.y > y0 + th {
                continue;
            }
            parts.entry(tr).or_default().push(it.name.clone());
            outlines.push((page, it.cut.iter().map(|&p| rot(p, angle) + t - v(x0, y0) + origin).collect()));
        }
        placements.push(Placement { piece_id: it.id.clone(), angle_deg: angle, split: outlines.len() > 1, outlines });
    }
    let mut pages_out: Vec<Page> = Vec::with_capacity(total);
    for &b in &order_of {
        let bin = &bins[b];
        let mut shapes = Vec::new();
        for &(what, angle, t) in &bin.placed {
            let geom_shapes: &[Shape] = match what {
                What::Piece(i, k) => {
                    let it = &items[i];
                    placements.push(Placement {
                        piece_id: it.id.clone(),
                        angle_deg: angle,
                        split: false,
                        outlines: vec![(number[b], it.cut.iter().map(|&p| rot(p, angle) + t + origin).collect())],
                    });
                    &it.variants[k].shapes
                }
                What::Scale => &scale.shapes,
                What::MiniScale => &mini.shapes,
                What::Legend(n) => &legends[n].shapes,
            };
            shapes.extend(geom_shapes.iter().map(|s| s.transformed(angle, t + origin)));
        }
        if let Some(at) = bin.overlay_scale {
            let (sq, _) = scale_squares(at + origin, Style::Guide);
            shapes.extend(sq);
            shapes.push(Shape::Text { at: at + origin + v(0.0, 30.0), size: 2.4, text: "Scale check, not a cut line".into(), align: Align::Left, bold: false, angle: 0.0 });
        }
        let mut header = format!("{}  -  page {} of {total}", project.name, number[b] + 1);
        if let Some(tr) = bin.tile {
            header.push_str(&format!("   |   large pieces, row {}, column {}", tr.row + 1, tr.col + 1));
            if let Some(p) = tile_page.get(&TileRef { row: tr.row, col: tr.col + 1 }) {
                header.push_str(&format!("   Right: page {}", p + 1));
            }
            if let Some(p) = tile_page.get(&TileRef { row: tr.row + 1, col: tr.col }) {
                header.push_str(&format!("   Below: page {}", p + 1));
            }
            if let Some(names) = parts.get(&tr) {
                header.push_str(&format!("   |   Parts of: {}", names.join(", ")));
            }
        }
        let footer = if legend_page.is_none() && number[b] == 0 {
            "Print at 100%, measure the squares. Solid: cut. Dots: stitch holes. Dash-dot: fold. Crossed circles: punch.".to_string()
        } else if bin.tile.is_some() {
            "Print at Actual size (100%). Trim on the frame line and tape to the next page so the frames meet.".to_string()
        } else {
            "Print at Actual size (100%) and measure the squares. Pieces may be turned to fit: follow their grain arrows.".to_string()
        };
        pages_out.push(Page { shapes, tile: bin.tile, header, footer });
    }
    let canvas = if canvas.is_empty() { None } else { Some(Canvas { shapes: canvas_shapes, tiles: tile_page.into_iter().collect() }) };
    Printout { paper: ctx.paper, landscape: ctx.landscape, tile: ctx.tile, pages: pages_out, canvas, placements, overlaid_scales: overlaid, legend_on_page: legend_page.is_some() }
}

// ---------- geometry checks ----------

/// Even-odd point in polygon test.
pub fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let n = poly.len();
    let mut inside = false;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a.y > p.y) != (b.y > p.y) && p.x < a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x) {
            inside = !inside;
        }
    }
    inside
}

fn segments_cross(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> bool {
    let cross = |o: Vec2, p: Vec2, q: Vec2| (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    let (d1, d2) = (cross(c, d, a), cross(c, d, b));
    let (d3, d4) = (cross(a, b, c), cross(a, b, d));
    ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0))
}

/// Whether two closed outlines overlap (their edges cross or one lies inside the other).
pub fn polygons_overlap(a: &[Vec2], b: &[Vec2]) -> bool {
    let bb = |p: &[Vec2]| p.iter().fold((v(f64::INFINITY, f64::INFINITY), v(f64::NEG_INFINITY, f64::NEG_INFINITY)), |(lo, hi), q| (v(lo.x.min(q.x), lo.y.min(q.y)), v(hi.x.max(q.x), hi.y.max(q.y))));
    let ((alo, ahi), (blo, bhi)) = (bb(a), bb(b));
    if ahi.x < blo.x || bhi.x < alo.x || ahi.y < blo.y || bhi.y < alo.y {
        return false;
    }
    for i in 0..a.len() {
        let (p, q) = (a[i], a[(i + 1) % a.len()]);
        for j in 0..b.len() {
            if segments_cross(p, q, b[j], b[(j + 1) % b.len()]) {
                return true;
            }
        }
    }
    point_in_polygon(a[0], b) || point_in_polygon(b[0], a)
}

/// Whether a cut outline fits in a `tile` (w, h) at some angle (every quarter degree).
pub fn fits_one_page(cut: &[Vec2], tile: (f64, f64)) -> bool {
    let mut a = 0.0;
    while a < 180.0 {
        let (_, s) = turned_box(cut.iter().copied(), a);
        if s.x <= tile.0 && s.y <= tile.1 {
            return true;
        }
        a += 0.25;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{compute, pdf, sheet, templates};

    fn as_drawn(p: &Project, page: PageSize) -> usize {
        let t = pdf::tiling(&sheet::build_sheet(p, &compute(p)), page);
        t.cols * t.rows
    }

    #[test]
    fn every_template_prints_on_no_more_pages_and_nothing_that_fits_is_split() {
        for t in templates::list() {
            let p = templates::by_id(t.id).unwrap();
            let c = compute(&p);
            for page in [PageSize::Letter, PageSize::A4] {
                let out = fewest_pages(&p, &c, page);
                let before = as_drawn(&p, page);
                assert!(out.pages.len() <= before, "{} {:?}: {} pages, as drawn {}", t.id, page, out.pages.len(), before);
                let (m, (tw, th)) = (PAGE_MARGIN_MM, out.tile);
                for cp in &c.pieces {
                    let n = out.placements.iter().filter(|pl| pl.piece_id == cp.id).count();
                    assert_eq!(n, 1, "{}: {} placed {n} times", t.id, cp.id);
                }
                for pl in &out.placements {
                    let cp = c.pieces.iter().find(|q| q.id == pl.piece_id).unwrap();
                    // Turning keeps the shape.
                    let len = |q: &[Vec2]| crate::geom::polyline_length(q, true);
                    assert!((len(&pl.outlines[0].1) - len(&cp.cut)).abs() < 1e-6);
                    if fits_one_page(&cp.cut, out.tile) {
                        assert!(!pl.split && pl.outlines.len() == 1, "{} {:?}: {} fits a page but was split", t.id, page, pl.piece_id);
                        for q in &pl.outlines[0].1 {
                            assert!(q.x >= m - 1e-6 && q.x <= m + tw + 1e-6 && q.y >= m - 1e-6 && q.y <= m + th + 1e-6, "{}: {} leaves the page", t.id, pl.piece_id);
                        }
                    } else {
                        assert!(pl.split, "{}: {} is bigger than a page", t.id, pl.piece_id);
                    }
                }
                // Pieces never overlap on any page.
                for n in 0..out.pages.len() {
                    let on: Vec<(&str, &Vec<Vec2>)> = out.placements.iter().flat_map(|pl| pl.outlines.iter().filter(|o| o.0 == n).map(move |o| (pl.piece_id.as_str(), &o.1))).collect();
                    for (i, a) in on.iter().enumerate() {
                        for b in &on[i + 1..] {
                            assert!(!polygons_overlap(a.1, b.1), "{} {:?} page {}: {} overlaps {}", t.id, page, n + 1, a.0, b.0);
                        }
                    }
                }
                let (bytes, pages) = pdf::printout_pdf(&out);
                assert_eq!(pages, out.pages.len());
                assert!(bytes.starts_with(b"%PDF-1.4"));
            }
        }
    }

    #[test]
    fn as_drawn_stays_available() {
        let p = templates::by_id("tote").unwrap();
        let c = compute(&p);
        let (_, pages) = pdf::print(&p, &c, PageSize::Letter, PrintLayout::AsDrawn);
        assert_eq!(pages, as_drawn(&p, PageSize::Letter));
        assert_eq!(pdf::page_count(&p, &c, PageSize::Letter, PrintLayout::AsDrawn), pages);
        let (_, fewest) = pdf::print(&p, &c, PageSize::Letter, PrintLayout::FewestPages);
        assert_eq!(pdf::page_count(&p, &c, PageSize::Letter, PrintLayout::FewestPages), fewest);
        let json: PrintLayout = serde_json::from_str("\"asDrawn\"").unwrap();
        assert_eq!(json, PrintLayout::AsDrawn);
        assert_eq!(PrintLayout::default(), PrintLayout::FewestPages);
    }

    #[test]
    fn spread_out_small_pieces_come_together() {
        // Coasters drawn a metre apart print on one page.
        let mut p = templates::by_id("coaster").unwrap();
        for (k, pc) in p.pieces.iter_mut().enumerate() {
            pc.position = v(1000.0 * k as f64, 700.0 * k as f64);
        }
        let c = compute(&p);
        assert!(as_drawn(&p, PageSize::Letter) > 4);
        assert_eq!(fewest_pages(&p, &c, PageSize::Letter).pages.len(), 1);
    }

    #[test]
    fn a_long_thin_piece_turns_to_fit_on_the_diagonal() {
        // 280 x 18 mm is longer than a Letter page's printable area but fits across its diagonal.
        let mut p = templates::blank();
        p.pieces.push(crate::generators::panel("s", "Strip", "m1", 280.0, 18.0));
        let c = compute(&p);
        let out = fewest_pages(&p, &c, PageSize::Letter);
        assert_eq!(out.pages.len(), 1);
        let a = out.placements[0].angle_deg % 90.0;
        assert!(a > 1.0 && a < 89.0, "{a}");
    }

    #[test]
    fn page_counts_report() {
        // The before and after table: cargo test page_counts_report -- --nocapture
        let mut rows = Vec::new();
        for t in templates::list() {
            let p = templates::by_id(t.id).unwrap();
            let c = compute(&p);
            let mut cols = Vec::new();
            for page in [PageSize::Letter, PageSize::A4] {
                let out = fewest_pages(&p, &c, page);
                cols.push(format!("{:>3} -> {:>2}{}{}{}", as_drawn(&p, page), out.pages.len(), if out.landscape { " landscape" } else { " portrait " }, if out.overlaid_scales > 0 { format!(" ({} grey scale)", out.overlaid_scales) } else { String::new() }, if out.legend_on_page { "" } else { " (legend in footer)" }));
            }
            rows.push(format!("{:<22} {:<12} | {:<34} | {}", t.id, t.category, cols[0], cols[1]));
        }
        println!("template               category     | Letter                             | A4\n{}", rows.join("\n"));
    }
}
