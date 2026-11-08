// What the commands do: files, exports, dialogs, tools and selection edits. The command registry
// (commands.ts) wires these to names, icons and keys; nothing here knows about the ribbon.

import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { cancelDrawing, captureCanvas, clearMeasure, viewCenter } from "./canvas";
import { beginShape, draw, toolFor, type Shape } from "./drawtools";
import { button, check, field, h, num } from "./dom";
import { icon } from "./icons";
import { selectedPieces } from "./editing";
import { ensureVisible } from "./layout";
import { simple } from "./prefs";
import { mirrorPiece, rectPiece, rotatePiece } from "./ops";
import { edit, piece, placing, setProject, setStatus, state, type Tool } from "./store";
import type { FabOptions, Piece, TemplateInfo } from "./types";
import { fmtLen, parseLength } from "./units";
import { capture3d, needsRebuild, rebuild, setRunning, sim3d, type Tool3d } from "./view3d";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FILTER = [{ name: "Hidework pattern", extensions: ["hidework"] }];

/** App-wide flags shared with main. */
export const app = { firstFit: true };

// ---------- templates ----------

export type Template = TemplateInfo & { category?: string };
let templates: Template[] = [];

/** The starter patterns, cached after the first call. */
export async function loadTemplates(): Promise<Template[]> {
  if (!templates.length) templates = await api.templates();
  return templates;
}

export function cachedTemplates(): Template[] {
  return templates;
}

/** Category order for the library and the New dialog; unknown categories follow. */
export const CATEGORY_ORDER = ["Start", "Wallets", "Covers", "Cases", "Small goods", "Home", "Straps", "Bags"];

export function byCategory(ts: Template[]): [string, Template[]][] {
  const groups = new Map<string, Template[]>();
  for (const t of ts) {
    const c = t.category || "Other";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(t);
  }
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

// ---------- files ----------

async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  return ask("You have unsaved changes. Discard them?", { title: "Hidework", kind: "warning" });
}

export async function newFrom(id: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  try {
    setProject(await api.fromTemplate(id), null);
    app.firstFit = true;
    const t = templates.find((x) => x.id === id);
    setStatus(t ? (simple() ? `Here is the ${t.name.toLowerCase()}. Next you can change its size, check it, or see it in 3D.` : `${t.name}. Press Space to simulate it in 3D.`) : "New project.");
  } catch (e) {
    setStatus(String(e));
  }
}

/** Open a template by (part of) its name or id. */
export async function newFromName(query: string): Promise<void> {
  const ts = await loadTemplates();
  const q = query.toLowerCase().replace(/[\s-]+/g, "");
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "");
  const hit = ts.find((t) => norm(t.id) === q || norm(t.name) === q) ?? ts.find((t) => norm(t.name).startsWith(q) || norm(t.id).startsWith(q)) ?? ts.find((t) => norm(t.name).includes(q));
  if (!hit) return setStatus(`No pattern called "${query}". Type New on its own to see them all.`);
  await newFrom(hit.id);
}

export async function openFile(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const path = await open({ filters: FILTER, multiple: false });
  if (typeof path !== "string") return;
  try {
    setProject(await api.load(path), path);
    app.firstFit = true;
    setStatus(`Opened ${path}`);
  } catch (e) {
    setStatus(String(e));
  }
}

