// Corner and edge operations shared by the ribbon, the command line and the property editor:
// round the selected corner, add a dart to the selected edge. Also the geometry of the shapes the
// drawing tools make (ovals, slots, strap ends, outlines drawn point by point, mirrored halves) and
// of editing one edge (bend it, move it, give it an exact length or angle).

import { api } from "./api";
import { rectPiece, signedArea } from "./ops";
import { edit, notify, piece, setStatus, state, uid } from "./store";
import type { Edge, Piece, V } from "./types";

/** Round corner `i` of piece `id`. Seams keep pointing at the same edges. */
export async function roundCornerAt(id: string, i: number, radiusMm: number): Promise<boolean> {
  const pc = piece(id);
  if (!pc) return false;
  try {
    const next = await api.roundCorner(pc, i, radiusMm);
    edit((p) => {
      const k = p.pieces.findIndex((x) => x.id === id);
      p.pieces[k] = { ...next, id };
      // Edges after the corner moved up by one.
      for (const j of p.joins) for (const side of [j.a, j.b]) if (side.pieceId === id) side.edges = side.edges.map((e) => (e >= i ? e + 1 : e));
    });
    state.sel = { kind: "piece", piece: id };
    setStatus(`Corner rounded, ${radiusMm} mm radius.`);
    notify();
    return true;
  } catch (e) {
    setStatus(String(e));
    return false;
  }
}

/** Add a dart in the middle of straight edge `i`, with its two sides joined. */
export async function addDartAt(id: string, i: number, widthMm = 20, depthMm = 40): Promise<boolean> {
  const pc = piece(id);
  if (!pc || !pc.edges[i]) return false;
  if (pc.edges[i].type !== "line") {
    setStatus("Darts go on straight edges. Make this edge straight first (in its properties).");
    return false;
  }
  try {
    const [next, pair] = await api.addDart(pc, i, 0.5, widthMm, depthMm);
    edit((p) => {
      const k = p.pieces.findIndex((x) => x.id === id);
      p.pieces[k] = { ...next, id };
      // Three edges were inserted after this one.
      for (const j of p.joins) for (const side of [j.a, j.b]) if (side.pieceId === id) side.edges = side.edges.map((x) => (x > i ? x + 3 : x));
      p.joins.push({ id: uid("j"), a: { pieceId: id, edges: [pair[0]] }, b: { pieceId: id, edges: [pair[1]] } });
    });
    setStatus("Dart added and its two sides joined. Drag its points to shape it.");
    return true;
  } catch (e) {
    setStatus(String(e));
    return false;
  }
}

// ---------- shapes drawn on the canvas (pure geometry; no undo here) ----------

/** Bezier constant for a quarter circle. */
const K = 0.55228475;
const vadd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vsub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vmul = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s });
const vlerp = (a: V, b: V, t: number): V => vadd(a, vmul(vsub(b, a), t));
const line = (): Edge => ({ type: "line", stitched: false });
const curve = (c1: V, c2: V): Edge => ({ type: "cubic", c1, c2, stitched: false });

/** One clicked point of a freely drawn outline; `out` is the curve handle pulled out by dragging. */
export interface PenPoint {
  p: V;
  out?: V;
}

/** Put a piece's corner points in the same winding as a drawn rectangle, so stitching goes inside. */
function normalise(pc: Piece): Piece {
  if (signedArea(pc.vertices) >= 0) return pc;
  const n = pc.vertices.length;
  const verts = [pc.vertices[0], ...pc.vertices.slice(1).reverse()];
  // Old edge k ran from vertex k to k+1. In the new order, edge j runs from old vertex (n-j)%n
  // back to old vertex (n-j-1), which is old edge (n-j-1) walked backwards.
  const edges: Edge[] = [];
  for (let j = 0; j < n; j++) {
    const old = pc.edges[(n - j - 1 + n) % n];
    edges.push(old.type === "cubic" ? { ...old, c1: old.c2, c2: old.c1 } : old);
  }
  pc.vertices = verts;
  pc.edges = edges;
  return pc;
}

/** A piece from outline points given in world mm (the piece sits at their top-left corner). */
export function pieceFromOutline(verts: V[], edges: Edge[], name: string): Piece {
  const min = { x: Math.min(...verts.map((v) => v.x)), y: Math.min(...verts.map((v) => v.y)) };
  const local = (p: V): V => ({ x: +(p.x - min.x).toFixed(3), y: +(p.y - min.y).toFixed(3) });
  const pc = rectPiece(min, 1, 1, name);
  pc.vertices = verts.map(local);
  pc.edges = edges.map((e) => (e.type === "cubic" ? { ...e, c1: local(e.c1), c2: local(e.c2) } : e));
  return normalise(pc);
}

