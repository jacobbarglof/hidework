//! SVG reader: paths (M L H V C S Q T A Z), rect, circle, ellipse, line, polyline, polygon, groups,
//! `use`, nested `svg`, transforms, and true size from width/height and viewBox (Inkscape writes
//! mm; plain pixels are 96 per inch, or 72 for Adobe Illustrator, which writes points as pixels).

use super::{arc_cubics, unit_mm, Affine, ImportOptions, Path, Seg};
use crate::geom::{v, Vec2};
use std::collections::HashMap;
use std::f64::consts::{FRAC_PI_2, PI, TAU};

const INKSCAPE: &str = "http://www.inkscape.org/namespaces/inkscape";
const SVG_NS: &str = "http://www.w3.org/2000/svg";

pub fn read(bytes: &[u8], opts: &ImportOptions, warnings: &mut Vec<String>) -> Result<(Vec<Path>, String), String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}');
    let po = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = roxmltree::Document::parse_with_options(text, po).map_err(|e| format!("This SVG file could not be read ({e})."))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" {
        return Err("This file is not an SVG drawing.".into());
    }
    let illustrator = text.contains("Adobe Illustrator") || text.contains("adobe.com/illustrator");
    let dpi = if opts.svg_dpi > 0.0 { opts.svg_dpi } else if illustrator { 72.0 } else { 96.0 };
    let px_mm = 25.4 / dpi;
    let vb = root.attribute("viewBox").and_then(parse_viewbox);
    let width = root.attribute("width").and_then(parse_length);
    let height = root.attribute("height").and_then(parse_length);
    let to_mm = |l: (f64, &str)| -> Option<f64> {
        match l.1 {
            "" | "px" => Some(l.0 * px_mm),
            "%" => None,
            u => unit_mm(u).map(|k| l.0 * k),
        }
    };
    let (root_tf, units) = if !opts.units.is_empty() {
        let k = unit_mm(&opts.units).ok_or_else(|| format!("Unknown unit {}", opts.units))?;
        let (x, y) = vb.map(|b| (b[0], b[1])).unwrap_or((0.0, 0.0));
        (Affine::scale(k, k).then_after(&Affine::translate(-x, -y)), format!("{} (as chosen)", opts.units))
    } else {
        match (vb, width.and_then(|w| to_mm(w).map(|m| (m, w.1)))) {
            (Some(b), Some((wmm, wunit))) if b[2] > 0.0 && b[3] > 0.0 => {
                let hmm = height.and_then(to_mm).unwrap_or(wmm * b[3] / b[2]);
                let (mut sx, mut sy) = (wmm / b[2], hmm / b[3]);
                let (mut ox, mut oy) = (0.0, 0.0);
                let par = root.attribute("preserveAspectRatio").unwrap_or("");
                if (sx - sy).abs() > 1e-9 * sx && !par.contains("none") {
                    let s = sx.min(sy);
                    ox = (wmm - b[2] * s) / 2.0;
                    oy = (hmm - b[3] * s) / 2.0;
                    sx = s;
                    sy = s;
                }
                let tf = Affine::translate(ox, oy).then_after(&Affine::scale(sx, sy)).then_after(&Affine::translate(-b[0], -b[1]));
                let unit = if wunit.is_empty() || wunit == "px" { format!("px at {dpi} per inch") } else { wunit.to_string() };
                (tf, format!("{unit} (from the file's width and viewBox)"))
            }
            (Some(b), None) => (
                Affine::scale(px_mm, px_mm).then_after(&Affine::translate(-b[0], -b[1])),
                format!("px at {dpi} per inch (the file gives no page size)"),
            ),
            _ => (Affine::scale(px_mm, px_mm), format!("px at {dpi} per inch")),
        }
    };
    if illustrator && opts.svg_dpi <= 0.0 && opts.units.is_empty() {
        warnings.push("This SVG came from Adobe Illustrator, which counts 72 pixels per inch; it was read that way. Check one measurement.".into());
    }
    let mut ids: HashMap<&str, roxmltree::Node> = HashMap::new();
    for n in doc.descendants().filter(|n| n.is_element()) {
        if let Some(id) = n.attribute("id") {
            ids.insert(id, n);
        }
    }
    let mut cx = Ctx { ids, paths: vec![], text: 0, images: 0, hidden: 0 };
    for child in root.children() {
        walk(child, &root_tf, "", 0, &mut cx);
    }
    if cx.text > 0 {
        warnings.push(format!("Left out {} of text (convert text to paths to bring it in).", if cx.text == 1 { "1 piece".to_string() } else { format!("{} pieces", cx.text) }));
    }
    if cx.images > 0 {
        warnings.push(format!("Left out {} picture(s) in the file; use \"A photo of my paper pattern\" for those.", cx.images));
    }
    if cx.hidden > 0 {
        warnings.push(format!("Left out {} hidden layer(s) or shape(s).", cx.hidden));
    }
    Ok((cx.paths, units))
}

