// The one list of commands. The ribbon, its group dropdowns, the File and Help menus, the
// navigation bars, the command line, the keyboard and the shortcuts dialog are all built from
// it, so a command's name, icon, shortcut and help are written once.

import { addRect, addRegularPolygon, cancelAll, exportFile, fabDialog, mirrorSelected, newFromName, openFile, parseLen, print, rotateSelected, saveFile, setTool, setTool3d, showMcp, showTemplates, startShape, toggleSim, type ExportKind } from "./actions";
import { applyProp, showBrowserTab, showLibraryTab, type PropKind } from "./browser";
import { fitView, viewCenter, zoomBy } from "./canvas";
import { alignSelected, copySelection, cutSelection, deleteSelected, distributeSelected, duplicateSelected, mergeSelected, nudgeSelected, pasteClipboard, selectAll, selectedPieces, setSnapGrid, snap, toggleSnap, type AlignTo } from "./editing";
import { showGuide, showSettings, showShortcuts } from "./help";
import { openChecker } from "./checker";
import { SCALE_MAX, SCALE_MIN, prefs, setMode, setScale, setTheme, type Theme } from "./prefs";
import { ensureVisible, hovered, layout, setLayout, visible, type Layout } from "./layout";
import { insertVertex, roundedRectPiece, toggleCurve } from "./ops";
import { addStrap, openFabricTest, panel } from "./panels";
import { offerUndo } from "./commandline";
import { showSteps } from "./guide";
import { showSearch } from "./search";
import { openSizes } from "./sizes";
import { showWelcome } from "./welcome";
import { DESIGNS, openTooling, startTooling, tooling } from "./tooling";
import { openHideLayout } from "./hide";
import { openImport } from "./importer";
import { addDartAt, edgeMiddle, ovalPiece, roundCornerAt, setEdgeAngle, setEdgeLength, slotPiece } from "./shapeops";
import { draw } from "./drawtools";
import { focusEdgeLength } from "./edgebox";
import { setSmartSnap, smart } from "./smartsnap";
import { changed, edit, notify, piece, placing, redo, setStatus, state, undo, version } from "./store";
import type { Metal } from "./fittings";
import type { PageSize, Units } from "./types";
import { OBJECT_PRESETS, dropObject, frameView, needsRebuild, rebuild, resetSim, setHeat, setMetal, sim3d, viewPreset, zoom3d } from "./view3d";

export type TabId = "pattern" | "sew" | "finish" | "simulate" | "output" | "view" | "file" | "edit" | "help";

/** Workspaces, in order (the toolbar's workspace switcher). "view" commands live in the View menu
 * and the navigation bars; "file", "edit" and "help" commands in the menu bar. */
export const TABS: { id: TabId; label: string; help: string }[] = [
  { id: "pattern", label: "Pattern", help: "Draw and shape pattern pieces" },
  { id: "sew", label: "Sew", help: "Seams, stitches and construction" },
  { id: "finish", label: "Hardware & Finish", help: "Holes, hardware, surface work and edges" },
  { id: "simulate", label: "Simulate", help: "Simulate in 3D: pull, pin, weigh, drop objects" },
  { id: "output", label: "Output", help: "Print, export and images" },
  { id: "view", label: "View", help: "Window layout, navigation and units" },
];

/** A small input shown in the ribbon next to (or instead of) a command's button. */
export interface Field {
  kind: "number" | "select" | "range";
  get(): string | number;
  set(v: string): void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
}

export interface Command {
  id: string;
  /** Full name, shown in menus, tooltips and help. */
  name: string;
  /** Ribbon label when the name is long. */
  short?: string;
  /** Plain-words label for the Simple mode button row. */
  simpleLabel?: string;
  /** What to type on the command line (default: the name without spaces). */
  word?: string;
  aliases?: string[];
  icon: string;
  /** Key bindings, written as shown: "Ctrl+Shift+S", "R", "Space", "F1", "Del". */
  keys?: string[];
  /** Shortcut text for help only (handled elsewhere, e.g. the arrow keys). */
  keyHint?: string;
  tab: TabId;
  group: string;
  /** One line of help for the tooltip and the shortcuts dialog. */
  help: string;
  /** Typed arguments, e.g. "[width height]". */
  args?: string;
  /** How it shows in the toolbar: a button ("big" or "small", the default), its field only (set in
   * the group's ▾ list), or only in the ▾ list ("none"; a user can pin it to the toolbar). */
  ribbon?: "big" | "small" | "field" | "none";
  field?: Field;
  /** Whether Enter on an empty command line may repeat it. */
  repeat?: boolean;
  run(args: string[]): unknown;
  active?(): boolean;
  enabled?(): boolean;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

const hasPiece = () => selectedPieces().length > 0;
const many = (n: number) => () => selectedPieces().length >= n;
const tool2d = (t: typeof state.tool) => () => state.tool === t;
const tool3d = (t: typeof sim3d.tool) => () => sim3d.tool === t;
/** A shape tool is on and drawing this shape. */
const shapeOn = (s: typeof draw.shape) => () => (state.tool === "rect" || state.tool === "polygon") && draw.shape === s;

/** A shape of a given size, typed on the command line, in the middle of the view. */
function addShapeAt(make: (at: { x: number; y: number }) => import("./types").Piece, w: number, hh: number, what: string): void {
  ensureVisible("2d");
  const c = viewCenter();
  const pc = make({ x: Math.round(c.x - w / 2), y: Math.round(c.y - hh / 2) });
  edit((p) => p.pieces.push(pc));
  state.sel = { kind: "piece", piece: pc.id };
  setStatus(`${what} added. Drag its corners or edges to change it.`);
}

function needSelection(kind: "vertex" | "edge", what: string): { piece: string; index: number } | null {
  const s = state.sel;
  if (s.kind === kind) return { piece: s.piece, index: s.index };
  setStatus(
    kind === "vertex"
      ? `${what}: select a corner first. Click a piece in the 2D window, then click one of its points.`
      : `${what}: select a straight edge first. Click a piece in the 2D window, then click one of its edges.`,
  );
  ensureVisible("2d");
  return null;
}

function setLayoutArg(a: string | undefined): boolean {
  const v = (a ?? "").toLowerCase();
  const map: Record<string, Layout> = { "3d": "3d", sim: "3d", simulation: "3d", both: "both", split: "both", pattern: "pattern", "2d": "pattern", flat: "pattern" };
  if (map[v]) {
    setLayout(map[v]);
    return true;
  }
  return false;
}

const VIEWS = ["front", "side", "top", "back", "iso", "home"] as const;

function preset(name: (typeof VIEWS)[number]): void {
  ensureVisible("3d");
  viewPreset(name === "home" ? "iso" : name);
}

function zoom(f: number): void {
  if (hovered === "3d" && visible("3d")) zoom3d(f);
  else if (visible("2d")) zoomBy(f);
  else zoom3d(f);
}

const METALS: Metal[] = ["brass", "nickel", "gunmetal", "copper", "black"];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export const COMMANDS: Command[] = [
  // ================= PATTERN =================
  { id: "select", name: "Select", aliases: ["v", "sel"], icon: "select", keys: ["V"], tab: "pattern", group: "Select", help: "Select and move pieces, points, edges, holes and seams.", run: () => { sim3d.tool = sim3d.tool === "pan" ? "orbit" : sim3d.tool; setTool("select"); }, active: tool2d("select") },
  { id: "cut", name: "Cut", icon: "cut", keys: ["Ctrl+X"], tab: "edit", group: "Clipboard", help: "Cut the selected pieces to the clipboard.", run: () => cutSelection(), enabled: hasPiece },
  { id: "copy", name: "Copy", icon: "copy", keys: ["Ctrl+C"], tab: "edit", group: "Clipboard", help: "Copy the selected pieces.", run: () => copySelection(), enabled: hasPiece },
  { id: "paste", name: "Paste", icon: "paste", keys: ["Ctrl+V"], tab: "edit", group: "Clipboard", help: "Paste copied pieces.", run: () => pasteClipboard() },
  { id: "selectall", name: "Select all", word: "SelectAll", aliases: ["selall", "all"], icon: "selectall", keys: ["Ctrl+A"], tab: "pattern", group: "Select", help: "Select every piece.", run: () => { ensureVisible("2d"); selectAll(); } },
  { id: "undo", simpleLabel: "Undo", name: "Undo", aliases: ["u"], icon: "undo", keys: ["Ctrl+Z"], tab: "edit", group: "Undo", repeat: false, help: "Undo the last change.", run: () => undo() },
  { id: "redo", simpleLabel: "Redo", name: "Redo", icon: "redo", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], tab: "edit", group: "Undo", repeat: false, help: "Redo what was undone.", run: () => redo() },
  { id: "cancel", name: "Cancel", aliases: ["esc", "deselect", "none"], icon: "cancel", keys: ["Esc"], tab: "pattern", group: "Select", ribbon: "none", repeat: false, help: "Stop drawing, close dialogs, deselect and go back to Select.", run: () => cancelAll() },

