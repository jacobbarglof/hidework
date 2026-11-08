//! Greedy graph colouring of constraints: no two constraints of one colour move the same
//! vertex, so each colour runs as one parallel dispatch with Gauss-Seidel order between colours.

/// Colour each constraint (given by the vertices it moves) and return the constraint order
/// grouped by colour, with each colour's (start, count) in that order.
pub fn colour<F>(count: usize, vertices: usize, mut moved: F) -> (Vec<u32>, Vec<(u32, u32)>)
where
    F: FnMut(usize, &mut Vec<u32>),
{
    // used[v] holds a bitmask of colours already taking vertex v, 64 colours per word.
    let mut used: Vec<Vec<u64>> = vec![Vec::new(); vertices];
    let mut colour_of = vec![0u32; count];
    let mut buf = Vec::with_capacity(8);
    let mut ncol = 0u32;
    for k in 0..count {
        buf.clear();
        moved(k, &mut buf);
        let mut c = 0u32;
        loop {
            let (w, bit) = ((c / 64) as usize, 1u64 << (c % 64));
            if buf.iter().all(|&v| used[v as usize].get(w).is_none_or(|m| m & bit == 0)) {
                break;
            }
            c += 1;
        }
        let (w, bit) = ((c / 64) as usize, 1u64 << (c % 64));
        for &v in &buf {
            let m = &mut used[v as usize];
            if m.len() <= w {
                m.resize(w + 1, 0);
            }
            m[w] |= bit;
        }
        colour_of[k] = c;
        ncol = ncol.max(c + 1);
    }
    let mut ranges = vec![(0u32, 0u32); ncol as usize];
    for &c in &colour_of {
        ranges[c as usize].1 += 1;
    }
    let mut at = 0;
    for r in ranges.iter_mut() {
        r.0 = at;
        at += r.1;
    }
    let mut fill: Vec<u32> = ranges.iter().map(|r| r.0).collect();
    let mut order = vec![0u32; count];
    for (k, &c) in colour_of.iter().enumerate() {
        order[fill[c as usize] as usize] = k as u32;
        fill[c as usize] += 1;
    }
    (order, ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_never_share_a_vertex() {
        // A chain of springs 0-1, 1-2, ... and one hub vertex 0 tied to everything.
        let mut cons: Vec<[u32; 2]> = (0..50).map(|i| [i, i + 1]).collect();
        cons.extend((2..40).map(|i| [0, i]));
        let (order, ranges) = colour(cons.len(), 60, |k, out| out.extend(cons[k]));
        assert_eq!(order.len(), cons.len());
        for &(s, c) in &ranges {
            let mut seen = std::collections::HashSet::new();
            for &k in &order[s as usize..(s + c) as usize] {
                for v in cons[k as usize] {
                    assert!(seen.insert(v), "vertex {v} twice in one colour");
                }
            }
        }
        assert!(ranges.len() >= 39);
    }
}
