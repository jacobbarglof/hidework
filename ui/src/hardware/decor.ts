// Seam inserts in the 3D window: welts, piping, bindings and zippers sewn into a seam.
//
// The curve follows the cloth, so tubes are rebuilt when it moves, but materials are made once
// per leather and a zipper's teeth stay one instanced mesh that is only re-posed. A zipper is a
// woven tape either side of an interlocking #5 metal tooth chain, with a slider and pull tab at
// its start and stops at its end.

import * as THREE from "three";
import type { SimInfo } from "../simtypes";
import { zipperSlider, zipperTooth } from "./models";
import { sweep, type P } from "./shapes";
import { tape } from "./metals";

interface ZipParts {
  teeth: THREE.InstancedMesh;
  slider: THREE.Mesh[];
  stops: THREE.InstancedMesh;
}

interface DecorState {
  tubes: THREE.Mesh[];
  zips: Map<number, ZipParts>;
  mats: Map<string, THREE.Material>;
}

const STOP = new THREE.BoxGeometry(2.4, 1.8, 1.5);

/** Flat woven tape section, 2 * half wide across the seam, just below the chain. */
function tapeSection(half: number): P[] {
  return [[-half, -1.45], [half, -1.45], [half, -1.0], [-half, -1.0]];
}

const m4 = new THREE.Matrix4();
const bx = new THREE.Vector3();
const by = new THREE.Vector3();
const bz = new THREE.Vector3();

export function updateDecor(group: THREE.Group, info: SimInfo, positions: Float32Array, normals: Float32Array, mats: { welt: THREE.Material; zip: THREE.Material; teeth: THREE.Material }, colorOf: (materialId: string | null) => THREE.Material): void {
  let st = group.userData.decor as DecorState | undefined;
  if (!st || (group.userData.decorInfo !== info)) {
    // A new simulation: start over.
    // Tubes and tapes are ours to dispose; teeth, stops and sliders share cached geometry.
    for (const t of st?.tubes ?? []) t.geometry.dispose();
    for (const z of st?.zips.values() ?? []) {
      z.teeth.dispose();
      z.stops.dispose();
    }
    group.clear();
    st = { tubes: [], zips: new Map(), mats: new Map() };
    group.userData.decor = st;
    group.userData.decorInfo = info;
  }
  const state = st;
  for (const t of state.tubes) {
    t.geometry.dispose();
    group.remove(t);
  }
  state.tubes = [];
  const matOf = (id: string | null) => {
    const key = id ?? "";
    let m = state.mats.get(key);
    if (!m) {
      m = colorOf(id);
      state.mats.set(key, m);
    }
    return m;
  };
  const P = (i: number) => new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  const N = (i: number) => new THREE.Vector3(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
  (info.decor ?? []).forEach((d, di) => {
    if (d.pairs.length < 2) return;
    const pts: THREE.Vector3[] = [];
    const outs: THREE.Vector3[] = [];
    for (const [a, b] of d.pairs) {
      const mid = P(a).add(P(b)).multiplyScalar(0.5);
      // Outward: away from both pieces' flesh sides (a corner seam points out diagonally).
      const out = N(a).add(N(b)).multiplyScalar(-1);
      const ok = out.lengthSq() > 0.09;
      if (ok) out.normalize();
      else out.copy(N(a)).negate();
      if (ok) mid.addScaledVector(out, d.construction === "zipper" ? 0 : 1.2);
      if (!pts.length || pts[pts.length - 1].distanceTo(mid) > 0.5) {
        pts.push(mid);
        outs.push(out);
      }
    }
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts);
    const segs = Math.min(400, pts.length * 3);
    const tube = (radius: number, radial: number, mat: THREE.Material, cast = true) => {
      const m = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, radius, radial, false), mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      group.add(m);
      state.tubes.push(m);
    };
    if (d.construction === "piped") tube(Math.max(1.5, d.widthMm / 2 + 0.6), 12, matOf(d.materialId));
    else if (d.construction === "bound") tube(Math.max(1.6, d.thicknessMm + 0.8), 12, matOf(d.materialId));
    else if (d.construction === "welted") tube(Math.max(0.8, d.thicknessMm * 0.7), 8, matOf(d.materialId), false);
    else if (d.construction === "zipper") {
      const len = curve.getLength();
      const count = Math.max(2, Math.floor(len / 0.95));
      // Outward direction along the curve, from the nearest seam point.
      const outAt = (u: number) => outs[Math.min(outs.length - 1, Math.round(u * (outs.length - 1)))];
      // The tape: a flat woven band either side of the chain, lying in the seam.
      const path = curve.getSpacedPoints(segs);
      const tapeGeo = sweep(path, (i) => outAt(i / segs), tapeSection(7), false);
      const tm = new THREE.Mesh(tapeGeo, tape());
      tm.receiveShadow = true;
      group.add(tm);
      state.tubes.push(tm);
      let z = state.zips.get(di);
      if (!z || z.teeth.instanceMatrix.count < count) {
        if (z) {
          group.remove(z.teeth, z.stops, ...z.slider);
          z.teeth.dispose();
          z.stops.dispose();
        }
        const teeth = new THREE.InstancedMesh(zipperTooth(), mats.teeth, count);
        teeth.castShadow = true;
        const stops = new THREE.InstancedMesh(STOP, mats.teeth, 2);
        const slider = zipperSlider().map((p) => {
          const m = new THREE.Mesh(p.geo, mats.teeth);
          m.castShadow = true;
          return m;
        });
        z = { teeth, slider, stops };
        state.zips.set(di, z);
        group.add(teeth, stops, ...slider);
      }
      z.teeth.count = count;
      const frame = (u: number, side: number) => {
        bx.copy(curve.getTangentAt(u));
        bz.copy(outAt(u)).addScaledVector(bx, -outAt(u).dot(bx)).normalize();
        by.crossVectors(bz, bx);
        if (side > 0) {
          // Teeth from the other tape face the other way.
          bx.negate();
          by.negate();
        }
        return m4.makeBasis(bx, by, bz);
      };
      for (let k = 0; k < count; k++) {
        const u = count > 1 ? k / (count - 1) : 0;
        const side = k % 2 ? 1 : -1;
        const p = curve.getPointAt(u);
        frame(u, side);
        p.addScaledVector(by, -0.6).addScaledVector(bz, -1.0);
        m4.setPosition(p);
        z.teeth.setMatrixAt(k, m4);
      }
      z.teeth.instanceMatrix.needsUpdate = true;
      z.teeth.computeBoundingSphere();
      // Slider and pull at the start, stops at the far end.
      const u0 = Math.min(0.5, 7 / Math.max(1, len));
      const p0 = curve.getPointAt(u0);
      frame(u0, -1);
      for (const m of z.slider) {
        m.position.copy(p0);
        m.quaternion.setFromRotationMatrix(m4);
      }
      for (const [k, sg] of [[0, -1], [1, 1]] as [number, number][]) {
        const u = Math.max(0, 1 - 1.5 / Math.max(1, len));
        const p = curve.getPointAt(u);
        frame(u, -1);
        p.addScaledVector(by, sg * 2).addScaledVector(bz, -0.4);
        m4.setPosition(p);
        z.stops.setMatrixAt(k, m4);
      }
      z.stops.instanceMatrix.needsUpdate = true;
      z.stops.computeBoundingSphere();
    }
  });
}

