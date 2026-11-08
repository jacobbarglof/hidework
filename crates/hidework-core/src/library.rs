//! The template library: flat leather goods ready to change. Each one is sized from common
//! practice (card 86 x 54 mm, A6 and A5 notebooks, Field Notes 89 x 140 mm, passport 88 x 125 mm,
//! phones, tablets and laptops), its seams match stitch for stitch, and its hardware is placed so
//! it can be cut and made as is.
//!
//! How the seams are made to match: two edges sewn together get the same stitch line length and
//! the same number of holes. Where a short piece (a pocket) sews to the lower part of a taller one,
//! the taller piece's side is split 3 mm (one stitch margin) below where the short piece's mouth
//! lands, because the short piece's stitching starts one margin below its own mouth.

use crate::compute::compute;
use crate::generators::{ellipse, gusset, panel, panel_rounded_bottom, strap, StrapParams, Tip};
use crate::geom::{offset_closed, signed_area, v, Vec2};
use crate::model::*;

/// A template: id, name, category, description and how to build it.
pub struct Entry {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    pub build: fn() -> Project,
}

pub fn entries() -> Vec<Entry> {
    let e = |id, name, category, description, build| Entry { id, name, category, description, build };
    vec![
        // Wallets
        e("card-sleeve", "Card sleeve", "Wallets", "Front with a thumb notch and back, stitched on three sides. Holds 4 to 6 cards.", card_sleeve),
        e("card-holder", "Card holder, three pockets", "Wallets", "Two body panels with an outer pocket on each and a centre slot between them.", card_holder),
        e("front-pocket-wallet", "Front-pocket wallet", "Wallets", "Minimalist: back, a full card pocket with a thumb notch and a slanted quick-access pocket.", front_pocket_wallet),
        e("snap-card-holder", "Card holder with snap", "Wallets", "One piece folded into a vertical card pocket with a flap and a line 20 snap.", snap_card_holder),
        e("bifold", "Bifold wallet", "Wallets", "Outer and liner folded at the spine, a full-length cash slot and two staggered card pockets a side.", bifold),
        e("trifold", "Trifold wallet", "Wallets", "Outer and liner in three panels with a cash slot and staggered card pockets on both outer panels.", trifold),
        e("long-wallet", "Long wallet", "Wallets", "Outer and liner folded along the length: notes lie flat, three rows of card slots.", long_wallet),
        e("coin-pouch", "Coin pouch with snap", "Wallets", "One piece folded into a pocket with a closing flap and a line 20 snap.", coin_pouch),
        // Covers
        e("passport-cover", "Passport cover", "Covers", "Passport sized cover with inside flaps for the passport's covers.", passport_cover),
        e("field-notes", "Field Notes cover", "Covers", "For 89 x 140 mm pocket notebooks, with a pen loop.", field_notes),
        e("a6-journal", "A6 journal cover", "Covers", "For A6 notebooks (105 x 148 mm).", a6_journal),
        e("checkbook-cover", "Checkbook cover", "Covers", "Top-stub checkbook (checks 152 x 70 mm): checks in one flap, the register in the other.", checkbook_cover),
        e("a4-folio", "A4 pad folio", "Covers", "Folio for an A4 writing pad with inside flaps and a pen loop.", a4_folio),
        // Cases
        e("phone-sleeve", "Phone sleeve", "Cases", "Two panels with a rounded bottom and a thumb notch, for a 72 x 148 mm phone.", phone_sleeve),
        e("glasses-case", "Glasses case", "Cases", "Tall pouch with a rounded bottom; wet-mould it around the glasses.", glasses_case),
        e("pen-sleeve", "Pen sleeve", "Cases", "One piece folded at the bottom, with a taller back to pull the pen out by.", pen_sleeve),
        e("earbud-case", "Earbud case", "Cases", "Small gusseted case with a snap flap for a charging case up to 62 x 50 x 24 mm.", earbud_case),
        e("tablet-sleeve", "Tablet sleeve, 11 in", "Cases", "Two panels with a thumb notch for an 11 inch tablet (250 x 178 x 6 mm).", tablet_sleeve),
        e("laptop-sleeve", "Laptop sleeve, 13 in", "Cases", "Front and a back with a fold-over flap and a magnetic snap, for a 13 inch laptop.", laptop_sleeve),
        // Outdoor
        e("knife-sheath", "Knife sheath, welted", "Outdoor", "Front, back with a riveted belt loop, and a welt between them for a 100 mm blade.", knife_sheath),
        e("axe-mask", "Axe mask", "Outdoor", "Welted edge cover for a hatchet bit with a strap round the poll and a snap.", axe_mask),
        e("belt-pouch", "Belt pouch", "Outdoor", "Front, gusset, back with a snap flap and two belt loops for a 38 mm belt.", belt_pouch),
        // Small goods
        e("key-fob", "Key fob", "Small goods", "Folded loop with a rivet and a key ring.", key_fob),
        e("key-case", "Key case, 6 hooks", "Small goods", "Folding case with a riveted 6-hook key plate and a snap tab.", key_case),
        e("cable-tie", "Cable organiser", "Small goods", "Strap with a line 20 snap to bundle a cable.", cable_tie),
        e("luggage-tag", "Luggage tag", "Small goods", "Two panels with a card window, open at one end for the card, and a buckle strap.", luggage_tag),
        e("bookmark", "Bookmark", "Small goods", "Rounded strip with a hole for a tassel.", bookmark),
        // Home
        e("coaster", "Coaster set", "Home", "Two round layers glued and stitched round.", coaster),
        e("drink-sleeve", "Drink sleeve", "Home", "Can coozie for a 66 mm can: a stitched tube with a round base.", drink_sleeve),
        e("bottle-carrier", "Bottle carrier", "Home", "Two riveted bands round a wine bottle and a carry strap.", bottle_carrier),
        e("plant-hanger", "Plant hanger", "Home", "Four straps riveted to a round base and folded round an O-ring.", plant_hanger),
        e("valet-tray", "Valet tray", "Home", "A flat square that snaps up at the corners into a tray.", valet_tray),
        e("mouse-pad", "Mouse pad", "Home", "250 x 210 mm with rounded corners and burnished edges.", mouse_pad),
        e("desk-mat", "Desk mat", "Home", "A 400 x 300 mm mat with rounded corners.", desk_mat),
        e("tool-roll", "Tool roll", "Home", "Waxed canvas back, a full-width pocket and a leather tie.", tool_roll),
        e("apron", "Shop apron", "Home", "Waxed canvas bib apron with a chest pocket, leather neck strap and waist ties.", apron),
        // Straps
        e("watch-strap", "Watch strap, 20 mm", "Straps", "Long and short halves folded round the spring bars, a buckle fold and a keeper.", watch_strap),
        e("dog-collar", "Dog collar", "Straps", "25 mm collar with a buckle, a D-ring in the buckle fold, seven holes and a keeper.", dog_collar),
        e("guitar-strap", "Guitar strap", "Straps", "60 mm strap with end slots for the strap buttons.", guitar_strap),
        e("camera-strap", "Camera strap", "Straps", "30 mm strap with both ends folded round split rings.", camera_strap),
        e("wrist-cuff", "Wrist cuff", "Straps", "Tooled cuff with two snaps.", wrist_cuff),
        e("hat-band", "Hat band", "Straps", "15 mm band with a small buckle for hats up to 62 cm.", hat_band),
    ]
}

// ---------- building blocks ----------

/// Stitch margin (the default stitch settings): stitching starts this far in from an open edge.
const M: f64 = 3.0;

fn material(id: &str, preset: &str, oz: f64) -> Material {
    let p = crate::physics::presets().into_iter().find(|p| p.id == preset).expect("preset");
    let thickness_mm = if p.kind == MaterialKind::Leather { oz * OZ_MM } else { p.thickness_mm };
    Material { id: id.into(), name: p.name.into(), kind: p.kind, thickness_mm, physics: Some(p.physics), cost_per_sqft: None, color: None }
}

fn project(name: &str, preset: &str, oz: f64) -> Project {
    let mut p = crate::templates::blank();
    p.name = name.into();
    p.materials = vec![material("m1", preset, oz)];
    p
}

fn thickness(p: &Project) -> f64 {
    p.materials[0].thickness_mm
}

/// A piece from its corners; each corner is (x, y, radius) and a radius above zero rounds it.
/// Edges run side 0 (corner 0 to 1), the arc at corner 1 if rounded, side 1, ..., side n-1 and
/// the arc at corner 0. Returns the piece and each side's edge index.
fn outline(id: &str, name: &str, pts: &[(f64, f64, f64)]) -> (Piece, Vec<usize>) {
    let n = pts.len();
    let p = |i: usize| v(pts[i % n].0, pts[i % n].1);
    let mut d = vec![0.0; n];
    let mut half = vec![0.0; n];
    for i in 0..n {
        if pts[i].2 <= 0.0 {
            continue;
        }
        let (a, c, b) = (p(i + n - 1), p(i), p(i + 1));
        let h = (a - c).normalized().dot((b - c).normalized()).clamp(-1.0, 1.0).acos() / 2.0;
        if h > 0.05 && h < 1.52 {
            half[i] = h;
            d[i] = (pts[i].2 / h.tan()).min(a.dist(c) * 0.49).min(b.dist(c) * 0.49);
        }
    }
    let mut pc = panel(id, name, "m1", 1.0, 1.0);
    pc.vertices.clear();
    pc.edges.clear();
    let mut sides = Vec::new();
    for k in 0..n {
        let (a, b) = (p(k), p(k + 1));
        sides.push(pc.edges.len());
        pc.vertices.push(a + (b - a).normalized() * d[k]);
        pc.edges.push(Edge::line(false));
        let j = (k + 1) % n;
        if d[j] > 0.0 {
            let (u, w) = ((a - b).normalized(), (p(j + 1) - b).normalized());
            let (t1, t2) = (b + u * d[j], b + w * d[j]);
            let k = 4.0 / 3.0 * ((std::f64::consts::PI - 2.0 * half[j]) / 4.0).tan() * (d[j] * half[j].tan());
            pc.vertices.push(t1);
            pc.edges.push(Edge::new(EdgeKind::Cubic { c1: t1 - u * k, c2: t2 - w * k }, false));
        }
    }
    (pc, sides)
}

