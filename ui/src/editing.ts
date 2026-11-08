// Pattern editing commands shared by the ribbon, the command line and the keyboard:
// clipboard, multi-selection, merging and grid snap. (Contract: the ribbon and command line call
// these; the 2D canvas implements selection and snapping behind them.)

import { viewCenter, viewRect } from "./canvas";
import { deleteVertex, flattenPiece, pointInPolygon, selfIntersects, signedArea } from "./ops";
import { reshapeByBoolean } from "./sketch";
import { computedPiece, edit, isMulti, notify, piece, selectPieces, selectedPieceId, selectedPieceIds, setStatus, state, uid } from "./store";
import type { Edge, HardwarePlacement, Hole, Join, Laminate, Mark, Material, Piece, Project, Units, V } from "./types";

/** isMulti(): more than one piece is selected. selectPieces(ids): select exactly these pieces (first = primary). */
export { isMulti, selectPieces } from "./store";

// ---------- grid snap ----------

/** Grid snap for the 2D pattern window (moving pieces, points, holes and hardware). */
export const snap = { on: false, gridMm: 5 };

/** The grid spacing in words, in the project's units: "5 mm", "1/8 in". */
export function gridWords(): string {
  if (state.project?.units !== "in") return `${+snap.gridMm.toFixed(2)} mm`;
  const inch = snap.gridMm / 25.4;
  for (const d of [1, 2, 4, 8, 16, 32]) {
    const n = Math.round(inch * d);
    if (n <= 0 || Math.abs(inch * d - n) > 1e-6) continue;
    const whole = Math.floor(n / d);
    const rest = n % d;
    return `${whole && rest ? `${whole} ${rest}/${d}` : rest ? `${rest}/${d}` : whole} in`;
  }
  return `${+inch.toFixed(3)} in`;
}

/** Turn grid snap on or off (no argument flips it). Holding Shift while dragging ignores the grid. */
export function toggleSnap(on = !snap.on): void {
  snap.on = on;
  setStatus(on ? `Grid snap on (${gridWords()}). Hold Alt to place freely.` : "Grid snap off.");
}

/** Set the snap grid spacing in millimetres (at least 0.5 mm); the 2D grid redraws at that size. */
export function setSnapGrid(mm: number): void {
  if (!Number.isFinite(mm)) return;
  snap.gridMm = Math.max(0.5, mm);
  setStatus(`Snap grid ${gridWords()}${snap.on ? "" : " (grid snap is off)"}.`);
}

/**
 * Measure in millimetres or inches. Lengths stay in millimetres inside; only what is shown and
 * typed changes. The snap grid moves to a round size in the new units (5 mm or 1/8 in) when it
 * is still on the other unit's usual size.
 */
export function setUnits(u: Units): void {
  if (state.project.units === u) return;
  edit((p) => (p.units = u));
  if (u === "in" && Math.abs(snap.gridMm - 5) < 1e-9) snap.gridMm = 25.4 / 8;
  else if (u === "mm" && Math.abs(snap.gridMm - 25.4 / 8) < 1e-9) snap.gridMm = 5;
  setStatus(u === "in" ? "Lengths now show in inches. Type 3/8 or 4 1/2 for fractions; 25mm still works." : "Lengths now show in millimetres. 2in still works when you type it.");
}

/** Round a design-space value to the snap grid when snap is on. */
export function snapValue(x: number): number {
  return snap.on ? Math.round(x / snap.gridMm) * snap.gridMm : x;
}

// ---------- selection ----------

/** Ids of all selected pieces (the multi-selection, or the single selected piece). */
export function selectedPieces(): string[] {
  return selectedPieceIds();
}

/** Select every piece in the project. */
export function selectAll(): void {
  const ids = state.project.pieces.map((p) => p.id);
  selectPieces(ids);
  notify();
  setStatus(ids.length ? `Selected ${plural(ids.length, "piece")}.` : "There are no pieces to select.");
}

/** Add a piece to the selection, or take it out when it is already selected (Shift/Ctrl+click). */
export function toggleInSelection(id: string): void {
  const ids = selectedPieceIds();
  selectPieces(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  notify();
}

const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

type Box = { min: V; max: V };

/** Bounds of a piece's design outline in world coordinates. */
function designBounds(pc: Piece): Box {
  const pts = flattenPiece(pc, pc.position).pts;
  return {
    min: { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) },
    max: { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)) },
  };
}

/** Bounds of a piece as drawn (cut line), in world coordinates. */
function shownBounds(pc: Piece): Box {
  const cp = computedPiece(pc.id);
  if (cp && cp.cut.length) return { min: add(cp.bounds.min, pc.position), max: add(cp.bounds.max, pc.position) };
  return designBounds(pc);
}