export async function saveFile(saveAs = false): Promise<void> {
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

export type ExportKind = "pdf" | "svg" | "laser" | "dxf" | "stl" | "png3d" | "png2d";
const fab = { kerfMm: 0.15, stitchHoleMm: 1, plateMm: 2, includeLabels: true, includeFolds: true };

export async function exportFile(kind: ExportKind): Promise<void> {
  const ext = kind === "laser" ? "svg" : kind.startsWith("png") ? "png" : kind;
  const suffix = kind === "laser" ? " laser" : kind === "stl" ? " stencil" : kind === "png3d" ? " 3D" : kind === "png2d" ? " pattern" : " template";
  const path = await save({ filters: [{ name: ext.toUpperCase(), extensions: [ext] }], defaultPath: `${state.project.name}${suffix}.${ext}` });
  if (!path) return;
  const opts: FabOptions = { ...fab };
  try {
    if (kind === "svg") await api.exportSvg(state.project, path);
    else if (kind === "pdf") {
      const pages = await api.exportPdf(state.project, path, state.page);
      setStatus(`Saved ${path}: ${pages} page${pages === 1 ? "" : "s"}. Print at Actual size (100%).`);
      return;
    } else if (kind === "laser") await api.exportLaserSvg(state.project, path, opts);
    else if (kind === "dxf") await api.exportDxf(state.project, path, opts);
    else if (kind === "stl") await api.exportStl(state.project, path, opts);
    else await invoke("save_png", { path, data: kind === "png3d" ? capture3d() : captureCanvas() });
    setStatus(`Saved ${path}.`);
  } catch (e) {
    setStatus(String(e));
  }
}

export function closeModal(): void {
  $("modal").classList.add("hidden");
}

export function showModal(...children: Node[]): HTMLElement {
  const modal = $("modal");
  const card = h("div", { class: "modal-card" }, ...children);
  modal.replaceChildren(card);
  modal.classList.remove("hidden");
  return card;
}

export function fabDialog(kind: "laser" | "dxf" | "stl"): void {
  const title = kind === "stl" ? "3D-print a stencil" : kind === "dxf" ? "DXF for laser or CNC" : "Laser-cut the template";
  const rows: Node[] = [
    h("h2", {}, title),
    h("p", { class: "hint" }, kind === "stl" ? "A flat plate of each piece with every stitch and punch hole through it. Lay it on the leather and mark or prick through." : "Cuts the template itself from acrylic, MDF or card. Red cuts, blue scores fold lines, black engraves names."),
    field("Stitch hole size, mm", num("fab-hole", fab.stitchHoleMm, (v) => (fab.stitchHoleMm = Math.max(0.3, v)), { step: 0.1, min: 0.3 }), "1 mm fits an awl tip or fine pen."),
  ];
  if (kind === "stl") rows.push(field("Plate thickness, mm", num("fab-plate", fab.plateMm, (v) => (fab.plateMm = Math.max(0.6, v)), { step: 0.2, min: 0.6 })));
  else {
    rows.push(field("Laser kerf, mm", num("fab-kerf", fab.kerfMm, (v) => (fab.kerfMm = Math.max(0, v)), { step: 0.01, min: 0 }), "Outlines grow and holes shrink by half of this."));
    rows.push(field("Score fold lines", check("fab-folds", fab.includeFolds, (v) => (fab.includeFolds = v))));
    rows.push(field("Engrave piece names", check("fab-labels", fab.includeLabels, (v) => (fab.includeLabels = v))));
  }
  rows.push(h("div", { class: "btn-row spaced" }, button("Cancel", closeModal, "quiet"), button("Save…", () => { closeModal(); void exportFile(kind); }, "primary")));
  showModal(...rows);
}

export async function print(): Promise<void> {
  try {
    const pages = await api.printPdf(state.project, state.page);
    setStatus(`Opened ${pages} page${pages === 1 ? "" : "s"} in your PDF viewer. Print at Actual size (100%), then measure the test squares.`);
  } catch (e) {
    setStatus(`Could not open the PDF: ${e}`);
  }
}

// ---------- the New project gallery ----------

const CATEGORY_ICON: Record<string, string> = { Start: "new", Wallets: "wallet", Covers: "book", Cases: "case", "Small goods": "smallgoods", Home: "homegoods", Straps: "strap", Bags: "bag" };
const thumbs = new Map<string, string>();

/** A small drawing of a template's pieces, laid out as in its pattern (SVG markup). */
export async function thumbnail(id: string): Promise<string> {
  const hit = thumbs.get(id);
  if (hit !== undefined) return hit;
  let svg = "";
  try {
    const p = await api.fromTemplate(id);
    const xs: number[] = [];
    const ys: number[] = [];
    const paths = p.pieces.map((pc) => {
      const at = (v: { x: number; y: number }) => {
        const x = v.x + pc.position.x;
        const y = v.y + pc.position.y;
        xs.push(x);
        ys.push(y);
        return `${x.toFixed(1)} ${y.toFixed(1)}`;
      };
      const n = pc.vertices.length;
      if (n < 2) return "";
      let d = `M${at(pc.vertices[0])}`;
      pc.edges.forEach((e, i) => {
        const to = pc.vertices[(i + 1) % n];
        d += e.type === "cubic" ? `C${at(e.c1)} ${at(e.c2)} ${at(to)}` : `L${at(to)}`;
      });
      return `<path d="${d}Z"/>`;
    });
    if (xs.length) {
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const w = Math.max(1, Math.max(...xs) - minX);
      const hh = Math.max(1, Math.max(...ys) - minY);
      const pad = Math.max(w, hh) * 0.06;
      const sw = Math.max(w, hh) / 90;
      svg = `<svg viewBox="${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(w + 2 * pad).toFixed(1)} ${(hh + 2 * pad).toFixed(1)}" preserveAspectRatio="xMidYMid meet" style="stroke-width:${sw.toFixed(2)}">${paths.join("")}</svg>`;
    }
  } catch {
    svg = "";
  }
  thumbs.set(id, svg);
  return svg;
}

/** New project: a gallery of picture cards, grouped by category. */
/** Every starter pattern on one page; `query` fills in the search box (to show one pattern). */
export async function showTemplates(query = ""): Promise<void> {
  const ts = await loadTemplates();
  const filter = h("input", { type: "text", placeholder: "Find a pattern by name…", class: "modal-filter", "aria-label": "Find a pattern", value: query }) as HTMLInputElement;
  const list = h("div", { class: "tpl-dialog" });
  const fill = () => {
    const q = filter.value.trim().toLowerCase();
    const hits = ts.filter((t) => !q || `${t.name} ${t.description} ${t.category ?? ""}`.toLowerCase().includes(q));
    const cards: [HTMLElement, string][] = [];
    list.replaceChildren(
      ...byCategory(hits).flatMap(([cat, items]) => [
        h("h3", { class: "tpl-cat" }, cat),
        h(
          "div",
          { class: "tpl-cards" },
          ...items.map((t) => {
            const pic = h("div", { class: "tpl-pic" }, icon(CATEGORY_ICON[cat] ?? "template", 40));
            cards.push([pic, t.id]);
            return h("button", { class: "tpl-card", type: "button", title: t.description, onclick: () => { closeModal(); void newFrom(t.id); } }, pic, h("strong", {}, t.name), h("span", {}, t.description));
          }),
        ),
      ]),
    );
    if (!hits.length) list.append(h("p", { class: "hint" }, "No pattern has that name. Clear the box to see them all."));
    // Draw the real pieces in, one at a time.
    void (async () => {
      for (const [pic, id] of cards) {
        const svg = await thumbnail(id);
        if (svg && pic.isConnected) pic.innerHTML = svg;
      }
    })();
  };
  filter.addEventListener("input", fill);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (list.querySelector(".tpl-card") as HTMLButtonElement | null)?.click();
    if (e.key === "Escape") closeModal();
    e.stopPropagation();
  });
  fill();
  const card = showModal(
    h("div", { class: "help-head" }, h("h2", {}, "Start a new project"), h("span", { class: "spacer" }), button("Cancel", closeModal, "quiet big")),
    h("p", { class: "hint" }, "Click a picture to open it. Every piece, seam and hole is already drawn; you can change any size afterwards."),
    filter,
    list,
  );
  card.classList.add("gallery");
}

