// Dev-only gallery for judging the 3D hardware, stitches and edges close up (npm run dev, then
// http://localhost:1420/gallery.html). It is not part of the app: gallery.html is not a build
// entry, so `npm run build` leaves it out.
//
//   ?scene=hardware&metal=brass[&side=outer|inner][&under=1]   every kind in one metal
//   ?scene=kind&kind=snap-24[&side=inner][&under=1]            one kind in every metal
//   ?scene=bag&style=tote[&carry=both&closure=snap&edge=burnished&stitch=saddle]
//        [&frames=90][&focus=hw:magnet-18|corner|x,y,z][&dist=120][&dir=x,y,z]
//                                                              a real bag through the dev bridge
//
// The overlay counts WebGL draw calls and triangles for one frame of the main canvas.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// ---------- draw call counter (installed before any renderer exists) ----------

interface Counter { canvas: HTMLCanvasElement; calls: number; tris: number }
const counters: Counter[] = [];
const origGetContext = HTMLCanvasElement.prototype.getContext;
(HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function (this: HTMLCanvasElement, type: string, attrs?: unknown) {
  const ctx = (origGetContext as (this: HTMLCanvasElement, t: string, a?: unknown) => RenderingContext | null).call(this, type, attrs);
  if (ctx && (type === "webgl2" || type === "webgl") && !(ctx as unknown as { __counted?: boolean }).__counted) {
    const gl = ctx as WebGL2RenderingContext;
    (gl as unknown as { __counted: boolean }).__counted = true;
    const c: Counter = { canvas: this, calls: 0, tris: 0 };
    counters.push(c);
    const tri = (mode: number, count: number, inst = 1) => {
      c.calls++;
      if (mode === gl.TRIANGLES) c.tris += (count / 3) * inst;
      else if (mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN) c.tris += Math.max(0, count - 2) * inst;
    };
    const de = gl.drawElements.bind(gl);
    gl.drawElements = (m: number, n: number, t: number, o: number) => { tri(m, n); de(m, n, t, o); };
    const da = gl.drawArrays.bind(gl);
    gl.drawArrays = (m: number, f: number, n: number) => { tri(m, n); da(m, f, n); };
    if (gl.drawElementsInstanced) {
      const dei = gl.drawElementsInstanced.bind(gl);
      gl.drawElementsInstanced = (m: number, n: number, t: number, o: number, k: number) => { tri(m, n, k); dei(m, n, t, o, k); };
      const dai = gl.drawArraysInstanced.bind(gl);
      gl.drawArraysInstanced = (m: number, f: number, n: number, k: number) => { tri(m, n, k); dai(m, f, n, k); };
    }
  }
  return ctx;
};

// Grab the 3D window's orbit controls when it first updates, so the gallery can aim the camera.
let controls: OrbitControls | null = null;
const origUpdate = OrbitControls.prototype.update;
OrbitControls.prototype.update = function (this: OrbitControls, dt?: number | null) {
  if (!controls && (this.domElement as HTMLElement | null)?.parentElement?.id === "view3d") controls = this;
  return origUpdate.call(this, dt ?? null);
};

const q = new URLSearchParams(location.search);
const statsEl = document.getElementById("stats")!;
const labelsEl = document.getElementById("labels")!;
const host = document.getElementById("view3d")!;
let extraStats = "";

function mainCounter(): Counter | undefined {
  return counters.reduce<Counter | undefined>((best, c) => (!best || c.canvas.width * c.canvas.height > best.canvas.width * best.canvas.height ? c : best), undefined);
}

let frame = 0;
let lastCalls = 0;
let lastTris = 0;
let lastT = performance.now();
const dts: number[] = [];
function statLoop(): void {
  requestAnimationFrame(statLoop);
  const c = mainCounter();
  if (!c) return;
  const now = performance.now();
  dts.push(now - lastT);
  if (dts.length > 60) dts.shift();
  lastT = now;
  frame++;
  const calls = c.calls - lastCalls;
  const tris = c.tris - lastTris;
  lastCalls = c.calls;
  lastTris = c.tris;
  if (frame % 15 === 0 && calls > 0) {
    const ms = dts.reduce((a, b) => a + b, 0) / dts.length;
    statsEl.textContent = `draw calls/frame ${calls}\ntriangles/frame ${Math.round(tris).toLocaleString()}\nframe ${ms.toFixed(1)} ms${extraStats}`;
    statsEl.dataset.calls = String(calls);
    statsEl.dataset.tris = String(Math.round(tris));
  }
}

// ---------- hardware scenes ----------

const SIZES: Record<string, number> = {
  "rivet-s": 6, "rivet-m": 8, "rivet-l": 10, "copper-rivet": 9, "chicago-screw": 10, "snap-24": 15, "snap-20": 12.5,
  "magnet-18": 18, "turnlock-catch": 30, "turnlock-eyelet": 30, "sam-browne": 10, "grommet-10": 10, "eyelet-5": 5,
  "bag-foot": 12, "d-ring": 25, "o-ring": 25, "square-ring": 25, buckle: 25, "swivel-clasp": 25, "key-ring": 25,
  zipper: 90, plaque: 40, concho: 25,
};
const KINDS = Object.keys(SIZES);
const METAL_LIST = ["brass", "nickel", "gunmetal", "copper", "black"] as const;

async function hardwareScene(items: { kind: string; metal: string; label: string }[], cols: number, cell: number): Promise<void> {
  const fittings = await import("../fittings");
  const { surfaces } = await import("../textures");
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#dfe5eb");
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.8;
  const camera = new THREE.PerspectiveCamera(28, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  const sun = new THREE.DirectionalLight("#ffffff", 2.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight("#e4eeff", 0.7);
  fill.position.set(-400, 300, 200);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight("#f2f5fa", "#b9b2a8", 0.55));
  const under = q.get("under") === "1";
  const side = q.get("side") ?? "single";
  const t = 2;
  const leather = surfaces("#8a5a34", "smooth");
  const grainTop = leather.grain.clone();
  grainTop.side = THREE.FrontSide;
  const fleshBottom = leather.flesh.clone();
  fleshBottom.side = THREE.BackSide;
  const rows = Math.ceil(items.length / cols);
  const labels: { el: HTMLElement; p: THREE.Vector3 }[] = [];
  items.forEach((it, k) => {
    const cx = ((k % cols) - (cols - 1) / 2) * cell;
    const cy = ((rows - 1) / 2 - Math.floor(k / cols)) * cell;
    const slabGeo = new THREE.PlaneGeometry(cell * 0.86, cell * 0.86);
    const top = new THREE.Mesh(slabGeo, grainTop);
    const bot = new THREE.Mesh(slabGeo, fleshBottom);
    bot.position.z = -t;
    top.position.set(cx, cy, 0);
    bot.position.set(cx, cy, -t);
    top.receiveShadow = bot.receiveShadow = true;
    scene.add(top, bot);
    const size = SIZES[it.kind] ?? 10;
    const hm = fittings.hardwareMesh as unknown as (kind: string, size: number, t: number, m: string, role?: string) => THREE.Object3D;
    const g = hm(it.kind, size, t, it.metal, side);
    g.position.set(cx, cy, 0);
    scene.add(g);
    const el = document.createElement("span");
    el.textContent = it.label;
    labelsEl.appendChild(el);
    labels.push({ el, p: new THREE.Vector3(cx, cy - cell * 0.43, under ? -t : 0) });
  });
  const box = new THREE.Box3().setFromObject(scene);
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(cols, rows) * cell * 0.5;
  const dir = under ? new THREE.Vector3(0.0, -0.6, -1) : q.get("scene") === "kind" ? new THREE.Vector3(0.0, -0.95, 0.75) : new THREE.Vector3(0.0, -0.5, 1);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.updateGtaoMaterial({ radius: 2, distanceExponent: 1, thickness: 1.5, scale: 1.2 });
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass(1, 1));
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    const vHalf = (camera.fov / 2) * (Math.PI / 180);
    const fit = Math.max(rows * cell * 0.5, (cols * cell * 0.5) / camera.aspect) * 1.02;
    camera.position.copy(c).addScaledVector(dir.clone().normalize(), fit / Math.tan(vHalf));
    camera.lookAt(c);
    camera.near = 5;
    camera.far = 5000;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);
  sun.position.copy(c).add(new THREE.Vector3(r * 0.8, -r * 0.6, (under ? -1 : 1) * r * 2.5));
  sun.target.position.copy(c);
  Object.assign(sun.shadow.camera, { left: -r * 1.4, right: r * 1.4, top: r * 1.4, bottom: -r * 1.4, near: 1, far: r * 8 });
  sun.shadow.camera.updateProjectionMatrix();
  const v = new THREE.Vector3();
  const loop = () => {
    requestAnimationFrame(loop);
    composer.render();
    for (const l of labels) {
      v.copy(l.p).project(camera);
      l.el.style.left = `${((v.x + 1) / 2) * host.clientWidth}px`;
      l.el.style.top = `${((1 - v.y) / 2) * host.clientHeight}px`;
    }
  };
  loop();
  let tris = 0;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry || o.parent === scene) return;
    const n = m.geometry.index ? m.geometry.index.count / 3 : (m.geometry.getAttribute("position")?.count ?? 0) / 3;
    tris += n * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  extraStats = `\nhardware triangles in scene ${Math.round(tris).toLocaleString()}`;
  if (q.get("tris") === "1") {
    // Triangles per kind, front and back of a single placement.
    const hm = fittings.hardwareMesh as unknown as (kind: string, size: number, t: number, m: string) => THREE.Object3D;
    const per = KINDS.map((k) => {
      let n = 0;
      hm(k, SIZES[k] ?? 10, t, "brass").traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) n += (m.geometry.index?.count ?? 0) / 3;
      });
      return `${k} ${n}`;
    });
    extraStats += `\n${per.join("\n")}`;
  }
  document.title = "ready";
}