  {
    id: "rect", name: "Rectangle", aliases: ["r", "rect", "box"], icon: "rect", keys: ["R"], tab: "pattern", group: "Create", args: "[width height]",
    simpleLabel: "Rectangle",
    help: "Click two corners (or drag). While drawing, type the width and press Enter, then the height. Rectangle 80 50 adds one straight away.",
    run: (a) => { const w = parseLen(a[0]); const hh = parseLen(a[1] ?? a[0]); if (w && hh) addRect(w, hh); else startShape("rect"); },
    active: shapeOn("rect"),
  },
  {
    id: "polygon", name: "Draw freely", short: "Draw freely", simpleLabel: "Draw freely", word: "Pen", aliases: ["p", "poly", "polygon", "polyline", "outline", "freehand"], icon: "pen", keys: ["P"], tab: "pattern", group: "Create", args: "[sides size]",
    help: "Click each corner of the piece in turn; drag while clicking to make a curve. Click the first point or press Enter to finish. Type a length and Enter for an exact side. Polygon 6 80 makes a regular six-sided piece.",
    run: (a) => { const n = num(a[0]); const s = parseLen(a[1]); if (n && s) addRegularPolygon(n, s); else startShape("pen"); },
    active: shapeOn("pen"),
  },
  {
    id: "roundrect", name: "Rounded rectangle", short: "Rounded", simpleLabel: "Rounded", word: "RoundedRect", aliases: ["rrect", "rounded"], icon: "roundrect", keys: ["U"], tab: "pattern", group: "Create", args: "[width height radius]",
    help: "Like Rectangle, with rounded corners (6 mm unless you type r and a size while drawing, for example r10). RoundedRect 80 50 6 adds one straight away.",
    run: (a) => {
      const w = parseLen(a[0]);
      if (!w) return startShape("roundrect");
      ensureVisible("2d");
      const hh = parseLen(a[1]) ?? w;
      const r = parseLen(a[2]) ?? draw.radiusMm;
      const c = viewCenter();
      const pc = roundedRectPiece({ x: Math.round(c.x - w / 2), y: Math.round(c.y - hh / 2) }, w, hh, Math.min(r, w / 2, hh / 2), "Rounded panel");
      edit((p) => p.pieces.push(pc));
      state.sel = { kind: "piece", piece: pc.id };
      setStatus(`Rounded panel ${w} × ${hh} mm added.`);
    },
    active: shapeOn("roundrect"),
  },
  {
    id: "circle", name: "Circle", aliases: ["c", "disc", "disk"], icon: "circle", keys: ["C"], tab: "pattern", group: "Create", args: "[across]",
    simpleLabel: "Circle",
    help: "Click the middle, then move out and click. Or type how wide it is across and press Enter. Circle 60 adds one straight away.",
    run: (a) => { const d = parseLen(a[0]); if (d) addShapeAt((at) => ovalPiece(at, d, d, "Circle"), d, d, `Circle ${d} mm across`); else startShape("circle"); },
    active: shapeOn("circle"),
  },
  {
    id: "oval", name: "Oval", aliases: ["ellipse", "ell"], icon: "ellipse", keys: ["Shift+E"], tab: "pattern", group: "Create", ribbon: "small", args: "[width height]",
    help: "Click two corners of the box the oval fills (or drag). Type the width, Enter, then the height. Oval 90 60 adds one straight away.",
    run: (a) => { const w = parseLen(a[0]); const hh = parseLen(a[1] ?? a[0]); if (w && hh) addShapeAt((at) => ovalPiece(at, w, hh, "Oval"), w, hh, `Oval ${w} × ${hh} mm`); else startShape("oval"); },
    active: shapeOn("oval"),
  },
  {
    id: "mirrorhalf", name: "Mirror half", short: "Mirror half", word: "MirrorHalf", aliases: ["half", "symmetric", "symmetry", "halfpiece"], icon: "mirrorhalf", keys: ["Shift+M"], tab: "pattern", group: "Create", ribbon: "small",
    help: "Draw one half of a piece beside a centre line and the other half is copied across, so both sides match exactly. Click on the centre line to start and again to finish.",
    run: () => startShape("mirror"),
    active: shapeOn("mirror"),
  },
  {
    id: "slotshape", name: "Slot shape", short: "Slot", word: "SlotShape", aliases: ["stadium", "pill", "keeper", "loop"], icon: "slot", keys: ["Shift+U"], tab: "pattern", group: "Create", ribbon: "small", args: "[length width]",
    help: "A long piece with both ends fully round, such as a keeper or a belt loop. Click two corners, or type the length and width. SlotShape 60 15 adds one straight away.",
    run: (a) => { const w = parseLen(a[0]); const hh = parseLen(a[1]); if (w && hh) addShapeAt((at) => slotPiece(at, w, hh, "both", "Slot"), w, hh, `Slot ${w} × ${hh} mm`); else startShape("slot"); },
    active: shapeOn("slot"),
  },
  {
    id: "strapend", name: "Strap end", word: "StrapEnd", aliases: ["tip", "strapend", "billet"], icon: "strapend", keys: ["Shift+N"], tab: "pattern", group: "Create", ribbon: "small", args: "[round|point] [length width]",
    help: "A strap with one square end and one shaped end, round or pointed. StrapEnd point draws a pointed one; StrapEnd round 200 25 adds one straight away.",
    run: (a) => {
      const words = a.filter((x) => /^(round|point|pointed)$/i.test(x));
      if (words.length) draw.ends = /^p/i.test(words[0]) ? "point" : "round";
      const nums = a.filter((x) => !words.includes(x));
      const w = parseLen(nums[0]);
      const hh = parseLen(nums[1]);
      if (w && hh) return addShapeAt((at) => slotPiece(at, w, hh, draw.ends, "Strap end"), w, hh, `Strap end ${w} × ${hh} mm`);
      startShape("strapend");
      setStatus(`Strap end (${draw.ends === "point" ? "pointed" : "round"}): click two corners, or type the length and width. Type StrapEnd ${draw.ends === "point" ? "round" : "point"} for the other kind.`);
    },
    active: shapeOn("strapend"),
  },
  {
    id: "strap", name: "Strap or belt", short: "Strap", word: "Strap", aliases: ["belt"], icon: "strap", tab: "pattern", group: "Create", args: "[length width]",
    help: "Open the strap builder (tip, holes, buckle end). Strap 600 25 adds one straight away.",
    run: async (a) => {
      const l = parseLen(a[0]);
      if (l) {
        ensureVisible("2d");
        const id = await addStrap({ name: "Strap", lengthMm: l, widthMm: parseLen(a[1]) ?? 25, holes: 0, buckleEnd: false });
        state.sel = { kind: "piece", piece: id };
        setStatus(`Strap ${l} mm added.`);
        return;
      }
      panel.special = "strap";
      setStatus("Strap builder: set it up in the properties panel on the right, then Make strap.");
    },
    active: () => panel.special === "strap",
  },
  { id: "bag", name: "Bag builder", short: "Bag", word: "Bag", aliases: ["bagbuilder"], icon: "bag", tab: "pattern", group: "Create", help: "Build a complete bag to your sizes, with seams and hardware placed.", run: () => { panel.special = "bag"; setStatus("Bag builder: choose a style and sizes in the properties panel."); }, active: () => panel.special === "bag" },
  { id: "template", simpleLabel: "New project", name: "New project", short: "New", word: "New", aliases: ["template", "templates", "open-template", "welcome"], icon: "template", keys: ["Ctrl+N"], tab: "file", group: "New", args: "[pattern name]", help: "What would you like to make? Pick a picture of it. New tote opens the tote straight away.", run: (a) => (a.length ? newFromName(a.join(" ")) : showWelcome()) },
  { id: "import", name: "Bring in a pattern…", short: "Bring in", simpleLabel: "Bring in a pattern", word: "Import", aliases: ["trace", "importpattern", "bringin"], icon: "import", tab: "pattern", group: "Create", help: "Bring in a pattern you already have: a drawing (SVG, DXF or PDF) or a photo of a paper template, at its true size.", run: () => openImport() },
  { id: "gallery", name: "All patterns in one list", short: "All patterns", word: "Patterns", aliases: ["gallery"], icon: "catalog", tab: "file", group: "New", help: "Every starter pattern on one page, by kind, with a search box.", run: () => showTemplates() },
  { id: "size", simpleLabel: "Change the size", name: "Change the size", short: "Size", word: "Size", aliases: ["resize", "scale", "dimensions"], icon: "resize", tab: "pattern", group: "Modify", help: "Make the whole thing (or one piece) wider, narrower, taller or shorter by typing the size you want. Seams keep matching.", run: () => openSizes(), active: () => panel.special === "size" },

