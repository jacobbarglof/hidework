// Rhino-style command line in the status bar, and the keyboard router for the whole app.
//
// How typing is split between shortcuts and the command line:
// - With focus outside any text box, a key bound to a command (R, P, V, 0, Space, Ctrl+S, F2…)
//   runs it at once.
// - A letter that is not a shortcut, or "/", starts the command line with that letter.
// - A second letter within half a second of a single-letter shortcut, when the two letters begin
//   a command name ("re", "sa", "ex"), switches to the command line: the shortcut's tool change
//   (or edit) is undone and both letters go into the line. So "rectangle 80 50" types normally.
// - In the line: ↑/↓ choose a match (or walk history on an empty line), Tab completes, Enter runs,
//   Space runs a command that takes no arguments (or completes one that does), Esc cancels.
//   Enter on an empty line repeats the last command, as in Rhino.

import { cancelAll, setTool, toggleSim } from "./actions";
import { nudgeSelected } from "./editing";
import { comboOf, commandForKey, exactCommand, isCommandPrefix, keyText, lastCommand, matchCommands, onRun, restoreLast, runCommand, wordOf, type Command } from "./commands";
import { h } from "./dom";
import { icon } from "./icons";
import { prefs, unzoom } from "./prefs";
import { closeMenu } from "./menus";
import { hideTip } from "./ribbon";
import { notify, state, undo, version } from "./store";
import type { Tool } from "./store";
import { sim3d, type Tool3d } from "./view3d";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let input: HTMLInputElement;
let list: HTMLElement;
let matches: Command[] = [];
let pick = 0;
const history: string[] = [];
let hIndex = -1;
let pending: { key: string; at: number; tool: Tool; tool3d: Tool3d; version: number; last: ReturnType<typeof lastCommand> } | null = null;
const PENDING_MS = 550;

function modalOpen(): boolean {
  return !$("modal").classList.contains("hidden") || !$("fabric-test").classList.contains("hidden");
}

// ---------- the line ----------

/** Put text in the command line and focus it (the S box sends commands that need numbers here). */
export function openLine(text: string): void {
  hideTip();
  closeMenu();
  input.value = text;
  hIndex = -1;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  update();
}

function closeLine(): void {
  input.value = "";
  hIndex = -1;
  matches = [];
  list.classList.add("hidden");
  if (document.activeElement === input) input.blur();
  renderStatus();
}

function firstWord(): string {
  return input.value.trimStart().split(/\s+/)[0] ?? "";
}

/** The first word is finished (arguments are being typed). */
function hasArgs(): boolean {
  return /^\S+\s/.test(input.value.trimStart());
}

/** A text box, number box or list has focus (checkboxes and buttons don't count). */
function typingInField(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === input) return false;
  if (a.isContentEditable || a.tagName === "TEXTAREA" || a.tagName === "SELECT") return true;
  if (a.tagName !== "INPUT") return false;
  const t = (a as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "color", "file"].includes(t);
}

function update(): void {
  const v = input.value.trimStart();
  if (!v || hIndex >= 0 || /\s/.test(v)) {
    matches = [];
    list.classList.add("hidden");
  } else {
    matches = matchCommands(v);
    pick = 0;
    renderList();
  }
  renderStatus();
}

function renderList(): void {
  if (!matches.length) {
    list.classList.add("hidden");
    return;
  }
  list.replaceChildren(
    ...matches.map((c, i) => {
      const row = h(
        "div",
        { class: `cs-row${i === pick ? " on" : ""}` },
        icon(c.icon, 20),
        h("span", { class: "cs-word" }, wordOf(c)),
        h("span", { class: "cs-name" }, c.name !== wordOf(c) ? c.name : "", c.args ? h("i", {}, ` ${c.args}`) : null),
        keyText(c) ? h("span", { class: "kbd" }, keyText(c)) : h("span", {}),
      );
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => choose(c));
      return row;
    }),
  );
  list.classList.remove("hidden");
  const r = input.getBoundingClientRect();
  list.style.left = `${unzoom(Math.max(4, r.left - 4))}px`;
  list.style.bottom = `${unzoom(window.innerHeight - r.top + 4)}px`;
}

/** Pick a match: commands with arguments complete so the numbers can be typed; others run. */
function choose(c: Command): void {
  if (c.args && !c.args.startsWith("[")) {
    input.value = `${wordOf(c)} `;
    update();
    input.focus();
  } else execute(wordOf(c));
}

