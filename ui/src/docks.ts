// Dockable panels, as in Fusion 360: the Library (left by default) and the Browser with the
// properties of what is selected (right by default). Each panel has a slim header. Drag the
// header to dock the panel on the left, the right or the top, or drop it anywhere else to float
// it. The header's arrow collapses the panel to a thin strip (click the strip to open it again);
// its ⋯ button, or a right-click, has every choice: dock left, right or top, float, merge with
// the other panel, collapse and close. Two panels on the same side share one dock, stacked (or
// side by side at the top) with a bar between them. Drag a dock's inner edge to resize it;
// double-click the edge to go back to the standard size. The arrangement is remembered on this
// computer. Simple mode always uses the plain arrangement (library left, browser right, no
// headers), so nothing can get lost there.

import "./docks.css";
import { h } from "./dom";
import { relayout } from "./layout";
import { closeMenu, openMenu, type Entry, type MenuItem } from "./menus";
import { prefs, simple, unzoom } from "./prefs";
import { setStatus, subscribe } from "./store";

export type PanelId = "library" | "browser";
export type Place = "left" | "right" | "top" | "float";
type Side = "left" | "right" | "top";

interface PanelState {
  place: Place;
  collapsed: boolean;
  closed: boolean;
  /** Where it floats, in px from the top left of the work area (screen size, not zoomed). */
  float: { x: number; y: number; w: number; h: number };
}

interface Arrangement {
  panels: Record<PanelId, PanelState>;
  /** Dock sizes in screen px; null is the standard size. */
  size: Record<Side, number | null>;
  /** The first panel's share when two panels share a dock. */
  split: Record<Side, number>;
}

const KEY = "hidework.panels";
const ORDER: PanelId[] = ["library", "browser"];
const META: Record<PanelId, { title: string; help: string; home: Side }> = {
  library: { title: "Library", help: "Patterns, fabrics, hardware and the 3D scene", home: "left" },
  browser: { title: "Browser", help: "The pieces, fabrics and seams of this project, and the properties of what is selected", home: "right" },
};
const SIDES: Side[] = ["left", "right", "top"];
const TOP_DEFAULT = 210;

/** All tools: the canvas comes first. The library starts as a thin strip on the left; the browser
 * is open on the right. */
function fullDefault(): Arrangement {
  return {
    panels: {
      library: { place: "left", collapsed: true, closed: false, float: { x: 60, y: 60, w: 280, h: 420 } },
      browser: { place: "right", collapsed: false, closed: false, float: { x: 400, y: 60, w: 320, h: 520 } },
    },
    size: { left: null, right: null, top: null },
    split: { left: 0.45, right: 0.45, top: 0.5 },
  };
}

/** Simple mode: both panels open in their usual places, no headers. */
function simpleArrangement(): Arrangement {
  const a = fullDefault();
  a.panels.library.collapsed = false;
  return a;
}

let arr: Arrangement = fullDefault();
const $ = (id: string) => document.getElementById(id) as HTMLElement;
/** The panel elements, kept here: a panel is briefly out of the page while it moves. */
const panels = new Map<PanelId, HTMLElement>();
const panelEl = (id: PanelId): HTMLElement => {
  if (!panels.has(id)) panels.set(id, $(`panel-${id}`));
  return panels.get(id)!;
};
const other = (id: PanelId): PanelId => (id === "library" ? "browser" : "library");

function load(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Partial<Arrangement>;
    const d = fullDefault();
    for (const id of ORDER) {
      const s = p.panels?.[id];
      if (!s) continue;
      const place: Place = ["left", "right", "top", "float"].includes(s.place) ? s.place : d.panels[id].place;
      const f = s.float && [s.float.x, s.float.y, s.float.w, s.float.h].every(Number.isFinite) ? s.float : d.panels[id].float;
      d.panels[id] = { place, collapsed: !!s.collapsed, closed: !!s.closed, float: { ...f } };
    }
    for (const side of SIDES) {
      const v = p.size?.[side];
      if (typeof v === "number" && Number.isFinite(v)) d.size[side] = v;
      const sp = p.split?.[side];
      if (typeof sp === "number" && sp > 0.1 && sp < 0.9) d.split[side] = sp;
    }
    arr = d;
  } catch {
    /* storage unavailable or damaged: keep the defaults */
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    /* storage unavailable */
  }
}

