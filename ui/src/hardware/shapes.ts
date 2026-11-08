// Geometry helpers for hardware: lathe profiles with real fillets, swept wire (rings, clasps,
// split rings, tongues), extruded plates with rounded bevels, and the attributes every hardware
// material expects: uv in millimetres, a tangent along the brushing direction, and `wear`
// (above 0 on exposed edges, below 0 in crevices) estimated from the surface curvature.
//
// All sizes are millimetres. Profiles are (r, z) pairs with z up; built shapes have +z out of the
// leather.

import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type P = [number, number];
/** A profile corner: (r, z) and an optional fillet radius. */
export type C = [number, number, number?];

/**
 * Round the corners of a polyline. Each corner with a radius gets an arc of `steps` segments
 * tangent to both neighbouring segments (the radius shrinks if the segments are too short).
 */
export function fillet(corners: C[], steps = 5): P[] {
  const out: P[] = [];
  for (let i = 0; i < corners.length; i++) {
    const [x, y, rad = 0] = corners[i];
    if (!rad || i === 0 || i === corners.length - 1) {
      out.push([x, y]);
      continue;
    }
    const [ax, ay] = corners[i - 1];
    const [bx, by] = corners[i + 1];
    let ux = ax - x, uy = ay - y;
    let vx = bx - x, vy = by - y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) {
      out.push([x, y]);
      continue;
    }
    ux /= lu; uy /= lu; vx /= lv; vy /= lv;
    const cos = Math.max(-1, Math.min(1, ux * vx + uy * vy));
    const half = Math.acos(cos) / 2;
    if (half < 1e-3 || half > Math.PI / 2 - 1e-3) {
      out.push([x, y]);
      continue;
    }
    let r = rad;
    let d = r / Math.tan(half);
    const lim = Math.min(lu, lv) * 0.49;
    if (d > lim) {
      d = lim;
      r = d * Math.tan(half);
    }
    const sx = x + ux * d, sy = y + uy * d;
    const ex = x + vx * d, ey = y + vy * d;
    let bxs = ux + vx, bys = uy + vy;
    const lb = Math.hypot(bxs, bys);
    bxs /= lb; bys /= lb;
    const cd = r / Math.sin(half);
    const cx = x + bxs * cd, cy = y + bys * cd;
    const a0 = Math.atan2(sy - cy, sx - cx);
    const a1 = Math.atan2(ey - cy, ex - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (da * k) / steps;
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return out;
}

/** Points on an elliptical arc centred at (cx, cz), angles in radians, inclusive. */
export function arc(cx: number, cz: number, rx: number, rz: number, a0: number, a1: number, n: number): P[] {
  const out: P[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    out.push([cx + Math.cos(a) * rx, cz + Math.sin(a) * rz]);
  }
  return out;
}

/** Drop points closer than `eps` to the previous one. */
function dedupe(p: P[], eps = 1e-4): P[] {
  const out: P[] = [];
  for (const q of p) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > eps) out.push(q);
  }
  return out;
}

export interface LatheOpts {
  segments?: number;
  /** Radius multiplier by angle and profile index (scallops, petals, facets). */
  mod?: (phi: number, j: number, n: number) => number;
  /** Phase of the first segment, radians. */
  phase?: number;
}

/**
 * Spin a profile round the z axis. The profile runs with the solid on its left: up the outside,
 * across the top toward the axis (or round a closed loop the same way), so normals point out.
 * uv: u is the arc length round the outermost radius, v the length along the profile (mm).
 */
export function lathe(profile: P[], opts: LatheOpts = {}): THREE.BufferGeometry {
  const pts = dedupe(profile);
  const seg = opts.segments ?? 48;
  const g = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(Math.max(0, r), z)), seg, opts.phase ?? 0, Math.PI * 2);
  const n = pts.length;
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const rmax = Math.max(...pts.map((p) => p[0]), 0.1);
  const along: number[] = [0];
  for (let j = 1; j < n; j++) along.push(along[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
  for (let i = 0; i <= seg; i++) {
    const phi = (opts.phase ?? 0) + (i / seg) * Math.PI * 2;
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      uv.setXY(k, phi * rmax, along[j]);
      if (opts.mod) {
        const f = opts.mod(phi, j, n);
        pos.setX(k, pos.getX(k) * f);
        pos.setZ(k, pos.getZ(k) * f);
      }
    }
  }
  if (opts.mod) g.computeVertexNormals();
  // Lathe is built round +y; turn it so the axis is +z.
  g.rotateX(Math.PI / 2);
  return finishGeometry(g, "spin");
}

