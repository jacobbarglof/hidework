// Leather layout and cost: pick the leather you have, mark its flaws, see how many items fit
// and where to cut, print the cutting layout, and work out what an item costs and what to
// charge. Big, plain controls for makers who do not live in software.
//
// Reads the project from the store and never changes it. The leather choice, flaws, prices and
// piece flags are remembered in localStorage until the project file gains fields for them.

import { invoke } from "@tauri-apps/api/core";
import "./hide.css";
import { state } from "./store";
import type { Project, V } from "./types";

// ---------- types mirrored from hidework-core (hide.rs, nest.rs, costing.rs) ----------

type FlawKind = "scar" | "brand" | "hole" | "tick" | "thin" | "stretchy";
type Severity = "minor" | "major";
type Grade = "A" | "B" | "C";
type AreaUnit = "sqft" | "m2" | "dm2";

interface Flaw {
  id: string;
  kind: FlawKind;
  shape: { type: "circle"; center: V; radiusMm: number } | { type: "polygon"; points: V[] };
  severity: Severity;
  note?: string;
}

interface Hide {
  id: string;
  name: string;
  kind: string;
  outline: V[];
  flaws: Flaw[];
  zones: { grade: Grade; polygon: V[] }[];
  backbone: { from: V; to: V } | null;
  thicknessMm: number;
  price: number | null;
  stampedSqft?: number | null;
}

interface HidePreset {
  id: string;
  name: string;
  description: string;
  typicalSqft: [number, number];
  hide: Hide;
}

interface PieceRule {
  pieceId: string;
  visible?: boolean | null;
  grain?: boolean | null;
  skip?: boolean;
}

interface NestOptions {
  spacingMm: number;
  edgeMarginMm: number;
  flawMarginMm: number;
  sets: number;
  materialId?: string | null;
  grain: "all" | "long" | "none";
  mirrorPairs: boolean;
  rules: PieceRule[];
  timeMs: number;
  includeSvg: boolean;
}

interface Placement {
  pieceId: string;
  name: string;
  item: number;
  copy: number;
  angleDeg: number;
  mirrored: boolean;
  offset: V;
  outline: V[];
  grade: Grade;
  visible: boolean;
  areaMm2: number;
  shape: number;
}

interface NestResult {
  hideName: string;
  materialId: string;
  materialName: string;
  pieces: { pieceId: string; name: string; perSet: number; areaMm2: number; visible: boolean; followsBackbone: boolean }[];
  placements: Placement[];
  unplaced: { pieceId: string; name: string; count: number; reason: string }[];
  completeItems: number;
  setsRequested: number;
  hideAreaMm2: number;
  usableAreaMm2: number;
  usedAreaMm2: number;
  wasteAreaMm2: number;
  yieldPct: number;
  leftoverPct: number;
  itemAreaMm2: number;
  leatherPerItemMm2: number;
  sentence: string;
  notes: string[];
  runs: number;
  elapsedMs: number;
  resolutionMm: number;
  svg: string | null;
}

interface Prices {
  currency: string;
  areaUnit: AreaUnit;
  leatherPrice: number;
  liningPrice: number;
  materialPrices: { materialId: string; price: number }[];
  wastePct: number;
  nest: { materialId: string; hideName: string; hideAreaMm2: number; items: number; hidePrice: number | null } | null;
  threadPerM: number;
  lacePerM: number;
  hardware: { kind: string; price: number }[];
  gluePerG: number;
  edgePaintPerM: number;
  consumables: number;
  hourlyRate: number;
  overheadPct: number;
  wholesaleX: number;
  retailX: number;
  labour: Record<string, number>;
}

interface CostLine {
  group: string;
  label: string;
  key: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  cost: number;
  text: string;
}

interface CostReport {
  currency: string;
  lines: CostLine[];
  labourSteps: { step: string; minutes: number; how: string }[];
  materialsCost: number;
  labourMinutes: number;
  labourCost: number;
  overheadCost: number;
  totalCost: number;
  wholesale: number;
  retail: number;
  wholesaleMarginPct: number;
  retailMarginPct: number;
  summary: string[];
}

// ---------- remembered settings ----------

const MM2_PER_SQFT = 92903.04;
const KEY = "hidework.leather.";

