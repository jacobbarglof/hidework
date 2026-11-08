//! Parametric piece builders: straps and belts, gussets, linings.

use crate::geom::{offset_closed, signed_area, v, Vec2};
use crate::model::*;
use serde::{Deserialize, Serialize};

const K: f64 = 0.552_284_75;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tip {
    Round,
    Point,
    Square,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StrapParams {
    pub name: String,
    pub length_mm: f64,
    pub width_mm: f64,
    pub tip: Tip,
    /// Number of adjustment holes at the tip end.
    pub holes: u32,
    pub hole_spacing_mm: f64,
    /// From the very tip to the first (outermost) hole.
    pub first_hole_mm: f64,
    pub hole_mm: f64,
    /// Fold the other end around a buckle: adds a fold, a tongue slot and two rivet holes.
    pub buckle_end: bool,
    /// Length of strap that wraps the buckle (both layers together).
    pub buckle_fold_mm: f64,
    pub tongue_slot_mm: f64,
    pub rivet_mm: f64,
    /// Stitch both long edges.
    pub stitched: bool,
}

impl Default for StrapParams {
    fn default() -> Self {
        StrapParams {
            name: "Strap".into(),
            length_mm: 1000.0,
            width_mm: 38.0,
            tip: Tip::Round,
            holes: 5,
            hole_spacing_mm: 25.0,
            first_hole_mm: 90.0,
            hole_mm: 4.0,
            buckle_end: true,
            buckle_fold_mm: 70.0,
            tongue_slot_mm: 20.0,
            rivet_mm: 3.0,
            stitched: false,
        }
    }
}

fn base_piece(name: &str, material_id: &str, at: Vec2) -> Piece {
    Piece {
        id: String::new(),
        name: name.into(),
        material_id: material_id.into(),
        position: at,
        vertices: vec![],
        edges: vec![],
        cut_count: 1,
        seam_allowance_mm: 0.0,
        stitch: StitchSettings::default(),
        folds: vec![],
        holes: vec![],
        grain_deg: 0.0,
        notes: String::new(),
        hardware: vec![],
        marks: vec![],
        place: None,
    }
}

/// A plain `w` by `h` rectangle: edge 0 top, 1 right, 2 bottom, 3 left (y down).
pub fn panel(id: &str, name: &str, material_id: &str, w: f64, h: f64) -> Piece {
    let mut pc = base_piece(name, material_id, v(0.0, 0.0));
    pc.id = id.into();
    pc.vertices = vec![v(0.0, 0.0), v(w, 0.0), v(w, h), v(0.0, h)];
    pc.edges = (0..4).map(|_| Edge::line(false)).collect();
    pc.grain_deg = 90.0;
    pc
}

/// A panel with rounded bottom corners: edges 0 top, 1 right, 2 corner, 3 bottom, 4 corner,
/// 5 left. With no radius it is a plain rectangle (edges 0 to 3).
pub fn panel_rounded_bottom(id: &str, name: &str, material_id: &str, w: f64, h: f64, r: f64) -> Piece {
    let r = r.clamp(0.0, (w / 2.0).min(h) - 1.0);
    if r < 0.5 {
        return panel(id, name, material_id, w, h);
    }
    let mut pc = base_piece(name, material_id, v(0.0, 0.0));
    pc.id = id.into();
    pc.vertices = vec![v(0.0, 0.0), v(w, 0.0), v(w, h - r), v(w - r, h), v(r, h), v(0.0, h - r)];
    pc.edges = vec![
        Edge::line(false),
        Edge::line(false),
        Edge::new(EdgeKind::Cubic { c1: v(w, h - r + r * K), c2: v(w - r + r * K, h) }, false),
        Edge::line(false),
        Edge::new(EdgeKind::Cubic { c1: v(r - r * K, h), c2: v(0.0, h - r + r * K) }, false),
        Edge::line(false),
    ];
    pc.grain_deg = 90.0;
    pc
}

/// An ellipse `w` by `h` from four cubic edges (bucket bag bottoms, round patches).
pub fn ellipse(id: &str, name: &str, material_id: &str, w: f64, h: f64) -> Piece {
    let (a, b) = (w / 2.0, h / 2.0);
    let mut pc = base_piece(name, material_id, v(0.0, 0.0));
    pc.id = id.into();
    pc.vertices = vec![v(a, 0.0), v(w, b), v(a, h), v(0.0, b)];
    pc.edges = vec![
        Edge::new(EdgeKind::Cubic { c1: v(a + a * K, 0.0), c2: v(w, b - b * K) }, false),
        Edge::new(EdgeKind::Cubic { c1: v(w, b + b * K), c2: v(a + a * K, h) }, false),
        Edge::new(EdgeKind::Cubic { c1: v(a - a * K, h), c2: v(0.0, b + b * K) }, false),
        Edge::new(EdgeKind::Cubic { c1: v(0.0, b - b * K), c2: v(a - a * K, 0.0) }, false),
    ];
    pc
}

/// Round off corner `vertex` of a straight-edged corner with radius `r` (a corner punch).
pub fn round_corner(pc: &mut Piece, vertex: usize, r: f64) -> Result<(), String> {
    let n = pc.vertices.len();
    if vertex >= n || n < 3 {
        return Err("No such corner".into());
    }
    let prev = (vertex + n - 1) % n;
    if !matches!(pc.edges[prev].kind, EdgeKind::Line) || !matches!(pc.edges[vertex].kind, EdgeKind::Line) {
        return Err("Both edges at the corner must be straight".into());
    }
    let (a, p, b) = (pc.vertices[prev], pc.vertices[vertex], pc.vertices[(vertex + 1) % n]);
    let (u, w) = ((a - p).normalized(), (b - p).normalized());
    let cos = u.dot(w).clamp(-1.0, 1.0);
    let half = cos.acos() / 2.0;
    if half < 0.05 || half > 1.52 {
        return Err("The corner is too sharp or too flat to round".into());
    }
    // Tangent points sit r / tan(half) from the corner.
    let d = (r / half.tan()).min(a.dist(p) * 0.49).min(b.dist(p) * 0.49);
    let (t1, t2) = (p + u * d, p + w * d);
    // Cubic approximation of the arc between the tangent points.
    let k = 4.0 / 3.0 * ((std::f64::consts::PI - 2.0 * half) / 4.0).tan() * (d * half.tan());
    let c1 = t1 - u * k;
    let c2 = t2 - w * k;
    let stitched = pc.edges[vertex].stitched || pc.edges[prev].stitched;
    let template = pc.edges[vertex].clone();
    pc.vertices[vertex] = t1;
    pc.vertices.insert(vertex + 1, t2);
    pc.edges.insert(vertex, Edge { kind: EdgeKind::Cubic { c1, c2 }, stitched, ..template });
    Ok(())
}

/// A V-shaped dart cut into edge `edge` at fraction `t` along it, `width` across the mouth and
/// `depth` deep. Returns the indices of the two new edges, which sew together.
pub fn add_dart(pc: &mut Piece, edge: usize, t: f64, width: f64, depth: f64) -> Result<(usize, usize), String> {
    let n = pc.vertices.len();
    if edge >= n || !matches!(pc.edges[edge].kind, EdgeKind::Line) {
        return Err("Darts go on straight edges".into());
    }
    let (a, b) = (pc.vertices[edge], pc.vertices[(edge + 1) % n]);
    let len = a.dist(b);
    let dir = (b - a).normalized();
    let s = crate::geom::signed_area(&pc.vertices);
    // Inward normal (y down coordinates follow the same winding rule as offsets).
    let inward = dir.left() * if s > 0.0 { 1.0 } else { -1.0 };
    let mid = (t.clamp(0.1, 0.9)) * len;
    let w = width.min(len * 0.4);
    let (m1, m2) = (a + dir * (mid - w / 2.0), a + dir * (mid + w / 2.0));
    let apex = a + dir * mid + inward * depth.min(len);
    let base = pc.edges[edge].clone();
    pc.vertices.splice(edge + 1..edge + 1, [m1, apex, m2]);
    pc.edges.splice(edge + 1..edge + 1, [Edge::line(base.stitched), Edge::line(base.stitched), base.clone()]);
    Ok((edge + 1, edge + 2))
}

/// A strap laid out along +x: buckle end at x = 0, tip at x = length.
pub fn strap(p: &StrapParams, material_id: &str, at: Vec2, id: &str) -> Piece {
    let (l, w) = (p.length_mm.max(p.width_mm * 2.0), p.width_mm.max(5.0));
    let mut pc = base_piece(&p.name, material_id, at);
    pc.id = id.into();
    let r = w / 2.0;
    let body = match p.tip {
        Tip::Square => l,
        Tip::Round | Tip::Point => l - r,
    };
    // Top edge (y = 0) from the buckle end to where the tip starts.
    pc.vertices.push(v(0.0, 0.0));
    pc.edges.push(Edge::line(p.stitched));
    pc.vertices.push(v(body, 0.0));
    match p.tip {
        Tip::Square => {
            pc.edges.push(Edge::line(false));
            pc.vertices.push(v(l, w));
        }
        Tip::Point => {
            pc.edges.push(Edge::line(false));
            pc.vertices.push(v(l, r));
            pc.edges.push(Edge::line(false));
            pc.vertices.push(v(body, w));
        }
        Tip::Round => {
            pc.edges.push(Edge::new(EdgeKind::Cubic { c1: v(body + r * K, 0.0), c2: v(l, r - r * K) }, false));
            pc.vertices.push(v(l, r));
            pc.edges.push(Edge::new(EdgeKind::Cubic { c1: v(l, r + r * K), c2: v(body + r * K, w) }, false));
            pc.vertices.push(v(body, w));
        }
    }
    if p.tip == Tip::Square {
        // The square tip's second corner is (l, w); close along the bottom.
        pc.edges.push(Edge::line(p.stitched));
        pc.vertices.push(v(0.0, w));
    } else {
        pc.edges.push(Edge::line(p.stitched));
        pc.vertices.push(v(0.0, w));
    }
    // Buckle end.
    pc.edges.push(Edge::line(false));
    // Square tip built (0,0) (body,0) (l,w) (0,w): fix the missing (l,0) corner.
    if p.tip == Tip::Square {
        pc.vertices = vec![v(0.0, 0.0), v(l, 0.0), v(l, w), v(0.0, w)];
        pc.edges = vec![Edge::line(p.stitched), Edge::line(false), Edge::line(p.stitched), Edge::line(false)];
    }
    for k in 0..p.holes {
        let x = l - p.first_hole_mm - k as f64 * p.hole_spacing_mm;
        if x > r {
            pc.holes.push(Hole {
                id: format!("{id}-h{k}"),
                center: v(x, r),
                diameter_mm: p.hole_mm,
                label: if k == 0 { "Adjust".into() } else { String::new() },
                length_mm: 0.0,
                angle_deg: 0.0,
            });
        }
    }
    if p.buckle_end {
        let f = p.buckle_fold_mm.max(20.0);
        pc.folds.push(Fold { id: format!("{id}-f"), orientation: Orientation::Vertical, position: f / 2.0, contents_mm: 0.0 });
        pc.holes.push(Hole {
            id: format!("{id}-slot"),
            center: v(f / 2.0, r),
            diameter_mm: p.hole_mm,
            label: "Tongue".into(),
            length_mm: p.tongue_slot_mm,
            angle_deg: 0.0,
        });
        for (k, x) in [10.0, f - 10.0].into_iter().enumerate() {
            pc.holes.push(Hole {
                id: format!("{id}-r{k}"),
                center: v(x, r),
                diameter_mm: p.rivet_mm,
                label: "Rivet".into(),
                length_mm: 0.0,
                angle_deg: 0.0,
            });
        }
    }
    pc.grain_deg = 0.0;
    pc.notes = format!("{} mm strap, {} holes at {} mm", l.round(), p.holes, p.hole_spacing_mm);
    pc
}

/// A rectangular gusset `length` long and `width` wide with both long edges stitched.
pub fn gusset(name: &str, length_mm: f64, width_mm: f64, material_id: &str, at: Vec2, id: &str) -> Piece {
    let mut pc = base_piece(name, material_id, at);
    pc.id = id.into();
    pc.vertices = vec![v(0.0, 0.0), v(length_mm, 0.0), v(length_mm, width_mm), v(0.0, width_mm)];
    pc.edges = vec![Edge::line(true), Edge::line(false), Edge::line(true), Edge::line(false)];
    pc.grain_deg = 0.0;
    pc.notes = "Gusset: sews to the panel edge it was made from.".into();
    pc
}

/// A lining or reinforcement cut `inset_mm` inside a piece's finished outline.
pub fn lining(source: &Piece, outline: &[Vec2], inset_mm: f64, id: &str) -> Piece {
    let inner = offset_closed(outline, inset_mm);
    // Thin out the flattened curve points so the lining stays editable.
    let mut pts: Vec<Vec2> = Vec::new();
    for &p in &inner {
        if pts.last().map_or(true, |&l: &Vec2| l.dist(p) > 2.0) {
            pts.push(p);
        }
    }
    if pts.len() > 3 && pts[0].dist(*pts.last().unwrap()) < 2.0 {
        pts.pop();
    }
    if signed_area(&pts).abs() < 1.0 {
        pts = inner;
    }
    let mut pc = base_piece(&format!("{} lining", source.name), &source.material_id, source.position + v(15.0, 15.0));
    pc.id = id.into();
    pc.edges = pts.iter().map(|_| Edge::line(false)).collect();
    pc.vertices = pts;
    pc.grain_deg = source.grain_deg;
    pc
}

/// Outline points of a slot (stadium), or None for a round hole.
pub fn slot_outline(h: &Hole) -> Option<Vec<Vec2>> {
    if h.length_mm <= h.diameter_mm {
        return None;
    }
    let r = h.diameter_mm / 2.0;
    let half = (h.length_mm - h.diameter_mm) / 2.0;
    let (c, s) = (h.angle_deg.to_radians().cos(), h.angle_deg.to_radians().sin());
    let rot = |p: Vec2| h.center + v(p.x * c - p.y * s, p.x * s + p.y * c);
    let mut pts = Vec::new();
    for k in 0..=12 {
        let a = -std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * k as f64 / 12.0;
        pts.push(rot(v(half + r * a.cos(), r * a.sin())));
    }
    for k in 0..=12 {
        let a = std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * k as f64 / 12.0;
        pts.push(rot(v(-half + r * a.cos(), r * a.sin())));
    }
    Some(pts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::compute;
    use crate::templates::blank;

    #[test]
    fn belt_folds_and_holes() {
        let s = strap(&StrapParams::default(), "m1", v(0.0, 0.0), "s1");
        assert_eq!(s.vertices.len(), s.edges.len());
        assert_eq!(s.holes.iter().filter(|h| h.label == "Rivet").count(), 2);
        let mut p = blank();
        p.pieces.push(s);
        let c = compute(&p);
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
        // 3 oz goatskin folded on itself: about 1.9 mm of allowance.
        assert!((c.pieces[0].folds[0].shift_mm - std::f64::consts::PI * 3.0 * OZ_MM / 2.0).abs() < 1e-9);
    }

    #[test]
    fn square_and_point_tips_are_valid() {
        for tip in [Tip::Square, Tip::Point] {
            let s = strap(&StrapParams { tip, ..Default::default() }, "m1", v(0.0, 0.0), "s");
            assert_eq!(s.vertices.len(), s.edges.len());
            assert!(signed_area(&s.vertices).abs() > 30000.0);
        }
    }

    #[test]
    fn slot_is_stadium() {
        let h = Hole { id: "x".into(), center: v(0.0, 0.0), diameter_mm: 4.0, label: String::new(), length_mm: 20.0, angle_deg: 0.0 };
        let o = slot_outline(&h).unwrap();
        let area = signed_area(&o).abs();
        let expected = 16.0 * 4.0 + std::f64::consts::PI * 4.0;
        assert!((area - expected).abs() < 0.5, "{area}");
    }
}
