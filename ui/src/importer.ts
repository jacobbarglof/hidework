// "Bring in a pattern": read a pattern file (SVG, DXF, PDF) or trace a photo of a paper pattern,
// check it at true size, and add the pieces to the project. Written for people who do not use
// drawing programs: big choices, one step at a time, plain words.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { fitView } from "./canvas";
import { h } from "./dom";
import { edit, notify, selectPieces, setStatus, state, uid, whenComputed } from "./store";
import type { Piece, V } from "./types";
import "./importer.css";

/** Mirrors `hidework_core::import::ImportResult`. */
interface ImportResult {
  pieces: Piece[];
  warnings: string[];
  unitsDetected: string;
  summary: string;
  openPaths: V[][];
  underlay?: { width: number; height: number; dataUrl: string; scaleKnown: boolean; mmPerPx: number; threshold: number } | null;
  tracedPx: V[][];
}

type Step = "choose" | "busy" | "photo" | "preview" | "error";

const s = {
  step: "choose" as Step,
  kind: "file" as "file" | "photo",
  path: "",
  busyText: "",
  error: "",
  result: null as ImportResult | null,
  /** File options. */
  units: "",
  /** Photo options. */
  pick: "measure" as "measure" | "corners",
  points: [] as V[],
  corners: [] as V[],
  length: 0,
  lengthUnit: "mm" as "mm" | "in" | "cm",
  sheet: "letter" as "letter" | "a4",
  threshold: null as number | null,
  /** True once the user moves the slider; until then the core picks the level itself. */
  thresholdSet: false,
  foreground: "auto" as "auto" | "dark" | "light",
  image: null as HTMLImageElement | null,
};

let card: HTMLElement | null = null;

/** Open the "Bring in a pattern" dialog. */
export function openImport(): void {
  Object.assign(s, { step: "choose", path: "", error: "", result: null, units: "", points: [], corners: [], length: 0, threshold: null, thresholdSet: false, foreground: "auto", image: null, pick: "measure" });
  const modal = document.getElementById("modal")!;
  card = h("div", { class: "modal-card imp-card", role: "dialog", "aria-label": "Bring in a pattern" });
  modal.replaceChildren(card);
  modal.classList.remove("hidden");
  render();
}

function close(): void {
  document.getElementById("modal")?.classList.add("hidden");
  card = null;
}

function big(title: string, sub: string, onclick: () => void): HTMLElement {
  return h("button", { class: "imp-choice", type: "button", onclick }, h("span", { class: "imp-choice-title" }, title), h("span", { class: "imp-choice-sub" }, sub));
}

function btn(label: string, onclick: () => void, cls = ""): HTMLButtonElement {
  return h("button", { class: `btn imp-btn ${cls}`, type: "button", onclick, disabled: cls.includes("disabled") }, label);
}

function render(): void {
  if (!card) return;
  const rows: Node[] = [h("h2", {}, "Bring in a pattern")];
  if (s.step === "choose") {
    rows.push(
      h("p", { class: "imp-lead" }, "Where is the pattern you already have?"),
      h("div", { class: "imp-choices" },
        big("A file from my computer", "SVG, DXF or PDF, from Inkscape, Illustrator, a CAD program or a pattern shop.", () => void pickFile()),
        big("A photo of my paper pattern", "A photo or scan of paper or card pieces lying flat on a plain surface.", () => void pickPhoto())),
      h("div", { class: "imp-actions" }, btn("Cancel", close, "quiet")),
    );
  } else if (s.step === "busy") {
    rows.push(h("p", { class: "imp-lead imp-busy" }, s.busyText));
  } else if (s.step === "error") {
    rows.push(h("p", { class: "imp-error" }, s.error), h("div", { class: "imp-actions" }, btn("Back", () => go("choose"), "quiet"), btn("Close", close)));
  } else {
    const parts = s.step === "photo" ? photoStep() : previewStep();
    rows.push(...parts.filter((n): n is Node => n !== null));
  }
  card.replaceChildren(...rows);
  if (s.step === "photo" || s.step === "preview") requestAnimationFrame(drawCanvas);
}

