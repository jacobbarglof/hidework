// Detailed models of the 23 kinds of set hardware, at true size from the craft catalogue
// (crates/hidework-core/src/craft.rs). Each model is built once per kind, size, leather thickness
// and role, merged into one geometry per finish, and reused (instanced) for every placement.
//
// Frame: origin on the grain surface, +z out of the leather, +x along the hardware's angle. Back
// parts (posts, burrs, washers, prongs) sit on the flesh side at z = -t.
//
// Roles: a fastener set through two layers is drawn once as a set. The outer piece (grain facing
// away from the other layer) shows the front part; the inner piece shows the back part on its
// flesh side. "single" shows both (one layer, or no partner found).

import * as THREE from "three";
import { arc, circleSection, fillet, flipZ, lathe, merge, plate, roundBox, roundedRect, roundedRectPath, sweep, type C, type P } from "./shapes";
import type { Finish } from "./metals";

export type Role = "single" | "outer" | "inner";
export type PartFinish = Finish | "tape" | "copper" | "copperDark";

export interface Part {
  geo: THREE.BufferGeometry;
  finish: PartFinish;
}

/** Kinds that join two layers and come as a matching pair (front and back parts). */
export const PAIRED = new Set(["rivet-s", "rivet-m", "rivet-l", "copper-rivet", "chicago-screw", "snap-24", "snap-20", "magnet-18"]);

interface Model {
  front: Part[];
  back: Part[];
}

const segs = (d: number) => Math.round(THREE.MathUtils.clamp(d * 3.2, 28, 72));

/** A domed cap profile: base at z0, a rolled lip, a vertical skirt, then a superellipse dome. */
function domeProfile(r: number, z0: number, skirt: number, h: number, q = 2.2, lip = 0.3, n = 12): P[] {
  const base = fillet([[0, z0], [r * 0.88, z0], [r, z0 + lip * 0.6, lip], [r, skirt]], 4);
  const top: P[] = [];
  for (let k = 1; k <= n; k++) {
    const a = (k / n) * (Math.PI / 2);
    const c = Math.cos(a), s = Math.sin(a);
    top.push([r * Math.pow(c, 2 / q), skirt + (h - skirt) * Math.pow(s, 2 / q)]);
  }
  return [...base, ...top];
}

/** A closed loop profile (does not touch the axis): repeat the first point to close it. */
function loop(corners: C[], steps = 4): P[] {
  const pts = fillet([...corners, corners[0], corners[1]], steps);
  // Drop the duplicated start so the loop closes on itself exactly once.
  return pts.slice(1);
}

function back(parts: Part[], t: number): Part[] {
  return parts.map((p) => ({ geo: flipZ(p.geo, -t), finish: p.finish }));
}

/** A slotted screw head (Chicago screw back, Sam Browne and concho screws, plate screws). */
function screwHead(r: number, h: number, slot: number, dome = 0.25): Part[] {
  const base = lathe(fillet([[0, -0.1], [r * 0.9, -0.1], [r, 0.2, 0.25], [r, h * 0.55], [r * 0.98, h * 0.58], [0, h * 0.58]], 4), { segments: segs(r * 2) });
  const halves: THREE.BufferGeometry[] = [];
  const rr = r * 0.985;
  const a0 = Math.asin(Math.min(0.9, slot / 2 / rr));
  for (const sgn of [1, -1]) {
    const s = new THREE.Shape();
    s.absarc(0, 0, rr, a0, Math.PI - a0, false);
    s.closePath();
    const g = plate(s, Math.max(0.05, h * 0.42 - 2 * dome), dome, { curve: 20, bevelSegments: 3 });
    g.translate(0, 0, h * 0.55);
    if (sgn < 0) g.rotateZ(Math.PI);
    halves.push(g);
  }
  const slotFloor = roundBox(r * 1.9, slot, 0.06, 0.02);
  slotFloor.translate(0, 0, h * 0.58);
  return [{ geo: merge([base, ...halves]), finish: "polished" }, { geo: slotFloor, finish: "dark" }];
}

function rivet(s: number, t: number): Model {
  const r = s / 2;
  // Spun caps: a low crown over a short skirt with a rolled edge.
  const front = lathe(domeProfile(r, -0.15, 0.06 * s, 0.34 * s, 2.7, 0.4), { segments: segs(s) });
  const rear = lathe(domeProfile(r * 0.96, -0.15, 0.05 * s, 0.28 * s, 3.0, 0.35), { segments: segs(s) });
  return { front: [{ geo: front, finish: "polished" }], back: back([{ geo: rear, finish: "polished" }], t) };
}

function copperRivet(s: number, t: number): Model {
  const r = s * 0.46;
  const head = lathe(domeProfile(r, -0.1, 0.5, 1.45, 3.4, 0.3), { segments: segs(s) });
  // The burr (rove): a dished washer, high in the middle, with the post peened over it.
  const R = s / 2, ri = 1.45;
  const burr = lathe(loop([[ri, 0.55, 0.12], [R, 0.0, 0.15], [R, 0.5, 0.15], [ri + 0.2, 1.05, 0.15], [ri, 0.9, 0.1]], 3), { segments: segs(s) });
  const n = 14;
  const peen = lathe(fillet([[0, 0.6], [1.35, 0.6], [1.35, 1.25, 0.2], [2.05, 1.5, 0.35], [1.6, 2.15, 0.5], [0, 2.35]], 4), {
    segments: segs(6),
    // Hammer facets on the peened head.
    mod: (phi, j) => (j > n * 0.35 ? 1 + 0.055 * Math.sin(phi * 7 + j * 1.3) * Math.cos(phi * 3 - j) : 1),
  });
  return {
    front: [{ geo: head, finish: "copper" }],
    back: back([{ geo: merge([burr, peen]), finish: "copper" }], t),
  };
}

