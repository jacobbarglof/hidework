//! Sort imported paths into pieces: outer outlines, holes and slots, stitch lines, folds.

use super::fit::seg_dist;
use super::{ImportOptions, InnerShapes, Path, Seg};
use crate::geom::{cubic_point, signed_area, v, Rect, Vec2};
use crate::model::*;
use std::collections::HashMap;

/// Pieces built from a file, with counts for the summary line.
#[derive(Debug, Default)]
pub struct Built {
    pub pieces: Vec<Piece>,
    pub open_paths: Vec<Vec<Vec2>>,
    pub holes: usize,
    pub slots: usize,
    pub folds: usize,
    pub stitched_edges: usize,
    pub inner: usize,
}

impl Built {
    pub fn summary(&self) -> String {
        let mut parts = vec![plural(self.pieces.len(), "piece")];
        if self.holes > 0 {
            parts.push(plural(self.holes, "hole"));
        }
        if self.slots > 0 {
            parts.push(plural(self.slots, "slot"));
        }
        if self.folds > 0 {
            parts.push(plural(self.folds, "fold"));
        }
        if self.stitched_edges > 0 {
            parts.push(format!("stitching on {}", plural(self.stitched_edges, "edge")));
        }
        if !self.open_paths.is_empty() {
            parts.push(format!("{} not used", plural(self.open_paths.len(), "loose line")));
        }
        parts.join(", ")
    }
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// A closed outline with its flattened polygon.
struct Shape {
    path: Path,
    poly: Vec<Vec2>,
    area: f64,
    bbox: Rect,
    parent: Option<usize>,
    depth: usize,
}

pub fn pieces_from_paths(paths: Vec<Path>, opts: &ImportOptions, warnings: &mut Vec<String>) -> Built {
    let tol = opts.join_tolerance_mm.max(1e-6);
    let mut closed: Vec<Path> = vec![];
    let mut open: Vec<Path> = vec![];
    for p in paths {
        let Some(p) = clean(p, tol) else { continue };
        if p.closed {
            closed.push(p);
        } else {
            open.push(p);
        }
    }
    let before = open.len();
    let (mut joined, still_open) = chain(open, tol);
    if before > 0 && !joined.is_empty() {
        let n = joined.len();
        warnings.push(format!("Joined {before} separate lines into {}.", plural(n, "closed outline")));
    }
    closed.append(&mut joined);
    let mut open = still_open;

    // Closed shapes, wound the same way as Hidework's own pieces (positive shoelace area, y down).
    let mut shapes: Vec<Shape> = vec![];
    let mut dupes = 0;
    for mut p in closed {
        let mut poly = p.flatten();
        let mut area = signed_area(&poly);
        if area.abs() < 1e-6 {
            p.closed = false;
            open.push(p);
            continue;
        }
        if area < 0.0 {
            p = p.reversed();
            poly = p.flatten();
            area = -area;
        }
        let bbox = Rect::of(&poly);
        let same = shapes.iter().any(|s| {
            s.bbox.min.dist(bbox.min) < 0.05 && s.bbox.max.dist(bbox.max) < 0.05 && (s.area - area).abs() <= 0.005 * area
        });
        if same {
            dupes += 1;
            continue;
        }
        shapes.push(Shape { path: p, poly, area, bbox, parent: None, depth: 0 });
    }
    if dupes > 0 {
        warnings.push(format!("Left out {} drawn twice on top of another.", plural(dupes, "outline")));
    }
    shapes.sort_by(|a, b| b.area.total_cmp(&a.area));
    for i in 0..shapes.len() {
        let parent = (0..i).rev().find(|&j| shapes[j].area > shapes[i].area && contains(&shapes[j], &shapes[i].poly));
        shapes[i].parent = parent;
    }

    // Biggest first, so a parent is always sorted before its children. Even depth: a piece; odd
    // depth: something inside a piece. A stitch line is only drawn, not cut, so shapes inside it
    // still belong to the piece outside it.
    let mut out = Built::default();
    let mut piece_of_shape: HashMap<usize, usize> = HashMap::new();
    let mut builders: Vec<PieceBuild> = vec![];
    let mut tiny = 0;
    let mut extra_pieces: Vec<(usize, String)> = vec![];
    let mut drawn_only = vec![false; shapes.len()];
    for i in 0..shapes.len() {
        let mut par = shapes[i].parent;
        while let Some(p) = par.filter(|&p| drawn_only[p]) {
            par = shapes[p].parent;
        }
        shapes[i].parent = par;
        shapes[i].depth = par.map_or(0, |p| shapes[p].depth + 1);
        let s = &shapes[i];
        if s.depth % 2 == 0 {
            if s.bbox.width().max(s.bbox.height()) < opts.min_size_mm {
                tiny += 1;
                continue;
            }
            piece_of_shape.insert(i, builders.len());
            builders.push(PieceBuild { shape: i, holes: vec![], folds: vec![], marks: vec![], stitch: vec![], dots: vec![], notes: vec![] });
            continue;
        }
        let Some(&bi) = par.and_then(|p| piece_of_shape.get(&p)) else { continue };
        let parent = &shapes[builders[bi].shape];
        let fine = sample_path(&s.path, 24);
        if let Some((c, d)) = as_circle(&fine, opts.shape_tolerance_mm) {
            if opts.detect_stitching && d <= 1.6 {
                builders[bi].dots.push((c, d));
            } else {
                builders[bi].holes.push(HoleSpec { center: c, diameter: d, length: 0.0, angle: 0.0 });
            }
            continue;
        }
        if let Some(h) = as_slot(&fine, opts.shape_tolerance_mm) {
            builders[bi].holes.push(h);
            continue;
        }
        if opts.detect_stitching {
            if let Some(m) = parallel_distance(&s.poly, true, &parent.poly) {
                if perimeter(&s.poly, true) > 0.5 * perimeter(&parent.poly, true) {
                    builders[bi].stitch.push((resample(&s.poly, true, 1.0), m));
                    drawn_only[i] = true;
                    continue;
                }
            }
        }
        match opts.inner_shapes {
            InnerShapes::Piece => extra_pieces.push((i, format!("{} inner shape", piece_name(parent, bi)))),
            InnerShapes::Mark => builders[bi].marks.push(s.bbox),
            InnerShapes::Skip => {}
        }
        out.inner += 1;
    }
    if tiny > 0 {
        warnings.push(format!("Left out {} smaller than {} mm across.", plural(tiny, "speck"), opts.min_size_mm));
    }
    if out.inner > 0 {
        warnings.push(match opts.inner_shapes {
            InnerShapes::Piece => format!("{} inside a piece (a window or cut-out) kept as separate pieces at the same place; Hidework pieces cannot have free-shape cut-outs yet.", plural(out.inner, "shape")),
            InnerShapes::Mark => format!("{} inside a piece became engrave marks the size of the shape.", plural(out.inner, "shape")),
            InnerShapes::Skip => format!("Left out {} inside a piece.", plural(out.inner, "shape")),
        });
    }

    // Loose lines: folds across a piece, stitch lines along its edges, or notes.
    let mut loose_outside = 0;
    for p in open {
        let pts = p.flatten();
        let mid = point_along(&pts, 0.5);
        let owner = (0..builders.len())
            .filter(|&b| {
                let s = &shapes[builders[b].shape];
                inside(&s.poly, mid) && (inside(&s.poly, pts[0]) || near_poly(&s.poly, pts[0], 0.5))
            })
            .min_by(|&a, &b| shapes[builders[a].shape].area.total_cmp(&shapes[builders[b].shape].area));
        let Some(b) = owner else {
            loose_outside += 1;
            out.open_paths.push(pts);
            continue;
        };
        let s = &shapes[builders[b].shape];
        let (a, z) = (pts[0], *pts.last().unwrap());
        let len = a.dist(z);
        let straight = len > 1.0 && pts.iter().all(|&q| seg_dist(q, a, z) < 0.05);
        if straight {
            let d = z - a;
            if d.y.abs() / len < 0.0175 && len >= 0.8 * s.bbox.width() {
                builders[b].folds.push((Orientation::Horizontal, (a.y + z.y) / 2.0));
                continue;
            }
            if d.x.abs() / len < 0.0175 && len >= 0.8 * s.bbox.height() {
                builders[b].folds.push((Orientation::Vertical, (a.x + z.x) / 2.0));
                continue;
            }
        }
        if opts.detect_stitching {
            if let Some(m) = parallel_distance(&pts, false, &s.poly) {
                builders[b].stitch.push((resample(&pts, false, 1.0), m));
                continue;
            }
        }
        builders[b].notes.push(format!("A line from the file ({:.0} mm long) was not used.", perimeter(&pts, false)));
        out.open_paths.push(pts);
    }
    if loose_outside > 0 {
        warnings.push(format!("{} outside every piece {} not closed shapes and were left out.", plural(loose_outside, "line"), if loose_outside == 1 { "was" } else { "were" }));
    }

    // Build the pieces.
    let mut names: HashMap<String, usize> = HashMap::new();
    for (bi, b) in builders.iter().enumerate() {
        let s = &shapes[b.shape];
        let mut name = piece_name(s, bi);
        let n = names.entry(name.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            name = format!("{name} {n}");
        }
        let mut pc = make_piece(&format!("imp{}", out.pieces.len() + 1), &name, &opts.material_id, &s.path);
        let o = pc.position;
        for (k, h) in b.holes.iter().enumerate() {
            pc.holes.push(Hole {
                id: format!("h{}", k + 1),
                center: round(h.center - o),
                diameter_mm: r4(h.diameter),
                label: String::new(),
                length_mm: r4(h.length),
                angle_deg: r4(h.angle),
            });
            if h.length > 0.0 {
                out.slots += 1;
            } else {
                out.holes += 1;
            }
        }
        for (k, &(or, at)) in b.folds.iter().enumerate() {
            let position = r4(if or == Orientation::Horizontal { at - o.y } else { at - o.x });
            pc.folds.push(Fold { id: format!("f{}", k + 1), orientation: or, position, contents_mm: 0.0 });
            out.folds += 1;
        }
        for (k, r) in b.marks.iter().enumerate() {
            pc.marks.push(Mark {
                id: format!("m{}", k + 1),
                kind: MarkKind::Engrave,
                center: round(r.center() - o),
                size: round(v(r.width(), r.height())),
                angle_deg: 0.0,
                text: "Cut-out from the imported file".into(),
                pattern: String::new(),
            });
        }
        let stitched = apply_stitching(&mut pc, &s.path, b, warnings);
        out.stitched_edges += stitched;
        if !b.notes.is_empty() {
            pc.notes = b.notes.join(" ");
        }
        out.pieces.push(pc);
    }
    for (i, name) in extra_pieces {
        let pc = make_piece(&format!("imp{}", out.pieces.len() + 1), &name, &opts.material_id, &shapes[i].path);
        out.pieces.push(pc);
    }
    out
}

struct HoleSpec {
    center: Vec2,
    diameter: f64,
    length: f64,
    angle: f64,
}

struct PieceBuild {
    shape: usize,
    holes: Vec<HoleSpec>,
    folds: Vec<(Orientation, f64)>,
    marks: Vec<Rect>,
    /// Stitch lines (dense points) and their distance from the outline.
    stitch: Vec<(Vec<Vec2>, f64)>,
    /// Small dots that may be stitch holes: centre and diameter.
    dots: Vec<(Vec2, f64)>,
    notes: Vec<String>,
}

fn piece_name(s: &Shape, i: usize) -> String {
    let n = s.path.name.trim();
    if n.is_empty() || n == "0" {
        format!("Imported piece {}", i + 1)
    } else {
        n.to_string()
    }
}

fn r4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

fn round(p: Vec2) -> Vec2 {
    v(r4(p.x), r4(p.y))
}

/// A piece from a closed path, with its local origin at the outline's top-left corner.
pub fn make_piece(id: &str, name: &str, material_id: &str, path: &Path) -> Piece {
    let bb = path.bbox();
    let o = round(bb.min);
    let mut vertices = vec![round(path.start - o)];
    let mut edges = vec![];
    for (i, s) in path.segs.iter().enumerate() {
        edges.push(match *s {
            Seg::Line(_) => Edge::line(false),
            Seg::Cubic(c1, c2, _) => Edge::new(EdgeKind::Cubic { c1: round(c1 - o), c2: round(c2 - o) }, false),
        });
        if i + 1 < path.segs.len() {
            vertices.push(round(s.end() - o));
        }
    }
    // Built through serde so fields other parts of Hidework add later take their defaults.
    let mut pc: Piece = serde_json::from_value(serde_json::json!({
        "id": id,
        "name": name,
        "materialId": if material_id.is_empty() { "leather" } else { material_id },
        "position": o,
        "vertices": vertices,
        "edges": edges,
        "stitch": StitchSettings::default(),
    }))
    .expect("a piece with every required field");
    pc.grain_deg = 90.0;
    pc
}

/// Drop zero-length segments and close closed paths exactly on their start.
fn clean(mut p: Path, tol: f64) -> Option<Path> {
    let mut cur = p.start;
    let mut segs = Vec::with_capacity(p.segs.len());
    for s in p.segs {
        let keep = match s {
            Seg::Line(e) => e.dist(cur) > 1e-9,
            Seg::Cubic(c1, c2, e) => e.dist(cur) > 1e-9 || c1.dist(cur) > 1e-9 || c2.dist(cur) > 1e-9,
        };
        if keep {
            segs.push(s);
            cur = s.end();
        }
    }
    p.segs = segs;
    if p.segs.is_empty() {
        return None;
    }
    let gap = p.end().dist(p.start);
    if !p.closed && gap <= tol && p.segs.len() >= 2 {
        p.closed = true;
    }
    if p.closed {
        if gap <= tol {
            snap_end(&mut p);
        } else {
            p.line_to(p.start);
        }
    }
    Some(p)
}

fn snap_end(p: &mut Path) {
    let start = p.start;
    if let Some(last) = p.segs.last_mut() {
        match last {
            Seg::Line(e) | Seg::Cubic(_, _, e) => *e = start,
        }
    }
    // A closing line that is now zero length goes.
    if p.segs.len() > 1 {
        if let Some(Seg::Line(e)) = p.segs.last() {
            let prev = p.segs[p.segs.len() - 2].end();
            if prev.dist(*e) < 1e-9 {
                p.segs.pop();
                let n = p.segs.len();
                match &mut p.segs[n - 1] {
                    Seg::Line(e) | Seg::Cubic(_, _, e) => *e = start,
                }
            }
        }
    }
}

/// Join open paths whose ends meet into longer paths; return the closed ones and the rest.
fn chain(open: Vec<Path>, tol: f64) -> (Vec<Path>, Vec<Path>) {
    let cell = tol * 2.0;
    let key = |p: Vec2| ((p.x / cell).floor() as i64, (p.y / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<(usize, bool)>> = HashMap::new();
    for (i, p) in open.iter().enumerate() {
        grid.entry(key(p.start)).or_default().push((i, false));
        grid.entry(key(p.end())).or_default().push((i, true));
    }
    let mut used = vec![false; open.len()];
    let find = |q: Vec2, used: &[bool]| -> Option<(usize, bool)> {
        let (kx, ky) = key(q);
        let mut best: Option<(f64, usize, bool)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for &(i, at_end) in grid.get(&(kx + dx, ky + dy)).map(|v| v.as_slice()).unwrap_or(&[]) {
                    if used[i] {
                        continue;
                    }
                    let e = if at_end { open[i].end() } else { open[i].start };
                    let d = e.dist(q);
                    if d <= tol && best.map_or(true, |b| d < b.0) {
                        best = Some((d, i, at_end));
                    }
                }
            }
        }
        best.map(|b| (b.1, b.2))
    };
    let (mut closed, mut rest) = (vec![], vec![]);
    for i in 0..open.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut cur = open[i].clone();
        let mut pieces = 1;
        // Extend forwards, then turn round and extend the other end.
        for pass in 0..2 {
            while cur.end().dist(cur.start) > tol {
                let Some((j, at_end)) = find(cur.end(), &used) else { break };
                used[j] = true;
                pieces += 1;
                let next = if at_end { open[j].reversed() } else { open[j].clone() };
                cur.segs.extend(next.segs);
            }
            if cur.end().dist(cur.start) <= tol || pass == 1 {
                break;
            }
            cur = cur.reversed();
        }
        if pieces == 1 {
            // Nothing joined: keep it the way the file drew it.
            cur = open[i].clone();
        }
        if cur.end().dist(cur.start) <= tol && cur.segs.len() >= 2 {
            cur.closed = true;
            snap_end(&mut cur);
            if pieces > 1 {
                closed.push(cur);
            } else {
                rest.push(cur);
            }
        } else {
            rest.push(cur);
        }
    }
    // Single paths that closed themselves were already handled by `clean`; keep them closed.
    let (selfclosed, rest): (Vec<Path>, Vec<Path>) = rest.into_iter().partition(|p| p.closed);
    closed.extend(selfclosed);
    (closed, rest)
}