function go(step: Step): void {
  s.step = step;
  render();
}

function fail(e: unknown): void {
  s.error = String(e);
  go("error");
}

// ---------- files ----------

async function pickFile(): Promise<void> {
  const path = await open({ multiple: false, directory: false, title: "Choose a pattern file", filters: [{ name: "Pattern files", extensions: ["svg", "dxf", "pdf"] }] });
  if (typeof path !== "string") return;
  s.kind = "file";
  s.path = path;
  await readFile();
}

async function readFile(): Promise<void> {
  s.busyText = "Reading the file…";
  go("busy");
  try {
    s.result = await invoke<ImportResult>("import_pattern", { path: s.path, options: { units: s.units, materialId: state.project.materials[0]?.id ?? "" } });
    go("preview");
  } catch (e) {
    fail(e);
  }
}

// ---------- photos ----------

async function pickPhoto(): Promise<void> {
  const path = await open({ multiple: false, directory: false, title: "Choose a photo of your pattern", filters: [{ name: "Photos", extensions: ["jpg", "jpeg", "png"] }] });
  if (typeof path !== "string") return;
  s.kind = "photo";
  s.path = path;
  s.image = null;
  await trace(true);
}

function lengthMm(): number {
  return s.length * (s.lengthUnit === "in" ? 25.4 : s.lengthUnit === "cm" ? 10 : 1);
}

async function trace(first = false): Promise<void> {
  s.busyText = first ? "Looking at the photo… this can take a few seconds." : "Tracing again…";
  go("busy");
  const options: Record<string, unknown> = {
    materialId: state.project.materials[0]?.id ?? "",
    foreground: s.foreground,
    preview: !s.image,
  };
  if (s.thresholdSet && s.threshold !== null) options.threshold = s.threshold;
  if (s.corners.length === 4) {
    options.corners = s.corners;
    options.sheet = s.sheet;
  } else if (s.points.length === 2 && lengthMm() > 0) {
    options.scalePoints = s.points;
    options.scaleLengthMm = lengthMm();
  }
  try {
    const r = await invoke<ImportResult>("trace_pattern", { path: s.path, options });
    if (r.underlay) {
      const img = new Image();
      img.src = r.underlay.dataUrl;
      await img.decode().catch(() => undefined);
      s.image = img;
      if (!s.thresholdSet) s.threshold = r.underlay.threshold;
    } else if (s.result?.underlay) {
      r.underlay = { ...s.result.underlay, scaleKnown: r.pieces.length > 0 };
    }
    s.result = r;
    go("photo");
  } catch (e) {
    fail(e);
  }
}

function scaleKnown(): boolean {
  return !!s.result && s.result.pieces.length > 0;
}