function chicago(s: number, t: number): Model {
  const r = s / 2;
  const head = lathe(domeProfile(r, -0.1, 0.8, 1.9, 3.6, 0.35), { segments: segs(s) });
  return { front: [{ geo: head, finish: "polished" }], back: back(screwHead(r, 1.8, Math.max(0.8, s * 0.09)), t) };
}

function snap(s: number, t: number, role: Role): Model {
  const k = s / 15;
  const r = s / 2;
  const H = 0.27 * s;
  // Cap: a rolled rim bead round a low dome, as press-stud caps are made.
  const capPts = fillet([[0, -0.1], [r * 0.9, -0.1], [r, 0.35, 0.4], [r, 0.95 * k, 0.5], [r - 0.75 * k, 1.45 * k, 0.45], [r - 1.25 * k, 1.2 * k, 0.2]], 4);
  const rd = r - 1.3 * k;
  for (let i = 1; i <= 14; i++) {
    const a = (i / 14) * (Math.PI / 2);
    capPts.push([rd * Math.pow(Math.cos(a), 2 / 2.2), 1.25 * k + (H - 1.25 * k) * Math.pow(Math.sin(a), 2 / 2.2)]);
  }
  const cap = lathe(capPts, { segments: segs(s) });
  // Socket, on the flesh side of the cap's layer: flange, collar and the spring across the mouth.
  const rh = 2.1 * k, rc = 3.6 * k, R = 5.4 * k;
  const socket = lathe(loop([[rh, 0], [R, 0, 0.15], [R, 0.55, 0.25], [rc + 0.3, 0.6, 0.25], [rc, 0.9, 0.2], [rc, 2.1 * k, 0.35], [rh + 0.45, 2.1 * k, 0.35], [rh, 1.6 * k, 0.2]], 3), { segments: segs(s) });
  const wires: THREE.BufferGeometry[] = [];
  for (const y of [-rh * 0.72, rh * 0.72]) {
    const path = [new THREE.Vector3(-rc * 0.98, y, 1.25 * k), new THREE.Vector3(rc * 0.98, y, 1.25 * k)];
    wires.push(sweep(path, new THREE.Vector3(0, 0, 1), circleSection(0.27 * k, 0.27 * k, 8), false));
  }
  const hole = lathe([[rh, 0.05], [0, 0.05]], { segments: 24 });
  // Stud, on the grain side of the other layer: flange, neck and the bulb that clicks in.
  const RF = 0.33 * s;
  const stud = lathe(fillet([[0, -0.1], [RF * 0.9, -0.1], [RF, 0.15, 0.2], [RF, 0.55, 0.2], [2.15 * k, 0.75, 0.3], [1.95 * k, 1.6 * k, 0.2], [2.6 * k, 2.25 * k, 0.45], [2.25 * k, 3.0 * k, 0.5], [0, 3.15 * k]], 4), { segments: segs(s) });
  // Post, on the flesh side of the stud's layer: a flange rolled over round a hole.
  const post = lathe(loop([[1.0 * k, 0], [RF, 0, 0.15], [RF, 0.5, 0.2], [2.4 * k, 0.6, 0.3], [2.4 * k, 1.1 * k, 0.35], [1.0 * k + 0.35, 1.45 * k, 0.3], [1.0 * k, 1.0 * k, 0.15]], 3), { segments: segs(s) });
  const postHole = lathe([[1.0 * k, 0.3], [0, 0.3]], { segments: 24 });
  if (role === "inner") return { front: [{ geo: stud, finish: "polished" }], back: back([{ geo: post, finish: "polished" }, { geo: postHole, finish: "dark" }], t) };
  return { front: [{ geo: cap, finish: "polished" }], back: back([{ geo: merge([socket, ...wires]), finish: "polished" }, { geo: hole, finish: "dark" }], t) };
}

