// The side panels: the piece and material ledger on the left, the inspector on the right.

import { button, check, choose, field, h, num, rerender, text } from "./dom";
import { deleteVertex, duplicatePiece, rectPiece, roundedRectPiece, toggleCurve } from "./ops";
import { computedPiece, edit, notify, piece, state, uid } from "./store";
import { fmtLen, fmtThickness, fromDisp, OZ_MM, round, toDisp } from "./units";
import { viewCenter } from "./canvas";
import type { Material, MaterialKind, Piece } from "./types";

const KINDS: [MaterialKind, string][] = [
  ["leather", "Leather"],
  ["waxedCanvas", "Waxed canvas"],
  ["other", "Other"],
];
const PITCHES = [2.7, 3, 3.38, 3.85, 4, 5, 6];

function heading(title: string, extra?: Node): HTMLElement {
  return h("div", { class: "section-head" }, h("h2", {}, title), extra ?? null);
}

function len(key: string, mm: number, commit: (mm: number) => void, min?: number): HTMLInputElement {
  const u = state.project.units;
  return num(key, round(toDisp(mm, u), u), (v) => commit(fromDisp(v, u)), { step: u === "in" ? 0.03125 : 0.5, min });
}

const unitLabel = () => (state.project.units === "in" ? "in" : "mm");

// ---------- left ledger ----------

export function renderLedger(el: HTMLElement): void {
  rerender(el, () => [piecesSection(), materialsSection()]);
}

function piecesSection(): HTMLElement {
  const add = (make: () => Piece) => () => {
    const pc = make();
    edit((p) => p.pieces.push(pc));
    state.sel = { kind: "piece", piece: pc.id };
    notify();
  };
  const at = () => {
    const c = viewCenter();
    return { x: Math.round(c.x - 40), y: Math.round(c.y - 25) };
  };
  const list = h("ul", { class: "ledger-list" });
  for (const pc of state.project.pieces) {
    const selected = state.sel.kind !== "none" && state.sel.kind !== "join" && state.sel.piece === pc.id;
    list.append(
      h(
        "li",
        { class: selected ? "selected" : "", onclick: () => { state.sel = { kind: "piece", piece: pc.id }; notify(); } },
        h("span", { class: "li-name" }, pc.name),
        h("span", { class: "li-meta" }, `×${pc.cutCount}`),
      ),
    );
  }
  if (!state.project.pieces.length) list.append(h("li", { class: "empty" }, "No pieces yet."));
  return h(
    "section",
    { class: "panel-section" },
    heading("Pieces"),
    list,
    h(
      "div",
      { class: "btn-row" },
      button("Rectangle", add(() => rectPiece(at(), 80, 50, "New panel"))),
      button("Rounded", add(() => roundedRectPiece(at(), 80, 50, 6, "New panel"))),
    ),
  );
}

function materialsSection(): HTMLElement {
  const rows = state.project.materials.map((m, i) => materialRow(m, i));
  return h(
    "section",
    { class: "panel-section" },
    heading("Materials"),
    ...rows,
    h(
      "div",
      { class: "btn-row" },
      button("Add material", () =>
        edit((p) => p.materials.push({ id: uid("m"), name: "New leather", kind: "leather", thicknessMm: 4 * OZ_MM })),
      ),
    ),
  );
}

function materialRow(m: Material, i: number): HTMLElement {
  const used = state.project.pieces.some((p) => p.materialId === m.id);
  const set = (fn: (x: Material) => void) => edit((p) => fn(p.materials[i]));
  return h(
    "div",
    { class: "material" },
    text(`mat-name-${m.id}`, m.name, (v) => set((x) => (x.name = v))),
    h(
      "div",
      { class: "material-grid" },
      field("Kind", choose(`mat-kind-${m.id}`, KINDS, m.kind, (v) => set((x) => (x.kind = v)))),
      field("Thickness, mm", num(`mat-mm-${m.id}`, Math.round(m.thicknessMm * 100) / 100, (v) => set((x) => (x.thicknessMm = Math.max(0.05, v))), { step: 0.05, min: 0.05 })),
      field("Ounces", num(`mat-oz-${m.id}`, Math.round((m.thicknessMm / OZ_MM) * 10) / 10, (v) => set((x) => (x.thicknessMm = Math.max(0.05, v * OZ_MM))), { step: 0.5, min: 0.5 })),
    ),
    used || state.project.materials.length === 1
      ? null
      : h("div", { class: "btn-row" }, button("Remove", () => edit((p) => p.materials.splice(i, 1)), "quiet")),
  );
}

// ---------- right inspector ----------

