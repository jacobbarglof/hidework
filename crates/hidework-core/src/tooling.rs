//! Leather tooling on damp veg-tan: swivel-knife cuts, stamps walked along a line, stamped areas,
//! single impressions and alphabet stamps, plus ready-made designs (border, basketweave, floral,
//! corner flourish, checkerboard, diamonds, monogram).
//!
//! Strokes live on `Piece::tooling` in piece design coordinates. `flatten` and `impressions` lay a
//! stroke out; `print_paths` gives every line to draw on a template; `to_staged` carries a design
//! point through the piece's fold allowances (like holes and marks). The UI mirrors `flatten`,
//! `impressions` and `face` in `ui/src/tooling.ts`; keep the two in step.

use crate::compute::FoldGeom;
use crate::geom::{cubic_point, offset_closed, polyline_length, signed_area, v, Rect, Vec2};
use crate::model::{EdgeKind, Orientation, Piece, StrokeKind, ToolKind, ToolingStroke};
use serde::{Deserialize, Serialize};

const EPS: f64 = 1e-9;

/// Plain-English facts about one tool and its usual settings.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub tool: ToolKind,
    pub name: &'static str,
    /// Face width (cut width for the swivel knife), millimetres.
    pub size_mm: f64,
    /// Usual distance between impressions.
    pub spacing_mm: f64,
    /// Usual depth, for the 3D preview.
    pub depth_mm: f64,
    pub description: &'static str,
}

pub const TOOLS: [ToolKind; 11] = [
    ToolKind::SwivelKnife,
    ToolKind::Beveler,
    ToolKind::Backgrounder,
    ToolKind::PearShader,
    ToolKind::Seeder,
    ToolKind::Camouflage,
    ToolKind::Veiner,
    ToolKind::MuleFoot,
    ToolKind::Basketweave,
    ToolKind::Border,
    ToolKind::Letter,
];

pub fn tool_info(t: ToolKind) -> ToolInfo {
    let (name, size_mm, spacing_mm, depth_mm, description) = match t {
        ToolKind::SwivelKnife => ("Swivel knife", 0.6, 0.0, 0.8, "Cuts the lines of the design into damp leather."),
        ToolKind::Beveler => ("Beveler", 6.0, 3.0, 0.6, "Walked beside a cut to press one side down, so the design stands up."),
        ToolKind::Backgrounder => ("Background", 4.0, 3.5, 0.5, "Presses the background down dark and matte so the design stands out."),
        ToolKind::PearShader => ("Pear shader", 8.0, 6.0, 0.35, "Soft hollows that shade petals and leaves."),
        ToolKind::Seeder => ("Seeder", 3.0, 4.0, 0.4, "Little round seeds, for flower centres."),
        ToolKind::Camouflage => ("Camouflage", 7.0, 6.0, 0.4, "A ribbed crescent, struck along the edges of stems and leaves."),
        ToolKind::Veiner => ("Veiner", 8.0, 5.0, 0.4, "Lined half-moons for leaf veins and scroll texture."),
        ToolKind::MuleFoot => ("Mule foot", 6.0, 6.0, 0.4, "A little horseshoe, struck in rows as a border."),
        ToolKind::Basketweave => ("Basketweave", 12.0, 10.0, 0.5, "The woven basket look, struck in a grid, turning each time."),
        ToolKind::Border => ("Border stamp", 6.0, 6.0, 0.45, "One stamp repeated along a line to make a border."),
        ToolKind::Letter => ("Letters", 12.0, 9.6, 0.5, "Alphabet and number stamps."),
    };
    ToolInfo { tool: t, name, size_mm, spacing_mm, depth_mm, description }
}

pub fn tools() -> Vec<ToolInfo> {
    TOOLS.iter().map(|&t| tool_info(t)).collect()
}

impl ToolingStroke {
    pub fn size(&self) -> f64 {
        if self.size_mm > 0.0 { self.size_mm } else { tool_info(self.tool).size_mm }
    }
    pub fn spacing(&self) -> f64 {
        // Letters keep their usual spacing in step with their height.
        if self.tool == ToolKind::Letter && self.spacing_mm <= 0.0 {
            return self.size() * 0.8;
        }
        let s = if self.spacing_mm > 0.0 { self.spacing_mm } else { tool_info(self.tool).spacing_mm };
        if s > 0.0 { s.max(0.5) } else { self.size().max(1.0) }
    }
    pub fn depth(&self) -> f64 {
        if self.depth_mm > 0.0 { self.depth_mm } else { tool_info(self.tool).depth_mm }
    }
    fn new(id: String, kind: StrokeKind, tool: ToolKind, points: Vec<Vec2>) -> ToolingStroke {
        ToolingStroke { id, kind, tool, points, smooth: false, closed: false, size_mm: 0.0, depth_mm: 0.0, spacing_mm: 0.0, angle_deg: 0.0, side: 0, text: String::new(), group: String::new() }
    }
}

/// One strike of a stamp: where its face centre lands and which way its +x points.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Impression {
    pub at: Vec2,
    pub angle_deg: f64,
    /// The letter struck, for alphabet stamps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ch: Option<char>,
}

// ---------- laying out a stroke ----------

/// The stroke's line as straight segments. Smooth strokes become a Catmull-Rom spline through the
/// points (each span the cubic Bezier `p1, p1 + (p2 - p0) / 6, p2 - (p3 - p1) / 6, p2`). A closed
/// stroke does not repeat its first point at the end.
pub fn flatten(s: &ToolingStroke) -> Vec<Vec2> {
    let closed = s.closed || s.kind == StrokeKind::Fill;
    smooth_path(&s.points, closed, s.smooth)
}

