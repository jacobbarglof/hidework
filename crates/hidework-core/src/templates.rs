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
    ]
}

pub fn by_id(id: &str) -> Option<Project> {
    match id {
        "blank" => Some(blank()),
        "card-wallet" => Some(card_wallet()),
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
        }],
        pieces: vec![],
        joins: vec![],
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
    let line = |stitched| Edge { kind: EdgeKind::Line, stitched };
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
        Edge { kind: corner(v(100.0, 130.0), v(100.0, 135.0), v(95.0, 135.0)), stitched: false },
        line(false),
        Edge { kind: corner(v(5.0, 135.0), v(0.0, 135.0), v(0.0, 130.0)), stitched: false },
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
    });
    let edge = |e: usize| EdgeRef { piece_id: "body".into(), edges: vec![e] };
    p.joins.push(Join { id: "j1".into(), a: edge(1), b: edge(2) });
    p.joins.push(Join { id: "j2".into(), a: edge(9), b: edge(8) });
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
    fn templates_resolve() {
        for t in list() {
            assert!(by_id(t.id).is_some());
        }
    }
}
