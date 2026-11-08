// Fusion 360 style chrome: the application bar (menu bar: File, Edit, View, Help; quick access;
// project name; command search; Simulate), the toolbar (workspace switcher, tabs, and groups of
// compact icon buttons, each with a CAPTION ▾ list of every command in the group, where a
// command can be pinned to the toolbar), Simple mode's one row of labelled buttons, rich
// tooltips, and the navigation bars at the bottom of each window. Everything is built from the
// command registry, so a new command shows up in its group and its menus by itself.

import "./workbench.css";
import { COMMANDS, TABS, allKeys, command, isEnabled, label, runCommand, wordOf, type Command, type TabId } from "./commands";
import { h } from "./dom";
import { icon } from "./icons";
import { layout, setLayout } from "./layout";
import { initMarking } from "./marking";
import { closeMenu, initMenus, menuAnchor, menuOpen, openMenu, type Entry, type MenuItem } from "./menus";
import { prefs, setTheme, unzoom, type Theme } from "./prefs";
import { initSearch, showSearch } from "./search";
import { initTimeline, renderTimeline } from "./timeline";
import { initToolDialog, invoke } from "./tooldialog";
import { state } from "./store";
import { sim3d } from "./view3d";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TAB_KEY = "hidework.ribbonTab";

type Scope = "fixed" | "panel";
const bound: { el: HTMLElement; cmd: Command; scope: Scope }[] = [];
const fields: { input: HTMLInputElement | HTMLSelectElement; cmd: Command; out?: HTMLElement; scope: Scope }[] = [];
let tab: TabId = "pattern";

// ---------- buttons ----------

type Kind = "tb" | "qa" | "nav" | "simple";
const SIZE: Record<Kind, number> = { tb: 22, qa: 18, nav: 18, simple: 18 };

function cmdButton(c: Command, kind: Kind, scope: Scope, opts: { text?: boolean } = {}): HTMLButtonElement {
  // Quick-access and navigation buttons carry a label too; it shows in Simple mode, where no
  // button is icon-only.
  const text = opts.text ?? true;
  const words = kind === "simple" ? c.simpleLabel ?? label(c) : label(c);
  const b = h("button", { class: `rb rb-${kind}`, type: "button", "aria-label": c.name }, icon(c.icon, SIZE[kind]), text ? h("span", { class: `rb-label${kind === "qa" || kind === "nav" ? " opt-label" : ""}` }, words) : null);
  if (kind === "simple") b.dataset.simple = "1";
  // Buttons never take focus, so Space and Enter stay with the keyboard shortcuts.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    closeMenu();
    hideTip();
    invoke(c);
  });
  tip(b, () => c);
  bound.push({ el: b, cmd: c, scope });
  return b;
}

function fieldControl(c: Command, scope: Scope, compact = false): HTMLElement {
  const f = c.field!;
  let input: HTMLInputElement | HTMLSelectElement;
  let out: HTMLElement | undefined;
  if (f.kind === "select") {
    const s = h("select", { class: "rf-input", "aria-label": c.name });
    for (const [v, t] of f.options ?? []) s.append(h("option", { value: v }, t));
    s.addEventListener("change", () => { f.set(s.value); s.blur(); });
    input = s;
  } else {
    const i = h("input", { class: "rf-input", type: f.kind === "range" ? "range" : "number", "aria-label": c.name, min: f.min !== undefined ? String(f.min) : undefined, max: f.max !== undefined ? String(f.max) : undefined, step: f.step !== undefined ? String(f.step) : undefined }) as HTMLInputElement;
    if (f.kind === "range") {
      out = h("span", { class: "rf-unit" });
      i.addEventListener("input", () => (out!.textContent = `${i.value}${f.unit ?? ""}`));
    }
    i.addEventListener("change", () => {
      f.set(i.value);
      if (f.kind === "range") i.blur();
    });
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        if (e.key === "Escape") i.value = String(f.get());
        i.blur();
      }
      e.stopPropagation();
    });
    input = i;
  }
  fields.push({ input, cmd: c, out, scope });
  const unit = out ?? (f.unit && f.kind !== "range" ? h("span", { class: "rf-unit" }, f.unit) : null);
  const el = compact
    ? h("label", { class: "rfield compact" }, input, unit)
    : h("label", { class: "rfield" }, h("span", { class: "rf-top" }, icon(c.icon, 18), h("span", {}, label(c))), h("span", { class: "rf-row" }, input, unit));
  tip(el, () => c);
  return el;
}