/** Move every selected piece by (dx, dy) mm; with a corner, hole, hardware or mark selected, move that instead. One undo step. */
export function nudgeSelected(dx: number, dy: number): void {
  const s = state.sel;
  const move = (p: V): V => ({ x: p.x + dx, y: p.y + dy });
  if (s.kind === "piece") {
    const ids = new Set(selectedPieceIds());
    edit((p) => p.pieces.forEach((pc) => ids.has(pc.id) && (pc.position = move(pc.position))));
    return;
  }
  const pc = s.kind === "none" || s.kind === "join" || s.kind === "material" ? undefined : piece(s.piece);
  if (!pc) return;
  if (s.kind === "vertex") edit(() => (pc.vertices[s.index] = move(pc.vertices[s.index])));
  else if (s.kind === "hole") edit(() => pc.holes.forEach((h) => h.id === s.id && (h.center = move(h.center))));
  else if (s.kind === "hardware") edit(() => (pc.hardware ?? []).forEach((h) => h.id === s.id && (h.at = move(h.at))));
  else if (s.kind === "mark") edit(() => (pc.marks ?? []).forEach((m) => m.id === s.id && (m.center = move(m.center))));
}

/** Delete pieces together with their seams and laminates, as one undo step. */
export function deletePieces(ids: string[]): void {
  const gone = new Set(ids);
  const names = state.project.pieces.filter((p) => gone.has(p.id)).map((p) => p.name);
  if (!names.length) return;
  state.sel = { kind: "none" };
  edit((p) => {
    p.pieces = p.pieces.filter((x) => !gone.has(x.id));
    p.joins = p.joins.filter((j) => !gone.has(j.a.pieceId) && !gone.has(j.b.pieceId));
    if (p.laminates) p.laminates = p.laminates.filter((l) => !gone.has(l.a) && !gone.has(l.b));
  });
  setStatus(names.length === 1 ? `Deleted ${names[0]}.` : `Deleted ${plural(names.length, "piece")}.`);
}