/** The arrangement on screen: the saved one, or the fixed one in Simple mode. */
function live(): Arrangement {
  return simple() ? simpleArrangement() : arr;
}

// ---------- reading the arrangement (for commands and menus) ----------

export function panelState(id: PanelId): Readonly<PanelState> {
  return live().panels[id];
}

/** Open: on screen and not collapsed. */
export function panelOpen(id: PanelId): boolean {
  const s = live().panels[id];
  return !s.closed && !s.collapsed;
}

export function panelsMerged(): boolean {
  const a = live().panels;
  return !a.library.closed && !a.browser.closed && a.library.place === a.browser.place;
}

export function panelsOnTop(): boolean {
  const a = live().panels;
  return a.library.place === "top" && a.browser.place === "top";
}

export function allCollapsed(): boolean {
  const shown = ORDER.filter((id) => !live().panels[id].closed);
  return shown.length > 0 && shown.every((id) => live().panels[id].collapsed);
}

// ---------- changing it ----------

/** Apply a change to the saved arrangement. In Simple mode it is kept for All tools. */
function change(fn: (a: Arrangement) => void, status?: string): void {
  fn(arr);
  save();
  render();
  if (simple()) setStatus("Panels stay where they are in Simple mode. Your change is used when all tools are showing.");
  else if (status) setStatus(status);
}

const where = (p: Place) => (p === "float" ? "floating" : p === "top" ? "at the top" : `on the ${p}`);

export function placePanel(id: PanelId, place: Place): void {
  change((a) => {
    const s = a.panels[id];
    s.place = place;
    s.closed = false;
    s.collapsed = false;
    if (place === "float") clampFloat(s);
  }, `${META[id].title} ${where(place)}.`);
}

export function setCollapsed(id: PanelId, on: boolean): void {
  change((a) => {
    a.panels[id].collapsed = on;
    a.panels[id].closed = false;
  });
}

export function toggleCollapsed(id: PanelId): void {
  setCollapsed(id, !arr.panels[id].collapsed);
}

export function closePanel(id: PanelId): void {
  change((a) => (a.panels[id].closed = true), `${META[id].title} closed. View, Panels brings it back.`);
}

/** Show a panel (closed or collapsed), e.g. before showing one of its tabs. Never moves it. */
export function revealPanel(id: PanelId): void {
  if (simple()) return;
  const s = arr.panels[id];
  if (!s.closed && !s.collapsed) return;
  s.closed = false;
  s.collapsed = false;
  save();
  render();
}

/** The Library and Browser panel commands: with no word, show or hide; or a place, or hide. */
export function panelCommand(id: PanelId, arg?: string): void {
  const v = (arg ?? "").toLowerCase();
  if (v === "left" || v === "right" || v === "top" || v === "float") return placePanel(id, v);
  if (v === "hide" || v === "close" || v === "off") return closePanel(id);
  if (v === "show" || v === "open" || v === "on") return revealPanel(id), setStatus(`${META[id].title} open.`);
  if (v === "collapse") return setCollapsed(id, true);
  if (panelOpen(id)) closePanel(id);
  else change((a) => ((a.panels[id].closed = false), (a.panels[id].collapsed = false)), `${META[id].title} open.`);
}

/** Put this panel together with the other one, or split two merged panels apart. */
export function mergePanel(id: PanelId): void {
  const o = other(id);
  if (panelsMerged()) {
    // Split: this panel goes home, or to the far side when it is already home.
    const here = arr.panels[id].place;
    const home = META[id].home;
    const to: Place = here !== home ? home : here === "left" ? "right" : "left";
    return placePanel(id, to);
  }
  change((a) => {
    const s = a.panels[id];
    const t = a.panels[o];
    t.closed = false;
    s.closed = false;
    s.collapsed = false;
    t.collapsed = false;
    if (t.place === "float" && s.place === "float") s.place = t.place = "right";
    else if (t.place === "float") t.place = s.place;
    else s.place = t.place;
  }, `Library and Browser share one panel ${where(arr.panels[o].place)}.`);
}

