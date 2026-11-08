//! True-scale SVG export (one sheet, millimetre units) for laser cutters and cutting machines.

use crate::sheet::{spec, Align, Shape, Sheet};
use std::fmt::Write;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn gray(g: f64) -> String {
    let c = (g.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{c:02x}{c:02x}{c:02x}")
}

pub fn to_svg(sheet: &Sheet) -> String {
    let mut s = String::new();
    let _ = writeln!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w:.3}mm" height="{h:.3}mm" viewBox="0 0 {w:.3} {h:.3}">"#,
        w = sheet.width,
        h = sheet.height
    );
    let _ = writeln!(s, r#"<rect width="100%" height="100%" fill="white"/>"#);
    for shape in &sheet.shapes {
        match shape {
            Shape::Poly { pts, closed, style } => {
                let st = spec(*style);
                let tag = if *closed { "polygon" } else { "polyline" };
                let points: Vec<String> = pts.iter().map(|p| format!("{:.3},{:.3}", p.x, p.y)).collect();
                let dash = if st.dash.is_empty() {
                    String::new()
                } else {
                    format!(r#" stroke-dasharray="{}""#, st.dash.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(" "))
                };
                let _ = writeln!(
                    s,
                    r#"<{tag} points="{}" fill="none" stroke="{}" stroke-width="{}"{dash} stroke-linejoin="round"/>"#,
                    points.join(" "),
                    gray(st.gray),
                    st.width_mm
                );
            }
            Shape::Circle { c, r, style, filled } => {
                let st = spec(*style);
                if *filled {
                    let _ = writeln!(s, r#"<circle cx="{:.3}" cy="{:.3}" r="{:.3}" fill="{}"/>"#, c.x, c.y, r, gray(st.gray));
                } else {
                    let _ = writeln!(
                        s,
                        r#"<circle cx="{:.3}" cy="{:.3}" r="{:.3}" fill="none" stroke="{}" stroke-width="{}"/>"#,
                        c.x,
                        c.y,
                        r,
                        gray(st.gray),
                        st.width_mm
                    );
                }
            }
            Shape::Text { at, size, text, align, bold, angle } => {
                let anchor = if *align == Align::Center { "middle" } else { "start" };
                let weight = if *bold { "bold" } else { "normal" };
                let turn = if angle.abs() > 1e-9 { format!(r#" transform="rotate({angle:.3} {:.3} {:.3})""#, at.x, at.y) } else { String::new() };
                let _ = writeln!(
                    s,
                    r#"<text x="{:.3}" y="{:.3}" font-family="Helvetica, Arial, sans-serif" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}"{turn}>{}</text>"#,
                    at.x,
                    at.y,
                    esc(text)
                );
            }
        }
    }
    s.push_str("</svg>\n");
    s
}