/** Delete whatever is selected: every selected piece, or the selected corner, hole, fold, seam, hardware or mark. */
export function deleteSelected(): void {
  const s = state.sel;
  if (s.kind === "piece") return deletePieces(selectedPieceIds());
  if (s.kind === "vertex") {
    const pc = piece(s.piece);
    if (!pc) return;
    if (pc.vertices.length <= 3) return setStatus("A piece needs at least three points.");
    edit((p) => deleteVertex(p, pc, s.index));
    state.sel = { kind: "piece", piece: s.piece };
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

export type AlignTo = "left" | "centre" | "right" | "top" | "middle" | "bottom";

/** Line the selected pieces up on their left, centre, right, top, middle or bottom (as drawn). One undo step. */
export function alignSelected(to: AlignTo): void {
  const pcs = selectedPieceIds().map((id) => piece(id)!).filter(Boolean);
  if (pcs.length < 2) return setStatus("Select two or more pieces to align.");
  const horiz = to === "left" || to === "centre" || to === "right";
  const key = (b: Box) =>
    to === "left" ? b.min.x : to === "right" ? b.max.x : to === "top" ? b.min.y : to === "bottom" ? b.max.y : to === "centre" ? (b.min.x + b.max.x) / 2 : (b.min.y + b.max.y) / 2;
  const vals = pcs.map((pc) => key(shownBounds(pc)));
  const target = to === "left" || to === "top" ? Math.min(...vals) : to === "right" || to === "bottom" ? Math.max(...vals) : (Math.min(...vals) + Math.max(...vals)) / 2;
  edit(() =>
    pcs.forEach((pc, k) => {
      const d = target - vals[k];
      pc.position = horiz ? { x: pc.position.x + d, y: pc.position.y } : { x: pc.position.x, y: pc.position.y + d };
    }),
  );
  setStatus(`Aligned ${plural(pcs.length, "piece")} (${to}).`);
}

/** Space three or more selected pieces evenly across ("x") or down ("y"), keeping the outer two in place. One undo step. */
export function distributeSelected(axis: "x" | "y"): void {
  const pcs = selectedPieceIds().map((id) => piece(id)!).filter(Boolean);
  if (pcs.length < 3) return setStatus("Select three or more pieces to space them evenly.");
  const items = pcs.map((pc) => ({ pc, b: shownBounds(pc) })).sort((a, b) => a.b.min[axis] - b.b.min[axis]);
  const size = (b: Box) => b.max[axis] - b.min[axis];
  const start = items[0].b.min[axis];
  const end = Math.max(...items.map((i) => i.b.max[axis]));
  const gap = (end - start - items.reduce((s, i) => s + size(i.b), 0)) / (items.length - 1);
  edit(() => {
    let at = start;
    for (const { pc, b } of items) {
      const d = at - b.min[axis];
      pc.position = axis === "x" ? { x: pc.position.x + d, y: pc.position.y } : { x: pc.position.x, y: pc.position.y + d };
      at += size(b) + gap;
    }
  });
  setStatus(`Spaced ${plural(pcs.length, "piece")} evenly ${axis === "x" ? "across" : "down"}.`);
}

// ---------- clipboard ----------

const CLIP_FORMAT = "hidework-clipboard";
type PieceClip = { format: typeof CLIP_FORMAT; version: 1; kind: "pieces"; pieces: Piece[]; joins: Join[]; laminates: Laminate[]; materials: Material[] };
type ItemClip =
  | { format: typeof CLIP_FORMAT; version: 1; kind: "hole"; piece: string; item: Hole }
  | { format: typeof CLIP_FORMAT; version: 1; kind: "hardware"; piece: string; item: HardwarePlacement }
  | { format: typeof CLIP_FORMAT; version: 1; kind: "mark"; piece: string; item: Mark };
type Clip = PieceClip | ItemClip;

/** The in-app clipboard and its JSON text (the same text goes to the system clipboard). */
const clip = { data: null as Clip | null, text: "" };
/** Repeated pastes of the same data step further away; the first paste after a cut lands in place. */
let pasteRun = { text: "", count: 0, cut: false };

function piecesClip(ids: string[]): PieceClip | null {
  const set = new Set(ids);
  const pieces = state.project.pieces.filter((p) => set.has(p.id));
  if (!pieces.length) return null;
  const mats = new Set(pieces.map((p) => p.materialId));
  return {
    format: CLIP_FORMAT,
    version: 1,
    kind: "pieces",
    pieces: clone(pieces),
    joins: clone(state.project.joins.filter((j) => set.has(j.a.pieceId) && set.has(j.b.pieceId))),
    laminates: clone((state.project.laminates ?? []).filter((l) => set.has(l.a) && set.has(l.b))),
    materials: clone(state.project.materials.filter((m) => mats.has(m.id))),
  };
}

function takeClip(): Clip | null {
  const s = state.sel;
  if (!isMulti()) {
    const pc = s.kind === "hole" || s.kind === "hardware" || s.kind === "mark" ? piece(s.piece) : undefined;
    if (pc && s.kind === "hole") {
      const item = pc.holes.find((x) => x.id === s.id);
      if (item) return { format: CLIP_FORMAT, version: 1, kind: "hole", piece: pc.id, item: clone(item) };
    } else if (pc && s.kind === "hardware") {
      const item = (pc.hardware ?? []).find((x) => x.id === s.id);
      if (item) return { format: CLIP_FORMAT, version: 1, kind: "hardware", piece: pc.id, item: clone(item) };
    } else if (pc && s.kind === "mark") {
      const item = (pc.marks ?? []).find((x) => x.id === s.id);
      if (item) return { format: CLIP_FORMAT, version: 1, kind: "mark", piece: pc.id, item: clone(item) };
    }
  }
  return piecesClip(selectedPieceIds());
}

function describe(c: Clip): string {
  if (c.kind === "pieces") return `${c.pieces.length === 1 ? c.pieces[0].name : plural(c.pieces.length, "piece")}${c.joins.length ? ` and ${plural(c.joins.length, "seam")}` : ""}`;
  return c.kind === "hole" ? "the hole" : c.kind === "hardware" ? "the hardware" : "the mark";
}

function putClip(c: Clip): void {
  clip.data = c;
  clip.text = JSON.stringify(c);
  pasteRun = { text: "", count: 0, cut: false };
  try {
    void navigator.clipboard?.writeText(clip.text).catch(() => {});
  } catch {
    /* the in-app clipboard still works */
  }
}

function parseClip(text: string): Clip | null {
  if (!text || text[0] !== "{") return null;
  try {
    const c = JSON.parse(text) as Clip;
    if (c?.format !== CLIP_FORMAT) return null;
    if (c.kind === "pieces" && Array.isArray(c.pieces)) return { ...c, joins: c.joins ?? [], laminates: c.laminates ?? [], materials: c.materials ?? [] };
    if ((c.kind === "hole" || c.kind === "hardware" || c.kind === "mark") && c.item) return c;
  } catch {
    /* not Hidework data */
  }
  return null;
}

/** Hidework data on the system clipboard (copied in another window), when the webview lets us read it. */
async function readSystem(): Promise<{ data: Clip; text: string } | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    const text = await Promise.race([navigator.clipboard.readText(), new Promise<string>((_, no) => window.setTimeout(() => no(new Error("timeout")), 400))]);
    const data = parseClip(text);
    return data ? { data, text } : null;
  } catch {
    return null;
  }
}

/** Copy the selected pieces (with holes, folds, hardware, marks, stitching, and the seams and laminates among them), or the selected hole, hardware or mark. */
export function copySelection(): void {
  const c = takeClip();
  if (!c) return setStatus("Select pieces (or a hole, hardware or mark) to copy.");
  putClip(c);
  setStatus(`Copied ${describe(c)}.`);
}

