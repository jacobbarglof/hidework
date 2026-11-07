//! Starter projects.

use crate::geom::{v, Vec2};
use crate::model::*;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

pub fn list() -> Vec<TemplateInfo> {
    vec![
        TemplateInfo { id: "blank", name: "Blank project", description: "An empty sheet with one leather." },
        TemplateInfo {
            id: "card-wallet",
            name: "Fold-over card wallet",
            description: "One piece folded at the bottom to make a pocket, stitched up both sides.",
        },
        TemplateInfo { id: "belt", name: "Belt", description: "38 mm belt with a folded buckle end, tongue slot, rivets and five holes." },
        TemplateInfo {
            id: "journal-cover",
            name: "A5 journal cover",
            description: "One piece with two inside flaps that hold the notebook's covers.",
        },
    ]
}

pub fn by_id(id: &str) -> Option<Project> {
    match id {
        "blank" => Some(blank()),
        "card-wallet" => Some(card_wallet()),
        "belt" => Some(belt()),
        "journal-cover" => Some(journal_cover()),
        _ => None,
    }
}

fn base(name: &str) -> Project {
    Project {
        format: FORMAT.into(),
        version: VERSION,
        name: name.into(),
        units: Units::Mm,
        materials: vec![Material {
            id: "m1".into(),
            name: "Veg-tan goatskin".into(),
            kind: MaterialKind::Leather,
            thickness_mm: 3.0 * OZ_MM,
            physics: crate::physics::presets().into_iter().find(|p| p.id == "goat-veg").map(|p| p.physics),
            cost_per_sqft: None,
            color: None,
        }],
        pieces: vec![],
        joins: vec![],
        thread_color: None,
    }
}

pub fn blank() -> Project {
    base("Untitled pattern")
}

/// Quarter-circle corner as a cubic from `a` to `b` bulging toward `corner`.
fn corner(a: Vec2, corner: Vec2, b: Vec2) -> EdgeKind {
    const K: f64 = 0.552_284_75;
    EdgeKind::Cubic { c1: a + (corner - a) * K, c2: b + (corner - b) * K }
}

/// A 100 mm wide wallet: the 60 mm front folds up over the 75 mm back around about 4 mm of cards.
/// Stitching runs 57 mm up each side on both layers, so the holes line up once folded.
pub fn card_wallet() -> Project {
    let mut p = base("Fold-over card wallet");
    let line = Edge::line;
    let vertices = vec![
        v(0.0, 0.0),     // 0 front top-left
        v(100.0, 0.0),   // 1 front top-right
        v(100.0, 60.0),  // 2 fold, right
        v(100.0, 117.0), // 3 end of back stitching, right
        v(100.0, 130.0), // 4
        v(95.0, 135.0),  // 5
        v(5.0, 135.0),   // 6
        v(0.0, 130.0),   // 7
        v(0.0, 117.0),   // 8 end of back stitching, left
        v(0.0, 60.0),    // 9 fold, left
    ];
    let edges = vec![
        line(false), // 0 pocket mouth
        line(true),  // 1 front right side
        line(true),  // 2 back right side
        line(false),
        Edge::new(corner(v(100.0, 130.0), v(100.0, 135.0), v(95.0, 135.0)), false),
        line(false),
        Edge::new(corner(v(5.0, 135.0), v(0.0, 135.0), v(0.0, 130.0)), false),
        line(false),
        line(true), // 8 back left side
        line(true), // 9 front left side
    ];
    p.pieces.push(Piece {
        id: "body".into(),
        name: "Wallet body".into(),
        material_id: "m1".into(),
        position: v(20.0, 20.0),
        vertices,
        edges,
        cut_count: 1,
        seam_allowance_mm: 0.0,
        stitch: StitchSettings::default(),
        folds: vec![Fold { id: "f1".into(), orientation: Orientation::Horizontal, position: 60.0, contents_mm: 4.0 }],
        holes: vec![],
        grain_deg: 90.0,
        notes: "Burnish the pocket mouth before stitching.".into(),
    });
    let edge = |e: usize| EdgeRef { piece_id: "body".into(), edges: vec![e] };
    p.joins.push(Join { id: "j1".into(), a: edge(1), b: edge(2) });
    p.joins.push(Join { id: "j2".into(), a: edge(9), b: edge(8) });
    p
}

