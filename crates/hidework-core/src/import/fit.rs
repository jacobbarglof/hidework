//! Turning dense points (traced photos, spline samples) back into a few lines and cubic Beziers:
//! Ramer-Douglas-Peucker simplification, corner finding, and Schneider's least-squares Bezier fit
//! (Graphics Gems, 1990).

use super::{Path, Seg};
use crate::geom::{cubic_point, Vec2};

/// Ramer-Douglas-Peucker on an open polyline; keeps both ends.
pub fn rdp(pts: &[Vec2], tol: f64) -> Vec<Vec2> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (mut best, mut bi) = (-1.0, a);
        for i in a + 1..b {
            let d = seg_dist(pts[i], pts[a], pts[b]);
            if d > best {
                best = d;
                bi = i;
            }
        }
        if best > tol {
            keep[bi] = true;
            stack.push((a, bi));
            stack.push((bi, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

/// RDP on a closed loop (no repeated start point).
pub fn rdp_closed(pts: &[Vec2], tol: f64) -> Vec<Vec2> {
    let n = pts.len();
    if n < 4 {
        return pts.to_vec();
    }
    let far = (1..n).max_by(|&i, &j| pts[i].dist(pts[0]).total_cmp(&pts[j].dist(pts[0]))).unwrap_or(n / 2);
    let mut a = rdp(&pts[..=far], tol);
    let mut tail: Vec<Vec2> = pts[far..].to_vec();
    tail.push(pts[0]);
    let b = rdp(&tail, tol);
    a.pop();
    a.extend_from_slice(&b[..b.len() - 1]);
    a
}

/// Distance from `p` to the segment `a`-`b`.
pub fn seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let ab = b - a;
    let l2 = ab.dot(ab);
    if l2 < 1e-24 {
        return p.dist(a);
    }
    let t = ((p - a).dot(ab) / l2).clamp(0.0, 1.0);
    p.dist(a + ab * t)
}

#[derive(Clone, Copy, Debug)]
pub struct FitParams {
    /// Largest allowed distance between the points and the fitted curve.
    pub tol: f64,
    /// A turn sharper than this (degrees) is kept as a corner.
    pub corner_deg: f64,
    /// Distance either side of a point used to measure its turn (filters out pixel noise).
    pub window: f64,
}

impl Default for FitParams {
    fn default() -> Self {
        FitParams { tol: 0.25, corner_deg: 45.0, window: 1.0 }
    }
}

/// Fit a closed loop of points with lines and cubics; corners stay sharp.
pub fn fit_closed(pts: &[Vec2], prm: &FitParams, name: &str) -> Path {
    // Even, close spacing: the fit only checks its error at the points, so long gaps (straight
    // runs left by simplification) would let a curve bulge between them unseen.
    let dense = densify(pts, (prm.tol.min(prm.window / 4.0)).max(1e-3));
    let pts = &dense[..];
    let n = pts.len();
    let mut path = Path::new(pts.first().copied().unwrap_or_default(), name);
    path.closed = true;
    if n < 3 {
        for &p in pts.iter().skip(1) {
            path.line_to(p);
        }
        return path;
    }
    // Arc length around the loop.
    let mut s = vec![0.0; n + 1];
    for i in 0..n {
        s[i + 1] = s[i] + pts[i].dist(pts[(i + 1) % n]);
    }
    let total = s[n];
    let at = |i: isize| pts[i.rem_euclid(n as isize) as usize];
    let arc = |i: isize| {
        let k = i.div_euclid(n as isize);
        s[i.rem_euclid(n as isize) as usize] + k as f64 * total
    };
    let w = prm.window.min(total / 8.0).max(1e-9);
    // The neighbours a window's arc length before and after each point.
    let around = |i: usize| -> (isize, isize) {
        let i = i as isize;
        let (mut j, mut k) = (i - 1, i + 1);
        while arc(i) - arc(j) < w && i - j < n as isize - 1 {
            j -= 1;
        }
        while arc(k) - arc(i) < w && k - i < n as isize - 1 {
            k += 1;
        }
        (j, k)
    };
    let turn: Vec<f64> = (0..n)
        .map(|i| {
            let (j, k) = around(i);
            let a = (pts[i] - at(j)).normalized();
            let b = (at(k) - pts[i]).normalized();
            a.dot(b).clamp(-1.0, 1.0).acos().to_degrees()
        })
        .collect();
    let mut corners: Vec<usize> = vec![];
    for i in 0..n {
        if turn[i] < prm.corner_deg {
            continue;
        }
        // Keep only the sharpest point within the window.
        let (j, k) = around(i);
        let best = (j..=k).all(|m| {
            let mi = m.rem_euclid(n as isize) as usize;
            mi == i || turn[mi] < turn[i] || (turn[mi] == turn[i] && mi > i)
        });
        if best {
            // A slightly rounded corner (blur, a worn card) has a plateau of equal turns: take
            // its middle.
            let (mut lo, mut hi) = (i as isize, i as isize);
            while i as isize - lo < n as isize / 4 && arc(i as isize) - arc(lo - 1) < w && turn[(lo - 1).rem_euclid(n as isize) as usize] >= turn[i] - 3.0 {
                lo -= 1;
            }
            while hi - (i as isize) < n as isize / 4 && arc(hi + 1) - arc(i as isize) < w && turn[(hi + 1).rem_euclid(n as isize) as usize] >= turn[i] - 3.0 {
                hi += 1;
            }
            let target = (arc(lo) + arc(hi)) / 2.0;
            let mid = (lo..=hi).min_by(|&a, &b| (arc(a) - target).abs().total_cmp(&(arc(b) - target).abs())).unwrap_or(i as isize);
            let c = mid.rem_euclid(n as isize) as usize;
            if !corners.contains(&c) {
                corners.push(c);
            }
        }
    }
    corners.sort();
    // One corner per tip: of corners closer than two windows, keep the sharper.
    let mut merged: Vec<usize> = vec![];
    for &c in &corners {
        let close = merged.iter().position(|&m| {
            let d = (s[c] - s[m]).abs();
            d.min(total - d) < 2.0 * w
        });
        match close {
            Some(k) if turn[c] > turn[merged[k]] => merged[k] = c,
            Some(_) => {}
            None => merged.push(c),
        }
    }
    let mut corners = merged;
    corners.sort();
    corners.dedup();
    // Put each corner where its two sides would meet, so straight sides stay on the true edge
    // instead of cutting across a rounded tip.
    let mut sharp: Vec<Vec2> = pts.to_vec();
    // How far along each side the rounded tip reaches; those points are left out of the fit.
    let mut cut = vec![0.0; n];
    for &c in &corners {
        // Sample the sides clear of the rounded tip (but not past the next corner).
        let gap = |dir: f64| {
            corners.iter().filter(|&&o| o != c).map(|&o| if dir > 0.0 { (s[o] - s[c]).rem_euclid(total) } else { (s[c] - s[o]).rem_euclid(total) }).fold(total, f64::min)
        };
        let (rb, ra) = ((gap(-1.0) / 2.0).min(3.0 * w), (gap(1.0) / 2.0).min(3.0 * w));
        // A least-squares line through each side (a two-point line would carry pixel noise).
        let side = |dir: isize, from: f64, to: f64| -> Option<(Vec2, Vec2)> {
            let mut pts_side = vec![];
            let mut m = c as isize;
            while (m - c as isize).abs() < n as isize {
                let d = (arc(m) - arc(c as isize)).abs();
                if d > to {
                    break;
                }
                if d >= from {
                    pts_side.push(at(m));
                }
                m += dir;
            }
            if pts_side.len() < 2 {
                return None;
            }
            let k = pts_side.len() as f64;
            let cen = pts_side.iter().fold(Vec2::default(), |a, &p| a + p) * (1.0 / k);
            let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
            for p in &pts_side {
                let d = *p - cen;
                sxx += d.x * d.x;
                sxy += d.x * d.y;
                syy += d.y * d.y;
            }
            let ang = 0.5 * (2.0 * sxy).atan2(sxx - syy);
            let mut u = Vec2 { x: ang.cos(), y: ang.sin() };
            // Point it away from the corner.
            if (cen - at(c as isize)).dot(u) < 0.0 {
                u = -u;
            }
            Some((cen, u))
        };
        let (Some((b1, ub)), Some((a1, ua))) = (side(-1, rb / 4.0, rb), side(1, ra / 4.0, ra)) else { continue };
        // Along the travel direction: into the corner on the way in, out of it on the way out.
        let (d1, d2) = (-ub, ua);
        let cross = d1.x * d2.y - d1.y * d2.x;
        if cross.abs() < (prm.corner_deg.to_radians() / 2.0).sin() {
            continue;
        }
        let t = ((a1 - b1).x * d2.y - (a1 - b1).y * d2.x) / cross;
        let x = b1 + d1 * t;
        if x.dist(pts[c]) < 1.5 * w {
            sharp[c] = x;
            cut[c] = w;
        }
    }
    let pts = &sharp[..];
    // Split points: the corners, plus smooth splits at quarter turns when there are few corners
    // (a loop with no corner cannot be one cubic).
    let mut splits: Vec<(usize, bool)> = corners.iter().map(|&c| (c, true)).collect();
    if splits.len() < 3 {
        let base = splits.first().map(|x| s[x.0]).unwrap_or(0.0);
        for q in if splits.is_empty() { 0 } else { 1 }..4 {
            let target = (base + total * q as f64 / 4.0) % total;
            let idx = (0..n).min_by(|&a, &b| (s[a] - target).abs().total_cmp(&(s[b] - target).abs())).unwrap();
            let near = splits.iter().any(|x| {
                let d = (s[x.0] - s[idx]).abs();
                d.min(total - d) < w
            });
            if !near {
                splits.push((idx, false));
            }
        }
    }
    splits.sort();
    splits.dedup_by_key(|x| x.0);
    let tangent = |i: usize| -> Vec2 {
        let (j, k) = around(i);
        (at(k) - at(j)).normalized()
    };
    let ns = splits.len();
    path.start = pts[splits[0].0];
    for q in 0..ns {
        let (a, ca) = splits[q];
        let (b, cb) = splits[(q + 1) % ns];
        let mut run: Vec<Vec2> = vec![];
        let mut i = a;
        loop {
            let from_a = (s[i] - s[a]).rem_euclid(total);
            let to_b = (s[b] - s[i]).rem_euclid(total);
            if i == a || (from_a >= cut[a] && to_b >= cut[b]) {
                run.push(pts[i]);
            }
            i = (i + 1) % n;
            if i == b {
                run.push(pts[b]);
                break;
            }
        }
        let t1 = if ca { None } else { Some(tangent(a)) };
        let t2 = if cb { None } else { Some(-tangent(b)) };
        fit_run(&run, t1, t2, prm, &mut path.segs);
    }
    // Close exactly on the start.
    if let Some(last) = path.segs.last_mut() {
        match last {
            Seg::Line(p) | Seg::Cubic(_, _, p) => *p = path.start,
        }
    }
    path
}

/// Add points along a closed loop so no gap is longer than `step`.
fn densify(pts: &[Vec2], step: f64) -> Vec<Vec2> {
    let n = pts.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        out.push(a);
        let k = (a.dist(b) / step).floor() as usize;
        for j in 1..=k.min(100_000) {
            let t = j as f64 / (k + 1) as f64;
            out.push(a + (b - a) * t);
        }
    }
    out
}

/// Fit an open run of points (no corner search) from the first point to the last.
pub fn fit_open(pts: &[Vec2], tol: f64, name: &str) -> Path {
    let mut path = Path::new(pts.first().copied().unwrap_or_default(), name);
    if pts.len() >= 2 {
        let prm = FitParams { tol, corner_deg: 180.0, window: 0.0 };
        fit_run(pts, None, None, &prm, &mut path.segs);
    }
    path
}

/// One run between split points: a line if it is straight enough, else cubics.
fn fit_run(run: &[Vec2], t1: Option<Vec2>, t2: Option<Vec2>, prm: &FitParams, out: &mut Vec<Seg>) {
    let (p0, pn) = (run[0], *run.last().unwrap());
    // Straight: within tolerance everywhere, or (for noisy traced edges) within half of it on
    // average and never far off.
    let dists: Vec<f64> = run.iter().map(|&p| seg_dist(p, p0, pn)).collect();
    let max = dists.iter().cloned().fold(0.0, f64::max);
    let rms = (dists.iter().map(|d| d * d).sum::<f64>() / dists.len().max(1) as f64).sqrt();
    let straight = max <= prm.tol || (rms <= prm.tol * 0.5 && max <= prm.tol * 2.5);
    if run.len() <= 2 || straight && p0.dist(pn) > 1e-9 {
        out.push(Seg::Line(pn));
        return;
    }
    // Drop duplicate points (they break the chord-length parameter).
    let mut d: Vec<Vec2> = Vec::with_capacity(run.len());
    for &p in run {
        if d.last().map_or(true, |q: &Vec2| q.dist(p) > 1e-9) {
            d.push(p);
        }
    }
    if d.len() < 2 {
        return;
    }
    let reach = (prm.window.max(prm.tol * 3.0)).min(polylen(&d) / 4.0);
    let t1 = t1.unwrap_or_else(|| end_tangent(&d, reach));
    let t2 = t2.unwrap_or_else(|| {
        let r: Vec<Vec2> = d.iter().rev().copied().collect();
        end_tangent(&r, reach)
    });
    let start = out.len();
    fit_cubic(&d, t1, t2, prm.tol, out, 0);
    // Cubics that came out straight become lines.
    let mut cur = p0;
    for s in out[start..].iter_mut() {
        if let Seg::Cubic(c1, c2, p) = *s {
            if seg_dist(c1, cur, p) < prm.tol * 0.5 && seg_dist(c2, cur, p) < prm.tol * 0.5 && cur.dist(p) > 1e-9 {
                *s = Seg::Line(p);
            }
        }
        cur = s.end();
    }
}

fn polylen(d: &[Vec2]) -> f64 {
    d.windows(2).map(|w| w[0].dist(w[1])).sum()
}

/// Direction leaving `d[0]`, from the first point at least `reach` along.
fn end_tangent(d: &[Vec2], reach: f64) -> Vec2 {
    let mut acc = 0.0;
    for i in 1..d.len() {
        acc += d[i - 1].dist(d[i]);
        if acc >= reach || i == d.len() - 1 {
            return (d[i] - d[0]).normalized();
        }
    }
    (d[d.len() - 1] - d[0]).normalized()
}

fn bern(u: f64) -> [f64; 4] {
    let m = 1.0 - u;
    [m * m * m, 3.0 * u * m * m, 3.0 * u * u * m, u * u * u]
}

/// Schneider's recursive fit: one cubic if it is within `tol`, else split at the worst point.
fn fit_cubic(d: &[Vec2], t1: Vec2, t2: Vec2, tol: f64, out: &mut Vec<Seg>, depth: u32) {
    let n = d.len();
    let (p0, pn) = (d[0], d[n - 1]);
    if n == 2 {
        let dist = p0.dist(pn) / 3.0;
        out.push(Seg::Cubic(p0 + t1 * dist, pn + t2 * dist, pn));
        return;
    }
    let mut u = chord_params(d);
    let mut bez = generate(d, &u, t1, t2);
    let (mut err, mut split) = max_error(d, &bez, &u);
    if err <= tol {
        out.push(Seg::Cubic(bez[1], bez[2], pn));
        return;
    }
    if err <= tol * 4.0 {
        for _ in 0..6 {
            u = reparameterize(d, &u, &bez);
            bez = generate(d, &u, t1, t2);
            let (e, s) = max_error(d, &bez, &u);
            err = e;
            split = s;
            if err <= tol {
                out.push(Seg::Cubic(bez[1], bez[2], pn));
                return;
            }
        }
    }
    if depth > 16 || n < 4 {
        out.push(Seg::Cubic(bez[1], bez[2], pn));
        return;
    }
    let split = split.clamp(1, n - 2);
    let tc = (d[split - 1] - d[split + 1]).normalized();
    let tc = if tc.len() < 0.5 { (d[split - 1] - d[split]).normalized() } else { tc };
    fit_cubic(&d[..=split], t1, tc, tol, out, depth + 1);
    fit_cubic(&d[split..], -tc, t2, tol, out, depth + 1);
}

fn chord_params(d: &[Vec2]) -> Vec<f64> {
    let mut u = vec![0.0; d.len()];
    for i in 1..d.len() {
        u[i] = u[i - 1] + d[i].dist(d[i - 1]);
    }
    let l = *u.last().unwrap();
    if l > 0.0 {
        for x in &mut u {
            *x /= l;
        }
    }
    u
}

fn generate(d: &[Vec2], u: &[f64], t1: Vec2, t2: Vec2) -> [Vec2; 4] {
    let (p0, pn) = (d[0], d[d.len() - 1]);
    let (mut c00, mut c01, mut c11, mut x0, mut x1) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (i, &ui) in u.iter().enumerate() {
        let b = bern(ui);
        let a0 = t1 * b[1];
        let a1 = t2 * b[2];
        c00 += a0.dot(a0);
        c01 += a0.dot(a1);
        c11 += a1.dot(a1);
        let tmp = d[i] - (p0 * (b[0] + b[1]) + pn * (b[2] + b[3]));
        x0 += a0.dot(tmp);
        x1 += a1.dot(tmp);
    }
    let det = c00 * c11 - c01 * c01;
    let seg = p0.dist(pn);
    let (mut al, mut ar) = if det.abs() > 1e-12 { ((x0 * c11 - x1 * c01) / det, (c00 * x1 - c01 * x0) / det) } else { (0.0, 0.0) };
    let eps = 1e-6 * seg.max(1e-9);
    if !(al > eps && ar > eps) || al > seg * 4.0 || ar > seg * 4.0 {
        let l = if seg > 1e-9 { seg / 3.0 } else { polylen(d) / 3.0 };
        al = l;
        ar = l;
    }
    [p0, p0 + t1 * al, pn + t2 * ar, pn]
}

fn max_error(d: &[Vec2], b: &[Vec2; 4], u: &[f64]) -> (f64, usize) {
    let mut best = (0.0, d.len() / 2);
    for i in 1..d.len() - 1 {
        let e = cubic_point(b[0], b[1], b[2], b[3], u[i]).dist(d[i]);
        if e > best.0 {
            best = (e, i);
        }
    }
    best
}

fn reparameterize(d: &[Vec2], u: &[f64], b: &[Vec2; 4]) -> Vec<f64> {
    let q1 = [(b[1] - b[0]) * 3.0, (b[2] - b[1]) * 3.0, (b[3] - b[2]) * 3.0];
    let q2 = [(q1[1] - q1[0]) * 2.0, (q1[2] - q1[1]) * 2.0];
    d.iter()
        .zip(u)
        .map(|(&p, &t)| {
            let q = cubic_point(b[0], b[1], b[2], b[3], t);
            let m = 1.0 - t;
            let d1 = q1[0] * (m * m) + q1[1] * (2.0 * m * t) + q1[2] * (t * t);
            let d2 = q2[0] * m + q2[1] * t;
            let num = (q - p).dot(d1);
            let den = d1.dot(d1) + (q - p).dot(d2);
            if den.abs() < 1e-12 {
                t
            } else {
                (t - num / den).clamp(0.0, 1.0)
            }
        })
        .collect()
}

/// Largest distance from the points to the path (dense sampling of the path).
pub fn max_deviation(pts: &[Vec2], path: &Path) -> f64 {
    let mut poly = path.flatten();
    if path.closed {
        poly.push(poly[0]);
    }
    pts.iter()
        .map(|&p| poly.windows(2).map(|w| seg_dist(p, w[0], w[1])).fold(f64::INFINITY, f64::min))
        .fold(0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::v;

    #[test]
    fn import_fit_circle_and_square() {
        let circle: Vec<Vec2> = (0..400).map(|i| {
            let t = i as f64 / 400.0 * std::f64::consts::TAU;
            v(50.0 + 30.0 * t.cos(), 50.0 + 30.0 * t.sin())
        }).collect();
        let p = fit_closed(&circle, &FitParams::default(), "c");
        assert!(p.segs.len() <= 8 && p.segs.iter().all(|s| matches!(s, Seg::Cubic(..))), "{}", p.segs.len());
        assert!(max_deviation(&circle, &p) < 0.25);

        let mut sq = vec![];
        for i in 0..100 {
            sq.push(v(i as f64, 0.0));
        }
        for i in 0..100 {
            sq.push(v(100.0, i as f64));
        }
        for i in 0..100 {
            sq.push(v(100.0 - i as f64, 100.0));
        }
        for i in 0..100 {
            sq.push(v(0.0, 100.0 - i as f64));
        }
        let p = fit_closed(&sq, &FitParams::default(), "s");
        assert_eq!(p.segs.len(), 4, "{:?}", p.segs);
        assert!(p.segs.iter().all(|s| matches!(s, Seg::Line(_))));
        assert!(max_deviation(&sq, &p) < 1e-9);
    }

    #[test]
    fn import_rdp_keeps_corners() {
        let pts = vec![v(0.0, 0.0), v(5.0, 0.01), v(10.0, 0.0), v(10.0, 10.0)];
        assert_eq!(rdp(&pts, 0.1), vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 10.0)]);
    }
}