/// A rectangle with all four corners rounded: edges 0 top, 1 corner, 2 right, 3 corner,
/// 4 bottom, 5 corner, 6 left, 7 corner.
fn rounded(id: &str, name: &str, w: f64, h: f64, r: f64) -> Piece {
    outline(id, name, &[(0.0, 0.0, r), (w, 0.0, r), (w, h, r), (0.0, h, r)]).0
}

fn stitch(pc: &mut Piece, edges: impl IntoIterator<Item = usize>) {
    for e in edges {
        pc.edges[e].stitched = true;
    }
}

/// A half-moon thumb notch in the middle of straight edge `e`. Edges after `e` move up by two.
fn notch(pc: &mut Piece, e: usize, width: f64, depth: f64) {
    let n = pc.vertices.len();
    let (a, b) = (pc.vertices[e], pc.vertices[(e + 1) % n]);
    let dir = (b - a).normalized();
    let inward = dir.left() * if signed_area(&pc.vertices) > 0.0 { 1.0 } else { -1.0 };
    let m = (a + b) * 0.5;
    let (p1, p2) = (m - dir * (width / 2.0), m + dir * (width / 2.0));
    // A cubic with both controls `k` in dips 0.75 k at its middle.
    let k = depth / 0.75;
    let flags = pc.edges[e].clone();
    pc.vertices.splice(e + 1..e + 1, [p1, p2]);
    pc.edges.splice(e + 1..e + 1, [Edge { kind: EdgeKind::Cubic { c1: p1 + inward * k, c2: p2 + inward * k }, ..flags.clone() }, flags]);
}

fn hole(pc: &mut Piece, id: &str, at: Vec2, d: f64, label: &str) {
    pc.holes.push(Hole { id: id.into(), center: at, diameter_mm: d, label: label.into(), length_mm: 0.0, angle_deg: 0.0 });
}

fn slot(pc: &mut Piece, id: &str, at: Vec2, d: f64, len: f64, angle: f64, label: &str) {
    pc.holes.push(Hole { id: id.into(), center: at, diameter_mm: d, label: label.into(), length_mm: len, angle_deg: angle });
}

fn hardware(pc: &mut Piece, id: &str, kind: &str, at: Vec2, label: &str) {
    pc.hardware.push(HardwarePlacement { id: id.into(), kind: kind.into(), at, angle_deg: 0.0, size_mm: 0.0, label: label.into() });
}

fn fold(pc: &mut Piece, id: &str, orientation: Orientation, at: f64, contents: f64) {
    pc.folds.push(Fold { id: id.into(), orientation, position: at, contents_mm: contents });
}

fn join(p: &mut Project, a: (&str, &[usize]), b: (&str, &[usize])) {
    let id = format!("j{}", p.joins.len() + 1);
    p.joins.push(Join::new(&id, EdgeRef::new(a.0, a.1), EdgeRef::new(b.0, b.1)));
}

/// A welted seam: a strip of the same leather glued between the two layers.
fn welted(p: &mut Project, a: (&str, &[usize]), b: (&str, &[usize]), width: f64) {
    join(p, a, b);
    let j = p.joins.last_mut().unwrap();
    j.construction = Construction::Welted;
    j.insert_material_id = Some("m1".into());
    j.insert_mm = width;
    j.glue = Adhesive::ContactCement;
}

/// Sew piece `a`'s edges onto the face of `b` (pockets, keepers, patches, loops).
fn onto(p: &mut Project, a: (&str, &[usize]), b: &str) {
    let id = format!("j{}", p.joins.len() + 1);
    p.joins.push(Join::new(&id, EdgeRef::new(a.0, a.1), EdgeRef::new(b, &[])));
}

fn computed_alone(pc: &Piece, t: f64) -> crate::compute::ComputedPiece {
    let mut p = crate::templates::blank();
    p.materials[0].thickness_mm = t;
    let mut q = pc.clone();
    q.material_id = "m1".into();
    p.pieces = vec![q];
    compute(&p).pieces.remove(0)
}

/// Stitch line length along some edges of a piece, as compute measures it.
fn run_len(pc: &Piece, t: f64, edges: &[usize]) -> f64 {
    let c = computed_alone(pc, t);
    edges.iter().map(|&e| c.edges[e].stitch_length_mm).sum()
}

/// Where the line through `p` along `d` crosses the line through `q` along `e`.
fn intersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2) -> Vec2 {
    let den = d.x * e.y - d.y * e.x;
    if den.abs() < 1e-9 {
        return p;
    }
    let s = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
    p + d * s
}

/// Cut out the little loops an inward offset makes at sharp corners: where two segments of the
/// line cross, keep the crossing point and drop what lies between.
fn without_loops(mut pts: Vec<Vec2>) -> Vec<Vec2> {
    let cross = |o: Vec2, p: Vec2, q: Vec2| (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    'again: loop {
        let n = pts.len();
        for i in 0..n.saturating_sub(1) {
            for j in (i + 2..n - 1).rev() {
                let (a, b, c, d) = (pts[i], pts[i + 1], pts[j], pts[j + 1]);
                let (d1, d2, d3, d4) = (cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d));
                if (d1 > 0.0) != (d2 > 0.0) && (d3 > 0.0) != (d4 > 0.0) {
                    let x = a + (b - a) * (d1 / (d1 - d2));
                    pts.splice(i + 1..=j, [x]);
                    continue 'again;
                }
            }
        }
        return pts;
    }
}

/// Make a closed outline simple: wherever two of its segments cross (strictly, as the pattern
/// checker counts it), cut off the smaller loop at the crossing point. Repeats until none cross.
fn untwist(mut pts: Vec<Vec2>) -> Vec<Vec2> {
    let cross = |o: Vec2, p: Vec2, q: Vec2| (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    let e = 1e-9;
    let strict = |d1: f64, d2: f64| (d1 > e && d2 < -e) || (d1 < -e && d2 > e);
    'again: loop {
        let n = pts.len();
        if n < 4 {
            return pts;
        }
        for i in 0..n {
            for k in i + 2..n {
                if i == 0 && k == n - 1 {
                    continue;
                }
                let (a, b, c, d) = (pts[i], pts[(i + 1) % n], pts[k], pts[(k + 1) % n]);
                let (d1, d2) = (cross(c, d, a), cross(c, d, b));
                if strict(d1, d2) && strict(cross(a, b, c), cross(a, b, d)) {
                    let x = a + (b - a) * (d1 / (d1 - d2));
                    if k - i <= n / 2 {
                        // The loop is pts[i + 1..=k]: drop it.
                        pts.splice(i + 1..=k, [x]);
                    } else {
                        // The rest is the smaller loop: keep only pts[i + 1..=k].
                        let mut keep = vec![x];
                        keep.extend_from_slice(&pts[i + 1..=k]);
                        pts = keep;
                    }
                    continue 'again;
                }
            }
        }
        return pts;
    }
}

/// A welt: a band `width` wide following the given (contiguous) sewn edges of `src`, ending square
/// on the open edges either side.
fn welt_for(src: &Piece, edges: &[usize], width: f64, t: f64, id: &str) -> Piece {
    let cp = computed_alone(src, t);
    let (pts, tags) = (&cp.outline, &cp.outline_edges);
    let m = pts.len();
    let on = |i: usize| tags[i].is_some_and(|e| edges.contains(&e));
    let start = (0..m).find(|&i| !on(i) && on((i + 1) % m)).map_or(0, |i| (i + 1) % m);
    let mut chain = Vec::new();
    let mut k = start;
    while on(k) && chain.len() < m {
        chain.push(k);
        k = (k + 1) % m;
    }
    chain.push(k);
    let inner = offset_closed(pts, width);
    let mut outer: Vec<Vec2> = chain.iter().map(|&i| pts[i]).collect();
    let mut inn: Vec<Vec2> = chain.iter().map(|&i| inner[i]).collect();
    // Square the ends onto the open edges.
    let (first, last) = (chain[0], *chain.last().unwrap());
    let open_in = pts[first] - pts[(first + m - 1) % m];
    let open_out = pts[(last + 1) % m] - pts[last];
    inn[0] = intersect(inn[1], inn[0] - inn[1], pts[first], open_in);
    let l = inn.len();
    inn[l - 1] = intersect(inn[l - 2], inn[l - 1] - inn[l - 2], pts[last], open_out);
    let mut inn = without_loops(inn);
    inn.reverse();
    outer.extend(inn);
    // Thin out points closer than 1.5 mm so the welt stays editable.
    let mut keep: Vec<Vec2> = Vec::new();
    for p in outer {
        if keep.last().map_or(true, |&q: &Vec2| q.dist(p) > 1.5) {
            keep.push(p);
        }
    }
    if keep.len() > 3 && keep[0].dist(*keep.last().unwrap()) <= 1.5 {
        keep.pop();
    }
    let keep = untwist(keep);
    let mut pc = panel(id, "Welt", "m1", 1.0, 1.0);
    pc.edges = keep.iter().map(|_| Edge::line(false)).collect();
    pc.vertices = keep;
    pc.grain_deg = src.grain_deg;
    pc.notes = "Glue between front and back along the sewn edge,\ntrim flush, stitch through all three.".into();
    pc
}

