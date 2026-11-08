// Stitches and lacing in the 3D window, all instanced (three draw calls for any number of
// stitches: thread, lace and the holes they pass through).
//
// - Thread: a plump, three-ply twisted thread (the twist is a normal map, so each stitch is only
//   about 100 triangles) whose ends dive into the holes. It sits a little into the grain, as a
//   pulled stitch does.
// - Saddle stitch: every stitch is slanted the same way on the front and the other way on the
//   back, as with a diamond pricking iron; the slanted slits show at each end.
// - Machine lockstitch: thinner, straight, no slant.
// - Lacing: a flat lace of the slit's width, crowned on top, flat underneath.

import * as THREE from "three";
import type { SimInfo, SurfacePoint } from "../simtypes";
import { sweep, type P } from "./shapes";

export interface Surface {
  info: SimInfo;
  at(sp: SurfacePoint): { p: THREE.Vector3; n: THREE.Vector3 };
  thickness(pieceId: string): number;
  laceWidth(pieceId: string): number;
}

export interface StitchMeshes {
  thread: THREE.InstancedMesh;
  lace: THREE.InstancedMesh;
}

let twistTex: THREE.DataTexture | null = null;
/** One period of diagonal ridges: three plies twisting round the thread. */
function twist(): THREE.DataTexture {
  if (twistTex) return twistTex;
  const w = 32;
  const data = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const ph = ((x + y) / w) * Math.PI * 2;
      // Rounded plies with a crisp groove between them.
      const d = -Math.sin(ph) * 0.9;
      const l = Math.hypot(d, d, 1);
      const k = (y * w + x) * 4;
      data[k] = ((-d / l) * 0.5 + 0.5) * 255;
      data[k + 1] = ((-d / l) * 0.5 + 0.5) * 255;
      data[k + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[k + 3] = 255;
    }
  }
  twistTex = new THREE.DataTexture(data, w, w, THREE.RGBAFormat);
  twistTex.wrapS = twistTex.wrapT = THREE.RepeatWrapping;
  // uv from the sweep: u along the stitch (0..1), v round it (0..pi). Two twists along, 3 plies.
  twistTex.repeat.set(2, 3 / Math.PI);
  twistTex.magFilter = THREE.LinearFilter;
  twistTex.minFilter = THREE.LinearMipmapLinearFilter;
  twistTex.generateMipmaps = true;
  twistTex.needsUpdate = true;
  return twistTex;
}

/** Unit stitch: length 1 along z, 1 wide (x) and 1 deep (y, out of the leather). Ends dive in. */
function threadGeometry(): THREE.BufferGeometry {
  const n = 9;
  const path: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const z = -0.5 + i / (n - 1);
    const e = Math.abs(2 * z);
    path.push(new THREE.Vector3(0, -0.85 * Math.pow(e, 4), z));
  }
  const sec: P[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    sec.push([0.5 * Math.cos(a), 0.5 * Math.sin(a)]);
  }
  return sweep(path, new THREE.Vector3(0, 1, 0), sec, false, (i) => {
    const e = Math.abs(2 * (-0.5 + i / (n - 1)));
    return Math.max(0.25, Math.sqrt(Math.max(0, 1 - Math.pow(e, 3))));
  });
}

/** Unit lace: flat underneath, crowned on top, slightly narrower where it enters the slits. */
function laceGeometry(): THREE.BufferGeometry {
  const sec: P[] = [];
  const m = 10;
  for (let k = 0; k < m; k++) {
    const a = (k / m) * Math.PI * 2;
    const x = 0.5 * Math.cos(a);
    const s = Math.sin(a);
    const y = s >= 0 ? 0.5 * Math.pow(s, 0.6) : -0.35 * Math.pow(-s, 0.25);
    sec.push([x, y]);
  }
  const path = [-0.5, -0.3, 0, 0.3, 0.5].map((z) => new THREE.Vector3(0, 0, z));
  return sweep(path, new THREE.Vector3(0, 1, 0), sec, false, (i) => (i === 0 || i === 4 ? 0.82 : 1));
}

