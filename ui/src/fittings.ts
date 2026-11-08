// What sits on and along the leather in the 3D window: set hardware (rivets, snaps, locks, rings,
// buckles, zips...), seam inserts (welt, piping, binding, zipper teeth), stitch and lacing styles,
// and surface work (stamps, tooling, embossing, paint) drawn onto the grain.

import * as THREE from "three";
import type { SimInfo, SurfacePoint } from "./simtypes";
import type { ComputedPiece, Mark } from "./types";

export type Metal = "brass" | "nickel" | "gunmetal" | "copper" | "black";

export const METALS: Record<Metal, string> = {
  brass: "#c9a24a",
  nickel: "#c9ccd1",
  gunmetal: "#5d6066",
  copper: "#b87333",
  black: "#2b2b2e",
};

const metalCache = new Map<string, THREE.MeshStandardMaterial>();
export function metal(m: Metal): THREE.MeshStandardMaterial {
  let mat = metalCache.get(m);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color: METALS[m], metalness: 1, roughness: m === "black" ? 0.45 : 0.26 });
    metalCache.set(m, mat);
  }
  return mat;
}

const DARK = new THREE.MeshStandardMaterial({ color: "#1d1b1a", roughness: 0.6 });

function dome(r: number, h: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.SphereGeometry(r, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  g.rotateX(Math.PI / 2);
  g.scale(1, 1, h / r);
  return new THREE.Mesh(g, mat);
}

function disc(r: number, h: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r, r, h, 32);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, h / 2);
  return new THREE.Mesh(g, mat);
}

function ring(r: number, tube: number, mat: THREE.Material, arc = Math.PI * 2): THREE.Mesh {
  return new THREE.Mesh(new THREE.TorusGeometry(r, tube, 12, 40, arc), mat);
}

function box(x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BoxGeometry(x, y, z);
  g.translate(0, 0, z / 2);
  return new THREE.Mesh(g, mat);
}

function frame(w: number, h: number, bar: number, depth: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const top = box(w, bar, depth, mat);
  top.position.y = h / 2 - bar / 2;
  const bot = box(w, bar, depth, mat);
  bot.position.y = -h / 2 + bar / 2;
  const l = box(bar, h, depth, mat);
  l.position.x = -w / 2 + bar / 2;
  const r = box(bar, h, depth, mat);
  r.position.x = w / 2 - bar / 2;
  g.add(top, bot, l, r);
  return g;
}

/**
 * A piece of hardware in its own frame: origin on the grain surface, +z out of the leather, +x
 * along the hardware's angle. `t` is the leather thickness (backs go at z = -t).
 */