fn smooth_path(pts: &[Vec2], closed: bool, smooth: bool) -> Vec<Vec2> {
    let n = pts.len();
    if !smooth || n < 3 {
        return pts.to_vec();
    }
    let at = |i: isize| -> Vec2 {
        if closed {
            pts[i.rem_euclid(n as isize) as usize]
        } else {
            pts[i.clamp(0, n as isize - 1) as usize]
        }
    };
    let spans = if closed { n } else { n - 1 };
    let mut out = vec![pts[0]];
    for i in 0..spans as isize {
        let (p0, p1, p2, p3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
        let c1 = p1 + (p2 - p0) * (1.0 / 6.0);
        let c2 = p2 - (p3 - p1) * (1.0 / 6.0);
        let steps = ((p1.dist(p2) / 0.75).ceil() as usize).clamp(2, 60);
        for k in 1..=steps {
            out.push(cubic_point(p1, c1, c2, p2, k as f64 / steps as f64));
        }
    }
    if closed {
        out.pop();
    }
    out
}

/// Where every stamp strikes. A cut has none.
pub fn impressions(s: &ToolingStroke) -> Vec<Impression> {
    match s.kind {
        StrokeKind::Cut => vec![],
        StrokeKind::Stamp => s.points.iter().map(|&at| Impression { at, angle_deg: s.angle_deg, ch: None }).collect(),
        StrokeKind::Letters => letters(s),
        StrokeKind::Line => along(s),
        StrokeKind::Fill => fill(s),
    }
}

fn along(s: &ToolingStroke) -> Vec<Impression> {
    let mut pts = flatten(s);
    if pts.is_empty() {
        return vec![];
    }
    if s.closed && pts.len() > 2 {
        pts.push(pts[0]);
    }
    let total = polyline_length(&pts, false);
    let sp = s.spacing();
    let offsets: Vec<f64> = if total < 1e-6 {
        vec![0.0]
    } else if s.closed {
        let n = ((total / sp).round() as usize).max(1);
        (0..n).map(|k| k as f64 * total / n as f64).collect()
    } else {
        let n = ((total / sp).round() as usize).max(1);
        (0..=n).map(|k| k as f64 * total / n as f64).collect()
    };
    // Stamps beside the line sit just clear of it: half their depth across the line.
    let across = face_depth(s.tool, s.size()) / 2.0 + if s.tool == ToolKind::Beveler { 0.2 } else { 0.0 };
    offsets
        .into_iter()
        .map(|o| {
            let (p, dir) = point_and_direction(&pts, o);
            let at = p + dir.left() * (across * s.side.signum() as f64);
            Impression { at, angle_deg: dir.y.atan2(dir.x).to_degrees() + s.angle_deg, ch: None }
        })
        .collect()
}

fn point_and_direction(pts: &[Vec2], s: f64) -> (Vec2, Vec2) {
    let mut acc = 0.0;
    let mut last = v(1.0, 0.0);
    for w in pts.windows(2) {
        let l = w[0].dist(w[1]);
        if l < 1e-12 {
            continue;
        }
        last = (w[1] - w[0]).normalized();
        if acc + l >= s - 1e-9 {
            let t = ((s - acc) / l).clamp(0.0, 1.0);
            return (w[0] + (w[1] - w[0]) * t, last);
        }
        acc += l;
    }
    (*pts.last().unwrap(), last)
}

fn letters(s: &ToolingStroke) -> Vec<Impression> {
    let Some(&start) = s.points.first() else { return vec![] };
    let a = s.angle_deg.to_radians();
    let dir = v(a.cos(), a.sin());
    let sp = s.spacing();
    s.text
        .chars()
        .enumerate()
        .filter(|(_, c)| !c.is_whitespace())
        .map(|(i, c)| Impression { at: start + dir * (i as f64 * sp), angle_deg: s.angle_deg, ch: Some(c) })
        .collect()
}

fn fill(s: &ToolingStroke) -> Vec<Impression> {
    let region = flatten(s);
    if region.len() < 3 {
        return vec![];
    }
    let sp = s.spacing();
    let a = s.angle_deg.to_radians();
    let (ca, sa) = (a.cos(), a.sin());
    let r = Rect::of(&region);
    let c = r.center();
    // Lay the grid out in a frame turned by the stroke angle about the region's centre.
    let to_grid = |p: Vec2| {
        let d = p - c;
        v(d.x * ca + d.y * sa, -d.x * sa + d.y * ca)
    };
    let from_grid = |q: Vec2| c + v(q.x * ca - q.y * sa, q.x * sa + q.y * ca);
    let g = Rect::of(&region.iter().map(|&p| to_grid(p)).collect::<Vec<_>>());
    let mut out = Vec::new();
    if s.tool == ToolKind::Basketweave {
        // Square cells; each stamp turns a quarter from its neighbours.
        // As many whole cells as fit, centred.
        let nx = ((g.width() / sp + 1e-9).floor() as i64).max(1);
        let ny = ((g.height() / sp + 1e-9).floor() as i64).max(1);
        let x0 = -(nx as f64 - 1.0) * sp / 2.0 + g.center().x;
        let y0 = -(ny as f64 - 1.0) * sp / 2.0 + g.center().y;
        for j in 0..ny {
            for i in 0..nx {
                let p = from_grid(v(x0 + i as f64 * sp, y0 + j as f64 * sp));
                if point_in_polygon(p, &region) {
                    out.push(Impression { at: p, angle_deg: s.angle_deg + if (i + j) % 2 == 1 { 90.0 } else { 0.0 }, ch: None });
                }
            }
        }
    } else {
        // Staggered rows, like a hand working across the area.
        let dy = sp * 0.866;
        let ny = (g.height() / dy).floor() as i64 + 1;
        let y0 = g.center().y - (ny as f64 - 1.0) * dy / 2.0;
        for j in 0..ny {
            let shift = if j % 2 == 1 { sp / 2.0 } else { 0.0 };
            let nx = (g.width() / sp).floor() as i64 + 2;
            let x0 = g.center().x - (nx as f64 - 1.0) * sp / 2.0 + shift - sp / 4.0;
            for i in 0..nx {
                let p = from_grid(v(x0 + i as f64 * sp, y0 + j as f64 * dy));
                if point_in_polygon(p, &region) {
                    out.push(Impression { at: p, angle_deg: s.angle_deg, ch: None });
                }
            }
        }
    }
    out
}

pub fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let n = poly.len();
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// How far a stamp face reaches across its +x direction.
pub fn face_depth(tool: ToolKind, size: f64) -> f64 {
    match tool {
        ToolKind::Beveler => size * 0.5,
        ToolKind::Basketweave => size * 0.6,
        ToolKind::Camouflage | ToolKind::Veiner => size * 0.55,
        ToolKind::PearShader => size * 0.55,
        ToolKind::SwivelKnife => size,
        _ => size,
    }
}

/// The outline of a stamp face (and any lines on it) in its own frame: centre at the origin, +x
/// along the impression's angle (along the line for a beveler). Each entry is a polyline and
/// whether it closes.
pub fn face(tool: ToolKind, size: f64) -> Vec<(Vec<Vec2>, bool)> {
    let h = size / 2.0;
    let rect = |w: f64, d: f64| vec![v(-w / 2.0, -d / 2.0), v(w / 2.0, -d / 2.0), v(w / 2.0, d / 2.0), v(-w / 2.0, d / 2.0)];
    let arc = |r: f64, a0: f64, a1: f64, cx: f64, cy: f64, n: usize| -> Vec<Vec2> {
        (0..=n).map(|k| {
            let a = (a0 + (a1 - a0) * k as f64 / n as f64).to_radians();
            v(cx + r * a.cos(), cy + r * a.sin())
        }).collect()
    };
    match tool {
        ToolKind::SwivelKnife => vec![],
        ToolKind::Beveler => vec![(rect(size, size * 0.5), true)],
        ToolKind::Backgrounder => vec![(rect(size, size), true)],
        ToolKind::Seeder => vec![(arc(h, 0.0, 360.0, 0.0, 0.0, 16), true), (arc(h * 0.45, 0.0, 360.0, 0.0, 0.0, 10), true)],
        ToolKind::PearShader => {
            // A pear: round at +x, narrowing to -x.
            let mut p = arc(h * 0.55, -110.0, 110.0, h * 0.4, 0.0, 12);
            p.push(v(-h, 0.0));
            vec![(p, true)]
        }
        ToolKind::Camouflage => {
            let mut p = arc(h, -70.0, 70.0, -h * 0.4, 0.0, 10);
            let mut inner = arc(h * 0.55, 70.0, -70.0, -h * 0.4, 0.0, 8);
            p.append(&mut inner);
            let mut out = vec![(p, true)];
            for a in [-40.0_f64, 0.0, 40.0] {
                let r = a.to_radians();
                out.push((vec![v(-h * 0.4 + h * 0.6 * r.cos(), h * 0.6 * r.sin()), v(-h * 0.4 + h * 0.95 * r.cos(), h * 0.95 * r.sin())], false));
            }
            out
        }
        ToolKind::Veiner => {
            let mut p = arc(h, -90.0, 90.0, -h * 0.3, 0.0, 12);
            p.push(v(-h * 0.3, -h));
            let mut out = vec![(p, true)];
            for k in 1..4 {
                let x = -h * 0.3 + h * 0.25 * k as f64;
                let y = (h * h - (x + h * 0.3).powi(2)).max(0.0).sqrt();
                out.push((vec![v(x, -y), v(x, y)], false));
            }
            out
        }
        ToolKind::MuleFoot => {
            // A horseshoe opening towards -x.
            let mut p = vec![v(-h, -h * 0.7)];
            p.extend(arc(h * 0.7, -90.0, 90.0, 0.0, 0.0, 12));
            p.push(v(-h, h * 0.7));
            vec![(p, false)]
        }
        ToolKind::Basketweave => {
            let (w, d) = (size, size * 0.6);
            let mut out = vec![(rect(w, d), true)];
            for k in 1..4 {
                let y = -d / 2.0 + d * k as f64 / 4.0;
                out.push((vec![v(-w / 2.0 + 0.6, y), v(w / 2.0 - 0.6, y)], false));
            }
            out
        }
        ToolKind::Border => vec![(vec![v(-h, 0.0), v(0.0, -h * 0.6), v(h, 0.0), v(0.0, h * 0.6)], true), (arc(h * 0.18, 0.0, 360.0, 0.0, 0.0, 8), true)],
        ToolKind::Letter => vec![(rect(size * 0.75, size), true)],
    }
}

/// Every line to draw for a stroke on a printed template, in piece design coordinates: the cut
/// itself for a cut, a light outline of the area for a fill, and the outline of each stamp
/// impression (for letters, the letter's box; print the letter itself inside it).
pub fn print_paths(s: &ToolingStroke) -> Vec<(Vec<Vec2>, bool)> {
    let mut out = Vec::new();
    match s.kind {
        StrokeKind::Cut => out.push((flatten(s), s.closed)),
        StrokeKind::Fill => out.push((flatten(s), true)),
        _ => {}
    }
    // A beveler walked along a cut is not printed: the cut lines are what gets traced onto the
    // leather, and a mark per strike buried a carving's lines (the 3D view shows the bevel).
    if s.kind == StrokeKind::Line && s.tool == ToolKind::Beveler {
        return out;
    }
    let shape = face(s.tool, s.size());
    for imp in impressions(s) {
        let a = imp.angle_deg.to_radians();
        let (ca, sa) = (a.cos(), a.sin());
        for (pts, closed) in &shape {
            out.push((pts.iter().map(|q| imp.at + v(q.x * ca - q.y * sa, q.x * sa + q.y * ca)).collect(), *closed));
        }
    }
    out
}

/// Carry a design point through a computed piece's fold allowances (the same mapping holes and
/// marks get), so tooling lands where it belongs on the compensated pattern.
pub fn to_staged(folds: &[FoldGeom], p: Vec2) -> Vec2 {
    let mut p = p;
    for f in folds {
        match f.orientation {
            Orientation::Horizontal if p.y - f.stage_at > EPS => p.y += f.shift_mm,
            Orientation::Vertical if p.x - f.stage_at > EPS => p.x += f.shift_mm,
            _ => {}
        }
    }
    p
}

// ---------- ready-made designs ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Design {
    /// A cut line round the piece inside the stitch line, beveled outside, with a row of stamps.
    Border,
    /// Basketweave filling the piece (or `rect`) inside a cut border.
    Basketweave,
    /// A flower with petals, two leaves and a scroll.
    Floral,
    /// A flourish in the piece corner nearest `at`.
    Corner,
    /// A grid of squares with every other one backgrounded.
    Checkerboard,
    /// Diagonal lines in a square frame with a seed in each diamond.
    Diamond,
    /// Initials in an oval frame.
    Monogram,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignRequest {
    pub design: Design,
    /// Where it goes (piece design coordinates): the centre, or near the corner for a flourish.
    #[serde(default)]
    pub at: Vec2,
    /// Overall size (width of the motif, or the stamp size for basketweave); 0 fits the piece.
    #[serde(default)]
    pub size_mm: f64,
    /// The stamp for a border row (Border stamp if none).
    #[serde(default)]
    pub tool: Option<ToolKind>,
    /// Distance from the piece edge for a border or basketweave; 0 means just inside the stitching.
    #[serde(default)]
    pub inset_mm: f64,
    /// Initials for a monogram.
    #[serde(default)]
    pub text: String,
    /// Fill this rectangle instead of the piece (basketweave, checkerboard, diamonds).
    #[serde(default)]
    pub rect: Option<Rect>,
}

/// The piece's finished outline in design coordinates (curved edges flattened).
pub fn piece_outline(piece: &Piece) -> Vec<Vec2> {
    let n = piece.vertices.len();
    let mut pts: Vec<Vec2> = Vec::new();
    for i in 0..n {
        let a = piece.vertices[i];
        let b = piece.vertices[(i + 1) % n];
        if pts.last().map_or(true, |l| l.dist(a) > 1e-9) {
            pts.push(a);
        }
        if let Some(EdgeKind::Cubic { c1, c2 }) = piece.edges.get(i).map(|e| &e.kind) {
            let ctrl = a.dist(*c1) + c1.dist(*c2) + c2.dist(b);
            let steps = ((ctrl / 1.0).ceil() as usize).clamp(4, 120);
            for k in 1..steps {
                pts.push(cubic_point(a, *c1, *c2, b, k as f64 / steps as f64));
            }
        }
    }
    if pts.len() > 1 && pts[0].dist(*pts.last().unwrap()) < 1e-9 {
        pts.pop();
    }
    pts
}

/// The usual distance of a border from the edge: clear of the stitching, or 4 mm on an unstitched piece.
pub fn default_inset(piece: &Piece) -> f64 {
    if piece.edges.iter().any(|e| e.stitched) {
        piece.stitch.margin_mm + 3.0
    } else {
        4.0
    }
}

/// Which `side` of a closed loop is outside it.
fn outside(loop_pts: &[Vec2]) -> i32 {
    if signed_area(loop_pts) > 0.0 { -1 } else { 1 }
}

/// Build a ready-made design for `piece`. Stroke ids are `{id}-{n}`, and all share group `id`.
pub fn design(piece: &Piece, req: &DesignRequest, id: &str) -> Vec<ToolingStroke> {
    let outline = piece_outline(piece);
    if outline.len() < 3 {
        return vec![];
    }
    let bounds = Rect::of(&outline);
    let fit = bounds.width().min(bounds.height());
    let inset = if req.inset_mm > 0.0 { req.inset_mm } else { default_inset(piece) };
    let mut b = Builder { id, n: 0, out: vec![] };
    match req.design {
        Design::Border => {
            let line = offset_closed(&outline, inset);
            let row_tool = req.tool.filter(|t| *t != ToolKind::SwivelKnife && *t != ToolKind::Letter).unwrap_or(ToolKind::Border);
            let row_size = if req.size_mm > 0.0 { req.size_mm } else { tool_info(row_tool).size_mm };
            b.cut(line.clone(), true, false);
            b.line(ToolKind::Beveler, line.clone(), true, false, outside(&line));
            let row = offset_closed(&outline, inset + 1.5 + face_depth(row_tool, row_size) / 2.0);
            let s = b.line(row_tool, row, true, false, 0);
            s.size_mm = if req.size_mm > 0.0 { req.size_mm } else { 0.0 };
        }
        Design::Basketweave => {
            let region = match req.rect {
                Some(r) => rect_points(r),
                None => offset_closed(&outline, inset),
            };
            b.cut(region.clone(), true, false);
            let inner = offset_closed(&region, 1.5);
            let s = b.push(ToolKind::Basketweave, StrokeKind::Fill, inner);
            s.closed = true;
            s.size_mm = if req.size_mm > 0.0 { req.size_mm } else { 0.0 };
        }
        Design::Floral => {
            let size = if req.size_mm > 0.0 { req.size_mm } else { (fit * 0.6).clamp(30.0, 160.0) };
            floral(&mut b, req.at, size);
        }
        Design::Corner => {
            let size = if req.size_mm > 0.0 { req.size_mm } else { (fit * 0.35).clamp(20.0, 90.0) };
            corner(&mut b, piece, req.at, size, inset);
        }
        Design::Checkerboard | Design::Diamond => {
            let r = req.rect.unwrap_or_else(|| {
                let size = if req.size_mm > 0.0 { req.size_mm } else { ((fit - 2.0 * inset) * 0.7).max(20.0) };
                Rect { min: req.at - v(size / 2.0, size / 2.0), max: req.at + v(size / 2.0, size / 2.0) }
            });
            if req.design == Design::Checkerboard { checkerboard(&mut b, r) } else { diamonds(&mut b, r) }
        }
        Design::Monogram => {
            let size = if req.size_mm > 0.0 { req.size_mm } else { (fit * 0.5).clamp(25.0, 110.0) };
            monogram(&mut b, req.at, size, &req.text);
        }
    }
    b.out
}

struct Builder<'a> {
    id: &'a str,
    n: usize,
    out: Vec<ToolingStroke>,
}

