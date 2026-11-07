//! The printable template as a device-independent display list (millimetres, y down), shared by
//! the SVG and PDF exporters.

use crate::compute::{ComputedPiece, ComputedProject};
use crate::geom::{v, Rect, Vec2};
use crate::model::{Orientation, Project, OZ_MM};

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
    Text { at: Vec2, size: f64, text: String, align: Align, bold: bool },
}

pub struct Sheet {
    pub width: f64,
    pub height: f64,
    pub shapes: Vec<Shape>,
}

const MARGIN: f64 = 5.0;
const HEADER: f64 = 34.0;
const MIN_WIDTH: f64 = 190.0;

pub fn thickness_label(mm: f64) -> String {
    let oz = mm / OZ_MM;
    let oz_txt = if (oz - oz.round()).abs() < 0.05 { format!("{:.0}", oz.round()) } else { format!("{oz:.1}") };
    format!("{mm:.1} mm ({oz_txt} oz)")
}

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
        let tr = |pts: &[Vec2]| pts.iter().map(|&p| p + off).collect::<Vec<_>>();
        shapes.push(Shape::Poly { pts: tr(&cp.cut), closed: true, style: Style::Cut });
        if piece.seam_allowance_mm > 0.0 {
            shapes.push(Shape::Poly { pts: tr(&cp.outline), closed: true, style: Style::Finished });
        }
        for run in &cp.stitch_runs {
            for &h in &run.holes {
                shapes.push(Shape::Circle { c: h + off, r: piece.stitch.hole_mm / 2.0, style: Style::StitchHole, filled: true });
            }
        }
        for f in &cp.folds {
            for seg in f.start.iter().chain(f.end.iter()) {
                shapes.push(Shape::Poly { pts: tr(seg), closed: false, style: Style::FoldEdge });
            }
            for seg in &f.center {
                shapes.push(Shape::Poly { pts: tr(seg), closed: false, style: Style::FoldCenter });
            }
            if let Some(seg) = f.center.first() {
                let at = match f.orientation {
                    Orientation::Horizontal => seg[0] + v(4.0, -1.2),
                    Orientation::Vertical => seg[0] + v(1.2, 8.0),
                };
                shapes.push(Shape::Text { at: at + off, size: 2.4, text: format!("FOLD (+{:.1} mm)", f.shift_mm), align: Align::Left, bold: false });
            }
        }
        for line in &cp.skive {
            shapes.push(Shape::Poly { pts: tr(line), closed: false, style: Style::Finished });
            let mid = line[line.len() / 2] + off;
            shapes.push(Shape::Text { at: mid + v(0.0, -1.0), size: 2.2, text: "skive".into(), align: Align::Center, bold: false });
        }
        for h in &cp.holes {
            let c = h.center + off;
            let r = h.diameter_mm / 2.0;
            if let Some(slot) = crate::generators::slot_outline(h) {
                shapes.push(Shape::Poly { pts: tr(&slot), closed: true, style: Style::Hardware });
                if !h.label.is_empty() {
                    shapes.push(Shape::Text { at: c + v(0.0, r + 4.0), size: 2.4, text: h.label.clone(), align: Align::Center, bold: false });
                }
                continue;
            }
            shapes.push(Shape::Circle { c, r, style: Style::Hardware, filled: false });
            let a = r + 1.5;
            shapes.push(Shape::Poly { pts: vec![c - v(a, 0.0), c + v(a, 0.0)], closed: false, style: Style::Guide });
            shapes.push(Shape::Poly { pts: vec![c - v(0.0, a), c + v(0.0, a)], closed: false, style: Style::Guide });
            if !h.label.is_empty() {
                shapes.push(Shape::Text { at: c + v(0.0, a + 3.0), size: 2.4, text: h.label.clone(), align: Align::Center, bold: false });
            }
        }
        // Labels and grain arrow, in the widest strip between folds.
        let c = label_center(cp) + off;
        shapes.push(Shape::Text { at: c + v(0.0, -6.0), size: 4.5, text: piece.name.clone(), align: Align::Center, bold: true });
        shapes.push(Shape::Text {
            at: c + v(0.0, -1.0),
            size: 2.8,
            text: format!("Cut {}  |  {}, {}", piece.cut_count, cp.material_name, thickness_label(cp.thickness_mm)),
            align: Align::Center,
            bold: false,
        });
        grain_arrow(c + v(0.0, 14.0), piece.grain_deg, 18.0, &mut shapes);
        for (k, line) in piece.notes.lines().filter(|l| !l.trim().is_empty()).enumerate() {
            shapes.push(Shape::Text { at: c + v(0.0, 28.0 + 4.0 * k as f64), size: 2.6, text: line.trim().to_string(), align: Align::Center, bold: false });
        }
    }
    Sheet { width, height, shapes }
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

fn header(project: &Project, shapes: &mut Vec<Shape>) {
    let inch = 25.4;
    let sq = |x: f64, s: f64, label: &str, shapes: &mut Vec<Shape>| {
        let y = MARGIN;
        shapes.push(Shape::Poly { pts: vec![v(x, y), v(x + s, y), v(x + s, y + s), v(x, y + s)], closed: true, style: Style::Cut });
        shapes.push(Shape::Text { at: v(x + s / 2.0, y + s / 2.0 + 1.0), size: 3.0, text: label.into(), align: Align::Center, bold: false });
    };
    sq(MARGIN, inch, "1 in", shapes);
    sq(MARGIN + inch + 5.0, 25.0, "25 mm", shapes);
    let x = MARGIN + inch + 5.0 + 25.0 + 8.0;
    let lines = [
        (5.0, true, project.name.clone()),
        (2.8, false, "Print at Actual size (100%), then measure both squares.".to_string()),
        (2.8, false, "Solid line: cut.  Dots: stitch holes.  Dash-dot: fold.  Crossed circles: punch.".to_string()),
        (2.8, false, "Made with Hidework.".to_string()),
    ];
    let mut y = MARGIN + 5.0;
    for (size, bold, text) in lines {
        shapes.push(Shape::Text { at: v(x, y), size, text, align: Align::Left, bold });
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
