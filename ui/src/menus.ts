// Dense dropdown menus for the whole chrome: the menu bar (File, Edit, View, Help), the toolbar
// group lists, the workspace switcher and the marking menu's overflow list.
//
// Rows are about 26 px: icon, name, shortcut on the right, a pin or a submenu arrow. The line
// under the list says what the row under the mouse (or the keyboard) does.
// Keys: Up and Down move, Right opens a submenu (or the next menu bar menu), Left closes it (or
// the previous one), Enter or Space runs, Esc closes, a letter jumps to the next row starting
// with it.

import { isEnabled, keyText, type Command } from "./commands";
import { h } from "./dom";
import { icon } from "./icons";
import { unzoom } from "./prefs";
import { invoke } from "./tooldialog";

/** A row that is not a command: a submenu, a choice, or something to run. */
export interface Entry {
  label: string;
  icon?: string;
  keys?: string;
  help?: string;
  run?(): void;
  /** Ticked (a choice that is on). */
  checked?(): boolean;
  enabled?(): boolean;
  sub?(): MenuItem[];
}

/** A command row with a pin that puts it on (or takes it off) the toolbar. */
export interface Pinnable {
  cmd: Command;
  pinned(): boolean;
  toggle(): void;
}

/** A command whose value is set right in the menu (grid size, paper, units). */
export interface FieldRow {
  field: Command;
}

export type MenuItem = "-" | Command | Entry | Pinnable | FieldRow | { heading: string };

export interface MenuOptions {
  /** Open above the anchor (navigation bars at the bottom). */
  above?: boolean;
  /** Open at a point instead of under an anchor. */
  at?: { x: number; y: number };
  /** The menu bar buttons, so Left and Right move between their menus. */
  bar?: { buttons: HTMLElement[]; open(b: HTMLElement): void };
  /** Called once the menu closes. */
  onClose?(): void;
}

interface Level {
  el: HTMLElement;
  items: MenuItem[];
  rows: (HTMLElement | null)[];
  active: number;
  help: HTMLElement;
}

const levels: Level[] = [];
let anchorEl: HTMLElement | null = null;
let options: MenuOptions = {};
let subTimer: number | undefined;

const isCmd = (i: MenuItem): i is Command => typeof i === "object" && "run" in i && "id" in i && "tab" in i;
const isPin = (i: MenuItem): i is Pinnable => typeof i === "object" && "cmd" in i;
const isField = (i: MenuItem): i is FieldRow => typeof i === "object" && "field" in i;
const isHeading = (i: MenuItem): i is { heading: string } => typeof i === "object" && "heading" in i;

function cmdOf(i: MenuItem): Command | null {
  if (i === "-" || isHeading(i)) return null;
  if (isCmd(i)) return i;
  if (isPin(i)) return i.cmd;
  if (isField(i)) return i.field;
  return null;
}

function enabled(i: MenuItem): boolean {
  if (i === "-" || isHeading(i)) return false;
  const c = cmdOf(i);
  if (c) return isEnabled(c);
  return (i as Entry).enabled?.() ?? true;
}

function helpOf(i: MenuItem): string {
  const c = cmdOf(i);
  if (c) return isEnabled(c) ? c.help : `${c.help} Not available for the current selection.`;
  if (i === "-" || isHeading(i)) return "";
  return (i as Entry).help ?? "";
}

function hasSub(i: MenuItem): boolean {
  return typeof i === "object" && !isCmd(i) && !isPin(i) && !isField(i) && !isHeading(i) && !!(i as Entry).sub;
}

export function menuOpen(): boolean {
  return levels.length > 0;
}

export function menuAnchor(): HTMLElement | null {
  return anchorEl;
}

/** Close every open menu. True when one was open. */
export function closeMenu(): boolean {
  const was = levels.length > 0;
  window.clearTimeout(subTimer);
  while (levels.length) levels.pop()!.el.remove();
  document.querySelectorAll(".menu-open").forEach((b) => b.classList.remove("menu-open"));
  anchorEl = null;
  const done = options.onClose;
  options = {};
  if (was) done?.();
  return was;
}

function closeFrom(depth: number): void {
  window.clearTimeout(subTimer);
  while (levels.length > depth) levels.pop()!.el.remove();
}

/** Open a menu under (or above) `anchor`; clicking the same anchor again closes it. */
export function openMenu(anchor: HTMLElement | null, items: MenuItem[], opts: MenuOptions = {}): void {
  if (anchor && anchorEl === anchor && levels.length) {
    closeMenu();
    return;
  }
  closeMenu();
  anchorEl = anchor;
  options = opts;
  anchor?.classList.add("menu-open");
  const lv = buildLevel(items, 0);
  if (opts.at) place(lv.el, { left: opts.at.x, right: opts.at.x, top: opts.at.y, bottom: opts.at.y }, "below");
  else if (anchor) place(lv.el, anchor.getBoundingClientRect(), opts.above ? "above" : "below");
}