impl Builder<'_> {
    fn push(&mut self, tool: ToolKind, kind: StrokeKind, points: Vec<Vec2>) -> &mut ToolingStroke {
        self.n += 1;
        let mut s = ToolingStroke::new(format!("{}-{}", self.id, self.n), kind, tool, points);
        s.group = self.id.to_string();
        self.out.push(s);
        self.out.last_mut().unwrap()
    }
    fn cut(&mut self, points: Vec<Vec2>, closed: bool, smooth: bool) -> &mut ToolingStroke {
        let s = self.push(ToolKind::SwivelKnife, StrokeKind::Cut, points);
        s.closed = closed;
        s.smooth = smooth;
        s
    }
    fn line(&mut self, tool: ToolKind, points: Vec<Vec2>, closed: bool, smooth: bool, side: i32) -> &mut ToolingStroke {
        let s = self.push(tool, StrokeKind::Line, points);
        s.closed = closed;
        s.smooth = smooth;
        s.side = side;
        s
    }
    /// A closed smooth cut beveled on its outside.
    fn shape(&mut self, points: Vec<Vec2>) {
        let side = outside(&smooth_path(&points, true, true));
        self.cut(points.clone(), true, true);
        self.line(ToolKind::Beveler, points, true, true, side);
    }
}

fn rect_points(r: Rect) -> Vec<Vec2> {
    vec![r.min, v(r.max.x, r.min.y), r.max, v(r.min.x, r.max.y)]
}