/** Merge panels: both in one dock (where the browser is), or back to the usual sides. */
export function toggleMerged(): void {
  if (panelsMerged()) {
    change((a) => {
      a.panels.library.place = "left";
      a.panels.browser.place = "right";
    }, "Library on the left, Browser on the right.");
  } else mergePanel("library");
}

/** Both panels in one strip along the top, or back to the usual sides. */
export function togglePanelsTop(): void {
  const on = panelsOnTop();
  change((a) => {
    for (const id of ORDER) {
      a.panels[id].place = on ? META[id].home : "top";
      a.panels[id].closed = false;
      a.panels[id].collapsed = false;
    }
  }, on ? "Panels back at the sides." : "Panels along the top. The 3D and pattern windows get the full width.");
}

/** Collapse every docked panel to a strip (most room for the windows), or open them again. */
export function toggleCollapseAll(): void {
  const collapse = !allCollapsed();
  change((a) => {
    for (const id of ORDER) if (!a.panels[id].closed) a.panels[id].collapsed = collapse;
  }, collapse ? "Panels collapsed. F6 or a click on a strip opens them." : "Panels open.");
}

export function resetPanels(): void {
  arr = fullDefault();
  for (const id of ORDER) panelEl(id).style.cssText = "";
  change(() => {}, "Panels back to the standard layout.");
}

// ---------- the panel menu ----------

/** The rows of a panel's ⋯ menu (also its right-click menu). */
export function panelMenu(id: PanelId): MenuItem[] {
  const s = live().panels[id];
  const o = META[other(id)].title;
  const at = (place: Place, label: string, iconName: string, help: string): Entry => ({ label, icon: iconName, help, checked: () => live().panels[id].place === place && !live().panels[id].closed, run: () => placePanel(id, place) });
  const items: MenuItem[] = [
    { heading: META[id].title },
    at("left", "Dock on the left", "panelleft", "Dock this panel along the left side."),
    at("right", "Dock on the right", "panelright", "Dock this panel along the right side."),
    at("top", "Dock at the top", "paneltop", "A wide strip above the 3D and pattern windows."),
    at("float", "Float", "panelfloat", "A small window over the work area. Drag its header to move it, its corner to size it."),
    "-",
    panelsMerged()
      ? { label: `Split from ${o}`, icon: "panelmerge", help: `Give the ${o.toLowerCase()} its own side again.`, run: () => mergePanel(id) }
      : { label: `Merge with ${o}`, icon: "panelmerge", help: `Put both panels in one dock, ${where(live().panels[other(id)].place === "float" ? s.place : live().panels[other(id)].place)}.`, run: () => mergePanel(id) },
    { label: s.collapsed ? "Expand" : "Collapse", icon: "panelcollapse", help: s.collapsed ? "Open the panel again." : "Fold the panel to a thin strip. Click the strip to open it.", run: () => toggleCollapsed(id) },
    { label: "Close", icon: "cancel", help: "Hide this panel. View, Panels brings it back.", run: () => closePanel(id) },
    "-",
    { label: "Reset panel layout", icon: "reset", help: "Library on the left as a strip, Browser open on the right, standard sizes.", run: resetPanels },
  ];
  return items;
}

/** The panel that a node is in, if any. */
export function panelOf(el: Element | null): PanelId | null {
  const p = el?.closest<HTMLElement>("[data-panel]");
  const id = p?.dataset.panel;
  return id === "library" || id === "browser" ? id : null;
}

// ---------- drawing it ----------

let built = false;

function grip(): HTMLElement {
  const s = h("span", { class: "ph-grip", "aria-hidden": "true" });
  s.innerHTML = '<svg viewBox="0 0 6 12" width="6" height="12"><g fill="currentColor"><rect x="0" y="1" width="2" height="2"/><rect x="4" y="1" width="2" height="2"/><rect x="0" y="5" width="2" height="2"/><rect x="4" y="5" width="2" height="2"/><rect x="0" y="9" width="2" height="2"/><rect x="4" y="9" width="2" height="2"/></g></svg>';
  return s;
}

