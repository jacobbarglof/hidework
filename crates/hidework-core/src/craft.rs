//! The leatherworker's catalogue: stitches and lacing, threads, seam constructions, adhesives,
//! edge finishes and hardware. Strength numbers are rule-of-thumb estimates for planning, not
//! test data; thread and lace factors are the usual "length of thread per length of seam" rules.

use crate::geom::{v, Vec2};
use crate::model::{Adhesive, Construction, EdgeFinish, Hole, HardwarePlacement, StitchKind};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchInfo {
    pub kind: StitchKind,
    pub name: &'static str,
    pub group: &'static str,
    pub description: &'static str,
    /// Thread (or lace) length per length of seam.
    pub thread_factor: f64,
    /// Load-bearing strands per hole, relative to one strand of thread or lace.
    pub strands: f64,
    /// The thread wraps over the cut edge (whip, blanket, loop lacing).
    pub wraps_edge: bool,
    /// Laced with leather lace through slits instead of thread through holes.
    pub lace: bool,
    pub needles: u8,
    pub default_pitch_mm: f64,
}

pub fn stitches() -> Vec<StitchInfo> {
    use StitchKind::*;
    let s = |kind, name, group, description, thread_factor, strands, wraps_edge, lace, needles, default_pitch_mm| StitchInfo {
        kind,
        name,
        group,
        description,
        thread_factor,
        strands,
        wraps_edge,
        lace,
        needles,
        default_pitch_mm,
    };
    vec![
        s(Saddle, "Saddle stitch", "Hand stitch", "Two needles through every hole. Each strand locks the other, so one cut stitch does not unravel. The standard for leather goods.", 4.0, 2.0, false, false, 2, 3.85),
        s(Lockstitch, "Machine lockstitch", "Machine", "Top and bobbin threads lock inside the leather. Fast and even; a cut stitch can run.", 3.0, 1.6, false, false, 1, 4.0),
        s(Running, "Running stitch", "Hand stitch", "One needle in and out, every other gap filled. Decorative or temporary; the weakest.", 1.6, 1.0, false, false, 1, 4.0),
        s(Backstitch, "Back stitch", "Hand stitch", "One needle doubling back; looks like a machine line on top. Good where only one side shows.", 3.0, 1.6, false, false, 1, 3.85),
        s(Cross, "Cross stitch", "Decorative", "X-shaped stitches across a seam or along an edge, from two rows of holes.", 5.0, 2.0, false, false, 2, 5.0),
        s(Baseball, "Baseball stitch", "Butt seam", "Joins two edges side by side with no overlap; the thread crosses the gap like a ball's seam.", 6.0, 2.0, false, false, 2, 5.0),
        s(Whip, "Whip stitch", "Edge stitch", "Thread wraps over the edge from one hole to the next. Quick, closes an edge, shows as slanted wraps.", 3.5, 1.0, true, false, 1, 4.0),
        s(Blanket, "Blanket stitch", "Edge stitch", "Buttonhole stitch: each loop catches the last along the edge. Decorative edge binding in thread.", 4.5, 1.0, true, false, 1, 5.0),
        s(LaceWhip, "Whip lacing", "Lacing", "Lace wraps over the edge through slits. Rustic, quick, strong.", 3.5, 1.0, true, true, 1, 6.35),
        s(LaceSingleLoop, "Single loop lacing", "Lacing", "Each pass loops back under the last, covering the edge with a braided look.", 7.0, 1.0, true, true, 1, 6.35),
        s(LaceDoubleLoop, "Double loop lacing", "Lacing", "Two loops per slit; fully covers the edge. The classic western finish.", 9.0, 1.5, true, true, 1, 6.35),
        s(LaceCross, "Cross lacing", "Lacing", "Lace crosses over the edge in X shapes (cross whip).", 7.0, 1.5, true, true, 1, 6.35),
    ]
}