  { id: "mirror", name: "Mirror piece", short: "Mirror", word: "Mirror", aliases: ["mir"], icon: "mirror", keys: ["Shift+X"], tab: "pattern", group: "Modify", help: "Mirror the selected pieces left to right.", run: () => mirrorSelected("x"), enabled: hasPiece },
  { id: "rotate", name: "Rotate 90°", short: "Rotate", word: "Rotate", aliases: ["rot"], icon: "rotate", keys: ["Shift+R"], tab: "pattern", group: "Modify", args: "[ccw]", help: "Turn the selected pieces a quarter turn clockwise (Rotate ccw turns the other way).", run: (a) => rotateSelected(!/^(ccw|-90|left)$/i.test(a[0] ?? "")), enabled: hasPiece },
  { id: "duplicate", name: "Duplicate", aliases: ["dup", "copypiece"], icon: "duplicate", keys: ["Ctrl+D"], tab: "pattern", group: "Modify", ribbon: "none", help: "Make a copy of the selected pieces next to them.", run: () => duplicateSelected(), enabled: hasPiece },
  {
    id: "round", name: "Round corner", short: "Round", word: "Round", aliases: ["fillet", "roundcorner"], icon: "roundcorner", keys: ["Shift+C"], tab: "pattern", group: "Modify", args: "[radius]",
    help: "Round the selected corner point (8 mm unless typed: Round 12).",
    run: (a) => { const s = needSelection("vertex", "Round corner"); if (s) void roundCornerAt(s.piece, s.index, parseLen(a[0]) ?? 8); },
    enabled: () => state.sel.kind === "vertex",
  },
  {
    id: "edgelength", name: "Edge length", short: "Length", word: "EdgeLength", aliases: ["length", "len", "sidelength"], icon: "edgelength", keys: ["Shift+L"], tab: "pattern", group: "Modify", ribbon: "small", args: "[length]",
    help: "Give the selected edge an exact length: EdgeLength 120. Or click an edge and type in the box beside it. A level or upright edge stretches the piece so it stays square.",
    run: (a) => {
      const s = needSelection("edge", "Edge length");
      if (!s) return;
      const l = parseLen(a[0]);
      if (!l) return void (focusEdgeLength() && setStatus("Type the length in the box beside the edge, then press Enter."));
      const pc = piece(s.piece);
      if (pc) edit(() => setEdgeLength(pc, s.index, l));
      setStatus(`The edge is now ${a[0]} long. Ctrl+Z takes it back.`);
    },
    enabled: () => state.sel.kind === "edge",
  },
  {
    id: "edgeangle", name: "Edge angle", short: "Angle", word: "EdgeAngle", aliases: ["direction", "sideangle"], icon: "edgeangle", keyHint: "Shift+L, then Tab", tab: "pattern", group: "Modify", ribbon: "none", args: "degrees",
    help: "Turn the selected edge about its start to an exact angle: EdgeAngle 90 (0 is level to the right, 90 straight up).",
    run: (a) => {
      const s = needSelection("edge", "Edge angle");
      if (!s) return;
      const d = num(a[0]);
      if (d === null) return setStatus("Type the angle after the command, for example EdgeAngle 45.");
      const pc = piece(s.piece);
      if (pc) edit(() => setEdgeAngle(pc, s.index, d));
      setStatus(`The edge now points at ${d}°. Ctrl+Z takes it back.`);
    },
    enabled: () => state.sel.kind === "edge",
  },
  {
    id: "addpoint", name: "Add a point", short: "Add point", word: "AddPoint", aliases: ["insertpoint", "split", "addcorner"], icon: "addpoint", keys: ["Shift+A"], tab: "pattern", group: "Modify", ribbon: "small", keyHint: "or double-click an edge",
    help: "Add a point in the middle of the selected edge, to drag into a new corner. Double-clicking an edge does the same where you click.",
    run: () => {
      const s = needSelection("edge", "Add a point");
      const pc = s && piece(s.piece);
      if (!s || !pc) return;
      let idx = 0;
      edit((p) => (idx = insertVertex(p, pc, s.index, edgeMiddle(pc, s.index))));
      state.sel = { kind: "vertex", piece: s.piece, index: idx };
      setStatus("Added a point. Drag it, or press Delete to remove it.");
    },
    enabled: () => state.sel.kind === "edge",
  },
  {
    id: "deletepoint", name: "Delete point", short: "Delete point", word: "DeletePoint", aliases: ["removepoint", "deletecorner"], icon: "deletepoint", keyHint: "Del", tab: "pattern", group: "Modify", ribbon: "small", repeat: false,
    help: "Remove the selected point; the edges either side join into one straight edge.",
    run: () => { if (needSelection("vertex", "Delete point")) deleteSelected(); },
    enabled: () => state.sel.kind === "vertex",
  },
  {
    id: "curveedge", name: "Curve or straighten edge", short: "Curve", word: "Curve", aliases: ["bend", "straighten", "curveedge"], icon: "curveedge", keys: ["Shift+B"], tab: "pattern", group: "Modify", ribbon: "small", keyHint: "or drag the round handle",
    help: "Make the selected edge a gentle curve, or a curve straight again. You can also drag the round handle in the middle of any edge to bend it.",
    run: () => {
      const s = needSelection("edge", "Curve");
      const pc = s && piece(s.piece);
      if (!s || !pc) return;
      edit(() => toggleCurve(pc, s.index));
      setStatus(pc.edges[s.index].type === "cubic" ? "The edge is curved. Drag its round handle to shape it." : "The edge is straight.");
    },
    enabled: () => state.sel.kind === "edge",
  },
  {
    id: "dart", name: "Add dart", short: "Dart", word: "Dart", icon: "dart", keys: ["Shift+D"], tab: "pattern", group: "Modify", args: "[width depth]",
    help: "Add a dart to the middle of the selected straight edge (20 × 40 mm unless typed).",
    run: (a) => { const s = needSelection("edge", "Dart"); if (s) void addDartAt(s.piece, s.index, parseLen(a[0]) ?? 20, parseLen(a[1]) ?? 40); },
    enabled: () => state.sel.kind === "edge",
  },
  { id: "merge", name: "Merge pieces", short: "Merge", word: "Merge", aliases: ["union", "combine"], icon: "merge", keys: ["Ctrl+J"], tab: "pattern", group: "Modify", help: "Merge the selected pieces into one: along the seam between them, or as a union where they overlap or touch.", run: () => mergeSelected(), enabled: many(2) },
  { id: "flip", name: "Flip piece", short: "Flip", word: "Flip", icon: "flip", keys: ["Shift+Y"], tab: "pattern", group: "Modify", ribbon: "none", help: "Flip the selected pieces top to bottom.", run: () => mirrorSelected("y"), enabled: hasPiece },
  { id: "delete", name: "Delete", aliases: ["del", "erase", "remove"], icon: "delete", keys: ["Del", "Backspace"], tab: "pattern", group: "Modify", ribbon: "none", repeat: false, help: "Delete the selection: a piece, point, hole, fold, seam, hardware or mark.", run: () => deleteSelected(), enabled: () => state.sel.kind !== "none" && state.sel.kind !== "material" },
  {
    id: "nudge", name: "Nudge", aliases: ["shift", "offset"], icon: "nudge", keyHint: "Arrows (Shift ×10)", tab: "pattern", group: "Modify", ribbon: "none", args: "dx dy",
    help: "Move the selected pieces a little: arrow keys, or type Nudge 10 0.",
    run: (a) => { const dx = parseLen(a[0]); const dy = parseLen(a[1]) ?? 0; if (dx === null) return setStatus("Nudge: use the arrow keys (Shift for ×10), or type Nudge 10 0."); nudgeSelected(dx, dy); },
    enabled: hasPiece,
  },

