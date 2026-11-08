//! Bag builder: a complete, sewn and arranged bag from a few measurements. Every piece is placed
//! on the form so the 3D window shows the assembled bag straight away, and matching rivets,
//! snaps and locks are placed through both layers so they fasten when simulated.

use crate::arrange::{default_place, frame, Frame};
use crate::compute::compute;
use crate::generators::{ellipse, panel, panel_rounded_bottom};
use crate::geom::{v, Vec2};
use crate::model::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BagStyle {
    /// Front, back and one gusset round the sides and bottom; two handles.
    Tote,
    /// Front, back, bottom and two side panels.
    BoxedTote,
    /// Back panel with a flap, front, gusset, shoulder strap.
    Messenger,
    /// Two panels and a zipper across the top.
    ZipPouch,
    /// An oval-bottomed tube with grommets for a drawstring.
    Bucket,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Carry {
    None,
    Handles,
    Shoulder,
    Both,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Closure {
    None,
    Magnetic,
    TurnLock,
    Snap,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BagParams {
    pub name: String,
    pub style: BagStyle,
    pub width_mm: f64,
    pub height_mm: f64,
    pub depth_mm: f64,
    /// Rounded bottom corners seen from the front.
    pub corner_mm: f64,
    /// Leather preset id (`physics::presets`).
    pub leather: String,
    /// Thickness override (0 = the preset's typical thickness).
    pub thickness_mm: f64,
    pub construction: Construction,
    pub glue: Adhesive,
    pub stitch: StitchKind,
    pub carry: Carry,
    pub handle_length_mm: f64,
    pub handle_width_mm: f64,
    pub strap_length_mm: f64,
    pub strap_width_mm: f64,
    pub closure: Closure,
    /// Messenger flap drop down the front.
    pub flap_mm: f64,
    pub pocket: bool,
    pub feet: bool,
    pub edge: EdgeFinish,
    pub thread_color: String,
}

impl Default for BagParams {
    fn default() -> Self {
        BagParams {
            name: "Tote".into(),
            style: BagStyle::Tote,
            width_mm: 340.0,
            height_mm: 300.0,
            depth_mm: 110.0,
            corner_mm: 30.0,
            leather: "pullup".into(),
            thickness_mm: 0.0,
            construction: Construction::EdgeToEdge,
            glue: Adhesive::ContactCement,
            stitch: StitchKind::Saddle,
            carry: Carry::Handles,
            handle_length_mm: 560.0,
            handle_width_mm: 25.0,
            strap_length_mm: 1250.0,
            strap_width_mm: 38.0,
            closure: Closure::Magnetic,
            flap_mm: 0.0,
            pocket: true,
            feet: true,
            edge: EdgeFinish::Painted,
            thread_color: "#efe4c8".into(),
        }
    }
}

impl BagParams {
    pub fn style_defaults(style: BagStyle) -> BagParams {
        let d = BagParams::default();
        match style {
            BagStyle::Tote => d,
            BagStyle::BoxedTote => BagParams { name: "Boxed tote".into(), style, corner_mm: 0.0, depth_mm: 140.0, ..d },
            BagStyle::Messenger => BagParams { name: "Messenger".into(), style, width_mm: 320.0, height_mm: 240.0, depth_mm: 80.0, corner_mm: 25.0, carry: Carry::Shoulder, closure: Closure::TurnLock, flap_mm: 170.0, pocket: false, feet: false, ..d },
            BagStyle::ZipPouch => BagParams { name: "Zip pouch".into(), style, width_mm: 220.0, height_mm: 140.0, depth_mm: 10.0, corner_mm: 20.0, carry: Carry::None, closure: Closure::None, pocket: false, feet: false, leather: "goat-chrome".into(), ..d },
            BagStyle::Bucket => BagParams { name: "Bucket bag".into(), style, width_mm: 230.0, height_mm: 280.0, depth_mm: 170.0, corner_mm: 0.0, carry: Carry::Shoulder, closure: Closure::None, pocket: false, leather: "chrome-cow".into(), ..d },
        }
    }
}

fn frames(p: &Project) -> Vec<(String, Frame)> {
    let c = compute(p);
    p.pieces.iter().filter_map(|pc| c.pieces.iter().find(|x| x.id == pc.id).map(|cp| (pc.id.clone(), frame(p, pc, cp)))).collect()
}

fn frame_of<'a>(f: &'a [(String, Frame)], id: &str) -> &'a Frame {
    &f.iter().find(|(k, _)| k == id).expect("piece has a frame").1
}

fn piece_mut<'a>(p: &'a mut Project, id: &str) -> &'a mut Piece {
    p.pieces.iter_mut().find(|x| x.id == id).expect("piece exists")
}