/**
 * Sweep a 2D section along a path. `up` gives the section's y direction at each point (for a
 * ring, the ring's axis); x is up × tangent. `scale` shrinks the section along the path (tapers).
 */
export function sweep(path: THREE.Vector3[], up: THREE.Vector3 | ((i: number) => THREE.Vector3), section: P[], closed: boolean, scale?: (i: number) => number): THREE.BufferGeometry {
  const n = path.length;
  const m = section.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const uvs: number[] = [];
  const t = new THREE.Vector3();
  const x = new THREE.Vector3();
  const y = new THREE.Vector3();
  let along = 0;
  for (let i = 0; i < n; i++) {
    const prev = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    t.subVectors(next, prev).normalize();
    const u = typeof up === "function" ? up(i) : up;
    x.crossVectors(u, t).normalize();
    y.crossVectors(t, x).normalize();
    if (i > 0) along += path[i].distanceTo(path[i - 1]);
    const s = scale ? scale(i) : 1;
    let around = 0;
    for (let k = 0; k <= m; k++) {
      const [a, b] = section[k % m];
      if (k > 0) around += Math.hypot(a - section[k - 1][0], b - section[k - 1][1]);
      pos.push(path[i].x + (x.x * a + y.x * b) * s, path[i].y + (x.y * a + y.y * b) * s, path[i].z + (x.z * a + y.z * b) * s);
      uvs.push(along, around);
    }
  }
  const rings = n;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const i1 = (i + 1) % rings;
    for (let k = 0; k < m; k++) {
      const a = i * (m + 1) + k;
      const b = i1 * (m + 1) + k;
      // Section points run counter-clockwise seen from ahead, so this winding faces out.
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  if (!closed && n > 1) {
    // Cap both ends of an open sweep with a fan, wound to face away from the path.
    const V = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    for (const [ring, dir] of [[0, path[0].clone().sub(path[1])], [n - 1, path[n - 1].clone().sub(path[n - 2])]] as [number, THREE.Vector3][]) {
      const base = ring * (m + 1);
      const c = new THREE.Vector3();
      for (let k = 0; k < m; k++) c.add(V(base + k));
      c.divideScalar(m);
      const ci = pos.length / 3;
      pos.push(c.x, c.y, c.z);
      uvs.push(0, 0);
      const fn = new THREE.Vector3().subVectors(V(base), c).cross(new THREE.Vector3().subVectors(V(base + 1), c));
      const flip = fn.dot(dir) < 0;
      for (let k = 0; k < m; k++) {
        if (flip) idx.push(ci, base + k + 1, base + k);
        else idx.push(ci, base + k, base + k + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return finishGeometry(g, "x");
}

/** A circular (or elliptical) wire section with `n` points, counter-clockwise. */
export function circleSection(rx: number, ry = rx, n = 14): P[] {
  const out: P[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push([Math.cos(a) * rx, Math.sin(a) * ry]);
  }
  return out;
}

/** A rounded rectangle outline (counter-clockwise), centred on the origin. */
export function roundedRect(w: number, h: number, r: number, steps = 6): THREE.Shape {
  const s = new THREE.Shape();
  const x = w / 2, y = h / 2;
  r = Math.min(r, x - 1e-3, y - 1e-3);
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r);
  s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y);
  s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r);
  s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  void steps;
  return s;
}

/** The same outline as a hole path (clockwise). */
export function roundedRectPath(w: number, h: number, r: number): THREE.Path {
  const p = new THREE.Path();
  const pts = roundedRect(w, h, r).getPoints(8).reverse();
  p.setFromPoints(pts);
  return p;
}

/**
 * Extrude a flat outline into a plate of `depth` with rounded bevels (`bevel` mm) on its top and
 * bottom edges. The plate sits on z = 0 and rises to depth + 2 * bevel.
 */
export function plate(shape: THREE.Shape, depth: number, bevel: number, opts: { curve?: number; bevelSegments?: number } = {}): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, depth),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: opts.bevelSegments ?? 4,
    curveSegments: opts.curve ?? 10,
  });
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g, 1e-4);
  g.translate(0, 0, bevel);
  g.computeVertexNormals();
  return finishGeometry(g, "x");
}