  {
    id: "align", name: "Align pieces", short: "Align", word: "Align", icon: "align", tab: "pattern", group: "Arrange", ribbon: "small", args: "[left|centre|right|top|middle|bottom]",
    help: "Line up the selected pieces (two or more). Align top, Align centre…",
    run: (a) => {
      const v = (a[0] ?? "left").toLowerCase();
      const map: Record<string, AlignTo> = { left: "left", l: "left", centre: "centre", center: "centre", c: "centre", right: "right", r: "right", top: "top", t: "top", middle: "middle", m: "middle", bottom: "bottom", b: "bottom" };
      if (map[v]) alignSelected(map[v]);
      else setStatus("Align left, centre, right, top, middle or bottom.");
    },
    enabled: many(2),
  },
  { id: "align-left", name: "Align left", word: "AlignLeft", icon: "alignleft", tab: "pattern", group: "Arrange", ribbon: "none", help: "Align left of the selected pieces.", run: () => alignSelected("left"), enabled: many(2) },
  { id: "align-centre", name: "Align centres", word: "AlignCentre", icon: "aligncentre", tab: "pattern", group: "Arrange", ribbon: "none", help: "Align centres of the selected pieces.", run: () => alignSelected("centre"), enabled: many(2) },
  { id: "align-right", name: "Align right", word: "AlignRight", icon: "alignright", tab: "pattern", group: "Arrange", ribbon: "none", help: "Align right of the selected pieces.", run: () => alignSelected("right"), enabled: many(2) },
  { id: "align-top", name: "Align top", word: "AlignTop", icon: "aligntop", tab: "pattern", group: "Arrange", ribbon: "none", help: "Align top of the selected pieces.", run: () => alignSelected("top"), enabled: many(2) },
  { id: "align-middle", name: "Align middles", word: "AlignMiddle", icon: "alignmiddle", tab: "pattern", group: "Arrange", ribbon: "none", help: "Align middles of the selected pieces.", run: () => alignSelected("middle"), enabled: many(2) },
  { id: "align-bottom", name: "Align bottom", word: "AlignBottom", icon: "alignbottom", tab: "pattern", group: "Arrange", ribbon: "none", help: "Align bottom of the selected pieces.", run: () => alignSelected("bottom"), enabled: many(2) },
  { id: "distribute", name: "Space evenly", short: "Distribute", word: "Distribute", aliases: ["space", "spread"], icon: "distribute", tab: "pattern", group: "Arrange", ribbon: "small", args: "[x|y]", help: "Space three or more selected pieces evenly across (Distribute x) or down (Distribute y).", run: (a) => distributeSelected(/^(y|v|down|vertical)/i.test(a[0] ?? "") ? "y" : "x"), enabled: many(3) },
  { id: "distribute-y", name: "Space evenly down", word: "DistributeY", icon: "distributey", tab: "pattern", group: "Arrange", ribbon: "none", help: "Space three or more selected pieces evenly from top to bottom.", run: () => distributeSelected("y"), enabled: many(3) },

  { id: "fold", name: "Fold line", short: "Fold", word: "Fold", aliases: ["f"], icon: "fold", keys: ["F"], tab: "pattern", group: "Fold", help: "Click a piece where it folds. Hidework adds the little extra length the outside of the bend needs (the fold allowance).", run: () => setTool("fold"), active: tool2d("fold") },
  {
    id: "folddir", name: "Fold direction", word: "FoldDirection", aliases: ["folddir"], icon: "folddir", keys: ["Shift+F"], tab: "pattern", group: "Fold", ribbon: "small", args: "[h|v]",
    help: "Switch new folds between across (horizontal) and down (vertical).",
    run: (a) => {
      const v = (a[0] ?? "").toLowerCase();
      state.foldOrientation = v.startsWith("h") ? "horizontal" : v.startsWith("v") ? "vertical" : state.foldOrientation === "horizontal" ? "vertical" : "horizontal";
      setTool("fold");
      setStatus(`New folds run ${state.foldOrientation === "horizontal" ? "across (horizontal)" : "down (vertical)"}. Click a piece to fold it.`);
    },
  },
  { id: "measure", name: "Measure", aliases: ["m", "dist", "ruler"], icon: "measure", keys: ["M"], tab: "pattern", group: "Inspect", help: "Drag between points or holes to measure; Shift measures freely.", run: () => setTool("measure"), active: tool2d("measure") },
  { id: "check", name: "Check my pattern", short: "Check", simpleLabel: "Check my pattern", word: "Check", aliases: ["checker", "validate", "problems"], icon: "check", tab: "pattern", group: "Inspect", help: "Look the pattern over for problems before you cut leather, such as seams whose lengths do not match.", run: () => openChecker() },
  { id: "snap", name: "Grid snap", short: "Snap", word: "Snap", aliases: ["gridsnap"], icon: "snap", keys: ["F9"], tab: "view", group: "Grid", args: "[on|off]", help: "Snap moved pieces, points, holes and hardware to the grid.", run: (a) => toggleSnap(a[0] ? /^(on|1|yes)$/i.test(a[0]) : !snap.on), active: () => snap.on },
  {
    id: "grid", name: "Grid size", word: "Grid", aliases: ["gridsize"], icon: "grid", tab: "view", group: "Grid", ribbon: "field", args: "mm",
    help: "Grid snap spacing in mm. Grid 5 turns snap on at 5 mm.",
    field: { kind: "number", get: () => snap.gridMm, set: (v) => { const n = parseFloat(v); if (Number.isFinite(n) && n > 0) { setSnapGrid(n); notify(); } }, unit: "mm", min: 0.5, step: 0.5 },
    run: (a) => { const n = parseLen(a[0]); if (!n) return setStatus(`Grid is ${snap.gridMm} mm. Type Grid 5 to change it.`); setSnapGrid(n); toggleSnap(true); },
  },
  {
    id: "smartsnap", name: "Smart snap", short: "Smart snap", simpleLabel: "Snapping", word: "SmartSnap", aliases: ["osnap", "objectsnap", "snapping", "guides"], icon: "snapobjects", keys: ["F10"], tab: "view", group: "Grid", args: "[on|off]",
    help: "While you draw or drag, points jump to other pieces' corners and edges and line up with them; a small marker and a word show what caught. Hold Shift for 15° steps, Alt to place freely. Click to turn it off or on.",
    run: (a) => {
      const on = a[0] ? /^(on|1|yes)$/i.test(a[0]) : !smart.on;
      setSmartSnap(on);
      setStatus(on ? "Smart snap is on: points jump to corners and edges and line up, with a marker to show it. Hold Alt to place freely." : "Smart snap is off. Points go where you put them (and to the grid when grid snap is on).");
    },
    active: () => smart.on,
  },

