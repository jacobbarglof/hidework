// Hardware in the live 3D window, instanced: every placement of the same kind, size, leather
// thickness and role shares one geometry per finish, drawn as one InstancedMesh. A tote with
// thirty rivets, screws and feet costs a handful of draw calls instead of one per part.
//
// Two-layer fasteners are matched up on the first frame: the layer whose grain faces away from
// its partner shows the front (cap), the other shows the back (post, burr, washer) on its flesh
// side, so nothing is drawn sandwiched between the layers.

import * as THREE from "three";
import type { SimInfo } from "../simtypes";
import { partMaterial } from "../fittings";
import type { Metal } from "./metals";
import { hardwareParts, PAIRED, type Role } from "./models";

type Hw = SimInfo["hardware"][number];
type At = (tri: number, bary: [number, number, number]) => { p: THREE.Vector3; n: THREE.Vector3 };

interface Item {
  hw: Hw;
  /** Model kind and size: set hardware, or a stand-in for a labelled fastener hole. */
  kind: string;
  size: number;
  t: number;
  role: Role;
  /** Plain punched hole drawn as a dark disc on the grain. */
  hole: boolean;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  items: number[];
}

const HOLE_MAT = new THREE.MeshStandardMaterial({ color: "#140c07", roughness: 0.95 });

/** A unit disc (radius 1) or a slot outline for a punched hole. */
const holeGeoCache = new Map<string, THREE.BufferGeometry>();
function holeGeometry(d: number, slot: number): THREE.BufferGeometry {
  const key = slot > d ? `${d.toFixed(2)}|${slot.toFixed(2)}` : "disc";
  let g = holeGeoCache.get(key);
  if (!g) {
    g = slot > d ? new THREE.CapsuleGeometry(d / 2, slot - d, 4, 12) : new THREE.CircleGeometry(1, 24);
    if (slot > d) {
      // Capsule is a solid along y; flatten it into a slot outline in the xy plane.
      g.scale(1, 1, 0.001);
    }
    holeGeoCache.set(key, g);
  }
  return g;
}

export class HardwareLayer {
  readonly group = new THREE.Group();
  private items: Item[] = [];
  private batches: Batch[] = [];
  private ready = false;
  private readonly basis = new THREE.Matrix4();
  private readonly out = new THREE.Vector3();
  private readonly xdir = new THREE.Vector3();
  private readonly ydir = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private where: { kind: string; p: THREE.Vector3 }[] = [];

  constructor(info: SimInfo, private readonly metal: Metal) {
    for (const hw of info.hardware) {
      const piece = info.pieces.find((p) => p.id === hw.pieceId);
      const t = piece?.thicknessMm ?? 1.5;
      if (hw.kind) {
        this.items.push({ hw, kind: hw.kind, size: hw.diameterMm, t, role: "single", hole: false });
      } else if (/rivet|snap|screw|stud|fasten/i.test(hw.label)) {
        // A hole the user labelled as a fastener: draw a matching fastener in it.
        const kind = /snap/i.test(hw.label) ? "snap-20" : /screw/i.test(hw.label) ? "chicago-screw" : "rivet-m";
        this.items.push({ hw, kind, size: THREE.MathUtils.clamp(hw.diameterMm * 2.2, 6, 15), t, role: "single", hole: false });
      } else {
        this.items.push({ hw, kind: "", size: hw.diameterMm, t, role: "single", hole: true });
      }
    }
    // Lets the dev gallery find hardware to aim the camera at.
    Object.defineProperty(this.group.userData, "locations", { get: () => this.where, enumerable: false });
  }