/// Point in polygon (even-odd ray cast).
pub fn inside(poly: &[Vec2], p: Vec2) -> bool {
    let mut c = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            c = !c;
        }
        j = i;
    }
    c
}

fn near_poly(poly: &[Vec2], p: Vec2, d: f64) -> bool {
    dist_to(poly, true, p) <= d
}

fn contains(outer: &Shape, pts: &[Vec2]) -> bool {
    let bb = Rect::of(pts);
    if bb.min.x < outer.bbox.min.x - 1e-6 || bb.min.y < outer.bbox.min.y - 1e-6 || bb.max.x > outer.bbox.max.x + 1e-6 || bb.max.y > outer.bbox.max.y + 1e-6 {
        return false;
    }
    let step = (pts.len() / 12).max(1);
    let (mut yes, mut all) = (0, 0);
    for p in pts.iter().step_by(step) {
        all += 1;
        if inside(&outer.poly, *p) {
            yes += 1;
        }
    }
    yes * 2 > all
}

/// Distance from a point to a polyline.
pub fn dist_to(poly: &[Vec2], closed: bool, p: Vec2) -> f64 {
    let n = poly.len();
    if n == 1 {
        return p.dist(poly[0]);
    }
    let segs = if closed { n } else { n - 1 };
    (0..segs).map(|i| seg_dist(p, poly[i], poly[(i + 1) % n])).fold(f64::INFINITY, f64::min)
}

