// The 3D drape bench: runs the Rust simulator and shows each material side by side.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { api } from "./api";

import { computedPiece, notify, piece, setStatus, state } from "./store";
import { OZ_MM } from "./units";
import type { DrapeResult, Physics, Preset, Scene, Side } from "./types";

export interface VariantChoice {
  /** "m:<materialId>" or "p:<presetId>". */
  source: string;
  oz: number;
}

export const drape = {
  pieceId: null as string | null,
  scene: { type: "cantilever", side: "right", overhangMm: 100 } as Scene,
  variants: [] as VariantChoice[],
  seconds: 4,
  result: null as DrapeResult | null,
  labels: [] as string[],
  running: false,
  frame: 0,
  playing: false,
  presets: [] as Preset[],
};

const COLORS = ["#8a5a32", "#5e3a20", "#b98a5a", "#6f7445"];
let drapeVisible = false;

export function setDrapeVisible(on: boolean): void {
  drapeVisible = on;
}

let renderer: THREE.WebGLRenderer | null = null;
let scene3: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let host: HTMLElement;
let labelLayer: HTMLElement;
let meshes: { geo: THREE.BufferGeometry; offset: THREE.Vector3; label: HTMLElement }[] = [];
let world: THREE.Group;
let animStart = 0;
let sunLight: THREE.DirectionalLight;

export async function loadPresets(): Promise<void> {
  if (!drape.presets.length) drape.presets = await api.presets();
}

export function initDrapeView(el: HTMLElement): void {
  host = el;
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  el.appendChild(renderer.domElement);
  labelLayer = document.createElement("div");
  labelLayer.className = "drape-labels";
  el.appendChild(labelLayer);
  scene3 = new THREE.Scene();
  scene3.background = new THREE.Color("#2a180c");

  camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
  camera.position.set(300, 380, 520);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const hemi = new THREE.HemisphereLight("#fff1d6", "#5a3a22", 1.8);
  scene3.add(hemi);
  const sun = new THREE.DirectionalLight("#ffe2b0", 3.2);
  sun.position.set(400, 900, 300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 900;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 10, far: 3000 });
  scene3.add(sun);
  scene3.add(sun.target);
  sunLight = sun;
  const candle = new THREE.PointLight("#ffb060", 1.2, 0, 0);
  candle.position.set(-500, 300, 400);
  scene3.add(candle);
  world = new THREE.Group();
  scene3.add(world);
  new ResizeObserver(() => resize()).observe(el);
  resize();
  const loop = () => {
    requestAnimationFrame(loop);
    if (!drapeVisible || !renderer) return;
    controls.update();
    stepAnimation();
    renderer.render(scene3, camera);
    placeLabels();
  };
  loop();
}

function resize(): void {
  if (!renderer) return;
  const r = host.getBoundingClientRect();
  renderer.setSize(Math.max(1, r.width), Math.max(1, r.height));
  camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}

export function physicsFor(source: string): { name: string; physics: Physics; kind: string } | null {
  if (source.startsWith("m:")) {
    const m = state.project.materials.find((x) => x.id === source.slice(2));
    if (!m) return null;
    const preset = drape.presets.find((p) => p.kind === m.kind);
    const fallback: Physics = preset?.physics ?? { densityKgM3: 900, bendingModulusMpa: 20, tensileModulusMpa: 80, anisotropy: 0.85, biasStiffness: 0.9, friction: 0.6 };
    return { name: m.name, physics: m.physics ?? fallback, kind: m.kind };
  }
  const p = drape.presets.find((x) => x.id === source.slice(2));
  return p ? { name: p.name, physics: p.physics, kind: p.kind } : null;
}

