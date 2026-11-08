//! The printable template as a device-independent display list (millimetres, y down), shared by
//! the SVG and PDF exporters.

use crate::compute::{ComputedPiece, ComputedProject};
use crate::geom::{v, Rect, Vec2};
use crate::model::{Orientation, Piece, Project, OZ_MM};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Style {
    Cut,
    Finished,
    StitchHole,
    FoldEdge,
    FoldCenter,
    Hardware,
    Guide,
    Frame,
}

pub struct StyleSpec {
    pub width_mm: f64,
    pub dash: &'static [f64],
    /// 0 is black, 1 is white.
    pub gray: f64,
}

pub fn spec(s: Style) -> StyleSpec {
    match s {
        Style::Cut => StyleSpec { width_mm: 0.35, dash: &[], gray: 0.0 },
        Style::Finished => StyleSpec { width_mm: 0.25, dash: &[2.0, 1.2], gray: 0.35 },
        Style::StitchHole => StyleSpec { width_mm: 0.0, dash: &[], gray: 0.0 },
        Style::FoldEdge => StyleSpec { width_mm: 0.2, dash: &[0.6, 0.9], gray: 0.4 },
        Style::FoldCenter => StyleSpec { width_mm: 0.3, dash: &[4.0, 1.2, 0.8, 1.2], gray: 0.0 },
        Style::Hardware => StyleSpec { width_mm: 0.3, dash: &[], gray: 0.0 },
        Style::Guide => StyleSpec { width_mm: 0.25, dash: &[], gray: 0.3 },
        Style::Frame => StyleSpec { width_mm: 0.15, dash: &[], gray: 0.5 },
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Align {
    Left,
    Center,
}

#[derive(Clone, Debug)]
pub enum Shape {
    Poly { pts: Vec<Vec2>, closed: bool, style: Style },
    Circle { c: Vec2, r: f64, style: Style, filled: bool },
    /// `angle` turns the baseline from +x towards +y (clockwise on the page), in degrees.
    Text { at: Vec2, size: f64, text: String, align: Align, bold: bool, angle: f64 },
}

impl Shape {
    /// Rotate by `deg` (clockwise on the page) about the origin, then move by `d`.
    pub fn transformed(&self, deg: f64, d: Vec2) -> Shape {
        let (c, s) = (deg.to_radians().cos(), deg.to_radians().sin());
        let f = |p: Vec2| v(p.x * c - p.y * s, p.x * s + p.y * c) + d;
        match self {
            Shape::Poly { pts, closed, style } => Shape::Poly { pts: pts.iter().map(|&p| f(p)).collect(), closed: *closed, style: *style },
            Shape::Circle { c, r, style, filled } => Shape::Circle { c: f(*c), r: *r, style: *style, filled: *filled },
            Shape::Text { at, size, text, align, bold, angle } => Shape::Text { at: f(*at), size: *size, text: text.clone(), align: *align, bold: *bold, angle: angle + deg },
        }
    }
}

/// Corners of the box a line of text covers (baseline at `at`; ascent 0.8, descent 0.25 of the
/// size), turned with the text.
pub fn text_box(at: Vec2, size: f64, text: &str, align: Align, bold: bool, angle: f64) -> [Vec2; 4] {
    let w = text_width(text, size, bold) * 1.1;
    let x0 = if align == Align::Center { -w / 2.0 } else { 0.0 };
    let (c, s) = (angle.to_radians().cos(), angle.to_radians().sin());
    let f = |x: f64, y: f64| at + v(x * c - y * s, x * s + y * c);
    [f(x0, -0.8 * size), f(x0 + w, -0.8 * size), f(x0 + w, 0.25 * size), f(x0, 0.25 * size)]
}

/// Everything a shape covers, as points (for bounds).
pub fn shape_points(s: &Shape) -> Vec<Vec2> {
    match s {
        Shape::Poly { pts, .. } => pts.clone(),
        Shape::Circle { c, r, .. } => vec![*c - v(*r, *r), *c + v(*r, *r)],
        Shape::Text { at, size, text, align, bold, angle } => text_box(*at, *size, text, *align, *bold, *angle).to_vec(),
    }
}

pub struct Sheet {
    pub width: f64,
    pub height: f64,
    pub shapes: Vec<Shape>,
}

const MARGIN: f64 = 5.0;
const HEADER: f64 = 40.0;
const MIN_WIDTH: f64 = 190.0;

pub fn thickness_label(mm: f64) -> String {
    let oz = mm / OZ_MM;
    let oz_txt = if (oz - oz.round()).abs() < 0.05 { format!("{:.0}", oz.round()) } else { format!("{oz:.1}") };
    format!("{mm:.1} mm ({oz_txt} oz)")
}

/// The template as drawn: every piece where it sits on the design sheet, under one header.
pub fn build_sheet(project: &Project, computed: &ComputedProject) -> Sheet {
    let b = computed.bounds.unwrap_or(Rect { min: v(0.0, 0.0), max: v(100.0, 50.0) });
    let origin = v(b.min.x - MARGIN, b.min.y - MARGIN - HEADER);
    let width = (b.width() + 2.0 * MARGIN).max(MIN_WIDTH);
    let height = b.height() + 2.0 * MARGIN + HEADER;
    let mut shapes = Vec::new();
    header(project, &mut shapes);
    for cp in &computed.pieces {
        let Some(piece) = project.piece(&cp.id) else { continue };
        let off = piece.position - origin;
        shapes.extend(piece_shapes(piece, cp, Labels::FULL).iter().map(|s| s.transformed(0.0, off)));
    }
    Sheet { width, height, shapes }
}

/// How much label text a piece carries.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Labels {
    pub notes: bool,
    pub material: bool,
    pub scale: f64,
}

impl Labels {
    pub const FULL: Labels = Labels { notes: true, material: true, scale: 1.0 };
    /// Shorter variants, tried in turn when a piece's labels would not fit on a page with it.
    pub const COMPACT: [Labels; 3] = [
        Labels { notes: false, material: true, scale: 1.0 },
        Labels { notes: false, material: false, scale: 0.8 },
        Labels { notes: false, material: false, scale: 0.6 },
    ];
}

/// One piece's cut line, stitching, folds, holes, marks and labels in piece coordinates (the
/// computed piece's compensated coordinates, before `position`).
pub fn piece_shapes(piece: &Piece, cp: &ComputedPiece, labels: Labels) -> Vec<Shape> {
    let mut shapes = Vec::new();
    let text = |at: Vec2, size: f64, text: String, align: Align| Shape::Text { at, size, text, align, bold: false, angle: 0.0 };
    shapes.push(Shape::Poly { pts: cp.cut.clone(), closed: true, style: Style::Cut });
    if piece.seam_allowance_mm > 0.0 {
        shapes.push(Shape::Poly { pts: cp.outline.clone(), closed: true, style: Style::Finished });
    }
    for run in &cp.stitch_runs {
        for (k, &h) in run.holes.iter().enumerate() {
            if run.lace {
                // Lacing slits lie along the line, as long as the lace is wide.
                let n = run.holes.len();
                let dir = (run.holes[(k + 1).min(n - 1)] - run.holes[k.saturating_sub(1)]).normalized();
                let (a, b) = (h - dir * (piece.stitch.hole_mm / 2.0), h + dir * (piece.stitch.hole_mm / 2.0));
                shapes.push(Shape::Poly { pts: vec![a, b], closed: false, style: Style::Hardware });
            } else {
                shapes.push(Shape::Circle { c: h, r: piece.stitch.hole_mm / 2.0, style: Style::StitchHole, filled: true });
            }
        }
    }
    for line in &cp.glue {
        shapes.push(Shape::Poly { pts: line.clone(), closed: false, style: Style::FoldEdge });
        let mid = line[line.len() / 2];
        shapes.push(text(mid + v(0.0, -1.0), 2.0, "glue".into(), Align::Center));
    }
    for line in &cp.creases {
        shapes.push(Shape::Poly { pts: line.clone(), closed: false, style: Style::Finished });
    }
    for mk in &cp.marks {
        if mk.kind == crate::model::MarkKind::Perforate {
            continue;
        }
        let (c, s) = (mk.angle_deg.to_radians().cos(), mk.angle_deg.to_radians().sin());
        let (hw, hh) = (mk.size.x / 2.0, mk.size.y / 2.0);
        let corner = |x: f64, y: f64| mk.center + v(x * c - y * s, x * s + y * c);
        shapes.push(Shape::Poly { pts: vec![corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)], closed: true, style: Style::Finished });
        let kind = format!("{:?}", mk.kind).to_lowercase();
        let label = if mk.text.is_empty() { kind } else { format!("{kind}: {}", mk.text) };
        shapes.push(text(mk.center + v(0.0, 1.0), 2.4, label, Align::Center));
    }
    // Tooling: swivel-knife cuts solid and dark, stamp rows and fills light, letters as text.
    for st in &piece.tooling {
        let style = if st.kind == crate::model::StrokeKind::Cut { Style::Hardware } else { Style::Guide };
        for (pts, closed) in crate::tooling::print_paths(st) {
            let pts: Vec<Vec2> = pts.iter().map(|&p| crate::tooling::to_staged(&cp.folds, p)).collect();
            if pts.len() >= 2 {
                shapes.push(Shape::Poly { pts, closed, style });
            }
        }
        if st.kind == crate::model::StrokeKind::Letters {
            for im in crate::tooling::impressions(st) {
                if let Some(ch) = im.ch {
                    let at = crate::tooling::to_staged(&cp.folds, im.at);
                    let size = if st.size_mm > 0.0 { st.size_mm } else { 6.0 };
                    shapes.push(Shape::Text { at, size, text: ch.to_string(), align: Align::Center, bold: true, angle: im.angle_deg });
                }
            }
        }
    }
    for f in &cp.folds {
        for seg in f.start.iter().chain(f.end.iter()) {
            shapes.push(Shape::Poly { pts: seg.to_vec(), closed: false, style: Style::FoldEdge });
        }
        for seg in &f.center {
            shapes.push(Shape::Poly { pts: seg.to_vec(), closed: false, style: Style::FoldCenter });
        }
        if let Some(seg) = f.center.first() {
            let at = match f.orientation {
                Orientation::Horizontal => seg[0] + v(4.0, -1.2),
                Orientation::Vertical => seg[0] + v(1.2, 8.0),
            };
            shapes.push(text(at, 2.4, format!("FOLD (+{:.1} mm)", f.shift_mm), Align::Left));
        }
    }
    for line in &cp.skive {
        shapes.push(Shape::Poly { pts: line.clone(), closed: false, style: Style::Finished });
        let mid = line[line.len() / 2];
        shapes.push(text(mid + v(0.0, -1.0), 2.2, "skive".into(), Align::Center));
    }
    for h in &cp.holes {
        let c = h.center;
        let r = h.diameter_mm / 2.0;
        if let Some(slot) = crate::generators::slot_outline(h) {
            shapes.push(Shape::Poly { pts: slot, closed: true, style: Style::Hardware });
            if !h.label.is_empty() {
                shapes.push(text(c + v(0.0, r + 4.0), 2.4, h.label.clone(), Align::Center));
            }
            continue;
        }
        shapes.push(Shape::Circle { c, r, style: Style::Hardware, filled: false });
        let a = r + 1.5;
        shapes.push(Shape::Poly { pts: vec![c - v(a, 0.0), c + v(a, 0.0)], closed: false, style: Style::Guide });
        shapes.push(Shape::Poly { pts: vec![c - v(0.0, a), c + v(0.0, a)], closed: false, style: Style::Guide });
        if !h.label.is_empty() {
            shapes.push(text(c + v(0.0, a + 3.0), 2.4, h.label.clone(), Align::Center));
        }
    }
    // Labels and grain arrow, in the widest strip between folds.
    let k = labels.scale;
    let c = label_center(cp);
    shapes.push(Shape::Text { at: c + v(0.0, -6.0 * k), size: 4.5 * k, text: piece.name.clone(), align: Align::Center, bold: true, angle: 0.0 });
    let cut = if labels.material { format!("Cut {}  |  {}, {}", piece.cut_count, cp.material_name, thickness_label(cp.thickness_mm)) } else { format!("Cut {}", piece.cut_count) };
    shapes.push(text(c + v(0.0, -1.0 * k), 2.8 * k, cut, Align::Center));
    grain_arrow(c + v(0.0, 14.0 * k), piece.grain_deg, 18.0 * k, &mut shapes);
    if labels.notes {
        for (n, line) in piece.notes.lines().filter(|l| !l.trim().is_empty()).enumerate() {
            shapes.push(text(c + v(0.0, 28.0 + 4.0 * n as f64), 2.6, line.trim().to_string(), Align::Center));
        }
    }
    shapes
}