function execute(text: string): void {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const w = parts.shift();
  if (!w) return closeLine();
  const c = exactCommand(w) ?? (matches.length && firstWord() === w ? matches[pick] : undefined) ?? matchCommands(w, 1)[0];
  if (history[history.length - 1] !== text.trim()) history.push(text.trim());
  if (history.length > 60) history.shift();
  closeLine();
  if (!c) {
    state.status = `Unknown command: ${w}. Press F1 to see them all.`;
    renderStatus();
    return;
  }
  runCommand(c, parts);
}

function repeatLast(): void {
  const l = lastCommand();
  if (!l) {
    openLine("");
    return;
  }
  runCommand(l.cmd, l.args);
}

function onInputKey(e: KeyboardEvent): void {
  const k = e.key;
  if (e.ctrlKey || e.metaKey || /^F\d+$/.test(k)) return; // the global handler decides
  e.stopPropagation();
  if (k === "Enter") {
    e.preventDefault();
    if (!input.value.trim()) {
      closeLine();
      if (prefs.mode !== "simple") repeatLast();
    } else execute(input.value);
  } else if (k === "Escape") {
    e.preventDefault();
    closeLine();
  } else if (k === "Tab") {
    e.preventDefault();
    const c = matches[pick] ?? exactCommand(firstWord());
    if (c) {
      input.value = `${wordOf(c)}${c.args ? " " : ""}`;
      update();
    }
  } else if (k === "ArrowDown" || k === "ArrowUp") {
    e.preventDefault();
    const d = k === "ArrowDown" ? 1 : -1;
    if (matches.length && hIndex < 0) {
      pick = (pick + d + matches.length) % matches.length;
      renderList();
      renderStatus();
    } else if (history.length) {
      // History: up goes back, down comes forward.
      hIndex = hIndex < 0 ? (d < 0 ? history.length - 1 : -1) : hIndex - d;
      if (hIndex >= history.length || hIndex < 0) {
        hIndex = -1;
        input.value = "";
      } else input.value = history[hIndex];
      matches = [];
      list.classList.add("hidden");
      renderStatus();
    }
  } else if (k === " ") {
    const v = input.value;
    if (!v.trim()) {
      e.preventDefault();
      closeLine();
      toggleSim();
      return;
    }
    if (/\s/.test(v.trim())) return; // already typing arguments
    const c = exactCommand(v.trim()) ?? matches[pick];
    if (!c) return;
    e.preventDefault();
    if (c.args) {
      input.value = `${wordOf(c)} `;
      update();
    } else execute(wordOf(c));
  } else if (k === "Backspace" && !input.value) {
    e.preventDefault();
    closeLine();
  }
}

// ---------- status ----------

/** The change the status bar's Undo button takes back (its version), while nothing else changed. */
let undoAt = -1;

/** Say what just changed, with an Undo button beside the message until the next change. */
export function offerUndo(text: string): void {
  undoAt = version;
  state.status = text;
  notify();
}

/** The text right of the prompt: what the command being typed wants, or the app status. */
export function renderStatus(): void {
  const el = $("status");
  const typing = document.activeElement === input && input.value.trim();
  let text = state.status;
  if (typing) {
    const c = hasArgs() ? exactCommand(firstWord()) : matches[pick] ?? exactCommand(firstWord());
    if (!c) text = `No command starts with "${firstWord()}". F1 lists them all.`;
    else if (hasArgs()) text = `${c.name}${c.args ? ` ${c.args}` : ""}. Enter to run, Esc to cancel.`;
    else text = `${c.name}${c.args ? ` ${c.args}` : ""}: ${c.help}  (Enter runs, Tab completes)`;
  } else if (document.activeElement === input) text = "Type a command (F1 lists them). Enter repeats the last one; Esc cancels.";
  el.classList.toggle("prompt", !!typing || document.activeElement === input);
  if (el.textContent !== text) el.textContent = text;
  $("status-undo").classList.toggle("hidden", !!typing || undoAt !== version || undoAt < 0);
}

// ---------- keyboard router ----------

const FILE_COMBOS = new Set(["ctrl+s", "ctrl+shift+s", "ctrl+o", "ctrl+n", "ctrl+p"]);
const TEXT_EDIT = /^ctrl\+(shift\+)?[acvxzy]$/;

