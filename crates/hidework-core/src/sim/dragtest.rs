//! Pulling on a settled model with the hand, the way the 3D view does: the pointer moves on a
//! plane facing the camera, so a pull toward the viewer can aim the hand below the floor.

#[cfg(test)]
mod tests {
    use super::super::*;

    fn stretch(s: &Sim) -> f64 {
        s.springs.iter().map(|sp| (norm(sub(s.x[sp.b], s.x[sp.a])) / sp.rest - 1.0) * 100.0).fold(0.0, f64::max)
    }

    fn pull(id: &str, at: Vec2, path: &[[f64; 3]]) -> (f64, usize, usize) {
        let p = crate::templates::by_id(id).unwrap();
        let mut s = Sim::new(&p, SimSpec::default()).unwrap();
        let t = std::time::Instant::now();
        for k in 0..15 {
            s.step(10);
            eprintln!("  settle {}: {:.0} ms total, stretch {:.2}%, recoveries {}", (k + 1) * 10, t.elapsed().as_secs_f64() * 1000.0, stretch(&s), s.recoveries);
        }
        let piece = p.pieces[0].id.clone();
        // The 3D view grabs the surface the pointer sees: the top layer over that spot.
        let near = s.vertex_at(&piece, at).unwrap();
        let q = s.x[near];
        let v0 = (0..s.x.len()).filter(|&i| (s.x[i][0] - q[0]).hypot(s.x[i][1] - q[1]) < 0.004).max_by(|&a, &b| s.x[a][2].total_cmp(&s.x[b][2])).unwrap();
        let start = scale(s.x[v0], 1000.0);
        let t0 = std::time::Instant::now();
        eprintln!("{id}: settled, {} points, recoveries {}", s.x.len(), s.recoveries);
        for (k, d) in path.iter().enumerate() {
            s.probe = k == 1 && std::env::var("HW_PROBE").is_ok();
            s.drag(Some(v0), add(start, *d), 12.0).unwrap();
            let t = std::time::Instant::now();
            s.step(6);
            if true {
                eprintln!("  step {k}: {:.0} ms, stretch {:.2}%, recoveries {}, hand at z {:.1} mm, {:?}", t.elapsed().as_secs_f64() * 1000.0, stretch(&s), s.recoveries, s.drag.as_ref().map_or(0.0, |g| g.at[2] * 1000.0), s.timings());
            }
            if k >= 2 && std::env::var("HW_PROBE").is_ok() || t0.elapsed().as_secs() > 40 { eprintln!("  giving up after 90 s"); break; }
        }
        s.step(30);
        s.drag(None, [0.0; 3], 0.0).unwrap();
        s.step(120);
        assert!(s.x.iter().all(|q| q.iter().all(|c| c.is_finite())));
        let r = (stretch(&s), s.crossings().len(), s.recoveries as usize);
        eprintln!("{id}: stretch {:.2}%, crossings {}, recoveries {}", r.0, r.1, r.2);
        r
    }

    /// A drag toward the viewer from a camera above: the hand aims down through the floor.
    fn into_the_floor() -> Vec<[f64; 3]> {
        (1..=30).map(|k| { let t = k as f64 / 30.0; [-60.0 * t, -90.0 * t, -80.0 * t] }).collect()
    }

    /// A sideways tug across the table and up.
    fn sideways_and_up() -> Vec<[f64; 3]> {
        (1..=30).map(|k| { let t = k as f64 / 30.0; [120.0 * t, 40.0 * t, 60.0 * t] }).collect()
    }

    #[test]
    fn pulling_a_card_wallet_into_the_floor_does_not_crumple_it() {
        let (st, cross, rec) = pull("card-wallet", v(50.0, 120.0), &into_the_floor());
        assert!(st < 8.0 && cross <= 10 && rec <= 4, "stretch {st:.1}%, {cross} crossings, {rec} recoveries");
    }

    #[test]
    fn tugging_a_card_wallet_sideways_keeps_it_whole() {
        let (st, cross, rec) = pull("card-wallet", v(5.0, 100.0), &sideways_and_up());
        assert!(st < 8.0 && cross <= 10 && rec <= 4, "stretch {st:.1}%, {cross} crossings, {rec} recoveries");
    }
}

#[cfg(test)]
mod probe {
    use super::super::*;