  // ================= SEW =================
  { id: "sew", name: "Sew", word: "Sew", aliases: ["s", "j", "seam", "segment"], icon: "sew", keys: ["J"], tab: "sew", group: "Sew", help: "Sew two edges together: click an edge, then the edge it sews to.", run: () => setTool("join"), active: tool2d("join") },
  { id: "seams", name: "Show seams", short: "Seams", word: "Seams", aliases: ["joins"], icon: "seams", tab: "sew", group: "Sew", help: "List every seam and whether its lengths and holes match.", run: () => { state.sel = { kind: "none" }; showBrowserTab("seams"); } },
  { id: "stitchtype", name: "Stitch type", short: "Stitch", word: "StitchType", aliases: ["stitch"], icon: "prickingiron", tab: "sew", group: "Stitch", help: "Choose the stitch for the selected piece (saddle, lock, lacing…).", run: () => showLibraryTab("hardware", "stitch") },
  { id: "glueall", name: "Glue every seam", short: "Glue all", word: "GlueAll", aliases: ["glue"], icon: "glue", tab: "sew", group: "All seams", help: "Contact cement on every seam.", run: () => { edit((p) => p.joins.forEach((j) => (j.glue = "contactCement"))); setStatus("Every seam is glued with contact cement."); } },
  { id: "edgeall", name: "Every seam edge to edge", short: "Edge to edge", word: "EdgeToEdge", aliases: ["butt"], icon: "edgetoedge", tab: "sew", group: "All seams", help: "Make every seam an edge-to-edge (flat) seam.", run: () => { edit((p) => p.joins.forEach((j) => (j.construction = "edgeToEdge"))); setStatus("Every seam is edge to edge."); } },
  { id: "turnedall", name: "Every seam turned", short: "Turned", word: "Turned", aliases: ["turn"], icon: "turned", tab: "sew", group: "All seams", help: "Make every seam turned (sewn inside out, then turned).", run: () => { edit((p) => p.joins.forEach((j) => (j.construction = "turned"))); setStatus("Every seam is turned."); } },

  // ================= HARDWARE & FINISH =================
  {
    id: "punch", name: "Punch hole", short: "Punch", word: "Punch", aliases: ["h", "hole"], icon: "punch", keys: ["H"], tab: "finish", group: "Holes", args: "[diameter]",
    help: "Click inside a piece to punch a hole. Punch 4 punches 4 mm holes.",
    run: (a) => {
      const d = parseLen(a[0]);
      placing.hardware = d ? { label: `Punch ${d} mm`, diameterMm: d, lengthMm: 0 } : null;
      setTool("hole");
      if (d) setStatus(`Click a piece to punch a ${d} mm hole.`);
    },
    active: tool2d("hole"),
  },
  { id: "hardware", name: "Set hardware", short: "Hardware", word: "Hardware", aliases: ["k", "hw", "rivet", "snap-button"], icon: "hardware", keys: ["K"], tab: "finish", group: "Hardware", help: "Pick rivets, snaps, buckles or rings in the library, then click a piece.", run: () => { setTool("hardware"); showLibraryTab("hardware", "hardware"); }, active: tool2d("hardware") },
  { id: "mark", name: "Surface work", short: "Surface", word: "Surface", aliases: ["e", "mark", "emboss", "engrave", "paint"], icon: "stamp", keys: ["E"], tab: "finish", group: "Surface", help: "Stamp, tool, emboss, engrave, paint or perforate: pick it, then click a piece.", run: () => { setTool("mark"); showLibraryTab("hardware", "surface"); }, active: tool2d("mark") },
  { id: "tooling", name: "Tooling", short: "Tooling", simpleLabel: "Decorate", word: "Tooling", aliases: ["carve", "tool", "decorate", "carving"], icon: "tooling", tab: "finish", group: "Tooling", args: "[tool or design]", help: "Carve and stamp the leather: swivel knife cuts, beveling, backgrounding, shading, letters, or a ready-made design. Tooling flower opens the flower design.", run: (a) => (a.length ? startTooling(a.join(" ")) : openTooling()), active: tool2d("tooling") },
  { id: "knife", name: "Swivel knife", short: "Knife", word: "Knife", aliases: ["swivelknife", "swivel"], icon: "swivelknife", tab: "finish", group: "Tooling", ribbon: "small", help: "Draw cut lines on a piece, as with a swivel knife.", run: () => startTooling("swivelKnife"), active: () => state.tool === "tooling" && tooling.tool === "swivelKnife" && !tooling.design },
  { id: "bevel", name: "Beveler", short: "Bevel", word: "Bevel", aliases: ["beveler", "beveller"], icon: "beveler", tab: "finish", group: "Tooling", ribbon: "small", help: "Walk the beveler beside a cut so the design stands up.", run: () => startTooling("beveler"), active: () => state.tool === "tooling" && tooling.tool === "beveler" && !tooling.design },
  { id: "letters", name: "Letter stamps", short: "Letters", word: "Letters", aliases: ["alphabet", "lettering"], icon: "letterstamp", tab: "finish", group: "Tooling", ribbon: "small", help: "Stamp letters and numbers onto a piece.", run: () => startTooling("letter"), active: () => state.tool === "tooling" && tooling.tool === "letter" && !tooling.design },
  ...DESIGNS.map(
    (d): Command => ({ id: `design-${d.design}`, name: `${d.name} design`, short: d.name, word: `Design${d.design[0].toUpperCase()}${d.design.slice(1)}`, icon: `design-${d.design}`, tab: "finish", group: "Designs", ribbon: "small", help: `Ready-made tooling. ${d.says}`, run: () => startTooling(`design:${d.design}`), active: () => state.tool === "tooling" && tooling.design === d.design }),
  ),
  { id: "edgefinish", name: "Edge finish", short: "Edges", word: "EdgeFinish", aliases: ["burnish", "edges"], icon: "burnisher", tab: "finish", group: "Edges", help: "Burnish, paint, turn or bind the edges of the selected piece.", run: () => showLibraryTab("hardware", "edges") },
  ...METALS.map(
    (m): Command => ({ id: `metal-${m}`, name: `${cap(m)} hardware`, short: cap(m), word: cap(m), icon: `metal-${m}`, tab: "finish", group: "Metal", ribbon: "small", help: `Draw the hardware in ${m} in 3D.`, run: () => setMetal(m), active: () => sim3d.metal === m }),
  ),
  { id: "metal", name: "Hardware metal", word: "Metal", icon: "metal", tab: "finish", group: "Metal", ribbon: "none", args: METALS.join("|"), help: "Hardware colour in 3D: Metal nickel.", run: (a) => { const m = (a[0] ?? "").toLowerCase() as Metal; if (METALS.includes(m)) setMetal(m); else setStatus(`Metal: one of ${METALS.join(", ")}.`); } },

