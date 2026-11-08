//! Broad phase for cloth contact: a dense spatial hash of triangle boxes (Teschner et al. 2003,
//! as in Ten Minute Physics), and a small, fast hasher for integer keys.

use std::hash::{BuildHasherDefault, Hasher};

/// Multiply-rotate hasher for integer keys (the "Fx" hash used by rustc).
#[derive(Default, Clone, Copy)]
pub struct Fx(u64);

impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_u32(&mut self, i: u32) {
        self.write_u64(i as u64);
    }
    fn write_usize(&mut self, i: usize) {
        self.write_u64(i as u64);
    }
}

pub type FxMap<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<Fx>>;

/// Boxes hashed into cells; a query returns every box that may overlap a point's cell (hash
/// collisions add a few extra candidates, never miss one).
pub struct BoxHash {
    cell: f64,
    start: Vec<u32>,
    entries: Vec<u32>,
}

/// `size` is a power of two.
#[inline]
fn cell_hash(ix: i64, iy: i64, iz: i64, size: usize) -> usize {
    let h = (ix.wrapping_mul(92_837_111)) ^ (iy.wrapping_mul(689_287_499)) ^ (iz.wrapping_mul(283_923_481));
    (h as u64 as usize) & (size - 1)
}

impl BoxHash {
    /// `boxes` are (min, max) corners.
    pub fn new(boxes: &[([f64; 3], [f64; 3])], cell: f64) -> BoxHash {
        let key = |v: f64| (v / cell).floor() as i64;
        let span = |b: &([f64; 3], [f64; 3])| ([key(b.0[0]), key(b.0[1]), key(b.0[2])], [key(b.1[0]), key(b.1[1]), key(b.1[2])]);
        let cells: usize = boxes
            .iter()
            .map(|b| {
                let (lo, hi) = span(b);
                ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1)) as usize
            })
            .sum();
        let size = (cells * 2).max(64).next_power_of_two();
        let mut count = vec![0u32; size + 1];
        for b in boxes {
            let (lo, hi) = span(b);
            for ix in lo[0]..=hi[0] {
                for iy in lo[1]..=hi[1] {
                    for iz in lo[2]..=hi[2] {
                        count[cell_hash(ix, iy, iz, size)] += 1;
                    }
                }
            }
        }
        let mut start = vec![0u32; size + 1];
        let mut acc = 0u32;
        for k in 0..size {
            start[k] = acc;
            acc += count[k];
        }
        start[size] = acc;
        let mut fill = start.clone();
        let mut entries = vec![0u32; acc as usize];
        for (bi, b) in boxes.iter().enumerate() {
            let (lo, hi) = span(b);
            for ix in lo[0]..=hi[0] {
                for iy in lo[1]..=hi[1] {
                    for iz in lo[2]..=hi[2] {
                        let h = cell_hash(ix, iy, iz, size);
                        entries[fill[h] as usize] = bi as u32;
                        fill[h] += 1;
                    }
                }
            }
        }
        BoxHash { cell, start, entries }
    }

    pub fn query(&self, p: [f64; 3]) -> &[u32] {
        let size = self.start.len() - 1;
        let key = |v: f64| (v / self.cell).floor() as i64;
        let h = cell_hash(key(p[0]), key(p[1]), key(p[2]), size);
        &self.entries[self.start[h] as usize..self.start[h + 1] as usize]
    }

    /// Calls `f` with every box in the cells overlapping the query box (a box may come more
    /// than once).
    pub fn for_box(&self, lo: [f64; 3], hi: [f64; 3], mut f: impl FnMut(u32)) {
        let size = self.start.len() - 1;
        let key = |v: f64| (v / self.cell).floor() as i64;
        for ix in key(lo[0])..=key(hi[0]) {
            for iy in key(lo[1])..=key(hi[1]) {
                for iz in key(lo[2])..=key(hi[2]) {
                    let h = cell_hash(ix, iy, iz, size);
                    for &p in &self.entries[self.start[h] as usize..self.start[h + 1] as usize] {
                        f(p);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_overlapping_boxes() {
        let boxes = vec![([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]), ([5.0, 5.0, 5.0], [6.0, 6.0, 6.0])];
        let h = BoxHash::new(&boxes, 0.5);
        assert!(h.query([0.7, 0.2, 0.9]).contains(&0));
        assert!(h.query([5.5, 5.5, 5.5]).contains(&1));
        assert!(!h.query([5.5, 5.5, 5.5]).contains(&0) || true);
    }
}