/** Edges through pen points (a closed loop when `closed`): curves wherever a point has a handle. */
export function penEdges(pts: PenPoint[], closed = true): Edge[] {
  const n = pts.length;
  const count = closed ? n : n - 1;
  const out: Edge[] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (!a.out && !b.out) out.push(line());
    else out.push(curve(a.out ? vadd(a.p, a.out) : vlerp(a.p, b.p, 1 / 3), b.out ? vsub(b.p, b.out) : vlerp(a.p, b.p, 2 / 3)));
  }
  return out;
}

/** A closed piece through pen points (world mm). */
export function penPiece(pts: PenPoint[], name = "Panel"): Piece {
  return pieceFromOutline(pts.map((q) => q.p), penEdges(pts), name);
}

/** The whole outline from one half drawn beside a centre line at x = `axis`: the half, then its mirror image back. */
export function mirrorOutline(half: PenPoint[], axis: number): PenPoint[] {
  const m = (p: V): V => ({ x: 2 * axis - p.x, y: p.y });
  const pts = half.map((q) => ({ p: { ...q.p }, out: q.out ? { ...q.out } : undefined }));
  // The first and last points sit on the centre line.
  pts[0].p.x = axis;
  pts[pts.length - 1].p.x = axis;
  const back: PenPoint[] = [];
  for (let i = pts.length - 2; i >= 1; i--) {
    const q = pts[i];
    // Walking back the other way the handle is mirrored and reversed: (x, y) becomes (x, -y).
    back.push({ p: m(q.p), out: q.out ? { x: q.out.x, y: -q.out.y } : undefined });
  }
  return [...pts, ...back];
}

/** A piece from a half outline mirrored across the vertical centre line at x = `axis`. */
export function mirroredPiece(half: PenPoint[], axis: number, name = "Panel"): Piece {
  return penPiece(mirrorOutline(half, axis), name);
}

/** An oval (or circle) filling the box at `at` (top-left), `w` across and `h` down. */
export function ovalPiece(at: V, w: number, h: number, name = "Panel"): Piece {
  const rx = w / 2;
  const ry = h / 2;
  const c = { x: at.x + rx, y: at.y + ry };
  const pts = [{ x: c.x, y: at.y }, { x: at.x + w, y: c.y }, { x: c.x, y: at.y + h }, { x: at.x, y: c.y }];
  const edges: Edge[] = [
    curve({ x: c.x + rx * K, y: at.y }, { x: at.x + w, y: c.y - ry * K }),
    curve({ x: at.x + w, y: c.y + ry * K }, { x: c.x + rx * K, y: at.y + h }),
    curve({ x: c.x - rx * K, y: at.y + h }, { x: at.x, y: c.y + ry * K }),
    curve({ x: at.x, y: c.y - ry * K }, { x: c.x - rx * K, y: at.y }),
  ];
  return pieceFromOutline(pts, edges, name);
}

/** A quarter-round from `a` to `b` about the square corner `corner`. */
function arc(a: V, corner: V, b: V): Edge {
  return curve(vlerp(a, corner, K), vlerp(b, corner, K));
}

export type SlotEnds = "both" | "round" | "point";

/**
 * A slot or strap end in the box at `at`, `w` across and `h` down, its long sides straight.
 * "both" rounds both short ends (a slot), "round" rounds the far end only (a strap end), "point"
 * gives the far end a point. A box taller than wide stands the shape up, far end at the bottom.
 */
export function slotPiece(at: V, w: number, h: number, ends: SlotEnds = "both", name = "Panel"): Piece {
  const tall = h > w;
  const L = tall ? h : w;
  const T = tall ? w : h;
  const r = Math.min(T / 2, L / 2);
  const verts: V[] = [];
  const edges: Edge[] = [];
  const push = (v: V, e: Edge) => {
    verts.push(v);
    edges.push(e);
  };
  if (ends === "point") {
    push({ x: 0, y: 0 }, line());
    push({ x: L - r, y: 0 }, line());
    push({ x: L, y: T / 2 }, line());
    push({ x: L - r, y: T }, line());
    push({ x: 0, y: T }, line());
  } else {
    const lr = ends === "both" ? r : 0;
    push({ x: lr, y: 0 }, line());
    push({ x: L - r, y: 0 }, arc({ x: L - r, y: 0 }, { x: L, y: 0 }, { x: L, y: T / 2 }));
    push({ x: L, y: T / 2 }, arc({ x: L, y: T / 2 }, { x: L, y: T }, { x: L - r, y: T }));
    push({ x: L - r, y: T }, line());
    if (lr) {
      push({ x: lr, y: T }, arc({ x: lr, y: T }, { x: 0, y: T }, { x: 0, y: T / 2 }));
      push({ x: 0, y: T / 2 }, arc({ x: 0, y: T / 2 }, { x: 0, y: 0 }, { x: lr, y: 0 }));
    } else push({ x: 0, y: T }, line());
  }
  // Stood up, the far end is at the bottom (a strap hanging down).
  const world = (p: V): V => vadd(tall ? { x: T - p.y, y: p.x } : p, at);
  const wv = verts.map(world);
  const we = edges.map((e) => (e.type === "cubic" ? { ...e, c1: world(e.c1), c2: world(e.c2) } : e));
  // Drop straight runs of no length (a slot exactly as long as it is wide is a circle).
  const keepV: V[] = [];
  const keepE: Edge[] = [];
  for (let i = 0; i < wv.length; i++) {
    const nx = wv[(i + 1) % wv.length];
    if (we[i].type === "line" && Math.hypot(nx.x - wv[i].x, nx.y - wv[i].y) < 1e-6) continue;
    keepV.push(wv[i]);
    keepE.push(we[i]);
  }
  return pieceFromOutline(keepV, keepE, name);
}

