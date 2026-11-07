//! Hidework core: the pattern model, geometry, and printable template export.
//!
//! All lengths are millimetres. Piece coordinates are local to the piece; `Piece::position`
//! places the piece on the template sheet. The y axis points down (screen convention).

pub mod compute;
pub mod geom;
pub mod model;
pub mod pdf;
pub mod sheet;
pub mod svg;
pub mod templates;

pub use compute::{compute, ComputedProject};
pub use model::Project;