function magnet(s: number, t: number, role: Role): Model {
  const R = 0.47 * s, H = 3.2;
  const male = role === "inner";
  const rim: C[] = [[0, -0.1], [R * 0.9, -0.1], [R, 0.2, 0.3], [R, H - 0.95], [R - 0.3, H - 0.7, 0.15], [R - 0.08, H - 0.45, 0.15], [R - 0.15, H, 0.3], [R - 1.2, H, 0.2], [R - 1.45, H - 0.25, 0.2]];
  const face: C[] = male
    ? [[3.4, H - 0.25, 0.35], [3.3, H + 1.7, 0.9], [2.2, H + 2.1, 0.8], [0, H + 2.15]]
    : [[4.7, H - 0.25, 0.3], [4.6, H + 0.6, 0.3], [3.3, H + 0.65, 0.3], [3.05, H - 0.1, 0.2], [3.0, H - 0.6], [0, H - 0.6]];
  const body = lathe(fillet([...rim, ...face], 4), { segments: segs(s) });
  const disc: Part[] = [{ geo: body, finish: "polished" }];
  if (!male) disc.push({ geo: lathe([[3.0, H - 0.55], [0, H - 0.55]], { segments: 24 }), finish: "dark" });
  // Washer with the two prongs folded flat over it.
  const ws = new THREE.Shape();
  ws.absarc(0, 0, s / 2, 0, Math.PI * 2, false);
  const hc = new THREE.Path();
  hc.absarc(0, 0, 1.6, 0, Math.PI * 2, true);
  const slit = (x: number) => {
    const p = roundedRectPath(1.6, 6.4, 0.6);
    const pts = p.getPoints(6).map((v) => new THREE.Vector2(v.x + x, v.y));
    return new THREE.Path(pts);
  };
  ws.holes = [slit(-0.39 * s), slit(0.39 * s), hc];
  const washer = plate(ws, 0.3, 0.15, { curve: 32, bevelSegments: 2 });
  const prongs: THREE.BufferGeometry[] = [];
  for (const sg of [-1, 1]) {
    const flat = roundBox(4.8, 5.2, 0.5, 0.2);
    flat.translate(sg * (0.39 * s - 2.1), 0, 0.55);
    const bend = sweep(arc(0, 0, 0.5, 0.5, 0, Math.PI / 2, 6).map(([a, b]) => new THREE.Vector3(sg * (0.39 * s + 0.25 - a), 0, 0.3 + b)), new THREE.Vector3(0, sg, 0), [[-0.25, -2.6], [0.25, -2.6], [0.25, 2.6], [-0.25, 2.6]], false);
    prongs.push(flat, bend);
  }
  const washerParts: Part[] = [{ geo: merge([washer, ...prongs]), finish: "brushed" }];
  // The outer layer (a flap) has its magnet facing the other layer, so on its flesh side.
  if (role === "outer") return { front: washerParts, back: back(disc, t) };
  return { front: disc, back: back(washerParts, t) };
}

function turnlockCatch(s: number, t: number): Model {
  const plateG = plate(roundedRect(s, 0.48 * s, 0.17 * s), 0.6, 0.45, { curve: 12 });
  const rb = 0.2 * s;
  const boss = lathe(fillet([[0, 1.45], [rb + 0.7, 1.45], [rb, 1.75, 0.35], [rb, 2.55, 0.4], [rb * 0.55, 2.75], [0, 2.75]], 4), { segments: segs(s) });
  const L = 0.53 * s, W = 0.21 * s;
  const turn = plate(roundedRect(W, L, W / 2), 2.0, 1.0, { curve: 14, bevelSegments: 5 });
  turn.translate(0, 0, 2.7);
  const pin = lathe(domeProfile(1.25, 6.6, 6.75, 7.25, 2.2, 0.15), { segments: 24 });
  // Back plate with the two prongs folded in toward the middle.
  const bp = plate(roundedRect(0.8 * s, 0.36 * s, 0.12 * s), 0.3, 0.15);
  const pr: THREE.BufferGeometry[] = [];
  for (const sg of [-1, 1]) {
    const p = roundBox(4.6, 3.6, 0.5, 0.2);
    p.translate(sg * (0.4 * s - 2.2), 0, 0.58);
    pr.push(p);
  }
  return {
    front: [{ geo: plateG, finish: "brushed" }, { geo: merge([boss, turn, pin]), finish: "polished" }],
    back: back([{ geo: merge([bp, ...pr]), finish: "brushed" }], t),
  };
}

function turnlockEyelet(s: number, t: number): Model {
  const Lw = 0.9 * s, Hw = 0.4 * s;
  const outer = roundedRect(Lw + 8, Hw + 8, (Hw + 8) / 2);
  outer.holes.push(roundedRectPath(Lw, Hw, Hw / 2));
  const frame = plate(outer, 0.6, 0.5, { curve: 16 });
  const lipS = roundedRect(Lw + 1.0, Hw + 1.0, (Hw + 1) / 2);
  lipS.holes.push(roundedRectPath(Lw, Hw, Hw / 2));
  const lip = plate(lipS, Math.max(0.1, t), 0, { curve: 16 });
  lip.translate(0, 0, -t);
  const bo = roundedRect(Lw + 6, Hw + 6, (Hw + 6) / 2);
  bo.holes.push(roundedRectPath(Lw + 0.4, Hw + 0.4, (Hw + 0.4) / 2));
  const bframe = plate(bo, 0.3, 0.15, { curve: 16 });
  const pr: THREE.BufferGeometry[] = [];
  for (const x of [-Lw * 0.25, Lw * 0.25]) {
    for (const sg of [-1, 1]) {
      const p = roundBox(3.2, 2.6, 0.45, 0.18);
      p.translate(x, sg * (Hw / 2 + 1.4), 0.5);
      pr.push(p);
    }
  }
  return {
    front: [{ geo: merge([frame, lip]), finish: "polished" }],
    back: back([{ geo: merge([bframe, ...pr]), finish: "brushed" }], t),
  };
}