fn label_center(cp: &ComputedPiece) -> Vec2 {
    let b = cp.bounds;
    let mut c = b.center();
    for (o, lo, hi) in [(Orientation::Horizontal, b.min.y, b.max.y), (Orientation::Vertical, b.min.x, b.max.x)] {
        let mut cuts: Vec<(f64, f64)> = cp.folds.iter().filter(|f| f.orientation == o).map(|f| (f.at, f.at + f.shift_mm)).collect();
        if cuts.is_empty() {
            continue;
        }
        cuts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut best = (0.0, c);
        let mut start = lo;
        for (a, z) in cuts.into_iter().chain([(hi, hi)]) {
            if a - start > best.0 {
                let mid = (start + a) / 2.0;
                best = (a - start, if o == Orientation::Horizontal { v(c.x, mid) } else { v(mid, c.y) });
            }
            start = z;
        }
        c = best.1;
    }
    c
}

/// The two scale-check squares (1 in and 25 mm) with their labels, top-left at `at`.
/// Returns the shapes and the block's size.
pub fn scale_squares(at: Vec2, style: Style) -> (Vec<Shape>, Vec2) {
    let inch = 25.4;
    let mut shapes = Vec::new();
    let mut sq = |x: f64, s: f64, label: &str| {
        let (x, y) = (at.x + x, at.y);
        shapes.push(Shape::Poly { pts: vec![v(x, y), v(x + s, y), v(x + s, y + s), v(x, y + s)], closed: true, style });
        shapes.push(Shape::Text { at: v(x + s / 2.0, y + s / 2.0 + 1.0), size: 3.0, text: label.into(), align: Align::Center, bold: false, angle: 0.0 });
    };
    sq(0.0, inch, "1 in");
    sq(inch + 5.0, 25.0, "25 mm");
    (shapes, v(inch + 5.0 + 25.0, inch))
}

