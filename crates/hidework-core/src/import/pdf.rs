//! Vector PDF reader (lopdf, MIT): path operators (m l c v y h re), painting (S s f F f* B B* b b*
//! n), the transform stack (q Q cm) and form XObjects. Text, images and shadings are left out.
//! PDF units are points (1/72 inch), so a pattern printed "at 100%" comes in at true size. Each
//! page is placed to the right of the one before.

use super::{unit_mm, Affine, ImportOptions, Path};
use crate::geom::{v, Rect, Vec2};
use lopdf::{content::Content, Dictionary, Document, Object, Stream};

const MAX_CONTENT: usize = 64 << 20;

pub fn read(bytes: &[u8], opts: &ImportOptions, warnings: &mut Vec<String>) -> Result<(Vec<Path>, String), String> {
    let doc = Document::load_mem(bytes).map_err(|e| format!("This PDF could not be read ({e})."))?;
    if doc.is_encrypted() {
        return Err("This PDF is locked with a password. Save an unlocked copy and try again.".into());
    }
    let (k, units) = if opts.units.is_empty() {
        (25.4 / 72.0, "points (1/72 inch, the PDF standard)".to_string())
    } else {
        (unit_mm(&opts.units).ok_or_else(|| format!("Unknown unit {}", opts.units))?, format!("{} (as chosen)", opts.units))
    };
    let pages = doc.get_pages();
    let mut out = vec![];
    let mut x_off = 0.0;
    let mut st = Stats::default();
    let mut used_pages = 0;
    for (&num, &id) in &pages {
        if !opts.pages.is_empty() && !opts.pages.contains(&num) {
            continue;
        }
        used_pages += 1;
        let page = doc.get_dictionary(id).map_err(|e| e.to_string())?;
        let mb = inherited(&doc, page, b"MediaBox").and_then(|o| rect_of(&doc, o)).unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let uu = inherited(&doc, page, b"UserUnit").and_then(|o| o.as_float().ok()).map(|x| x as f64).unwrap_or(1.0);
        let kk = k * uu;
        let to_sheet = Affine { a: kk, b: 0.0, c: 0.0, d: -kk, e: x_off - kk * mb[0], f: kk * mb[3] };
        let page_mm = Rect { min: v(x_off, 0.0), max: v(x_off + (mb[2] - mb[0]) * kk, (mb[3] - mb[1]) * kk) };
        let content = doc.get_page_content_with_limit(id, MAX_CONTENT).map_err(|e| format!("Page {num} could not be read ({e})."))?;
        let ops = Content::decode(&content).map_err(|e| format!("Page {num} could not be read ({e})."))?;
        let (res_dict, res_ids) = doc.get_page_resources(id).unwrap_or((None, vec![]));
        let mut res: Vec<&Dictionary> = res_dict.into_iter().collect();
        res.extend(res_ids.iter().filter_map(|r| doc.get_dictionary(*r).ok()));
        let mut paths = vec![];
        run(&doc, &ops.operations, to_sheet, &res, 0, &mut paths, &mut st);
        // A rectangle covering the whole page is a background, not a piece.
        let before = paths.len();
        paths.retain(|p: &Path| {
            let b = p.bbox();
            !(p.closed && b.min.dist(page_mm.min) < 1.0 && b.max.dist(page_mm.max) < 1.0)
        });
        st.backgrounds += before - paths.len();
        out.extend(paths);
        x_off = page_mm.max.x + 20.0;
    }
    if used_pages == 0 {
        return Err("None of the chosen pages are in this PDF.".into());
    }
    if used_pages > 1 {
        warnings.push(format!("Read {used_pages} pages, placed side by side. A pattern tiled across pages will come in as separate parts."));
    }
    if st.text > 0 {
        warnings.push(format!("Left out {} block(s) of text.", st.text));
    }
    if st.images > 0 {
        warnings.push(format!("Left out {} picture(s) in the PDF; use \"A photo of my paper pattern\" for a scanned pattern.", st.images));
    }
    if st.backgrounds > 0 {
        warnings.push(format!("Left out {} page background(s).", st.backgrounds));
    }
    if out.is_empty() && st.images > 0 {
        warnings.push("This PDF holds only pictures (a scan), with no drawn lines to read.".into());
    }
    Ok((out, units))
}