function load<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(KEY + name);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function loadList<T>(name: string): T[] {
  try {
    const raw = localStorage.getItem(KEY + name);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(name: string, value: unknown): void {
  try {
    localStorage.setItem(KEY + name, JSON.stringify(value));
  } catch {
    /* storage full or blocked: settings just are not remembered */
  }
}

type Choice = { kind: "preset"; id: string } | { kind: "panel"; wMm: number; hMm: number };

const LABOUR_LABELS: [string, string][] = [
  ["cutPerPieceMin", "Cutting: minutes per piece"],
  ["cutPerMMin", "Cutting: minutes per metre of line"],
  ["prickPerHoleMin", "Pricking: minutes per hole"],
  ["handStitchPerHoleMin", "Hand stitching: minutes per stitch"],
  ["machineStitchPerHoleMin", "Machine stitching: minutes per stitch"],
  ["lacePerSlitMin", "Lacing: minutes per slit"],
  ["edgeBurnishedPerMMin", "Burnished edges: minutes per metre"],
  ["edgePaintedPerMMin", "Painted edges: minutes per metre"],
  ["edgeTurnedPerMMin", "Turned edges: minutes per metre"],
  ["skivePerMMin", "Skiving: minutes per metre"],
  ["gluePerSeamMin", "Gluing: minutes per seam"],
  ["punchPerHoleMin", "Punching: minutes per hole"],
  ["hardwareFactor", "Hardware setting: times the usual time"],
  ["assemblyPerPieceMin", "Assembly: minutes per piece"],
  ["extraMin", "Design, packing and photos: minutes per item"],
];

const ui = {
  root: null as HTMLElement | null,
  tab: "leather" as "leather" | "fit" | "cost",
  presets: [] as HidePreset[],
  choice: load<{ c: Choice }>("choice", { c: { kind: "preset", id: "double-shoulder" } }).c,
  flawKind: "scar" as FlawKind,
  flawSeverity: "major" as Severity,
  options: load("options", { spacingMm: 3, edgeMarginMm: 5, sets: 0, grain: "long" as "all" | "long" | "none" }),
  result: null as NestResult | null,
  resultHide: null as Hide | null,
  stale: false,
  busy: false,
  error: "",
  prices: null as Prices | null,
  useLayout: true,
  report: null as CostReport | null,
  canvas: null as HTMLCanvasElement | null,
  drag: null as null | { center: V; radius: number },
  scrollToResult: false,
  view: { k: 1, ox: 0, oy: 0 },
};

function choiceKey(c: Choice = ui.choice): string {
  return c.kind === "preset" ? c.id : `panel-${Math.round(c.wMm)}x${Math.round(c.hMm)}`;
}

function flaws(): Flaw[] {
  return loadList<Flaw>(`flaws.${choiceKey()}`);
}

function setFlaws(list: Flaw[]): void {
  save(`flaws.${choiceKey()}`, list);
  if (ui.result) ui.stale = true;
}

function paid(): number | null {
  const v = load<{ v: number | null }>(`paid.${choiceKey()}`, { v: null }).v;
  return typeof v === "number" && v > 0 ? v : null;
}

function projectKey(): string {
  return state.project?.name || "untitled";
}

function visibleFlags(): Record<string, boolean> {
  return load<Record<string, boolean>>(`visible.${projectKey()}`, {});
}

// ---------- the leather ----------

function fmtIn(mm: number): string {
  return `${+(mm / 25.4).toFixed(1)}`;
}

function panelName(wMm: number, hMm: number): string {
  return state.project?.units === "in" ? `${fmtIn(wMm)} x ${fmtIn(hMm)} in panel` : `${+(wMm / 10).toFixed(1)} x ${+(hMm / 10).toFixed(1)} cm panel`;
}

/** The leather as sent to the core: the preset or panel, the marked flaws and the price paid. */
function currentHide(): Hide | null {
  const c = ui.choice;
  let hide: Hide;
  if (c.kind === "panel") {
    hide = {
      id: choiceKey(c),
      name: panelName(c.wMm, c.hMm),
      kind: "panel",
      outline: [
        { x: 0, y: 0 },
        { x: c.wMm, y: 0 },
        { x: c.wMm, y: c.hMm },
        { x: 0, y: c.hMm },
      ],
      flaws: [],
      zones: [],
      backbone: null,
      thicknessMm: 2,
      price: null,
    };
  } else {
    const p = ui.presets.find((x) => x.id === c.id);
    if (!p) return null;
    hide = JSON.parse(JSON.stringify(p.hide)) as Hide;
  }
  hide.flaws = flaws();
  hide.price = paid();
  return hide;
}

function polyArea(pts: V[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function areaText(mm2: number): string {
  return `${(mm2 / MM2_PER_SQFT).toFixed(1)} sq ft (${(mm2 / 1e6).toFixed(2)} m²)`;
}

function money(x: number, cur = ui.prices?.currency ?? "$"): string {
  return `${cur}${x.toFixed(2)}`;
}

// ---------- DOM helpers ----------

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

function bigButton(label: string, onclick: () => void, cls = ""): HTMLButtonElement {
  return el("button", { type: "button", class: `hw-btn ${cls}`, onclick }, label);
}

function numberInput(value: number, commit: (v: number) => void, opts: { step?: number; min?: number; label?: string } = {}): HTMLInputElement {
  return el("input", {
    type: "number",
    class: "hw-num",
    value: String(+value.toFixed(opts.step !== undefined && opts.step >= 0.01 ? Math.max(0, -Math.floor(Math.log10(opts.step))) : 4)),
    step: String(opts.step ?? "any"),
    min: opts.min !== undefined ? String(opts.min) : undefined,
    "aria-label": opts.label,
    onchange: (e: Event) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) commit(v);
    },
  });
}

function outlineSvg(pts: V[], size = 120): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const svg = document.createElementNS(ns, "svg");
  const pad = Math.max(w, h) * 0.04;
  svg.setAttribute("viewBox", `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${w + 2 * pad} ${h + 2 * pad}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size * 0.75));
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(0)} ${p.y.toFixed(0)}`).join("") + "Z");
  path.setAttribute("class", "hw-thumb-shape");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);
  return svg;
}