// ---------- editing one edge of an existing piece (design mm, piece-local) ----------

function cubicPoint(a: V, c1: V, c2: V, b: V, t: number): V {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** The two ends of edge `i`. */
export function edgeEnds(pc: Piece, i: number): [V, V] {
  const n = pc.vertices.length;
  return [pc.vertices[i], pc.vertices[(i + 1) % n]];
}

/** Length of an edge from `a` to `b` (curves measured along the curve). */
export function segmentLength(a: V, b: V, e: Edge | undefined): number {
  if (!e || e.type === "line") return Math.hypot(b.x - a.x, b.y - a.y);
  let len = 0;
  let prev = a;
  for (let k = 1; k <= 48; k++) {
    const p = cubicPoint(a, e.c1, e.c2, b, k / 48);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

/** Length of edge `i` as drawn. */
export function edgeLength(pc: Piece, i: number): number {
  const [a, b] = edgeEnds(pc, i);
  return segmentLength(a, b, pc.edges[i]);
}

/** Direction from `a` to `b` in degrees: 0 points right, 90 points up the screen. */
export function angleOf(a: V, b: V): number {
  const deg = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
  return Math.round((((deg % 360) + 360) % 360) * 100) / 100;
}

/** Direction of edge `i` from its start to its end. */
export function edgeAngle(pc: Piece, i: number): number {
  const [a, b] = edgeEnds(pc, i);
  return angleOf(a, b);
}

/** The middle of edge `i` (halfway along a curve's parameter). */
export function edgeMiddle(pc: Piece, i: number): V {
  const [a, b] = edgeEnds(pc, i);
  const e = pc.edges[i];
  if (!e || e.type === "line") return vlerp(a, b, 0.5);
  return cubicPoint(a, e.c1, e.c2, b, 0.5);
}

/**
 * Bend edge `i` so its middle moves by `d` from where it was in `orig` (the edge before the drag).
 * A straight edge becomes a curve; a curve keeps its character and bulges further; dragged back
 * flat, it becomes straight again.
 */
export function bendEdge(pc: Piece, i: number, orig: Edge, d: V): void {
  const [a, b] = edgeEnds(pc, i);
  const c1 = orig.type === "cubic" ? orig.c1 : vlerp(a, b, 1 / 3);
  const c2 = orig.type === "cubic" ? orig.c2 : vlerp(a, b, 2 / 3);
  // The middle of a cubic moves by 3/8 of what both handles move.
  const m = vmul(d, 4 / 3);
  const n1 = vadd(c1, m);
  const n2 = vadd(c2, m);
  const ab = vsub(b, a);
  const len = Math.hypot(ab.x, ab.y) || 1;
  const off = (p: V) => Math.abs((p.x - a.x) * ab.y - (p.y - a.y) * ab.x) / len;
  const along = (p: V) => ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (len * len);
  const flat = off(n1) < 0.4 && off(n2) < 0.4 && Math.abs(along(n1) - 1 / 3) < 0.05 && Math.abs(along(n2) - 2 / 3) < 0.05;
  pc.edges[i] = flat ? { ...orig, type: "line" } as Edge : { ...orig, type: "cubic", c1: n1, c2: n2 } as Edge;
}

/** Move vertex `k` by `d`, with the curve handles either side of it. */
function moveVertex(pc: Piece, k: number, d: V): void {
  const n = pc.vertices.length;
  pc.vertices[k] = vadd(pc.vertices[k], d);
  const after = pc.edges[k];
  if (after?.type === "cubic") after.c1 = vadd(after.c1, d);
  const before = pc.edges[(k - 1 + n) % n];
  if (before?.type === "cubic") before.c2 = vadd(before.c2, d);
}

/** Copy of a piece's outline (corner points and edges), to restore during a drag. */
export function outlineCopy(pc: Piece): { vertices: V[]; edges: Edge[] } {
  return { vertices: pc.vertices.map((v) => ({ ...v })), edges: pc.edges.map((e) => (e.type === "cubic" ? { ...e, c1: { ...e.c1 }, c2: { ...e.c2 } } : { ...e })) };
}

/** Put edge `i` (both its ends) at where it was in `orig` plus `d`. */
export function moveEdge(pc: Piece, i: number, orig: { vertices: V[]; edges: Edge[] }, d: V): void {
  const n = orig.vertices.length;
  const o = outlineCopy(orig as Piece);
  pc.vertices = o.vertices;
  pc.edges = o.edges;
  moveVertex(pc, i, d);
  moveVertex(pc, (i + 1) % n, d);
}

/**
 * Make edge `i` `len` mm long, keeping its start. A level or upright edge stretches the piece
 * (every point past the edge's end moves with it), so a rectangle stays a rectangle; a slanted
 * edge moves only its end point.
 */
export function setEdgeLength(pc: Piece, i: number, len: number): boolean {
  const cur = edgeLength(pc, i);
  if (!(len > 0.1) || cur < 1e-6) return false;
  const n = pc.vertices.length;
  const [a, b] = edgeEnds(pc, i);
  const chord = vsub(b, a);
  const cl = Math.hypot(chord.x, chord.y);
  if (cl < 1e-6) return false;
  const u = vmul(chord, 1 / cl);
  const level = Math.abs(u.x) < 1e-3 || Math.abs(u.y) < 1e-3;
  const e = pc.edges[i];
  if (e.type === "cubic" && !level) {
    // Scale the curve about its start; its length scales by the same factor.
    const k = len / cur;
    const nb = vadd(a, vmul(chord, k));
    const d = vsub(nb, b);
    pc.edges[i] = { ...e, c1: vadd(a, vmul(vsub(e.c1, a), k)), c2: vadd(a, vmul(vsub(e.c2, a), k)) };
    pc.vertices[(i + 1) % n] = nb;
    const next = pc.edges[(i + 1) % n];
    if (next?.type === "cubic") next.c1 = vadd(next.c1, d);
    return true;
  }
  // A curve that runs level gets longer by stretching its chord in proportion.
  const d = vmul(u, e.type === "cubic" ? cl * (len / cur - 1) : len - cl);
  if (!level) {
    moveVertex(pc, (i + 1) % n, d);
    return true;
  }
  const along = (p: V) => (p.x - a.x) * u.x + (p.y - a.y) * u.y;
  const end = along(b);
  // Everything on the far half moves, so rounded corners near the far end go with it.
  const moved = pc.vertices.map((v) => along(v) > end / 2 + 1e-6);
  pc.vertices = pc.vertices.map((v, j) => (moved[j] ? vadd(v, d) : v));
  pc.edges = pc.edges.map((ed, j) => {
    if (ed.type !== "cubic") return ed;
    const s = moved[j];
    const t = moved[(j + 1) % n];
    if (s && t) return { ...ed, c1: vadd(ed.c1, d), c2: vadd(ed.c2, d) };
    if (!s && !t) return ed;
    // Between a fixed end and a moving one, handles move in proportion to how far along they are.
    const span = Math.abs(end - along(pc.vertices[s ? (j + 1) % n : j])) || 1;
    const fixedAt = along(s ? pc.vertices[(j + 1) % n] : pc.vertices[j]);
    const f = (p: V): V => vadd(p, vmul(d, Math.max(0, Math.min(1, Math.abs(along(p) - fixedAt) / span))));
    return { ...ed, c1: f(ed.c1), c2: f(ed.c2) };
  });
  return true;
}

/** Turn edge `i` about its start so it points at `deg` degrees (0 = right, 90 = up the screen). */
export function setEdgeAngle(pc: Piece, i: number, deg: number): boolean {
  if (!Number.isFinite(deg)) return false;
  const n = pc.vertices.length;
  const [a, b] = edgeEnds(pc, i);
  const now = Math.atan2(-(b.y - a.y), b.x - a.x);
  // Screen y points down, so turning up the screen is a negative turn in these coordinates.
  const turn = -((deg * Math.PI) / 180 - now);
  const rot = (p: V): V => {
    const x = p.x - a.x;
    const y = p.y - a.y;
    return { x: a.x + x * Math.cos(turn) - y * Math.sin(turn), y: a.y + x * Math.sin(turn) + y * Math.cos(turn) };
  };
  const nb = rot(b);
  const d = vsub(nb, b);
  const e = pc.edges[i];
  if (e.type === "cubic") pc.edges[i] = { ...e, c1: rot(e.c1), c2: rot(e.c2) };
  pc.vertices[(i + 1) % n] = nb;
  const next = pc.edges[(i + 1) % n];
  if (next?.type === "cubic") next.c1 = vadd(next.c1, d);
  return true;
}