function buildHead(id: PanelId): void {
  const head = panelEl(id).querySelector<HTMLElement>(".panel-head")!;
  const collapse = h("button", { type: "button", class: "ph-btn ph-collapse" });
  const menu = h("button", { type: "button", class: "ph-btn ph-menu", title: "Panel options: dock, float, merge, collapse, close", "aria-haspopup": "menu", "aria-label": `${META[id].title} panel options` }, "⋯");
  for (const b of [collapse, menu]) b.addEventListener("mousedown", (e) => e.preventDefault());
  collapse.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCollapsed(id);
  });
  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(menu, panelMenu(id));
  });
  head.replaceChildren(grip(), h("span", { class: "ph-title" }, META[id].title), h("span", { class: "spacer" }), collapse, menu);
  head.title = `${META[id].help}. Drag to dock it on the left, right or top, or to float it. Right-click for more.`;
  head.addEventListener("pointerdown", (e) => onHeadDown(id, e));
}

function collapseGlyph(place: Place, collapsed: boolean): [string, string] {
  if (place === "left") return collapsed ? ["›", "Open the panel"] : ["‹", "Collapse to a strip"];
  if (place === "right") return collapsed ? ["‹", "Open the panel"] : ["›", "Collapse to a strip"];
  return collapsed ? ["▾", "Open the panel"] : ["▴", "Collapse to its header"];
}

function dockEl(side: Side): HTMLElement {
  return $(`dock-${side}`);
}

/** The ratio of a zoomed element's screen size to its CSS size. */
function zoomOf(el: HTMLElement): number {
  const w = el.offsetWidth;
  const r = el.getBoundingClientRect().width;
  return w > 0 && r > 0 ? r / w : prefs.scale;
}

export function render(): void {
  if (!built) return;
  const a = live();
  const easy = simple();
  for (const side of SIDES) {
    const dock = dockEl(side);
    const ids = ORDER.filter((id) => a.panels[id].place === side && !a.panels[id].closed);
    const open = ids.filter((id) => !a.panels[id].collapsed);
    const kids: HTMLElement[] = [];
    ids.forEach((id, i) => {
      if (i > 0 && open.length === 2) kids.push(sash(side));
      kids.push(panelEl(id));
    });
    kids.push(edgeHandle(side));
    dock.replaceChildren(...kids);
    dock.classList.toggle("empty", ids.length === 0);
    dock.classList.toggle("strip", side !== "top" && ids.length > 0 && open.length === 0);
    dock.classList.toggle("stacked", ids.length > 1);
    // Sizes: in Simple mode always the standard ones.
    const size = easy ? null : a.size[side];
    dock.classList.toggle("sized", size !== null);
    const z = prefs.scale;
    if (side === "top") dock.style.height = open.length ? `${(size ?? TOP_DEFAULT) / z}px` : "";
    else dock.style.width = size !== null && open.length ? `${size / z}px` : "";
    // Two open panels share the dock.
    ids.forEach((id) => {
      const el = panelEl(id);
      const st = a.panels[id];
      const k = open.length === 2 ? (id === ORDER[0] ? a.split[side] : 1 - a.split[side]) : 1;
      el.style.flex = st.collapsed ? "" : `${k} 1 0`;
    });
  }
  const layer = $("dock-float");
  const floats = ORDER.filter((id) => a.panels[id].place === "float" && !a.panels[id].closed);
  layer.replaceChildren(...floats.map((id) => panelEl(id)));
  for (const id of floats) {
    const el = panelEl(id);
    const f = a.panels[id].float;
    el.style.flex = "";
    el.style.left = `${unzoom(f.x)}px`;
    el.style.top = `${unzoom(f.y)}px`;
    el.style.width = `${unzoom(f.w)}px`;
    el.style.height = a.panels[id].collapsed ? "" : `${unzoom(f.h)}px`;
  }
  for (const id of ORDER) {
    const el = panelEl(id);
    const st = a.panels[id];
    el.classList.toggle("collapsed", st.collapsed);
    el.classList.toggle("float", st.place === "float" && !st.closed);
    el.classList.toggle("closed", st.closed);
    if (st.place !== "float") for (const p of ["left", "top", "width", "height"] as const) el.style[p] = "";
    el.dataset.place = st.place;
    const [g, t] = collapseGlyph(st.place, st.collapsed);
    const b = el.querySelector<HTMLElement>(".ph-collapse");
    if (b) {
      b.textContent = g;
      b.title = t;
      b.setAttribute("aria-label", `${t}: ${META[id].title}`);
      b.setAttribute("aria-expanded", String(!st.collapsed));
    }
    // Closed panels wait, hidden, in their home dock, so their contents stay in the page.
    if (st.closed && !el.isConnected) dockEl(META[id].home).prepend(el);
  }
  relayout();
}