/// Map points given in a unit frame (x across, y down, motif about one unit wide) onto the piece.
fn place(c: Vec2, size: f64, pts: &[(f64, f64)]) -> Vec<Vec2> {
    pts.iter().map(|&(x, y)| c + v(x * size, y * size)).collect()
}

fn floral(b: &mut Builder, c: Vec2, size: f64) {
    // Flower, a little above centre.
    let fc = c + v(0.0, -0.08 * size);
    for k in 0..5 {
        let a = (k as f64 * 72.0 - 90.0).to_radians();
        let polar = |da: f64, r: f64| fc + v((a + da).cos() * r * size, (a + da).sin() * r * size);
        b.shape(vec![polar(-0.42, 0.07), polar(-0.3, 0.15), polar(0.0, 0.23), polar(0.3, 0.15), polar(0.42, 0.07)]);
    }
    let centre: Vec<Vec2> = (0..8).map(|k| {
        let a = (k as f64 * 45.0).to_radians();
        fc + v(a.cos() * 0.055 * size, a.sin() * 0.055 * size)
    }).collect();
    b.cut(centre, true, true);
    let seed = (0.03 * size).clamp(2.0, 4.0);
    let seeds: Vec<Vec2> = std::iter::once(fc).chain((0..5).map(|k| {
        let a = (k as f64 * 72.0).to_radians();
        fc + v(a.cos(), a.sin()) * (seed * 0.9)
    })).collect();
    let s = b.push(ToolKind::Seeder, StrokeKind::Stamp, seeds);
    s.size_mm = seed;
    // Two leaves either side, below the flower.
    for (dir, base) in [(-1.0, (-0.2, 0.08)), (1.0, (0.2, 0.08))] {
        let leaf = place(c, size, &[base, (base.0 + dir * 0.13, base.1 - 0.06), (base.0 + dir * 0.3, base.1 + 0.02), (base.0 + dir * 0.14, base.1 + 0.07)]);
        b.shape(leaf);
        let vein = place(c, size, &[base, (base.0 + dir * 0.14, base.1 + 0.0), (base.0 + dir * 0.25, base.1 + 0.02)]);
        b.cut(vein.clone(), false, true);
        let s = b.line(ToolKind::Veiner, vein, false, true, 0);
        s.size_mm = (0.05 * size).clamp(4.0, 8.0);
    }
    // A scroll curling down and round from under the flower.
    let mut scroll = vec![(0.0, 0.16), (0.02, 0.28)];
    let (cx, cy) = (0.13, 0.33);
    for k in 0..14 {
        let t = k as f64 / 13.0;
        let a = (180.0 + 330.0 * t).to_radians();
        let r = 0.12 * (1.0 - 0.7 * t);
        scroll.push((cx + a.cos() * r, cy - a.sin() * r));
    }
    let pts = place(c, size, &scroll);
    b.cut(pts.clone(), false, true);
    // Bevel the outside of the curl: the side away from its centre.
    let centre = c + v(cx * size, cy * size);
    let mid = pts[pts.len() / 2];
    let next = pts[pts.len() / 2 + 1];
    let left = (next - mid).normalized().left();
    let side = if (mid + left - centre).len() > (mid - centre).len() { 1 } else { -1 };
    b.line(ToolKind::Beveler, pts, false, true, side);
}

