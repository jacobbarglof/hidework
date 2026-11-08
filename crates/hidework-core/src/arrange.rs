//! Arrangement: where each piece starts in 3D, like CLO's arrangement points around an avatar.
//! Here the "avatar" is the form (a bag's outside box or oval). A piece goes on a face (front,
//! back, sides, bottom, top), wraps round it (gusset, tube, back panel with flap), or arches over
//! it (handles, shoulder straps). Millimetres, z up, the form's base centred on the origin.
//!
//! A piece's local frame maps pattern x and y onto the surface; its third axis (the flesh side,
//! +z when the piece lies flat) points into the form, so the grain faces out.

use crate::compute::ComputedPiece;
use crate::geom::{Rect, Vec2};
use crate::model::{Face, Form, Piece, Place, Project};

pub type P3 = [f64; 3];

fn add(a: P3, b: P3) -> P3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: P3, s: f64) -> P3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: P3, b: P3) -> P3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn unit(a: P3) -> P3 {
    let l = dot(a, a).sqrt().max(1e-12);
    mul(a, 1.0 / l)
}

/// A polyline spine with arc length, extrapolated straight past both ends.
#[derive(Clone, Debug)]
pub struct Spine {
    pts: Vec<P3>,
    cum: Vec<f64>,
}

impl Spine {
    pub fn new(pts: Vec<P3>) -> Spine {
        let mut p: Vec<P3> = Vec::with_capacity(pts.len());
        for q in pts {
            if p.last().map_or(true, |l| dot(sub(q, *l), sub(q, *l)) > 1e-10) {
                p.push(q);
            }
        }
        let mut cum = vec![0.0];
        for w in p.windows(2) {
            let d = sub(w[1], w[0]);
            cum.push(cum.last().unwrap() + dot(d, d).sqrt());
        }
        Spine { pts: p, cum }
    }
    pub fn len(&self) -> f64 {
        *self.cum.last().unwrap_or(&0.0)
    }
    /// Point and unit tangent at arc length s.
    pub fn at(&self, s: f64) -> (P3, P3) {
        let n = self.pts.len();
        if n < 2 {
            return (self.pts.first().copied().unwrap_or([0.0; 3]), [1.0, 0.0, 0.0]);
        }
        let k = match self.cum.iter().position(|&c| c > s) {
            Some(0) => 0,
            Some(i) => i - 1,
            None => n - 2,
        }
        .min(n - 2);
        let t = unit(sub(self.pts[k + 1], self.pts[k]));
        (add(self.pts[k], mul(t, s - self.cum[k])), t)
    }
    /// Arc length of the nearest point.
    pub fn project(&self, w: P3) -> f64 {
        let mut best = (f64::INFINITY, 0.0);
        for k in 0..self.pts.len().saturating_sub(1) {
            let (a, b) = (self.pts[k], self.pts[k + 1]);
            let ab = sub(b, a);
            let l2 = dot(ab, ab).max(1e-12);
            let t = (dot(sub(w, a), ab) / l2).clamp(0.0, 1.0);
            let q = add(a, mul(ab, t));
            let d = dot(sub(w, q), sub(w, q));
            if d < best.0 {
                best = (d, self.cum[k] + t * l2.sqrt());
            }
        }
        best.1
    }
}

#[derive(Clone, Debug)]
enum Kind {
    /// On the template sheet: local + position, flat on the floor.
    Flat { position: Vec2 },
    Plane { origin: P3, x: P3, y: P3 },
    /// Follows a spine with the piece's x (or y when `along_y`). The cross direction is fixed
    /// (`cross`), or derived from a fixed normal (`normal`) for handles that bend in their plane.
    Path { spine: Spine, cross: Option<P3>, normal: Option<P3>, along_y: bool, anchor_end: bool },
}

/// Maps pattern coordinates (compensated, piece-local, y down) to the 3D start position.
#[derive(Clone, Debug)]
pub struct Frame {
    kind: Kind,
    /// The local point that lands on the face's reference point.
    center: Vec2,
    bounds: Rect,
}

impl Frame {
    pub fn is_flat(&self) -> bool {
        matches!(self.kind, Kind::Flat { .. })
    }