export function renderInspector(el: HTMLElement): void {
  rerender(el, () => {
    const s = state.sel;
    switch (s.kind) {
      case "none":
        return projectInspector();
      case "join":
        return joinInspector(s.id);
      case "piece":
        return pieceInspector(s.piece);
      case "edge":
        return edgeInspector(s.piece, s.index);
      case "vertex":
        return vertexInspector(s.piece, s.index);
      case "hole":
        return holeInspector(s.piece, s.id);
      case "fold":
        return foldInspector(s.piece, s.id);
    }
  });
}

function back(pieceId: string): HTMLElement {
  return h("a", { class: "back", href: "#", onclick: (e: Event) => { e.preventDefault(); state.sel = { kind: "piece", piece: pieceId }; notify(); } }, "‹ Back to piece");
}

function projectInspector(): Node[] {
  const p = state.project;
  const joins = state.computed?.joins ?? [];
  const out: Node[] = [
    heading("Project"),
    field("Name", text("proj-name", p.name, (v) => edit((x) => (x.name = v)))),
    field("Units", choose("proj-units", [["mm", "Millimetres"], ["in", "Inches"]], p.units, (v) => edit((x) => (x.units = v)))),
    heading("Seams"),
  ];
  if (!p.joins.length) out.push(h("p", { class: "hint" }, "Use Join (J) to pair two edges that sew together. Hidework checks they match."));
  for (const j of p.joins) {
    const rep = joins.find((r) => r.id === j.id);
    out.push(
      h(
        "div",
        { class: `seam ${rep?.ok ? "ok" : "bad"}`, onclick: () => { state.sel = { kind: "join", id: j.id }; notify(); } },
        h("strong", {}, `${seamName(j.a)} ↔ ${seamName(j.b)}`),
        h("span", {}, rep?.message ?? "…"),
      ),
    );
  }
  for (const w of state.computed?.warnings ?? []) out.push(h("p", { class: "warn" }, w));
  out.push(
    heading("How to"),
    h(
      "ul",
      { class: "help" },
      h("li", {}, "Click a piece to select it; drag to move it."),
      h("li", {}, "Click an edge of the selected piece to stitch it or curve it."),
      h("li", {}, "Double-click an edge to add a corner; Delete removes one."),
      h("li", {}, "Scroll to zoom; right-drag or Space-drag to pan; Alt turns off snapping."),
    ),
  );
  return out;
}

function seamName(r: { pieceId: string; edges: number[] }): string {
  return `${piece(r.pieceId)?.name ?? "?"} edge ${r.edges.map((e) => e + 1).join("+")}`;
}

function joinInspector(id: string): Node[] {
  const j = state.project.joins.find((x) => x.id === id);
  const rep = state.computed?.joins.find((r) => r.id === id);
  if (!j) return [];
  const u = state.project.units;
  return <Node[]>[
    heading("Seam"),
    h("p", { class: `verdict ${rep?.ok ? "ok" : "bad"}` }, rep?.message ?? "Measuring…"),
    rep
      ? h(
          "table",
          { class: "report" },
          h("tr", {}, h("th", {}, ""), h("th", {}, seamName(j.a)), h("th", {}, seamName(j.b))),
          h("tr", {}, h("td", {}, "Edge"), h("td", {}, fmtLen(rep.aLengthMm, u)), h("td", {}, fmtLen(rep.bLengthMm, u))),
          h("tr", {}, h("td", {}, "Stitch line"), h("td", {}, fmtLen(rep.aStitchMm, u)), h("td", {}, fmtLen(rep.bStitchMm, u))),
          h("tr", {}, h("td", {}, "Holes"), h("td", {}, String(rep.aHoles)), h("td", {}, String(rep.bHoles))),
        )
      : null,
    h("div", { class: "btn-row" }, button("Remove seam", () => { edit((p) => (p.joins = p.joins.filter((x) => x.id !== id))); state.sel = { kind: "none" }; notify(); }, "quiet")),
  ];
}

