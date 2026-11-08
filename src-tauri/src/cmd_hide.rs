//! Commands for the leather layout and costing dialog (WP3): hide presets, nesting a project on
//! a hide or panel, and costing a project.

use hidework_core::costing::{self, CostReport, Prices};
use hidework_core::hide::{self, Hide, HidePreset};
use hidework_core::model::Project;
use hidework_core::nest::{self, NestOptions, NestResult};

#[tauri::command]
pub fn hide_presets() -> Vec<HidePreset> {
    hide::presets()
}

/// Lay the project's pieces out on the leather. Runs off the UI thread; the time budget is in
/// `options.timeMs` (1.5 s by default).
#[tauri::command]
pub async fn nest_on_hide(project: Project, hide: Hide, options: Option<NestOptions>) -> Result<NestResult, String> {
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let computed = hidework_core::compute(&project);
        nest::nest(&project, &computed, &hide, &options)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cost_project(project: Project, prices: Option<Prices>) -> CostReport {
    let computed = hidework_core::compute(&project);
    costing::cost(&project, &computed, &prices.unwrap_or_default())
}
