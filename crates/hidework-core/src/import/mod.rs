//! Bring in patterns people already have: SVG, DXF and vector PDF files.
//!
//! Every reader turns its file into [`Path`]s in millimetres with y pointing down, then
//! [`build::pieces_from_paths`] sorts them into pieces: outer closed outlines become pieces, closed
//! shapes inside a piece become holes, slots, stitch lines or inner shapes, straight lines across a
//! piece become folds, and anything else is reported. Curves stay cubic Beziers wherever the file
//! has them (arcs and quadratics convert exactly; DXF splines are fitted within 0.02 mm).

pub mod build;
pub mod dxf;
pub mod fit;
pub mod pdf;
pub mod svg;

use crate::geom::{flatten_cubic, v, Rect, Vec2};
use crate::model::Piece;
use serde::{Deserialize, Serialize};

/// What to do with a closed shape inside a piece that is not a round hole, a slot or a stitch line
/// (a card window, a decorative cut-out). The project model has no free-shape cut-out yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InnerShapes {
    /// Keep the shape as its own piece, at the same place (default: nothing is lost).
    #[default]
    Piece,
    /// A mark (engrave) covering the shape's bounding box.
    Mark,
    /// Leave it out (reported).
    Skip,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    /// Material for the new pieces; empty means `leather`.
    pub material_id: String,
    /// Force the file's drawing unit: `mm`, `cm`, `m`, `in`, `ft`, `pt` or `px` (96 per inch).
    /// Empty means read it from the file.
    pub units: String,
    /// Extra scale on top of the units (1 = true size).
    pub scale: f64,
    /// Line ends closer than this are joined into one outline.
    pub join_tolerance_mm: f64,
    /// Outer outlines smaller than this across are dropped (specks, registration dots).
    pub min_size_mm: f64,
    pub inner_shapes: InnerShapes,
    /// Turn stitch lines and rows of stitch dots inside a piece into stitched edges.
    pub detect_stitching: bool,
    /// PDF pages to read, counting from 1; empty means every page.
    pub pages: Vec<u32>,
    /// Pixels per inch for SVG files drawn in pixels; 0 means 96, or 72 for Adobe Illustrator.
    pub svg_dpi: f64,
    /// How far an inner shape may stray from a perfect circle or slot and still become a hole
    /// (0 for drawn files; traced photos need a little).
    pub shape_tolerance_mm: f64,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            material_id: String::new(),
            units: String::new(),
            scale: 1.0,
            join_tolerance_mm: 0.1,
            min_size_mm: 3.0,
            inner_shapes: InnerShapes::Piece,
            detect_stitching: true,
            pages: vec![],
            svg_dpi: 0.0,
            shape_tolerance_mm: 0.0,
        }
    }
}

/// The photo behind a trace, so the interface can show it and let the user pick points on it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Underlay {
    /// Size of the photo in pixels after turning it upright; picked points use these pixels.
    pub width: u32,
    pub height: u32,
    /// A smaller JPEG of the photo (`data:image/jpeg;base64,...`), drawn stretched to width x height.
    pub data_url: String,
    /// True when the millimetre scale is known (from the user, the sheet corners or the scan).
    pub scale_known: bool,
    /// Millimetres per photo pixel used (an average when the perspective is corrected).
    pub mm_per_px: f64,
    /// Threshold used (0 to 255), so a slider can start there.
    pub threshold: u8,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// New pieces at true size. Each piece's `position` keeps its place from the file.
    pub pieces: Vec<Piece>,
    /// Plain-English notes about anything changed, guessed or left out.
    pub warnings: Vec<String>,
    /// The drawing unit and where it came from, e.g. `mm (from the file's width and viewBox)`.
    pub units_detected: String,
    /// One line for the user: "2 pieces, 3 holes, 1 fold".
    pub summary: String,
    /// Lines that were not closed and not used (sheet millimetres), for the preview.
    pub open_paths: Vec<Vec<Vec2>>,
    /// Photo traces only: the photo, and the traced outlines in photo pixels.
    #[serde(default)]
    pub underlay: Option<Underlay>,
    #[serde(default)]
    pub traced_px: Vec<Vec<Vec2>>,
}

