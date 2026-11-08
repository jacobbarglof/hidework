// The 3D window: the finished piece, simulated live like CLO's 3D garment window.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { invoke } from "@tauri-apps/api/core";
import { generation, notify, setStatus, state, uid, version } from "./store";
import { colorFor, finishFor, surfaces } from "./textures";
import type { Prop, SimInfo, SimObject, SimStatus, Shape } from "./simtypes";
import { createViewCube, groundGrid, studioBackground, type ViewCube } from "./scenery";
import { markTextures, stitchMeshes, updateDecor, updateStitches, type Metal, type StitchMeshes } from "./fittings";
import { HardwareLayer } from "./hardware/instances";
import { edgeMaterial as rimMaterial, makeRim, writeRim } from "./hardware/edges";
import { framesFor, noteFrame, noteSim, onQualityChange, quality, type Quality } from "./quality";

/** "orbit" is the default: left-drag on the leather pulls it, on empty space orbits. "pan" makes
 * left-drag pan everywhere (the navigation bar's Pan). */
export type Tool3d = "orbit" | "pan" | "move" | "pin" | "weight" | "object";

export const sim3d = {
  info: null as SimInfo | null,
  status: null as SimStatus | null,
  running: false,
  building: false,
  builtVersion: -1,
  tool: "orbit" as Tool3d,
  heat: false,
  stitches: true,
  foldAngle: 180,
  weightGrams: 200,
  objectPreset: "phone",
  props: [] as Prop[],
  liftMm: 0,
  frames: 0,
  error: "",
  metal: "brass" as Metal,
};

export const OBJECT_PRESETS: Record<string, { name: string; shape: Shape; grams: number; color: string }> = {
  cards: { name: "5 cards", shape: { type: "box", size: [85.6, 54, 4] }, grams: 25, color: "#2f5d8a" },
  phone: { name: "Phone", shape: { type: "box", size: [72, 147, 8] }, grams: 190, color: "#1b1b1f" },
  keys: { name: "Keys", shape: { type: "box", size: [60, 30, 12] }, grams: 60, color: "#9a9aa2" },
  notebook: { name: "A5 notebook", shape: { type: "box", size: [148, 210, 12] }, grams: 300, color: "#7a2e24" },
  tablet: { name: "Tablet", shape: { type: "box", size: [175, 250, 7] }, grams: 480, color: "#2a2a30" },
  bottle: { name: "Water bottle", shape: { type: "cylinder", radius: 33, height: 210 }, grams: 520, color: "#6fa3c7" },
  apple: { name: "Apple", shape: { type: "sphere", radius: 38 }, grams: 180, color: "#a8322b" },
  kilo: { name: "1 kg weight", shape: { type: "cylinder", radius: 30, height: 45 }, grams: 1000, color: "#7d6a3a" },
};

let host: HTMLElement;
let renderer: THREE.WebGLRenderer;
let composer: EffectComposer;
let gtao: GTAOPass;
let smaa: SMAAPass;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let sun: THREE.DirectionalLight;
const cloth = new THREE.Group();
const extras = new THREE.Group();
const propGroup = new THREE.Group();
let positions: Float32Array | null = null;
interface PieceMeshes {
  geo: THREE.BufferGeometry;
  grain: THREE.Mesh;
  flesh: THREE.Mesh;
  heat: THREE.Mesh;
  /** Cut edges, one mesh per edge finish. */
  rims: { mesh: THREE.Mesh; edges: [number, number][] }[];
  overlay: THREE.Mesh | null;
  halfT: number;
}
let pieces: PieceMeshes[] = [];
let shared: THREE.BufferAttribute | null = null;
let normals: Float32Array | null = null;
let stitchSet: StitchMeshes | null = null;
const decor = new THREE.Group();
let viewCube: ViewCube | null = null;
let hardware: THREE.Group = new THREE.Group();
let objectMeshes = new Map<string, THREE.Mesh>();
let markerGroup = new THREE.Group();
let utilisation: Float32Array | null = null;
let stepping = false;
let builtGeneration = -1;
let dragging: { vertex: number; plane: THREE.Plane; radius: number } | null = null;

const raycaster = new THREE.Raycaster();