/** Copy, then delete what was copied (one undo step). The next paste puts it back in place. */
export function cutSelection(): void {
  const c = takeClip();
  if (!c) return setStatus("Select pieces (or a hole, hardware or mark) to cut.");
  putClip(c);
  pasteRun = { text: clip.text, count: -1, cut: true };
  if (c.kind === "pieces") deletePieces(c.pieces.map((p) => p.id));
  else deleteSelected();
  setStatus(`Cut ${describe(c)}. Paste (Ctrl+V) to put it back or onto another piece.`);
}

/** Paste: pieces get new ids and "(copy)" names, land 15 mm down and right (at the view centre when that is off screen) and become the selection; a hole, hardware or mark goes onto the selected piece 5 mm away. One undo step. */
export function pasteClipboard(): void {
  void (async () => {
    let data = clip.data;
    let text = clip.text;
    const sys = await readSystem();
    if (sys && sys.text !== clip.text) [data, text] = [sys.data, sys.text];
    if (!data) return setStatus("Nothing to paste yet: copy pieces (Ctrl+C) first.");
    pasteRun = pasteRun.text === text ? { ...pasteRun, count: pasteRun.count + 1 } : { text, count: 1, cut: false };
    if (data.kind === "pieces") pastePieces(data, pasteRun.count, pasteRun.cut && pasteRun.count === 0);
    else pasteItem(data, pasteRun.count);
  })();
}

/** Duplicate all selected pieces (and the seams and laminates among them) 15 mm away, without touching the clipboard. One undo step. */
export function duplicateSelected(): void {
  const c = piecesClip(selectedPieceIds());
  if (!c) return setStatus("Select pieces to duplicate.");
  pastePieces(c, 1, false);
}

function pastePieces(c: PieceClip, step: number, keepNames: boolean): void {
  const off = 15 * step;
  const ids = new Map<string, string>();
  const mats = new Set([...state.project.materials, ...c.materials].map((m) => m.id));
  const pieces = c.pieces.map((src) => {
    const pc: Piece = clone(src);
    pc.id = uid("p");
    ids.set(src.id, pc.id);
    if (!keepNames && !/\(copy\)$/.test(src.name)) pc.name = `${src.name} (copy)`;
    pc.position = { x: src.position.x + off, y: src.position.y + off };
    pc.holes.forEach((h) => (h.id = uid("h")));
    pc.folds.forEach((f) => (f.id = uid("f")));
    pc.hardware?.forEach((x) => (x.id = uid("hw")));
    pc.marks?.forEach((x) => (x.id = uid("mk")));
    pc.tooling?.forEach((x) => (x.id = uid("tl")));
    if (!mats.has(pc.materialId)) pc.materialId = state.project.materials[0]?.id ?? pc.materialId;
    return pc;
  });
  // Bring the paste into view when it would land off screen.
  const boxes = pieces.map(designBounds);
  const min = { x: Math.min(...boxes.map((b) => b.min.x)), y: Math.min(...boxes.map((b) => b.min.y)) };
  const max = { x: Math.max(...boxes.map((b) => b.max.x)), y: Math.max(...boxes.map((b) => b.max.y)) };
  const shown = viewRect();
  if (shown && (max.x < shown.min.x || min.x > shown.max.x || max.y < shown.min.y || min.y > shown.max.y)) {
    const d = sub(viewCenter(), { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 });
    pieces.forEach((pc) => (pc.position = add(pc.position, d)));
  }
  const joins: Join[] = c.joins
    .filter((j) => ids.has(j.a.pieceId) && ids.has(j.b.pieceId))
    .map((j) => ({ ...clone(j), id: uid("j"), a: { pieceId: ids.get(j.a.pieceId)!, edges: [...j.a.edges] }, b: { pieceId: ids.get(j.b.pieceId)!, edges: [...j.b.edges] } }));
  const lams: Laminate[] = c.laminates.filter((l) => ids.has(l.a) && ids.has(l.b)).map((l) => ({ ...clone(l), id: uid("lam"), a: ids.get(l.a)!, b: ids.get(l.b)! }));
  const newMats = c.materials.filter((m) => !state.project.materials.some((x) => x.id === m.id));
  edit((p) => {
    p.materials.push(...clone(newMats));
    p.pieces.push(...pieces);
    p.joins.push(...joins);
    if (lams.length) p.laminates = [...(p.laminates ?? []), ...lams];
  });
  selectPieces(pieces.map((p) => p.id));
  notify();
  setStatus(`Pasted ${pieces.length === 1 ? pieces[0].name : plural(pieces.length, "piece")}${joins.length ? ` with ${plural(joins.length, "seam")}` : ""}.`);
}

