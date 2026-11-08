import { invoke } from "@tauri-apps/api/core";
import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/cinzel-decorative/700.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/600.css";
import "./style.css";

import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { registerToolSetter, renderBrowser, renderLibrary } from "./browser";
import { cancelDrawing, captureCanvas, clearMeasure, fitView, initCanvas, isTyping, requestDraw } from "./canvas";
import { initControl } from "./control";
import { button, check, field, h, num } from "./dom";
import { initDrapeView, loadPresets, setDrapeVisible } from "./drape";
import { deleteVertex, duplicatePiece, mirrorPiece, rotatePiece } from "./ops";
import { closeFabricTest, deletePiece, fabricTestOpen, openFabricTest, panel, renderFabricTest, renderInspector } from "./panels";
import { edit, notify, piece, placing, redo, selectedPieceId, setProject, setStatus, state, subscribe, undo, version, type Tool } from "./store";
import type { FabOptions, PageSize } from "./types";
import { capture3d, frameView, initView3d, needsRebuild, rebuild, resetSim, setHeat, setMetal, setRunning, sim3d, viewPreset, type Tool3d } from "./view3d";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FILTER = [{ name: "Hidework pattern", extensions: ["hidework"] }];

// ---------- files ----------

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

type ExportKind = "pdf" | "svg" | "laser" | "dxf" | "stl" | "png3d" | "png2d";
const fab = { kerfMm: 0.15, stitchHoleMm: 1, plateMm: 2, includeLabels: true, includeFolds: true };

async function exportFile(kind: ExportKind): Promise<void> {
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
    else await (await import("@tauri-apps/api/core")).invoke("save_png", { path, data: kind === "png3d" ? capture3d() : captureCanvas() });
    setStatus(`Saved ${path}.`);
  } catch (e) {
    setStatus(String(e));
  }
}

function fabDialog(kind: "laser" | "dxf" | "stl"): void {
  const modal = $("modal");
  const close = () => modal.classList.add("hidden");
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
  rows.push(h("div", { class: "btn-row spaced" }, button("Cancel", close, "quiet"), button("Save…", () => { close(); void exportFile(kind); }, "primary")));
  modal.replaceChildren(h("div", { class: "modal-card" }, ...rows));
  modal.classList.remove("hidden");
}

async function print(): Promise<void> {
  try {
    const pages = await api.printPdf(state.project, state.page);
    setStatus(`Opened ${pages} page${pages === 1 ? "" : "s"} in your PDF viewer. Print at Actual size (100%), then measure the test squares.`);
  } catch (e) {
    setStatus(`Could not open the PDF: ${e}`);
  }
}

// ---------- menus ----------

type MenuItem = [string, string, () => void] | "-";