/** Sensible defaults the first time the bench opens for a piece. */
export function defaultsFor(pieceId: string): void {
  drape.pieceId = pieceId;
  const cp = computedPiece(pieceId);
  const pc = piece(pieceId);
  if (cp) {
    const w = cp.bounds.max.x - cp.bounds.min.x;
    const h = cp.bounds.max.y - cp.bounds.min.y;
    const side: Side = w >= h ? "right" : "bottom";
    drape.scene = { type: "cantilever", side, overhangMm: Math.round(Math.max(w, h) * 0.6) };
  }
  if (!drape.variants.length && pc) {
    const m = state.project.materials.find((x) => x.id === pc.materialId);
    const oz = m ? Math.round((m.thicknessMm / OZ_MM) * 2) / 2 : 3;
    drape.variants = [
      { source: `m:${pc.materialId}`, oz },
      { source: "p:deer", oz },
    ];
  }
}

export async function runDrape(): Promise<DrapeResult> {
  await loadPresets();
  const id = drape.pieceId;
  const cp = id ? computedPiece(id) : undefined;
  const pc = id ? piece(id) : undefined;
  if (!cp || !pc) throw new Error("Choose a piece to test.");
  const variants = drape.variants.map((v) => {
    const src = physicsFor(v.source);
    if (!src) throw new Error("A material in the comparison no longer exists.");
    return { label: `${src.name}, ${v.oz} oz`, thicknessMm: v.oz * OZ_MM, physics: src.physics };
  });
  if (!variants.length) throw new Error("Add at least one material to compare.");
  drape.running = true;
  notify();
  setStatus("Simulating the drape…");
  try {
    const t0 = performance.now();
    const result = await api.drape({ outline: cp.outline, grainDeg: pc.grainDeg, scene: drape.scene, variants: variants, seconds: drape.seconds });
    drape.result = result;
    drape.labels = variants.map((v) => v.label);
    showResult(result, variants.map((v) => drape.variants[variants.indexOf(v)]?.source ?? ""));
    setStatus(`Simulated ${variants.length} material${variants.length === 1 ? "" : "s"} in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
    return result;
  } finally {
    drape.running = false;
    notify();
  }
}

function supportMeshes(result: DrapeResult, spanX: number, count: number): THREE.Object3D[] {
  const wood = new THREE.MeshStandardMaterial({ color: "#5a3a22", roughness: 0.85 });
  const brass = new THREE.MeshStandardMaterial({ color: "#b08a3e", metalness: 0.7, roughness: 0.35 });
  const rest = result.rest;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of rest) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const out: THREE.Object3D[] = [];
  const sup = result.support;
  const totalW = spanX * count;
  if (sup.type === "table") {
    // Table top at z = 0, the region "behind" the edge.
    const pad = 60;
    let x0 = minX - pad, x1 = maxX + pad, y0 = minY - pad, y1 = maxY + pad;
    if (sup.side === "right") x1 = sup.edgeMm;
    if (sup.side === "left") x0 = -sup.edgeMm;
    if (sup.side === "bottom") y1 = sup.edgeMm;
    if (sup.side === "top") y0 = -sup.edgeMm;
    const horizontal = sup.side === "left" || sup.side === "right";
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(horizontal ? x1 - x0 : x1 - x0 + totalW, 30, horizontal ? y1 - y0 + 0 : y1 - y0),
      wood,
    );
    box.position.set((x0 + x1) / 2 + (horizontal ? 0 : (totalW - spanX) / 2), -15.5, (y0 + y1) / 2);
    box.receiveShadow = true;
    if (horizontal) {
      // One long bench running along z under every variant would hide them; instead one per variant.
      for (let k = 0; k < count; k++) {
        const b = box.clone();
        b.position.x += k * spanX;
        out.push(b);
      }
    } else out.push(box);
  } else if (sup.type === "disc") {
    for (let k = 0; k < count; k++) {
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(sup.radiusMm, sup.radiusMm, 160, 64), brass);
      cyl.position.set(sup.center.x + k * spanX, -80.5, sup.center.y);
      cyl.receiveShadow = true;
      cyl.castShadow = true;
      out.push(cyl);
    }
  } else {
    const horizontal = sup.side === "top" || sup.side === "bottom";
    const y = sup.side === "top" ? minY : sup.side === "bottom" ? maxY : 0;
    const x = sup.side === "left" ? minX : sup.side === "right" ? maxX : 0;
    for (let k = 0; k < count; k++) {
      const bar = new THREE.Mesh(
        horizontal ? new THREE.BoxGeometry(maxX - minX + 40, 8, 8) : new THREE.BoxGeometry(8, 8, maxY - minY + 40),
        brass,
      );
      bar.position.set(horizontal ? (minX + maxX) / 2 + k * spanX : x + k * spanX, 4, horizontal ? y : (minY + maxY) / 2);
      out.push(bar);
    }
  }
  return out;
}

export function showResult(result: DrapeResult, sources: string[]): void {
  for (const m of meshes) m.geo.dispose();
  meshes = [];
  labelLayer.replaceChildren();
  world.clear();
  const rest = result.rest;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of rest) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const spanX = w * 1.35 + 80;
  const index = result.triangles.flat();
  let lowest = 0;
  result.variants.forEach((v, k) => {
    const last = v.frames[v.frames.length - 1];
    for (let i = 2; i < last.length; i += 3) lowest = Math.min(lowest, last[i]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rest.length * 3), 3));
    geo.setIndex(index);
    const kind = physicsFor(sources[k] ?? "")?.kind;
    const color = kind === "waxedCanvas" ? "#6f7445" : COLORS[k % COLORS.length];
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide, flatShading: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const offset = new THREE.Vector3(k * spanX, 0, 0);
    mesh.position.copy(offset);
    world.add(mesh);
    // Edge line so the outline reads like a cut edge.
    const label = document.createElement("div");
    label.className = "drape-label";
    const m = v.metrics;
    const stat = m.droopDeg !== null ? `droops ${m.droopDeg.toFixed(0)}°` : m.drapeCoefficient !== null ? `drape ${m.drapeCoefficient.toFixed(2)}` : `drops ${m.tipDropMm.toFixed(0)} mm`;
    label.innerHTML = `<strong>${v.label}</strong><span>${stat}</span>`;
    labelLayer.appendChild(label);
    meshes.push({ geo, offset, label });
  });
  for (const s of supportMeshes(result, spanX, result.variants.length)) world.add(s);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(spanX * result.variants.length + 2000, 3000),
    new THREE.MeshStandardMaterial({ color: "#3b2415", roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((spanX * (result.variants.length - 1)) / 2 + (minX + maxX) / 2, lowest - 6, (minY + maxY) / 2);
  floor.receiveShadow = true;
  world.add(floor);
  // Frame every variant's settled shape from a three-quarter view.
  const box = new THREE.Box3();
  result.variants.forEach((v, k) => {
    const last = v.frames[v.frames.length - 1];
    for (let i = 0; i < last.length; i += 3) box.expandByPoint(new THREE.Vector3(last[i] + k * spanX, last[i + 2], last[i + 1]));
  });
  const center = box.getCenter(new THREE.Vector3());
  const dims = box.getSize(new THREE.Vector3());
  const radius = Math.max(dims.length() / 2, 50);
  const fov = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.sin(fov / 2)) * 1.05;
  const dir = new THREE.Vector3(0.45, 0.55, 0.7).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(1, distance / 100);
  camera.far = distance * 20;
  camera.updateProjectionMatrix();
  const s = radius * 1.6;
  sunLight.position.copy(center).add(new THREE.Vector3(radius * 0.6, radius * 2, radius * 0.8));
  sunLight.target.position.copy(center);
  Object.assign(sunLight.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: radius * 6 });
  sunLight.shadow.camera.updateProjectionMatrix();
  drape.frame = 0;
  drape.playing = true;
  animStart = performance.now();
  applyFrame(0);
}

function framesCount(): number {
  return drape.result ? Math.max(...drape.result.variants.map((v) => v.frames.length)) : 0;
}

export function applyFrame(f: number): void {
  const r = drape.result;
  if (!r) return;
  drape.frame = f;
  r.variants.forEach((v, k) => {
    const fr = v.frames[Math.min(f, v.frames.length - 1)];
    const pos = meshes[k]?.geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < fr.length; i += 3) {
      arr[i] = fr[i];
      arr[i + 1] = fr[i + 2];
      arr[i + 2] = fr[i + 1];
    }
    pos.needsUpdate = true;
    meshes[k].geo.computeVertexNormals();
    meshes[k].geo.computeBoundingSphere();
  });
}

function stepAnimation(): void {
  if (!drape.playing || !drape.result) return;
  const n = framesCount();
  const f = Math.min(n - 1, Math.floor(((performance.now() - animStart) / 2500) * n));
  if (f !== drape.frame) {
    applyFrame(f);
    const slider = document.getElementById("drape-scrub") as HTMLInputElement | null;
    if (slider) slider.value = String(f);
  }
  if (f >= n - 1) drape.playing = false;
}

export function replay(): void {
  animStart = performance.now();
  drape.playing = true;
}

export function scrub(f: number): void {
  drape.playing = false;
  applyFrame(f);
}

export function maxFrame(): number {
  return Math.max(0, framesCount() - 1);
}

function placeLabels(): void {
  const r = host.getBoundingClientRect();
  for (const m of meshes) {
    m.geo.computeBoundingBox();
    const b = m.geo.boundingBox;
    if (!b) continue;
    const p = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y + 30, (b.min.z + b.max.z) / 2).add(m.offset).project(camera);
    m.label.style.left = `${((p.x + 1) / 2) * r.width}px`;
    m.label.style.top = `${((1 - p.y) / 2) * r.height}px`;
    m.label.style.display = p.z < 1 ? "" : "none";
  }
}

/** PNG of the 3D view (base64, no data: prefix). */
export function captureDrape(): string {
  if (!renderer) return "";
  controls.update();
  renderer.render(scene3, camera);
  placeLabels();
  const src = renderer.domElement;
  const k = Math.min(1, 1200 / Math.max(src.width, src.height, 1));
  const out = document.createElement("canvas");
  out.width = Math.round(src.width * k);
  out.height = Math.round(src.height * k);
  const c = out.getContext("2d")!;
  c.drawImage(src, 0, 0, out.width, out.height);
  const s = out.width / Math.max(1, host.getBoundingClientRect().width);
  for (const m of meshes) {
    if (m.label.style.display === "none") continue;
    const x = parseFloat(m.label.style.left) * s;
    const y = parseFloat(m.label.style.top) * s;
    const title = m.label.querySelector("strong")?.textContent ?? "";
    const sub = m.label.querySelector("span")?.textContent ?? "";
    c.font = `600 ${Math.round(12 * s)}px Cinzel, serif`;
    const w1 = c.measureText(title).width;
    c.font = `italic ${Math.round(14 * s)}px 'EB Garamond', serif`;
    const w = Math.max(w1, c.measureText(sub).width) + 20 * s;
    const hgt = 40 * s;
    c.fillStyle = "rgba(246,236,211,0.94)";
    c.fillRect(x - w / 2, y - hgt, w, hgt);
    c.strokeStyle = "#b08a3e";
    c.lineWidth = Math.max(1, s);
    c.strokeRect(x - w / 2, y - hgt, w, hgt);
    c.textAlign = "center";
    c.fillStyle = "#7a1f1a";
    c.font = `600 ${Math.round(12 * s)}px Cinzel, serif`;
    c.fillText(title, x, y - hgt + 16 * s);
    c.fillStyle = "#2b1d0e";
    c.font = `italic ${Math.round(14 * s)}px 'EB Garamond', serif`;
    c.fillText(sub, x, y - 8 * s);
  }
  return out.toDataURL("image/png").split(",")[1] ?? "";
}

export function hasDrapeView(): boolean {
  return renderer !== null;
}