export async function showMcp(): Promise<void> {
  const path = (await invoke<string | null>("mcp_path").catch(() => null)) ?? "C:\\Program Files\\Hidework\\hidework-mcp.exe";
  showModal(
    h("h2", {}, "Connect an AI agent"),
    h("p", { class: "hint" }, "Hidework includes an MCP server, hidework-mcp, next to the app. Agents can draft, sew, simulate, load, export and take screenshots."),
    h("p", {}, "Claude Code:"),
    h("textarea", { rows: 2, readOnly: true }, `claude mcp add hidework -- "${path}"`),
    h("p", { class: "hint" }, "Any MCP client works the same way: run that program over stdio."),
    h("div", { class: "btn-row spaced" }, button("Close", closeModal, "quiet")),
  );
}

// ---------- tools ----------

const HINTS: Record<Tool, string> = {
  select: "Select: click a piece, point, edge, hole or seam. Drag to move it.",
  hole: "Click inside a piece to punch a hole (pick a size in Library › Hardware).",
  fold: "Click a piece where it folds. Shift+F turns the fold direction.",
  join: "Sew: click an edge, then the edge it sews to.",
  measure: "Drag between points or holes to measure. Shift measures freely.",
  rect: "Drag a rectangle. Or type Rectangle 80 50 for an exact size.",
  polygon: "Click points; double-click or click the first point to close.",
  hardware: "Click a piece to set the hardware chosen in Library › Hardware.",
  mark: "Click a piece to place surface work (choose it in Library › Hardware).",
  tooling: "Swivel knife: draw on a piece to cut a tooled line into the grain.",
};