function onKey(e: KeyboardEvent): void {
  if (e.isComposing || e.repeat && /^[a-z]$/i.test(e.key)) return;
  const combo = comboOf(e);
  const fn = /^f\d+$/.test(combo.split("+").pop() ?? "");
  const mod = e.ctrlKey || e.metaKey;
  const inLine = document.activeElement === input;
  if (!inLine && typingInField()) {
    // A field elsewhere has focus: only file shortcuts and function keys.
    if (FILE_COMBOS.has(combo) || fn) {
      const c = commandForKey(combo);
      if (c) {
        e.preventDefault();
        runCommand(c);
      }
    }
    return;
  }
  if (inLine) {
    if (!mod && !fn) return;
    if (input.value && TEXT_EDIT.test(combo)) return;
  }
  if (combo === "escape") {
    e.preventDefault();
    pending = null;
    if (closeMenu()) return;
    if (modalOpen() && !$("modal").classList.contains("hidden")) {
      $("modal").classList.add("hidden");
      return;
    }
    cancelAll();
    return;
  }
  // Space and Enter press a button (or open More options) that has keyboard focus.
  const focused = document.activeElement as HTMLElement | null;
  if ((combo === "space" || combo === "enter") && focused && (focused.tagName === "BUTTON" || focused.tagName === "SUMMARY" || focused.tagName === "A")) return;
  // With a dialog open, plain keys belong to it.
  if (modalOpen() && !mod && !fn) return;
  const arrows: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  const bare = combo.replace(/^shift\+/, "");
  if (!mod && !e.altKey && arrows[bare]) {
    const [dx, dy] = arrows[bare];
    const step = e.shiftKey ? 10 : 1;
    e.preventDefault();
    nudgeSelected(dx * step, dy * step);
    return;
  }
  const letter = !mod && !e.altKey && e.key.length === 1 && /[a-z]/i.test(e.key);
  // Simple mode has no single-key shortcuts and nothing that depends on timing: a typed letter
  // starts the command line, other plain characters do nothing, Enter does not repeat.
  if (prefs.mode === "simple" && !mod && !e.altKey && (e.key.length === 1 && e.key !== " " || combo === "enter")) {
    pending = null;
    if (letter) {
      e.preventDefault();
      openLine(e.key);
    }
    return;
  }
  if (combo === "enter") {
    e.preventDefault();
    repeatLast();
    return;
  }
  if (letter && pending && performance.now() - pending.at < PENDING_MS && isCommandPrefix(pending.key + e.key)) {
    // Typing a word, not two shortcuts: undo the first one and move both letters to the line.
    e.preventDefault();
    const p = pending;
    pending = null;
    if (version !== p.version) undo();
    if (state.tool !== p.tool) setTool(p.tool);
    sim3d.tool = p.tool3d;
    restoreLast(p.last);
    openLine(p.key + e.key);
    return;
  }
  const c = commandForKey(combo);
  if (c) {
    e.preventDefault();
    pending = letter ? { key: e.key, at: performance.now(), tool: state.tool, tool3d: sim3d.tool, version, last: lastCommand() } : null;
    runCommand(c);
    return;
  }
  pending = null;
  if (letter || e.key === "/") {
    e.preventDefault();
    openLine(letter ? e.key : "");
  }
}

export function initCommandLine(): void {
  input = $<HTMLInputElement>("cmd");
  list = $("cmd-suggest");
  input.addEventListener("keydown", onInputKey);
  input.addEventListener("input", () => {
    hIndex = -1;
    update();
  });
  input.addEventListener("focus", () => {
    hideTip();
    renderStatus();
  });
  // Clicking away cancels what was typed.
  input.addEventListener("blur", () => {
    input.value = "";
    matches = [];
    list.classList.add("hidden");
    renderStatus();
  });
  window.addEventListener("keydown", onKey);
  // A command run from the ribbon or a shortcut replaces whatever was being typed.
  onRun(() => { if (input.value || document.activeElement === input) closeLine(); });
  window.addEventListener("mousedown", () => (pending = null), { capture: true });
  window.addEventListener("resize", () => list.classList.add("hidden"));
  const undoBtn = $("status-undo");
  undoBtn.addEventListener("mousedown", (e) => e.preventDefault());
  undoBtn.addEventListener("click", () => {
    undoAt = -1;
    undo();
    state.status = "Undone. It is back as it was.";
    notify();
  });
  $("cmd-prompt").addEventListener("mousedown", (e) => {
    e.preventDefault();
    openLine(input.value);
  });
}