fn corner(b: &mut Builder, piece: &Piece, at: Vec2, size: f64, inset: f64) {
    let n = piece.vertices.len();
    let Some((i, _)) = piece.vertices.iter().enumerate().min_by(|a, b| a.1.dist(at).total_cmp(&b.1.dist(at))) else { return };
    let p = piece.vertices[i];
    let prev = piece.vertices[(i + n - 1) % n];
    let next = piece.vertices[(i + 1) % n];
    let e1 = (prev - p).normalized();
    let e2 = (next - p).normalized();
    let mut bis = (e1 + e2).normalized();
    // A reflex corner: point the flourish into the piece anyway.
    if signed_area(&piece.vertices) * (e2.x * e1.y - e2.y * e1.x) < 0.0 {
        bis = -bis;
    }
    let half = (e1.dot(e2).clamp(-1.0, 1.0).acos() / 2.0).sin().max(0.2);
    let q = p + bis * (inset / half);
    let map = |along: Vec2, inward: Vec2, pts: &[(f64, f64)]| -> Vec<Vec2> { pts.iter().map(|&(a, w)| q + along * (a * size) + inward * (w * size)).collect() };
    let curl = [(0.1, 0.1), (0.4, 0.06), (0.72, 0.12), (0.84, 0.27), (0.74, 0.38), (0.62, 0.33), (0.66, 0.25)];
    for (along, inward) in [(e1, e2), (e2, e1)] {
        let pts = map(along, inward, &curl);
        b.cut(pts.clone(), false, true);
        let s = b.line(ToolKind::Camouflage, pts[..4].to_vec(), false, true, 0);
        s.size_mm = (0.08 * size).clamp(4.0, 7.0);
    }
    let perp = bis.left();
    let leaf: Vec<Vec2> = [(0.16, 0.0), (0.34, 0.09), (0.56, 0.0), (0.34, -0.09)].iter().map(|&(a, w)| q + bis * (a * size) + perp * (w * size)).collect();
    b.shape(leaf);
    let s = b.push(ToolKind::PearShader, StrokeKind::Stamp, vec![q + bis * (0.33 * size)]);
    s.size_mm = (0.1 * size).clamp(4.0, 8.0);
    s.angle_deg = bis.y.atan2(bis.x).to_degrees();
    let s = b.push(ToolKind::Seeder, StrokeKind::Stamp, vec![q + bis * (0.08 * size)]);
    s.size_mm = (0.05 * size).clamp(2.0, 4.0);
}

