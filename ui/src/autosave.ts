// Autosave: once a minute (and when the window is hidden), a project that has changed is written
// to a recovery file in the app's data folder (the `autosave_path` command), or to this computer's
// browser storage if that is not available. On the next start the welcome screen offers "Pick up
// where you left off".

import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { app } from "./actions";
import { setProject, setStatus, state, version } from "./store";
import type { Project } from "./types";

const META = "hidework.recovery";
const LOCAL = "hidework.recovery.project";
const EVERY_MS = 60_000;

export interface Recovery {
  name: string;
  /** When it was written (ms since 1970). */
  at: number;
  /** "file": the recovery file; "local": browser storage; "saved": the user's own saved file. */
  where: "file" | "local" | "saved";
  /** The project's own file, if it has been saved. */
  filePath: string | null;
  pieces: number;
}

let path: string | null = null;
let lastVersion = -1;

function readMeta(): Recovery | null {
  try {
    const m = JSON.parse(localStorage.getItem(META) ?? "null") as Recovery | null;
    return m && typeof m.at === "number" && m.pieces > 0 ? m : null;
  } catch {
    return null;
  }
}

function writeMeta(m: Recovery): void {
  try {
    localStorage.setItem(META, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}

/** What "Pick up where you left off" would open, or null. Read at start, before anything changes. */
let found: Recovery | null = null;
export function recovery(): Recovery | null {
  return found;
}

/** Once something else has been opened, last time's work is no longer "where you left off". */
export function forgetRecovery(): void {
  found = null;
}

async function tick(): Promise<void> {
  if (!state.project || version === lastVersion) return;
  lastVersion = version;
  // An untouched template is not worth offering back.
  if (!state.dirty && !state.filePath) return;
  const base = { name: state.project.name, at: Date.now(), filePath: state.filePath, pieces: state.project.pieces.length };
  if (!state.dirty && state.filePath) {
    writeMeta({ ...base, where: "saved" });
    return;
  }
  const snapshot: Project = JSON.parse(JSON.stringify(state.project));
  if (path) {
    try {
      await api.save(snapshot, path);
      writeMeta({ ...base, where: "file" });
      return;
    } catch {
      /* fall through to browser storage */
    }
  }
  try {
    localStorage.setItem(LOCAL, JSON.stringify(snapshot));
    writeMeta({ ...base, where: "local" });
  } catch {
    /* nowhere to keep it */
  }
}

export async function initAutosave(): Promise<void> {
  found = readMeta();
  path = await invoke<string | null>("autosave_path").catch(() => null);
  lastVersion = version;
  window.setInterval(() => void tick(), EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void tick();
  });
}

/** Open what was being worked on last time. */
export async function restore(): Promise<boolean> {
  const m = found;
  if (!m) return false;
  found = null;
  try {
    let p: Project;
    if (m.where === "saved" && m.filePath) p = await api.load(m.filePath);
    else if (m.where === "file" && path) p = await api.load(path);
    else p = JSON.parse(localStorage.getItem(LOCAL) ?? "null") as Project;
    if (!p) throw new Error("nothing was kept");
    setProject(p, m.filePath);
    // A recovered copy may hold changes the saved file does not have yet.
    if (m.where !== "saved") state.dirty = true;
    app.firstFit = true;
    lastVersion = version;
    setStatus(m.where === "saved" ? `Opened ${m.name}, as you last saved it.` : `Here is ${m.name} as it was ${when(m.at)}. Click Save to keep it.`);
    return true;
  } catch (e) {
    setStatus(`Could not bring back ${m.name}: ${e}. Choose what to make instead.`);
    return false;
  }
}

/** "today at 3:42 pm", "yesterday at 9:05 am", "on Tuesday 4 November at 10:15 am". */
export function when(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `today at ${time}`;
  if (diff === 1) return `yesterday at ${time}`;
  return `on ${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} at ${time}`;
}
