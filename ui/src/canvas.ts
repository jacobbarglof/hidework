// The drafting table: draws the pattern on parchment and handles mouse editing.

import { computedPiece, edit, isMulti, notify, piece, placing, selectPieces, selectedPieceId, selectedPieceIds, setStatus, snapshot, changed, state, subscribe, uid } from "./store";
import { canvasPng } from "./dom";
import { snap as grid } from "./editing";
import { dist, edgePoints, insertVertex, midpoint, polygonTouchesBox, toDesign } from "./ops";
import { snapStep } from "./units";
import { cancelShape, drawDouble, drawDown, drawing, drawMove, drawUp, fmt, initDraw, paintDraw } from "./drawtools";
import { initEdgeBox, place as placeEdgeBox } from "./edgebox";
import { simple } from "./prefs";
import { bendEdge, edgeLength, edgeMiddle, moveEdge, outlineCopy, segmentLength } from "./shapeops";
import { drawSnapHit, smartSnap, snapMove, type SnapHit } from "./smartsnap";
import type { Edge } from "./types";
import { addStroke, faceDepth, flatten, hooks as toolingHooks, impressions, isSelectedStroke, newStroke, paintStroke, placeDesign, pointInPolygon, selectedStrokes, simplify, strokes, strokeSize, toStaged, tooling as toolingArm, toolingOpen } from "./tooling";
import type { ComputedPiece, Piece, ToolingStroke, V } from "./types";

const INK = "#2b1d0e";
const OXBLOOD = "#7a1f1a";
const GOLD = "#b08a3e";
const OK = "#3f6b2a";

const view = { scale: 3, ox: 120, oy: 80 };
let cv: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let hover: { piece: string; edge: number } | null = null;
let hoverWorld: V | null = null;
let spaceDown = false;

type Drag =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "pieces"; ids: string[]; start: V; origs: V[]; moved: boolean }
  | { kind: "box"; a: V; b: V; base: string[] }
  | { kind: "vertex"; id: string; index: number; start: V; orig: V; moved: boolean }
  | { kind: "ctrl"; id: string; edge: number; which: 0 | 1; start: V; orig: V; moved: boolean }
  | { kind: "edge"; id: string; edge: number; start: V; orig: { vertices: V[]; edges: Edge[] }; moved: boolean }
  | { kind: "bend"; id: string; edge: number; start: V; orig: Edge; moved: boolean }
  | { kind: "hole"; id: string; hid: string; start: V; orig: V; moved: boolean }
  | { kind: "fold"; id: string; fid: string; start: V; orig: number; moved: boolean }
  | { kind: "hardware"; id: string; hid: string; start: V; orig: V; moved: boolean }
  | { kind: "mark"; id: string; mid: string; start: V; orig: V; moved: boolean }
  | { kind: "tooling"; id: string; sids: string[]; start: V; origs: V[][]; moved: boolean };
let drag: Drag | null = null;
let measure: { a: V; b: V; active: boolean } | null = null;
/** What the pointer snapped to while reshaping or moving a piece (shown with a marker and a word). */
let editHit: SnapHit | null = null;
/** A tooling line being drawn: points in piece design mm; `down` while the button is held. */
let tdraft: { piece: string; pts: V[]; free: boolean; down: V | null } | null = null;
/** A tooling box being dragged (fills and boxed designs), world mm. */
let tbox: { piece: string | null; a: V; b: V } | null = null;

/** The modifier keys that change snapping (a mouse event, or the keys last seen). */
type Mods = { shiftKey: boolean; altKey: boolean };
let mods: Mods = { shiftKey: false, altKey: false };

/** Snap a piece-local design point. With grid snap on, the grid is the drawn (world) grid, so
 * the point lands on a grid line even when the piece itself sits off the grid. */
function snapLocal(p: V, pos: V, e: Mods): V {
  if (!gridOn(e)) return { x: snap(p.x, e), y: snap(p.y, e) };
  return { x: snap(pos.x + p.x, e) - pos.x, y: snap(pos.y + p.y, e) - pos.y };
}

/** Grid snap applies: switched on, and neither Shift (place freely) nor Alt (fine) held. */
function gridOn(e: Mods): boolean {
  return grid.on && !e.shiftKey && !e.altKey;
}

/** Snap a fold position (piece-local, along one axis whose piece offset is `pos`). */
function foldSnap(v: number, pos: number, e: Mods): number {
  return gridOn(e) ? snap(pos + v, e) - pos : snap(v, e);
}

export function cancelDrawing(): void {
  cancelShape();
  editHit = null;
  finishTooling();
  requestDraw();
}

// ---------- tooling (see tooling.ts) ----------

/** Finish a half-drawn tooling line (kept if it has two points) or drop a box. True if anything was pending. */
function finishTooling(): boolean {
  const had = !!tdraft || !!tbox;
  if (tdraft) finishDraft(false);
  tbox = null;
  if (had) requestDraw();
  return had;
}
toolingHooks.finish = finishTooling;

/** A world point as a snapped design point on piece `pc`. */
function localPoint(pc: Piece, w: V, e: Mods): V {
  return snapLocal(rawLocal(pc, w), pc.position, e);
}

function rawLocal(pc: Piece, w: V): V {
  return toDesign(computedPiece(pc.id), { x: w.x - pc.position.x, y: w.y - pc.position.y });
}

function finishDraft(close: boolean): void {
  const d = tdraft;
  tdraft = null;
  const pc = d && piece(d.piece);
  if (!d || !pc) return;
  let pts = d.pts;
  let closed = close;
  if (d.free) {
    pts = simplify(pts, Math.max(0.25, 1.5 / view.scale));
    if (pts.length >= 4 && dist(pts[0], pts[pts.length - 1]) * view.scale < 14) {
      pts.pop();
      closed = true;
    }
    if (gridOn(mods) && pts.length) {
      pts[0] = snapLocal(pts[0], pc.position, mods);
      if (!closed) pts[pts.length - 1] = snapLocal(pts[pts.length - 1], pc.position, mods);
    }
  }
  pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 0.05);
  if (pts.length < 2) {
    requestDraw();
    return;
  }
  const kind = toolingArm.how === "cut" ? "cut" : "line";
  addStroke(d.piece, newStroke(kind, pts, { smooth: pts.length > 2, closed }));
  setStatus(`${kind === "cut" ? "Cut line" : "Row of stamps"} added. Draw another, or press Esc when you are done.`);
}

function toolingDown(w: V, e: MouseEvent): void {
  const design = toolingArm.design;
  const how = toolingArm.how;
  const boxed = design === "basketweave" || design === "checkerboard" || design === "diamond" || (!design && how === "fill");
  if (!design && (how === "cut" || how === "line")) {
    if (tdraft) {
      const pc = piece(tdraft.piece);
      if (!pc) {
        tdraft = null;
        return;
      }
      const p = localPoint(pc, w, e);
      // Clicking the first point again closes the shape.
      const first = toScreen(addV(toStaged(computedPiece(pc.id), tdraft.pts[0]), pc.position));
      const here = toScreen(w);
      if (tdraft.pts.length >= 3 && Math.hypot(first.x - here.x, first.y - here.y) < 10) {
        finishDraft(true);
        return;
      }
      tdraft.pts.push(p);
      tdraft.down = w;
      requestDraw();
      return;
    }
    const id = hitPiece(w);
    if (!id) return setStatus("Start on a piece of leather.");
    tdraft = { piece: id, pts: [localPoint(piece(id)!, w, e)], free: false, down: w };
    requestDraw();
    return;
  }
  if (boxed) {
    tbox = { piece: hitPiece(w), a: w, b: w };
    requestDraw();
    return;
  }
  const id = hitPiece(w);
  if (!id) return setStatus("Click on a piece of leather.");
  const pc = piece(id)!;
  const p = localPoint(pc, w, e);
  if (design) {
    void placeDesign(id, p);
  } else if (how === "letters") {
    if (!toolingArm.text.trim()) return setStatus("Type the letters to stamp in the Tooling panel first.");
    addStroke(id, newStroke("letters", [p], { text: toolingArm.text }));
    setStatus("Letters stamped. Click again for more, or press Esc when you are done.");
  } else {
    addStroke(id, newStroke("stamp", [p]));
    setStatus("Stamped. Keep clicking to strike more, or press Esc when you are done.");
  }
}