export function initView3d(el: HTMLElement): void {
  host = el;
  renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(quality().pixelRatio, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = studioBackground();
  scene.backgroundIntensity = 1;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.8;
  camera = new THREE.PerspectiveCamera(32, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  camera.position.set(250, -350, 300);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // Left drag on the leather grabs and pulls it; left drag on empty space, or right drag, orbits;
  // middle drag pans; the wheel zooms.
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  sun = new THREE.DirectionalLight("#ffffff", 2.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight("#e4eeff", 0.7);
  fill.position.set(-400, 300, 200);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight("#f2f5fa", "#b9b2a8", 0.55));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.ShadowMaterial({ opacity: 0.2 }));
  ground.receiveShadow = true;
  scene.add(ground);
  scene.add(groundGrid());
  scene.add(cloth, extras, propGroup, markerGroup);
  extras.add(decor);
  extras.add(hardware);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.updateGtaoMaterial({ radius: 6, distanceExponent: 1, thickness: 3, scale: 1.2 });
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
  smaa = new SMAAPass(1, 1);
  composer.addPass(smaa);
  applyQuality(quality());
  // A change of quality (by the user, or Auto stepping down on a slow computer) redraws at once
  // and, when the mesh detail changed, rebuilds the model in place, keeping its shape.
  onQualityChange((q, remesh) => {
    applyQuality(q);
    resize();
    if (remesh && sim3d.info && !sim3d.building) void rebuild(true, true);
  });
  new ResizeObserver(resize).observe(el);
  resize();
  bindPointer();
  viewCube = createViewCube(el, (dir) => lookFrom(dir), () => viewPreset("iso"));
  let last = performance.now();
  const loop = () => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const elapsed = now - last;
    last = now;
    controls.mouseButtons.LEFT = sim3d.tool === "pan" ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.update();
    // Keep up with real time: a 60 Hz screen needs a frame and a half of simulation per redraw
    // (the solver's frame is 1/90 s); a slow redraw catches up by up to three.
    if (sim3d.running && !stepping && positions) void step(framesFor(elapsed));
    const note = noteFrame(now, sim3d.running);
    if (note) setStatus(note);
    composer.render();
    viewCube?.sync(camera, controls.target);
  };
  loop();
}

