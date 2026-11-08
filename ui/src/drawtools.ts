// The shape tools of the 2D pattern window: rectangle, rounded rectangle, circle, oval, slot,
// strap end, an outline drawn point by point (the pen), and a half outline mirrored across a
// centre line. Each one says in plain words what to do next, shows its sizes while it is drawn,
// and takes exact sizes from the keyboard the way Rhino does: type 120 and Enter for the width,
// then 80 and Enter for the height. Esc drops the shape being drawn, Backspace (or Ctrl+Z) takes
// back the last point, and a finished shape is one step on the undo list.

import "./draw.css";
import { roundedRectPiece, rectPiece, flattenPiece } from "./ops";
import { prefs, simple } from "./prefs";
import { mirrorOutline, ovalPiece, penEdges, penPiece, slotPiece, type PenPoint, type SlotEnds } from "./shapeops";
import { drawSnapHit, smartSnap, type SnapHit } from "./smartsnap";
import { edit, notify, setStatus, state } from "./store";
import { fromDisp } from "./units";
import type { Piece, V } from "./types";

export type Shape = "rect" | "roundrect" | "circle" | "oval" | "slot" | "strapend" | "pen" | "mirror";

/** The canvas the tools draw on (canvas.ts supplies it). */
export interface Host {
  el: HTMLCanvasElement;
  ctx(): CanvasRenderingContext2D;
  toScreen(p: V): V;
  scale(): number;
  redraw(): void;
}

/** The chosen shape and the settings that carry over from one shape to the next. */
export const draw = { shape: "rect" as Shape, radiusMm: 6, ends: "round" as Exclude<SlotEnds, "both"> };

const NAMES: Record<Shape, string> = { rect: "Rectangle", roundrect: "Rounded rectangle", circle: "Circle", oval: "Oval", slot: "Slot", strapend: "Strap end", pen: "Draw freely", mirror: "Mirror half" };
const PIECE_NAMES: Record<Shape, string> = { rect: "Panel", roundrect: "Rounded panel", circle: "Circle", oval: "Oval", slot: "Slot", strapend: "Strap end", pen: "Piece", mirror: "Piece" };

let host: Host;
/** A box shape being drawn: `a` is the first corner (the middle, for a circle). */
let box: { a: V; b: V; down: boolean; sx: number; sy: number; moved: boolean; w: number | null; h: number | null } | null = null;
/** Sizes typed before the first click (the shape is then placed in the middle of the view). */
let early: number[] = [];
/** An outline being drawn point by point; `axis` is the centre line of a mirrored half. */
let pen: { pts: PenPoint[]; down: { sx: number; sy: number } | null; axis: number | null } | null = null;
/** What has been typed so far. */
let typed = "";
/** The pointer, snapped, and what caught it. */
let hit: SnapHit | null = null;
let mouse: V | null = null;
let promptEl: HTMLElement | null = null;

export function initDraw(h: Host): void {
  host = h;
  promptEl = document.createElement("div");
  promptEl.className = "draw-prompt hidden";
  promptEl.setAttribute("aria-live", "polite");
  h.el.parentElement!.append(promptEl);
  window.addEventListener("keydown", onKey, { capture: true });
}

/** A shape tool is the current tool. */
export function drawing(): boolean {
  return state.tool === "rect" || state.tool === "polygon";
}

/** Something is half drawn (a point placed, or a size typed). */
export function inProgress(): boolean {
  return !!box || !!pen?.pts.length || early.length > 0 || typed.length > 0;
}

/** The tool (canvas.ts) for a shape. */
export function toolFor(s: Shape): "rect" | "polygon" {
  return s === "pen" || s === "mirror" ? "polygon" : "rect";
}

/** Start drawing `s` (the tool must already be the one toolFor(s) names). */
export function beginShape(s: Shape): void {
  draw.shape = s;
  reset();
  sayPrompt();
}

/** Drop whatever is half drawn. */
export function cancelShape(): void {
  reset();
  host?.redraw();
  renderPrompt();
}

function reset(): void {
  box = null;
  pen = null;
  early = [];
  typed = "";
  hit = null;
}

