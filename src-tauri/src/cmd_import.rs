//! Commands for "Bring in a pattern" (WP2): read an SVG, DXF or PDF pattern file, or trace a photo
//! or scan of a paper pattern. Both run off the interface thread (big photos take a moment).

use hidework_core::import::{self, ImportOptions, ImportResult};
use hidework_core::trace::{self, TraceOptions};

/// Larger files than this are refused (a pattern file or phone photo is far smaller).
const MAX_BYTES: u64 = 200 << 20;

fn read(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not open {path}: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err(format!("{path} is too big to bring in."));
    }
    std::fs::read(path).map_err(|e| format!("Could not open {path}: {e}"))
}

#[tauri::command]
pub async fn import_pattern(path: String, options: Option<ImportOptions>) -> Result<ImportResult, String> {
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read(&path)?;
        let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
        import::import_file(&bytes, &ext, &options)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trace_pattern(path: String, options: Option<TraceOptions>) -> Result<ImportResult, String> {
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read(&path)?;
        trace::trace_image(&bytes, &options)
    })
    .await
    .map_err(|e| e.to_string())?
}