fn preset_material(id: &str, mat_id: &str, oz: f64) -> Material {
    let p = crate::physics::presets().into_iter().find(|p| p.id == id).expect("preset");
    Material {
        id: mat_id.into(),
        name: p.name.into(),
        kind: p.kind,
        thickness_mm: oz * OZ_MM,
        physics: Some(p.physics),
        cost_per_sqft: None,
            color: None,
    }
}

pub fn belt() -> Project {
    let mut p = base("Belt");
    p.materials = vec![preset_material("vegtan-firm", "m1", 9.0)];
    let params = crate::generators::StrapParams { name: "Belt".into(), length_mm: 1100.0, ..Default::default() };
    p.pieces.push(crate::generators::strap(&params, "m1", v(20.0, 20.0), "belt"));
    p
}

/// A5 notebook (148 x 210 mm): two 151 mm panels, a 12 mm spine and 70 mm flaps folded inside
/// around about 1.5 mm of notebook cover. Flap stitching is 67 mm on both layers.
pub fn journal_cover() -> Project {
    let mut p = base("A5 journal cover");
    p.materials = vec![preset_material("vegtan-soft", "m1", 4.0)];
    let (flap, overlap, w, h) = (70.0, 137.0, 454.0, 216.0);
    let vertices = vec![
        v(0.0, 0.0),
        v(flap, 0.0),
        v(overlap, 0.0),
        v(w - overlap, 0.0),
        v(w - flap, 0.0),
        v(w, 0.0),
        v(w, h),
        v(w - flap, h),
        v(w - overlap, h),
        v(overlap, h),
        v(flap, h),
        v(0.0, h),
    ];
    let st = [true, true, false, true, true, false, true, true, false, true, true, false];
    p.pieces.push(Piece {
        id: "cover".into(),
        name: "Journal cover".into(),
        material_id: "m1".into(),
        position: v(20.0, 20.0),
        vertices,
        edges: st.iter().map(|&s| Edge::line(s)).collect(),
        cut_count: 1,
        seam_allowance_mm: 0.0,
        stitch: StitchSettings::default(),
        folds: vec![
            Fold { id: "f1".into(), orientation: Orientation::Vertical, position: flap, contents_mm: 1.5 },
            Fold { id: "f2".into(), orientation: Orientation::Vertical, position: w - flap, contents_mm: 1.5 },
        ],
        holes: vec![],
        grain_deg: 90.0,
        notes: "Fold the flaps inward. Spine runs down the middle.".into(),
    });
    let e = |i: usize| EdgeRef { piece_id: "cover".into(), edges: vec![i] };
    for (k, (a, b)) in [(0, 1), (4, 3), (10, 9), (6, 7)].into_iter().enumerate() {
        p.joins.push(Join { id: format!("j{k}"), a: e(a), b: e(b) });
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{compute, pdf, sheet, svg};

    #[test]
    fn card_wallet_sides_line_up() {
        let p = card_wallet();
        let c = compute(&p);
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
        for j in &c.joins {
            assert!(j.ok, "{}", j.message);
            assert!((j.a_stitch_mm - 57.0).abs() < 1e-6, "{}", j.message);
            assert_eq!(j.a_holes, 16);
        }
        let body = &c.pieces[0];
        let allowance = fold_allowance_mm(4.0, 3.0 * OZ_MM);
        assert!((body.bounds.height() - (135.0 + allowance)).abs() < 1e-6);
        assert_eq!(body.stitch_runs.len(), 4);
    }

    #[test]
    fn card_wallet_exports() {
        let p = card_wallet();
        let c = compute(&p);
        let s = sheet::build_sheet(&p, &c);
        let svg = svg::to_svg(&s);
        assert!(svg.contains("1 in") && svg.contains("Wallet body"));
        let (bytes, pages) = pdf::to_pdf(&s, pdf::PageSize::Letter);
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert_eq!(pages, 1);
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pieces[0].edges.len(), 10);
    }

    #[test]
    fn templates_resolve_and_seams_match() {
        for t in list() {
            let p = by_id(t.id).unwrap();
            let c = compute(&p);
            assert!(c.warnings.is_empty(), "{}: {:?}", t.id, c.warnings);
            for j in &c.joins {
                assert!(j.ok, "{}: {}", t.id, j.message);
            }
            let stl = crate::fab::stl(&p, &crate::fab::FabOptions::default());
            assert!(p.pieces.is_empty() || stl.len() > 84, "{}", t.id);
        }
    }
}
