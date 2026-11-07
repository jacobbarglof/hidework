//! Triangulate a flat piece for simulation: boundary resampled at a target spacing, a triangular
//! lattice inside, Delaunay (Bowyer-Watson), then triangles outside the outline dropped.

use crate::geom::{signed_area, v, Vec2};

pub struct Mesh {
    pub points: Vec<Vec2>,
    pub triangles: Vec<[usize; 3]>,
}

fn point_in_poly(p: Vec2, poly: &[Vec2]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let ab = b - a;
    let l2 = ab.dot(ab);
    let t = if l2 < 1e-18 { 0.0 } else { ((p - a).dot(ab) / l2).clamp(0.0, 1.0) };
    p.dist(a + ab * t)
}

fn boundary_dist(p: Vec2, poly: &[Vec2]) -> f64 {
    let n = poly.len();
    (0..n).map(|i| seg_dist(p, poly[i], poly[(i + 1) % n])).fold(f64::INFINITY, f64::min)
}

/// Resample a closed outline so no boundary edge is longer than `h`, keeping every corner.
pub fn resample(poly: &[Vec2], h: f64) -> Vec<Vec2> {
    let n = poly.len();
    // Sharp corners are kept exactly; the stretches between them are spaced evenly.
    let mut corners: Vec<usize> = (0..n)
        .filter(|&i| {
            let d1 = (poly[i] - poly[(i + n - 1) % n]).normalized();
            let d2 = (poly[(i + 1) % n] - poly[i]).normalized();
            d1.dot(d2) < 0.97
        })
        .collect();
    if corners.is_empty() {
        corners.push(0);
    }
    let mut out = Vec::new();
    for (k, &start) in corners.iter().enumerate() {
        let end = corners[(k + 1) % corners.len()];
        let mut run = vec![poly[start]];
        let mut i = start;
        loop {
            i = (i + 1) % n;
            run.push(poly[i]);
            if i == end {
                break;
            }
        }
        let total: f64 = run.windows(2).map(|w| w[0].dist(w[1])).sum();
        let count = ((total / h).round() as usize).max(1);
        for j in 0..count {
            out.push(crate::geom::point_at(&run, total * j as f64 / count as f64));
        }
    }
    out
}

struct Tri {
    v: [usize; 3],
    c: Vec2,
    r2: f64,
}

fn circum(p: &[Vec2], idx: [usize; 3]) -> Tri {
    let (a, b, c) = (p[idx[0]], p[idx[1]], p[idx[2]]);
    let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if d.abs() < 1e-14 {
        return Tri { v: idx, c: a, r2: f64::INFINITY };
    }
    let (a2, b2, c2) = (a.dot(a), b.dot(b), c.dot(c));
    let ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    let uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    let cc = v(ux, uy);
    Tri { v: idx, c: cc, r2: cc.dist(a).powi(2) }
}

pub fn delaunay(points: &[Vec2]) -> Vec<[usize; 3]> {
    let mut p = points.to_vec();
    let (mut lo, mut hi) = (v(f64::INFINITY, f64::INFINITY), v(f64::NEG_INFINITY, f64::NEG_INFINITY));
    for q in points {
        lo = v(lo.x.min(q.x), lo.y.min(q.y));
        hi = v(hi.x.max(q.x), hi.y.max(q.y));
    }
    let span = (hi.x - lo.x).max(hi.y - lo.y).max(1.0) * 20.0;
    let mid = (lo + hi) * 0.5;
    let n = p.len();
    p.push(mid + v(-span, -span));
    p.push(mid + v(span, -span));
    p.push(mid + v(0.0, span));
    let mut tris = vec![circum(&p, [n, n + 1, n + 2])];
    for i in 0..n {
        let q = p[i];
        let mut edges: Vec<[usize; 2]> = Vec::new();
        tris.retain(|t| {
            if q.dist(t.c).powi(2) < t.r2 - 1e-12 {
                for k in 0..3 {
                    let e = [t.v[k], t.v[(k + 1) % 3]];
                    if let Some(pos) = edges.iter().position(|x| x[0] == e[1] && x[1] == e[0]) {
                        edges.swap_remove(pos);
                    } else {
                        edges.push(e);
                    }
                }
                false
            } else {
                true
            }
        });
        for e in edges {
            tris.push(circum(&p, [e[0], e[1], i]));
        }
    }
    tris.into_iter().filter(|t| t.v.iter().all(|&k| k < n)).map(|t| t.v).collect()
}

/// Triangulate a closed outline with roughly `target` vertices.
pub fn triangulate(outline: &[Vec2], target: usize) -> Mesh {
    let area = signed_area(outline).abs().max(1.0);
    // Equilateral lattice: about 0.866 h^2 per vertex.
    let h = (area / (target.max(30) as f64 * 0.866)).sqrt();
    let mut points = resample(outline, h);
    let (mut lo, mut hi) = (v(f64::INFINITY, f64::INFINITY), v(f64::NEG_INFINITY, f64::NEG_INFINITY));
    for q in outline {
        lo = v(lo.x.min(q.x), lo.y.min(q.y));
        hi = v(hi.x.max(q.x), hi.y.max(q.y));
    }
    let dy = h * 0.866;
    let mut row = 0;
    let mut y = lo.y + dy * 0.5;
    while y < hi.y {
        let off = if row % 2 == 0 { 0.0 } else { h * 0.5 };
        let mut x = lo.x + off + h * 0.25;
        while x < hi.x {
            let q = v(x, y);
            if point_in_poly(q, outline) && boundary_dist(q, outline) > 0.55 * h {
                points.push(q);
            }
            x += h;
        }
        y += dy;
        row += 1;
    }
    let triangles = delaunay(&points)
        .into_iter()
        .filter(|t| {
            let c = (points[t[0]] + points[t[1]] + points[t[2]]) * (1.0 / 3.0);
            point_in_poly(c, outline)
        })
        .map(|t| {
            // Consistent winding: counter-clockwise in a y-up frame.
            let (a, b, c) = (points[t[0]], points[t[1]], points[t[2]]);
            let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            if cross < 0.0 {
                [t[0], t[2], t[1]]
            } else {
                t
            }
        })
        .collect();
    Mesh { points, triangles }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rectangle_mesh_covers_its_area() {
        let rect = vec![v(0.0, 0.0), v(100.0, 0.0), v(100.0, 60.0), v(0.0, 60.0)];
        let m = triangulate(&rect, 400);
        let area: f64 = m
            .triangles
            .iter()
            .map(|t| {
                let (a, b, c) = (m.points[t[0]], m.points[t[1]], m.points[t[2]]);
                ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2.0
            })
            .sum();
        assert!((area - 6000.0).abs() < 1.0, "{area}");
        assert!(m.points.len() > 250 && m.points.len() < 700, "{}", m.points.len());
    }

    #[test]
    fn concave_shape_stays_inside() {
        // An L shape: the notch must stay empty.
        let l = vec![v(0.0, 0.0), v(80.0, 0.0), v(80.0, 30.0), v(30.0, 30.0), v(30.0, 80.0), v(0.0, 80.0)];
        let m = triangulate(&l, 300);
        let area: f64 = m
            .triangles
            .iter()
            .map(|t| {
                let (a, b, c) = (m.points[t[0]], m.points[t[1]], m.points[t[2]]);
                ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() / 2.0
            })
            .sum();
        assert!((area - (80.0 * 30.0 + 30.0 * 50.0)).abs() < 2.0, "{area}");
    }
}
