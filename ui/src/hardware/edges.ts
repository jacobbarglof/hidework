// Cut edges of the leather in the 3D window, shaped and finished by their edge finish:
//
// - raw: square, matte and fibrous, a little lighter than the grain, with a ragged fibre texture;
// - burnished: rounded over and glossy, darker where the fibres were compressed;
// - painted: a slight bead of glossy edge paint in a deep tone of the leather;
// - turned: the leather folded back on itself, so the grain wraps round in a full half-round;
// - bound: a binding wrapped over the edge, standing a little proud of both faces.
//
// Each edge is a strip of K points across the thickness. The shape is an offset `f(s)` along the
// in-plane outward direction, for s from one face (-1) to the other (+1); normals are worked out
// from the same profile, so a frame costs no computeVertexNormals.

import * as THREE from "three";
import type { SimInfo } from "../simtypes";
import type { SurfaceSet } from "../textures";

interface Profile {
  /** Points across the thickness. */
  k: number;
  /** Outward offset in mm for s in [-1, 1], given half the thickness. */
  f(s: number, half: number): number;
  /** Its derivative with respect to s. */
  df(s: number, half: number): number;
  /** How far past each face the strip reaches (mm), for bindings. */
  proud: number;
  /** Ragged fibres: random outward jitter in mm. */
  jitter: number;
}

const round = (amt: number, k: number, proud = 0): Profile => ({
  k,
  f: (s, half) => amt * (half + proud) * Math.sqrt(Math.max(0, 1 - s * s)),
  df: (s, half) => {
    const q = Math.max(1e-3, 1 - s * s);
    return (-amt * (half + proud) * s) / Math.sqrt(q);
  },
  proud,
  jitter: 0,
});

const PROFILES: Record<string, Profile> = {
  raw: { k: 3, f: () => 0, df: () => 0, proud: 0, jitter: 0.06 },
  burnished: round(0.5, 7),
  painted: {
    k: 5,
    f: (s, half) => 0.22 * half * Math.sqrt(Math.max(0, 1 - s ** 4)),
    df: (s, half) => (-0.22 * half * 2 * s ** 3) / Math.sqrt(Math.max(1e-3, 1 - s ** 4)),
    proud: 0,
    jitter: 0,
  },
  turned: round(1, 9),
  bound: round(0.9, 7, 0.45),
};

function profileOf(finish: string): Profile {
  return PROFILES[finish] ?? PROFILES.raw;
}

// ---------- materials ----------

let fibreTex: THREE.DataTexture | null = null;
/** Fibre bump for raw edges: short, mostly across-the-thickness fibres. */
function fibres(): THREE.DataTexture {
  if (fibreTex) return fibreTex;
  const w = 64, h = 64;
  const hgt = new Float32Array(w * h);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i++) {
    const x0 = rnd() * w, y0 = rnd() * h;
    const len = 3 + rnd() * 8;
    const ang = Math.PI / 2 + (rnd() - 0.5) * 1.2;
    for (let t = 0; t < len; t++) {
      const x = Math.floor(x0 + Math.cos(ang) * t + w) % w;
      const y = Math.floor(y0 + Math.sin(ang) * t + h) % h;
      hgt[y * w + x] += 0.5 + rnd() * 0.5;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const H = (i: number, j: number) => hgt[((j + h) % h) * w + ((i + w) % w)];
      const dx = (H(x + 1, y) - H(x - 1, y)) * 0.6;
      const dy = (H(x, y + 1) - H(x, y - 1)) * 0.6;
      const l = Math.hypot(dx, dy, 1);
      const k = (y * w + x) * 4;
      data[k] = ((-dx / l) * 0.5 + 0.5) * 255;
      data[k + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      data[k + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[k + 3] = 255;
    }
  }
  fibreTex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  fibreTex.wrapS = fibreTex.wrapT = THREE.RepeatWrapping;
  fibreTex.generateMipmaps = true;
  fibreTex.minFilter = THREE.LinearMipmapLinearFilter;
  fibreTex.magFilter = THREE.LinearFilter;
  fibreTex.needsUpdate = true;
  return fibreTex;
}

function tone(color: string, l: number, s = 1): THREE.Color {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * s), Math.max(0, Math.min(1, hsl.l * l)));
}

const matCache = new Map<string, THREE.Material>();