/// Lay the pieces out left to right in rows, 20 mm apart, on a 700 mm wide sheet, using each
/// piece's cut outline (fold allowances included).
fn lay_out(mut p: Project) -> Project {
    let c = compute(&p);
    let (mut x, mut y, mut row) = (20.0, 20.0, 0.0f64);
    for pc in p.pieces.iter_mut() {
        let Some(cp) = c.pieces.iter().find(|q| q.id == pc.id) else { continue };
        let b = cp.bounds;
        let (w, h) = (b.width(), b.height());
        if x > 20.0 && x + w > 700.0 {
            x = 20.0;
            y += row + 25.0;
            row = 0.0;
        }
        pc.position = v(x - b.min.x, y - b.min.y);
        x += w + 20.0;
        row = row.max(h);
    }
    p
}

// ---------- wallets ----------

fn card_sleeve() -> Project {
    let mut p = project("Card sleeve", "goat-veg", 3.0);
    let (w, h) = (100.0, 68.0);
    // Front: the notch splits the top, so its sides start at edge 4.
    let mut front = rounded("front", "Front", w, h, 5.0);
    notch(&mut front, 0, 30.0, 10.0);
    stitch(&mut front, 4..=8);
    front.notes = "Burnish the mouth and the notch before stitching.".into();
    let mut back = rounded("back", "Back", w, h, 5.0);
    stitch(&mut back, 2..=6);
    p.pieces.push(front);
    p.pieces.push(back);
    join(&mut p, ("front", &[4, 5, 6, 7, 8]), ("back", &[2, 3, 4, 5, 6]));
    lay_out(p)
}

fn card_holder() -> Project {
    let mut p = project("Card holder, three pockets", "goat-veg", 2.5);
    let (w, h, ph) = (100.0, 72.0, 50.0);
    for (id, name) in [("front", "Front body"), ("back", "Back body")] {
        let mut pc = rounded(id, name, w, h, 5.0);
        stitch(&mut pc, 2..=6);
        p.pieces.push(pc);
    }
    for (id, name) in [("pocket-front", "Outer pocket, front"), ("pocket-back", "Outer pocket, back")] {
        let mut pc = panel_rounded_bottom(id, name, "m1", w, ph, 5.0);
        stitch(&mut pc, 1..=5);
        pc.notes = "Burnish the top edge, glue to its body, then punch through all four layers.".into();
        p.pieces.push(pc);
    }
    join(&mut p, ("front", &[2, 3, 4, 5, 6]), ("back", &[2, 3, 4, 5, 6]));
    onto(&mut p, ("pocket-front", &[1, 2, 3, 4, 5]), "front");
    onto(&mut p, ("pocket-back", &[1, 2, 3, 4, 5]), "back");
    lay_out(p)
}

fn front_pocket_wallet() -> Project {
    let mut p = project("Front-pocket wallet", "goat-veg", 3.0);
    let (w, h, hm, r) = (100.0, 70.0, 52.0, 5.0);
    // Full pocket, notched; its sides stitch from 3 mm below its mouth.
    let mut mid = panel_rounded_bottom("pocket", "Card pocket", "m1", w, hm, r);
    notch(&mut mid, 0, 30.0, 9.0);
    stitch(&mut mid, 3..=7);
    mid.notes = "Burnish the mouth and notch before stitching.".into();
    // Back, split where the pocket's stitching starts.
    let s = h - hm + M;
    let (mut back, sd) = outline("back", "Back", &[(0.0, 0.0, r), (w, 0.0, r), (w, s, 0.0), (w, h, r), (0.0, h, r), (0.0, s, 0.0)]);
    stitch(&mut back, sd[2]..=sd[4]);
    // Quick-access pocket with a slanted mouth, sewn onto the card pocket's face.
    let (hf, drop) = (40.0, 12.0);
    let (mut quick, qd) = outline("quick", "Quick-access pocket", &[(0.0, drop, 0.0), (w, 0.0, 0.0), (w, hf, r), (0.0, hf, r)]);
    stitch(&mut quick, qd[1]..=qd[3]);
    quick.notes = "The low side is for your thumb. Stitch it on with the card pocket's seam.".into();
    p.pieces.push(back);
    p.pieces.push(mid);
    p.pieces.push(quick);
    let b: Vec<usize> = (sd[2]..=sd[4]).collect();
    join(&mut p, ("pocket", &[3, 4, 5, 6, 7]), ("back", &b));
    let q: Vec<usize> = (qd[1]..=qd[3]).collect();
    onto(&mut p, ("quick", &q), "pocket");
    lay_out(p)
}

/// One piece: a flap, a back and a front that folds up over the back; the front's sides sew to
/// the lower part of the back's sides and the flap closes with a snap.
#[allow(clippy::too_many_arguments)]
fn snap_pouch(name: &str, preset: &str, oz: f64, w: f64, flap: f64, back: f64, front: f64, r: f64, bottom_contents: f64, flap_contents: f64, snap: &str) -> Project {
    let mut p = project(name, preset, oz);
    let (f1, f2) = (flap, flap + back);
    let (s, total) = (f2 - front + M, f2 + front);
    let (mut pc, sd) = outline(
        "body",
        name,
        &[(0.0, 0.0, r), (w, 0.0, r), (w, f1, 0.0), (w, s, 0.0), (w, f2, 0.0), (w, total, 0.0), (0.0, total, 0.0), (0.0, f2, 0.0), (0.0, s, 0.0), (0.0, f1, 0.0)],
    );
    stitch(&mut pc, [sd[3], sd[4], sd[6], sd[7]]);
    fold(&mut pc, "flap-fold", Orientation::Horizontal, f1, flap_contents);
    fold(&mut pc, "bottom-fold", Orientation::Horizontal, f2, bottom_contents);
    // The cap lands 2 f1 - 12 down the back once the flap folds; the front folds up about f2.
    let cap = 12.0;
    hardware(&mut pc, "snap-cap", snap, v(w / 2.0, cap), "Snap cap");
    hardware(&mut pc, "snap-stud", snap, v(w / 2.0, 2.0 * f2 - (2.0 * f1 - cap)), "Snap stud");
    pc.notes = "Fold the front up and stitch its sides to the back; fold the flap over and snap.\nCheck where the cap lands before setting the stud.".into();
    p.pieces.push(pc);
    join(&mut p, ("body", &[sd[4]]), ("body", &[sd[3]]));
    join(&mut p, ("body", &[sd[6]]), ("body", &[sd[7]]));
    lay_out(p)
}

fn coin_pouch() -> Project {
    snap_pouch("Coin pouch with snap", "vegtan-soft", 3.0, 80.0, 45.0, 75.0, 60.0, 12.0, 10.0, 8.0, "snap-20")
}

fn snap_card_holder() -> Project {
    snap_pouch("Card holder with snap", "vegtan-soft", 3.0, 72.0, 40.0, 95.0, 80.0, 10.0, 5.0, 6.0, "snap-20")
}

/// Outer and liner cut alike, folded at `folds` and sewn round `seams`; the open top edge
/// between them is the cash slot.
fn outer_and_liner(p: &mut Project, w: f64, h: f64, r: f64, folds: &[(Orientation, f64, f64)], seams: &[&[usize]]) {
    for (id, name) in [("outer", "Outer"), ("liner", "Liner")] {
        let mut pc = rounded(id, name, w, h, r);
        for (k, &(o, at, contents)) in folds.iter().enumerate() {
            fold(&mut pc, &format!("f{}", k + 1), o, at, contents);
        }
        for s in seams {
            stitch(&mut pc, s.iter().copied());
        }
        pc.notes = if id == "liner" {
            "Stitch the card pockets on first. Glue to the outer\nwith the wallet closed, then trim flush.".into()
        } else {
            "Burnish the open edges before assembly.".into()
        };
        p.pieces.push(pc);
    }
    for s in seams {
        join(p, ("outer", s), ("liner", s));
    }
}

/// A card pocket that sits in a bottom corner of a wallet panel: the rounded corner goes to the
/// wallet's corner; stitched on both sides and the bottom.
fn corner_pocket(p: &mut Project, id: &str, name: &str, w: f64, h: f64, r: f64) {
    let (mut pc, sd) = outline(id, name, &[(0.0, 0.0, 0.0), (w, 0.0, 0.0), (w, h, 0.0), (0.0, h, r)]);
    let e: Vec<usize> = (sd[1]..=sd[3]).collect();
    stitch(&mut pc, e.iter().copied());
    pc.cut_count = 2;
    pc.notes = "Cut 2: turn one over for the other side. Burnish the mouth first.".into();
    p.pieces.push(pc);
    onto(p, (id, &e), "liner");
}