// ---------- tooltips ----------

let tipTimer: number | undefined;

function tip(el: HTMLElement, get: () => Command): void {
  el.addEventListener("mouseenter", () => {
    window.clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => showTip(el, get()), 450);
  });
  el.addEventListener("mouseleave", hideTip);
}

function showTip(anchor: HTMLElement, c: Command): void {
  if (!document.body.contains(anchor) || menuOpen()) return;
  const t = $("tip");
  const keys = allKeys(c);
  const off = !isEnabled(c) ? [h("div", { class: "tip-off" }, "Not available for the current selection.")] : [];
  t.replaceChildren(
    h("div", { class: "tip-head" }, icon(c.icon, 22), h("strong", {}, c.name), keys ? h("span", { class: "tip-keys" }, ...keys.split(" · ").map((k) => h("span", { class: "kbd" }, k))) : null),
    h("div", { class: "tip-help" }, c.help),
    h("div", { class: "tip-type" }, "Type ", h("b", {}, wordOf(c)), c.args ? ` ${c.args}` : "", c.aliases?.length ? `  ·  or ${c.aliases.slice(0, 4).join(", ")}` : ""),
    ...off,
  );
  t.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const { width: w, height: hgt } = t.getBoundingClientRect();
  let top = r.bottom + 6;
  if (top + hgt > window.innerHeight - 4) top = r.top - hgt - 6;
  // Popups are zoomed with the interface size, so their own offsets are too.
  t.style.left = `${unzoom(Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)))}px`;
  t.style.top = `${unzoom(Math.max(4, top))}px`;
}

export function hideTip(): void {
  window.clearTimeout(tipTimer);
  $("tip").classList.add("hidden");
}

// ---------- menus ----------

export { closeMenu };

/** Commands by id, skipping any that no longer exist. */
const ids = (...list: string[]): MenuItem[] =>
  list.flatMap((id): MenuItem[] => {
    if (id === "-") return ["-"];
    const c = COMMANDS.find((x) => x.id === id);
    return c ? [c.ribbon === "field" ? { field: c } : c] : [];
  });

/** A menu's own rows, then any other command of that tab (so new commands always show). */
function withRest(tab: TabId, items: MenuItem[]): MenuItem[] {
  const listed = new Set(items.map((i) => (typeof i === "object" && "id" in i ? i.id : typeof i === "object" && "field" in i ? i.field.id : "")));
  const sub = (i: MenuItem) => (typeof i === "object" && "sub" in i && i.sub ? i.sub() : []);
  for (const i of items) for (const s of sub(i)) if (typeof s === "object") listed.add("id" in s ? s.id : "field" in s ? s.field.id : "");
  // Commands that only make sense with typed words (View 3d, Export dxf) stay on the command line.
  const rest = COMMANDS.filter((c) => c.tab === tab && !listed.has(c.id) && !(c.args && !c.args.startsWith("[") && !c.field));
  return rest.length ? [...items, "-", ...rest.map((c): MenuItem => (c.ribbon === "field" ? { field: c } : c))] : items;
}

const sub = (label: string, iconName: string, items: () => MenuItem[], help = ""): Entry => ({ label, icon: iconName, sub: items, help });