fn checkerboard(b: &mut Builder, r: Rect) {
    let n = 4;
    let (w, h) = (r.width() / n as f64, r.height() / n as f64);
    for k in 0..=n {
        let x = r.min.x + k as f64 * w;
        let y = r.min.y + k as f64 * h;
        b.cut(vec![v(x, r.min.y), v(x, r.max.y)], false, false);
        b.cut(vec![v(r.min.x, y), v(r.max.x, y)], false, false);
    }
    for j in 0..n {
        for i in 0..n {
            if (i + j) % 2 == 0 {
                let m = 0.8_f64.min(w / 4.0);
                let cell = Rect { min: v(r.min.x + i as f64 * w + m, r.min.y + j as f64 * h + m), max: v(r.min.x + (i + 1) as f64 * w - m, r.min.y + (j + 1) as f64 * h - m) };
                let s = b.push(ToolKind::Backgrounder, StrokeKind::Fill, rect_points(cell));
                s.closed = true;
            }
        }
    }
}

/// The part of the line through `p` along `d` that lies inside `r`.
fn clip(r: Rect, p: Vec2, d: Vec2) -> Option<[Vec2; 2]> {
    let (mut t0, mut t1) = (f64::NEG_INFINITY, f64::INFINITY);
    for (pc, dc, lo, hi) in [(p.x, d.x, r.min.x, r.max.x), (p.y, d.y, r.min.y, r.max.y)] {
        if dc.abs() < 1e-12 {
            if pc < lo || pc > hi {
                return None;
            }
        } else {
            let (a, b) = ((lo - pc) / dc, (hi - pc) / dc);
            t0 = t0.max(a.min(b));
            t1 = t1.min(a.max(b));
        }
    }
    (t1 - t0 > 1e-6).then(|| [p + d * t0, p + d * t1])
}

fn diamonds(b: &mut Builder, r: Rect) {
    let n = 4.0;
    let cell = r.width().min(r.height()) / n;
    b.cut(rect_points(r), true, false);
    let c = r.center();
    let mut seeds = Vec::new();
    for k in -8..=8 {
        let o = k as f64 * cell;
        for (p, d) in [(c + v(o, 0.0), v(1.0, 1.0)), (c + v(o, 0.0), v(1.0, -1.0))] {
            if let Some([a, e]) = clip(r, p, d) {
                b.cut(vec![a, e], false, false);
            }
        }
    }
    // Diamond centres: halfway between neighbouring lines both ways, where
    // (x - cx) - (y - cy) and (x - cx) + (y - cy) are both an odd number of half cells.
    for a in -8..=8 {
        for bb in -8..=8 {
            let p = c + v((a + bb + 1) as f64 / 2.0 * cell, (bb - a) as f64 / 2.0 * cell);
            if p.x > r.min.x + cell * 0.3 && p.x < r.max.x - cell * 0.3 && p.y > r.min.y + cell * 0.3 && p.y < r.max.y - cell * 0.3 {
                seeds.push(p);
            }
        }
    }
    if !seeds.is_empty() {
        let s = b.push(ToolKind::Seeder, StrokeKind::Stamp, seeds);
        s.size_mm = (cell * 0.2).clamp(2.0, 4.0);
    }
}

