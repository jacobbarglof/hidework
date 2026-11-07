//! Fold a flat, fold-compensated piece into its finished 3D shape.
//!
//! Each fold allowance becomes a circular bend: its length L is spread over the fold angle, so at
//! 180 degrees the neutral radius is L / pi, exactly the radius the allowance was computed from.
//! The widest flat stretch between folds stays put (the "anchor"); everything else turns toward
//! the flesh side (+z), so the grain ends up outside, as on a finished wallet or cover.
//!
//! Output axes: X and Y as on the pattern, Z up. One family of folds (all horizontal or all
//! vertical) is bent; if a piece has both, the vertical ones stay flat for now.

use crate::compute::ComputedPiece;
use crate::geom::Vec2;
use crate::model::Orientation;

#[derive(Clone, Debug)]
pub struct Bender {
    horizontal: bool,
    /// Bands [start, end) in the folding axis, sorted.
    bands: Vec<(f64, f64)>,
    anchor: (f64, f64),
    angle: f64,
}

impl Bender {
    /// `angle_deg` is how far each fold closes: 0 flat, 180 fully closed.
    pub fn new(cp: &ComputedPiece, angle_deg: f64) -> Bender {
        let has_h = cp.folds.iter().any(|f| f.orientation == Orientation::Horizontal);
        let horizontal = has_h;
        let fam = if has_h { Orientation::Horizontal } else { Orientation::Vertical };
        let mut bands: Vec<(f64, f64)> = cp.folds.iter().filter(|f| f.orientation == fam).map(|f| (f.at, f.at + f.shift_mm)).collect();
        bands.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let (lo, hi) = if horizontal { (cp.bounds.min.y, cp.bounds.max.y) } else { (cp.bounds.min.x, cp.bounds.max.x) };
        let mut best = (lo, hi, f64::NEG_INFINITY);
        let mut start = lo;
        for &(a, b) in bands.iter().chain([(hi, hi)].iter()) {
            if a - start > best.2 {
                best = (start, a, a - start);
            }
            start = b;
        }
        Bender { horizontal, bands, anchor: (best.0, best.1), angle: angle_deg.to_radians().clamp(0.0, std::f64::consts::PI) }
    }

    pub fn is_flat(&self) -> bool {
        self.bands.is_empty() || self.angle < 1e-6
    }

    /// Walk `s` along a chain starting at 0 through `bands` (relative, increasing). Returns the
    /// neutral point (along, up) and the heading angle there.
    fn walk(&self, s: f64, bands: &[(f64, f64)]) -> (f64, f64, f64) {
        let (mut px, mut py, mut phi) = (0.0f64, 0.0f64, 0.0f64);
        let mut cur = 0.0;
        for &(b0, b1) in bands {
            let end = s.min(b0);
            if end > cur {
                px += (end - cur) * phi.cos();
                py += (end - cur) * phi.sin();
            }
            if s <= b0 {
                return (px, py, phi);
            }
            let len = b1 - b0;
            let arc = s.min(b1) - b0;
            if self.angle < 1e-6 || len <= 0.0 {
                px += arc * phi.cos();
                py += arc * phi.sin();
            } else {
                let r = len / self.angle;
                let (cx, cy) = (px - r * phi.sin(), py + r * phi.cos());
                let a = arc / r;
                phi += a;
                px = cx + r * phi.sin();
                py = cy - r * phi.cos();
            }
            cur = b0 + arc;
            if s <= b1 {
                return (px, py, phi);
            }
        }
        if s > cur {
            px += (s - cur) * phi.cos();
            py += (s - cur) * phi.sin();
        }
        (px, py, phi)
    }

    /// Map a pattern point at offset `w` from the neutral surface (positive toward the flesh
    /// side) to 3D. Also returns the surface normal (toward the flesh side).
    pub fn map(&self, p: Vec2, w: f64) -> ([f64; 3], [f64; 3]) {
        let (s, across) = if self.horizontal { (p.y, p.x) } else { (p.x, p.y) };
        let (a0, a1) = self.anchor;
        let (along, up, phi, dir) = if s >= a0 && s <= a1 || self.is_flat() {
            (s, 0.0, 0.0, 1.0)
        } else if s > a1 {
            let rel: Vec<(f64, f64)> = self.bands.iter().filter(|b| b.0 >= a1 - 1e-9).map(|b| (b.0 - a1, b.1 - a1)).collect();
            let (u, h, phi) = self.walk(s - a1, &rel);
            (a1 + u, h, phi, 1.0)
        } else {
            let mut rel: Vec<(f64, f64)> = self.bands.iter().filter(|b| b.1 <= a0 + 1e-9).map(|b| (a0 - b.1, a0 - b.0)).collect();
            rel.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
            let (u, h, phi) = self.walk(a0 - s, &rel);
            (a0 - u, h, phi, -1.0)
        };
        // Normal of the walked chain: (-sin phi, cos phi) in (walk direction, up).
        let n_along = -phi.sin() * dir;
        let n_up = phi.cos();
        let along = along + w * n_along;
        let up = up + w * n_up;
        if self.horizontal {
            ([across, along, up], [0.0, n_along, n_up])
        } else {
            ([along, across, up], [n_along, 0.0, n_up])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::compute;
    use crate::geom::v;
    use crate::templates::{card_wallet, journal_cover};

    #[test]
    fn closed_wallet_front_lands_over_the_back_with_the_card_gap() {
        let p = card_wallet();
        let c = compute(&p);
        let b = Bender::new(&c.pieces[0], 180.0);
        // The back (larger part) is the anchor and stays flat.
        let (q, n) = b.map(v(50.0, 100.0), 0.0);
        assert!((q[2]).abs() < 1e-9 && (n[2] - 1.0).abs() < 1e-9);
        // The front's top edge folds over: same x, above the back by the contents + thickness.
        let t = c.pieces[0].thickness_mm;
        let (f, nf) = b.map(v(50.0, 0.0), 0.0);
        assert!((f[2] - (4.0 + t)).abs() < 1e-6, "{f:?}");
        assert!(nf[2] < -0.999);
        // Inner faces sit exactly the card gap apart.
        let (inner_top, _) = b.map(v(50.0, 0.0), t / 2.0);
        let (inner_bottom, _) = b.map(v(50.0, 100.0), t / 2.0);
        assert!((inner_top[2] - inner_bottom[2] - 4.0).abs() < 1e-6);
    }

    #[test]
    fn journal_flaps_fold_and_main_panel_stays() {
        let p = journal_cover();
        let c = compute(&p);
        let b = Bender::new(&c.pieces[0], 180.0);
        let (mid, _) = b.map(v(230.0, 100.0), 0.0);
        assert!(mid[2].abs() < 1e-9);
        let (left_flap, _) = b.map(v(10.0, 100.0), 0.0);
        let (right_flap, _) = b.map(v(c.pieces[0].bounds.max.x - 10.0, 100.0), 0.0);
        assert!(left_flap[2] > 2.0 && right_flap[2] > 2.0);
        assert!(left_flap[0] > 60.0, "flap folds inward: {left_flap:?}");
    }
}