export function setTool(t: Tool): void {
  if (t !== "select") ensureVisible("2d");
  state.tool = t;
  state.joinPending = null;
  if (t !== "measure") clearMeasure();
  if (t !== "polygon" && t !== "rect") cancelDrawing();
  if (t !== "hole") placing.hardware = null;
  setStatus(HINTS[t]);
  // The plain Rectangle and Polygon tools draw a rectangle and a free outline.
  if (t === "rect" || t === "polygon") beginShape(toolFor(draw.shape) === t ? draw.shape : t === "rect" ? "rect" : "pen");
}

/** Pick a shape tool: rectangle, rounded, circle, oval, slot, strap end, pen or mirror half. */
export function startShape(s: Shape): void {
  cancelDrawing();
  draw.shape = s;
  setTool(toolFor(s));
}

const HINTS_3D: Record<Tool3d, string> = {
  orbit: "Left-drag the leather to pull it (Shift+drag moves a whole piece); drag empty space or right-drag to orbit; middle-drag pans.",
  pan: "Pan: left-drag moves the view. Esc or Orbit to go back.",
  move: "Drag the leather to pull it around while it simulates.",
  pin: "Click the leather to pin it in place (like a hand or a nail).",
  weight: "Click the leather to hang a weight from it.",
  object: "Click to drop the chosen object (pick one in Library › Scene).",
};

/** Pick a 3D tool. Picking the active one again goes back to orbit, unless `toggle` is false. */
export function setTool3d(t: Tool3d, toggle = true): void {
  if (t !== "orbit" && t !== "pan") ensureVisible("3d");
  sim3d.tool = toggle && sim3d.tool === t ? "orbit" : t;
  setStatus(HINTS_3D[sim3d.tool]);
}

export function toggleSim(): void {
  ensureVisible("3d");
  if (!sim3d.info || needsRebuild()) {
    void rebuild().then(() => setRunning(true));
    return;
  }
  setRunning(!sim3d.running);
  setStatus(sim3d.running ? "Simulating. Space to pause." : "Paused.");
}

/** Esc: stop drawing, close dialogs, deselect, back to the Select tool. */
export function cancelAll(): void {
  closeModal();
  cancelDrawing();
  state.sel = { kind: "none" };
  sim3d.tool = "orbit";
  setTool("select");
  setStatus("");
}

// ---------- selection edits ----------

/** The pieces a piece command acts on: the multi-selection, or the one selected piece. */
export function targetPieces(): string[] {
  return selectedPieces();
}

/** Run `f` on every target piece as one undo step, or say what to select. */
export function onPieces(what: string, f: (pc: Piece) => void): void {
  const ids = targetPieces();
  if (!ids.length) return setStatus(`${what}: select a piece first.`);
  edit(() => ids.forEach((id) => { const pc = piece(id); if (pc) f(pc); }));
}

export function mirrorSelected(axis: "x" | "y"): void {
  onPieces(axis === "x" ? "Mirror" : "Flip", (pc) => mirrorPiece(pc, axis));
}

export function rotateSelected(clockwise = true): void {
  onPieces("Rotate", (pc) => rotatePiece(pc, clockwise));
}

// ---------- typed geometry ----------

/** A length typed on the command line: plain numbers are in the project's units; 3in, 80mm, 8cm, 3 1/2 and 3/8 work too. */
export function parseLen(s: string | undefined): number | null {
  return parseLength(s, state.project.units);
}

function addPiece(pc: Piece, what: string): void {
  edit((p) => p.pieces.push(pc));
  state.sel = { kind: "piece", piece: pc.id };
  setStatus(what);
}

function centred(w: number, hgt: number): { x: number; y: number } {
  const c = viewCenter();
  return { x: Math.round(c.x - w / 2), y: Math.round(c.y - hgt / 2) };
}

export function addRect(w: number, hgt: number): void {
  ensureVisible("2d");
  addPiece(rectPiece(centred(w, hgt), w, hgt, "Panel"), `Panel ${fmtLen(w, state.project.units)} × ${fmtLen(hgt, state.project.units)} added.`);
}

/** A regular polygon with `n` sides and the given width across its points. */
export function addRegularPolygon(n: number, size: number): void {
  ensureVisible("2d");
  const sides = Math.max(3, Math.min(64, Math.round(n)));
  const r = size / 2;
  const pc = rectPiece(centred(size, size), 1, 1, `${sides}-sided panel`);
  pc.vertices = Array.from({ length: sides }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    return { x: +(r + r * Math.cos(a)).toFixed(3), y: +(r + r * Math.sin(a)).toFixed(3) };
  });
  pc.edges = pc.vertices.map(() => ({ type: "line", stitched: false }));
  addPiece(pc, `${sides}-sided panel added, ${fmtLen(size, state.project.units)} across.`);
}
