import { invoke } from "@tauri-apps/api/core";
import type { Computed, PageSize, Project, TemplateInfo } from "./types";

export const api = {
  compute: (project: Project) => invoke<Computed>("compute_project", { project }),
  templates: () => invoke<TemplateInfo[]>("list_templates"),
  fromTemplate: (id: string) => invoke<Project>("from_template", { id }),
  save: (project: Project, path: string) => invoke<void>("save_project", { project, path }),
  load: (path: string) => invoke<Project>("load_project", { path }),
  exportSvg: (project: Project, path: string) => invoke<void>("export_svg", { project, path }),
  exportPdf: (project: Project, path: string, page: PageSize) => invoke<number>("export_pdf", { project, path, page }),
  printPdf: (project: Project, page: PageSize) => invoke<number>("print_pdf", { project, page }),
  pageCount: (project: Project, page: PageSize) => invoke<number>("page_count", { project, page }),
};
