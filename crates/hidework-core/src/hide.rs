//! The leather a maker actually has: a hide, side, shoulder, belly or panel with its outline,
//! flaws (scars, brands, holes, tick bites, thin or stretchy spots), quality zones and backbone.
//!
//! All lengths are millimetres, y down. Presets are plausible generated shapes at the usual sale
//! sizes, not measurements of a real hide; a traced outline (from a photo or a drawing) replaces
//! them with the real thing.

use crate::geom::{signed_area, v, Rect, Vec2};
use serde::{Deserialize, Serialize};

pub const MM2_PER_SQFT: f64 = 92_903.04;
pub const MM2_PER_M2: f64 = 1_000_000.0;
pub const MM2_PER_DM2: f64 = 10_000.0;

/// Units leather is sold in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AreaUnit {
    #[default]
    Sqft,
    M2,
    Dm2,
}

impl AreaUnit {
    pub fn mm2(self) -> f64 {
        match self {
            AreaUnit::Sqft => MM2_PER_SQFT,
            AreaUnit::M2 => MM2_PER_M2,
            AreaUnit::Dm2 => MM2_PER_DM2,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            AreaUnit::Sqft => "sq ft",
            AreaUnit::M2 => "m²",
            AreaUnit::Dm2 => "dm²",
        }
    }
}

