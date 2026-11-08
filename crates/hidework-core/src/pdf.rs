//! True-scale PDF export on Letter or A4 pages, either re-arranged onto the fewest pages
//! (`print`, see `crate::print`) or as drawn, tiled with trim frames and page labels (`to_pdf`).
//! A minimal hand-written PDF 1.4 writer: vector paths and the built-in Helvetica fonts only.

use crate::compute::ComputedProject;
use crate::model::Project;
use crate::print::{PrintLayout, Printout};
use crate::sheet::{spec, text_width, Align, Shape, Sheet, Style};
use serde::{Deserialize, Serialize};
use std::fmt::Write;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageSize {
    Letter,
    A4,
}

impl PageSize {
    pub fn mm(self) -> (f64, f64) {
        match self {
            PageSize::Letter => (215.9, 279.4),
            PageSize::A4 => (210.0, 297.0),
        }
    }
}

/// Unprinted border on each page; most printers cannot print the outer 5 to 6 mm.
pub const PAGE_MARGIN_MM: f64 = 12.0;
const PT: f64 = 72.0 / 25.4;

pub struct Tiling {
    pub cols: usize,
    pub rows: usize,
    pub tile_w: f64,
    pub tile_h: f64,
}

pub fn tiling(sheet: &Sheet, page: PageSize) -> Tiling {
    let (pw, ph) = page.mm();
    let tile_w = pw - 2.0 * PAGE_MARGIN_MM;
    let tile_h = ph - 2.0 * PAGE_MARGIN_MM;
    let cols = ((sheet.width / tile_w) - 1e-6).ceil().max(1.0) as usize;
    let rows = ((sheet.height / tile_h) - 1e-6).ceil().max(1.0) as usize;
    Tiling { cols, rows, tile_w, tile_h }
}

/// Encode text for WinAnsi Helvetica: Latin-1 passes through, anything else becomes '?'.
fn pdf_text(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for ch in s.chars() {
        let b = match ch {
            '\u{2013}' | '\u{2014}' => b'-',
            '\u{2019}' => b'\'',
            c if (c as u32) < 256 => c as u32 as u8,
            _ => b'?',
        };
        if matches!(b, b'(' | b')' | b'\\') {
            out.push(b'\\');
        }
        out.push(b);
    }
    out
}

fn text_op(buf: &mut Vec<u8>, x: f64, y: f64, size: f64, bold: bool, text: &str, align: Align) {
    text_op_turned(buf, x, y, size, bold, text, align, 0.0);
}

/// Text whose baseline is turned `angle` degrees clockwise on the page.
#[allow(clippy::too_many_arguments)]
fn text_op_turned(buf: &mut Vec<u8>, x: f64, y: f64, size: f64, bold: bool, text: &str, align: Align, angle: f64) {
    let (c, s) = (angle.to_radians().cos(), angle.to_radians().sin());
    let shift = if align == Align::Center { text_width(text, size, bold) / 2.0 } else { 0.0 };
    let (x, y) = (x - c * shift, y - s * shift);
    let font = if bold { "F2" } else { "F1" };
    // Page space is y down, so the glyphs' up direction is (sin, -cos).
    let _ = write!(Bytes(buf), "BT /{font} {size:.3} Tf {c:.6} {s:.6} {s:.6} {:.6} {x:.3} {y:.3} Tm (", -c);
    buf.extend(pdf_text(text));
    buf.extend_from_slice(b") Tj ET\n");
}

struct Bytes<'a>(&'a mut Vec<u8>);
impl Write for Bytes<'_> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.0.extend_from_slice(s.as_bytes());
        Ok(())
    }
}

fn stroke_setup(buf: &mut Vec<u8>, style: Style) {
    let st = spec(style);
    let dash: Vec<String> = st.dash.iter().map(|d| format!("{d}")).collect();
    let _ = writeln!(Bytes(buf), "{:.3} w {:.3} G {:.3} g [{}] 0 d", st.width_mm.max(0.05), st.gray, st.gray, dash.join(" "));
}

