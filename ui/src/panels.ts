// Property editor (right dock, lower half): edits whatever is selected in the browser, the 2D
// window or the 3D window. Also the strap builder and the fabric-test bench controls.

import { api } from "./api";
import { viewCenter } from "./canvas";
import { button, check, choose, field, h, num, rerender, text } from "./dom";
import { defaultsFor, drape, loadPresets, maxFrame, replay, runDrape, scrub } from "./drape";
import { alignSelected, copySelection, cutSelection, deletePieces, distributeSelected, duplicateSelected, mergeSelected } from "./editing";
import { deleteVertex, duplicatePiece, mirrorPiece, rotatePiece, toggleCurve } from "./ops";
import { computedPiece, edit, isMulti, notify, piece, selectedPieceIds, setStatus, state, uid, version } from "./store";
import { colorFor } from "./textures";
import { fmtLen, fmtThickness, fromDisp, OZ_MM, round, toDisp } from "./units";
import { sim3d } from "./view3d";
import { arrangeSection, bagBuilder, bomCraftSection, edgeFinishSection, finishAll, hardwareInspector, hardwareList, joinCraftSection, loadCatalogue, markInspector, marksList, projectCraftSection, stitchSection, toolingInspector } from "./craftpanels";
import { offerUndo } from "./commandline";
import { simple } from "./prefs";
import { openSizes, sizeInspector } from "./sizes";
import { openTooling } from "./tooling";
import { openHideLayout } from "./hide";
import { plainWords } from "./words";
import { drape as drapeState } from "./drape";
import type { Bom, Material, MaterialKind, MaterialStats, Physics, Piece, Scene, Side, StrapParams } from "./types";

const KINDS: [MaterialKind, string][] = [
  ["leather", "Leather"],
  ["waxedCanvas", "Waxed canvas"],
  ["other", "Other"],
];
const PITCHES = [2.7, 3, 3.38, 3.85, 4, 5, 6];
const PUNCH_SIZES = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 8, 10];
const DEFAULT_PHYSICS: Physics = { densityKgM3: 900, bendingModulusMpa: 20, tensileModulusMpa: 80, anisotropy: 0.85, biasStiffness: 0.9, friction: 0.6, tensileStrengthMpa: 20 };

export const panel = { special: null as null | "strap" | "bag" | "size" };

const strapForm: StrapParams = {
  name: "Strap",
  lengthMm: 1000,
  widthMm: 38,
  tip: "round",
  holes: 5,
  holeSpacingMm: 25,
  firstHoleMm: 90,
  holeMm: 4,
  buckleEnd: true,
  buckleFoldMm: 70,
  tongueSlotMm: 20,
  rivetMm: 3,
  stitched: false,
};

/** Reports fetched from the core, refreshed when the project changes. */
export const reports = { version: -1, stats: [] as MaterialStats[], bom: null as Bom | null, waste: -1, loading: false };

export function refreshReports(): void {
  if (reports.loading || (reports.version === version && reports.waste === state.wastePct)) return;
  reports.loading = true;
  const v = version;
  Promise.all([api.materialStats(state.project), api.bom(state.project, state.wastePct)])
    .then(([stats, bom]) => Object.assign(reports, { stats, bom, version: v, waste: state.wastePct }))
    .catch(() => {})
    .finally(() => {
      reports.loading = false;
      notify();
    });
}

export function heading(title: string, extra?: Node): HTMLElement {
  return h("div", { class: "section-head" }, h("h2", {}, title), extra ?? null);
}

function len(key: string, mm: number, commit: (mm: number) => void, min?: number): HTMLInputElement {
  const u = state.project.units;
  return num(key, round(toDisp(mm, u), u), (v) => commit(fromDisp(v, u)), { step: u === "in" ? 0.03125 : 0.5, min });
}

const unitLabel = () => (state.project.units === "in" ? "in" : "mm");

export const select = (sel: typeof state.sel) => () => {
  state.sel = sel;
  panel.special = null;
  notify();
};

