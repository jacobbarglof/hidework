//! Material physics: the handful of numbers that decide how a hide or canvas hangs, plus a
//! starter library and calibration from a bench strip test.
//!
//! Bending is what makes leather look like leather. A sheet's flexural rigidity is
//! `D = E t^3 / 12` (E = bending modulus, t = thickness), so doubling thickness makes it eight
//! times stiffer. Its weight per area is `W = rho g t`. The ratio sets the *bending length*
//! `c = (D / W)^(1/3)`, the classic measure from the cantilever test (ASTM D1388): a strip pushed
//! off a table edge droops to 41.5 degrees when the overhang is `2c`.

use crate::model::{Material, MaterialKind, OZ_MM};
use serde::{Deserialize, Serialize};

pub const G: f64 = 9.81;
/// One ounce per square yard in grams per square metre (canvas weights).
pub const OZ_YD2_GSM: f64 = 33.906;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Physics {
    pub density_kg_m3: f64,
    /// Effective modulus for bending, in megapascals.
    pub bending_modulus_mpa: f64,
    /// Modulus for stretching in the plane, in megapascals.
    pub tensile_modulus_mpa: f64,
    /// Bending stiffness across the grain (spine or warp) divided by along it.
    #[serde(default = "one")]
    pub anisotropy: f64,
    /// Stretch stiffness on the bias (45 degrees) relative to straight grain. Woven canvas is
    /// much softer on the bias; leather is close to 1.
    #[serde(default = "one")]
    pub bias_stiffness: f64,
    #[serde(default = "friction")]
    pub friction: f64,
    /// Tensile strength (MPa) for load checks. Rough starting estimate unless measured.
    #[serde(default = "strength")]
    pub tensile_strength_mpa: f64,
}

fn strength() -> f64 {
    20.0
}

fn one() -> f64 {
    1.0
}
fn friction() -> f64 {
    0.6
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: MaterialKind,
    pub typical_oz: &'static str,
    pub thickness_mm: f64,
    pub physics: Physics,
    pub note: &'static str,
}

const fn ph(density: f64, bend: f64, tensile: f64, aniso: f64, bias: f64, mu: f64) -> Physics {
    Physics {
        density_kg_m3: density,
        bending_modulus_mpa: bend,
        tensile_modulus_mpa: tensile,
        anisotropy: aniso,
        bias_stiffness: bias,
        friction: mu,
        tensile_strength_mpa: 20.0,
    }
}

const fn strong(p: Physics, mpa: f64) -> Physics {
    Physics { tensile_strength_mpa: mpa, ..p }
}

/// Starting estimates, not lab data: hides vary a lot by tannery, temper and cut. Calibrate with
/// a strip test for anything that matters.
pub fn presets() -> Vec<Preset> {
    use MaterialKind::*;
    vec![
        Preset { id: "vegtan-firm", name: "Veg-tan cowhide, firm", kind: Leather, typical_oz: "4-10 oz", thickness_mm: 6.0 * OZ_MM, physics: strong(ph(950.0, 45.0, 120.0, 0.8, 0.9, 0.7), 25.0), note: "Tooling and holster leather; holds a molded shape." },
        Preset { id: "vegtan-soft", name: "Veg-tan cowhide, soft temper", kind: Leather, typical_oz: "3-6 oz", thickness_mm: 4.0 * OZ_MM, physics: strong(ph(900.0, 20.0, 80.0, 0.8, 0.9, 0.7), 22.0), note: "Bags and wallets that should flex." },
        Preset { id: "chrome-cow", name: "Chrome-tan cowhide", kind: Leather, typical_oz: "2-5 oz", thickness_mm: 3.0 * OZ_MM, physics: strong(ph(850.0, 8.0, 40.0, 0.85, 0.9, 0.6), 18.0), note: "Soft upholstery and bag leather." },
        Preset { id: "pullup", name: "Oil-tan pull-up cowhide", kind: Leather, typical_oz: "4-6 oz", thickness_mm: 5.0 * OZ_MM, physics: ph(900.0, 15.0, 60.0, 0.85, 0.9, 0.5), note: "Waxy, oiled finish; firm but pliable." },
        Preset { id: "goat-veg", name: "Veg-tan goatskin", kind: Leather, typical_oz: "2-3 oz", thickness_mm: 2.5 * OZ_MM, physics: ph(850.0, 30.0, 90.0, 0.9, 0.9, 0.6), note: "Thin and strong; wallet interiors and linings." },
        Preset { id: "goat-chrome", name: "Chrome-tan goatskin (kid)", kind: Leather, typical_oz: "1.5-3 oz", thickness_mm: 2.0 * OZ_MM, physics: strong(ph(800.0, 6.0, 45.0, 0.9, 0.9, 0.6), 18.0), note: "Soft and fine-grained; gloves, small goods." },
        Preset { id: "deer", name: "Deerskin", kind: Leather, typical_oz: "2-4 oz", thickness_mm: 3.0 * OZ_MM, physics: strong(ph(650.0, 2.5, 15.0, 0.9, 0.85, 0.7), 12.0), note: "Very soft and stretchy; drapes like heavy cloth." },
        Preset { id: "lamb", name: "Lambskin", kind: Leather, typical_oz: "1-2 oz", thickness_mm: 1.5 * OZ_MM, physics: strong(ph(600.0, 2.0, 12.0, 0.9, 0.85, 0.6), 9.0), note: "Buttery and light; linings and garments." },
        Preset { id: "cordovan", name: "Horse shell (cordovan type)", kind: Leather, typical_oz: "4-5 oz", thickness_mm: 4.5 * OZ_MM, physics: ph(1050.0, 60.0, 150.0, 0.9, 0.95, 0.5), note: "Dense, very firm, glassy finish." },
        Preset { id: "waxed-canvas", name: "Waxed cotton canvas", kind: WaxedCanvas, typical_oz: "10-18 oz/yd²", thickness_mm: 0.8, physics: ph(750.0, 25.0, 150.0, 1.0, 0.25, 0.8), note: "Stiff, creases and holds folds; soft on the bias." },
        Preset { id: "duck-canvas", name: "Cotton duck canvas (unwaxed)", kind: WaxedCanvas, typical_oz: "10-18 oz/yd²", thickness_mm: 0.7, physics: strong(ph(650.0, 10.0, 120.0, 1.0, 0.2, 0.7), 25.0), note: "Softer than waxed; still firm for a fabric." },
    ]
}