function place(el: HTMLElement, r: { left: number; right: number; top: number; bottom: number }, how: "below" | "above" | "right"): void {
  const { width: w, height: hgt } = el.getBoundingClientRect();
  let left = how === "right" ? r.right - 2 : r.left;
  if (left + w > window.innerWidth - 4) left = how === "right" ? r.left - w + 2 : window.innerWidth - w - 4;
  let top = how === "above" ? r.top - hgt - 2 : how === "right" ? r.top - 3 : r.bottom + 1;
  if (top + hgt > window.innerHeight - 4) top = window.innerHeight - hgt - 4;
  el.style.left = `${unzoom(Math.max(4, left))}px`;
  el.style.top = `${unzoom(Math.max(4, top))}px`;
}

function buildLevel(items: MenuItem[], depth: number): Level {
  const el = h("div", { class: "menu dense", role: "menu" });
  const help = h("div", { class: "menu-help" });
  const lv: Level = { el, items, rows: [], active: -1, help };
  items.forEach((it, i) => {
    const row = rowFor(it, lv, i, depth);
    lv.rows.push(row);
    el.append(row ?? h("div", { class: "menu-sep" }));
  });
  if (items.some((i) => helpOf(i))) el.append(help);
  el.addEventListener("mousedown", (e) => e.preventDefault());
  document.body.append(el);
  levels.push(lv);
  return lv;
}

function rowFor(it: MenuItem, lv: Level, i: number, depth: number): HTMLElement | null {
  if (it === "-") return null;
  if (isHeading(it)) {
    const head = h("div", { class: "menu-head" }, it.heading);
    return head;
  }
  const c = cmdOf(it);
  const on = c ? c.active?.() ?? false : (it as Entry).checked?.() ?? false;
  const off = !enabled(it);
  const iconName = c ? c.icon : (it as Entry).icon;
  const name = c ? c.name : (it as Entry).label;
  const keys = c ? keyText(c) : (it as Entry).keys ?? "";
  const tail: Node[] = [];
  if (isField(it)) tail.push(fieldInput(it.field));
  else tail.push(h("span", { class: "mi-key" }, keys));
  if (hasSub(it)) tail.push(h("span", { class: "mi-end mi-arrow" }, "▸"));
  else if (isPin(it)) {
    const pin = h("span", { class: `mi-end mi-pin${it.pinned() ? " pinned" : ""}`, title: it.pinned() ? "Take off the toolbar" : "Pin to the toolbar" }, pinGlyph());
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      it.toggle();
      pin.classList.toggle("pinned", it.pinned());
      pin.title = it.pinned() ? "Take off the toolbar" : "Pin to the toolbar";
    });
    tail.push(pin);
  } else tail.push(h("span", { class: "mi-end" }));
  const row = h(
    "div",
    { class: `mi${on ? " on" : ""}${off ? " off" : ""}${isField(it) ? " field" : ""}`, role: "menuitem", "aria-disabled": off ? "true" : undefined },
    h("span", { class: "mi-ico" }, iconName ? icon(iconName, 16) : on ? h("span", { class: "mi-tick" }, "✓") : null),
    h("span", { class: "mi-name" }, name),
    ...tail,
  );
  row.addEventListener("mouseenter", () => {
    setActive(lv, i);
    window.clearTimeout(subTimer);
    const d = levels.indexOf(lv);
    if (hasSub(it)) subTimer = window.setTimeout(() => openSub(lv, i), 140);
    else if (d >= 0) subTimer = window.setTimeout(() => closeFrom(d + 1), 220);
  });
  row.addEventListener("click", () => activate(lv, i));
  void depth;
  return row;
}

function pinGlyph(): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5.5 1.5h5v1.6l-1 .6v3.2l2.2 2.2v1.2H4.3V9.1l2.2-2.2V3.7l-1-.6zM8 10.3v4.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  return wrap.firstChild as SVGSVGElement;
}

function fieldInput(c: Command): HTMLElement {
  const f = c.field!;
  let input: HTMLInputElement | HTMLSelectElement;
  if (f.kind === "select") {
    const s = h("select", { class: "mi-input", "aria-label": c.name });
    for (const [v, t] of f.options ?? []) s.append(h("option", { value: v, selected: String(f.get()) === v }, t));
    s.addEventListener("change", () => f.set(s.value));
    input = s;
  } else {
    const i = h("input", { class: "mi-input", type: f.kind === "range" ? "range" : "number", "aria-label": c.name, value: String(f.get()), min: f.min !== undefined ? String(f.min) : undefined, max: f.max !== undefined ? String(f.max) : undefined, step: f.step !== undefined ? String(f.step) : undefined }) as HTMLInputElement;
    i.addEventListener("change", () => f.set(i.value));
    input = i;
  }
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key === "Enter") input.blur();
    if (e.key !== "Escape" && e.key !== "ArrowUp" && e.key !== "ArrowDown") e.stopPropagation();
  });
  return h("span", { class: "mi-field" }, input, f.unit && f.kind !== "range" ? h("span", { class: "mi-unit" }, f.unit) : null);
}

