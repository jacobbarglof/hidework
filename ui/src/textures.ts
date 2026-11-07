// Procedural, tileable PBR textures for leather and canvas (no image files needed).

import * as THREE from "three";

const SIZE = 512;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Tileable value noise in [0, 1]. */
function valueNoise(size: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const g = new Float32Array(cells * cells).map(() => r());
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => g[((j + cells) % cells) * cells + ((i + cells) % cells)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      out[y * size + x] = a + (b - a) * sy;
    }
  }
  return out;
}

/** Tileable Voronoi: returns F2 - F1 (0 on cell borders, larger in cell centres). */
function voronoiEdges(size: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) {
    pts[i * 2] = r();
    pts[i * 2 + 1] = r();
  }
  const out = new Float32Array(size * size);
  const cs = size / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cs);
      const cy = Math.floor(y / cs);
      let f1 = 1e9;
      let f2 = 1e9;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          const gy = cy + dy;
          const k = (((gy + cells) % cells) * cells + ((gx + cells) % cells)) * 2;
          const px = (gx + pts[k]) * cs;
          const py = (gy + pts[k + 1]) * cs;
          const d = Math.hypot(px - x, py - y);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
      }
      out[y * size + x] = (f2 - f1) / cs;
    }
  }
  return out;
}

function toTexture(fill: (data: Uint8ClampedArray) => void, srgb: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(SIZE, SIZE);
  fill(img.data);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

function normalFrom(height: Float32Array, strength: number): THREE.CanvasTexture {
  return toTexture((d) => {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const h = (i: number, j: number) => height[((j + SIZE) % SIZE) * SIZE + ((i + SIZE) % SIZE)];
        const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
        const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
        const l = Math.hypot(dx, dy, 1);
        const k = (y * SIZE + x) * 4;
        d[k] = ((-dx / l) * 0.5 + 0.5) * 255;
        d[k + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
        d[k + 2] = ((1 / l) * 0.5 + 0.5) * 255;
        d[k + 3] = 255;
      }
    }
  }, false);
}

export type Finish = "smooth" | "pebbled" | "nubuck" | "canvas";

export interface SurfaceSet {
  grain: THREE.MeshPhysicalMaterial;
  flesh: THREE.MeshPhysicalMaterial;
  edge: THREE.MeshStandardMaterial;
  /** World millimetres covered by one texture tile. */
  tileMm: number;
}

const cache = new Map<string, SurfaceSet>();

/** Guess a finish from the material's kind and name. */
export function finishFor(kind: string, name: string): Finish {
  const n = name.toLowerCase();
  if (kind === "waxedCanvas") return "canvas";
  if (/deer|lamb|suede|nubuck/.test(n)) return "nubuck";
  if (/chrome|goat|pebble|kid/.test(n)) return "pebbled";
  return "smooth";
}

/** A default colour from the material's kind and name, if the user has not chosen one. */
export function colorFor(kind: string, name: string): string {
  const n = name.toLowerCase();
  if (kind === "waxedCanvas") return /duck/.test(n) ? "#b6a684" : "#5d5f3c";
  if (/cordovan|horse/.test(n)) return "#4a1c14";
  if (/chrome/.test(n)) return "#4b2e1f";
  if (/pull|oil/.test(n)) return "#6a3d22";
  if (/deer/.test(n)) return "#c49a6c";
  if (/lamb/.test(n)) return "#d2b48c";
  if (/goat/.test(n)) return "#8d5a35";
  return "#c08a55";
}

function shade(hex: string, k: number): THREE.Color {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * (k < 1 ? 1.05 : 0.8)), Math.max(0, Math.min(1, hsl.l * k)));
}