fn bifold() -> Project {
    let mut p = project("Bifold wallet", "vegtan-soft", 3.0);
    let (w, h, r) = (220.0, 92.0, 6.0);
    outer_and_liner(&mut p, w, h, r, &[(Orientation::Vertical, w / 2.0, 7.0)], &[&[2, 3, 4, 5, 6]]);
    // Pockets stop 6 mm short of the spine so the wallet folds.
    corner_pocket(&mut p, "pocket-tall", "Card pocket, back row", w / 2.0 - 6.0, 45.0, r);
    corner_pocket(&mut p, "pocket-short", "Card pocket, front row", w / 2.0 - 6.0, 32.0, r);
    lay_out(p)
}

fn trifold() -> Project {
    let mut p = project("Trifold wallet", "vegtan-soft", 2.5);
    let (w, h, r) = (258.0, 92.0, 6.0);
    let third = w / 3.0;
    outer_and_liner(&mut p, w, h, r, &[(Orientation::Vertical, third, 4.0), (Orientation::Vertical, 2.0 * third, 9.0)], &[&[2, 3, 4, 5, 6]]);
    corner_pocket(&mut p, "pocket-tall", "Card pocket, back row", third - 6.0, 45.0, r);
    corner_pocket(&mut p, "pocket-short", "Card pocket, front row", third - 6.0, 32.0, r);
    p.pieces[0].notes = "Fold the left panel in first, then the right panel over it.".into();
    lay_out(p)
}

fn long_wallet() -> Project {
    let mut p = project("Long wallet", "vegtan-soft", 3.0);
    let (w, h, r) = (190.0, 196.0, 6.0);
    // Folded along its length; the top and bottom edges meet as the two note slots.
    outer_and_liner(&mut p, w, h, r, &[(Orientation::Horizontal, h / 2.0, 8.0)], &[&[2], &[6]]);
    let mut pockets = panel("pockets", "Card pocket row", "m1", w, 60.0);
    stitch(&mut pockets, 1..=3);
    pockets.cut_count = 3;
    pockets.notes = "Cut 3. Stitch them to the liner's upper half, 14 mm apart, each bottom hidden by the next;\na centre stitch line splits each row into two card slots.".into();
    p.pieces.push(pockets);
    onto(&mut p, ("pockets", &[1, 2, 3]), "liner");
    lay_out(p)
}

// ---------- covers ----------

/// A cover for a book `bw` x `bh` mm and `spine` thick, with inside flaps, like the journal
/// cover. Each flap's top and bottom are stitched to the panel it folds onto: the flap stitching
/// starts one margin in from the outer edge and ends at the fold, so the panel's stitched stretch
/// is `flap - margin` long and ends at `overlap = 2 flap - margin`.
fn book_cover(name: &str, bw: f64, bh: f64, spine: f64, flap: f64, oz: f64) -> Project {
    let mut p = project(name, "vegtan-soft", oz);
    let (w, h) = (2.0 * (bw + 3.0) + spine + 2.0 * flap, bh + 6.0);
    let overlap = 2.0 * flap - M;
    let vertices = vec![
        v(0.0, 0.0), v(flap, 0.0), v(overlap, 0.0), v(w - overlap, 0.0), v(w - flap, 0.0), v(w, 0.0),
        v(w, h), v(w - flap, h), v(w - overlap, h), v(overlap, h), v(flap, h), v(0.0, h),
    ];
    let st = [true, true, false, true, true, false, true, true, false, true, true, false];
    let mut pc = panel("cover", "Cover", "m1", w, h);
    pc.vertices = vertices;
    pc.edges = st.iter().map(|&s| Edge::line(s)).collect();
    fold(&mut pc, "f1", Orientation::Vertical, flap, 1.5);
    fold(&mut pc, "f2", Orientation::Vertical, w - flap, 1.5);
    pc.notes = "Fold the flaps inward and stitch them at top and bottom. Spine runs down the middle.".into();
    p.pieces.push(pc);
    for (a, b) in [(0usize, 1usize), (4, 3), (10, 9), (6, 7)] {
        join(&mut p, ("cover", &[a]), ("cover", &[b]));
    }
    lay_out(p)
}

fn pen_loop(p: &mut Project, pen_mm: f64) {
    // Wraps a pen with two 10 mm tabs stitched to the cover.
    let len = (std::f64::consts::PI * (pen_mm + 1.5) + 20.0).round();
    let mut loop_ = panel("pen-loop", "Pen loop", "m1", len, 18.0);
    stitch(&mut loop_, [1, 3]);
    loop_.grain_deg = 0.0;
    loop_.notes = "Wrap round a pen and stitch both ends\nonto the inside of the back cover.".into();
    p.pieces.push(loop_);
    onto(p, ("pen-loop", &[1, 3]), "cover");
}

fn passport_cover() -> Project {
    book_cover("Passport cover", 88.0, 125.0, 6.0, 60.0, 3.0)
}

fn field_notes() -> Project {
    let mut p = book_cover("Field Notes cover", 89.0, 140.0, 4.0, 55.0, 4.0);
    pen_loop(&mut p, 9.0);
    lay_out(p)
}

fn a6_journal() -> Project {
    book_cover("A6 journal cover", 105.0, 148.0, 10.0, 60.0, 4.0)
}

fn checkbook_cover() -> Project {
    // The checkbook opens along its long edge, so it is the "book" 74 wide and 154 tall.
    let mut p = book_cover("Checkbook cover", 74.0, 154.0, 5.0, 55.0, 3.0);
    p.pieces[0].notes = "Slip the checks' back cover into one flap and the register into the other.".into();
    p
}

fn a4_folio() -> Project {
    let mut p = book_cover("A4 pad folio", 210.0, 297.0, 15.0, 90.0, 5.0);
    pen_loop(&mut p, 11.0);
    lay_out(p)
}

// ---------- cases ----------

/// Front and back with a rounded bottom sewn round three sides, optionally with a thumb notch.
#[allow(clippy::too_many_arguments)]
fn pouch(name: &str, preset: &str, oz: f64, w: f64, h: f64, r: f64, notch_w: f64, note: &str) -> Project {
    let mut p = project(name, preset, oz);
    for (id, pname) in [("front", "Front"), ("back", "Back")] {
        let mut pc = panel_rounded_bottom(id, pname, "m1", w, h, r);
        stitch(&mut pc, 1..=5);
        if notch_w > 0.0 && id == "front" {
            notch(&mut pc, 0, notch_w, notch_w * 0.35);
        }
        pc.notes = note.into();
        p.pieces.push(pc);
    }
    let sides = |pc: &Piece| -> Vec<usize> {
        let n = pc.edges.len();
        (n - 5..n).collect()
    };
    let (a, b) = (sides(&p.pieces[0]), sides(&p.pieces[1]));
    join(&mut p, ("front", &a), ("back", &b));
    lay_out(p)
}

fn phone_sleeve() -> Project {
    // 72 x 148 x 8 mm phone: 2 (72 + 8) round the stitch lines, plus ease.
    pouch("Phone sleeve", "vegtan-firm", 4.0, 86.0, 168.0, 12.0, 30.0, "Wet-mould around the phone (in a plastic bag).")
}

fn glasses_case() -> Project {
    pouch("Glasses case", "vegtan-firm", 5.0, 95.0, 175.0, 30.0, 0.0, "Wet-mould around the folded glasses.")
}

fn tablet_sleeve() -> Project {
    pouch("Tablet sleeve, 11 in", "pullup", 4.0, 264.0, 190.0, 15.0, 50.0, "Loads from the long side. For 250 x 178 x 6 mm;\nwiden 2 mm per extra mm of thickness.")
}

fn pen_sleeve() -> Project {
    let mut p = project("Pen sleeve", "vegtan-soft", 3.0);
    let (w, fold_at, total) = (50.0, 150.0, 320.0);
    let build = |split: f64| {
        outline(
            "body",
            "Sleeve",
            &[(0.0, 0.0, 6.0), (w, 0.0, 6.0), (w, fold_at, 0.0), (w, split, 0.0), (w, total, 10.0), (0.0, total, 10.0), (0.0, split, 0.0), (0.0, fold_at, 0.0)],
        )
    };
    // The back is taller; its sides are stitched for exactly as long as the front's.
    let (mut probe, sd) = build(fold_at + 140.0);
    stitch(&mut probe, [sd[1], sd[2], sd[6], sd[7]]);
    let front_run = run_len(&probe, 3.0 * OZ_MM, &[sd[1]]);
    let (mut pc, sd) = build(fold_at + front_run);
    stitch(&mut pc, [sd[1], sd[2], sd[6], sd[7]]);
    fold(&mut pc, "bottom", Orientation::Horizontal, fold_at, 10.0);
    pc.notes = "Fold at the line and stitch both sides;\nthe taller back is the pull tab.".into();
    p.pieces.push(pc);
    join(&mut p, ("body", &[sd[1]]), ("body", &[sd[2]]));
    join(&mut p, ("body", &[sd[7]]), ("body", &[sd[6]]));
    lay_out(p)
}

