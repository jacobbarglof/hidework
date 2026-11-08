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
    /// Thread colour for the 3D preview (CSS colour).
    #[serde(default)]
    pub thread_color: Option<String>,
    /// Thread or lace from the catalogue (`craft::threads`); none means 0.6 mm polyester.
    #[serde(default)]
    pub thread: Option<String>,
    /// The body the pieces are arranged around in 3D (like CLO's avatar): a bag's outside size.
    #[serde(default)]
    pub form: Option<Form>,
    /// Pieces glued face to face (linings, stiffeners, doubled straps).
    #[serde(default)]
    pub laminates: Vec<Laminate>,
}

/// The shape pieces are arranged on in 3D: width (x), depth (y) and height (z), millimetres.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Form {
    pub width_mm: f64,
    pub depth_mm: f64,
    pub height_mm: f64,
    /// Rounded (oval) plan instead of a box, for bucket bags and cases.
    #[serde(default)]
    pub round: bool,
    /// Corner radius of a box form seen from the front (rounded bag bottoms).
    #[serde(default)]
    pub corner_mm: f64,
}

impl Default for Form {
    fn default() -> Self {
        Form { width_mm: 300.0, depth_mm: 100.0, height_mm: 320.0, round: false, corner_mm: 0.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Face {
    /// Laid out flat as on the template sheet.
    #[default]
    Flat,
    Front,
    Back,
    Left,
    Right,
    Bottom,
    Top,
    /// Down the left side, across the bottom, up the right side (a gusset). Follows the piece's x.
    WrapSides,
    /// Right round the form (a tube or bucket body). Follows the piece's x.
    WrapAround,
    /// Up the back, over the top and down the front (a back panel with a flap). Follows the piece's y.
    BackFlap,
    /// A handle arching over the top with both ends on the front (or back). Follows the piece's x.
    HandleFront,
    HandleBack,
    /// A shoulder strap from one side over the top to the other. Follows the piece's x.
    StrapSides,
}

/// Where a piece sits in 3D before simulating (CLO's arrangement points).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Place {
    pub face: Face,
    /// Shift along the face (x across, y down), millimetres.
    pub offset: Vec2,
    /// Distance outside the form's surface (negative is inside, for linings).
    pub layer_mm: f64,
    /// Handles and straps: distance between the two attachment points (0 = automatic).
    pub span_mm: f64,
    /// Handles and straps: length of each end lying flat on the panel (0 = 40 mm).
    pub tab_mm: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Laminate {
    pub id: String,
    pub a: String,
    pub b: String,
    #[serde(default)]
    pub glue: Adhesive,
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
    /// Physical properties for simulation; none means the defaults for its kind.
    #[serde(default)]
    pub physics: Option<crate::physics::Physics>,
    /// Price per square foot, for costing.
    #[serde(default)]
    pub cost_per_sqft: Option<f64>,
    /// Surface colour for the 3D preview (CSS colour).
    #[serde(default)]
    pub color: Option<String>,
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
    /// Free text printed on the template (edge finish, assembly order...).
    #[serde(default)]
    pub notes: String,
    /// Hardware set into this piece; each adds the holes it needs.
    #[serde(default)]
    pub hardware: Vec<HardwarePlacement>,
    /// Decoration and surface work: stamps, tooling, embossing, engraving, paint, perforation.
    #[serde(default)]
    pub marks: Vec<Mark>,
    /// Where the piece starts in 3D.
    #[serde(default)]
    pub place: Option<Place>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwarePlacement {
    pub id: String,
    /// Catalogue id (`craft::hardware`).
    pub kind: String,
    pub at: Vec2,
    #[serde(default)]
    pub angle_deg: f64,
    /// Cap, ring width or zipper length; 0 means the catalogue default.
    #[serde(default)]
    pub size_mm: f64,
    #[serde(default)]
    pub label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkKind {
    /// A maker's mark or stamp struck into damp veg-tan.
    #[default]
    Stamp,
    /// Carved and tooled area (pattern: floral, geometric, basketweave, border).
    Tooling,
    /// Raised from behind or pressed with a plate.
    Emboss,
    /// Laser or hand engraving.
    Engrave,
    /// Dyed or painted area (pattern: CSS colour).
    Paint,
    /// Lettering.
    Text,
    /// A grid of punched holes filling the area (pattern: spacing in mm).
    Perforate,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub id: String,
    #[serde(default)]
    pub kind: MarkKind,
    pub center: Vec2,
    /// Width and height of the area.
    pub size: Vec2,
    #[serde(default)]
    pub angle_deg: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub pattern: String,
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
    /// Width of a skive zone along this edge (0 = none).
    #[serde(default)]
    pub skive_mm: f64,
    #[serde(default)]
    pub finish: EdgeFinish,
    /// Turn allowance for a turned (folded) edge; 0 means the default.
    #[serde(default)]
    pub turn_mm: f64,
    /// A decorative crease line along the edge.
    #[serde(default)]
    pub crease: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeFinish {
    #[default]
    Raw,
    Burnished,
    Painted,
    Turned,
    Bound,
}

impl Edge {
    pub fn new(kind: EdgeKind, stitched: bool) -> Edge {
        Edge { kind, stitched, skive_mm: 0.0, finish: EdgeFinish::Raw, turn_mm: 0.0, crease: false }
    }
    /// Extra material this edge adds outside the finished line (turned edges).
    pub fn turn_allowance(&self) -> f64 {
        match self.finish {
            EdgeFinish::Turned if self.turn_mm > 0.0 => self.turn_mm,
            EdgeFinish::Turned => crate::craft::TURN_MM,
            _ => 0.0,
        }
    }
    pub fn line(stitched: bool) -> Edge {
        Edge::new(EdgeKind::Line, stitched)
    }
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
    /// Diameter of the printed hole mark (for lacing: the slit length, which is the lace width).
    pub hole_mm: f64,
    #[serde(default)]
    pub kind: StitchKind,
    /// Rows of stitching (2 = a double row).
    #[serde(default = "one")]
    pub rows: u32,
    /// Distance between rows (0 = 4 mm).
    #[serde(default)]
    pub row_gap_mm: f64,
}

impl Default for StitchSettings {
    fn default() -> Self {
        StitchSettings { margin_mm: 3.0, pitch_mm: 3.85, hole_mm: 1.0, kind: StitchKind::Saddle, rows: 1, row_gap_mm: 0.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StitchKind {
    #[default]
    Saddle,
    Lockstitch,
    Running,
    Backstitch,
    Cross,
    Baseball,
    Whip,
    Blanket,
    LaceWhip,
    LaceSingleLoop,
    LaceDoubleLoop,
    LaceCross,
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
    /// Overall length of an oblong slot (buckle tongue, strap slot); 0 or less than the diameter
    /// means a round hole.
    #[serde(default)]
    pub length_mm: f64,
    /// Slot direction in degrees (0 = along +x).
    #[serde(default)]
    pub angle_deg: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Join {
    pub id: String,
    pub a: EdgeRef,
    /// The other side. With no edges, `a` is sewn onto the face of that piece (patch pockets,
    /// tabs, appliques).
    pub b: EdgeRef,
    #[serde(default)]
    pub construction: Construction,
    #[serde(default)]
    pub glue: Adhesive,
    /// Width of the glued band along the edge; 0 means twice the stitch margin.
    #[serde(default)]
    pub glue_width_mm: f64,
    /// Welt, piping or binding: its material (thickness).
    #[serde(default)]
    pub insert_material_id: Option<String>,
    /// Welt or binding width, or piping cord diameter (0 = automatic).
    #[serde(default)]
    pub insert_mm: f64,
}

impl Join {
    pub fn new(id: &str, a: EdgeRef, b: EdgeRef) -> Join {
        Join { id: id.into(), a, b, construction: Construction::EdgeToEdge, glue: Adhesive::None, glue_width_mm: 0.0, insert_material_id: None, insert_mm: 0.0 }
    }
    pub fn onto_face(&self) -> bool {
        self.b.edges.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Construction {
    #[default]
    EdgeToEdge,
    Turned,
    Lapped,
    Butt,
    Welted,
    Piped,
    Bound,
    Zipper,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Adhesive {
    #[default]
    None,
    ContactCement,
    WaterContact,
    Pva,
    Tape,
}

impl EdgeRef {
    pub fn new(piece_id: &str, edges: &[usize]) -> EdgeRef {
        EdgeRef { piece_id: piece_id.into(), edges: edges.to_vec() }
    }
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
        let s = serde_json::to_string(&Edge::line(false)).unwrap();
        assert_eq!(s, r#"{"type":"line","stitched":false,"skiveMm":0.0,"finish":"raw","turnMm":0.0,"crease":false}"#);
        // Files from before the craft catalogue still load.
        let j: Join = serde_json::from_str(r#"{"id":"j","a":{"pieceId":"a","edges":[0]},"b":{"pieceId":"b","edges":[1]}}"#).unwrap();
        assert_eq!(j.construction, Construction::EdgeToEdge);
        let st: StitchSettings = serde_json::from_str(r#"{"marginMm":3,"pitchMm":3.85,"holeMm":1}"#).unwrap();
        assert_eq!((st.kind, st.rows), (StitchKind::Saddle, 1));
    }
}
