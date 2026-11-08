//! Bill of materials: hide area per material with waste, cost, thread or lace by stitch type,
//! glue, and hardware.

use crate::compute::ComputedProject;
use crate::craft;
use crate::geom::signed_area;
use crate::model::{Adhesive, Project};
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
    /// Catalogue id for set hardware (empty for plain punched holes).
    pub kind: String,
    pub grams: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLine {
    pub name: String,
    pub stitch: String,
    pub seam_mm: f64,
    pub length_m: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlueLine {
    pub name: String,
    pub area_cm2: f64,
    pub grams: f64,
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
    /// Thread and lace together.
    pub thread_m: f64,
    pub threads: Vec<ThreadLine>,
    pub glue: Vec<GlueLine>,
    pub stitch_holes: usize,
    pub total_cost: Option<f64>,
}

fn add_glue(glue: &mut Vec<GlueLine>, a: Adhesive, area_cm2: f64) {
    let info = craft::adhesive_info(a);
    let grams = area_cm2 * 1e-4 * info.grams_per_m2;
    match glue.iter_mut().find(|g| g.name == info.name) {
        Some(g) => {
            g.area_cm2 += area_cm2;
            g.grams += grams;
        }
        None => glue.push(GlueLine { name: info.name.into(), area_cm2, grams }),
    }
}

pub fn bom(project: &Project, computed: &ComputedProject, waste_pct: f64) -> Bom {
    let mut materials: Vec<MaterialLine> = Vec::new();
    let mut pieces = Vec::new();
    let mut hardware: Vec<HardwareLine> = Vec::new();
    let mut seam = 0.0;
    let mut holes_total = 0;
    // Stitch-line length per stitch kind (every row); the second side of joined seams comes off below.
    let mut by_kind: Vec<(crate::model::StitchKind, f64)> = Vec::new();
    for cp in &computed.pieces {
        let Some(pc) = project.piece(&cp.id) else { continue };
        let n = pc.cut_count.max(1);
        let area = signed_area(&cp.cut).abs() / 100.0;
        let stitch_len: f64 = cp.edges.iter().map(|e| e.stitch_length_mm).sum();
        let rows_len: f64 = cp.stitch_runs.iter().map(|r| crate::geom::polyline_length(&r.points, r.closed)).sum();
        let hole_count: usize = cp.stitch_runs.iter().map(|r| r.holes.len()).sum();
        seam += stitch_len * n as f64;
        match by_kind.iter_mut().find(|k| k.0 == pc.stitch.kind) {
            Some(k) => k.1 += rows_len * n as f64,
            None => by_kind.push((pc.stitch.kind, rows_len * n as f64)),
        }
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
            match hardware.iter_mut().find(|x| x.kind.is_empty() && x.label == label && (x.diameter_mm - h.diameter_mm).abs() < 1e-6 && (x.slot_mm - h.length_mm).abs() < 1e-6) {
                Some(x) => x.count += n,
                None => hardware.push(HardwareLine { label, diameter_mm: h.diameter_mm, slot_mm: h.length_mm, count: n, kind: String::new(), grams: 0.0 }),
            }
        }
        for hw in &pc.hardware {
            let Some(info) = craft::hardware_info(&hw.kind) else { continue };
            let size = if hw.size_mm > 0.0 { hw.size_mm } else { info.default_size_mm };
            // The bag builder puts a fastener's second half on the other piece with an id ending
            // in "b"; count the pair once.
            if info.fastens && hw.id.ends_with('b') {
                continue;
            }
            let grams = if hw.kind == "zipper" { info.grams * size } else { info.grams };
            match hardware.iter_mut().find(|x| x.kind == hw.kind && (x.diameter_mm - size).abs() < 1e-6) {
                Some(x) => x.count += n,
                None => hardware.push(HardwareLine { label: info.name.into(), diameter_mm: size, slot_mm: 0.0, count: n, kind: hw.kind.clone(), grams }),
            }
        }
    }
    // A joined, stitched seam is sewn once even though both sides carry a stitch line.
    for j in &project.joins {
        let Some(rep) = computed.joins.iter().find(|r| r.id == j.id) else { continue };
        if rep.a_stitch_mm > 0.0 && rep.b_stitch_mm > 0.0 {
            let shared = rep.a_stitch_mm.min(rep.b_stitch_mm);
            seam -= shared;
            let kind = project.piece(&j.b.piece_id).map(|p| p.stitch.kind);
            if let Some(k) = by_kind.iter_mut().find(|k| Some(k.0) == kind) {
                k.1 -= shared;
            }
        }
    }
    let mut threads = Vec::new();
    let mut thread_m = 0.0;
    for (kind, len) in by_kind {
        if len <= 0.5 {
            continue;
        }
        let info = craft::stitch_info(kind);
        let t = craft::thread(project.thread.as_deref(), info.lace);
        let m = len * info.thread_factor / 1000.0;
        thread_m += m;
        threads.push(ThreadLine { name: t.name.into(), stitch: info.name.into(), seam_mm: len, length_m: m });
    }
    // Glue: the glued band of every glued seam on both pieces, and laminated faces.
    let mut glue: Vec<GlueLine> = Vec::new();
    for j in &project.joins {
        if j.glue == Adhesive::None {
            continue;
        }
        let w = if j.glue_width_mm > 0.0 { j.glue_width_mm } else { project.piece(&j.a.piece_id).map_or(6.0, |p| (2.0 * p.stitch.margin_mm).max(6.0)) };
        let len = computed.joins.iter().find(|r| r.id == j.id).map_or(0.0, |r| r.a_length_mm);
        add_glue(&mut glue, j.glue, 2.0 * len * w / 100.0);
    }
    for lam in &project.laminates {
        let area = [&lam.a, &lam.b]
            .iter()
            .filter_map(|id| computed.pieces.iter().find(|c| &c.id == *id))
            .map(|c| signed_area(&c.outline).abs() / 100.0)
            .fold(f64::INFINITY, f64::min);
        if area.is_finite() {
            add_glue(&mut glue, if lam.glue == Adhesive::None { Adhesive::ContactCement } else { lam.glue }, 2.0 * area);
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
        thread_m,
        threads,
        glue,
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
        assert!((b.thread_m - 0.114 * THREAD_FACTOR).abs() < 0.05, "{}", b.thread_m);
    }

    #[test]
    fn bag_bom_counts_hardware_once_and_glue() {
        let p = crate::bags::bag(&crate::bags::BagParams::default());
        let c = compute(&p);
        let b = bom(&p, &c, 20.0);
        let rivets = b.hardware.iter().find(|h| h.kind == "rivet-m").map_or(0, |h| h.count);
        assert_eq!(rivets, 8, "{:?}", b.hardware);
        assert_eq!(b.hardware.iter().find(|h| h.kind == "bag-foot").map_or(0, |h| h.count), 4);
        assert!(!b.glue.is_empty() && b.glue[0].grams > 0.0);
        assert!(b.threads.len() == 1 && b.thread_m > 3.0, "{:?}", b.threads);
    }
}