fn perimeter(pts: &[Vec2], closed: bool) -> f64 {
    crate::geom::polyline_length(pts, closed)
}

/// Points every `step` along a polyline (closed loops do not repeat the start).
fn resample(pts: &[Vec2], closed: bool, step: f64) -> Vec<Vec2> {
    let mut src = pts.to_vec();
    if closed {
        src.push(pts[0]);
    }
    let mut out = vec![src[0]];
    let (mut next, mut acc) = (step, 0.0);
    for w in src.windows(2) {
        let l = w[0].dist(w[1]);
        while l > 0.0 && next <= acc + l {
            out.push(w[0] + (w[1] - w[0]) * ((next - acc) / l));
            next += step;
        }
        acc += l;
    }
    let last = *src.last().unwrap();
    if closed {
        if out.len() > 1 && out.last().unwrap().dist(out[0]) < step * 0.5 {
            out.pop();
        }
    } else if out.last().unwrap().dist(last) > 1e-9 {
        out.push(last);
    }
    out
}

fn point_along(pts: &[Vec2], f: f64) -> Vec2 {
    let total = perimeter(pts, false);
    crate::geom::point_at(pts, total * f)
}

/// If the line keeps a steady distance (1 to 15 mm) from the outline, that distance.
fn parallel_distance(pts: &[Vec2], closed: bool, outline: &[Vec2]) -> Option<f64> {
    let samples = resample(pts, closed, 2.0);
    if samples.len() < 4 {
        return None;
    }
    let d: Vec<f64> = samples.iter().map(|&p| dist_to(outline, true, p)).collect();
    let m = d.iter().sum::<f64>() / d.len() as f64;
    let sd = (d.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / d.len() as f64).sqrt();
    (sd < 0.3 && (1.0..=15.0).contains(&m)).then_some(m)
}

