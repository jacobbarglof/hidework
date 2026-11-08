// Smart snapping for the 2D pattern window: while drawing or reshaping a piece, the pointer is
// pulled to other pieces' corners, the middles of their edges and the edges themselves, lines up
// with points level or straight above (with a guide line, as in Figma), keeps to 15 degree steps
// while Shift is held, and offers the same length as another edge. Every snap shows a small
// marker and a word, so it is never a surprise. Smart snap turns off with one button (F10); Alt
// always places freely. Grid snap (F9) still applies when nothing else catches.

import { snap as grid } from "./editing";
import { dist, edgePoints, midpoint } from "./ops";
import { computedPiece, state } from "./store";
import { snapStep } from "./units";
import type { V } from "./types";

const KEY = "hidework.smartSnap";

/** Whether smart snapping is on (remembered on this computer). */
export const smart = { on: true };

try {
  const v = localStorage.getItem(KEY);
  if (v === "0") smart.on = false;
} catch {
  /* storage unavailable: keep it on */
}

export function setSmartSnap(on: boolean): void {
  smart.on = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

export type SnapKind = "corner" | "middle" | "edge" | "first" | "centre" | "align" | "angle" | "length" | "square" | "grid";

export interface SnapHit {
  /** Where the point goes (world mm). */
  p: V;
  kind: SnapKind | null;
  /** The word shown beside the marker. */
  word: string;
  /** Dashed guide lines to draw (world mm). */
  guides: [V, V][];
  /** Edges that came out the same length, for tick marks (world mm). */
  same: [V, V][];
}

export interface SnapOptions {
  /** Pixels per mm. */
  scale: number;
  shift: boolean;
  alt: boolean;
  /** The point the new one is measured from (for 15 degree steps and same-length hints). */
  from?: V | null;
  /** The first point of an outline being drawn: snapping to it closes the shape. */
  first?: V | null;
  /** Points of the shape being drawn or edited (snap and line up with them too). */
  own?: V[];
  /** A piece to leave out of the corner and edge targets (the one being edited). */
  skip?: string | null;
  /** Lengths that the new edge (from `from`) may match, each with the edge it came from. */
  lengths?: { len: number; a: V; b: V }[];
  /** A vertical centre line at this x (mirror drawing). */
  axis?: number | null;
}

const PX_POINT = 10;
const PX_EDGE = 7;
const PX_ALIGN = 6;
const PX_LENGTH = 6;

/** Corners and edge middles of every piece (world mm). */
function targets(skip: string | null | undefined): { corners: V[]; middles: V[]; segs: [V, V][] } {
  const corners: V[] = [];
  const middles: V[] = [];
  const segs: [V, V][] = [];
  for (const pc of state.project.pieces) {
    if (pc.id === skip) continue;
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    const off = pc.position;
    for (const v of cp.vertices) corners.push({ x: v.x + off.x, y: v.y + off.y });
    for (let e = 0; e < cp.vertices.length; e++) {
      const pts = edgePoints(cp, e);
      if (pts.length > 1) {
        const m = midpoint(pts);
        middles.push({ x: m.x + off.x, y: m.y + off.y });
      }
    }
    const m = cp.cut.length;
    for (let i = 0; i < m; i++) {
      const a = cp.cut[i];
      const b = cp.cut[(i + 1) % m];
      segs.push([{ x: a.x + off.x, y: a.y + off.y }, { x: b.x + off.x, y: b.y + off.y }]);
    }
  }
  return { corners, middles, segs };
}

function nearestOnSeg(p: V, a: V, b: V): V {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Round one coordinate: to the grid when grid snap is on, otherwise to half a millimetre (1/32 in). */
function round(v: number): number {
  if (grid.on) return Math.round(v / grid.gridMm) * grid.gridMm;
  const step = snapStep(state.project.units);
  return Math.round(v / step) * step;
}

const none = (p: V): SnapHit => ({ p, kind: null, word: "", guides: [], same: [] });

/** Where a point goes once snapped, and what caught it. */
export function smartSnap(raw: V, o: SnapOptions): SnapHit {
  if (o.alt) return none({ x: Math.round(raw.x * 100) / 100, y: Math.round(raw.y * 100) / 100 });
  const tol = (px: number) => px / o.scale;
  if (!smart.on) {
    if (o.first && dist(raw, o.first) < tol(PX_POINT)) return { ...none(o.first), kind: "first", word: "close the shape" };
    if (o.shift && o.from) return angleSnap(raw, o);
    return { ...none({ x: round(raw.x), y: round(raw.y) }), kind: grid.on ? "grid" : null, word: grid.on ? "grid" : "" };
  }
  // 1. Points: the first point (closes the shape), own points, other pieces' corners and edge middles.
  if (o.first && dist(raw, o.first) < tol(PX_POINT)) return { ...none(o.first), kind: "first", word: "close the shape" };
  const t = targets(o.skip);
  let best: { p: V; kind: SnapKind; d: number } | null = null;
  const consider = (list: V[], kind: SnapKind) => {
    for (const q of list) {
      const d = dist(raw, q);
      if (d < tol(PX_POINT) && (!best || d < best.d)) best = { p: q, kind, d };
    }
  };
  consider(o.own ?? [], "corner");
  consider(t.corners, "corner");
  if (!best) consider(t.middles, "middle");
  if (best) {
    const b = best as { p: V; kind: SnapKind };
    return { ...none({ ...b.p }), kind: b.kind, word: b.kind === "corner" ? "corner" : "middle of edge" };
  }
  // 2. The centre line of a mirrored piece.
  if (o.axis !== undefined && o.axis !== null && Math.abs(raw.x - o.axis) < tol(PX_POINT)) {
    return { ...none({ x: o.axis, y: round(raw.y) }), kind: "centre", word: "centre line" };
  }
  // 3. Shift: 15 degree steps from the last point.
  if (o.shift && o.from) return angleSnap(raw, o);
  // 4. On another piece's edge.
  let edge: { p: V; d: number } | null = null;
  for (const [a, b] of t.segs) {
    const q = nearestOnSeg(raw, a, b);
    const d = dist(raw, q);
    if (d < tol(PX_EDGE) && (!edge || d < edge.d)) edge = { p: q, d };
  }
  if (edge) return { ...none(edge.p), kind: "edge", word: "on the edge" };
  // 5. Lined up with a point level with it or straight above or below it.
  const refs = [...(o.own ?? []), ...t.corners];
  let ax: V | null = null;
  let ay: V | null = null;
  for (const q of refs) {
    if (Math.abs(q.x - raw.x) < tol(PX_ALIGN) && (!ax || Math.abs(q.x - raw.x) < Math.abs(ax.x - raw.x))) ax = q;
    if (Math.abs(q.y - raw.y) < tol(PX_ALIGN) && (!ay || Math.abs(q.y - raw.y) < Math.abs(ay.y - raw.y))) ay = q;
  }
  const p = { x: ax ? ax.x : round(raw.x), y: ay ? ay.y : round(raw.y) };
  const guides: [V, V][] = [];
  if (ax) guides.push([ax, p]);
  if (ay) guides.push([ay, p]);
  if (ax || ay) return { p, kind: "align", word: ax && ay ? "lined up both ways" : ax ? "lined up above or below" : "lined up level", guides, same: [] };
  // 6. The same length as another edge.
  const sameLen = lengthSnap(p, o);
  if (sameLen) return sameLen;
  return { ...none(p), kind: grid.on ? "grid" : null, word: grid.on ? "grid" : "" };
}

function angleSnap(raw: V, o: SnapOptions): SnapHit {
  const from = o.from!;
  const d = Math.hypot(raw.x - from.x, raw.y - from.y);
  const a = Math.atan2(raw.y - from.y, raw.x - from.x);
  const step = Math.PI / 12;
  const sa = Math.round(a / step) * step;
  const len = grid.on ? Math.round(d / grid.gridMm) * grid.gridMm : Math.round(d / snapStep(state.project.units)) * snapStep(state.project.units);
  const p = { x: from.x + Math.cos(sa) * len, y: from.y + Math.sin(sa) * len };
  let deg = Math.round((-sa * 180) / Math.PI);
  deg = ((deg % 360) + 360) % 360;
  const hit: SnapHit = { p, kind: "angle", word: `${deg}°`, guides: [[from, { x: from.x + Math.cos(sa) * (len + 40 / o.scale), y: from.y + Math.sin(sa) * (len + 40 / o.scale) }]], same: [] };
  const sameLen = lengthSnap(p, o);
  if (sameLen) return { ...sameLen, kind: "angle", word: `${deg}°, same length`, guides: hit.guides };
  return hit;
}

/** If the edge from `o.from` to `p` is nearly as long as one of `o.lengths`, make it exactly that long. */
function lengthSnap(p: V, o: SnapOptions): SnapHit | null {
  if (!o.from || !o.lengths?.length) return null;
  const from = o.from;
  const d = dist(from, p);
  if (d < 1e-6) return null;
  let best: { len: number; a: V; b: V } | null = null;
  for (const L of o.lengths) {
    if (Math.abs(L.len - d) * o.scale < PX_LENGTH && (!best || Math.abs(L.len - d) < Math.abs(best.len - d))) best = L;
  }
  if (!best) return null;
  const k = best.len / d;
  const q = { x: from.x + (p.x - from.x) * k, y: from.y + (p.y - from.y) * k };
  return { p: q, kind: "length", word: "same length", guides: [], same: [[best.a, best.b], [from, q]] };
}

/**
 * Snap a whole piece being moved: the corner (of `pts`, world mm) nearest another piece's corner,
 * or lined up with one. Returns the correction to add and what caught it, or null.
 */
export function snapMove(pts: V[], skip: string[], scale: number): { d: V; hit: SnapHit } | null {
  if (!smart.on || !pts.length) return null;
  const tolP = PX_POINT / scale;
  const tolA = PX_ALIGN / scale;
  const others: V[] = [];
  for (const pc of state.project.pieces) {
    if (skip.includes(pc.id)) continue;
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    for (const v of cp.vertices) others.push({ x: v.x + pc.position.x, y: v.y + pc.position.y });
  }
  if (!others.length) return null;
  let bp: { d: V; q: V; at: V; len: number } | null = null;
  for (const p of pts)
    for (const q of others) {
      const l = dist(p, q);
      if (l < tolP && (!bp || l < bp.len)) bp = { d: { x: q.x - p.x, y: q.y - p.y }, q, at: p, len: l };
    }
  if (bp) return { d: bp.d, hit: { p: bp.q, kind: "corner", word: "corner to corner", guides: [], same: [] } };
  let bx: { dx: number; p: V; q: V } | null = null;
  let by: { dy: number; p: V; q: V } | null = null;
  for (const p of pts)
    for (const q of others) {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      if (Math.abs(dx) < tolA && (!bx || Math.abs(dx) < Math.abs(bx.dx))) bx = { dx, p, q };
      if (Math.abs(dy) < tolA && (!by || Math.abs(dy) < Math.abs(by.dy))) by = { dy, p, q };
    }
  if (!bx && !by) return null;
  const d = { x: bx?.dx ?? 0, y: by?.dy ?? 0 };
  const guides: [V, V][] = [];
  if (bx) guides.push([bx.q, { x: bx.p.x + d.x, y: bx.p.y + d.y }]);
  if (by) guides.push([by.q, { x: by.p.x + d.x, y: by.p.y + d.y }]);
  const at = bx ? { x: bx.p.x + d.x, y: bx.p.y + d.y } : { x: by!.p.x + d.x, y: by!.p.y + d.y };
  return { d, hit: { p: at, kind: "align", word: bx && by ? "lined up both ways" : bx ? "lined up above or below" : "lined up level", guides, same: [] } };
}

// ---------- drawing the feedback ----------

/** Draw the marker, word and guides for a snap (`toScreen` maps world mm to canvas px). */
export function drawSnapHit(ctx: CanvasRenderingContext2D, hit: SnapHit | null, toScreen: (p: V) => V, big: boolean): void {
  if (!hit || !hit.kind) return;
  const GOLD = "#a87a1e";
  const RED = "#7a1f1a";
  ctx.save();
  // Guides.
  ctx.strokeStyle = "rgba(168,122,30,0.95)";
  ctx.lineWidth = 1.2;
  ctx.setLineDash([6, 4]);
  for (const [a, b] of hit.guides) {
    const p = toScreen(a);
    const q = toScreen(b);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // Same-length ticks: two short strokes across the middle of each edge.
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2;
  for (const [a, b] of hit.same) {
    const p = toScreen(a);
    const q = toScreen(b);
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const nx = -(q.y - p.y) / l;
    const ny = (q.x - p.x) / l;
    const tx = (q.x - p.x) / l;
    const ty = (q.y - p.y) / l;
    for (const s of [-3, 3]) {
      ctx.beginPath();
      ctx.moveTo(mx + tx * s - nx * 6, my + ty * s - ny * 6);
      ctx.lineTo(mx + tx * s + nx * 6, my + ty * s + ny * 6);
      ctx.stroke();
    }
  }
  // Marker.
  const s = toScreen(hit.p);
  ctx.lineWidth = 2;
  ctx.strokeStyle = hit.kind === "first" ? RED : GOLD;
  ctx.fillStyle = "rgba(255,248,230,0.85)";
  ctx.beginPath();
  if (hit.kind === "corner") ctx.rect(s.x - 6, s.y - 6, 12, 12);
  else if (hit.kind === "middle") {
    ctx.moveTo(s.x, s.y - 7);
    ctx.lineTo(s.x + 7, s.y + 5);
    ctx.lineTo(s.x - 7, s.y + 5);
    ctx.closePath();
  } else if (hit.kind === "edge") {
    ctx.moveTo(s.x - 6, s.y - 6);
    ctx.lineTo(s.x + 6, s.y + 6);
    ctx.moveTo(s.x + 6, s.y - 6);
    ctx.lineTo(s.x - 6, s.y + 6);
  } else if (hit.kind === "first") ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
  else if (hit.kind === "grid") {
    ctx.moveTo(s.x - 5, s.y);
    ctx.lineTo(s.x + 5, s.y);
    ctx.moveTo(s.x, s.y - 5);
    ctx.lineTo(s.x, s.y + 5);
  } else ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
  if (hit.kind !== "edge" && hit.kind !== "grid") ctx.fill();
  ctx.stroke();
  // Word.
  if (hit.word) {
    const size = big ? 16 : 13;
    ctx.font = `600 ${size}px 'EB Garamond', serif`;
    const w = ctx.measureText(hit.word).width;
    const x = s.x + 12;
    const y = s.y + 14;
    ctx.fillStyle = "rgba(255,248,230,0.94)";
    ctx.strokeStyle = hit.kind === "first" ? RED : GOLD;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - 5, y - size + 1, w + 10, size + 7, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = hit.kind === "first" ? RED : "#5a3f0e";
    ctx.fillText(hit.word, x, y + 2);
  }
  ctx.restore();
}