/// Put hardware at local points of `from` and at the matching points of `onto` (through both).
fn fasten(p: &mut Project, from: &str, pts: &[Vec2], onto: &str, kind: &str, size: f64) {
    let f = frames(p);
    let (ff, fo) = (frame_of(&f, from).clone(), frame_of(&f, onto).clone());
    for (k, &q) in pts.iter().enumerate() {
        let w = ff.map([q.x, q.y, 0.0]);
        let r = fo.inverse(w);
        let n = p.pieces.iter().map(|x| x.hardware.len()).sum::<usize>();
        piece_mut(p, from).hardware.push(HardwarePlacement { id: format!("{from}-{kind}-{k}-{n}"), kind: kind.into(), at: q, angle_deg: 0.0, size_mm: size, label: String::new() });
        piece_mut(p, onto).hardware.push(HardwarePlacement { id: format!("{onto}-{kind}-{k}-{n}b"), kind: kind.into(), at: r, angle_deg: 0.0, size_mm: size, label: String::new() });
    }
}

/// Hardware at a world point on one piece.
fn put_at(p: &mut Project, onto: &str, world: [f64; 3], kind: &str, size: f64, id: &str) {
    let f = frames(p);
    let at = frame_of(&f, onto).inverse(world);
    piece_mut(p, onto).hardware.push(HardwarePlacement { id: id.into(), kind: kind.into(), at, angle_deg: 0.0, size_mm: size, label: String::new() });
}

fn stitch_edges(pc: &mut Piece, edges: &[usize]) {
    for &e in edges {
        pc.edges[e].stitched = true;
    }
}

fn finish_edges(pc: &mut Piece, finish: EdgeFinish) {
    for e in pc.edges.iter_mut() {
        e.finish = finish;
    }
}

fn stitch_len(p: &Project, id: &str, edges: &[usize]) -> f64 {
    let c = compute(p);
    let cp = c.pieces.iter().find(|x| x.id == id).unwrap();
    edges.iter().map(|&e| cp.edges[e].stitch_length_mm).sum()
}

fn join(p: &mut Project, a: (&str, &[usize]), b: (&str, &[usize]), params: &BagParams) {
    let id = format!("j{}", p.joins.len() + 1);
    let mut j = Join::new(&id, EdgeRef::new(a.0, a.1), EdgeRef::new(b.0, b.1));
    j.construction = params.construction;
    j.glue = params.glue;
    p.joins.push(j);
}

/// Sides and bottom of a panel from `panel_rounded_bottom`.
fn sides_and_bottom(pc: &Piece) -> Vec<usize> {
    if pc.edges.len() == 6 {
        vec![1, 2, 3, 4, 5]
    } else {
        vec![1, 2, 3]
    }
}

