// Right-click marking menu, as in Fusion: up to eight commands in a ring around the mouse for
// what is under it (a piece, several pieces, an edge, a corner, a hole, a fold, hardware, empty
// paper, the 3D leather or empty 3D space), with a short list of more below. Move the mouse
// toward a command and click anywhere in that direction, or click it directly. Esc or a click in
// the middle closes it. A right-drag still pans (2D) or orbits (3D); only a still right-click
// opens the menu. Simple mode gets a plain list of a few commands instead.

import { COMMANDS, isEnabled, keyText, label, lastCommand, runCommand, type Command } from "./commands";
import { selectAt } from "./canvas";
import { h } from "./dom";
import { icon } from "./icons";
import { closeMenu, openMenu, type MenuItem } from "./menus";
import { hideTip } from "./ribbon";
import { prefs, unzoom } from "./prefs";
import { closeSearch } from "./search";
import { invoke } from "./tooldialog";
import { leatherAt } from "./view3d";

type Ctx = "piece" | "multi" | "edge" | "vertex" | "hole" | "fold" | "hardware" | "none" | "leather" | "space3d";

const MENUS: Record<Ctx, { title: string; ring: string[]; more: string[] }> = {
  piece: { title: "Piece", ring: ["mirror", "rotate", "duplicate", "delete", "sew", "punch", "fold", "size"], more: ["flip", "merge", "copy", "cut", "hardware", "mark", "stitchtype", "edgefinish", "nudge", "check"] },
  multi: { title: "Pieces", ring: ["align", "distribute", "merge", "duplicate", "delete", "mirror", "rotate", "copy"], more: ["align-left", "align-centre", "align-right", "align-top", "align-middle", "align-bottom", "distribute-y", "flip", "cut"] },
  edge: { title: "Edge", ring: ["sew", "dart", "fold", "punch", "measure", "stitchtype", "seams", "delete"], more: ["edgefinish", "mirror", "rotate", "duplicate"] },
  vertex: { title: "Corner", ring: ["round", "delete", "measure", "nudge"], more: ["select", "cancel"] },
  hole: { title: "Hole", ring: ["delete", "punch", "measure", "hardware"], more: ["select", "cancel"] },
  fold: { title: "Fold", ring: ["delete", "folddir", "fold", "measure"], more: ["foldangle", "select"] },
  hardware: { title: "Hardware", ring: ["delete", "hardware", "measure", "simulate"], more: ["metal", "select"] },
  none: { title: "Pattern", ring: ["rect", "polygon", "paste", "selectall", "fit", "measure", "undo", "redo"], more: ["roundrect", "strap", "bag", "import", "snap", "zoomin", "zoomout", "showboth", "search"] },
  leather: { title: "Leather", ring: ["pin", "weight", "pull", "object", "simulate", "reset", "stress", "stitches"], more: ["drop", "rebuild", "home", "front", "top", "fabrictest", "props", "png3d"] },
  space3d: { title: "3D view", ring: ["simulate", "home", "fit", "rebuild", "reset", "drop", "front", "top"], more: ["stress", "stitches", "props", "png3d", "show3d", "showboth"] },
};

/** Ring slots, clockwise from the top: direction in degrees (for pointing) and where the
 * button sits (px from the mouse at 100%). */
const SLOTS = [-90, -45, 0, 45, 90, 135, 180, -135];
const SLOT_XY: [number, number][] = [[0, -64], [40, -38], [56, 0], [40, 38], [0, 64], [-40, 38], [-56, 0], [-40, -38]];
const LIST_TOP = 92;

const byId = new Map<string, Command>();
const cmd = (id: string) => byId.get(id) ?? null;

let overlay: HTMLElement | null = null;
let ring: { c: Command; el: HTMLElement; angle: number }[] = [];
let rows: { run(): void; el: HTMLElement; ok: boolean }[] = [];
let hot = -1;
let rowHot = -1;
let center = { x: 0, y: 0 };

export function markingOpen(): boolean {
  return !!overlay;
}

export function closeMarking(): void {
  overlay?.remove();
  overlay = null;
  ring = [];
  rows = [];
}