struct Ctx<'a, 'i> {
    ids: HashMap<&'a str, roxmltree::Node<'a, 'i>>,
    paths: Vec<Path>,
    text: usize,
    images: usize,
    hidden: usize,
}

fn hidden(n: &roxmltree::Node) -> bool {
    if n.attribute("display") == Some("none") || n.attribute("visibility") == Some("hidden") {
        return true;
    }
    let style: String = n.attribute("style").unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
    style.contains("display:none") || style.contains("visibility:hidden")
}

/// A useful name: an Inkscape label, or an id that is not an automatic one like `path123`.
fn label(n: &roxmltree::Node) -> Option<String> {
    if let Some(l) = n.attribute((INKSCAPE, "label")) {
        if !l.trim().is_empty() {
            return Some(l.trim().to_string());
        }
    }
    let id = n.attribute("id")?;
    let base = id.trim_end_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_');
    let auto = ["path", "rect", "circle", "ellipse", "polygon", "polyline", "line", "g", "layer", "Layer", "svg", "use", "shape", "Shape", "Group", "group", "Path"];
    if base.is_empty() || auto.contains(&base) {
        return None;
    }
    // Illustrator writes underscores as `_x5F_` and spaces as `_`.
    Some(id.replace("_x5F_", "\u{1}").replace('_', " ").replace('\u{1}', "_").trim().to_string())
}

fn walk(n: roxmltree::Node, ctm: &Affine, name: &str, depth: usize, cx: &mut Ctx) {
    if !n.is_element() || depth > 64 {
        return;
    }
    match n.tag_name().namespace() {
        None | Some(SVG_NS) => {}
        _ => return,
    }
    if hidden(&n) {
        cx.hidden += 1;
        return;
    }
    let tag = n.tag_name().name();
    let tf = ctm.then_after(&n.attribute("transform").map(parse_transform).unwrap_or(Affine::IDENTITY));
    let own = label(&n);
    let name_here = own.clone().unwrap_or_else(|| name.to_string());
    match tag {
        "g" | "a" | "switch" => {
            for c in n.children() {
                walk(c, &tf, &name_here, depth + 1, cx);
            }
        }
        "svg" => {
            let (x, y) = (num_attr(&n, "x"), num_attr(&n, "y"));
            let mut t = tf.then_after(&Affine::translate(x, y));
            if let Some(b) = n.attribute("viewBox").and_then(parse_viewbox) {
                let w = n.attribute("width").and_then(parse_length).map(|l| l.0).unwrap_or(b[2]);
                let h = n.attribute("height").and_then(parse_length).map(|l| l.0).unwrap_or(b[3]);
                if b[2] > 0.0 && b[3] > 0.0 {
                    t = t.then_after(&Affine::scale(w / b[2], h / b[3])).then_after(&Affine::translate(-b[0], -b[1]));
                }
            }
            for c in n.children() {
                walk(c, &t, &name_here, depth + 1, cx);
            }
        }
        "use" => {
            let href = n.attribute(("http://www.w3.org/1999/xlink", "href")).or_else(|| n.attribute("href")).unwrap_or("");
            if let Some(target) = href.strip_prefix('#').and_then(|id| cx.ids.get(id).copied()) {
                let t = tf.then_after(&Affine::translate(num_attr(&n, "x"), num_attr(&n, "y")));
                if target.tag_name().name() == "symbol" {
                    for c in target.children() {
                        walk(c, &t, &name_here, depth + 1, cx);
                    }
                } else {
                    walk(target, &t, &name_here, depth + 1, cx);
                }
            }
        }
        "text" => cx.text += 1,
        "image" => cx.images += 1,
        "path" | "rect" | "circle" | "ellipse" | "line" | "polyline" | "polygon" => {
            for p in shape_paths(&n, tag, &name_here) {
                cx.paths.push(p.transformed(&tf));
            }
        }
        _ => {}
    }
}