// ---------- open / close ----------

/** Open the leather layout and costing dialog. */
export function openHideLayout(): void {
  if (!state.project) return;
  if (!ui.root) {
    ui.root = el("div", { class: "hw-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Leather layout and cost" });
    ui.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    document.body.append(ui.root);
  }
  ui.root.classList.remove("hidden");
  ui.result = null;
  ui.report = null;
  ui.stale = false;
  ui.error = "";
  render();
  if (!ui.presets.length) {
    invoke<HidePreset[]>("hide_presets")
      .then((p) => {
        ui.presets = p;
        render();
      })
      .catch((e) => {
        ui.error = `Could not load the leather shapes: ${e}`;
        render();
      });
  }
  if (!ui.prices) {
    // Fill missing settings with the core's defaults by costing once with what we remember.
    ui.prices = load<Prices>("prices", defaultPrices());
  }
}

function close(): void {
  ui.root?.classList.add("hidden");
}

function defaultPrices(): Prices {
  return {
    currency: "$",
    areaUnit: "sqft",
    leatherPrice: 9,
    liningPrice: 3,
    materialPrices: [],
    wastePct: 25,
    nest: null,
    threadPerM: 0.12,
    lacePerM: 0.8,
    hardware: [],
    gluePerG: 0.04,
    edgePaintPerM: 0.25,
    consumables: 0.75,
    hourlyRate: 25,
    overheadPct: 15,
    wholesaleX: 2,
    retailX: 2,
    labour: {},
  };
}

// ---------- rendering ----------