const isBox = () => draw.shape !== "pen" && draw.shape !== "mirror";
const round1 = (v: number) => Math.round(v * 10) / 10;

/** A length for the screen: 120 mm, 85.5 mm, 4.72 in. */
export function fmt(mm: number): string {
  if (state.project.units === "in") return `${(mm / 25.4).toFixed(2)} in`;
  const r = round1(mm);
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} mm`;
}

const unitWord = () => (state.project.units === "in" ? "in" : "mm");

// ---------- prompts ----------

interface Prompt {
  step: string;
  main: string;
  alt: string;
}

function prompt(): Prompt {
  const u = unitWord();
  const keys = "Esc stops. Backspace takes back the last step.";
  const shape = draw.shape;
  const name = NAMES[shape];
  if (shape === "circle") {
    if (!box) return { step: `${name}: step 1 of 2`, main: "Click where the middle of the circle goes.", alt: `Or type how wide it is across (${u}) and press Enter.` };
    return { step: `${name}: step 2 of 2`, main: "Move out and click to make it the size you want.", alt: `Or type how wide it is across (${u}) and press Enter. ${keys}` };
  }
  if (isBox()) {
    const extra = shape === "roundrect" ? ` Corners: ${fmt(draw.radiusMm)} round (type r10 and Enter to change).` : "";
    if (!box) {
      if (early.length === 1) return { step: `${name}: size`, main: `Width ${fmt(early[0])}. Now type the height and press Enter.`, alt: `Or click where the first corner goes. ${keys}` };
      return { step: `${name}: step 1 of 2`, main: "Click where the first corner goes.", alt: `Or type the width (${u}) and press Enter, then the height.${extra}` };
    }
    if (box.w !== null && box.h === null) return { step: `${name}: step 2 of 2`, main: `Width ${fmt(box.w)}. Now type the height and press Enter, or click.`, alt: keys };
    if (box.h !== null && box.w === null) return { step: `${name}: step 2 of 2`, main: `Height ${fmt(box.h)}. Now type the width and press Enter, or click.`, alt: keys };
    return { step: `${name}: step 2 of 2`, main: "Click where the opposite corner goes (or drag to it).", alt: `Or type the width (${u}) and press Enter, then the height.${extra} ${keys}` };
  }
  if (shape === "mirror") {
    const n = pen?.pts.length ?? 0;
    if (!n) return { step: `${name}: step 1`, main: "Click on the centre line, where the piece starts.", alt: "Draw one half; the other half is copied across the centre line. Esc stops." };
    if (n === 1) return { step: `${name}: next point`, main: "Click the next point down one side.", alt: `Drag while clicking to make a curve. Or type a length (${u}) and press Enter. ${keys}` };
    return { step: `${name}: next point`, main: "Click the next point, or click back on the centre line to finish.", alt: `Enter finishes. Drag while clicking to make a curve. ${keys}` };
  }
  const n = pen?.pts.length ?? 0;
  if (!n) return { step: `${name}: step 1`, main: "Click where the first point goes.", alt: "Then click each corner in turn. Esc stops." };
  if (n < 3) return { step: `${name}: next point`, main: "Click the next point.", alt: `Drag while clicking to make a curve. Or type a length (${u}) and press Enter. ${keys}` };
  return { step: `${name}: next point`, main: "Click the next point. Click the first point, or press Enter, to finish.", alt: `Drag while clicking to make a curve. ${keys}` };
}

function sayPrompt(): void {
  const p = prompt();
  setStatus(`${p.main} ${p.alt}`);
  renderPrompt();
}

function typedLabel(): string {
  if (!typed) return "";
  const shape = draw.shape;
  if (shape === "roundrect" && /^r/i.test(typed)) return `Corner size: ${typed.slice(1) || "…"} ${unitWord()}`;
  let what = "Size";
  if (shape === "circle") what = "Across";
  else if (isBox()) {
    const done = box ? (box.w !== null ? 1 : 0) + (box.h !== null ? 1 : 0) : early.length;
    what = /[\s,x*]/i.test(typed.trim()) ? "Width and height" : box?.w !== null && box ? "Height" : box?.h !== null && box ? "Width" : done === 1 ? "Height" : "Width";
  } else what = typed.includes("<") ? "Length and angle" : typed.includes(",") ? "Across and down" : "Length";
  return `${what}: ${typed} ${/[a-z"]$/i.test(typed) ? "" : unitWord()}  (Enter)`;
}

function renderPrompt(): void {
  if (!promptEl) return;
  if (!drawing()) {
    promptEl.classList.add("hidden");
    return;
  }
  const p = prompt();
  const t = typedLabel();
  promptEl.classList.toggle("big", simple());
  promptEl.style.setProperty("zoom", String(prefs.scale));
  promptEl.replaceChildren(
    el("div", "dp-step", p.step),
    el("div", "dp-main", p.main),
    el("div", "dp-alt", p.alt),
    ...(t ? [el("div", "dp-typed", t)] : []),
  );
  promptEl.classList.remove("hidden");
}

function el(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

// ---------- pointer ----------

interface Mods {
  shiftKey: boolean;
  altKey: boolean;
}

function snapOpts(e: Mods): Parameters<typeof smartSnap>[1] {
  const pts = pen?.pts.map((q) => q.p) ?? [];
  const last = pts.length ? pts[pts.length - 1] : box ? box.a : null;
  const lengths: { len: number; a: V; b: V }[] = [];
  for (let i = 1; i < pts.length; i++) lengths.push({ len: Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y), a: pts[i - 1], b: pts[i] });
  return {
    scale: host.scale(),
    shift: e.shiftKey,
    alt: e.altKey,
    from: draw.shape === "circle" || isBox() ? (e.shiftKey ? last : null) : last,
    first: draw.shape === "pen" && pts.length >= 3 ? pts[0] : null,
    own: draw.shape === "mirror" && pen ? [...pts, ...pts.map((p) => ({ x: 2 * (pen!.axis ?? p.x) - p.x, y: p.y }))] : pts,
    lengths: draw.shape === "pen" || draw.shape === "mirror" ? lengths : [],
    axis: draw.shape === "mirror" && pen && pen.pts.length ? pen.axis : null,
  };
}

/** The pointer moved (world mm). */
export function drawMove(w: V, e: MouseEvent): void {
  mouse = w;
  if (pen?.down && pen.pts.length) {
    // Dragging out of the point just placed: pull a curve handle.
    const last = pen.pts[pen.pts.length - 1];
    const s = host.toScreen(last.p);
    const r = host.el.getBoundingClientRect();
    const dx = e.clientX - r.left - s.x;
    const dy = e.clientY - r.top - s.y;
    if (Math.hypot(dx, dy) > 5) {
      last.out = { x: w.x - last.p.x, y: w.y - last.p.y };
      hit = null;
      host.redraw();
      return;
    }
  }
  hit = smartSnap(w, snapOpts(e));
  if (box) {
    let b = hit.p;
    if (draw.shape !== "circle") {
      if (box.w !== null) b = { ...b, x: box.a.x + Math.sign(b.x - box.a.x || 1) * box.w };
      if (box.h !== null) b = { ...b, y: box.a.y + Math.sign(b.y - box.a.y || 1) * box.h };
      // Nearly square: make it square, and say so.
      const ww = Math.abs(b.x - box.a.x);
      const hh = Math.abs(b.y - box.a.y);
      if (!e.altKey && box.w === null && box.h === null && ww > 0 && Math.abs(ww - hh) * host.scale() < 6 && (!hit.kind || hit.kind === "grid")) {
        const m = Math.max(ww, hh);
        b = { x: box.a.x + Math.sign(b.x - box.a.x || 1) * m, y: box.a.y + Math.sign(b.y - box.a.y || 1) * m };
        hit = { p: b, kind: "square", word: draw.shape === "oval" ? "a circle" : "square", guides: [], same: [] };
      }
    }
    box.b = b;
    if (box.down && !box.moved) {
      const r = host.el.getBoundingClientRect();
      if (Math.hypot(e.clientX - r.left - box.sx, e.clientY - r.top - box.sy) > 5) box.moved = true;
    }
  }
  host.redraw();
}

/** A press on the canvas (world mm). */
export function drawDown(w: V, e: MouseEvent): void {
  const r = host.el.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  const h = smartSnap(w, snapOpts(e));
  if (isBox()) {
    if (!box) {
      box = { a: h.p, b: h.p, down: true, sx, sy, moved: false, w: early[0] ?? null, h: early[1] ?? null };
      early = [];
      if (box.w !== null && box.h !== null && draw.shape !== "circle") {
        box.b = { x: box.a.x + box.w, y: box.a.y + box.h };
        return finishBox();
      }
      sayPrompt();
    } else {
      // The second click: the box ends where the pointer is now.
      drawMove(w, e);
      finishBox();
    }
    host.redraw();
    return;
  }
  // Pen and mirror.
  if (!pen) pen = { pts: [], down: null, axis: null };
  if (draw.shape === "pen" && h.kind === "first") return finishPen();
  if (draw.shape === "mirror") {
    if (!pen.pts.length) pen.axis = h.p.x;
    else if (pen.pts.length >= 2 && (h.kind === "centre" || Math.abs(h.p.x - pen.axis!) < 1e-6)) {
      // Back on the centre line (or on the first point, which sits on it): the half is done.
      pen.pts.push({ p: { x: pen.axis!, y: h.p.y } });
      return finishPen();
    }
  }
  pen.pts.push({ p: h.p });
  pen.down = { sx, sy };
  sayPrompt();
  host.redraw();
}

/** The button came up. */
export function drawUp(): void {
  if (box?.down) {
    box.down = false;
    if (box.moved) finishBox();
    else sayPrompt();
  }
  if (pen?.down) pen.down = null;
  host.redraw();
}

/** A double-click finishes an outline. */
export function drawDouble(): void {
  if (!pen) return;
  // The second press of the double-click placed a point on top of the last one.
  const n = pen.pts.length;
  if (n >= 2) {
    const a = host.toScreen(pen.pts[n - 1].p);
    const b = host.toScreen(pen.pts[n - 2].p);
    if (Math.hypot(a.x - b.x, a.y - b.y) < 6) pen.pts.pop();
  }
  finishPen();
}

// ---------- finishing ----------

/** The piece the box would make, in world mm (null while too small). */
function boxPiece(a: V, b: V): Piece | null {
  const name = PIECE_NAMES[draw.shape];
  if (draw.shape === "circle") {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    if (r < 1) return null;
    return ovalPiece({ x: a.x - r, y: a.y - r }, 2 * r, 2 * r, name);
  }
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  if (w < 2 || h < 2) return null;
  switch (draw.shape) {
    case "roundrect":
      return roundedRectPiece(min, w, h, Math.min(draw.radiusMm, w / 2, h / 2), name);
    case "oval":
      return ovalPiece(min, w, h, name);
    case "slot":
      return slotPiece(min, w, h, "both", name);
    case "strapend":
      return slotPiece(min, w, h, draw.ends, name);
    default:
      return rectPiece(min, w, h, name);
  }
}

function sizeText(a: V, b: V): string {
  if (draw.shape === "circle") return `${fmt(2 * Math.hypot(b.x - a.x, b.y - a.y))} across`;
  return `${fmt(Math.abs(b.x - a.x))} × ${fmt(Math.abs(b.y - a.y))}`;
}

function add(pc: Piece, what: string): void {
  edit((p) => p.pieces.push(pc));
  state.sel = { kind: "piece", piece: pc.id };
  state.tool = "select";
  reset();
  renderPrompt();
  setStatus(`${what} Drag its corners or edges to change it, or click an edge to type its exact length. Ctrl+Z takes it back.`);
  notify();
}

function finishBox(): void {
  const b = box;
  if (!b) return;
  const pc = boxPiece(b.a, b.b);
  if (!pc) {
    box = null;
    setStatus("That was too small to make a piece. Click where the first corner goes and try again.");
    renderPrompt();
    host.redraw();
    return;
  }
  add(pc, `Added a ${NAMES[draw.shape].toLowerCase()}, ${sizeText(b.a, b.b)}.`);
}

/** Make the shape from sizes alone, in the middle of the view. */
function placeTyped(w: number, h: number): void {
  const c = centre();
  const a = draw.shape === "circle" ? c : { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2) };
  const b = draw.shape === "circle" ? { x: c.x + w / 2, y: c.y } : { x: a.x + w, y: a.y + h };
  const pc = boxPiece(a, b);
  if (!pc) return setStatus("That is too small to make a piece.");
  add(pc, `Added a ${NAMES[draw.shape].toLowerCase()}, ${sizeText(a, b)}.`);
}

