// Sketch-style outline booleans, as in a Fusion 360 sketch: grow a piece by a shape drawn over or
// against it (union), or cut a shape out of it. The outlines are flattened, combined
// (ops.combineRings), then rebuilt as edges: a run of the result that follows one curved edge
// becomes one curve again (the part of the original curve between the run's ends), so circles,
// rounded corners and pen curves stay curves instead of turning into many short straight edges.

import { combineRings, flattenPiece, signedArea } from "./ops";
import type { Edge, Piece, V } from "./types";

type Cubic = [V, V, V, V];

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const addV = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const lerpV = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function at(c: Cubic, t: number): V {
  const u = 1 - t;
  return {
    x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y,
  };
}

/** De Casteljau split at t: the parts before and after. */
function split(c: Cubic, t: number): [Cubic, Cubic] {
  const p01 = lerpV(c[0], c[1], t);
  const p12 = lerpV(c[1], c[2], t);
  const p23 = lerpV(c[2], c[3], t);
  const a = lerpV(p01, p12, t);
  const b = lerpV(p12, p23, t);
  const m = lerpV(a, b, t);
  return [
    [c[0], p01, a, m],
    [m, b, p23, c[3]],
  ];
}

/** The part of a curve between t0 < t1. */
function part(c: Cubic, t0: number, t1: number): Cubic {
  const right = t0 > 1e-9 ? split(c, t0)[1] : c;
  const u = t0 > 1e-9 ? (t1 - t0) / (1 - t0) : t1;
  return u < 1 - 1e-9 ? split(right, u)[0] : right;
}

/** The curve parameter nearest to `p`. */
export function nearestT(c: Cubic, p: V): number {
  const N = 128;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i <= N; i++) {
    const q = at(c, i / N);
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bd) {
      bd = d;
      best = i / N;
    }
  }
  let lo = Math.max(0, best - 1 / N);
  let hi = Math.min(1, best + 1 / N);
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const d1 = ((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2)(at(c, m1));
    const d2 = ((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2)(at(c, m2));
    if (d1 < d2) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

function asLine(e: Edge): Edge {
  const out: Edge = { type: "line", stitched: e.stitched };
  if (e.skiveMm !== undefined) out.skiveMm = e.skiveMm;
  if (e.finish !== undefined) out.finish = e.finish;
  if (e.turnMm !== undefined) out.turnMm = e.turnMm;
  if (e.crease !== undefined) out.crease = e.crease;
  return out;
}

export interface Reshaped {
  /** A's old edge number to its new edge numbers. */
  mapA: Map<number, number[]>;
  /** B's edge number to the new edge numbers that came from it. */
  mapB: Map<number, number[]>;
  /** The two outlines enclosed a gap, which the union filled. */
  holesFilled: boolean;
  /** Some curves could not be kept as curves. */
  curvesLost: boolean;
  /** Area before and after (mm², always positive). */
  before: number;
  after: number;
}

/**
 * Give piece A the outline of A ∪ B ("union") or A with B cut away ("cut"). Both pieces are
 * placed by their own positions; A keeps its position and its other features. With `inherit`,
 * edges that came from B take their stitching and edge finish from the neighbouring edge of A
 * (so a tab drawn onto a stitched side is stitched too). Returns an error in words.
 */
export function reshapeByBoolean(A: Piece, B: Piece, op: "union" | "cut", inherit: boolean, tol = 0.05): Reshaped | string {
  const ra = flattenPiece(A, A.position);
  const rb = flattenPiece(B, B.position);
  const before = Math.abs(signedArea(ra.pts));
  const res = combineRings(ra, rb, op, tol);
  if ("error" in res) return res.error;
  const n = res.pts.length;
  const pieces = [A, B];
  // Segments that each follow one curved edge alone can merge back into that curve.
  const key = res.srcs.map((list) => (list.length === 1 && pieces[list[0][0]].edges[list[0][1]]?.type === "cubic" ? `${list[0][0]}:${list[0][1]}` : null));
  let start = 0;
  for (let k = 0; k < n; k++) {
    if (key[k] === null || key[k] !== key[(k - 1 + n) % n]) {
      start = k;
      break;
    }
    if (k === n - 1) start = -1; // the whole loop is one curve: keep it flat
  }
  const runs: { from: number; count: number }[] = [];
  if (start < 0) for (let k = 0; k < n; k++) runs.push({ from: k, count: 1 });
  else {
    for (let i = 0; i < n; ) {
      const k = (start + i) % n;
      let count = 1;
      if (key[k] !== null) while (i + count < n && key[(start + i + count) % n] === key[k]) count++;
      runs.push({ from: k, count });
      i += count;
    }
  }
  const verts: V[] = [];
  const edges: Edge[] = [];
  const fromB: boolean[] = [];
  const mapA = new Map<number, number[]>();
  const mapB = new Map<number, number[]>();
  const note = (ring: number, e: number, idx: number) => {
    const m = ring === 0 ? mapA : mapB;
    const list = m.get(e) ?? [];
    if (!list.includes(idx)) list.push(idx);
    m.set(e, list);
  };
  const curvesLost = start < 0 && key.some((k) => k !== null);
  for (const run of runs) {
    const idx = edges.length;
    const k0 = run.from;
    const k1 = (run.from + run.count) % n;
    const p0 = res.pts[k0];
    const p1 = res.pts[k1];
    for (let i = 0; i < run.count; i++) for (const [ring, e] of res.srcs[(k0 + i) % n]) note(ring, e, idx);
    const [ring, e] = res.srcs[k0][0];
    const src = pieces[ring];
    const orig = src.edges[e];
    verts.push(sub(p0, A.position));
    fromB.push(ring === 1);
    if (orig?.type === "cubic" && key[k0] !== null) {
      const off = src.position;
      const nv = src.vertices.length;
      const c: Cubic = [addV(src.vertices[e], off), addV(orig.c1, off), addV(orig.c2, off), addV(src.vertices[(e + 1) % nv], off)];
      const t0 = nearestT(c, p0);
      const t1 = nearestT(c, p1);
      if (Math.abs(t1 - t0) < 1e-6) {
        edges.push(asLine(orig));
        continue;
      }
      let s = t0 < t1 ? part(c, t0, t1) : part(c, t1, t0);
      if (t0 > t1) s = [s[3], s[2], s[1], s[0]];
      // Ends exactly where the outline meets: move the handles with them.
      const c1 = addV(s[1], sub(p0, s[0]));
      const c2 = addV(s[2], sub(p1, s[3]));
      edges.push({ ...JSON.parse(JSON.stringify(orig)), type: "cubic", c1: sub(c1, A.position), c2: sub(c2, A.position) } as Edge);
    } else edges.push(asLine(orig));
  }
  if (inherit) {
    // New edges carry on the stitching and finish of the edge of A they grow out of.
    const m = edges.length;
    for (let i = 0; i < m; i++) {
      if (!fromB[i]) continue;
      let j = -1;
      for (let d = 1; d < m && j < 0; d++) {
        if (!fromB[(i - d + m) % m]) j = (i - d + m) % m;
        else if (!fromB[(i + d) % m]) j = (i + d) % m;
      }
      if (j < 0) continue;
      edges[i].stitched = edges[j].stitched;
      if (edges[j].finish !== undefined) edges[i].finish = edges[j].finish;
      else delete edges[i].finish;
    }
  }
  A.vertices = verts;
  A.edges = edges;
  const after = Math.abs(signedArea(flattenPiece(A, A.position).pts));
  return { mapA, mapB, holesFilled: res.holesFilled, curvesLost, before, after };
}