/// A gusseted pouch: front, a back that carries the flap, and a gusset sized to the stitch line.
#[allow(clippy::too_many_arguments)]
fn gusset_pouch(p: &mut Project, w: f64, h: f64, depth: f64, r: f64, flap: f64, flap_r: f64, snap: &str) {
    let t = thickness(p);
    let mut front = panel_rounded_bottom("front", "Front", "m1", w, h, r);
    stitch(&mut front, 1..=5);
    let (mut back, sd) = outline(
        "back",
        "Back and flap",
        &[(0.0, 0.0, flap_r), (w, 0.0, flap_r), (w, flap, 0.0), (w, flap + M, 0.0), (w, flap + h, r), (0.0, flap + h, r), (0.0, flap + M, 0.0), (0.0, flap, 0.0)],
    );
    let seam: Vec<usize> = (sd[3]..=sd[5]).collect();
    stitch(&mut back, seam.iter().copied());
    // The flap crosses the top of the pouch: make its allowance about the depth plus both layers.
    let contents = (2.0 * (depth + 2.0 * t) / std::f64::consts::PI - t).max(0.0);
    fold(&mut back, "flap-fold", Orientation::Horizontal, flap, contents);
    let cap = 13.0;
    hardware(&mut back, "snap-cap", snap, v(w / 2.0, cap), "Snap cap");
    hardware(&mut front, "snap-stud", snap, v(w / 2.0, flap - cap), "Snap stud");
    let u = run_len(&front, t, &[1, 2, 3, 4, 5]);
    let mut g = gusset("Gusset", u + 2.0 * M, depth, "m1", v(0.0, 0.0), "gusset");
    g.notes = "Sews to the front along one edge and to the back along the other;\nthe ends are the mouth.".into();
    p.pieces.push(front);
    p.pieces.push(back);
    p.pieces.push(g);
    join(p, ("front", &[1, 2, 3, 4, 5]), ("gusset", &[0]));
    join(p, ("back", &seam), ("gusset", &[2]));
}

fn earbud_case() -> Project {
    let mut p = project("Earbud case", "vegtan-soft", 4.0);
    gusset_pouch(&mut p, 68.0, 64.0, 26.0, 18.0, 36.0, 14.0, "snap-20");
    p.pieces[0].notes = "Set the snap stud before stitching.".into();
    lay_out(p)
}

fn belt_pouch() -> Project {
    let mut p = project("Belt pouch", "vegtan-firm", 5.0);
    gusset_pouch(&mut p, 100.0, 150.0, 35.0, 12.0, 75.0, 20.0, "snap-24");
    // Two loops for a 38 mm belt, stitched top and bottom onto the back.
    let mut lp = panel("loop", "Belt loop", "m1", 30.0, 75.0);
    stitch(&mut lp, [0, 2]);
    lp.cut_count = 2;
    lp.notes = "Cut 2. Stitch both ends onto the back,\n20 mm in from each side, before assembly.".into();
    p.pieces.push(lp);
    onto(&mut p, ("loop", &[0, 2]), "back");
    lay_out(p)
}

fn laptop_sleeve() -> Project {
    let mut p = project("Laptop sleeve, 13 in", "pullup", 4.0);
    let t = thickness(&p);
    // 304 x 215 x 11.3 mm laptop: 2 (304 + 11.3) round the stitch lines, plus ease.
    let (w, h, flap, r) = (324.0, 230.0, 90.0, 15.0);
    let mut front = panel_rounded_bottom("front", "Front", "m1", w, h, r);
    stitch(&mut front, 1..=5);
    let (mut back, sd) = outline(
        "back",
        "Back and flap",
        &[(0.0, 0.0, 25.0), (w, 0.0, 25.0), (w, flap, 0.0), (w, flap + M, 0.0), (w, flap + h, r), (0.0, flap + h, r), (0.0, flap + M, 0.0), (0.0, flap, 0.0)],
    );
    let seam: Vec<usize> = (sd[3]..=sd[5]).collect();
    stitch(&mut back, seam.iter().copied());
    fold(&mut back, "flap-fold", Orientation::Horizontal, flap, 11.3 + t);
    let at = 28.0;
    hardware(&mut back, "magnet-a", "magnet-18", v(w / 2.0, at), "Magnet");
    hardware(&mut front, "magnet-b", "magnet-18", v(w / 2.0, flap - at), "Magnet");
    front.notes = "Set the magnet and back it with a leather patch before stitching.".into();
    p.pieces.push(front);
    p.pieces.push(back);
    join(&mut p, ("front", &[1, 2, 3, 4, 5]), ("back", &seam));
    lay_out(p)
}

// ---------- outdoor ----------

fn knife_sheath() -> Project {
    let mut p = project("Knife sheath, welted", "vegtan-firm", 8.0);
    let t = thickness(&p);
    // Pocket for a 100 x 25 mm blade and the front of the handle; spine on the left.
    let pocket = [(48.0, 95.0, 20.0), (18.0, 158.0, 6.0), (0.0, 128.0, 12.0)];
    let mut fpts = vec![(0.0, 0.0, 0.0), (48.0, 0.0, 0.0)];
    fpts.extend(pocket);
    let (mut front, fd) = outline("front", "Front", &fpts);
    let fseam: Vec<usize> = (fd[1]..=fd[4]).collect();
    stitch(&mut front, fseam.iter().copied());
    front.notes = "Wet-form round the knife after stitching.".into();
    // Back: a belt loop above the pocket that folds down and rivets to the back.
    let l = 100.0;
    let mut bpts = vec![(0.0, 0.0, 8.0), (48.0, 0.0, 8.0), (48.0, l + M, 0.0)];
    bpts.extend(pocket.iter().map(|&(x, y, r)| (x, y + l, r)));
    bpts.push((0.0, l + M, 0.0));
    let (mut back, bd) = outline("back", "Back with belt loop", &bpts);
    let bseam: Vec<usize> = (bd[2]..=bd[5]).collect();
    stitch(&mut back, bseam.iter().copied());
    fold(&mut back, "loop", Orientation::Horizontal, l / 2.0, 5.0);
    for (k, y) in [10.0, l - 10.0].into_iter().enumerate() {
        hardware(&mut back, &format!("loop-rivet{k}"), "rivet-l", v(24.0, y), "Loop rivet");
    }
    back.notes = "Fold the loop to the back and rivet it; fits a 40 mm belt.".into();
    let welt = welt_for(&front, &fseam, 9.0, t, "welt");
    p.pieces.push(front);
    p.pieces.push(back);
    p.pieces.push(welt);
    welted(&mut p, ("front", &fseam), ("back", &bseam), 9.0);
    lay_out(p)
}

fn axe_mask() -> Project {
    let mut p = project("Axe mask", "vegtan-firm", 7.0);
    let t = thickness(&p);
    let (w, d) = (150.0, 48.0);
    let mut pieces = Vec::new();
    for (id, name) in [("front", "Front"), ("back", "Back")] {
        let mut pc = panel(id, name, "m1", w, d);
        // The bit side bows out to follow the edge.
        pc.edges[2].kind = EdgeKind::Cubic { c1: v(w - 40.0, d + 22.0), c2: v(40.0, d + 22.0) };
        stitch(&mut pc, 1..=3);
        pc.grain_deg = 0.0;
        pieces.push(pc);
    }
    hardware(&mut pieces[0], "stud", "snap-24", v(w / 2.0, 12.0), "Snap stud");
    hardware(&mut pieces[1], "strap-rivet", "rivet-m", v(w / 2.0, 12.0), "Strap rivet");
    let welt = welt_for(&pieces[0], &[1, 2, 3], 9.0, t, "welt");
    let mut st = rounded("strap", "Retaining strap", 280.0, 20.0, 9.0);
    st.grain_deg = 0.0;
    hardware(&mut st, "rivet", "rivet-m", v(12.0, 10.0), "Rivet to back");
    hardware(&mut st, "cap", "snap-24", v(266.0, 10.0), "Snap cap");
    st.notes = "Runs from the back round the poll to the front.".into();
    p.pieces.extend(pieces);
    p.pieces.push(welt);
    p.pieces.push(st);
    welted(&mut p, ("front", &[1, 2, 3]), ("back", &[1, 2, 3]), 9.0);
    lay_out(p)
}

// ---------- small goods ----------

fn key_fob() -> Project {
    let mut p = project("Key fob", "vegtan-firm", 6.0);
    let mut pc = rounded("fob", "Fob", 22.0, 130.0, 8.0);
    pc.grain_deg = 90.0;
    fold(&mut pc, "f1", Orientation::Horizontal, 65.0, 3.0);
    hardware(&mut pc, "rivet-a", "rivet-m", v(11.0, 20.0), "Rivet");
    hardware(&mut pc, "rivet-b", "rivet-m", v(11.0, 110.0), "Rivet");
    hardware(&mut pc, "ring", "key-ring", v(11.0, 65.0), "Key ring");
    pc.notes = "Thread the key ring, then\nrivet both ends together.".into();
    p.pieces.push(pc);
    lay_out(p)
}