/// Area in the given unit.
pub fn area_in(mm2: f64, unit: AreaUnit) -> f64 {
    mm2 / unit.mm2()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HideKind {
    WholeHide,
    #[default]
    Side,
    DoubleShoulder,
    Shoulder,
    Belly,
    HalfBack,
    Panel,
    Goat,
    Lamb,
    /// Traced from a photo or drawn by hand.
    Traced,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlawKind {
    #[default]
    Scar,
    Brand,
    Hole,
    Tick,
    /// A thin or loose spot (often the belly or flanks).
    Thin,
    Stretchy,
}

/// How bad a flaw is. Minor flaws may sit under hidden parts (linings, gussets' insides);
/// major flaws and holes are cut around by every piece.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Minor,
    #[default]
    Major,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FlawShape {
    #[serde(rename_all = "camelCase")]
    Circle { center: Vec2, radius_mm: f64 },
    Polygon { points: Vec<Vec2> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flaw {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: FlawKind,
    pub shape: FlawShape,
    #[serde(default)]
    pub severity: Severity,
    #[serde(default)]
    pub note: String,
}

impl Flaw {
    pub fn circle(kind: FlawKind, center: Vec2, radius_mm: f64, severity: Severity) -> Flaw {
        Flaw { id: String::new(), kind, shape: FlawShape::Circle { center, radius_mm }, severity, note: String::new() }
    }
    /// True when nothing may be cut over it, not even hidden parts.
    pub fn blocks_everything(&self) -> bool {
        self.severity == Severity::Major || self.kind == FlawKind::Hole
    }
    /// The flaw as a polygon (circles as 32-gons that enclose the circle).
    pub fn polygon(&self) -> Vec<Vec2> {
        match &self.shape {
            FlawShape::Polygon { points } => points.clone(),
            FlawShape::Circle { center, radius_mm } => {
                let n = 32;
                // Circumscribed polygon so the polygon covers the whole circle.
                let r = radius_mm.max(0.5) / (std::f64::consts::PI / n as f64).cos();
                (0..n)
                    .map(|i| {
                        let a = i as f64 / n as f64 * std::f64::consts::TAU;
                        *center + v(a.cos(), a.sin()) * r
                    })
                    .collect()
            }
        }
    }
}

/// Leather quality: A is the firm, even back and butt; B the shoulder (wrinkles, growth marks);
/// C the belly and legs (thin, loose, stretchy).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
pub enum Grade {
    #[default]
    A,
    B,
    C,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub grade: Grade,
    pub polygon: Vec<Vec2>,
}

/// The backbone (spine) line, from the tail end to the neck. Straps and belts run along it
/// because leather stretches least that way.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backbone {
    pub from: Vec2,
    pub to: Vec2,
}

impl Backbone {
    /// Direction in degrees (0 = along +x), from tail to neck.
    pub fn angle_deg(&self) -> f64 {
        let d = self.to - self.from;
        d.y.atan2(d.x).to_degrees()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hide {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: HideKind,
    /// Closed outline, millimetres.
    pub outline: Vec<Vec2>,
    #[serde(default)]
    pub flaws: Vec<Flaw>,
    /// Quality zones, best first. A point takes the grade of the first zone it lies in; with no
    /// zones the whole piece counts as grade A, and outside every listed zone it is grade C.
    #[serde(default)]
    pub zones: Vec<Zone>,
    #[serde(default)]
    pub backbone: Option<Backbone>,
    #[serde(default = "default_thickness")]
    pub thickness_mm: f64,
    /// What the maker paid for this whole piece of leather.
    #[serde(default)]
    pub price: Option<f64>,
    /// The area stamped on the hide by the tannery (often a little more than the real area).
    #[serde(default)]
    pub stamped_sqft: Option<f64>,
}

fn default_thickness() -> f64 {
    2.0
}

impl Hide {
    pub fn area_mm2(&self) -> f64 {
        signed_area(&self.outline).abs()
    }
    pub fn area_sqft(&self) -> f64 {
        self.area_mm2() / MM2_PER_SQFT
    }
    pub fn area_m2(&self) -> f64 {
        self.area_mm2() / MM2_PER_M2
    }
    pub fn bounds(&self) -> Rect {
        Rect::of(&self.outline)
    }
    /// Backbone direction in degrees, if the leather has one that matters.
    pub fn backbone_deg(&self) -> Option<f64> {
        self.backbone.map(|b| b.angle_deg())
    }
    /// Quality at a point (outside the outline counts as C).
    pub fn grade_at(&self, p: Vec2) -> Grade {
        if self.zones.is_empty() {
            return Grade::A;
        }
        self.zones.iter().find(|z| point_in_polygon(p, &z.polygon)).map_or(Grade::C, |z| z.grade)
    }
    /// A rectangular panel, W x H millimetres (no backbone, all grade A).
    pub fn panel(name: &str, w: f64, h: f64) -> Hide {
        Hide {
            id: String::new(),
            name: name.into(),
            kind: HideKind::Panel,
            outline: vec![v(0.0, 0.0), v(w, 0.0), v(w, h), v(0.0, h)],
            flaws: vec![],
            zones: vec![],
            backbone: None,
            thickness_mm: default_thickness(),
            price: None,
            stamped_sqft: None,
        }
    }
    /// A hide from a traced outline (photo or drawing), in millimetres. The outline is cleaned
    /// (duplicate points and a repeated closing point removed) and moved so its corner is at the
    /// origin. With a backbone, A/B/C zones are guessed from it (A along the back toward the
    /// tail, B toward the neck, C far from the backbone); without one the whole hide is grade A.
    pub fn from_outline(name: &str, outline: &[Vec2], backbone: Option<Backbone>) -> Result<Hide, String> {
        let mut pts: Vec<Vec2> = Vec::with_capacity(outline.len());
        for &p in outline {
            if !(p.x.is_finite() && p.y.is_finite()) {
                return Err("The outline has a point that is not a number.".into());
            }
            if pts.last().is_none_or(|q: &Vec2| q.dist(p) > 0.01) {
                pts.push(p);
            }
        }
        while pts.len() > 1 && pts[0].dist(pts[pts.len() - 1]) <= 0.01 {
            pts.pop();
        }
        if pts.len() < 3 || signed_area(&pts).abs() < 100.0 {
            return Err("The outline needs at least three points around an area bigger than 1 cm².".into());
        }
        let b = Rect::of(&pts);
        let shift = b.min;
        let pts: Vec<Vec2> = pts.into_iter().map(|p| p - shift).collect();
        let backbone = backbone.map(|bb| Backbone { from: bb.from - shift, to: bb.to - shift });
        let mut hide = Hide {
            id: String::new(),
            name: name.into(),
            kind: HideKind::Traced,
            outline: pts,
            flaws: vec![],
            zones: vec![],
            backbone,
            thickness_mm: default_thickness(),
            price: None,
            stamped_sqft: None,
        };
        if let Some(bb) = backbone {
            hide.zones = guess_zones(&hide.outline, bb);
        }
        Ok(hide)
    }
    /// Copy with the outline moved so its bounding box starts at the origin, flaws, zones and
    /// backbone moved with it, and degenerate flaws dropped. Nesting calls this first.
    pub fn normalized(&self) -> Hide {
        let mut h = self.clone();
        let b = Rect::of(&h.outline);
        if b.is_empty() {
            return h;
        }
        let s = b.min;
        let mv = |p: &mut Vec2| *p = *p - s;
        h.outline.iter_mut().for_each(mv);
        for z in &mut h.zones {
            z.polygon.iter_mut().for_each(mv);
        }
        for f in &mut h.flaws {
            match &mut f.shape {
                FlawShape::Circle { center, .. } => mv(center),
                FlawShape::Polygon { points } => points.iter_mut().for_each(mv),
            }
        }
        h.flaws.retain(|f| match &f.shape {
            FlawShape::Circle { radius_mm, .. } => *radius_mm > 0.0,
            FlawShape::Polygon { points } => points.len() >= 3,
        });
        if let Some(bb) = &mut h.backbone {
            mv(&mut bb.from);
            mv(&mut bb.to);
        }
        h
    }
}

/// Even-odd point in polygon.
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

/// Clip a (possibly concave) polygon against a convex polygon (Sutherland-Hodgman). Concave
/// subjects can come back with zero-width bridges, which is harmless for point tests and
/// rasterising.
pub fn clip_convex(subject: &[Vec2], clip: &[Vec2]) -> Vec<Vec2> {
    let ccw = signed_area(clip) > 0.0;
    let inside = |a: Vec2, b: Vec2, p: Vec2| {
        let c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        if ccw {
            c >= 0.0
        } else {
            c <= 0.0
        }
    };
    let cross = |p: Vec2, q: Vec2, a: Vec2, b: Vec2| {
        let r = q - p;
        let s = b - a;
        let den = r.x * s.y - r.y * s.x;
        if den.abs() < 1e-12 {
            return p;
        }
        let t = ((a.x - p.x) * s.y - (a.y - p.y) * s.x) / den;
        p + r * t
    };
    let mut out = subject.to_vec();
    let m = clip.len();
    for i in 0..m {
        if out.is_empty() {
            break;
        }
        let (a, b) = (clip[i], clip[(i + 1) % m]);
        let input = std::mem::take(&mut out);
        let n = input.len();
        for k in 0..n {
            let cur = input[k];
            let prev = input[(k + n - 1) % n];
            let (ci, pi) = (inside(a, b, cur), inside(a, b, prev));
            if ci {
                if !pi {
                    out.push(cross(prev, cur, a, b));
                }
                out.push(cur);
            } else if pi {
                out.push(cross(prev, cur, a, b));
            }
        }
    }
    if out.len() < 3 || signed_area(&out).abs() < 1.0 {
        return vec![];
    }
    out
}

/// A rectangle in the backbone's frame: `along` from the tail (0) to the neck (1) and `across`
/// as a distance either side of the backbone line, in millimetres.
fn frame_rect(bb: Backbone, along: (f64, f64), across: (f64, f64)) -> Vec<Vec2> {
    let d = (bb.to - bb.from).normalized();
    let n = d.left();
    let p = |s: f64, t: f64| bb.from + d * s + n * t;
    vec![p(along.0, across.0), p(along.1, across.0), p(along.1, across.1), p(along.0, across.1)]
}

/// Guess A/B/C zones from the backbone: A within 55% of the widest reach from the backbone and
/// in the tail-end 60% of its length, B within 65% anywhere along it, C the rest.
pub fn guess_zones(outline: &[Vec2], bb: Backbone) -> Vec<Zone> {
    let d = (bb.to - bb.from).normalized();
    if d.len() < 0.5 {
        return vec![];
    }
    let n = d.left();
    let (mut s0, mut s1, mut reach) = (f64::INFINITY, f64::NEG_INFINITY, 0.0f64);
    for &p in outline {
        let q = p - bb.from;
        let s = q.dot(d);
        s0 = s0.min(s);
        s1 = s1.max(s);
        reach = reach.max(q.dot(n).abs());
    }
    let len = s1 - s0;
    let big = reach * 2.0 + len + 10.0;
    let a = frame_rect(bb, (s0 - 10.0, s0 + 0.6 * len), (-0.55 * reach, 0.55 * reach));
    let b = frame_rect(bb, (s0 - 10.0, s1 + 10.0), (-0.65 * reach, 0.65 * reach));
    let c = frame_rect(bb, (s0 - big, s1 + big), (-big, big));
    [(Grade::A, a), (Grade::B, b), (Grade::C, c)]
        .into_iter()
        .map(|(g, r)| Zone { grade: g, polygon: clip_convex(outline, &r) })
        .filter(|z| !z.polygon.is_empty())
        .collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HidePreset {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// The usual range sold, square feet.
    pub typical_sqft: (f64, f64),
    pub hide: Hide,
}

/// Closed Catmull-Rom curve through control points, `per` samples per span.
fn smooth(ctrl: &[(f64, f64)], per: usize) -> Vec<Vec2> {
    let p: Vec<Vec2> = ctrl.iter().map(|&(x, y)| v(x, y)).collect();
    let n = p.len();
    let mut out = Vec::with_capacity(n * per);
    for i in 0..n {
        let (p0, p1, p2, p3) = (p[(i + n - 1) % n], p[i], p[(i + 1) % n], p[(i + 2) % n]);
        for k in 0..per {
            let t = k as f64 / per as f64;
            let (t2, t3) = (t * t, t * t * t);
            let q = (p1 * 2.0 + (p2 - p0) * t + (p0 * 2.0 - p1 * 5.0 + p2 * 4.0 - p3) * t2 + (p1 * 3.0 - p0 - p2 * 3.0 + p3) * t3) * 0.5;
            out.push(q);
        }
    }
    out
}

/// Scale points (about the origin) so the polygon has the target area, then move it to the origin.
fn fit_area(mut pts: Vec<Vec2>, target_sqft: f64) -> (Vec<Vec2>, f64) {
    // Returns the outline and the scale used.
    let a = signed_area(&pts).abs();
    let k = (target_sqft * MM2_PER_SQFT / a).sqrt();
    for p in &mut pts {
        *p = *p * k;
    }
    let b = Rect::of(&pts);
    for p in &mut pts {
        *p = *p - b.min;
    }
    (pts, k)
}

/// Mirror a half outline across y = 0 into a whole outline. The half runs from the backbone at
/// one end round to the backbone at the other; its points on the backbone itself are dropped so
/// the whole outline does not run back through the middle.
fn mirror_half(half: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let edge: Vec<(f64, f64)> = half.iter().copied().filter(|p| p.1 > 1e-9).collect();
    let mut out = edge.clone();
    out.extend(edge.iter().rev().map(|&(x, y)| (x, -y)));
    out
}

fn base_hide(id: &str, name: &str, kind: HideKind, outline: Vec<Vec2>, backbone: Option<Backbone>, thickness_mm: f64) -> Hide {
    Hide { id: id.into(), name: name.into(), kind, outline, flaws: vec![], zones: vec![], backbone, thickness_mm, price: None, stamped_sqft: None }
}

fn rect_zone(outline: &[Vec2], grade: Grade, x0: f64, y0: f64, x1: f64, y1: f64) -> Option<Zone> {
    let r = vec![v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)];
    let polygon = clip_convex(outline, &r);
    (!polygon.is_empty()).then_some(Zone { grade, polygon })
}

/// Zones from fractions of the bounding box; the outline itself is added last as grade C.
fn zones_frac(outline: &[Vec2], rects: &[(Grade, f64, f64, f64, f64)]) -> Vec<Zone> {
    let b = Rect::of(outline);
    let (w, h) = (b.width(), b.height());
    let mut z: Vec<Zone> = rects
        .iter()
        .filter_map(|&(g, x0, y0, x1, y1)| rect_zone(outline, g, b.min.x + x0 * w, b.min.y + y0 * h, b.min.x + x1 * w, b.min.y + y1 * h))
        .collect();
    z.push(Zone { grade: Grade::C, polygon: outline.to_vec() });
    z
}

/// One side of a cow: the hide split down the backbone. The backbone is the straight top edge,
/// tail at the left, neck at the right.
fn side_half() -> Vec<(f64, f64)> {
    vec![
        (0.0, 0.0),
        (6.0, 0.0),
        (12.0, 0.0),
        (18.0, 0.0),
        (23.5, 0.3),
        (24.6, 2.0),
        (24.2, 5.0),
        (23.0, 7.6),
        (22.2, 10.0),
        (21.3, 12.4),
        (19.8, 12.6),
        (19.0, 10.4),
        (16.0, 10.6),
        (12.0, 11.0),
        (8.0, 10.6),
        (5.2, 10.2),
        (4.4, 12.4),
        (2.8, 13.4),
        (1.2, 12.8),
        (0.6, 9.4),
        (-0.4, 5.6),
        (-0.3, 2.0),
    ]
}

fn side_preset() -> Hide {
    let (outline, _) = fit_area(smooth(&side_half(), 10), 23.5);
    let b = Rect::of(&outline);
    let bb = Backbone { from: v(b.min.x, b.min.y), to: v(b.max.x, b.min.y) };
    let mut h = base_hide("side", "Full side", HideKind::Side, outline, Some(bb), 4.5 * crate::model::OZ_MM);
    h.zones = zones_frac(&h.outline, &[(Grade::A, 0.0, 0.0, 0.58, 0.5), (Grade::B, 0.58, 0.0, 1.0, 0.55), (Grade::B, 0.0, 0.5, 0.58, 0.62)]);
    h
}

fn whole_preset() -> Hide {
    let whole = mirror_half(&side_half());
    let (outline, _) = fit_area(smooth(&whole, 10), 47.0);
    let b = Rect::of(&outline);
    let cy = b.center().y;
    let bb = Backbone { from: v(b.min.x, cy), to: v(b.max.x, cy) };
    let mut h = base_hide("whole", "Whole hide", HideKind::WholeHide, outline, Some(bb), 4.5 * crate::model::OZ_MM);
    h.zones = zones_frac(&h.outline, &[(Grade::A, 0.0, 0.25, 0.58, 0.75), (Grade::B, 0.58, 0.22, 1.0, 0.78), (Grade::B, 0.0, 0.19, 0.58, 0.81)]);
    h
}

fn double_shoulder_preset() -> Hide {
    // Across both sides of the shoulder; the backbone runs up the middle, neck at the top and the
    // straight cut toward the butt at the bottom.
    let ctrl = [
        (1.4, 1.6),
        (4.0, 0.6),
        (7.5, 0.0),
        (11.0, 0.6),
        (13.6, 1.6),
        (14.8, 4.0),
        (15.1, 6.8),
        (14.6, 8.5),
        (11.0, 8.6),
        (7.5, 8.6),
        (4.0, 8.6),
        (0.4, 8.5),
        (-0.1, 6.8),
        (0.2, 4.0),
    ];
    let (outline, _) = fit_area(smooth(&ctrl, 10), 12.0);
    let b = Rect::of(&outline);
    let cx = b.center().x;
    let bb = Backbone { from: v(cx, b.max.y), to: v(cx, b.min.y) };
    let mut h = base_hide("double-shoulder", "Double shoulder", HideKind::DoubleShoulder, outline, Some(bb), 4.0 * crate::model::OZ_MM);
    h.zones = zones_frac(&h.outline, &[(Grade::A, 0.25, 0.4, 0.75, 1.0), (Grade::B, 0.1, 0.0, 0.9, 1.0)]);
    h
}

fn shoulder_preset() -> Hide {
    // One side of the shoulder: backbone along the top, neck to the right, straight cut at left.
    let ctrl = [
        (0.0, 0.0),
        (4.0, 0.0),
        (8.6, 0.2),
        (9.4, 2.0),
        (9.0, 4.6),
        (8.4, 7.0),
        (6.8, 7.8),
        (4.0, 7.4),
        (1.2, 7.6),
        (0.0, 7.2),
        (-0.1, 4.0),
    ];
    let (outline, _) = fit_area(smooth(&ctrl, 10), 7.0);
    let b = Rect::of(&outline);
    let bb = Backbone { from: v(b.min.x, b.min.y), to: v(b.max.x, b.min.y) };
    let mut h = base_hide("shoulder", "Single shoulder", HideKind::Shoulder, outline, Some(bb), 4.0 * crate::model::OZ_MM);
    h.zones = zones_frac(&h.outline, &[(Grade::A, 0.0, 0.0, 0.5, 0.5), (Grade::B, 0.0, 0.0, 1.0, 0.68)]);
    h
}

fn belly_preset() -> Hide {
    // A long strip; the straight edge was cut toward the backbone, the wavy edge is the belly.
    let ctrl = [
        (0.0, 0.0),
        (6.0, 0.0),
        (12.0, 0.0),
        (18.0, 0.0),
        (18.6, 1.2),
        (18.4, 3.4),
        (16.8, 3.8),
        (15.4, 2.6),
        (12.0, 3.0),
        (8.0, 2.8),
        (4.0, 3.0),
        (2.6, 4.2),
        (0.8, 4.0),
        (-0.3, 1.6),
    ];
    let (outline, _) = fit_area(smooth(&ctrl, 10), 5.5);
    let b = Rect::of(&outline);
    let bb = Backbone { from: v(b.min.x, b.min.y), to: v(b.max.x, b.min.y) };
    let mut h = base_hide("belly", "Belly", HideKind::Belly, outline, Some(bb), 3.5 * crate::model::OZ_MM);
    h.zones = zones_frac(&h.outline, &[(Grade::B, 0.0, 0.0, 1.0, 0.35)]);
    h
}

fn half_back_preset() -> Hide {
    // A side without its belly: backbone along the top, shoulder end at the right.
    let ctrl = [
        (0.0, 0.0),
        (6.0, 0.0),
        (12.0, 0.0),
        (18.6, 0.2),
        (19.4, 2.0),
        (19.0, 4.6),
        (18.0, 6.4),
        (12.0, 6.6),
        (6.0, 6.4),
        (0.6, 6.6),
        (-0.2, 3.2),
    ];
    let (outline, _) = fit_area(smooth(&ctrl, 10), 13.0);
    let b = Rect::of(&outline);
    let bb = Backbone { from: v(b.min.x, b.min.y), to: v(b.max.x, b.min.y) };
    let mut h = base_hide("half-back", "Half back", HideKind::HalfBack, outline, Some(bb), 5.0 * crate::model::OZ_MM);
    h.zones = zones_frac(&h.outline, &[(Grade::A, 0.0, 0.0, 0.62, 0.85), (Grade::B, 0.62, 0.0, 1.0, 0.85)]);
    h
}

/// A small whole skin (goat or lamb): backbone down the middle from tail (bottom) to neck (top).
fn small_skin(id: &str, name: &str, kind: HideKind, sqft: f64, wide: f64, thickness_mm: f64) -> Hide {
    let right = [
        (0.0, 0.0),
        (1.2 * wide, 0.1),
        (1.8 * wide, 0.8),
        (3.6 * wide, 1.2),
        (4.3 * wide, 1.7),
        (3.7 * wide, 2.3),
        (3.1 * wide, 2.9),
        (3.4 * wide, 4.6),
        (3.5 * wide, 6.5),
        (3.9 * wide, 8.0),
        (4.4 * wide, 8.9),
        (3.6 * wide, 9.3),
        (2.2 * wide, 9.1),
        (1.0 * wide, 9.7),
        (0.0, 9.9),
    ];
    // Mirror across x = 0: right side top to bottom, then left side bottom to top.
    let mut ctrl: Vec<(f64, f64)> = right.to_vec();
    ctrl.extend(right.iter().rev().filter(|p| p.0 > 1e-9).map(|&(x, y)| (-x, y)));
    let (outline, _) = fit_area(smooth(&ctrl, 10), sqft);
    let b = Rect::of(&outline);
    let cx = b.center().x;
    let bb = Backbone { from: v(cx, b.max.y), to: v(cx, b.min.y) };
    let mut h = base_hide(id, name, kind, outline, Some(bb), thickness_mm);
    h.zones = zones_frac(&h.outline, &[(Grade::A, 0.3, 0.25, 0.7, 0.82), (Grade::B, 0.18, 0.12, 0.82, 0.9)]);
    h
}

/// The leather people usually buy, as plausible generated shapes at typical sizes.
pub fn presets() -> Vec<HidePreset> {
    use crate::model::OZ_MM;
    let in_mm = 25.4;
    let mut panel_12 = Hide::panel("12 x 12 in panel", 12.0 * in_mm, 12.0 * in_mm);
    panel_12.id = "panel-12x12".into();
    let mut panel_24 = Hide::panel("12 x 24 in panel", 12.0 * in_mm, 24.0 * in_mm);
    panel_24.id = "panel-12x24".into();
    vec![
        HidePreset { id: "whole", name: "Whole hide", description: "Both sides of the cow in one piece. The most leather for the money, but big to handle.", typical_sqft: (40.0, 55.0), hide: whole_preset() },
        HidePreset { id: "side", name: "Full side", description: "Half a hide, split along the backbone. Firm back and butt, softer belly and legs.", typical_sqft: (22.0, 25.0), hide: side_preset() },
        HidePreset { id: "half-back", name: "Half back", description: "A side with the belly trimmed off: mostly firm, even leather. Good for straps and belts.", typical_sqft: (11.0, 15.0), hide: half_back_preset() },
        HidePreset { id: "double-shoulder", name: "Double shoulder", description: "The shoulder across both sides of the backbone. Good value for bags and wallets; some wrinkles.", typical_sqft: (10.0, 14.0), hide: double_shoulder_preset() },
        HidePreset { id: "shoulder", name: "Single shoulder", description: "One side of the shoulder. A handy size for small goods.", typical_sqft: (6.0, 8.0), hide: shoulder_preset() },
        HidePreset { id: "belly", name: "Belly", description: "Long strip from under the animal: thin, stretchy and cheap. Linings, gussets and practice.", typical_sqft: (4.0, 7.0), hide: belly_preset() },
        HidePreset { id: "goat", name: "Goat skin", description: "A whole small skin: thin, strong and fine-grained. Wallet insides and linings.", typical_sqft: (5.0, 7.0), hide: small_skin("goat", "Goat skin", HideKind::Goat, 6.0, 1.0, 2.0 * OZ_MM) },
        HidePreset { id: "lamb", name: "Lamb skin", description: "A whole lamb skin: soft and light. Linings, pouches and garments.", typical_sqft: (6.0, 8.0), hide: small_skin("lamb", "Lamb skin", HideKind::Lamb, 7.0, 1.1, 1.5 * OZ_MM) },
        HidePreset { id: "panel-12x12", name: "Panel 12 x 12 in", description: "A square craft panel (30 x 30 cm). Even leather, no backbone to follow.", typical_sqft: (1.0, 1.0), hide: panel_12 },
        HidePreset { id: "panel-12x24", name: "Panel 12 x 24 in", description: "A craft panel (30 x 60 cm). Enough for a few wallets or a belt.", typical_sqft: (2.0, 2.0), hide: panel_24 },
    ]
}

pub fn preset(id: &str) -> Option<Hide> {
    presets().into_iter().find(|p| p.id == id).map(|p| p.hide)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_presets_have_typical_areas() {
        for p in presets() {
            let a = p.hide.area_sqft();
            assert!(a >= p.typical_sqft.0 - 0.05 && a <= p.typical_sqft.1 + 0.05, "{} is {a} sq ft", p.id);
            assert!(p.hide.outline.len() >= 4);
            let b = p.hide.bounds();
            assert!(b.min.x.abs() < 1e-6 && b.min.y.abs() < 1e-6, "{} not at origin", p.id);
            if p.hide.kind != HideKind::Panel {
                assert!(p.hide.backbone.is_some(), "{}", p.id);
                assert!(!p.hide.zones.is_empty(), "{}", p.id);
            }
            // Every zone lies on the hide.
            for z in &p.hide.zones {
                assert!(signed_area(&z.polygon).abs() <= p.hide.area_mm2() * 1.001, "{}", p.id);
            }
        }
        // The whole hide is solid across the backbone (no slit back through the middle).
        let whole = preset("whole").unwrap();
        let wb = whole.bounds();
        assert!(point_in_polygon(wb.center(), &whole.outline));
        assert!(wb.height() > 1.6 * preset("side").unwrap().bounds().height() * 0.9);
        let side = preset("side").unwrap();
        // A side is about 2.2 m² and roughly twice as long as it is wide.
        assert!((side.area_m2() - 23.5 * MM2_PER_SQFT / MM2_PER_M2).abs() < 0.01);
        let b = side.bounds();
        assert!(b.width() > 1.6 * b.height(), "{} x {}", b.width(), b.height());
        assert!((side.backbone_deg().unwrap()).abs() < 1e-9);
        assert!((preset("double-shoulder").unwrap().backbone_deg().unwrap() + 90.0).abs() < 1e-9);
    }

    #[test]
    fn hide_zones_grade_points() {
        let side = preset("side").unwrap();
        let b = side.bounds();
        // Near the backbone at the tail end is prime; low on the belly is C.
        assert_eq!(side.grade_at(v(b.min.x + 0.3 * b.width(), b.min.y + 0.2 * b.height())), Grade::A);
        assert_eq!(side.grade_at(v(b.min.x + 0.8 * b.width(), b.min.y + 0.2 * b.height())), Grade::B);
        assert_eq!(side.grade_at(v(b.min.x + 0.5 * b.width(), b.min.y + 0.78 * b.height())), Grade::C);
        let panel = preset("panel-12x12").unwrap();
        assert_eq!(panel.grade_at(v(10.0, 10.0)), Grade::A);
        assert!((panel.area_sqft() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn hide_from_traced_outline() {
        let pts = vec![v(100.0, 50.0), v(900.0, 50.0), v(950.0, 700.0), v(80.0, 720.0), v(100.0, 50.0)];
        let bb = Backbone { from: v(100.0, 60.0), to: v(900.0, 60.0) };
        let h = Hide::from_outline("My side", &pts, Some(bb)).unwrap();
        assert_eq!(h.outline.len(), 4);
        assert_eq!(h.kind, HideKind::Traced);
        assert!(h.bounds().min.x.abs() < 1e-9 && h.bounds().min.y.abs() < 1e-9);
        assert!((h.backbone.unwrap().from.x - 20.0).abs() < 1e-9);
        assert_eq!(h.zones.first().map(|z| z.grade), Some(Grade::A));
        assert!(h.zones.iter().any(|z| z.grade == Grade::C));
        // Near the backbone at the tail end is A; the far side is C.
        assert_eq!(h.grade_at(v(150.0, 40.0)), Grade::A);
        assert_eq!(h.grade_at(v(450.0, 640.0)), Grade::C);
        assert!(Hide::from_outline("bad", &[v(0.0, 0.0), v(1.0, 0.0)], None).is_err());
        let json = serde_json::to_string(&h).unwrap();
        let back: Hide = serde_json::from_str(&json).unwrap();
        assert_eq!(back, h);
        let f: Flaw = serde_json::from_str(r#"{"kind":"brand","shape":{"type":"circle","center":{"x":1,"y":2},"radiusMm":20}}"#).unwrap();
        assert_eq!(f.severity, Severity::Major);
        assert!(f.blocks_everything());
    }

    #[test]
    fn hide_clip_and_point_tests() {
        let sq = vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 10.0), v(0.0, 10.0)];
        let clip = vec![v(5.0, -1.0), v(20.0, -1.0), v(20.0, 20.0), v(5.0, 20.0)];
        let c = clip_convex(&sq, &clip);
        assert!((signed_area(&c).abs() - 50.0).abs() < 1e-9);
        assert!(point_in_polygon(v(5.0, 5.0), &sq));
        assert!(!point_in_polygon(v(15.0, 5.0), &sq));
        assert!((area_in(MM2_PER_SQFT * 2.0, AreaUnit::Sqft) - 2.0).abs() < 1e-12);
        assert!((area_in(1e6, AreaUnit::Dm2) - 100.0).abs() < 1e-12);
    }
}