const MENUBAR: { label: string; full: boolean; items(): MenuItem[] }[] = [
  {
    label: "File",
    full: false,
    items: () =>
      withRest("file", [
        ...ids("template", "gallery", "import", "-", "open", "save", "saveas", "-", "print", "paper"),
        sub("Export", "pdf", () => ids("pdf", "svg", "laser", "dxf", "stl"), "Save the pattern for printing, a laser or a 3D printer."),
        sub("Save an image", "image", () => ids("png3d", "png2d"), "Save the 3D or pattern window as a picture."),
        "-",
        ...ids("hidelayout"),
      ]),
  },
  { label: "Edit", full: true, items: () => withRest("edit", ids("undo", "redo", "-", "cut", "copy", "paste", "duplicate", "delete", "-", "select", "selectall", "cancel")) },
  {
    label: "View",
    full: true,
    items: () =>
      withRest("view", [
        ...ids("show3d", "showboth", "showpattern", "-", "fit", "home", "zoomin", "zoomout", "orbit", "pan"),
        sub("3D views", "views", () => ids("home", "front", "side", "top", "back"), "Look at the 3D piece from one side."),
        "-",
        ...ids("snap", "smartsnap", "grid", "units", "-"),
        sub("Text size", "textbigger", () => ids("bigger", "smaller", "textsize"), "Make all text and buttons bigger or smaller."),
        sub("Colours", "theme", () => (["leather", "light", "contrast"] as Theme[]).map((t): Entry => ({ label: { leather: "Leather", light: "Light", contrast: "High contrast" }[t], checked: () => prefs.theme === t, run: () => setTheme(t), help: { leather: "Dark brown, like tooled leather.", light: "Dark writing on a light page.", contrast: "White and yellow on black, easiest to read." }[t] })), "Leather, light or high contrast colours."),
        ...ids("settings", "-", "tools"),
      ]),
  },
  { label: "Help", full: false, items: () => withRest("help", ids("help", "search", "shortcuts", "-", "steps", "welcome", "settings", "-", "agent")) },
];

// ---------- application bar ----------

function buildAppBar(): void {
  const buttons: HTMLElement[] = [];
  const openBar = (b: HTMLElement) => {
    const m = MENUBAR[buttons.indexOf(b)];
    if (m) openMenu(b, m.items(), { bar: { buttons: buttons.filter((x) => x.offsetParent !== null), open: openBar } });
  };
  for (const m of MENUBAR) {
    const b = h("button", { type: "button", class: `mb-btn${m.full ? " full-only" : ""}`, "aria-haspopup": "menu" }, m.label);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => openBar(b));
    // With a menu open, pointing at the next menu name opens it.
    b.addEventListener("mouseenter", () => { const a = menuAnchor(); if (a && a !== b && buttons.includes(a)) openBar(b); });
    buttons.push(b);
  }
  $("menubar").replaceChildren(...buttons);
  $("quick").replaceChildren(...["open", "save", "undo", "redo"].map((id) => cmdButton(command(id), "qa", "fixed")));
  const sim = $("btn-sim");
  sim.addEventListener("mousedown", (e) => e.preventDefault());
  sim.addEventListener("click", () => runCommand(command("simulate")));
  tip(sim, () => command("simulate"));
  const find = $("search-btn");
  find.replaceChildren(searchGlyph(), h("span", { class: "sb-text" }, "Search commands"), h("span", { class: "kbd" }, "S"));
  find.addEventListener("mousedown", (e) => e.preventDefault());
  find.addEventListener("click", () => showSearch(find));
  find.title = "Find any command by name (S)";
  const tools = $("tools-btn");
  tools.addEventListener("mousedown", (e) => e.preventDefault());
  tools.addEventListener("click", () => runCommand(command("tools")));
  tools.replaceChildren(icon("tools", 16), h("span", {}, "Simple tools"));
  tools.title = "Go back to the short row of big buttons";
}

function searchGlyph(): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.3 10.3l4 4" stroke="currentColor" stroke-width="1.8"/></svg>';
  return wrap.firstChild as SVGSVGElement;
}

/** Simple mode: one short row of labelled buttons for the main jobs. */
function buildSimpleBar(): void {
  // Grouped by job, left to right in the order the work is done: start or save, take back, draw a
  // piece, make it, then display and help. Open and Redo stay in the File menu and on Ctrl+O and
  // Ctrl+Y, which keeps the row short.
  const groups = [["template", "save"], ["undo"], ["draw"], ["size", "check", "see3d", "print"], ["settings", "help"]];
  const all = cmdButton(command("tools"), "simple", "fixed");
  all.classList.add("show-all");
  const parts: Node[] = [];
  groups.forEach((g, i) => {
    if (i) parts.push(h("span", { class: "sb-sep", "aria-hidden": "true" }));
    parts.push(...g.map((id) => (id === "draw" ? drawButton() : cmdButton(command(id), "simple", "fixed"))));
  });
  $("simplebar").replaceChildren(...parts, h("span", { class: "spacer" }), all);
}

