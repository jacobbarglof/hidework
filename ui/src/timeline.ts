// History timeline along the bottom (full tools only): every undo step as a small chip, oldest
// on the left, then the steps that Redo would bring back, greyed. Click a chip to go back (or
// forward) to just after that step; click the start marker to undo everything.

import { COMMANDS, runningCommand } from "./commands";
import { h } from "./dom";
import { icon } from "./icons";
import { prefs } from "./prefs";
import { history, notify, redo, setStatus, state, undo } from "./store";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Words for an edit made with the mouse, by tool. */
const TOOL_WORDS: Record<string, string> = { hole: "Punch hole", fold: "Fold line", join: "Sew", rect: "Rectangle", polygon: "Polygon", hardware: "Set hardware", mark: "Surface work", tooling: "Tooling", measure: "Measure" };
const SEL_WORDS: Record<string, string> = { piece: "Move piece", vertex: "Move point", edge: "Change edge", hole: "Move hole", fold: "Move fold", hardware: "Move hardware", mark: "Move mark", tooling: "Move tooling", join: "Change seam", material: "Change leather" };

function nameStep(): string {
  const c = runningCommand();
  if (c) return c.name;
  const a = document.activeElement;
  if (a && a.closest("#inspector, #browser, .tooldlg")) return SEL_WORDS[state.sel.kind]?.replace(/^Move /, "Change ") ?? "Change";
  if (state.tool !== "select") return TOOL_WORDS[state.tool] ?? "Change";
  return SEL_WORDS[state.sel.kind] ?? "Change";
}

const ICON_FOR: Record<string, string> = {};
function iconFor(label: string): string {
  if (!Object.keys(ICON_FOR).length) {
    for (const c of COMMANDS) ICON_FOR[c.name] = c.icon;
    Object.assign(ICON_FOR, { "Move piece": "move", "Move point": "select", "Change edge": "edge", "Move hole": "punch", "Move fold": "fold", "Move hardware": "hardware", "Move mark": "stamp", "Move tooling": "swivelknife", "Change seam": "sew", "Change leather": "fabric", "Change piece": "select" });
  }
  return ICON_FOR[label] ?? "select";
}

let drawn = "";

/** Go to just after step `n` (0 = before every change). */
function goTo(n: number): void {
  let guard = 400;
  while (history.undo.length > n && guard--) undo();
  while (history.undo.length < n && history.redo.length && guard--) redo();
  setStatus(n === 0 ? "Back to the start. Redo (Ctrl+Y) or the timeline brings the changes back." : `Back to step ${n}: ${history.undo[n - 1] ?? ""}. Click a later step to go forward.`);
}

export function renderTimeline(): void {
  const el = $("timeline");
  if (!el) return;
  if (prefs.mode !== "full") return;
  const key = `${history.undo.join("|")}#${history.redo.join("|")}`;
  if (key === drawn) return;
  drawn = key;
  const chip = (label: string, n: number, cls: string) => {
    const b = h("button", { type: "button", class: `tl-chip ${cls}`, title: `${n}. ${label}. Click to go back to just after this step.` }, icon(iconFor(label), 13), h("span", {}, label));
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => goTo(n));
    return b;
  };
  const done = history.undo.map((l, i) => chip(l, i + 1, i === history.undo.length - 1 ? "now" : ""));
  // Redo steps come back in reverse order of the stack.
  const ahead = [...history.redo].reverse().map((l, i) => chip(l, history.undo.length + i + 1, "ahead"));
  const start = h("button", { type: "button", class: `tl-start${history.undo.length ? "" : " now"}`, title: "The start: before every change since this project was opened." }, "▕◀");
  start.addEventListener("mousedown", (e) => e.preventDefault());
  start.addEventListener("click", () => goTo(0));
  const empty = !done.length && !ahead.length ? [h("span", { class: "tl-empty" }, "Your changes show here. Click one to go back to it.")] : [];
  const track = h("div", { class: "tl-track" }, start, ...done, h("span", { class: "tl-marker", title: "You are here" }), ...ahead, ...empty);
  el.replaceChildren(h("span", { class: "tl-label" }, "History"), track);
  // Keep the newest step in view.
  requestAnimationFrame(() => {
    const now = track.querySelector(".tl-marker") as HTMLElement | null;
    if (now) track.scrollLeft = Math.max(0, now.offsetLeft - track.clientWidth + 60);
  });
}

export function initTimeline(): void {
  history.label = nameStep;
  const el = $("timeline");
  el?.addEventListener("wheel", (e) => {
    const t = el.querySelector(".tl-track") as HTMLElement | null;
    if (t && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      t.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
  notify();
}
