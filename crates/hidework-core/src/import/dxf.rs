//! ASCII DXF reader: LINE, LWPOLYLINE and POLYLINE (with bulge arcs), ARC, CIRCLE, ELLIPSE,
//! SPLINE (sampled and refitted within 0.02 mm), and INSERT of blocks (with scale, rotation and
//! simple arrays). Units come from `$INSUNITS`; drawings with no unit are read as millimetres.
//! DXF is y-up, so everything is flipped to Hidework's y-down sheet.

use super::fit::fit_open;
use super::{arc_cubics, arc_through, Affine, ImportOptions, Path, Seg};
use crate::geom::{v, Rect, Vec2};
use std::collections::HashMap;
use std::f64::consts::TAU;

#[derive(Clone, Debug, Default)]
struct Entity {
    kind: String,
    codes: Vec<(i32, String)>,
    /// POLYLINE vertices.
    vertices: Vec<Entity>,
}

impl Entity {
    fn get(&self, code: i32) -> Option<&str> {
        self.codes.iter().find(|c| c.0 == code).map(|c| c.1.as_str())
    }
    fn f(&self, code: i32) -> f64 {
        self.get(code).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0)
    }
    fn f_or(&self, code: i32, d: f64) -> f64 {
        self.get(code).and_then(|s| s.trim().parse().ok()).unwrap_or(d)
    }
    fn i(&self, code: i32) -> i64 {
        self.get(code).and_then(|s| s.trim().parse().ok()).unwrap_or(0)
    }
    fn all(&self, code: i32) -> Vec<f64> {
        self.codes.iter().filter(|c| c.0 == code).filter_map(|c| c.1.trim().parse().ok()).collect()
    }
    fn layer(&self) -> &str {
        self.get(8).unwrap_or("0")
    }
    /// Entities drawn with a flipped extrusion (0, 0, -1) are mirrored in x.
    fn flipped(&self) -> bool {
        self.f_or(230, 1.0) < 0.0
    }
}

struct Block {
    base: Vec2,
    entities: Vec<Entity>,
}

