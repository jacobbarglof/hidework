//! Pattern checking from the simulation: after a run, what the 3D result says about the pattern.
//! A correct pattern assembles cleanly, so each issue here points at something to fix: a seam
//! that cannot close, leather passing through leather, a panel stretched or bunched, hardware
//! that misses its partner, a bag that will not stand.

use super::*;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimIssue {
    /// seamOpen, seamOverload, panelOverload, intersecting, overstretched, buckled,
    /// hardwareAlone, hardwareApart, notStanding, tipped, unstable.
    pub kind: String,
    /// "error" (the pattern or setup needs fixing), "warning" (worth a look) or "info".
    pub severity: String,
    pub title: String,
    pub message: String,
    /// What to change.
    pub fix: String,
    pub piece_ids: Vec<String>,
    /// Where it is in 3D (mm), for highlighting.
    pub at: Option<[f64; 3]>,
    /// Where it is on the first piece's pattern (piece-local mm).
    pub at_pattern: Option<[f64; 2]>,
    /// The measured number, the limit it was judged against, and their unit.
    pub value: f64,
    pub limit: f64,
    pub unit: String,
}

/// Mesh resolution `diagnose_project` runs at, at most.
const DIAGNOSE_RESOLUTION: usize = 400;

fn mm3(p: P3) -> [f64; 3] {
    [p[0] * 1000.0, p[1] * 1000.0, p[2] * 1000.0]
}

impl Sim {
    fn piece_name(&self, k: u32) -> String {
        self.info.pieces.get(k as usize).map_or("a piece".into(), |p| p.name.clone())
    }

    fn piece_id(&self, k: u32) -> String {
        self.info.pieces.get(k as usize).map_or(String::new(), |p| p.id.clone())
    }

    fn where_on(&self, i: usize) -> String {
        let r = self.rest2d[i];
        format!("{} at x {:.0}, y {:.0} mm on its pattern", self.piece_name(self.piece_of[i]), r.x, r.y)
    }

    #[allow(clippy::too_many_arguments)]
    fn issue(&self, kind: &str, severity: &str, title: String, message: String, fix: &str, pieces: Vec<String>, at_vertex: Option<usize>, value: f64, limit: f64, unit: &str) -> SimIssue {
        SimIssue {
            kind: kind.into(),
            severity: severity.into(),
            title,
            message,
            fix: fix.into(),
            piece_ids: pieces,
            at: at_vertex.map(|i| mm3(self.x[i])),
            at_pattern: at_vertex.map(|i| [self.rest2d[i].x, self.rest2d[i].y]),
            value,
            limit,
            unit: unit.into(),
        }
    }

