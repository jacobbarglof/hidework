// "Change the size": a short form in plain words ("How wide is the finished wallet?") instead of
// corner coordinates. It works on any pattern:
//
// - The whole item: the main piece's finished width and height (the largest flat panel between
//   its folds). Every ordinary piece grows or shrinks by the same amount across and down, with its
//   folds, holes, hardware and marks, so seams between them keep matching. Stitch spacing, hole
//   sizes, rivets and corner radii in millimetres stay as they are.
// - Long strips (gussets, welts, straps on a bag) are not stretched across: a strip sewn to a
//   panel is lengthened in its middle to match the panel's new seam, so its ends (slots, holes,
//   folds) stay where they were.
// - A strap, belt or collar: "How long?" adds or removes length in the middle of the strap, so the
//   buckle end, the tip and the holes stay put.
// - Just one piece: its flat width and height.

import { cachedTemplates } from "./actions";
import { h } from "./dom";
import { ensureVisible } from "./layout";
import { panel } from "./panels";
import { edit, notify, piece, selectedPieceId, setStatus, state, whenComputed } from "./store";
import type { EdgeRef, Piece, Project, V } from "./types";
import { parseLength, toDisp } from "./units";
import { offerUndo } from "./commandline";
import { markStep } from "./guide";

// ---------- measuring ----------

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function box(pc: Piece): Box {
  const xs = pc.vertices.map((v) => v.x);
  const ys = pc.vertices.map((v) => v.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const wOf = (b: Box) => b.maxX - b.minX;
const hOf = (b: Box) => b.maxY - b.minY;

/** A long narrow piece: a gusset, welt, strap or belt (its long side at least 3.5 times its short). */
function isStrip(pc: Piece): boolean {
  const b = box(pc);
  const long = Math.max(wOf(b), hOf(b));
  const short = Math.max(0.1, Math.min(wOf(b), hOf(b)));
  return long / short >= 3.5;
}

function area(pc: Piece): number {
  const b = box(pc);
  return wOf(b) * hOf(b) * Math.max(1, pc.cutCount);
}

/** The piece the finished size is read from: the largest panel, or the largest strip if all are. */
function mainPiece(p: Project): Piece | undefined {
  const panels = p.pieces.filter((pc) => pc.vertices.length >= 3 && !isStrip(pc));
  const pool = panels.length ? panels : p.pieces.filter((pc) => pc.vertices.length >= 3);
  return [...pool].sort((a, b) => area(b) - area(a))[0];
}

/** Largest flat stretch between folds along one axis (what you see once it is folded). */
function finished(pc: Piece, axis: "x" | "y"): number {
  const b = box(pc);
  const lo = axis === "x" ? b.minX : b.minY;
  const hi = axis === "x" ? b.maxX : b.maxY;
  const cuts = pc.folds
    .filter((f) => (axis === "y" ? f.orientation === "horizontal" : f.orientation === "vertical"))
    .map((f) => f.position)
    .filter((x) => x > lo && x < hi)
    .sort((a, b2) => a - b2);
  const at = [lo, ...cuts, hi];
  let best = 0;
  for (let i = 1; i < at.length; i++) best = Math.max(best, at[i] - at[i - 1]);
  return best;
}

function edgeLength(pc: Piece, i: number): number {
  const n = pc.vertices.length;
  const a = pc.vertices[i];
  const b = pc.vertices[(i + 1) % n];
  const e = pc.edges[i];
  if (!e || e.type !== "cubic") return Math.hypot(b.x - a.x, b.y - a.y);
  let len = 0;
  let prev = a;
  for (let k = 1; k <= 24; k++) {
    const t = k / 24;
    const u = 1 - t;
    const p = {
      x: u * u * u * a.x + 3 * u * u * t * e.c1.x + 3 * u * t * t * e.c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * e.c1.y + 3 * u * t * t * e.c2.y + t * t * t * b.y,
    };
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

function refLength(p: Project, r: EdgeRef): number {
  const pc = p.pieces.find((x) => x.id === r.pieceId);
  return pc ? r.edges.reduce((s, i) => s + edgeLength(pc, i), 0) : 0;
}

// ---------- changing ----------

/** Move every point of a piece through separate x and y maps (vertices, curves, holes, folds…). */
function mapAxes(pc: Piece, fx: (x: number) => number, fy: (y: number) => number): void {
  const f = (p: V): V => ({ x: fx(p.x), y: fy(p.y) });
  pc.vertices = pc.vertices.map(f);
  pc.edges = pc.edges.map((e) => (e.type === "cubic" ? { ...e, c1: f(e.c1), c2: f(e.c2) } : e));
  pc.holes.forEach((x) => (x.center = f(x.center)));
  pc.hardware?.forEach((x) => (x.at = f(x.at)));
  pc.marks?.forEach((m) => (m.center = f(m.center)));
  pc.tooling?.forEach((s) => (s.points = s.points.map(f)));
  pc.folds.forEach((fd) => (fd.position = fd.orientation === "horizontal" ? fy(fd.position) : fx(fd.position)));
}

/** Grow a piece by factors across and down, about its top-left corner. */
function scalePiece(pc: Piece, sx: number, sy: number): void {
  const b = box(pc);
  mapAxes(pc, (x) => b.minX + (x - b.minX) * sx, (y) => b.minY + (y - b.minY) * sy);
}

/** Every coordinate of a piece along an axis that something sits on (to find a clear place to cut). */
function features(pc: Piece, axis: "x" | "y"): number[] {
  const out: number[] = [];
  const k = (p: V) => (axis === "x" ? p.x : p.y);
  pc.vertices.forEach((v) => out.push(k(v)));
  pc.holes.forEach((x) => out.push(k(x.center) - x.diameterMm, k(x.center) + x.diameterMm + (x.lengthMm ?? 0)));
  pc.hardware?.forEach((x) => out.push(k(x.at) - (x.sizeMm ?? 10), k(x.at) + (x.sizeMm ?? 10)));
  pc.marks?.forEach((m) => out.push(k(m.center) - (axis === "x" ? m.size.x : m.size.y) / 2, k(m.center) + (axis === "x" ? m.size.x : m.size.y) / 2));
  pc.tooling?.forEach((s) => s.points.forEach((p) => out.push(k(p))));
  pc.folds.filter((f) => (axis === "y" ? f.orientation === "horizontal" : f.orientation === "vertical")).forEach((f) => out.push(f.position));
  return out;
}

/**
 * Add `delta` mm of length to a piece along an axis by cutting it at the clearest place near its
 * middle and moving everything past the cut. Its ends (tips, slots, holes, folds) keep their size.
 * Falls back to stretching when the piece is shortened by more than the clear space allows.
 */
function insertLength(pc: Piece, axis: "x" | "y", delta: number): void {
  if (Math.abs(delta) < 0.01) return;
  const b = box(pc);
  const lo = axis === "x" ? b.minX : b.minY;
  const len = axis === "x" ? wOf(b) : hOf(b);
  const feats = features(pc, axis);
  let cut = lo + len / 2;
  let clear = -1;
  for (let i = 0; i <= 30; i++) {
    const c = lo + len * (0.3 + (0.4 * i) / 30);
    const d = Math.min(...feats.map((f) => Math.abs(f - c)));
    if (d > clear + 0.5) {
      clear = d;
      cut = c;
    }
  }
  const after = feats.filter((f) => f > cut);
  const room = after.length ? Math.min(...after) - cut : Infinity;
  if (delta < 0 && -delta >= room - 1) {
    const s = Math.max(0.1, (len + delta) / Math.max(1, len));
    scalePiece(pc, axis === "x" ? s : 1, axis === "y" ? s : 1);
    return;
  }
  const move = (v: number) => (v > cut ? v + delta : v);
  mapAxes(pc, axis === "x" ? move : (x) => x, axis === "y" ? move : (y) => y);
}

/** The long axis of a strip. */
function longAxis(pc: Piece): "x" | "y" {
  const b = box(pc);
  return wOf(b) >= hOf(b) ? "x" : "y";
}

/**
 * Lengthen or shorten strips sewn to pieces that changed, so the seam lengths keep the proportion
 * they had before. `before` holds each join's two lengths from before the change.
 */
function refitStrips(p: Project, changed: Set<string>, before: Map<string, [number, number]>): void {
  const done = new Set<string>();
  for (const j of p.joins) {
    const was = before.get(j.id);
    if (!was || !j.a.edges.length || !j.b.edges.length) continue;
    for (const [strip, other, ws, wo] of [[j.a, j.b, was[0], was[1]], [j.b, j.a, was[1], was[0]]] as [EdgeRef, EdgeRef, number, number][]) {
      const spc = p.pieces.find((x) => x.id === strip.pieceId);
      if (!spc || done.has(spc.id) || changed.has(spc.id) || !changed.has(other.pieceId) || !isStrip(spc) || wo <= 0) continue;
      const target = (ws / wo) * refLength(p, other);
      insertLength(spc, longAxis(spc), target - refLength(p, strip));
      done.add(spc.id);
    }
  }
}

function joinLengths(p: Project): Map<string, [number, number]> {
  return new Map(p.joins.map((j) => [j.id, [refLength(p, j.a), refLength(p, j.b)] as [number, number]]));
}

async function afterChange(what: string): Promise<void> {
  const ok = new Set((state.computed?.joins ?? []).filter((r) => r.ok).map((r) => r.id));
  markStep("size");
  await whenComputed();
  const broken = (state.computed?.joins ?? []).filter((r) => !r.ok && ok.has(r.id)).length;
  offerUndo(
    broken
      ? `${what} ${broken} seam${broken === 1 ? " no longer matches" : "s no longer match"}: click Check my pattern to see ${broken === 1 ? "it" : "them"}, or Undo.`
      : `${what} The seams still match.`,
  );
}

/** Resize the whole item so its main piece has this finished width or height (mm). */
export function resizeWhole(axis: "x" | "y", toMm: number): void {
  const p = state.project;
  const main = mainPiece(p);
  if (!main) return;
  const strap = isStrip(main);
  const now = strap ? (axis === longAxis(main) ? Math.max(wOf(box(main)), hOf(box(main))) : Math.min(wOf(box(main)), hOf(box(main)))) : finished(main, axis);
  if (!(toMm > 0) || !(now > 0) || Math.abs(toMm - now) < 0.05) return;
  const noun = nounFor(p);
  edit((proj) => {
    const m = proj.pieces.find((x) => x.id === main.id)!;
    if (strap) {
      if (axis === longAxis(m)) insertLength(m, axis, toMm - now);
      else {
        // Wider or narrower: every strip in the same direction keeps its centre line.
        const k = toMm / now;
        for (const pc of proj.pieces.filter(isStrip)) {
          const ax = longAxis(pc) === "x" ? "y" : "x";
          const b = box(pc);
          const mid = ax === "y" ? (b.minY + b.maxY) / 2 : (b.minX + b.maxX) / 2;
          const f = (v: number) => mid + (v - mid) * k;
          mapAxes(pc, ax === "x" ? f : (x) => x, ax === "y" ? f : (y) => y);
        }
      }
      return;
    }
    const before = joinLengths(proj);
    const k = toMm / now;
    const sx = axis === "x" ? k : 1;
    const sy = axis === "y" ? k : 1;
    const changed = new Set<string>();
    const ox = Math.min(...proj.pieces.map((pc) => pc.position.x));
    const oy = Math.min(...proj.pieces.map((pc) => pc.position.y));
    for (const pc of proj.pieces) {
      // Keep the pieces apart on the sheet: their places spread out as they grow.
      pc.position = { x: ox + (pc.position.x - ox) * sx, y: oy + (pc.position.y - oy) * sy };
      if (isStrip(pc)) continue;
      scalePiece(pc, sx, sy);
      changed.add(pc.id);
    }
    refitStrips(proj, changed, before);
    if (proj.form) {
      proj.form.widthMm *= sx;
      proj.form.heightMm *= sy;
    }
  });
  const u = state.project.units;
  const word = strap ? (axis === longAxis(main) ? "long" : "wide") : axis === "x" ? "wide" : "tall";
  void afterChange(`The ${noun} is now ${fmt(toMm, u)} ${word}.`);
}

/** Resize one piece to this flat width or height (mm); strips sewn to it follow. */
export function resizePiece(id: string, axis: "x" | "y", toMm: number): void {
  const pc0 = piece(id);
  if (!pc0) return;
  const b = box(pc0);
  const now = axis === "x" ? wOf(b) : hOf(b);
  if (!(toMm > 0) || !(now > 0) || Math.abs(toMm - now) < 0.05) return;
  edit((proj) => {
    const before = joinLengths(proj);
    const pc = proj.pieces.find((x) => x.id === id)!;
    if (isStrip(pc) && axis === longAxis(pc)) insertLength(pc, axis, toMm - now);
    else scalePiece(pc, axis === "x" ? toMm / now : 1, axis === "y" ? toMm / now : 1);
    refitStrips(proj, new Set([id]), before);
  });
  void afterChange(`${pc0.name} is now ${fmt(toMm, state.project.units)} ${axis === "x" ? "wide" : "tall"}.`);
}

// ---------- words ----------

const fmt = (mm: number, u: "mm" | "in") => (u === "in" ? `${(mm / 25.4).toFixed(2)} in` : `${Math.round(mm * 10) / 10} mm`);

/** What the thing being made is called: "wallet", "bag", "belt"… */
export function nounFor(p: Project): string {
  const t = cachedTemplates().find((x) => x.name === p.name);
  const name = (t?.name ?? p.name).toLowerCase();
  const byWord: [RegExp, string][] = [
    [/card (holder|sleeve)/, "card holder"],
    [/wallet/, "wallet"],
    [/cover|folio/, "cover"],
    [/belt/, "belt"],
    [/collar/, "collar"],
    [/strap|band|cuff/, "strap"],
    [/sheath/, "sheath"],
    [/sleeve/, "sleeve"],
    [/case|roll/, "case"],
    [/pouch/, "pouch"],
    [/tote|bag|messenger|bucket/, "bag"],
    [/coaster|mat|pad|tray/, name.replace(/ set$/, "")],
  ];
  for (const [re, n] of byWord) if (re.test(name)) return n;
  const cat = t?.category ?? "";
  return cat === "Bags" ? "bag" : cat === "Straps" ? "strap" : cat === "Wallets" ? "wallet" : "piece";
}

// ---------- the form ----------

export function openSizes(): void {
  panel.special = "size";
  ensureVisible("2d");
  setStatus("Change the size: type the size you want and press Enter, or use the − and + buttons.");
  notify();
}

/** A measurement row: a big − button, the number, the unit, a big + button. */
function sizeRow(key: string, question: string, mm: number, apply: (mm: number) => void, help?: string): HTMLElement {
  const u = state.project.units;
  const step = u === "in" ? 6.35 : 5;
  const shown = u === "in" ? Math.round(toDisp(mm, u) * 100) / 100 : Math.round(mm * 10) / 10;
  // Text, not a number box, so inches can be typed as fractions (4 1/2, 3/8) as well as decimals.
  const input = h("input", { type: "text", inputMode: "decimal", autocomplete: "off", class: "size-input", value: String(shown), "data-key": key, "aria-label": question }) as HTMLInputElement;
  const commit = () => {
    const v = parseLength(input.value, u);
    if (v !== null && v > 0) apply(v);
    else setStatus(u === "in" ? "Type a number, for example 4.5 or 4 1/2, then press Enter." : "Type a number, for example 95, then press Enter.");
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    e.stopPropagation();
  });
  const bump = (d: number) => h("button", { type: "button", class: "btn size-bump", "aria-label": `${d < 0 ? "Smaller" : "Bigger"} by ${u === "in" ? "a quarter inch" : "5 mm"}`, onclick: () => apply(Math.max(step, mm + d)) }, d < 0 ? "−" : "+");
  return h(
    "div",
    { class: "size-q" },
    h("label", { class: "size-label", for: undefined }, question),
    h("div", { class: "size-row" }, bump(-step), input, h("span", { class: "size-unit" }, u === "in" ? "inches" : "mm"), bump(step)),
    help ? h("p", { class: "hint" }, help) : null,
  );
}

export function sizeInspector(): Node[] {
  const p = state.project;
  const back = h("a", { class: "back", href: "#", onclick: (e: Event) => { e.preventDefault(); panel.special = null; notify(); } }, "‹ Back");
  const main = mainPiece(p);
  if (!main) return [back, h("div", { class: "section-head" }, h("h2", {}, "Change the size")), h("p", { class: "hint" }, "There are no pieces yet. Choose a pattern first (New project).")];
  const noun = nounFor(p);
  const out: Node[] = [back, h("div", { class: "section-head" }, h("h2", {}, "Change the size"))];
  if (isStrip(main)) {
    const b = box(main);
    const ax = longAxis(main);
    const long = Math.max(wOf(b), hOf(b));
    const short = Math.min(wOf(b), hOf(b));
    out.push(
      sizeRow("sz-long", `How long is the ${noun}, from end to end?`, long, (v) => resizeWhole(ax, v), "Length is added or taken away in the middle, so the buckle end, the tip and the holes stay as they are."),
      sizeRow("sz-wide", `How wide is the ${noun}?`, short, (v) => resizeWhole(ax === "x" ? "y" : "x", v)),
    );
  } else {
    const folded = main.folds.length > 0;
    out.push(
      sizeRow("sz-w", `How wide is the finished ${noun}?`, finished(main, "x"), (v) => resizeWhole("x", v)),
      sizeRow("sz-h", `How tall is the finished ${noun}?`, finished(main, "y"), (v) => resizeWhole("y", v)),
      h(
        "p",
        { class: "hint" },
        `${folded ? "Measured once it is folded. " : ""}All the pieces grow or shrink together, so the seams keep matching. Stitch spacing, hole sizes and hardware stay the same size.`,
      ),
    );
  }
  const sid = selectedPieceId();
  const sel = sid ? piece(sid) : undefined;
  if (sel && p.pieces.length > 1 && sel.vertices.length >= 3) {
    const b = box(sel);
    out.push(
      h("div", { class: "section-head" }, h("h2", {}, `Just this piece: ${sel.name}`)),
      sizeRow("sz-pw", "Width of this piece, laid flat", wOf(b), (v) => resizePiece(sel.id, "x", v)),
      sizeRow("sz-ph", "Height of this piece, laid flat", hOf(b), (v) => resizePiece(sel.id, "y", v)),
      h("p", { class: "hint" }, "Only this piece changes, and any long strip sewn to it. Other seams may then need a look: Check my pattern will tell you."),
    );
  } else if (p.pieces.length > 1) {
    out.push(h("p", { class: "hint" }, "To change just one piece, click it in the pattern first."));
  }
  out.push(h("p", { class: "hint" }, "Changed your mind? Click Undo at the top."));
  return out;
}