/** Simple mode's "Draw a piece" button: one button in the row, the shapes in a list of big choices. */
function drawButton(): HTMLButtonElement {
  const b = h("button", { class: "rb rb-simple sb-draw", type: "button", "aria-label": "Draw a piece", "aria-haspopup": "menu" }, icon("freehand", SIZE.simple), h("span", { class: "rb-label" }, "Draw a piece", h("span", { class: "caret" }, " ▾")));
  b.dataset.simple = "1";
  b.title = "Draw a new piece: a rectangle, a rounded rectangle, a circle, any shape point by point, or one half mirrored.";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    hideTip();
    openMenu(b, ids("rect", "roundrect", "circle", "polygon", "-", "mirrorhalf"));
  });
  return b;
}

// ---------- toolbar: workspaces, tabs and groups ----------

const PIN_KEY = "hidework.toolbarPins";
/** Buttons a group shows before the rest go into its ▾ list. */
const MAX_SHOWN = 6;
/** Workspaces split into tabs; groups not named here go on the first tab. */
const SUBTABS: Partial<Record<TabId, { label: string; groups: string[] }[]>> = {
  pattern: [{ label: "Pieces", groups: [] }],
  sew: [{ label: "Seams", groups: [] }],
  finish: [
    { label: "Hardware", groups: ["Holes", "Hardware", "Edges", "Metal"] },
    { label: "Tooling", groups: ["Surface", "Tooling", "Designs"] },
  ],
  simulate: [{ label: "Physics", groups: [] }],
  output: [{ label: "Print and export", groups: [] }],
};
const WS_ICON: Partial<Record<TabId, string>> = { pattern: "rect", sew: "sew", finish: "hardware", simulate: "simulate", output: "print" };

/** The workspaces: every tab but View (a function: commands.ts may still be loading when this file runs). */
const workspaces = () => TABS.filter((t) => t.id !== "view");
let subTab = 0;
/** Toolbar changes made with the pins: true shows a command, false hides one that shows by default. */
let pins: Record<string, boolean> = {};

function loadPins(): void {
  try {
    const p = JSON.parse(localStorage.getItem(PIN_KEY) ?? "{}");
    if (p && typeof p === "object") pins = p;
  } catch {
    pins = {};
  }
}

function savePins(): void {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {
    /* storage unavailable */
  }
}

function loadTab(): TabId {
  try {
    const t = localStorage.getItem(TAB_KEY) as TabId | null;
    if (t && workspaces().some((x) => x.id === t)) return t;
  } catch {
    /* storage unavailable */
  }
  return "pattern";
}

/** Switch workspace (Pattern, Sew, Hardware & Finish, Simulate, Output). */
export function setTab(t: TabId): void {
  if (!workspaces().some((x) => x.id === t)) return;
  if (t !== tab) subTab = 0;
  tab = t;
  try {
    localStorage.setItem(TAB_KEY, t);
  } catch {
    /* storage unavailable */
  }
  buildTabs();
  buildPanel();
  // Before the first project loads there is nothing else to refresh.
  if (state.project) refreshRibbon();
}

function buildTabs(): void {
  const ws = workspaces().find((w) => w.id === tab)!;
  const sw = h("button", { type: "button", class: "ws-btn", title: "Switch workspace", "aria-haspopup": "menu" }, icon(WS_ICON[tab] ?? "tools", 22), h("span", { class: "ws-text" }, h("span", { class: "ws-kicker" }, "Workspace"), h("span", { class: "ws-name" }, ws.label)), h("span", { class: "caret" }, "▾"));
  sw.addEventListener("mousedown", (e) => e.preventDefault());
  sw.addEventListener("click", () =>
    openMenu(sw, workspaces().map((w): Entry => ({ label: w.label, icon: WS_ICON[w.id], help: w.help, checked: () => w.id === tab, run: () => setTab(w.id) }))),
  );
  $("ws-switch").replaceChildren(sw);
  const subs = SUBTABS[tab] ?? [{ label: ws.label, groups: [] }];
  if (subTab >= subs.length) subTab = 0;
  $("ribbon-tabs").replaceChildren(
    ...subs.map((s, i) => {
      const b = h("button", { type: "button", class: `rtab${i === subTab ? " active" : ""}` }, s.label);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        subTab = i;
        buildTabs();
        buildPanel();
        refreshRibbon();
      });
      return b;
    }),
  );
}

