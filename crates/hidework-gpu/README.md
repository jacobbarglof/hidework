# hidework-gpu

GPU backend for Hidework's live 3D simulation. It runs the XPBD substep loop of
`hidework_core::sim` as WGSL compute shaders through [wgpu](https://wgpu.rs) (MIT OR
Apache-2.0), on DX12, Vulkan or Metal. Without a suitable GPU it does nothing and the caller
keeps the CPU solver; it never panics or requires a GPU.

It is not wired into the app yet.

## How to call it

```rust
use hidework_gpu::{GpuContext, GpuSolver};

// Once at startup. None means "no usable GPU": keep calling sim.step(frames).
let ctx = GpuContext::new();
if let Some(ctx) = &ctx {
    println!("simulating on {}", ctx.describe()); // e.g. "Intel(R) Arc(TM) Graphics (Vulkan)"
}

// Whenever the simulation is built, or pins, weights or props change: a fresh snapshot.
let mut gpu = GpuSolver::new(ctx.as_ref().unwrap(), &sim.solver_data())?;

// Each frame (1/90 s): all 16 substeps in one command encoder, one readback, written back
// into the Sim (positions, velocities, clock, stitch and stretch force readouts, "settled").
gpu.step_sim(&mut sim, 1)?;
```

- `Sim::solver_data()` (in `crates/hidework-core/src/sim/export.rs`) copies the solver state
  into `SolverData`: flat `Vec<f32>` / `Vec<u32>` arrays in metres and seconds.
- `Sim::set_positions(x, v)` puts positions and velocities back; `Sim::finish_gpu_frame(...)`
  does the per-frame bookkeeping the CPU `step` does after its substeps. `step_sim` calls both.
- If the CPU moves the leather between frames (a reset, a drag handled on the CPU), call
  `gpu.set_state(x, v)` or build a new `GpuSolver`.
- `GpuSolver::step` returns `Err` on a GPU error (device lost, driver fault). Fall back to the
  CPU solver for the rest of the session when that happens.
- `HIDEWORK_GPU=0` in the environment makes `GpuContext::new()` return None.
- `SolverData::cpu_only` lists parts of the current scene the GPU does not simulate (`"hand"`,
  `"objects"`). Use the CPU solver while that list is not empty.

## What it runs on the GPU

Per substep, in the CPU pipeline's order:

1. Contact search, only when a point has moved half the search margin since the last one: a
   spatial hash (counting sort), then point-triangle pairs within the margin, each with the side
   of the triangle the point is on, remembered from the previous search while the pair stays
   close.
2. Predict (damping, gravity and hung weights).
3. Implicit bending of every piece: `(M / dt^2 + Q) x = M / dt^2 x_pred` with pins and seam
   points held, by Jacobi-preconditioned conjugate gradients, one workgroup per piece, warm
   started from the previous substep. This replaces the CPU's prefactored banded Cholesky solve.
4. Welds (seams, braces, glue, laminates, fasteners) with the sewing ramp, as XPBD distance
   constraints, Gauss-Seidel by graph colour (one dispatch per colour).
5. Isometric bending at seam points as constraints, then edge stretch (springs), both by colour.
6. Leather against leather: point-triangle contact with thickness, the remembered side and
   Coulomb friction, Jacobi with averaging (fixed-point atomics); stretch again; the floor and
   props (box, pedestal, bar) with Coulomb friction, one-sided, never glued.
7. Velocity update with the speed cap.

After each frame the solver reads back positions, velocities, spring and weld multipliers and
the top speed, and applies the CPU's guard: a frame with non-finite numbers is undone, one with
runaway stretch has its velocities halved.

## What still runs on the CPU only

- Objects dropped on the leather (phone, cards, bottle) and their contact with it.
- The hand (pulling the leather with the mouse).
- Edge-edge contact (the CPU's second contact test, for a strap edge across a rim). The GPU has
  point-triangle contact only.
- Bending force readouts at pins (`bend_f`, part of the pin pull readout).
- The fabric test bench (`drape.rs`), which is a separate projective dynamics solver.

## Parity and speed (Intel Arc integrated graphics, Vulkan; Core Ultra 9 185H, 22 threads)

- Strip droop (cantilever, overhang twice the bending length): GPU within 0.3 degrees of the
  CPU for pull-up and firm veg-tan at resolutions 200 and 600 (for example 41.0 against 41.3).
- Tote, resolution 300, 4 s: no NaNs, seams closed (95th percentile gap 0.6 mm, CPU 0.4 mm),
  walls stand (top 462 mm, CPU 470 mm). Stretch is higher (99th percentile 4.1%, CPU 2.2%) and
  about 24 edges cross other leather where the CPU has none, because the GPU lacks edge-edge
  contact and solves contact by Jacobi averaging.
- Frames per second (`examples/bench.rs`, 90 frames after 60 of sewing; CPU figures vary with
  machine load):

  | template  | res | vertices | CPU fps | GPU fps |
  |-----------|-----|----------|---------|---------|
  | tote      | 300 | 1505     | 83      | 18      |
  | tote      | 900 | 2899     | 29      | 23      |
  | messenger | 300 | 1180     | 71      | 30      |
  | messenger | 900 | 2545     | 8       | 21      |

  On this integrated GPU the cost is mostly fixed per dispatch (about 80 dispatches per
  substep, 1300 per frame: one per constraint colour), so the GPU only wins on larger meshes. A
  discrete GPU, fewer weld colours, or fusing kernels would move the break-even point down.

## Tests and benchmark

```
set CARGO_TARGET_DIR=C:/Programs/Hidework/target/gpu
cargo test --release -p hidework-gpu
cargo run --release -p hidework-gpu --example bench
```

The tests compare against the CPU solver (strip droop, tote) and skip cleanly when there is no
GPU.