function pasteItem(c: ItemClip, step: number): void {
  const target = selectedPieceId() ?? (piece(c.piece) ? c.piece : null);
  const pc = target ? piece(target) : undefined;
  if (!pc) return setStatus(`Select the piece to paste ${describe(c)} onto.`);
  const off = 5 * Math.max(0, step);
  const move = (p: V): V => ({ x: p.x + off, y: p.y + off });
  if (c.kind === "hole") {
    const item: Hole = { ...clone(c.item), id: uid("h"), center: move(c.item.center) };
    edit(() => pc.holes.push(item));
    state.sel = { kind: "hole", piece: pc.id, id: item.id };
  } else if (c.kind === "hardware") {
    const item: HardwarePlacement = { ...clone(c.item), id: uid("hw"), at: move(c.item.at) };
    edit(() => (pc.hardware = [...(pc.hardware ?? []), item]));
    state.sel = { kind: "hardware", piece: pc.id, id: item.id };
  } else {
    const item: Mark = { ...clone(c.item), id: uid("mk"), center: move(c.item.center) };
    edit(() => (pc.marks = [...(pc.marks ?? []), item]));
    state.sel = { kind: "mark", piece: pc.id, id: item.id };
  }
  notify();
  setStatus(`Pasted ${describe(c)} onto ${pc.name}.`);
}

// ---------- merging ----------

/** How far apart (mm) the ends of two sewn edges may be and still count as meeting. */
const END_TOL = 0.5;
const APART = "apart";

/** Merge the selected pieces into one (along a seam between them when there is one). */
export function mergeSelected(): void {
  const ids = selectedPieceIds();
  if (ids.length < 2) return setStatus("Select two or more pieces to merge: Shift+click them, or drag a box around them.");
  const draft: Project = clone(state.project);
  const left = new Set(ids);
  const primary = ids[0];
  const notes: string[] = [];
  const problems: string[] = [];
  const tried = new Set<string>();
  let seams = 0;
  let unions = 0;
  // Merge pairwise along seams between selected pieces, the primary piece first.
  for (;;) {
    const between = draft.joins.filter((j) => !tried.has(j.id) && j.a.pieceId !== j.b.pieceId && left.has(j.a.pieceId) && left.has(j.b.pieceId));
    const j = between.find((x) => x.a.pieceId === primary || x.b.pieceId === primary) ?? between[0];
    if (!j) break;
    tried.add(j.id);
    if (j.a.edges.length !== 1 || j.b.edges.length !== 1) {
      problems.push("Merging follows seams with one edge on each side; this seam joins several edges.");
      continue;
    }
    const [keep, gone] = j.b.pieceId === primary ? [j.b.pieceId, j.a.pieceId] : [j.a.pieceId, j.b.pieceId];
    const r = mergeAlongSeam(draft, j, keep, gone);
    if (typeof r === "string") {
      problems.push(r);
      continue;
    }
    left.delete(gone);
    seams++;
    notes.push(...r);
  }
  // Pieces still apart merge when their outlines overlap or touch.
  for (let progress = true; progress && left.size > 1; ) {
    progress = false;
    const order = [...left].sort((a, b) => (a === primary ? -1 : b === primary ? 1 : 0));
    search: for (let x = 0; x < order.length; x++) {
      for (let y = x + 1; y < order.length; y++) {
        const r = mergeByUnion(draft, order[x], order[y]);
        if (typeof r === "string") {
          if (r !== APART) problems.push(r);
          continue;
        }
        left.delete(order[y]);
        unions++;
        notes.push(...r);
        progress = true;
        break search;
      }
    }
  }
  if (!seams && !unions) {
    return setStatus(problems[0] ?? "These pieces are not sewn together and do not touch. Sew the two edges first (S), then merge, or move the pieces so they overlap.");
  }
  edit((p) => {
    p.pieces = draft.pieces;
    p.joins = draft.joins;
    p.laminates = draft.laminates;
  });
  selectPieces([...left]);
  notify();
  const how = seams ? `along ${plural(seams, "seam")}${unions ? ` and ${unions} more where they overlap` : ""}` : "where they overlap";
  const rest = left.size > 1 ? ` ${plural(left.size - 1, "piece")} could not be merged: ${problems[0] ?? "sew them first (S) or move them so they touch."}` : "";
  setStatus(`Merged ${plural(seams + unions + 1, "piece")} ${how}.${notes.length ? ` ${[...new Set(notes)].join(" ")}` : ""}${rest}`);
}

/** Rotation by theta about `from`, then a move to `to`; exact for quarter turns. */
function rigid(theta: number, from: V, to: V): { map: (p: V) => V; deg: number; cos: number } {
  let c = Math.cos(theta);
  let s = Math.sin(theta);
  for (const v of [-1, 0, 1]) {
    if (Math.abs(c - v) < 1e-9) c = v;
    if (Math.abs(s - v) < 1e-9) s = v;
  }
  const map = (p: V): V => {
    const x = p.x - from.x;
    const y = p.y - from.y;
    return { x: x * c - y * s + to.x, y: x * s + y * c + to.y };
  };
  return { map, deg: (theta * 180) / Math.PI, cos: c };
}

