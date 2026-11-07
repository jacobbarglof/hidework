//! Hidework core: the pattern model, geometry, and printable template export.
//!
//! All lengths are millimetres. Piece coordinates are local to the piece; `Piece::position`
//! places the piece on the template sheet. The y axis points down (screen convention).

pub mod banded;
pub mod bend;
pub mod bom;
pub mod compute;
pub mod generators;
pub mod drape;
pub mod fab;
pub mod geom;
pub mod mesh;
pub mod model;
pub mod pdf;
pub mod physics;
pub mod sheet;
pub mod sim;
pub mod svg;
pub mod templates;

pub use compute::{compute, ComputedProject};
pub use model::Project;
