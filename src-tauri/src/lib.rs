//! Desktop shell: exposes the core to the interface as Tauri commands.

use hidework_core::model::{Project, FORMAT};
use hidework_core::pdf::{self, PageSize};
use hidework_core::templates::{self, TemplateInfo};
use hidework_core::{compute, sheet, svg, ComputedProject};
use std::path::PathBuf;

type Res<T> = Result<T, String>;

#[tauri::command]
fn compute_project(project: Project) -> ComputedProject {
    compute(&project)
}

#[tauri::command]
fn list_templates() -> Vec<TemplateInfo> {
    templates::list()
}

#[tauri::command]
fn from_template(id: String) -> Res<Project> {
    templates::by_id(&id).ok_or_else(|| format!("No template called {id}"))
}

#[tauri::command]
fn save_project(project: Project, path: String) -> Res<()> {
    let json = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not save {path}: {e}"))
}

#[tauri::command]
fn load_project(path: String) -> Res<Project> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    let project: Project = serde_json::from_str(&text).map_err(|e| format!("{path} is not a Hidework project: {e}"))?;
    if project.format != FORMAT {
        return Err(format!("{path} is not a Hidework project"));
    }
    Ok(project)
}

fn render_pdf(project: &Project, page: PageSize) -> (Vec<u8>, usize) {
    let c = compute(project);
    pdf::to_pdf(&sheet::build_sheet(project, &c), page)
}

#[tauri::command]
fn export_svg(project: Project, path: String) -> Res<()> {
    let c = compute(&project);
    std::fs::write(&path, svg::to_svg(&sheet::build_sheet(&project, &c))).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_pdf(project: Project, path: String, page: PageSize) -> Res<usize> {
    let (bytes, pages) = render_pdf(&project, page);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(pages)
}

/// Write the template to a temporary PDF and open it in the system viewer for printing.
#[tauri::command]
fn print_pdf(project: Project, page: PageSize) -> Res<usize> {
    let (bytes, pages) = render_pdf(&project, page);
    let safe: String = project.name.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    let path: PathBuf = std::env::temp_dir().join(format!("hidework-{safe}.pdf"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
    Ok(pages)
}

#[tauri::command]
fn page_count(project: Project, page: PageSize) -> usize {
    let c = compute(&project);
    let t = pdf::tiling(&sheet::build_sheet(&project, &c), page);
    t.cols * t.rows
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            compute_project,
            list_templates,
            from_template,
            save_project,
            load_project,
            export_svg,
            export_pdf,
            print_pdf,
            page_count
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hidework");
}
