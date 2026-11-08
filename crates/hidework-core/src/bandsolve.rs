//! Sparse Cholesky for the per-piece implicit bending solve: reverse Cuthill-McKee ordering and
//! an envelope (profile) factor, which stores each row only from its first non-zero, so its cost
//! follows the mesh's real row widths rather than the widest one. The solve carries the x, y and
//! z right-hand sides together (one pass over the factor instead of three).

use std::collections::VecDeque;

pub struct Band3 {
    n: usize,
    /// Widest row (for reports).
    bw: usize,
    /// perm[k] = original index at position k.
    perm: Vec<u32>,
    /// Row k of L holds columns first[k] ..= k, stored from start[k].
    first: Vec<u32>,
    start: Vec<u32>,
    l: Vec<f64>,
    /// 1 / L(k, k).
    inv_diag: Vec<f64>,
}

fn rcm(n: usize, graph: &[Vec<usize>]) -> Vec<usize> {
    let mut order = Vec::with_capacity(n);
    let mut seen = vec![false; n];
    while order.len() < n {
        let start = (0..n).filter(|&i| !seen[i]).min_by_key(|&i| graph[i].len()).unwrap();
        let mut q = VecDeque::from([start]);
        seen[start] = true;
        while let Some(i) = q.pop_front() {
            order.push(i);
            let mut nb: Vec<usize> = graph[i].iter().copied().filter(|&j| !seen[j]).collect();
            nb.sort_by_key(|&j| graph[j].len());
            nb.dedup();
            for j in nb {
                if !seen[j] {
                    seen[j] = true;
                    q.push_back(j);
                }
            }
        }
    }
    order.reverse();
    order
}

impl Band3 {
    /// Factor a symmetric positive definite matrix given as entries (i, j, value); entries may
    /// repeat (they add) and either triangle may be given.
    pub fn factor(n: usize, entries: &[(usize, usize, f64)]) -> Result<Band3, String> {
        let mut graph = vec![Vec::new(); n];
        for &(i, j, _) in entries {
            if i != j {
                graph[i].push(j);
                graph[j].push(i);
            }
        }
        for g in graph.iter_mut() {
            g.sort_unstable();
            g.dedup();
        }
        let perm = rcm(n, &graph);
        let mut pos = vec![0usize; n];
        for (k, &i) in perm.iter().enumerate() {
            pos[i] = k;
        }
        // The envelope: each row from its leftmost entry (fill-in stays inside it).
        let mut first: Vec<usize> = (0..n).collect();
        for &(i, j, _) in entries {
            let (r, c) = if pos[i] >= pos[j] { (pos[i], pos[j]) } else { (pos[j], pos[i]) };
            first[r] = first[r].min(c);
        }
        let mut start = vec![0usize; n + 1];
        for r in 0..n {
            start[r + 1] = start[r] + (r - first[r] + 1);
        }
        let mut l = vec![0.0; start[n]];
        for &(i, j, v) in entries {
            let (r, c) = if pos[i] >= pos[j] { (pos[i], pos[j]) } else { (pos[j], pos[i]) };
            l[start[r] + (c - first[r])] += v;
        }
        let mut inv_diag = vec![0.0; n];
        for i in 0..n {
            let ri = start[i] - first[i];
            for j in first[i]..=i {
                let rj = start[j] - first[j];
                let k0 = first[i].max(first[j]);
                let mut s = l[ri + j];
                for k in k0..j {
                    s -= l[ri + k] * l[rj + k];
                }
                if i == j {
                    if s <= 0.0 || !s.is_finite() {
                        return Err("bending matrix is not positive definite".into());
                    }
                    l[ri + i] = s.sqrt();
                    inv_diag[i] = 1.0 / l[ri + i];
                } else {
                    l[ri + j] = s * inv_diag[j];
                }
            }
        }
        let bw = (0..n).map(|r| r - first[r]).max().unwrap_or(0);
        Ok(Band3 {
            n,
            bw,
            perm: perm.into_iter().map(|p| p as u32).collect(),
            first: first.into_iter().map(|f| f as u32).collect(),
            start: start.into_iter().map(|s| s as u32).collect(),
            l,
            inv_diag,
        })
    }

    /// Size and widest row of the factor.
    pub fn shape(&self) -> (usize, usize) {
        (self.n, self.bw)
    }

    /// Solve A x = b for three right-hand sides at once (in place, original ordering).
    pub fn solve(&self, b: &mut [[f64; 3]]) {
        let n = self.n;
        let mut y: Vec<[f64; 3]> = (0..n).map(|k| b[self.perm[k] as usize]).collect();
        for i in 0..n {
            let (f, s0) = (self.first[i] as usize, self.start[i] as usize);
            let row = &self.l[s0..s0 + (i - f)];
            let mut s = y[i];
            for (lv, yk) in row.iter().zip(&y[f..i]) {
                s[0] -= lv * yk[0];
                s[1] -= lv * yk[1];
                s[2] -= lv * yk[2];
            }
            let d = self.inv_diag[i];
            y[i] = [s[0] * d, s[1] * d, s[2] * d];
        }
        for i in (0..n).rev() {
            let d = self.inv_diag[i];
            let xi = [y[i][0] * d, y[i][1] * d, y[i][2] * d];
            y[i] = xi;
            let (f, s0) = (self.first[i] as usize, self.start[i] as usize);
            let row = &self.l[s0..s0 + (i - f)];
            for (lv, yk) in row.iter().zip(y[f..i].iter_mut()) {
                yk[0] -= lv * xi[0];
                yk[1] -= lv * xi[1];
                yk[2] -= lv * xi[2];
            }
        }
        for k in 0..n {
            b[self.perm[k] as usize] = y[k];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(n: usize, e: &[(usize, usize, f64)]) {
        let f = Band3::factor(n, e).unwrap();
        let xt: Vec<[f64; 3]> = (0..n).map(|i| [(i as f64 * 0.3).cos(), i as f64, -1.0]).collect();
        let mut b = vec![[0.0; 3]; n];
        for &(i, j, v) in e {
            for c in 0..3 {
                b[i][c] += v * xt[j][c];
                if i != j {
                    b[j][c] += v * xt[i][c];
                }
            }
        }
        f.solve(&mut b);
        for i in 0..n {
            for c in 0..3 {
                assert!((b[i][c] - xt[i][c]).abs() < 1e-9, "{i} {c}");
            }
        }
    }

    #[test]
    fn solves_a_scrambled_chain() {
        let n = 30;
        let map: Vec<usize> = (0..n).map(|i| (i * 7) % n).collect();
        let mut e = vec![];
        for i in 0..n {
            e.push((map[i], map[i], 3.0));
            if i + 1 < n {
                e.push((map[i], map[i + 1], -1.0));
            }
        }
        assert!(Band3::factor(n, &e).unwrap().bw <= 2);
        check(n, &e);
    }

    #[test]
    fn solves_a_grid() {
        // A 2D grid Laplacian plus mass, scrambled.
        let (w, h) = (9, 7);
        let n = w * h;
        let id = |x: usize, y: usize| ((x + y * w) * 37) % n;
        let mut e = vec![];
        for y in 0..h {
            for x in 0..w {
                e.push((id(x, y), id(x, y), 5.0));
                if x + 1 < w {
                    e.push((id(x, y), id(x + 1, y), -1.0));
                }
                if y + 1 < h {
                    e.push((id(x, y), id(x, y + 1), -1.0));
                }
            }
        }
        check(n, &e);
    }
}