fn num_attr(n: &roxmltree::Node, a: &str) -> f64 {
    n.attribute(a).and_then(parse_length).map(|(x, u)| x * user_units(u)).unwrap_or(0.0)
}

/// User units (CSS pixels) per unit, for lengths written with a unit inside the drawing.
fn user_units(u: &str) -> f64 {
    match u {
        "" | "px" | "%" => 1.0,
        u => unit_mm(u).map(|k| k * 96.0 / 25.4).unwrap_or(1.0),
    }
}

fn shape_paths(n: &roxmltree::Node, tag: &str, name: &str) -> Vec<Path> {
    let a = |k: &str| num_attr(n, k);
    match tag {
        "path" => parse_path(n.attribute("d").unwrap_or(""), name),
        "rect" => {
            let (x, y, w, h) = (a("x"), a("y"), a("width"), a("height"));
            if w <= 0.0 || h <= 0.0 {
                return vec![];
            }
            let (mut rx, mut ry) = (a("rx"), a("ry"));
            if n.attribute("rx").is_none() {
                rx = ry;
            }
            if n.attribute("ry").is_none() {
                ry = rx;
            }
            let (rx, ry) = (rx.clamp(0.0, w / 2.0), ry.clamp(0.0, h / 2.0));
            let mut p = Path::new(v(x + rx, y), name);
            p.closed = true;
            if rx > 0.0 && ry > 0.0 {
                p.line_to(v(x + w - rx, y));
                p.segs.extend(arc_cubics(v(x + w - rx, y + ry), rx, ry, 0.0, -FRAC_PI_2, FRAC_PI_2));
                p.line_to(v(x + w, y + h - ry));
                p.segs.extend(arc_cubics(v(x + w - rx, y + h - ry), rx, ry, 0.0, 0.0, FRAC_PI_2));
                p.line_to(v(x + rx, y + h));
                p.segs.extend(arc_cubics(v(x + rx, y + h - ry), rx, ry, 0.0, FRAC_PI_2, FRAC_PI_2));
                p.line_to(v(x, y + ry));
                p.segs.extend(arc_cubics(v(x + rx, y + ry), rx, ry, 0.0, PI, FRAC_PI_2));
            } else {
                p.line_to(v(x + w, y));
                p.line_to(v(x + w, y + h));
                p.line_to(v(x, y + h));
                p.line_to(v(x, y));
            }
            vec![p]
        }
        "circle" | "ellipse" => {
            let (cx, cy) = (a("cx"), a("cy"));
            let (rx, ry) = if tag == "circle" { (a("r"), a("r")) } else { (a("rx"), a("ry")) };
            if rx <= 0.0 || ry <= 0.0 {
                return vec![];
            }
            let mut p = Path::new(v(cx + rx, cy), name);
            p.closed = true;
            p.segs = arc_cubics(v(cx, cy), rx, ry, 0.0, 0.0, TAU);
            if let Some(Seg::Cubic(_, _, e)) = p.segs.last_mut() {
                *e = p.start;
            }
            vec![p]
        }
        "line" => {
            let mut p = Path::new(v(a("x1"), a("y1")), name);
            p.line_to(v(a("x2"), a("y2")));
            vec![p]
        }
        _ => {
            let nums = numbers(n.attribute("points").unwrap_or(""));
            let pts: Vec<Vec2> = nums.chunks_exact(2).map(|c| v(c[0], c[1])).collect();
            if pts.len() < 2 {
                return vec![];
            }
            let mut p = Path::new(pts[0], name);
            for &q in &pts[1..] {
                p.line_to(q);
            }
            p.closed = tag == "polygon";
            vec![p]
        }
    }
}