function menus(): Record<string, MenuItem[]> {
  const sel = selectedPieceId();
  const onPiece = (f: (id: string) => void) => () => (sel ? f(sel) : setStatus("Select a piece first."));
  return {
    File: [
      ["New from pattern…", "", () => void showTemplates()],
      ["Open…", "Ctrl+O", () => void openFile()],
      ["Save", "Ctrl+S", () => void saveFile()],
      ["Save as…", "Ctrl+Shift+S", () => void saveFile(true)],
      "-",
      ["Print template…", "Ctrl+P", () => void print()],
      ["Export PDF…", "", () => void exportFile("pdf")],
      ["Export SVG sheet…", "", () => void exportFile("svg")],
      ["Laser cut the template…", "", () => fabDialog("laser")],
      ["DXF for laser or CNC…", "", () => fabDialog("dxf")],
      ["3D-print a stencil (STL)…", "", () => fabDialog("stl")],
      "-",
      ["Save 3D image…", "", () => void exportFile("png3d")],
      ["Save pattern image…", "", () => void exportFile("png2d")],
    ],
    Edit: [
      ["Undo", "Ctrl+Z", undo],
      ["Redo", "Ctrl+Y", redo],
      "-",
      ["Duplicate piece", "Ctrl+D", onPiece((id) => { const pc = piece(id)!; const c = duplicatePiece(pc); edit((p) => p.pieces.push(c)); state.sel = { kind: "piece", piece: c.id }; notify(); })],
      ["Delete selection", "Del", deleteSelection],
      "-",
      ["Units: millimetres", "", () => edit((p) => (p.units = "mm"))],
      ["Units: inches", "", () => edit((p) => (p.units = "in"))],
    ],
    Pattern: [
      ["Rectangle", "R", () => setTool("rect")],
      ["Polygon", "P", () => setTool("polygon")],
      ["Strap or belt…", "", () => { panel.special = "strap"; notify(); }],
      ["Bag builder…", "", () => { panel.special = "bag"; notify(); }],
      "-",
      ["Mirror piece", "", onPiece((id) => edit(() => mirrorPiece(piece(id)!, "x")))],
      ["Flip piece", "", onPiece((id) => edit(() => mirrorPiece(piece(id)!, "y")))],
      ["Rotate 90°", "", onPiece((id) => edit(() => rotatePiece(piece(id)!, true)))],
      "-",
      ["Punch hole", "H", () => { placing.hardware = null; setTool("hole"); }],
      ["Set hardware", "K", () => setTool("hardware")],
      ["Surface work (stamp, tooling…)", "E", () => setTool("mark")],
      ["Fold line", "F", () => setTool("fold")],
      ["Measure", "M", () => setTool("measure")],
    ],
    Sewing: [
      ["Segment sewing", "S", () => setTool("join")],
      ["Show seams", "", () => { state.sel = { kind: "none" }; notify(); }],
      ["Glue every seam (contact cement)", "", () => edit((p) => p.joins.forEach((j) => (j.glue = "contactCement")))],
      ["Make every seam edge to edge", "", () => edit((p) => p.joins.forEach((j) => (j.construction = "edgeToEdge")))],
      ["Make every seam turned", "", () => edit((p) => p.joins.forEach((j) => (j.construction = "turned")))],
    ],
    "3D": [
      ["Simulate", "Space", toggleSim],
      ["Reset to arrangement", "", () => void resetSim()],
      ["Rebuild from pattern", "", () => void rebuild()],
      "-",
      ["Stress map", "", () => setHeat(!sim3d.heat)],
      ["Show stitches", "", () => { sim3d.stitches = !sim3d.stitches; notify(); }],
      ["Hardware: brass", "", () => setMetal("brass")],
      ["Hardware: nickel", "", () => setMetal("nickel")],
      ["Hardware: gunmetal", "", () => setMetal("gunmetal")],
      ["Hardware: copper", "", () => setMetal("copper")],
      ["Hardware: black", "", () => setMetal("black")],
      "-",
      ["Front view", "1", () => viewPreset("front")],
      ["Side view", "3", () => viewPreset("side")],
      ["Top view", "7", () => viewPreset("top")],
      ["Home view", "", () => viewPreset("iso")],
      ["Fit view", "0", frameView],
    ],
    Fabric: [
      ["Fabric test…", "", () => openFabricTest(state.sel.kind === "material" ? state.sel.id : undefined)],
      ["Edit fabrics", "", () => { const m = state.project.materials[0]; if (m) { state.sel = { kind: "material", id: m.id }; notify(); } }],
    ],
    Help: [
      ["Shortcuts", "", showShortcuts],
      ["Connect an AI agent (MCP)…", "", showMcp],
    ],
  };
}