/// Points along a path, `per` to each curve (finer than `Path::flatten` for small shapes).
fn sample_path(p: &Path, per: usize) -> Vec<Vec2> {
    let mut out = vec![p.start];
    let mut cur = p.start;
    for s in &p.segs {
        match *s {
            Seg::Line(e) => out.push(e),
            Seg::Cubic(c1, c2, e) => out.extend((1..=per).map(|k| cubic_point(cur, c1, c2, e, k as f64 / per as f64))),
        }
        cur = s.end();
    }
    if out.len() > 1 && out[0].dist(*out.last().unwrap()) < 1e-9 {
        out.pop();
    }
    out
}

/// A round outline: centre and diameter.
fn as_circle(poly: &[Vec2], tol: f64) -> Option<(Vec2, f64)> {
    let pts = resample(poly, true, (perimeter(poly, true) / 64.0).max(1e-3));
    let c = pts.iter().fold(Vec2::default(), |a, &p| a + p) * (1.0 / pts.len() as f64);
    let r: Vec<f64> = pts.iter().map(|p| p.dist(c)).collect();
    let mean = r.iter().sum::<f64>() / r.len() as f64;
    let spread = r.iter().cloned().fold(0.0, f64::max) - r.iter().cloned().fold(f64::INFINITY, f64::min);
    (mean > 0.0 && spread <= (0.02 * mean).max(0.03).max(2.0 * tol)).then_some((c, 2.0 * mean))
}

