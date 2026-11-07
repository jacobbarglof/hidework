// Pattern edits that need geometry: new pieces, splitting and removing corners, mapping clicks
// back through fold allowances.

import { state, uid } from "./store";
import type { ComputedPiece, Edge, Piece, Project, V } from "./types";

const K = 0.55228475;
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s });
const lerp = (a: V, b: V, t: number): V => add(a, mul(sub(b, a), t));
export const dist = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);

function basePiece(name: string, at: V): Piece {
  return {
    id: uid("p"),
    name,
    materialId: state.project.materials[0]?.id ?? "",
    position: at,
    vertices: [],
    edges: [],
    cutCount: 1,
    seamAllowanceMm: 0,
    stitch: { marginMm: 3, pitchMm: 3.85, holeMm: 1 },
    folds: [],
    holes: [],
    grainDeg: 90,
  };
}

export function rectPiece(at: V, w: number, h: number, name: string): Piece {
  const p = basePiece(name, at);
  p.vertices = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  p.edges = p.vertices.map(() => ({ type: "line", stitched: false }) as Edge);
  return p;
}

export function roundedRectPiece(at: V, w: number, h: number, r: number, name: string): Piece {
  const p = basePiece(name, at);
  const corners: [V, V, V][] = [
    [{ x: w - r, y: 0 }, { x: w, y: 0 }, { x: w, y: r }],
    [{ x: w, y: h - r }, { x: w, y: h }, { x: w - r, y: h }],
    [{ x: r, y: h }, { x: 0, y: h }, { x: 0, y: h - r }],
    [{ x: 0, y: r }, { x: 0, y: 0 }, { x: r, y: 0 }],
  ];
  for (const [a, c, b] of corners) {
    p.vertices.push(a, b);
    p.edges.push({ type: "cubic", c1: lerp(a, c, K), c2: lerp(b, c, K), stitched: false }, { type: "line", stitched: false });
  }
  // Rotate so vertex 0 is the start of the top edge, matching rectPiece.
  p.vertices.unshift(p.vertices.pop()!);
  p.edges.unshift(p.edges.pop()!);
  return p;
}

/** Map a piece-local point on the compensated pattern back to design coordinates. */
export function toDesign(cp: ComputedPiece | undefined, local: V): V {
  if (!cp) return local;
  let { x, y } = local;
  for (const f of [...cp.folds].reverse()) {
    const horiz = f.orientation === "horizontal";
    let c = horiz ? y : x;
    if (c > f.stageAt + f.shiftMm) c -= f.shiftMm;
    else if (c > f.stageAt) c = f.stageAt;
    if (horiz) y = c;
    else x = c;
  }
  return { x, y };
}

function cubicAt(a: V, c1: V, c2: V, b: V, t: number): V {
  const u = 1 - t;
  return add(add(mul(a, u * u * u), mul(c1, 3 * u * u * t)), add(mul(c2, 3 * u * t * t), mul(b, t * t * t)));
}

function fixJoinsAfterInsert(p: Project, pieceId: string, i: number): void {
  for (const j of p.joins) {
    for (const r of [j.a, j.b]) {
      if (r.pieceId !== pieceId) continue;
      const out: number[] = [];
      for (const e of r.edges) {
        if (e < i) out.push(e);
        else if (e === i) out.push(i, i + 1);
        else out.push(e + 1);
      }
      r.edges = out;
    }
  }
}

/** Split edge `i` at the point nearest `design`. Returns the new vertex index. */
export function insertVertex(p: Project, pc: Piece, i: number, design: V): number {
  const n = pc.vertices.length;
  const a = pc.vertices[i];
  const b = pc.vertices[(i + 1) % n];
  const e = pc.edges[i];
  if (e.type === "line") {
    const ab = sub(b, a);
    const t = Math.min(0.95, Math.max(0.05, ((design.x - a.x) * ab.x + (design.y - a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y || 1)));
    pc.vertices.splice(i + 1, 0, lerp(a, b, t));
    pc.edges.splice(i + 1, 0, { type: "line", stitched: e.stitched });
  } else {
    let best = 0.5;
    let bestD = Infinity;
    for (let k = 1; k < 100; k++) {
      const t = k / 100;
      const d = dist(cubicAt(a, e.c1, e.c2, b, t), design);
      if (d < bestD) [best, bestD] = [t, d];
    }
    const t = best;
    const p01 = lerp(a, e.c1, t), p12 = lerp(e.c1, e.c2, t), p23 = lerp(e.c2, b, t);
    const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
    const mid = lerp(p012, p123, t);
    pc.edges[i] = { type: "cubic", c1: p01, c2: p012, stitched: e.stitched };
    pc.vertices.splice(i + 1, 0, mid);
    pc.edges.splice(i + 1, 0, { type: "cubic", c1: p123, c2: p23, stitched: e.stitched });
  }
  fixJoinsAfterInsert(p, pc.id, i);
  return i + 1;
}

/** Remove vertex `i`; the edge before it now runs straight to the next vertex. */
export function deleteVertex(p: Project, pc: Piece, i: number): boolean {
  const n = pc.vertices.length;
  if (n <= 3) return false;
  const prev = (i + n - 1) % n;
  pc.edges[prev] = { type: "line", stitched: pc.edges[prev].stitched };
  pc.vertices.splice(i, 1);
  pc.edges.splice(i, 1);
  for (const j of p.joins) {
    for (const r of [j.a, j.b]) {
      if (r.pieceId !== pc.id) continue;
      r.edges = r.edges.filter((e) => e !== i).map((e) => (e > i ? e - 1 : e));
    }
  }
  p.joins = p.joins.filter((j) => j.a.edges.length && j.b.edges.length);
  return true;
}

/** Turn a straight edge into a gentle curve, or a curve back into a line. */
export function toggleCurve(pc: Piece, i: number): void {
  const n = pc.vertices.length;
  const e = pc.edges[i];
  if (e.type === "cubic") {
    pc.edges[i] = { type: "line", stitched: e.stitched };
    return;
  }
  const a = pc.vertices[i];
  const b = pc.vertices[(i + 1) % n];
  const d = sub(b, a);
  const nrm = { x: -d.y * 0.15, y: d.x * 0.15 };
  pc.edges[i] = { type: "cubic", c1: add(lerp(a, b, 1 / 3), nrm), c2: add(lerp(a, b, 2 / 3), nrm), stitched: e.stitched };
}

export function duplicatePiece(pc: Piece): Piece {
  const copy: Piece = JSON.parse(JSON.stringify(pc));
  copy.id = uid("p");
  copy.name = `${pc.name} copy`;
  copy.position = { x: pc.position.x + 15, y: pc.position.y + 15 };
  copy.folds.forEach((f) => (f.id = uid("f")));
  copy.holes.forEach((h) => (h.id = uid("h")));
  return copy;
}

/** Where along a compensated outline an edge sits: its points in order. */
export function edgePoints(cp: ComputedPiece, e: number): V[] {
  const pts: V[] = [];
  const m = cp.outline.length;
  for (let i = 0; i < m; i++) {
    if (cp.outlineEdges[i] === e) {
      if (!pts.length || dist(pts[pts.length - 1], cp.outline[i]) > 1e-9) pts.push(cp.outline[i]);
      pts.push(cp.outline[(i + 1) % m]);
    }
  }
  return pts;
}

export function midpoint(pts: V[]): V {
  if (!pts.length) return { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (acc + l >= total / 2) return lerp(pts[i - 1], pts[i], l ? (total / 2 - acc) / l : 0);
    acc += l;
  }
  return pts[0];
}
