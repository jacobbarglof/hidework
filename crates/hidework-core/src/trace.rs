//! Trace a photo or scan of a paper or card pattern into pieces.
//!
//! Steps: turn the photo upright (EXIF), grey and lightly blur it, pick a threshold (Otsu, or the
//! user's), decide which side is the pattern (the opposite of what fills the border), follow the
//! outlines with marching squares (sub-pixel), keep the largest outlines and their holes, then map
//! pixels to millimetres and fit lines and cubic Beziers.
//!
//! Scale comes from, in order: four picked corners of a sheet of known size (which also corrects
//! the perspective), two picked points and the real distance between them, a millimetres-per-pixel
//! figure, or the resolution a scanner wrote into the file (150 dpi or more). Without any of these
//! the outlines are traced (for the preview) but no pieces are made.

use crate::geom::{signed_area, v, Rect, Vec2};
use crate::import::fit::{fit_closed, rdp_closed, FitParams};
use crate::import::{base64, build, ImportOptions, ImportResult, InnerShapes, Underlay};
use image::{DynamicImage, GrayImage, ImageDecoder, ImageReader};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Foreground {
    /// The pattern is whatever does not fill the edges of the photo (or of the sheet).
    #[default]
    Auto,
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SheetSize {
    #[default]
    Letter,
    A4,
    /// `sheet_mm` gives the size.
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TraceOptions {
    pub material_id: String,
    /// 0 to 255; none means automatic (Otsu).
    pub threshold: Option<u8>,
    pub foreground: Foreground,
    /// Known millimetres per pixel (0 = not known).
    pub mm_per_px: f64,
    /// Two points in photo pixels on something measured, and the real distance between them.
    pub scale_points: Vec<Vec2>,
    pub scale_length_mm: f64,
    /// Four corners of a sheet of paper in photo pixels, any order: corrects the perspective.
    pub corners: Vec<Vec2>,
    pub sheet: SheetSize,
    /// Custom sheet width and height in millimetres.
    pub sheet_mm: Vec2,
    /// Outlines smaller than this (square millimetres) are ignored.
    pub min_area_mm2: f64,
    pub max_pieces: usize,
    pub holes: bool,
    /// How far the fitted curves may stray from the traced edge.
    pub fit_tolerance_mm: f64,
    /// Turns sharper than this (degrees) stay corners.
    pub corner_deg: f64,
    /// Photos larger than this (pixels on the long side) are reduced before tracing.
    pub max_px: u32,
    pub smooth: bool,
    /// Return a small JPEG of the photo for the interface.
    pub preview: bool,
    pub preview_px: u32,
}

impl Default for TraceOptions {
    fn default() -> Self {
        TraceOptions {
            material_id: String::new(),
            threshold: None,
            foreground: Foreground::Auto,
            mm_per_px: 0.0,
            scale_points: vec![],
            scale_length_mm: 0.0,
            corners: vec![],
            sheet: SheetSize::Letter,
            sheet_mm: v(0.0, 0.0),
            min_area_mm2: 100.0,
            max_pieces: 12,
            holes: true,
            fit_tolerance_mm: 0.1,
            corner_deg: 40.0,
            max_px: 3000,
            smooth: true,
            preview: true,
            preview_px: 1600,
        }
    }
}

/// Pixel-to-millimetre map.
#[derive(Clone, Copy, Debug)]
enum Scale {
    Unknown,
    Uniform(f64),
    Homography([f64; 8], f64),
}

impl Scale {
    fn map(&self, p: Vec2) -> Vec2 {
        match *self {
            Scale::Unknown => p,
            Scale::Uniform(k) => p * k,
            Scale::Homography(h, _) => apply_h(&h, p),
        }
    }
    fn mm_per_px(&self) -> f64 {
        match *self {
            Scale::Unknown => 0.0,
            Scale::Uniform(k) => k,
            Scale::Homography(_, k) => k,
        }
    }
}

pub fn trace_image(bytes: &[u8], opts: &TraceOptions) -> Result<ImportResult, String> {
    let mut warnings = vec![];
    let reader = ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|e| format!("This picture could not be read ({e})."))?;
    let mut decoder = reader.into_decoder().map_err(|_| "This picture could not be read. Hidework can trace PNG and JPEG photos.".to_string())?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| format!("This picture could not be read ({e})."))?;
    img.apply_orientation(orientation);
    let (w0, h0) = (img.width(), img.height());
    if w0 < 16 || h0 < 16 {
        return Err("This picture is too small to trace.".into());
    }

    // Scale.
    let mut scale = Scale::Unknown;
    let mut sheet_area = 0.0;
    let mut quad: Option<[Vec2; 4]> = None;
    if opts.corners.len() == 4 {
        let (sw, sh) = match opts.sheet {
            SheetSize::Letter => (215.9, 279.4),
            SheetSize::A4 => (210.0, 297.0),
            SheetSize::Custom => (opts.sheet_mm.x, opts.sheet_mm.y),
        };
        if sw <= 0.0 || sh <= 0.0 {
            return Err("Type the size of the sheet first.".into());
        }
        let q = order_corners(&opts.corners);
        let horiz = q[0].dist(q[1]) + q[3].dist(q[2]);
        let vert = q[1].dist(q[2]) + q[0].dist(q[3]);
        let (long, short) = (sw.max(sh), sw.min(sh));
        let (dw, dh) = if horiz >= vert { (long, short) } else { (short, long) };
        let dst = [v(0.0, 0.0), v(dw, 0.0), v(dw, dh), v(0.0, dh)];
        let h = homography(&q, &dst).ok_or("Those four corners do not make a sheet shape. Click the four corners of the paper again.")?;
        let px_area = signed_area(&q).abs();
        scale = Scale::Homography(h, (dw * dh / px_area.max(1.0)).sqrt());
        sheet_area = dw * dh;
        quad = Some(q);
        if opts.scale_points.len() == 2 {
            warnings.push("The sheet corners set the scale, so the two measured points were not needed.".into());
        }
    } else if opts.scale_points.len() == 2 && opts.scale_length_mm > 0.0 {
        let d = opts.scale_points[0].dist(opts.scale_points[1]);
        if d < 5.0 {
            return Err("The two points are too close together. Pick two points further apart.".into());
        }
        scale = Scale::Uniform(opts.scale_length_mm / d);
    } else if opts.mm_per_px > 0.0 {
        scale = Scale::Uniform(opts.mm_per_px);
    } else if let Some(dpi) = file_dpi(bytes).filter(|d| *d >= 150.0) {
        scale = Scale::Uniform(25.4 / dpi);
        warnings.push(format!("Scale taken from the scan's {dpi:.0} dots per inch. Check it against a ruler."));
    }

    // Working grey image.
    let gray0 = img.to_luma8();
    let ds = (w0.max(h0) as f64 / opts.max_px.max(256) as f64).max(1.0);
    let gray: GrayImage = if ds > 1.0 {
        image::imageops::resize(&gray0, (w0 as f64 / ds).round() as u32, (h0 as f64 / ds).round() as u32, image::imageops::FilterType::Triangle)
    } else {
        gray0
    };
    let (w, h) = (gray.width() as usize, gray.height() as usize);
    let sx = w0 as f64 / w as f64;
    let sy = h0 as f64 / h as f64;
    let mut g: Vec<f32> = gray.as_raw().iter().map(|&x| x as f32).collect();
    if opts.smooth {
        g = box_blur(&g, w, h);
    }
    let to_orig = |p: Vec2| v(p.x * sx, p.y * sy);
    let min_px_area = match scale {
        Scale::Unknown => (w * h) as f64 * 0.002,
        s => opts.min_area_mm2 / (s.mm_per_px() * s.mm_per_px()) / (sx * sy),
    }
    .max(16.0);

    // First the area inside the sheet (pattern lying on the paper), then the whole photo.
    let mut attempt = None;
    if let Some(q) = quad {
        let qs: Vec<Vec2> = shrink(&q, 0.02).iter().map(|p| v(p.x / sx, p.y / sy)).collect();
        attempt = extract(&g, w, h, Some(&qs), opts, min_px_area);
        if attempt.as_ref().map_or(false, |a| a.loops.is_empty()) {
            attempt = None;
        }
    }
    let on_sheet = attempt.is_some();
    let found = match attempt {
        Some(a) => a,
        None => extract(&g, w, h, None, opts, min_px_area).ok_or("Could not tell the pattern from the background. Try a photo with the pattern on a plain, contrasting surface.")?,
    };
    if !on_sheet {
        if let Some(t) = found.note {
            warnings.push(t.into());
        }
    }

    // Outlines in photo pixels (for the preview) and in millimetres.
    let mut traced_px = vec![];
    let mut paths = vec![];
    let mut pieces_found = 0;
    for (k, lp) in found.loops.iter().enumerate() {
        let orig: Vec<Vec2> = lp.pts.iter().map(|&p| to_orig(p)).collect();
        let simple = rdp_closed(&orig, 0.3 * sx);
        // Drop the sheet itself when tracing the whole photo.
        let mm: Vec<Vec2> = simple.iter().map(|&p| scale.map(p)).collect();
        if !on_sheet && sheet_area > 0.0 && lp.depth == 0 {
            let a = signed_area(&mm).abs();
            if (a / sheet_area - 1.0).abs() < 0.15 {
                continue;
            }
        }
        traced_px.push(rdp_closed(&orig, sx.max(1.0)));
        if lp.depth == 0 {
            pieces_found += 1;
        }
        if matches!(scale, Scale::Unknown) {
            continue;
        }
        let mmpp = scale.mm_per_px();
        let prm = FitParams { tol: opts.fit_tolerance_mm.max(0.05), corner_deg: opts.corner_deg, window: (3.0 * mmpp * sx).max(1.0) };
        let name = if lp.depth == 0 { format!("Traced piece {}", k + 1) } else { String::new() };
        paths.push(fit_closed(&mm, &prm, &name));
    }
    if found.line_drawing {
        warnings.push("The pattern looks drawn as a line; the outside edge of the line was used.".into());
    }

    let mut result = ImportResult { units_detected: "photo".into(), ..Default::default() };
    if matches!(scale, Scale::Unknown) {
        result.summary = format!("{} found; set the size to bring them in", plural(pieces_found, "outline"));
        warnings.push("The size is not known yet. Click two points on something you measured and type how long it is, or click the four corners of a sheet of paper.".into());
    } else {
        let iopts = ImportOptions {
            material_id: opts.material_id.clone(),
            min_size_mm: 0.0,
            detect_stitching: false,
            inner_shapes: InnerShapes::Piece,
            shape_tolerance_mm: opts.fit_tolerance_mm.max(0.05) + scale.mm_per_px() * sx,
            ..Default::default()
        };
        let built = build::pieces_from_paths(paths, &iopts, &mut warnings);
        result.summary = built.summary();
        result.pieces = built.pieces;
        result.units_detected = match scale {
            Scale::Homography(..) => "mm (from the sheet corners)".into(),
            _ => format!("mm ({:.4} mm per pixel)", scale.mm_per_px()),
        };
        if result.pieces.is_empty() {
            warnings.push("No pattern outline was found. Try the slider, or a photo with more contrast.".into());
        }
    }
    if opts.preview {
        let k = (opts.preview_px.max(64) as f64 / w0.max(h0) as f64).min(1.0);
        let small = if k < 1.0 { img.resize((w0 as f64 * k) as u32, (h0 as f64 * k) as u32, image::imageops::FilterType::Triangle) } else { img.clone() };
        let rgb = small.to_rgb8();
        let mut buf = vec![];
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80).encode_image(&rgb).map_err(|e| e.to_string())?;
        result.underlay = Some(Underlay {
            width: w0,
            height: h0,
            data_url: format!("data:image/jpeg;base64,{}", base64(&buf)),
            scale_known: !matches!(scale, Scale::Unknown),
            mm_per_px: scale.mm_per_px(),
            threshold: found.threshold,
        });
    }
    result.traced_px = traced_px;
    result.warnings = warnings;
    Ok(result)
}