const HOLE_MAT = new THREE.MeshStandardMaterial({ color: "#1a0f08", roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
let holeGeo: THREE.BufferGeometry | null = null;

export function stitchMeshes(info: SimInfo, threadColor: string, laceColor: string): StitchMeshes {
  let n = 0;
  let l = 0;
  let h = 0;
  for (const line of info.stitches) {
    const gaps = line.closed ? line.holes.length : Math.max(0, line.holes.length - 1);
    if (line.lace) l += gaps * 4;
    else {
      n += gaps * 4;
      h += line.holes.length * 2;
    }
  }
  const tm = new THREE.MeshStandardMaterial({ color: threadColor, roughness: 0.62, normalMap: twist(), normalScale: new THREE.Vector2(0.9, 0.9) });
  const lm = new THREE.MeshStandardMaterial({ color: laceColor, roughness: 0.5 });
  const thread = new THREE.InstancedMesh(threadGeometry(), tm, Math.max(1, n));
  const lace = new THREE.InstancedMesh(laceGeometry(), lm, Math.max(1, l));
  holeGeo ??= new THREE.CircleGeometry(0.5, 10);
  const holes = new THREE.InstancedMesh(holeGeo, HOLE_MAT, Math.max(1, h));
  holes.name = "stitch-holes";
  // A child of the thread mesh, so it shows and hides with the stitches.
  thread.add(holes);
  thread.castShadow = lace.castShadow = true;
  thread.receiveShadow = lace.receiveShadow = true;
  thread.count = 0;
  lace.count = 0;
  holes.count = 0;
  thread.userData.holes = holes;
  return { thread, lace };
}

const tmpM = new THREE.Matrix4();
const vx = new THREE.Vector3();
const vy = new THREE.Vector3();
const vz = new THREE.Vector3();
const mid = new THREE.Vector3();
const scl = new THREE.Vector3();
const q = new THREE.Quaternion();

/** One instance from a to b: z along a→b, y toward `up` (out of the leather), scaled. */
function put(mesh: THREE.InstancedMesh, a: THREE.Vector3, b: THREE.Vector3, width: number, depth: number, up: THREE.Vector3, shrink = 0): void {
  if (mesh.count >= mesh.instanceMatrix.count) return;
  vz.subVectors(b, a);
  const len = Math.max(0.1, vz.length() - shrink);
  vz.normalize();
  vy.copy(up).addScaledVector(vz, -up.dot(vz));
  if (vy.lengthSq() < 1e-8) vy.set(0, 0, 1).addScaledVector(vz, -vz.z);
  vy.normalize();
  vx.crossVectors(vy, vz);
  tmpM.makeBasis(vx, vy, vz);
  q.setFromRotationMatrix(tmpM);
  mid.addVectors(a, b).multiplyScalar(0.5);
  scl.set(width, depth, len);
  tmpM.compose(mid, q, scl);
  mesh.setMatrixAt(mesh.count++, tmpM);
}

/** A slanted slit where the thread goes in, just above the face. */
function slit(mesh: THREE.InstancedMesh, p: THREE.Vector3, out: THREE.Vector3, axis: THREE.Vector3, len: number, wid: number): void {
  if (mesh.count >= mesh.instanceMatrix.count) return;
  vz.copy(out);
  vx.copy(axis).addScaledVector(out, -axis.dot(out)).normalize();
  vy.crossVectors(vz, vx);
  tmpM.makeBasis(vx, vy, vz);
  q.setFromRotationMatrix(tmpM);
  scl.set(len, wid, 1);
  tmpM.compose(p, q, scl);
  mesh.setMatrixAt(mesh.count++, tmpM);
}

const along = new THREE.Vector3();
const lat = new THREE.Vector3();
const outF = new THREE.Vector3();
const outB = new THREE.Vector3();
const a0 = new THREE.Vector3();
const b0 = new THREE.Vector3();
const a1 = new THREE.Vector3();
const b1 = new THREE.Vector3();
const axis = new THREE.Vector3();

type SP = { p: THREE.Vector3; n: THREE.Vector3 };
/** A point on a face: the grain (front, -n side) or the flesh (back, +n side), lifted by `o`. */
const onFace = (t: THREE.Vector3, p: SP, side: -1 | 1, half: number, o: number) => t.copy(p.p).addScaledVector(p.n, side * (half + o));

/** Lay out every stitch for the current cloth positions, in the style of its stitch kind. */
export function updateStitches(s: Surface, m: StitchMeshes): void {
  const holes = m.thread.userData.holes as THREE.InstancedMesh | undefined;
  m.thread.count = 0;
  m.lace.count = 0;
  if (holes) holes.count = 0;
  for (const line of s.info.stitches) {
    const half = s.thickness(line.pieceId) / 2;
    const pts = line.holes.map((h) => s.at(h));
    const edge = line.edge?.length === pts.length ? line.edge.map((e) => s.at(e)) : null;
    const hidden = new Set(line.hidden ?? []);
    const nH = pts.length;
    const gaps = line.closed ? nH : nH - 1;
    const laceW = s.laceWidth(line.pieceId);
    const machine = line.kind === "lockstitch" || line.kind === "machine";
    // Thread size: hand-sewn thread is plump; machine thread finer.
    const tw = machine ? 0.62 : 0.95;
    const td = machine ? 0.48 : 0.72;
    // The thread's centre sits a little above the face, so its underside presses into the grain.
    const lift = td * 0.2;
    for (let k = 0; k < gaps; k++) {
      const k1 = (k + 1) % nH;
      if (hidden.has(k) || hidden.has(k1)) continue;
      const a = pts[k];
      const b = pts[k1];
      along.subVectors(b.p, a.p);
      const L = along.length();
      along.normalize();
      lat.crossVectors(a.n, along).normalize();
      outF.copy(a.n).negate();
      outB.copy(a.n);
      switch (line.kind) {
        case "saddle": {
          // Slant: each stitch runs from one end of a slanted slit to the far end of the next.
          const w = Math.min(0.9, 0.2 * L);
          onFace(a0, a, -1, half, lift).addScaledVector(lat, w);
          onFace(b0, b, -1, half, lift).addScaledVector(lat, -w);
          put(m.thread, a0, b0, tw, td, outF, 0.25);
          onFace(a1, a, 1, half, lift).addScaledVector(lat, -w);
          onFace(b1, b, 1, half, lift).addScaledVector(lat, w);
          put(m.thread, a1, b1, tw, td, outB, 0.25);
          break;
        }
        case "running":
          if (k % 2 === 0) put(m.thread, onFace(a0, a, -1, half, lift), onFace(b0, b, -1, half, lift), tw, td, outF, 0.3);
          else put(m.thread, onFace(a1, a, 1, half, lift), onFace(b1, b, 1, half, lift), tw, td, outB, 0.3);
          break;
        case "cross":
        case "baseball": {
          const w = 2;
          put(m.thread, onFace(a0, a, -1, half, lift).addScaledVector(lat, w), onFace(b0, b, -1, half, lift).addScaledVector(lat, -w), tw, td, outF);
          put(m.thread, onFace(a0, a, -1, half, lift + 0.3).addScaledVector(lat, -w), onFace(b0, b, -1, half, lift + 0.3).addScaledVector(lat, w), tw, td, outF);
          put(m.thread, onFace(a1, a, 1, half, lift), onFace(b1, b, 1, half, lift), tw, td, outB);
          break;
        }
        case "whip":
        case "blanket":
        case "laceWhip":
        case "laceSingleLoop":
        case "laceDoubleLoop":
        case "laceCross": {
          if (!edge) {
            put(m.thread, onFace(a0, a, -1, half, lift), onFace(b0, b, -1, half, lift), tw, td, outF);
            break;
          }
          const eMid: SP = { p: edge[k].p.clone().add(edge[k1].p).multiplyScalar(0.5), n: edge[k].n.clone().add(edge[k1].n).normalize() };
          const lace = line.lace;
          const mesh = lace ? m.lace : m.thread;
          const w = lace ? laceW : tw;
          const d = lace ? 0.75 : td;
          const o = lace ? 0.3 : lift;
          // Round the edge: out of this hole on the front, over the edge, into the next from behind.
          const edgeOut = eMid.p.clone().sub(a.p).normalize();
          put(mesh, onFace(a0, a, -1, half, o), onFace(b0, eMid, -1, half, o + 0.2), w, d, outF);
          put(mesh, onFace(a1, eMid, -1, half, o + 0.2).addScaledVector(edgeOut, d * 0.5), onFace(b1, eMid, 1, half, o + 0.2).addScaledVector(edgeOut, d * 0.5), w, d, edgeOut);
          put(mesh, onFace(a0, eMid, 1, half, o + 0.2), onFace(b0, b, 1, half, o), w, d, outB);
          if (line.kind === "blanket") put(mesh, onFace(a0, edge[k], -1, 0, 0.2), onFace(b0, edge[k1], -1, 0, 0.2), w, d, edgeOut);
          if (line.kind === "laceSingleLoop" || line.kind === "laceDoubleLoop" || line.kind === "laceCross") {
            // The loops braid along the edge.
            put(mesh, a0.copy(edge[k].p).addScaledVector(edgeOut, d * 0.6), b0.copy(edge[k1].p).addScaledVector(edgeOut, d * 0.6), w * (line.kind === "laceDoubleLoop" ? 1.25 : 1), d + 0.4, edgeOut);
          }
          break;
        }
        default:
          // Lockstitch and back stitch: straight lines on both faces.
          put(m.thread, onFace(a0, a, -1, half, lift), onFace(b0, b, -1, half, lift), tw, td, outF, 0.15);
          put(m.thread, onFace(a1, a, 1, half, lift), onFace(b1, b, 1, half, lift), tw, td, outB, 0.15);
      }
    }
    // The holes: slanted slits for a saddle stitch, small round holes for a machine.
    if (holes && !line.lace && nH > 1) {
      const slitLen = machine ? 0.7 : THREE.MathUtils.clamp(laceW * 0.9, 1.0, 2.6);
      const slitW = machine ? 0.6 : 0.42;
      for (let k = 0; k < nH; k++) {
        if (hidden.has(k)) continue;
        const a = pts[k];
        const nb = pts[k < nH - 1 ? k + 1 : k - 1];
        along.subVectors(nb.p, a.p).normalize();
        if (k === nH - 1) along.negate();
        lat.crossVectors(a.n, along).normalize();
        axis.copy(lat).addScaledVector(along, line.kind === "saddle" ? 0.65 : 0);
        outF.copy(a.n).negate();
        slit(holes, onFace(a0, a, -1, half, 0.02), outF, axis, slitLen, slitW);
        axis.copy(lat).addScaledVector(along, line.kind === "saddle" ? -0.65 : 0);
        slit(holes, onFace(a0, a, 1, half, 0.02), a.n, axis, slitLen, slitW);
      }
    }
  }
  for (const mesh of [m.thread, m.lace, holes]) {
    if (!mesh) continue;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
}