  // ================= SIMULATE =================
  { id: "simulate", name: "Simulate", aliases: ["sim", "run", "play", "pause"], icon: "simulate", keys: ["Space"], tab: "simulate", group: "Simulate", help: "Start or pause the 3D simulation.", run: () => toggleSim(), active: () => sim3d.running },
  {
    id: "see3d", name: "See it in 3D", simpleLabel: "See it in 3D", word: "See3D", aliases: ["3d", "preview"], icon: "see3d", tab: "simulate", group: "Simulate", ribbon: "none",
    help: "Show the 3D window and let the leather settle, as if you had made it. Click again to pause.",
    run: async () => {
      ensureVisible("3d");
      if (sim3d.running) return toggleSim();
      if (!sim3d.info || needsRebuild()) await rebuild();
      toggleSim();
      setStatus("This is your piece in 3D. Drag the leather to pull it. Click See it in 3D again to pause.");
    },
    active: () => sim3d.running,
  },
  { id: "reset", name: "Start over in 3D", short: "Start over", word: "Reset", icon: "reset", keys: ["Shift+Space"], tab: "simulate", group: "Simulate", help: "Put the pieces back where they started, keeping pins and objects.", run: () => { ensureVisible("3d"); void resetSim(); } },
  { id: "rebuild", name: "Rebuild from pattern", short: "Rebuild", word: "Rebuild", icon: "rebuild", keys: ["Ctrl+B"], tab: "simulate", group: "Simulate", help: "Rebuild the 3D piece from the current pattern.", run: () => { ensureVisible("3d"); void rebuild(); } },
  { id: "pull", name: "Move / pull", short: "Pull", word: "Pull", aliases: ["g", "move", "drag", "grab"], icon: "pull", keys: ["G"], tab: "simulate", group: "Interact", help: "Drag the leather to pull it; Shift+drag moves a whole piece.", run: () => setTool3d("move"), active: tool3d("move") },
  { id: "pin", name: "Pin", aliases: ["i", "nail"], icon: "pin", keys: ["I"], tab: "simulate", group: "Interact", help: "Click the leather to pin it in place.", run: () => setTool3d("pin"), active: tool3d("pin") },
  {
    id: "weight", name: "Hang a weight", short: "Weight", word: "Weight", aliases: ["w", "load"], icon: "weight", keys: ["W"], tab: "simulate", group: "Interact", args: "[grams]",
    help: "Click the leather to hang a weight from it. Weight 500 uses 500 g.",
    field: { kind: "number", get: () => sim3d.weightGrams, set: (v) => (sim3d.weightGrams = Math.max(1, parseFloat(v) || 100)), unit: "g", min: 1, step: 50 },
    run: (a) => { const g = num(a[0]); if (g) sim3d.weightGrams = Math.max(1, g); setTool3d("weight", !g); if (g) setStatus(`Click the leather to hang ${sim3d.weightGrams} g.`); },
    active: tool3d("weight"),
  },
  {
    id: "object", name: "Drop object", short: "Object", word: "Object", aliases: ["o"], icon: "object", keys: ["O"], tab: "simulate", group: "Interact", args: `[${Object.keys(OBJECT_PRESETS).join("|")}]`,
    help: "Click in 3D to drop the chosen object (cards, phone, bottle…).",
    run: (a) => { if (a[0] && OBJECT_PRESETS[a[0].toLowerCase()]) sim3d.objectPreset = a[0].toLowerCase(); setTool3d("object", !a[0]); showLibraryTab("scene"); },
    active: tool3d("object"),
  },
  {
    id: "drop", name: "Drop in the middle", short: "Drop", word: "Drop", icon: "drop", keys: ["Shift+O"], tab: "simulate", group: "Interact", ribbon: "small", args: "[object]",
    help: "Drop the chosen object onto the middle of the piece.",
    run: async (a) => {
      ensureVisible("3d");
      const k = a[0]?.toLowerCase();
      if (k && OBJECT_PRESETS[k]) sim3d.objectPreset = k;
      if (!sim3d.info) await rebuild();
      try { await dropObject(sim3d.objectPreset, null); } catch (e) { setStatus(String(e)); }
    },
  },
  { id: "stress", name: "Stress map", short: "Stress", word: "Stress", aliases: ["heat", "heatmap"], icon: "stress", keys: ["Shift+S"], tab: "simulate", group: "Display", help: "Colour the leather by how hard it is stretched.", run: () => { ensureVisible("3d"); setHeat(!sim3d.heat); }, active: () => sim3d.heat },
  { id: "stitches", name: "Show stitches", short: "Stitches", word: "Stitches", aliases: ["thread"], icon: "stitches", keys: ["Shift+T"], tab: "simulate", group: "Display", help: "Show or hide the stitching in 3D.", run: () => { sim3d.stitches = !sim3d.stitches; notify(); }, active: () => sim3d.stitches },
  {
    id: "foldangle", name: "Fold angle", word: "FoldAngle", aliases: ["angle"], icon: "foldangle", tab: "simulate", group: "Display", ribbon: "field", args: "degrees",
    help: "How far folds start closed in 3D (180 = folded flat).",
    field: { kind: "range", get: () => sim3d.foldAngle, set: (v) => { sim3d.foldAngle = parseInt(v, 10); void rebuild(); }, unit: "°", min: 0, max: 180, step: 5 },
    run: (a) => { const d = num(a[0]); if (d === null) return setStatus(`Folds start ${sim3d.foldAngle}° closed. Type FoldAngle 90 to change it.`); sim3d.foldAngle = Math.max(0, Math.min(180, d)); void rebuild(); },
  },
  {
    id: "props", name: "Props", word: "Props", aliases: ["prop", "table", "pedestal", "hook"], icon: "props", tab: "simulate", group: "Scene", args: "[floor|table|pedestal|bar]",
    help: "Put a table, pedestal or hook bar under the piece (Library › Scene).",
    run: (a) => { const k = (a[0] ?? "").toLowerCase(); const kinds: Record<string, PropKind> = { floor: "floor", table: "table", pedestal: "pedestal", stand: "pedestal", bar: "bar", hook: "bar" }; if (kinds[k]) void applyProp(kinds[k]); else showLibraryTab("scene"); },
  },
  { id: "fabrictest", name: "Fabric test", short: "Fabric test", word: "FabricTest", aliases: ["drape"], icon: "fabrictest", tab: "simulate", group: "Material", help: "Test how a leather drapes and bends, and calibrate it.", run: () => openFabricTest(state.sel.kind === "material" ? state.sel.id : undefined) },
  { id: "fabrics", name: "Edit fabrics", short: "Fabrics", word: "Fabrics", aliases: ["materials", "leather"], icon: "fabric", tab: "simulate", group: "Material", help: "Edit the project's leathers and linings and their physics.", run: () => { const m = state.project.materials[0]; if (m) state.sel = { kind: "material", id: m.id }; showBrowserTab("fabrics"); } },

  // ================= OUTPUT =================
  { id: "print", simpleLabel: "Print", name: "Print template", short: "Print", word: "Print", icon: "print", keys: ["Ctrl+P"], tab: "output", group: "Print", help: "Open the true-scale template in your PDF viewer to print at 100%.", run: () => void print() },
  {
    id: "paper", name: "Paper size", word: "Paper", aliases: ["page"], icon: "paper", tab: "output", group: "Print", ribbon: "field", args: "letter|a4",
    help: "Paper size for printing and PDF export.",
    field: { kind: "select", get: () => state.page, set: (v) => { state.page = v as PageSize; changed(); }, options: [["letter", "Letter"], ["a4", "A4"]] },
    run: (a) => { const v = (a[0] ?? "").toLowerCase(); if (v === "letter" || v === "a4") { state.page = v; changed(); setStatus(`Paper: ${v === "a4" ? "A4" : "Letter"}.`); } else setStatus("Paper letter or Paper a4."); },
  },
  { id: "pdf", name: "Export PDF", short: "PDF", word: "PDF", aliases: ["exportpdf"], icon: "pdf", keys: ["Ctrl+E"], tab: "output", group: "Export", help: "Save the tiled true-scale template as a PDF.", run: () => void exportFile("pdf") },
  { id: "svg", name: "Export SVG sheet", short: "SVG", word: "SVG", aliases: ["exportsvg"], icon: "svg", tab: "output", group: "Export", help: "Save the pattern as one SVG sheet.", run: () => void exportFile("svg") },
  { id: "laser", name: "Laser-cut the template", short: "Laser", word: "Laser", aliases: ["lasersvg"], icon: "laser", tab: "output", group: "Export", help: "SVG for a laser: red cuts, blue scores, black engraves.", run: () => fabDialog("laser") },
  { id: "dxf", name: "DXF for laser or CNC", short: "DXF", word: "DXF", icon: "dxf", tab: "output", group: "Export", help: "DXF with cut, score and engrave layers.", run: () => fabDialog("dxf") },
  { id: "stl", name: "3D-print a stencil (STL)", short: "STL", word: "STL", aliases: ["stencil"], icon: "stl", tab: "output", group: "Export", help: "A flat plate of each piece with every hole through it.", run: () => fabDialog("stl") },
  {
    id: "export", name: "Export", icon: "export", tab: "output", group: "Export", ribbon: "none", args: "pdf|svg|laser|dxf|stl|png3d|png2d",
    help: "Export by kind: Export dxf.",
    run: (a) => { const k = (a[0] ?? "").toLowerCase(); if (k === "laser" || k === "dxf" || k === "stl") fabDialog(k); else if (["pdf", "svg", "png3d", "png2d"].includes(k)) void exportFile(k as ExportKind); else setStatus("Export pdf, svg, laser, dxf, stl, png3d or png2d."); },
  },
  { id: "png3d", name: "Save 3D image", short: "3D image", word: "Image3D", aliases: ["screenshot", "capture"], icon: "image3d", tab: "output", group: "Image", help: "Save the 3D window as a PNG.", run: () => void exportFile("png3d") },
  { id: "png2d", name: "Save pattern image", short: "Pattern image", word: "ImagePattern", aliases: ["image2d"], icon: "image", tab: "output", group: "Image", help: "Save the pattern window as a PNG.", run: () => void exportFile("png2d") },

  { id: "hidelayout", name: "How many can I make?", short: "Leather & cost", simpleLabel: "How many can I make?", word: "HideLayout", aliases: ["hide", "layout", "cost", "howmany", "nest"], icon: "hidelayout", tab: "output", group: "Leather", help: "Lay the pieces out on your own hide (marking any flaws), see how many you can cut from it and what each one costs.", run: () => openHideLayout() },