export function hardwareMesh(kind: string, size: number, t: number, m: Metal): THREE.Group {
  const mat = metal(m);
  const g = new THREE.Group();
  const back = (o: THREE.Object3D) => {
    o.rotation.x = Math.PI;
    o.position.z = -t;
    g.add(o);
  };
  switch (kind) {
    case "rivet-s":
    case "rivet-m":
    case "rivet-l":
      g.add(dome(size / 2, size * 0.32, mat));
      back(dome(size / 2, size * 0.25, mat));
      break;
    case "copper-rivet":
      g.add(dome(size / 2, size * 0.3, metal("copper")));
      back(disc(size * 0.42, 0.8, metal("copper")));
      break;
    case "chicago-screw":
      g.add(disc(size / 2, 1.6, mat));
      back(disc(size / 2, 1.6, mat));
      break;
    case "snap-24":
    case "snap-20":
      g.add(dome(size / 2, size * 0.28, mat));
      back(ring(size * 0.32, 0.9, mat));
      break;
    case "magnet-18": {
      g.add(disc(size / 2, 2.6, mat));
      const r = ring(size * 0.3, 0.7, mat);
      r.position.z = 2.6;
      g.add(r);
      back(disc(size * 0.48, 0.6, mat));
      break;
    }
    case "turnlock-catch": {
      g.add(box(size * 0.95, size * 0.5, 1.2, mat));
      const knob = box(size * 0.18, size * 0.5, 4.5, mat);
      knob.position.z = 1.2;
      g.add(knob);
      break;
    }
    case "turnlock-eyelet":
      g.add(frame(size * 1.08, size * 0.52, 3, 1.4, mat));
      back(frame(size * 1.0, size * 0.45, 2.5, 0.8, mat));
      break;
    case "sam-browne": {
      const post = disc(1.8, 3.5, mat);
      g.add(post);
      const head = dome(size / 2, size * 0.35, mat);
      head.position.z = 3.5;
      g.add(head);
      break;
    }
    case "grommet-10":
    case "eyelet-5": {
      const r = ring(size / 2 + 1.2, size > 6 ? 1.3 : 0.8, mat);
      r.scale.z = 0.6;
      r.position.z = 0.4;
      g.add(r);
      back(disc(size / 2 + 2, 0.6, mat));
      break;
    }
    case "bag-foot":
      g.add(dome(size / 2, size * 0.42, mat));
      break;
    case "d-ring": {
      // Straight side lies across the tab; the curve stands out.
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, size, 12), mat);
      bar.rotation.z = Math.PI / 2;
      bar.position.z = 1.6;
      const arc = ring(size / 2, 1.6, mat, Math.PI);
      arc.rotation.x = Math.PI / 2;
      arc.position.z = 1.6;
      g.add(bar, arc);
      break;
    }
    case "o-ring":
    case "key-ring": {
      const r = ring(size / 2, kind === "o-ring" ? 1.7 : 1.0, mat);
      r.rotation.x = Math.PI / 2;
      r.position.z = size / 2;
      g.add(r);
      break;
    }
    case "square-ring": {
      const f = frame(size + 4, size * 0.6 + 4, 2.5, 2.5, mat);
      f.rotation.x = Math.PI / 2;
      f.position.z = (size * 0.6 + 4) / 2;
      g.add(f);
      break;
    }
    case "buckle": {
      g.add(frame(size + 8, size * 0.75, 3, 2.4, mat));
      const tongue = box(2, size * 0.55, 1.8, mat);
      tongue.position.set(0, 0, 2.4);
      tongue.rotation.z = Math.PI / 2;
      g.add(tongue);
      break;
    }
    case "swivel-clasp": {
      const r = ring(size / 2, 1.6, mat);
      r.rotation.x = Math.PI / 2;
      r.position.z = size / 2;
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(3, size * 1.4, 6, 16), mat);
      body.rotation.x = Math.PI / 2;
      body.position.z = size + size * 0.7 + 3;
      g.add(r, body);
      break;
    }
    case "zipper": {
      const tape = box(size + 10, 18, 0.6, DARK);
      g.add(tape);
      const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 3.2, 1.6), mat, Math.max(1, Math.floor(size / 1.6)));
      const mtx = new THREE.Matrix4();
      for (let k = 0; k < teeth.count; k++) {
        mtx.makeTranslation(-size / 2 + k * 1.6, k % 2 ? 1.2 : -1.2, 1.2);
        teeth.setMatrixAt(k, mtx);
      }
      g.add(teeth);
      const slider = box(12, 9, 3.5, mat);
      slider.position.x = -size / 2 + 6;
      slider.position.z = 0.6;
      const pull = box(16, 4, 1, mat);
      pull.position.set(-size / 2 - 4, 0, 3.8);
      g.add(slider, pull);
      break;
    }
    case "plaque": {
      const plate = box(size, size * 0.38, 1.5, mat);
      g.add(plate);
      for (const x of [-(size / 2 - 5), size / 2 - 5]) {
        const s = dome(1.6, 0.8, mat);
        s.position.set(x, 0, 1.5);
        g.add(s);
      }
      break;
    }
    case "concho": {
      g.add(dome(size / 2, size * 0.18, mat));
      const r = ring(size * 0.36, 0.7, mat);
      r.position.z = size * 0.08;
      g.add(r);
      break;
    }
    default:
      g.add(dome(Math.max(3, size / 2), Math.max(1.5, size * 0.3), mat));
  }
  g.traverse((o) => {
    o.castShadow = true;
  });
  return g;
}