#[derive(Default)]
struct Stats {
    text: usize,
    images: usize,
    backgrounds: usize,
}

fn inherited<'a>(doc: &'a Document, page: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    let mut node = page;
    for _ in 0..32 {
        if let Ok(o) = node.get(key) {
            return Some(o);
        }
        let parent = node.get(b"Parent").ok()?.as_reference().ok()?;
        node = doc.get_dictionary(parent).ok()?;
    }
    None
}

fn deref<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    doc.dereference(o).map(|(_, o)| o).unwrap_or(o)
}

fn rect_of(doc: &Document, o: &Object) -> Option<[f64; 4]> {
    let a = deref(doc, o).as_array().ok()?;
    let n: Vec<f64> = a.iter().filter_map(|x| deref(doc, x).as_float().ok()).map(|x| x as f64).collect();
    (n.len() == 4).then(|| [n[0].min(n[2]), n[1].min(n[3]), n[0].max(n[2]), n[1].max(n[3])])
}

fn xobject<'a>(doc: &'a Document, res: &[&'a Dictionary], name: &[u8]) -> Option<&'a Stream> {
    for d in res {
        let Ok(xo) = d.get(b"XObject") else { continue };
        let Ok(xo) = deref(doc, xo).as_dict() else { continue };
        if let Ok(s) = xo.get(name) {
            if let Ok(s) = deref(doc, s).as_stream() {
                return Some(s);
            }
        }
    }
    None
}

fn nums(ops: &[Object]) -> Vec<f64> {
    ops.iter().filter_map(|o| o.as_float().ok()).map(|x| x as f64).collect()
}

/// Interpret one content stream. `ctm` maps user space straight to sheet millimetres.
fn run(doc: &Document, ops: &[lopdf::content::Operation], ctm0: Affine, res: &[&Dictionary], depth: usize, out: &mut Vec<Path>, st: &mut Stats) {
    let mut ctm = ctm0;
    let mut stack: Vec<Affine> = vec![];
    let mut subs: Vec<Path> = vec![];
    let mut cur: Option<Path> = None;
    let mut start = Vec2::default();
    let mut last = Vec2::default();
    let finish = |cur: &mut Option<Path>, subs: &mut Vec<Path>| {
        if let Some(p) = cur.take() {
            if !p.segs.is_empty() {
                subs.push(p);
            }
        }
    };
    for op in ops {
        let n = nums(&op.operands);
        let g = |i: usize| n.get(i).copied().unwrap_or(0.0);
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(ctm0),
            "cm" if n.len() == 6 => ctm = ctm.then_after(&Affine { a: g(0), b: g(1), c: g(2), d: g(3), e: g(4), f: g(5) }),
            "m" => {
                finish(&mut cur, &mut subs);
                start = ctm.apply(v(g(0), g(1)));
                last = start;
                cur = Some(Path::new(start, ""));
            }
            "l" => {
                let p = ctm.apply(v(g(0), g(1)));
                cur.get_or_insert_with(|| Path::new(last, "")).line_to(p);
                last = p;
            }
            "c" => {
                let (c1, c2, p) = (ctm.apply(v(g(0), g(1))), ctm.apply(v(g(2), g(3))), ctm.apply(v(g(4), g(5))));
                cur.get_or_insert_with(|| Path::new(last, "")).cubic_to(c1, c2, p);
                last = p;
            }
            "v" => {
                let (c2, p) = (ctm.apply(v(g(0), g(1))), ctm.apply(v(g(2), g(3))));
                cur.get_or_insert_with(|| Path::new(last, "")).cubic_to(last, c2, p);
                last = p;
            }
            "y" => {
                let (c1, p) = (ctm.apply(v(g(0), g(1))), ctm.apply(v(g(2), g(3))));
                cur.get_or_insert_with(|| Path::new(last, "")).cubic_to(c1, p, p);
                last = p;
            }
            "h" => {
                if let Some(p) = cur.as_mut() {
                    p.closed = true;
                }
                finish(&mut cur, &mut subs);
                last = start;
            }
            "re" => {
                finish(&mut cur, &mut subs);
                let (x, y, w, h) = (g(0), g(1), g(2), g(3));
                let mut p = Path::new(ctm.apply(v(x, y)), "");
                p.line_to(ctm.apply(v(x + w, y)));
                p.line_to(ctm.apply(v(x + w, y + h)));
                p.line_to(ctm.apply(v(x, y + h)));
                p.line_to(p.start);
                p.closed = true;
                start = p.start;
                last = start;
                subs.push(p);
            }
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n" => {
                let o = op.operator.as_str();
                if o == "s" || o == "b" || o == "b*" {
                    if let Some(p) = cur.as_mut() {
                        p.closed = true;
                    }
                }
                finish(&mut cur, &mut subs);
                if o != "n" {
                    let fill = !matches!(o, "S" | "s");
                    for mut p in subs.drain(..) {
                        if fill && p.segs.len() >= 2 {
                            p.closed = true;
                        }
                        out.push(p);
                    }
                }
                subs.clear();
            }
            "BT" => st.text += 1,
            "Do" => {
                let Some(name) = op.operands.first().and_then(|o| o.as_name().ok()) else { continue };
                let Some(s) = xobject(doc, res, name) else { continue };
                match s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) {
                    Some(b"Form") if depth < 12 => {
                        let m = s.dict.get(b"Matrix").ok().map(|o| nums(deref(doc, o).as_array().map(|a| a.as_slice()).unwrap_or(&[]))).unwrap_or_default();
                        let mt = if m.len() == 6 { Affine { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] } } else { Affine::IDENTITY };
                        let mut inner: Vec<&Dictionary> = vec![];
                        if let Ok(r) = s.dict.get(b"Resources") {
                            if let Ok(d) = deref(doc, r).as_dict() {
                                inner.push(d);
                            }
                        }
                        inner.extend_from_slice(res);
                        let data = s.decompressed_content().unwrap_or_else(|_| s.content.clone());
                        if let Ok(c) = Content::decode(&data) {
                            run(doc, &c.operations, ctm.then_after(&mt), &inner, depth + 1, out, st);
                        }
                    }
                    Some(b"Image") => st.images += 1,
                    _ => {}
                }
            }
            "BI" | "EI" => st.images += 1,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::geom::Rect;
    use crate::import::{import_file, ImportOptions};
    use lopdf::{dictionary, Document, Object, Stream};

    fn pdf(content: &[u8]) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.to_vec()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        }));
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn import_pdf_true_size() {
        // A white page background, a clip, a 2 x 1 inch rectangle drawn with lines inside a
        // translated q/Q block, and an 18 pt (1/4 inch) circle filled inside it.
        let k = 9.0 * 0.552_284_75;
        let content = format!(
            "1 1 1 rg 0 0 612 792 re f 0 0 300 300 re W n \
             q 1 0 0 1 72 72 cm 0 0 m 144 0 l 144 72 l 0 72 l 0 0 l S Q \
             153 108 m 153 {a} {b} 117 144 117 c {c} 117 135 {a} 135 108 c 135 {d} {c} 99 144 99 c {b} 99 153 {d} 153 108 c f \
             BT /F1 12 Tf (hi) Tj ET",
            a = 108.0 + k, b = 144.0 + k, c = 144.0 - k, d = 108.0 - k
        );
        let r = import_file(&pdf(content.as_bytes()), "pdf", &ImportOptions::default()).unwrap();
        assert_eq!(r.pieces.len(), 1, "{:?}", r.warnings);
        let p = &r.pieces[0];
        let b = Rect::of(&p.vertices);
        assert!((b.width() - 50.8).abs() < 0.01 && (b.height() - 25.4).abs() < 0.01, "{b:?}");
        assert_eq!(p.holes.len(), 1);
        assert!((p.holes[0].diameter_mm - 6.35).abs() < 0.02, "{}", p.holes[0].diameter_mm);
        // 1 inch from the left, and the top of the rectangle is 792 - 144 pt down the page.
        assert!((p.position.x - 25.4).abs() < 0.01 && (p.position.y - 648.0 * 25.4 / 72.0).abs() < 0.01, "{:?}", p.position);
        assert!(r.warnings.iter().any(|w| w.contains("background")));
        assert!(r.warnings.iter().any(|w| w.contains("text")));
    }
}