function samBrowne(s: number, t: number): Model {
  const r = s / 2;
  const stud = lathe(fillet([[0, -0.1], [3.4, -0.1], [3.5, 0.25, 0.2], [2.7, 0.55, 0.3], [2.0, 0.8, 0.4], [2.0, 3.6], [r * 0.9, 3.75, 0.2], [r, 4.25, 0.5], [r, 4.9, 0.6], [r * 0.6, 6.55, 2.0], [0, 6.75]], 5), { segments: segs(s) });
  return { front: [{ geo: stud, finish: "polished" }], back: back(screwHead(3.5, 1.5, 0.8), t) };
}

function grommet(s: number, t: number, small: boolean): Model {
  const ri = s / 2;
  const ro = ri + (small ? 2.0 : Math.max(2.4, 0.5 * s));
  const h = small ? 1.1 : 1.3 + 0.07 * s;
  const w = small ? 0.3 : 0.45;
  const front = lathe(loop([[ri + w, -t - 0.25], [ri + w, -0.05, 0.3], [ro - 0.3, -0.05, 0.4], [ro, 0.2, 0.45], [ro * 0.5 + ri * 0.5, h, (ro - ri) * 0.42], [ri, h * 0.35, 0.5], [ri, -t - 0.25]], 5), { segments: segs(ro * 2) });
  let rear: THREE.BufferGeometry;
  if (small) {
    // Eyelets have no washer: the barrel is split into petals and rolled back on the leather.
    rear = lathe(loop([[ri, 0.0], [ri + 1.6, 0.0, 0.25], [ri + 1.5, 0.5, 0.3], [ri + 0.3, 0.75, 0.3]], 3), { segments: 48, mod: (phi, j, n) => (j >= n / 3 ? 1 + 0.12 * Math.max(0, Math.cos(phi * 6)) : 1) });
  } else {
    const washer = lathe(loop([[ri + 0.5, 0.0], [ro * 0.92, 0.0, 0.15], [ro * 0.92, 0.45, 0.2], [ri + 0.6, 0.85, 0.2]], 3), { segments: segs(ro * 2) });
    const roll = lathe(arc(ri + 0.55, 0.95, 0.45, 0.45, -Math.PI / 2, Math.PI * 1.5, 12), { segments: segs(ro * 2) });
    rear = merge([washer, roll]);
  }
  return { front: [{ geo: front, finish: "polished" }], back: back([{ geo: rear, finish: "polished" }], t) };
}

function bagFoot(s: number, t: number): Model {
  const r = s / 2;
  const dome = lathe([...fillet([[0, -0.1], [r * 0.88, -0.1], [r, 0.2, 0.3], [r * 0.98, 0.9]], 4), ...domeProfile(r * 0.98, 0.9, 0.9, 0.5 * s, 2.3, 0).slice(4)], { segments: segs(s) });
  const ws = new THREE.Shape();
  ws.absarc(0, 0, 0.45 * s, 0, Math.PI * 2, false);
  const hc = new THREE.Path();
  hc.absarc(0, 0, 1.5, 0, Math.PI * 2, true);
  ws.holes.push(hc);
  const washer = plate(ws, 0.3, 0.15, { curve: 28 });
  const legs: THREE.BufferGeometry[] = [];
  for (const sg of [-1, 1]) {
    const p = roundBox(0.32 * s, 2.3, 0.5, 0.2);
    p.translate(sg * (0.16 * s + 0.4), 0, 0.58);
    legs.push(p);
  }
  return { front: [{ geo: dome, finish: "polished" }], back: back([{ geo: merge([washer, ...legs]), finish: "polished" }], t) };
}

/** A closed outline in the xz plane, sampled evenly, for swept rings. */
function outline(points: THREE.Vector3[], n: number): THREE.Vector3[] {
  const c = new THREE.CatmullRomCurve3(points, true, "centripetal");
  return c.getSpacedPoints(n).slice(0, n);
}

/** A weld bead round a wire: a slightly proud band where the ring was closed. */
function weld(at: THREE.Vector3, along: THREE.Vector3, w: number): THREE.BufferGeometry {
  const g = lathe(loop([[w * 0.92, -0.5], [w + 0.16, -0.18, 0.12], [w + 0.18, 0.15, 0.12], [w * 0.92, 0.5]], 3), { segments: 20 });
  g.lookAt(along);
  g.translate(at.x, at.y, at.z);
  return g;
}

function dRing(s: number): Model {
  const w = Math.max(1.2, 0.075 * s);
  const a = s / 2 + w;
  const legs = 0.15 * s;
  const top = 0.62 * s;
  const pts: THREE.Vector3[] = [];
  // Straight bar along the leather, rounded corners, short legs, then the bow of the D.
  const rc = 0.28 * s;
  for (let k = 0; k <= 8; k++) pts.push(new THREE.Vector3(-a + rc + (2 * (a - rc) * k) / 8, 0, 0));
  for (const [x, z] of arc(a - 0.28 * s, 0.28 * s, 0.28 * s, 0.28 * s, -Math.PI / 2, 0, 6).slice(1)) pts.push(new THREE.Vector3(x, 0, z));
  for (const [x, z] of arc(0, Math.max(legs, 0.28 * s), a, top, 0, Math.PI, 28).slice(1, -1)) pts.push(new THREE.Vector3(x, 0, z));
  for (const [x, z] of arc(-a + 0.28 * s, 0.28 * s, 0.28 * s, 0.28 * s, Math.PI, Math.PI * 1.5, 6).slice(0, -1)) pts.push(new THREE.Vector3(x, 0, z));
  const path = outline(pts, 140).map((p) => p.setZ(p.z + w));
  const ring = sweep(path, new THREE.Vector3(0, 1, 0), circleSection(w, w, 16), true);
  const bead = weld(new THREE.Vector3(0, 0, w), new THREE.Vector3(1, 0, 0), w);
  return { front: [{ geo: merge([ring, bead]), finish: "polished" }], back: [] };
}