function photoStep(): (Node | null)[] {
  const r = s.result!;
  const len = h("input", {
    type: "number", min: "0", step: "any", class: "imp-input", value: s.length > 0 ? String(s.length) : "",
    placeholder: "length", "aria-label": "How long it is",
    oninput: (e: Event) => { s.length = parseFloat((e.target as HTMLInputElement).value) || 0; },
    onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") void trace(); },
  });
  const unit = h("select", { class: "imp-input", "aria-label": "Unit", onchange: (e: Event) => { s.lengthUnit = (e.target as HTMLSelectElement).value as typeof s.lengthUnit; } },
    ...(["mm", "cm", "in"] as const).map((u) => h("option", { value: u, selected: s.lengthUnit === u }, u === "in" ? "inches" : u)));
  const tab = (id: typeof s.pick, label: string) => h("button", { type: "button", class: `imp-tab ${s.pick === id ? "on" : ""}`, onclick: () => { s.pick = id; render(); } }, label);
  const help = s.pick === "measure"
    ? h("div", { class: "imp-step" },
        h("p", { class: "imp-lead" }, s.points.length < 2 ? `Click two points on something you measured (${s.points.length} of 2).` : "Now type how long it is between the two points."),
        h("div", { class: "imp-row" }, len, unit, btn("Use this size", () => void trace(), "primary"), s.points.length ? btn("Clear points", () => { s.points = []; render(); }, "quiet") : null))
    : h("div", { class: "imp-step" },
        h("p", { class: "imp-lead" }, s.corners.length < 4 ? `Click the four corners of the sheet of paper (${s.corners.length} of 4).` : "The photo has been straightened using the sheet."),
        h("div", { class: "imp-row" },
          h("label", { class: "imp-inline" }, "The sheet is ",
            h("select", { class: "imp-input", onchange: (e: Event) => { s.sheet = (e.target as HTMLSelectElement).value as typeof s.sheet; if (s.corners.length === 4) void trace(); } },
              h("option", { value: "letter", selected: s.sheet === "letter" }, "Letter (8½ × 11 in)"),
              h("option", { value: "a4", selected: s.sheet === "a4" }, "A4 (210 × 297 mm)"))),
          s.corners.length ? btn("Clear corners", () => { s.corners = []; void trace(); }, "quiet") : null),
        h("p", { class: "imp-hint" }, "Use this when the pattern lies on (or next to) a sheet of paper. It also corrects a photo taken at an angle."));
  const slider = h("input", {
    type: "range", min: "1", max: "254", value: String(s.threshold ?? 128), class: "imp-slider", "aria-label": "Outline sensitivity",
    onchange: (e: Event) => { s.threshold = parseInt((e.target as HTMLInputElement).value, 10); s.thresholdSet = true; void trace(); },
  });
  const fg = h("select", { class: "imp-input", "aria-label": "Which is the pattern", onchange: (e: Event) => { s.foreground = (e.target as HTMLSelectElement).value as typeof s.foreground; void trace(); } },
    h("option", { value: "auto", selected: s.foreground === "auto" }, "Work it out"),
    h("option", { value: "dark", selected: s.foreground === "dark" }, "The darker shapes"),
    h("option", { value: "light", selected: s.foreground === "light" }, "The lighter shapes"));
  return [
    h("p", { class: "imp-lead" }, "Step 1: tell Hidework how big the photo is."),
    h("div", { class: "imp-tabs" }, tab("measure", "I measured something"), tab("corners", "It is on a sheet of paper")),
    help,
    canvasBox(),
    h("div", { class: "imp-row imp-tune" },
      h("label", { class: "imp-inline" }, "If the red outline is wrong, move this: ", slider),
      h("label", { class: "imp-inline" }, "The pattern is ", fg)),
    h("p", { class: `imp-summary ${scaleKnown() ? "ok" : ""}` }, r.summary),
    warningsList(r.warnings),
    h("div", { class: "imp-actions" },
      btn("Back", () => go("choose"), "quiet"),
      btn("Next: check the size", () => go("preview"), scaleKnown() ? "primary" : "primary disabled")),
  ];
}

// ---------- preview ----------

function previewStep(): (Node | null)[] {
  const r = s.result!;
  const unitsSel = h("select", { class: "imp-input", "aria-label": "The file is drawn in", onchange: (e: Event) => { s.units = (e.target as HTMLSelectElement).value; void readFile(); } },
    ...[["", "Work it out"], ["mm", "millimetres"], ["cm", "centimetres"], ["in", "inches"], ["pt", "points (1/72 inch)"], ["px", "pixels (96 per inch)"]].map(([v, l]) => h("option", { value: v, selected: s.units === v }, l)));
  const ok = r.pieces.length > 0;
  return [
    h("p", { class: "imp-lead" }, ok ? "Step 2: check it. Each piece shows its size; hold a ruler to your paper pattern to compare." : "Nothing could be brought in from this file."),
    canvasBox(),
    h("p", { class: `imp-summary ${ok ? "ok" : ""}` }, r.summary),
    s.kind === "file"
      ? h("div", { class: "imp-row" }, h("span", { class: "imp-hint" }, `Read as ${r.unitsDetected}.`), h("label", { class: "imp-inline" }, "Size looks wrong? The file is drawn in ", unitsSel))
      : null,
    warningsList(r.warnings),
    h("div", { class: "imp-actions" },
      btn("Back", () => go(s.kind === "photo" ? "photo" : "choose"), "quiet"),
      btn("Add to my pattern", add, ok ? "primary" : "primary disabled")),
  ];
}