fn shapes_op(buf: &mut Vec<u8>, shapes: &[Shape]) {
    const K: f64 = 0.552_284_75;
    for shape in shapes {
        match shape {
            Shape::Poly { pts, closed, style } => {
                if pts.len() < 2 {
                    continue;
                }
                stroke_setup(buf, *style);
                let mut w = Bytes(buf);
                let _ = write!(w, "{:.3} {:.3} m ", pts[0].x, pts[0].y);
                for p in &pts[1..] {
                    let _ = write!(w, "{:.3} {:.3} l ", p.x, p.y);
                }
                let _ = writeln!(w, "{}", if *closed { "s" } else { "S" });
            }
            Shape::Circle { c, r, style, filled } => {
                stroke_setup(buf, *style);
                let (x, y, r) = (c.x, c.y, *r);
                let k = K * r;
                let _ = writeln!(
                    Bytes(buf),
                    "{:.3} {y:.3} m {:.3} {:.3} {:.3} {:.3} {x:.3} {:.3} c {:.3} {:.3} {:.3} {:.3} {:.3} {y:.3} c {:.3} {:.3} {:.3} {:.3} {x:.3} {:.3} c {:.3} {:.3} {:.3} {:.3} {:.3} {y:.3} c {}",
                    x + r,
                    x + r, y + k, x + k, y + r, y + r,
                    x - k, y + r, x - r, y + k, x - r,
                    x - r, y - k, x - k, y - r, y - r,
                    x + k, y - r, x + r, y - k, x + r,
                    if *filled { "f" } else { "s" }
                );
            }
            Shape::Text { at, size, text, align, bold, angle } => {
                let _ = writeln!(Bytes(buf), "0 g");
                text_op_turned(buf, at.x, at.y, *size, *bold, text, *align, *angle);
            }
        }
    }
}

fn page_content(sheet: &Sheet, page: PageSize, t: &Tiling, row: usize, col: usize) -> Vec<u8> {
    let (pw, ph) = page.mm();
    let m = PAGE_MARGIN_MM;
    let n = t.cols * t.rows;
    let index = row * t.cols + col + 1;
    let mut b = Vec::new();
    // Millimetres, origin top-left, y down.
    let _ = writeln!(Bytes(&mut b), "q {PT:.6} 0 0 {:.6} 0 {:.4} cm 1 J 1 j", -PT, ph * PT);
    let _ = writeln!(Bytes(&mut b), "q {m} {m} {:.3} {:.3} re W n", t.tile_w, t.tile_h);
    let _ = writeln!(Bytes(&mut b), "1 0 0 1 {:.3} {:.3} cm", m - col as f64 * t.tile_w, m - row as f64 * t.tile_h);
    shapes_op(&mut b, &sheet.shapes);
    b.extend_from_slice(b"Q\n");
    frame_op(&mut b, (pw, ph), (t.tile_w, t.tile_h));
    let mut label = format!("Page {index} of {n}  (row {}, column {})", row + 1, col + 1);
    if col + 1 < t.cols {
        let _ = write!(label, "   Right: page {}", index + 1);
    }
    if row + 1 < t.rows {
        let _ = write!(label, "   Below: page {}", index + t.cols);
    }
    let _ = writeln!(Bytes(&mut b), "0 g");
    text_op(&mut b, m, m - 4.0, 3.0, true, &label, Align::Left);
    text_op(
        &mut b,
        m,
        ph - m + 6.5,
        2.6,
        false,
        "Print at Actual size (100%). Trim one page on its frame line and tape it over the next so the frames meet.",
        Align::Left,
    );
    b.extend_from_slice(b"Q\n");
    b
}

/// Trim frame round the printable area, and corner ticks.
fn frame_op(b: &mut Vec<u8>, (pw, ph): (f64, f64), (tw, th): (f64, f64)) {
    let m = PAGE_MARGIN_MM;
    stroke_setup(b, Style::Frame);
    let _ = writeln!(Bytes(b), "{m} {m} {tw:.3} {th:.3} re S");
    for (cx, cy) in [(m, m), (m + tw, m), (m, m + th), (m + tw, m + th)] {
        let sx = if cx < pw / 2.0 { -1.0 } else { 1.0 };
        let sy = if cy < ph / 2.0 { -1.0 } else { 1.0 };
        let _ = writeln!(Bytes(b), "{cx:.3} {cy:.3} m {:.3} {cy:.3} l {cx:.3} {cy:.3} m {cx:.3} {:.3} l S", cx + sx * 5.0, cy + sy * 5.0);
    }
}