function centre(): V {
  const r = host.el.getBoundingClientRect();
  const s = host.scale();
  // Inverse of toScreen at the middle of the canvas.
  const o = host.toScreen({ x: 0, y: 0 });
  return { x: (r.width / 2 - o.x) / s, y: (r.height / 2 - o.y) / s };
}

function finishPen(): void {
  const p = pen;
  if (!p) return;
  if (draw.shape === "mirror") {
    if (p.pts.length < 2) return setStatus("Click at least one point beside the centre line first.");
    const last = p.pts[p.pts.length - 1];
    // Finish on the centre line, level with the last point.
    if (Math.abs(last.p.x - p.axis!) > 1e-6) p.pts.push({ p: { x: p.axis!, y: last.p.y } });
    if (p.pts.length < 3) return setStatus("Click at least one point beside the centre line first.");
    const pts = mirrorOutline(p.pts, p.axis!);
    add(penPiece(pts, PIECE_NAMES.mirror), `Added a mirrored piece with ${pts.length} points; both halves match.`);
    return;
  }
  if (p.pts.length < 3) return setStatus("An outline needs at least three points. Click some more.");
  add(penPiece(p.pts, PIECE_NAMES.pen), `Added a piece with ${p.pts.length} points.`);
}

// ---------- keyboard ----------