fn key_case() -> Project {
    let mut p = project("Key case, 6 hooks", "vegtan-soft", 4.0);
    let (w, h) = (130.0, 75.0);
    // Right edge carries a snap tab that wraps the closed case.
    let (mut pc, _) = outline(
        "case",
        "Key case",
        &[(0.0, 0.0, 8.0), (w, 0.0, 8.0), (w, 24.0, 0.0), (w + 40.0, 24.0, 10.0), (w + 40.0, 51.0, 10.0), (w, 51.0, 0.0), (w, h, 8.0), (0.0, h, 8.0)],
    );
    fold(&mut pc, "spine", Orientation::Vertical, w / 2.0, 10.0);
    for (k, x) in [w / 2.0 + 12.0, w / 2.0 + 57.0].into_iter().enumerate() {
        hardware(&mut pc, &format!("plate{k}"), "rivet-s", v(x, 14.0), "Key plate rivet");
    }
    hardware(&mut pc, "cap", "snap-20", v(w + 30.0, 37.5), "Snap cap");
    hardware(&mut pc, "stud", "snap-20", v(18.0, 37.5), "Snap stud");
    pc.grain_deg = 0.0;
    for e in pc.edges.iter_mut() {
        e.finish = EdgeFinish::Burnished;
    }
    pc.notes = "Rivet a 6-hook key plate (45 mm hole spacing) inside the right half.\nThe tab wraps the closed case and snaps on the outside.".into();
    p.pieces.push(pc);
    lay_out(p)
}

fn cable_tie() -> Project {
    let mut p = project("Cable organiser", "vegtan-firm", 5.0);
    let mut pc = rounded("tie", "Cable tie", 130.0, 20.0, 9.0);
    pc.grain_deg = 0.0;
    hardware(&mut pc, "snap-a", "snap-20", v(15.0, 10.0), "Snap cap");
    hardware(&mut pc, "snap-b", "snap-20", v(115.0, 10.0), "Snap stud");
    slot(&mut pc, "slot", v(45.0, 10.0), 3.0, 12.0, 90.0, "");
    pc.notes = "Push the cable's plug through the slit\nto keep the tie on the cable.".into();
    p.pieces.push(pc);
    lay_out(p)
}

fn luggage_tag() -> Project {
    let mut p = project("Luggage tag", "vegtan-firm", 5.0);
    let (w, h) = (110.0, 65.0);
    // Stitched round all but the right end, where the card slides in.
    let seam = [4usize, 5, 6, 7, 0];
    let mut front = rounded("front", "Front with window", w, h, 8.0);
    stitch(&mut front, seam);
    slot(&mut front, "window", v(62.0, 32.5), 34.0, 66.0, 0.0, "Window");
    slot(&mut front, "strap-slot", v(14.0, 32.5), 3.0, 18.0, 90.0, "");
    let mut back = rounded("back", "Back", w, h, 8.0);
    stitch(&mut back, seam);
    slot(&mut back, "strap-slot-b", v(14.0, 32.5), 3.0, 18.0, 90.0, "Strap slot");
    back.notes = "The card slides in at the open right end.".into();
    p.pieces.push(front);
    p.pieces.push(back);
    join(&mut p, ("front", &seam), ("back", &seam));
    let params = StrapParams {
        name: "Tag strap".into(),
        length_mm: 240.0,
        width_mm: 15.0,
        holes: 4,
        hole_spacing_mm: 15.0,
        first_hole_mm: 30.0,
        hole_mm: 3.0,
        buckle_end: true,
        buckle_fold_mm: 50.0,
        tongue_slot_mm: 12.0,
        ..Default::default()
    };
    p.pieces.push(strap(&params, "m1", v(0.0, 0.0), "strap"));
    lay_out(p)
}

fn bookmark() -> Project {
    let mut p = project("Bookmark", "vegtan-firm", 4.0);
    let mut pc = rounded("mark", "Bookmark", 40.0, 180.0, 6.0);
    hole(&mut pc, "tassel", v(20.0, 14.0), 4.0, "Tassel");
    pc.marks.push(Mark { id: "stamp".into(), kind: MarkKind::Stamp, center: v(20.0, 120.0), size: v(25.0, 25.0), angle_deg: 0.0, text: String::new(), pattern: String::new() });
    p.pieces.push(pc);
    lay_out(p)
}

// ---------- home ----------

fn coaster() -> Project {
    let mut p = project("Coaster set", "vegtan-firm", 5.0);
    for (id, name) in [("top", "Top"), ("base", "Base")] {
        let mut pc = ellipse(id, name, "m1", 100.0, 100.0);
        stitch(&mut pc, 0..4);
        pc.cut_count = 4;
        p.pieces.push(pc);
    }
    p.laminates.push(Laminate { id: "lam".into(), a: "top".into(), b: "base".into(), glue: Adhesive::ContactCement });
    join(&mut p, ("top", &[0, 1, 2, 3]), ("base", &[0, 1, 2, 3]));
    lay_out(p)
}

fn drink_sleeve() -> Project {
    let mut p = project("Drink sleeve", "vegtan-soft", 4.0);
    let t = thickness(&p);
    // 66 mm can: the tube's finished edge is pi (66 + 2 t) round.
    let w = (std::f64::consts::PI * (66.0 + 2.0 * t)).round();
    let mut body = panel("body", "Sleeve", "m1", w, 100.0);
    stitch(&mut body, 1..=3);
    body.grain_deg = 0.0;
    body.notes = "Sew the ends together into a tube, then sew in the base.".into();
    // Base circle whose stitch line matches the tube's bottom stitch line.
    let l = run_len(&body, t, &[2]);
    let d = 2.0 * (l / (2.0 * std::f64::consts::PI) + M);
    let mut base = ellipse("base", "Base", "m1", d, d);
    stitch(&mut base, 0..4);
    p.pieces.push(body);
    p.pieces.push(base);
    join(&mut p, ("body", &[1]), ("body", &[3]));
    join(&mut p, ("body", &[2]), ("base", &[0, 1, 2, 3]));
    lay_out(p)
}

fn bottle_carrier() -> Project {
    let mut p = project("Bottle carrier", "vegtan-firm", 6.0);
    let t = thickness(&p);
    // Bands round a 76 mm bottle, overlapping 20 mm at the rivet.
    let band_len = (std::f64::consts::PI * (76.0 + t) + 20.0).round();
    let mut band = rounded("band", "Band", band_len, 25.0, 4.0);
    band.grain_deg = 0.0;
    band.cut_count = 2;
    hardware(&mut band, "r1", "rivet-m", v(10.0, 12.5), "Rivet");
    hardware(&mut band, "r2", "rivet-m", v(band_len - 10.0, 12.5), "Rivet");
    band.notes = "Cut 2: one 40 mm above the base, one at the shoulder.\nEach rivet also goes through the strap.".into();
    let mut st = rounded("strap", "Carry strap", 650.0, 25.0, 12.0);
    st.grain_deg = 0.0;
    for (k, x) in [12.0, 150.0, 638.0].into_iter().enumerate() {
        hardware(&mut st, &format!("s{k}"), "rivet-m", v(x, 12.5), "Rivet");
    }
    st.notes = "Up the bottle from the lower band; the end loops back to the upper band as the handle.".into();
    p.pieces.push(band);
    p.pieces.push(st);
    lay_out(p)
}

fn plant_hanger() -> Project {
    let mut p = project("Plant hanger", "vegtan-firm", 6.0);
    let mut base = ellipse("base", "Base", "m1", 140.0, 140.0);
    for (k, (x, y)) in [(70.0, 12.0), (128.0, 70.0), (70.0, 128.0), (12.0, 70.0)].into_iter().enumerate() {
        hardware(&mut base, &format!("b{k}"), "rivet-m", v(x, y), "Strap rivet");
    }
    base.notes = "For pots up to 130 mm\nacross the base.".into();
    let mut st = rounded("strap", "Hanging strap", 600.0, 15.0, 7.0);
    st.grain_deg = 0.0;
    st.cut_count = 4;
    fold(&mut st, "ring", Orientation::Vertical, 575.0, 6.0);
    hardware(&mut st, "low", "rivet-m", v(10.0, 7.5), "Rivet to base");
    hardware(&mut st, "top-a", "rivet-m", v(560.0, 7.5), "Rivet");
    hardware(&mut st, "top-b", "rivet-m", v(590.0, 7.5), "Rivet");
    hardware(&mut st, "o-ring", "o-ring", v(575.0, 7.5), "O-ring");
    st.notes = "Cut 4. Fold the top end round the O-ring and rivet.".into();
    p.pieces.push(base);
    p.pieces.push(st);
    lay_out(p)
}

fn valet_tray() -> Project {
    let mut p = project("Valet tray", "vegtan-firm", 6.0);
    let (s, wall) = (220.0, 35.0);
    let mut pc = rounded("tray", "Tray", s, s, 6.0);
    for (k, at) in [wall, s - wall].into_iter().enumerate() {
        fold(&mut pc, &format!("h{k}"), Orientation::Horizontal, at, 0.0);
        fold(&mut pc, &format!("v{k}"), Orientation::Vertical, at, 0.0);
    }
    // Each corner square folds on its diagonal; the cap and stud sit mirrored across it.
    let (a, b) = (0.3 * wall, 0.7 * wall);
    for (k, (sx, sy)) in [(0.0, 0.0), (s, 0.0), (s, s), (0.0, s)].into_iter().enumerate() {
        let at = |x: f64, y: f64| v(if sx > 0.0 { s - x } else { x }, if sy > 0.0 { s - y } else { y });
        hardware(&mut pc, &format!("cap{k}"), "snap-20", at(a, b), "Cap");
        hardware(&mut pc, &format!("stud{k}"), "snap-20", at(b, a), "Stud");
    }
    pc.notes = "Crease the fold lines. Pinch each corner square\non its diagonal so cap meets stud, and snap.".into();
    p.pieces.push(pc);
    lay_out(p)
}