fn monogram(b: &mut Builder, c: Vec2, size: f64, text: &str) {
    let (rx, ry) = (size / 2.0, size * 0.38);
    let oval: Vec<Vec2> = (0..12).map(|k| {
        let a = (k as f64 * 30.0).to_radians();
        c + v(a.cos() * rx, a.sin() * ry)
    }).collect();
    b.shape(oval);
    let row: Vec<Vec2> = (0..12).map(|k| {
        let a = (k as f64 * 30.0).to_radians();
        c + v(a.cos() * (rx + 4.5), a.sin() * (ry + 4.5))
    }).collect();
    let s = b.line(ToolKind::Border, row, true, true, 0);
    s.size_mm = 5.0;
    let initials: String = text.chars().filter(|c| !c.is_whitespace()).take(3).collect::<String>().to_uppercase();
    let initials = if initials.is_empty() { "A".to_string() } else { initials };
    let n = initials.chars().count() as f64;
    let h = (ry * 1.1).min(size * 0.8 / (n * 0.8).max(1.0));
    let sp = h * 0.8;
    let s = b.push(ToolKind::Letter, StrokeKind::Letters, vec![c - v((n - 1.0) * sp / 2.0, 0.0)]);
    s.text = initials;
    s.size_mm = h;
    s.spacing_mm = sp;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generators::panel;
    use crate::model::Piece;

    fn stroke(kind: StrokeKind, tool: ToolKind, points: Vec<Vec2>) -> ToolingStroke {
        ToolingStroke::new("s".into(), kind, tool, points)
    }

    fn inside_rect(p: Vec2, r: &Rect, margin: f64) -> bool {
        p.x >= r.min.x + margin - 1e-6 && p.x <= r.max.x - margin + 1e-6 && p.y >= r.min.y + margin - 1e-6 && p.y <= r.max.y - margin + 1e-6
    }

    fn wallet() -> Piece {
        let mut p = panel("p", "Panel", "m", 120.0, 80.0);
        p.edges.iter_mut().for_each(|e| e.stitched = true);
        p
    }

    #[test]
    fn old_files_load_and_json_is_camel_case() {
        let pc: Piece = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "A", "materialId": "m", "position": {"x": 0, "y": 0},
            "vertices": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}],
            "edges": [{"type": "line", "stitched": false}, {"type": "line", "stitched": false}, {"type": "line", "stitched": false}],
            "stitch": {"marginMm": 3, "pitchMm": 3.85, "holeMm": 1}
        }))
        .unwrap();
        assert!(pc.tooling.is_empty());
        let s: ToolingStroke = serde_json::from_str(r#"{"id":"t","kind":"line","tool":"pearShader","points":[{"x":1,"y":2}],"spacingMm":4,"side":-1}"#).unwrap();
        assert_eq!((s.kind, s.tool, s.side, s.spacing_mm), (StrokeKind::Line, ToolKind::PearShader, -1, 4.0));
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""tool":"pearShader""#) && json.contains(r#""sizeMm":0.0"#), "{json}");
        let k: ToolingStroke = serde_json::from_str(r#"{"id":"k"}"#).unwrap();
        assert_eq!((k.kind, k.tool), (StrokeKind::Cut, ToolKind::SwivelKnife));
    }

    #[test]
    fn smooth_cut_passes_through_its_points() {
        let pts = vec![v(0.0, 0.0), v(20.0, 10.0), v(40.0, 0.0), v(60.0, 15.0)];
        let mut s = stroke(StrokeKind::Cut, ToolKind::SwivelKnife, pts.clone());
        s.smooth = true;
        let f = flatten(&s);
        assert!(f.len() > 20);
        for p in &pts {
            assert!(f.iter().any(|q| q.dist(*p) < 1e-9), "{p:?} missing");
        }
        // A straight stroke is just its points.
        s.smooth = false;
        assert_eq!(flatten(&s), pts);
    }

    #[test]
    fn stamps_walk_evenly_along_a_line_beside_it() {
        let mut s = stroke(StrokeKind::Line, ToolKind::Beveler, vec![v(0.0, 0.0), v(30.0, 0.0)]);
        let imps = impressions(&s);
        // 30 mm at 3 mm: 11 strikes, evenly spread, along +x.
        assert_eq!(imps.len(), 11);
        for (k, imp) in imps.iter().enumerate() {
            assert!((imp.at.x - 3.0 * k as f64).abs() < 1e-9 && imp.at.y.abs() < 1e-9);
            assert!(imp.angle_deg.abs() < 1e-9);
        }
        // On the left side (the +y normal for travel along +x): just clear of the cut.
        s.side = 1;
        let imps = impressions(&s);
        assert!(imps.iter().all(|i| (i.at.y - 1.7).abs() < 1e-9), "{:?}", imps[0]);
        s.side = -1;
        assert!(impressions(&s).iter().all(|i| i.at.y < 0.0));
        // A closed loop does not strike the start twice.
        let mut ring = stroke(StrokeKind::Line, ToolKind::Border, vec![v(0.0, 0.0), v(30.0, 0.0), v(30.0, 30.0), v(0.0, 30.0)]);
        ring.closed = true;
        assert_eq!(impressions(&ring).len(), 20);
    }

    #[test]
    fn basketweave_fills_a_rectangle_turning_each_stamp() {
        let r = Rect { min: v(0.0, 0.0), max: v(60.0, 40.0) };
        let mut s = stroke(StrokeKind::Fill, ToolKind::Basketweave, rect_points(r));
        s.spacing_mm = 10.0;
        let imps = impressions(&s);
        assert_eq!(imps.len(), 6 * 4, "{}", imps.len());
        assert!(imps.iter().all(|i| inside_rect(i.at, &r, 0.0)));
        let turned = imps.iter().filter(|i| (i.angle_deg - 90.0).abs() < 1e-9).count();
        assert_eq!(turned, 12);
        // Backgrounding covers the area in staggered rows.
        let bg = stroke(StrokeKind::Fill, ToolKind::Backgrounder, rect_points(r));
        let n = impressions(&bg).len();
        // The UI (tooling.ts) lays out the same 238.
        assert_eq!(n, 238);
        // A turned grid still stays inside.
        s.angle_deg = 30.0;
        assert!(impressions(&s).iter().all(|i| inside_rect(i.at, &r, 0.0)));
    }

    #[test]
    fn letters_skip_spaces() {
        let mut s = stroke(StrokeKind::Letters, ToolKind::Letter, vec![v(10.0, 10.0)]);
        s.text = "J B".into();
        let imps = impressions(&s);
        assert_eq!(imps.len(), 2);
        assert_eq!(imps[0].ch, Some('J'));
        assert!((imps[1].at.x - (10.0 + 2.0 * 9.6)).abs() < 1e-9);
        assert!(stroke(StrokeKind::Cut, ToolKind::SwivelKnife, vec![v(0.0, 0.0), v(5.0, 0.0)]).kind == StrokeKind::Cut);
    }

    #[test]
    fn border_runs_inside_the_stitching_beveled_outside() {
        let pc = wallet();
        let out = design(&pc, &DesignRequest { design: Design::Border, at: v(0.0, 0.0), size_mm: 0.0, tool: None, inset_mm: 0.0, text: String::new(), rect: None }, "d1");
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|s| s.group == "d1"));
        let r = Rect { min: v(0.0, 0.0), max: v(120.0, 80.0) };
        // Cut at stitch margin (3) + 3 mm.
        let cut = &out[0];
        assert_eq!(cut.kind, StrokeKind::Cut);
        assert!(cut.points.iter().all(|p| inside_rect(*p, &r, 6.0 - 1e-6) && !inside_rect(*p, &r, 6.0 + 0.1)));
        // Bevel strikes sit outside the cut line (between it and the edge).
        let bev = impressions(&out[1]);
        assert!(!bev.is_empty());
        assert!(bev.iter().all(|i| !inside_rect(i.at, &r, 6.0) && inside_rect(i.at, &r, 3.5)), "{:?}", bev[0]);
        // Border stamps inside the cut.
        let row = impressions(&out[2]);
        assert!(row.len() > 40);
        assert!(row.iter().all(|i| inside_rect(i.at, &r, 6.0)));
        let ids: std::collections::HashSet<_> = out.iter().map(|s| s.id.clone()).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn basketweave_design_fills_the_piece() {
        let pc = wallet();
        let out = design(&pc, &DesignRequest { design: Design::Basketweave, at: v(0.0, 0.0), size_mm: 0.0, tool: None, inset_mm: 0.0, text: String::new(), rect: None }, "bw");
        assert_eq!(out.len(), 2);
        let fill = &out[1];
        assert_eq!((fill.kind, fill.tool), (StrokeKind::Fill, ToolKind::Basketweave));
        let n = impressions(fill).len();
        // About (120 - 15) / 10 by (80 - 15) / 10 stamps.
        assert!((50..=90).contains(&n), "{n}");
        // In a given rectangle instead.
        let r = Rect { min: v(10.0, 10.0), max: v(50.0, 50.0) };
        let out = design(&pc, &DesignRequest { design: Design::Basketweave, at: v(0.0, 0.0), size_mm: 8.0, tool: None, inset_mm: 0.0, text: String::new(), rect: Some(r) }, "bw2");
        assert!(impressions(&out[1]).iter().all(|i| inside_rect(i.at, &r, 0.0)));
        assert_eq!(out[1].size_mm, 8.0);
    }

    #[test]
    fn floral_corner_and_monogram_stay_where_they_are_put() {
        let pc = wallet();
        let req = |design, at| DesignRequest { design, at, size_mm: 0.0, tool: None, inset_mm: 0.0, text: "jb".into(), rect: None };
        let c = v(60.0, 40.0);
        let fl = design(&pc, &req(Design::Floral, c), "f");
        assert!(fl.len() >= 10);
        assert!(fl.iter().any(|s| s.kind == StrokeKind::Cut && s.closed && s.smooth));
        assert!(fl.iter().any(|s| s.tool == ToolKind::Seeder));
        let size = (80.0_f64 * 0.6).clamp(30.0, 160.0);
        for s in &fl {
            for p in flatten(s) {
                assert!(p.dist(c) < size * 0.6, "{} at {p:?}", s.id);
            }
        }
        // Corner nearest (115, 75): the bottom-right corner, inside the piece.
        let co = design(&pc, &req(Design::Corner, v(115.0, 75.0)), "c");
        assert!(co.len() >= 5);
        let r = Rect { min: v(0.0, 0.0), max: v(120.0, 80.0) };
        for s in &co {
            for p in flatten(s) {
                assert!(inside_rect(p, &r, 2.0), "{} at {p:?}", s.id);
                assert!(p.x > 60.0 && p.y > 35.0, "{} at {p:?}", s.id);
            }
        }
        let mo = design(&pc, &req(Design::Monogram, c), "m");
        let letters = mo.iter().find(|s| s.kind == StrokeKind::Letters).unwrap();
        assert_eq!(letters.text, "JB");
        let imps = impressions(letters);
        assert_eq!(imps.len(), 2);
        assert!(((imps[0].at.x + imps[1].at.x) / 2.0 - c.x).abs() < 1e-9);
    }

    #[test]
    fn geometric_designs() {
        let pc = wallet();
        let r = Rect { min: v(20.0, 10.0), max: v(60.0, 50.0) };
        let req = |design| DesignRequest { design, at: v(0.0, 0.0), size_mm: 0.0, tool: None, inset_mm: 0.0, text: String::new(), rect: Some(r) };
        let ch = design(&pc, &req(Design::Checkerboard), "k");
        assert_eq!(ch.iter().filter(|s| s.kind == StrokeKind::Cut).count(), 10);
        assert_eq!(ch.iter().filter(|s| s.kind == StrokeKind::Fill).count(), 8);
        let di = design(&pc, &req(Design::Diamond), "d");
        let cuts: Vec<_> = di.iter().filter(|s| s.kind == StrokeKind::Cut && !s.closed).collect();
        assert!(cuts.len() >= 10, "{}", cuts.len());
        for s in &di {
            for p in &s.points {
                assert!(inside_rect(*p, &r, 0.0), "{p:?}");
            }
        }
        assert!(di.iter().any(|s| s.tool == ToolKind::Seeder && s.points.len() >= 8));
    }

    #[test]
    fn print_paths_and_fold_mapping() {
        let mut s = stroke(StrokeKind::Line, ToolKind::Seeder, vec![v(0.0, 0.0), v(8.0, 0.0)]);
        // Three seeds, each a ring of two circles.
        assert_eq!(print_paths(&s).len(), 3 * 2);
        s.kind = StrokeKind::Cut;
        assert_eq!(print_paths(&s), vec![(vec![v(0.0, 0.0), v(8.0, 0.0)], false)]);
        for t in TOOLS {
            assert!(tool_info(t).size_mm > 0.0);
            if t != ToolKind::SwivelKnife {
                assert!(!face(t, 6.0).is_empty());
            }
        }
        let fold = FoldGeom { id: "f".into(), orientation: Orientation::Horizontal, at: 40.0, stage_at: 40.0, shift_mm: 5.0, start: vec![], end: vec![], center: vec![] };
        assert_eq!(to_staged(&[fold.clone()], v(3.0, 50.0)), v(3.0, 55.0));
        assert_eq!(to_staged(&[fold], v(3.0, 30.0)), v(3.0, 30.0));
    }
}
