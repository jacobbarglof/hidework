//! The GPU solver against the CPU solver. Every test skips (passes with a note) when there is no
//! suitable GPU adapter, or when HIDEWORK_GPU=0.

use hidework_core::sim::{Sim, SimSpec};
use hidework_gpu::{GpuContext, GpuSolver};

fn gpu() -> Option<GpuContext> {
    let c = GpuContext::new();
    match &c {
        Some(c) => eprintln!("adapter: {}", c.describe()),
        None => eprintln!("no suitable GPU adapter: skipping"),
    }
    c
}

/// A strip clamped at one end (the cantilever bending test, ASTM D1388) with an overhang of
/// twice its bending length, and the clamp edge and tip vertices.
fn strip(preset: &str, res: usize) -> (Sim, usize, usize) {
    let mut p = hidework_core::templates::blank();
    let pr = hidework_core::physics::presets().into_iter().find(|x| x.id == preset).unwrap();
    let c = hidework_core::physics::bending_length_mm(&pr.physics, pr.thickness_mm);
    p.materials[0].physics = Some(pr.physics);
    p.materials[0].thickness_mm = pr.thickness_mm;
    let clamp = 20.0;
    p.pieces = vec![hidework_core::generators::panel("s", "Strip", "m1", 2.0 * c + clamp, 25.0)];
    let mut s = Sim::new(&p, SimSpec { resolution: res, lift_mm: 300.0, ..Default::default() }).unwrap();
    let rest = s.info.rest.clone();
    let n = rest.len() / 2;
    for i in 0..n {
        if rest[2 * i] as f64 <= clamp + 0.01 {
            s.pin(&format!("c{i}"), i).unwrap();
        }
    }
    let rx = |i: usize| rest[2 * i];
    let edge = (0..n).filter(|&i| rx(i) as f64 <= clamp + 0.01).max_by(|&a, &b| rx(a).total_cmp(&rx(b))).unwrap();
    let tip = (0..n).max_by(|&a, &b| rx(a).total_cmp(&rx(b))).unwrap();
    (s, edge, tip)
}

fn droop(s: &Sim, edge: usize, tip: usize) -> f64 {
    let x = s.positions();
    let d: Vec<f64> = (0..3).map(|k| (x[3 * tip + k] - x[3 * edge + k]) as f64).collect();
    (-d[2]).atan2((d[0] * d[0] + d[1] * d[1]).sqrt()).to_degrees()
}

/// Run the strip test with `step(sim, frames)` and return the droop angle averaged over the end.
fn run_strip(s: &mut Sim, edge: usize, tip: usize, mut step: impl FnMut(&mut Sim, usize)) -> f64 {
    step(s, 270);
    let mut sum = 0.0;
    for _ in 0..60 {
        step(s, 3);
        sum += droop(s, edge, tip);
    }
    sum / 60.0
}

#[test]
fn strip_droop_matches_the_cpu() {
    let Some(ctx) = gpu() else { return };
    for preset in ["pullup", "vegtan-firm"] {
        for res in [200, 600] {
            let (mut cpu, edge, tip) = strip(preset, res);
            let a_cpu = run_strip(&mut cpu, edge, tip, |s, f| s.step(f));
            let (mut sim, edge, tip) = strip(preset, res);
            let mut g = GpuSolver::new(&ctx, &sim.solver_data()).unwrap();
            let a_gpu = run_strip(&mut sim, edge, tip, |s, f| g.step_sim(s, f).unwrap());
            eprintln!("{preset} res {res}: CPU {a_cpu:.1} deg, GPU {a_gpu:.1} deg (ASTM 41.5), most CG iterations {}", g.solver_stats().0);
            assert!((a_gpu - a_cpu).abs() < 4.0, "{preset} res {res}: GPU {a_gpu:.1} vs CPU {a_cpu:.1} degrees");
        }
    }
}

/// 99th percentile stretch (percent) and 95th percentile seam gap beyond rest (mm).
fn stretch_and_gap(s: &Sim) -> (f64, f64) {
    let d = s.solver_data();
    let x = |i: u32| [d.x[3 * i as usize] as f64, d.x[3 * i as usize + 1] as f64, d.x[3 * i as usize + 2] as f64];
    let len = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let mut e: Vec<f64> = (0..d.spring_rest.len())
        .map(|k| {
            let (a, b) = (x(d.spring_ab[2 * k]), x(d.spring_ab[2 * k + 1]));
            len([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) / d.spring_rest[k] as f64 - 1.0
        })
        .collect();
    e.sort_by(|a, b| b.total_cmp(a));
    let mut gaps: Vec<f64> = (0..d.weld_rest.len())
        .map(|k| {
            let mut v = [0.0; 3];
            for q in 0..6 {
                let c = d.weld_c[6 * k + q] as f64;
                let p = x(d.weld_v[6 * k + q]);
                for j in 0..3 {
                    v[j] += c * p[j];
                }
            }
            (len(v) - d.weld_rest[k] as f64).max(0.0) * 1000.0
        })
        .collect();
    gaps.sort_by(|a, b| b.total_cmp(a));
    (e[e.len() / 100] * 100.0, gaps.get(gaps.len() / 20).copied().unwrap_or(0.0))
}

fn top_mm(s: &Sim) -> f64 {
    s.positions().chunks(3).map(|p| p[2] as f64).fold(f64::NEG_INFINITY, f64::max)
}

#[test]
fn tote_stays_together_on_the_gpu() {
    let Some(ctx) = gpu() else { return };
    let p = hidework_core::templates::by_id("tote").unwrap();
    let spec = SimSpec { resolution: 300, ..Default::default() };
    let mut cpu = Sim::new(&p, spec.clone()).unwrap();
    let mut sim = Sim::new(&p, spec).unwrap();
    let top0 = top_mm(&sim);
    let mut g = GpuSolver::new(&ctx, &sim.solver_data()).unwrap();
    let mut worst_cross = 0;
    for _ in 0..4 {
        g.step_sim(&mut sim, 60).unwrap();
        cpu.step(60);
        worst_cross = worst_cross.max(sim.crossings().len());
        assert!(sim.positions().iter().all(|c| c.is_finite()), "non-finite positions");
    }
    let (st, gap) = stretch_and_gap(&sim);
    let (st_c, gap_c) = stretch_and_gap(&cpu);
    let (top, top_c) = (top_mm(&sim), top_mm(&cpu));
    let (searches, overflow) = g.contact_stats();
    eprintln!(
        "tote res 300 after 4 s: GPU top {top0:.0} -> {top:.0} mm, stretch {st:.2}%, seam gap {gap:.2} mm, crossings {worst_cross}, searches {searches}, dropped pairs {overflow}, most pairs at a point {}, most CG iterations {}, colours {:?}",
        g.solver_stats().1,
        g.solver_stats().0,
        g.colours()
    );
    eprintln!("                          CPU top {top_c:.0} mm, stretch {st_c:.2}%, seam gap {gap_c:.2} mm, crossings {}", cpu.crossings().len());
    assert!(st < 5.0, "stretched {st:.2}%");
    assert!(gap < 3.0, "seams open by {gap:.2} mm");
    assert!(top > 0.8 * top_c, "sank to {top:.0} mm against the CPU's {top_c:.0} mm");
    // The GPU has point-triangle contact only (no edge-edge test) and solves contact Jacobi
    // style, so a few edges cross where the CPU has none (measured: 24 against 0). The bound is
    // the CPU suite's own bound for any bag style.
    assert!(worst_cross < 40, "{worst_cross} edges through the leather");
}
