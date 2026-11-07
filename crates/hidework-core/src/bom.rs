//! Bill of materials: hide area per material with waste, cost, thread and hardware.

use crate::compute::ComputedProject;
use crate::geom::signed_area;
use crate::model::Project;
use serde::Serialize;

pub const MM2_PER_SQFT: f64 = 92_903.04;
/// Saddle stitching uses roughly four times the seam length in thread (common rule of thumb).
pub const THREAD_FACTOR: f64 = 4.0;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialLine {
    pub material_id: String,
    pub name: String,
    pub pieces: u32,
    pub area_cm2: f64,
    pub sqft: f64,
    /// Area to buy once cutting waste is allowed for.
    pub sqft_with_waste: f64,
    pub cost: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceLine {
    pub name: String,
    pub material: String,
    pub cut_count: u32,
    pub area_cm2: f64,
    pub stitch_holes: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareLine {
    pub label: String,
    pub diameter_mm: f64,
    pub slot_mm: f64,
    pub count: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bom {
    pub waste_pct: f64,
    pub materials: Vec<MaterialLine>,
    pub pieces: Vec<PieceLine>,
    pub hardware: Vec<HardwareLine>,
    /// Stitched seam length, counting a joined seam once.
    pub seam_mm: f64,
    pub thread_m: f64,
    pub stitch_holes: usize,
    pub total_cost: Option<f64>,
}

pub fn bom(project: &Project, computed: &ComputedProject, waste_pct: f64) -> Bom {
    let mut materials: Vec<MaterialLine> = Vec::new();
    let mut pieces = Vec::new();
    let mut hardware: Vec<HardwareLine> = Vec::new();
    let mut seam = 0.0;
    let mut holes_total = 0;
    for cp in &computed.pieces {
        let Some(pc) = project.piece(&cp.id) else { continue };
        let n = pc.cut_count.max(1);
        let area = signed_area(&cp.cut).abs() / 100.0;
        let stitch_len: f64 = cp.edges.iter().map(|e| e.stitch_length_mm).sum();
        let hole_count: usize = cp.stitch_runs.iter().map(|r| r.holes.len()).sum();
        seam += stitch_len * n as f64;
        holes_total += hole_count * n as usize;
        let mat = project.material(&pc.material_id);
        let mat_name = mat.map_or("No material".to_string(), |m| m.name.clone());
        pieces.push(PieceLine { name: pc.name.clone(), material: mat_name.clone(), cut_count: n, area_cm2: area, stitch_holes: hole_count });
        match materials.iter_mut().find(|m| m.material_id == pc.material_id) {
            Some(line) => {
                line.pieces += n;
                line.area_cm2 += area * n as f64;
            }
            None => materials.push(MaterialLine {
                material_id: pc.material_id.clone(),
                name: mat_name,
                pieces: n,
                area_cm2: area * n as f64,
                sqft: 0.0,
                sqft_with_waste: 0.0,
                cost: None,
            }),
        }
        for h in &pc.holes {
            let label = if h.label.is_empty() { "Punched hole".to_string() } else { h.label.clone() };
            match hardware.iter_mut().find(|x| x.label == label && (x.diameter_mm - h.diameter_mm).abs() < 1e-6 && (x.slot_mm - h.length_mm).abs() < 1e-6) {
                Some(x) => x.count += n,
                None => hardware.push(HardwareLine { label, diameter_mm: h.diameter_mm, slot_mm: h.length_mm, count: n }),
            }
        }
    }
    // A joined, stitched seam is sewn once even though both sides carry a stitch line.
    for j in &computed.joins {
        if j.a_stitch_mm > 0.0 && j.b_stitch_mm > 0.0 {
            seam -= j.a_stitch_mm.min(j.b_stitch_mm);
        }
    }
    let mut total = None;
    for line in &mut materials {
        line.sqft = line.area_cm2 * 100.0 / MM2_PER_SQFT;
        line.sqft_with_waste = line.sqft * (1.0 + waste_pct.max(0.0) / 100.0);
        if let Some(price) = project.material(&line.material_id).and_then(|m| m.cost_per_sqft) {
            let c = line.sqft_with_waste * price;
            line.cost = Some(c);
            total = Some(total.unwrap_or(0.0) + c);
        }
    }
    Bom {
        waste_pct,
        materials,
        pieces,
        hardware,
        seam_mm: seam.max(0.0),
        thread_m: seam.max(0.0) * THREAD_FACTOR / 1000.0,
        stitch_holes: holes_total,
        total_cost: total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::compute;
    use crate::templates::card_wallet;

    #[test]
    fn wallet_bom() {
        let mut p = card_wallet();
        p.materials[0].cost_per_sqft = Some(10.0);
        let c = compute(&p);
        let b = bom(&p, &c, 25.0);
        assert_eq!(b.materials.len(), 1);
        // The front and back stitch lines are joined, so the seam is 2 x 57 mm.
        assert!((b.seam_mm - 114.0).abs() < 0.5, "{}", b.seam_mm);
        assert_eq!(b.stitch_holes, 64);
        assert!(b.total_cost.unwrap() > 0.0);
    }
}