function groupsOf(t: TabId): [string, Command[]][] {
  const out = new Map<string, Command[]>();
  const subs = SUBTABS[t] ?? [];
  const named = new Set(subs.flatMap((s) => s.groups));
  for (const c of COMMANDS) {
    if (c.tab !== t) continue;
    const on = subs.length < 2 ? true : subTab === 0 ? subs[0].groups.includes(c.group) || !named.has(c.group) : subs[subTab].groups.includes(c.group);
    if (!on) continue;
    if (!out.has(c.group)) out.set(c.group, []);
    out.get(c.group)!.push(c);
  }
  return [...out.entries()];
}

/** The commands of a group that show as toolbar buttons. */
function shownIn(cmds: Command[]): Command[] {
  const icons = new Set<string>();
  let n = 0;
  return cmds.filter((c) => {
    if (c.ribbon === "field") return false;
    const pin = pins[c.id];
    // By default: the first few, skipping repeats of an icon already showing (they would look the same).
    const byDefault = c.ribbon !== "none" && n < MAX_SHOWN && !icons.has(c.icon);
    const show = pin ?? byDefault;
    if (byDefault) n++;
    if (show) icons.add(c.icon);
    return show;
  });
}

function shownByDefault(c: Command, cmds: Command[]): boolean {
  const saved = pins[c.id];
  delete pins[c.id];
  const r = shownIn(cmds).includes(c);
  if (saved !== undefined) pins[c.id] = saved;
  return r;
}

function groupMenu(cmds: Command[]): MenuItem[] {
  return cmds.map((c): MenuItem =>
    c.ribbon === "field"
      ? { field: c }
      : {
          cmd: c,
          pinned: () => shownIn(cmds).includes(c),
          toggle: () => {
            const now = shownIn(cmds).includes(c);
            if (shownByDefault(c, cmds) === !now) delete pins[c.id];
            else pins[c.id] = !now;
            savePins();
            buildPanel();
            refreshRibbon();
          },
        },
  );
}

function buildPanel(): void {
  for (const list of [bound, fields] as { scope: Scope }[][]) for (let i = list.length - 1; i >= 0; i--) if (list[i].scope === "panel") list.splice(i, 1);
  const panel = $("ribbon-panel");
  panel.replaceChildren(
    ...groupsOf(tab).map(([name, cmds]) => {
      const shown = shownIn(cmds);
      const body = h("div", { class: "tg-body" }, ...shown.map((c) => cmdButton(c, "tb", "panel", { text: false })));
      const cap = h("button", { type: "button", class: "tg-cap", "aria-haspopup": "menu", title: `Every ${name.toLowerCase()} command; pin one to show it here` }, h("span", {}, name), h("span", { class: "caret" }, "▾"));
      cap.addEventListener("mousedown", (e) => e.preventDefault());
      cap.addEventListener("click", () => openMenu(cap, groupMenu(cmds)));
      if (!shown.length) body.append(h("span", { class: "tg-empty" }));
      return h("div", { class: "tgroup" }, body, cap);
    }),
  );
  requestAnimationFrame(fitRibbon);
}

/** Tighten the toolbar when the app window is too narrow for every group. */
function fitRibbon(): void {
  const p = $("ribbon-panel");
  p.classList.remove("tight");
  if (p.scrollWidth > p.clientWidth + 1) p.classList.add("tight");
}

// ---------- window strips and navigation bars ----------

function buildWindows(): void {
  const strip = (id: string, title: string, sub: string, only: "3d" | "pattern") => {
    const max = h("button", { type: "button", class: "win-btn" });
    max.dataset.only = only;
    max.addEventListener("mousedown", (e) => e.preventDefault());
    max.addEventListener("click", () => setLayout(layout() === "both" ? only : "both"));
    $(id).replaceChildren(h("span", { class: "win-title" }, title), h("span", { class: "win-sub" }, sub), h("span", { class: "spacer" }), max);
    return max;
  };
  maxButtons = [
    [strip("head3d", "3D", "Simulation", "3d"), "3d"],
    [strip("head2d", "2D", "Pattern", "pattern"), "pattern"],
  ];

  const views = h("button", { type: "button", class: "rb rb-nav" }, icon("views", 20), h("span", { class: "rb-label opt-label" }, "Views"), h("span", { class: "caret" }, "▾"));
  views.addEventListener("mousedown", (e) => e.preventDefault());
  views.addEventListener("click", () => openMenu(views, ids("home", "front", "side", "top", "back"), { above: true }));
  views.title = "3D views";
  // Items marked "adv" are hidden in Simple mode, which keeps only zoom, fit and home.
  const adv = <T extends HTMLElement>(el: T): T => (el.classList.add("nav-adv"), el);
  const sep = () => adv(h("span", { class: "nav-sep" }));
  const nav = (id: string) => cmdButton(command(id), "nav", "fixed");
  $("nav3d").replaceChildren(adv(nav("orbit")), adv(nav("pan")), nav("zoomin"), nav("zoomout"), nav("fit"), nav("home"), adv(views), sep(), adv(nav("stress")), adv(nav("stitches")));
  $("nav2d").replaceChildren(nav("fit"), nav("zoomin"), nav("zoomout"), sep(), nav("smartsnap"), adv(nav("snap")), adv(fieldControl(command("grid"), "fixed", true)), sep(), adv(nav("measure")));
}