// ---------- stitches ----------

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

export function stitchMeshes(info: SimInfo, threadColor: string, laceColor: string): StitchMeshes {
  let n = 0;
  let l = 0;
  for (const line of info.stitches) {
    const gaps = line.closed ? line.holes.length : Math.max(0, line.holes.length - 1);
    if (line.lace) l += gaps * 4;
    else n += gaps * 4;
  }
  const tg = new THREE.CylinderGeometry(0.42, 0.42, 1, 6, 1);
  tg.rotateX(Math.PI / 2);
  const thread = new THREE.InstancedMesh(tg, new THREE.MeshStandardMaterial({ color: threadColor, roughness: 0.6 }), Math.max(1, n));
  const lace = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: laceColor, roughness: 0.55 }), Math.max(1, l));
  thread.castShadow = lace.castShadow = true;
  thread.count = 0;
  lace.count = 0;
  return { thread, lace };
}

const zAxis = new THREE.Vector3(0, 0, 1);
const tmpM = new THREE.Matrix4();

function put(mesh: THREE.InstancedMesh, a: THREE.Vector3, b: THREE.Vector3, width: number, depth: number, up?: THREE.Vector3): void {
  const dir = b.clone().sub(a);
  const len = Math.max(0.1, dir.length() - 0.6);
  dir.normalize();
  let q: THREE.Quaternion;
  if (up) {
    // A flat strip (lace): z along the path, y along `up`.
    const x = new THREE.Vector3().crossVectors(up, dir).normalize();
    const y = new THREE.Vector3().crossVectors(dir, x);
    q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, dir));
  } else {
    q = new THREE.Quaternion().setFromUnitVectors(zAxis, dir);
  }
  tmpM.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(width, depth, len));
  mesh.setMatrixAt(mesh.count++, tmpM);
}