function warningsList(w: string[]): Node | null {
  if (!w.length) return null;
  return h("details", { class: "imp-notes" }, h("summary", {}, `Notes (${w.length})`), h("ul", {}, ...w.map((t) => h("li", {}, t))));
}

// ---------- the canvas ----------

let cv: HTMLCanvasElement | null = null;
/** Photo pixels or sheet millimetres to canvas pixels. */
let view = { k: 1, ox: 0, oy: 0 };

function canvasBox(): HTMLElement {
  cv = h("canvas", { class: "imp-canvas", onclick: (e: MouseEvent) => clickCanvas(e) });
  return h("div", { class: "imp-canvas-box" }, cv);
}

function fit(minX: number, minY: number, maxX: number, maxY: number, w: number, hgt: number, pad: number): void {
  const k = Math.min((w - 2 * pad) / Math.max(1e-6, maxX - minX), (hgt - 2 * pad) / Math.max(1e-6, maxY - minY));
  view = { k, ox: (w - (maxX - minX) * k) / 2 - minX * k, oy: (hgt - (maxY - minY) * k) / 2 - minY * k };
}

const X = (p: V): [number, number] => [p.x * view.k + view.ox, p.y * view.k + view.oy];

function drawCanvas(): void {
  if (!cv || !s.result) return;
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--ink").trim() || "#2b1d0e";
  const paper = css.getPropertyValue("--parchment").trim() || "#efe2c4";
  g.fillStyle = paper;
  g.fillRect(0, 0, r.width, r.height);
  if (s.step === "photo") drawPhoto(g, r.width, r.height);
  else drawPieces(g, r.width, r.height, ink);
}

function drawPhoto(g: CanvasRenderingContext2D, w: number, hgt: number): void {
  const u = s.result?.underlay;
  if (!u) return;
  fit(0, 0, u.width, u.height, w, hgt, 8);
  if (s.image) g.drawImage(s.image, view.ox, view.oy, u.width * view.k, u.height * view.k);
  g.lineWidth = 2.5;
  g.strokeStyle = "#e0322a";
  for (const loop of s.result!.tracedPx) {
    g.beginPath();
    loop.forEach((p, i) => (i ? g.lineTo(...X(p)) : g.moveTo(...X(p))));
    g.closePath();
    g.stroke();
  }
  const dot = (p: V, label: string, color: string) => {
    const [x, y] = X(p);
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#fff";
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = "#fff";
    g.font = "bold 12px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, x, y + 0.5);
  };
  if (s.points.length === 2) {
    g.strokeStyle = "#1f7ae0";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(...X(s.points[0]));
    g.lineTo(...X(s.points[1]));
    g.stroke();
  }
  s.points.forEach((p, i) => dot(p, String(i + 1), "#1f7ae0"));
  if (s.corners.length > 1) {
    g.strokeStyle = "#2e9e4f";
    g.lineWidth = 2;
    g.beginPath();
    s.corners.forEach((p, i) => (i ? g.lineTo(...X(p)) : g.moveTo(...X(p))));
    if (s.corners.length === 4) g.closePath();
    g.stroke();
  }
  s.corners.forEach((p, i) => dot(p, String(i + 1), "#2e9e4f"));
}