/** A box with rounded edges, sitting on z = 0. */
export function roundBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const shape = roundedRect(w, h, Math.min(r * 1.6, w / 2, h / 2));
  return plate(shape, Math.max(0.01, d - 2 * r), r, { curve: 4, bevelSegments: 3 });
}

/** Planar uv (mm) for geometry that has none, chosen so no face is degenerate. */
function planarUv(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute("position");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) + 0.5 * pos.getZ(i);
    uv[i * 2 + 1] = pos.getY(i) + 0.8 * pos.getZ(i);
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

const tmpA = new THREE.Vector3();
const tmpN = new THREE.Vector3();

/**
 * Add the attributes hardware materials expect: uv (if missing), tangent along the brushing
 * direction ("spin": round the z axis, "x": along +x), and wear from curvature.
 */
export function finishGeometry(g: THREE.BufferGeometry, brush: "spin" | "x"): THREE.BufferGeometry {
  if (!g.index) g = mergeVertices(g, 1e-4);
  if (!g.getAttribute("uv")) planarUv(g);
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const n = pos.count;
  const tan = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    tmpN.fromBufferAttribute(nor, i);
    if (brush === "spin") tmpA.set(-pos.getY(i), pos.getX(i), 0);
    else tmpA.set(1, 0, 0);
    if (tmpA.lengthSq() < 1e-8) tmpA.set(1, 0, 0);
    tmpA.addScaledVector(tmpN, -tmpA.dot(tmpN));
    if (tmpA.lengthSq() < 1e-6) {
      tmpA.set(0, 1, 0).addScaledVector(tmpN, -tmpN.y);
    }
    tmpA.normalize();
    tan[i * 4] = tmpA.x;
    tan[i * 4 + 1] = tmpA.y;
    tan[i * 4 + 2] = tmpA.z;
    tan[i * 4 + 3] = 1;
  }
  g.setAttribute("tangent", new THREE.BufferAttribute(tan, 4));
  bakeWear(g);
  return g;
}

/**
 * Mean curvature per vertex from the normals of its neighbours: convex rims and fillets are
 * worn and polished, concave corners collect dirt.
 */
function bakeWear(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const idx = g.index!;
  const n = pos.count;
  const k = new Float32Array(n);
  const c = new Float32Array(n);
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), na = new THREE.Vector3(), nb = new THREE.Vector3();
  const edge = (a: number, b: number) => {
    pa.fromBufferAttribute(pos, a);
    pb.fromBufferAttribute(pos, b);
    na.fromBufferAttribute(nor, a);
    nb.fromBufferAttribute(nor, b);
    const d2 = pa.distanceToSquared(pb);
    if (d2 < 1e-10) return;
    const kk = (na.sub(nb).dot(pa.sub(pb))) / d2;
    k[a] += kk;
    k[b] += kk;
    c[a]++;
    c[b]++;
  };
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), d = idx.getX(t + 2);
    edge(a, b);
    edge(b, d);
    edge(d, a);
  }
  const wear = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cv = c[i] ? k[i] / c[i] : 0;
    wear[i] = cv > 0 ? THREE.MathUtils.smoothstep(cv, 1.8, 5.5) : -THREE.MathUtils.smoothstep(-cv, 1.0, 4.0);
  }
  g.setAttribute("wear", new THREE.BufferAttribute(wear, 1));
}

/** Merge parts that share a material into one geometry. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const keep = ["position", "normal", "uv", "tangent", "wear"];
  const ready = parts.map((p) => {
    const g = p.index ? p : mergeVertices(p, 1e-4);
    for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
    g.morphAttributes = {};
    return g;
  });
  if (ready.length === 1) return ready[0];
  return mergeGeometries(ready, false) ?? ready[0];
}

/** Move, turn and scale a geometry in place and return it. */
export function place(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** Mirror a geometry through z = 0 (front part to the back of the leather), keeping winding. */
export function flipZ(g: THREE.BufferGeometry, z0: number): THREE.BufferGeometry {
  g.rotateX(Math.PI);
  g.translate(0, 0, z0);
  return g;
}