/** Material for a cut edge by its finish. Rim uv: u along the edge, v across it, both in mm. */
export function edgeMaterial(finish: string, color: string, surf: SurfaceSet): THREE.Material {
  const key = `${finish}|${color}|${surf.grain.uuid}`;
  const hit = matCache.get(key);
  if (hit) return hit;
  let m: THREE.Material;
  switch (finish) {
    case "burnished":
      m = new THREE.MeshPhysicalMaterial({ color: tone(color, 0.5, 1.1), roughness: 0.3, clearcoat: 0.75, clearcoatRoughness: 0.28, sheen: 0.2, sheenColor: tone(color, 0.8) });
      break;
    case "painted":
      m = new THREE.MeshPhysicalMaterial({ color: tone(color, 0.3, 1.15), roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.18 });
      break;
    case "turned": {
      // The grain folded round: the grain's own textures, seen from outside.
      const g = surf.grain.clone();
      g.side = THREE.FrontSide;
      m = g;
      break;
    }
    case "bound":
      m = new THREE.MeshStandardMaterial({ color: tone(color, 0.62), roughness: 0.55 });
      break;
    default: {
      const tex = fibres();
      const t = tex.clone();
      t.repeat.set(1 / 1.6, 1 / 1.6);
      t.needsUpdate = true;
      m = new THREE.MeshStandardMaterial({ color: tone(color, 1.08, 0.75), roughness: 0.95, normalMap: t, normalScale: new THREE.Vector2(0.9, 0.9) });
    }
  }
  matCache.set(key, m);
  return m;
}

// ---------- geometry ----------

interface RimData {
  profile: Profile;
  edges: [number, number][];
  /** Boundary vertices of this rim, and each edge's two entries in that list. */
  verts: number[];
  ea: Int32Array;
  eb: Int32Array;
  /** +1 or -1 per edge: which way e × n points out of the piece (found on the first frame). */
  sign: Int8Array | null;
  /** Interior vertex beside each edge, to find the sign. */
  opp: Int32Array;
  out: Float32Array;
  jit: Float32Array;
  lengthAlong: Float32Array;
  /** uv units per mm (the turned grain uses the grain's texture tile). */
  uvScale: number;
}

/** A mesh for one piece's edges with one finish. Call writeRim each frame to place it. */
export function makeRim(info: SimInfo, edges: [number, number][], finish: string, material: THREE.Material, indexRange: [number, number], tileMm = 40): THREE.Mesh {
  const profile = profileOf(finish);
  const K = profile.k;
  const local = new Map<number, number>();
  const verts: number[] = [];
  const id = (v: number) => {
    let i = local.get(v);
    if (i === undefined) {
      i = verts.length;
      local.set(v, i);
      verts.push(v);
    }
    return i;
  };
  const ea = new Int32Array(edges.length);
  const eb = new Int32Array(edges.length);
  edges.forEach(([a, b], k) => {
    ea[k] = id(a);
    eb[k] = id(b);
  });
  // The interior vertex of the triangle on each boundary edge.
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const want = new Map<string, number>();
  edges.forEach(([a, b], k) => want.set(key(a, b), k));
  const opp = new Int32Array(edges.length).fill(-1);
  const ix = info.indices;
  for (let t = indexRange[0]; t < indexRange[1]; t += 3) {
    const tri = [ix[t], ix[t + 1], ix[t + 2]];
    for (let e = 0; e < 3; e++) {
      const k = want.get(key(tri[e], tri[(e + 1) % 3]));
      if (k !== undefined) opp[k] = tri[(e + 2) % 3];
    }
  }
  const jit = new Float32Array(verts.length * K);
  for (let i = 0; i < jit.length; i++) jit[i] = (Math.sin(i * 12.9898 + 4.1) * 43758.5453) % 1;
  const n = edges.length * 2 * K;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const idx: number[] = [];
  for (let e = 0; e < edges.length; e++) {
    const base = e * 2 * K;
    for (let j = 0; j < K - 1; j++) {
      const a0 = base + j, a1 = base + j + 1, b0 = base + K + j, b1 = base + K + j + 1;
      idx.push(a0, b0, b1, a0, b1, a1);
    }
  }
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, material);
  const data: RimData = { profile, edges, verts, ea, eb, sign: null, opp, out: new Float32Array(verts.length * 3), jit, lengthAlong: new Float32Array(edges.length), uvScale: finish === "turned" ? 1 / tileMm : 1 };
  mesh.userData.rim = data;
  return mesh;
}

const A = new THREE.Vector3(), B = new THREE.Vector3(), E = new THREE.Vector3(), N = new THREE.Vector3(), O = new THREE.Vector3(), C = new THREE.Vector3();