function pieceInspector(id: string): Node[] {
  const pc = piece(id);
  const cp = computedPiece(id);
  if (!pc) return [];
  const u = state.project.units;
  const set = (fn: (x: Piece) => void) => edit(() => fn(pc));
  const matOptions = state.project.materials.map((m) => [m.id, `${m.name}, ${fmtThickness(m.thicknessMm)}`] as [string, string]);
  const out: Node[] = [
    heading("Piece"),
    field("Name", text("pc-name", pc.name, (v) => set((x) => (x.name = v)))),
    field("Material", choose("pc-mat", matOptions, pc.materialId, (v) => set((x) => (x.materialId = v)))),
    h(
      "div",
      { class: "grid2" },
      field("Cut", num("pc-cut", pc.cutCount, (v) => set((x) => (x.cutCount = Math.max(1, Math.round(v)))), { step: 1, min: 1 })),
      field("Grain, degrees", num("pc-grain", pc.grainDeg, (v) => set((x) => (x.grainDeg = v)), { step: 15 })),
      field(`Seam allowance, ${unitLabel()}`, len("pc-sa", pc.seamAllowanceMm, (v) => set((x) => (x.seamAllowanceMm = Math.max(0, v))), 0)),
    ),
    heading("Stitching"),
    h(
      "div",
      { class: "grid2" },
      field(`From edge, ${unitLabel()}`, len("st-margin", pc.stitch.marginMm, (v) => set((x) => (x.stitch.marginMm = Math.max(0.5, v))), 0.5)),
      field("Iron spacing, mm", (() => {
        const i = num("st-pitch", pc.stitch.pitchMm, (v) => set((x) => (x.stitch.pitchMm = Math.max(1, v))), { step: 0.01, min: 1 });
        i.setAttribute("list", "pitches");
        return i;
      })()),
      field("Hole mark, mm", num("st-hole", pc.stitch.holeMm, (v) => set((x) => (x.stitch.holeMm = Math.max(0.2, v))), { step: 0.1, min: 0.2 })),
    ),
    h("datalist", { id: "pitches" }, ...PITCHES.map((p) => h("option", { value: String(p) }))),
    heading("Edges"),
  ];
  const table = h("table", { class: "report edges" }, h("tr", {}, h("th", {}, "#"), h("th", {}, "Stitch"), h("th", {}, "Length"), h("th", {}, "Holes")));
  pc.edges.forEach((e, i) => {
    const rep = cp?.edges[i];
    table.append(
      h(
        "tr",
        { class: "clickable" },
        h("td", { onclick: () => { state.sel = { kind: "edge", piece: id, index: i }; notify(); } }, `${i + 1}${e.type === "cubic" ? " ⌒" : ""}`),
        h("td", {}, check(`edge-st-${i}`, e.stitched, (v) => set((x) => (x.edges[i].stitched = v)))),
        h("td", {}, rep ? fmtLen(rep.lengthMm, u) : ""),
        h("td", {}, rep && e.stitched ? String(rep.holeCount) : ""),
      ),
    );
  });
  out.push(
    table,
    h(
      "div",
      { class: "btn-row" },
      button("Stitch all", () => set((x) => x.edges.forEach((e) => (e.stitched = true)))),
      button("Stitch none", () => set((x) => x.edges.forEach((e) => (e.stitched = false))), "quiet"),
    ),
    heading("Folds"),
  );
  if (!pc.folds.length) out.push(h("p", { class: "hint" }, "Use Fold (F) and click the piece where it bends. Hidework adds the length the outer layer needs."));
  for (const f of pc.folds) {
    const g = cp?.folds.find((x) => x.id === f.id);
    out.push(
      h(
        "div",
        { class: "seam", onclick: () => { state.sel = { kind: "fold", piece: id, id: f.id }; notify(); } },
        h("strong", {}, `${f.orientation === "horizontal" ? "Across" : "Down"} at ${fmtLen(f.position, u)}`),
        h("span", {}, g ? `Adds ${fmtLen(g.shiftMm, u)} around ${fmtLen(f.contentsMm, u)} of contents` : ""),
      ),
    );
  }
  out.push(heading("Punched holes"));
  if (!pc.holes.length) out.push(h("p", { class: "hint" }, "Use Punch (H) to place snaps, rivets or strap holes."));
  for (const hole of pc.holes) {
    out.push(
      h(
        "div",
        { class: "seam", onclick: () => { state.sel = { kind: "hole", piece: id, id: hole.id }; notify(); } },
        h("strong", {}, hole.label || "Hole"),
        h("span", {}, `${hole.diameterMm.toFixed(1)} mm at ${fmtLen(hole.center.x, u)}, ${fmtLen(hole.center.y, u)}`),
      ),
    );
  }
  out.push(
    h(
      "div",
      { class: "btn-row spaced" },
      button("Duplicate", () => {
        const copy = duplicatePiece(pc);
        edit((p) => p.pieces.push(copy));
        state.sel = { kind: "piece", piece: copy.id };
        notify();
      }),
      button("Delete piece", () => deletePiece(id), "danger"),
    ),
  );
  return out;
}