pub fn read(bytes: &[u8], opts: &ImportOptions, warnings: &mut Vec<String>) -> Result<(Vec<Path>, String), String> {
    if bytes.starts_with(b"AutoCAD Binary DXF") {
        return Err("This is a binary DXF file. Save it again as an ASCII (text) DXF and try once more.".into());
    }
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text.lines().collect();
    let mut pairs: Vec<(i32, &str)> = Vec::with_capacity(lines.len() / 2);
    let mut i = 0;
    while i + 1 < lines.len() {
        let Ok(code) = lines[i].trim().parse::<i32>() else {
            return Err(format!("This DXF file looks damaged near line {}.", i + 1));
        };
        pairs.push((code, lines[i + 1].trim()));
        i += 2;
    }
    // Split into sections.
    let mut header: HashMap<String, Vec<(i32, String)>> = HashMap::new();
    let mut layers_off: Vec<String> = vec![];
    let mut blocks: HashMap<String, Block> = HashMap::new();
    let mut entities: Vec<Entity> = vec![];
    let mut k = 0;
    while k < pairs.len() {
        if pairs[k] == (0, "SECTION") && k + 1 < pairs.len() {
            let name = pairs[k + 1].1;
            let mut end = k + 2;
            while end < pairs.len() && pairs[end] != (0, "ENDSEC") {
                end += 1;
            }
            let body = &pairs[k + 2..end];
            match name {
                "HEADER" => {
                    let mut var = String::new();
                    for &(c, val) in body {
                        if c == 9 {
                            var = val.to_string();
                        } else {
                            header.entry(var.clone()).or_default().push((c, val.to_string()));
                        }
                    }
                }
                "TABLES" => {
                    for e in group(body) {
                        if e.kind == "LAYER" {
                            let off = e.i(62) < 0 || e.i(70) & 1 == 1;
                            if off {
                                layers_off.push(e.get(2).unwrap_or("").to_string());
                            }
                        }
                    }
                }
                "BLOCKS" => {
                    let all = group(body);
                    let mut cur: Option<(String, Block)> = None;
                    for e in all {
                        match e.kind.as_str() {
                            "BLOCK" => cur = Some((e.get(2).unwrap_or("").to_string(), Block { base: v(e.f(10), e.f(20)), entities: vec![] })),
                            "ENDBLK" => {
                                if let Some((n, b)) = cur.take() {
                                    blocks.insert(n, b);
                                }
                            }
                            _ => {
                                if let Some((_, b)) = cur.as_mut() {
                                    b.entities.push(e);
                                }
                            }
                        }
                    }
                }
                "ENTITIES" => entities = group(body),
                _ => {}
            }
            k = end + 1;
        } else {
            k += 1;
        }
    }
    let insunits = header.get("$INSUNITS").and_then(|v| v.iter().find(|c| c.0 == 70)).and_then(|c| c.1.parse::<i64>().ok()).unwrap_or(0);
    let (mut k_mm, mut units) = match insunits {
        1 => (25.4, "inches (from the file)".to_string()),
        2 => (304.8, "feet (from the file)".to_string()),
        4 => (1.0, "mm (from the file)".to_string()),
        5 => (10.0, "cm (from the file)".to_string()),
        6 => (1000.0, "metres (from the file)".to_string()),
        9 => (0.0254, "mils (from the file)".to_string()),
        10 => (914.4, "yards (from the file)".to_string()),
        14 => (100.0, "decimetres (from the file)".to_string()),
        _ => (1.0, "mm (the file does not say; assumed)".to_string()),
    };
    let unitless = !matches!(insunits, 1 | 2 | 4 | 5 | 6 | 9 | 10 | 14);
    if !opts.units.is_empty() {
        k_mm = super::unit_mm(&opts.units).ok_or_else(|| format!("Unknown unit {}", opts.units))?;
        units = format!("{} (as chosen)", opts.units);
    }
    let mut cx = Cx { blocks: &blocks, layers_off: &layers_off, paths: vec![], skipped: HashMap::new(), hidden: 0, approx_splines: 0, spline_tol: 0.02 / k_mm };
    for e in &entities {
        cx.entity(e, &Affine::IDENTITY, "", 0);
    }
    let to_sheet = Affine::scale(k_mm, -k_mm);
    let paths: Vec<Path> = cx.paths.iter().map(|p| p.transformed(&to_sheet)).collect();
    if unitless && opts.units.is_empty() {
        let mut bb = Rect::empty();
        for p in &paths {
            bb.union(&p.bbox());
        }
        if !bb.is_empty() && bb.width().max(bb.height()) < 40.0 {
            warnings.push("The file does not say its unit and the drawing is very small in millimetres. If it was drawn in inches, choose inches and bring it in again.".into());
        } else {
            warnings.push("The file does not say its unit, so millimetres were assumed. Check one measurement.".into());
        }
    }
    let mut skipped: Vec<_> = cx.skipped.into_iter().collect();
    skipped.sort();
    for (kind, n) in skipped {
        warnings.push(format!("Left out {n} {kind} item{} (not pattern lines).", if n == 1 { "" } else { "s" }));
    }
    if cx.hidden > 0 {
        warnings.push(format!("Left out {} item(s) on layers that are turned off or frozen.", cx.hidden));
    }
    if cx.approx_splines > 0 {
        warnings.push(format!("{} spline(s) given only by points they pass through were smoothed through those points.", cx.approx_splines));
    }
    Ok((paths, units))
}

/// Group code pairs into entities (each starts at a code 0); POLYLINE gathers its VERTEXes.
fn group(body: &[(i32, &str)]) -> Vec<Entity> {
    let mut out: Vec<Entity> = vec![];
    let mut in_poly = false;
    for &(c, val) in body {
        if c == 0 {
            match val {
                "VERTEX" if in_poly => {
                    out.last_mut().unwrap().vertices.push(Entity { kind: val.into(), ..Default::default() });
                    continue;
                }
                "SEQEND" if in_poly => {
                    in_poly = false;
                    out.push(Entity { kind: "SEQEND".into(), ..Default::default() });
                    continue;
                }
                _ => {}
            }
            in_poly = val == "POLYLINE";
            out.push(Entity { kind: val.into(), ..Default::default() });
        } else if let Some(e) = out.last_mut() {
            if in_poly && !e.vertices.is_empty() {
                e.vertices.last_mut().unwrap().codes.push((c, val.into()));
            } else {
                e.codes.push((c, val.into()));
            }
        }
    }
    out.retain(|e| e.kind != "SEQEND");
    out
}