  // ================= VIEW =================
  { id: "show3d", name: "3D only", word: "Show3D", aliases: ["only3d"], icon: "layout3d", keys: ["F2", "Ctrl+1"], tab: "view", group: "Layout", help: "Show only the 3D simulation window.", run: () => setLayout("3d"), active: () => layout() === "3d" },
  { id: "showboth", name: "3D and pattern", short: "Both", word: "ShowBoth", aliases: ["split"], icon: "layoutboth", keys: ["F3", "Ctrl+2"], tab: "view", group: "Layout", help: "Show the 3D and pattern windows side by side.", run: () => setLayout("both"), active: () => layout() === "both" },
  { id: "showpattern", name: "Pattern only", short: "Pattern", word: "ShowPattern", aliases: ["only2d", "flat"], icon: "layoutpattern", keys: ["F4", "Ctrl+3"], tab: "view", group: "Layout", help: "Show only the 2D pattern window.", run: () => setLayout("pattern"), active: () => layout() === "pattern" },
  {
    id: "view", name: "View", icon: "views", tab: "view", group: "Layout", ribbon: "none", args: "3d|pattern|both|front|side|top|back|home",
    help: "View 3d, View pattern, View both; or a 3D direction: View top.",
    run: (a) => { const v = (a[0] ?? "").toLowerCase(); if (setLayoutArg(v)) return; if ((VIEWS as readonly string[]).includes(v)) return preset(v as (typeof VIEWS)[number]); setStatus("View 3d, pattern or both; or front, side, top, back, home."); },
  },
  { id: "fit", name: "Fit", aliases: ["zoomextents", "ze", "extents"], icon: "fit", keys: ["0", "Home"], tab: "view", group: "Navigate", help: "Fit everything in both windows.", run: () => { fitView(); frameView(); } },
  { id: "home", name: "Home view", short: "Home", word: "Home", aliases: ["iso"], icon: "home", keys: ["Shift+Home"], tab: "view", group: "Navigate", help: "Turn the 3D view to the home (three-quarter) angle.", run: () => preset("home") },
  { id: "zoomin", name: "Zoom in", word: "ZoomIn", icon: "zoomin", keys: ["=", "+"], tab: "view", group: "Navigate", ribbon: "small", help: "Zoom in on the window under the mouse.", run: () => zoom(1.25) },
  { id: "zoomout", name: "Zoom out", word: "ZoomOut", icon: "zoomout", keys: ["-"], tab: "view", group: "Navigate", ribbon: "small", help: "Zoom out on the window under the mouse.", run: () => zoom(0.8) },
  { id: "orbit", name: "Orbit", word: "Orbit", icon: "orbit", tab: "view", group: "Navigate", ribbon: "small", help: "3D: drag empty space to orbit, drag the leather to pull it. Right-drag always orbits.", run: () => setTool3d("orbit", false), active: tool3d("orbit") },
  { id: "pan", name: "Pan", word: "Pan", icon: "pan", tab: "view", group: "Navigate", ribbon: "small", help: "3D: left-drag pans. Middle-drag pans in both windows; right-drag pans in 2D.", run: () => setTool3d("pan"), active: tool3d("pan") },
  { id: "front", name: "Front view", short: "Front", word: "Front", icon: "viewfront", keys: ["1"], tab: "view", group: "3D views", help: "Look at the front.", run: () => preset("front") },
  { id: "side", name: "Side view", short: "Side", word: "Side", aliases: ["right"], icon: "viewside", keys: ["3"], tab: "view", group: "3D views", help: "Look from the side.", run: () => preset("side") },
  { id: "top", name: "Top view", short: "Top", word: "Top", aliases: ["plan"], icon: "viewtop", keys: ["7"], tab: "view", group: "3D views", help: "Look straight down.", run: () => preset("top") },
  { id: "back", name: "Back view", short: "Back", word: "Back", aliases: ["rear"], icon: "viewback", keys: ["9"], tab: "view", group: "3D views", help: "Look at the back.", run: () => preset("back") },
  {
    id: "units", name: "Units", aliases: ["unit"], icon: "units", tab: "view", group: "Units", ribbon: "field", args: "mm|in",
    help: "Show lengths in millimetres or inches.",
    field: { kind: "select", get: () => state.project.units, set: (v) => edit((p) => (p.units = v as Units)), options: [["mm", "Millimetres"], ["in", "Inches"]] },
    run: (a) => { const v = (a[0] ?? "").toLowerCase(); const u: Units = v.startsWith("i") ? "in" : v.startsWith("m") ? "mm" : state.project.units === "mm" ? "in" : "mm"; edit((p) => (p.units = u)); setStatus(`Units: ${u === "in" ? "inches" : "millimetres"}.`); },
  },

  { id: "tools", name: "Show all tools", word: "Tools", aliases: ["alltools", "simple", "ribbon"], icon: "tools", tab: "view", group: "Display", help: "Switch between the short row of big buttons (Simple) and every tool in the ribbon.", run: (a) => { const v = (a[0] ?? "").toLowerCase(); setMode(v === "simple" ? "simple" : v === "all" || v === "full" ? "full" : prefs.mode === "simple" ? "full" : "simple"); }, active: () => prefs.mode === "full" },
  { id: "bigger", name: "Bigger text", short: "Bigger", simpleLabel: "Bigger text", word: "Bigger", aliases: ["larger"], icon: "textbigger", keys: ["Ctrl+="], tab: "view", group: "Display", ribbon: "small", repeat: false, help: "Make all text and buttons bigger (up to 200%).", run: () => setScale(prefs.scale + 0.1), enabled: () => prefs.scale < SCALE_MAX },
  { id: "smaller", name: "Smaller text", short: "Smaller", word: "Smaller", icon: "textsmaller", keys: ["Ctrl+-"], tab: "view", group: "Display", ribbon: "small", repeat: false, help: "Make all text and buttons smaller (down to 85%).", run: () => setScale(prefs.scale - 0.1), enabled: () => prefs.scale > SCALE_MIN },
  {
    id: "textsize", name: "Text size", word: "TextSize", aliases: ["uisize"], icon: "textsize", keys: ["Ctrl+0"], tab: "view", group: "Display", ribbon: "field", args: "[percent 85 to 200]",
    help: "Size of all text and buttons, 85% to 200%. Ctrl+0 goes back to the usual size (100%).",
    field: { kind: "select", get: () => String(Math.round(prefs.scale * 100)), set: (v) => setScale(parseInt(v, 10) / 100), options: [85, 100, 115, 125, 150, 175, 200].map((n) => [String(n), `${n}%`] as [string, string]) },
    run: (a) => { const n = num(a[0]); setScale(n ? n / 100 : 1); },
  },
  {
    id: "theme", name: "Colours", word: "Theme", aliases: ["colours", "colors", "contrast"], icon: "theme", tab: "view", group: "Display", ribbon: "field", args: "leather|light|contrast",
    help: "Leather (dark), light, or high contrast colours.",
    field: { kind: "select", get: () => prefs.theme, set: (v) => setTheme(v as Theme), options: [["leather", "Leather"], ["light", "Light"], ["contrast", "High contrast"]] },
    run: (a) => {
      const v = (a[0] ?? "").toLowerCase();
      const order: Theme[] = ["leather", "light", "contrast"];
      const pick: Theme = v === "light" ? "light" : v.startsWith("c") || v.startsWith("h") ? "contrast" : v === "leather" || v === "dark" ? "leather" : order[(order.indexOf(prefs.theme) + 1) % 3];
      setTheme(pick);
    },
  },
  { id: "settings", name: "Text size and colours", short: "Settings", simpleLabel: "Text size", word: "Settings", aliases: ["preferences", "display"], icon: "settings", tab: "view", group: "Display", repeat: false, help: "Make everything bigger, choose light or high contrast colours, or switch between Simple and All tools.", run: () => showSettings() },

  // ================= FILE (app bar) =================
  { id: "open", simpleLabel: "Open", name: "Open…", word: "Open", icon: "open", keys: ["Ctrl+O"], tab: "file", group: "File", help: "Open a .hidework pattern.", run: () => void openFile() },
  { id: "save", simpleLabel: "Save", name: "Save", icon: "save", keys: ["Ctrl+S"], tab: "file", group: "File", help: "Save the pattern.", run: () => void saveFile() },
  { id: "saveas", name: "Save as…", word: "SaveAs", icon: "saveas", keys: ["Ctrl+Shift+S"], tab: "file", group: "File", help: "Save the pattern under a new name.", run: () => void saveFile(true) },