/// Read a pattern file. `ext` is the file extension (`svg`, `dxf` or `pdf`, any case, with or
/// without the dot); when it is unknown the content decides.
pub fn import_file(bytes: &[u8], ext: &str, opts: &ImportOptions) -> Result<ImportResult, String> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_string();
    let kind = match ext.as_str() {
        "svg" => "svg",
        "dxf" => "dxf",
        "pdf" | "ai" => "pdf",
        _ if head.starts_with("%PDF") => "pdf",
        _ if head.contains("<svg") || head.trim_start().starts_with("<?xml") => "svg",
        _ if head.contains("SECTION") => "dxf",
        _ => return Err(format!("Hidework can read SVG, DXF and PDF pattern files, not .{ext} files.")),
    };
    let mut warnings = Vec::new();
    let (mut paths, units) = match kind {
        "svg" => svg::read(bytes, opts, &mut warnings)?,
        "dxf" => dxf::read(bytes, opts, &mut warnings)?,
        _ => pdf::read(bytes, opts, &mut warnings)?,
    };
    let s = if opts.scale > 0.0 { opts.scale } else { 1.0 };
    if (s - 1.0).abs() > 1e-12 {
        let a = Affine::scale(s, s);
        for p in &mut paths {
            *p = p.transformed(&a);
        }
        warnings.push(format!("Scaled by {s} as asked."));
    }
    let built = build::pieces_from_paths(paths, opts, &mut warnings);
    if built.pieces.is_empty() {
        warnings.push("No closed outlines were found, so nothing can become a piece. If the pattern is drawn as separate lines, check that their ends meet.".into());
    }
    Ok(ImportResult {
        summary: built.summary(),
        pieces: built.pieces,
        warnings,
        units_detected: units,
        open_paths: built.open_paths,
        underlay: None,
        traced_px: vec![],
    })
}

/// Millimetres per unit for a unit name, if known.
pub fn unit_mm(name: &str) -> Option<f64> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "mm" | "millimetre" | "millimeter" | "millimetres" | "millimeters" => 1.0,
        "cm" => 10.0,
        "m" => 1000.0,
        "in" | "inch" | "inches" => 25.4,
        "ft" | "foot" | "feet" => 304.8,
        "pt" => 25.4 / 72.0,
        "pc" => 25.4 / 6.0,
        "px" => 25.4 / 96.0,
        _ => return None,
    })
}

/// One piece of an outline; the start is the previous segment's end.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Line(Vec2),
    Cubic(Vec2, Vec2, Vec2),
}

impl Seg {
    pub fn end(&self) -> Vec2 {
        match *self {
            Seg::Line(p) | Seg::Cubic(_, _, p) => p,
        }
    }
    fn map(&self, a: &Affine) -> Seg {
        match *self {
            Seg::Line(p) => Seg::Line(a.apply(p)),
            Seg::Cubic(c1, c2, p) => Seg::Cubic(a.apply(c1), a.apply(c2), a.apply(p)),
        }
    }
}

/// A run of segments in sheet millimetres (y down), open or closed.
#[derive(Clone, Debug, PartialEq)]
pub struct Path {
    pub start: Vec2,
    pub segs: Vec<Seg>,
    pub closed: bool,
    /// Layer, label or id from the file, used to name the piece.
    pub name: String,
}

impl Path {
    pub fn new(start: Vec2, name: &str) -> Path {
        Path { start, segs: vec![], closed: false, name: name.into() }
    }
    pub fn end(&self) -> Vec2 {
        self.segs.last().map(|s| s.end()).unwrap_or(self.start)
    }
    pub fn line_to(&mut self, p: Vec2) {
        self.segs.push(Seg::Line(p));
    }
    pub fn cubic_to(&mut self, c1: Vec2, c2: Vec2, p: Vec2) {
        self.segs.push(Seg::Cubic(c1, c2, p));
    }
    pub fn transformed(&self, a: &Affine) -> Path {
        Path { start: a.apply(self.start), segs: self.segs.iter().map(|s| s.map(a)).collect(), closed: self.closed, name: self.name.clone() }
    }
    /// The same path walked the other way.
    pub fn reversed(&self) -> Path {
        let mut pts = vec![self.start];
        pts.extend(self.segs.iter().map(|s| s.end()));
        let mut out = Path::new(self.end(), &self.name);
        out.closed = self.closed;
        for (i, s) in self.segs.iter().enumerate().rev() {
            let to = pts[i];
            out.segs.push(match *s {
                Seg::Line(_) => Seg::Line(to),
                Seg::Cubic(c1, c2, _) => Seg::Cubic(c2, c1, to),
            });
        }
        out
    }
    /// Points along the path (start included); closed paths do not repeat the start.
    pub fn flatten(&self) -> Vec<Vec2> {
        let mut out = vec![self.start];
        let mut cur = self.start;
        for s in &self.segs {
            match *s {
                Seg::Line(p) => out.push(p),
                Seg::Cubic(c1, c2, p) => out.extend(flatten_cubic(cur, c1, c2, p)),
            }
            cur = s.end();
        }
        if self.closed && out.len() > 1 && out[0].dist(*out.last().unwrap()) < 1e-9 {
            out.pop();
        }
        out
    }
    pub fn bbox(&self) -> Rect {
        Rect::of(&self.flatten())
    }
}

