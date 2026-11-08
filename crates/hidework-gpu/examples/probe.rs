//! Per-frame timing and solver statistics for one template, for tuning.
//!
//! cargo run --release -p hidework-gpu --example probe [template] [resolution] [frames]

use hidework_core::sim::{Sim, SimSpec};
use hidework_gpu::{GpuContext, GpuSolver};
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let tpl = args.next().unwrap_or_else(|| "tote".into());
    let res: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(300);
    let frames: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(20);
    let Some(ctx) = GpuContext::new() else {
        println!("no suitable GPU adapter");
        return;
    };
    println!("adapter: {}", ctx.describe());
    let p = hidework_core::templates::by_id(&tpl).expect("template");
    let mut sim = Sim::new(&p, SimSpec { resolution: res, ..Default::default() }).expect("sim");
    let t = Instant::now();
    let mut g = GpuSolver::new(&ctx, &sim.solver_data()).expect("gpu solver");
    println!("{} vertices, setup {:.0} ms, colours {:?}", sim.positions().len() / 3, t.elapsed().as_secs_f64() * 1000.0, g.colours());
    for f in 0..frames {
        let t = Instant::now();
        g.step_sim(&mut sim, 1).expect("frame");
        let (searches, dropped) = g.contact_stats();
        let (cg, pairs) = g.solver_stats();
        println!(
            "frame {f:>3}: {:>7.1} ms  vmax {:.3} m/s  searches {searches}  dropped {dropped}  most pairs {pairs}  most CG {cg}  recovered {}",
            t.elapsed().as_secs_f64() * 1000.0,
            g.vmax(),
            g.recovered()
        );
    }
}