pub fn default_physics(kind: MaterialKind) -> Physics {
    match kind {
        MaterialKind::Leather => ph(900.0, 20.0, 80.0, 0.85, 0.9, 0.6),
        MaterialKind::WaxedCanvas => ph(750.0, 25.0, 150.0, 1.0, 0.25, 0.8),
        MaterialKind::Other => ph(800.0, 10.0, 60.0, 1.0, 0.8, 0.6),
    }
}

pub fn physics_of(m: &Material) -> Physics {
    m.physics.unwrap_or_else(|| default_physics(m.kind))
}

/// Flexural rigidity `E t^3 / 12` in newton metres.
pub fn flexural_rigidity(p: &Physics, thickness_mm: f64) -> f64 {
    let t = thickness_mm / 1000.0;
    p.bending_modulus_mpa * 1e6 * t * t * t / 12.0
}

/// Weight per area in newtons per square metre.
pub fn areal_weight(p: &Physics, thickness_mm: f64) -> f64 {
    p.density_kg_m3 * G * thickness_mm / 1000.0
}

/// Bending length `(D / W)^(1/3)` in millimetres.
pub fn bending_length_mm(p: &Physics, thickness_mm: f64) -> f64 {
    (flexural_rigidity(p, thickness_mm) / areal_weight(p, thickness_mm)).cbrt() * 1000.0
}

/// From a cantilever strip test: the overhang (mm) at which the strip's tip touches a 41.5 degree
/// line from the table edge. Returns the bending modulus in MPa that reproduces it.
pub fn bending_modulus_from_overhang(thickness_mm: f64, density_kg_m3: f64, overhang_mm: f64) -> f64 {
    let c = overhang_mm / 2000.0;
    let t = thickness_mm / 1000.0;
    let w = density_kg_m3 * G * t;
    12.0 * w * c * c * c / (t * t * t) / 1e6
}

/// Density from a fabric weight in ounces per square yard and its thickness.
pub fn density_from_oz_yd2(oz_yd2: f64, thickness_mm: f64) -> f64 {
    oz_yd2 * OZ_YD2_GSM / 1000.0 / (thickness_mm / 1000.0)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialStats {
    pub id: String,
    pub physics: Physics,
    pub bending_length_mm: f64,
    /// Micro newton metres, the unit textile labs report.
    pub flexural_rigidity_unm: f64,
    pub grams_per_m2: f64,
    pub oz_per_yd2: f64,
}

pub fn stats(m: &Material) -> MaterialStats {
    let p = physics_of(m);
    let gsm = p.density_kg_m3 * m.thickness_mm;
    MaterialStats {
        id: m.id.clone(),
        physics: p,
        bending_length_mm: bending_length_mm(&p, m.thickness_mm),
        flexural_rigidity_unm: flexural_rigidity(&p, m.thickness_mm) * 1e6,
        grams_per_m2: gsm,
        oz_per_yd2: gsm / OZ_YD2_GSM,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thickness_scaling() {
        let p = presets().into_iter().find(|p| p.id == "vegtan-firm").unwrap().physics;
        let d3 = flexural_rigidity(&p, 3.0 * OZ_MM);
        let d7 = flexural_rigidity(&p, 7.0 * OZ_MM);
        assert!((d7 / d3 - (7.0f64 / 3.0).powi(3)).abs() < 1e-9);
        // Bending length grows with thickness^(2/3).
        let c3 = bending_length_mm(&p, 3.0 * OZ_MM);
        let c7 = bending_length_mm(&p, 7.0 * OZ_MM);
        assert!((c7 / c3 - (7.0f64 / 3.0).powf(2.0 / 3.0)).abs() < 1e-9);
    }

    #[test]
    fn deerskin_drapes_more_than_vegtan() {
        let all = presets();
        let get = |id: &str| all.iter().find(|p| p.id == id).unwrap().physics;
        let t = 3.0 * OZ_MM;
        assert!(bending_length_mm(&get("deer"), t) * 1.8 < bending_length_mm(&get("vegtan-firm"), t));
    }

    #[test]
    fn calibration_round_trips() {
        let p = ph(900.0, 33.0, 80.0, 1.0, 1.0, 0.6);
        let t = 1.6;
        let overhang = 2.0 * bending_length_mm(&p, t);
        let e = bending_modulus_from_overhang(t, 900.0, overhang);
        assert!((e - 33.0).abs() < 1e-6, "{e}");
    }
}