function oRing(s: number): Model {
  const w = Math.max(1.2, 0.075 * s);
  const R = s / 2 + w;
  const path: THREE.Vector3[] = [];
  const n = 120;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    path.push(new THREE.Vector3(Math.cos(a) * R, 0, R + w + Math.sin(a) * R));
  }
  const ring = sweep(path, new THREE.Vector3(0, 1, 0), circleSection(w, w, 16), true);
  const bead = weld(new THREE.Vector3(R, 0, R + w), new THREE.Vector3(0, 0, 1), w);
  return { front: [{ geo: merge([ring, bead]), finish: "polished" }], back: [] };
}

function squareRing(s: number): Model {
  const w = Math.max(1.3, 0.08 * s);
  const X = s / 2 + w, Z = 0.3 * s + w;
  const rc = 1.6 * w;
  const pts: THREE.Vector3[] = [];
  const corner = (cx: number, cz: number, a0: number) => arc(cx, cz, rc, rc, a0, a0 + Math.PI / 2, 5).forEach(([x, z]) => pts.push(new THREE.Vector3(x, 0, z)));
  corner(X - rc, -Z + rc, -Math.PI / 2);
  corner(X - rc, Z - rc, 0);
  corner(-X + rc, Z - rc, Math.PI / 2);
  corner(-X + rc, -Z + rc, Math.PI);
  const path = outline(pts, 140).map((p) => p.setZ(p.z + Z + w));
  // Square wire with softened corners, as cast square rings are.
  const sec: P[] = [];
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    const c = Math.cos(a), sn = Math.sin(a);
    sec.push([w * Math.sign(c) * Math.pow(Math.abs(c), 0.6), w * Math.sign(sn) * Math.pow(Math.abs(sn), 0.6)]);
  }
  const ring = sweep(path, new THREE.Vector3(0, 1, 0), sec, true);
  const bead = weld(new THREE.Vector3(X, 0, Z + w), new THREE.Vector3(0, 0, 1), w * 1.05);
  return { front: [{ geo: merge([ring, bead]), finish: "polished" }], back: [] };
}

function keyRing(s: number): Model {
  const R = s / 2;
  const turns = 2;
  const pitch = 0.95;
  const n = 220;
  const path: THREE.Vector3[] = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * turns * Math.PI * 2 - 0.25;
    path.push(new THREE.Vector3(Math.cos(a) * R, (a / (Math.PI * 2)) * pitch - pitch, R + 1 + Math.sin(a) * R));
  }
  // A flat wire, rounded on its edges; the ends are cut on a slant and taper away.
  const sec: P[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    sec.push([0.42 * Math.cos(a), 0.95 * Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), 0.5)]);
  }
  const ring = sweep(path, (i) => {
    const a = (i / n) * turns * Math.PI * 2 - 0.25;
    return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  }, sec, false, (i) => {
    const e = Math.min(i, n - i) / 10;
    return e >= 1 ? 1 : 0.35 + 0.65 * e;
  });
  return { front: [{ geo: ring, finish: "polished" }], back: [] };
}

function buckle(s: number): Model {
  const w = Math.max(1.6, 0.085 * s);
  const X = 0.38 * s + w, Y = s / 2 + 1 + w;
  const zc = 0.85 * w;
  const rc = 0.22 * s;
  const pts: THREE.Vector3[] = [];
  const corner = (cx: number, cy: number, a0: number) => arc(cx, cy, rc, rc, a0, a0 + Math.PI / 2, 6).forEach(([x, y]) => pts.push(new THREE.Vector3(x, y, zc)));
  corner(X - rc, -Y + rc, -Math.PI / 2);
  corner(X - rc, Y - rc, 0);
  corner(-X + rc, Y - rc, Math.PI / 2);
  corner(-X + rc, -Y + rc, Math.PI);
  const framePath = outline(pts, 160).map((p) => p.setZ(zc));
  // A cast frame: oval section, wider than it is tall.
  const frame = sweep(framePath, new THREE.Vector3(0, 0, 1), circleSection(w * 1.1, w * 0.85, 16), true);
  // Centre (heel) bar across the strap at the tongue slot.
  const bar = sweep([new THREE.Vector3(0, -Y, zc), new THREE.Vector3(0, Y, zc)], new THREE.Vector3(0, 0, 1), circleSection(w * 0.8, w * 0.8, 14), false);
  // Roller on the front bar.
  const rr = w + 0.75;
  const L = 2 * (Y - rc) - 1;
  const roller = lathe(fillet([[0, -L / 2], [rr, -L / 2, 0.5], [rr, L / 2, 0.5], [0, L / 2]], 4), { segments: 32 });
  roller.rotateX(-Math.PI / 2);
  roller.translate(X, 0, zc);
  // Tongue: wraps the heel bar, runs to the roller and dips past it into the strap's hole.
  const tr = w * 0.8 + 0.85;
  const tp: THREE.Vector3[] = [];
  for (const [x, z] of arc(0, zc, tr, tr, Math.PI * 1.35, Math.PI * 0.42, 10)) tp.push(new THREE.Vector3(x, 0, z));
  const topZ = zc + rr + 0.75;
  tp.push(new THREE.Vector3(X * 0.35, 0, topZ + 0.7), new THREE.Vector3(X * 0.75, 0, topZ + 0.35), new THREE.Vector3(X - 0.6, 0, topZ), new THREE.Vector3(X + rr * 0.7, 0, topZ - 0.6), new THREE.Vector3(X + rr + 0.6, 0, zc - 0.2), new THREE.Vector3(X + rr + 0.9, 0, -0.6));
  const tcurve = new THREE.CatmullRomCurve3(tp, false, "centripetal").getSpacedPoints(70);
  const tongue = sweep(tcurve, new THREE.Vector3(0, 1, 0), circleSection(0.85, 1.55, 14), false, (i) => (i > 60 ? 1 - (i - 60) * 0.045 : 1));
  return { front: [{ geo: merge([frame, bar, roller, tongue]), finish: "polished" }], back: [] };
}