function render(): void {
  const root = ui.root;
  if (!root) return;
  const tabs: [typeof ui.tab, string][] = [
    ["leather", "1. Your leather"],
    ["fit", "2. How many can I make?"],
    ["cost", "3. What does it cost?"],
  ];
  const head = el(
    "div",
    { class: "hw-head" },
    el("h2", {}, "Leather layout and cost"),
    el(
      "div",
      { class: "hw-tabs", role: "tablist" },
      ...tabs.map(([id, label]) =>
        el(
          "button",
          {
            type: "button",
            role: "tab",
            class: `hw-tab${ui.tab === id ? " on" : ""}`,
            "aria-selected": String(ui.tab === id),
            onclick: () => {
              ui.tab = id;
              render();
              if (id === "cost") recost();
            },
          },
          label,
        ),
      ),
    ),
    bigButton("Close", close, "quiet"),
  );
  const body = el("div", { class: "hw-body" });
  if (ui.error) body.append(el("p", { class: "hw-error" }, ui.error));
  if (ui.tab === "leather") body.append(...renderLeather());
  else if (ui.tab === "fit") body.append(...renderFit());
  else body.append(...renderCost());
  root.replaceChildren(el("div", { class: "hw-card" }, head, body));
  if (ui.tab === "fit") drawCanvas();
  if (ui.scrollToResult) {
    ui.scrollToResult = false;
    root.querySelector(".hw-result")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

function renderLeather(): Node[] {
  const out: Node[] = [el("p", { class: "hw-lead" }, "Which leather do you have? Pick the shape closest to it.")];
  if (!ui.presets.length) {
    out.push(el("p", {}, "Loading the leather shapes…"));
    return out;
  }
  const grid = el("div", { class: "hw-grid" });
  for (const p of ui.presets) {
    const on = ui.choice.kind === "preset" && ui.choice.id === p.id;
    const area = polyArea(p.hide.outline);
    const range = p.typicalSqft[0] === p.typicalSqft[1] ? `${p.typicalSqft[0]} sq ft` : `usually ${p.typicalSqft[0]} to ${p.typicalSqft[1]} sq ft`;
    grid.append(
      el(
        "button",
        {
          type: "button",
          class: `hw-pick${on ? " on" : ""}`,
          "aria-pressed": String(on),
          onclick: () => {
            ui.choice = { kind: "preset", id: p.id };
            save("choice", { c: ui.choice });
            ui.result = null;
            render();
          },
        },
        outlineSvg(p.hide.outline),
        el("strong", {}, p.name),
        el("span", { class: "hw-size" }, `This one: ${areaText(area)}`),
        el("span", { class: "hw-size" }, range),
        el("span", { class: "hw-desc" }, p.description),
      ),
    );
  }
  out.push(grid);
  // A panel of any size.
  const inches = state.project?.units === "in";
  const unit = inches ? "in" : "cm";
  const perUnit = inches ? 25.4 : 10;
  const cur = ui.choice.kind === "panel" ? ui.choice : { kind: "panel" as const, wMm: 12 * 25.4, hMm: 24 * 25.4 };
  let w = cur.wMm / perUnit;
  let h = cur.hMm / perUnit;
  const panelOn = ui.choice.kind === "panel";
  out.push(
    el(
      "div",
      { class: `hw-panel${panelOn ? " on" : ""}` },
      el("strong", {}, "Or a panel of"),
      numberInput(w, (v) => (w = v), { min: 1, label: `Width in ${unit}` }),
      el("span", {}, "by"),
      numberInput(h, (v) => (h = v), { min: 1, label: `Height in ${unit}` }),
      el("span", {}, unit),
      bigButton(panelOn ? "Using this panel" : "Use this panel", () => {
        if (w > 0 && h > 0) {
          ui.choice = { kind: "panel", wMm: w * perUnit, hMm: h * perUnit };
          save("choice", { c: ui.choice });
          ui.result = null;
          render();
        }
      }),
    ),
  );
  const hide = currentHide();
  out.push(
    el(
      "div",
      { class: "hw-row" },
      el("label", { class: "hw-field" }, el("span", {}, `What did you pay for this ${hide ? hide.name.toLowerCase() : "leather"}? (optional)`), numberInput(paid() ?? 0, (v) => {
        save(`paid.${choiceKey()}`, { v: v > 0 ? v : null });
      }, { min: 0, step: 0.01, label: "Price paid" })),
    ),
    el("div", { class: "hw-actions" }, bigButton("Next: how many can I make?", () => {
      ui.tab = "fit";
      render();
    }, "primary")),
  );
  return out;
}

const FLAW_KINDS: [FlawKind, string][] = [
  ["scar", "Scar"],
  ["brand", "Brand"],
  ["hole", "Hole"],
  ["tick", "Tick bite"],
  ["thin", "Thin spot"],
  ["stretchy", "Stretchy"],
];

function renderFit(): Node[] {
  const hide = currentHide();
  if (!hide) return [el("p", {}, "Pick your leather first.")];
  const p = state.project as Project;
  const flags = visibleFlags();
  const marks = el(
    "div",
    { class: "hw-tools" },
    el("span", { class: "hw-tools-label" }, "Mark a flaw, then drag on the leather:"),
    ...FLAW_KINDS.map(([k, label]) =>
      el(
        "button",
        {
          type: "button",
          class: `hw-chip${ui.flawKind === k ? " on" : ""}`,
          "aria-pressed": String(ui.flawKind === k),
          onclick: () => {
            ui.flawKind = k;
            render();
          },
        },
        label,
      ),
    ),
    el(
      "button",
      {
        type: "button",
        class: "hw-chip",
        title: "Minor flaws may sit under hidden parts such as linings",
        onclick: () => {
          ui.flawSeverity = ui.flawSeverity === "major" ? "minor" : "major";
          render();
        },
      },
      ui.flawSeverity === "major" ? "Cut around it completely" : "Fine under hidden parts",
    ),
    bigButton("Undo last mark", () => {
      const f = flaws();
      f.pop();
      setFlaws(f);
      render();
    }, "quiet"),
    bigButton("Clear marks", () => {
      setFlaws([]);
      render();
    }, "quiet"),
  );
  ui.canvas = el("canvas", { class: "hw-canvas", width: 900, height: 560, "aria-label": "The leather. Drag to mark a flaw." });
  wireCanvas(ui.canvas);
  const pieces = el(
    "div",
    { class: "hw-pieces" },
    el("h3", {}, "Pieces that show on the outside"),
    el("p", { class: "hw-hint" }, "These get the best leather and stay clear of small flaws."),
    ...p.pieces.map((pc) => {
      const def = !/lining|liner|stiffener|reinforc|backer|filler|welt|interfacing|inner/i.test(pc.name);
      const on = flags[pc.id] ?? def;
      return el(
        "label",
        { class: "hw-check" },
        el("input", {
          type: "checkbox",
          checked: on,
          onchange: (e: Event) => {
            const f = visibleFlags();
            f[pc.id] = (e.target as HTMLInputElement).checked;
            save(`visible.${projectKey()}`, f);
            if (ui.result) ui.stale = true;
          },
        }),
        el("span", {}, `${pc.name}${pc.cutCount > 1 ? ` (cut ${pc.cutCount})` : ""}`),
      );
    }),
    el("h3", {}, "Settings"),
    el("label", { class: "hw-field" }, el("span", {}, "Gap between pieces (mm)"), numberInput(ui.options.spacingMm, (v) => {
      ui.options.spacingMm = Math.max(0, v);
      save("options", ui.options);
    }, { min: 0, step: 0.5 })),
    el("label", { class: "hw-field" }, el("span", {}, "Keep in from the edge (mm)"), numberInput(ui.options.edgeMarginMm, (v) => {
      ui.options.edgeMarginMm = Math.max(0, v);
      save("options", ui.options);
    }, { min: 0, step: 1 })),
    el(
      "label",
      { class: "hw-check" },
      el("input", {
        type: "checkbox",
        checked: ui.options.grain !== "none",
        onchange: (e: Event) => {
          ui.options.grain = (e.target as HTMLInputElement).checked ? "long" : "none";
          save("options", ui.options);
        },
      }),
      el("span", {}, "Straps and long pieces follow the backbone"),
    ),
    el(
      "label",
      { class: "hw-check" },
      el("input", {
        type: "checkbox",
        checked: ui.options.sets === 1,
        onchange: (e: Event) => {
          ui.options.sets = (e.target as HTMLInputElement).checked ? 1 : 0;
          save("options", ui.options);
        },
      }),
      el("span", {}, "Lay out just one set (instead of as many as fit)"),
    ),
  );
  const out: Node[] = [
    el("p", { class: "hw-lead" }, `${hide.name}: ${areaText(polyArea(hide.outline))}.`),
    marks,
    el("div", { class: "hw-split" }, el("div", { class: "hw-stage" }, ui.canvas), pieces),
    el("div", { class: "hw-actions" }, bigButton(ui.busy ? "Working it out…" : "How many can I make?", fit, "primary huge")),
  ];
  if (ui.result) {
    const r = ui.result;
    out.push(
      el(
        "div",
        { class: "hw-result" },
        el("p", { class: "hw-sentence" }, r.sentence),
        ui.stale ? el("p", { class: "hw-warn" }, "You changed something since. Press the button again to update the layout.") : null,
        el(
          "div",
          { class: "hw-stats" },
          stat("Complete items", String(r.completeItems)),
          stat("Leather used", `${r.yieldPct.toFixed(0)}%`),
          stat("Left over", areaText(r.wasteAreaMm2)),
          stat("Leather per item", r.completeItems ? areaText(r.leatherPerItemMm2) : "–"),
        ),
        ...r.notes.map((n) => el("p", { class: "hw-note" }, n)),
        ...r.unplaced.map((u) => el("p", { class: "hw-warn" }, `${u.count} x ${u.name}: ${u.reason}.`)),
        el("p", { class: "hw-hint" }, `Numbers on the pieces are the item each piece belongs to. Worked out in ${(r.elapsedMs / 1000).toFixed(1)} s from ${r.runs} tries.`),
        el(
          "div",
          { class: "hw-actions" },
          bigButton("Print the cutting layout", printLayout),
          bigButton("What does it cost?", () => {
            ui.tab = "cost";
            render();
            recost();
          }, "primary"),
        ),
      ),
    );
  }
  return out;
}

function stat(label: string, value: string): HTMLElement {
  return el("div", { class: "hw-stat" }, el("span", {}, label), el("strong", {}, value));
}

async function fit(): Promise<void> {
  const hide = currentHide();
  if (!hide || ui.busy || !state.project) return;
  const flags = visibleFlags();
  const options: NestOptions = {
    spacingMm: ui.options.spacingMm,
    edgeMarginMm: ui.options.edgeMarginMm,
    flawMarginMm: 3,
    sets: ui.options.sets,
    grain: ui.options.grain,
    mirrorPairs: true,
    rules: Object.entries(flags).map(([pieceId, visible]) => ({ pieceId, visible })),
    timeMs: 1500,
    includeSvg: true,
  };
  ui.busy = true;
  ui.error = "";
  render();
  try {
    ui.result = await invoke<NestResult>("nest_on_hide", { project: state.project, hide, options });
    ui.resultHide = hide;
    ui.stale = false;
    ui.scrollToResult = true;
  } catch (e) {
    ui.error = `Could not lay out the pieces: ${e}`;
  } finally {
    ui.busy = false;
    render();
  }
}

// ---------- the drawing ----------

const COLOURS = ["#7aa6d8", "#e0a458", "#8cc084", "#d47f8c", "#b49ad8", "#6cc4c0", "#d8c35a", "#c98d6b", "#9fb2c4", "#e58f5a"];

function drawCanvas(): void {
  const cv = ui.canvas;
  const hide = ui.stale || !ui.resultHide ? currentHide() : ui.resultHide;
  if (!cv || !hide) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 900;
  const cssH = cv.clientHeight || 560;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  const xs = hide.outline.map((p) => p.x);
  const ys = hide.outline.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX;
  const h = Math.max(...ys) - minY;
  const pad = 24;
  const k = Math.min((cssW - 2 * pad) / w, (cssH - 2 * pad - 20) / h);
  ui.view = { k, ox: pad + (cssW - 2 * pad - w * k) / 2 - minX * k, oy: pad - minY * k };
  const T = (p: V): [number, number] => [ui.view.ox + p.x * k, ui.view.oy + p.y * k];
  const path = (pts: V[]) => {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(...T(p)) : g.moveTo(...T(p))));
    g.closePath();
  };
  path(hide.outline);
  g.fillStyle = "#efe2c4";
  g.fill();
  for (const z of hide.zones) {
    if (z.grade === "A") continue;
    path(z.polygon);
    g.fillStyle = z.grade === "B" ? "rgba(185,160,110,0.30)" : "rgba(150,120,70,0.40)";
    g.fill();
  }
  for (const z of hide.zones) {
    if (z.grade !== "A") continue;
    path(z.polygon);
    g.fillStyle = "#efe2c4";
    g.fill();
    g.setLineDash([6, 4]);
    g.strokeStyle = "#8a7a5a";
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);
  }
  path(hide.outline);
  g.strokeStyle = "#2b1d0e";
  g.lineWidth = 2;
  g.stroke();
  if (hide.backbone) {
    const [x1, y1] = T(hide.backbone.from);
    const [x2, y2] = T(hide.backbone.to);
    g.setLineDash([12, 6]);
    g.strokeStyle = "#8a2620";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = "#8a2620";
    g.font = "15px Georgia, serif";
    g.fillText("backbone", (x1 + x2) / 2 + 6, (y1 + y2) / 2 - 6);
  }
  if (ui.result && !ui.stale) {
    for (const p of ui.result.placements) {
      path(p.outline);
      g.fillStyle = COLOURS[p.shape % COLOURS.length];
      g.globalAlpha = 0.85;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = "#1b120a";
      g.lineWidth = 1;
      g.stroke();
      const bx = p.outline.map((q) => q.x);
      const by = p.outline.map((q) => q.y);
      const cx = (Math.min(...bx) + Math.max(...bx)) / 2;
      const cy = (Math.min(...by) + Math.max(...by)) / 2;
      const size = Math.min(Math.max(...bx) - Math.min(...bx), Math.max(...by) - Math.min(...by)) * k;
      if (size > 12) {
        g.fillStyle = "#1b120a";
        g.font = `${Math.min(22, Math.max(11, size * 0.4)).toFixed(0)}px Georgia, serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(String(p.item), ...T({ x: cx, y: cy }));
        g.textAlign = "start";
        g.textBaseline = "alphabetic";
      }
    }
  }
  const drawFlaw = (f: Flaw) => {
    if (f.shape.type === "circle") {
      const [x, y] = T(f.shape.center);
      g.beginPath();
      g.arc(x, y, Math.max(3, f.shape.radiusMm * k), 0, Math.PI * 2);
    } else {
      path(f.shape.points);
    }
    const col = f.severity === "major" || f.kind === "hole" ? "192,57,43" : "230,126,34";
    g.fillStyle = `rgba(${col},0.55)`;
    g.fill();
    g.strokeStyle = `rgb(${col})`;
    g.lineWidth = 2;
    g.stroke();
  };
  hide.flaws.forEach(drawFlaw);
  if (ui.drag) drawFlaw({ id: "", kind: ui.flawKind, severity: ui.flawSeverity, shape: { type: "circle", center: ui.drag.center, radiusMm: ui.drag.radius } });
  // Scale bar: 100 mm, or 4 inches when the project measures in inches.
  const inch = state.project?.units === "in";
  const bar = inch ? 101.6 : 100;
  const sx = cssW - pad - bar * k;
  const sy = cssH - 14;
  g.fillStyle = "#eadcc0";
  g.fillRect(sx, sy, bar * k, 4);
  g.font = "13px Georgia, serif";
  g.textAlign = "right";
  g.fillText(inch ? "4 in" : "100 mm", sx - 6, sy + 5);
  g.textAlign = "start";
}

function toMm(cv: HTMLCanvasElement, e: MouseEvent): V {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left - ui.view.ox) / ui.view.k, y: (e.clientY - r.top - ui.view.oy) / ui.view.k };
}

function wireCanvas(cv: HTMLCanvasElement): void {
  cv.addEventListener("mousedown", (e) => {
    ui.drag = { center: toMm(cv, e), radius: 15 };
    drawCanvas();
  });
  cv.addEventListener("mousemove", (e) => {
    if (!ui.drag) return;
    const p = toMm(cv, e);
    ui.drag.radius = Math.max(8, Math.hypot(p.x - ui.drag.center.x, p.y - ui.drag.center.y));
    drawCanvas();
  });
  const finish = () => {
    if (!ui.drag) return;
    const f = flaws();
    f.push({ id: `f${Date.now()}`, kind: ui.flawKind, severity: ui.flawSeverity, shape: { type: "circle", center: ui.drag.center, radiusMm: Math.round(ui.drag.radius) } });
    ui.drag = null;
    setFlaws(f);
    render();
  };
  cv.addEventListener("mouseup", finish);
  cv.addEventListener("mouseleave", finish);
}

// ---------- printing ----------

function printLayout(): void {
  const svg = ui.result?.svg;
  if (!svg) return;
  const holder = el("div", { id: "hw-print" });
  holder.innerHTML = svg;
  const s = holder.querySelector("svg");
  if (s) {
    // Fit the page; the drawing carries a 100 mm scale bar.
    s.removeAttribute("width");
    s.removeAttribute("height");
  }
  document.body.append(holder);
  document.body.classList.add("hw-printing");
  const done = () => {
    document.body.classList.remove("hw-printing");
    holder.remove();
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
  // Some webviews do not fire afterprint; clean up on the next interaction anyway.
  setTimeout(() => window.addEventListener("pointerdown", done, { once: true }), 500);
}

// ---------- cost ----------

let costTimer = 0;

function setPrice(fn: (p: Prices) => void): void {
  if (!ui.prices) ui.prices = defaultPrices();
  fn(ui.prices);
  save("prices", { ...ui.prices, nest: null });
  window.clearTimeout(costTimer);
  costTimer = window.setTimeout(recost, 250);
}

async function recost(): Promise<void> {
  if (!state.project) return;
  const prices: Prices = { ...(ui.prices ?? defaultPrices()) };
  const r = ui.result;
  prices.nest =
    ui.useLayout && r && r.completeItems > 0 && !ui.stale
      ? { materialId: r.materialId, hideName: r.hideName, hideAreaMm2: r.hideAreaMm2, items: r.completeItems, hidePrice: ui.resultHide?.price ?? null }
      : null;
  try {
    ui.report = await invoke<CostReport>("cost_project", { project: state.project, prices });
    ui.error = "";
  } catch (e) {
    ui.error = `Could not work out the cost: ${e}`;
  }
  if (ui.tab === "cost") render();
}

function priceField(label: string, value: number, commit: (v: number) => void, step = 0.01): HTMLElement {
  return el("label", { class: "hw-field" }, el("span", {}, label), numberInput(value, commit, { min: 0, step }));
}

function renderCost(): Node[] {
  const p = ui.prices ?? defaultPrices();
  const rep = ui.report;
  const cur = p.currency;
  const out: Node[] = [];
  if (rep) {
    out.push(
      el(
        "div",
        { class: "hw-prices" },
        el("div", { class: "hw-price" }, el("span", {}, "Costs you to make"), el("strong", {}, money(rep.totalCost, cur))),
        el("div", { class: "hw-price" }, el("span", {}, "Sell wholesale at"), el("strong", {}, money(rep.wholesale, cur)), el("em", {}, `${rep.wholesaleMarginPct.toFixed(0)}% margin`)),
        el("div", { class: "hw-price" }, el("span", {}, "Sell retail at"), el("strong", {}, money(rep.retail, cur)), el("em", {}, `${rep.retailMarginPct.toFixed(0)}% margin`)),
      ),
      ...rep.summary.map((s) => el("p", { class: "hw-summary" }, s)),
    );
  } else {
    out.push(el("p", { class: "hw-lead" }, "Working out the cost…"));
  }
  const r = ui.result;
  const form = el("div", { class: "hw-form" });
  if (r && r.completeItems > 0 && !ui.stale) {
    const paidNow = ui.resultHide?.price;
    form.append(
      el(
        "label",
        { class: "hw-check wide" },
        el("input", {
          type: "checkbox",
          checked: ui.useLayout,
          onchange: (e: Event) => {
            ui.useLayout = (e.target as HTMLInputElement).checked;
            recost();
          },
        }),
        el(
          "span",
          {},
          paidNow
            ? `Use my leather: the ${r.hideName.toLowerCase()} cost ${money(paidNow, cur)} and fits ${r.completeItems}.`
            : `Use my leather layout: ${r.completeItems} from this ${r.hideName.toLowerCase()} (with the leftover shared out).`,
        ),
      ),
    );
  }
  if (rep) {
    const fromPaid = ui.useLayout && r && r.completeItems > 0 && !ui.stale && ui.resultHide?.price ? r.materialId : null;
    for (const l of rep.lines.filter((l) => l.group === "Leather" || l.group === "Lining")) {
      if (l.key === fromPaid) continue;
      form.append(
        priceField(`${l.label}: price per ${l.unit}`, l.unitPrice, (v) =>
          setPrice((pr) => {
            pr.materialPrices = pr.materialPrices.filter((m) => m.materialId !== l.key);
            pr.materialPrices.push({ materialId: l.key, price: v });
          }),
        ),
      );
    }
  }
  form.append(
    priceField(`Your hourly rate (${cur})`, p.hourlyRate, (v) => setPrice((pr) => (pr.hourlyRate = v)), 1),
    priceField("Overhead (%)", p.overheadPct, (v) => setPrice((pr) => (pr.overheadPct = v)), 1),
    priceField("Wholesale price = cost x", p.wholesaleX, (v) => setPrice((pr) => (pr.wholesaleX = v)), 0.1),
    priceField("Retail price = wholesale x", p.retailX, (v) => setPrice((pr) => (pr.retailX = v)), 0.1),
    priceField(`Thread (${cur} per metre)`, p.threadPerM, (v) => setPrice((pr) => (pr.threadPerM = v))),
    priceField(`Lace (${cur} per metre)`, p.lacePerM, (v) => setPrice((pr) => (pr.lacePerM = v))),
    priceField(`Glue (${cur} per gram)`, p.gluePerG, (v) => setPrice((pr) => (pr.gluePerG = v)), 0.001),
    priceField(`Edge paint (${cur} per metre of edge)`, p.edgePaintPerM, (v) => setPrice((pr) => (pr.edgePaintPerM = v))),
    priceField(`Sandpaper, wax and other supplies (${cur} per item)`, p.consumables, (v) => setPrice((pr) => (pr.consumables = v))),
    priceField("Waste allowed without a layout (%)", p.wastePct, (v) => setPrice((pr) => (pr.wastePct = v)), 1),
    el(
      "label",
      { class: "hw-field" },
      el("span", {}, "Money sign"),
      el("input", {
        type: "text",
        class: "hw-num",
        value: cur,
        maxLength: 4,
        onchange: (e: Event) => setPrice((pr) => (pr.currency = (e.target as HTMLInputElement).value || "$")),
      }),
    ),
  );
  if (rep) {
    for (const l of rep.lines.filter((l) => l.group === "Hardware")) {
      form.append(
        priceField(`${l.label} (${cur} each)`, l.unitPrice, (v) =>
          setPrice((pr) => {
            pr.hardware = pr.hardware.filter((h) => h.kind !== l.key);
            pr.hardware.push({ kind: l.key, price: v });
          }),
        ),
      );
    }
  }
  out.push(el("h3", {}, "Your prices"), form);
  const labour = el("details", { class: "hw-more" }, el("summary", {}, "How long things take (change these to match your speed)"));
  const lab = el("div", { class: "hw-form" });
  for (const [key, label] of LABOUR_LABELS) {
    const val = p.labour[key];
    lab.append(
      priceField(label, typeof val === "number" ? val : labourDefault(key), (v) => setPrice((pr) => (pr.labour = { ...pr.labour, [key]: v })), 0.01),
    );
  }
  labour.append(lab);
  out.push(labour);
  if (rep) {
    out.push(
      el("h3", {}, "Where the money goes"),
      el(
        "table",
        { class: "hw-table" },
        el("tbody", {}, ...rep.lines.map((l) => el("tr", {}, el("td", {}, l.group), el("td", {}, l.text), el("td", { class: "num" }, money(l.cost, cur))))),
        el("tfoot", {}, el("tr", {}, el("td", {}, "Total"), el("td", {}, "Cost to make one"), el("td", { class: "num" }, money(rep.totalCost, cur)))),
      ),
      el("h3", {}, "Where the time goes"),
      el(
        "table",
        { class: "hw-table" },
        el("tbody", {}, ...rep.labourSteps.map((s) => el("tr", {}, el("td", {}, s.step), el("td", {}, s.how), el("td", { class: "num" }, `${s.minutes.toFixed(0)} min`)))),
      ),
    );
  }
  return out;
}

/** The core's labour defaults (costing.rs LabourRates), shown until the maker changes them. */
function labourDefault(key: string): number {
  const d: Record<string, number> = {
    cutPerPieceMin: 2,
    cutPerMMin: 1.5,
    prickPerHoleMin: 0.01,
    handStitchPerHoleMin: 0.12,
    machineStitchPerHoleMin: 0.01,
    lacePerSlitMin: 0.25,
    edgeBurnishedPerMMin: 10,
    edgePaintedPerMMin: 15,
    edgeTurnedPerMMin: 8,
    skivePerMMin: 5,
    gluePerSeamMin: 2,
    punchPerHoleMin: 0.3,
    hardwareFactor: 1,
    assemblyPerPieceMin: 1,
    extraMin: 0,
  };
  return d[key] ?? 0;
}