function stepBack(): boolean {
  if (typed) {
    typed = typed.slice(0, -1);
  } else if (pen?.pts.length) {
    pen.pts.pop();
    if (!pen.pts.length) pen = null;
  } else if (box) {
    if (box.h !== null) box.h = null;
    else if (box.w !== null) box.w = null;
    else box = null;
  } else if (early.length) early.pop();
  else return false;
  sayPrompt();
  host.redraw();
  return true;
}

/** Numbers typed in the project's units (3in, 80mm, 8cm also work). */
function len(s: string): number | null {
  const m = /^(-?\d*\.?\d+)\s*(mm|cm|in|"|)$/i.exec(s.trim());
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (u === "mm") return v;
  if (u === "cm") return v * 10;
  if (u === "in" || u === '"') return v * 25.4;
  return fromDisp(v, state.project.units);
}

function applyTyped(): void {
  const t = typed.trim();
  typed = "";
  if (!t) return;
  if (draw.shape === "roundrect" && /^r/i.test(t)) {
    const r = len(t.slice(1));
    if (r === null || r < 0) return setStatus("Type r and a number for the corner size, for example r10.");
    draw.radiusMm = r;
    sayPrompt();
    host.redraw();
    return;
  }
  if (isBox()) {
    const parts = t.split(/\s*[\s,x*]\s*/i).filter(Boolean).map(len);
    if (parts.some((v) => v === null || v <= 0)) return setStatus(`"${t}" is not a size. Type a number such as 120, then Enter.`);
    const nums = parts as number[];
    if (draw.shape === "circle") {
      const d = nums[0];
      if (!box) return placeTyped(d, d);
      box.b = { x: box.a.x + d / 2, y: box.a.y };
      return finishBox();
    }
    if (!box) {
      early.push(...nums);
      if (early.length >= 2) return placeTyped(early[0], early[1]);
      sayPrompt();
      host.redraw();
      return;
    }
    for (const v of nums) {
      if (box.w === null) box.w = v;
      else if (box.h === null) box.h = v;
    }
    if (box.w !== null && box.h !== null) {
      const sx = Math.sign((mouse?.x ?? box.a.x + 1) - box.a.x) || 1;
      const sy = Math.sign((mouse?.y ?? box.a.y + 1) - box.a.y) || 1;
      box.b = { x: box.a.x + sx * box.w, y: box.a.y + sy * box.h };
      return finishBox();
    }
    if (mouse) drawMove(mouse, { shiftKey: false, altKey: false, clientX: NaN, clientY: NaN } as MouseEvent);
    sayPrompt();
    return;
  }
  // Pen and mirror: the next point from the last one.
  const last = pen?.pts[pen.pts.length - 1]?.p;
  if (!last || !pen) return setStatus("Click the first point, then type how long the next side is.");
  let next: V | null = null;
  const polar = /^(.+)<(.+)$/.exec(t);
  const pair = /^([^,]+),([^,]+)$/.exec(t);
  if (polar) {
    const l = len(polar[1]);
    const a = parseFloat(polar[2]);
    if (l !== null && Number.isFinite(a)) next = { x: last.x + l * Math.cos((a * Math.PI) / 180), y: last.y - l * Math.sin((a * Math.PI) / 180) };
  } else if (pair) {
    const dx = len(pair[1]);
    const dy = len(pair[2]);
    if (dx !== null && dy !== null) next = { x: last.x + dx, y: last.y + dy };
  } else {
    const l = len(t);
    // Along the direction the pointer shows (snapped), or to the right.
    const toward = hit?.p ?? mouse;
    const dx = toward ? toward.x - last.x : 1;
    const dy = toward ? toward.y - last.y : 0;
    const d = Math.hypot(dx, dy);
    if (l !== null) next = d > 1e-6 ? { x: last.x + (dx / d) * l, y: last.y + (dy / d) * l } : { x: last.x + l, y: last.y };
  }
  if (!next) return setStatus(`"${t}" is not a length. Type a number such as 120, then Enter. 120<30 goes 120 at 30 degrees; 40,20 goes 40 across and 20 down.`);
  pen.pts.push({ p: next });
  sayPrompt();
  host.redraw();
}

function typingElsewhere(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === "TEXTAREA" || a.tagName === "SELECT") return true;
  if (a.tagName !== "INPUT") return false;
  const t = (a as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "color", "file"].includes(t);
}