/** Lay out every stitch for the current cloth positions, in the style of its stitch kind. */
export function updateStitches(s: Surface, m: StitchMeshes): void {
  m.thread.count = 0;
  m.lace.count = 0;
  for (const line of s.info.stitches) {
    const half = s.thickness(line.pieceId) / 2 + 0.35;
    const pts = line.holes.map((h) => s.at(h));
    const edge = line.edge?.length === pts.length ? line.edge.map((e) => s.at(e)) : null;
    const hidden = new Set(line.hidden ?? []);
    const nH = pts.length;
    const gaps = line.closed ? nH : nH - 1;
    const laceW = s.laceWidth(line.pieceId);
    for (let k = 0; k < gaps; k++) {
      const k1 = (k + 1) % nH;
      if (hidden.has(k) || hidden.has(k1)) continue;
      const a = pts[k];
      const b = pts[k1];
      const along = b.p.clone().sub(a.p).normalize();
      const lat = new THREE.Vector3().crossVectors(a.n, along).normalize().multiplyScalar(0.5);
      const front = (p: { p: THREE.Vector3; n: THREE.Vector3 }, o = 0) => p.p.clone().addScaledVector(p.n, -(half + o));
      const backS = (p: { p: THREE.Vector3; n: THREE.Vector3 }, o = 0) => p.p.clone().addScaledVector(p.n, half + o);
      switch (line.kind) {
        case "saddle":
          put(m.thread, front(a).add(lat), front(b).sub(lat), 1, 1);
          put(m.thread, backS(a).sub(lat), backS(b).add(lat), 1, 1);
          break;
        case "running":
          if (k % 2 === 0) put(m.thread, front(a), front(b), 1, 1);
          else put(m.thread, backS(a), backS(b), 1, 1);
          break;
        case "cross":
        case "baseball":
          put(m.thread, front(a).add(lat.clone().multiplyScalar(2)), front(b).sub(lat.clone().multiplyScalar(2)), 1, 1);
          put(m.thread, front(a).sub(lat.clone().multiplyScalar(2)), front(b).add(lat.clone().multiplyScalar(2)), 1, 1);
          put(m.thread, backS(a), backS(b), 1, 1);
          break;
        case "whip":
        case "blanket":
        case "laceWhip":
        case "laceSingleLoop":
        case "laceDoubleLoop":
        case "laceCross": {
          if (!edge) {
            put(m.thread, front(a), front(b), 1, 1);
            break;
          }
          const eMid = { p: edge[k].p.clone().add(edge[k1].p).multiplyScalar(0.5), n: edge[k].n.clone().add(edge[k1].n).normalize() };
          const lace = line.lace;
          const mesh = lace ? m.lace : m.thread;
          const w = lace ? laceW : 1;
          const d = lace ? 0.8 : 1;
          const o = lace ? 0.3 : 0;
          // Over the edge: front of this hole, around the edge, into the next hole from behind.
          put(mesh, front(a, o), front(eMid, o + 0.2), w, d, lace ? a.n : undefined);
          put(mesh, front(eMid, o + 0.2), backS(eMid, o + 0.2), w, d, lace ? along : undefined);
          put(mesh, backS(eMid, o + 0.2), backS(b, o), w, d, lace ? a.n : undefined);
          if (line.kind === "blanket") put(mesh, front(edge[k], 0.2), front(edge[k1], 0.2), w, d);
          if (line.kind === "laceSingleLoop" || line.kind === "laceDoubleLoop" || line.kind === "laceCross") {
            // The loops braid along the edge.
            put(mesh, edge[k].p.clone().addScaledVector(eMid.n, 0), edge[k1].p.clone(), w * (line.kind === "laceDoubleLoop" ? 1.25 : 1), d + 0.6, along.clone().cross(a.n).normalize());
          }
          break;
        }
        default:
          // Lockstitch and back stitch: straight lines on both faces.
          put(m.thread, front(a), front(b), 1, 1);
          put(m.thread, backS(a), backS(b), 1, 1);
      }
    }
  }
  m.thread.instanceMatrix.needsUpdate = true;
  m.lace.instanceMatrix.needsUpdate = true;
  m.thread.computeBoundingSphere();
  m.lace.computeBoundingSphere();
}

// ---------- seam inserts ----------