fn mat(name: &str, w: f64, h: f64, r: f64, oz: f64) -> Project {
    let mut p = project(name, "vegtan-firm", oz);
    let mut pc = rounded("mat", name, w, h, r);
    pc.grain_deg = 0.0;
    for e in pc.edges.iter_mut() {
        e.finish = EdgeFinish::Burnished;
    }
    pc.notes = "Bevel and burnish the edges; seal the grain side.".into();
    p.pieces.push(pc);
    lay_out(p)
}

fn mouse_pad() -> Project {
    mat("Mouse pad", 250.0, 210.0, 12.0, 5.0)
}

fn desk_mat() -> Project {
    mat("Desk mat", 400.0, 300.0, 15.0, 5.0)
}

fn tool_roll() -> Project {
    let mut p = project("Tool roll", "waxed-canvas", 0.0);
    p.materials.push(material("m2", "vegtan-soft", 4.0));
    let (w, h, ph) = (400.0, 300.0, 160.0);
    // Back split where the pocket's side stitching starts.
    let s = h - ph + M;
    let (mut back, sd) = outline("back", "Back", &[(0.0, 0.0, 0.0), (w, 0.0, 0.0), (w, s, 0.0), (w, h, 0.0), (0.0, h, 0.0), (0.0, s, 0.0)]);
    let seam: Vec<usize> = (sd[2]..=sd[4]).collect();
    stitch(&mut back, seam.iter().copied());
    for e in back.edges.iter_mut() {
        e.finish = EdgeFinish::Turned;
        e.turn_mm = 10.0;
    }
    back.grain_deg = 0.0;
    back.notes = "Turn and machine-stitch a 10 mm hem on the top and sides first.".into();
    let mut pocket = panel("pocket", "Pocket", "m1", w, ph);
    stitch(&mut pocket, 1..=3);
    pocket.grain_deg = 0.0;
    pocket.edges[0].finish = EdgeFinish::Turned;
    pocket.edges[0].turn_mm = 10.0;
    pocket.notes = "Hem the mouth, then stitch dividers every 40 mm from the bottom up to the mouth.".into();
    p.pieces.push(back);
    p.pieces.push(pocket);
    join(&mut p, ("pocket", &[1, 2, 3]), ("back", &seam));
    let params = StrapParams { name: "Tie".into(), length_mm: 900.0, width_mm: 12.0, holes: 0, buckle_end: false, tip: Tip::Point, ..Default::default() };
    let mut tie = strap(&params, "m2", v(0.0, 0.0), "tie");
    tie.notes = "Box-stitch the square end to the outside of the back, halfway up the right edge.".into();
    let end = tie.edges.len() - 1;
    p.pieces.push(tie);
    onto(&mut p, ("tie", &[end]), "back");
    lay_out(p)
}

fn apron() -> Project {
    let mut p = project("Shop apron", "waxed-canvas", 0.0);
    p.materials.push(material("m2", "vegtan-firm", 5.0));
    // Bib 260 wide, scooped armholes out to the 600 mm skirt at waist level (y = 300).
    let (mut body, sd) = outline(
        "body",
        "Apron body",
        &[(170.0, 0.0, 10.0), (430.0, 0.0, 10.0), (430.0, 40.0, 0.0), (600.0, 300.0, 0.0), (600.0, 850.0, 30.0), (0.0, 850.0, 30.0), (0.0, 300.0, 0.0), (170.0, 40.0, 0.0)],
    );
    body.edges[sd[2]].kind = EdgeKind::Cubic { c1: v(430.0, 190.0), c2: v(470.0, 300.0) };
    body.edges[sd[6]].kind = EdgeKind::Cubic { c1: v(130.0, 300.0), c2: v(170.0, 190.0) };
    for e in body.edges.iter_mut() {
        e.finish = EdgeFinish::Turned;
        e.turn_mm = 10.0;
    }
    hardware(&mut body, "neck-l", "rivet-m", v(190.0, 16.0), "Neck strap rivet");
    hardware(&mut body, "neck-r", "chicago-screw", v(410.0, 16.0), "Neck strap screw");
    hardware(&mut body, "waist-l", "copper-rivet", v(16.0, 315.0), "Tie rivet");
    hardware(&mut body, "waist-r", "copper-rivet", v(584.0, 315.0), "Tie rivet");
    body.notes = "Hem all round (10 mm turned and machine-stitched) before setting the hardware.\nBack each rivet with a small leather washer.".into();
    let mut pocket = panel("pocket", "Chest pocket", "m1", 180.0, 150.0);
    stitch(&mut pocket, 1..=3);
    pocket.edges[0].finish = EdgeFinish::Turned;
    pocket.edges[0].turn_mm = 10.0;
    pocket.notes = "Hem the mouth; sew on centred 120 mm below the bib top,\nwith a divider 60 mm from the left.".into();
    let neck = StrapParams { name: "Neck strap".into(), length_mm: 640.0, width_mm: 20.0, holes: 5, hole_spacing_mm: 15.0, first_hole_mm: 20.0, hole_mm: 4.5, buckle_end: false, tip: Tip::Round, ..Default::default() };
    let mut ns = strap(&neck, "m2", v(0.0, 0.0), "neck");
    hole(&mut ns, "neck-rivet", v(10.0, 10.0), 3.0, "Rivet");
    ns.notes = "Rivet the square end to the bib's left corner; the holes adjust on the screw.".into();
    let tie = StrapParams { name: "Waist tie".into(), length_mm: 800.0, width_mm: 20.0, holes: 0, buckle_end: false, tip: Tip::Point, ..Default::default() };
    let mut wt = strap(&tie, "m2", v(0.0, 0.0), "tie");
    hole(&mut wt, "tie-rivet", v(12.0, 10.0), 3.0, "Rivet");
    wt.cut_count = 2;
    wt.notes = "Cut 2. Rivet the square end to the body at the waist.".into();
    p.pieces.push(body);
    p.pieces.push(pocket);
    p.pieces.push(ns);
    p.pieces.push(wt);
    onto(&mut p, ("pocket", &[1, 2, 3]), "body");
    lay_out(p)
}

// ---------- straps ----------

fn watch_strap() -> Project {
    let mut p = project("Watch strap, 20 mm", "vegtan-soft", 4.0);
    let lug = 12.0;
    // Long half: lug fold at x = 0, holes towards the round tip. 120 mm finished.
    let long = StrapParams { name: "Long half".into(), length_mm: 120.0 + lug, width_mm: 20.0, holes: 7, hole_spacing_mm: 6.0, first_hole_mm: 30.0, hole_mm: 1.8, buckle_end: false, tip: Tip::Round, stitched: true, ..Default::default() };
    let mut lp = strap(&long, "m1", v(0.0, 0.0), "long");
    fold(&mut lp, "lug", Orientation::Vertical, lug, 1.8);
    lp.notes = "Fold the end round the spring bar;\nthe edge stitching holds it.".into();
    // Short half: buckle fold at x = 0, lug fold at the square end. 75 mm finished.
    let short = StrapParams { name: "Short half".into(), length_mm: 75.0 + 15.0 + lug, width_mm: 20.0, holes: 0, buckle_end: true, buckle_fold_mm: 30.0, tongue_slot_mm: 10.0, hole_mm: 2.0, tip: Tip::Square, stitched: true, ..Default::default() };
    let mut sp = strap(&short, "m1", v(0.0, 0.0), "short");
    sp.holes.retain(|h| h.label != "Rivet");
    fold(&mut sp, "lug", Orientation::Vertical, short.length_mm - lug, 1.8);
    sp.notes = "Buckle at the slotted end, spring bar at the square end;\nthe edge stitching holds both folds.".into();
    let mut keeper = panel("keeper", "Keeper", "m1", 52.0, 8.0);
    keeper.grain_deg = 0.0;
    keeper.notes = "Wrap round both halves,\nbutt the ends and stitch.".into();
    p.pieces.push(lp);
    p.pieces.push(sp);
    p.pieces.push(keeper);
    lay_out(p)
}

fn dog_collar() -> Project {
    let mut p = project("Dog collar", "vegtan-firm", 8.0);
    let params = StrapParams { name: "Collar".into(), length_mm: 480.0, width_mm: 25.0, holes: 7, hole_spacing_mm: 20.0, first_hole_mm: 60.0, buckle_end: true, buckle_fold_mm: 110.0, ..Default::default() };
    let mut pc = strap(&params, "m1", v(0.0, 0.0), "collar");
    // A second pair of rivets between the buckle and the D-ring, mirrored about the fold at 55.
    hardware(&mut pc, "rivet-c", "rivet-m", v(35.0, 12.5), "");
    hardware(&mut pc, "rivet-d", "rivet-m", v(75.0, 12.5), "");
    hardware(&mut pc, "d-ring", "d-ring", v(22.5, 12.5), "D-ring");
    pc.notes = "Buckle in the fold, then the D-ring between the two rivet pairs. Fits necks of 330 to 450 mm.".into();
    let mut keeper = panel("keeper", "Keeper", "m1", 70.0, 12.0);
    keeper.grain_deg = 0.0;
    keeper.notes = "Wrap round the collar behind\nthe buckle, butt and stitch.".into();
    p.pieces.push(pc);
    p.pieces.push(keeper);
    lay_out(p)
}