fn plural(n: usize, w: &str) -> String {
    if n == 1 {
        format!("1 {w}")
    } else {
        format!("{n} {w}s")
    }
}

struct Loop {
    /// Working-image pixels.
    pts: Vec<Vec2>,
    depth: usize,
}

struct Found {
    loops: Vec<Loop>,
    threshold: u8,
    line_drawing: bool,
    note: Option<&'static str>,
}

/// Threshold, choose the pattern side, trace, and keep the pieces and their holes.
fn extract(g: &[f32], w: usize, h: usize, roi: Option<&[Vec2]>, opts: &TraceOptions, min_area: f64) -> Option<Found> {
    let in_roi = |x: usize, y: usize| roi.map_or(true, |q| crate::import::build::inside(q, v(x as f64 + 0.5, y as f64 + 0.5)));
    let mask: Vec<bool> = if roi.is_some() { (0..w * h).map(|i| in_roi(i % w, i / w)).collect() } else { vec![true; w * h] };
    let mut hist = [0u64; 256];
    for (i, &x) in g.iter().enumerate() {
        if mask[i] {
            hist[x.round().clamp(0.0, 255.0) as usize] += 1;
        }
    }
    let (t_auto, spread) = otsu(&hist);
    let t = opts.threshold.unwrap_or(t_auto);
    if opts.threshold.is_none() && spread < 30.0 {
        return if roi.is_some() { Some(Found { loops: vec![], threshold: t, line_drawing: false, note: None }) } else { None };
    }
    let tf = t as f32 + 0.5;
    // Which side fills the border (of the photo, or just inside the sheet)?
    let mut light = 0usize;
    let mut total = 0usize;
    let border = |x: usize, y: usize| {
        if !mask[y * w + x] {
            return false;
        }
        if roi.is_none() {
            return x == 0 || y == 0 || x == w - 1 || y == h - 1;
        }
        // Next to a pixel outside the sheet area.
        (x == 0 || !mask[y * w + x - 1]) || (x + 1 == w || !mask[y * w + x + 1]) || (y == 0 || !mask[(y - 1) * w + x]) || (y + 1 == h || !mask[(y + 1) * w + x])
    };
    for y in 0..h {
        for x in 0..w {
            if border(x, y) {
                total += 1;
                if g[y * w + x] > tf {
                    light += 1;
                }
            }
        }
    }
    let dark_fg = match opts.foreground {
        Foreground::Dark => true,
        Foreground::Light => false,
        Foreground::Auto => light * 2 >= total,
    };
    let note = (opts.foreground == Foreground::Auto && roi.is_none()).then_some(if dark_fg {
        "Traced the darker shapes on a lighter background."
    } else {
        "Traced the lighter shapes on a darker background."
    });
    let field = |i: usize| -> f32 {
        if !mask[i] {
            return -255.0;
        }
        if dark_fg {
            tf - g[i]
        } else {
            g[i] - tf
        }
    };
    let raw = marching_squares(w, h, &field);
    // Keep loops big enough, and not cut by the photo's edge.
    let mut loops: Vec<(Vec<Vec2>, f64, Rect)> = raw
        .into_iter()
        .filter_map(|p| {
            let a = signed_area(&p).abs();
            let r = Rect::of(&p);
            (a >= 9.0).then_some((p, a, r))
        })
        .collect();
    loops.sort_by(|a, b| b.1.total_cmp(&a.1));
    let n = loops.len();
    let mut parent = vec![None; n];
    let mut depth = vec![0usize; n];
    for i in 0..n {
        let p0 = loops[i].0[0];
        let bi = loops[i].2;
        parent[i] = (0..i).rev().find(|&j| {
            let bj = loops[j].2;
            bj.min.x <= bi.min.x && bj.min.y <= bi.min.y && bj.max.x >= bi.max.x && bj.max.y >= bi.max.y && loops[j].1 > loops[i].1 && crate::import::build::inside(&loops[j].0, p0)
        });
        depth[i] = parent[i].map_or(0, |j| depth[j] + 1);
    }
    let touches = |r: &Rect| r.min.x < 1.5 || r.min.y < 1.5 || r.max.x > w as f64 - 1.5 || r.max.y > h as f64 - 1.5;
    let mut keep: Vec<usize> = (0..n).filter(|&i| depth[i] == 0 && loops[i].1 >= min_area && !touches(&loops[i].2)).collect();
    keep.truncate(opts.max_pieces.max(1));
    let mut out = vec![];
    let mut line_drawing = false;
    for &pi in &keep {
        out.push(Loop { pts: loops[pi].0.clone(), depth: 0 });
        if !opts.holes {
            continue;
        }
        let kids: Vec<usize> = (0..n).filter(|&c| parent[c] == Some(pi)).collect();
        // A drawn outline: the inside edge of the line is nearly the whole shape.
        let line = kids.iter().copied().find(|&c| loops[c].1 > 0.6 * loops[pi].1);
        let holes: Vec<usize> = match line {
            Some(c) => {
                line_drawing = true;
                (0..n).filter(|&k| parent[k] == Some(c)).collect()
            }
            None => kids,
        };
        for c in holes {
            if loops[c].1 >= 12.0 && loops[c].1 >= min_area * 0.002 {
                out.push(Loop { pts: loops[c].0.clone(), depth: 1 });
            }
        }
    }
    Some(Found { loops: out, threshold: t, line_drawing, note })
}