function swivel(s: number): Model {
  const w = Math.max(1.3, 0.07 * s);
  // The strap eye: a rounded rectangular loop standing on the leather.
  const X = s / 2 + w, Z = 0.17 * s + w;
  const rc = 1.8 * w;
  const pts: THREE.Vector3[] = [];
  const corner = (cx: number, cz: number, a0: number) => arc(cx, cz, rc, rc, a0, a0 + Math.PI / 2, 5).forEach(([x, z]) => pts.push(new THREE.Vector3(x, 0, z)));
  corner(X - rc, -Z + rc, -Math.PI / 2);
  corner(X - rc, Z - rc, 0);
  corner(-X + rc, Z - rc, Math.PI / 2);
  corner(-X + rc, -Z + rc, Math.PI);
  const eye = sweep(outline(pts, 120).map((p) => p.setZ(p.z + Z + w)), new THREE.Vector3(0, 1, 0), circleSection(w, w, 14), true);
  // Swivel joint: collar, neck, collar.
  const z0 = 2 * Z + 2 * w - 0.4;
  const joint = lathe(fillet([[0, z0], [2.8, z0, 0.3], [2.8, z0 + 1.4, 0.4], [1.7, z0 + 1.7, 0.3], [1.7, z0 + 2.9], [3.2, z0 + 3.2, 0.5], [3.2, z0 + 5.0, 0.6], [2.4, z0 + 5.6, 0.4], [0, z0 + 5.6]], 4), { segments: 40 });
  // Hook body: up the spine, over the top and down to the nose; oval section, tapering.
  const zb = z0 + 5.2;
  const Hh = 1.25 * s, Wh = 0.42 * s;
  const hp: THREE.Vector3[] = [
    new THREE.Vector3(0.05 * s, 0, zb),
    new THREE.Vector3(-0.12 * s, 0, zb + 0.2 * Hh),
    new THREE.Vector3(-Wh / 2, 0, zb + 0.55 * Hh),
  ];
  for (const [x, z] of arc(0, zb + 0.72 * Hh, Wh / 2, 0.28 * Hh, Math.PI, 0, 14).slice(1)) hp.push(new THREE.Vector3(x, 0, z));
  hp.push(new THREE.Vector3(Wh / 2 - 0.4, 0, zb + 0.6 * Hh), new THREE.Vector3(Wh / 2 - 1.2, 0, zb + 0.5 * Hh));
  const hc = new THREE.CatmullRomCurve3(hp, false, "centripetal").getSpacedPoints(90);
  const hook = sweep(hc, new THREE.Vector3(0, 1, 0), circleSection(1.25 + 0.03 * s, 1.7 + 0.04 * s, 14), false, (i) => 1.15 - 0.45 * (i / 90));
  // Gate: a flat spring bar from the body to the nose, on its pin.
  const g0 = new THREE.Vector3(0.12 * s, 0, zb + 0.08 * Hh);
  const g1 = new THREE.Vector3(Wh / 2 - 1.6, 0, zb + 0.47 * Hh);
  const gate = sweep([g0, g0.clone().lerp(g1, 0.5).add(new THREE.Vector3(0.5, 0, 0)), g1], new THREE.Vector3(0, 1, 0), circleSection(0.55, 1.5, 12), false);
  const pin = lathe(fillet([[0, -2.3], [0.7, -2.3, 0.2], [0.7, 2.3, 0.2], [0, 2.3]], 3), { segments: 16 });
  pin.rotateX(-Math.PI / 2);
  pin.translate(g0.x, 0, g0.z);
  // The coil spring at the gate's root.
  const coil: THREE.Vector3[] = [];
  for (let k = 0; k <= 60; k++) {
    const a = (k / 60) * Math.PI * 2 * 4;
    coil.push(new THREE.Vector3(g0.x - 1.2 + Math.cos(a) * 0.9, -1.4 + (k / 60) * 2.8, g0.z + 1.2 + Math.sin(a) * 0.9));
  }
  const spring = sweep(coil, new THREE.Vector3(0, 1, 0), circleSection(0.2, 0.2, 6), false);
  return { front: [{ geo: merge([eye, joint, hook, gate, pin]), finish: "polished" }, { geo: spring, finish: "brushed" }], back: [] };
}

