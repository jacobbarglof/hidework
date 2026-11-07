import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/cinzel-decorative/700.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/600.css";
import "./style.css";

import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { fitView, initCanvas, isTyping, requestDraw } from "./canvas";
import { h } from "./dom";
import { deleteVertex } from "./ops";
import { deletePiece, renderInspector, renderLedger } from "./panels";
import { edit, notify, piece, redo, setProject, setStatus, state, subscribe, undo, type Tool } from "./store";
import type { PageSize } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FILTER = [{ name: "Hidework pattern", extensions: ["hidework"] }];

async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  return ask("You have unsaved changes. Discard them?", { title: "Hidework", kind: "warning" });
}

async function newFrom(id: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  setProject(await api.fromTemplate(id), null);
  firstFit = true;
}

async function openFile(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const path = await open({ filters: FILTER, multiple: false });
  if (typeof path !== "string") return;
  try {
    setProject(await api.load(path), path);
    firstFit = true;
    setStatus(`Opened ${path}`);
  } catch (e) {
    setStatus(String(e));
  }
}

async function saveFile(saveAs = false): Promise<void> {
  let path = state.filePath;
  if (!path || saveAs) {
    const chosen = await save({ filters: FILTER, defaultPath: `${state.project.name}.hidework` });
    if (!chosen) return;
    path = chosen;
  }
  try {
    await api.save(state.project, path);
    state.filePath = path;
    state.dirty = false;
    setStatus(`Saved ${path}`);
  } catch (e) {
    setStatus(String(e));
  }
}

async function exportFile(kind: "svg" | "pdf"): Promise<void> {
  const path = await save({ filters: [{ name: kind.toUpperCase(), extensions: [kind] }], defaultPath: `${state.project.name} template.${kind}` });
  if (!path) return;
  try {
    if (kind === "svg") {
      await api.exportSvg(state.project, path);
      setStatus(`Saved ${path} at true scale.`);
    } else {
      const pages = await api.exportPdf(state.project, path, state.page);
      setStatus(`Saved ${path}: ${pages} page${pages === 1 ? "" : "s"}. Print at Actual size (100%).`);
    }
  } catch (e) {
    setStatus(String(e));
  }
}

async function print(): Promise<void> {
  try {
    const pages = await api.printPdf(state.project, state.page);
    setStatus(`Opened ${pages} page${pages === 1 ? "" : "s"} in your PDF viewer. Print at Actual size (100%), then measure the test squares.`);
  } catch (e) {
    setStatus(`Could not open the PDF: ${e}`);
  }
}

async function showNewMenu(anchor: HTMLElement): Promise<void> {
  const menu = $("menu");
  const templates = await api.templates();
  menu.replaceChildren(
    ...templates.map((t) =>
      h(
        "button",
        { class: "menu-item", type: "button", onclick: () => { menu.classList.add("hidden"); void newFrom(t.id); } },
        h("strong", {}, t.name),
        h("span", {}, t.description),
      ),
    ),
  );
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.classList.remove("hidden");
}

function setTool(t: Tool): void {
  state.tool = t;
  state.joinPending = null;
  const hints: Record<Tool, string> = {
    select: "",
    hole: "Click inside a piece to punch a hole.",
    fold: "Click a piece where it folds.",
    join: "Click the first edge of a seam.",
  };
  setStatus(hints[t]);
}

function deleteSelection(): void {
  const s = state.sel;
  if (s.kind === "piece") deletePiece(s.piece);
  else if (s.kind === "vertex") {
    const pc = piece(s.piece);
    if (!pc) return;
    let ok = false;
    edit((p) => (ok = deleteVertex(p, pc, s.index)));
    if (ok) state.sel = { kind: "piece", piece: s.piece };
    else setStatus("A piece needs at least three corners.");
  } else if (s.kind === "hole") {
    edit((p) => p.pieces.forEach((pc) => (pc.holes = pc.holes.filter((x) => x.id !== s.id))));
    state.sel = { kind: "piece", piece: s.piece };
  } else if (s.kind === "fold") {
    edit((p) => p.pieces.forEach((pc) => (pc.folds = pc.folds.filter((x) => x.id !== s.id))));
    state.sel = { kind: "piece", piece: s.piece };
  } else if (s.kind === "join") {
    edit((p) => (p.joins = p.joins.filter((j) => j.id !== s.id)));
    state.sel = { kind: "none" };
  }
  notify();
}

function wire(): void {
  $("btn-new").addEventListener("click", (e) => void showNewMenu(e.currentTarget as HTMLElement));
  $("btn-open").addEventListener("click", () => void openFile());
  $("btn-save").addEventListener("click", (e) => void saveFile((e as MouseEvent).shiftKey));
  $("btn-undo").addEventListener("click", undo);
  $("btn-redo").addEventListener("click", redo);
  $("btn-fit").addEventListener("click", fitView);
  $("btn-svg").addEventListener("click", () => void exportFile("svg"));
  $("btn-pdf").addEventListener("click", () => void exportFile("pdf"));
  $("btn-print").addEventListener("click", () => void print());
  $("btn-fold-dir").addEventListener("click", () => {
    state.foldOrientation = state.foldOrientation === "horizontal" ? "vertical" : "horizontal";
    setTool("fold");
  });
  $<HTMLSelectElement>("page-size").addEventListener("change", (e) => {
    state.page = (e.target as HTMLSelectElement).value as PageSize;
    edit(() => {}); // refresh the page count
  });
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool as Tool)));
  document.addEventListener("mousedown", (e) => {
    const menu = $("menu");
    if (!menu.contains(e.target as Node) && e.target !== $("btn-new")) menu.classList.add("hidden");
  });
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void saveFile(e.shiftKey);
      return;
    }
    if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void openFile();
      return;
    }
    if (isTyping()) return;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (mod) return;
    const key = e.key.toLowerCase();
    if (key === "delete" || key === "backspace") deleteSelection();
    else if (key === "escape") {
      state.sel = { kind: "none" };
      setTool("select");
    } else if (key === "v") setTool("select");
    else if (key === "h") setTool("hole");
    else if (key === "f") setTool("fold");
    else if (key === "j") setTool("join");
    else if (key === "0") fitView();
  });
}

let firstFit = true;

function refreshChrome(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === state.tool));
  $("btn-fold-dir").textContent = state.foldOrientation === "horizontal" ? "═" : "║";
  $("btn-fold-dir").title = `Fold direction: ${state.foldOrientation === "horizontal" ? "across" : "down"} (click to switch)`;
  $("status").textContent = state.status;
  const name = state.filePath ? state.filePath.split(/[\\/]/).pop() : "unsaved";
  $("info").textContent = `${state.project.name}${state.dirty ? " •" : ""}  ·  ${name}  ·  ${state.pages} ${state.page === "a4" ? "A4" : "Letter"} page${state.pages === 1 ? "" : "s"}`;
  renderLedger($("ledger"));
  renderInspector($("inspector"));
  if (firstFit && state.computed) {
    firstFit = false;
    fitView();
  }
  requestDraw();
}

async function main(): Promise<void> {
  initCanvas($<HTMLCanvasElement>("canvas"));
  subscribe(refreshChrome);
  wire();
  setProject(await api.fromTemplate("card-wallet"), null);
  setStatus("Welcome. This fold-over card wallet is a starting point: click it to explore.");
}

void main();