function resize(): void {
  const r = host.getBoundingClientRect();
  const w = Math.max(1, r.width);
  const h = Math.max(1, r.height);
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------- building the scene ----------

/** (Re)start the simulation from the current pattern. */
export async function rebuild(keepRunning = false, carry = false): Promise<void> {
  if (sim3d.building) return;
  // Carry the current 3D shape over only for an edit of the same project, never a new one.
  carry = carry && !!sim3d.info && builtGeneration === generation;
  sim3d.building = true;
  // The pattern this build is made from; edits made while it runs leave it out of date.
  const startVersion = version;
  sim3d.error = "";
  const was = sim3d.running;
  sim3d.running = false;
  // Let a frame already on its way finish, so its positions are not drawn on the new mesh.
  while (stepping) await new Promise((r) => setTimeout(r, 5));
  // Keep the scene (objects, weights, pins) across a rebuild, like CLO keeps the avatar.
  const keep = builtGeneration === generation ? sim3d.status : null;
  if (!keep) {
    sim3d.status = null;
    for (const m of objectMeshes.values()) extras.remove(m);
    objectMeshes.clear();
    if (builtGeneration !== generation) {
      sim3d.props = [];
      sim3d.liftMm = 0;
    }
  }
  builtGeneration = generation;
  try {
    const info = await invoke<SimInfo>("sim_start", {
      project: state.project,
      spec: { foldAngleDeg: sim3d.foldAngle, props: sim3d.props, liftMm: sim3d.liftMm, resolution: quality().resolution },
      carry,
    });
    sim3d.info = info;
    sim3d.builtVersion = startVersion;
    sim3d.frames = 0;
    build(info);
    if (keep) {
      for (const o of keep.objects) await invoke("sim_add_object", { object: o });
      for (const [id, grams, at] of keep.weights) await invoke("sim_add_weight", { id, target: { world: at }, grams });
      for (const [id, at] of keep.pins) await invoke("sim_pin", { id, target: { world: at } });
    }
    const buf = await invoke<ArrayBuffer>("sim_step", { frames: 0 });
    applyPositions(new Float32Array(buf));
    // An edit keeps the camera where the user put it.
    if (!carry) frameView();
    sim3d.running = keepRunning && was;
    await refreshStatus();
  } catch (e) {
    sim3d.error = String(e);
    setStatus(`3D: ${e}`);
  } finally {
    sim3d.building = false;
    notify();
  }
}

function build(info: SimInfo): void {
  for (const p of pieces) {
    p.geo.dispose();
    for (const r of p.rims) r.mesh.geometry.dispose();
    p.overlay?.geometry.dispose();
  }
  cloth.clear();
  pieces = [];
  const n = info.rest.length / 2;
  positions = new Float32Array(n * 3);
  normals = new Float32Array(n * 3);
  shared = new THREE.BufferAttribute(positions, 3);
  shared.setUsage(THREE.DynamicDrawUsage);
  const normalAttr = new THREE.BufferAttribute(normals, 3);
  const uv = new Float32Array(n * 2);
  const colors = new Float32Array(n * 3);
  for (const pi of info.pieces) {
    const mat = state.project.materials.find((m) => m.id === pi.materialId);
    const color = mat?.color ?? colorFor(mat?.kind ?? "leather", mat?.name ?? "");
    const surf = surfaces(color, finishFor(mat?.kind ?? "leather", mat?.name ?? ""));
    for (let i = pi.vertexStart; i < pi.vertexStart + pi.vertexCount; i++) {
      uv[i * 2] = info.rest[i * 2] / surf.tileMm;
      uv[i * 2 + 1] = info.rest[i * 2 + 1] / surf.tileMm;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", shared);
    geo.setAttribute("normal", normalAttr);
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(info.indices.slice(pi.indexStart, pi.indexStart + pi.indexCount));
    const halfT = pi.thicknessMm / 2;
    const grain = new THREE.Mesh(geo, offsetMaterial(surf.grain, -halfT));
    const flesh = new THREE.Mesh(geo, offsetMaterial(surf.flesh, halfT));
    const heat = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }));
    heat.visible = false;
    for (const m of [grain, flesh, heat]) {
      m.castShadow = true;
      m.receiveShadow = true;
      cloth.add(m);
    }
    // Cut edges, grouped by finish: raw, burnished, painted, turned or bound.
    const groups = new Map<string, [number, number][]>();
    info.boundary.forEach(([a, b], k) => {
      if (a < pi.vertexStart || a >= pi.vertexStart + pi.vertexCount) return;
      const f = info.boundaryFinish?.[k] ?? "raw";
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f)!.push([a, b]);
    });
    const rims: PieceMeshes["rims"] = [];
    for (const [finish, edges] of groups) {
      // Shaped by finish (rounded, beaded, folded, fibrous): hardware/edges.ts.
      const rim = makeRim(info, edges, finish, edgeMaterial(finish, color, surf), [pi.indexStart, pi.indexStart + pi.indexCount], surf.tileMm);
      rim.castShadow = true;
      cloth.add(rim);
      rims.push({ mesh: rim, edges });
    }
    // Stamps, tooling, paint and lettering drawn onto the grain.
    let overlay: THREE.Mesh | null = null;
    const cp = state.computed?.pieces.find((c) => c.id === pi.id);
    const tex = cp ? markTextures(cp) : null;
    if (tex) {
      const ouv = new Float32Array(n * 2);
      for (let i = pi.vertexStart; i < pi.vertexStart + pi.vertexCount; i++) {
        ouv[i * 2] = (info.rest[i * 2] - tex.min.x) / tex.size.x;
        ouv[i * 2 + 1] = 1 - (info.rest[i * 2 + 1] - tex.min.y) / tex.size.y;
      }
      const og = new THREE.BufferGeometry();
      og.setAttribute("position", shared);
      og.setAttribute("normal", normalAttr);
      og.setAttribute("uv", new THREE.BufferAttribute(ouv, 2));
      og.setIndex(info.indices.slice(pi.indexStart, pi.indexStart + pi.indexCount));
      const om = new THREE.MeshStandardMaterial({ map: tex.map, bumpMap: tex.bump, bumpScale: 1.2, transparent: true, roughness: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
      overlay = new THREE.Mesh(og, offsetMaterial(om, -halfT - 0.06));
      overlay.renderOrder = 2;
      cloth.add(overlay);
    }
    grain.userData.piece = flesh.userData.piece = heat.userData.piece = pi.id;
    pieces.push({ geo, grain, flesh, heat, rims, overlay, halfT });
  }
  buildStitches(info);
  buildHardware(info);
  buildProps();
}

