//! Small 2D geometry kit: vectors, cubic flattening, polygon offsets, line clipping.

use serde::{Deserialize, Serialize};
use std::ops::{Add, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

pub const fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

impl Vec2 {
    pub fn dot(self, o: Vec2) -> f64 {
        self.x * o.x + self.y * o.y
    }
    pub fn len(self) -> f64 {
        self.dot(self).sqrt()
    }
    pub fn normalized(self) -> Vec2 {
        let l = self.len();
        if l < 1e-12 {
            Vec2::default()
        } else {
            self * (1.0 / l)
        }
    }
    /// Left normal of a direction: (-y, x).
    pub fn left(self) -> Vec2 {
        v(-self.y, self.x)
    }
    pub fn dist(self, o: Vec2) -> f64 {
        (self - o).len()
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, o: Vec2) -> Vec2 {
        v(self.x + o.x, self.y + o.y)
    }
}
impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, o: Vec2) -> Vec2 {
        v(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f64> for Vec2 {
    type Output = Vec2;
    fn mul(self, s: f64) -> Vec2 {
        v(self.x * s, self.y * s)
    }
}
impl Neg for Vec2 {
    type Output = Vec2;
    fn neg(self) -> Vec2 {
        v(-self.x, -self.y)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub min: Vec2,
    pub max: Vec2,
}

impl Rect {
    pub fn empty() -> Rect {
        Rect { min: v(f64::INFINITY, f64::INFINITY), max: v(f64::NEG_INFINITY, f64::NEG_INFINITY) }
    }
    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x
    }
    pub fn include(&mut self, p: Vec2) {
        self.min = v(self.min.x.min(p.x), self.min.y.min(p.y));
        self.max = v(self.max.x.max(p.x), self.max.y.max(p.y));
    }
    pub fn union(&mut self, r: &Rect) {
        if !r.is_empty() {
            self.include(r.min);
            self.include(r.max);
        }
    }
    pub fn of(pts: &[Vec2]) -> Rect {
        let mut r = Rect::empty();
        for &p in pts {
            r.include(p);
        }
        r
    }
    pub fn width(&self) -> f64 {
        self.max.x - self.min.x
    }
    pub fn height(&self) -> f64 {
        self.max.y - self.min.y
    }
    pub fn center(&self) -> Vec2 {
        (self.min + self.max) * 0.5
    }
    pub fn translated(&self, d: Vec2) -> Rect {
        Rect { min: self.min + d, max: self.max + d }
    }
}

/// Shoelace area; the sign tells the winding.
pub fn signed_area(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    (0..n)
        .map(|i| {
            let a = pts[i];
            let b = pts[(i + 1) % n];
            a.x * b.y - b.x * a.y
        })
        .sum::<f64>()
        * 0.5
}

pub fn polyline_length(pts: &[Vec2], closed: bool) -> f64 {
    let n = pts.len();
    if n < 2 {
        return 0.0;
    }
    let segs = if closed { n } else { n - 1 };
    (0..segs).map(|i| pts[i].dist(pts[(i + 1) % n])).sum()
}

pub fn cubic_point(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2, t: f64) -> Vec2 {
    let u = 1.0 - t;
    p0 * (u * u * u) + c1 * (3.0 * u * u * t) + c2 * (3.0 * u * t * t) + p3 * (t * t * t)
}

/// Points along a cubic, excluding `p0` and including `p3`. About one point per half millimetre
/// of control polygon, enough for print-accurate curves.
pub fn flatten_cubic(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2) -> Vec<Vec2> {
    let ctrl = p0.dist(c1) + c1.dist(c2) + c2.dist(p3);
    let n = ((ctrl / 0.5).ceil() as usize).clamp(4, 200);
    (1..=n).map(|i| cubic_point(p0, c1, c2, p3, i as f64 / n as f64)).collect()
}

/// Offset a closed polygon. Positive `d` moves inward, negative outward. Each input vertex maps to
/// exactly one output vertex (mitred corners, miter length capped at 4x the offset).
pub fn offset_closed(pts: &[Vec2], d: f64) -> Vec<Vec2> {
    let n = pts.len();
    if n < 3 || d == 0.0 {
        return pts.to_vec();
    }
    let s = if signed_area(pts) > 0.0 { 1.0 } else { -1.0 };
    (0..n)
        .map(|i| {
            let p = pts[i];
            let a = pts[(i + n - 1) % n];
            let b = pts[(i + 1) % n];
            let n1 = (p - a).normalized().left() * s;
            let n2 = (b - p).normalized().left() * s;
            let bis = n1 + n2;
            let bl = bis.len();
            if bl < 1e-9 {
                return p + n1 * d;
            }
            let bis = bis * (1.0 / bl);
            let cos_half = bis.dot(n1).max(1e-6);
            let mut m = d / cos_half;
            let limit = 4.0 * d.abs();
            if m.abs() > limit {
                m = limit * m.signum();
            }
            p + bis * m
        })
        .collect()
}

/// Point at arc length `s` along an open polyline.
pub fn point_at(pts: &[Vec2], s: f64) -> Vec2 {
    let mut acc = 0.0;
    for w in pts.windows(2) {
        let l = w[0].dist(w[1]);
        if acc + l >= s - 1e-12 {
            let t = if l < 1e-12 { 0.0 } else { ((s - acc) / l).clamp(0.0, 1.0) };
            return w[0] + (w[1] - w[0]) * t;
        }
        acc += l;
    }
    *pts.last().unwrap_or(&Vec2::default())
}

/// Segments where the axis-aligned line `coord = c` lies inside a closed polygon.
/// `horizontal` means the line is y = c; otherwise x = c.
pub fn clip_axis_line(poly: &[Vec2], c: f64, horizontal: bool) -> Vec<[Vec2; 2]> {
    let n = poly.len();
    let mut xs = Vec::new();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let (ac, bc, ao, bo) = if horizontal { (a.y, b.y, a.x, b.x) } else { (a.x, b.x, a.y, b.y) };
        if (ac > c) != (bc > c) {
            xs.push(ao + (c - ac) * (bo - ao) / (bc - ac));
        }
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs.chunks(2)
        .filter(|p| p.len() == 2)
        .map(|p| if horizontal { [v(p[0], c), v(p[1], c)] } else { [v(c, p[0]), v(c, p[1])] })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_offsets_inward_both_windings() {
        let sq = vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 10.0), v(0.0, 10.0)];
        let ins = offset_closed(&sq, 1.0);
        assert!(ins[0].dist(v(1.0, 1.0)) < 1e-9);
        let mut rev = sq.clone();
        rev.reverse();
        let ins = offset_closed(&rev, 1.0);
        assert!(ins.iter().all(|p| p.x > 0.5 && p.x < 9.5));
        let out = offset_closed(&sq, -2.0);
        assert!(out[2].dist(v(12.0, 12.0)) < 1e-9);
    }

    #[test]
    fn clip_line_through_square() {
        let sq = vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 10.0), v(0.0, 10.0)];
        let segs = clip_axis_line(&sq, 4.0, true);
        assert_eq!(segs.len(), 1);
        assert!((segs[0][1].x - segs[0][0].x - 10.0).abs() < 1e-9);
    }
}