/// A 2D affine map: `x' = a x + c y + e`, `y' = b x + d y + f` (SVG matrix order).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Affine {
    pub const IDENTITY: Affine = Affine { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
    pub fn translate(x: f64, y: f64) -> Affine {
        Affine { e: x, f: y, ..Affine::IDENTITY }
    }
    pub fn scale(x: f64, y: f64) -> Affine {
        Affine { a: x, d: y, ..Affine::IDENTITY }
    }
    /// Rotation by `deg` degrees (from +x towards +y).
    pub fn rotate(deg: f64) -> Affine {
        let (s, c) = deg.to_radians().sin_cos();
        Affine { a: c, b: s, c: -s, d: c, e: 0.0, f: 0.0 }
    }
    /// `self` after `o`: apply `o` first, then `self`.
    pub fn then_after(&self, o: &Affine) -> Affine {
        Affine {
            a: self.a * o.a + self.c * o.b,
            b: self.b * o.a + self.d * o.b,
            c: self.a * o.c + self.c * o.d,
            d: self.b * o.c + self.d * o.d,
            e: self.a * o.e + self.c * o.f + self.e,
            f: self.b * o.e + self.d * o.f + self.f,
        }
    }
    pub fn apply(&self, p: Vec2) -> Vec2 {
        v(self.a * p.x + self.c * p.y + self.e, self.b * p.x + self.d * p.y + self.f)
    }
    /// Average length scale (square root of the determinant).
    pub fn scale_factor(&self) -> f64 {
        (self.a * self.d - self.b * self.c).abs().sqrt()
    }
}

/// Cubic Beziers for an elliptical arc around `c` with radii `rx`, `ry`, x axis turned by `phi`
/// radians, from angle `t0` sweeping `dt` radians (positive = from +x towards +y). Returns the
/// segments after the arc's start point, at most a quarter turn each.
pub fn arc_cubics(c: Vec2, rx: f64, ry: f64, phi: f64, t0: f64, dt: f64) -> Vec<Seg> {
    let n = ((dt.abs() / (std::f64::consts::FRAC_PI_2 + 1e-9)).ceil() as usize).max(1);
    let step = dt / n as f64;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let (sp, cp) = phi.sin_cos();
    let pt = |t: f64| {
        let (s, co) = t.sin_cos();
        let (x, y) = (rx * co, ry * s);
        v(c.x + x * cp - y * sp, c.y + x * sp + y * cp)
    };
    let der = |t: f64| {
        let (s, co) = t.sin_cos();
        let (x, y) = (-rx * s, ry * co);
        v(x * cp - y * sp, x * sp + y * cp)
    };
    (0..n)
        .map(|i| {
            let a = t0 + step * i as f64;
            let b = a + step;
            Seg::Cubic(pt(a) + der(a) * k, pt(b) - der(b) * k, pt(b))
        })
        .collect()
}

/// A circular arc from `p0` to `p1` turning through `sweep` radians (positive = from +x towards
/// +y, which is counter-clockwise in a y-up drawing such as DXF).
pub fn arc_through(p0: Vec2, p1: Vec2, sweep: f64) -> Vec<Seg> {
    let chord = p1 - p0;
    let l = chord.len();
    if l < 1e-12 || sweep.abs() < 1e-9 {
        return vec![Seg::Line(p1)];
    }
    let r = l / (2.0 * (sweep / 2.0).sin()).abs();
    // Travelling with increasing angle, the centre is on the left of the chord for a minor arc
    // and on the right for a major one (and the other way for a negative sweep).
    let mid = (p0 + p1) * 0.5;
    let h = (r * r - l * l / 4.0).max(0.0).sqrt();
    let left = chord.normalized().left();
    let side = if (sweep > 0.0) == (sweep.abs() < std::f64::consts::PI) { 1.0 } else { -1.0 };
    let c = mid + left * (h * side);
    let t0 = (p0.y - c.y).atan2(p0.x - c.x);
    let mut segs = arc_cubics(c, r, r, 0.0, t0, sweep);
    if let Some(Seg::Cubic(_, _, e)) = segs.last_mut() {
        *e = p1;
    }
    segs
}

/// Standard base64 (for data URLs).
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for ch in bytes.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if ch.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if ch.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::cubic_point;

    #[test]
    fn import_arc_through_is_round() {
        // A half circle of radius 10 from (0,0) to (20,0) with a positive sweep passes y = -10.
        let segs = arc_through(v(0.0, 0.0), v(20.0, 0.0), std::f64::consts::PI);
        let mut cur = v(0.0, 0.0);
        for s in &segs {
            if let Seg::Cubic(c1, c2, p) = *s {
                for i in 0..=10 {
                    let q = cubic_point(cur, c1, c2, p, i as f64 / 10.0);
                    assert!((q.dist(v(10.0, 0.0)) - 10.0).abs() < 0.003, "{q:?}");
                }
                cur = p;
            }
        }
        let Seg::Cubic(_, _, mid) = segs[0] else { unreachable!() };
        assert!(mid.y < -9.9, "{mid:?}");
    }

    #[test]
    fn import_affine_order_and_base64() {
        let t = Affine::translate(10.0, 0.0).then_after(&Affine::scale(2.0, 2.0));
        assert_eq!(t.apply(v(1.0, 1.0)), v(12.0, 2.0));
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }

    #[test]
    fn import_rejects_unknown_files() {
        assert!(import_file(b"hello", "docx", &ImportOptions::default()).is_err());
    }
}