let toothGeo: THREE.BufferGeometry | null = null;
/**
 * One #5 metal zipper tooth (about 60 triangles): a scoop outline, wider at its head, with a
 * chamfer. Head toward +y, top at z = 1.25, chain running along x. Shared: do not dispose.
 */
export function zipperTooth(): THREE.BufferGeometry {
  if (toothGeo) return toothGeo;
  const ts = new THREE.Shape();
  ts.moveTo(-0.7, -1.8);
  ts.lineTo(0.7, -1.8);
  ts.lineTo(0.7, 0.6);
  ts.quadraticCurveTo(0.95, 1.2, 0.55, 1.75);
  ts.lineTo(-0.55, 1.75);
  ts.quadraticCurveTo(-0.95, 1.2, -0.7, 0.6);
  ts.closePath();
  toothGeo = plate(ts, 0.75, 0.25, { curve: 2, bevelSegments: 1 });
  return toothGeo;
}

let sliderParts: Part[] | null = null;
/**
 * A zipper slider centred on x = 0, riding a chain whose teeth top out at z = 0: the shaped top
 * plate, the lug the pull hangs from, and the pull tab lying back along -x. Shared.
 */
export function zipperSlider(): Part[] {
  if (sliderParts) return sliderParts;
  const top = new THREE.Shape();
  top.moveTo(-5.5, -3.0);
  top.lineTo(5.0, -4.6);
  top.quadraticCurveTo(5.8, 0, 5.0, 4.6);
  top.lineTo(-5.5, 3.0);
  top.quadraticCurveTo(-6.2, 0, -5.5, -3.0);
  const body = plate(top, 0.7, 0.5, { curve: 8 });
  body.translate(0, 0, 0.05);
  const lugPath = arc(-1.0, 1.65, 2.6, 1.6, 0, Math.PI, 12).map(([x, z]) => new THREE.Vector3(x, 0, z));
  const lug = sweep(lugPath, new THREE.Vector3(0, 1, 0), circleSection(0.55, 1.1, 10), false);
  const tabS = roundedRect(20, 7, 2.2);
  tabS.holes.push(roundedRectPath(5, 2.2, 1));
  const tab = plate(tabS, 0.4, 0.35, { curve: 6 });
  tab.translate(-7.5, 0, 0);
  tab.rotateY(-0.08);
  tab.translate(-0.5, 0, 2.0);
  sliderParts = [
    { geo: merge([body, lug]), finish: "polished" },
    { geo: tab, finish: "brushed" },
  ];
  return sliderParts;
}

function zipper(s: number, t: number): Model {
  // #5 metal zipper in a window: the chain shows through the slot, the tape lies under the leather.
  const p = 0.95;
  const teeth: THREE.BufferGeometry[] = [];
  const tooth = zipperTooth();
  const n = Math.max(2, Math.floor(s / p));
  const zTop = -0.25;
  for (let k = 0; k < n; k++) {
    const x = -s / 2 + 0.5 + k * p;
    const side = k % 2 ? 1 : -1;
    const g = tooth.clone();
    if (side > 0) g.rotateZ(Math.PI);
    g.translate(x, side * 0.6, zTop - 1.25);
    teeth.push(g);
  }
  const tapeS = roundedRect(s + 22, 30, 3);
  const tapeG = plate(tapeS, 0.4, 0, { curve: 4 });
  tapeG.translate(0, 0, -t - 0.45);
  const x0 = -s / 2 + 7;
  const [body, tab] = zipperSlider().map((q) => q.geo.clone().translate(x0, 0, zTop));
  const stops: THREE.BufferGeometry[] = [];
  for (const sg of [-1, 1]) {
    const st = roundBox(2.4, 1.7, 1.5, 0.4);
    st.translate(s / 2 - 1, sg * 2.0, zTop - 1.3);
    stops.push(st);
  }
  const bottom = roundBox(3.2, 6.0, 1.7, 0.45);
  bottom.translate(-s / 2 - 0.4, 0, zTop - 1.4);
  return {
    front: [
      { geo: merge([...teeth, ...stops, bottom, body]), finish: "polished" },
      { geo: tab, finish: "brushed" },
      { geo: tapeG, finish: "tape" },
    ],
    back: [],
  };
}

function plaque(s: number, t: number): Model {
  const H = 0.38 * s;
  const base = plate(roundedRect(s, H, 2.4), 0.6, 0.45, { curve: 8 });
  const top = 1.5;
  // An engraved double rule round the border.
  const line = (inset: number, width: number) => {
    const o = roundedRect(s - 2 * inset, H - 2 * inset, Math.max(0.3, 2.4 - inset * 0.6));
    o.holes.push(roundedRectPath(s - 2 * (inset + width), H - 2 * (inset + width), Math.max(0.2, 2.4 - (inset + width) * 0.6)));
    const g = new THREE.ShapeGeometry(o, 6);
    g.translate(0, 0, top + 0.015);
    return g;
  };
  const engraving = merge([line(1.6, 0.32), line(2.35, 0.16)]);
  const screws: Part[] = [];
  const heads: THREE.BufferGeometry[] = [];
  const slots: THREE.BufferGeometry[] = [];
  for (const x of [-(s / 2 - 5), s / 2 - 5]) {
    const [h, sl] = screwHead(1.75, 1.0, 0.45, 0.12);
    heads.push(h.geo.clone().translate(x, 0, top - 0.05));
    slots.push(sl.geo.clone().translate(x, 0, top - 0.05));
  }
  screws.push({ geo: merge(heads), finish: "polished" }, { geo: merge(slots), finish: "dark" });
  const posts: THREE.BufferGeometry[] = [];
  for (const x of [-(s / 2 - 5), s / 2 - 5]) posts.push(lathe(fillet([[0, -0.1], [2.3, -0.1], [2.4, 0.2, 0.2], [2.3, 0.9, 0.3], [0, 1.0]], 3), { segments: 24 }).translate(x, 0, 0));
  return {
    front: [{ geo: base, finish: "brushed" }, { geo: engraving, finish: "engrave" }, ...screws],
    back: back([{ geo: merge(posts), finish: "polished" }], t),
  };
}

