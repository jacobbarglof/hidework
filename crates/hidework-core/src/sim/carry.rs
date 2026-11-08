//! Live update: when the pattern changes while the 3D model is up, the new simulation starts from
//! the shape the old one is in now instead of laying the pieces out flat again. Each new point is
//! found on the old piece by its pattern position (the same place on the leather) and takes the
//! old 3D position there; points on a piece that grew are carried by the nearest old triangle.
//! Pieces that are new keep their arranged start.

use super::*;

/// Barycentric weights of `q` in the triangle `a b c` (may be negative outside), or None for a
/// degenerate triangle.
fn bary(a: (f64, f64), b: (f64, f64), c: (f64, f64), q: (f64, f64)) -> Option<[f64; 3]> {
    let (v0, v1, v2) = ((b.0 - a.0, b.1 - a.1), (c.0 - a.0, c.1 - a.1), (q.0 - a.0, q.1 - a.1));
    let den = v0.0 * v1.1 - v1.0 * v0.1;
    if den.abs() < 1e-12 {
        return None;
    }
    let v = (v2.0 * v1.1 - v1.0 * v2.1) / den;
    let w = (v0.0 * v2.1 - v2.0 * v0.1) / den;
    Some([1.0 - v - w, v, w])
}

impl Sim {
    /// The simulation for an edited `project`, starting from the shape `old` is in now.
    pub fn carry_over(project: &Project, spec: SimSpec, old: &Sim) -> Result<Sim, String> {
        let mut sim = Sim::new(project, spec)?;
        sim.take_shape(old);
        Ok(sim)
    }

    /// Move every point of a piece that `old` also has to where that spot of leather is in `old`.
    /// Returns how many points were carried.
    pub fn take_shape(&mut self, old: &Sim) -> usize {
        let mut carried = 0;
        let rest = |s: &Sim, i: usize| (s.info.rest[2 * i] as f64, s.info.rest[2 * i + 1] as f64);
        let pieces = self.info.pieces.clone();
        for np in &pieces {
            let Some(op) = old.info.pieces.iter().find(|p| p.id == np.id) else { continue };
            let (os, oe) = (op.vertex_start as usize, (op.vertex_start + op.vertex_count) as usize);
            let otris: Vec<[usize; 3]> = old.tris.iter().filter(|t| t[0] >= os && t[0] < oe).copied().collect();
            if otris.is_empty() {
                continue;
            }
            for v in np.vertex_start as usize..(np.vertex_start + np.vertex_count) as usize {
                let q = rest(self, v);
                // The triangle the point sits in, or failing that the one it is least outside.
                let mut best: Option<([usize; 3], [f64; 3])> = None;
                let mut score = f64::NEG_INFINITY;
                for t in &otris {
                    if let Some(b) = bary(rest(old, t[0]), rest(old, t[1]), rest(old, t[2]), q) {
                        let s = b[0].min(b[1]).min(b[2]);
                        if s > score {
                            score = s;
                            best = Some((*t, b));
                            if s >= 0.0 {
                                break;
                            }
                        }
                    }
                }
                let Some((t, b)) = best else { continue };
                let mut p = [0.0; 3];
                for k in 0..3 {
                    let o = old.x[t[k]];
                    for d in 0..3 {
                        p[d] += b[k] * o[d];
                    }
                }
                if p.iter().all(|c| c.is_finite()) {
                    self.x[v] = p;
                    self.prev[v] = p;
                    self.vel[v] = [0.0; 3];
                    carried += 1;
                }
            }
        }
        if carried > 0 {
            // Seams draw closed again from where they are now: ones already sewn have no gap left,
            // a new seam closes gently instead of snapping.
            let x = &self.x;
            for (k, w) in self.welds.iter().enumerate() {
                self.weld_start[k] = norm(sub(w.b.pos(x), w.a.pos(x)));
            }
        }
        carried
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edited_tote_keeps_its_shape() {
        let mut p = crate::templates::by_id("tote").unwrap();
        let spec = SimSpec { resolution: 300, ..Default::default() };
        let mut old = Sim::new(&p, spec.clone()).unwrap();
        old.step(180);
        // Make the front 10 mm taller at the top, as a user would by dragging its edge.
        let front = p.pieces.iter_mut().find(|pc| pc.id == "front").unwrap();
        let top = front.vertices.iter().map(|v| v.y).fold(f64::INFINITY, f64::min);
        for v in front.vertices.iter_mut() {
            if (v.y - top).abs() < 1e-6 {
                v.y -= 10.0;
            }
        }
        let mut sim = Sim::carry_over(&p, spec, &old).unwrap();
        let fr = sim.info.pieces.iter().find(|pc| pc.id == "front").unwrap().clone();
        // The front starts standing where the old front stood, not flat where a fresh build puts it.
        let height = |s: &Sim| {
            let r = fr.vertex_start as usize..(fr.vertex_start + fr.vertex_count) as usize;
            let zs: Vec<f64> = r.map(|i| s.x[i][2]).collect();
            zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - zs.iter().cloned().fold(f64::INFINITY, f64::min)
        };
        let old_front = old.info.pieces.iter().find(|pc| pc.id == "front").unwrap();
        let old_h = {
            let r = old_front.vertex_start as usize..(old_front.vertex_start + old_front.vertex_count) as usize;
            let zs: Vec<f64> = r.map(|i| old.x[i][2]).collect();
            zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - zs.iter().cloned().fold(f64::INFINITY, f64::min)
        };
        assert!((height(&sim) - old_h).abs() < 0.03, "carried {} vs old {}", height(&sim), old_h);
        sim.step(90);
        assert!(sim.x.iter().all(|p| p.iter().all(|c| c.is_finite())));
        assert!(height(&sim) > 0.8 * old_h, "the bag fell over after the edit");
    }
}