/** Place a rim on the cloth's current positions and normals (n points to the flesh side). */
export function writeRim(mesh: THREE.Mesh, positions: Float32Array, normals: Float32Array, half: number): void {
  const d = mesh.userData.rim as RimData | undefined;
  if (!d) return;
  const { profile, edges, verts, ea, eb, out, jit } = d;
  const K = profile.k;
  const P = (v: number, t: THREE.Vector3) => t.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
  const Nn = (v: number, t: THREE.Vector3) => t.set(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
  // Which way is out, per edge: away from the triangle the edge belongs to (fixed by topology).
  if (!d.sign) {
    d.sign = new Int8Array(edges.length);
    edges.forEach(([a, b], k) => {
      P(a, A);
      P(b, B);
      E.subVectors(B, A);
      Nn(a, N);
      O.crossVectors(E, N);
      const o = d.opp[k];
      if (o < 0) {
        d.sign![k] = 1;
        return;
      }
      P(o, C).sub(A.add(B).multiplyScalar(0.5));
      d.sign![k] = O.dot(C) > 0 ? -1 : 1;
    });
    // Strips are wound for e x n pointing out; turn round the ones that point in.
    const index = mesh.geometry.index!;
    const ia = index.array as Uint16Array | Uint32Array;
    const per = (K - 1) * 6;
    for (let k = 0; k < edges.length; k++) {
      if (d.sign[k] > 0) continue;
      for (let t = k * per; t < (k + 1) * per; t += 3) {
        const tmp = ia[t + 1];
        ia[t + 1] = ia[t + 2];
        ia[t + 2] = tmp;
      }
    }
    index.needsUpdate = true;
  }
  // Outward direction per boundary vertex: the average of its edges', in its tangent plane.
  out.fill(0);
  for (let k = 0; k < edges.length; k++) {
    const [a, b] = edges[k];
    P(a, A);
    P(b, B);
    E.subVectors(B, A);
    d.lengthAlong[k] = E.length();
    Nn(a, N).add(Nn(b, C)).normalize();
    O.crossVectors(E, N).normalize().multiplyScalar(d.sign[k]);
    for (const i of [ea[k], eb[k]]) {
      out[i * 3] += O.x;
      out[i * 3 + 1] += O.y;
      out[i * 3 + 2] += O.z;
    }
  }
  for (let i = 0; i < verts.length; i++) {
    Nn(verts[i], N);
    O.set(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
    O.addScaledVector(N, -O.dot(N));
    if (O.lengthSq() < 1e-10) O.set(1, 0, 0);
    O.normalize();
    out[i * 3] = O.x;
    out[i * 3 + 1] = O.y;
    out[i * 3 + 2] = O.z;
  }
  const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const nor = mesh.geometry.getAttribute("normal") as THREE.BufferAttribute;
  const uv = mesh.geometry.getAttribute("uv") as THREE.BufferAttribute;
  const pa = pos.array as Float32Array, na = nor.array as Float32Array, ua = uv.array as Float32Array;
  const reach = half + profile.proud;
  let along = 0;
  for (let k = 0; k < edges.length; k++) {
    for (let side = 0; side < 2; side++) {
      const vi = side ? eb[k] : ea[k];
      const v = verts[vi];
      P(v, A);
      Nn(v, N);
      O.set(out[vi * 3], out[vi * 3 + 1], out[vi * 3 + 2]);
      for (let j = 0; j < K; j++) {
        // s runs from the grain face (-n side, s = -1) to the flesh face (s = +1).
        const s = -1 + (2 * j) / (K - 1);
        const f = profile.f(s, half) + (profile.jitter ? (jit[vi * K + j] - 0.5) * 2 * profile.jitter : 0);
        const df = profile.df(s, half);
        const q = (k * 2 * K + side * K + j) * 3;
        pa[q] = A.x + N.x * s * reach + O.x * f;
        pa[q + 1] = A.y + N.y * s * reach + O.y * f;
        pa[q + 2] = A.z + N.z * s * reach + O.z * f;
        // Across the strip the surface runs along n * reach + o * df; its normal in the (n, o)
        // plane is o * reach - n * df.
        let nx = O.x * reach - N.x * df, ny = O.y * reach - N.y * df, nz = O.z * reach - N.z * df;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        na[q] = nx;
        na[q + 1] = ny;
        na[q + 2] = nz;
        const u = (k * 2 * K + side * K + j) * 2;
        ua[u] = (along + (side ? d.lengthAlong[k] : 0)) * d.uvScale;
        ua[u + 1] = (s * reach + f * 0.5) * d.uvScale;
      }
    }
    along += d.lengthAlong[k];
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  uv.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
}