fn guitar_strap() -> Project {
    let mut p = project("Guitar strap", "vegtan-firm", 7.0);
    let mut pc = rounded("strap", "Guitar strap", 1200.0, 60.0, 25.0);
    pc.grain_deg = 0.0;
    for (k, x) in [30.0, 1170.0].into_iter().enumerate() {
        hole(&mut pc, &format!("button{k}"), v(x, 30.0), 10.0, "Strap button");
        slot(&mut pc, &format!("slit{k}"), v(if k == 0 { x + 12.0 } else { x - 12.0 }, 30.0), 2.0, 14.0, 0.0, "");
    }
    pc.notes = "Cut along the spine of the hide so it does not stretch.".into();
    p.pieces.push(pc);
    lay_out(p)
}

fn camera_strap() -> Project {
    let mut p = project("Camera strap", "vegtan-soft", 4.0);
    let (len, end) = (1000.0, 40.0);
    let total = len + 2.0 * end;
    let mut pc = rounded("strap", "Camera strap", total, 30.0, 10.0);
    pc.grain_deg = 0.0;
    stitch(&mut pc, 0..8);
    for (k, x) in [end, total - end].into_iter().enumerate() {
        fold(&mut pc, &format!("ring{k}"), Orientation::Vertical, x, 3.0);
        hardware(&mut pc, &format!("ring{k}"), "key-ring", v(x, 15.0), "Split ring");
    }
    pc.notes = "Fold each end round a split ring; the edge stitching holds the folds.".into();
    p.pieces.push(pc);
    lay_out(p)
}

fn wrist_cuff() -> Project {
    let mut p = project("Wrist cuff", "vegtan-firm", 7.0);
    let mut pc = rounded("cuff", "Cuff", 230.0, 50.0, 10.0);
    pc.grain_deg = 0.0;
    for (k, y) in [15.0, 35.0].into_iter().enumerate() {
        hardware(&mut pc, &format!("cap{k}"), "snap-20", v(15.0, y), "");
        hardware(&mut pc, &format!("stud{k}"), "snap-20", v(215.0, y), "");
    }
    pc.marks.push(Mark { id: "tool".into(), kind: MarkKind::Tooling, center: v(115.0, 25.0), size: v(140.0, 34.0), angle_deg: 0.0, text: String::new(), pattern: "floral".into() });
    pc.notes = "200 mm round when snapped: for wrists up to 180 mm.".into();
    p.pieces.push(pc);
    lay_out(p)
}

fn hat_band() -> Project {
    let mut p = project("Hat band", "vegtan-soft", 3.0);
    let params = StrapParams {
        name: "Hat band".into(),
        length_mm: 660.0,
        width_mm: 15.0,
        holes: 5,
        hole_spacing_mm: 12.0,
        first_hole_mm: 40.0,
        hole_mm: 2.5,
        buckle_end: true,
        buckle_fold_mm: 40.0,
        tongue_slot_mm: 10.0,
        rivet_mm: 2.5,
        ..Default::default()
    };
    let mut pc = strap(&params, "m1", v(0.0, 0.0), "band");
    pc.notes = "Fits crowns of 560 to 620 mm. Use a 15 mm buckle.".into();
    p.pieces.push(pc);
    lay_out(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::compute;

    #[test]
    fn every_template_builds_and_its_seams_match() {
        let mut ids = std::collections::HashSet::new();
        for e in entries() {
            assert!(ids.insert(e.id), "duplicate id {}", e.id);
            let p = (e.build)();
            assert!(!p.pieces.is_empty(), "{}", e.id);
            let c = compute(&p);
            assert!(c.warnings.is_empty(), "{}: {:?}", e.id, c.warnings);
            for j in &c.joins {
                assert!(j.ok, "{}: {}", e.id, j.message);
            }
            // Laid out without overlapping.
            for (i, a) in c.pieces.iter().enumerate() {
                for b in &c.pieces[i + 1..] {
                    let (pa, pb) = (p.piece(&a.id).unwrap().position, p.piece(&b.id).unwrap().position);
                    let ra = (pa.x + a.bounds.min.x, pa.x + a.bounds.max.x, pa.y + a.bounds.min.y, pa.y + a.bounds.max.y);
                    let rb = (pb.x + b.bounds.min.x, pb.x + b.bounds.max.x, pb.y + b.bounds.min.y, pb.y + b.bounds.max.y);
                    let overlap = ra.0 < rb.1 && rb.0 < ra.1 && ra.2 < rb.3 && rb.2 < ra.3;
                    assert!(!overlap, "{}: {} overlaps {}", e.id, a.id, b.id);
                }
            }
            // Every hole (punched or for hardware) sits inside its piece.
            for cp in &c.pieces {
                for h in &cp.holes {
                    assert!(crate::print::point_in_polygon(h.center, &cp.outline), "{}: hole {} outside {}", e.id, h.id, cp.id);
                }
            }
            // Simulates.
            let s = crate::sim::Sim::new(&p, crate::sim::SimSpec { resolution: 150, ..Default::default() });
            assert!(s.is_ok(), "{}: {:?}", e.id, s.err());
        }
    }

    #[test]
    fn seams_match_hole_for_hole() {
        // Edge-to-edge seams in the library have identical stitch runs on both sides, so the hole
        // counts agree exactly, except where a closed ring meets an open run (the drink sleeve base).
        for e in entries() {
            let p = (e.build)();
            let c = compute(&p);
            for (j, r) in p.joins.iter().zip(&c.joins) {
                if j.onto_face() || (e.id == "drink-sleeve" && j.b.piece_id == "base") {
                    continue;
                }
                assert_eq!(r.a_holes, r.b_holes, "{} {}: {}", e.id, r.id, r.message);
            }
        }
    }

    #[test]
    fn rounded_edges_run_top_corner_right_corner_bottom_corner_left_corner() {
        let pc = rounded("r", "R", 100.0, 60.0, 5.0);
        assert_eq!(pc.edges.len(), 8);
        let lines: Vec<bool> = pc.edges.iter().map(|e| matches!(e.kind, EdgeKind::Line)).collect();
        assert_eq!(lines, [true, false, true, false, true, false, true, false]);
        let n = pc.vertices.len();
        let mid = |e: usize| (pc.vertices[e] + pc.vertices[(e + 1) % n]) * 0.5;
        assert!(mid(0).y.abs() < 1e-9, "top");
        assert!((mid(2).x - 100.0).abs() < 1e-9, "right");
        assert!((mid(4).y - 60.0).abs() < 1e-9, "bottom");
        assert!(mid(6).x.abs() < 1e-9, "left");
        // Each corner arc is a quarter circle of radius 5 starting and ending on the sides.
        assert!(pc.vertices[0].dist(v(5.0, 0.0)) < 1e-9 && pc.vertices[7].dist(v(0.0, 5.0)) < 1e-9);
    }

    #[test]
    fn welts_do_not_cross_themselves() {
        for id in ["knife-sheath", "axe-mask"] {
            let p = (entries().into_iter().find(|e| e.id == id).unwrap().build)();
            let w = &p.piece("welt").unwrap().vertices;
            let n = w.len();
            for i in 0..n {
                for j in i + 2..n {
                    if (j + 1) % n == i {
                        continue;
                    }
                    let (a, b, c, d) = (w[i], w[(i + 1) % n], w[j], w[(j + 1) % n]);
                    let cross = |o: Vec2, p: Vec2, q: Vec2| (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
                    let hit = (cross(c, d, a) > 0.0) != (cross(c, d, b) > 0.0) && (cross(a, b, c) > 0.0) != (cross(a, b, d) > 0.0);
                    assert!(!hit, "{id}: welt crosses itself at {i} and {j}");
                }
            }
        }
    }

    #[test]
    fn welts_pass_the_pattern_checker() {
        // The checker's outline test (crossing, area, corners) on the generated welts.
        for id in ["knife-sheath", "axe-mask"] {
            let p = (entries().into_iter().find(|e| e.id == id).unwrap().build)();
            let bad: Vec<String> = crate::check::check(&p).into_iter().filter(|i| i.check == "outline").map(|i| i.id).collect();
            assert!(bad.is_empty(), "{id}: {bad:?}");
        }
    }

    #[test]
    fn untwist_cuts_off_a_loop() {
        // A figure-of-eight bow tie becomes one triangle.
        let bow = vec![v(0.0, 0.0), v(10.0, 10.0), v(10.0, 0.0), v(0.0, 10.0)];
        let t = untwist(bow);
        assert_eq!(t.len(), 3);
        assert!(signed_area(&t).abs() > 1.0);
    }

    #[test]
    fn notch_dips_into_the_piece() {
        let mut pc = panel_rounded_bottom("f", "F", "m1", 86.0, 170.0, 12.0);
        notch(&mut pc, 0, 30.0, 10.0);
        assert_eq!(pc.edges.len(), 8);
        let cp = computed_alone(&pc, 1.6);
        let deepest = cp.outline.iter().filter(|q| (q.x - 43.0).abs() < 1.5 && q.y < 50.0).map(|q| q.y).fold(0.0, f64::max);
        assert!((deepest - 10.0).abs() < 0.3, "{deepest}");
    }
}