function finishBox(): void {
  const b = tbox;
  tbox = null;
  requestDraw();
  if (!b) return;
  const id = b.piece ?? hitPiece(b.b);
  if (!id) return setStatus("Drag over a piece of leather.");
  const pc = piece(id)!;
  const sa = toScreen(b.a);
  const sb = toScreen(b.b);
  const design = toolingArm.design;
  if (Math.hypot(sb.x - sa.x, sb.y - sa.y) < 6) {
    // A click, not a drag.
    if (design) return void placeDesign(id, localPoint(pc, b.a, mods));
    const local = rawLocal(pc, b.a);
    const loop = strokes(pc).filter((s) => s.kind === "cut" && s.closed).reverse().find((s) => pointInPolygon(local, flatten(s)));
    if (!loop) return setStatus("Drag a box over the area to fill, or click inside a closed cut line.");
    addStroke(id, newStroke("fill", loop.points.map((q) => ({ ...q })), { smooth: loop.smooth, closed: true }));
    setStatus("Filled. Do another, or press Esc when you are done.");
    return;
  }
  const a = localPoint(pc, b.a, mods);
  const c = localPoint(pc, b.b, mods);
  const min = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y) };
  const max = { x: Math.max(a.x, c.x), y: Math.max(a.y, c.y) };
  if (max.x - min.x < 2 || max.y - min.y < 2) return;
  if (design) return void placeDesign(id, { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 }, { min, max });
  addStroke(id, newStroke("fill", [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }], { closed: true }));
  setStatus("Filled. Drag another box, or press Esc when you are done.");
}

function drawToolingDraft(): void {
  if (tdraft) {
    const pc = piece(tdraft.piece);
    const cp = computedPiece(tdraft.piece);
    if (pc) {
      ctx.strokeStyle = OXBLOOD;
      ctx.lineWidth = 2;
      ctx.setLineDash(tdraft.free ? [] : [5, 3]);
      ctx.beginPath();
      tdraft.pts.forEach((p, i) => {
        const q = toScreen(addV(toStaged(cp, p), pc.position));
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      if (!tdraft.free && hoverWorld) {
        const q = toScreen(hoverWorld);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (!tdraft.free) {
        for (const p of tdraft.pts) {
          const q = toScreen(addV(toStaged(cp, p), pc.position));
          ctx.fillStyle = GOLD;
          ctx.fillRect(q.x - 4, q.y - 4, 8, 8);
        }
      }
    }
  }
  if (tbox) {
    const a = toScreen(tbox.a);
    const b = toScreen(tbox.b);
    ctx.fillStyle = "rgba(122,31,26,0.10)";
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeStyle = OXBLOOD;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
  }
}

/** Tooling on a piece: cuts as thin dark lines, stamps as their impressions, clipped to the leather. */
function drawTooling(pc: Piece, cp: ComputedPiece, off: V): void {
  const list = pc.tooling ?? [];
  if (!list.length) return;
  const map = (p: V): V => addV(toStaged(cp, p), off);
  ctx.save();
  path(cp.cut, off, true);
  ctx.clip();
  ctx.translate(view.ox, view.oy);
  for (const st of list) paintStroke(ctx, st, view.scale, map, isSelectedStroke(pc.id, st));
  ctx.restore();
  // The selected line's path and points.
  const cur = selectedStrokes();
  if (!cur || cur.pc.id !== pc.id) return;
  for (const st of cur.group) {
    if (st.kind !== "fill" && st.kind !== "line") continue;
    const pts = flatten(st).map((p) => toScreen(map(p)));
    ctx.strokeStyle = OXBLOOD;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    if (st.closed || st.kind === "fill") ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (cur.group.length === 1) {
    for (const p of cur.s.points) {
      const q = toScreen(map(p));
      ctx.fillStyle = GOLD;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.fillRect(q.x - 3.5, q.y - 3.5, 7, 7);
      ctx.strokeRect(q.x - 3.5, q.y - 3.5, 7, 7);
    }
  }
}

/** The tooling stroke under a world point (lines and stamps before filled areas). */
function hitStroke(w: V): { piece: string; id: string } | null {
  const tol = 6 / view.scale;
  for (const fills of [false, true]) {
    for (const pc of [...state.project.pieces].reverse()) {
      const list = pc.tooling ?? [];
      if (!list.length) continue;
      const cp = computedPiece(pc.id);
      const local = { x: w.x - pc.position.x, y: w.y - pc.position.y };
      for (const st of [...list].reverse()) {
        if ((st.kind === "fill") !== fills) continue;
        if (strokeHit(st, cp, local, tol)) return { piece: pc.id, id: st.id };
      }
    }
  }
  return null;
}

function strokeHit(st: ToolingStroke, cp: ComputedPiece | undefined, p: V, tol: number): boolean {
  const stage = (q: V) => toStaged(cp, q);
  if (st.kind === "fill") return pointInPolygon(p, flatten(st).map(stage));
  if (st.kind === "cut" || st.kind === "line") {
    const pts = flatten(st).map(stage);
    if (st.closed && pts.length > 2) pts.push(pts[0]);
    const reach = Math.max(tol, st.kind === "line" ? faceDepth(st.tool, strokeSize(st)) : strokeSize(st) / 2);
    for (let i = 0; i + 1 < pts.length; i++) if (segDist(p, pts[i], pts[i + 1]) < reach) return true;
    if (st.kind === "cut") return false;
  }
  const r = Math.max(tol, strokeSize(st) / 2);
  return impressions(st).some((imp) => dist(stage(imp.at), p) < r);
}


/** PNG of the pattern canvas (base64, no data: prefix). */
export function captureCanvas(): string {
  draw();
  return canvasPng(cv);
}

export function zoomBy(factor: number): void {
  const r = cv.getBoundingClientRect();
  const before = toWorld(r.width / 2, r.height / 2);
  view.scale = Math.min(60, Math.max(0.2, view.scale * factor));
  view.ox = r.width / 2 - before.x * view.scale;
  view.oy = r.height / 2 - before.y * view.scale;
  requestDraw();
}

/** Nearest corner or stitch hole within a few pixels, for measuring. */
function snapToFeature(w: V): V {
  let best = w;
  let bestD = 9 / view.scale;
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    const pts = [...cp.vertices, ...cp.stitchRuns.flatMap((r) => r.holes), ...cp.holes.map((h) => h.center)];
    for (const p of pts) {
      const q = addV(p, pc.position);
      const d = dist(q, w);
      if (d < bestD) [best, bestD] = [q, d];
    }
  }
  return best;
}

function drawMeasure(): void {
  if (!measure) return;
  const a = toScreen(measure.a);
  const b = toScreen(measure.b);
  ctx.strokeStyle = OXBLOOD;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 3]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const p of [a, b]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = OXBLOOD;
    ctx.fill();
  }
  const d = dist(measure.a, measure.b);
  const inch = state.project.units === "in";
  const txt = inch ? `${(d / 25.4).toFixed(3)} in` : `${d.toFixed(1)} mm`;
  ctx.font = "600 14px 'EB Garamond', serif";
  const tw = ctx.measureText(txt).width;
  const mx = (a.x + b.x) / 2 + 8;
  const my = (a.y + b.y) / 2 - 8;
  ctx.fillStyle = "rgba(246,236,211,0.92)";
  ctx.fillRect(mx - 4, my - 14, tw + 8, 20);
  ctx.strokeStyle = OXBLOOD;
  ctx.lineWidth = 1;
  ctx.strokeRect(mx - 4, my - 14, tw + 8, 20);
  ctx.fillStyle = OXBLOOD;
  ctx.fillText(txt, mx, my);
}

const toScreen = (p: V): V => ({ x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale });
const toWorld = (sx: number, sy: number): V => ({ x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale });
const addV = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });

let queued = false;
export function requestDraw(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    draw();
  });
}

export function initCanvas(el: HTMLCanvasElement): void {
  cv = el;
  ctx = el.getContext("2d")!;
  new ResizeObserver(() => resize()).observe(el.parentElement!);
  resize();
  subscribe(requestDraw);
  el.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  el.addEventListener("dblclick", onDouble);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  const host = { el, ctx: () => ctx, toScreen, scale: () => view.scale, redraw: requestDraw };
  initDraw(host);
  initEdgeBox(host);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !isTyping()) spaceDown = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") spaceDown = false;
  });
}

export function isTyping(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "SELECT" || a.tagName === "TEXTAREA");
}

function resize(): void {
  const r = cv.parentElement!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.floor(r.width * dpr));
  cv.height = Math.max(1, Math.floor(r.height * dpr));
  cv.style.width = `${r.width}px`;
  cv.style.height = `${r.height}px`;
  draw();
}

export function fitView(): void {
  const b = state.computed?.bounds;
  if (!b) return;
  const r = cv.getBoundingClientRect();
  const pad = 70;
  const w = Math.max(10, b.max.x - b.min.x);
  const h = Math.max(10, b.max.y - b.min.y);
  view.scale = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / h, 12);
  view.ox = r.width / 2 - ((b.min.x + b.max.x) / 2) * view.scale;
  view.oy = r.height / 2 - ((b.min.y + b.max.y) / 2) * view.scale;
  requestDraw();
}

export function viewCenter(): V {
  const r = cv.getBoundingClientRect();
  return toWorld(r.width / 2, r.height / 2);
}

/** The part of the pattern currently visible in the 2D window (null before the canvas exists). */
export function viewRect(): { min: V; max: V } | null {
  if (!cv) return null;
  const r = cv.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { min: toWorld(0, 0), max: toWorld(r.width, r.height) };
}

// ---------- drawing ----------

function path(pts: V[], off: V, closed: boolean): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(addV(p, off));
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (closed) ctx.closePath();
}

