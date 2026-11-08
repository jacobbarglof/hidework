//! Without a GPU (here forced with HIDEWORK_GPU=0) the context is None, never a panic, and the
//! caller keeps the CPU solver. Its own test binary, so the switch does not touch other tests.

#[test]
fn no_gpu_means_none_not_a_panic() {
    std::env::set_var("HIDEWORK_GPU", "0");
    assert!(hidework_gpu::GpuContext::new().is_none());
    std::env::remove_var("HIDEWORK_GPU");
}