/// Otsu's split, returned as the level halfway between the two class means (which puts a blurred
/// edge exactly where the sharp edge was), and the gap between those means.
fn otsu(hist: &[u64; 256]) -> (u8, f64) {
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return (128, 0.0);
    }
    let sum: f64 = hist.iter().enumerate().map(|(i, &c)| i as f64 * c as f64).sum();
    let (mut wb, mut sb, mut best, mut mid, mut gap) = (0.0, 0.0, -1.0, 128.0, 0.0);
    for t in 0..256 {
        wb += hist[t] as f64;
        if wb == 0.0 {
            continue;
        }
        let wf = total as f64 - wb;
        if wf == 0.0 {
            break;
        }
        sb += t as f64 * hist[t] as f64;
        let mb = sb / wb;
        let mf = (sum - sb) / wf;
        let between = wb * wf * (mb - mf) * (mb - mf);
        if between > best {
            best = between;
            mid = (mb + mf) / 2.0;
            gap = mf - mb;
        }
    }
    (mid.round().clamp(0.0, 254.0) as u8, gap)
}

/// 3 x 3 box blur (edges clamp).
fn box_blur(g: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut tmp = vec![0.0; w * h];
    for y in 0..h {
        for x in 0..w {
            let a = g[y * w + x.saturating_sub(1)];
            let b = g[y * w + x];
            let c = g[y * w + (x + 1).min(w - 1)];
            tmp[y * w + x] = (a + b + c) / 3.0;
        }
    }
    let mut out = vec![0.0; w * h];
    for y in 0..h {
        for x in 0..w {
            let a = tmp[y.saturating_sub(1) * w + x];
            let b = tmp[y * w + x];
            let c = tmp[(y + 1).min(h - 1) * w + x];
            out[y * w + x] = (a + b + c) / 3.0;
        }
    }
    out
}