function setActive(lv: Level, i: number): void {
  if (lv.active >= 0) lv.rows[lv.active]?.classList.remove("hot");
  lv.active = i;
  const row = lv.rows[i];
  if (!row) return;
  row.classList.add("hot");
  row.scrollIntoView({ block: "nearest" });
  lv.help.textContent = helpOf(lv.items[i]);
}

function openSub(lv: Level, i: number): void {
  const d = levels.indexOf(lv);
  if (d < 0) return;
  closeFrom(d + 1);
  const it = lv.items[i] as Entry;
  if (!it.sub || !enabled(it)) return;
  const sub = buildLevel(it.sub(), d + 1);
  place(sub.el, lv.rows[i]!.getBoundingClientRect(), "right");
}

function activate(lv: Level, i: number): void {
  const it = lv.items[i];
  if (!it || it === "-" || isHeading(it) || isField(it)) return;
  if (hasSub(it)) {
    openSub(lv, i);
    const sub = levels[levels.indexOf(lv) + 1];
    if (sub) move(sub, 1);
    return;
  }
  if (!enabled(it)) return;
  const c = cmdOf(it);
  closeMenu();
  if (c) invoke(c);
  else (it as Entry).run?.();
}

function move(lv: Level, d: number): void {
  const n = lv.items.length;
  let i = lv.active;
  for (let k = 0; k < n; k++) {
    i = (i + d + n) % n;
    const it = lv.items[i];
    if (it !== "-" && !isHeading(it) && enabled(it)) return setActive(lv, i);
  }
}

function onKey(e: KeyboardEvent): void {
  if (!levels.length) return;
  const t = e.target instanceof HTMLElement ? e.target : null;
  // A field inside a menu keeps its own typing.
  if (t && t.closest(".menu") && (t.tagName === "INPUT" || t.tagName === "SELECT") && e.key !== "Escape") return;
  const lv = levels[levels.length - 1];
  const k = e.key;
  let handled = true;
  if (k === "ArrowDown") move(lv, 1);
  else if (k === "ArrowUp") move(lv, -1);
  else if (k === "ArrowRight") {
    const it = lv.items[lv.active];
    if (it && hasSub(it)) {
      openSub(lv, lv.active);
      move(levels[levels.length - 1], 1);
    } else if (options.bar) step(1);
  } else if (k === "ArrowLeft") {
    if (levels.length > 1) closeFrom(levels.length - 1);
    else if (options.bar) step(-1);
  } else if (k === "Enter" || k === " ") {
    if (lv.active >= 0) activate(lv, lv.active);
  } else if (k === "Escape") {
    if (levels.length > 1) closeFrom(levels.length - 1);
    else closeMenu();
  } else if (k === "Tab") closeMenu();
  else if (k.length === 1 && /[a-z0-9]/i.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const n = lv.items.length;
    for (let s = 1; s <= n; s++) {
      const i = (lv.active + s + n) % n;
      const it = lv.items[i];
      const c = cmdOf(it);
      const name = c ? c.name : it !== "-" && !isHeading(it) ? (it as Entry).label : "";
      if (name && name[0].toLowerCase() === k.toLowerCase() && enabled(it)) {
        setActive(lv, i);
        break;
      }
    }
  } else if (e.ctrlKey || e.metaKey || /^F\d+$/.test(k)) {
    // Ctrl shortcuts and function keys still work; the menu gives way.
    closeMenu();
    handled = false;
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

function step(d: number): void {
  const bar = options.bar!;
  const i = bar.buttons.indexOf(anchorEl!);
  const next = bar.buttons[(i + d + bar.buttons.length) % bar.buttons.length];
  closeMenu();
  bar.open(next);
  if (levels[0]) move(levels[0], 1);
}

/** Start keyboard navigation in the open menu (after opening it from the keyboard). */
export function focusFirst(): void {
  if (levels[0]) move(levels[0], 1);
}

export function initMenus(): void {
  window.addEventListener("keydown", onKey, { capture: true });
  document.addEventListener(
    "mousedown",
    (e) => {
      const t = e.target as HTMLElement;
      if (!levels.length) return;
      if (t.closest(".menu") || (anchorEl && anchorEl.contains(t))) return;
      closeMenu();
    },
    { capture: true },
  );
  window.addEventListener("blur", () => closeMenu());
  window.addEventListener("resize", () => closeMenu());
}