pub fn bag(params: &BagParams) -> Project {
    let pr = crate::physics::presets();
    let preset = pr.iter().find(|x| x.id == params.leather).or_else(|| pr.iter().find(|x| x.id == "pullup")).unwrap();
    let t = if params.thickness_mm > 0.0 { params.thickness_mm } else { preset.thickness_mm };
    let mut p = crate::templates::blank();
    p.name = params.name.clone();
    p.materials = vec![Material { id: "body".into(), name: preset.name.into(), kind: preset.kind, thickness_mm: t, physics: Some(preset.physics.clone()), cost_per_sqft: None, color: None }];

    p.thread = Some(if crate::craft::stitch_info(params.stitch).lace { "lace-goat-3".into() } else { "poly-0.6".into() });
    p.thread_color = Some(params.thread_color.clone());
    let (w, h, d) = (params.width_mm.max(60.0), params.height_mm.max(40.0), params.depth_mm.max(2.0));
    let r = params.corner_mm.max(0.0);
    let stitch = StitchSettings { kind: params.stitch, pitch_mm: crate::craft::stitch_info(params.stitch).default_pitch_mm, hole_mm: if crate::craft::stitch_info(params.stitch).lace { 3.0 } else { 1.0 }, margin_mm: if crate::craft::stitch_info(params.stitch).lace { 4.0 } else { 3.5 }, ..Default::default() };
    let m = stitch.margin_mm;
    // The form is the stitch-line box: pieces are cut one margin bigger all round.
    let rounded = !matches!(params.style, BagStyle::BoxedTote | BagStyle::Bucket) && r > m;
    p.form = Some(Form { width_mm: w - 2.0 * m, depth_mm: (d - 2.0 * m).max(1.0), height_mm: h - m, round: params.style == BagStyle::Bucket, corner_mm: if rounded { r - m } else { 0.0 } });
    let fw = w - 2.0 * m;
    let fdp = (d - 2.0 * m).max(1.0);
    let fh = h - m;
    let _ = fw;
    let add = |p: &mut Project, mut pc: Piece, face: Face| {
        pc.stitch = stitch.clone();
        finish_edges(&mut pc, params.edge);
        pc.place = Some(default_place(face));
        pc.material_id = "body".into();
        p.pieces.push(pc);
    };

    match params.style {
        BagStyle::Tote | BagStyle::Messenger => {
            let mut front = panel_rounded_bottom("front", "Front", "body", w, h, r);
            let se = sides_and_bottom(&front);
            stitch_edges(&mut front, &se);
            front.edges[0].crease = true;
            add(&mut p, front, Face::Front);
            if params.style == BagStyle::Tote {
                let mut back = panel_rounded_bottom("back", "Back", "body", w, h, r);
                stitch_edges(&mut back, &se);
                back.edges[0].crease = true;
                add(&mut p, back, Face::Back);
            } else {
                let fd = if params.flap_mm > 0.0 { params.flap_mm } else { h * 0.7 };
                let back = flap_back(w, h, d, fd, r, m);
                add(&mut p, back, Face::BackFlap);
            }
            let back_edges: Vec<usize> = if params.style == BagStyle::Tote { se.clone() } else if r > 0.5 { vec![5, 6, 7, 8, 9] } else { vec![5, 6, 7] };
            let len = stitch_len(&p, "front", &se);
            let mut gusset = panel("gusset", "Gusset", "body", len + 2.0 * m, d);
            stitch_edges(&mut gusset, &[0, 2]);
            gusset.grain_deg = 0.0;
            gusset.notes = "Crease the gusset where it turns the bottom corners.".into();
            add(&mut p, gusset, Face::WrapSides);
            join(&mut p, ("front", &se), ("gusset", &[0]), params);
            join(&mut p, ("back", &back_edges), ("gusset", &[2]), params);
        }
        BagStyle::BoxedTote => {
            for (id, name, face) in [("front", "Front", Face::Front), ("back", "Back", Face::Back)] {
                let mut pc = panel(id, name, "body", w, h);
                stitch_edges(&mut pc, &[1, 2, 3]);
                pc.edges[0].crease = true;
                add(&mut p, pc, face);
            }
            let mut bottom = panel("bottom", "Bottom", "body", w, d);
            stitch_edges(&mut bottom, &[0, 1, 2, 3]);
            bottom.grain_deg = 0.0;
            add(&mut p, bottom, Face::Bottom);
            for (id, name, face) in [("left", "Left side", Face::Left), ("right", "Right side", Face::Right)] {
                let mut pc = panel(id, name, "body", d, h);
                stitch_edges(&mut pc, &[1, 2, 3]);
                pc.edges[0].crease = true;
                add(&mut p, pc, face);
            }
            // Left side: x = 0 is at the back. Right side: x = 0 is at the front.
            join(&mut p, ("front", &[2]), ("bottom", &[0]), params);
            join(&mut p, ("back", &[2]), ("bottom", &[2]), params);
            join(&mut p, ("left", &[2]), ("bottom", &[3]), params);
            join(&mut p, ("right", &[2]), ("bottom", &[1]), params);
            join(&mut p, ("left", &[1]), ("front", &[3]), params);
            join(&mut p, ("left", &[3]), ("back", &[1]), params);
            join(&mut p, ("right", &[3]), ("front", &[1]), params);
            join(&mut p, ("right", &[1]), ("back", &[3]), params);
        }
        BagStyle::ZipPouch => {
            // A soft, nearly flat pouch: it lies on the table, back on front, rather than standing
            // on its edge to topple over.
            for (id, name, face) in [("front", "Front", Face::Flat), ("back", "Back", Face::Flat)] {
                let mut pc = panel_rounded_bottom(id, name, "body", w, h, r);
                let se = sides_and_bottom(&pc);
                stitch_edges(&mut pc, &se);
                add(&mut p, pc, face);
            }
            let se = sides_and_bottom(&p.pieces[0]);
            join(&mut p, ("front", &se), ("back", &se), params);
            let mut z = Join::new("zip", EdgeRef::new("front", &[0]), EdgeRef::new("back", &[0]));
            z.construction = Construction::Zipper;
            p.joins.push(z);
            p.pieces[0].notes = "Sew the zipper tape to the top edges first, then sew the sides and bottom.".into();
        }
        BagStyle::Bucket => {
            let mut bottom = ellipse("bottom", "Bottom", "body", w, d);
            stitch_edges(&mut bottom, &[0, 1, 2, 3]);
            bottom.grain_deg = 0.0;
            add(&mut p, bottom, Face::Bottom);
            let len = stitch_len(&p, "bottom", &[0, 1, 2, 3]);
            let mut body = panel("body", "Body", "body", len + 2.0 * m, h);
            stitch_edges(&mut body, &[1, 2, 3]);
            body.grain_deg = 0.0;
            body.edges[0].crease = true;
            body.notes = "Close the back seam first, then sew in the bottom.".into();
            let bl = len + 2.0 * m;
            // Twelve grommets, evenly round: none falls at the sides (a quarter and three
            // quarters round), where the shoulder strap's screws go.
            let n = 12;
            body.hardware = (0..n)
                .map(|k| HardwarePlacement { id: format!("grommet{k}"), kind: "grommet-10".into(), at: v(bl * (k as f64 + 0.5) / n as f64, 28.0), angle_deg: 0.0, size_mm: 0.0, label: String::new() })
                .collect();
            add(&mut p, body, Face::WrapAround);
            join(&mut p, ("body", &[2]), ("bottom", &[0, 1, 2, 3]), params);
            join(&mut p, ("body", &[1]), ("body", &[3]), params);
        }
    }

    // Carry: handles riveted to the front and back, a strap riveted to the sides.
    let handles = matches!(params.carry, Carry::Handles | Carry::Both) && params.style != BagStyle::ZipPouch;
    let shoulder = matches!(params.carry, Carry::Shoulder | Carry::Both) && params.style != BagStyle::ZipPouch;
    if handles {
        // Handles are cut from heavier leather (or two layers glued) so they hold their arch:
        // bending stiffness grows with thickness cubed.
        let handle_t = (t * 1.6).clamp(3.2, 5.0).max(t);
        p.materials.push(Material { id: "handle".into(), name: format!("{}, heavier for the handles", preset.name), kind: preset.kind, thickness_mm: handle_t, physics: Some(preset.physics.clone()), cost_per_sqft: None, color: None });
        let (hl, hw) = (params.handle_length_mm.max(150.0), params.handle_width_mm.max(10.0));
        for (id, name, face, onto) in [("handle1", "Handle (front)", Face::HandleFront, "front"), ("handle2", "Handle (back)", Face::HandleBack, "back")] {
            let mut pc = panel(id, name, "body", hl, hw);
            stitch_edges(&mut pc, &[0, 2]);
            pc.grain_deg = 0.0;
            pc.notes = "Cut from heavier leather, or glue two layers flesh to flesh.".into();
            let tab = 40.0;
            let mut place = default_place(face);
            place.span_mm = w * 0.42;
            place.tab_mm = tab;
            add(&mut p, pc, face);
            let last = p.pieces.last_mut().unwrap();
            last.place = Some(place);
            last.material_id = "handle".into();
            let pts = [v(12.0, hw / 2.0), v(30.0, hw / 2.0), v(hl - 12.0, hw / 2.0), v(hl - 30.0, hw / 2.0)];
            let onto = if params.style == BagStyle::Messenger && onto == "back" { "back" } else { onto };
            fasten(&mut p, id, &pts, onto, "rivet-m", 0.0);
        }
    }
    if shoulder {
        let (sl, sw) = (params.strap_length_mm.max(300.0), params.strap_width_mm.max(15.0));
        let mut pc = panel("strap", "Shoulder strap", "body", sl, sw);
        stitch_edges(&mut pc, &[0, 2]);
        pc.grain_deg = 0.0;
        add(&mut p, pc, Face::StrapSides);
        let pts = [v(12.0, sw / 2.0), v(30.0, sw / 2.0), v(sl - 12.0, sw / 2.0), v(sl - 30.0, sw / 2.0)];
        let onto = match params.style {
            BagStyle::BoxedTote => None,
            BagStyle::Bucket => Some("body"),
            _ => Some("gusset"),
        };
        match onto {
            Some(onto) => fasten(&mut p, "strap", &pts, onto, "chicago-screw", 0.0),
            None => {
                fasten(&mut p, "strap", &pts[..2], "left", "chicago-screw", 0.0);
                fasten(&mut p, "strap", &pts[2..], "right", "chicago-screw", 0.0);
            }
        }
    }

    // Closure.
    if params.style == BagStyle::Messenger && params.closure != Closure::None {
        let (catch, eye) = match params.closure {
            Closure::TurnLock => ("turnlock-catch", "turnlock-eyelet"),
            Closure::Snap => ("snap-24", "snap-24"),
            _ => ("magnet-18", "magnet-18"),
        };
        // 28 mm up from the flap's tip, and the catch on the front where the flap lands.
        let at = v(w / 2.0, 28.0);
        let world = frame_of(&frames(&p), "back").map([at.x, at.y, 0.0]);
        piece_mut(&mut p, "back").hardware.push(HardwarePlacement { id: "closure-flap".into(), kind: eye.into(), at, angle_deg: 0.0, size_mm: 0.0, label: String::new() });
        put_at(&mut p, "front", [0.0, -fdp / 2.0, world[2]], catch, 0.0, "closure-front");
    } else if params.closure != Closure::None && matches!(params.style, BagStyle::Tote | BagStyle::BoxedTote) {
        // A pair at the top centre, on the inside faces.
        let kind = match params.closure {
            Closure::Snap => "snap-20",
            Closure::TurnLock => "magnet-18",
            _ => "magnet-18",
        };
        put_at(&mut p, "front", [0.0, -fdp / 2.0, fh - 25.0], kind, 0.0, "closure-front");
        put_at(&mut p, "back", [0.0, fdp / 2.0, fh - 25.0], kind, 0.0, "closure-back");
    }

    // Front patch pocket.
    if params.pocket && matches!(params.style, BagStyle::Tote | BagStyle::BoxedTote | BagStyle::Messenger) {
        let (pw, ph) = (w * 0.55, h * 0.42);
        let mut pc = panel("pocket", "Front pocket", "body", pw, ph);
        stitch_edges(&mut pc, &[1, 2, 3]);
        pc.edges[0].crease = true;
        pc.stitch = stitch.clone();
        finish_edges(&mut pc, params.edge);
        pc.material_id = "body".into();
        pc.place = Some(Place { face: Face::Front, offset: v(0.0, -h * 0.12), layer_mm: t + 0.6, ..Default::default() });
        p.pieces.push(pc);
        let mut j = Join::new("pocket", EdgeRef::new("pocket", &[1, 2, 3]), EdgeRef::new("front", &[]));
        j.glue = params.glue;
        p.joins.push(j);
    }

    // Feet under the base.
    if params.feet && params.style != BagStyle::ZipPouch {
        let onto = match params.style {
            BagStyle::BoxedTote | BagStyle::Bucket => "bottom",
            _ => "gusset",
        };
        let (fx, fy) = (w * 0.36, d * 0.22);
        for (k, (sx, sy)) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)].into_iter().enumerate() {
            put_at(&mut p, onto, [sx * fx, sy * fy, 0.0], "bag-foot", 0.0, &format!("foot{k}"));
        }
    }

    // Lay the pieces out on the template sheet without overlapping.
    let c = compute(&p);
    let (mut x, mut y, mut row_h) = (10.0, 10.0, 0.0f64);
    let sheet_w = 900.0;
    for pc in p.pieces.iter_mut() {
        let Some(cp) = c.pieces.iter().find(|q| q.id == pc.id) else { continue };
        let (bw, bh) = (cp.bounds.width(), cp.bounds.height());
        if x + bw > sheet_w && x > 10.0 {
            x = 10.0;
            y += row_h + 35.0;
            row_h = 0.0;
        }
        pc.position = v(x - cp.bounds.min.x, y - cp.bounds.min.y);
        // Thin pieces (straps) get room for their labels below them.
        let bh = bh.max(30.0);
        x += bw + 30.0;
        row_h = row_h.max(bh);
    }
    p
}