export function updateDecor(group: THREE.Group, info: SimInfo, positions: Float32Array, normals: Float32Array, mats: { welt: THREE.Material; zip: THREE.Material; teeth: THREE.Material }, colorOf: (materialId: string | null) => THREE.Material): void {
  for (const c of group.children) (c as THREE.Mesh).geometry?.dispose();
  group.clear();
  const P = (i: number) => new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  const N = (i: number) => new THREE.Vector3(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
  for (const d of info.decor ?? []) {
    if (d.pairs.length < 2) continue;
    const pts: THREE.Vector3[] = [];
    for (const [a, b] of d.pairs) {
      const mid = P(a).add(P(b)).multiplyScalar(0.5);
      // Outward: away from both pieces' flesh sides (a corner seam points out diagonally).
      const out = N(a).add(N(b)).multiplyScalar(-1);
      if (out.lengthSq() > 0.09) mid.addScaledVector(out.normalize(), d.construction === "zipper" ? 0 : 1.2);
      if (!pts.length || pts[pts.length - 1].distanceTo(mid) > 0.5) pts.push(mid);
    }
    if (pts.length < 2) continue;
    const curve = new THREE.CatmullRomCurve3(pts);
    const segs = Math.min(400, pts.length * 3);
    if (d.construction === "piped") {
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, Math.max(1.5, d.widthMm / 2 + 0.6), 10, false), colorOf(d.materialId));
      tube.castShadow = true;
      group.add(tube);
    } else if (d.construction === "bound") {
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, Math.max(1.6, d.thicknessMm + 0.8), 10, false), colorOf(d.materialId));
      tube.scale.set(1, 1, 1);
      tube.castShadow = true;
      group.add(tube);
    } else if (d.construction === "welted") {
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, Math.max(0.8, d.thicknessMm * 0.7), 6, false), colorOf(d.materialId));
      group.add(tube);
    } else if (d.construction === "zipper") {
      group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 2.2, 6, false), mats.zip));
      const len = curve.getLength();
      const count = Math.max(2, Math.floor(len / 1.6));
      const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(1.3, 3.4, 2.2), mats.teeth, count);
      const m = new THREE.Matrix4();
      for (let k = 0; k < count; k++) {
        const u = k / (count - 1);
        const p = curve.getPointAt(u);
        const t = curve.getTangentAt(u);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), t);
        m.compose(p, q, new THREE.Vector3(1, 1, 1));
        teeth.setMatrixAt(k, m);
      }
      teeth.castShadow = true;
      group.add(teeth);
      const slider = new THREE.Mesh(new THREE.BoxGeometry(12, 9, 5), mats.teeth);
      const p0 = curve.getPointAt(0.04);
      slider.position.copy(p0);
      slider.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), curve.getTangentAt(0.04));
      slider.castShadow = true;
      group.add(slider);
    }
  }
}

// ---------- surface work ----------

const TOOL = "rgba(45,25,12,0.62)";

