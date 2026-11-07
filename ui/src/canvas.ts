// The drafting table: draws the pattern on parchment and handles mouse editing.

import { computedPiece, edit, notify, piece, selectedPieceId, setStatus, snapshot, changed, state, subscribe, uid } from "./store";
import { dist, edgePoints, insertVertex, midpoint, toDesign } from "./ops";
import { snapStep } from "./units";
import type { ComputedPiece, Piece, V } from "./types";

const INK = "#2b1d0e";
const OXBLOOD = "#7a1f1a";
const GOLD = "#b08a3e";
const OK = "#3f6b2a";

const view = { scale: 3, ox: 120, oy: 80 };
let cv: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let hover: { piece: string; edge: number } | null = null;
let hoverWorld: V | null = null;
let spaceDown = false;

type Drag =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "piece"; id: string; start: V; orig: V; moved: boolean }
  | { kind: "vertex"; id: string; index: number; start: V; orig: V; moved: boolean }
  | { kind: "ctrl"; id: string; edge: number; which: 0 | 1; start: V; orig: V; moved: boolean }
  | { kind: "hole"; id: string; hid: string; start: V; orig: V; moved: boolean }
  | { kind: "fold"; id: string; fid: string; start: V; orig: number; moved: boolean };
let drag: Drag | null = null;

const toScreen = (p: V): V => ({ x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale });
const toWorld = (sx: number, sy: number): V => ({ x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale });
const addV = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });

let queued = false;
export function requestDraw(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    draw();
  });
}

export function initCanvas(el: HTMLCanvasElement): void {
  cv = el;
  ctx = el.getContext("2d")!;
  new ResizeObserver(() => resize()).observe(el.parentElement!);
  resize();
  subscribe(requestDraw);
  el.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  el.addEventListener("dblclick", onDouble);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !isTyping()) spaceDown = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") spaceDown = false;
  });
}

export function isTyping(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "SELECT" || a.tagName === "TEXTAREA");
}

function resize(): void {
  const r = cv.parentElement!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.floor(r.width * dpr));
  cv.height = Math.max(1, Math.floor(r.height * dpr));
  cv.style.width = `${r.width}px`;
  cv.style.height = `${r.height}px`;
  draw();
}

export function fitView(): void {
  const b = state.computed?.bounds;
  if (!b) return;
  const r = cv.getBoundingClientRect();
  const pad = 70;
  const w = Math.max(10, b.max.x - b.min.x);
  const h = Math.max(10, b.max.y - b.min.y);
  view.scale = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / h, 12);
  view.ox = r.width / 2 - ((b.min.x + b.max.x) / 2) * view.scale;
  view.oy = r.height / 2 - ((b.min.y + b.max.y) / 2) * view.scale;
  requestDraw();
}

export function viewCenter(): V {
  const r = cv.getBoundingClientRect();
  return toWorld(r.width / 2, r.height / 2);
}

// ---------- drawing ----------

function path(pts: V[], off: V, closed: boolean): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(addV(p, off));
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (closed) ctx.closePath();
}