fn numbers(s: &str) -> Vec<f64> {
    let mut lx = Lexer { s: s.as_bytes(), i: 0 };
    let mut out = vec![];
    while let Some(x) = lx.number() {
        out.push(x);
    }
    out
}

fn parse_viewbox(s: &str) -> Option<[f64; 4]> {
    let n = numbers(s);
    (n.len() == 4).then(|| [n[0], n[1], n[2], n[3]])
}

/// A length and its unit (`""` for none).
fn parse_length(s: &str) -> Option<(f64, &str)> {
    let s = s.trim();
    let end = s.find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))).unwrap_or(s.len());
    // An exponent "e" belongs to the number only when digits follow; "em"/"ex" units start with e.
    let (mut num, mut unit) = s.split_at(end);
    if num.ends_with(['e', 'E']) {
        num = &s[..end - 1];
        unit = &s[end - 1..];
    }
    let x: f64 = num.parse().ok()?;
    Some((x, unit.trim()))
}

pub(crate) fn parse_transform(s: &str) -> Affine {
    let mut tf = Affine::IDENTITY;
    let mut rest = s;
    while let Some(open) = rest.find('(') {
        let name = rest[..open].trim_matches(|c: char| c.is_whitespace() || c == ',');
        let Some(close) = rest[open..].find(')') else { break };
        let args = numbers(&rest[open + 1..open + close]);
        let g = |i: usize| args.get(i).copied().unwrap_or(0.0);
        let t = match name {
            "matrix" if args.len() == 6 => Affine { a: g(0), b: g(1), c: g(2), d: g(3), e: g(4), f: g(5) },
            "translate" => Affine::translate(g(0), g(1)),
            "scale" => Affine::scale(g(0), if args.len() > 1 { g(1) } else { g(0) }),
            "rotate" => {
                let r = Affine::rotate(g(0));
                if args.len() >= 3 {
                    Affine::translate(g(1), g(2)).then_after(&r).then_after(&Affine::translate(-g(1), -g(2)))
                } else {
                    r
                }
            }
            "skewX" => Affine { c: g(0).to_radians().tan(), ..Affine::IDENTITY },
            "skewY" => Affine { b: g(0).to_radians().tan(), ..Affine::IDENTITY },
            _ => Affine::IDENTITY,
        };
        tf = tf.then_after(&t);
        rest = &rest[open + close + 1..];
    }
    tf
}

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
}

