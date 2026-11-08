// Hardware metals for the 3D window. Each metal comes in a few finishes:
//
// - polished: mirror-bright caps, rings and clasps;
// - brushed: plates and turn-lock faces, with anisotropic highlights that follow the brushing
//   (round parts are spun, so the streaks run round them; flat plates are brushed along +x);
// - dark: inside a socket or a hole, where little light reaches;
// - engrave: the bottom of an engraved line.
//
// Every geometry built by ./shapes carries a `wear` attribute: above 0 on exposed edges and rims,
// below 0 in crevices. The shader brightens or strips the plating on worn edges (gunmetal and
// black wear through to bright steel) and darkens crevices with old polish and dirt. It costs one
// vertex attribute and a few shader lines, no extra textures or passes.

import * as THREE from "three";

export type Metal = "brass" | "nickel" | "gunmetal" | "copper" | "black";
export type Finish = "polished" | "brushed" | "dark" | "engrave";

interface MetalSpec {
  color: string;
  metalness: number;
  roughness: number;
  /** Where the surface wears through on edges. */
  wear: string;
  wearRough: number;
  /** How strongly edges wear (plating wears through, solid metal only brightens). */
  wearAmt: number;
  /** Crevice darkening. */
  grime: number;
  clearcoat: number;
}

const SPECS: Record<Metal, MetalSpec> = {
  brass: { color: "#d6ae5c", metalness: 1, roughness: 0.2, wear: "#efd290", wearRough: 0.12, wearAmt: 0.3, grime: 0.5, clearcoat: 0 },
  nickel: { color: "#c7c9cc", metalness: 1, roughness: 0.16, wear: "#e6e7e9", wearRough: 0.1, wearAmt: 0.25, grime: 0.45, clearcoat: 0 },
  gunmetal: { color: "#6b6e74", metalness: 1, roughness: 0.3, wear: "#a9adb3", wearRough: 0.18, wearAmt: 0.4, grime: 0.45, clearcoat: 0 },
  copper: { color: "#d58b62", metalness: 1, roughness: 0.24, wear: "#f0b090", wearRough: 0.14, wearAmt: 0.3, grime: 0.55, clearcoat: 0 },
  black: { color: "#18181a", metalness: 0.25, roughness: 0.38, wear: "#8f9296", wearRough: 0.22, wearAmt: 0.4, grime: 0.3, clearcoat: 0.35 },
};

export const METALS: Record<Metal, string> = Object.fromEntries(Object.entries(SPECS).map(([k, v]) => [k, v.color])) as Record<Metal, string>;

/** Fine brushing streaks for a roughness map: the streaks run along u (uv in mm). */
let streakTex: THREE.DataTexture | null = null;
function streaks(): THREE.DataTexture {
  if (streakTex) return streakTex;
  const w = 64;
  const h = 128;
  const data = new Uint8Array(w * h * 4);
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  // A value per row (v), slightly varying along the row so the streaks are not perfect lines.
  const rows = new Float32Array(h).map(() => rnd());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = rows[y] * 0.75 + rows[(y + 1) % h] * 0.25;
      const v = 150 + (a - 0.5) * 90 + (rnd() - 0.5) * 16;
      const k = (y * w + x) * 4;
      // Green carries roughness in three.js.
      data[k] = data[k + 1] = data[k + 2] = Math.max(0, Math.min(255, v));
      data[k + 3] = 255;
    }
  }
  streakTex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  streakTex.wrapS = streakTex.wrapT = THREE.RepeatWrapping;
  // One tile covers 12 mm along the streaks and 6 mm across them.
  streakTex.repeat.set(1 / 12, 1 / 6);
  streakTex.magFilter = THREE.LinearFilter;
  streakTex.minFilter = THREE.LinearMipmapLinearFilter;
  streakTex.generateMipmaps = true;
  streakTex.anisotropy = 8;
  streakTex.needsUpdate = true;
  return streakTex;
}

function addWear(mat: THREE.MeshPhysicalMaterial, spec: MetalSpec, key: string): void {
  const wearColor = new THREE.Color(spec.wear);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.wearColor = { value: wearColor };
    shader.uniforms.wearAmt = { value: spec.wearAmt };
    shader.uniforms.wearRough = { value: spec.wearRough };
    shader.uniforms.grime = { value: spec.grime };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float wear;\nvarying float vWear;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWear = wear;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vWear;\nuniform vec3 wearColor;\nuniform float wearAmt;\nuniform float wearRough;\nuniform float grime;")
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\nfloat wEdge = clamp(vWear, 0.0, 1.0) * wearAmt;\nfloat wPit = clamp(-vWear, 0.0, 1.0) * grime;\ndiffuseColor.rgb = mix(diffuseColor.rgb, wearColor, wEdge) * (1.0 - 0.75 * wPit);",
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, wearRough, wEdge) + 0.35 * wPit;",
      )
      .replace(
        "#include <metalnessmap_fragment>",
        "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 1.0, wEdge);",
      );
  };
  mat.customProgramCacheKey = () => `hw-wear-${key}`;
}

const cache = new Map<string, THREE.MeshPhysicalMaterial>();

/** The shared material for a metal and finish (built once, reused by every piece of hardware). */
export function metalFinish(m: Metal, finish: Finish = "polished"): THREE.MeshPhysicalMaterial {
  const key = `${m}|${finish}`;
  let mat = cache.get(key);
  if (mat) return mat;
  const spec = SPECS[m] ?? SPECS.brass;
  const color = new THREE.Color(spec.color);
  if (finish === "dark") color.multiplyScalar(0.35);
  if (finish === "engrave") color.multiplyScalar(0.45);
  mat = new THREE.MeshPhysicalMaterial({
    color,
    metalness: spec.metalness,
    roughness: finish === "polished" ? spec.roughness : finish === "brushed" ? spec.roughness + 0.38 : spec.roughness + 0.3,
    clearcoat: spec.clearcoat,
    clearcoatRoughness: 0.3,
  });
  if (finish === "brushed") {
    mat.roughnessMap = streaks();
    mat.anisotropy = 0.8;
    mat.anisotropyRotation = 0;
  }
  addWear(mat, spec, key);
  cache.set(key, mat);
  return mat;
}

/** Zipper tape and other woven parts. */
let tapeMat: THREE.MeshStandardMaterial | null = null;
export function tape(): THREE.MeshStandardMaterial {
  if (!tapeMat) {
    const w = 64;
    const data = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        // A tight twill: diagonal ribs.
        const v = 34 + 14 * Math.sin(((x + y) / w) * Math.PI * 2 * 16) + ((x * 7 + y * 13) % 5);
        const k = (y * w + x) * 4;
        data[k] = v * 1.05;
        data[k + 1] = v;
        data[k + 2] = v * 0.95;
        data[k + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(data, w, w, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / 8, 1 / 8);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    tapeMat = new THREE.MeshStandardMaterial({ color: "#ffffff", map: t, roughness: 0.92, metalness: 0 });
  }
  return tapeMat;
}