/// An oblong slot (two half circles joined by straight sides).
fn as_slot(poly: &[Vec2], tol: f64) -> Option<HoleSpec> {
    let pts = resample(poly, true, (perimeter(poly, true) / 120.0).max(1e-3));
    let c = pts.iter().fold(Vec2::default(), |a, &p| a + p) * (1.0 / pts.len() as f64);
    let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
    for p in &pts {
        let d = *p - c;
        sxx += d.x * d.x;
        sxy += d.x * d.y;
        syy += d.y * d.y;
    }
    let ang = 0.5 * (2.0 * sxy).atan2(sxx - syy);
    let ax = v(ang.cos(), ang.sin());
    let (mut lo, mut hi, mut wlo, mut whi) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for p in &pts {
        let d = *p - c;
        let (a, b) = (d.dot(ax), d.dot(ax.left()));
        lo = lo.min(a);
        hi = hi.max(a);
        wlo = wlo.min(b);
        whi = whi.max(b);
    }
    let (l, w) = (hi - lo, whi - wlo);
    if l < w * 1.05 || w <= 0.0 {
        return None;
    }
    let mid = c + ax * ((lo + hi) / 2.0) + ax.left() * ((wlo + whi) / 2.0);
    let half = (l - w) / 2.0;
    let (p0, p1) = (mid - ax * half, mid + ax * half);
    let ok = pts.iter().all(|&p| (seg_dist(p, p0, p1) - w / 2.0).abs() <= (0.03 * w).max(0.03).max(tol));
    let mut deg = ang.to_degrees();
    if deg < 0.0 {
        deg += 180.0;
    }
    ok.then_some(HoleSpec { center: mid, diameter: w, length: l, angle: deg })
}

