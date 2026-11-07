//! Sparse symmetric positive-definite solves for mesh-sized systems: reverse Cuthill-McKee
//! reordering to a narrow band, then a banded Cholesky factorization.

use std::collections::{BTreeMap, VecDeque};

/// Symmetric matrix assembled entry by entry (only i >= j stored).
pub struct SymBuilder {
    pub n: usize,
    rows: Vec<BTreeMap<usize, f64>>,
}

impl SymBuilder {
    pub fn new(n: usize) -> Self {
        SymBuilder { n, rows: vec![BTreeMap::new(); n] }
    }
    pub fn add(&mut self, i: usize, j: usize, v: f64) {
        let (a, b) = if i >= j { (i, j) } else { (j, i) };
        *self.rows[a].entry(b).or_insert(0.0) += v;
    }
    pub fn get(&self, i: usize, j: usize) -> f64 {
        let (a, b) = if i >= j { (i, j) } else { (j, i) };
        self.rows[a].get(&b).copied().unwrap_or(0.0)
    }
    /// Every stored entry (i >= j).
    pub fn entries(&self) -> impl Iterator<Item = (usize, usize, f64)> + '_ {
        self.rows.iter().enumerate().flat_map(|(i, row)| row.iter().map(move |(&j, &v)| (i, j, v)))
    }
    /// Off-diagonal neighbours of each row (both triangles).
    fn graph(&self) -> Vec<Vec<usize>> {
        let mut g = vec![Vec::new(); self.n];
        for (i, row) in self.rows.iter().enumerate() {
            for &j in row.keys() {
                if j != i {
                    g[i].push(j);
                    g[j].push(i);
                }
            }
        }
        g
    }
}

fn rcm(graph: &[Vec<usize>]) -> Vec<usize> {
    let n = graph.len();
    let mut order = Vec::with_capacity(n);
    let mut seen = vec![false; n];
    let deg = |i: usize| graph[i].len();
    while order.len() < n {
        let start = (0..n).filter(|&i| !seen[i]).min_by_key(|&i| deg(i)).unwrap();
        let mut q = VecDeque::from([start]);
        seen[start] = true;
        while let Some(i) = q.pop_front() {
            order.push(i);
            let mut nb: Vec<usize> = graph[i].iter().copied().filter(|&j| !seen[j]).collect();
            nb.sort_by_key(|&j| deg(j));
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

pub struct BandedCholesky {
    n: usize,
    bw: usize,
    /// perm[k] = original index at position k; pos[i] = position of original i.
    perm: Vec<usize>,
    pos: Vec<usize>,
    /// l[k * (bw + 1) + d] = L(k, k - d).
    l: Vec<f64>,
}

impl BandedCholesky {
    pub fn factor(a: &SymBuilder) -> Result<Self, String> {
        let n = a.n;
        let perm = rcm(&a.graph());
        let mut pos = vec![0; n];
        for (k, &i) in perm.iter().enumerate() {
            pos[i] = k;
        }
        let mut bw = 0;
        for (i, row) in a.rows.iter().enumerate() {
            for &j in row.keys() {
                bw = bw.max(pos[i].abs_diff(pos[j]));
            }
        }
        let w = bw + 1;
        let mut l = vec![0.0; n * w];
        for (i, row) in a.rows.iter().enumerate() {
            for (&j, &v) in row {
                let (r, c) = if pos[i] >= pos[j] { (pos[i], pos[j]) } else { (pos[j], pos[i]) };
                l[r * w + (r - c)] += v;
            }
        }
        for i in 0..n {
            let j0 = i.saturating_sub(bw);
            for j in j0..=i {
                let k0 = j0.max(j.saturating_sub(bw));
                let mut s = l[i * w + (i - j)];
                for k in k0..j {
                    s -= l[i * w + (i - k)] * l[j * w + (j - k)];
                }
                if i == j {
                    if s <= 0.0 {
                        return Err("matrix is not positive definite".into());
                    }
                    l[i * w] = s.sqrt();
                } else {
                    l[i * w + (i - j)] = s / l[j * w];
                }
            }
        }
        Ok(BandedCholesky { n, bw, perm, pos, l })
    }

    pub fn solve(&self, b: &[f64]) -> Vec<f64> {
        let (n, bw, w) = (self.n, self.bw, self.bw + 1);
        let mut y: Vec<f64> = (0..n).map(|k| b[self.perm[k]]).collect();
        for i in 0..n {
            let mut s = y[i];
            for k in i.saturating_sub(bw)..i {
                s -= self.l[i * w + (i - k)] * y[k];
            }
            y[i] = s / self.l[i * w];
        }
        for i in (0..n).rev() {
            let mut s = y[i];
            for k in i + 1..(i + bw + 1).min(n) {
                s -= self.l[k * w + (k - i)] * y[k];
            }
            y[i] = s / self.l[i * w];
        }
        let mut x = vec![0.0; n];
        for i in 0..n {
            x[i] = y[self.pos[i]];
        }
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_a_laplacian_chain() {
        // Tridiagonal SPD system with scrambled indices.
        let n = 40;
        let map: Vec<usize> = (0..n).map(|i| (i * 17) % n).collect();
        let mut a = SymBuilder::new(n);
        for i in 0..n {
            a.add(map[i], map[i], 3.0);
            if i + 1 < n {
                a.add(map[i], map[i + 1], -1.0);
            }
        }
        let x_true: Vec<f64> = (0..n).map(|i| (i as f64 * 0.37).sin()).collect();
        let mut b = vec![0.0; n];
        for i in 0..n {
            for j in 0..n {
                b[i] += a.get(i, j) * x_true[j];
            }
        }
        let f = BandedCholesky::factor(&a).unwrap();
        assert!(f.bw <= 2, "bandwidth {}", f.bw);
        let x = f.solve(&b);
        for i in 0..n {
            assert!((x[i] - x_true[i]).abs() < 1e-10);
        }
    }
}
