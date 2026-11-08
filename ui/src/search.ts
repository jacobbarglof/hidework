// The S command box: a small search field at the mouse, like Fusion's S toolbox. It uses the
// command line's matching (commandline words, names and aliases); with nothing typed it lists
// the commands used last. Typing numbers after a word runs it with them ("rect 80 50").

import { COMMANDS, TABS, exactCommand, isEnabled, keyText, matchCommands, onRun, runCommand, wordOf, type Command } from "./commands";
import { openLine } from "./commandline";
import { h } from "./dom";
import { icon } from "./icons";
import { closeMenu } from "./menus";
import { unzoom } from "./prefs";
import { invoke } from "./tooldialog";

const RECENT_KEY = "hidework.recent";
const SHOW = 10;
/** Good first picks when nothing has been used yet. */
const STARTERS = ["rect", "polygon", "sew", "punch", "fold", "measure", "mirror", "simulate", "print", "pdf"];

let box: HTMLElement | null = null;
let input: HTMLInputElement;
let list: HTMLElement;
let hits: Command[] = [];
let pick = 0;
const mouse = { x: 0, y: 0, seen: false };
let recent: string[] = [];

function loadRecent(): void {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (Array.isArray(r)) recent = r.filter((x) => typeof x === "string").slice(0, 12);
  } catch {
    recent = [];
  }
}

function remember(c: Command): void {
  if (c.id === "search" || c.id === "cancel") return;
  recent = [c.id, ...recent.filter((x) => x !== c.id)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* storage unavailable */
  }
}

/** Commands used last, newest first (for the search box and the marking menu). */
export function recentCommands(): Command[] {
  const byId = new Map(COMMANDS.map((c) => [c.id, c]));
  return recent.map((id) => byId.get(id)).filter((c): c is Command => !!c);
}

const where = (c: Command) => {
  const ws = TABS.find((t) => t.id === c.tab)?.label ?? { file: "File", edit: "Edit", help: "Help" }[c.tab as string] ?? c.tab;
  return `${ws} › ${c.group}`;
};

function fill(): void {
  const q = input.value.trim();
  const word = q.split(/\s+/)[0] ?? "";
  if (!word) {
    const seen = new Set<string>();
    const base = [...recentCommands(), ...STARTERS.map((id) => COMMANDS.find((c) => c.id === id)).filter((c): c is Command => !!c)];
    hits = base.filter((c) => !seen.has(c.id) && seen.add(c.id)).slice(0, SHOW);
  } else {
    const exact = exactCommand(word);
    const m = matchCommands(word, SHOW + 4);
    // Recently used commands come first among equally good matches.
    const rank = (c: Command) => (c === exact ? -100 : 0) + (recent.includes(c.id) ? recent.indexOf(c.id) - 50 : 0);
    hits = m.map((c, i) => [c, rank(c) * 0.01 + i] as const).sort((a, b) => a[1] - b[1]).map(([c]) => c).slice(0, SHOW);
    if (exact && !hits.includes(exact)) hits.unshift(exact);
  }
  pick = Math.min(pick, Math.max(0, hits.length - 1));
  render(!word);
}

function render(showingRecent: boolean): void {
  const rows: Node[] = [];
  if (showingRecent) rows.push(h("div", { class: "sx-head" }, recent.length ? "Recent" : "Try"));
  hits.forEach((c, i) => {
    const row = h(
      "div",
      { class: `sx-row${i === pick ? " on" : ""}${isEnabled(c) ? "" : " off"}` },
      icon(c.icon, 16),
      h("span", { class: "sx-name" }, c.name),
      h("span", { class: "sx-where" }, where(c)),
      h("span", { class: "sx-key" }, keyText(c)),
    );
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("mouseenter", () => {
      pick = i;
      list.querySelectorAll(".sx-row").forEach((r, k) => r.classList.toggle("on", k === i));
      help();
    });
    row.addEventListener("click", () => choose(c));
    rows.push(row);
  });
  if (!hits.length) rows.push(h("div", { class: "sx-none" }, "No command by that name. F1 lists them all."));
  list.replaceChildren(...rows);
  help();
}