    /// Local frame (point, x axis, y axis, normal) at a pattern point.
    fn local(&self, p: Vec2) -> (P3, P3, P3, P3) {
        match &self.kind {
            Kind::Flat { position } => ([p.x + position.x, p.y + position.y, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
            Kind::Plane { origin, x, y } => {
                let d = p - self.center;
                (add(*origin, add(mul(*x, d.x), mul(*y, d.y))), *x, *y, cross(*x, *y))
            }
            Kind::Path { spine, cross: c, normal, along_y, anchor_end } => {
                let (along, across) = if *along_y { (p.y, p.x - self.center.x) } else { (p.x, p.y - self.center.y) };
                let s = if *anchor_end {
                    spine.len() - (self.bounds.max.y - along)
                } else {
                    let mid = if *along_y { self.center.y } else { self.center.x };
                    spine.len() / 2.0 + (along - mid)
                };
                let (o, t) = spine.at(s);
                let c = match (c, normal) {
                    (Some(c), _) => *c,
                    (None, Some(n)) => unit(cross(*n, t)),
                    _ => [0.0, 0.0, 1.0],
                };
                let pt = add(o, mul(c, across));
                if *along_y {
                    (pt, c, t, cross(c, t))
                } else {
                    (pt, t, c, cross(t, c))
                }
            }
        }
    }

    /// World position (mm) of a folded local point `q` = (x, y, z toward the flesh side).
    pub fn map(&self, q: [f64; 3]) -> P3 {
        let (o, _, _, n) = self.local(Vec2 { x: q[0], y: q[1] });
        add(o, mul(n, q[2]))
    }

    /// Inward (flesh side) normal at a pattern point.
    pub fn normal(&self, p: Vec2) -> P3 {
        self.local(p).3
    }

    /// The pattern point that lands nearest a world point (for placing matching hardware).
    pub fn inverse(&self, w: P3) -> Vec2 {
        match &self.kind {
            Kind::Flat { position } => Vec2 { x: w[0] - position.x, y: w[1] - position.y },
            Kind::Plane { origin, x, y } => {
                let d = sub(w, *origin);
                self.center + Vec2 { x: dot(d, *x), y: dot(d, *y) }
            }
            Kind::Path { spine, cross: c, normal, along_y, anchor_end } => {
                let s = spine.project(w);
                let (o, t) = spine.at(s);
                let cdir = match (c, normal) {
                    (Some(c), _) => *c,
                    (None, Some(n)) => unit(cross(*n, t)),
                    _ => [0.0, 0.0, 1.0],
                };
                let across = dot(sub(w, o), cdir);
                let along = if *anchor_end {
                    s - spine.len() + self.bounds.max.y
                } else {
                    s - spine.len() / 2.0 + if *along_y { self.center.y } else { self.center.x }
                };
                if *along_y {
                    Vec2 { x: across + self.center.x, y: along }
                } else {
                    Vec2 { x: along, y: across + self.center.y }
                }
            }
        }
    }
}

fn arc(c: P3, r: f64, a0: f64, a1: f64, u: P3, v: P3, n: usize) -> Vec<P3> {
    (0..=n).map(|k| {
        let a = a0 + (a1 - a0) * k as f64 / n as f64;
        add(c, add(mul(u, r * a.cos()), mul(v, r * a.sin())))
    }).collect()
}

/// Half a semi-ellipse's perimeter (Ramanujan).
fn half_ellipse(a: f64, b: f64) -> f64 {
    let h = ((a - b) / (a + b)).powi(2);
    std::f64::consts::PI * (a + b) * (1.0 + 3.0 * h / (10.0 + (4.0 - 3.0 * h).sqrt())) / 2.0
}

/// An arch in the plane spanned by `side` (half-span direction) and z: up from the start tab,
/// over, and down the end tab, sized so its length is `len`.
fn arch(center: P3, side: P3, half: f64, top: f64, tab: f64, len: f64) -> Vec<P3> {
    arch_flared(center, side, half, 0.0, top, tab, len)
}

/// An arch whose arc starts `flare` further out than its tabs (to clear something at the top,
/// such as a flap's edges).
fn arch_flared(center: P3, side: P3, half: f64, flare: f64, top: f64, tab: f64, len: f64) -> Vec<P3> {
    let tab_half = half;
    let half = half + flare;
    let arc_len = (len - 2.0 * tab - 2.0 * flare).max(half * 2.2);
    let (mut lo, mut hi) = (1.0, 5000.0);
    for _ in 0..60 {
        let mid = (lo + hi) / 2.0;
        if half_ellipse(half, mid) > arc_len {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    let b = (lo + hi) / 2.0;
    let base = [center[0], center[1], top];
    let at = |t: f64| add(base, add(mul(side, half * t.cos()), [0.0, 0.0, b * t.sin()]));
    let mut pts = vec![add(add(base, mul(side, tab_half)), [0.0, 0.0, -tab])];
    if flare > 0.0 {
        pts.push(add(base, mul(side, tab_half)));
    }
    for k in 0..=48 {
        pts.push(at(std::f64::consts::PI * k as f64 / 48.0));
    }
    if flare > 0.0 {
        pts.push(add(base, mul(side, -tab_half)));
    }
    pts.push(add(add(base, mul(side, -tab_half)), [0.0, 0.0, -tab]));
    pts
}

pub fn form_of(project: &Project) -> Form {
    project.form.clone().unwrap_or_default()
}

/// Thickness of the piece's material (for automatic layer offsets).
fn thickness(project: &Project, piece: &Piece) -> f64 {
    project.material(&piece.material_id).map_or(1.5, |m| m.thickness_mm)
}

pub fn frame(project: &Project, piece: &Piece, cp: &ComputedPiece) -> Frame {
    let b = Rect::of(&cp.outline);
    let place = piece.place.clone().unwrap_or_default();
    let flat = Frame { kind: Kind::Flat { position: piece.position }, center: b.center(), bounds: b };
    if place.face == Face::Flat {
        return flat;
    }
    let f = form_of(project);
    let (w, d, h) = (f.width_mm.max(10.0), f.depth_mm.max(1.0), f.height_mm.max(10.0));
    let t = thickness(project, piece);
    let l = place.layer_mm;
    let center = b.center() - place.offset;
    // The form is the stitch-line size of the bag: walls stand with their bottom stitch line on
    // the floor line, so their cut edge sits one margin lower.
    let m = if piece.edges.iter().any(|e| e.stitched) { piece.stitch.margin_mm } else { 0.0 };
    let foot = Vec2 { x: center.x, y: b.max.y - place.offset.y };
    let wall = |origin: P3, x: P3| Frame { kind: Kind::Plane { origin: [origin[0], origin[1], -m], x, y: [0.0, 0.0, -1.0] }, center: foot, bounds: b };
    let plane = |origin: P3, x: P3, y: P3| Frame { kind: Kind::Plane { origin, x, y }, center, bounds: b };
    let (xp, xn, yp, yn, zp, zn) = ([1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]);
    match place.face {
        Face::Flat => flat,
        Face::Front => wall([0.0, -d / 2.0 - l, 0.0], xp),
        Face::Back => wall([0.0, d / 2.0 + l, 0.0], xn),
        Face::Left => wall([-w / 2.0 - l, 0.0, 0.0], yn),
        Face::Right => wall([w / 2.0 + l, 0.0, 0.0], yp),
        Face::Bottom => plane([0.0, 0.0, -l], xp, yp),
        Face::Top => plane([0.0, 0.0, h + l], xp, yn),
        Face::WrapSides => {
            let (x0, z0) = (w / 2.0 + l, -l);
            let r = f.corner_mm.clamp(0.0, (w / 2.0).min(h) * 0.9) + if f.corner_mm > 0.0 { l } else { 0.0 };
            let mut pts = vec![[-x0, 0.0, h], [-x0, 0.0, z0 + r]];
            if r > 0.5 {
                pts.extend(arc([-x0 + r, 0.0, z0 + r], r, std::f64::consts::PI, 1.5 * std::f64::consts::PI, xp, zp, 12));
                pts.extend(arc([x0 - r, 0.0, z0 + r], r, 1.5 * std::f64::consts::PI, 2.0 * std::f64::consts::PI, xp, zp, 12));
            } else {
                pts.extend([[-x0, 0.0, z0], [x0, 0.0, z0]]);
            }
            pts.extend([[x0, 0.0, z0 + r], [x0, 0.0, h]]);
            Frame { kind: Kind::Path { spine: Spine::new(pts), cross: Some(yp), normal: None, along_y: false, anchor_end: false }, center, bounds: b }
        }
        Face::WrapAround => {
            let (a, c) = (w / 2.0 + l, d / 2.0 + l);
            let pts: Vec<P3> = if f.round {
                (0..=144).map(|k| {
                    let th = std::f64::consts::FRAC_PI_2 + 2.0 * std::f64::consts::PI * k as f64 / 144.0;
                    [a * th.cos(), c * th.sin(), -m]
                }).collect()
            } else {
                vec![[0.0, c, -m], [-a, c, -m], [-a, -c, -m], [a, -c, -m], [a, c, -m], [0.0, c, -m]]
            };
            Frame { kind: Kind::Path { spine: Spine::new(pts), cross: Some(zn), normal: None, along_y: false, anchor_end: false }, center: foot, bounds: b }
        }
        Face::BackFlap => {
            // Up the back, over the top and down the front, a layer's clearance outside the
            // gusset and front: their cut edges stand a seam margin proud of the form.
            let gap = l + m + t + 1.5;
            let top = h + m + gap;
            let ext = h * 2.0;
            let pts = vec![[0.0, -d / 2.0 - gap, top - ext], [0.0, -d / 2.0 - gap, top], [0.0, d / 2.0 + l, top], [0.0, d / 2.0 + l, -m]];
            Frame { kind: Kind::Path { spine: Spine::new(pts), cross: Some(xn), normal: None, along_y: true, anchor_end: true }, center, bounds: b }
        }
        Face::HandleFront | Face::HandleBack => {
            let front = place.face == Face::HandleFront;
            let lay = if l != 0.0 { l } else { t + 0.6 };
            let y = if front { -d / 2.0 - lay } else { d / 2.0 + lay };
            let half = if place.span_mm > 0.0 { place.span_mm / 2.0 } else { w * 0.22 };
            let tab = if place.tab_mm > 0.0 { place.tab_mm } else { 40.0 };
            let side = if front { xp } else { xn };
            let pts = arch([0.0, y, 0.0], side, half, h, tab, b.width());
            Frame { kind: Kind::Path { spine: Spine::new(pts), cross: None, normal: Some(if front { yp } else { yn }), along_y: false, anchor_end: false }, center, bounds: b }
        }
        Face::StrapSides => {
            let lay = if l != 0.0 { l } else { t + 0.6 };
            let half = if place.span_mm > 0.0 { place.span_mm / 2.0 } else { w / 2.0 + lay };
            let tab = if place.tab_mm > 0.0 { place.tab_mm } else { 40.0 };
            // Under a flap, the strap steps out past the flap's edges before rising.
            let flap = project.pieces.iter().any(|q| q.place.as_ref().is_some_and(|p| p.face == Face::BackFlap));
            let flare = if flap && place.span_mm <= 0.0 { m + t + 2.0 } else { 0.0 };
            let pts = arch_flared([0.0, 0.0, 0.0], xn, half, flare, h, tab, b.width());
            Frame { kind: Kind::Path { spine: Spine::new(pts), cross: Some(yn), normal: None, along_y: false, anchor_end: false }, center, bounds: b }
        }
    }
}

/// True when any piece in the project is arranged on the form.
pub fn arranged(project: &Project) -> bool {
    project.pieces.iter().any(|p| p.place.as_ref().is_some_and(|pl| pl.face != Face::Flat))
}

pub fn default_place(face: Face) -> Place {
    Place { face, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::compute;
    use crate::geom::v;
    use crate::model::*;
    use crate::templates::blank;

    fn rect(id: &str, w: f64, h: f64, face: Face) -> Piece {
        let mut p = crate::generators::panel(id, id, "m1", w, h);
        p.place = Some(default_place(face));
        p
    }

    #[test]
    fn faces_put_grain_outside_and_round_trip() {
        let mut proj = blank();
        proj.form = Some(Form { width_mm: 300.0, depth_mm: 100.0, height_mm: 250.0, round: false, corner_mm: 0.0 });
        for face in [Face::Front, Face::Back, Face::Left, Face::Right, Face::Bottom, Face::WrapSides, Face::WrapAround, Face::BackFlap, Face::HandleFront, Face::StrapSides] {
            proj.pieces = vec![rect("p", 120.0, 80.0, face)];
            let c = compute(&proj);
            let fr = frame(&proj, &proj.pieces[0], &c.pieces[0]);
            let p = v(70.0, 30.0);
            let w = fr.map([p.x, p.y, 0.0]);
            let back = fr.inverse(w);
            assert!(back.dist(p) < 0.5, "{face:?}: {p:?} -> {w:?} -> {back:?}");
            // The flesh side faces the form's centre line (or down onto a bottom panel).
            let n = fr.normal(p);
            let to_center = sub([0.0, 0.0, 125.0], w);
            if !matches!(face, Face::HandleFront | Face::StrapSides) {
                assert!(dot(n, to_center) > 0.0, "{face:?} normal {n:?} at {w:?}");
            }
        }
    }

    #[test]
    fn front_panel_sits_on_the_front_upright() {
        let mut proj = blank();
        proj.form = Some(Form { width_mm: 300.0, depth_mm: 100.0, height_mm: 250.0, round: false, corner_mm: 0.0 });
        proj.pieces = vec![rect("p", 300.0, 250.0, Face::Front)];
        let c = compute(&proj);
        let fr = frame(&proj, &proj.pieces[0], &c.pieces[0]);
        // Pattern top-left (y down) is the bag's top-left seen from the front.
        let tl = fr.map([0.0, 0.0, 0.0]);
        assert!((tl[0] + 150.0).abs() < 1e-6 && (tl[1] + 50.0).abs() < 1e-6 && (tl[2] - 250.0).abs() < 1e-6, "{tl:?}");
    }
}
