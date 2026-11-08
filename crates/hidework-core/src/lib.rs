//! Hidework core: the pattern model, geometry, and printable template export.
//!
//! All lengths are millimetres. Piece coordinates are local to the piece; `Piece::position`
//! places the piece on the template sheet. The y axis points down (screen convention); in 3D, z is up.

pub mod arrange;
pub mod bags;
pub mod library;
pub mod banded;
pub mod bend;
pub mod bandsolve;
pub mod bom;
pub mod check;
pub mod compute;
pub mod contact;
pub mod costing;
pub mod craft;
pub mod hide;
pub mod nest;
pub mod generators;
pub mod import;
pub mod drape;
pub mod fab;
pub mod geom;
pub mod mesh;
pub mod model;
pub mod pdf;
pub mod physics;
pub mod print;
pub mod sheet;
pub mod sim;
pub mod svg;
pub mod templates;
pub mod tooling;
pub mod trace;

pub use compute::{compute, ComputedProject};
pub use model::Project;