    /// What the run so far says about the pattern. Cheap: one pass over the constraints and a
    /// crossing check. Most useful after a few simulated seconds (`diagnose_project` does that).
    pub fn diagnose(&self) -> Vec<SimIssue> {
        let mut out = Vec::new();
        let sewn = self.time > SEW_S + 0.4;
        let h_mm = self.h * 1000.0;

        // Seams: gap left after sewing, and stitch load against strength.
        let mut gap: HashMap<u32, (f64, usize)> = HashMap::new();
        let mut load: HashMap<u32, (f64, f64, usize)> = HashMap::new();
        for wd in &self.welds {
            let l = norm(sub(wd.b.pos(&self.x), wd.a.pos(&self.x)));
            let open = (l - wd.rest) * 1000.0;
            match wd.kind {
                WeldKind::Seam | WeldKind::Fastener => {
                    let e = gap.entry(wd.group).or_insert((0.0, wd.a.main()));
                    if open > e.0 {
                        *e = (open, wd.a.main());
                    }
                }
                _ => {}
            }
            if matches!(wd.kind, WeldKind::Seam | WeldKind::Glue | WeldKind::Fastener | WeldKind::Laminate) {
                let r = wd.f / wd.allow.max(1e-9);
                let e = load.entry(wd.group).or_insert((0.0, 0.0, wd.a.main()));
                if r > e.0 {
                    *e = (r, wd.f, wd.a.main());
                }
            }
        }
        let mut groups: Vec<_> = gap.into_iter().collect();
        groups.sort_by_key(|g| g.0);
        for (g, (open, i)) in groups {
            let grp = &self.groups[g as usize];
            let fastener = self.welds.iter().any(|w| w.group == g && w.kind == WeldKind::Fastener);
            let limit = (0.5 * h_mm).max(3.0);
            if !sewn || open <= limit {
                continue;
            }
            let sev = if open > 2.0 * limit { "error" } else { "warning" };
            if fastener {
                out.push(self.issue("hardwareApart", sev, format!("{} pulls apart", capital(&grp.label)), format!("{} is {:.0} mm from its partner near {}: the two layers do not line up there.", capital(&grp.label), open, self.where_on(i)), "Place the hardware at the same point on both layers (or arrange the pieces so the holes meet).", grp.pieces.clone(), Some(i), open, limit, "mm"));
            } else {
                out.push(self.issue("seamOpen", sev, format!("{} does not close", capital(&grp.label)), format!("After sewing, {} is still {:.0} mm open near {}. The two edges probably differ in length, or are joined in the wrong order or direction.", grp.label, open, self.where_on(i)), "Compare the two edges' stitch lengths and directions in the seam; make them match, or join the right edges.", grp.pieces.clone(), Some(i), open, limit, "mm"));
            }
        }
        let mut loads: Vec<_> = load.into_iter().collect();
        loads.sort_by_key(|g| g.0);
        for (g, (r, f, i)) in loads {
            if r <= 1.0 {
                continue;
            }
            let grp = &self.groups[g as usize];
            let allow = f / r;
            out.push(self.issue("seamOverload", "error", format!("{} is overloaded", capital(&grp.label)), format!("Each stitch or fastener of {} carries {:.0} N near {}, past the {:.0} N it holds.", grp.label, f, self.where_on(i), allow), "Use stronger thread or more stitches, glue the seam, or spread the load (wider strap, more rivets).", grp.pieces.clone(), Some(i), f, allow, "N"));
        }

        // Panels: stress past strength, and stretch a leather would not take.
        let np = self.info.pieces.len();
        let mut stress = vec![(0.0f64, 0.0f64, 0usize); np];
        // Stretch is judged over a region, not one edge: the tenth most stretched part of the piece.
        let mut strains: Vec<Vec<(f64, usize)>> = vec![vec![]; np];
        for s in &self.springs {
            let p = self.piece_of[s.a] as usize;
            let st = s.f.max(0.0) / s.area;
            if st / s.strength_pa > stress[p].0 {
                stress[p] = (st / s.strength_pa, st / 1e6, s.a);
            }
            strains[p].push((norm(sub(self.x[s.b], self.x[s.a])) / s.rest - 1.0, s.a));
        }
        let strain: Vec<(f64, usize)> = strains
            .into_iter()
            .map(|mut v| {
                if v.is_empty() {
                    return (0.0, 0);
                }
                v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
                v[v.len() / 10]
            })
            .collect();
        for p in 0..np {
            let (r, mpa, i) = stress[p];
            if r > 1.0 {
                out.push(self.issue("panelOverload", "error", format!("{} is overstressed", self.piece_name(p as u32)), format!("The leather of {} is stressed to {:.0} MPa near {}, past its {:.0} MPa strength.", self.piece_name(p as u32), mpa, self.where_on(i), mpa / r), "Use thicker or stronger leather there, or spread the load.", vec![self.piece_id(p as u32)], Some(i), mpa, mpa / r, "MPa"));
            }
            let (e, i) = strain[p];
            let pct = e * 100.0;
            if sewn && pct > 3.0 {
                let sev = if pct > 8.0 { "error" } else { "warning" };
                out.push(self.issue("overstretched", sev, format!("{} is stretched", self.piece_name(p as u32)), format!("{} is stretched {:.0}% near {}: more than leather gives. The pattern is too small for what is sewn to it, or a seam joins the wrong edges.", self.piece_name(p as u32), pct, self.where_on(i)), "Lengthen this piece along the stretched direction, or shorten the edge it is sewn to.", vec![self.piece_id(p as u32)], Some(i), pct, 3.0, "%"));
            }
        }

        // Bunching: sharp creases away from folds and seams (more leather than room for it).
        let mut sharp = vec![(0usize, 0.0f64, 0usize); np];
        for (k, (idx, _, _)) in self.bends.iter().enumerate() {
            if self.bend_fold.get(k).copied().unwrap_or(false) || idx.iter().any(|&v| self.near_weld[v]) {
                continue;
            }
            let (a, b, c, d) = (self.x[idx[0]], self.x[idx[1]], self.x[idx[2]], self.x[idx[3]]);
            let n1 = cross(sub(b, a), sub(c, a));
            let n2 = cross(sub(d, a), sub(b, a));
            let (l1, l2) = (norm(n1), norm(n2));
            if l1 < 1e-14 || l2 < 1e-14 {
                continue;
            }
            let ang = (dot(n1, n2) / (l1 * l2)).clamp(-1.0, 1.0).acos().to_degrees();
            let p = self.piece_of[idx[0]] as usize;
            if ang > 60.0 {
                sharp[p].0 += 1;
            }
            if ang > sharp[p].1 {
                sharp[p].1 = ang;
                sharp[p].2 = idx[0];
            }
        }
        for p in 0..np {
            let (count, ang, i) = sharp[p];
            if sewn && count >= 3 {
                out.push(self.issue("buckled", "warning", format!("{} buckles", self.piece_name(p as u32)), format!("{} creases sharply ({:.0} degrees) near {}: there is more leather there than the seams let lie smooth. The pattern may be too big along a seam, or the seam it joins too short.", self.piece_name(p as u32), ang, self.where_on(i)), "Check the seam lengths around this piece; trim the extra or add a dart or fold.", vec![self.piece_id(p as u32)], Some(i), ang, 60.0, "degrees"));
            }
        }

        // Leather through leather.
        let mut pairs: HashMap<(u32, u32), (usize, usize)> = HashMap::new();
        for (u, a, b) in self.crossing_edges() {
            let key = (a.min(b), a.max(b));
            let e = pairs.entry(key).or_insert((0, u));
            e.0 += 1;
        }
        let mut pairs: Vec<_> = pairs.into_iter().collect();
        pairs.sort_by_key(|p| p.0);
        for ((a, b), (count, i)) in pairs {
            let who = if a == b { format!("{} passes through itself", self.piece_name(a)) } else { format!("{} and {} pass through each other", self.piece_name(a), self.piece_name(b)) };
            let sev = if count >= 4 { "error" } else { "warning" };
            let ids = if a == b { vec![self.piece_id(a)] } else { vec![self.piece_id(a), self.piece_id(b)] };
            out.push(self.issue("intersecting", sev, capital(&who), format!("{} in {} place{} near {}.", who, count, if count == 1 { "" } else { "s" }, self.where_on(i)), "If they started crossed, change where the pieces are arranged (face, offset or layer); if a seam drags one through the other, check which edges it joins.", ids, Some(i), count as f64, 0.0, "edges"));
        }

        // Hardware with nothing to fasten.
        for (pid, label, w) in &self.lone_hw {
            let name = self.info.pieces.iter().find(|p| &p.id == pid).map_or(pid.clone(), |p| p.name.clone());
            out.push(SimIssue {
                kind: "hardwareAlone".into(),
                severity: "warning".into(),
                title: format!("{} on {} fastens nothing", label, name),
                message: format!("The {} on {} has no matching one on another layer within 6 mm, so it holds nothing together.", label.to_lowercase(), name),
                fix: "Add the matching part on the other layer at the same point, or arrange the pieces so they overlap there.".into(),
                piece_ids: vec![pid.clone()],
                at: Some(mm3(*w)),
                at_pattern: None,
                value: 0.0,
                limit: 6.0,
                unit: "mm".into(),
            });
        }

        // Standing: an arranged bag on the floor should keep its height and stay upright.
        let free = self.pins.is_empty() && self.drag.is_none() && self.objects.is_empty() && self.weights.is_empty();
        let walls: Vec<usize> = (0..self.x.len()).filter(|&i| self.standing.get(self.piece_of[i] as usize).copied().unwrap_or(false)).collect();
        if sewn && free && !walls.is_empty() {
            let top = |xs: &[P3]| walls.iter().map(|&i| xs[i][2]).fold(f64::NEG_INFINITY, f64::max);
            let (t0, t1) = (top(&self.start), top(&self.x));
            let ratio = t1 / t0.max(1e-9);
            let i_top = walls.iter().copied().max_by(|&a, &b| self.start[a][2].partial_cmp(&self.start[b][2]).unwrap()).unwrap();
            if ratio < 0.7 {
                out.push(self.issue("notStanding", "warning", "The bag does not stand".into(), format!("Its walls sank from {:.0} to {:.0} mm high. Soft leather slumps like this; if it should hold its shape, the leather is too soft or thin for the size.", t0 * 1000.0, t1 * 1000.0), "Use firmer or thicker leather, add a stiffener or lining, or make the bag smaller.", vec![], Some(i_top), ratio * 100.0, 70.0, "% of height"));
            }
            // Tipping: the walls' up direction, from the low points' centre to the high points'.
            let mid = |xs: &[P3], hi: bool| {
                let zs: Vec<f64> = walls.iter().map(|&i| self.start[i][2]).collect();
                let zmid = (zs.iter().cloned().fold(f64::INFINITY, f64::min) + zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max)) / 2.0;
                let sel: Vec<usize> = walls.iter().copied().filter(|&i| (self.start[i][2] > zmid) == hi).collect();
                let n = sel.len().max(1) as f64;
                sel.iter().fold([0.0; 3], |acc, &i| add(acc, scale(xs[i], 1.0 / n)))
            };
            let up = sub(mid(&self.x, true), mid(&self.x, false));
            let tilt = (up[2] / norm(up).max(1e-12)).clamp(-1.0, 1.0).acos().to_degrees();
            if tilt > 30.0 {
                out.push(self.issue("tipped", "warning", "The bag tips over".into(), format!("It leans {:.0} degrees from upright.", tilt), "Widen the base, move weight lower, or check that both sides are the same height.", vec![], None, tilt, 30.0, "degrees"));
            }
        }

        if self.recoveries > 0 {
            out.push(self.issue("unstable", "info", "The simulation had to steady itself".into(), format!("On {} frame{} the leather moved impossibly fast and was calmed. The result is still usable; if it keeps happening, a seam or fastener is probably fighting another.", self.recoveries, if self.recoveries == 1 { "" } else { "s" }), "Look for the other issues listed here first.", vec![], None, self.recoveries as f64, 0.0, "frames"));
        }
        out
    }
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or(String::new(), |f| f.to_uppercase().collect::<String>() + c.as_str())
}

/// Build the simulation for a project, let it settle for `seconds`, and report what it shows.
pub fn diagnose_project(project: &Project, spec: SimSpec, seconds: f64) -> Result<Vec<SimIssue>, String> {
    // A pattern check needs the shape, not the finest mesh: a few hundred points per piece find
    // the same problems in a fraction of the time.
    let spec = SimSpec { resolution: spec.resolution.min(DIAGNOSE_RESOLUTION), ..spec };
    let mut sim = Sim::new(project, spec)?;
    sim.step((seconds.clamp(0.0, 30.0) / DT).round() as usize);
    Ok(sim.diagnose())
}