function modalOpen(): boolean {
  const m = document.getElementById("modal");
  return !!m && !m.classList.contains("hidden");
}

/** Keys while a shape tool is on, before the app's own shortcuts see them. */
function onKey(e: KeyboardEvent): void {
  if (!drawing() || e.isComposing || typingElsewhere() || modalOpen()) return;
  const k = e.key;
  const take = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k.toLowerCase() === "z") {
    if (stepBack()) take();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const unitLetter = typed.length > 0 && /^[mcin"]$/i.test(k);
  const sep = typed.length > 0 && /^[ ,x*<]$/i.test(k);
  const radius = draw.shape === "roundrect" && !typed && /^r$/i.test(k);
  const minus = k === "-" && (inProgress() || /[\s,x*<r]$/i.test(typed));
  if (/^[0-9.]$/.test(k) || unitLetter || sep || radius || minus) {
    take();
    typed += k;
    renderPrompt();
    host.redraw();
    return;
  }
  if (k === "Backspace") {
    if (stepBack()) take();
    return;
  }
  if (k === "Enter") {
    if (typed) {
      take();
      applyTyped();
      renderPrompt();
      return;
    }
    if (pen && pen.pts.length) {
      take();
      finishPen();
    } else if (inProgress()) {
      // Half a box drawn: Enter waits for the second corner rather than repeating a command.
      take();
      sayPrompt();
    }
    return;
  }
  if (k === "Escape") {
    if (typed) {
      take();
      typed = "";
      renderPrompt();
      return;
    }
    if (inProgress()) {
      take();
      reset();
      setStatus(`${NAMES[draw.shape]}: that shape is gone. ${prompt().main} Press Esc again to stop drawing.`);
      renderPrompt();
      host.redraw();
    }
  }
}

// ---------- painting ----------

const OXBLOOD = "#7a1f1a";
const GOLD = "#b08a3e";
const INK = "#2b1d0e";

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, strong = false): void {
  const size = simple() ? 16 : 14;
  ctx.font = `${strong ? 700 : 600} ${size}px 'EB Garamond', serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(255,248,230,0.94)";
  ctx.strokeStyle = strong ? OXBLOOD : "rgba(122,31,26,0.6)";
  ctx.lineWidth = strong ? 1.5 : 1;
  ctx.beginPath();
  ctx.roundRect(x - w / 2 - 6, y - size / 2 - 4, w + 12, size + 8, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = OXBLOOD;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function outline(ctx: CanvasRenderingContext2D, pc: Piece, fill: string): void {
  const pts = flattenPiece(pc, pc.position, 24).pts.map(host.toScreen);
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = OXBLOOD;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Paint the shape being drawn, its sizes and the snap marker. Called at the end of each frame. */
export function paintDraw(): void {
  if (!drawing()) {
    if (promptEl && !promptEl.classList.contains("hidden")) promptEl.classList.add("hidden");
    return;
  }
  renderPromptIfStale();
  const ctx = host.ctx();
  const S = host.toScreen;
  ctx.save();
  if (box) {
    const pc = boxPiece(box.a, box.b);
    if (pc) outline(ctx, pc, "rgba(168,104,52,0.18)");
    if (draw.shape === "circle") {
      const a = S(box.a);
      const b = S(box.b);
      ctx.strokeStyle = OXBLOOD;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      dot(ctx, a, OXBLOOD);
      label(ctx, `${fmt(2 * Math.hypot(box.b.x - box.a.x, box.b.y - box.a.y))} across`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 18, true);
    } else {
      const a = S(box.a);
      const b = S(box.b);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      dot(ctx, a, OXBLOOD);
      label(ctx, `${box.w !== null ? "Width " : ""}${fmt(Math.abs(box.b.x - box.a.x))}`, (minX + maxX) / 2, minY - 18, box.w !== null);
      label(ctx, `${box.h !== null ? "Height " : ""}${fmt(Math.abs(box.b.y - box.a.y))}`, maxX + 12 + measureHalf(ctx, fmt(Math.abs(box.b.y - box.a.y))), (minY + maxY) / 2, box.h !== null);
    }
  }
  if (pen && pen.pts.length) paintPen(ctx);
  if (draw.shape === "mirror" && pen?.axis !== null && pen?.axis !== undefined) paintAxis(ctx, pen.axis);
  else if (draw.shape === "mirror" && hit) paintAxis(ctx, hit.p.x, true);
  drawSnapHit(ctx, hit, S, simple());
  // What is being typed, beside the pointer as well as in the prompt.
  if (typed && mouse) {
    const m = S(hit?.p ?? mouse);
    label(ctx, typedLabel().replace(/\s+\(Enter\)$/, ""), m.x + 60, m.y - 26, true);
  }
  ctx.restore();
}

function measureHalf(ctx: CanvasRenderingContext2D, t: string): number {
  ctx.font = `600 ${simple() ? 16 : 14}px 'EB Garamond', serif`;
  return ctx.measureText(t).width / 2 + 6;
}

let shown = "";
function renderPromptIfStale(): void {
  const key = `${draw.shape}|${!!box}|${box?.w}|${box?.h}|${pen?.pts.length ?? 0}|${early.join(",")}|${typed}|${prefs.scale}|${prefs.mode}|${state.project.units}|${draw.radiusMm}`;
  if (key === shown && promptEl && !promptEl.classList.contains("hidden")) return;
  shown = key;
  renderPrompt();
}

function dot(ctx: CanvasRenderingContext2D, p: V, color: string): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function paintAxis(ctx: CanvasRenderingContext2D, x: number, faint = false): void {
  const s = host.toScreen({ x, y: 0 }).x;
  const h = host.el.getBoundingClientRect().height;
  ctx.strokeStyle = faint ? "rgba(122,31,26,0.35)" : OXBLOOD;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([12, 4, 3, 4]);
  ctx.beginPath();
  ctx.moveTo(s, 0);
  ctx.lineTo(s, h);
  ctx.stroke();
  ctx.setLineDash([]);
  if (!faint) {
    ctx.save();
    ctx.fillStyle = OXBLOOD;
    ctx.font = `italic ${simple() ? 16 : 14}px 'EB Garamond', serif`;
    ctx.fillText("centre line", s + 6, 20);
    ctx.restore();
  }
}

function paintPen(ctx: CanvasRenderingContext2D): void {
  const p = pen!;
  const S = host.toScreen;
  const pts = p.pts;
  const tail = !p.down && hit ? hit.p : null;
  // The mirrored half, faint, so the whole piece shows as it is drawn.
  if (draw.shape === "mirror" && p.axis !== null && pts.length >= 1) {
    const half = [...pts.map((q) => ({ ...q })), ...(tail ? [{ p: tail }] : [])];
    if (half.length >= 2) {
      const whole = mirrorOutline([...half, { p: { x: p.axis, y: half[half.length - 1].p.y } }], p.axis);
      const pc = penPiece(whole, "preview");
      outline(ctx, pc, "rgba(168,104,52,0.10)");
    }
  }
  // The points so far, with their curves.
  const edges = penEdges(pts, false);
  ctx.strokeStyle = OXBLOOD;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  const s0 = S(pts[0].p);
  ctx.moveTo(s0.x, s0.y);
  edges.forEach((e, i) => {
    const b = S(pts[i + 1].p);
    if (e.type === "cubic") {
      const c1 = S(e.c1);
      const c2 = S(e.c2);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
    } else ctx.lineTo(b.x, b.y);
  });
  ctx.stroke();
  // The next side, following the pointer.
  const last = pts[pts.length - 1];
  if (tail) {
    const a = S(last.p);
    const b = S(tail);
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    if (last.out) {
      const c1 = S({ x: last.p.x + last.out.x, y: last.p.y + last.out.y });
      ctx.bezierCurveTo(c1.x, c1.y, b.x, b.y, b.x, b.y);
    } else ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const l = Math.hypot(tail.x - last.p.x, tail.y - last.p.y);
    if (l > 0.05) {
      const deg = Math.round(((((Math.atan2(-(tail.y - last.p.y), tail.x - last.p.x) * 180) / Math.PI) % 360) + 360) % 360);
      label(ctx, `${fmt(l)}, ${deg}°`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 20, true);
    }
  }
  // Lengths of the sides already drawn.
  for (let i = 1; i < pts.length; i++) {
    const a = S(pts[i - 1].p);
    const b = S(pts[i].p);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 50) continue;
    label(ctx, fmt(Math.hypot(pts[i].p.x - pts[i - 1].p.x, pts[i].p.y - pts[i - 1].p.y)), (a.x + b.x) / 2, (a.y + b.y) / 2 - 16);
  }
  // Points, and the handle being pulled.
  pts.forEach((q, i) => {
    const s = S(q.p);
    ctx.fillStyle = i === 0 ? OXBLOOD : GOLD;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    const r = i === 0 ? 6 : 4.5;
    ctx.fillRect(s.x - r, s.y - r, 2 * r, 2 * r);
    ctx.strokeRect(s.x - r, s.y - r, 2 * r, 2 * r);
    if (q.out) {
      const h1 = S({ x: q.p.x + q.out.x, y: q.p.y + q.out.y });
      const h2 = S({ x: q.p.x - q.out.x, y: q.p.y - q.out.y });
      ctx.strokeStyle = OXBLOOD;
      ctx.beginPath();
      ctx.moveTo(h2.x, h2.y);
      ctx.lineTo(h1.x, h1.y);
      ctx.stroke();
      for (const hh of [h1, h2]) {
        ctx.beginPath();
        ctx.arc(hh.x, hh.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#f6ecd3";
        ctx.fill();
        ctx.stroke();
      }
    }
  });
}

/** Show the prompt again after a tool change (canvas.ts calls this on every state change). */
export function refreshPrompt(): void {
  renderPrompt();
}
