//! Frames per second, GPU against CPU, for bag templates at two resolutions.
//!
//! cargo run --release -p hidework-gpu --example bench [frames]

use hidework_core::sim::{Sim, SimSpec};
use hidework_gpu::{GpuContext, GpuSolver};
use std::time::Instant;

fn main() {
    let frames: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(90);
    let ctx = GpuContext::new();
    match &ctx {
        Some(c) => println!("GPU adapter: {}", c.describe()),
        None => println!("no suitable GPU adapter: CPU only"),
    }
    println!("CPU threads: {}", std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1));
    println!("{:<10} {:>5} {:>7} {:>9} {:>9} {:>8}  colours (welds, seam bends, springs)", "template", "res", "verts", "CPU fps", "GPU fps", "speedup");
    for tpl in ["tote", "messenger"] {
        let p = hidework_core::templates::by_id(tpl).expect("template");
        for res in [300, 900] {
            let spec = SimSpec { resolution: res, ..Default::default() };
            // Both start after the seams have drawn closed, so the timing is of a sewn bag.
            let mut cpu = Sim::new(&p, spec.clone()).expect("sim");
            cpu.step(60);
            let verts = cpu.positions().len() / 3;
            let t = Instant::now();
            cpu.step(frames);
            let cpu_fps = frames as f64 / t.elapsed().as_secs_f64();
            let (gpu_fps, colours) = match &ctx {
                Some(ctx) => {
                    let mut sim = Sim::new(&p, spec).expect("sim");
                    sim.step(60);
                    let mut g = GpuSolver::new(ctx, &sim.solver_data()).expect("gpu solver");
                    g.step_sim(&mut sim, 5).expect("warm up");
                    let t = Instant::now();
                    g.step_sim(&mut sim, frames).expect("gpu frames");
                    (frames as f64 / t.elapsed().as_secs_f64(), format!("{:?}", g.colours()))
                }
                None => (f64::NAN, String::new()),
            };
            println!("{tpl:<10} {res:>5} {verts:>7} {cpu_fps:>9.1} {gpu_fps:>9.1} {:>7.2}x  {colours}", gpu_fps / cpu_fps);
        }
    }
}
