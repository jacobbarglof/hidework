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
  // Fresh ids, so selecting or deleting hardware or a mark on the copy leaves the original alone.
  copy.hardware?.forEach((x) => (x.id = uid("hw")));
  copy.marks?.forEach((x) => (x.id = uid("mk")));
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

function pieceBounds(pc: Piece): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = pc.vertices.map((v) => v.x);
  const ys = pc.vertices.map((v) => v.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Apply a point map to everything in a piece (vertices, curve handles, holes, hardware, marks). */
function mapPiece(pc: Piece, f: (p: V) => V): void {
  pc.vertices = pc.vertices.map(f);
  pc.edges = pc.edges.map((e) => (e.type === "cubic" ? { ...e, c1: f(e.c1), c2: f(e.c2) } : e));
  pc.holes.forEach((h) => (h.center = f(h.center)));
  pc.hardware?.forEach((x) => (x.at = f(x.at)));
  pc.marks?.forEach((m) => (m.center = f(m.center)));
  pc.tooling?.forEach((t) => (t.points = t.points.map(f)));
}

/** A mirror swaps left and right of every tooling line (bevels stay on the same side of the cut). */
function flipToolingSides(pc: Piece): void {
  pc.tooling?.forEach((t) => (t.side = -(t.side ?? 0)));
}

/** Change the angle of every hole, hardware item, mark and tooling stroke on a piece. */
function mapAngles(pc: Piece, g: (deg: number) => number): void {
  pc.holes.forEach((h) => (h.angleDeg = g(h.angleDeg ?? 0)));
  pc.hardware?.forEach((x) => (x.angleDeg = g(x.angleDeg ?? 0)));
  pc.marks?.forEach((m) => (m.angleDeg = g(m.angleDeg ?? 0)));
  pc.tooling?.forEach((t) => (t.angleDeg = g(t.angleDeg ?? 0)));
}

/** Flip left-right (axis "x") or top-bottom (axis "y") in place. Edge numbers stay the same. */
export function mirrorPiece(pc: Piece, axis: "x" | "y"): void {
  const b = pieceBounds(pc);
  if (axis === "x") {
    const s = b.minX + b.maxX;
    mapPiece(pc, (p) => ({ x: s - p.x, y: p.y }));
    pc.folds.forEach((f) => f.orientation === "vertical" && (f.position = s - f.position));
    mapAngles(pc, (a) => 180 - a);
    flipToolingSides(pc);
    pc.grainDeg = 180 - pc.grainDeg;
  } else {
    const s = b.minY + b.maxY;
    mapPiece(pc, (p) => ({ x: p.x, y: s - p.y }));
    pc.folds.forEach((f) => f.orientation === "horizontal" && (f.position = s - f.position));
    mapAngles(pc, (a) => -a);
    flipToolingSides(pc);
    pc.grainDeg = -pc.grainDeg;
  }
}

/** Quarter turn about the piece's corner box, keeping its top-left where it was. */
export function rotatePiece(pc: Piece, clockwise: boolean): void {
  const b = pieceBounds(pc);
  // Clockwise on screen (y down): (x, y) -> (-y, x).
  const raw = (p: V): V => (clockwise ? { x: -p.y, y: p.x } : { x: p.y, y: -p.x });
  const corners = [raw({ x: b.minX, y: b.minY }), raw({ x: b.maxX, y: b.maxY })];
  const nx = Math.min(corners[0].x, corners[1].x);
  const ny = Math.min(corners[0].y, corners[1].y);
  const f = (p: V): V => {
    const r = raw(p);
    return { x: r.x - nx + b.minX, y: r.y - ny + b.minY };
  };
  mapPiece(pc, f);
  pc.folds.forEach((fd) => {
    if (fd.orientation === "horizontal") {
      fd.orientation = "vertical";
      fd.position = f({ x: 0, y: fd.position }).x;
    } else {
      fd.orientation = "horizontal";
      fd.position = f({ x: fd.position, y: 0 }).y;
    }
  });
  // Holes, hardware and marks turn with the piece. A mark keeps its width and height and gains
  // the quarter turn in its angle (its box covers the same leather as swapping the two, and its
  // lettering turns with the piece).
  const turn = clockwise ? 90 : -90;
  mapAngles(pc, (a) => a + turn);
  pc.grainDeg += turn;
}

// ---------- outlines as polygons (drag-box selection and merging) ----------

const cross = (a: V, b: V): number => a.x * b.y - a.y * b.x;

/** Shoelace area; the sign tells the winding. */
export function signedArea(pts: V[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += cross(pts[i], pts[(i + 1) % pts.length]);
  return s / 2;
}

/** A closed polyline; segment k runs from pts[k] to pts[k+1] (wrapping) and came from edge src[k]. */
export interface Ring {
  pts: V[];
  src: number[];
}

/** A piece's design outline as a polygon (curves flattened), offset by `off`. */
export function flattenPiece(pc: Piece, off: V = { x: 0, y: 0 }, steps = 16): Ring {
  const pts: V[] = [];
  const src: number[] = [];
  const n = pc.vertices.length;
  for (let i = 0; i < n; i++) {
    const a = pc.vertices[i];
    const b = pc.vertices[(i + 1) % n];
    const e = pc.edges[i];
    pts.push(add(a, off));
    src.push(i);
    if (e?.type === "cubic") {
      for (let k = 1; k < steps; k++) {
        pts.push(add(cubicAt(a, e.c1, e.c2, b, k / steps), off));
        src.push(i);
      }
    }
  }
  return { pts, src };
}

export function pointInPolygon(p: V, poly: V[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Do segments ab and cd touch or cross? */
export function segmentsMeet(a: V, b: V, c: V, d: V): boolean {
  const d1 = sub(b, a);
  const d2 = sub(d, c);
  const o1 = cross(d1, sub(c, a));
  const o2 = cross(d1, sub(d, a));
  const o3 = cross(d2, sub(a, c));
  const o4 = cross(d2, sub(b, c));
  const within = (p: V, q: V, r: V) =>
    Math.min(p.x, q.x) - 1e-9 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-9 && Math.min(p.y, q.y) - 1e-9 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-9;
  if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0;
  return (o1 === 0 && within(a, b, c)) || (o2 === 0 && within(a, b, d)) || (o3 === 0 && within(c, d, a)) || (o4 === 0 && within(c, d, b));
}

/** Does a closed polygon touch the axis-aligned box [min, max] (inside it, around it or across it)? */
export function polygonTouchesBox(poly: V[], min: V, max: V): boolean {
  if (!poly.length) return false;
  const inBox = (p: V) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
  if (poly.some(inBox)) return true;
  const corners = [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }];
  if (corners.some((c) => pointInPolygon(c, poly))) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    for (let k = 0; k < 4; k++) if (segmentsMeet(a, b, corners[k], corners[(k + 1) % 4])) return true;
  }
  return false;
}

/** Does a closed polyline cross itself (neighbouring segments excepted)? */
export function selfIntersects(poly: V[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsMeet(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

function reverseRing(r: Ring): Ring {
  const n = r.pts.length;
  const pts = [...r.pts].reverse();
  // Reversed segment k runs pts[n-1-k] -> pts[n-2-k], which is original segment n-2-k; the
  // closing segment stays the closing segment.
  const src = pts.map((_, k) => (k < n - 1 ? r.src[n - 2 - k] : r.src[n - 1]));
  return { pts, src };
}

/** The outline of a union; segment k came from the edges `srcs[k]` (each `[ring, edge]`). */
export interface UnionResult {
  pts: V[];
  srcs: [number, number][][];
  /** The two outlines enclosed a gap, which the union filled. */
  holesFilled: boolean;
}

/**
 * Union of two simple polygons that overlap or share part of their boundary (within `tol` mm).
 * Returns one outer outline (positive shoelace area), or an error when the shapes are apart or
 * only meet at a point.
 */
export function unionRings(p0: Ring, q0: Ring, tol = 0.02): UnionResult | { error: string } {
  return combineRings(p0, q0, "union", tol);
}

/**
 * Union of two simple polygons, or the first with the second cut away ("cut"). Segment k of the
 * result came from the edges `srcs[k]`. A cut that would split the outline in two, leave a hole,
 * or take everything away is an error, as is a union of shapes that are apart.
 */
export function combineRings(p0: Ring, q0: Ring, op: "union" | "cut", tol = 0.02): UnionResult | { error: string } {
  const rings = [p0, q0].map((r) => (signedArea(r.pts) < 0 ? reverseRing(r) : r));
  const nodes: V[] = [];
  const node = (p: V): number => {
    for (let i = 0; i < nodes.length; i++) if (dist(nodes[i], p) <= tol) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  type Seg = { a: V; b: V; ring: number; src: number; cuts: { t: number; p: V }[] };
  const segs: Seg[][] = rings.map((r, ring) => r.pts.map((a, k) => ({ a, b: r.pts[(k + 1) % r.pts.length], ring, src: r.src[k], cuts: [] })));
  const cut = (s: Seg, t: number, p: V) => {
    const l = dist(s.a, s.b);
    if (t * l > tol && (1 - t) * l > tol) s.cuts.push({ t, p });
  };
  for (const s of segs[0]) {
    for (const q of segs[1]) {
      const d1 = sub(s.b, s.a);
      const d2 = sub(q.b, q.a);
      const l1 = Math.hypot(d1.x, d1.y);
      const l2 = Math.hypot(d2.x, d2.y);
      if (l1 < 1e-12 || l2 < 1e-12) continue;
      const den = cross(d1, d2);
      const w = sub(q.a, s.a);
      if (Math.abs(den) > 1e-9 * l1 * l2) {
        const t = cross(w, d2) / den;
        const u = cross(w, d1) / den;
        if (t * l1 >= -tol && (t - 1) * l1 <= tol && u * l2 >= -tol && (u - 1) * l2 <= tol) {
          const p = add(s.a, mul(d1, t));
          cut(s, t, p);
          cut(q, u, p);
        }
      } else if (Math.abs(cross(d1, w)) / l1 <= tol) {
        // Collinear: each side splits where the other one ends.
        for (const p of [q.a, q.b]) cut(s, ((p.x - s.a.x) * d1.x + (p.y - s.a.y) * d1.y) / (l1 * l1), p);
        for (const p of [s.a, s.b]) cut(q, ((p.x - q.a.x) * d2.x + (p.y - q.a.y) * d2.y) / (l2 * l2), p);
      }
    }
  }
  // Split every segment at its cuts into node-to-node parts.
  type Part = { u: number; v: number; ring: number; src: number };
  const parts: Part[] = [];
  for (const list of segs) {
    for (const s of list) {
      const pts = [s.a, ...s.cuts.sort((x, y) => x.t - y.t).map((c) => c.p), s.b];
      for (let i = 0; i + 1 < pts.length; i++) {
        const u = node(pts[i]);
        const v = node(pts[i + 1]);
        if (u !== v) parts.push({ u, v, ring: s.ring, src: s.src });
      }
    }
  }
  const has = [new Set<string>(), new Set<string>()];
  for (const pt of parts) has[pt.ring].add(`${pt.u},${pt.v}`);
  const kept =
    op === "union"
      ? parts.filter((pt) => {
          const other = 1 - pt.ring;
          if (has[other].has(`${pt.u},${pt.v}`)) return pt.ring === 0; // shared, same direction: keep once
          if (has[other].has(`${pt.v},${pt.u}`)) return false; // shared and facing: the seam disappears
          return !pointInPolygon(lerp(nodes[pt.u], nodes[pt.v], 0.5), rings[other].pts);
        })
      : parts
          .filter((pt) => {
            const other = 1 - pt.ring;
            const same = has[other].has(`${pt.u},${pt.v}`);
            const facing = has[other].has(`${pt.v},${pt.u}`);
            // The first outline keeps what lies outside the cut (and edges the cut only rests against);
            // the cut keeps what lies inside the first outline, walked the other way.
            if (pt.ring === 0) return same ? false : facing ? true : !pointInPolygon(lerp(nodes[pt.u], nodes[pt.v], 0.5), rings[1].pts);
            return same || facing ? false : pointInPolygon(lerp(nodes[pt.u], nodes[pt.v], 0.5), rings[0].pts);
          })
          .map((pt) => (pt.ring === 1 ? { ...pt, u: pt.v, v: pt.u } : pt));
  // Chain the kept parts into loops.
  const out = new Map<number, Part[]>();
  for (const pt of kept) out.set(pt.u, [...(out.get(pt.u) ?? []), pt]);
  for (const list of out.values()) if (list.length > 1) return { error: "The outlines only meet at a corner." };
  const used = new Set<Part>();
  const loops: { pts: V[]; srcs: [number, number][][] }[] = [];
  for (const start of kept) {
    if (used.has(start)) continue;
    const pts: V[] = [];
    const srcs: [number, number][][] = [];
    let cur: Part | undefined = start;
    while (cur && !used.has(cur)) {
      used.add(cur);
      pts.push(nodes[cur.u]);
      srcs.push([[cur.ring, cur.src]]);
      cur = out.get(cur.v)?.[0];
    }
    if (cur !== start) return { error: "The outlines could not be joined cleanly." };
    loops.push({ pts, srcs });
  }
  const outer = loops.filter((l) => signedArea(l.pts) > 0);
  if (op === "cut") {
    if (!outer.length) return { error: "That would cut the whole piece away." };
    if (outer.length > 1) return { error: "That cut would split the piece in two. Draw it so the leather still joins up." };
    if (loops.length > 1) return { error: "That would leave a hole inside the piece. Start the cut on the piece's edge, or punch a hole instead." };
  } else if (outer.length !== 1) return { error: outer.length ? "The outlines do not overlap or touch." : "The outlines could not be joined cleanly." };
  const res = outer[0];
  // Drop points where the outline runs straight on: two collinear segments become one.
  for (let i = 0; i < res.pts.length && res.pts.length > 3; ) {
    const n = res.pts.length;
    const prev = (i + n - 1) % n;
    const a = sub(res.pts[i], res.pts[prev]);
    const b = sub(res.pts[(i + 1) % n], res.pts[i]);
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    // A corner one outline already had between two of its own edges stays, even when straight:
    // the stitching, a fold or an edge finish may change there.
    const own = (l: [number, number][]) => (l.every((x) => x[0] === l[0][0]) ? l[0][0] : -1);
    const ra = own(res.srcs[prev]);
    const keep = ra >= 0 && ra === own(res.srcs[i]) && !res.srcs[prev].some((x) => res.srcs[i].some((y) => y[1] === x[1]));
    if (keep || (la > tol && lb > tol && !(Math.abs(cross(a, b)) <= 1e-7 * la * lb && a.x * b.x + a.y * b.y > 0))) {
      i++;
      continue;
    }
    // Segment `prev` now runs on to point i+1 and also stands for segment i's edges.
    for (const s of res.srcs[i]) if (!res.srcs[prev].some((x) => x[0] === s[0] && x[1] === s[1])) res.srcs[prev].push(s);
    res.pts.splice(i, 1);
    res.srcs.splice(i, 1);
    if (i > 0) i--;
  }
  return { pts: res.pts, srcs: res.srcs, holesFilled: loops.length > 1 };
}
