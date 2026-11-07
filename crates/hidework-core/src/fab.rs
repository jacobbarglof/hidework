//! Make the template itself: laser-cut it from acrylic, MDF or card (colour-coded SVG, layered
//! DXF) or 3D print it as a stencil plate (STL) with the stitch holes through it, ready to mark
//! or prick through.

use crate::compute::{compute, ComputedProject};
use crate::geom::{offset_closed, signed_area, v, Vec2};
use crate::mesh::{delaunay, resample};
use crate::model::Project;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FabOptions {
    /// Piece ids to include; empty means every piece.
    pub pieces: Vec<String>,
    /// Diameter of the stitch holes cut into the template (big enough for a scratch awl tip).
    pub stitch_hole_mm: f64,
    /// Laser kerf: outlines grow and holes shrink by half of it.
    pub kerf_mm: f64,
    /// Plate thickness for 3D printing.
    pub plate_mm: f64,
    pub include_stitch_holes: bool,
    pub include_punch_holes: bool,
    /// Fold lines as score (light cut) lines.
    pub include_folds: bool,
    /// Piece names as engraving.
    pub include_labels: bool,
}

impl Default for FabOptions {
    fn default() -> Self {
        FabOptions {
            pieces: vec![],
            stitch_hole_mm: 1.0,
            kerf_mm: 0.15,
            plate_mm: 2.0,
            include_stitch_holes: true,
            include_punch_holes: true,
            include_folds: true,
            include_labels: true,
        }
    }
}

/// One template part in sheet coordinates (millimetres, y down).
pub struct Part {
    pub name: String,
    pub outline: Vec<Vec2>,
    pub holes: Vec<(Vec2, f64)>,
    /// Oblong slots as closed outlines.
    pub slots: Vec<Vec<Vec2>>,
    pub scores: Vec<[Vec2; 2]>,
    pub label_at: Vec2,
}

pub fn parts(project: &Project, computed: &ComputedProject, o: &FabOptions) -> Vec<Part> {
    let mut out = Vec::new();
    for cp in &computed.pieces {
        if !o.pieces.is_empty() && !o.pieces.contains(&cp.id) {
            continue;
        }
        let Some(piece) = project.piece(&cp.id) else { continue };
        let off = piece.position;
        let mut holes = Vec::new();
        if o.include_stitch_holes {
            for run in &cp.stitch_runs {
                holes.extend(run.holes.iter().map(|&h| (h + off, o.stitch_hole_mm)));
            }
        }
        let mut slots = Vec::new();
        if o.include_punch_holes {
            for h in &cp.holes {
                match crate::generators::slot_outline(h) {
                    Some(s) => slots.push(s.into_iter().map(|p| p + off).collect()),
                    None => holes.push((h.center + off, h.diameter_mm)),
                }
            }
        }
        let scores = if o.include_folds {
            cp.folds.iter().flat_map(|f| f.center.iter().map(|s| [s[0] + off, s[1] + off])).collect()
        } else {
            vec![]
        };
        out.push(Part {
            name: piece.name.clone(),
            outline: cp.cut.iter().map(|&p| p + off).collect(),
            holes,
            slots,
            scores,
            label_at: cp.bounds.center() + off + v(0.0, -8.0),
        });
    }
    out
}

