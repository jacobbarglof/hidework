// Simulation and 3D quality that fits the computer running Hidework.
//
// Three levels trade detail for speed: how fine the leather mesh is (the solver's cost grows with
// it), and how much the 3D view draws (pixel density, soft shadows, ambient occlusion,
// anti-aliasing). "Auto" starts from what the machine reports (processor threads, memory, and
// whether the graphics chip is real or a software fallback) and then watches how fast the
// simulation and the drawing actually run, stepping down a level when the machine cannot keep up.
// The level it settles on is remembered for the next start on this computer.

export type QualityId = "fast" | "balanced" | "detailed";
export type QualityPref = "auto" | QualityId;

export interface Quality {
  id: QualityId;
  name: string;
  /** Solver mesh resolution (SimSpec.resolution). */
  resolution: number;
  /** Most device pixels per CSS pixel the 3D view draws. */
  pixelRatio: number;
  shadows: boolean;
  shadowMap: number;
  occlusion: boolean;
  antialias: boolean;
}

export const LEVELS: Quality[] = [
  { id: "fast", name: "Fast", resolution: 300, pixelRatio: 1, shadows: false, shadowMap: 512, occlusion: false, antialias: false },
  { id: "balanced", name: "Balanced", resolution: 550, pixelRatio: 1.25, shadows: true, shadowMap: 1024, occlusion: false, antialias: true },
  { id: "detailed", name: "Detailed", resolution: 900, pixelRatio: 2, shadows: true, shadowMap: 2048, occlusion: true, antialias: true },
];

const PREF_KEY = "hidework.quality";
const LEARNED_KEY = "hidework.quality.learned";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

const isLevel = (v: string | null): v is QualityId => v === "fast" || v === "balanced" || v === "detailed";

let pref: QualityPref = ((): QualityPref => {
  const v = read(PREF_KEY);
  return v === "auto" || isLevel(v) ? v : "auto";
})();

/** What the machine says about itself, for the first guess and for Help. */
export function machine(): { threads: number; memoryGb: number | null; gpu: string; software: boolean } {
  const threads = navigator.hardwareConcurrency || 2;
  const memoryGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null;
  let gpu = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    gpu = (ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "") || "";
  } catch {
    /* no WebGL details */
  }
  const software = /swiftshader|llvmpipe|softpipe|microsoft basic render|software/i.test(gpu);
  return { threads, memoryGb, gpu, software };
}

/** First guess from the hardware alone. */
function guess(): QualityId {
  const m = machine();
  if (m.software || m.threads <= 4 || (m.memoryGb !== null && m.memoryGb <= 4)) return "fast";
  if (m.threads <= 8 || (m.memoryGb !== null && m.memoryGb <= 8)) return "balanced";
  return "detailed";
}

let autoLevel: QualityId = ((): QualityId => {
  const learned = read(LEARNED_KEY);
  const g = guess();
  // Never start above what the hardware suggests; start lower if this computer taught us to.
  if (isLevel(learned)) return LEVELS.findIndex((l) => l.id === learned) < LEVELS.findIndex((l) => l.id === g) ? learned : g;
  return g;
})();

export function qualityPref(): QualityPref {
  return pref;
}

export function quality(): Quality {
  const id = pref === "auto" ? autoLevel : pref;
  return LEVELS.find((l) => l.id === id) ?? LEVELS[1];
}

const listeners: ((q: Quality, rebuild: boolean) => void)[] = [];

/** Called when the level changes; `rebuild` says the simulation mesh must be rebuilt. */
export function onQualityChange(f: (q: Quality, rebuild: boolean) => void): void {
  listeners.push(f);
}

function changed(before: Quality): void {
  const q = quality();
  if (q.id === before.id) return;
  for (const f of listeners) f(q, q.resolution !== before.resolution);
}

export function setQualityPref(p: QualityPref): void {
  const before = quality();
  pref = p;
  write(PREF_KEY, p);
  changed(before);
}

// ---------- watching how fast it runs (Auto only) ----------

let windowStart = 0;
let simSeconds = 0;
let renderFrames = 0;
let slowWindows = 0;
let lastDrop = 0;

/** Report that `frames` simulation frames (1/90 s each) were computed. */
export function noteSim(frames: number): void {
  simSeconds += frames / 90;
}

/**
 * Called once per drawn frame while the simulation runs. Every two seconds it compares simulated
 * time with wall time and drawn frames with wall time; two slow windows in a row step Auto down.
 * Returns a message when it changed level.
 */
export function noteFrame(now: number, simulating: boolean): string | null {
  if (!simulating) {
    windowStart = 0;
    return null;
  }
  if (!windowStart) {
    windowStart = now;
    simSeconds = 0;
    renderFrames = 0;
    return null;
  }
  renderFrames++;
  const wall = (now - windowStart) / 1000;
  if (wall < 2) return null;
  const simSpeed = simSeconds / wall;
  const fps = renderFrames / wall;
  windowStart = now;
  simSeconds = 0;
  renderFrames = 0;
  const slow = simSpeed < 0.45 || fps < 20;
  slowWindows = slow ? slowWindows + 1 : 0;
  if (pref !== "auto" || slowWindows < 2 || now - lastDrop < 6000) return null;
  const i = LEVELS.findIndex((l) => l.id === autoLevel);
  if (i <= 0) return null;
  const before = quality();
  autoLevel = LEVELS[i - 1].id;
  write(LEARNED_KEY, autoLevel);
  slowWindows = 0;
  lastDrop = now;
  changed(before);
  return `This computer was running the 3D slowly (${Math.round(simSpeed * 100)}% speed, ${Math.round(fps)} frames a second), so it now uses ${quality().name} quality. View > Simulation quality changes it.`;
}

/** How many simulation frames to compute this drawn frame, to keep up with real time. */
export function framesFor(elapsedMs: number): number {
  return Math.max(1, Math.min(3, Math.round((elapsedMs / 1000) * 90)));
}