/// The template as drawn, tiled. Returns the PDF bytes and the number of pages.
pub fn to_pdf(sheet: &Sheet, page: PageSize) -> (Vec<u8>, usize) {
    let t = tiling(sheet, page);
    let mut pages = Vec::new();
    for row in 0..t.rows {
        for col in 0..t.cols {
            pages.push((page.mm(), page_content(sheet, page, &t, row, col)));
        }
    }
    let n = pages.len();
    (write_pdf(pages), n)
}

/// Print a project with the chosen layout. Returns the PDF bytes and the number of pages.
pub fn print(project: &Project, computed: &ComputedProject, page: PageSize, layout: PrintLayout) -> (Vec<u8>, usize) {
    match layout {
        PrintLayout::AsDrawn => to_pdf(&crate::sheet::build_sheet(project, computed), page),
        PrintLayout::FewestPages => printout_pdf(&crate::print::fewest_pages(project, computed, page)),
    }
}

/// Pages `print` would produce.
pub fn page_count(project: &Project, computed: &ComputedProject, page: PageSize, layout: PrintLayout) -> usize {
    match layout {
        PrintLayout::AsDrawn => {
            let t = tiling(&crate::sheet::build_sheet(project, computed), page);
            t.cols * t.rows
        }
        PrintLayout::FewestPages => crate::print::fewest_pages(project, computed, page).pages.len(),
    }
}

/// Render a laid-out printout.
pub fn printout_pdf(p: &Printout) -> (Vec<u8>, usize) {
    let m = PAGE_MARGIN_MM;
    let (pw, ph) = p.paper;
    let (tw, th) = p.tile;
    let mut pages = Vec::new();
    for page in &p.pages {
        let mut b = Vec::new();
        let _ = writeln!(Bytes(&mut b), "q {PT:.6} 0 0 {:.6} 0 {:.4} cm 1 J 1 j", -PT, ph * PT);
        if let Some(t) = page.tile {
            // The part of the big piece this page shows.
            let _ = writeln!(Bytes(&mut b), "q {m} {m} {tw:.3} {th:.3} re W n");
            let _ = writeln!(Bytes(&mut b), "1 0 0 1 {:.3} {:.3} cm", m - t.col as f64 * tw, m - t.row as f64 * th);
            if let Some(c) = &p.canvas {
                shapes_op(&mut b, &c.shapes);
            }
            b.extend_from_slice(b"Q\n");
        }
        let _ = writeln!(Bytes(&mut b), "q {m} {m} {tw:.3} {th:.3} re W n");
        shapes_op(&mut b, &page.shapes);
        b.extend_from_slice(b"Q\n");
        frame_op(&mut b, (pw, ph), (tw, th));
        let _ = writeln!(Bytes(&mut b), "0 g");
        text_op(&mut b, m, m - 4.0, 3.0, true, &page.header, Align::Left);
        text_op(&mut b, m, ph - m + 6.5, 2.6, false, &page.footer, Align::Left);
        b.extend_from_slice(b"Q\n");
        pages.push(((pw, ph), b));
    }
    let n = pages.len();
    (write_pdf(pages), n)
}

/// Assemble pages (paper size in mm, content stream) into a PDF file.
fn write_pdf(pages: Vec<((f64, f64), Vec<u8>)>) -> Vec<u8> {
    let n = pages.len();
    let mut objs: Vec<Vec<u8>> = Vec::new();
    // 1 catalog, 2 pages, 3 font, 4 bold font, 5 info, then (page, content) pairs.
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 6 + 2 * i)).collect();
    objs.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objs.push(format!("<< /Type /Pages /Count {n} /Kids [{}] >>", kids.join(" ")).into_bytes());
    objs.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec());
    objs.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_vec());
    objs.push(b"<< /Producer (Hidework) /Title (Hidework template) >>".to_vec());
    for (i, ((pw, ph), content)) in pages.into_iter().enumerate() {
        objs.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.3} {:.3}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {} 0 R >>",
                pw * PT,
                ph * PT,
                7 + 2 * i
            )
            .into_bytes(),
        );
        let mut stream = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
        stream.extend(content);
        stream.extend_from_slice(b"\nendstream");
        objs.push(stream);
    }
    let mut out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n", i + 1).into_bytes());
        out.extend(o);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).into_bytes());
    for o in offsets {
        out.extend(format!("{o:010} 00000 n \n").into_bytes());
    }
    out.extend(format!("trailer\n<< /Size {} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).into_bytes());
    out
}