/// Point `t` of edge `i` of a closed path.
fn edge_point(path: &Path, i: usize, t: f64) -> Vec2 {
    let a = if i == 0 { path.start } else { path.segs[i - 1].end() };
    match path.segs[i] {
        Seg::Line(b) => a + (b - a) * t,
        Seg::Cubic(c1, c2, b) => cubic_point(a, c1, c2, b, t),
    }
}

/// Mark edges that run along a stitch line or a row of stitch dots; returns how many.
fn apply_stitching(pc: &mut Piece, path: &Path, b: &PieceBuild, warnings: &mut Vec<String>) -> usize {
    let n = path.segs.len();
    let mut margins = vec![];
    let mut on = vec![false; n];
    for (line, m) in &b.stitch {
        for (i, edge_on) in on.iter_mut().enumerate() {
            let ok = (1..=5).all(|k| {
                let q = edge_point(path, i, k as f64 / 6.0);
                (dist_to(line, false, q) - m).abs() <= 0.6
            });
            if ok {
                *edge_on = true;
                margins.push(*m);
            }
        }
    }
    let mut pitch = None;
    if b.dots.len() >= 6 {
        let mut per_edge: Vec<Vec<f64>> = vec![vec![]; n];
        for &(c, _) in &b.dots {
            let (mut best, mut bi) = (f64::INFINITY, 0);
            for i in 0..n {
                let d = (0..=20).map(|k| edge_point(path, i, k as f64 / 20.0)).collect::<Vec<_>>();
                let dd = dist_to(&d, false, c);
                if dd < best {
                    best = dd;
                    bi = i;
                }
            }
            if (1.0..=15.0).contains(&best) {
                per_edge[bi].push(best);
            }
        }
        for (i, ds) in per_edge.iter().enumerate() {
            if ds.len() >= 2 {
                on[i] = true;
                margins.extend(ds);
            }
        }
        let mut gaps: Vec<f64> = b
            .dots
            .iter()
            .enumerate()
            .map(|(i, &(c, _))| b.dots.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, &(o, _))| o.dist(c)).fold(f64::INFINITY, f64::min))
            .collect();
        gaps.sort_by(f64::total_cmp);
        let g = gaps[gaps.len() / 2];
        if (1.5..=12.0).contains(&g) {
            pitch = Some(g);
        }
    } else {
        // Too few to be a stitch row: they are small holes.
        for (k, &(c, d)) in b.dots.iter().enumerate() {
            pc.holes.push(Hole {
                id: format!("d{}", k + 1),
                center: round(c - pc.position),
                diameter_mm: r4(d),
                label: String::new(),
                length_mm: 0.0,
                angle_deg: 0.0,
            });
        }
    }
    let count = on.iter().filter(|x| **x).count();
    if count > 0 {
        margins.sort_by(f64::total_cmp);
        let m = (margins[margins.len() / 2] * 10.0).round() / 10.0;
        pc.stitch.margin_mm = m;
        if let Some(p) = pitch {
            pc.stitch.pitch_mm = (p * 100.0).round() / 100.0;
        }
        for (e, flag) in pc.edges.iter_mut().zip(&on) {
            e.stitched = *flag;
        }
        let what = if b.dots.len() >= 6 { format!("{} stitch dots", b.dots.len()) } else { "the stitch line".to_string() };
        warnings.push(format!(
            "{}: {} became stitching on {} of {} edges, {} mm in from the edge{}.",
            pc.name,
            what,
            count,
            n,
            m,
            pitch.map(|p| format!(", {:.2} mm apart", p)).unwrap_or_default()
        ));
    } else if b.dots.len() >= 6 {
        warnings.push(format!("{}: left out {} small dots that did not line up along an edge.", pc.name, b.dots.len()));
    }
    count
}