/** Push a surface material out along its normal by `offset` mm (gives the leather thickness). */
function offsetMaterial(base: THREE.Material, offset: number): THREE.Material {
  const m = base.clone();
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n transformed += normalize(objectNormal) * ${offset.toFixed(4)};`);
  };
  m.customProgramCacheKey = () => `offset${offset.toFixed(4)}${base.uuid}`;
  return m;
}

/** Material for a cut edge by its finish (hardware/edges.ts). */
function edgeMaterial(finish: string, color: string, surf: ReturnType<typeof surfaces>): THREE.Material {
  return rimMaterial(finish, color, surf);
}

function buildStitches(info: SimInfo): void {
  if (stitchSet) {
    extras.remove(stitchSet.thread, stitchSet.lace);
    stitchSet.thread.geometry.dispose();
    stitchSet.lace.geometry.dispose();
  }
  const color = state.project.threadColor ?? "#efe4c8";
  // Lace in a darker tone of the first leather.
  const m0 = state.project.materials[0];
  const lace = new THREE.Color(m0?.color ?? colorFor(m0?.kind ?? "leather", m0?.name ?? "")).multiplyScalar(0.55);
  stitchSet = stitchMeshes(info, color, `#${lace.getHexString()}`);
  extras.add(stitchSet.thread, stitchSet.lace);
}

const BRASS = new THREE.MeshStandardMaterial({ color: "#c9a24a", metalness: 1, roughness: 0.28 });

/** Set hardware, labelled fasteners and punched holes, instanced by kind (hardware/instances.ts). */
let hwLayer: HardwareLayer | null = null;

function buildHardware(info: SimInfo): void {
  extras.remove(hardware);
  hwLayer?.dispose();
  hwLayer = new HardwareLayer(info, sim3d.metal);
  hardware = hwLayer.group;
  extras.add(hardware);
}

const WOOD = new THREE.MeshStandardMaterial({ color: "#6b4528", roughness: 0.7 });
const STEEL = new THREE.MeshStandardMaterial({ color: "#a7a9ad", metalness: 1, roughness: 0.3 });

function buildProps(): void {
  propGroup.clear();
  for (const p of sim3d.props) {
    let m: THREE.Mesh;
    if (p.type === "box") {
      const s = [p.max[0] - p.min[0], p.max[1] - p.min[1], p.max[2] - p.min[2]];
      m = new THREE.Mesh(new THREE.BoxGeometry(s[0], s[1], s[2]), WOOD);
      m.position.set((p.min[0] + p.max[0]) / 2, (p.min[1] + p.max[1]) / 2, (p.min[2] + p.max[2]) / 2);
    } else if (p.type === "pedestal") {
      m = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, p.top, 64), BRASS);
      m.rotation.x = Math.PI / 2;
      m.position.set(p.center[0], p.center[1], p.top / 2);
    } else {
      const a = new THREE.Vector3(...p.a);
      const b = new THREE.Vector3(...p.b);
      m = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, a.distanceTo(b), 24), STEEL);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    }
    m.castShadow = m.receiveShadow = true;
    propGroup.add(m);
  }
}

// ---------- per-frame updates ----------

function surfacePoint(tri: number, bary: [number, number, number]): { p: THREE.Vector3; n: THREE.Vector3 } {
  const info = sim3d.info!;
  const ids = [info.indices[tri * 3], info.indices[tri * 3 + 1], info.indices[tri * 3 + 2]];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  ids.forEach((id, k) => {
    p.x += positions![id * 3] * bary[k];
    p.y += positions![id * 3 + 1] * bary[k];
    p.z += positions![id * 3 + 2] * bary[k];
    n.x += normals![id * 3] * bary[k];
    n.y += normals![id * 3 + 1] * bary[k];
    n.z += normals![id * 3 + 2] * bary[k];
  });
  return { p, n: n.normalize() };
}