fn bounds(parts: &[Part]) -> (Vec2, Vec2) {
    let (mut lo, mut hi) = (v(f64::INFINITY, f64::INFINITY), v(f64::NEG_INFINITY, f64::NEG_INFINITY));
    for p in parts {
        for q in &p.outline {
            lo = v(lo.x.min(q.x), lo.y.min(q.y));
            hi = v(hi.x.max(q.x), hi.y.max(q.y));
        }
    }
    if lo.x > hi.x {
        (v(0.0, 0.0), v(10.0, 10.0))
    } else {
        (lo, hi)
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Laser SVG using the common colour convention: red cut, blue score, black engrave.
/// Hairline strokes; most laser software maps operations by colour.
pub fn laser_svg(project: &Project, o: &FabOptions) -> String {
    let parts = parts(project, &compute(project), o);
    let (lo, hi) = bounds(&parts);
    let m = 5.0;
    let (w, h) = (hi.x - lo.x + 2.0 * m, hi.y - lo.y + 2.0 * m);
    let tr = |p: Vec2| p - lo + v(m, m);
    let half = o.kerf_mm.max(0.0) / 2.0;
    let mut s = String::new();
    let _ = writeln!(s, r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w:.3}mm" height="{h:.3}mm" viewBox="0 0 {w:.3} {h:.3}">"#);
    let _ = writeln!(s, "<!-- Hidework laser template. Red: cut. Blue: score. Black: engrave. Kerf compensation {:.2} mm. -->", o.kerf_mm);
    let _ = writeln!(s, r##"<g id="cut" fill="none" stroke="#ff0000" stroke-width="0.05">"##);
    for p in &parts {
        let outline = offset_closed(&p.outline, -half);
        let pts: Vec<String> = outline.iter().map(|&q| {
            let q = tr(q);
            format!("{:.3},{:.3}", q.x, q.y)
        }).collect();
        let _ = writeln!(s, r#"<polygon points="{}"/>"#, pts.join(" "));
        for &(c, d) in &p.holes {
            let c = tr(c);
            let _ = writeln!(s, r#"<circle cx="{:.3}" cy="{:.3}" r="{:.3}"/>"#, c.x, c.y, (d / 2.0 - half).max(0.05));
        }
        for slot in &p.slots {
            let pts: Vec<String> = offset_closed(slot, half).iter().map(|&q| {
                let q = tr(q);
                format!("{:.3},{:.3}", q.x, q.y)
            }).collect();
            let _ = writeln!(s, r#"<polygon points="{}"/>"#, pts.join(" "));
        }
    }
    s.push_str("</g>\n");
    let _ = writeln!(s, r##"<g id="score" fill="none" stroke="#0000ff" stroke-width="0.05">"##);
    for p in &parts {
        for seg in &p.scores {
            let (a, b) = (tr(seg[0]), tr(seg[1]));
            let _ = writeln!(s, r#"<line x1="{:.3}" y1="{:.3}" x2="{:.3}" y2="{:.3}"/>"#, a.x, a.y, b.x, b.y);
        }
    }
    s.push_str("</g>\n");
    if o.include_labels {
        let _ = writeln!(s, r##"<g id="engrave" fill="#000000" font-family="Helvetica, Arial, sans-serif" font-size="4" text-anchor="middle">"##);
        for p in &parts {
            let c = tr(p.label_at);
            let _ = writeln!(s, r#"<text x="{:.3}" y="{:.3}">{}</text>"#, c.x, c.y, esc(&p.name));
        }
        s.push_str("</g>\n");
    }
    s.push_str("</svg>\n");
    s
}

/// DXF (R12, millimetres) with layers CUT, HOLES, SCORE and TEXT. Y is flipped to DXF's y-up.
pub fn dxf(project: &Project, o: &FabOptions) -> String {
    let parts = parts(project, &compute(project), o);
    let half = o.kerf_mm.max(0.0) / 2.0;
    let mut s = String::new();
    let mut put = |code: i32, val: &str| {
        let _ = writeln!(s, "{code}\n{val}");
    };
    put(0, "SECTION");
    put(2, "HEADER");
    put(9, "$INSUNITS");
    put(70, "4");
    put(0, "ENDSEC");
    put(0, "SECTION");
    put(2, "TABLES");
    put(0, "TABLE");
    put(2, "LAYER");
    put(70, "4");
    for (name, color) in [("CUT", "1"), ("HOLES", "1"), ("SCORE", "5"), ("TEXT", "7")] {
        put(0, "LAYER");
        put(2, name);
        put(70, "0");
        put(62, color);
        put(6, "CONTINUOUS");
    }
    put(0, "ENDTAB");
    put(0, "ENDSEC");
    put(0, "SECTION");
    put(2, "ENTITIES");
    let f = |x: f64| format!("{x:.4}");
    for p in &parts {
        put(0, "POLYLINE");
        put(8, "CUT");
        put(66, "1");
        put(70, "1");
        for q in offset_closed(&p.outline, -half) {
            put(0, "VERTEX");
            put(8, "CUT");
            put(10, &f(q.x));
            put(20, &f(-q.y));
            put(30, "0");
        }
        put(0, "SEQEND");
        put(8, "CUT");
        for &(c, d) in &p.holes {
            put(0, "CIRCLE");
            put(8, "HOLES");
            put(10, &f(c.x));
            put(20, &f(-c.y));
            put(30, "0");
            put(40, &f((d / 2.0 - half).max(0.05)));
        }
        for slot in &p.slots {
            put(0, "POLYLINE");
            put(8, "HOLES");
            put(66, "1");
            put(70, "1");
            for q in offset_closed(slot, half) {
                put(0, "VERTEX");
                put(8, "HOLES");
                put(10, &f(q.x));
                put(20, &f(-q.y));
                put(30, "0");
            }
            put(0, "SEQEND");
            put(8, "HOLES");
        }
        for seg in &p.scores {
            put(0, "LINE");
            put(8, "SCORE");
            put(10, &f(seg[0].x));
            put(20, &f(-seg[0].y));
            put(30, "0");
            put(11, &f(seg[1].x));
            put(21, &f(-seg[1].y));
            put(31, "0");
        }
        if o.include_labels {
            put(0, "TEXT");
            put(8, "TEXT");
            put(10, &f(p.label_at.x));
            put(20, &f(-p.label_at.y));
            put(30, "0");
            put(40, "4");
            put(1, &p.name);
            put(72, "1");
            put(11, &f(p.label_at.x));
            put(21, &f(-p.label_at.y));
            put(31, "0");
        }
    }
    put(0, "ENDSEC");
    put(0, "EOF");
    s
}

fn inside(p: Vec2, poly: &[Vec2]) -> bool {
    let mut c = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            c = !c;
        }
        j = i;
    }
    c
}

/// Flat triangulation of an outline with round holes: (points, triangles with CCW winding in y-up).
pub fn plate_triangulation(outline: &[Vec2], holes: &[(Vec2, f64)], slots: &[Vec<Vec2>]) -> (Vec<Vec2>, Vec<[usize; 3]>) {
    // Work in y-up so windings mean what slicers expect.
    let outline: Vec<Vec2> = outline.iter().map(|p| v(p.x, -p.y)).collect();
    let holes: Vec<(Vec2, f64)> = holes.iter().map(|&(c, d)| (v(c.x, -c.y), d / 2.0)).collect();
    let area = signed_area(&outline).abs().max(1.0);
    let h = (area / 1500.0).sqrt().clamp(2.0, 8.0);
    let mut pts = resample(&outline, h);
    let mut rims: Vec<Vec<Vec2>> = Vec::new();
    for &(c, r) in &holes {
        let segs = ((std::f64::consts::TAU * r / 0.35).ceil() as usize).clamp(8, 48);
        let rim: Vec<Vec2> = (0..segs)
            .map(|k| {
                let a = k as f64 / segs as f64 * std::f64::consts::TAU;
                c + v(a.cos(), a.sin()) * r
            })
            .collect();
        pts.extend(rim.iter().copied());
        rims.push(rim);
    }
    for slot in slots {
        let rim: Vec<Vec2> = slot.iter().map(|p| v(p.x, -p.y)).collect();
        pts.extend(rim.iter().copied());
        rims.push(rim);
    }
    let (mut lo, mut hi) = (v(f64::INFINITY, f64::INFINITY), v(f64::NEG_INFINITY, f64::NEG_INFINITY));
    for q in &outline {
        lo = v(lo.x.min(q.x), lo.y.min(q.y));
        hi = v(hi.x.max(q.x), hi.y.max(q.y));
    }
    let n_out = outline.len();
    let seg_dist = |p: Vec2, a: Vec2, b: Vec2| {
        let ab = b - a;
        let t = ((p - a).dot(ab) / ab.dot(ab).max(1e-18)).clamp(0.0, 1.0);
        p.dist(a + ab * t)
    };
    let mut y = lo.y + h * 0.5;
    let mut row = 0;
    while y < hi.y {
        let mut x = lo.x + if row % 2 == 0 { h * 0.25 } else { h * 0.75 };
        while x < hi.x {
            let q = v(x, y);
            let clear_edge = (0..n_out).all(|i| seg_dist(q, outline[i], outline[(i + 1) % n_out]) > 0.55 * h);
            let clear_holes = rims.iter().all(|rim| {
                let k = rim.len();
                !inside(q, rim) && (0..k).all(|i| seg_dist(q, rim[i], rim[(i + 1) % k]) > 0.6 * h)
            });
            if inside(q, &outline) && clear_edge && clear_holes {
                pts.push(q);
            }
            x += h;
        }
        y += h * 0.866;
        row += 1;
    }
    let tris = delaunay(&pts)
        .into_iter()
        .filter(|t| {
            let c = (pts[t[0]] + pts[t[1]] + pts[t[2]]) * (1.0 / 3.0);
            inside(c, &outline) && rims.iter().all(|rim| !inside(c, rim))
        })
        .map(|t| {
            let (a, b, c) = (pts[t[0]], pts[t[1]], pts[t[2]]);
            if (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0.0 {
                [t[0], t[2], t[1]]
            } else {
                t
            }
        })
        .collect();
    (pts, tris)
}

/// Binary STL of every part as a flat plate `plate_mm` thick, holes through.
pub fn stl(project: &Project, o: &FabOptions) -> Vec<u8> {
    let parts = parts(project, &compute(project), o);
    let t = o.plate_mm.max(0.4) as f32;
    let mut facets: Vec<[[f32; 3]; 3]> = Vec::new();
    for p in &parts {
        let (pts, tris) = plate_triangulation(&p.outline, &p.holes, &p.slots);
        let top = |i: usize| [pts[i].x as f32, pts[i].y as f32, t];
        let bot = |i: usize| [pts[i].x as f32, pts[i].y as f32, 0.0];
        let mut edge_use: HashMap<(usize, usize), usize> = HashMap::new();
        for tr in &tris {
            facets.push([top(tr[0]), top(tr[1]), top(tr[2])]);
            facets.push([bot(tr[0]), bot(tr[2]), bot(tr[1])]);
            for k in 0..3 {
                let (a, b) = (tr[k], tr[(k + 1) % 3]);
                *edge_use.entry((a.min(b), a.max(b))).or_default() += 1;
            }
        }
        // Walls on boundary edges (outer outline and hole rims), outward = right of a->b.
        for tr in &tris {
            for k in 0..3 {
                let (a, b) = (tr[k], tr[(k + 1) % 3]);
                if edge_use[&(a.min(b), a.max(b))] == 1 {
                    facets.push([bot(a), bot(b), top(b)]);
                    facets.push([bot(a), top(b), top(a)]);
                }
            }
        }
    }
    let mut out = Vec::with_capacity(84 + facets.len() * 50);
    let mut header = b"Hidework template plate (mm)".to_vec();
    header.resize(80, b' ');
    out.extend(header);
    out.extend((facets.len() as u32).to_le_bytes());
    for f in &facets {
        let u = [f[1][0] - f[0][0], f[1][1] - f[0][1], f[1][2] - f[0][2]];
        let w = [f[2][0] - f[0][0], f[2][1] - f[0][1], f[2][2] - f[0][2]];
        let mut nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        let l = (nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2]).sqrt().max(1e-12);
        nrm = [nrm[0] / l, nrm[1] / l, nrm[2] / l];
        for c in nrm.iter().chain(f.iter().flatten()) {
            out.extend(c.to_le_bytes());
        }
        out.extend(0u16.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::templates::card_wallet;

    #[test]
    fn stl_is_watertight() {
        let p = card_wallet();
        let bytes = stl(&p, &FabOptions::default());
        let n = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
        assert_eq!(bytes.len(), 84 + 50 * n);
        // Every undirected edge of a closed surface is shared by exactly two facets.
        let mut edges: HashMap<([i64; 3], [i64; 3]), i32> = HashMap::new();
        for k in 0..n {
            let off = 84 + 50 * k + 12;
            let vert = |i: usize| {
                let b = &bytes[off + 12 * i..off + 12 * i + 12];
                let f = |j: usize| (f32::from_le_bytes(b[4 * j..4 * j + 4].try_into().unwrap()) * 1000.0).round() as i64;
                [f(0), f(1), f(2)]
            };
            let vs = [vert(0), vert(1), vert(2)];
            for e in 0..3 {
                let (a, b) = (vs[e], vs[(e + 1) % 3]);
                *edges.entry(if a < b { (a, b) } else { (b, a) }).or_default() += 1;
            }
        }
        let bad = edges.values().filter(|&&c| c != 2).count();
        assert_eq!(bad, 0, "{bad} non-manifold edges of {}", edges.len());
    }

    #[test]
    fn plate_keeps_holes_open() {
        let sq = vec![v(0.0, 0.0), v(40.0, 0.0), v(40.0, 40.0), v(0.0, 40.0)];
        let (pts, tris) = plate_triangulation(&sq, &[(v(20.0, 20.0), 4.0)], &[]);
        let area: f64 = tris
            .iter()
            .map(|t| {
                let (a, b, c) = (pts[t[0]], pts[t[1]], pts[t[2]]);
                ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2.0
            })
            .sum();
        let expected = 1600.0 - std::f64::consts::PI * 4.0;
        assert!((area - expected).abs() < 0.5, "{area} vs {expected}");
    }

    #[test]
    fn laser_and_dxf_have_layers() {
        let p = card_wallet();
        let svg = laser_svg(&p, &FabOptions::default());
        assert!(svg.contains("#ff0000") && svg.contains("#0000ff") && svg.matches("<circle").count() == 64);
        let d = dxf(&p, &FabOptions::default());
        assert!(d.contains("SCORE") && d.matches("\nCIRCLE\n").count() == 64 && d.ends_with("EOF\n"));
    }
}