export function deletePiece(id: string): void {
  edit((p) => {
    p.pieces = p.pieces.filter((x) => x.id !== id);
    p.joins = p.joins.filter((j) => j.a.pieceId !== id && j.b.pieceId !== id);
  });
  state.sel = { kind: "none" };
  notify();
}

function edgeInspector(id: string, i: number): Node[] {
  const pc = piece(id);
  const rep = computedPiece(id)?.edges[i];
  if (!pc || !pc.edges[i]) return [];
  const e = pc.edges[i];
  const u = state.project.units;
  return [
    back(id),
    heading(`Edge ${i + 1}`),
    field("Stitched", check("e-st", e.stitched, (v) => edit(() => (pc.edges[i].stitched = v)))),
    h(
      "table",
      { class: "report" },
      h("tr", {}, h("td", {}, "Length"), h("td", {}, rep ? fmtLen(rep.lengthMm, u) : "")),
      e.stitched ? h("tr", {}, h("td", {}, "Stitch line"), h("td", {}, rep ? fmtLen(rep.stitchLengthMm, u) : "")) : null,
      e.stitched ? h("tr", {}, h("td", {}, "Holes"), h("td", {}, rep ? String(rep.holeCount) : "")) : null,
    ),
    h(
      "div",
      { class: "btn-row" },
      button(e.type === "line" ? "Make curved" : "Make straight", () => edit(() => toggleCurve(pc, i))),
    ),
    h("p", { class: "hint" }, e.type === "cubic" ? "Drag the two round handles to shape the curve." : "Double-click the edge to add a corner."),
  ];
}

function vertexInspector(id: string, i: number): Node[] {
  const pc = piece(id);
  if (!pc || !pc.vertices[i]) return [];
  const v = pc.vertices[i];
  return [
    back(id),
    heading(`Corner ${i + 1}`),
    h(
      "div",
      { class: "grid2" },
      field(`X, ${unitLabel()}`, len("v-x", v.x, (x) => edit(() => (pc.vertices[i].x = x)))),
      field(`Y, ${unitLabel()}`, len("v-y", v.y, (y) => edit(() => (pc.vertices[i].y = y)))),
    ),
    h("p", { class: "hint" }, "Positions are before fold allowance, measured from the piece's origin."),
    h(
      "div",
      { class: "btn-row" },
      button("Remove corner", () => {
        let ok = false;
        edit((p) => (ok = deleteVertex(p, pc, i)));
        if (ok) state.sel = { kind: "piece", piece: id };
        notify();
      }, "quiet"),
    ),
  ];
}

function holeInspector(id: string, hid: string): Node[] {
  const pc = piece(id);
  const hole = pc?.holes.find((x) => x.id === hid);
  if (!pc || !hole) return [];
  return [
    back(id),
    heading("Punched hole"),
    field("Label", text("h-label", hole.label, (v) => edit(() => (hole.label = v)))),
    field("Diameter, mm", num("h-d", hole.diameterMm, (v) => edit(() => (hole.diameterMm = Math.max(0.5, v))), { step: 0.5, min: 0.5 })),
    h(
      "div",
      { class: "grid2" },
      field(`X, ${unitLabel()}`, len("h-x", hole.center.x, (x) => edit(() => (hole.center.x = x)))),
      field(`Y, ${unitLabel()}`, len("h-y", hole.center.y, (y) => edit(() => (hole.center.y = y)))),
    ),
    h("div", { class: "btn-row" }, button("Remove hole", () => { edit(() => (pc.holes = pc.holes.filter((x) => x.id !== hid))); state.sel = { kind: "piece", piece: id }; notify(); }, "quiet")),
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
    heading("Fold"),
    field("Direction", choose("f-o", [["horizontal", "Across (horizontal)"], ["vertical", "Down (vertical)"]], f.orientation, (v) => edit(() => (f.orientation = v)))),
    field(`Position, ${unitLabel()}`, len("f-pos", f.position, (v) => edit(() => (f.position = v)))),
    field(`Contents when closed, ${unitLabel()}`, len("f-contents", f.contentsMm, (v) => edit(() => (f.contentsMm = Math.max(0, v))), 0), "Inner layers, cards or a notebook between the two halves."),
    h(
      "p",
      { class: "verdict ok" },
      g ? `Adds ${fmtLen(g.shiftMm, u)}: π × (contents + leather) ÷ 2, the outer layer's arc around the bend.` : "",
    ),
    h("div", { class: "btn-row" }, button("Remove fold", () => { edit(() => (pc.folds = pc.folds.filter((x) => x.id !== fid))); state.sel = { kind: "piece", piece: id }; notify(); }, "quiet")),
  ];
}