function setHot(i: number): void {
  hot = i;
  ring.forEach((r, k) => r.el.classList.toggle("hot", k === i));
}

function setRowHot(i: number): void {
  rowHot = i;
  rows.forEach((r, k) => r.el.classList.toggle("hot", k === i));
}

function run(c: Command): void {
  closeMarking();
  if (isEnabled(c)) invoke(c);
}

function open(ctx: Ctx, x: number, y: number): void {
  closeMenu();
  closeSearch();
  hideTip();
  closeMarking();
  if (!byId.size) COMMANDS.forEach((c) => byId.set(c.id, c));
  const m = MENUS[ctx];
  center = { x, y };
  hot = -1;
  rowHot = -1;
  const wheel = h("div", { class: "mk-wheel" });
  wheel.style.left = `${unzoom(x)}px`;
  wheel.style.top = `${unzoom(y)}px`;
  wheel.append(h("div", { class: "mk-hub", title: "Close (Esc)" }));
  const list = m.ring.map(cmd).filter((c): c is Command => !!c).slice(0, 8);
  ring = list.map((c, i) => {
    const a = SLOTS[i];
    const [dx, dy] = SLOT_XY[i];
    const side = Math.abs(dx) < 4 ? "mid" : dx > 0 ? "right" : "left";
    const el = h("button", { type: "button", class: `mk-item ${side}${isEnabled(c) ? "" : " off"}${c.active?.() ? " on" : ""}`, title: c.help }, icon(c.icon, 16), h("span", {}, label(c)));
    el.style.left = `${dx}px`;
    el.style.top = `${dy}px`;
    el.addEventListener("mouseenter", () => setHot(i));
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      run(c);
    });
    wheel.append(el);
    return { c, el, angle: a };
  });
  // The list of more commands, under the ring.
  rows = [];
  const more = h("div", { class: "mk-more menu dense" }, h("div", { class: "menu-head" }, m.title));
  const last = lastCommand();
  const entries: { name: string; icon: string; key: string; ok: boolean; run(): void }[] = [];
  if (last && last.cmd.repeat !== false && !list.includes(last.cmd)) entries.push({ name: `Repeat ${last.cmd.name}`, icon: last.cmd.icon, key: "Enter", ok: isEnabled(last.cmd), run: () => { closeMarking(); runCommand(last.cmd, last.args); } });
  for (const c of m.more.map(cmd).filter((c): c is Command => !!c && !list.includes(c))) entries.push({ name: c.name, icon: c.icon, key: keyText(c), ok: isEnabled(c), run: () => run(c) });
  entries.forEach((e, i) => {
    const el = h("div", { class: `mi${e.ok ? "" : " off"}` }, h("span", { class: "mi-ico" }, icon(e.icon, 16)), h("span", { class: "mi-name" }, e.name), h("span", { class: "mi-key" }, e.key), h("span", { class: "mi-end" }));
    el.addEventListener("mouseenter", () => {
      setHot(-1);
      setRowHot(i);
    });
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (e.ok) e.run();
    });
    rows.push({ el, run: e.run, ok: e.ok });
    more.append(el);
  });
  more.style.top = `${LIST_TOP}px`;
  if (entries.length) wheel.append(more);
  overlay = h("div", { class: "mk-overlay" }, wheel);
  overlay.addEventListener("contextmenu", (e) => e.preventDefault());
  overlay.addEventListener("mousemove", (e) => {
    if ((e.target as HTMLElement).closest(".mk-more")) return;
    const dx = e.clientX - center.x;
    const dy = e.clientY - center.y;
    if (Math.hypot(dx, dy) < 22 * prefs.scale) return setHot(-1);
    setRowHot(-1);
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    let best = -1;
    let bd = 999;
    ring.forEach((r, i) => {
      const d = Math.abs(((a - r.angle + 540) % 360) - 180);
      if (d < bd) [best, bd] = [i, d];
    });
    setHot(bd <= 30 ? best : -1);
  });
  overlay.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (e.button !== 0) closeMarking();
  });
  overlay.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".mk-more")) return;
    const r = ring[hot];
    if (r && Math.hypot(e.clientX - center.x, e.clientY - center.y) >= 22 * prefs.scale) run(r.c);
    else closeMarking();
  });
  document.body.append(overlay);
  // Keep the list on screen.
  const box = more.getBoundingClientRect();
  if (box.bottom > window.innerHeight - 6) more.style.top = `${LIST_TOP - unzoom(box.bottom - window.innerHeight + 6)}px`;
  const wb = wheel.getBoundingClientRect();
  if (wb.right > window.innerWidth - 6) wheel.style.left = `${unzoom(x - (wb.right - window.innerWidth + 6))}px`;
  if (wb.left < 6) wheel.style.left = `${unzoom(x + 6 - wb.left)}px`;
}