struct Cx<'a> {
    blocks: &'a HashMap<String, Block>,
    layers_off: &'a [String],
    paths: Vec<Path>,
    skipped: HashMap<String, usize>,
    hidden: usize,
    approx_splines: usize,
    /// Spline refit tolerance in drawing units.
    spline_tol: f64,
}

impl Cx<'_> {
    fn emit(&mut self, p: Path, tf: &Affine, e: &Entity) {
        // Only the 2D (object coordinate system) entities mirror with a flipped extrusion.
        let ocs = matches!(e.kind.as_str(), "LWPOLYLINE" | "POLYLINE" | "ARC" | "CIRCLE");
        let p = if ocs && e.flipped() { p.transformed(&Affine::scale(-1.0, 1.0)) } else { p };
        self.paths.push(p.transformed(tf));
    }

    fn entity(&mut self, e: &Entity, tf: &Affine, inherited: &str, depth: usize) {
        if self.layers_off.iter().any(|l| l == e.layer()) {
            self.hidden += 1;
            return;
        }
        let layer = if e.layer() == "0" { inherited } else { e.layer() };
        let name = layer.to_string();
        match e.kind.as_str() {
            "LINE" => {
                let mut p = Path::new(v(e.f(10), e.f(20)), &name);
                p.line_to(v(e.f(11), e.f(21)));
                self.emit(p, tf, e);
            }
            "LWPOLYLINE" => {
                let mut pts: Vec<(Vec2, f64)> = vec![];
                for (c, val) in &e.codes {
                    let x: f64 = val.trim().parse().unwrap_or(0.0);
                    match c {
                        10 => pts.push((v(x, 0.0), 0.0)),
                        20 => {
                            if let Some(l) = pts.last_mut() {
                                l.0.y = x;
                            }
                        }
                        42 => {
                            if let Some(l) = pts.last_mut() {
                                l.1 = x;
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(p) = bulge_path(&pts, e.i(70) & 1 == 1, &name) {
                    self.emit(p, tf, e);
                }
            }
            "POLYLINE" => {
                let flags = e.i(70);
                if flags & (16 | 64) != 0 {
                    *self.skipped.entry("3D mesh".into()).or_default() += 1;
                    return;
                }
                let pts: Vec<(Vec2, f64)> = e.vertices.iter().filter(|vx| vx.i(70) & 16 == 0).map(|vx| (v(vx.f(10), vx.f(20)), vx.f(42))).collect();
                if let Some(p) = bulge_path(&pts, flags & 1 == 1, &name) {
                    self.emit(p, tf, e);
                }
            }
            "ARC" => {
                let (c, r) = (v(e.f(10), e.f(20)), e.f(40));
                let (a0, a1) = (e.f(50).to_radians(), e.f(51).to_radians());
                let mut sweep = (a1 - a0).rem_euclid(TAU);
                if sweep < 1e-9 {
                    sweep = TAU;
                }
                if r > 0.0 {
                    let mut p = Path::new(c + v(a0.cos(), a0.sin()) * r, &name);
                    p.segs = arc_cubics(c, r, r, 0.0, a0, sweep);
                    self.emit(p, tf, e);
                }
            }
            "CIRCLE" => {
                let (c, r) = (v(e.f(10), e.f(20)), e.f(40));
                if r > 0.0 {
                    let mut p = Path::new(c + v(r, 0.0), &name);
                    p.segs = arc_cubics(c, r, r, 0.0, 0.0, TAU);
                    close_exact(&mut p);
                    self.emit(p, tf, e);
                }
            }
            "ELLIPSE" => {
                let c = v(e.f(10), e.f(20));
                let major = v(e.f(11), e.f(21));
                let rx = major.len();
                let ry = rx * e.f_or(40, 1.0);
                let phi = major.y.atan2(major.x);
                let t0 = e.f_or(41, 0.0);
                let t1 = e.f_or(42, TAU);
                let mut sweep = (t1 - t0).rem_euclid(TAU);
                if sweep < 1e-9 {
                    sweep = TAU;
                }
                if rx > 0.0 && ry > 0.0 {
                    let (s, co) = t0.sin_cos();
                    let (sp, cp) = phi.sin_cos();
                    let start = c + v(rx * co * cp - ry * s * sp, rx * co * sp + ry * s * cp);
                    let mut p = Path::new(start, &name);
                    p.segs = arc_cubics(c, rx, ry, phi, t0, sweep);
                    if (sweep - TAU).abs() < 1e-9 {
                        close_exact(&mut p);
                    }
                    self.emit(p, tf, e);
                }
            }
            "SPLINE" => {
                if let Some(p) = self.spline(e, &name) {
                    self.emit(p, tf, e);
                }
            }
            "INSERT" => {
                let bname = e.get(2).unwrap_or("");
                let Some(block) = self.blocks.get(bname) else { return };
                if depth > 16 {
                    return;
                }
                let (cols, rows) = (e.i(70).max(1), e.i(71).max(1));
                let (cs, rs) = (e.f(44), e.f(45));
                let rot = e.f(50);
                let base = Affine::scale(e.f_or(41, 1.0), e.f_or(42, 1.0)).then_after(&Affine::translate(-block.base.x, -block.base.y));
                for r in 0..rows {
                    for cidx in 0..cols {
                        let at = v(e.f(10), e.f(20));
                        let off = v(cs * cidx as f64, rs * r as f64);
                        let mut t = Affine::translate(at.x, at.y).then_after(&Affine::rotate(rot)).then_after(&Affine::translate(off.x, off.y)).then_after(&base);
                        if e.flipped() {
                            t = Affine::scale(-1.0, 1.0).then_after(&t);
                        }
                        let full = tf.then_after(&t);
                        for be in &block.entities {
                            self.entity(be, &full, layer, depth + 1);
                        }
                    }
                }
            }
            "VIEWPORT" | "ATTDEF" | "ATTRIB" => {}
            other => *self.skipped.entry(other.to_string()).or_default() += 1,
        }
    }

    fn spline(&mut self, e: &Entity, name: &str) -> Option<Path> {
        let deg = e.i(71).max(1) as usize;
        let knots = e.all(40);
        let weights = e.all(41);
        let ctrl: Vec<Vec2> = e.all(10).into_iter().zip(e.all(20)).map(|(x, y)| v(x, y)).collect();
        let fit: Vec<Vec2> = e.all(11).into_iter().zip(e.all(21)).map(|(x, y)| v(x, y)).collect();
        let closed_flag = e.i(70) & 1 == 1;
        let pts: Vec<Vec2> = if ctrl.len() > deg && knots.len() == ctrl.len() + deg + 1 {
            let w: Vec<f64> = if weights.len() == ctrl.len() { weights } else { vec![1.0; ctrl.len()] };
            let (u0, u1) = (knots[deg], knots[ctrl.len()]);
            let n = (ctrl.len() * 24).clamp(100, 4000);
            (0..=n).map(|i| de_boor(deg, &knots, &ctrl, &w, u0 + (u1 - u0) * i as f64 / n as f64)).collect()
        } else if fit.len() >= 2 {
            self.approx_splines += 1;
            let mut p = Path::new(fit[0], name);
            let closed = closed_flag && fit.len() > 2;
            let m = fit.len();
            let get = |i: isize| -> Vec2 {
                if closed {
                    fit[i.rem_euclid(m as isize) as usize]
                } else {
                    fit[i.clamp(0, m as isize - 1) as usize]
                }
            };
            let segs = if closed { m } else { m - 1 };
            for i in 0..segs as isize {
                let (p0, p1) = (get(i), get(i + 1));
                let c1 = p0 + (p1 - get(i - 1)) * (1.0 / 6.0);
                let c2 = p1 - (get(i + 2) - p0) * (1.0 / 6.0);
                p.cubic_to(c1, c2, p1);
            }
            p.closed = closed;
            return Some(p);
        } else {
            return None;
        };
        let closed = pts.len() > 2 && pts[0].dist(*pts.last().unwrap()) < self.spline_tol.max(1e-9);
        let mut p = fit_open(&pts, self.spline_tol, name);
        if closed {
            p.closed = true;
            close_exact(&mut p);
        }
        Some(p)
    }
}

fn close_exact(p: &mut Path) {
    let s = p.start;
    if let Some(Seg::Cubic(_, _, e) | Seg::Line(e)) = p.segs.last_mut() {
        *e = s;
    }
    p.closed = true;
}

/// A polyline whose vertices may carry bulges (tan of a quarter of the arc's angle, positive =
/// counter-clockwise) for the segment that follows them.
fn bulge_path(pts: &[(Vec2, f64)], closed: bool, name: &str) -> Option<Path> {
    if pts.len() < 2 {
        return None;
    }
    let mut p = Path::new(pts[0].0, name);
    let n = pts.len();
    let segs = if closed { n } else { n - 1 };
    for i in 0..segs {
        let (a, bulge) = pts[i];
        let b = pts[(i + 1) % n].0;
        if bulge.abs() < 1e-9 {
            p.line_to(b);
        } else {
            p.segs.extend(arc_through(a, b, 4.0 * bulge.atan()));
        }
    }
    p.closed = closed;
    if closed {
        close_exact(&mut p);
    }
    Some(p)
}

/// A point on a (rational) B-spline by de Boor's algorithm.
fn de_boor(deg: usize, knots: &[f64], ctrl: &[Vec2], w: &[f64], u: f64) -> Vec2 {
    let n = ctrl.len();
    let mut k = deg;
    while k + 1 < n && u >= knots[k + 1] {
        k += 1;
    }
    let mut d: Vec<(f64, f64, f64)> = (0..=deg).map(|j| {
        let i = k + j - deg;
        (ctrl[i].x * w[i], ctrl[i].y * w[i], w[i])
    }).collect();
    for r in 1..=deg {
        for j in (r..=deg).rev() {
            let i = k + j - deg;
            let den = knots[i + deg + 1 - r] - knots[i];
            let a = if den.abs() < 1e-15 { 0.0 } else { (u - knots[i]) / den };
            d[j] = (
                (1.0 - a) * d[j - 1].0 + a * d[j].0,
                (1.0 - a) * d[j - 1].1 + a * d[j].1,
                (1.0 - a) * d[j - 1].2 + a * d[j].2,
            );
        }
    }
    let (x, y, ww) = d[deg];
    v(x / ww, y / ww)
}

#[cfg(test)]
mod tests {
    use crate::geom::{cubic_point, Rect};
    use crate::import::{import_file, ImportOptions};
    use crate::model::EdgeKind;

    fn dxf(header_units: i32, entities: &str) -> String {
        format!("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n{header_units}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n{entities}0\nENDSEC\n0\nEOF\n")
    }

    /// A 4 x 2 inch card slot outline with rounded ends from LWPOLYLINE bulges (two half circles),
    /// plus a 0.25 inch circle hole.
    fn slot_card() -> String {
        let ent = "0\nLWPOLYLINE\n8\nCard\n90\n4\n70\n1\n\
10\n1\n20\n0\n\
10\n3\n20\n0\n42\n1\n\
10\n3\n20\n2\n\
10\n1\n20\n2\n42\n1\n\
0\nCIRCLE\n8\nCard\n10\n2\n20\n1\n40\n0.125\n";
        dxf(1, ent)
    }

    #[test]
    fn import_dxf_bulges_in_inches() {
        let r = import_file(slot_card().as_bytes(), "dxf", &ImportOptions::default()).unwrap();
        assert_eq!(r.pieces.len(), 1, "{:?}", r.warnings);
        let p = &r.pieces[0];
        assert_eq!(p.name, "Card");
        // Flatten the outline to measure it.
        let mut pts = vec![];
        for (i, e) in p.edges.iter().enumerate() {
            let a = p.vertices[i];
            let b = p.vertices[(i + 1) % p.vertices.len()];
            match e.kind {
                EdgeKind::Line => pts.push(a),
                EdgeKind::Cubic { c1, c2 } => pts.extend((0..20).map(|k| cubic_point(a, c1, c2, b, k as f64 / 20.0))),
            }
        }
        let bb = Rect::of(&pts);
        // 2 in straight + two 1 in radius half circles = 4 in long, 2 in tall.
        assert!((bb.width() - 101.6).abs() < 0.2, "{bb:?}");
        assert!((bb.height() - 50.8).abs() < 0.2, "{bb:?}");
        assert!(p.edges.iter().filter(|e| matches!(e.kind, EdgeKind::Cubic { .. })).count() >= 4);
        assert_eq!(p.holes.len(), 1);
        assert!((p.holes[0].diameter_mm - 6.35).abs() < 0.05);
        assert!(r.units_detected.starts_with("inches"));
        // Hole sits in the middle (y flipped: still the middle).
        assert!((p.holes[0].center.x - 50.8).abs() < 0.1 && (p.holes[0].center.y - 25.4).abs() < 0.1, "{:?}", p.holes[0].center);
    }

    #[test]
    fn import_dxf_line_soup_joins_and_folds() {
        // A 100 x 60 mm rectangle from four LINEs in mixed directions, a fold line across it,
        // an ARC hole made of two half arcs, and a TEXT that is left out.
        let ent = "0\nLINE\n8\nBody\n10\n0\n20\n0\n11\n100\n21\n0\n\
0\nLINE\n8\nBody\n10\n100\n20\n60\n11\n100\n21\n0\n\
0\nLINE\n8\nBody\n10\n100\n20\n60\n11\n0\n21\n60\n\
0\nLINE\n8\nBody\n10\n0\n20\n0\n11\n0\n21\n60\n\
0\nLINE\n8\nFold\n10\n0\n20\n30\n11\n100\n21\n30\n\
0\nARC\n8\nBody\n10\n20\n20\n15\n40\n3\n50\n0\n51\n180\n\
0\nARC\n8\nBody\n10\n20\n20\n15\n40\n3\n50\n180\n51\n360\n\
0\nTEXT\n8\nBody\n1\nhello\n";
        let r = import_file(dxf(4, ent).as_bytes(), "dxf", &ImportOptions::default()).unwrap();
        assert_eq!(r.pieces.len(), 1, "{:?}", r.warnings);
        let p = &r.pieces[0];
        let bb = Rect::of(&p.vertices);
        assert!((bb.width() - 100.0).abs() < 1e-6 && (bb.height() - 60.0).abs() < 1e-6);
        assert_eq!(p.folds.len(), 1);
        assert!((p.folds[0].position - 30.0).abs() < 1e-6);
        assert_eq!(p.holes.len(), 1);
        assert!((p.holes[0].diameter_mm - 6.0).abs() < 0.02);
        // y flipped: the hole at y = 15 (y up) is 45 mm down from the top.
        assert!((p.holes[0].center.y - 45.0).abs() < 0.05, "{:?}", p.holes[0].center);
        assert!(r.warnings.iter().any(|w| w.contains("TEXT")));
    }

    #[test]
    fn import_dxf_spline_and_insert() {
        // A closed cubic B-spline approximating a circle-ish blob, inserted twice at 2x scale.
        let mut blk = String::from("0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nB\n10\n0\n20\n0\n");
        blk += "0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n5\n10\n0\n20\n5\n";
        blk += "0\nENDBLK\n0\nENDSEC\n";
        let ent = "0\nINSERT\n8\nTabs\n2\nB\n10\n0\n20\n0\n41\n2\n42\n2\n\
0\nINSERT\n8\nTabs\n2\nB\n10\n50\n20\n0\n41\n2\n42\n2\n50\n90\n\
0\nSPLINE\n8\nCurve\n70\n8\n71\n3\n72\n8\n73\n4\n40\n0\n40\n0\n40\n0\n40\n0\n40\n1\n40\n1\n40\n1\n40\n1\n\
10\n0\n20\n100\n10\n30\n20\n130\n10\n60\n20\n130\n10\n90\n20\n100\n";
        let s = format!("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n{blk}0\nSECTION\n2\nENTITIES\n{ent}0\nENDSEC\n0\nEOF\n");
        let r = import_file(s.as_bytes(), "dxf", &ImportOptions::default()).unwrap();
        assert_eq!(r.pieces.len(), 2, "{:?}", r.warnings);
        let sizes: Vec<(f64, f64)> = r.pieces.iter().map(|p| { let b = Rect::of(&p.vertices); (b.width(), b.height()) }).collect();
        assert!(sizes.iter().any(|&(w, h)| (w - 20.0).abs() < 1e-6 && (h - 10.0).abs() < 1e-6), "{sizes:?}");
        assert!(sizes.iter().any(|&(w, h)| (w - 10.0).abs() < 1e-6 && (h - 20.0).abs() < 1e-6), "{sizes:?}");
        // The open spline is reported as a loose line; a single Bezier span refits to one cubic.
        assert_eq!(r.open_paths.len(), 1);
        let sp = &r.open_paths[0];
        assert!((sp[0].x - 0.0).abs() < 1e-6 && (sp.last().unwrap().x - 90.0).abs() < 1e-6);
    }
}
