// Display preferences, remembered on this computer: Simple or All tools, interface size
// (85% to 200%), colour theme (leather, light, high contrast) and whether the welcome opens at
// start.
//
// The size is the CSS variable --ui-scale, applied with `zoom` to the chrome (app bar, ribbon,
// docks, status bar, window strips, navigation bars, menus and dialogs). The 3D and pattern
// canvases are not zoomed: they draw at the screen's own resolution.

import { notify, setStatus } from "./store";

export type Mode = "simple" | "full";
export type Theme = "leather" | "light" | "contrast";

const KEY = "hidework.prefs";
export const SCALE_MIN = 0.85;
export const SCALE_MAX = 2;
/** New users start in Simple mode at 100% (14 px text, already scaled by Windows display settings). */
const NEW_USER = { mode: "simple" as Mode, scale: 1, theme: "leather" as Theme, welcome: true };
/** Bumped when a default changes enough that saved settings from older versions should be reset. */
const PREFS_VERSION = 2;

export const prefs = { ...NEW_USER };

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...prefs, v: PREFS_VERSION }));
  } catch {
    /* storage unavailable */
  }
}

function apply(): void {
  const root = document.documentElement;
  root.dataset.mode = prefs.mode;
  root.dataset.theme = prefs.theme;
  root.style.setProperty("--ui-scale", String(prefs.scale));
  // Large sizes (150% and up) switch to more compact arrangements that keep everything on screen.
  root.dataset.big = String(prefs.scale >= 1.45);
  // The canvases measure their boxes on resize.
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

export function initPrefs(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<typeof prefs> & { v?: number };
      if (p.mode === "simple" || p.mode === "full") prefs.mode = p.mode;
      // Version 1 started everyone at 115%, which was far too big on scaled Windows displays.
      if ((p.v ?? 1) >= PREFS_VERSION && typeof p.scale === "number" && Number.isFinite(p.scale)) prefs.scale = clampScale(p.scale);
      if (p.theme === "leather" || p.theme === "light" || p.theme === "contrast") prefs.theme = p.theme;
      if (typeof p.welcome === "boolean") prefs.welcome = p.welcome;
    }
  } catch {
    /* storage unavailable or damaged: keep the defaults */
  }
  apply();
}

export function simple(): boolean {
  return prefs.mode === "simple";
}

/** A viewport position (px) converted for the style of a popup that is itself zoomed. */
export function unzoom(px: number): number {
  return px / prefs.scale;
}

function clampScale(s: number): number {
  return Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, s)) * 20) / 20;
}

export function setMode(m: Mode): void {
  prefs.mode = m;
  save();
  apply();
  setStatus(m === "simple" ? "Simple tools. Click \"Show all tools\" for the full ribbon." : "All tools are showing. Click \"Simple tools\" for the short row of big buttons.");
}

export function setScale(s: number): void {
  prefs.scale = clampScale(s);
  save();
  apply();
  setStatus(`Text and buttons at ${Math.round(prefs.scale * 100)}%. Ctrl and + makes them bigger, Ctrl and − smaller.`);
}

/** Whether "What would you like to make?" opens when Hidework starts. */
export function setWelcome(on: boolean): void {
  prefs.welcome = on;
  save();
}

export function setTheme(t: Theme): void {
  prefs.theme = t;
  save();
  apply();
  setStatus(t === "light" ? "Light colours." : t === "contrast" ? "High contrast colours." : "Leather colours.");
  notify();
}