function openMenu(name: string, anchor: HTMLElement): void {
  const menu = $("menu");
  const items = menus()[name];
  menu.replaceChildren(
    ...items.map((it) =>
      it === "-"
        ? h("div", { class: "menu-sep" })
        : h("button", { class: "menu-item", type: "button", onclick: () => { menu.classList.add("hidden"); it[2](); } }, h("span", {}, it[0]), h("span", { class: "key" }, it[1])),
    ),
  );
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 2}px`;
  menu.classList.remove("hidden");
  menu.dataset.open = name;
  document.querySelectorAll(".menus > button").forEach((b) => b.classList.toggle("open", b === anchor));
}

async function showTemplates(): Promise<void> {
  const ts = await api.templates();
  const modal = $("modal");
  modal.replaceChildren(
    h(
      "div",
      { class: "modal-card" },
      h("h2", {}, "New from pattern"),
      ...ts.map((t) => h("button", { class: "menu-item stack", type: "button", onclick: () => { modal.classList.add("hidden"); void newFrom(t.id); } }, h("strong", {}, t.name), h("span", { class: "desc" }, t.description))),
      h("div", { class: "btn-row spaced" }, button("Cancel", () => modal.classList.add("hidden"), "quiet")),
    ),
  );
  modal.classList.remove("hidden");
}

function showShortcuts(): void {
  const rows: [string, string][] = [
    ["Space", "Simulate on/off"], ["V", "Select / transform"], ["R", "Rectangle"], ["P", "Polygon (click points, double-click to close)"], ["H", "Punch hole"], ["K", "Set hardware"], ["E", "Stamp, tooling, paint, perforate"], ["F", "Fold line"], ["S or J", "Segment sewing"], ["M", "Measure"],
    ["G / I / W / O", "3D: move cloth / pin / weight / drop object"], ["Right drag", "Orbit (3D) or pan (2D)"], ["Middle drag", "Pan (3D)"], ["Wheel", "Zoom"], ["0", "Fit view"], ["1 / 3 / 7", "Front / side / top"],
    ["Arrows", "Nudge piece (Shift ×10)"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Ctrl+D", "Duplicate"], ["Del", "Delete selection"],
  ];
  const modal = $("modal");
  modal.replaceChildren(h("div", { class: "modal-card" }, h("h2", {}, "Shortcuts"), h("table", { class: "report" }, ...rows.map(([k, d]) => h("tr", {}, h("td", {}, k), h("td", {}, d)))), h("div", { class: "btn-row spaced" }, button("Close", () => modal.classList.add("hidden"), "quiet"))));
  modal.classList.remove("hidden");
}

async function showMcp(): Promise<void> {
  const modal = $("modal");
  const path = (await invoke<string | null>("mcp_path").catch(() => null)) ?? "C:\\Program Files\\Hidework\\hidework-mcp.exe";
  modal.replaceChildren(
    h(
      "div",
      { class: "modal-card" },
      h("h2", {}, "Connect an AI agent"),
      h("p", { class: "hint" }, "Hidework includes an MCP server, hidework-mcp, next to the app. Agents can draft, sew, simulate, load, export and take screenshots."),
      h("p", {}, "Claude Code:"),
      h("textarea", { rows: 2, readOnly: true }, `claude mcp add hidework -- "${path}"`),
      h("p", { class: "hint" }, "Any MCP client works the same way: run that program over stdio."),
      h("div", { class: "btn-row spaced" }, button("Close", () => modal.classList.add("hidden"), "quiet")),
    ),
  );
  modal.classList.remove("hidden");
}

// ---------- tools ----------

function setTool(t: Tool): void {
  state.tool = t;
  state.joinPending = null;
  if (t !== "measure") clearMeasure();
  if (t !== "polygon" && t !== "rect") cancelDrawing();
  if (t !== "hole") placing.hardware = null;
  const hints: Partial<Record<Tool, string>> = {
    hole: "Click inside a piece to punch a hole.",
    fold: "Click a piece where it folds.",
    join: "Segment sewing: click an edge, then the edge it sews to.",
    measure: "Drag between points or holes to measure. Shift measures freely.",
    rect: "Drag a rectangle.",
    polygon: "Click points; double-click or click the first point to close.",
  };
  setStatus(hints[t] ?? "");
}

function setTool3d(t: Tool3d): void {
  sim3d.tool = sim3d.tool === t ? "orbit" : t;
  const hints: Record<Tool3d, string> = {
    orbit: "Right-drag to orbit, middle-drag to pan, wheel to zoom.",
    move: "Drag the leather to pull it around while it simulates.",
    pin: "Click the leather to pin it in place (like a hand or a nail).",
    weight: "Click the leather to hang a weight from it.",
    object: "Click to drop the chosen object (pick one in Library › Objects).",
  };
  setStatus(hints[sim3d.tool]);
  notify();
}

function toggleSim(): void {
  if (!sim3d.info || needsRebuild()) {
    void rebuild().then(() => setRunning(true));
    return;
  }
  setRunning(!sim3d.running);
  setStatus(sim3d.running ? "Simulating. Space to pause." : "Paused.");
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
    else setStatus("A piece needs at least three points.");
  } else if (s.kind === "hole") {
    edit((p) => p.pieces.forEach((pc) => (pc.holes = pc.holes.filter((x) => x.id !== s.id))));
    state.sel = { kind: "piece", piece: s.piece };
  } else if (s.kind === "fold") {
    edit((p) => p.pieces.forEach((pc) => (pc.folds = pc.folds.filter((x) => x.id !== s.id))));
    state.sel = { kind: "piece", piece: s.piece };
  } else if (s.kind === "join") {
    edit((p) => (p.joins = p.joins.filter((j) => j.id !== s.id)));
    state.sel = { kind: "none" };
  } else if (s.kind === "hardware") {
    edit((p) => p.pieces.forEach((pc) => (pc.hardware = (pc.hardware ?? []).filter((x) => x.id !== s.id))));
    state.sel = { kind: "piece", piece: s.piece };
  } else if (s.kind === "mark") {
    edit((p) => p.pieces.forEach((pc) => (pc.marks = (pc.marks ?? []).filter((x) => x.id !== s.id))));
    state.sel = { kind: "piece", piece: s.piece };
  }
  notify();
}

function nudge(dx: number, dy: number): void {
  const s = state.sel;
  if (s.kind !== "piece") return;
  const pc = piece(s.piece);
  if (pc) edit(() => (pc.position = { x: pc.position.x + dx, y: pc.position.y + dy }));
}

function tb(glyph: string, label: string, title: string, active: boolean, onclick: () => void): HTMLElement {
  return h("button", { class: `tb-btn${active ? " active" : ""}`, type: "button", title, onclick }, h("span", { class: "glyph" }, glyph), label ? h("span", { class: "label" }, label) : null);
}

function renderToolbars(): void {
  const t = state.tool;
  $("tb2d").replaceChildren(
    tb("⬚", "Select", "Select and transform (V)", t === "select", () => setTool("select")),
    tb("▭", "Rect", "Rectangle (R)", t === "rect", () => setTool("rect")),
    tb("⬠", "Polygon", "Polygon (P)", t === "polygon", () => setTool("polygon")),
    h("span", { class: "tb-sep" }),
    tb("◎", "Punch", "Punch hole (H)", t === "hole", () => { placing.hardware = null; setTool("hole"); }),
    tb("⊚", "Hardware", "Set hardware (K): pick it in the library", t === "hardware", () => setTool("hardware")),
    tb("✦", "Mark", "Stamp, tooling, emboss, paint, perforate (E)", t === "mark", () => setTool("mark")),
    tb("┄", "Fold", "Fold line (F)", t === "fold", () => setTool("fold")),
    tb(state.foldOrientation === "horizontal" ? "═" : "║", "", "Fold direction", false, () => { state.foldOrientation = state.foldOrientation === "horizontal" ? "vertical" : "horizontal"; setTool("fold"); }),
    tb("⫘", "Sew", "Segment sewing (S)", t === "join", () => setTool("join")),
    tb("↔", "Measure", "Measure (M)", t === "measure", () => setTool("measure")),
    h("span", { class: "tb-sep" }),
    tb("⤢", "Fit", "Fit (0)", false, fitView),
  );
  const s = sim3d.tool;
  const angle = h("input", { type: "range", min: "0", max: "180", step: "5", value: String(sim3d.foldAngle), title: "How far folds start closed" });
  angle.addEventListener("change", () => { sim3d.foldAngle = parseInt(angle.value, 10); void rebuild(); });
  const grams = h("input", { type: "number", min: "1", step: "50", value: String(sim3d.weightGrams), title: "Weight, grams" });
  grams.addEventListener("change", () => (sim3d.weightGrams = Math.max(1, parseFloat(grams.value) || 100)));
  $("tb3d").replaceChildren(
    tb("✥", "Move", "Drag the leather (G)", s === "move", () => setTool3d("move")),
    tb("📌", "Pin", "Pin (I)", s === "pin", () => setTool3d("pin")),
    tb("⚖", "Weight", "Hang a weight (W)", s === "weight", () => setTool3d("weight")),
    h("label", { class: "tb-field" }, grams, "g"),
    tb("▣", "Object", "Drop an object (O)", s === "object", () => setTool3d("object")),
    h("span", { class: "tb-sep" }),
    tb("◐", "Stress", "Stress map", sim3d.heat, () => setHeat(!sim3d.heat)),
    tb("⋯", "Stitches", "Show stitches", sim3d.stitches, () => { sim3d.stitches = !sim3d.stitches; notify(); }),
    h("label", { class: "tb-field", title: "Fold angle" }, "Fold", angle),
    tb("↺", "Reset", "Reset to arrangement", false, () => void resetSim()),
    tb("⤢", "Fit", "Fit view (0)", false, frameView),
  );
  const simBtn = $("btn-sim");
  simBtn.classList.toggle("on", sim3d.running);
  simBtn.lastChild!.textContent = sim3d.building ? "Building…" : sim3d.running ? "Simulating" : "Simulate";
}

function renderHud(): void {
  const m = sim3d.status?.metrics;
  const hud = $("hud3d");
  if (!m || !sim3d.info) {
    hud.textContent = sim3d.error ? sim3d.error : "";
    return;
  }
  const parts = [`Load ${(m.loadG / 1000).toFixed(2)} kg`, `stitch ${m.maxStitchN.toFixed(1)}/${m.stitchCapacityN.toFixed(0)} N`];
  if (m.maxPinN > 0) parts.push(`pin ${m.maxPinN.toFixed(1)}/${m.pinCapacityN.toFixed(0)} N`);
  const spans: Node[] = [h("span", {}, parts.join(" · "))];
  if (m.capacityKg !== null) spans.push(h("span", { class: "cap" }, `  ·  carries ~${m.capacityKg.toFixed(1)} kg`));
  if (m.loadG === 0 && m.pins === 0) {
    hud.replaceChildren(h("span", {}, "Space to simulate · G move · I pin · W weight · O drop an object"));
    return;
  }
  hud.replaceChildren(...spans);
}

// ---------- wiring ----------

function wire(): void {
  const nav = $("menus");
  for (const name of Object.keys(menus())) {
    const b = h("button", { type: "button" }, name);
    b.addEventListener("click", () => openMenu(name, b));
    b.addEventListener("mouseenter", () => { if (!$("menu").classList.contains("hidden") && $("menu").dataset.open !== name) openMenu(name, b); });
    nav.append(b);
  }
  $("btn-print").addEventListener("click", () => void print());
  $("btn-sim").addEventListener("click", toggleSim);
  $("fabric-close").addEventListener("click", () => { closeFabricTest(); setDrapeVisible(false); });
  $<HTMLSelectElement>("page-size").addEventListener("change", (e) => {
    state.page = (e.target as HTMLSelectElement).value as PageSize;
    edit(() => {});
  });
  document.addEventListener("mousedown", (e) => {
    const menu = $("menu");
    const t = e.target as HTMLElement;
    if (!menu.contains(t) && !t.closest(".menus")) {
      menu.classList.add("hidden");
      document.querySelectorAll(".menus > button").forEach((b) => b.classList.remove("open"));
    }
    if (t === $("modal")) $("modal").classList.add("hidden");
  });
  // Splitter between the 3D and 2D windows.
  const split = $("splitter");
  split.addEventListener("pointerdown", (e) => {
    split.setPointerCapture(e.pointerId);
    const w3 = document.querySelector<HTMLElement>(".w3d")!;
    const w2 = document.querySelector<HTMLElement>(".w2d")!;
    const total = w3.getBoundingClientRect().width + w2.getBoundingClientRect().width;
    const left = w3.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => {
      const f = Math.min(0.85, Math.max(0.15, (ev.clientX - left) / total));
      w3.style.flex = `0 0 ${f * total}px`;
      w2.style.flex = `1 1 0`;
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", () => split.removeEventListener("pointermove", move), { once: true });
  });
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "s") { e.preventDefault(); void saveFile(e.shiftKey); return; }
    if (mod && key === "o") { e.preventDefault(); void openFile(); return; }
    if (mod && key === "p") { e.preventDefault(); void print(); return; }
    if (isTyping()) return;
    if (mod && key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === "y") { e.preventDefault(); redo(); return; }
    if (mod && key === "d") { e.preventDefault(); const s = selectedPieceId(); if (s) { const c = duplicatePiece(piece(s)!); edit((p) => p.pieces.push(c)); state.sel = { kind: "piece", piece: c.id }; notify(); } return; }
    if (mod) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.code === "Space") { e.preventDefault(); toggleSim(); }
    else if (key === "delete" || key === "backspace") deleteSelection();
    else if (key === "escape") { state.sel = { kind: "none" }; $("modal").classList.add("hidden"); sim3d.tool = "orbit"; setTool("select"); }
    else if (key === "arrowleft") nudge(-step, 0);
    else if (key === "arrowright") nudge(step, 0);
    else if (key === "arrowup") nudge(0, -step);
    else if (key === "arrowdown") nudge(0, step);
    else if (key === "v") setTool("select");
    else if (key === "r") setTool("rect");
    else if (key === "p") setTool("polygon");
    else if (key === "h") { placing.hardware = null; setTool("hole"); }
    else if (key === "f") setTool("fold");
    else if (key === "j" || key === "s") setTool("join");
    else if (key === "m") setTool("measure");
    else if (key === "k") setTool("hardware");
    else if (key === "e") setTool("mark");
    else if (key === "g") setTool3d("move");
    else if (key === "i") setTool3d("pin");
    else if (key === "w") setTool3d("weight");
    else if (key === "o") setTool3d("object");
    else if (key === "0") { fitView(); frameView(); }
    else if (key === "1") viewPreset("front");
    else if (key === "3") viewPreset("side");
    else if (key === "7") viewPreset("top");
  });
}

let firstFit = true;
let rebuildTimer: number | undefined;

function refreshChrome(): void {
  $("status").textContent = state.status;
  const name = state.filePath ? state.filePath.split(/[\\/]/).pop() : "unsaved";
  $("info").textContent = `${state.project.name}${state.dirty ? " •" : ""}  ·  ${name}  ·  ${state.pages} ${state.page === "a4" ? "A4" : "Letter"} page${state.pages === 1 ? "" : "s"}`;
  renderToolbars();
  renderLibrary($("library"));
  renderBrowser($("browser"));
  renderInspector($("inspector"));
  renderFabricTest($("fabric-controls"));
  setDrapeVisible(fabricTestOpen());
  renderHud();
  if (firstFit && state.computed) {
    firstFit = false;
    fitView();
  }
  // The 3D window follows the pattern (CLO-style) while not simulating.
  if (state.computed && needsRebuild() && !sim3d.running && !sim3d.building) {
    window.clearTimeout(rebuildTimer);
    const v = version;
    rebuildTimer = window.setTimeout(() => { if (v === version && needsRebuild() && !sim3d.running && !sim3d.building) void rebuild(); }, 350);
  }
  requestDraw();
}

async function main(): Promise<void> {
  initCanvas($<HTMLCanvasElement>("canvas"));
  initView3d($("view3d"));
  initDrapeView($("drape-view"));
  registerToolSetter(setTool);
  subscribe(refreshChrome);
  wire();
  await initControl();
  // Opened by double-clicking a .hidework file: show it; otherwise start with the wallet.
  const file = await invoke<string | null>("startup_file").catch(() => null);
  if (file) {
    try {
      setProject(await api.load(file), file);
    } catch (e) {
      setStatus(`Could not open ${file}: ${e}`);
      setProject(await api.fromTemplate("card-wallet"), null);
    }
  } else {
    setProject(await api.fromTemplate("card-wallet"), null);
  }
  void loadPresets().then(notify);
  setStatus("Welcome. Space simulates the wallet in 3D; the library has fabrics, hardware, objects and props.");
}

void main();