function mapEdge(e: Edge, f: (p: V) => V): Edge {
  return e.type === "cubic" ? { ...clone(e), c1: f(e.c1), c2: f(e.c2) } : clone(e);
}

/**
 * Remove corner `k` (not corner 0) when the edges either side of it are straight, run on in
 * line and are stitched alike; edge k-1 then runs on to the next corner. Returns how old edge
 * numbers move, or null when the corner stays.
 */
function dropStraightCorner(pc: Piece, k: number): ((e: number) => number) | null {
  const n = pc.vertices.length;
  if (n <= 3 || k <= 0 || k >= n) return null;
  const e0 = pc.edges[k - 1];
  const e1 = pc.edges[k];
  if (e0.type !== "line" || e1.type !== "line" || e0.stitched !== e1.stitched) return null;
  const u = sub(pc.vertices[k], pc.vertices[k - 1]);
  const v = sub(pc.vertices[(k + 1) % n], pc.vertices[k]);
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  if (lu < 1e-9 || lv < 1e-9 || Math.abs(u.x * v.y - u.y * v.x) > 1e-6 * lu * lv || u.x * v.x + u.y * v.y <= 0) return null;
  pc.vertices.splice(k, 1);
  pc.edges.splice(k, 1);
  return (e) => (e < k ? e : e === k ? k - 1 : e - 1);
}

/** Point B's seam ends at A through `mapB` and A's through `mapA`; drop ends that vanish, seams left empty, and B. */
function remapRefs(p: Project, a: string, b: string, mapA: (e: number) => number[], mapB: (e: number) => number[]): void {
  for (const j of p.joins) {
    for (const r of [j.a, j.b]) {
      if (r.pieceId === a) r.edges = [...new Set(r.edges.flatMap(mapA))];
      else if (r.pieceId === b) {
        r.pieceId = a;
        r.edges = [...new Set(r.edges.flatMap(mapB))];
      }
    }
  }
  p.joins = p.joins.filter((j) => j.a.edges.length && j.b.edges.length);
  if (p.laminates) {
    p.laminates.forEach((l) => {
      if (l.a === b) l.a = a;
      if (l.b === b) l.b = a;
    });
    p.laminates = p.laminates.filter((l) => l.a !== l.b);
  }
  p.pieces = p.pieces.filter((x) => x.id !== b);
}

/** Move B's holes, hardware, marks and folds onto A through `f` (B design coordinates to A's), turned by `deg`. Returns a note about folds. */
function carryFeatures(A: Piece, B: Piece, f: (p: V) => V, deg: number, cos: number): string | null {
  A.holes.push(...B.holes.map((h) => ({ ...h, center: f(h.center), angleDeg: (h.angleDeg ?? 0) + deg })));
  if (B.hardware?.length) A.hardware = [...(A.hardware ?? []), ...B.hardware.map((h) => ({ ...h, at: f(h.at), angleDeg: (h.angleDeg ?? 0) + deg }))];
  if (B.marks?.length) A.marks = [...(A.marks ?? []), ...B.marks.map((m) => ({ ...m, center: f(m.center), angleDeg: (m.angleDeg ?? 0) + deg }))];
  if (B.tooling?.length) A.tooling = [...(A.tooling ?? []), ...B.tooling.map((t) => ({ ...t, points: t.points.map(f), angleDeg: (t.angleDeg ?? 0) + deg }))];
  const straight = Math.abs(Math.abs(cos) - 1) < 1e-9;
  const turned = Math.abs(cos) < 1e-9;
  let lost = 0;
  for (const fd of B.folds) {
    if (!straight && !turned) {
      lost++;
      continue;
    }
    const horiz = fd.orientation === "horizontal";
    const at = f(horiz ? { x: 0, y: fd.position } : { x: fd.position, y: 0 });
    const nowHoriz = straight ? horiz : !horiz;
    const fold = { ...fd, orientation: nowHoriz ? ("horizontal" as const) : ("vertical" as const), position: nowHoriz ? at.y : at.x };
    if (!A.folds.some((x) => x.orientation === fold.orientation && Math.abs(x.position - fold.position) < 0.01)) A.folds.push(fold);
  }
  if (lost) return `${plural(lost, "fold")} on ${B.name} ended up at an angle and ${lost === 1 ? "was" : "were"} dropped.`;
  return B.folds.length ? `Fold lines from ${B.name} now run across the whole merged piece.` : null;
}