function concho(s: number, t: number): Model {
  const R = s / 2;
  const h = 0.18 * s;
  const prof: C[] = [
    [0, -0.1], [R * 0.95, -0.1], [R, 0.3, 0.25], [R, 0.8, 0.3],
    // Raised rim bead, then an engraved groove.
    [R * 0.94, 1.3, 0.35], [R * 0.88, 1.2, 0.2], [R * 0.855, 0.95, 0.12], [R * 0.82, 1.25, 0.2],
    // Dome, with a second engraved ring part way up.
    [R * 0.6, h * 0.62, 1.5], [R * 0.565, h * 0.62 - 0.3, 0.1], [R * 0.53, h * 0.68, 0.2],
    [R * 0.22, h * 0.97, 1.2],
    // Centre boss.
    [R * 0.17, h * 0.93, 0.25], [R * 0.15, h + 0.45, 0.4], [0, h + 0.6],
  ];
  const pts = fillet(prof, 4);
  const rimEnd = pts.findIndex(([r]) => r < R * 0.8);
  const disc = lathe(pts, {
    segments: 96,
    // A scalloped edge: twelve lobes on the rim only.
    mod: (phi, j) => (j < rimEnd ? 1 + 0.035 * Math.cos(phi * 12) : 1),
  });
  return { front: [{ geo: disc, finish: "polished" }], back: back(screwHead(3.2, 1.6, 0.8), t) };
}

function fallback(s: number): Model {
  const r = Math.max(3, s / 2);
  return { front: [{ geo: lathe(domeProfile(r, -0.1, 0.4, Math.max(1.5, s * 0.3), 2.2, 0.3), { segments: segs(s) }), finish: "polished" }], back: [] };
}

function buildModel(kind: string, s: number, t: number, role: Role): Model {
  switch (kind) {
    case "rivet-s":
    case "rivet-m":
    case "rivet-l":
      return rivet(s, t);
    case "copper-rivet":
      return copperRivet(s, t);
    case "chicago-screw":
      return chicago(s, t);
    case "snap-24":
    case "snap-20":
      return snap(s, t, role);
    case "magnet-18":
      return magnet(s, t, role);
    case "turnlock-catch":
      return turnlockCatch(s, t);
    case "turnlock-eyelet":
      return turnlockEyelet(s, t);
    case "sam-browne":
      return samBrowne(s, t);
    case "grommet-10":
      return grommet(s, t, false);
    case "eyelet-5":
      return grommet(s, t, true);
    case "bag-foot":
      return bagFoot(s, t);
    case "d-ring":
      return dRing(s);
    case "o-ring":
      return oRing(s);
    case "square-ring":
      return squareRing(s);
    case "key-ring":
      return keyRing(s);
    case "buckle":
      return buckle(s);
    case "swivel-clasp":
      return swivel(s);
    case "zipper":
      return zipper(s, t);
    case "plaque":
      return plaque(s, t);
    case "concho":
      return concho(s, t);
    default:
      return fallback(s);
  }
}

const cache = new Map<string, Part[]>();

/**
 * The parts of one piece of hardware, merged into one geometry per finish. Built once per
 * kind, size, thickness and role; callers must not dispose the geometries.
 */
export function hardwareParts(kind: string, size: number, t: number, role: Role = "single"): Part[] {
  const s = Math.round(size * 10) / 10;
  const tt = Math.round(t * 20) / 20;
  const r = PAIRED.has(kind) ? role : "single";
  const key = `${kind}|${s}|${tt}|${r}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = buildModel(kind, s, tt, r);
  // Snaps and magnets carry a part on each face of each layer (cap and socket, stud and post).
  const both = r === "single" || kind.startsWith("snap") || kind === "magnet-18";
  const parts = both ? [...m.front, ...m.back] : r === "outer" ? m.front : m.back;
  const byFinish = new Map<PartFinish, THREE.BufferGeometry[]>();
  const fin = (p: Part): PartFinish => (kind === "copper-rivet" ? "copper" : p.finish);
  for (const p of parts) {
    const f = fin(p);
    if (!byFinish.has(f)) byFinish.set(f, []);
    byFinish.get(f)!.push(p.geo);
  }
  const out = [...byFinish].map(([finish, geos]) => {
    const geo = merge(geos);
    geo.computeBoundingSphere();
    return { geo, finish };
  });
  cache.set(key, out);
  return out;
}