  /** Match two-layer fasteners up and make the instanced meshes (needs the first positions). */
  private build(at: At): void {
    const P = this.items.map((it) => at(it.hw.at.tri, it.hw.at.bary));
    this.items.forEach((it, i) => {
      if (it.hole || !PAIRED.has(it.kind)) return;
      let best = -1;
      let bd = Infinity;
      this.items.forEach((o, j) => {
        if (j === i || o.kind !== it.kind || o.hw.pieceId === it.hw.pieceId) return;
        const d = P[i].p.distanceTo(P[j].p);
        if (d < bd) [best, bd] = [j, d];
      });
      if (best < 0 || bd > it.t + this.items[best].t + 4) return;
      // Grain normal is -n; the partner lies along it for the inner layer.
      const toward = P[best].p.clone().sub(P[i].p).dot(P[i].n.clone().negate());
      it.role = toward > 0 ? "inner" : "outer";
    });
    const groups = new Map<string, number[]>();
    this.items.forEach((it, i) => {
      const key = it.hole ? `hole|${it.hw.diameterMm.toFixed(2)}|${(it.hw.slotMm ?? 0).toFixed(2)}` : `${it.kind}|${it.size.toFixed(1)}|${it.t.toFixed(2)}|${it.role}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(i);
    });
    for (const [key, ids] of groups) {
      const first = this.items[ids[0]];
      if (first.hole) {
        const mesh = new THREE.InstancedMesh(holeGeometry(first.hw.diameterMm, first.hw.slotMm ?? 0), HOLE_MAT, ids.length);
        mesh.name = key;
        this.batches.push({ mesh, items: ids });
        this.group.add(mesh);
        continue;
      }
      for (const part of hardwareParts(first.kind, first.size, first.t, first.role)) {
        const mesh = new THREE.InstancedMesh(part.geo, partMaterial(part.finish, this.metal), ids.length);
        mesh.name = key;
        mesh.castShadow = part.finish !== "dark" && part.finish !== "engrave";
        mesh.receiveShadow = true;
        this.batches.push({ mesh, items: ids });
        this.group.add(mesh);
      }
    }
    this.ready = true;
  }

  /** Follow the cloth: place every instance on its surface point. */
  update(at: At): void {
    if (!this.items.length) return;
    if (!this.ready) this.build(at);
    const frames: THREE.Matrix4[] = this.items.map((it) => {
      const { p, n } = at(it.hw.at.tri, it.hw.at.bary);
      const half = it.t / 2;
      const m = new THREE.Matrix4();
      if (it.hole) {
        // Dark disc just above the grain face (grain is on the -n side).
        const r = (it.hw.slotMm ?? 0) > it.hw.diameterMm ? 1 : it.hw.diameterMm / 2;
        this.out.copy(n).negate();
        this.pos.copy(p).addScaledVector(n, -(half + 0.05));
        this.xdir.set(1, 0, 0);
        const ang = ((it.hw.angleDeg ?? 0) * Math.PI) / 180;
        // Slots run along their angle; the piece's x is not known here, so use the world x.
        this.xdir.applyAxisAngle(this.out, ang);
        this.xdir.addScaledVector(this.out, -this.xdir.dot(this.out));
        if (this.xdir.lengthSq() < 1e-8) this.xdir.set(0, 1, 0).addScaledVector(this.out, -this.out.y);
        this.xdir.normalize();
        this.ydir.crossVectors(this.out, this.xdir);
        // Capsules are built along y; turn them so the slot runs along x.
        this.basis.makeBasis(this.ydir.clone().negate(), this.xdir, this.out);
        this.quat.setFromRotationMatrix(this.basis);
        this.scl.set(r, r, 1);
        return m.compose(this.pos, this.quat, this.scl);
      }
      // Local +z out of the grain side, +x along the hardware's angle.
      this.out.copy(n).negate();
      if (it.hw.toward) this.xdir.copy(at(it.hw.toward.tri, it.hw.toward.bary).p).sub(p);
      else this.xdir.set(1, 0, 0);
      this.xdir.addScaledVector(this.out, -this.xdir.dot(this.out));
      if (this.xdir.lengthSq() < 1e-8) this.xdir.set(0, 0, 1).cross(this.out);
      this.xdir.normalize();
      this.ydir.crossVectors(this.out, this.xdir);
      this.pos.copy(p).addScaledVector(this.out, half);
      return m.makeBasis(this.xdir, this.ydir, this.out).setPosition(this.pos);
    });
    for (const b of this.batches) {
      b.items.forEach((i, k) => b.mesh.setMatrixAt(k, frames[i]));
      b.mesh.instanceMatrix.needsUpdate = true;
      b.mesh.computeBoundingSphere();
    }
    this.where = this.items.map((it, i) => ({ kind: it.kind, p: new THREE.Vector3().setFromMatrixPosition(frames[i]) }));
  }

  /** Instanced meshes do not own their geometry or materials (both are shared caches). */
  dispose(): void {
    for (const b of this.batches) b.mesh.dispose();
    this.group.clear();
  }
}
