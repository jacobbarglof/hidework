//! GPU backend for Hidework's live cloth simulator: the XPBD substep loop of
//! `hidework_core::sim` as wgpu compute shaders (WGSL), run from a flat snapshot
//! (`Sim::solver_data`).
//!
//! ```no_run
//! use hidework_gpu::{GpuContext, GpuSolver};
//! # fn demo(sim: &mut hidework_core::sim::Sim) -> Result<(), String> {
//! let Some(ctx) = GpuContext::new() else { return Ok(()) }; // no GPU: keep using sim.step
//! let mut gpu = GpuSolver::new(&ctx, &sim.solver_data())?;
//! gpu.step_sim(sim, 1)?; // one frame on the GPU, written back into the Sim
//! # Ok(()) }
//! ```
//!
//! Nothing here panics for want of a GPU: `GpuContext::new` returns None and the caller keeps
//! the CPU solver.

mod colour;
mod solver;

pub use solver::GpuSolver;

use std::sync::{Arc, Mutex};

/// A GPU device and queue for the solver, with what it is.
pub struct GpuContext {
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
    info: wgpu::AdapterInfo,
    pub(crate) error: Arc<Mutex<Option<String>>>,
}

/// Storage buffers the solver binds in one shader stage.
pub(crate) const STORAGE_BUFFERS: u32 = 27;

impl GpuContext {
    /// The best hardware adapter (DX12, Vulkan or Metal), or None when there is no suitable one
    /// (no GPU, a software rasteriser only, or limits too small). Setting the environment
    /// variable `HIDEWORK_GPU=0` also gives None.
    pub fn new() -> Option<GpuContext> {
        if std::env::var("HIDEWORK_GPU").is_ok_and(|v| v == "0" || v.eq_ignore_ascii_case("off")) {
            return None;
        }
        // A broken driver can panic inside wgpu; treat that as "no GPU".
        std::panic::catch_unwind(Self::create).ok().flatten()
    }

    fn create() -> Option<GpuContext> {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
        desc.backends = wgpu::Backends::PRIMARY;
        let instance = wgpu::Instance::new(desc);
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
            ..Default::default()
        }))
        .ok()?;
        let info = adapter.get_info();
        if info.device_type == wgpu::DeviceType::Cpu {
            return None;
        }
        let limits = adapter.limits();
        if limits.max_storage_buffers_per_shader_stage < STORAGE_BUFFERS
            || limits.max_compute_workgroup_size_x < 256
            || limits.max_compute_invocations_per_workgroup < 256
            || limits.max_bind_groups < 2
        {
            return None;
        }
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("hidework-gpu"),
            required_features: wgpu::Features::empty(),
            required_limits: limits,
            ..Default::default()
        }))
        .ok()?;
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let sink = error.clone();
        device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
            if let Ok(mut slot) = sink.lock() {
                slot.get_or_insert_with(|| e.to_string());
            }
        }));
        Some(GpuContext { device, queue, info, error })
    }

    /// The adapter's name, as the driver reports it (for example "Intel(R) Arc(TM) Graphics").
    pub fn adapter_name(&self) -> &str {
        &self.info.name
    }

    /// The graphics API in use: "DX12", "Vulkan" or "Metal".
    pub fn backend(&self) -> &'static str {
        match self.info.backend {
            wgpu::Backend::Dx12 => "DX12",
            wgpu::Backend::Vulkan => "Vulkan",
            wgpu::Backend::Metal => "Metal",
            wgpu::Backend::Gl => "GL",
            wgpu::Backend::BrowserWebGpu => "WebGPU",
            _ => "other",
        }
    }

    /// "name (backend)", for a settings page or a log line.
    pub fn describe(&self) -> String {
        format!("{} ({})", self.adapter_name(), self.backend())
    }

    /// The first GPU error since the last call, if any (validation errors, device loss).
    pub(crate) fn take_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|mut e| e.take())
    }
}