function help(): void {
  const c = hits[pick];
  const el = box?.querySelector(".sx-help");
  if (el) el.textContent = c ? `${c.help}${c.args ? `  Type: ${wordOf(c)} ${c.args}` : ""}` : "";
}

function choose(c: Command): void {
  const args = input.value.trim().split(/\s+/).slice(1).filter(Boolean);
  closeSearch();
  // A command that needs numbers and got none goes to the command line, ready for them.
  if (!args.length && c.args && !c.args.startsWith("[")) {
    openLine(`${wordOf(c)} `);
    return;
  }
  if (args.length) runCommand(c, args);
  else invoke(c);
}

export function searchOpen(): boolean {
  return !!box;
}

export function closeSearch(): void {
  box?.remove();
  box = null;
}

/** Open the command box at the mouse (or under `anchor`). */
export function showSearch(anchor?: HTMLElement): void {
  closeMenu();
  closeSearch();
  input = h("input", { class: "sx-input", type: "text", placeholder: "Search commands", spellcheck: false, autocomplete: "off", "aria-label": "Search commands" }) as HTMLInputElement;
  list = h("div", { class: "sx-list" });
  box = h("div", { class: "searchbox", role: "dialog", "aria-label": "Search commands" }, h("div", { class: "sx-top" }, glass(), input, h("span", { class: "kbd" }, "S")), list, h("div", { class: "sx-help" }));
  document.body.append(box);
  pick = 0;
  fill();
  const r = anchor?.getBoundingClientRect();
  const { width: w, height: hgt } = box.getBoundingClientRect();
  let x = r ? r.right - w : mouse.seen ? mouse.x - 30 : window.innerWidth / 2 - w / 2;
  let y = r ? r.bottom + 2 : mouse.seen ? mouse.y - 18 : 120;
  x = Math.max(6, Math.min(window.innerWidth - w - 6, x));
  y = Math.max(6, Math.min(window.innerHeight - hgt - 6, y));
  box.style.left = `${unzoom(x)}px`;
  box.style.top = `${unzoom(y)}px`;
  input.addEventListener("input", () => {
    pick = 0;
    fill();
  });
  input.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      if (hits.length) pick = (pick + (k === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      list.querySelectorAll(".sx-row").forEach((row, i) => row.classList.toggle("on", i === pick));
      list.querySelector(".sx-row.on")?.scrollIntoView({ block: "nearest" });
      help();
    } else if (k === "Enter") {
      e.preventDefault();
      const c = hits[pick];
      if (c) choose(c);
    } else if (k === "Escape") {
      e.preventDefault();
      closeSearch();
    } else if (k === "Tab") {
      e.preventDefault();
      const c = hits[pick];
      if (c) {
        input.value = `${wordOf(c)} `;
        fill();
      }
    }
    // Plain keys are typing, not shortcuts.
    if (!e.ctrlKey && !e.metaKey && !/^F\d+$/.test(k)) e.stopPropagation();
  });
  input.addEventListener("blur", () => window.setTimeout(() => { if (box && !box.contains(document.activeElement)) closeSearch(); }, 0));
  input.focus();
}

function glass(): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = '<svg class="sx-glass" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.3 10.3l4 4" stroke="currentColor" stroke-width="1.8"/></svg>';
  return wrap.firstChild as SVGSVGElement;
}

export function initSearch(): void {
  loadRecent();
  onRun(remember);
  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.seen = true;
  }, { passive: true });
  document.addEventListener("mousedown", (e) => {
    if (box && !box.contains(e.target as Node)) closeSearch();
  }, { capture: true });
  window.addEventListener("resize", closeSearch);
}