pub fn stitch_info(kind: StitchKind) -> StitchInfo {
    stitches().into_iter().find(|s| s.kind == kind).expect("every stitch kind is in the catalogue")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub diameter_mm: f64,
    /// Breaking load of one strand, newtons (estimate).
    pub break_n: f64,
    pub lace: bool,
}

pub fn threads() -> Vec<ThreadInfo> {
    let t = |id, name, diameter_mm, break_n, lace| ThreadInfo { id, name, diameter_mm, break_n, lace };
    vec![
        t("poly-0.45", "Braided polyester 0.45 mm", 0.45, 35.0, false),
        t("poly-0.53", "Braided polyester 0.53 mm", 0.53, 45.0, false),
        t("poly-0.6", "Braided polyester 0.6 mm", 0.6, 60.0, false),
        t("poly-0.8", "Braided polyester 0.8 mm", 0.8, 90.0, false),
        t("poly-1.0", "Braided polyester 1.0 mm", 1.0, 130.0, false),
        t("linen-18-3", "Waxed linen 18/3", 0.55, 45.0, false),
        t("nylon-138", "Bonded nylon #138 (machine)", 0.4, 85.0, false),
        t("nylon-207", "Bonded nylon #207 (machine)", 0.5, 125.0, false),
        t("nylon-277", "Bonded nylon #277 (machine)", 0.6, 170.0, false),
        t("lace-goat-3", "Goatskin lace 3 mm", 3.0, 120.0, true),
        t("lace-kanga-3", "Kangaroo lace 3 mm", 3.0, 220.0, true),
        t("lace-calf-5", "Calf lace 5 mm", 5.0, 180.0, true),
    ]
}