/// Closed iso-lines (field > 0 inside) through the pixel centres, in image pixel coordinates
/// (pixel `i` covers `i..i+1`). The image is padded with outside, so every loop closes.
fn marching_squares(w: usize, h: usize, field: &dyn Fn(usize) -> f32) -> Vec<Vec<Vec2>> {
    let pw = w + 2;
    let ph = h + 2;
    let f = |i: usize, j: usize| -> f32 {
        if i == 0 || j == 0 || i > w || j > h {
            -255.0
        } else {
            field((j - 1) * w + (i - 1))
        }
    };
    let hid = |i: usize, j: usize| (2 * (j * pw + i)) as u32;
    let vid = |i: usize, j: usize| (2 * (j * pw + i) + 1) as u32;
    let mut adj: HashMap<u32, [u32; 2]> = HashMap::new();
    let mut link = |a: u32, b: u32| {
        for (x, y) in [(a, b), (b, a)] {
            let e = adj.entry(x).or_insert([u32::MAX; 2]);
            if e[0] == u32::MAX {
                e[0] = y;
            } else {
                e[1] = y;
            }
        }
    };
    for j in 0..ph - 1 {
        for i in 0..pw - 1 {
            let (a, b, c, d) = (f(i, j), f(i + 1, j), f(i + 1, j + 1), f(i, j + 1));
            let idx = ((a > 0.0) as u8) << 3 | ((b > 0.0) as u8) << 2 | ((c > 0.0) as u8) << 1 | (d > 0.0) as u8;
            if idx == 0 || idx == 15 {
                continue;
            }
            let (top, bottom, left, right) = (hid(i, j), hid(i, j + 1), vid(i, j), vid(i + 1, j));
            let centre = (a + b + c + d) / 4.0 > 0.0;
            match idx {
                1 | 14 => link(left, bottom),
                2 | 13 => link(bottom, right),
                3 | 12 => link(left, right),
                4 | 11 => link(top, right),
                6 | 9 => link(top, bottom),
                7 | 8 => link(left, top),
                5 => {
                    if centre {
                        link(left, top);
                        link(bottom, right);
                    } else {
                        link(left, bottom);
                        link(top, right);
                    }
                }
                10 => {
                    if centre {
                        link(top, right);
                        link(left, bottom);
                    } else {
                        link(left, top);
                        link(bottom, right);
                    }
                }
                _ => {}
            }
        }
    }
    let point = |id: u32| -> Vec2 {
        let e = (id / 2) as usize;
        let (i, j) = (e % pw, e / pw);
        let (fa, fb, horizontal) = if id % 2 == 0 { (f(i, j), f(i + 1, j), true) } else { (f(i, j), f(i, j + 1), false) };
        let t = (fa / (fa - fb)) as f64;
        // Padded grid point (i, j) is the centre of image pixel (i - 1, j - 1), at (i - 0.5, j - 0.5).
        if horizontal {
            v(i as f64 + t - 0.5, j as f64 - 0.5)
        } else {
            v(i as f64 - 0.5, j as f64 + t - 0.5)
        }
    };
    let mut loops = vec![];
    let mut keys: Vec<u32> = adj.keys().copied().collect();
    keys.sort_unstable();
    for k in keys {
        let Some(&first) = adj.get(&k) else { continue };
        if first[0] == u32::MAX {
            continue;
        }
        let mut pts = vec![point(k)];
        let (mut prev, mut cur) = (k, first[0]);
        adj.remove(&k);
        while cur != k {
            let Some(n) = adj.remove(&cur) else { break };
            pts.push(point(cur));
            let next = if n[0] == prev { n[1] } else { n[0] };
            prev = cur;
            cur = next;
            if cur == u32::MAX {
                break;
            }
        }
        if pts.len() >= 4 {
            loops.push(pts);
        }
    }
    loops
}