function computeNormals(): void {
  const info = sim3d.info!;
  const pos = positions!;
  const nor = normals!;
  nor.fill(0);
  const ix = info.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      nor[k] += nx;
      nor[k + 1] += ny;
      nor[k + 2] += nz;
    }
  }
  for (let i = 0; i < nor.length; i += 3) {
    const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]) || 1;
    nor[i] /= l;
    nor[i + 1] /= l;
    nor[i + 2] /= l;
  }
}

function applyPositions(buf: Float32Array): void {
  if (!positions || !sim3d.info) return;
  const n = positions.length;
  // A frame from the simulation before a rebuild has a different number of points: skip it.
  if (buf.length < n) return;
  positions.set(buf.subarray(0, n));
  computeNormals();
  shared!.needsUpdate = true;
  for (const p of pieces) {
    (p.geo.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
    p.geo.computeBoundingSphere();
    updateRim(p);
  }
  if (stitchSet) {
    stitchSet.thread.visible = stitchSet.lace.visible = sim3d.stitches;
    updateStitches(surfaceAccess, stitchSet);
  }
  updateHardware();
  if (decorTick++ % 3 === 0) refreshDecor();
  // Objects follow the cloth positions in the same buffer.
  const objs = sim3d.status?.objects ?? [];
  objs.forEach((o, k) => {
    const m = objectMeshes.get(o.id);
    if (m && buf.length >= n + (k + 1) * 3) m.position.set(buf[n + k * 3], buf[n + k * 3 + 1], buf[n + k * 3 + 2]);
  });
  updateMarkers();
}

function updateRim(p: PieceMeshes): void {
  for (const r of p.rims) writeRim(r.mesh, positions!, normals!, p.halfT);
  if (p.overlay) p.overlay.geometry.computeBoundingSphere();
}

let decorTick = 0;
const DECOR_MATS = {
  welt: new THREE.MeshStandardMaterial({ color: "#3a2416", roughness: 0.6 }),
  zip: new THREE.MeshStandardMaterial({ color: "#1e1d1c", roughness: 0.8 }),
  teeth: new THREE.MeshStandardMaterial({ color: "#b9bcc2", metalness: 1, roughness: 0.3 }),
};

function refreshDecor(): void {
  const info = sim3d.info;
  if (!info || !positions || !normals) return;
  updateDecor(decor, info, positions, normals, DECOR_MATS, (mid) => {
    const m = state.project.materials.find((x) => x.id === mid);
    const c = new THREE.Color(m?.color ?? colorFor(m?.kind ?? "leather", m?.name ?? "")).multiplyScalar(0.75);
    return new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 });
  });
}

/** What the stitch builder needs to know about the cloth right now. */
const surfaceAccess = {
  get info(): SimInfo {
    return sim3d.info!;
  },
  at: (sp: { tri: number; bary: [number, number, number] }) => surfacePoint(sp.tri, sp.bary),
  thickness: (pid: string) => sim3d.info?.pieces.find((p) => p.id === pid)?.thicknessMm ?? 1.5,
  laceWidth: (pid: string) => state.project.pieces.find((p) => p.id === pid)?.stitch.holeMm ?? 3,
};

function updateHardware(): void {
  if (sim3d.info && hwLayer) hwLayer.update(surfacePoint);
}

const PIN_MAT = new THREE.MeshStandardMaterial({ color: "#b3261e", roughness: 0.3 });

function updateMarkers(): void {
  markerGroup.clear();
  const st = sim3d.status;
  if (!st) return;
  for (const [, at] of st.pins) {
    const head = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 12), PIN_MAT);
    head.position.set(at[0], at[1], at[2] + 4);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 8, 6), STEEL);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.set(at[0], at[1], at[2]);
    markerGroup.add(head, shaft);
  }
  for (const [, grams, at] of st.weights) {
    const r = Math.cbrt(grams / 8.5 / Math.PI) * 4;
    const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, r * 1.2, 32), BRASS);
    w.rotation.x = Math.PI / 2;
    w.position.set(at[0], at[1], at[2] - 30 - r * 0.6);
    w.castShadow = true;
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 30, 4), STEEL);
    cord.rotation.x = Math.PI / 2;
    cord.position.set(at[0], at[1], at[2] - 15);
    markerGroup.add(w, cord);
  }
}