/**
 * Merge piece `gone` (B) into `keep` (A) along seam `j`, one edge on each side. B turns and moves
 * so its sewn edge lies on A's sewn edge running the other way (B on the far side, centred on
 * it); the shared edge is dropped and B's other edges, curves included, are spliced in where A's
 * edge was. A's edges before the seam keep their numbers; A's edges after it shift by the number
 * of edges inserted, minus one. Returns notes for the status line, or an error message.
 */
function mergeAlongSeam(p: Project, j: Join, keep: string, gone: string): string[] | string {
  const A = p.pieces.find((x) => x.id === keep);
  const B = p.pieces.find((x) => x.id === gone);
  if (!A || !B) return "A sewn piece is missing.";
  const i = (j.a.pieceId === keep ? j.a : j.b).edges[0];
  const jb = (j.a.pieceId === keep ? j.b : j.a).edges[0];
  const n = A.vertices.length;
  const m = B.vertices.length;
  if (n < 3 || m < 3 || i >= n || jb >= m) return "The seam points at an edge that no longer exists.";
  // Walk B in the same turning direction as A, so the sewn edges run opposite ways once B lies
  // outside A. Reversing the walk changes the numbering only, never the shape.
  const same = Math.sign(signedArea(flattenPiece(A).pts)) === Math.sign(signedArea(flattenPiece(B).pts));
  const bv = same ? B.vertices : B.vertices.map((_, k) => B.vertices[(m - k) % m]);
  const be: Edge[] = same
    ? B.edges
    : B.edges.map((_, k) => {
        const e = B.edges[m - 1 - k];
        return e.type === "cubic" ? { ...e, c1: e.c2, c2: e.c1 } : e;
      });
  const walk = (e: number) => (same ? e : m - 1 - e);
  const jr = walk(jb);
  const a0 = A.vertices[i];
  const a1 = A.vertices[(i + 1) % n];
  const b0 = bv[jr];
  const b1 = bv[(jr + 1) % m];
  const la = Math.hypot(a1.x - a0.x, a1.y - a0.y);
  const lb = Math.hypot(b1.x - b0.x, b1.y - b0.y);
  if (la < 1e-6 || lb < 1e-6) return "A sewn edge has no length.";
  // B's edge b0 -> b1 must point along a1 -> a0, centred on A's edge.
  const theta = Math.atan2(a0.y - a1.y, a0.x - a1.x) - Math.atan2(b1.y - b0.y, b1.x - b0.x);
  const T = rigid(theta, { x: (b0.x + b1.x) / 2, y: (b0.y + b1.y) / 2 }, { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 });
  const tv = bv.map(T.map);
  const te = be.map((e) => mapEdge(e, T.map));
  // B's outline from the end of its sewn edge round to its start: it runs from a0 back to a1.
  const chain = tv.map((_, t) => tv[(jr + 1 + t) % m]);
  const chainE = te.map((_, t) => te[(jr + 1 + t) % m]).slice(0, m - 1);
  const startMeets = Math.hypot(chain[0].x - a0.x, chain[0].y - a0.y) <= END_TOL;
  const endMeets = Math.hypot(chain[m - 1].x - a1.x, chain[m - 1].y - a1.y) <= END_TOL;
  const outV: V[] = [];
  const outE: Edge[] = [];
  for (let k = 0; k <= i; k++) {
    outV.push(A.vertices[k]);
    if (k < i) outE.push(A.edges[k]);
  }
  if (!startMeets) {
    outE.push({ type: "line", stitched: false });
    outV.push(chain[0]);
  }
  for (let t = 0; t < m - 1; t++) {
    outE.push(chainE[t]);
    if (t < m - 2 || !endMeets) outV.push(chain[t + 1]);
  }
  if (!endMeets) outE.push({ type: "line", stitched: false });
  for (let k = i + 1; k < n; k++) {
    outV.push(A.vertices[k]);
    outE.push(A.edges[k]);
  }
  const inserted = m - 1 + (startMeets ? 0 : 1) + (endMeets ? 0 : 1);
  const bStart = i + (startMeets ? 0 : 1);
  const notes: string[] = [];
  if (Math.abs(la - lb) > 2 * END_TOL) notes.push(`The sewn edges differ by ${Math.abs(la - lb).toFixed(1)} mm, so the outline steps where the shorter one ends.`);
  if (A.materialId !== B.materialId) notes.push(`${B.name} was a different material; the merged piece uses ${A.name}'s.`);
  A.vertices = outV;
  A.edges = outE;
  // Where the two outlines carry straight on through a seam end (two rectangles side by side),
  // drop the corner so the edges become one. The higher corner goes first so the lower keeps its number.
  let renumber = (e: number) => e;
  const ends = [endMeets ? (i + inserted) % outV.length : 0, startMeets ? i : 0].filter((k) => k > 0).sort((x, y) => y - x);
  for (const k of ends) {
    const f = dropStraightCorner(A, k);
    if (f) {
      const before = renumber;
      renumber = (e) => f(before(e));
    }
  }
  const mapA = (e: number): number[] => (e < i ? [e] : e === i ? [] : [e - 1 + inserted]).map(renumber);
  const mapB = (e: number): number[] => {
    const r = walk(e);
    return (r === jr ? [] : [bStart + ((r - jr - 1 + m) % m)]).map(renumber);
  };
  const fold = carryFeatures(A, B, T.map, T.deg, T.cos);
  if (fold) notes.push(fold);
  p.joins = p.joins.filter((x) => x.id !== j.id);
  remapRefs(p, A.id, B.id, mapA, mapB);
  if (selfIntersects(flattenPiece(A).pts)) notes.push("The merged outline crosses itself; check the shape (Undo brings both pieces back).");
  return notes;
}