/// The legend printed once per template.
pub fn legend_lines(project: &Project) -> Vec<(f64, bool, String)> {
    vec![
        (5.0, true, project.name.clone()),
        (2.8, false, "Print at Actual size (100%), then measure both squares.".to_string()),
        (2.8, false, "Solid line: cut.  Dots: stitch holes (dashes: lacing slits).".to_string()),
        (2.8, false, "Dash-dot: fold.  Crossed circles: punch.  Dotted inner line: glue to here.".to_string()),
        (2.8, false, "Dashed: skive, crease or decoration area.  Made with Hidework.".to_string()),
    ]
}

fn header(project: &Project, shapes: &mut Vec<Shape>) {
    let (sq, size) = scale_squares(v(MARGIN, MARGIN), Style::Cut);
    shapes.extend(sq);
    let x = MARGIN + size.x + 8.0;
    let mut y = MARGIN + 5.0;
    for (size, bold, text) in legend_lines(project) {
        shapes.push(Shape::Text { at: v(x, y), size, text, align: Align::Left, bold, angle: 0.0 });
        y += size + 3.0;
    }
}

fn grain_arrow(c: Vec2, deg: f64, len: f64, shapes: &mut Vec<Shape>) {
    let d = v(deg.to_radians().cos(), deg.to_radians().sin());
    let n = d.left();
    let a = c - d * (len / 2.0);
    let b = c + d * (len / 2.0);
    shapes.push(Shape::Poly { pts: vec![a, b], closed: false, style: Style::Guide });
    for (tip, dir) in [(a, d), (b, -d)] {
        shapes.push(Shape::Poly { pts: vec![tip + dir * 2.5 + n * 1.3, tip, tip + dir * 2.5 - n * 1.3], closed: false, style: Style::Guide });
    }
}

/// Rough Helvetica advance width, good enough to centre labels.
pub fn text_width(text: &str, size: f64, bold: bool) -> f64 {
    text.chars().count() as f64 * size * if bold { 0.58 } else { 0.52 }
}