function syncObjects(): void {
  const objs = sim3d.status?.objects ?? [];
  for (const [id, m] of objectMeshes) {
    if (!objs.some((o) => o.id === id)) {
      extras.remove(m);
      objectMeshes.delete(id);
    }
  }
  objs.forEach((o, k) => {
    if (objectMeshes.has(o.id)) return;
    const preset = Object.values(OBJECT_PRESETS).find((p) => p.name === o.name);
    const mat = new THREE.MeshPhysicalMaterial({ color: preset?.color ?? "#777", roughness: 0.35, clearcoat: 0.4, transparent: /bottle/i.test(o.name), opacity: /bottle/i.test(o.name) ? 0.75 : 1 });
    const s = o.shape;
    const geo = s.type === "box" ? new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]) : s.type === "sphere" ? new THREE.SphereGeometry(s.radius, 32, 24) : new THREE.CylinderGeometry(s.radius, s.radius, s.height, 40);
    if (s.type === "cylinder") geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    const at = sim3d.status!.objectPositions[k]?.[1] ?? o.pos;
    mesh.position.set(at[0], at[1], at[2]);
    extras.add(mesh);
    objectMeshes.set(o.id, mesh);
  });
}

export async function refreshStatus(): Promise<void> {
  try {
    sim3d.status = await invoke<SimStatus>("sim_status");
    syncObjects();
    updateMarkers();
    if (sim3d.heat) await refreshHeat();
  } catch {
    sim3d.status = null;
  }
}

async function refreshHeat(): Promise<void> {
  const buf = await invoke<ArrayBuffer>("sim_utilisation");
  utilisation = new Float32Array(buf);
  const colors = pieces[0]?.geo.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!colors) return;
  const arr = colors.array as Float32Array;
  const c = new THREE.Color();
  for (let i = 0; i < utilisation.length; i++) {
    // Blue (relaxed) -> green -> yellow -> red (at the limit), on a log-ish scale.
    const u = Math.min(1, Math.sqrt(Math.max(0, utilisation[i])) * 1.6);
    c.setHSL((1 - u) * 0.66, 0.85, 0.5);
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  colors.needsUpdate = true;
}

export function setHeat(on: boolean): void {
  sim3d.heat = on;
  for (const p of pieces) {
    p.heat.visible = on;
    p.grain.visible = p.flesh.visible = !on;
  }
  if (on) void refreshHeat();
  notify();
}

async function step(frames = 1): Promise<void> {
  stepping = true;
  try {
    const buf = await invoke<ArrayBuffer>("sim_step", { frames });
    applyPositions(new Float32Array(buf));
    noteSim(frames);
    const before = sim3d.frames;
    sim3d.frames += frames;
    if (Math.floor(sim3d.frames / 20) !== Math.floor(before / 20)) {
      await refreshStatus();
      notify();
      if (sim3d.status?.metrics.settled && !dragging) {
        sim3d.running = false;
        setStatus("Settled. Drag, pin or load the piece, then simulate again.");
        notify();
      }
    }
  } catch (e) {
    sim3d.running = false;
    setStatus(String(e));
  } finally {
    stepping = false;
  }
}

export function frameView(): void {
  if (!positions || positions.length === 0) return;
  const box = new THREE.Box3();
  for (let i = 0; i < positions.length; i += 3) box.expandByPoint(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
  for (const m of propGroup.children) box.expandByObject(m);
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(40, box.getSize(new THREE.Vector3()).length() / 2);
  // Fit the narrower of the vertical and horizontal fields of view.
  const vHalf = (camera.fov / 2) * (Math.PI / 180);
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const dist = (r / Math.sin(Math.min(vHalf, hHalf))) * 1.1;
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.55, -0.75, 0.6).normalize().multiplyScalar(dist));
  camera.near = Math.max(0.5, dist / 200);
  camera.far = dist * 30;
  camera.updateProjectionMatrix();
  sun.position.copy(c).add(new THREE.Vector3(r * 0.8, -r * 0.6, r * 2.5));
  sun.target.position.copy(c);
  const s = r * 1.8;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: r * 8 });
  sun.shadow.camera.updateProjectionMatrix();
  gtao.updateGtaoMaterial({ radius: r * 0.05 });
}

