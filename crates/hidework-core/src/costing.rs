//! What an item costs to make and what to charge for it: leather (by area, or the share of a
//! hide from a nesting layout), lining, thread, hardware, glue, edge paint, consumables, labour
//! estimated from the pattern, overhead, and wholesale and retail prices with margins.
//!
//! Labour minutes are rule-of-thumb defaults for a practised hand maker; every rate is in
//! `LabourRates` so a maker can set their own. Prices default to typical small-quantity US
//! retail prices and are meant to be replaced with the maker's own.

use crate::bom::{self, Bom};
use crate::compute::ComputedProject;
use crate::craft;
use crate::geom::polyline_length;
use crate::hide::{AreaUnit, MM2_PER_SQFT};
use crate::model::{Adhesive, EdgeFinish, MarkKind, MaterialKind, Project, StitchKind};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaterialPrice {
    pub material_id: String,
    /// Price per `Prices::area_unit`.
    pub price: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HardwarePrice {
    /// Catalogue id (`craft::hardware`).
    pub kind: String,
    pub price: f64,
}

/// Leather use taken from a nesting layout.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NestShare {
    pub material_id: String,
    pub hide_name: String,
    pub hide_area_mm2: f64,
    /// Complete items the layout fits.
    pub items: u32,
    /// What the maker paid for the whole piece of leather; none prices it by area instead.
    pub hide_price: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LabourRates {
    pub cut_per_piece_min: f64,
    pub cut_per_m_min: f64,
    pub prick_per_hole_min: f64,
    pub hand_stitch_per_hole_min: f64,
    pub machine_stitch_per_hole_min: f64,
    pub lace_per_slit_min: f64,
    pub edge_raw_per_m_min: f64,
    pub edge_burnished_per_m_min: f64,
    pub edge_painted_per_m_min: f64,
    pub edge_turned_per_m_min: f64,
    pub edge_bound_per_m_min: f64,
    pub skive_per_m_min: f64,
    pub glue_per_seam_min: f64,
    pub glue_per_laminate_min: f64,
    pub punch_per_hole_min: f64,
    /// Multiplies the built-in minutes per kind of hardware.
    pub hardware_factor: f64,
    pub assembly_per_piece_min: f64,
    /// Surface work: per stamp or lettering, and per square centimetre of tooling.
    pub stamp_min: f64,
    pub tooling_per_cm2_min: f64,
    /// Design, packing, photos: fixed minutes per item.
    pub extra_min: f64,
}

impl Default for LabourRates {
    fn default() -> Self {
        LabourRates {
            cut_per_piece_min: 2.0,
            cut_per_m_min: 1.5,
            prick_per_hole_min: 0.01,
            hand_stitch_per_hole_min: 0.12,
            machine_stitch_per_hole_min: 0.01,
            lace_per_slit_min: 0.25,
            edge_raw_per_m_min: 2.0,
            edge_burnished_per_m_min: 10.0,
            edge_painted_per_m_min: 15.0,
            edge_turned_per_m_min: 8.0,
            edge_bound_per_m_min: 10.0,
            skive_per_m_min: 5.0,
            glue_per_seam_min: 2.0,
            glue_per_laminate_min: 3.0,
            punch_per_hole_min: 0.3,
            hardware_factor: 1.0,
            assembly_per_piece_min: 1.0,
            stamp_min: 1.0,
            tooling_per_cm2_min: 0.4,
            extra_min: 0.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prices {
    pub currency: String,
    /// Unit that leather and lining prices are given in.
    pub area_unit: AreaUnit,
    /// Leather price per area unit when the material has none.
    pub leather_price: f64,
    /// Lining and fabric (materials that are not leather) per area unit.
    pub lining_price: f64,
    pub material_prices: Vec<MaterialPrice>,
    /// Waste allowed on top of the pieces' area when there is no layout.
    pub waste_pct: f64,
    pub nest: Option<NestShare>,
    pub thread_per_m: f64,
    pub lace_per_m: f64,
    /// Prices per hardware kind; kinds not listed use the defaults.
    pub hardware: Vec<HardwarePrice>,
    pub glue_per_g: f64,
    pub edge_paint_per_m: f64,
    /// Sandpaper, wax, burnishing gum, needles, tissue: per item.
    pub consumables: f64,
    pub hourly_rate: f64,
    /// Rent, tools, fees, as a share of materials plus labour.
    pub overhead_pct: f64,
    /// Wholesale price = cost x this.
    pub wholesale_x: f64,
    /// Retail price = wholesale x this.
    pub retail_x: f64,
    pub labour: LabourRates,
}

impl Default for Prices {
    fn default() -> Self {
        Prices {
            currency: "$".into(),
            area_unit: AreaUnit::Sqft,
            leather_price: 9.0,
            lining_price: 3.0,
            material_prices: vec![],
            waste_pct: 25.0,
            nest: None,
            thread_per_m: 0.12,
            lace_per_m: 0.8,
            hardware: vec![],
            glue_per_g: 0.04,
            edge_paint_per_m: 0.25,
            consumables: 0.75,
            hourly_rate: 25.0,
            overhead_pct: 15.0,
            wholesale_x: 2.0,
            retail_x: 2.0,
            labour: LabourRates::default(),
        }
    }
}

/// Typical small-quantity price of one piece of catalogue hardware (US dollars).
pub fn default_hardware_price(kind: &str) -> f64 {
    match kind {
        "rivet-s" => 0.15,
        "rivet-m" => 0.2,
        "rivet-l" => 0.3,
        "copper-rivet" => 0.4,
        "chicago-screw" => 0.6,
        "snap-24" => 0.6,
        "snap-20" => 0.5,
        "magnet-18" => 0.8,
        "turnlock-catch" => 5.0,
        // Sold with the catch.
        "turnlock-eyelet" => 0.0,
        "sam-browne" => 0.8,
        "grommet-10" => 0.3,
        "eyelet-5" => 0.1,
        "bag-foot" => 0.4,
        "d-ring" => 0.8,
        "o-ring" => 0.7,
        "square-ring" => 0.8,
        "buckle" => 3.0,
        "swivel-clasp" => 2.5,
        "key-ring" => 0.4,
        "zipper" => 2.5,
        "plaque" => 3.0,
        "concho" => 2.0,
        _ => 1.0,
    }
}

/// Minutes to set one piece of hardware.
fn hardware_minutes(kind: &str) -> f64 {
    match kind {
        "rivet-s" | "rivet-m" | "rivet-l" => 1.0,
        "copper-rivet" => 2.0,
        "chicago-screw" => 1.0,
        "snap-24" | "snap-20" => 2.0,
        "magnet-18" => 3.0,
        "turnlock-catch" => 8.0,
        "turnlock-eyelet" => 4.0,
        "sam-browne" => 2.0,
        "grommet-10" | "eyelet-5" => 1.0,
        "bag-foot" => 1.5,
        "d-ring" | "o-ring" | "square-ring" | "swivel-clasp" | "key-ring" => 0.5,
        "buckle" => 3.0,
        "zipper" => 15.0,
        "plaque" | "concho" => 3.0,
        _ => 2.0,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostLine {
    /// Leather, Lining, Thread, Hardware, Glue, Edge paint, Consumables, Labour, Overhead.
    pub group: String,
    pub label: String,
    /// What the price is keyed by: the material id for leather and lining, the hardware kind
    /// for hardware, otherwise empty.
    pub key: String,
    pub quantity: f64,
    pub unit: String,
    pub unit_price: f64,
    pub cost: f64,
    /// The line in plain English.
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabourStep {
    pub step: String,
    pub minutes: f64,
    pub how: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostReport {
    pub currency: String,
    pub lines: Vec<CostLine>,
    pub labour_steps: Vec<LabourStep>,
    pub materials_cost: f64,
    pub labour_minutes: f64,
    pub labour_cost: f64,
    pub overhead_cost: f64,
    /// Everything it takes to make one item.
    pub total_cost: f64,
    pub wholesale: f64,
    pub retail: f64,
    pub wholesale_margin_pct: f64,
    pub retail_margin_pct: f64,
    /// Plain-English summary, one sentence per entry.
    pub summary: Vec<String>,
}

fn money(c: &str, x: f64) -> String {
    format!("{c}{x:.2}")
}

/// "1 h 35 min" / "12 min".
pub fn duration(min: f64) -> String {
    let m = min.max(0.0).round() as u64;
    match (m / 60, m % 60) {
        (0, mm) => format!("{mm} min"),
        (h, 0) => format!("{h} h"),
        (h, mm) => format!("{h} h {mm} min"),
    }
}

fn plural(n: f64, one: &str, many: &str) -> String {
    let k = n.round() as i64;
    format!("{k} {}", if k == 1 { one } else { many })
}

/// Labour per item, by step.
pub fn labour(project: &Project, computed: &ComputedProject, rates: &LabourRates) -> Vec<LabourStep> {
    let mut pieces = 0.0;
    let mut cut_m = 0.0;
    let mut holes_hand = 0.0;
    let mut holes_machine = 0.0;
    let mut slits = 0.0;
    let mut pricked = 0.0;
    let mut edge = [0.0f64; 5];
    let mut skive_m = 0.0;
    let mut punched = 0.0;
    let mut stamps = 0.0;
    let mut tooling_cm2 = 0.0;
    let mut hw_min = 0.0;
    let mut hw_count = 0.0;
    let fin = |f: EdgeFinish| match f {
        EdgeFinish::Raw => 0,
        EdgeFinish::Burnished => 1,
        EdgeFinish::Painted => 2,
        EdgeFinish::Turned => 3,
        EdgeFinish::Bound => 4,
    };
    for cp in &computed.pieces {
        let Some(pc) = project.piece(&cp.id) else { continue };
        let n = pc.cut_count.max(1) as f64;
        pieces += n;
        cut_m += n * polyline_length(&cp.cut, true) / 1000.0;
        for r in &cp.stitch_runs {
            let k = r.holes.len() as f64 * n;
            pricked += k;
            if r.lace {
                slits += k;
            } else if r.kind == StitchKind::Lockstitch {
                holes_machine += k;
            } else {
                holes_hand += k;
            }
        }
        for (i, e) in pc.edges.iter().enumerate() {
            let len = cp.edges.get(i).map_or(0.0, |r| r.length_mm) / 1000.0;
            edge[fin(e.finish)] += n * len;
            if e.skive_mm > 0.0 {
                skive_m += n * len;
            }
        }
        punched += n * cp.holes.len() as f64;
        for m in &pc.marks {
            match m.kind {
                MarkKind::Stamp | MarkKind::Text | MarkKind::Engrave => stamps += n,
                MarkKind::Emboss => stamps += 2.0 * n,
                MarkKind::Tooling | MarkKind::Paint | MarkKind::Perforate => tooling_cm2 += n * (m.size.x * m.size.y).abs() / 100.0,
            }
        }
        for hw in &pc.hardware {
            hw_min += n * hardware_minutes(&hw.kind);
            hw_count += n;
        }
    }
    // A joined seam is stitched once and its two edges are finished together.
    for j in &project.joins {
        let Some(rep) = computed.joins.iter().find(|r| r.id == j.id) else { continue };
        if j.onto_face() {
            continue;
        }
        let shared = rep.a_length_mm.min(rep.b_length_mm) / 1000.0;
        if let Some(pc) = project.piece(&j.a.piece_id) {
            let f = j.a.edges.first().and_then(|&e| pc.edges.get(e)).map_or(EdgeFinish::Raw, |e| e.finish);
            edge[fin(f)] = (edge[fin(f)] - shared).max(0.0);
            let shared_holes = rep.a_holes.min(rep.b_holes) as f64;
            let lace = craft::stitch_info(pc.stitch.kind).lace;
            if lace {
                slits = (slits - shared_holes).max(0.0);
            } else if pc.stitch.kind == StitchKind::Lockstitch {
                holes_machine = (holes_machine - shared_holes).max(0.0);
            } else {
                holes_hand = (holes_hand - shared_holes).max(0.0);
            }
        }
    }
    let glued = project.joins.iter().filter(|j| j.glue != Adhesive::None).count() as f64;
    let laminates = project.laminates.len() as f64;
    let r = rates;
    let mut steps = Vec::new();
    let mut push = |step: &str, minutes: f64, how: String| {
        if minutes > 0.004 {
            steps.push(LabourStep { step: step.into(), minutes, how });
        }
    };
    push("Cutting", pieces * r.cut_per_piece_min + cut_m * r.cut_per_m_min, format!("{} with {:.1} m of cutting line", plural(pieces, "piece", "pieces"), cut_m));
    push("Pricking holes", pricked * r.prick_per_hole_min, format!("{pricked:.0} stitch holes with irons"));
    push("Hand stitching", holes_hand * r.hand_stitch_per_hole_min, plural(holes_hand, "stitch", "stitches"));
    push("Machine stitching", holes_machine * r.machine_stitch_per_hole_min, plural(holes_machine, "stitch", "stitches"));
    push("Lacing", slits * r.lace_per_slit_min, plural(slits, "slit", "slits"));
    let edges_min = edge[0] * r.edge_raw_per_m_min + edge[1] * r.edge_burnished_per_m_min + edge[2] * r.edge_painted_per_m_min + edge[3] * r.edge_turned_per_m_min + edge[4] * r.edge_bound_per_m_min;
    let mut parts = Vec::new();
    for (k, name) in ["raw", "burnished", "painted", "turned", "bound"].iter().enumerate() {
        if edge[k] > 0.0005 {
            parts.push(format!("{:.2} m {name}", edge[k]));
        }
    }
    push("Edges", edges_min, if parts.is_empty() { "no edges".into() } else { parts.join(", ") });
    push("Skiving", skive_m * r.skive_per_m_min, format!("{skive_m:.2} m of skived edge"));
    push("Gluing", glued * r.glue_per_seam_min + laminates * r.glue_per_laminate_min, format!("{} and {}", plural(glued, "glued seam", "glued seams"), plural(laminates, "glued-up layer", "glued-up layers")));
    push("Punching holes", punched * r.punch_per_hole_min, plural(punched, "hole", "holes"));
    push("Setting hardware", hw_min * r.hardware_factor, plural(hw_count, "piece of hardware", "pieces of hardware"));
    push("Stamping and tooling", stamps * r.stamp_min + tooling_cm2 * r.tooling_per_cm2_min, format!("{} and {tooling_cm2:.0} cm² of tooling", plural(stamps, "stamp", "stamps")));
    push("Assembly", pieces * r.assembly_per_piece_min, format!("marking, fitting and checking {}", plural(pieces, "piece", "pieces")));
    push("Other", r.extra_min, "design, packing and photos".into());
    steps
}

fn area_price(p: &Prices, project: &Project, material_id: &str, leather: bool) -> f64 {
    if let Some(mp) = p.material_prices.iter().find(|m| m.material_id == material_id) {
        return mp.price;
    }
    if let Some(per_sqft) = project.material(material_id).and_then(|m| m.cost_per_sqft) {
        // Per square foot to per chosen unit.
        return per_sqft * p.area_unit.mm2() / MM2_PER_SQFT;
    }
    if leather {
        p.leather_price
    } else {
        p.lining_price
    }
}

/// Cost to make one item, and the prices to charge.
pub fn cost(project: &Project, computed: &ComputedProject, prices: &Prices) -> CostReport {
    let p = prices;
    let c = p.currency.as_str();
    let unit = p.area_unit;
    let b: Bom = bom::bom(project, computed, p.waste_pct);
    let mut lines: Vec<CostLine> = Vec::new();
    for m in &b.materials {
        let leather = project.material(&m.material_id).is_none_or(|x| x.kind == MaterialKind::Leather);
        let group = if leather { "Leather" } else { "Lining" };
        let price = area_price(p, project, &m.material_id, leather);
        let nest = p.nest.as_ref().filter(|n| n.material_id == m.material_id && n.items > 0);
        let line = match nest {
            Some(n) if n.hide_price.is_some() => {
                let hp = n.hide_price.unwrap_or(0.0);
                let each = hp / n.items as f64;
                let qty = n.hide_area_mm2 / n.items as f64 / unit.mm2();
                CostLine {
                    group: group.into(),
                    label: m.name.clone(),
                    key: m.material_id.clone(),
                    quantity: qty,
                    unit: unit.label().into(),
                    unit_price: if qty > 0.0 { each / qty } else { 0.0 },
                    cost: each,
                    text: format!(
                        "{}: your {} cost {} and fits {}, so each takes {} ({:.2} {} with its share of the leftover).",
                        m.name,
                        if n.hide_name.is_empty() { "leather".to_string() } else { n.hide_name.to_lowercase() },
                        money(c, hp),
                        plural(n.items as f64, "item", "items"),
                        money(c, each),
                        qty,
                        unit.label()
                    ),
                }
            }
            Some(n) => {
                let qty = n.hide_area_mm2 / n.items as f64 / unit.mm2();
                CostLine {
                    group: group.into(),
                    label: m.name.clone(),
                    key: m.material_id.clone(),
                    quantity: qty,
                    unit: unit.label().into(),
                    unit_price: price,
                    cost: qty * price,
                    text: format!("{}: {:.2} {} per item from the cutting layout (leftover shared out) at {} per {} = {}.", m.name, qty, unit.label(), money(c, price), unit.label(), money(c, qty * price)),
                }
            }
            None => {
                let qty = m.sqft_with_waste * MM2_PER_SQFT / unit.mm2();
                CostLine {
                    group: group.into(),
                    label: m.name.clone(),
                    key: m.material_id.clone(),
                    quantity: qty,
                    unit: unit.label().into(),
                    unit_price: price,
                    cost: qty * price,
                    text: format!("{}: {:.2} {} including {:.0}% for waste, at {} per {} = {}.", m.name, qty, unit.label(), p.waste_pct, money(c, price), unit.label(), money(c, qty * price)),
                }
            }
        };
        lines.push(line);
    }
    for t in &b.threads {
        let lace = t.name.to_lowercase().contains("lace");
        let per = if lace { p.lace_per_m } else { p.thread_per_m };
        lines.push(CostLine {
            group: "Thread".into(),
            label: t.name.clone(),
            key: String::new(),
            quantity: t.length_m,
            unit: "m".into(),
            unit_price: per,
            cost: t.length_m * per,
            text: format!("{}: {:.1} m for {} at {} a metre = {}.", t.name, t.length_m, t.stitch.to_lowercase(), money(c, per), money(c, t.length_m * per)),
        });
    }
    for h in b.hardware.iter().filter(|h| !h.kind.is_empty()) {
        let each = p.hardware.iter().find(|x| x.kind == h.kind).map_or_else(|| default_hardware_price(&h.kind), |x| x.price);
        let n = h.count as f64;
        lines.push(CostLine {
            group: "Hardware".into(),
            label: h.label.clone(),
            key: h.kind.clone(),
            quantity: n,
            unit: "each".into(),
            unit_price: each,
            cost: n * each,
            text: format!("{} x {} at {} = {}.", h.count, h.label, money(c, each), money(c, n * each)),
        });
    }
    for g in &b.glue {
        lines.push(CostLine {
            group: "Glue".into(),
            label: g.name.clone(),
            key: String::new(),
            quantity: g.grams,
            unit: "g".into(),
            unit_price: p.glue_per_g,
            cost: g.grams * p.glue_per_g,
            text: format!("{}: about {:.0} g at {} a gram = {}.", g.name, g.grams, money(c, p.glue_per_g), money(c, g.grams * p.glue_per_g)),
        });
    }
    let steps = labour(project, computed, &p.labour);
    let painted_m = painted_edge_m(project, computed);
    if painted_m > 0.0 {
        lines.push(CostLine {
            group: "Edge paint".into(),
            label: "Edge paint".into(),
            key: String::new(),
            quantity: painted_m,
            unit: "m".into(),
            unit_price: p.edge_paint_per_m,
            cost: painted_m * p.edge_paint_per_m,
            text: format!("Edge paint for {:.2} m of edge at {} a metre = {}.", painted_m, money(c, p.edge_paint_per_m), money(c, painted_m * p.edge_paint_per_m)),
        });
    }
    if p.consumables > 0.0 {
        lines.push(CostLine {
            group: "Consumables".into(),
            label: "Consumables".into(),
            key: String::new(),
            quantity: 1.0,
            unit: "item".into(),
            unit_price: p.consumables,
            cost: p.consumables,
            text: format!("Sandpaper, wax, burnishing gum and needles: {} per item.", money(c, p.consumables)),
        });
    }
    let materials_cost: f64 = lines.iter().map(|l| l.cost).sum();
    let labour_minutes: f64 = steps.iter().map(|s| s.minutes).sum();
    let labour_cost = labour_minutes / 60.0 * p.hourly_rate;
    lines.push(CostLine {
        group: "Labour".into(),
        label: "Your time".into(),
        key: String::new(),
        quantity: labour_minutes / 60.0,
        unit: "h".into(),
        unit_price: p.hourly_rate,
        cost: labour_cost,
        text: format!("About {} of work at {} an hour = {}.", duration(labour_minutes), money(c, p.hourly_rate), money(c, labour_cost)),
    });
    let overhead_cost = (materials_cost + labour_cost) * p.overhead_pct.max(0.0) / 100.0;
    if overhead_cost > 0.0 {
        lines.push(CostLine {
            group: "Overhead".into(),
            label: "Overhead".into(),
            key: String::new(),
            quantity: p.overhead_pct,
            unit: "%".into(),
            unit_price: 0.0,
            cost: overhead_cost,
            text: format!("Overhead (tools, rent, fees) at {:.0}% = {}.", p.overhead_pct, money(c, overhead_cost)),
        });
    }
    let total = materials_cost + labour_cost + overhead_cost;
    let wholesale = total * p.wholesale_x.max(0.0);
    let retail = wholesale * p.retail_x.max(0.0);
    let margin = |price: f64| if price > 0.0 { 100.0 * (price - total) / price } else { 0.0 };
    let name = if project.name.trim().is_empty() { "item".to_string() } else { project.name.trim().to_lowercase() };
    let summary = vec![
        format!("Materials come to {} and about {} of work at {} an hour is {}.", money(c, materials_cost), duration(labour_minutes), money(c, p.hourly_rate), money(c, labour_cost)),
        format!("With {:.0}% overhead it costs {} to make one {name}.", p.overhead_pct, money(c, total)),
        format!("Sell wholesale at {} ({:.1} x cost): you keep {} on each, a {:.0}% margin.", money(c, wholesale), p.wholesale_x, money(c, wholesale - total), margin(wholesale)),
        format!("Sell retail at {} ({:.1} x wholesale): you keep {} on each, a {:.0}% margin.", money(c, retail), p.retail_x, money(c, retail - total), margin(retail)),
    ];
    CostReport {
        currency: p.currency.clone(),
        lines,
        labour_steps: steps,
        materials_cost,
        labour_minutes,
        labour_cost,
        overhead_cost,
        total_cost: total,
        wholesale,
        retail,
        wholesale_margin_pct: margin(wholesale),
        retail_margin_pct: margin(retail),
        summary,
    }
}

/// Painted edge length per item, metres (joined edges painted once).
fn painted_edge_m(project: &Project, computed: &ComputedProject) -> f64 {
    let mut m = 0.0;
    for cp in &computed.pieces {
        let Some(pc) = project.piece(&cp.id) else { continue };
        let n = pc.cut_count.max(1) as f64;
        for (i, e) in pc.edges.iter().enumerate() {
            if e.finish == EdgeFinish::Painted {
                m += n * cp.edges.get(i).map_or(0.0, |r| r.length_mm) / 1000.0;
            }
        }
    }
    for j in &project.joins {
        let Some(rep) = computed.joins.iter().find(|r| r.id == j.id) else { continue };
        let painted = project.piece(&j.a.piece_id).and_then(|pc| j.a.edges.first().and_then(|&e| pc.edges.get(e))).is_some_and(|e| e.finish == EdgeFinish::Painted);
        if painted && !j.onto_face() {
            m -= rep.a_length_mm.min(rep.b_length_mm) / 1000.0;
        }
    }
    m.max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::compute;
    use crate::model::EdgeFinish;

    #[test]
    fn costing_card_wallet() {
        let p = crate::templates::card_wallet();
        let c = compute(&p);
        let r = cost(&p, &c, &Prices::default());
        let leather = r.lines.iter().find(|l| l.group == "Leather").unwrap();
        // About 0.15 sq ft of pieces plus 25% waste at $9.
        assert!(leather.quantity > 0.12 && leather.quantity < 0.3, "{}", leather.quantity);
        assert!((leather.cost - leather.quantity * 9.0).abs() < 1e-9);
        assert!(r.lines.iter().any(|l| l.group == "Thread"));
        // 64 holes on the two seams: 32 stitches by hand plus cutting, edges and assembly.
        let stitch = r.labour_steps.iter().find(|s| s.step == "Hand stitching").unwrap();
        assert!((stitch.minutes - 32.0 * 0.12).abs() < 0.01, "{}", stitch.minutes);
        assert!(r.labour_minutes > 5.0 && r.labour_minutes < 60.0, "{}", r.labour_minutes);
        let sum: f64 = r.lines.iter().map(|l| l.cost).sum();
        assert!((sum - r.total_cost).abs() < 1e-9);
        assert!((r.wholesale - 2.0 * r.total_cost).abs() < 1e-9);
        assert!((r.retail - 4.0 * r.total_cost).abs() < 1e-9);
        assert!((r.wholesale_margin_pct - 50.0).abs() < 1e-9);
        assert!((r.retail_margin_pct - 75.0).abs() < 1e-9);
        assert_eq!(r.summary.len(), 4);
        assert!(r.summary[1].contains("fold-over card wallet"), "{}", r.summary[1]);
    }

    #[test]
    fn costing_tote_hardware_and_overrides() {
        let mut p = crate::templates::by_id("tote").unwrap();
        p.materials[0].cost_per_sqft = Some(12.0);
        let c = compute(&p);
        let mut prices = Prices { hardware: vec![HardwarePrice { kind: "rivet-m".into(), price: 1.0 }], ..Default::default() };
        let r = cost(&p, &c, &prices);
        let rivets = r.lines.iter().find(|l| l.group == "Hardware" && l.label.contains("medium")).unwrap();
        assert_eq!(rivets.quantity, 8.0);
        assert!((rivets.cost - 8.0).abs() < 1e-9);
        let leather = r.lines.iter().find(|l| l.group == "Leather").unwrap();
        assert!((leather.unit_price - 12.0).abs() < 1e-9);
        assert!(r.labour_steps.iter().any(|s| s.step == "Setting hardware"));
        // A layout share replaces the waste estimate: a $150 hide that fits 3 totes is $50 each.
        prices.nest = Some(NestShare { material_id: p.materials[0].id.clone(), hide_name: "Double shoulder".into(), hide_area_mm2: 12.0 * MM2_PER_SQFT, items: 3, hide_price: Some(150.0) });
        let r2 = cost(&p, &c, &prices);
        let l2 = r2.lines.iter().find(|l| l.group == "Leather").unwrap();
        assert!((l2.cost - 50.0).abs() < 1e-9, "{}", l2.text);
        assert!((l2.quantity - 4.0).abs() < 1e-9);
        assert!(l2.text.contains("fits 3 items"), "{}", l2.text);
        // Priced per m² instead.
        let r3 = cost(&p, &c, &Prices { area_unit: AreaUnit::M2, leather_price: 100.0, ..Default::default() });
        let l3 = r3.lines.iter().find(|l| l.group == "Leather").unwrap();
        assert!((l3.unit_price - 12.0 * 1e6 / MM2_PER_SQFT).abs() < 1e-6);
        assert_eq!(l3.unit, "m²");
    }

    #[test]
    fn costing_painted_edges() {
        let mut p = crate::templates::card_wallet();
        for e in &mut p.pieces[0].edges {
            e.finish = EdgeFinish::Painted;
        }
        let c = compute(&p);
        let r = cost(&p, &c, &Prices::default());
        let paint = r.lines.iter().find(|l| l.group == "Edge paint").unwrap();
        // Perimeter about 0.5 m less the two joined sides (about 0.11 m).
        assert!(paint.quantity > 0.3 && paint.quantity < 0.6, "{}", paint.quantity);
        assert_eq!(duration(95.0), "1 h 35 min");
        assert_eq!(duration(60.0), "1 h");
        assert_eq!(duration(12.4), "12 min");
    }
}