function clickCanvas(e: MouseEvent): void {
  if (s.step !== "photo" || !cv) return;
  const r = cv.getBoundingClientRect();
  const p = { x: (e.clientX - r.left - view.ox) / view.k, y: (e.clientY - r.top - view.oy) / view.k };
  const u = s.result?.underlay;
  if (!u || p.x < 0 || p.y < 0 || p.x > u.width || p.y > u.height) return;
  if (s.pick === "measure") {
    if (s.points.length >= 2) s.points = [];
    s.points.push(p);
    render();
  } else {
    if (s.corners.length >= 4) s.corners = [];
    s.corners.push(p);
    if (s.corners.length === 4) void trace();
    else render();
  }
}

/** Points along a piece outline in sheet millimetres. */
function outline(pc: Piece): V[] {
  const n = pc.vertices.length;
  const out: V[] = [];
  pc.edges.forEach((e, i) => {
    const a = pc.vertices[i];
    const b = pc.vertices[(i + 1) % n];
    if (e.type === "cubic") {
      for (let k = 0; k < 16; k++) {
        const t = k / 16, m = 1 - t;
        out.push({
          x: m * m * m * a.x + 3 * m * m * t * e.c1.x + 3 * m * t * t * e.c2.x + t * t * t * b.x,
          y: m * m * m * a.y + 3 * m * m * t * e.c1.y + 3 * m * t * t * e.c2.y + t * t * t * b.y,
        });
      }
    } else out.push(a);
  });
  return out.map((p) => ({ x: p.x + pc.position.x, y: p.y + pc.position.y }));
}

function bboxOf(pts: V[]): { min: V; max: V } {
  const min = { x: Infinity, y: Infinity }, max = { x: -Infinity, y: -Infinity };
  for (const p of pts) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y);
  }
  return { min, max };
}