function onKey(e: KeyboardEvent): void {
  if (!overlay) return;
  const k = e.key;
  if (k === "Escape") closeMarking();
  else if (k === "ArrowDown" || k === "ArrowUp") {
    if (!rows.length) return;
    const n = rows.length;
    setHot(-1);
    setRowHot(rowHot < 0 ? (k === "ArrowDown" ? 0 : n - 1) : (rowHot + (k === "ArrowDown" ? 1 : -1) + n) % n);
  } else if (k === "ArrowLeft" || k === "ArrowRight") {
    if (!ring.length) return;
    setRowHot(-1);
    setHot(hot < 0 ? 0 : (hot + (k === "ArrowRight" ? 1 : -1) + ring.length) % ring.length);
  } else if (k === "Enter" || k === " ") {
    if (rowHot >= 0 && rows[rowHot].ok) rows[rowHot].run();
    else if (hot >= 0) run(ring[hot].c);
  } else if (e.ctrlKey || e.metaKey) {
    closeMarking();
    return;
  } else {
    closeMarking();
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** Right-click without dragging in a window opens the menu for what is under the mouse. */
function hook(el: HTMLElement, where: "2d" | "3d"): void {
  let down: { x: number; y: number } | null = null;
  el.addEventListener("pointerdown", (e) => { if (e.button === 2) down = { x: e.clientX, y: e.clientY }; }, { capture: true });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const d = down;
    down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    let ctx: Ctx;
    if (where === "2d") ctx = selectAt(e.clientX, e.clientY);
    else ctx = leatherAt(e.clientX, e.clientY) ? "leather" : "space3d";
    if (prefs.mode === "full") open(ctx, e.clientX, e.clientY);
    else openPlain(ctx, e.clientX, e.clientY);
  });
}

/** Simple mode: a few everyday commands for what is under the mouse, in a plain list with big
 * rows and plain names (no ring). */
const PLAIN: Record<Ctx, string[]> = {
  piece: ["size", "duplicate", "mirror", "rotate", "delete", "check"],
  multi: ["align", "duplicate", "delete"],
  edge: ["sew", "measure", "delete"],
  vertex: ["round", "delete"],
  hole: ["delete"],
  fold: ["delete"],
  hardware: ["delete"],
  none: ["rect", "roundrect", "circle", "polygon", "paste", "selectall", "fit", "undo"],
  leather: ["simulate", "reset", "home", "fit"],
  space3d: ["simulate", "home", "fit", "reset"],
};

function openPlain(ctx: Ctx, x: number, y: number): void {
  closeMarking();
  closeSearch();
  hideTip();
  if (!byId.size) COMMANDS.forEach((c) => byId.set(c.id, c));
  const rows: MenuItem[] = [{ heading: MENUS[ctx].title }];
  for (const c of PLAIN[ctx].map(cmd).filter((c): c is Command => !!c))
    rows.push({ label: c.simpleLabel ?? c.name, icon: c.icon, help: c.help, enabled: () => isEnabled(c), checked: () => c.active?.() ?? false, run: () => invoke(c) });
  openMenu(null, rows, { at: { x, y }, big: true });
}

/** Open the menu for a context at a point (for screenshots and tests). */
export function showMarking(ctx: Ctx, x: number, y: number): void {
  open(ctx, x, y);
}

export function initMarking(): void {
  hook(document.getElementById("stage")!, "2d");
  hook(document.getElementById("view3d")!, "3d");
  window.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("resize", closeMarking);
  window.addEventListener("blur", closeMarking);
}