/** Zoom the 3D camera toward (factor > 1) or away from its target. */
export function zoom3d(factor: number): void {
  const t = controls.target;
  const offset = camera.position.clone().sub(t).multiplyScalar(1 / Math.max(0.05, factor));
  const d = offset.length();
  if (d < camera.near * 2 || d > camera.far * 0.8) return;
  camera.position.copy(t).add(offset);
}

/** Look at the target from a direction (unit vector toward the camera), keeping the distance. */
export function lookFrom(dir: THREE.Vector3): void {
  const t = controls.target.clone();
  const d = camera.position.distanceTo(t);
  const v = dir.clone().normalize();
  // Straight down or up: nudge so z-up orbiting stays well defined.
  if (Math.abs(v.z) > 0.999) v.set(0.001, -0.001, Math.sign(v.z));
  camera.position.copy(t).add(v.multiplyScalar(d));
}

/** Hardware colour: brass, nickel, gunmetal, copper or black. */
export function setMetal(m: Metal): void {
  sim3d.metal = m;
  if (sim3d.info) buildHardware(sim3d.info);
  if (positions) updateHardware();
  notify();
}

export function viewPreset(name: "front" | "back" | "top" | "side" | "iso"): void {
  const t = controls.target.clone();
  const d = camera.position.distanceTo(t);
  const dirs: Record<string, THREE.Vector3> = {
    front: new THREE.Vector3(0, -1, 0.05),
    back: new THREE.Vector3(0, 1, 0.05),
    top: new THREE.Vector3(0.001, -0.001, 1),
    side: new THREE.Vector3(1, 0, 0.05),
    iso: new THREE.Vector3(0.55, -0.75, 0.6),
  };
  camera.position.copy(t).add(dirs[name].normalize().multiplyScalar(d));
}

// ---------- interaction ----------

/** Right-click (marking menu): whether the leather is under a screen point. */
export function leatherAt(clientX: number, clientY: number): boolean {
  return !!sim3d.info && !!pick({ clientX, clientY } as PointerEvent);
}

function pick(ev: PointerEvent): THREE.Intersection | null {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const meshes = pieces.flatMap((p) => (sim3d.heat ? [p.heat] : [p.grain, p.flesh]));
  return raycaster.intersectObjects(meshes, false)[0] ?? null;
}

function hitVertex(hit: THREE.Intersection): number {
  const f = hit.face!;
  let best = f.a;
  let bd = Infinity;
  for (const i of [f.a, f.b, f.c]) {
    const d = hit.point.distanceTo(new THREE.Vector3(positions![i * 3], positions![i * 3 + 1], positions![i * 3 + 2]));
    if (d < bd) [best, bd] = [i, d];
  }
  return best;
}

function bindPointer(): void {
  const el = renderer.domElement;
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  // Capture phase, so a grab on the leather can stop the orbit control before it starts.
  el.addEventListener("pointerdown", async (ev) => {
    if (ev.button !== 0 || !sim3d.info || sim3d.tool === "pan") return;
    const hit = pick(ev);
    if (sim3d.tool === "orbit" || sim3d.tool === "move") {
      if (!hit) return;
      controls.enabled = false;
      const vertex = hitVertex(hit);
      const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
      // Shift moves the whole piece; otherwise a hand-sized patch is pulled.
      const radius = ev.shiftKey ? 1e9 : 12;
      dragging = { vertex, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point), radius };
      el.setPointerCapture(ev.pointerId);
      await invoke("sim_drag", { vertex, target: hit.point.toArray(), radiusMm: radius });
      if (!sim3d.running) {
        sim3d.running = true;
        setStatus(ev.shiftKey ? "Moving the piece. Let go to drop it." : "Pulling the leather. Shift+drag moves a whole piece.");
      }
      notify();
    } else if (sim3d.tool === "pin" && hit) {
      controls.enabled = false;
      const id = uid("pin");
      await invoke("sim_pin", { id, target: { vertex: hitVertex(hit) } });
      await refreshStatus();
      setStatus("Pinned. Simulate (Space) to let the rest hang.");
      notify();
    } else if (sim3d.tool === "weight" && hit) {
      controls.enabled = false;
      const id = uid("w");
      await invoke("sim_add_weight", { id, target: { vertex: hitVertex(hit) }, grams: sim3d.weightGrams });
      await refreshStatus();
      sim3d.running = true;
      notify();
    } else if (sim3d.tool === "object") {
      controls.enabled = false;
      await dropObject(sim3d.objectPreset, hit ? hit.point : null);
    }
  }, { capture: true });
  el.addEventListener("pointermove", async (ev) => {
    if (!dragging) return;
    const r = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const p = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragging.plane, p)) await invoke("sim_drag", { vertex: dragging.vertex, target: p.toArray(), radiusMm: dragging.radius });
  });
  el.addEventListener("pointerup", async () => {
    controls.enabled = true;
    if (!dragging) return;
    dragging = null;
    await invoke("sim_drag", { vertex: null, target: [0, 0, 0] });
  });
}