function fmtLen(mm: number): string {
  return state.project.units === "in" ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(mm < 100 ? 1 : 0)} mm`;
}

function drawPieces(g: CanvasRenderingContext2D, w: number, hgt: number, ink: string): void {
  const r = s.result!;
  const shapes = r.pieces.map(outline);
  const all = [...shapes.flat(), ...r.openPaths.flat()];
  if (!all.length) return;
  const b = bboxOf(all);
  fit(b.min.x, b.min.y, b.max.x, b.max.y, w, hgt - 26, 30);
  g.lineJoin = "round";
  r.pieces.forEach((pc, i) => {
    const pts = shapes[i];
    g.beginPath();
    pts.forEach((p, k) => (k ? g.lineTo(...X(p)) : g.moveTo(...X(p))));
    g.closePath();
    g.fillStyle = "rgba(160, 104, 52, 0.28)";
    g.fill();
    g.strokeStyle = ink;
    g.lineWidth = 1.6;
    g.stroke();
    g.fillStyle = ink;
    for (const hole of pc.holes) {
      const [x, y] = X({ x: hole.center.x + pc.position.x, y: hole.center.y + pc.position.y });
      const len = Math.max(hole.lengthMm ?? 0, hole.diameterMm);
      const rr = Math.max(1.5, (hole.diameterMm / 2) * view.k);
      const a = ((hole.angleDeg ?? 0) * Math.PI) / 180;
      const half = Math.max(0, (len - hole.diameterMm) / 2) * view.k;
      g.save();
      g.translate(x, y);
      g.rotate(a);
      g.beginPath();
      g.arc(-half, 0, rr, Math.PI / 2, (3 * Math.PI) / 2);
      g.arc(half, 0, rr, -Math.PI / 2, Math.PI / 2);
      g.closePath();
      g.fillStyle = "#f6ecd3";
      g.fill();
      g.stroke();
      g.restore();
    }
    g.setLineDash([6, 4]);
    g.strokeStyle = "#1f5fbf";
    for (const f of pc.folds) {
      const pb = bboxOf(pts);
      const pos = f.orientation === "horizontal" ? f.position + pc.position.y : f.position + pc.position.x;
      g.beginPath();
      if (f.orientation === "horizontal") { g.moveTo(...X({ x: pb.min.x, y: pos })); g.lineTo(...X({ x: pb.max.x, y: pos })); }
      else { g.moveTo(...X({ x: pos, y: pb.min.y })); g.lineTo(...X({ x: pos, y: pb.max.y })); }
      g.stroke();
    }
    g.setLineDash([]);
    const pb = bboxOf(pts);
    const [cx, cy] = X({ x: (pb.min.x + pb.max.x) / 2, y: (pb.min.y + pb.max.y) / 2 });
    // Name and size on a pale label so holes and lines under it do not hide the text.
    const size = `${fmtLen(pb.max.x - pb.min.x)} × ${fmtLen(pb.max.y - pb.min.y)}`;
    g.font = "bold 14px Georgia, serif";
    const tw = Math.max(g.measureText(pc.name).width, g.measureText(size).width) + 12;
    g.fillStyle = "rgba(246, 236, 211, 0.85)";
    g.fillRect(cx - tw / 2, cy - 19, tw, 38);
    g.fillStyle = ink;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(pc.name, cx, cy - 9);
    g.font = "13px Georgia, serif";
    g.fillText(size, cx, cy + 9);
  });
  g.setLineDash([3, 4]);
  g.strokeStyle = "rgba(43, 29, 14, 0.5)";
  for (const line of r.openPaths) {
    g.beginPath();
    line.forEach((p, k) => (k ? g.lineTo(...X(p)) : g.moveTo(...X(p))));
    g.stroke();
  }
  g.setLineDash([]);
  // Scale bar: 10 cm (or 4 in), shortened to fit.
  const unitIn = state.project.units === "in";
  let barMm = unitIn ? 101.6 : 100;
  while (barMm * view.k > w * 0.4 && barMm > 5) barMm /= 2;
  const x0 = 16, y0 = hgt - 14;
  g.strokeStyle = ink;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x0, y0 - 5); g.lineTo(x0, y0); g.lineTo(x0 + barMm * view.k, y0); g.lineTo(x0 + barMm * view.k, y0 - 5);
  g.stroke();
  g.fillStyle = ink;
  g.textAlign = "left";
  g.textBaseline = "bottom";
  g.font = "12px Georgia, serif";
  g.fillText(unitIn ? `${(barMm / 25.4).toFixed(barMm < 25 ? 2 : 0)} in` : `${barMm >= 10 ? (barMm / 10).toFixed(barMm % 10 ? 1 : 0) + " cm" : barMm + " mm"}`, x0 + barMm * view.k + 6, y0 + 2);
}

// ---------- adding ----------

/** Rightmost and topmost extent of the pieces already in the project, in sheet millimetres. */
function existingExtent(): { right: number; top: number } | null {
  const pts = state.project.pieces.flatMap((pc) => {
    const ctl = pc.edges.flatMap((e) => (e.type === "cubic" ? [e.c1, e.c2] : []));
    return [...pc.vertices, ...ctl].map((p) => ({ x: p.x + pc.position.x, y: p.y + pc.position.y }));
  });
  if (!pts.length) return null;
  const b = bboxOf(pts);
  return { right: b.max.x, top: b.min.y };
}

function add(): void {
  const r = s.result;
  if (!r || !r.pieces.length) return;
  const material = state.project.materials[0]?.id;
  const pieces: Piece[] = JSON.parse(JSON.stringify(r.pieces));
  const b = bboxOf(pieces.flatMap(outline));
  const at = existingExtent();
  const dx = (at ? at.right + 20 : 0) - b.min.x;
  const dy = (at ? at.top : 0) - b.min.y;
  const ids: string[] = [];
  for (const pc of pieces) {
    pc.id = uid("p");
    if (material) pc.materialId = material;
    pc.position = { x: pc.position.x + dx, y: pc.position.y + dy };
    ids.push(pc.id);
  }
  edit((p) => p.pieces.push(...pieces));
  selectPieces(ids);
  notify();
  close();
  setStatus(`Added ${pieces.length === 1 ? "1 piece" : `${pieces.length} pieces`} from ${s.path.split(/[\\/]/).pop()}. Check the sizes with the Measure tool.`);
  void whenComputed().then(fitView);
}