    fn stretch(s: &Sim) -> f64 {
        s.springs.iter().map(|sp| (norm(sub(s.x[sp.b], s.x[sp.a])) / sp.rest - 1.0) * 100.0).fold(0.0, f64::max)
    }

    #[test]
    #[ignore]
    fn probe_grab() {
        let p = crate::templates::by_id("card-wallet").unwrap();
        for (name, at, radius, still) in [("wake only", v(50.0, 120.0), -1.0, true), ("grab still r12", v(50.0, 120.0), 12.0, true), ("grab still r0", v(50.0, 120.0), 0.0, true), ("grab 3mm r12", v(50.0, 120.0), 12.0, false)] {
            let mut s = Sim::new(&p, SimSpec::default()).unwrap();
            s.step(150);
            let piece = p.pieces[0].id.clone();
            let v0 = s.vertex_at(&piece, at).unwrap();
            let start = scale(s.x[v0], 1000.0);
            let before = stretch(&s);
            if radius < 0.0 {
                s.wake();
            } else {
                let tgt = if still { start } else { add(start, [0.0, 0.0, 3.0]) };
                s.drag(Some(v0), tgt, radius).unwrap();
            }
            let mut line = format!("{name}: before {before:.2}% |");
            for _ in 0..6 {
                s.step(1);
                line += &format!(" {:.1}%/{}", stretch(&s), s.recoveries);
            }
            let g = s.drag.as_ref().map_or(0, |g| g.verts.len());
            eprintln!("{line} | grabbed {g} points, z of grab {:.1} mm, sleeping before? n/a", start[2]);
        }
    }
}

#[cfg(test)]
mod worst {
    use super::super::*;

    #[test]
    #[ignore]
    fn which_springs_stretch() {
        let p = crate::templates::by_id("card-wallet").unwrap();
        let mut s = Sim::new(&p, SimSpec::default()).unwrap();
        let seam: std::collections::HashSet<usize> = s.seam_points().into_iter().collect();
        let show = |s: &Sim, label: &str| {
            let mut v: Vec<(f64, usize)> = s.springs.iter().enumerate().map(|(k, sp)| ((norm(sub(s.x[sp.b], s.x[sp.a])) / sp.rest - 1.0) * 100.0, k)).collect();
            v.sort_by(|a, b| b.0.total_cmp(&a.0));
            eprintln!("{label}: {} springs, rest min {:.2} mm", s.springs.len(), s.springs.iter().map(|sp| sp.rest).fold(f64::INFINITY, f64::min) * 1000.0);
            for &(st, k) in v.iter().take(6) {
                let sp = &s.springs[k];
                eprintln!("  {st:6.2}%  rest {:.2} mm  w {:.3e}  a{}{} b{}{}  z {:.2}/{:.2} mm  rest2d a ({:.1},{:.1}) b ({:.1},{:.1})", sp.rest * 1000.0, sp.w, sp.a, if seam.contains(&sp.a) { "*" } else { "" }, sp.b, if seam.contains(&sp.b) { "*" } else { "" }, s.x[sp.a][2] * 1000.0, s.x[sp.b][2] * 1000.0, s.rest2d[sp.a].x, s.rest2d[sp.a].y, s.rest2d[sp.b].x, s.rest2d[sp.b].y);
            }
        };
        show(&s, "start");
        s.step(30);
        show(&s, "after 30");
        s.step(120);
        show(&s, "after 150");
    }
}

#[cfg(test)]
mod pouch_probe {
    use super::super::*;

    #[test]
    #[ignore]
    fn pouch_holder_frames() {
        let p = crate::templates::by_id("pouch-holder").unwrap();
        let mut s = Sim::new(&p, SimSpec { resolution: 200, ..Default::default() }).unwrap();
        let worst = |s: &Sim| s.springs.iter().map(|sp| (norm(sub(s.x[sp.b], s.x[sp.a])) / sp.rest - 1.0) * 100.0).fold(0.0, f64::max);
        eprintln!("start stretch {:.1}%", worst(&s));
        for k in 0..36 {
            s.step(5);
            eprintln!("frame {}: stretch {:.1}%, recoveries {}, subs {}, good {}", (k + 1) * 5, worst(&s), s.recoveries, s.subs, s.good.is_some());
        }
    }
}