function drawMark(g: CanvasRenderingContext2D, mk: Mark, k: number, bump: boolean): void {
  g.save();
  g.translate(mk.center.x * k, mk.center.y * k);
  g.rotate(((mk.angleDeg ?? 0) * Math.PI) / 180);
  const w = mk.size.x * k;
  const h = mk.size.y * k;
  const ink = bump ? "#000" : TOOL;
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineCap = "round";
  const text = (str: string, weight: string, color: string) => {
    g.fillStyle = color;
    g.font = `${weight} ${Math.max(6, h * 0.62)}px Cinzel, 'Times New Roman', serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(str, 0, h * 0.04, w * 0.96);
  };
  switch (mk.kind) {
    case "paint":
      g.fillStyle = bump ? "rgba(0,0,0,0)" : mk.pattern || "#1d1d1f";
      g.fillRect(-w / 2, -h / 2, w, h);
      break;
    case "stamp": {
      g.lineWidth = Math.max(2, k * 0.6);
      const r = Math.min(w, h) * 0.2;
      g.beginPath();
      g.roundRect(-w / 2, -h / 2, w, h, r);
      g.stroke();
      g.beginPath();
      g.roundRect(-w / 2 + k * 1.5, -h / 2 + k * 1.5, w - k * 3, h - k * 3, r * 0.7);
      g.stroke();
      text(mk.text || "HW", "700", ink);
      break;
    }
    case "text":
      text(mk.text || "", "600", ink);
      break;
    case "engrave":
      g.lineWidth = Math.max(1, k * 0.25);
      g.strokeRect(-w / 2, -h / 2, w, h);
      if (mk.text) {
        g.font = `400 ${Math.max(6, h * 0.5)}px 'EB Garamond', serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.lineWidth = Math.max(0.8, k * 0.18);
        g.strokeText(mk.text, 0, 0, w * 0.95);
      }
      break;
    case "emboss":
      if (!bump) {
        g.fillStyle = "rgba(255,240,215,0.35)";
        g.font = `700 ${Math.max(6, h * 0.62)}px Cinzel, serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(mk.text || "◆", -k * 0.4, -k * 0.4, w * 0.95);
        text(mk.text || "◆", "700", "rgba(30,16,6,0.45)");
      } else {
        text(mk.text || "◆", "700", "#fff");
      }
      break;
    case "tooling": {
      g.lineWidth = Math.max(1.5, k * 0.45);
      g.beginPath();
      g.rect(-w / 2, -h / 2, w, h);
      g.stroke();
      const p = mk.pattern || "floral";
      if (p === "basketweave") {
        const s = 6 * k;
        for (let y = -h / 2; y < h / 2; y += s) {
          for (let x = -w / 2; x < w / 2; x += s) {
            const flip = (Math.round((x + w) / s) + Math.round((y + h) / s)) % 2;
            for (let l = 1; l < 4; l++) {
              g.beginPath();
              if (flip) {
                g.moveTo(x + (l * s) / 4, y + 1);
                g.lineTo(x + (l * s) / 4, y + s - 1);
              } else {
                g.moveTo(x + 1, y + (l * s) / 4);
                g.lineTo(x + s - 1, y + (l * s) / 4);
              }
              g.stroke();
            }
          }
        }
      } else if (p === "geometric") {
        const s = 8 * k;
        for (let y = -h / 2; y < h / 2 + s; y += s) {
          for (let x = -w / 2; x < w / 2 + s; x += s) {
            g.beginPath();
            g.moveTo(x, y - s / 2);
            g.lineTo(x + s / 2, y);
            g.lineTo(x, y + s / 2);
            g.lineTo(x - s / 2, y);
            g.closePath();
            g.stroke();
          }
        }
      } else if (p === "border") {
        g.strokeRect(-w / 2 + 3 * k, -h / 2 + 3 * k, w - 6 * k, h - 6 * k);
      } else if (p === "pebble") {
        for (let i = 0; i < (w * h) / (k * k * 3); i++) {
          g.beginPath();
          g.arc((Math.sin(i * 12.9898) * 0.5) * w, (Math.sin(i * 78.233) * 0.5) * h, k * 0.5, 0, Math.PI * 2);
          g.fill();
        }
      } else {
        // Floral: scrolls with leaves, like a Sheridan panel.
        const n = Math.max(1, Math.round(w / (h * 1.2)));
        for (let i = 0; i < n; i++) {
          const cx = -w / 2 + ((i + 0.5) * w) / n;
          const r = Math.min(h, w / n) * 0.36;
          g.beginPath();
          for (let a = 0; a < Math.PI * 3.2; a += 0.05) {
            const rr = r * (1 - a / (Math.PI * 3.6));
            const x = cx + Math.cos(a + i) * rr;
            const y = Math.sin(a + i) * rr;
            if (a === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
          for (const s of [-1, 1]) {
            g.beginPath();
            g.ellipse(cx + s * r * 0.95, s * r * 0.55, r * 0.42, r * 0.16, s * 0.7, 0, Math.PI * 2);
            g.stroke();
          }
        }
      }
      break;
    }
    default:
      break;
  }
  g.restore();
}

/** A transparent picture of a piece's surface work, laid over its grain side. */
export function markTextures(cp: ComputedPiece): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture; min: { x: number; y: number }; size: { x: number; y: number } } | null {
  const marks = (cp.marks ?? []).filter((m) => m.kind !== "perforate");
  if (!marks.length) return null;
  const b = cp.bounds;
  const size = { x: b.max.x - b.min.x, y: b.max.y - b.min.y };
  const k = Math.min(8, 2048 / Math.max(size.x, size.y));
  const make = (bump: boolean) => {
    const c = document.createElement("canvas");
    c.width = Math.ceil(size.x * k);
    c.height = Math.ceil(size.y * k);
    const g = c.getContext("2d")!;
    if (bump) {
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
    }
    g.translate(-b.min.x * k, -b.min.y * k);
    for (const mk of marks) drawMark(g, mk, k, bump);
    const t = new THREE.CanvasTexture(c);
    if (!bump) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: make(false), bump: make(true), min: b.min, size };
}