export function seamName(r: { pieceId: string; edges: number[] }): string {
  return `${piece(r.pieceId)?.name ?? "?"} edge ${r.edges.map((e) => e + 1).join("+")}`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function metric(label: string, value: string, big = false): HTMLElement {
  return h("div", { class: `metric${big ? " big" : ""}` }, h("span", {}, label), h("b", {}, value));
}

// ---------- property editor ----------

export function renderInspector(el: HTMLElement): void {
  refreshReports();
  rerender(el, () => {
    if (panel.special === "size") return sizeInspector();
    if (panel.special === "strap") return strapInspector();
    if (panel.special === "bag") {
      if (!drapeState.presets.length) void loadPresets().then(notify);
      return bagBuilder(() => { panel.special = null; notify(); }, drapeState.presets);
    }
    const s = state.sel;
    switch (s.kind) {
      case "none":
        return projectInspector();
      case "join":
        return joinInspector(s.id);
      case "material":
        return materialInspector(s.id);
      case "piece":
        return isMulti() ? multiInspector() : pieceInspector(s.piece);
      case "edge":
        return edgeInspector(s.piece, s.index);
      case "vertex":
        return vertexInspector(s.piece, s.index);
      case "hole":
        return holeInspector(s.piece, s.id);
      case "fold":
        return foldInspector(s.piece, s.id);
      case "hardware":
        return hardwareInspector(s.piece, s.id, back(s.piece));
      case "mark":
        return markInspector(s.piece, s.id, back(s.piece));
      case "tooling":
        return toolingInspector(s.piece, s.id, back(s.piece));
    }
    return [];
  });
  if (simple()) plainWords(el);
}

// ---------- Simple mode: fewer things at once ----------

/** "More options" sections the user has opened (kept open while they work). */
const opened = new Set<string>();

/**
 * In Simple mode, tuck advanced parts of a panel behind a "More options" button; with All tools
 * they show as usual.
 */
function more(key: string, nodes: (Node | null | undefined)[], label = "More options"): Node[] {
  const list = nodes.filter((n): n is Node => !!n);
  if (!simple() || !list.length) return list;
  const d = h("details", { class: "more", open: opened.has(key) }, h("summary", { "data-key": `more-${key}` }, label), h("div", { class: "more-body" }, ...list));
  d.addEventListener("toggle", () => (d.open ? opened.add(key) : opened.delete(key)));
  return [d];
}

function back(pieceId: string): HTMLElement {
  return h("a", { class: "back", href: "#", onclick: (e: Event) => { e.preventDefault(); select({ kind: "piece", piece: pieceId })(); } }, "‹ Back to the piece");
}

/** The simulation readout, shown with the project. */
export function simReadout(): Node[] {
  const st = sim3d.status;
  if (!st || !sim3d.info) return [h("p", { class: "hint" }, "Press Simulate (Space) to see how the piece holds up. Pin it, hang weights or drop objects in from the library.")];
  const m = st.metrics;
  const out: Node[] = [
    metric("Load carried", `${(m.loadG / 1000).toFixed(2)} kg`),
    metric("Leather weight", `${m.clothG.toFixed(0)} g`),
    metric("Peak stitch load", `${m.maxStitchN.toFixed(1)} N of ${m.stitchCapacityN.toFixed(0)} N`),
    metric("Peak pull at a pin", m.maxPinN > 0 ? `${m.maxPinN.toFixed(1)} N of ${m.pinCapacityN.toFixed(0)} N` : "no pins"),
    metric("Peak panel stress", `${m.maxStressMpa.toFixed(2)} MPa of ${m.panelStrengthMpa.toFixed(0)}`),
    metric("Largest movement", `${m.sagMm.toFixed(1)} mm`),
    metric("Estimated capacity", m.capacityKg !== null ? `${m.capacityKg.toFixed(1)} kg` : "—", true),
  ];
  out.push(h("p", { class: "hint" }, m.capacityKg !== null ? `Limited by ${m.limitedBy}, with a safety factor of 2. Strengths are estimates until calibrated.` : `Capacity: ${m.limitedBy}.`));
  out.push(h("p", { class: "stat-line" }, `${sim3d.info.seams} seam${sim3d.info.seams === 1 ? "" : "s"} sewn · ${sim3d.info.fasteners} rivet/snap fastening${sim3d.info.fasteners === 1 ? "" : "s"} · ${m.settled ? "settled" : `t = ${m.timeS.toFixed(1)} s`}`));
  for (const w of sim3d.info.warnings) out.push(h("p", { class: "warn" }, w));
  return out;
}

function projectInspector(): Node[] {
  const p = state.project;
  const thread = field("Thread colour", (() => {
    const i = h("input", { type: "color", value: p.threadColor ?? "#efe4c8", "data-key": "thread" });
    i.addEventListener("change", () => edit((x) => (x.threadColor = i.value)));
    return i;
  })());
  const units = field("Measure in", choose("proj-units", [["mm", "Millimetres"], ["in", "Inches"]], p.units, (v) => edit((x) => (x.units = v))));
  const waste = field("Cutting waste, %", num("waste", state.wastePct, (v) => { state.wastePct = Math.max(0, v); notify(); }, { step: 5, min: 0 }));
  if (simple()) return simpleProjectInspector(units, [thread, ...projectCraftSection(), heading("Simulation"), ...simReadout(), waste]);
  const out: Node[] = [
    heading("Project"),
    field("Name", text("proj-name", p.name, (v) => edit((x) => (x.name = v)))),
    h("div", { class: "grid2" }, units, thread),
    ...projectCraftSection(),
    heading("Simulation"),
    ...simReadout(),
    heading("Materials & cost"),
    waste,
  ];
  out.push(...bomTables());
  for (const w of state.computed?.warnings ?? []) out.push(h("p", { class: "warn" }, w));
  return out;
}

/** Simple mode with nothing selected: the name, what to do next, and how much leather to buy. */
function simpleProjectInspector(units: Node, rest: Node[]): Node[] {
  const p = state.project;
  const bom = reports.bom;
  const area = bom?.materials.reduce((s, m) => s + m.sqftWithWaste, 0) ?? 0;
  return [
    heading("Your project"),
    field("Name", text("proj-name", p.name, (v) => edit((x) => (x.name = v)))),
    h("p", { class: "hint plain" }, p.pieces.length ? "Click a piece in the pattern to change it, or use the big buttons at the top." : "There are no pieces yet. Click New project to choose what to make."),
    p.pieces.length ? h("div", { class: "btn-row" }, button("Change the size", openSizes, "primary big")) : null,
    units,
    bom && area > 0 ? h("p", { class: "stat-line plain" }, `Leather to buy: about ${area.toFixed(1)} square feet${bom.totalCost !== null ? `, about $${bom.totalCost.toFixed(2)}` : ""}.`) : null,
    p.pieces.length ? h("div", { class: "btn-row" }, button("How many can I make from my hide?", openHideLayout, "big")) : null,
    ...(state.computed?.warnings ?? []).map((w) => h("p", { class: "warn" }, w)),
    ...more("project", [...rest, heading("Materials & cost"), ...bomTables()]),
  ].filter((n): n is HTMLElement => !!n);
}

function bomTables(): Node[] {
  const p = state.project;
  const out: Node[] = [];
  const bom = reports.bom;
  if (bom) {
    const t = h("table", { class: "report" }, h("tr", {}, h("th", {}, "Material"), h("th", {}, "Area"), h("th", {}, "Buy"), h("th", {}, "Cost")));
    for (const m of bom.materials) {
      t.append(h("tr", {}, h("td", {}, m.name), h("td", {}, `${m.sqft.toFixed(2)} ft²`), h("td", {}, `${m.sqftWithWaste.toFixed(2)} ft²`), h("td", {}, m.cost !== null ? `$${m.cost.toFixed(2)}` : "—")));
    }
    out.push(t, h("p", { class: "stat-line" }, `Seams ${fmtLen(bom.seamMm, p.units)} · ${bom.stitchHoles} holes · ~${bom.threadM.toFixed(1)} m of thread or lace`), ...bomCraftSection(bom));
    if (bom.totalCost !== null) out.push(metric("Leather cost with waste", `$${bom.totalCost.toFixed(2)}`, true));
    if (bom.hardware.length) {
      const hw = h("table", { class: "report" }, h("tr", {}, h("th", {}, "Hardware / punch"), h("th", {}, "Size"), h("th", {}, "Qty")));
      for (const x of bom.hardware) hw.append(h("tr", {}, h("td", {}, x.label), h("td", {}, x.kind ? `${x.diameterMm} mm` : x.slotMm > x.diameterMm ? `${x.diameterMm}×${x.slotMm} slot` : `${x.diameterMm} mm hole`), h("td", {}, String(x.count))));
      out.push(hw);
    }
  }
  return out;
}

function joinInspector(id: string): Node[] {
  const j = state.project.joins.find((x) => x.id === id);
  const rep = state.computed?.joins.find((r) => r.id === id);
  if (!j) return [];
  const u = state.project.units;
  const table = rep
      ? h(
          "table",
          { class: "report" },
          h("tr", {}, h("th", {}, ""), h("th", {}, seamName(j.a)), h("th", {}, seamName(j.b))),
          h("tr", {}, h("td", {}, "Edge"), h("td", {}, fmtLen(rep.aLengthMm, u)), h("td", {}, fmtLen(rep.bLengthMm, u))),
          h("tr", {}, h("td", {}, "Stitch line"), h("td", {}, fmtLen(rep.aStitchMm, u)), h("td", {}, fmtLen(rep.bStitchMm, u))),
          h("tr", {}, h("td", {}, "Holes"), h("td", {}, String(rep.aHoles)), h("td", {}, String(rep.bHoles))),
        )
      : null;
  return <Node[]>[
    heading("Seam"),
    h("p", { class: `verdict ${rep?.ok ? "ok" : "bad"}` }, rep?.message ?? "Measuring…"),
    ...more("join", [table, ...joinCraftSection(j), h("p", { class: "hint" }, "In 3D, this seam is sewn (or glued, or zipped) when you simulate.")]),
    h("div", { class: "btn-row" }, button("Remove seam", () => { edit((p) => (p.joins = p.joins.filter((x) => x.id !== id))); state.sel = { kind: "none" }; offerUndo("The seam is removed."); }, "danger")),
  ];
}

// ---------- fabric property editor (CLO's "Property Editor" for a fabric) ----------

function materialInspector(id: string): Node[] {
  const i = state.project.materials.findIndex((m) => m.id === id);
  const m = state.project.materials[i];
  if (!m) return [];
  const set = (fn: (x: Material) => void) => edit((p) => fn(p.materials[i]));
  const stats = reports.stats.find((s) => s.id === m.id);
  const ph: Physics = { ...DEFAULT_PHYSICS, ...(stats?.physics ?? m.physics ?? {}) };
  const setPh = (k: keyof Physics) => (v: number) => set((x) => (x.physics = { ...ph, [k]: v }));
  const used = state.project.pieces.filter((p) => p.materialId === m.id).length;
  const color = h("input", { type: "color", value: m.color ?? colorFor(m.kind, m.name), "data-key": `mat-color-${m.id}` });
  color.addEventListener("change", () => set((x) => (x.color = color.value)));
  const cal = num(`cal-${m.id}`, 0, () => {}, { step: 1, min: 0 });
  cal.placeholder = "overhang mm";
  return <Node[]>[
    heading("Fabric"),
    field("Name", text(`mat-name-${m.id}`, m.name, (v) => set((x) => (x.name = v)))),
    h(
      "div",
      { class: "grid2" },
      field("Type", choose(`mat-kind-${m.id}`, KINDS, m.kind, (v) => set((x) => (x.kind = v)))),
      field("Colour", color),
      field("Thickness, mm", num(`mat-mm-${m.id}`, round2(m.thicknessMm), (v) => set((x) => (x.thicknessMm = Math.max(0.05, v))), { step: 0.05, min: 0.05 })),
      field("Weight, oz", num(`mat-oz-${m.id}`, Math.round((m.thicknessMm / OZ_MM) * 10) / 10, (v) => set((x) => (x.thicknessMm = Math.max(0.05, v * OZ_MM))), { step: 0.5, min: 0.5 })),
      field("Price per ft²", num(`mat-cost-${m.id}`, m.costPerSqft ?? 0, (v) => set((x) => (x.costPerSqft = v > 0 ? v : null)), { step: 0.25, min: 0 })),
    ),
    stats ? h("p", { class: "stat-line" }, `Bending length ${stats.bendingLengthMm.toFixed(0)} mm · ${stats.gramsPerM2.toFixed(0)} g/m² (${stats.ozPerYd2.toFixed(1)} oz/yd²) · used by ${used} piece${used === 1 ? "" : "s"}`) : null,
    heading("Physical properties"),
    h(
      "div",
      { class: "physics" },
      h(
        "div",
        { class: "grid2" },
        field("Density, kg/m³", num(`ph-d-${m.id}`, ph.densityKgM3, setPh("densityKgM3"), { step: 10, min: 50 })),
        field("Bending, MPa", num(`ph-b-${m.id}`, round2(ph.bendingModulusMpa), setPh("bendingModulusMpa"), { step: 0.5, min: 0.05 })),
        field("Stretch, MPa", num(`ph-t-${m.id}`, ph.tensileModulusMpa, setPh("tensileModulusMpa"), { step: 5, min: 1 })),
        field("Strength, MPa", num(`ph-u-${m.id}`, ph.tensileStrengthMpa ?? 20, setPh("tensileStrengthMpa"), { step: 1, min: 1 })),
        field("Bend across ÷ along", num(`ph-a-${m.id}`, ph.anisotropy, setPh("anisotropy"), { step: 0.05, min: 0.05 })),
        field("Bias stiffness", num(`ph-s-${m.id}`, ph.biasStiffness, setPh("biasStiffness"), { step: 0.05, min: 0.05, max: 1 })),
        field("Friction", num(`ph-f-${m.id}`, ph.friction, setPh("friction"), { step: 0.05, min: 0, max: 1 })),
      ),
      h("p", { class: "hint" }, "Library values are starting estimates. Calibrate bending with a strip test: slide a 25 mm strip off a table until its tip touches a 41.5° line, then enter the overhang."),
      h(
        "div",
        { class: "btn-row" },
        cal,
        button("Calibrate", async () => {
          const overhang = parseFloat(cal.value);
          if (!(overhang > 0)) return setStatus("Enter the strip's overhang in millimetres first.");
          const e = await api.calibrate(m.thicknessMm, ph.densityKgM3, overhang);
          set((x) => (x.physics = { ...ph, bendingModulusMpa: e }));
          setStatus(`${m.name}: bending modulus ${e.toFixed(2)} MPa from a ${overhang} mm overhang.`);
        }),
      ),
    ),
    h(
      "div",
      { class: "btn-row spaced" },
      button("Fabric test…", () => openFabricTest(m.id), "primary"),
      used ? null : button("Delete fabric", () => { edit((p) => p.materials.splice(i, 1)); state.sel = { kind: "none" }; notify(); }, "danger"),
    ),
  ];
}

// ---------- pattern pieces ----------

function pieceInspector(id: string): Node[] {
  const pc = piece(id);
  const cp = computedPiece(id);
  if (!pc) return [];
  const u = state.project.units;
  const set = (fn: (x: Piece) => void) => edit(() => fn(pc));
  const matOptions = state.project.materials.map((m) => [m.id, `${m.name}, ${fmtThickness(m.thicknessMm)}`] as [string, string]);
  const easy = simple();
  const cut = field(easy ? "How many to cut" : "Cut ×", num("pc-cut", pc.cutCount, (v) => set((x) => (x.cutCount = Math.max(1, Math.round(v)))), { step: 1, min: 1 }));
  const where = [
    field("Grain °", num("pc-grain", pc.grainDeg, (v) => set((x) => (x.grainDeg = v)), { step: 15 })),
    field(`Allowance`, len("pc-sa", pc.seamAllowanceMm, (v) => set((x) => (x.seamAllowanceMm = Math.max(0, v))), 0)),
    field(easy ? `Across the sheet, ${unitLabel()}` : `X, ${unitLabel()}`, len("pc-x", pc.position.x, (v) => set((x) => (x.position.x = v)))),
    field(easy ? `Down the sheet, ${unitLabel()}` : `Y, ${unitLabel()}`, len("pc-y", pc.position.y, (v) => set((x) => (x.position.y = v)))),
  ];
  const lining = button("Lining", async () => {
    const lid = uid("p");
    const lining = await api.lining(state.project, id, 2, lid);
    edit((p) => p.pieces.push(lining));
    state.sel = { kind: "piece", piece: lid };
    offerUndo("A lining is made, 2 mm inside the outline.");
  }, "quiet");
  const copy = button(easy ? "Make a copy" : "Duplicate", () => {
    const c = duplicatePiece(pc);
    edit((p) => p.pieces.push(c));
    state.sel = { kind: "piece", piece: c.id };
    offerUndo(`A copy of ${pc.name} is made, next to it.`);
  }, "quiet");
  const shape = [
    button("Mirror", () => set((x) => mirrorPiece(x, "x")), "quiet"),
    button("Flip", () => set((x) => mirrorPiece(x, "y")), "quiet"),
    button(easy ? "Turn" : "Rotate", () => set((x) => rotatePiece(x, true)), "quiet"),
    copy,
  ];
  const notes = field("Notes printed on the template", (() => {
    const t = h("textarea", { rows: 2, "data-key": "pc-notes", onchange: (e: Event) => set((x) => (x.notes = (e.target as HTMLTextAreaElement).value)) });
    t.value = pc.notes ?? "";
    return t;
  })());
  const name = field("Name", text("pc-name", pc.name, (v) => set((x) => (x.name = v))));
  const fabric = field("Fabric", choose("pc-mat", matOptions, pc.materialId, (v) => set((x) => (x.materialId = v))));
  const out: Node[] = easy
    ? [
        h("div", { class: "grid2" }, cut),
        h("div", { class: "grid2" }, ...where),
        notes,
        h("div", { class: "btn-row" }, lining),
      ]
    : [heading("Pattern piece"), name, fabric, h("div", { class: "grid3" }, cut, ...where), notes, h("div", { class: "btn-row" }, ...shape, lining)];
  out.push(
    heading("Stitching"),
    h(
      "div",
      { class: "grid3" },
      field(`From edge`, len("st-margin", pc.stitch.marginMm, (v) => set((x) => (x.stitch.marginMm = Math.max(0.5, v))), 0.5)),
      field("Iron, mm", (() => {
        const i = num("st-pitch", pc.stitch.pitchMm, (v) => set((x) => (x.stitch.pitchMm = Math.max(1, v))), { step: 0.01, min: 1 });
        i.setAttribute("list", "pitches");
        return i;
      })()),
      field((loadCatalogue()?.stitches.find((k) => k.kind === (pc.stitch.kind ?? "saddle"))?.lace ? "Slit, mm" : "Hole, mm"), num("st-hole", pc.stitch.holeMm, (v) => set((x) => (x.stitch.holeMm = Math.max(0.2, v))), { step: 0.1, min: 0.2 })),
    ),
    ...stitchSection(pc),
    h("datalist", { id: "pitches" }, ...PITCHES.map((p) => h("option", { value: String(p) }))),
  );
  const table = h("table", { class: "report edges" }, h("tr", {}, h("th", {}, "Edge"), h("th", {}, "Stitch"), h("th", {}, "Length"), h("th", {}, "Holes"), h("th", {}, "Skive")));
  pc.edges.forEach((e, i) => {
    const rep = cp?.edges[i];
    table.append(
      h(
        "tr",
        { class: "clickable" },
        h("td", { onclick: select({ kind: "edge", piece: id, index: i }) }, `${i + 1}${e.type === "cubic" ? " ⌒" : ""}`),
        h("td", {}, check(`edge-st-${i}`, e.stitched, (v) => set((x) => (x.edges[i].stitched = v)))),
        h("td", {}, rep ? fmtLen(rep.lengthMm, u) : ""),
        h("td", {}, rep && e.stitched ? String(rep.holeCount) : ""),
        h("td", {}, (e.skiveMm ?? 0) > 0 ? fmtLen(e.skiveMm ?? 0, u) : ""),
      ),
    );
  });
  out.push(
    table,
    h(
      "div",
      { class: "btn-row" },
      button("Stitch all", () => set((x) => x.edges.forEach((e) => (e.stitched = true))), "quiet"),
      button("Stitch none", () => set((x) => x.edges.forEach((e) => (e.stitched = false))), "quiet"),
      button("Burnish all", () => finishAll(pc, "burnished"), "quiet"),
      button("Paint all", () => finishAll(pc, "painted"), "quiet"),
    ),
    ...arrangeSection(pc),
    heading("Folds"),
  );
  if (!pc.folds.length) out.push(h("p", { class: "hint" }, "Fold tool (F): click where the piece bends. The pattern gains the length the outer layer needs."));
  for (const f of pc.folds) {
    const g = cp?.folds.find((x) => x.id === f.id);
    out.push(
      h(
        "div",
        { class: "seam", onclick: select({ kind: "fold", piece: id, id: f.id }) },
        h("strong", {}, `Folds ${f.orientation === "horizontal" ? "across" : "down"}, ${fmtLen(f.position, u)} from the ${f.orientation === "horizontal" ? "top" : "left"}`),
        h("span", {}, g ? `${fmtLen(g.shiftMm, u)} extra for the bend, round ${fmtLen(f.contentsMm, u)} of contents` : ""),
      ),
    );
  }
  out.push(heading("Holes & hardware"));
  if (!pc.holes.length) out.push(h("p", { class: "hint" }, "Punch tool (H), or pick hardware from the library."));
  for (const hole of pc.holes) {
    const slot = (hole.lengthMm ?? 0) > hole.diameterMm;
    out.push(
      h(
        "div",
        { class: "seam", onclick: select({ kind: "hole", piece: id, id: hole.id }) },
        h("strong", {}, hole.label || (slot ? "Slot" : "Hole")),
        h("span", {}, `${slot ? `${hole.diameterMm} × ${hole.lengthMm} mm slot` : `${hole.diameterMm.toFixed(1)} mm`} at ${fmtLen(hole.center.x, u)}, ${fmtLen(hole.center.y, u)}`),
      ),
    );
  }
  out.push(heading("Set hardware"));
  const hw = hardwareList(pc, (hid) => select({ kind: "hardware", piece: id, id: hid }));
  out.push(...(hw.length ? hw : [h("p", { class: "hint" }, "Hardware tool (K), or pick rivets, snaps, rings, buckles, locks and zips from the library.")]));
  out.push(heading("Surface work"));
  const mk = marksList(pc, (mid) => select({ kind: "mark", piece: id, id: mid }));
  out.push(...(mk.length ? mk : [h("p", { class: "hint" }, "Mark tool (E): stamps, tooling, embossing, engraving, paint, lettering and perforation.")]));
  const del = h("div", { class: "btn-row spaced" }, button("Delete piece", () => { deletePiece(id); offerUndo(`${pc.name} is deleted.`); }, "danger"));
  if (!easy) return [...out, del];
  // Simple mode: the few things most people change, the rest behind More options.
  return [
    heading("This piece"),
    h("div", { class: "btn-row big-row" }, button("Change the size", openSizes, "primary big"), button("Decorate (tooling)", openTooling, "big")),
    name,
    fabric,
    h("div", { class: "btn-row" }, ...shape),
    ...more("piece", out),
    del,
  ];
}

/** Delete a piece with its seams and laminates (one undo step). */
export function deletePiece(id: string): void {
  deletePieces([id]);
}

/** Several pieces selected: a summary and the actions that work on all of them. */
function multiInspector(): Node[] {
  const ids = selectedPieceIds();
  const pcs = ids.map((id) => piece(id)).filter((x): x is Piece => !!x);
  const set = new Set(ids);
  const seams = state.project.joins.filter((j) => set.has(j.a.pieceId) && set.has(j.b.pieceId)).length;
  const u = state.project.units;
  let area = 0;
  for (const pc of pcs) {
    const cp = computedPiece(pc.id);
    const pts = cp?.cut ?? [];
    let a = 0;
    for (let i = 0; i < pts.length; i++) a += pts[i].x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * pts[i].y;
    area += (Math.abs(a) / 2) * pc.cutCount;
  }
  const areaTxt = u === "in" ? `${(area / 645.16).toFixed(1)} in²` : `${(area / 100).toFixed(1)} cm²`;
  return [
    heading(`${pcs.length} pieces selected`),
    h("p", { class: "stat-line" }, `${seams ? `${seams} seam${seams === 1 ? "" : "s"} between them · ` : ""}${areaTxt} of leather to cut`),
    ...pcs.map((pc) => h("div", { class: "seam", onclick: select({ kind: "piece", piece: pc.id }) }, h("strong", {}, pc.name), h("span", {}, `cut ${pc.cutCount}`))),
    h(
      "div",
      { class: "btn-row" },
      button("Merge", mergeSelected, "primary"),
      button("Duplicate", duplicateSelected, "quiet"),
      button("Copy", copySelection, "quiet"),
      button("Cut", cutSelection, "quiet"),
    ),
    h("p", { class: "hint" }, seams ? "Merge joins pieces along the seams between them into one piece." : "Merge needs a seam between the pieces (Sew, S) or outlines that overlap or touch."),
    heading("Arrange"),
    h(
      "div",
      { class: "btn-row" },
      button("Left", () => alignSelected("left"), "quiet"),
      button("Centre", () => alignSelected("centre"), "quiet"),
      button("Right", () => alignSelected("right"), "quiet"),
      button("Top", () => alignSelected("top"), "quiet"),
      button("Middle", () => alignSelected("middle"), "quiet"),
      button("Bottom", () => alignSelected("bottom"), "quiet"),
    ),
    pcs.length > 2
      ? h("div", { class: "btn-row" }, button("Space across", () => distributeSelected("x"), "quiet"), button("Space down", () => distributeSelected("y"), "quiet"))
      : null,
    h("p", { class: "hint" }, "Shift or Ctrl+click adds or removes a piece; drag a box on empty paper to select several. Drag any selected piece to move them all."),
    h("div", { class: "btn-row spaced" }, button(`Delete ${pcs.length} pieces`, () => deletePieces(ids), "danger")),
  ].filter((n): n is HTMLElement => !!n);
}

/** Make a gusset as long as the stitch line (or edge) of `edges`, and join it. */
export async function makeGusset(pieceId: string, edges: number[], widthMm: number): Promise<string> {
  const pc = piece(pieceId);
  const cp = computedPiece(pieceId);
  if (!pc || !cp) throw new Error("No such piece.");
  const stitched = edges.every((e) => pc.edges[e]?.stitched);
  const length = edges.reduce((s, e) => s + (stitched ? cp.edges[e]?.stitchLengthMm ?? 0 : cp.edges[e]?.lengthMm ?? 0), 0);
  const total = stitched ? length + 2 * pc.stitch.marginMm : length;
  const gid = uid("p");
  const at = { x: pc.position.x, y: cp.bounds.max.y + pc.position.y + 25 };
  const g = await api.gusset(`${pc.name} gusset`, total, widthMm, pc.materialId, at, gid);
  g.stitch = { ...pc.stitch };
  edit((p) => {
    p.pieces.push(g);
    p.joins.push({ id: uid("j"), a: { pieceId, edges }, b: { pieceId: gid, edges: [0] } });
  });
  return gid;
}

function edgeInspector(id: string, i: number): Node[] {
  const pc = piece(id);
  const rep = computedPiece(id)?.edges[i];
  if (!pc || !pc.edges[i]) return [];
  const e = pc.edges[i];
  const u = state.project.units;
  const gussetWidth = num("gusset-w", 40, () => {}, { step: 1, min: 5 });
  return [
    back(id),
    heading(`Edge ${i + 1}`),
    h(
      "div",
      { class: "grid2" },
      field("Stitched", check("e-st", e.stitched, (v) => edit(() => (pc.edges[i].stitched = v)))),
      field(`Skive width, ${unitLabel()}`, len("e-skive", e.skiveMm ?? 0, (v) => edit(() => (pc.edges[i].skiveMm = Math.max(0, v))), 0)),
    ),
    h(
      "table",
      { class: "report" },
      h("tr", {}, h("td", {}, "Length"), h("td", {}, rep ? fmtLen(rep.lengthMm, u) : "")),
      e.stitched ? h("tr", {}, h("td", {}, "Stitch line"), h("td", {}, rep ? fmtLen(rep.stitchLengthMm, u) : "")) : null,
      e.stitched ? h("tr", {}, h("td", {}, "Holes"), h("td", {}, rep ? String(rep.holeCount) : "")) : null,
    ),
    h("div", { class: "btn-row" }, button(e.type === "line" ? "Make curved" : "Make straight", () => edit(() => toggleCurve(pc, i)), "quiet"), e.type === "line" ? button("Add dart", async () => {
      const [next, pair] = await api.addDart(pc, i, 0.5, 20, 40);
      edit((p) => {
        const k = p.pieces.findIndex((x) => x.id === id);
        p.pieces[k] = { ...next, id };
        // Three edges were inserted after this one.
        for (const j of p.joins) for (const side of [j.a, j.b]) if (side.pieceId === id) side.edges = side.edges.map((x) => (x > i ? x + 3 : x));
        p.joins.push({ id: uid("j"), a: { pieceId: id, edges: [pair[0]] }, b: { pieceId: id, edges: [pair[1]] } });
      });
      setStatus("Dart added and its two sides joined. Drag its points to shape it.");
    }, "quiet") : null),
    ...edgeFinishSection(pc, i),
    heading("Gusset from this edge"),
    h(
      "div",
      { class: "btn-row" },
      field("Width, mm", gussetWidth),
      button("Make gusset", async () => {
        const gid = await makeGusset(id, [i], parseFloat(gussetWidth.value) || 40);
        state.sel = { kind: "piece", piece: gid };
        notify();
      }),
    ),
  ];
}

function vertexInspector(id: string, i: number): Node[] {
  const pc = piece(id);
  if (!pc || !pc.vertices[i]) return [];
  const v = pc.vertices[i];
  return [
    back(id),
    heading(`Corner point ${i + 1}`),
    h(
      "div",
      { class: "grid2" },
      field(`X, ${unitLabel()}`, len("v-x", v.x, (x) => edit(() => (pc.vertices[i].x = x)))),
      field(`Y, ${unitLabel()}`, len("v-y", v.y, (y) => edit(() => (pc.vertices[i].y = y)))),
    ),
    h("p", { class: "hint" }, "Measured from the piece's top-left corner, before the fold allowance is added."),
    (() => {
      const r = num("v-round", 8, () => {}, { step: 1, min: 1 });
      return h("div", { class: "btn-row" }, field("Corner radius", r), button("Round corner", async () => {
        try {
          const next = await api.roundCorner(pc, i, parseFloat(r.value) || 8);
          edit((p) => {
            const k = p.pieces.findIndex((x) => x.id === id);
            p.pieces[k] = { ...next, id };
            // Edges after the corner moved up by one: keep seams pointing at the same edges.
            for (const j of p.joins) for (const side of [j.a, j.b]) if (side.pieceId === id) side.edges = side.edges.map((e) => (e >= i ? e + 1 : e));
          });
          state.sel = { kind: "piece", piece: id };
          notify();
        } catch (e) {
          setStatus(String(e));
        }
      }, "quiet"));
    })(),
    h("div", { class: "btn-row" }, button("Delete point", () => { let ok = false; edit((p) => (ok = deleteVertex(p, pc, i))); if (ok) { state.sel = { kind: "piece", piece: id }; offerUndo("The corner point is deleted."); } else notify(); }, "danger")),
  ];
}

function holeInspector(id: string, hid: string): Node[] {
  const pc = piece(id);
  const hole = pc?.holes.find((x) => x.id === hid);
  if (!pc || !hole) return [];
  const dia = num("h-d", hole.diameterMm, (v) => edit(() => (hole.diameterMm = Math.max(0.5, v))), { step: 0.5, min: 0.5 });
  dia.setAttribute("list", "punch-sizes");
  return [
    back(id),
    heading((hole.lengthMm ?? 0) > hole.diameterMm ? "Slot" : "Hole"),
    field("Label", text("h-label", hole.label, (v) => edit(() => (hole.label = v))), "Rivet, snap or screw holes that line up when folded are fastened together in 3D."),
    h(
      "div",
      { class: "grid3" },
      field("Size, mm", dia),
      field("Slot, mm", num("h-len", hole.lengthMm ?? 0, (v) => edit(() => (hole.lengthMm = Math.max(0, v))), { step: 1, min: 0 })),
      field("Angle °", num("h-ang", hole.angleDeg ?? 0, (v) => edit(() => (hole.angleDeg = v)), { step: 15 })),
      field(`X`, len("h-x", hole.center.x, (x) => edit(() => (hole.center.x = x)))),
      field(`Y`, len("h-y", hole.center.y, (y) => edit(() => (hole.center.y = y)))),
    ),
    h("datalist", { id: "punch-sizes" }, ...PUNCH_SIZES.map((s) => h("option", { value: String(s) }))),
    h("div", { class: "btn-row" }, button("Delete", () => { edit(() => (pc.holes = pc.holes.filter((x) => x.id !== hid))); state.sel = { kind: "piece", piece: id }; offerUndo("The hole is deleted."); }, "danger")),
  ];
}

function foldInspector(id: string, fid: string): Node[] {
  const pc = piece(id);
  const f = pc?.folds.find((x) => x.id === fid);
  const g = computedPiece(id)?.folds.find((x) => x.id === fid);
  if (!pc || !f) return [];
  const u = state.project.units;
  return [
    back(id),
    heading("Fold line"),
    field("Direction", choose("f-o", [["horizontal", "Across"], ["vertical", "Down"]], f.orientation, (v) => edit(() => (f.orientation = v)))),
    h(
      "div",
      { class: "grid2" },
      field(`Distance from the ${f.orientation === "horizontal" ? "top" : "left"}, ${unitLabel()}`, len("f-pos", f.position, (v) => edit(() => (f.position = v)))),
      field(`What goes inside, ${unitLabel()} thick`, len("f-contents", f.contentsMm, (v) => edit(() => (f.contentsMm = Math.max(0, v))), 0)),
    ),
    h("p", { class: "verdict ok" }, g ? `Fold allowance: ${fmtLen(g.shiftMm, u)}. When leather folds, the outside of the bend has to go further round than the inside, so the pattern needs that much extra length here. Hidework adds it for you from the leather's thickness and what goes inside.` : ""),
    h("div", { class: "btn-row" }, button("Delete fold", () => { edit(() => (pc.folds = pc.folds.filter((x) => x.id !== fid))); state.sel = { kind: "piece", piece: id }; offerUndo("The fold is deleted."); }, "danger")),
  ];
}

// ---------- strap builder ----------

export async function addStrap(params: StrapParams, materialId?: string, at?: { x: number; y: number }): Promise<string> {
  const id = uid("p");
  const pos = at ?? (() => {
    const c = viewCenter();
    return { x: Math.round(c.x - (params.lengthMm ?? 1000) / 2), y: Math.round(c.y) };
  })();
  const pc = await api.strap(params, materialId ?? state.project.materials[0]?.id ?? "", pos, id);
  edit((p) => p.pieces.push(pc));
  return id;
}

function strapInspector(): Node[] {
  const f = strapForm;
  const n = (key: keyof StrapParams, label: string, step = 1) => field(label, num(`strap-${key}`, Number(f[key] ?? 0), (v) => ((f as Record<string, unknown>)[key] = v), { step, min: 0 }));
  return [
    h("a", { class: "back", href: "#", onclick: (e: Event) => { e.preventDefault(); panel.special = null; notify(); } }, "‹ Back"),
    heading("Strap or belt"),
    field("Name", text("strap-name", f.name ?? "Strap", (v) => (f.name = v))),
    h(
      "div",
      { class: "grid2" },
      n("lengthMm", "Length, mm", 5),
      n("widthMm", "Width, mm"),
      field("Tip", choose("strap-tip", [["round", "Round"], ["point", "Point"], ["square", "Square"]], f.tip ?? "round", (v) => (f.tip = v))),
      n("holes", "Holes"),
      n("holeSpacingMm", "Hole spacing"),
      n("firstHoleMm", "Tip to 1st hole"),
      n("holeMm", "Hole size", 0.5),
      field("Buckle end", check("strap-buckle", f.buckleEnd ?? true, (v) => (f.buckleEnd = v))),
      n("buckleFoldMm", "Buckle wrap"),
      n("tongueSlotMm", "Tongue slot"),
      n("rivetMm", "Rivet hole", 0.5),
      field("Stitch edges", check("strap-stitch", f.stitched ?? false, (v) => (f.stitched = v))),
    ),
    h("div", { class: "btn-row" }, button("Make strap", async () => { const id = await addStrap({ ...f }); panel.special = null; state.sel = { kind: "piece", piece: id }; notify(); }, "primary")),
  ];
}

// ---------- fabric test bench (CLO's Fabric Kit, as a dialog) ----------

let fabricOpen = false;

export function openFabricTest(materialId?: string): void {
  fabricOpen = true;
  const pid = state.sel.kind === "piece" ? state.sel.piece : state.project.pieces[0]?.id;
  if (pid) defaultsFor(pid);
  if (materialId) {
    const m = state.project.materials.find((x) => x.id === materialId);
    const oz = m ? Math.round((m.thicknessMm / OZ_MM) * 2) / 2 : 3;
    drape.variants = [{ source: `m:${materialId}`, oz }, { source: `m:${materialId}`, oz: oz * 2 }, { source: "p:deer", oz: 3 }];
  }
  document.getElementById("fabric-test")?.classList.remove("hidden");
  void loadPresets().then(notify);
  notify();
}

export function closeFabricTest(): void {
  fabricOpen = false;
  document.getElementById("fabric-test")?.classList.add("hidden");
  notify();
}

export function fabricTestOpen(): boolean {
  return fabricOpen;
}

export function renderFabricTest(el: HTMLElement): void {
  if (!fabricOpen) return;
  rerender(el, drapeControls);
}

function drapeControls(): Node[] {
  const pcs = state.project.pieces.map((p) => [p.id, p.name] as [string, string]);
  const sc = drape.scene;
  const setScene = (s: Scene) => { drape.scene = s; notify(); };
  const sides: [Side, string][] = [["right", "Right edge"], ["left", "Left edge"], ["bottom", "Bottom edge"], ["top", "Top edge"]];
  const sources: [string, string][] = [
    ...state.project.materials.map((m) => [`m:${m.id}`, `Project: ${m.name}`] as [string, string]),
    ...drape.presets.map((p) => [`p:${p.id}`, p.name] as [string, string]),
  ];
  const out: Node[] = [
    h("p", { class: "hint" }, "Compare up to four fabrics or weights on the standard bench tests, side by side."),
    field("Specimen (piece)", choose("dr-piece", pcs, drape.pieceId ?? "", (v) => { drape.pieceId = v; notify(); })),
    field("Test", choose("dr-scene", [["cantilever", "Cantilever (table edge)"], ["pedestal", "Drape (Cusick pedestal)"], ["hang", "Hang from an edge"]], sc.type, (v) => {
      if (v === "cantilever") setScene({ type: "cantilever", side: "right", overhangMm: 100 });
      if (v === "pedestal") setScene({ type: "pedestal", radiusMm: 50 });
      if (v === "hang") setScene({ type: "hang", side: "top" });
    })),
  ];
  if (sc.type === "cantilever") {
    out.push(h("div", { class: "grid2" }, field("Overhanging edge", choose("dr-side", sides, sc.side, (v) => setScene({ ...sc, side: v }))), field("Overhang, mm", num("dr-over", sc.overhangMm, (v) => setScene({ ...sc, overhangMm: Math.max(5, v) }), { step: 5, min: 5 }))));
  } else if (sc.type === "pedestal") {
    out.push(field("Pedestal radius, mm", num("dr-rad", sc.radiusMm, (v) => setScene({ ...sc, radiusMm: Math.max(5, v) }), { step: 5, min: 5 })));
  } else {
    out.push(field("Pinned edge", choose("dr-side", sides, sc.side, (v) => setScene({ ...sc, side: v }))));
  }
  out.push(heading("Compare"));
  drape.variants.forEach((v, k) => {
    out.push(
      h(
        "div",
        { class: "variant" },
        choose(`dr-src-${k}`, sources, v.source, (s) => { v.source = s; notify(); }),
        h("div", { class: "variant-row" }, field("oz", num(`dr-oz-${k}`, v.oz, (x) => { v.oz = Math.max(0.5, x); notify(); }, { step: 0.5, min: 0.5 })), h("span", { class: "variant-mm" }, `${(v.oz * OZ_MM).toFixed(2)} mm`), button("✕", () => { drape.variants.splice(k, 1); notify(); }, "quiet icon")),
      ),
    );
  });
  out.push(
    h(
      "div",
      { class: "btn-row" },
      drape.variants.length < 4 ? button("Add fabric", () => { drape.variants.push({ source: drape.variants[0]?.source ?? "p:vegtan-firm", oz: 7 }); notify(); }, "quiet") : null,
      button(drape.running ? "Simulating…" : "Run test", async () => {
        try {
          await runDrape();
        } catch (e) {
          setStatus(String(e instanceof Error ? e.message : e));
        }
      }, "primary"),
    ),
  );
  const r = drape.result;
  if (r) {
    out.push(heading("Results"));
    const t = h("table", { class: "report" }, h("tr", {}, h("th", {}, "Fabric"), h("th", {}, "Bend len"), h("th", {}, sc.type === "pedestal" ? "Drape" : sc.type === "cantilever" ? "Droop" : "Drop"), h("th", {}, "Mass")));
    r.variants.forEach((v) => {
      const m = v.metrics;
      const main = m.droopDeg !== null ? `${m.droopDeg.toFixed(1)}°` : m.drapeCoefficient !== null ? m.drapeCoefficient.toFixed(2) : `${m.tipDropMm.toFixed(0)} mm`;
      t.append(h("tr", {}, h("td", {}, v.label), h("td", {}, `${m.bendingLengthMm.toFixed(0)} mm`), h("td", {}, main), h("td", {}, `${m.massG.toFixed(1)} g`)));
    });
    out.push(t);
    const slider = h("input", { type: "range", id: "drape-scrub", min: "0", max: String(maxFrame()), value: String(drape.frame), oninput: (e: Event) => scrub(parseInt((e.target as HTMLInputElement).value, 10)) });
    out.push(h("div", { class: "btn-row" }, slider, button("Replay", replay, "quiet")));
    out.push(h("p", { class: "hint" }, "A strip overhanging twice its bending length droops to 41.5° (ASTM D1388). Drape 1.0 stays flat; lower hangs more."));
  }
  return out;
}