/** Drop a library object above a point (or above the middle of the piece). */
export async function dropObject(preset: string, at: THREE.Vector3 | null): Promise<string> {
  const o = OBJECT_PRESETS[preset];
  if (!o || !positions) throw new Error(`No object ${preset}`);
  let p = at;
  if (!p) {
    const box = new THREE.Box3();
    for (let i = 0; i < positions.length; i += 3) box.expandByPoint(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
    p = box.getCenter(new THREE.Vector3());
    p.z = box.max.z;
  }
  const half = o.shape.type === "box" ? o.shape.size[2] / 2 : o.shape.type === "sphere" ? o.shape.radius : o.shape.height / 2;
  const id = uid("o");
  const spec: SimObject = { id, name: o.name, shape: o.shape, grams: o.grams, pos: [p.x, p.y, p.z + half + 25] };
  await invoke("sim_add_object", { object: spec });
  await refreshStatus();
  sim3d.running = true;
  setStatus(`${o.name} (${o.grams} g) dropped in. It is simulating.`);
  notify();
  return id;
}

export async function removeSceneItem(id: string): Promise<void> {
  await invoke("sim_remove", { id });
  await refreshStatus();
  sim3d.running = true;
  notify();
}

export async function setProps(props: Prop[], lift: number): Promise<void> {
  sim3d.props = props;
  sim3d.liftMm = lift;
  // New scenery: start the scene fresh (pins and loads were placed for the old one).
  sim3d.status = null;
  for (const m of objectMeshes.values()) extras.remove(m);
  objectMeshes.clear();
  await rebuild();
}

export function bounds(): THREE.Box3 | null {
  if (!positions) return null;
  const box = new THREE.Box3();
  for (let i = 0; i < positions.length; i += 3) box.expandByPoint(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
  return box;
}

export function setRunning(on: boolean): void {
  sim3d.running = on && !!sim3d.info;
  notify();
}

export async function resetSim(): Promise<void> {
  await invoke("sim_reset");
  const buf = await invoke<ArrayBuffer>("sim_step", { frames: 0 });
  applyPositions(new Float32Array(buf));
  await refreshStatus();
  notify();
}

/** Run the simulation for a number of frames without drawing each one (for agents). */
export async function runFrames(frames: number): Promise<void> {
  const buf = await invoke<ArrayBuffer>("sim_step", { frames });
  applyPositions(new Float32Array(buf));
  await refreshStatus();
}

/** PNG (base64) of the 3D window at most 1200 px. */
export function capture3d(): string {
  controls.update();
  composer.render();
  const src = renderer.domElement;
  const k = Math.min(1, 1200 / Math.max(src.width, src.height, 1));
  const out = document.createElement("canvas");
  out.width = Math.round(src.width * k);
  out.height = Math.round(src.height * k);
  out.getContext("2d")!.drawImage(src, 0, 0, out.width, out.height);
  return out.toDataURL("image/png").split(",")[1] ?? "";
}

export function needsRebuild(): boolean {
  return sim3d.builtVersion !== version;
}

/** Draw at the chosen quality: pixel density, soft shadows, ambient occlusion, anti-aliasing. */
function applyQuality(q: Quality): void {
  renderer.setPixelRatio(Math.min(q.pixelRatio, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = q.shadows;
  sun.castShadow = q.shadows;
  if (sun.shadow.mapSize.x !== q.shadowMap) {
    sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  gtao.enabled = q.occlusion;
  smaa.enabled = q.antialias;
}