// ---------- dragging: docks' edges, the bar between two panels, panel headers ----------

const edges: Partial<Record<Side, HTMLElement>> = {};
const sashes: Partial<Record<Side, HTMLElement>> = {};

function edgeHandle(side: Side): HTMLElement {
  if (edges[side]) return edges[side]!;
  const el = h("div", { class: `dock-edge ${side}`, title: "Drag to resize the panel. Double-click for the standard size.", role: "separator", "aria-orientation": side === "top" ? "horizontal" : "vertical" });
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || simple()) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const dock = dockEl(side);
    const r0 = dock.getBoundingClientRect();
    const z = zoomOf(dock);
    const ws = $("workspace").getBoundingClientRect();
    const start = side === "top" ? r0.height : r0.width;
    const max = side === "top" ? ws.height * 0.6 : ws.width * 0.45;
    const min = side === "top" ? 90 : 170;
    let size = start;
    dock.classList.add("sized", "resizing");
    const move = (ev: PointerEvent) => {
      const d = side === "left" ? ev.clientX - e.clientX : side === "right" ? e.clientX - ev.clientX : ev.clientY - e.clientY;
      size = Math.round(Math.min(max, Math.max(min, start + d)));
      if (side === "top") dock.style.height = `${size / z}px`;
      else dock.style.width = `${size / z}px`;
      relayout();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener(
      "pointerup",
      () => {
        el.removeEventListener("pointermove", move);
        dock.classList.remove("resizing");
        arr.size[side] = size;
        save();
        render();
      },
      { once: true },
    );
  });
  el.addEventListener("dblclick", () => {
    arr.size[side] = null;
    save();
    render();
  });
  edges[side] = el;
  return el;
}

function sash(side: Side): HTMLElement {
  if (sashes[side]) return sashes[side]!;
  const across = side === "top";
  const el = h("div", { class: `dock-sash${across ? " across" : ""}`, title: "Drag to share the room between the two panels. Double-click to even out.", role: "separator" });
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const dock = dockEl(side).getBoundingClientRect();
    const [first, second] = ORDER.map(panelEl);
    let f = arr.split[side];
    const move = (ev: PointerEvent) => {
      f = across ? (ev.clientX - dock.left) / dock.width : (ev.clientY - dock.top) / dock.height;
      f = Math.min(0.85, Math.max(0.15, f));
      first.style.flex = `${f} 1 0`;
      second.style.flex = `${1 - f} 1 0`;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener(
      "pointerup",
      () => {
        el.removeEventListener("pointermove", move);
        arr.split[side] = f;
        save();
        relayout();
      },
      { once: true },
    );
  });
  el.addEventListener("dblclick", () => {
    arr.split[side] = 0.5;
    save();
    render();
  });
  sashes[side] = el;
  return el;
}

function clampFloat(s: PanelState): void {
  const ws = $("workspace").getBoundingClientRect();
  s.float.w = Math.min(Math.max(200, s.float.w), Math.max(200, ws.width - 20));
  s.float.h = Math.min(Math.max(160, s.float.h), Math.max(160, ws.height - 20));
  s.float.x = Math.min(Math.max(0, s.float.x), Math.max(0, ws.width - 80));
  s.float.y = Math.min(Math.max(0, s.float.y), Math.max(0, ws.height - 40));
}

/** Where a drop at a point would dock the panel: near an edge of the work area, or float. */
function zoneAt(x: number, y: number): Place {
  const r = $("workspace").getBoundingClientRect();
  const edge = Math.min(70, r.width * 0.08);
  if (x - r.left < edge) return "left";
  if (r.right - x < edge) return "right";
  if (y - r.top < edge) return "top";
  return "float";
}