/// Corners in order top-left, top-right, bottom-right, bottom-left (clockwise on screen).
fn order_corners(c: &[Vec2]) -> [Vec2; 4] {
    let m = (c[0] + c[1] + c[2] + c[3]) * 0.25;
    let mut s: Vec<Vec2> = c[..4].to_vec();
    s.sort_by(|a, b| (a.y - m.y).atan2(a.x - m.x).total_cmp(&(b.y - m.y).atan2(b.x - m.x)));
    let tl = (0..4).min_by(|&i, &j| (s[i].x + s[i].y).total_cmp(&(s[j].x + s[j].y))).unwrap();
    [s[tl], s[(tl + 1) % 4], s[(tl + 2) % 4], s[(tl + 3) % 4]]
}

/// Move each corner `f` of the way towards the middle.
fn shrink(q: &[Vec2; 4], f: f64) -> [Vec2; 4] {
    let m = (q[0] + q[1] + q[2] + q[3]) * 0.25;
    q.map(|p| p + (m - p) * f)
}

/// The projective map taking `src[i]` to `dst[i]` (h33 = 1).
fn homography(src: &[Vec2; 4], dst: &[Vec2; 4]) -> Option<[f64; 8]> {
    let mut a = [[0.0f64; 9]; 8];
    for i in 0..4 {
        let (x, y, u, w) = (src[i].x, src[i].y, dst[i].x, dst[i].y);
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -w * x, -w * y, w];
    }
    for col in 0..8 {
        let piv = (col..8).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        for r in 0..8 {
            if r != col {
                let k = a[r][col] / a[col][col];
                for c in col..9 {
                    a[r][c] -= k * a[col][c];
                }
            }
        }
    }
    let mut h = [0.0; 8];
    for i in 0..8 {
        h[i] = a[i][8] / a[i][i];
    }
    Some(h)
}