/**
 * Merge `bId` into `aId` when their outlines, as placed and with curves flattened, overlap or
 * touch: the new outline is their union, in straight edges. Every old edge maps to the new
 * edges that run along it, so seams on the outer outline survive. Returns notes, APART, or an
 * error message.
 */
function mergeByUnion(p: Project, aId: string, bId: string): string[] | string {
  const A = p.pieces.find((x) => x.id === aId);
  const B = p.pieces.find((x) => x.id === bId);
  if (!A || !B || A.vertices.length < 3 || B.vertices.length < 3) return APART;
  if (!boxesMeet(A, B, 0.05)) return APART;
  const res = reshapeByBoolean(A, B, "union", false, 0.05);
  if (typeof res === "string") return res === "The outlines do not overlap or touch." ? APART : res;
  const d = sub(B.position, A.position);
  const fold = carryFeatures(A, B, (q) => add(q, d), 0, 1);
  remapRefs(p, A.id, B.id, (e) => res.mapA.get(e) ?? [], (e) => res.mapB.get(e) ?? []);
  const notes: string[] = [];
  if (res.curvesLost) notes.push("Curves became short straight edges.");
  if (res.holesFilled) notes.push("The gap the pieces enclosed was filled in.");
  if (fold) notes.push(fold);
  return notes;
}

/** Do the two pieces' outlines (with their positions) come within `tol` of each other's boxes? */
function boxesMeet(A: Piece, B: Piece, tol: number): boolean {
  const box = (pc: Piece) => {
    const pts = flattenPiece(pc, pc.position).pts;
    return { x0: Math.min(...pts.map((q) => q.x)), x1: Math.max(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), y1: Math.max(...pts.map((q) => q.y)) };
  };
  const ba = box(A);
  const bb = box(B);
  return !(ba.x1 < bb.x0 - tol || bb.x1 < ba.x0 - tol || ba.y1 < bb.y0 - tol || bb.y1 < ba.y0 - tol);
}

/** combineShape: the shape does not reach the piece. */
export const SHAPE_APART = APART;
/** combineShape: the shape changes nothing (it lies inside the piece, or outside it for a cut). */
export const SHAPE_NO_CHANGE = "no change";

/**
 * Sketch-style editing: grow piece `targetId` of `p` by `shape` ("union") or cut `shape` out of it
 * ("cut"), as one outline. `shape` is not in the project; it is placed by its own position, in the
 * target's design coordinates. New edges carry on the stitching of the edge they grow out of, and
 * seams on the target follow its edges. Returns notes for the status line, SHAPE_APART,
 * SHAPE_NO_CHANGE, or an error in words.
 */
export function combineShape(p: Project, targetId: string, shape: Piece, op: "union" | "cut"): string[] | string {
  const A = p.pieces.find((x) => x.id === targetId);
  if (!A || A.vertices.length < 3 || shape.vertices.length < 3) return APART;
  if (!boxesMeet(A, shape, 0.05)) return APART;
  const res = reshapeByBoolean(A, shape, op, true, 0.05);
  if (typeof res === "string") return res === "The outlines do not overlap or touch." ? APART : res;
  if (Math.abs(res.after - res.before) < 0.01) return SHAPE_NO_CHANGE;
  remapRefs(p, A.id, shape.id, (e) => res.mapA.get(e) ?? [], () => []);
  const notes: string[] = [];
  if (res.holesFilled) notes.push("The gap it enclosed was filled in.");
  if (op === "cut") {
    // Holes and hardware the cut took away with it.
    const ring = flattenPiece(A).pts;
    const out = A.holes.filter((h) => !pointInPolygon(h.center, ring)).length + (A.hardware ?? []).filter((h) => !pointInPolygon(h.at, ring)).length;
    if (out) notes.push(`${out} ${out === 1 ? "hole or fitting" : "holes or fittings"} now ${out === 1 ? "sits" : "sit"} outside the piece: move or delete ${out === 1 ? "it" : "them"}.`);
  }
  return notes;
}