  // ================= HELP (app bar) =================
  { id: "steps", name: "Show my steps", short: "My steps", word: "Steps", aliases: ["checklist", "guide-steps"], icon: "steps", tab: "help", group: "Help", repeat: false, help: "The numbered list of steps (choose, change the size, check, see in 3D, print) on the left.", run: () => showSteps() },
  { id: "welcome", name: "What would you like to make?", short: "Start", word: "Welcome", aliases: ["start"], icon: "welcome", tab: "help", group: "Help", repeat: false, help: "The welcome page with big pictures of things to make.", run: () => showWelcome() },
  { id: "help", name: "Help", simpleLabel: "Help", word: "Help", aliases: ["guide", "howto", "?"], icon: "help", keys: ["F1"], tab: "help", group: "Help", repeat: false, help: "Plain-English help: how to start, change, sew, see in 3D and print a pattern.", run: () => showGuide(() => showShortcuts(COMMANDS, TABS)) },
  { id: "shortcuts", name: "All commands and shortcuts", short: "Shortcuts", word: "Shortcuts", aliases: ["commands", "keys"], icon: "keyboard", keys: ["Shift+F1"], tab: "help", group: "Help", repeat: false, help: "Every command with its keyboard shortcut and what to type.", run: () => showShortcuts(COMMANDS, TABS) },
  { id: "search", name: "Search commands", short: "Search", word: "Search", aliases: ["find", "toolbox"], icon: "search", keys: ["S"], tab: "help", group: "Help", repeat: false, help: "Find any command by name at the mouse, with the ones you used last at the top.", run: () => showSearch() },
  { id: "agent", name: "Connect an AI agent (MCP)…", short: "AI agent", word: "Agent", aliases: ["mcp"], icon: "agent", tab: "help", group: "Help", help: "Let Claude or another MCP agent draft, sew and simulate in Hidework.", run: () => void showMcp() },
];

// The fold-direction label follows the current direction.
Object.defineProperty(COMMANDS.find((c) => c.id === "folddir")!, "short", { get: () => (state.foldOrientation === "horizontal" ? "Fold across" : "Fold down") });

const byId = new Map(COMMANDS.map((c) => [c.id, c]));

export function command(id: string): Command {
  const c = byId.get(id);
  if (!c) throw new Error(`No command ${id}`);
  return c;
}

/** What to type for a command. */
export function wordOf(c: Command): string {
  return c.word ?? c.name.replace(/[^A-Za-z0-9]/g, "");
}

export function label(c: Command): string {
  return c.short ?? c.name;
}

/** The shortcut to show (the first binding, or the hint). */
export function keyText(c: Command): string {
  return c.keys?.[0] ?? c.keyHint ?? "";
}

/** Every shortcut, for help: "F2 · Ctrl+1". */
export function allKeys(c: Command): string {
  return [...(c.keys ?? []), ...(c.keyHint ? [c.keyHint] : [])].join(" · ");
}

// ---------- running ----------

let last: { cmd: Command; args: string[] } | null = null;
let running: Command | null = null;

/** The command whose run() is going on right now (names its undo step in the history timeline). */
export function runningCommand(): Command | null {
  return running;
}
const listeners: ((c: Command) => void)[] = [];

export function onRun(fn: (c: Command) => void): void {
  listeners.push(fn);
}

export function lastCommand(): { cmd: Command; args: string[] } | null {
  return last;
}

/** Put back what lastCommand() returned (when a shortcut turned out to be the start of a word). */
export function restoreLast(prev: { cmd: Command; args: string[] } | null): void {
  last = prev;
}

/** Edits that remove or change a lot at once: say how to take them back. */
const UNDO_NOTE = new Set(["delete", "cut", "merge", "glueall", "edgeall", "turnedall", "mirror", "flip", "rotate", "align", "distribute"]);

export function runCommand(c: Command, args: string[] = []): void {
  if (c.repeat !== false) last = { cmd: c, args };
  const before = version;
  try {
    running = c;
    let r: unknown;
    try {
      r = c.run(args);
    } finally {
      running = null;
    }
    if (UNDO_NOTE.has(c.id.replace(/-.*/, "")) && version !== before) offerUndo(state.status && !/undo/i.test(state.status) ? state.status : `${c.name}: done.`);
    if (r instanceof Promise) r.catch((e) => setStatus(String(e))).finally(notify);
  } catch (e) {
    setStatus(String(e));
  }
  listeners.forEach((f) => f(c));
  notify();
}

export function runId(id: string, args: string[] = []): void {
  runCommand(command(id), args);
}

// ---------- keys ----------

function normKey(k: string): string {
  const s = k.toLowerCase();
  const map: Record<string, string> = { " ": "space", spacebar: "space", del: "delete", esc: "escape", "+": "=", _: "-", return: "enter" };
  return map[s] ?? s;
}

/** "Ctrl+Shift+S" → "ctrl+shift+s" with modifiers in a fixed order. */
export function normCombo(s: string): string {
  const parts = s.split("+");
  // "Ctrl++" and "+" both mean the plus key.
  let key = parts.pop() ?? "";
  if (key === "" && s.endsWith("+")) {
    key = "+";
    parts.pop();
  }
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const k = normKey(key);
  const shift = mods.has("shift") && k !== "=" && k !== "-";
  return `${mods.has("ctrl") || mods.has("cmd") ? "ctrl+" : ""}${shift ? "shift+" : ""}${mods.has("alt") ? "alt+" : ""}${k}`;
}

export function comboOf(e: KeyboardEvent): string {
  const k = normKey(e.key === " " || e.code === "Space" ? " " : e.key);
  const shift = e.shiftKey && k !== "=" && k !== "-";
  return `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${shift ? "shift+" : ""}${e.altKey ? "alt+" : ""}${k}`;
}

const bindings = new Map<string, Command>();
for (const c of COMMANDS)
  for (const k of c.keys ?? []) {
    const n = normCombo(k);
    if (bindings.has(n) && bindings.get(n) !== c) console.warn(`Shortcut ${k} is bound twice (${bindings.get(n)!.id}, ${c.id})`);
    bindings.set(n, c);
  }

export function commandForKey(combo: string): Command | undefined {
  return bindings.get(combo);
}

// ---------- command-line matching ----------

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9?]/g, "");

function score(c: Command, q: string): number {
  const names = [wordOf(c), c.name, ...(c.aliases ?? [])].map(flat);
  if (names.some((n) => n === q)) return 0;
  if (flat(wordOf(c)).startsWith(q)) return 1;
  if (names.some((n) => n.startsWith(q))) return 2;
  // Start of a later word in the name: "as" finds Save as.
  if (c.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 3;
  // Letters in order: "rr" finds RoundedRect.
  const w = flat(wordOf(c));
  let i = 0;
  for (const ch of w) if (ch === q[i]) i++;
  return i === q.length && q.length >= 2 ? 4 : -1;
}

/** Commands matching what was typed, best first. */
export function matchCommands(query: string, limit = 9): Command[] {
  const q = flat(query);
  if (!q) return [];
  const scored = COMMANDS.map((c) => [c, score(c, q)] as const).filter(([, s]) => s >= 0);
  // Letters-in-order matches only when nothing starts with what was typed.
  const strong = scored.some(([, s]) => s <= 3);
  return scored
    .filter(([, s]) => !strong || s <= 3)
    .sort((a, b) => a[1] - b[1] || wordOf(a[0]).length - wordOf(b[0]).length)
    .slice(0, limit)
    .map(([c]) => c);
}

/** The command a typed word names exactly (word, name or alias). */
export function exactCommand(word: string): Command | undefined {
  const q = flat(word);
  return COMMANDS.find((c) => [wordOf(c), c.name, ...(c.aliases ?? [])].some((n) => flat(n) === q));
}

/** True when some command's word or alias starts with `prefix` (used to tell typing from shortcuts). */
export function isCommandPrefix(prefix: string): boolean {
  const q = flat(prefix);
  return COMMANDS.some((c) => [wordOf(c), ...(c.aliases ?? [])].some((n) => flat(n).startsWith(q)));
}

/** Whether a command applies to the current selection (the ribbon greys it out otherwise). */
export function isEnabled(c: Command): boolean {
  return c.enabled ? c.enabled() : true;
}