pub fn thread(id: Option<&str>, lace: bool) -> ThreadInfo {
    let all = threads();
    let want = id.and_then(|id| all.iter().find(|t| t.id == id).cloned());
    match want {
        Some(t) if t.lace == lace => t,
        _ => all.into_iter().find(|t| t.id == if lace { "lace-goat-3" } else { "poly-0.6" }).unwrap(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstructionInfo {
    pub construction: Construction,
    pub name: &'static str,
    pub description: &'static str,
}

pub fn constructions() -> Vec<ConstructionInfo> {
    use Construction::*;
    let c = |construction, name, description| ConstructionInfo { construction, name, description };
    vec![
        c(EdgeToEdge, "Edge to edge", "Flesh to flesh with the edges together, stitched through both and the edge finished as one. Wallets, cases, structured bags."),
        c(Turned, "Turned", "Sewn grain to grain inside out, then turned right side out: the stitching hides inside. Use soft leather about 1.2 mm or thinner at the seam."),
        c(Lapped, "Lapped", "One panel overlaps the other and one row of stitching goes through both. Flat, strong, easy to glue first."),
        c(Butt, "Butt", "The edges meet side by side with no overlap: baseball stitch, or a backing strip underneath. Flat and flexible."),
        c(Welted, "Welted", "A strip of leather (the welt) sits between the two edges. Stiffens the seam, protects stitching, seals the edge."),
        c(Piped, "Piped", "A cord wrapped in a thin strip sewn into the seam. A crisp rounded line that holds the bag's shape."),
        c(Bound, "Bound", "A binding strip folded over both raw edges and stitched through. Hides thin or soft edges."),
        c(Zipper, "Zipper", "Joined by a zipper. Opens and closes; the tape is stitched to each edge."),
    ]
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdhesiveInfo {
    pub adhesive: Adhesive,
    pub name: &'static str,
    pub description: &'static str,
    /// Lap shear strength on leather, MPa (estimate).
    pub shear_mpa: f64,
    /// Wet coverage, grams per square metre (both faces together).
    pub grams_per_m2: f64,
}

pub fn adhesives() -> Vec<AdhesiveInfo> {
    use Adhesive::*;
    let a = |adhesive, name, description, shear_mpa, grams_per_m2| AdhesiveInfo { adhesive, name, description, shear_mpa, grams_per_m2 };
    vec![
        a(None, "No glue", "Stitching or hardware only.", 0.0, 0.0),
        a(ContactCement, "Contact cement (solvent)", "Coat both faces, let it go tacky, press together. Instant, permanent, flexible. Ventilate.", 1.2, 250.0),
        a(WaterContact, "Water-based contact cement", "Same method as solvent contact cement with fewer fumes; slightly weaker.", 0.9, 220.0),
        a(Pva, "PVA leather glue", "One coat, slower set. Good for linings, positioning and edges; not for flexing seams.", 0.6, 150.0),
        a(Tape, "Double-sided tape", "Holds parts in place for stitching. Not structural.", 0.12, 0.0),
    ]
}

pub fn adhesive_info(a: Adhesive) -> AdhesiveInfo {
    adhesives().into_iter().find(|x| x.adhesive == a).unwrap()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishInfo {
    pub finish: EdgeFinish,
    pub name: &'static str,
    pub description: &'static str,
}

pub fn finishes() -> Vec<FinishInfo> {
    use EdgeFinish::*;
    let f = |finish, name, description| FinishInfo { finish, name, description };
    vec![
        f(Raw, "Raw", "Cut and left as is."),
        f(Burnished, "Burnished", "Bevelled, sanded and rubbed glossy with water, gum or wax. Veg-tan and firm leathers."),
        f(Painted, "Edge paint", "Layers of edge paint sanded between coats. Works on chrome-tan and mixed layers."),
        f(Turned, "Turned (folded)", "The edge is skived thin and folded under (rempliage). Adds a turn allowance to the cut line."),
        f(Bound, "Bound", "Wrapped in a binding strip."),
    ]
}

/// Default turn allowance for a folded (turned) edge, millimetres.
pub const TURN_MM: f64 = 6.0;

// ---------- hardware ----------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub description: &'static str,
    /// Size the next two numbers refer to: cap or ring inner width, zipper length.
    pub default_size_mm: f64,
    pub size_label: &'static str,
    pub grams: f64,
    /// Holds two layers together (rivets, snaps, screws, locks).
    pub fastens: bool,
    /// Pull-apart strength of the fastener, newtons (estimate).
    pub hold_n: f64,
}

pub fn hardware() -> Vec<HardwareInfo> {
    let h = |id, name, group, description, default_size_mm, size_label, grams, fastens, hold_n| HardwareInfo {
        id,
        name,
        group,
        description,
        default_size_mm,
        size_label,
        grams,
        fastens,
        hold_n,
    };
    vec![
        h("rivet-s", "Double-cap rivet, small", "Rivets", "6 mm caps; set through both layers.", 6.0, "cap", 0.6, true, 250.0),
        h("rivet-m", "Double-cap rivet, medium", "Rivets", "8 mm caps; the usual strap rivet.", 8.0, "cap", 1.0, true, 350.0),
        h("rivet-l", "Double-cap rivet, large", "Rivets", "10 mm caps for thick straps.", 10.0, "cap", 1.4, true, 450.0),
        h("copper-rivet", "Copper rivet and burr", "Rivets", "#9 rivet peened over a burr. The strongest rivet.", 9.0, "burr", 1.5, true, 700.0),
        h("chicago-screw", "Chicago screw", "Rivets", "Two-part screw post; removable.", 10.0, "head", 3.0, true, 600.0),
        h("snap-24", "Line 24 snap", "Closures", "Heavy press stud for flaps and straps.", 15.0, "cap", 2.5, true, 45.0),
        h("snap-20", "Line 20 snap", "Closures", "Medium press stud for wallets and small flaps.", 12.5, "cap", 2.0, true, 30.0),
        h("magnet-18", "Magnetic snap 18 mm", "Closures", "Two prongs through slits, bent over a washer.", 18.0, "disc", 6.0, true, 18.0),
        h("turnlock-catch", "Turn lock (catch)", "Closures", "The turning part, on the front panel.", 30.0, "plate", 12.0, true, 150.0),
        h("turnlock-eyelet", "Turn lock (eyelet)", "Closures", "The plate around a cut-out window, on the flap.", 30.0, "window", 8.0, true, 150.0),
        h("sam-browne", "Sam Browne stud", "Closures", "Button stud through a keyhole slot.", 10.0, "head", 4.0, true, 120.0),
        h("grommet-10", "Grommet 10 mm", "Eyelets", "For drawstrings and lacing; hole equals the inner size.", 10.0, "inner", 2.0, false, 0.0),
        h("eyelet-5", "Eyelet 5 mm", "Eyelets", "Small eyelet for laces and cords.", 5.0, "inner", 0.5, false, 0.0),
        h("bag-foot", "Bag foot", "Bag", "Domed foot under a bag base; two prongs or a screw.", 12.0, "dome", 2.5, false, 0.0),
        h("d-ring", "D-ring", "Strap hardware", "Holds a strap end; sewn or riveted in a tab.", 25.0, "inner width", 6.0, false, 0.0),
        h("o-ring", "O-ring", "Strap hardware", "Round ring for straps and clasps.", 25.0, "inner", 6.0, false, 0.0),
        h("square-ring", "Square ring", "Strap hardware", "Square or rectangular loop.", 25.0, "inner width", 7.0, false, 0.0),
        h("buckle", "Buckle", "Strap hardware", "Heel-bar buckle; adds the tongue slot.", 25.0, "strap width", 22.0, false, 0.0),
        h("swivel-clasp", "Swivel clasp", "Strap hardware", "Trigger snap hook for detachable straps.", 25.0, "strap width", 15.0, false, 0.0),
        h("key-ring", "Key ring", "Strap hardware", "Split ring for key fobs.", 25.0, "diameter", 4.0, false, 0.0),
        h("zipper", "Zipper #5", "Zippers", "Zip window: a slot the zip sits in. Size is the opening length.", 180.0, "opening", 0.11, false, 0.0),
        h("plaque", "Name plate", "Decoration", "Metal plate with two screw posts.", 40.0, "width", 8.0, false, 0.0),
        h("concho", "Concho", "Decoration", "Decorative disc on a screw post, often with lacing.", 25.0, "diameter", 9.0, false, 0.0),
    ]
}

pub fn hardware_info(id: &str) -> Option<HardwareInfo> {
    hardware().into_iter().find(|h| h.id == id)
}

/// Holes a placed piece of hardware needs, in piece coordinates (design, before folds).
pub fn hardware_holes(hw: &HardwarePlacement) -> Vec<Hole> {
    let Some(info) = hardware_info(&hw.kind) else { return vec![] };
    let s = if hw.size_mm > 0.0 { hw.size_mm } else { info.default_size_mm };
    let (c, sn) = (hw.angle_deg.to_radians().cos(), hw.angle_deg.to_radians().sin());
    let at = |d: Vec2| hw.at + v(d.x * c - d.y * sn, d.x * sn + d.y * c);
    let label = if hw.label.is_empty() { info.name.to_string() } else { hw.label.clone() };
    let mut k = 0;
    let mut out = Vec::new();
    let mut hole = |d: Vec2, dia: f64, len: f64, ang: f64, out: &mut Vec<Hole>| {
        out.push(Hole { id: format!("{}#{k}", hw.id), center: at(d), diameter_mm: dia, label: if k == 0 { label.clone() } else { String::new() }, length_mm: len, angle_deg: hw.angle_deg + ang });
        k += 1;
    };
    match hw.kind.as_str() {
        "rivet-s" => hole(v(0.0, 0.0), 2.5, 0.0, 0.0, &mut out),
        "rivet-m" => hole(v(0.0, 0.0), 3.0, 0.0, 0.0, &mut out),
        "rivet-l" => hole(v(0.0, 0.0), 3.5, 0.0, 0.0, &mut out),
        "copper-rivet" => hole(v(0.0, 0.0), 3.0, 0.0, 0.0, &mut out),
        "chicago-screw" => hole(v(0.0, 0.0), 4.5, 0.0, 0.0, &mut out),
        "snap-24" => hole(v(0.0, 0.0), 4.0, 0.0, 0.0, &mut out),
        "snap-20" => hole(v(0.0, 0.0), 3.5, 0.0, 0.0, &mut out),
        "magnet-18" => {
            for x in [-s * 0.39, s * 0.39] {
                hole(v(x, 0.0), 1.2, 6.0, 90.0, &mut out);
            }
        }
        "turnlock-catch" => {
            for x in [-s * 0.4, s * 0.4] {
                hole(v(x, 0.0), 1.2, 5.0, 90.0, &mut out);
            }
        }
        "turnlock-eyelet" => hole(v(0.0, 0.0), s * 0.4, s * 0.9, 0.0, &mut out),
        "sam-browne" => {
            hole(v(0.0, 0.0), s * 0.75, 0.0, 0.0, &mut out);
            hole(v(0.0, s * 0.85), 2.0, s * 0.9, 90.0, &mut out);
        }
        "grommet-10" | "eyelet-5" => hole(v(0.0, 0.0), s, 0.0, 0.0, &mut out),
        "bag-foot" => hole(v(0.0, 0.0), 3.0, 0.0, 0.0, &mut out),
        "buckle" => hole(v(0.0, 0.0), 4.0, (s * 0.7).max(12.0), 0.0, &mut out),
        "zipper" => hole(v(0.0, 0.0), 8.0, s + 8.0, 0.0, &mut out),
        "plaque" => {
            for x in [-(s / 2.0 - 5.0), s / 2.0 - 5.0] {
                hole(v(x, 0.0), 2.5, 0.0, 0.0, &mut out);
            }
        }
        "concho" => {
            hole(v(0.0, 0.0), 3.5, 0.0, 0.0, &mut out);
            for x in [-s * 0.25, s * 0.25] {
                hole(v(x, s * 0.6), 1.2, 4.0, 90.0, &mut out);
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_is_complete() {
        use StitchKind::*;
        for k in [Saddle, Lockstitch, Running, Backstitch, Cross, Baseball, Whip, Blanket, LaceWhip, LaceSingleLoop, LaceDoubleLoop, LaceCross] {
            let s = stitch_info(k);
            assert!(s.thread_factor > 1.0 && s.strands > 0.0);
        }
        assert_eq!(constructions().len(), 8);
        assert!(thread(Some("lace-kanga-3"), true).lace);
        // Asking for a thread on a laced seam falls back to lace.
        assert!(thread(Some("poly-0.6"), true).lace);
    }

    #[test]
    fn hardware_makes_its_holes() {
        let mut hw = HardwarePlacement { id: "m".into(), kind: "magnet-18".into(), at: v(50.0, 20.0), angle_deg: 0.0, size_mm: 0.0, label: String::new() };
        let holes = hardware_holes(&hw);
        assert_eq!(holes.len(), 2);
        assert!((holes[0].center.x - (50.0 - 18.0 * 0.39)).abs() < 1e-9);
        assert_eq!(holes[0].label, "Magnetic snap 18 mm");
        hw.kind = "zipper".into();
        hw.size_mm = 150.0;
        let z = hardware_holes(&hw);
        assert!((z[0].length_mm - 158.0).abs() < 1e-9);
        for h in hardware() {
            hw.kind = h.id.into();
            hw.size_mm = 0.0;
            let holes = hardware_holes(&hw);
            assert!(!holes.is_empty() || matches!(h.id, "d-ring" | "o-ring" | "square-ring" | "swivel-clasp" | "key-ring"), "{}", h.id);
        }
    }
}