function drawBackground(w: number, h: number): void {
  ctx.fillStyle = "#efe2c4";
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(255,248,230,0.35)");
  g.addColorStop(1, "rgba(120,80,40,0.28)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const inch = state.project.units === "in";
  const major = inch ? 25.4 : 50;
  const minor = inch ? 25.4 / 4 : 10;
  const tl = toWorld(0, 0);
  const br = toWorld(w, h);
  const lines = (step: number, color: string) => {
    if (step * view.scale < 7) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const sx = Math.round(toScreen({ x, y: 0 }).x) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
      const sy = Math.round(toScreen({ x: 0, y }).y) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();
  };
  lines(minor, "rgba(110,75,40,0.10)");
  lines(major, "rgba(110,75,40,0.22)");
}

function fillFor(pc: Piece): string {
  const kind = state.project.materials.find((m) => m.id === pc.materialId)?.kind;
  if (kind === "waxedCanvas") return "rgba(118,122,72,0.30)";
  if (kind === "other") return "rgba(120,110,100,0.22)";
  return "rgba(168,104,52,0.30)";
}

function drawPiece(pc: Piece, cp: ComputedPiece, selected: boolean): void {
  const off = pc.position;
  const s = view.scale;
  // Leather body with a soft shadow.
  ctx.save();
  ctx.shadowColor = "rgba(60,35,15,0.35)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  path(cp.cut, off, true);
  ctx.fillStyle = fillFor(pc);
  ctx.fill();
  ctx.restore();
  path(cp.cut, off, true);
  ctx.strokeStyle = selected ? OXBLOOD : INK;
  ctx.lineWidth = selected ? 2.2 : 1.4;
  ctx.setLineDash([]);
  ctx.stroke();
  if (pc.seamAllowanceMm > 0) {
    path(cp.outline, off, true);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(43,29,14,0.6)";
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Stitch holes.
  ctx.fillStyle = INK;
  const hr = Math.max(1.1, (pc.stitch.holeMm / 2) * s);
  for (const run of cp.stitchRuns) {
    for (const h of run.holes) {
      const p = toScreen(addV(h, off));
      ctx.beginPath();
      ctx.arc(p.x, p.y, hr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Folds.
  for (const f of cp.folds) {
    const sel = state.sel.kind === "fold" && state.sel.id === f.id;
    ctx.strokeStyle = sel ? OXBLOOD : "rgba(43,29,14,0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (const seg of [...f.start, ...f.end]) {
      path(seg, off, false);
      ctx.stroke();
    }
    ctx.setLineDash([10, 3, 2, 3]);
    ctx.lineWidth = sel ? 2.4 : 1.4;
    ctx.strokeStyle = sel ? OXBLOOD : INK;
    for (const seg of f.center) {
      path(seg, off, false);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const first = f.center[0];
    if (first) {
      const p = toScreen(addV(first[0], off));
      ctx.fillStyle = sel ? OXBLOOD : INK;
      ctx.font = "italic 13px 'EB Garamond', serif";
      ctx.fillText(`fold  +${f.shiftMm.toFixed(1)} mm`, p.x + 8, p.y - 5);
    }
  }
  // Punched holes.
  for (const h of cp.holes) {
    const p = toScreen(addV(h.center, off));
    const sel = state.sel.kind === "hole" && state.sel.id === h.id;
    const r = Math.max(3, (h.diameterMm / 2) * s);
    ctx.strokeStyle = sel ? OXBLOOD : INK;
    ctx.lineWidth = sel ? 2 : 1.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.moveTo(p.x - r - 4, p.y);
    ctx.lineTo(p.x + r + 4, p.y);
    ctx.moveTo(p.x, p.y - r - 4);
    ctx.lineTo(p.x, p.y + r + 4);
    ctx.stroke();
  }
  // Name.
  const c = toScreen(addV({ x: (cp.bounds.min.x + cp.bounds.max.x) / 2, y: (cp.bounds.min.y + cp.bounds.max.y) / 2 }, off));
  ctx.fillStyle = selected ? OXBLOOD : "rgba(43,29,14,0.85)";
  ctx.textAlign = "center";
  ctx.font = `600 ${Math.max(11, Math.min(20, 4.5 * s))}px Cinzel, serif`;
  ctx.fillText(pc.name, c.x, c.y);
  ctx.font = `italic ${Math.max(10, Math.min(15, 3 * s))}px 'EB Garamond', serif`;
  ctx.fillText(`cut ${pc.cutCount}  ·  ${cp.materialName}`, c.x, c.y + Math.max(14, Math.min(22, 5 * s)));
  ctx.textAlign = "left";
}

function drawEdgeHighlight(pc: Piece, cp: ComputedPiece, e: number, color: string, width: number): void {
  const pts = edgePoints(cp, e);
  if (pts.length < 2) return;
  path(pts, pc.position, false);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineCap = "butt";
}

function drawSelection(pc: Piece, cp: ComputedPiece): void {
  const sel = state.sel;
  if (sel.kind === "edge") {
    drawEdgeHighlight(pc, cp, sel.index, GOLD, 5);
    const ctrl = cp.controls[sel.index];
    if (ctrl) {
      const n = cp.vertices.length;
      const a = toScreen(addV(cp.vertices[sel.index], pc.position));
      const b = toScreen(addV(cp.vertices[(sel.index + 1) % n], pc.position));
      const c1 = toScreen(addV(ctrl[0], pc.position));
      const c2 = toScreen(addV(ctrl[1], pc.position));
      ctx.strokeStyle = OXBLOOD;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c1.x, c1.y);
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const c of [c1, c2]) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#f6ecd3";
        ctx.fill();
        ctx.strokeStyle = OXBLOOD;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
  cp.vertices.forEach((v, i) => {
    const p = toScreen(addV(v, pc.position));
    const active = sel.kind === "vertex" && sel.index === i;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = active ? OXBLOOD : GOLD;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.fillRect(-4, -4, 8, 8);
    ctx.strokeRect(-4, -4, 8, 8);
    ctx.restore();
  });
}

function drawJoins(): void {
  const comp = state.computed;
  if (!comp) return;
  for (const j of state.project.joins) {
    const rep = comp.joins.find((r) => r.id === j.id);
    const ends: V[] = [];
    for (const ref of [j.a, j.b]) {
      const pc = piece(ref.pieceId);
      const cp = computedPiece(ref.pieceId);
      if (!pc || !cp) continue;
      const pts = ref.edges.flatMap((e) => edgePoints(cp, e));
      ends.push(toScreen(addV(midpoint(pts), pc.position)));
    }
    if (ends.length !== 2) continue;
    const selected = state.sel.kind === "join" && state.sel.id === j.id;
    const color = rep?.ok ? OK : OXBLOOD;
    const [a, b] = ends;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const bend = Math.max(30, dist(a, b) * 0.25);
    ctx.strokeStyle = color;
    ctx.globalAlpha = selected ? 1 : 0.55;
    ctx.lineWidth = selected ? 2.4 : 1.4;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx + bend, my, b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of ends) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawFoldPreview(): void {
  if (state.tool !== "fold" || !hoverWorld) return;
  const hit = hitPiece(hoverWorld);
  if (!hit) return;
  const pc = piece(hit)!;
  const cp = computedPiece(hit)!;
  const b = cp.bounds;
  const local = { x: hoverWorld.x - pc.position.x, y: hoverWorld.y - pc.position.y };
  const step = snapStep(state.project.units);
  const horiz = state.foldOrientation === "horizontal";
  const c = Math.round((horiz ? local.y : local.x) / step) * step;
  const seg: V[] = horiz ? [{ x: b.min.x, y: c }, { x: b.max.x, y: c }] : [{ x: c, y: b.min.y }, { x: c, y: b.max.y }];
  path(seg, pc.position, false);
  ctx.strokeStyle = OXBLOOD;
  ctx.setLineDash([10, 3, 2, 3]);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function draw(): void {
  if (!ctx || !state.project) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr;
  const h = cv.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground(w, h);
  const comp = state.computed;
  if (!comp) return;
  const selId = selectedPieceId();
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (cp) drawPiece(pc, cp, pc.id === selId);
  }
  drawJoins();
  if (hover) {
    const pc = piece(hover.piece);
    const cp = computedPiece(hover.piece);
    if (pc && cp) drawEdgeHighlight(pc, cp, hover.edge, "rgba(176,138,62,0.75)", 4);
  }
  if (state.joinPending) {
    const pc = piece(state.joinPending.piece);
    const cp = computedPiece(state.joinPending.piece);
    if (pc && cp) drawEdgeHighlight(pc, cp, state.joinPending.edge, OXBLOOD, 5);
  }
  if (selId) {
    const pc = piece(selId);
    const cp = computedPiece(selId);
    if (pc && cp) drawSelection(pc, cp);
  }
  drawFoldPreview();
  drawScaleBar(w, h);
}

function drawScaleBar(_w: number, h: number): void {
  const inch = state.project.units === "in";
  const unit = inch ? 25.4 : 10;
  let n = 1;
  while (n * unit * view.scale < 60) n *= inch ? 2 : 5;
  const len = n * unit * view.scale;
  const x = 18;
  const y = h - 22;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + len, y);
  ctx.lineTo(x + len, y - 5);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = "italic 13px 'EB Garamond', serif";
  ctx.fillText(inch ? `${n} in` : `${n * 10} mm`, x + len + 8, y + 4);
}

// ---------- hit testing ----------

function pointInPoly(p: V, poly: V[], off: V): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = addV(poly[i], off);
    const b = addV(poly[j], off);
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(p: V, a: V, b: V): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitPiece(w: V): string | null {
  for (const pc of [...state.project.pieces].reverse()) {
    const cp = computedPiece(pc.id);
    if (cp && pointInPoly(w, cp.cut, pc.position)) return pc.id;
  }
  return null;
}

function hitEdge(w: V, only?: string): { piece: string; edge: number } | null {
  const tol = 7 / view.scale;
  let best: { piece: string; edge: number; d: number } | null = null;
  for (const pc of state.project.pieces) {
    if (only && pc.id !== only) continue;
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    const m = cp.outline.length;
    for (let i = 0; i < m; i++) {
      const e = cp.outlineEdges[i];
      if (e === null) continue;
      const d = segDist(w, addV(cp.outline[i], pc.position), addV(cp.outline[(i + 1) % m], pc.position));
      if (d < tol && (!best || d < best.d)) best = { piece: pc.id, edge: e, d };
    }
  }
  return best ? { piece: best.piece, edge: best.edge } : null;
}

function hitHandle(w: V): { kind: "vertex"; index: number } | { kind: "ctrl"; edge: number; which: 0 | 1 } | null {
  const id = selectedPieceId();
  if (!id) return null;
  const pc = piece(id)!;
  const cp = computedPiece(id);
  if (!cp) return null;
  const tol = 8 / view.scale;
  const sel = state.sel;
  if (sel.kind === "edge") {
    const c = cp.controls[sel.index];
    if (c) {
      for (const which of [0, 1] as const) if (dist(w, addV(c[which], pc.position)) < tol) return { kind: "ctrl", edge: sel.index, which };
    }
  }
  for (let i = 0; i < cp.vertices.length; i++) if (dist(w, addV(cp.vertices[i], pc.position)) < tol) return { kind: "vertex", index: i };
  return null;
}

function hitHole(w: V): { piece: string; id: string } | null {
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    for (const h of cp.holes) {
      if (dist(w, addV(h.center, pc.position)) < Math.max(h.diameterMm / 2, 7 / view.scale)) return { piece: pc.id, id: h.id };
    }
  }
  return null;
}

function hitFold(w: V): { piece: string; id: string } | null {
  const tol = 6 / view.scale;
  for (const pc of state.project.pieces) {
    const cp = computedPiece(pc.id);
    if (!cp) continue;
    for (const f of cp.folds) {
      for (const seg of f.center) if (segDist(w, addV(seg[0], pc.position), addV(seg[1], pc.position)) < tol) return { piece: pc.id, id: f.id };
    }
  }
  return null;
}

// ---------- interaction ----------

function eventWorld(e: MouseEvent): V {
  const r = cv.getBoundingClientRect();
  return toWorld(e.clientX - r.left, e.clientY - r.top);
}

function snap(v: number, e: MouseEvent): number {
  if (e.altKey) return Math.round(v * 100) / 100;
  const step = snapStep(state.project.units);
  return Math.round(v / step) * step;
}

function onDown(e: MouseEvent): void {
  cv.focus();
  const w = eventWorld(e);
  if (e.button === 1 || e.button === 2 || spaceDown) {
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
    return;
  }
  if (e.button !== 0) return;
  if (state.tool === "hole" || state.tool === "fold") {
    const id = hitPiece(w);
    if (!id) return;
    const pc = piece(id)!;
    const d = toDesign(computedPiece(id), { x: w.x - pc.position.x, y: w.y - pc.position.y });
    if (state.tool === "hole") {
      const hid = uid("h");
      edit(() => pc.holes.push({ id: hid, center: { x: snap(d.x, e), y: snap(d.y, e) }, diameterMm: 3, label: "" }));
      state.sel = { kind: "hole", piece: id, id: hid };
    } else {
      const fid = uid("f");
      const horiz = state.foldOrientation === "horizontal";
      edit(() => pc.folds.push({ id: fid, orientation: state.foldOrientation, position: snap(horiz ? d.y : d.x, e), contentsMm: 0 }));
      state.sel = { kind: "fold", piece: id, id: fid };
      state.tool = "select";
    }
    notify();
    return;
  }
  if (state.tool === "join") {
    const hit = hitEdge(w);
    if (!hit) return;
    if (!state.joinPending) {
      state.joinPending = hit;
      setStatus("Now click the edge it sews to.");
    } else {
      const a = state.joinPending;
      if (a.piece === hit.piece && a.edge === hit.edge) return;
      const jid = uid("j");
      edit((p) => p.joins.push({ id: jid, a: { pieceId: a.piece, edges: [a.edge] }, b: { pieceId: hit.piece, edges: [hit.edge] } }));
      state.joinPending = null;
      state.sel = { kind: "join", id: jid };
      setStatus("Joined. The inspector shows whether the two sides match.");
    }
    notify();
    return;
  }
  // Select tool.
  const h = hitHandle(w);
  const id = selectedPieceId();
  if (h && id) {
    const pc = piece(id)!;
    if (h.kind === "vertex") {
      state.sel = { kind: "vertex", piece: id, index: h.index };
      drag = { kind: "vertex", id, index: h.index, start: w, orig: { ...pc.vertices[h.index] }, moved: false };
    } else {
      const edge = pc.edges[h.edge];
      if (edge.type === "cubic") {
        drag = { kind: "ctrl", id, edge: h.edge, which: h.which, start: w, orig: { ...(h.which === 0 ? edge.c1 : edge.c2) }, moved: false };
      }
    }
    notify();
    return;
  }
  const hole = hitHole(w);
  if (hole) {
    state.sel = { kind: "hole", piece: hole.piece, id: hole.id };
    const hd = piece(hole.piece)!.holes.find((x) => x.id === hole.id)!;
    drag = { kind: "hole", id: hole.piece, hid: hole.id, start: w, orig: { ...hd.center }, moved: false };
    notify();
    return;
  }
  const fold = hitFold(w);
  if (fold) {
    state.sel = { kind: "fold", piece: fold.piece, id: fold.id };
    const fd = piece(fold.piece)!.folds.find((x) => x.id === fold.id)!;
    drag = { kind: "fold", id: fold.piece, fid: fold.id, start: w, orig: fd.position, moved: false };
    notify();
    return;
  }
  if (id) {
    const edge = hitEdge(w, id);
    if (edge) {
      state.sel = { kind: "edge", piece: id, index: edge.edge };
      notify();
      return;
    }
  }
  const pid = hitPiece(w);
  if (pid) {
    state.sel = { kind: "piece", piece: pid };
    drag = { kind: "piece", id: pid, start: w, orig: { ...piece(pid)!.position }, moved: false };
  } else {
    state.sel = { kind: "none" };
  }
  notify();
}

function onMove(e: MouseEvent): void {
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  const w = eventWorld(e);
  if (!drag) {
    hoverWorld = inside ? w : null;
    const prev = hover;
    if (!inside) hover = null;
    else if (state.tool === "join") hover = hitEdge(w);
    else if (state.tool === "select" && selectedPieceId()) hover = hitEdge(w, selectedPieceId()!);
    else hover = null;
    if (prev?.piece !== hover?.piece || prev?.edge !== hover?.edge || state.tool === "fold") requestDraw();
    cv.style.cursor = spaceDown ? "grab" : state.tool === "select" ? (hover ? "pointer" : "default") : "crosshair";
    return;
  }
  if (drag.kind === "pan") {
    view.ox = drag.ox + (e.clientX - drag.sx);
    view.oy = drag.oy + (e.clientY - drag.sy);
    requestDraw();
    return;
  }
  const dx = w.x - drag.start.x;
  const dy = w.y - drag.start.y;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) * view.scale < 3) return;
    drag.moved = true;
    snapshot();
  }
  const pc = piece(drag.id);
  if (!pc) return;
  switch (drag.kind) {
    case "piece":
      pc.position = { x: snap(drag.orig.x + dx, e), y: snap(drag.orig.y + dy, e) };
      notify();
      return;
    case "vertex":
      pc.vertices[drag.index] = { x: snap(drag.orig.x + dx, e), y: snap(drag.orig.y + dy, e) };
      break;
    case "ctrl": {
      const edge = pc.edges[drag.edge];
      if (edge.type !== "cubic") return;
      const p = { x: snap(drag.orig.x + dx, e), y: snap(drag.orig.y + dy, e) };
      if (drag.which === 0) edge.c1 = p;
      else edge.c2 = p;
      break;
    }
    case "hole": {
      const hd = pc.holes.find((x) => x.id === (drag as { hid: string }).hid);
      if (hd) hd.center = { x: snap(drag.orig.x + dx, e), y: snap(drag.orig.y + dy, e) };
      break;
    }
    case "fold": {
      const fd = pc.folds.find((x) => x.id === (drag as { fid: string }).fid);
      if (fd) fd.position = snap(drag.orig + (fd.orientation === "horizontal" ? dy : dx), e);
      break;
    }
  }
  changed();
}

function onUp(): void {
  drag = null;
}

function onDouble(e: MouseEvent): void {
  const id = selectedPieceId();
  if (!id || state.tool !== "select") return;
  const w = eventWorld(e);
  const hit = hitEdge(w, id);
  if (!hit) return;
  const pc = piece(id)!;
  const d = toDesign(computedPiece(id), { x: w.x - pc.position.x, y: w.y - pc.position.y });
  let idx = 0;
  edit((p) => (idx = insertVertex(p, pc, hit.edge, d)));
  state.sel = { kind: "vertex", piece: id, index: idx };
  setStatus("Added a corner. Drag it, or press Delete to remove it.");
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  const before = toWorld(sx, sy);
  const factor = Math.exp(-e.deltaY * 0.0015);
  view.scale = Math.min(60, Math.max(0.2, view.scale * factor));
  view.ox = sx - before.x * view.scale;
  view.oy = sy - before.y * view.scale;
  requestDraw();
}