impl Lexer<'_> {
    fn skip(&mut self) {
        while self.i < self.s.len() && (self.s[self.i].is_ascii_whitespace() || self.s[self.i] == b',') {
            self.i += 1;
        }
    }
    fn command(&mut self) -> Option<u8> {
        self.skip();
        let c = *self.s.get(self.i)?;
        if c.is_ascii_alphabetic() && c != b'e' && c != b'E' {
            self.i += 1;
            Some(c)
        } else {
            None
        }
    }
    fn at_number(&mut self) -> bool {
        self.skip();
        matches!(self.s.get(self.i), Some(c) if c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.'))
    }
    fn number(&mut self) -> Option<f64> {
        if !self.at_number() {
            return None;
        }
        let st = self.i;
        let s = self.s;
        if matches!(s[self.i], b'-' | b'+') {
            self.i += 1;
        }
        while self.i < s.len() && s[self.i].is_ascii_digit() {
            self.i += 1;
        }
        if self.i < s.len() && s[self.i] == b'.' {
            self.i += 1;
            while self.i < s.len() && s[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        if self.i < s.len() && matches!(s[self.i], b'e' | b'E') {
            let save = self.i;
            self.i += 1;
            if self.i < s.len() && matches!(s[self.i], b'-' | b'+') {
                self.i += 1;
            }
            if self.i < s.len() && s[self.i].is_ascii_digit() {
                while self.i < s.len() && s[self.i].is_ascii_digit() {
                    self.i += 1;
                }
            } else {
                self.i = save;
            }
        }
        std::str::from_utf8(&s[st..self.i]).ok()?.parse().ok().or_else(|| {
            self.i = st + 1;
            None
        })
    }
    fn flag(&mut self) -> Option<bool> {
        self.skip();
        let c = *self.s.get(self.i)?;
        if c == b'0' || c == b'1' {
            self.i += 1;
            Some(c == b'1')
        } else {
            None
        }
    }
    fn pair(&mut self) -> Option<Vec2> {
        let x = self.number()?;
        let y = self.number()?;
        Some(v(x, y))
    }
}

/// Path data to subpaths (user units).
pub(crate) fn parse_path(d: &str, name: &str) -> Vec<Path> {
    let mut lx = Lexer { s: d.as_bytes(), i: 0 };
    let mut out: Vec<Path> = vec![];
    let mut cur = Path::new(v(0.0, 0.0), name);
    let (mut pos, mut start) = (v(0.0, 0.0), v(0.0, 0.0));
    let mut last_c: Option<Vec2> = None;
    let mut last_q: Option<Vec2> = None;
    let mut cmd = 0u8;
    let flush = |cur: &mut Path, out: &mut Vec<Path>, at: Vec2| {
        if !cur.segs.is_empty() {
            out.push(std::mem::replace(cur, Path::new(at, name)));
        } else {
            cur.start = at;
        }
    };
    loop {
        if let Some(c) = lx.command() {
            cmd = c;
        } else if !lx.at_number() {
            break;
        } else if cmd == 0 {
            break;
        }
        let rel = cmd.is_ascii_lowercase();
        let base = if rel { pos } else { v(0.0, 0.0) };
        let (mut nc, mut nq) = (None, None);
        match cmd.to_ascii_uppercase() {
            b'M' => {
                let Some(p) = lx.pair() else { break };
                pos = base + p;
                start = pos;
                flush(&mut cur, &mut out, pos);
                cur.closed = false;
                // Further pairs are line-tos.
                cmd = if rel { b'l' } else { b'L' };
            }
            b'Z' => {
                if !cur.segs.is_empty() {
                    cur.closed = true;
                }
                pos = start;
                flush(&mut cur, &mut out, pos);
                cmd = 0;
            }
            b'L' => {
                let Some(p) = lx.pair() else { break };
                pos = base + p;
                cur.line_to(pos);
            }
            b'H' => {
                let Some(x) = lx.number() else { break };
                pos = v(if rel { pos.x + x } else { x }, pos.y);
                cur.line_to(pos);
            }
            b'V' => {
                let Some(y) = lx.number() else { break };
                pos = v(pos.x, if rel { pos.y + y } else { y });
                cur.line_to(pos);
            }
            b'C' => {
                let (Some(c1), Some(c2), Some(p)) = (lx.pair(), lx.pair(), lx.pair()) else { break };
                cur.cubic_to(base + c1, base + c2, base + p);
                nc = Some(base + c2);
                pos = base + p;
            }
            b'S' => {
                let (Some(c2), Some(p)) = (lx.pair(), lx.pair()) else { break };
                let c1 = last_c.map(|c| pos * 2.0 - c).unwrap_or(pos);
                cur.cubic_to(c1, base + c2, base + p);
                nc = Some(base + c2);
                pos = base + p;
            }
            b'Q' => {
                let (Some(q), Some(p)) = (lx.pair(), lx.pair()) else { break };
                let (q, p) = (base + q, base + p);
                cur.cubic_to(pos + (q - pos) * (2.0 / 3.0), p + (q - p) * (2.0 / 3.0), p);
                nq = Some(q);
                pos = p;
            }
            b'T' => {
                let Some(p) = lx.pair() else { break };
                let q = last_q.map(|c| pos * 2.0 - c).unwrap_or(pos);
                let p = base + p;
                cur.cubic_to(pos + (q - pos) * (2.0 / 3.0), p + (q - p) * (2.0 / 3.0), p);
                nq = Some(q);
                pos = p;
            }
            b'A' => {
                let (Some(rx), Some(ry), Some(rot)) = (lx.number(), lx.number(), lx.number()) else { break };
                let (Some(large), Some(sweep)) = (lx.flag(), lx.flag()) else { break };
                let Some(p) = lx.pair() else { break };
                let p = base + p;
                cur.segs.extend(svg_arc(pos, p, rx, ry, rot, large, sweep));
                pos = p;
            }
            _ => break,
        }
        last_c = nc;
        last_q = nq;
    }
    if !cur.segs.is_empty() {
        out.push(cur);
    }
    out
}

/// SVG endpoint arc (spec section F.6.5) as cubics.
fn svg_arc(p1: Vec2, p2: Vec2, rx: f64, ry: f64, rot_deg: f64, large: bool, sweep: bool) -> Vec<Seg> {
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx < 1e-12 || ry < 1e-12 || p1.dist(p2) < 1e-12 {
        return vec![Seg::Line(p2)];
    }
    let phi = rot_deg.to_radians();
    let (sp, cp) = phi.sin_cos();
    let dx = (p1.x - p2.x) / 2.0;
    let dy = (p1.y - p2.y) / 2.0;
    let x1 = cp * dx + sp * dy;
    let y1 = -sp * dx + cp * dy;
    let lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
    if lam > 1.0 {
        rx *= lam.sqrt();
        ry *= lam.sqrt();
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut coef = (num / den).max(0.0).sqrt();
    if large == sweep {
        coef = -coef;
    }
    let cxp = coef * rx * y1 / ry;
    let cyp = -coef * ry * x1 / rx;
    let c = v(cp * cxp - sp * cyp + (p1.x + p2.x) / 2.0, sp * cxp + cp * cyp + (p1.y + p2.y) / 2.0);
    let ang = |ux: f64, uy: f64, vx: f64, vy: f64| (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    let t1 = ang(1.0, 0.0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let mut dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if !sweep && dt > 0.0 {
        dt -= TAU;
    } else if sweep && dt < 0.0 {
        dt += TAU;
    }
    let mut segs = arc_cubics(c, rx, ry, phi, t1, dt);
    if let Some(Seg::Cubic(_, _, e)) = segs.last_mut() {
        *e = p2;
    }
    segs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::{import_file, ImportOptions};
    use crate::model::EdgeKind;

    /// An Inkscape-style wallet outline in mm: 100 x 80 with one rounded corner (radius 10, an
    /// arc), two 4 mm holes, inside a translated layer.
    const WALLET: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     width="140mm" height="120mm" viewBox="0 0 140 120">
  <g inkscape:groupmode="layer" inkscape:label="Pattern" transform="translate(20,20)">
    <path inkscape:label="Wallet outer" d="M 0,0 H 90 A 10 10 0 0 1 100,10 V 80 H 0 Z" style="fill:none;stroke:#000"/>
    <circle cx="20" cy="40" r="2"/>
    <circle cx="80" cy="40" r="2"/>
  </g>
  <text x="10" y="110">Wallet</text>
</svg>"##;

    #[test]
    fn import_svg_wallet_true_size() {
        let r = import_file(WALLET.as_bytes(), "svg", &ImportOptions::default()).unwrap();
        assert_eq!(r.pieces.len(), 1, "{:?}", r.warnings);
        let p = &r.pieces[0];
        assert_eq!(p.name, "Wallet outer");
        let bb = crate::geom::Rect::of(&p.vertices);
        assert!((bb.width() - 100.0).abs() < 0.2 && (bb.height() - 80.0).abs() < 0.2, "{bb:?}");
        assert!((p.position.x - 20.0).abs() < 0.2 && (p.position.y - 20.0).abs() < 0.2);
        assert!(p.edges.iter().any(|e| matches!(e.kind, EdgeKind::Cubic { .. })));
        assert_eq!(p.holes.len(), 2);
        for h in &p.holes {
            assert!((h.diameter_mm - 4.0).abs() < 0.05, "{}", h.diameter_mm);
        }
        assert!((p.holes[0].center.y - 40.0).abs() < 0.05);
        assert!(r.units_detected.starts_with("mm"), "{}", r.units_detected);
        assert!(r.warnings.iter().any(|w| w.contains("text")));
        // The arc stays round: the corner point at 45 degrees is 10 mm from the arc centre.
        let c = crate::geom::v(90.0, 10.0);
        let k = p.edges.iter().position(|e| matches!(e.kind, EdgeKind::Cubic { .. })).unwrap();
        if let EdgeKind::Cubic { c1, c2 } = p.edges[k].kind {
            let q = crate::geom::cubic_point(p.vertices[k], c1, c2, p.vertices[(k + 1) % p.vertices.len()], 0.5);
            assert!((q.dist(c) - 10.0).abs() < 0.01, "{q:?}");
        }
    }

    #[test]
    fn import_svg_pixels_and_transforms() {
        // 96 px = 1 inch; a rotated rectangle keeps its size; relative commands and a quadratic.
        let s = r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
            <rect x="10" y="10" width="96" height="48" transform="rotate(90 58 34)"/>
            <path d="m200 200 l96 0 q48 48 0 96 l-96 0 z"/>
        </svg>"#;
        let r = import_file(s.as_bytes(), "svg", &ImportOptions::default()).unwrap();
        assert_eq!(r.pieces.len(), 2);
        let sizes: Vec<(f64, f64)> = r.pieces.iter().map(|p| {
            let b = crate::geom::Rect::of(&p.vertices);
            (b.width(), b.height())
        }).collect();
        assert!(sizes.iter().any(|&(w, h)| (w - 12.7).abs() < 0.05 && (h - 25.4).abs() < 0.05), "{sizes:?}");
        assert!(r.units_detected.contains("96"));
    }

    #[test]
    fn import_svg_path_lexer_edge_cases() {
        // Packed numbers and arc flags without separators.
        let p = parse_path("M0,0L10-5.5.5 1e1 2,3a5 5 0 01 10 0z", "x");
        assert_eq!(p.len(), 1);
        assert!(p[0].closed);
        assert_eq!(p[0].segs[0], Seg::Line(v(10.0, -5.5)));
        assert_eq!(p[0].segs[1], Seg::Line(v(0.5, 10.0)));
        assert_eq!(p[0].segs[2], Seg::Line(v(2.0, 3.0)));
        assert!(p[0].end().dist(v(12.0, 3.0)) < 1e-9);
        let t = parse_transform("translate(10) scale(2)");
        assert_eq!(t.apply(v(1.0, 1.0)), v(12.0, 2.0));
    }

    #[test]
    fn import_svg_illustrator_points() {
        let s = r#"<?xml version="1.0"?><!-- Generator: Adobe Illustrator 27.0.0 -->
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792"><rect x="72" y="72" width="72" height="144"/></svg>"#;
        let r = import_file(s.as_bytes(), "svg", &ImportOptions::default()).unwrap();
        let b = crate::geom::Rect::of(&r.pieces[0].vertices);
        assert!((b.width() - 25.4).abs() < 0.01 && (b.height() - 50.8).abs() < 0.01, "{b:?}");
    }
}