export function surfaces(color: string, finish: Finish): SurfaceSet {
  const key = `${color}|${finish}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const base = new THREE.Color(color);
  const mottle = valueNoise(SIZE, 8, 11);
  let grainHeight: Float32Array;
  let normalStrength: number;
  let roughBase: number;
  if (finish === "canvas") {
    // Plain weave: alternating over/under threads.
    const threads = 48;
    grainHeight = new Float32Array(SIZE * SIZE);
    const fuzz = valueNoise(SIZE, 64, 5);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const u = (x / SIZE) * threads;
        const w = (y / SIZE) * threads;
        const over = (Math.floor(u) + Math.floor(w)) % 2 === 0;
        const across = Math.sin((u % 1) * Math.PI);
        const down = Math.sin((w % 1) * Math.PI);
        grainHeight[y * SIZE + x] = (over ? across * 0.6 + down * 0.4 : down * 0.6 + across * 0.4) + fuzz[y * SIZE + x] * 0.15;
      }
    }
    normalStrength = 3.5;
    roughBase = 0.62;
  } else {
    const cells = finish === "pebbled" ? 40 : finish === "nubuck" ? 90 : 70;
    const vor = voronoiEdges(SIZE, cells, 7);
    const fine = valueNoise(SIZE, 128, 3);
    grainHeight = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < grainHeight.length; i++) {
      const pebble = Math.min(1, vor[i] * 2.2);
      grainHeight[i] = pebble * (finish === "pebbled" ? 1 : 0.5) + fine[i] * 0.25;
    }
    normalStrength = finish === "pebbled" ? 6 : finish === "nubuck" ? 2.5 : 2.2;
    roughBase = finish === "smooth" ? 0.42 : finish === "pebbled" ? 0.55 : 0.85;
  }
  const map = toTexture((d) => {
    for (let i = 0; i < SIZE * SIZE; i++) {
      const m = 0.88 + mottle[i] * 0.2 - (1 - Math.min(1, grainHeight[i])) * 0.06;
      d[i * 4] = Math.min(255, base.r * 255 * m);
      d[i * 4 + 1] = Math.min(255, base.g * 255 * m);
      d[i * 4 + 2] = Math.min(255, base.b * 255 * m);
      d[i * 4 + 3] = 255;
    }
  }, false);
  map.colorSpace = THREE.NoColorSpace; // colour above is already linear
  const rough = toTexture((d) => {
    for (let i = 0; i < SIZE * SIZE; i++) {
      const r = Math.min(1, roughBase + (1 - Math.min(1, grainHeight[i])) * 0.15 + mottle[i] * 0.08);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = r * 255;
      d[i * 4 + 3] = 255;
    }
  }, false);
  const normal = normalFrom(grainHeight, normalStrength);
  const grain = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map,
    roughnessMap: rough,
    roughness: 1,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.9, 0.9),
    clearcoat: finish === "smooth" ? 0.25 : finish === "canvas" ? 0.15 : 0.05,
    clearcoatRoughness: 0.45,
    sheen: finish === "nubuck" ? 0.6 : 0,
    sheenRoughness: 0.8,
    sheenColor: shade(color, 1.3),
    side: THREE.BackSide,
  });
  // Flesh side: fibrous suede, lighter and fully matte.
  const fibre = valueNoise(SIZE, 160, 9);
  const fibreN = normalFrom(fibre, 1.8);
  const fleshColor = finish === "canvas" ? shade(color, 0.9) : shade(color, 1.25);
  const flesh = new THREE.MeshPhysicalMaterial({
    color: fleshColor,
    roughness: 0.95,
    normalMap: finish === "canvas" ? normal : fibreN,
    normalScale: new THREE.Vector2(0.6, 0.6),
    sheen: finish === "canvas" ? 0 : 1,
    sheenRoughness: 0.9,
    sheenColor: shade(color, 1.45),
    side: THREE.FrontSide,
  });
  const edge = new THREE.MeshStandardMaterial({ color: shade(color, 0.55), roughness: 0.35, metalness: 0, side: THREE.DoubleSide });
  const set: SurfaceSet = { grain, flesh, edge, tileMm: finish === "canvas" ? 25 : 40 };
  cache.set(key, set);
  return set;
}
