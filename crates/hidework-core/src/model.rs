//! The project file model. Serialized as camelCase JSON (`.hidework` files).

use crate::geom::Vec2;
use serde::{Deserialize, Serialize};

/// One leather "ounce" of thickness is 1/64 inch.
pub const OZ_MM: f64 = 25.4 / 64.0;
pub const FORMAT: &str = "hidework-project";
pub const VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub units: Units,
    pub materials: Vec<Material>,
    pub pieces: Vec<Piece>,
    #[serde(default)]
    pub joins: Vec<Join>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Units {
    Mm,
    In,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub id: String,
    pub name: String,
    pub kind: MaterialKind,
    pub thickness_mm: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaterialKind {
    Leather,
    WaxedCanvas,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub id: String,
    pub name: String,
    pub material_id: String,
    /// Where the piece's local origin sits on the template sheet.
    pub position: Vec2,
    /// Finished outline, as designed (before fold compensation). Edge `i` runs from vertex `i`
    /// to vertex `i + 1` (wrapping).
    pub vertices: Vec<Vec2>,
    pub edges: Vec<Edge>,
    #[serde(default = "one")]
    pub cut_count: u32,
    /// Extra material outside the finished line (0 for edge-to-edge leather construction).
    #[serde(default)]
    pub seam_allowance_mm: f64,
    pub stitch: StitchSettings,
    #[serde(default)]
    pub folds: Vec<Fold>,
    #[serde(default)]
    pub holes: Vec<Hole>,
    /// Direction of the hide's spine or the canvas warp, in degrees (0 = along +x).
    #[serde(default)]
    pub grain_deg: f64,
}

fn one() -> u32 {
    1
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    #[serde(flatten)]
    pub kind: EdgeKind,
    #[serde(default)]
    pub stitched: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EdgeKind {
    Line,
    /// Cubic Bezier with absolute control points in piece coordinates.
    Cubic { c1: Vec2, c2: Vec2 },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchSettings {
    /// Distance from the finished edge to the stitch line.
    pub margin_mm: f64,
    /// Pricking iron spacing (hole to hole).
    pub pitch_mm: f64,
    /// Diameter of the printed hole mark.
    pub hole_mm: f64,
}

impl Default for StitchSettings {
    fn default() -> Self {
        StitchSettings { margin_mm: 3.0, pitch_mm: 3.85, hole_mm: 1.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    /// A fold line along x (y = position).
    Horizontal,
    /// A fold line along y (x = position).
    Vertical,
}

/// A 180 degree fold. The pattern gains `pi * (contents + thickness) / 2` across the fold so the
/// outer layer wraps around whatever sits inside it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fold {
    pub id: String,
    pub orientation: Orientation,
    /// y for a horizontal fold, x for a vertical fold, in design (uncompensated) coordinates.
    pub position: f64,
    /// Thickness of everything between the two folded halves when closed (inner layers, cards).
    #[serde(default)]
    pub contents_mm: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hole {
    pub id: String,
    pub center: Vec2,
    pub diameter_mm: f64,
    #[serde(default)]
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Join {
    pub id: String,
    pub a: EdgeRef,
    pub b: EdgeRef,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRef {
    pub piece_id: String,
    pub edges: Vec<usize>,
}

impl Project {
    pub fn material(&self, id: &str) -> Option<&Material> {
        self.materials.iter().find(|m| m.id == id)
    }
    pub fn piece(&self, id: &str) -> Option<&Piece> {
        self.pieces.iter().find(|p| p.id == id)
    }
}

pub fn fold_allowance_mm(contents_mm: f64, thickness_mm: f64) -> f64 {
    std::f64::consts::PI * (contents_mm.max(0.0) + thickness_mm.max(0.0)) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ounces_and_fold_allowance() {
        assert!((3.0 * OZ_MM - 1.190625).abs() < 1e-9);
        // Folding 1.2 mm leather around 4 mm of cards needs about 8.2 mm extra.
        let a = fold_allowance_mm(4.0, 1.2);
        assert!((a - 8.168).abs() < 0.01, "{a}");
    }

    #[test]
    fn edge_json_shape() {
        let e: Edge = serde_json::from_str(r#"{"type":"cubic","c1":{"x":1,"y":2},"c2":{"x":3,"y":4},"stitched":true}"#).unwrap();
        assert!(e.stitched);
        assert!(matches!(e.kind, EdgeKind::Cubic { .. }));
        let s = serde_json::to_string(&Edge { kind: EdgeKind::Line, stitched: false }).unwrap();
        assert_eq!(s, r#"{"type":"line","stitched":false}"#);
    }
}
