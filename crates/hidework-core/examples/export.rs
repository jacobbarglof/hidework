//! cargo run -p hidework-core --example export -- <template-id or project.hidework> <out-dir> [letter|a4]
use hidework_core::{compute, model::Project, pdf, sheet, svg, templates};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src = args.get(1).map(String::as_str).unwrap_or("card-wallet");
    let out = std::path::PathBuf::from(args.get(2).map(String::as_str).unwrap_or("."));
    let page = if args.get(3).map(String::as_str) == Some("a4") { pdf::PageSize::A4 } else { pdf::PageSize::Letter };
    let project: Project = match templates::by_id(src) {
        Some(p) => p,
        None => serde_json::from_str(&std::fs::read_to_string(src).expect("read project")).expect("parse project"),
    };
    let c = compute(&project);
    for j in &c.joins {
        println!("join {}: {}", j.id, j.message);
    }
    let s = sheet::build_sheet(&project, &c);
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("template.svg"), svg::to_svg(&s)).unwrap();
    let (bytes, pages) = pdf::to_pdf(&s, page);
    std::fs::write(out.join("template.pdf"), bytes).unwrap();
    println!("wrote {} ({} pages)", out.display(), pages);
}