function zoneRect(z: Place, x: number, y: number, s: PanelState): { left: number; top: number; width: number; height: number } {
  const r = $("workspace").getBoundingClientRect();
  const w = Math.min(320, r.width * 0.25);
  if (z === "left") return { left: r.left, top: r.top, width: w, height: r.height };
  if (z === "right") return { left: r.right - w, top: r.top, width: w, height: r.height };
  if (z === "top") return { left: r.left, top: r.top, width: r.width, height: Math.min(TOP_DEFAULT, r.height * 0.4) };
  return { left: x - 40, top: y - 10, width: s.float.w, height: s.collapsed ? 26 : s.float.h };
}

function onHeadDown(id: PanelId, e: PointerEvent): void {
  if (e.button !== 0 || simple() || (e.target as HTMLElement).closest(".ph-btn")) return;
  const head = e.currentTarget as HTMLElement;
  const s = arr.panels[id];
  // A click (no drag) on a collapsed panel's header opens it.
  const wasCollapsed = s.collapsed;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let zone: Place = s.place;
  const floating = s.place === "float";
  const el = panelEl(id);
  const r0 = el.getBoundingClientRect();
  const ws = $("workspace").getBoundingClientRect();
  head.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
    if (!dragging) {
      dragging = true;
      closeMenu();
      document.body.classList.add("dock-dragging");
      ghost = h("div", { class: "dock-ghost" });
      document.body.append(ghost);
    }
    zone = zoneAt(ev.clientX, ev.clientY);
    if (floating && zone === "float") {
      // A floating panel moves with the mouse.
      s.float.x = r0.left - ws.left + ev.clientX - x0;
      s.float.y = r0.top - ws.top + ev.clientY - y0;
      clampFloat(s);
      el.style.left = `${unzoom(s.float.x)}px`;
      el.style.top = `${unzoom(s.float.y)}px`;
      ghost!.style.display = "none";
      return;
    }
    const g = zoneRect(zone, ev.clientX, ev.clientY, s);
    Object.assign(ghost!.style, { display: "", left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
    ghost!.classList.toggle("docked", zone !== "float");
  };
  const end = (ev: PointerEvent, cancel = false) => {
    head.removeEventListener("pointermove", move);
    head.removeEventListener("pointerup", up);
    head.removeEventListener("pointercancel", lost);
    window.removeEventListener("keydown", esc, true);
    ghost?.remove();
    document.body.classList.remove("dock-dragging");
    if (!dragging) {
      if (!cancel && wasCollapsed) setCollapsed(id, false);
      return;
    }
    if (cancel) return render();
    if (zone === "float") {
      if (!floating) {
        s.float.x = ev.clientX - ws.left - 40;
        s.float.y = ev.clientY - ws.top - 10;
      }
      clampFloat(s);
    }
    placePanel(id, zone);
  };
  const up = (ev: PointerEvent) => end(ev);
  const lost = (ev: PointerEvent) => end(ev, true);
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    end(new PointerEvent("pointerup"), true);
  };
  head.addEventListener("pointermove", move);
  head.addEventListener("pointerup", up);
  head.addEventListener("pointercancel", lost);
  window.addEventListener("keydown", esc, true);
}

/** Remember a floating panel's size after it is resized by its corner. */
function watchFloatSize(): void {
  const ro = new ResizeObserver(() => {
    let moved = false;
    for (const id of ORDER) {
      const el = panelEl(id);
      const s = arr.panels[id];
      if (simple() || s.place !== "float" || s.collapsed || s.closed || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 10) continue;
      if (Math.abs(r.width - s.float.w) > 1 || Math.abs(r.height - s.float.h) > 1) {
        s.float.w = Math.round(r.width);
        s.float.h = Math.round(r.height);
        moved = true;
      }
    }
    if (moved) {
      save();
      relayout();
    }
  });
  for (const id of ORDER) ro.observe(panelEl(id));
}

export function initDocks(): void {
  load();
  for (const id of ORDER) {
    panelEl(id);
    buildHead(id);
  }
  built = true;
  render();
  watchFloatSize();
  // Simple mode and All tools use different arrangements; redraw when the mode or size changes.
  let mode = prefs.mode;
  let scale = prefs.scale;
  subscribe(() => {
    if (prefs.mode === mode && prefs.scale === scale) return;
    mode = prefs.mode;
    scale = prefs.scale;
    render();
  });
}