let maxButtons: [HTMLButtonElement, "3d" | "pattern"][] = [];

// ---------- state ----------

function refreshWindowButtons(): void {
  // Window names in plain words in Simple mode.
  const subs: [string, string, string][] = [["head3d", "Simulation", "What it will look like"], ["head2d", "Pattern", "Flat, to cut out"]];
  for (const [id, full, easy] of subs) {
    const sub = $(id).querySelector(".win-sub");
    const t = prefs.mode === "simple" ? easy : full;
    if (sub && sub.textContent !== t) sub.textContent = t;
  }
  for (const [b, only] of maxButtons) {
    const maxed = layout() === only;
    if (b.dataset.maxed === String(maxed)) continue;
    b.dataset.maxed = String(maxed);
    const words = maxed ? "Show both" : only === "3d" ? "Only 3D" : "Only pattern";
    b.replaceChildren(icon(maxed ? "layoutboth" : only === "3d" ? "layout3d" : "layoutpattern", 16), h("span", { class: "opt-label" }, words));
    b.title = maxed ? "Show both windows (F3)" : only === "3d" ? "Show only the 3D window (F2)" : "Show only the pattern window (F4)";
  }
}

export function refreshRibbon(): void {
  const toggle = $("simplebar").querySelector(".show-all .rb-label");
  if (toggle) toggle.textContent = prefs.mode === "simple" ? "Show all tools" : "Simple tools";
  for (const { el, cmd } of bound) {
    el.classList.toggle("active", cmd.active?.() ?? false);
    el.classList.toggle("off", !isEnabled(cmd));
    if (cmd.short && !el.dataset.simple && el.classList.contains("rb-tb")) {
      const l = el.querySelector(".rb-label");
      if (l && l.textContent !== label(cmd)) l.textContent = label(cmd);
    }
  }
  for (const { input, cmd, out } of fields) {
    if (document.activeElement === input) continue;
    const v = String(cmd.field!.get());
    if (input.value !== v) input.value = v;
    if (out) out.textContent = `${v}${cmd.field!.unit ?? ""}`;
  }
  const sim = $("btn-sim");
  sim.classList.toggle("on", sim3d.running);
  const txt = sim3d.building ? "Building…" : sim3d.running ? "Simulating" : "Simulate";
  const lbl = sim.querySelector(".lbl");
  if (lbl && lbl.textContent !== txt) lbl.textContent = txt;
  const name = state.filePath ? state.filePath.split(/[\\/]/).pop() : "not saved";
  const title = $("app-title");
  const t = `${state.project.name}${state.dirty ? " •" : ""}`;
  if (title.dataset.t !== `${t}|${name}`) {
    title.dataset.t = `${t}|${name}`;
    title.replaceChildren(h("strong", {}, t), h("span", {}, name ?? ""));
    title.title = state.filePath ?? "This project has not been saved yet.";
  }
  refreshWindowButtons();
  renderTimeline();
}

export function initRibbon(): void {
  tab = loadTab();
  loadPins();
  initMenus();
  buildAppBar();
  buildSimpleBar();
  buildTabs();
  buildPanel();
  buildWindows();
  refreshWindowButtons();
  initSearch();
  initMarking();
  initToolDialog();
  initTimeline();
  document.addEventListener("mousedown", hideTip);
  window.addEventListener("blur", hideTip);
  window.addEventListener("resize", () => { hideTip(); fitRibbon(); });
  // Browser preview only: ?ui=... settings for screenshots of the chrome.
  if (import.meta.env.DEV && location.search) void import("./chromedemo").then((m) => m.runDemo());
}