function drawBackground(w: number, h: number): void {
  ctx.fillStyle = "#efe2c4";
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(255,248,230,0.35)");
  g.addColorStop(1, "rgba(120,80,40,0.28)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const inch = state.project.units === "in";
  // With grid snap on the grid shows the snap spacing, with a heavier line every 10 (every 5 for
  // grids of 10 mm and up).
  const major = grid.on ? grid.gridMm * (grid.gridMm >= 10 ? 5 : 10) : inch ? 25.4 : 50;
  const minor = grid.on ? grid.gridMm : inch ? 25.4 / 4 : 10;
  const tl = toWorld(0, 0);
  const br = toWorld(w, h);
  const lines = (step: number, color: string) => {
    if (step * view.scale < 7) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const sx = Math.round(toScreen({ x, y: 0 }).x) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
      const sy = Math.round(toScreen({ x: 0, y }).y) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();
  };
  lines(minor, grid.on ? "rgba(110,75,40,0.16)" : "rgba(110,75,40,0.10)");
  lines(major, grid.on ? "rgba(110,75,40,0.30)" : "rgba(110,75,40,0.22)");
}

function fillFor(pc: Piece): string {
  const kind = state.project.materials.find((m) => m.id === pc.materialId)?.kind;
  if (kind === "waxedCanvas") return "rgba(118,122,72,0.30)";
  if (kind === "other") return "rgba(120,110,100,0.22)";
  return "rgba(168,104,52,0.30)";
}

function drawPiece(pc: Piece, cp: ComputedPiece, selected: boolean): void {
  const off = pc.position;
  const s = view.scale;
  // Leather body with a soft shadow.
  ctx.save();
  ctx.shadowColor = "rgba(60,35,15,0.35)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  path(cp.cut, off, true);
  ctx.fillStyle = fillFor(pc);
  ctx.fill();
  ctx.restore();
  path(cp.cut, off, true);
  ctx.strokeStyle = selected ? OXBLOOD : INK;
  ctx.lineWidth = selected ? 2.2 : 1.4;
  ctx.setLineDash([]);
  ctx.stroke();
  if (pc.seamAllowanceMm > 0) {
    path(cp.outline, off, true);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(43,29,14,0.6)";
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Stitch holes.
  ctx.fillStyle = INK;
  const hr = Math.max(1.1, (pc.stitch.holeMm / 2) * s);
  for (const run of cp.stitchRuns) {
    const n = run.holes.length;
    run.holes.forEach((h, k) => {
      const p = toScreen(addV(h, off));
      if (run.lace) {
        const a = run.holes[Math.max(0, k - 1)];
        const b = run.holes[Math.min(n - 1, k + 1)];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const half = (pc.stitch.holeMm / 2) * s;
        const dx = ((b.x - a.x) / len) * half;
        const dy = ((b.y - a.y) / len) * half;
        ctx.strokeStyle = INK;
        ctx.lineWidth = Math.max(1.4, 0.9 * s);
        ctx.beginPath();
        ctx.moveTo(p.x - dx, p.y - dy);
        ctx.lineTo(p.x + dx, p.y + dy);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, hr, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  // Glue bands and crease lines.
  for (const line of cp.glue ?? []) {
    path(line, off, false);
    ctx.setLineDash([1.5, 3]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(176,138,62,0.95)";
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const line of cp.creases ?? []) {
    path(line, off, false);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = "rgba(43,29,14,0.45)";
    ctx.stroke();
  }
  // Folds.
  for (const f of cp.folds) {
    const sel = state.sel.kind === "fold" && state.sel.id === f.id;
    ctx.strokeStyle = sel ? OXBLOOD : "rgba(43,29,14,0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (const seg of [...f.start, ...f.end]) {
      path(seg, off, false);
      ctx.stroke();
    }
    ctx.setLineDash([10, 3, 2, 3]);
    ctx.lineWidth = sel ? 2.4 : 1.4;
    ctx.strokeStyle = sel ? OXBLOOD : INK;
    for (const seg of f.center) {
      path(seg, off, false);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const first = f.center[0];
    if (first) {
      const p = toScreen(addV(first[0], off));
      ctx.fillStyle = sel ? OXBLOOD : INK;
      ctx.font = "italic 13px 'EB Garamond', serif";
      ctx.fillText(`fold  +${f.shiftMm.toFixed(1)} mm`, p.x + 8, p.y - 5);
    }
  }
  // Skive zones.
  for (const line of cp.skive ?? []) {
    path(line, off, false);
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(122,31,26,0.75)";
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Punched holes and slots.
  for (const h of cp.holes) {
    const p = toScreen(addV(h.center, off));
    const sel = state.sel.kind === "hole" && state.sel.id === h.id;
    const r = Math.max(3, (h.diameterMm / 2) * s);
    ctx.strokeStyle = sel ? OXBLOOD : INK;
    ctx.lineWidth = sel ? 2 : 1.2;
    if ((h.lengthMm ?? 0) > h.diameterMm) {
      const half = (((h.lengthMm ?? 0) - h.diameterMm) / 2) * s;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(((h.angleDeg ?? 0) * Math.PI) / 180);
      ctx.beginPath();
      ctx.arc(half, 0, r, -Math.PI / 2, Math.PI / 2);
      ctx.arc(-half, 0, r, Math.PI / 2, (3 * Math.PI) / 2);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      continue;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.moveTo(p.x - r - 4, p.y);
    ctx.lineTo(p.x + r + 4, p.y);
    ctx.moveTo(p.x, p.y - r - 4);
    ctx.lineTo(p.x, p.y + r + 4);
    ctx.stroke();
  }
  drawMarks(pc, cp, off);
  drawTooling(pc, cp, off);
  drawHardware(pc, cp, off);
  // Name.
  const c = toScreen(addV({ x: (cp.bounds.min.x + cp.bounds.max.x) / 2, y: (cp.bounds.min.y + cp.bounds.max.y) / 2 }, off));
  ctx.fillStyle = selected ? OXBLOOD : "rgba(43,29,14,0.85)";
  ctx.textAlign = "center";
  ctx.font = `600 ${Math.max(11, Math.min(20, 4.5 * s))}px Cinzel, serif`;
  ctx.fillText(pc.name, c.x, c.y);
  ctx.font = `italic ${Math.max(10, Math.min(15, 3 * s))}px 'EB Garamond', serif`;
  ctx.fillText(`cut ${pc.cutCount}  ·  ${cp.materialName}`, c.x, c.y + Math.max(14, Math.min(22, 5 * s)));
  ctx.textAlign = "left";
}

function drawMarks(pc: Piece, cp: ComputedPiece, off: V): void {
  const s = view.scale;
  for (const mk of cp.marks ?? []) {
    const sel = state.sel.kind === "mark" && state.sel.id === mk.id;
    const c = toScreen(addV(mk.center, off));
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(((mk.angleDeg ?? 0) * Math.PI) / 180);
    const w = mk.size.x * s;
    const hgt = mk.size.y * s;
    if (mk.kind === "paint") {
      ctx.fillStyle = mk.pattern || "#1d1d1f";
      ctx.globalAlpha = 0.55;
      ctx.fillRect(-w / 2, -hgt / 2, w, hgt);
      ctx.globalAlpha = 1;
    } else if (mk.kind === "tooling") {
      ctx.strokeStyle = "rgba(90,52,24,0.55)";
      ctx.lineWidth = 1;
      const step = Math.max(6, 4 * s);
      for (let x = -w / 2; x < w / 2; x += step) {
        ctx.beginPath();
        ctx.arc(x + step / 2, 0, step / 2, 0, Math.PI);
        ctx.stroke();
      }
    }
    if (mk.kind !== "perforate") {
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = sel ? OXBLOOD : "rgba(43,29,14,0.7)";
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(-w / 2, -hgt / 2, w, hgt);
      ctx.setLineDash([]);
      ctx.fillStyle = sel ? OXBLOOD : INK;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = mk.text || mk.kind;
      ctx.font = `${mk.kind === "text" || mk.kind === "stamp" ? "600 " : "italic "}${Math.max(9, Math.min(hgt * 0.6, 16))}px ${mk.kind === "text" ? "Cinzel, serif" : "'EB Garamond', serif"}`;
      ctx.fillText(label, 0, 0, w * 0.95);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
    } else if (sel) {
      ctx.strokeStyle = OXBLOOD;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-w / 2, -hgt / 2, w, hgt);
    }
    ctx.restore();
  }
  void pc;
}

/** Hardware as small symbols in brass over the holes it needs. */
function drawHardware(pc: Piece, cp: ComputedPiece, off: V): void {
  const s = view.scale;
  for (const hw of cp.hardware ?? []) {
    const sel = state.sel.kind === "hardware" && state.sel.id === hw.id;
    const c = toScreen(addV(hw.at, off));
    const size = (hw.sizeMm || 0) * s;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(((hw.angleDeg ?? 0) * Math.PI) / 180);
    ctx.strokeStyle = sel ? OXBLOOD : GOLD;
    ctx.fillStyle = "rgba(176,138,62,0.18)";
    ctx.lineWidth = sel ? 2.2 : 1.4;
    const r = Math.max(6, (size || 10 * s) / 2);
    const k = hw.kind;
    ctx.beginPath();
    if (k === "d-ring") {
      ctx.moveTo(-r, -r * 0.2);
      ctx.lineTo(r, -r * 0.2);
      ctx.arc(0, -r * 0.2, r, 0, Math.PI);
    } else if (k === "square-ring" || k === "buckle") {
      ctx.rect(-r, -r * 0.7, 2 * r, 1.4 * r);
    } else if (k === "zipper") {
      const half = ((hw.sizeMm || 180) / 2) * s;
      ctx.rect(-half, -4 * s, 2 * half, 8 * s);
    } else if (k === "plaque") {
      ctx.rect(-r, -r * 0.4, 2 * r, 0.8 * r);
    } else if (k.startsWith("turnlock")) {
      ctx.rect(-r * 0.6, -r * 0.4, 1.2 * r, 0.8 * r);
    } else {
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (sel || s > 2.5) {
      ctx.fillStyle = sel ? OXBLOOD : "rgba(43,29,14,0.7)";
      ctx.font = `italic ${Math.max(10, Math.min(13, 2.6 * s))}px 'EB Garamond', serif`;
      ctx.textAlign = "center";
      ctx.fillText(hw.label || k.replace(/-/g, " "), c.x, c.y + r + 12);
      ctx.textAlign = "left";
    }
  }
  void pc;
}

function drawEdgeHighlight(pc: Piece, cp: ComputedPiece, e: number, color: string, width: number): void {
  const pts = edgePoints(cp, e);
  if (pts.length < 2) return;
  path(pts, pc.position, false);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineCap = "butt";
}

function drawSelection(pc: Piece, cp: ComputedPiece): void {
  const sel = state.sel;
  if (sel.kind === "edge") {
    drawEdgeHighlight(pc, cp, sel.index, GOLD, 5);
    const ctrl = cp.controls[sel.index];
    if (ctrl) {
      const n = cp.vertices.length;
      const a = toScreen(addV(cp.vertices[sel.index], pc.position));
      const b = toScreen(addV(cp.vertices[(sel.index + 1) % n], pc.position));
      const c1 = toScreen(addV(ctrl[0], pc.position));
      const c2 = toScreen(addV(ctrl[1], pc.position));
      ctx.strokeStyle = OXBLOOD;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c1.x, c1.y);
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const c of [c1, c2]) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#f6ecd3";
        ctx.fill();
        ctx.strokeStyle = OXBLOOD;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
  drawEdgeInfo(pc, cp);
  cp.vertices.forEach((v, i) => {
    const p = toScreen(addV(v, pc.position));
    const active = sel.kind === "vertex" && sel.index === i;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = active ? OXBLOOD : GOLD;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.fillRect(-4, -4, 8, 8);
    ctx.strokeRect(-4, -4, 8, 8);
    ctx.restore();
  });
}

/** Where the middle of design edge `i` is drawn (world mm). */
function edgeMidWorld(pc: Piece, cp: ComputedPiece, i: number): V {
  return addV(toStaged(cp, edgeMiddle(pc, i)), pc.position);
}

/** The selected piece's edge lengths, and the round handle in the middle of each edge that bends it. */
function drawEdgeInfo(pc: Piece, cp: ComputedPiece): void {
  const n = pc.vertices.length;
  if (n !== cp.vertices.length) return;
  const sel = state.sel;
  const live = new Set<number>();
  if (drag && (drag.kind === "edge" || drag.kind === "bend") && drag.id === pc.id) live.add(drag.edge);
  if (drag?.kind === "vertex" && drag.id === pc.id) {
    live.add(drag.index);
    live.add((drag.index - 1 + n) % n);
  }
  if (sel.kind === "edge" && sel.piece === pc.id) live.add(sel.index);
  const centre = toScreen(addV({ x: (cp.bounds.min.x + cp.bounds.max.x) / 2, y: (cp.bounds.min.y + cp.bounds.max.y) / 2 }, pc.position));
  const size = simple() ? 15 : 13;
  for (let i = 0; i < n; i++) {
    const a = toScreen(addV(cp.vertices[i], pc.position));
    const b = toScreen(addV(cp.vertices[(i + 1) % n], pc.position));
    const m = toScreen(edgeMidWorld(pc, cp, i));
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const strong = live.has(i);
    // The bend handle.
    if (chord > 24) {
      ctx.beginPath();
      ctx.arc(m.x, m.y, strong ? 5.5 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(246,236,211,0.95)";
      ctx.fill();
      ctx.strokeStyle = strong ? OXBLOOD : GOLD;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    if (chord < 44 && !strong) continue;
    // The length, just outside the edge.
    let nx = -(b.y - a.y) / (chord || 1);
    let ny = (b.x - a.x) / (chord || 1);
    if ((m.x - centre.x) * nx + (m.y - centre.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const text = fmt(edgeLength(pc, i));
    ctx.font = `${strong ? 700 : 600} ${size}px 'EB Garamond', serif`;
    const tw = ctx.measureText(text).width;
    const off = 14 + Math.abs(nx) * (tw / 2) + Math.abs(ny) * (size / 2);
    const x = m.x + nx * off;
    const y = m.y + ny * off;
    ctx.fillStyle = strong ? "rgba(255,248,230,0.96)" : "rgba(255,248,230,0.8)";
    ctx.beginPath();
    ctx.roundRect(x - tw / 2 - 4, y - size / 2 - 3, tw + 8, size + 6, 4);
    ctx.fill();
    if (strong) {
      ctx.strokeStyle = OXBLOOD;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = strong ? OXBLOOD : "rgba(43,29,14,0.85)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
}

function drawJoins(): void {
  const comp = state.computed;
  if (!comp) return;
  for (const j of state.project.joins) {
    const rep = comp.joins.find((r) => r.id === j.id);
    const ends: V[] = [];
    for (const ref of [j.a, j.b]) {
      const pc = piece(ref.pieceId);
      const cp = computedPiece(ref.pieceId);
      if (!pc || !cp) continue;
      const pts = ref.edges.flatMap((e) => edgePoints(cp, e));
      ends.push(toScreen(addV(midpoint(pts), pc.position)));
    }
    if (ends.length !== 2) continue;
    const selected = state.sel.kind === "join" && state.sel.id === j.id;
    const color = rep?.ok ? OK : OXBLOOD;
    const [a, b] = ends;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const bend = Math.max(30, dist(a, b) * 0.25);
    ctx.strokeStyle = color;
    ctx.globalAlpha = selected ? 1 : 0.55;
    ctx.lineWidth = selected ? 2.4 : 1.4;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx + bend, my, b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of ends) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawFoldPreview(): void {
  if (state.tool !== "fold" || !hoverWorld) return;
  const hit = hitPiece(hoverWorld);
  if (!hit) return;
  const pc = piece(hit)!;
  const cp = computedPiece(hit)!;
  const b = cp.bounds;
  const local = { x: hoverWorld.x - pc.position.x, y: hoverWorld.y - pc.position.y };
  const horiz = state.foldOrientation === "horizontal";
  const c = foldSnap(horiz ? local.y : local.x, horiz ? pc.position.y : pc.position.x, mods);
  const seg: V[] = horiz ? [{ x: b.min.x, y: c }, { x: b.max.x, y: c }] : [{ x: c, y: b.min.y }, { x: c, y: b.max.y }];
  path(seg, pc.position, false);
  ctx.strokeStyle = OXBLOOD;
  ctx.setLineDash([10, 3, 2, 3]);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function draw(): void {
  if (!ctx || !state.project) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr;
  const h = cv.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground(w, h);
  const comp = state.computed;
  if (!comp) return;
  const selId = isMulti() ? null : selectedPieceId();
  const selected = new Set(selectedPieceIds());
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (cp) drawPiece(pc, cp, selected.has(pc.id));
  }
  drawJoins();
  if (hover) {
    const pc = piece(hover.piece);
    const cp = computedPiece(hover.piece);
    if (pc && cp) drawEdgeHighlight(pc, cp, hover.edge, "rgba(176,138,62,0.75)", 4);
  }
  if (state.joinPending) {
    const pc = piece(state.joinPending.piece);
    const cp = computedPiece(state.joinPending.piece);
    if (pc && cp) drawEdgeHighlight(pc, cp, state.joinPending.edge, OXBLOOD, 5);
  }
  if (selId) {
    const pc = piece(selId);
    const cp = computedPiece(selId);
    if (pc && cp) drawSelection(pc, cp);
  }
  drawFoldPreview();
  drawMeasure();
  drawToolingDraft();
  drawBox();
  if (drag && editHit) drawSnapHit(ctx, editHit, toScreen, simple());
  paintDraw();
  drawScaleBar(w, h);
  placeEdgeBox();
}

function drawScaleBar(_w: number, h: number): void {
  const inch = state.project.units === "in";
  const unit = inch ? 25.4 : 10;
  let n = 1;
  while (n * unit * view.scale < 60) n *= inch ? 2 : 5;
  const len = n * unit * view.scale;
  const x = 18;
  const y = h - 22;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + len, y);
  ctx.lineTo(x + len, y - 5);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = "italic 13px 'EB Garamond', serif";
  ctx.fillText(inch ? `${n} in` : `${n * 10} mm`, x + len + 8, y + 4);
}

// ---------- hit testing ----------

function pointInPoly(p: V, poly: V[], off: V): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = addV(poly[i], off);
    const b = addV(poly[j], off);
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(p: V, a: V, b: V): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitPiece(w: V): string | null {
  for (const pc of [...state.project.pieces].reverse()) {
    const cp = computedPiece(pc.id);
    if (cp && pointInPoly(w, cp.cut, pc.position)) return pc.id;
  }
  return null;
}

function hitEdge(w: V, only?: string): { piece: string; edge: number } | null {
  const tol = 7 / view.scale;
  let best: { piece: string; edge: number; d: number } | null = null;
  for (const pc of state.project.pieces) {
    if (only && pc.id !== only) continue;
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    const m = cp.outline.length;
    for (let i = 0; i < m; i++) {
      const e = cp.outlineEdges[i];
      if (e === null) continue;
      const d = segDist(w, addV(cp.outline[i], pc.position), addV(cp.outline[(i + 1) % m], pc.position));
      if (d < tol && (!best || d < best.d)) best = { piece: pc.id, edge: e, d };
    }
  }
  return best ? { piece: best.piece, edge: best.edge } : null;
}

function hitHandle(w: V): { kind: "vertex"; index: number } | { kind: "ctrl"; edge: number; which: 0 | 1 } | { kind: "bend"; edge: number } | null {
  // Corner handles show (and grab) only with a single piece selected.
  const id = isMulti() ? null : selectedPieceId();
  if (!id) return null;
  const pc = piece(id)!;
  const cp = computedPiece(id);
  if (!cp) return null;
  const tol = 8 / view.scale;
  const sel = state.sel;
  if (sel.kind === "edge") {
    const c = cp.controls[sel.index];
    if (c) {
      for (const which of [0, 1] as const) if (dist(w, addV(c[which], pc.position)) < tol) return { kind: "ctrl", edge: sel.index, which };
    }
  }
  for (let i = 0; i < cp.vertices.length; i++) if (dist(w, addV(cp.vertices[i], pc.position)) < tol) return { kind: "vertex", index: i };
  // The round handle in the middle of each edge (shown on edges long enough to have one).
  if (cp.vertices.length === pc.vertices.length) {
    const n = pc.vertices.length;
    for (let i = 0; i < n; i++) {
      const chord = dist(cp.vertices[i], cp.vertices[(i + 1) % n]) * view.scale;
      if (chord > 24 && dist(w, edgeMidWorld(pc, cp, i)) < tol) return { kind: "bend", edge: i };
    }
  }
  return null;
}

function hitHardware(w: V): { piece: string; id: string } | null {
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    for (const hw of cp.hardware ?? []) {
      const r = Math.max(5, (hw.sizeMm || 10) / 2);
      if (dist(w, addV(hw.at, pc.position)) < Math.max(r, 8 / view.scale)) return { piece: pc.id, id: hw.id };
    }
  }
  return null;
}

function hitMark(w: V): { piece: string; id: string } | null {
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    for (const mk of cp.marks ?? []) {
      const d = { x: w.x - pc.position.x - mk.center.x, y: w.y - pc.position.y - mk.center.y };
      const a = (-(mk.angleDeg ?? 0) * Math.PI) / 180;
      const lx = d.x * Math.cos(a) - d.y * Math.sin(a);
      const ly = d.x * Math.sin(a) + d.y * Math.cos(a);
      if (Math.abs(lx) <= mk.size.x / 2 && Math.abs(ly) <= mk.size.y / 2) return { piece: pc.id, id: mk.id };
    }
  }
  return null;
}

function hitHole(w: V): { piece: string; id: string } | null {
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    for (const h of cp.holes) {
      // Holes that hardware or perforation make are edited through their owner.
      if (h.id.includes("#")) continue;
      if (dist(w, addV(h.center, pc.position)) < Math.max(h.diameterMm / 2, 7 / view.scale)) return { piece: pc.id, id: h.id };
    }
  }
  return null;
}

function hitFold(w: V): { piece: string; id: string } | null {
  const tol = 6 / view.scale;
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    for (const f of cp.folds) {
      for (const seg of f.center) if (segDist(w, addV(seg[0], pc.position), addV(seg[1], pc.position)) < tol) return { piece: pc.id, id: f.id };
    }
  }
  return null;
}

// ---------- interaction ----------

function eventWorld(e: MouseEvent): V {
  const r = cv.getBoundingClientRect();
  return toWorld(e.clientX - r.left, e.clientY - r.top);
}

/** Right-click (marking menu): select what is under a screen point, as a click would but without
 * dragging, and say what it is. A piece inside a multi-selection keeps the multi-selection. */
export function selectAt(clientX: number, clientY: number): "piece" | "multi" | "edge" | "vertex" | "hole" | "fold" | "hardware" | "none" {
  const w = eventWorld({ clientX, clientY } as MouseEvent);
  const id = selectedPieceId();
  const hd = hitHandle(w);
  const hw = hitHardware(w);
  const hole = hitHole(w);
  const fold = hitFold(w);
  const edge = hitEdge(w);
  const pid = hitPiece(w);
  let kind: ReturnType<typeof selectAt> = "none";
  if (hd && id && hd.kind === "vertex") (state.sel = { kind: "vertex", piece: id, index: hd.index }), (kind = "vertex");
  else if (hw) (state.sel = { kind: "hardware", piece: hw.piece, id: hw.id }), (kind = "hardware");
  else if (hole) (state.sel = { kind: "hole", piece: hole.piece, id: hole.id }), (kind = "hole");
  else if (fold) (state.sel = { kind: "fold", piece: fold.piece, id: fold.id }), (kind = "fold");
  else if (edge) (state.sel = { kind: "edge", piece: edge.piece, index: edge.edge }), (kind = "edge");
  else if (pid && isMulti() && selectedPieceIds().includes(pid)) kind = "multi";
  else if (pid) (state.sel = { kind: "piece", piece: pid }), (kind = "piece");
  else state.sel = { kind: "none" };
  notify();
  return kind;
}

/** Alt: free to 0.01 mm. Grid snap on (and no Shift): the snap grid. Otherwise half a millimetre (1/32 in). */
function snap(v: number, e: Mods): number {
  if (e.altKey) return Math.round(v * 100) / 100;
  if (gridOn(e)) return Math.round(v / grid.gridMm) * grid.gridMm;
  const step = snapStep(state.project.units);
  return Math.round(v / step) * step;
}

function onDown(e: MouseEvent): void {
  cv.focus();
  const w = eventWorld(e);
  if (e.button === 1 || e.button === 2 || spaceDown) {
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
    return;
  }
  if (e.button !== 0) return;
  if (state.tool === "tooling") {
    toolingDown(w, e);
    return;
  }
  if (drawing()) {
    drawDown(w, e);
    return;
  }
  if (state.tool === "measure") {
    const p = snapToFeature(w);
    measure = { a: p, b: p, active: true };
    requestDraw();
    return;
  }
  if (state.tool === "hardware" || state.tool === "mark") {
    const id = hitPiece(w);
    if (!id) return;
    const pc = piece(id)!;
    const d = toDesign(computedPiece(id), { x: w.x - pc.position.x, y: w.y - pc.position.y });
    const at = snapLocal(d, pc.position, e);
    if (state.tool === "hardware") {
      const hid = uid("hw");
      edit(() => (pc.hardware = [...(pc.hardware ?? []), { id: hid, kind: placing.kind, at, angleDeg: 0, sizeMm: 0 }]));
      state.sel = { kind: "hardware", piece: id, id: hid };
    } else {
      const mid = uid("mk");
      const m = placing.mark;
      edit(() => (pc.marks = [...(pc.marks ?? []), { id: mid, kind: m.kind, center: at, size: { ...m.size }, angleDeg: 0, text: m.text, pattern: m.pattern }]));
      state.sel = { kind: "mark", piece: id, id: mid };
    }
    notify();
    return;
  }
  if (state.tool === "hole" || state.tool === "fold") {
    const id = hitPiece(w);
    if (!id) return;
    const pc = piece(id)!;
    const d = toDesign(computedPiece(id), { x: w.x - pc.position.x, y: w.y - pc.position.y });
    if (state.tool === "hole") {
      const hid = uid("h");
      const hw = placing.hardware;
      edit(() => pc.holes.push({ id: hid, center: snapLocal(d, pc.position, e), diameterMm: hw?.diameterMm ?? 3, label: hw?.label ?? "", lengthMm: hw?.lengthMm ?? 0, angleDeg: 0 }));
      state.sel = { kind: "hole", piece: id, id: hid };
    } else {
      const fid = uid("f");
      const horiz = state.foldOrientation === "horizontal";
      edit(() => pc.folds.push({ id: fid, orientation: state.foldOrientation, position: foldSnap(horiz ? d.y : d.x, horiz ? pc.position.y : pc.position.x, e), contentsMm: 0 }));
      state.sel = { kind: "fold", piece: id, id: fid };
      state.tool = "select";
    }
    notify();
    return;
  }
  if (state.tool === "join") {
    const hit = hitEdge(w);
    if (!hit) return;
    if (!state.joinPending) {
      state.joinPending = hit;
      setStatus("Now click the edge it sews to.");
    } else {
      const a = state.joinPending;
      if (a.piece === hit.piece && a.edge === hit.edge) return;
      const jid = uid("j");
      edit((p) => p.joins.push({ id: jid, a: { pieceId: a.piece, edges: [a.edge] }, b: { pieceId: hit.piece, edges: [hit.edge] } }));
      state.joinPending = null;
      state.sel = { kind: "join", id: jid };
      setStatus("Joined. The inspector shows whether the two sides match.");
    }
    notify();
    return;
  }
  // Select tool. Shift or Ctrl+click adds a piece to the selection or takes it out (then drags
  // the selection); on empty paper it starts a drag box that adds to the selection.
  const picked = selectedPieceIds();
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    const pid = hitPiece(w);
    if (pid) {
      const next = picked.includes(pid) ? picked.filter((x) => x !== pid) : [...picked, pid];
      selectPieces(next);
      if (next.includes(pid)) dragPieces(pid, next, w);
    } else {
      drag = { kind: "box", a: w, b: w, base: picked };
    }
    notify();
    return;
  }
  // With several pieces selected, grabbing any of them moves them all.
  if (picked.length > 1) {
    const pid = hitPiece(w);
    if (pid && picked.includes(pid)) {
      dragPieces(pid, picked, w);
      notify();
      return;
    }
  }
  const h = hitHandle(w);
  const id = selectedPieceId();
  if (h && id) {
    const pc = piece(id)!;
    if (h.kind === "vertex") {
      state.sel = { kind: "vertex", piece: id, index: h.index };
      drag = { kind: "vertex", id, index: h.index, start: w, orig: { ...pc.vertices[h.index] }, moved: false };
    } else if (h.kind === "bend") {
      state.sel = { kind: "edge", piece: id, index: h.edge };
      drag = { kind: "bend", id, edge: h.edge, start: w, orig: JSON.parse(JSON.stringify(pc.edges[h.edge])), moved: false };
      setStatus("Drag the round handle to bend this edge into a curve. Drag it back to make it straight again.");
    } else {
      const edge = pc.edges[h.edge];
      if (edge.type === "cubic") {
        drag = { kind: "ctrl", id, edge: h.edge, which: h.which, start: w, orig: { ...(h.which === 0 ? edge.c1 : edge.c2) }, moved: false };
      }
    }
    notify();
    return;
  }
  const hw = hitHardware(w);
  if (hw) {
    state.sel = { kind: "hardware", piece: hw.piece, id: hw.id };
    const x = piece(hw.piece)!.hardware!.find((q) => q.id === hw.id)!;
    drag = { kind: "hardware", id: hw.piece, hid: hw.id, start: w, orig: { ...x.at }, moved: false };
    notify();
    return;
  }
  const hole = hitHole(w);
  if (hole) {
    state.sel = { kind: "hole", piece: hole.piece, id: hole.id };
    const hd = piece(hole.piece)!.holes.find((x) => x.id === hole.id)!;
    drag = { kind: "hole", id: hole.piece, hid: hole.id, start: w, orig: { ...hd.center }, moved: false };
    notify();
    return;
  }
  // Tooling: clickable directly while the Tooling panel is open, otherwise once its piece is selected.
  const ts = hitStroke(w);
  if (ts && (toolingOpen() || selectedPieceId() === ts.piece)) {
    state.sel = { kind: "tooling", piece: ts.piece, id: ts.id };
    const cur = selectedStrokes();
    if (cur) drag = { kind: "tooling", id: ts.piece, sids: cur.group.map((x) => x.id), start: w, origs: cur.group.map((x) => x.points.map((q) => ({ ...q }))), moved: false };
    notify();
    return;
  }
  const mark = hitMark(w);
  if (mark) {
    const pcm = piece(mark.piece)!;
    // A click inside a mark selects the mark only when that piece is already selected; otherwise
    // it selects (and drags) the piece as usual.
    if (selectedPieceId() === mark.piece || state.sel.kind === "mark") {
      state.sel = { kind: "mark", piece: mark.piece, id: mark.id };
      const x = pcm.marks!.find((q) => q.id === mark.id)!;
      drag = { kind: "mark", id: mark.piece, mid: mark.id, start: w, orig: { ...x.center }, moved: false };
      notify();
      return;
    }
  }
  const fold = hitFold(w);
  if (fold) {
    state.sel = { kind: "fold", piece: fold.piece, id: fold.id };
    const fd = piece(fold.piece)!.folds.find((x) => x.id === fold.id)!;
    drag = { kind: "fold", id: fold.piece, fid: fold.id, start: w, orig: fd.position, moved: false };
    notify();
    return;
  }
  if (id) {
    const edge = hitEdge(w, id);
    if (edge) {
      // Click selects the edge (and shows its length box); dragging moves the whole edge.
      state.sel = { kind: "edge", piece: id, index: edge.edge };
      drag = { kind: "edge", id, edge: edge.edge, start: w, orig: outlineCopy(piece(id)!), moved: false };
      notify();
      return;
    }
  }
  const pid = hitPiece(w);
  if (pid) {
    state.sel = { kind: "piece", piece: pid };
    dragPieces(pid, [pid], w);
  } else {
    // Empty paper: clear the selection and start a drag box.
    state.sel = { kind: "none" };
    drag = { kind: "box", a: w, b: w, base: [] };
  }
  notify();
}

/** Start moving `ids` with the mouse; `lead` (the piece grabbed) is the one that snaps. */
function dragPieces(lead: string, ids: string[], w: V): void {
  const order = [lead, ...ids.filter((x) => x !== lead)].filter((x) => !!piece(x));
  drag = { kind: "pieces", ids: order, start: w, origs: order.map((x) => ({ ...piece(x)!.position })), moved: false };
}

/** Pieces whose outline (as drawn) touches the box between two world points. */
function piecesInBox(a: V, b: V): string[] {
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
  const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
  return state.project.pieces
    .filter((pc) => {
      const cp = computedPiece(pc.id);
      return !!cp && polygonTouchesBox(cp.cut.map((p) => addV(p, pc.position)), min, max);
    })
    .map((pc) => pc.id);
}

function drawBox(): void {
  if (drag?.kind !== "box") return;
  const a = toScreen(drag.a);
  const b = toScreen(drag.b);
  if (Math.hypot(b.x - a.x, b.y - a.y) < 3) return;
  ctx.fillStyle = "rgba(176,138,62,0.10)";
  ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  ctx.strokeStyle = OXBLOOD;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  ctx.setLineDash([]);
}

function onMove(e: MouseEvent): void {
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  const w = eventWorld(e);
  mods = { shiftKey: e.shiftKey, altKey: e.altKey };
  if (measure?.active) {
    measure.b = e.shiftKey ? w : snapToFeature(w);
    requestDraw();
    return;
  }
  if (drawing() && drag?.kind !== "pan") {
    if (inside || e.buttons) drawMove(w, e);
    cv.style.cursor = spaceDown ? "grab" : "crosshair";
    return;
  }
  if (state.tool === "tooling" && (tdraft || tbox)) {
    hoverWorld = w;
    if (tbox) tbox.b = w;
    if (tdraft?.down) {
      const pc = piece(tdraft.piece);
      const sa = toScreen(tdraft.down);
      const sb = toScreen(w);
      // Moving with the button held (from the first point) draws freehand.
      if (!tdraft.free && tdraft.pts.length === 1 && Math.hypot(sb.x - sa.x, sb.y - sa.y) > 4) tdraft.free = true;
      if (tdraft.free && pc) {
        const p = rawLocal(pc, w);
        if (dist(p, tdraft.pts[tdraft.pts.length - 1]) * view.scale > 1.5) tdraft.pts.push(p);
      }
    }
    requestDraw();
    return;
  }
  if (!drag) {
    hoverWorld = inside ? w : null;
    const prev = hover;
    if (!inside) hover = null;
    else if (state.tool === "join") hover = hitEdge(w);
    else if (state.tool === "select" && selectedPieceId() && !isMulti()) hover = hitEdge(w, selectedPieceId()!);
    else hover = null;
    if (prev?.piece !== hover?.piece || prev?.edge !== hover?.edge || state.tool === "fold") requestDraw();
    const handle = inside && state.tool === "select" ? hitHandle(w) : null;
    cv.style.cursor = spaceDown ? "grab" : state.tool === "select" ? (handle?.kind === "bend" ? "grab" : handle ? "move" : hover ? "move" : "default") : "crosshair";
    return;
  }
  if (drag.kind === "pan") {
    view.ox = drag.ox + (e.clientX - drag.sx);
    view.oy = drag.oy + (e.clientY - drag.sy);
    requestDraw();
    return;
  }
  if (drag.kind === "box") {
    drag.b = w;
    requestDraw();
    return;
  }
  const dx = w.x - drag.start.x;
  const dy = w.y - drag.start.y;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) * view.scale < 3) return;
    drag.moved = true;
    snapshot();
  }
  if (drag.kind === "pieces") {
    // The grabbed piece snaps; the others keep their places relative to it.
    const origs = drag.origs;
    const lead = { x: snap(origs[0].x + dx, e), y: snap(origs[0].y + dy, e) };
    const d = { x: lead.x - origs[0].x, y: lead.y - origs[0].y };
    // Smart snap: a corner of the grabbed piece meets or lines up with another piece's corner.
    editHit = null;
    const cpl = computedPiece(drag.ids[0]);
    if (cpl && !e.altKey && !e.shiftKey) {
      const corners = cpl.vertices.map((v) => ({ x: v.x + origs[0].x + dx, y: v.y + origs[0].y + dy }));
      const m = snapMove(corners, drag.ids, view.scale);
      if (m) {
        d.x = dx + m.d.x;
        d.y = dy + m.d.y;
        if (m.d.x === 0) d.x = lead.x - origs[0].x;
        if (m.d.y === 0) d.y = lead.y - origs[0].y;
        editHit = m.hit;
      }
    }
    drag.ids.forEach((id, k) => {
      const pc = piece(id);
      if (pc) pc.position = addV(origs[k], d);
    });
    notify();
    return;
  }
  const pc = piece(drag.id);
  if (!pc) return;
  const at = (orig: V): V => snapLocal({ x: orig.x + dx, y: orig.y + dy }, pc.position, e);
  switch (drag.kind) {
    case "vertex": {
      const cp = computedPiece(pc.id);
      const n = pc.vertices.length;
      const k = drag.index;
      // Smart snap in world mm: other pieces' corners and edges, lining up with this piece's own
      // corners, 15 degree steps from the corner before it (Shift), the same length as another edge.
      const world = (q: V) => addV(toStaged(cp, q), pc.position);
      const others = pc.vertices.map((v, j) => (j === k ? null : world(v))).filter((v): v is V => !!v);
      const prevV = world(pc.vertices[(k - 1 + n) % n]);
      const lengths = pc.edges.map((ed, j) => ({ ed, j })).filter(({ j }) => j !== k && j !== (k - 1 + n) % n).map(({ ed, j }) => ({ len: segmentLength(pc.vertices[j], pc.vertices[(j + 1) % n], ed), a: world(pc.vertices[j]), b: world(pc.vertices[(j + 1) % n]) }));
      const raw = world({ x: drag.orig.x + dx, y: drag.orig.y + dy });
      editHit = smartSnap(raw, { scale: view.scale, shift: e.shiftKey, alt: e.altKey, from: prevV, own: others, skip: pc.id, lengths });
      pc.vertices[k] = toDesign(cp, { x: editHit.p.x - pc.position.x, y: editHit.p.y - pc.position.y });
      break;
    }
    case "edge": {
      // The edge's start snaps; its end keeps the same offset.
      const cp = computedPiece(pc.id);
      const n = drag.orig.vertices.length;
      const world = (q: V) => addV(toStaged(cp, q), pc.position);
      const ei = drag.edge;
      const a0 = drag.orig.vertices[ei];
      const others = drag.orig.vertices.map((v, j) => (j === ei || j === (ei + 1) % n ? null : world(v))).filter((v): v is V => !!v);
      editHit = smartSnap(world({ x: a0.x + dx, y: a0.y + dy }), { scale: view.scale, shift: false, alt: e.altKey, own: others, skip: pc.id });
      const to = toDesign(cp, { x: editHit.p.x - pc.position.x, y: editHit.p.y - pc.position.y });
      moveEdge(pc, drag.edge, drag.orig, { x: to.x - a0.x, y: to.y - a0.y });
      break;
    }
    case "bend":
      editHit = null;
      bendEdge(pc, drag.edge, drag.orig, { x: e.altKey ? dx : snap(dx, { shiftKey: true, altKey: false }), y: e.altKey ? dy : snap(dy, { shiftKey: true, altKey: false }) });
      break;
    case "ctrl": {
      const edge = pc.edges[drag.edge];
      if (edge.type !== "cubic") return;
      const p = at(drag.orig);
      if (drag.which === 0) edge.c1 = p;
      else edge.c2 = p;
      break;
    }
    case "hole": {
      const hd = pc.holes.find((x) => x.id === (drag as { hid: string }).hid);
      if (hd) hd.center = at(drag.orig);
      break;
    }
    case "fold": {
      const fd = pc.folds.find((x) => x.id === (drag as { fid: string }).fid);
      if (fd) {
        const horiz = fd.orientation === "horizontal";
        fd.position = foldSnap(drag.orig + (horiz ? dy : dx), horiz ? pc.position.y : pc.position.x, e);
      }
      break;
    }
    case "hardware": {
      const x = (pc.hardware ?? []).find((q) => q.id === (drag as { hid: string }).hid);
      if (x) x.at = at(drag.orig);
      break;
    }
    case "mark": {
      const x = (pc.marks ?? []).find((q) => q.id === (drag as { mid: string }).mid);
      if (x) x.center = at(drag.orig);
      break;
    }
    case "tooling": {
      // The first point snaps; the rest of the line (or design) keeps its shape.
      const o = drag.origs[0]?.[0];
      if (!o) break;
      const lead = at(o);
      const d = { x: lead.x - o.x, y: lead.y - o.y };
      const sids = drag.sids;
      const origs = drag.origs;
      for (const st of pc.tooling ?? []) {
        const k = sids.indexOf(st.id);
        if (k >= 0) st.points = origs[k].map((q) => addV(q, d));
      }
      break;
    }
  }
  changed();
}

function onUp(): void {
  if (editHit) {
    editHit = null;
    requestDraw();
  }
  if (drawing() && drag?.kind !== "pan") {
    drag = null;
    drawUp();
    return;
  }
  if (drag && (drag.kind === "edge" || drag.kind === "bend") && drag.moved) {
    const pc = piece(drag.id);
    if (pc) setStatus(drag.kind === "bend" ? `Edge bent; it is now ${fmt(edgeLength(pc, drag.edge))} long. Drag the round handle back to straighten it.` : `Edge moved. Its length is ${fmt(edgeLength(pc, drag.edge))}.`);
  }
  if (drag?.kind === "box") {
    const box = drag;
    drag = null;
    const a = toScreen(box.a);
    const b = toScreen(box.b);
    if (Math.hypot(b.x - a.x, b.y - a.y) >= 3) {
      const hits = piecesInBox(box.a, box.b);
      selectPieces([...box.base, ...hits.filter((x) => !box.base.includes(x))]);
      notify();
      const n = selectedPieceIds().length;
      setStatus(n > 1 ? `${n} pieces selected. Drag one to move them all; Shift+click adds or removes a piece.` : n ? "1 piece selected." : "Nothing in the box.");
    }
    requestDraw();
    return;
  }
  drag = null;
  if (tbox) {
    finishBox();
    return;
  }
  if (tdraft?.down) {
    if (tdraft.free) finishDraft(false);
    else {
      tdraft.down = null;
      setStatus("Click the next point. Double-click (or press Enter) to finish; click the first point to close the shape.");
    }
    return;
  }
  if (measure?.active) {
    measure.active = false;
    const d = dist(measure.a, measure.b);
    setStatus(`Measured ${d.toFixed(1)} mm (${(d / 25.4).toFixed(3)} in). Drag again to measure something else.`);
  }
}

export function clearMeasure(): void {
  measure = null;
  requestDraw();
}

function onDouble(e: MouseEvent): void {
  if (state.tool === "tooling") {
    if (tdraft && !tdraft.free) {
      // The double-click's second press added a point on top of the last one.
      const n = tdraft.pts.length;
      const pc = piece(tdraft.piece);
      if (pc && n >= 2) {
        const a = toScreen(addV(tdraft.pts[n - 1], pc.position));
        const b = toScreen(addV(tdraft.pts[n - 2], pc.position));
        if (Math.hypot(a.x - b.x, a.y - b.y) < 8) tdraft.pts.pop();
      }
      finishDraft(false);
    }
    return;
  }
  if (drawing()) {
    drawDouble();
    return;
  }
  const id = selectedPieceId();
  if (!id || state.tool !== "select" || isMulti()) return;
  const w = eventWorld(e);
  const hit = hitEdge(w, id);
  if (!hit) return;
  const pc = piece(id)!;
  const d = toDesign(computedPiece(id), { x: w.x - pc.position.x, y: w.y - pc.position.y });
  let idx = 0;
  edit((p) => (idx = insertVertex(p, pc, hit.edge, d)));
  state.sel = { kind: "vertex", piece: id, index: idx };
  setStatus("Added a corner. Drag it, or press Delete to remove it.");
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  const before = toWorld(sx, sy);
  const factor = Math.exp(-e.deltaY * 0.0015);
  view.scale = Math.min(60, Math.max(0.2, view.scale * factor));
  view.ox = sx - before.x * view.scale;
  view.oy = sy - before.y * view.scale;
  requestDraw();
}