// ---------- a real bag ----------

async function bagScene(): Promise<void> {
  const { installDevMock } = await import("../devmock");
  await installDevMock();
  const store = await import("../store");
  const v3 = await import("../view3d");
  const { api } = await import("../api");
  v3.initView3d(host);
  const style = (q.get("style") ?? "tote") as Parameters<typeof api.bagDefaults>[0];
  const params = await api.bagDefaults(style);
  for (const key of ["carry", "closure", "edge", "stitch", "construction", "leather"] as const) {
    const val = q.get(key);
    if (val) (params as unknown as Record<string, unknown>)[key] = val;
  }
  if (q.get("feet")) params.feet = q.get("feet") === "1";
  if (q.get("pocket")) params.pocket = q.get("pocket") === "1";
  if (q.get("metal")) v3.sim3d.metal = q.get("metal") as typeof v3.sim3d.metal;
  const project = await api.makeBag(params);
  store.setProject(project, null);
  await store.whenComputed();
  await v3.rebuild();
  const frames = Number(q.get("frames") ?? 90);
  const t0 = performance.now();
  if (frames > 0) await v3.runFrames(frames);
  const simMs = performance.now() - t0;
  const info = v3.sim3d.info;
  const holes = info?.stitches.reduce((a, s) => a + s.holes.length, 0) ?? 0;
  extraStats = `\nstitch holes ${holes}, hardware ${info?.hardware.filter((h) => h.kind).length ?? 0} set + ${info?.hardware.filter((h) => !h.kind).length ?? 0} holes\nsim ${frames} frames ${simMs.toFixed(0)} ms`;
  // Aim the camera.
  const focus = q.get("focus");
  if (focus && !controls) extraStats += "\nno controls";
  if (focus && controls) {
    let target: THREE.Vector3 | null = null;
    const b = v3.bounds();
    if (focus.startsWith("hw:")) {
      const kind = focus.slice(3);
      const nth = Number(q.get("nth") ?? 0);
      const found: THREE.Vector3[] = [];
      const sceneRoot = findScene();
      sceneRoot?.traverse((o) => {
        const ud = o.userData as { hw?: { kind: string }; kind?: string; locations?: { kind: string; p: THREE.Vector3 }[] };
        if (ud.hw?.kind === kind && ud.kind === "set") found.push(o.getWorldPosition(new THREE.Vector3()));
        for (const l of ud.locations ?? []) if (l.kind === kind) found.push(l.p.clone());
      });
      target = found[nth] ?? found[0] ?? null;
    } else if (focus === "corner" && b) {
      target = new THREE.Vector3(b.min.x, b.min.y, b.max.z);
    } else if (focus === "bottom" && b) {
      target = new THREE.Vector3(b.min.x * 0.6, b.min.y * 0.6, b.min.z);
    } else {
      const xyz = focus.split(",").map(Number);
      if (xyz.length === 3 && xyz.every(Number.isFinite)) target = new THREE.Vector3(...xyz);
    }
    extraStats += `\nfocus ${focus}: ${target ? target.toArray().map((x) => x.toFixed(0)).join(",") : "not found"}`;
    if (target) {
      const dist = Number(q.get("dist") ?? 120);
      const d = (q.get("dir") ?? "0.45,-1,0.55").split(",").map(Number);
      const cam = controls.object as THREE.PerspectiveCamera;
      controls.target.copy(target);
      cam.position.copy(target).add(new THREE.Vector3(d[0], d[1], d[2]).normalize().multiplyScalar(dist));
      cam.near = Math.max(0.2, dist / 300);
      cam.updateProjectionMatrix();
      controls.update();
    }
  }
  document.title = "ready";
}

let rootScene: THREE.Scene | null = null;
const origRender = THREE.WebGLRenderer.prototype.render;
THREE.WebGLRenderer.prototype.render = function (this: THREE.WebGLRenderer, s: THREE.Object3D, c: THREE.Camera) {
  if (!rootScene && (s as THREE.Scene).isScene && this.domElement.parentElement?.id === "view3d") rootScene = s as THREE.Scene;
  return origRender.call(this, s, c);
};
function findScene(): THREE.Scene | null {
  return rootScene;
}

async function main(): Promise<void> {
  statLoop();
  const scene = q.get("scene") ?? "hardware";
  if (scene === "bag") return bagScene();
  if (scene === "kind") {
    const kind = q.get("kind") ?? "rivet-m";
    const size = SIZES[kind] ?? 10;
    return hardwareScene(METAL_LIST.map((m) => ({ kind, metal: m, label: `${kind} ${m}` })), 5, Math.max(16, size * 1.6));
  }
  const metal = q.get("metal") ?? "brass";
  return hardwareScene(KINDS.map((k) => ({ kind: k, metal, label: k })), 6, 62);
}

main().catch((e) => {
  statsEl.textContent = `error: ${e}`;
  document.title = "error";
  console.error(e);
});