/// A back panel that runs up, over the top and down the front as a flap.
fn flap_back(w: f64, h: f64, d: f64, fd: f64, r: f64, m: f64) -> Piece {
    let rf = (w * 0.12).min(fd * 0.4);
    let top = fd + d + m;
    let hh = fd + d + h;
    let k = 0.552_284_75;
    let mut pc = panel("back", "Back and flap", "body", w, hh);
    let mut verts = vec![v(0.0, top), v(0.0, rf), v(rf, 0.0), v(w - rf, 0.0), v(w, rf), v(w, top)];
    let mut edges = vec![
        Edge::line(false),
        Edge::new(EdgeKind::Cubic { c1: v(0.0, rf - rf * k), c2: v(rf - rf * k, 0.0) }, false),
        Edge::line(false),
        Edge::new(EdgeKind::Cubic { c1: v(w - rf + rf * k, 0.0), c2: v(w, rf - rf * k) }, false),
        Edge::line(false),
    ];
    if r > 0.5 {
        verts.extend([v(w, hh - r), v(w - r, hh), v(r, hh), v(0.0, hh - r)]);
        edges.extend([
            Edge::line(true),
            Edge::new(EdgeKind::Cubic { c1: v(w, hh - r + r * k), c2: v(w - r + r * k, hh) }, true),
            Edge::line(true),
            Edge::new(EdgeKind::Cubic { c1: v(r - r * k, hh), c2: v(0.0, hh - r + r * k) }, true),
            Edge::line(true),
        ]);
    } else {
        verts.extend([v(w, hh), v(0.0, hh)]);
        edges.extend([Edge::line(true), Edge::line(true), Edge::line(true)]);
    }
    pc.vertices = verts;
    pc.edges = edges;
    pc.notes = "The flap folds over the top: crease along the top of the gusset.".into();
    pc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bag_is_valid_and_its_seams_match() {
        for style in [BagStyle::Tote, BagStyle::BoxedTote, BagStyle::Messenger, BagStyle::ZipPouch, BagStyle::Bucket] {
            let p = bag(&BagParams::style_defaults(style));
            let c = compute(&p);
            assert!(c.warnings.is_empty(), "{style:?}: {:?}", c.warnings);
            for j in &c.joins {
                // Same-piece back seams and the zipper compare plain edges; everything else must match.
                assert!(j.ok, "{style:?} seam {}: {}", j.id, j.message);
            }
            assert!(p.pieces.iter().all(|pc| pc.place.is_some()));
        }
    }

    #[test]
    fn bucket_strap_screws_clear_the_drawstring_grommets() {
        let p = bag(&BagParams::style_defaults(BagStyle::Bucket));
        let body = p.piece("body").unwrap();
        let screws: Vec<Vec2> = body.hardware.iter().filter(|h| h.kind == "chicago-screw").map(|h| h.at).collect();
        let grommets: Vec<Vec2> = body.hardware.iter().filter(|h| h.kind == "grommet-10").map(|h| h.at).collect();
        assert_eq!(screws.len(), 4);
        for s in &screws {
            for g in &grommets {
                assert!(s.dist(*g) >= 14.0, "screw {s:?} only {:.1} mm from grommet {g:?}", s.dist(*g));
            }
        }
    }

    #[test]
    fn handle_rivets_go_through_both_layers() {
        let p = bag(&BagParams::default());
        let f = frames(&p);
        let h = p.piece("handle1").unwrap();
        let front = p.piece("front").unwrap();
        assert_eq!(h.hardware.len(), 4);
        for (a, b) in h.hardware.iter().zip(front.hardware.iter().filter(|x| x.kind == "rivet-m")) {
            let wa = frame_of(&f, "handle1").map([a.at.x, a.at.y, 0.0]);
            let wb = frame_of(&f, "front").map([b.at.x, b.at.y, 0.0]);
            let dist = ((wa[0] - wb[0]).powi(2) + (wa[1] - wb[1]).powi(2) + (wa[2] - wb[2]).powi(2)).sqrt();
            assert!(dist < 5.0, "{dist} mm apart");
            // Rivets sit on the panel, near its top.
            assert!(b.at.y > 0.0 && b.at.y < 45.0 && b.at.x > 0.0 && b.at.x < 340.0, "{:?}", b.at);
        }
    }
}