fn apply_h(h: &[f64; 8], p: Vec2) -> Vec2 {
    let w = h[6] * p.x + h[7] * p.y + 1.0;
    v((h[0] * p.x + h[1] * p.y + h[2]) / w, (h[3] * p.x + h[4] * p.y + h[5]) / w)
}

/// Resolution written in a PNG (pHYs) or JPEG (JFIF) file, in dots per inch.
fn file_dpi(b: &[u8]) -> Option<f64> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        let mut i = 8;
        while i + 8 <= b.len() {
            let len = u32::from_be_bytes(b[i..i + 4].try_into().ok()?) as usize;
            let kind = &b[i + 4..i + 8];
            if kind == b"pHYs" && i + 17 <= b.len() {
                let ppu = u32::from_be_bytes(b[i + 8..i + 12].try_into().ok()?) as f64;
                return (b[i + 16] == 1).then_some(ppu * 0.0254);
            }
            if kind == b"IDAT" {
                return None;
            }
            i += 12 + len;
        }
        return None;
    }
    if b.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 4 <= b.len() && b[i] == 0xFF {
            let marker = b[i + 1];
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            if marker == 0xE0 && i + 16 <= b.len() && &b[i + 4..i + 9] == b"JFIF\0" {
                let units = b[i + 11];
                let x = u16::from_be_bytes([b[i + 12], b[i + 13]]) as f64;
                return match units {
                    1 => Some(x),
                    2 => Some(x * 2.54),
                    _ => None,
                };
            }
            if marker == 0xDA {
                return None;
            }
            i += 2 + len;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::cubic_point;
    use crate::model::{EdgeKind, Piece};
    use image::{ImageFormat, Luma};

    fn png(img: &GrayImage) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(vec![]);
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    /// Outline points of a piece (edges flattened), in piece coordinates.
    fn outline(p: &Piece) -> Vec<Vec2> {
        let n = p.vertices.len();
        let mut pts = vec![];
        for (i, e) in p.edges.iter().enumerate() {
            let (a, b) = (p.vertices[i], p.vertices[(i + 1) % n]);
            match e.kind {
                EdgeKind::Line => pts.push(a),
                EdgeKind::Cubic { c1, c2 } => pts.extend((0..16).map(|k| cubic_point(a, c1, c2, b, k as f64 / 16.0))),
            }
        }
        pts
    }

    /// A dark 400 x 240 px shape with one rounded corner (radius 60 px) and a 40 px round hole,
    /// on white. At 0.25 mm per pixel that is 100 x 60 mm with a 10 mm hole.
    fn card_png() -> Vec<u8> {
        let img = GrayImage::from_fn(800, 600, |x, y| {
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            let in_rect = (100.0..500.0).contains(&px) && (100.0..340.0).contains(&py);
            let corner = px > 440.0 && py > 280.0 && v(px, py).dist(v(440.0, 280.0)) > 60.0;
            let hole = v(px, py).dist(v(200.0, 220.0)) < 20.0;
            Luma([if in_rect && !corner && !hole { 30 } else { 240 }])
        });
        png(&img)
    }

    #[test]
    fn trace_card_true_size() {
        let opts = TraceOptions { mm_per_px: 0.25, ..Default::default() };
        let r = trace_image(&card_png(), &opts).unwrap();
        assert_eq!(r.pieces.len(), 1, "{:?} {:?}", r.warnings, r.summary);
        let p = &r.pieces[0];
        let bb = Rect::of(&outline(p));
        assert!((bb.width() - 100.0).abs() < 0.2 && (bb.height() - 60.0).abs() < 0.2, "{bb:?} {:?} {:?}", p.vertices, p.edges.iter().map(|e| format!("{:?}", e.kind)).collect::<Vec<_>>());
        assert!(p.edges.iter().any(|e| matches!(e.kind, EdgeKind::Cubic { .. })), "the rounded corner stays a curve");
        assert!(p.edges.len() <= 16, "{} edges", p.edges.len());
        assert_eq!(p.holes.len(), 1, "{:?}", r.warnings);
        assert!((p.holes[0].diameter_mm - 10.0).abs() < 0.3, "{}", p.holes[0].diameter_mm);
        assert!((p.holes[0].center.x - 25.0).abs() < 0.2 && (p.holes[0].center.y - 30.0).abs() < 0.2, "{:?}", p.holes[0].center);
        let u = r.underlay.unwrap();
        assert_eq!((u.width, u.height), (800, 600));
        assert!(u.data_url.starts_with("data:image/jpeg;base64,"));
        assert_eq!(r.traced_px.len(), 2);
    }

    #[test]
    fn trace_two_point_scale_and_unknown_scale() {
        let bytes = card_png();
        let none = trace_image(&bytes, &TraceOptions::default()).unwrap();
        assert!(none.pieces.is_empty() && none.traced_px.len() == 2);
        assert!(!none.underlay.as_ref().unwrap().scale_known);
        let opts = TraceOptions { scale_points: vec![v(100.0, 100.0), v(500.0, 100.0)], scale_length_mm: 100.0, preview: false, ..Default::default() };
        let r = trace_image(&bytes, &opts).unwrap();
        let bb = Rect::of(&outline(&r.pieces[0]));
        assert!((bb.width() - 100.0).abs() < 0.2 && (bb.height() - 60.0).abs() < 0.2, "{bb:?}");
    }

    #[test]
    fn trace_perspective_from_sheet_corners() {
        // A Letter sheet photographed at an angle on a grey table, with a 100 x 60 mm dark card
        // lying on it at (50, 80) mm from the sheet's top-left corner.
        let sheet = [v(0.0, 0.0), v(215.9, 0.0), v(215.9, 279.4), v(0.0, 279.4)];
        let photo = [v(150.0, 100.0), v(650.0, 130.0), v(700.0, 780.0), v(100.0, 740.0)];
        let to_sheet = homography(&photo, &sheet).unwrap();
        let ss = 4;
        let img = GrayImage::from_fn(800, 900, |x, y| {
            let mut acc = 0.0;
            for a in 0..ss {
                for b in 0..ss {
                    let p = v(x as f64 + (a as f64 + 0.5) / ss as f64, y as f64 + (b as f64 + 0.5) / ss as f64);
                    let q = apply_h(&to_sheet, p);
                    let on_sheet = (0.0..215.9).contains(&q.x) && (0.0..279.4).contains(&q.y);
                    let on_card = (50.0..150.0).contains(&q.x) && (80.0..140.0).contains(&q.y);
                    acc += if on_card { 40.0 } else if on_sheet { 235.0 } else { 110.0 };
                }
            }
            Luma([(acc / (ss * ss) as f64).round() as u8])
        });
        // Corners clicked in a muddled order.
        let opts = TraceOptions { corners: vec![photo[2], photo[0], photo[3], photo[1]], preview: false, ..Default::default() };
        let r = trace_image(&png(&img), &opts).unwrap();
        assert_eq!(r.pieces.len(), 1, "{:?}", r.warnings);
        let p = &r.pieces[0];
        let bb = Rect::of(&outline(p));
        assert!((bb.width() - 100.0).abs() < 0.2 && (bb.height() - 60.0).abs() < 0.2, "{bb:?} {:?} {:?}", p.vertices, p.edges.iter().map(|e| format!("{:?}", e.kind)).collect::<Vec<_>>());
        assert!((p.position.x - 50.0).abs() < 0.3 && (p.position.y - 80.0).abs() < 0.3, "{:?}", p.position);
        // Straight sides come out as lines (a few extra joints are allowed at 0.1 mm tolerance).
        assert!(p.edges.len() <= 8 && p.edges.iter().filter(|e| matches!(e.kind, EdgeKind::Line)).count() >= 4, "{:?}", p.edges);
    }

    #[test]
    fn trace_noisy_photo() {
        // Grainy lighting (+-20 grey levels) on a 150 x 90 mm card at 0.25 mm per pixel.
        let img = GrayImage::from_fn(1200, 900, |x, y| {
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            let in_rect = (200.0..800.0).contains(&px) && (200.0..560.0).contains(&py);
            let corner = px > 710.0 && py > 470.0 && v(px, py).dist(v(710.0, 470.0)) > 90.0;
            let n = ((x * 7919 + y * 104729) % 41) as i32 - 20;
            Luma([((if in_rect && !corner { 60 } else { 225 }) + n).clamp(0, 255) as u8])
        });
        let r = trace_image(&png(&img), &TraceOptions { mm_per_px: 0.25, ..Default::default() }).unwrap();
        assert_eq!(r.pieces.len(), 1, "{:?}", r.warnings);
        let bb = Rect::of(&outline(&r.pieces[0]));
        assert!((bb.width() - 150.0).abs() < 0.2 && (bb.height() - 90.0).abs() < 0.2, "{bb:?} {:?} {:?} {:?}", r.pieces[0].vertices, r.pieces[0].edges.iter().map(|e| format!("{:?}", e.kind)).collect::<Vec<_>>(), r.underlay.map(|u| u.threshold));
    }

    #[test]
    fn trace_helpers() {
        let q = order_corners(&[v(10.0, 10.0), v(0.0, 10.0), v(0.0, 0.0), v(10.0, 0.0)]);
        assert_eq!(q, [v(0.0, 0.0), v(10.0, 0.0), v(10.0, 10.0), v(0.0, 10.0)]);
        let mut hist = [0u64; 256];
        hist[20] = 100;
        hist[220] = 300;
        let (t, gap) = otsu(&hist);
        assert!((20..220).contains(&t) && gap > 150.0);
        // A PNG with 300 dpi written in it.
        let img = GrayImage::from_pixel(20, 20, Luma([255]));
        let mut bytes = png(&img);
        // Insert a pHYs chunk after IHDR (8 + 25 bytes).
        let ppm: u32 = (300.0 / 0.0254f64).round() as u32;
        let mut chunk = vec![0, 0, 0, 9];
        chunk.extend_from_slice(b"pHYs");
        chunk.extend_from_slice(&ppm.to_be_bytes());
        chunk.extend_from_slice(&ppm.to_be_bytes());
        chunk.push(1);
        chunk.extend_from_slice(&[0, 0, 0, 0]);
        bytes.splice(33..33, chunk);
        assert!((file_dpi(&bytes).unwrap() - 300.0).abs() < 0.1);
    }
}
