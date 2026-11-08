// Leather tooling: the Tooling panel (a big, plain palette of tools and ready-made designs), the
// selected-stroke controls, and the stroke geometry the 2D pattern and the 3D leather both draw.
//
// Geometry here mirrors crates/hidework-core/src/tooling.rs (flatten, impressions, face); keep the
// two in step. Strokes are stored on Piece.tooling in piece design coordinates; `toStaged` moves a
// design point through the piece's fold allowances, as compute.rs does for holes and marks.

import "./tooling.css";
import { invoke } from "@tauri-apps/api/core";
import { h, keepScroll } from "./dom";
import { ensureVisible } from "./layout";
import { edit, notify, piece, setStatus, state, subscribe, uid } from "./store";
import type { ComputedPiece, Design, DesignRequest, Piece, Rect, StrokeKind, ToolingStroke, ToolKind, V } from "./types";

// ---------- the tools ----------

export type How = "cut" | "line" | "stamp" | "fill" | "letters";

export interface ToolDef {
  tool: ToolKind;
  name: string;
  /** Face width (cut width for the knife), spacing and depth, mm (tooling.rs tool_info). */
  size: number;
  spacing: number;
  depth: number;
  says: string;
  /** Ways to use it, the usual one first. */
  hows: How[];
}

export const TOOLS: ToolDef[] = [
  { tool: "swivelKnife", name: "Swivel knife", size: 0.6, spacing: 0, depth: 0.8, says: "Cuts the lines of your design.", hows: ["cut"] },
  { tool: "beveler", name: "Beveler", size: 6, spacing: 3, depth: 0.6, says: "Walk it beside a cut so the design stands up.", hows: ["line", "stamp"] },
  { tool: "backgrounder", name: "Background", size: 4, spacing: 3.5, depth: 0.5, says: "Presses the background down dark.", hows: ["fill", "stamp", "line"] },
  { tool: "pearShader", name: "Pear shader", size: 8, spacing: 6, depth: 0.35, says: "Soft hollows to shade petals and leaves.", hows: ["stamp", "line", "fill"] },
  { tool: "seeder", name: "Seeder", size: 3, spacing: 4, depth: 0.4, says: "Little round seeds for flower centres.", hows: ["stamp", "line", "fill"] },
  { tool: "camouflage", name: "Camouflage", size: 7, spacing: 6, depth: 0.4, says: "Ribbed crescents along stems and leaves.", hows: ["line", "stamp"] },
  { tool: "veiner", name: "Veiner", size: 8, spacing: 5, depth: 0.4, says: "Lined half-moons for leaf veins.", hows: ["line", "stamp"] },
  { tool: "muleFoot", name: "Mule foot", size: 6, spacing: 6, depth: 0.4, says: "A little horseshoe, in rows.", hows: ["line", "stamp"] },
  { tool: "basketweave", name: "Basketweave", size: 12, spacing: 10, depth: 0.5, says: "The woven basket look, in a grid.", hows: ["fill", "stamp"] },
  { tool: "border", name: "Border stamp", size: 6, spacing: 6, depth: 0.45, says: "One stamp repeated along a line.", hows: ["line", "stamp"] },
  { tool: "letter", name: "Letters", size: 12, spacing: 9.6, depth: 0.5, says: "Alphabet and number stamps.", hows: ["letters"] },
];

export const DESIGNS: { design: Design; name: string; says: string }[] = [
  { design: "border", name: "Border", says: "Click a piece. A cut line goes round it inside the stitching, beveled, with a row of stamps." },
  { design: "basketweave", name: "Basketweave", says: "Click a piece to fill it with basketweave, or drag a box over part of it." },
  { design: "floral", name: "Flower", says: "Click where the middle of the flower goes." },
  { design: "corner", name: "Corner", says: "Click near the corner you want to decorate." },
  { design: "checkerboard", name: "Checkerboard", says: "Click where the middle goes, or drag a box." },
  { design: "diamond", name: "Diamonds", says: "Click where the middle goes, or drag a box." },
  { design: "monogram", name: "Monogram", says: "Type the initials, then click where they go." },
];

const HOW_NAMES: Record<How, string> = { cut: "Cut a line", line: "Along a line", stamp: "One at a time", fill: "Fill an area", letters: "Letters" };
const HOW_SAYS: Record<How, string> = {
  cut: "Hold the mouse button down and draw the line on the leather. Or click point by point, then double-click to finish.",
  line: "Draw where the stamps go: hold the button down and draw, or click point by point, then double-click.",
  stamp: "Click on the leather wherever you want to strike the stamp.",
  fill: "Drag a box over the area to fill. Or click inside a closed cut line to fill that shape.",
  letters: "Type the letters below, then click where the first letter goes.",
};

export function toolDef(t: ToolKind): ToolDef {
  return TOOLS.find((x) => x.tool === t) ?? TOOLS[0];
}

export function toolName(t: ToolKind): string {
  return toolDef(t).name;
}

/** What the 2D canvas does while the Tooling tool is on. */
export const tooling = {
  tool: "swivelKnife" as ToolKind,
  how: "cut" as How,
  /** A ready-made design to place instead of a tool. */
  design: null as Design | null,
  /** Size and spacing for new strokes; 0 = the tool's usual. */
  sizeMm: 0,
  spacingMm: 0,
  text: "ABC",
  initials: "AB",
};

/** Set by canvas.ts: finish whatever is being drawn. Returns true when something was pending. */
export const hooks = { finish: (): boolean => false };

// ---------- geometry (mirrors tooling.rs) ----------

const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const len = (a: V): number => Math.hypot(a.x, a.y);
const dist = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);
const norm = (a: V): V => {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
const left = (a: V): V => ({ x: -a.y, y: a.x });

export function strokeSize(s: ToolingStroke): number {
  return (s.sizeMm ?? 0) > 0 ? s.sizeMm! : toolDef(s.tool).size;
}

export function strokeSpacing(s: ToolingStroke): number {
  // Letters keep their usual spacing in step with their height.
  if (s.tool === "letter" && !((s.spacingMm ?? 0) > 0)) return strokeSize(s) * 0.8;
  const sp = (s.spacingMm ?? 0) > 0 ? s.spacingMm! : toolDef(s.tool).spacing;
  return sp > 0 ? Math.max(0.5, sp) : Math.max(1, strokeSize(s));
}

export function strokeDepth(s: ToolingStroke): number {
  return (s.depthMm ?? 0) > 0 ? s.depthMm! : toolDef(s.tool).depth;
}

export function isClosed(s: ToolingStroke): boolean {
  return !!s.closed || s.kind === "fill";
}

function cubic(a: V, c1: V, c2: V, b: V, t: number): V {
  const u = 1 - t;
  return add(add(mul(a, u * u * u), mul(c1, 3 * u * u * t)), add(mul(c2, 3 * u * t * t), mul(b, t * t * t)));
}

/** A path through the points, smooth (Catmull-Rom) or straight. Closed paths do not repeat the start. */
export function smoothPath(pts: V[], closed: boolean, smooth: boolean): V[] {
  const n = pts.length;
  if (!smooth || n < 3) return pts.slice();
  const at = (i: number): V => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const spans = closed ? n : n - 1;
  const out = [pts[0]];
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1 = add(p1, mul(sub(p2, p0), 1 / 6));
    const c2 = sub(p2, mul(sub(p3, p1), 1 / 6));
    const steps = Math.max(2, Math.min(60, Math.ceil(dist(p1, p2) / 0.75)));
    for (let k = 1; k <= steps; k++) out.push(cubic(p1, c1, c2, p2, k / steps));
  }
  if (closed) out.pop();
  return out;
}

export function flatten(s: ToolingStroke): V[] {
  return smoothPath(s.points, isClosed(s), !!s.smooth);
}

export interface Impression {
  at: V;
  angleDeg: number;
  ch?: string;
}

export function faceDepth(tool: ToolKind, size: number): number {
  switch (tool) {
    case "beveler": return size * 0.5;
    case "basketweave": return size * 0.6;
    case "camouflage": case "veiner": case "pearShader": return size * 0.55;
    default: return size;
  }
}

function pointAndDirection(pts: V[], s: number): [V, V] {
  let acc = 0;
  let last: V = { x: 1, y: 0 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = dist(pts[i], pts[i + 1]);
    if (l < 1e-12) continue;
    last = norm(sub(pts[i + 1], pts[i]));
    if (acc + l >= s - 1e-9) {
      const t = Math.max(0, Math.min(1, (s - acc) / l));
      return [add(pts[i], mul(sub(pts[i + 1], pts[i]), t)), last];
    }
    acc += l;
  }
  return [pts[pts.length - 1], last];
}

export function pointInPolygon(p: V, poly: V[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function bounds(pts: V[]): Rect {
  const r = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
  for (const p of pts) {
    r.min.x = Math.min(r.min.x, p.x);
    r.min.y = Math.min(r.min.y, p.y);
    r.max.x = Math.max(r.max.x, p.x);
    r.max.y = Math.max(r.max.y, p.y);
  }
  return r;
}

/** Where every stamp strikes (in the stroke's own coordinates). A cut has none. */
export function impressions(s: ToolingStroke): Impression[] {
  const ang = s.angleDeg ?? 0;
  switch (s.kind) {
    case "cut":
      return [];
    case "stamp":
      return s.points.map((at) => ({ at, angleDeg: ang }));
    case "letters": {
      const start = s.points[0];
      if (!start) return [];
      const a = (ang * Math.PI) / 180;
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const sp = strokeSpacing(s);
      const out: Impression[] = [];
      [...(s.text ?? "")].forEach((ch, i) => {
        if (!/\s/.test(ch)) out.push({ at: add(start, mul(dir, i * sp)), angleDeg: ang, ch });
      });
      return out;
    }
    case "line": {
      const pts = flatten(s);
      if (!pts.length) return [];
      if (s.closed && pts.length > 2) pts.push(pts[0]);
      let total = 0;
      for (let i = 0; i + 1 < pts.length; i++) total += dist(pts[i], pts[i + 1]);
      const sp = strokeSpacing(s);
      const offs: number[] = [];
      if (total < 1e-6) offs.push(0);
      else {
        const n = Math.max(1, Math.round(total / sp));
        const count = s.closed ? n : n + 1;
        for (let k = 0; k < count; k++) offs.push((k * total) / n);
      }
      const across = faceDepth(s.tool, strokeSize(s)) / 2 + (s.tool === "beveler" ? 0.2 : 0);
      const side = Math.sign(s.side ?? 0);
      return offs.map((o) => {
        const [p, d] = pointAndDirection(pts, o);
        return { at: add(p, mul(left(d), across * side)), angleDeg: (Math.atan2(d.y, d.x) * 180) / Math.PI + ang };
      });
    }
    case "fill": {
      const region = flatten(s);
      if (region.length < 3) return [];
      const sp = strokeSpacing(s);
      const a = (ang * Math.PI) / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      const r = bounds(region);
      const c = { x: (r.min.x + r.max.x) / 2, y: (r.min.y + r.max.y) / 2 };
      const toGrid = (p: V): V => {
        const d = sub(p, c);
        return { x: d.x * ca + d.y * sa, y: -d.x * sa + d.y * ca };
      };
      const fromGrid = (q: V): V => ({ x: c.x + q.x * ca - q.y * sa, y: c.y + q.x * sa + q.y * ca });
      const g = bounds(region.map(toGrid));
      const gw = g.max.x - g.min.x, gh = g.max.y - g.min.y;
      const gc = { x: (g.min.x + g.max.x) / 2, y: (g.min.y + g.max.y) / 2 };
      const out: Impression[] = [];
      if (s.tool === "basketweave") {
        const nx = Math.max(1, Math.floor(gw / sp + 1e-9));
        const ny = Math.max(1, Math.floor(gh / sp + 1e-9));
        const x0 = gc.x - ((nx - 1) * sp) / 2;
        const y0 = gc.y - ((ny - 1) * sp) / 2;
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const p = fromGrid({ x: x0 + i * sp, y: y0 + j * sp });
            if (pointInPolygon(p, region)) out.push({ at: p, angleDeg: ang + ((i + j) % 2 === 1 ? 90 : 0) });
          }
      } else {
        const dy = sp * 0.866;
        const ny = Math.floor(gh / dy) + 1;
        const y0 = gc.y - ((ny - 1) * dy) / 2;
        for (let j = 0; j < ny; j++) {
          const shift = j % 2 === 1 ? sp / 2 : 0;
          const nx = Math.floor(gw / sp) + 2;
          const x0 = gc.x - ((nx - 1) * sp) / 2 + shift - sp / 4;
          for (let i = 0; i < nx; i++) {
            const p = fromGrid({ x: x0 + i * sp, y: y0 + j * dy });
            if (pointInPolygon(p, region)) out.push({ at: p, angleDeg: ang });
          }
        }
      }
      return out;
    }
  }
}

/** A stamp face in its own frame (+x along the impression angle): polylines and whether each closes. */
export function face(tool: ToolKind, size: number): [V[], boolean][] {
  const hh = size / 2;
  const rect = (w: number, d: number): V[] => [{ x: -w / 2, y: -d / 2 }, { x: w / 2, y: -d / 2 }, { x: w / 2, y: d / 2 }, { x: -w / 2, y: d / 2 }];
  const arc = (r: number, a0: number, a1: number, cx: number, cy: number, n: number): V[] => {
    const out: V[] = [];
    for (let k = 0; k <= n; k++) {
      const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180;
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  };
  switch (tool) {
    case "swivelKnife": return [];
    case "beveler": return [[rect(size, size * 0.5), true]];
    case "backgrounder": return [[rect(size, size), true]];
    case "seeder": return [[arc(hh, 0, 360, 0, 0, 16), true], [arc(hh * 0.45, 0, 360, 0, 0, 10), true]];
    case "pearShader": return [[[...arc(hh * 0.55, -110, 110, hh * 0.4, 0, 12), { x: -hh, y: 0 }], true]];
    case "camouflage": {
      const out: [V[], boolean][] = [[[...arc(hh, -70, 70, -hh * 0.4, 0, 10), ...arc(hh * 0.55, 70, -70, -hh * 0.4, 0, 8)], true]];
      for (const a of [-40, 0, 40]) {
        const r = (a * Math.PI) / 180;
        out.push([[{ x: -hh * 0.4 + hh * 0.6 * Math.cos(r), y: hh * 0.6 * Math.sin(r) }, { x: -hh * 0.4 + hh * 0.95 * Math.cos(r), y: hh * 0.95 * Math.sin(r) }], false]);
      }
      return out;
    }
    case "veiner": {
      const out: [V[], boolean][] = [[[...arc(hh, -90, 90, -hh * 0.3, 0, 12), { x: -hh * 0.3, y: -hh }], true]];
      for (let k = 1; k < 4; k++) {
        const x = -hh * 0.3 + hh * 0.25 * k;
        const y = Math.sqrt(Math.max(0, hh * hh - (x + hh * 0.3) ** 2));
        out.push([[{ x, y: -y }, { x, y }], false]);
      }
      return out;
    }
    case "muleFoot": return [[[{ x: -hh, y: -hh * 0.7 }, ...arc(hh * 0.7, -90, 90, 0, 0, 12), { x: -hh, y: hh * 0.7 }], false]];
    case "basketweave": {
      const w = size, d = size * 0.6;
      const out: [V[], boolean][] = [[rect(w, d), true]];
      for (let k = 1; k < 4; k++) {
        const y = -d / 2 + (d * k) / 4;
        out.push([[{ x: -w / 2 + 0.6, y }, { x: w / 2 - 0.6, y }], false]);
      }
      return out;
    }
    case "border": return [[[{ x: -hh, y: 0 }, { x: 0, y: -hh * 0.6 }, { x: hh, y: 0 }, { x: 0, y: hh * 0.6 }], true], [arc(hh * 0.18, 0, 360, 0, 0, 8), true]];
    case "letter": return [[rect(size * 0.75, size), true]];
  }
}

/** A design point carried through the computed piece's fold allowances (tooling.rs to_staged). */
export function toStaged(cp: ComputedPiece | undefined, p: V): V {
  if (!cp?.folds.length) return p;
  let { x, y } = p;
  for (const f of cp.folds) {
    if (f.orientation === "horizontal") {
      if (y - f.stageAt > 1e-9) y += f.shiftMm;
    } else if (x - f.stageAt > 1e-9) x += f.shiftMm;
  }
  return { x, y };
}

/** Which `side` of a closed loop is outside it. */
export function outsideSide(loop: V[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a > 0 ? -1 : 1;
}

/** Douglas-Peucker: drop points within `eps` of the line through their neighbours. */
export function simplify(pts: V[], eps: number): V[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let best = -1, bd = eps;
    const a = pts[i0], b = pts[i1];
    for (let i = i0 + 1; i < i1; i++) {
      const d = segDist(pts[i], a, b);
      if (d > bd) [best, bd] = [i, d];
    }
    if (best > 0) {
      keep[best] = true;
      stack.push([i0, best], [best, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function segDist(p: V, a: V, b: V): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---------- strokes on pieces ----------

export function strokes(pc: Piece | undefined): ToolingStroke[] {
  return pc?.tooling ?? [];
}

/** The selected stroke and every stroke of its design group. */
export function selectedStrokes(): { pc: Piece; s: ToolingStroke; group: ToolingStroke[] } | null {
  const sel = state.sel;
  if (sel.kind !== "tooling") return null;
  const pc = piece(sel.piece);
  const s = strokes(pc).find((x) => x.id === sel.id);
  if (!pc || !s) return null;
  const group = s.group ? strokes(pc).filter((x) => x.group === s.group) : [s];
  return { pc, s, group };
}

export function isSelectedStroke(pid: string, s: ToolingStroke): boolean {
  const sel = state.sel;
  if (sel.kind !== "tooling" || sel.piece !== pid) return false;
  if (sel.id === s.id) return true;
  if (!s.group) return false;
  return strokes(piece(pid)).some((x) => x.id === sel.id && x.group === s.group);
}

/** Add a stroke to a piece (one undo step) and select it. */
export function addStroke(pid: string, s: Omit<ToolingStroke, "id"> & { id?: string }): ToolingStroke | null {
  const pc = piece(pid);
  if (!pc) return null;
  const stroke = { ...s, id: s.id ?? uid("tl") } as ToolingStroke;
  edit(() => (pc.tooling = [...(pc.tooling ?? []), stroke]));
  state.sel = { kind: "tooling", piece: pid, id: stroke.id };
  notify();
  return stroke;
}

/** A new stroke of the armed tool with these points. */
export function newStroke(kind: StrokeKind, points: V[], extra: Partial<ToolingStroke> = {}): Omit<ToolingStroke, "id"> {
  return { kind, tool: kind === "cut" ? "swivelKnife" : tooling.tool, points, sizeMm: tooling.sizeMm, spacingMm: tooling.spacingMm, angleDeg: 0, side: 0, ...extra };
}

/** Place a ready-made design (built by the Rust core) on a piece. */
export async function placeDesign(pid: string, at: V, rect: Rect | null = null): Promise<void> {
  const pc = piece(pid);
  const design = tooling.design;
  if (!pc || !design) return;
  const group = uid("tg");
  const request: DesignRequest = { design, at, sizeMm: 0, tool: design === "border" ? borderStamp() : null, insetMm: 0, text: tooling.initials, rect };
  let made: ToolingStroke[];
  try {
    made = await invoke<ToolingStroke[]>("tooling_design", { piece: pc, request, id: group });
  } catch (e) {
    setStatus(`Could not make the design: ${e}`);
    return;
  }
  if (!made.length) return setStatus("That design does not fit on this piece.");
  edit(() => (pc.tooling = [...(pc.tooling ?? []), ...made]));
  state.sel = { kind: "tooling", piece: pid, id: made[0].id };
  setStatus(`${DESIGNS.find((d) => d.design === design)?.name ?? "Design"} added. Drag it to move it; use Bigger or Smaller in the Tooling panel.`);
}

/** Stamps that can make the row of a border design. */
const BORDER_STAMPS = (): ToolDef[] => TOOLS.filter((t) => t.hows.includes("line") && t.tool !== "beveler");

/** The stamp the Border design uses: the armed tool if it can make a border row, else the border stamp. */
function borderStamp(): ToolKind {
  return BORDER_STAMPS().some((t) => t.tool === tooling.tool) ? tooling.tool : "border";
}

function editStrokes(fn: (pc: Piece, list: ToolingStroke[]) => void): void {
  const cur = selectedStrokes();
  if (!cur) return;
  edit(() => fn(cur.pc, cur.group));
}

/** Move the selected stroke (or its whole design) by d mm. */
export function nudgeStrokes(d: V): void {
  editStrokes((_, list) => list.forEach((s) => (s.points = s.points.map((p) => add(p, d)))));
}

export function deleteStrokes(all = true): void {
  const cur = selectedStrokes();
  if (!cur) return;
  const gone = new Set((all ? cur.group : [cur.s]).map((s) => s.id));
  edit(() => (cur.pc.tooling = strokes(cur.pc).filter((s) => !gone.has(s.id))));
  state.sel = { kind: "piece", piece: cur.pc.id };
  setStatus(gone.size > 1 ? "Design removed. Ctrl+Z brings it back." : "Tooling line removed. Ctrl+Z brings it back.");
}

/** Spread the selected design out or draw it in about its middle (stamps keep their real size). */
export function scaleStrokes(k: number): void {
  const cur = selectedStrokes();
  if (!cur) return;
  const all = cur.group.flatMap((s) => s.points);
  const b = bounds(all);
  const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
  edit(() => cur.group.forEach((s) => (s.points = s.points.map((p) => add(c, mul(sub(p, c), k))))));
}

/** Walk a beveler along the selected cut, on its outside (or the left of an open cut). */
export function bevelAlong(): void {
  const cur = selectedStrokes();
  if (!cur || cur.s.kind !== "cut") return;
  const s = cur.s;
  const side = s.closed ? outsideSide(flatten(s)) : 1;
  addStroke(cur.pc.id, { kind: "line", tool: "beveler", points: s.points.map((p) => ({ ...p })), smooth: s.smooth, closed: s.closed, side, group: s.group ?? "", sizeMm: 0, spacingMm: 0, angleDeg: 0 });
  setStatus("Beveler walked along the cut. Use Other side if it should be on the other side.");
}

function setOnSelected(fn: (s: ToolingStroke) => void): void {
  const cur = selectedStrokes();
  if (!cur) return;
  edit(() => fn(cur.s));
}

// ---------- the panel ----------

let panelEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let lastSig = "";

/** Open the Tooling panel (or bring it forward). */
export function openTooling(): void {
  if (!panelEl) {
    bodyEl = h("div", { class: "tl-body" });
    const close = h("button", { class: "tl-close", type: "button", title: "Close the Tooling panel", onclick: () => closeTooling() }, "Close");
    const title = h("div", { class: "tl-title" }, h("h2", {}, "Tooling"), close);
    panelEl = h("aside", { class: "tl-panel", role: "dialog", "aria-label": "Tooling" }, title, bodyEl);
    dragBy(title, panelEl);
    document.body.append(panelEl);
    subscribe(() => renderPanel(false));
  }
  panelEl.classList.remove("tl-hidden");
  renderPanel(true);
  if (state.tool !== "tooling") setStatus("Tooling: pick a tool or a ready-made design from the panel.");
}

export function closeTooling(): void {
  panelEl?.classList.add("tl-hidden");
  if (state.tool === "tooling") stopTooling();
}

export function toolingOpen(): boolean {
  return !!panelEl && !panelEl.classList.contains("tl-hidden");
}

const ALIASES: Record<string, ToolKind | `design:${Design}`> = {
  knife: "swivelKnife", swivel: "swivelKnife", cut: "swivelKnife", "swivel-knife": "swivelKnife",
  bevel: "beveler", beveller: "beveler", background: "backgrounder", pear: "pearShader", "pear-shader": "pearShader", shader: "pearShader",
  seed: "seeder", camo: "camouflage", vein: "veiner", mule: "muleFoot", "mule-foot": "muleFoot", basket: "basketweave",
  letters: "letter", alphabet: "letter", numbers: "letter", stamp: "border",
  flower: "design:floral", floral: "design:floral", corner: "design:corner", monogram: "design:monogram", initials: "design:monogram",
  checkerboard: "design:checkerboard", checker: "design:checkerboard", diamond: "design:diamond", diamonds: "design:diamond",
};

/**
 * Arm a tooling tool on the 2D pattern: a tool name (`swivelKnife`, `beveler`, `backgrounder`,
 * `pearShader`, `seeder`, `camouflage`, `veiner`, `muleFoot`, `basketweave`, `border`, `letter`,
 * or plain words like "knife", "bevel", "seed"), or a ready-made design as `design:border`,
 * `design:basketweave`, `design:floral`, `design:corner`, `design:checkerboard`,
 * `design:diamond`, `design:monogram` (also "flower", "corner", "monogram"). Opens the panel.
 */
export function startTooling(tool: string): void {
  const key = tool.trim();
  const lower = key.toLowerCase();
  const found: string = TOOLS.find((t) => t.tool.toLowerCase() === lower)?.tool ?? ALIASES[lower] ?? (lower.startsWith("design:") ? `design:${lower.slice(7)}` : key);
  if (found.startsWith("design:")) {
    const d = found.slice(7) as Design;
    if (!DESIGNS.some((x) => x.design === d)) return setStatus(`There is no ready-made design called ${d}.`);
    tooling.design = d;
  } else {
    const t = TOOLS.find((x) => x.tool === found);
    if (!t) return setStatus(`There is no tooling tool called ${tool}.`);
    tooling.design = null;
    if (tooling.tool !== t.tool) {
      tooling.tool = t.tool;
      tooling.how = t.hows[0];
      tooling.sizeMm = 0;
      tooling.spacingMm = 0;
    }
  }
  hooks.finish();
  ensureVisible("2d");
  state.tool = "tooling";
  state.joinPending = null;
  openTooling();
  setStatus(armedHint() + " Press Esc when you are done.");
}

/** Back to the Select tool (finishing anything half drawn). */
export function stopTooling(): void {
  hooks.finish();
  if (state.tool === "tooling") state.tool = "select";
  notify();
}

export function armedHint(): string {
  if (tooling.design) return DESIGNS.find((d) => d.design === tooling.design)?.says ?? "";
  return HOW_SAYS[tooling.how];
}

function renderPanel(force: boolean): void {
  if (!bodyEl || !panelEl || panelEl.classList.contains("tl-hidden")) return;
  const sel = selectedStrokes();
  const sig = JSON.stringify([state.tool, tooling, sel?.s, sel?.group.length, sel?.pc.id, state.project?.units]);
  if (!force && sig === lastSig) return;
  // Leave a field alone while it is being typed in.
  if (!force && bodyEl.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
  lastSig = sig;
  const body = bodyEl;
  keepScroll(body, () => body.replaceChildren(...buildPanel()));
}

function buildPanel(): Node[] {
  const on = state.tool === "tooling";
  const out: Node[] = [];
  out.push(h("p", { class: "tl-lead" }, "1. Pick a tool, then work on the leather in the pattern."));
  const grid = h("div", { class: "tl-grid" });
  for (const t of TOOLS) {
    const active = on && !tooling.design && tooling.tool === t.tool;
    grid.append(card(toolPicture(t.tool), t.name, t.says, active, () => startTooling(t.tool)));
  }
  out.push(grid);
  out.push(h("h3", {}, "Ready-made designs"));
  const dgrid = h("div", { class: "tl-grid" });
  for (const d of DESIGNS) {
    const active = on && tooling.design === d.design;
    dgrid.append(card(designPicture(d.design), d.name, "", active, () => startTooling(`design:${d.design}`)));
  }
  out.push(dgrid);
  if (on) out.push(...armedSection());
  else out.push(h("p", { class: "tl-hint" }, "Click any tooling on the pattern to change it."));
  const cur = selectedStrokes();
  if (cur) out.push(...strokeControls());
  return out;
}

function card(pic: HTMLCanvasElement, name: string, says: string, active: boolean, onclick: () => void): HTMLElement {
  return h("button", { type: "button", class: `tl-card${active ? " tl-on" : ""}`, title: says || name, onclick, "aria-pressed": active ? "true" : "false" }, pic, h("span", { class: "tl-name" }, name));
}

function stepper(label: string, value: string, minus: () => void, plus: () => void, usual?: () => void): HTMLElement {
  return h(
    "div",
    { class: "tl-step" },
    h("span", { class: "tl-step-label" }, label),
    h("button", { type: "button", class: "tl-big", onclick: minus, "aria-label": `${label} smaller` }, "−"),
    h("span", { class: "tl-value" }, value),
    h("button", { type: "button", class: "tl-big", onclick: plus, "aria-label": `${label} bigger` }, "+"),
    usual ? h("button", { type: "button", class: "tl-small", onclick: usual }, "Usual") : null,
  );
}

const mm = (v: number) => `${Math.round(v * 10) / 10} mm`;

function armedSection(): Node[] {
  const out: Node[] = [h("h3", {}, "2. How to use it")];
  if (tooling.design) {
    const d = DESIGNS.find((x) => x.design === tooling.design)!;
    out.push(h("p", { class: "tl-say" }, d.says));
    if (d.design === "monogram") {
      const inp = h("input", { type: "text", class: "tl-text", value: tooling.initials, maxLength: 3, "data-key": "tl-initials", "aria-label": "Initials" });
      inp.addEventListener("input", () => (tooling.initials = inp.value));
      out.push(h("label", { class: "tl-field" }, h("span", {}, "Initials"), inp));
    }
    if (d.design === "border") {
      const row = h("div", { class: "tl-hows" }, h("span", { class: "tl-step-label" }, "Stamp"));
      for (const t of BORDER_STAMPS()) {
        const pick = t.tool === borderStamp();
        row.append(h("button", { type: "button", class: `tl-how${pick ? " tl-on" : ""}`, onclick: () => { tooling.tool = t.tool; notify(); } }, t.name));
      }
      out.push(row);
    }
  } else {
    const t = toolDef(tooling.tool);
    if (t.hows.length > 1) {
      const row = h("div", { class: "tl-hows" });
      for (const how of t.hows) row.append(h("button", { type: "button", class: `tl-how${how === tooling.how ? " tl-on" : ""}`, onclick: () => { hooks.finish(); tooling.how = how; setStatus(HOW_SAYS[how]); } }, HOW_NAMES[how]));
      out.push(row);
    }
    out.push(h("p", { class: "tl-say" }, HOW_SAYS[tooling.how]));
    if (tooling.how === "letters") {
      const inp = h("input", { type: "text", class: "tl-text", value: tooling.text, "data-key": "tl-letters", "aria-label": "Letters to stamp" });
      inp.addEventListener("input", () => (tooling.text = inp.value));
      out.push(h("label", { class: "tl-field" }, h("span", {}, "Letters to stamp"), inp));
    }
    const size = tooling.sizeMm || t.size;
    if (t.tool !== "swivelKnife") {
      out.push(stepper(t.tool === "letter" ? "Letter height" : "Stamp size", mm(size) + (tooling.sizeMm ? "" : " (usual)"), () => { tooling.sizeMm = Math.max(1, size - 1); notify(); }, () => { tooling.sizeMm = size + 1; notify(); }, tooling.sizeMm ? () => { tooling.sizeMm = 0; notify(); } : undefined));
    }
    if (tooling.how === "line" || tooling.how === "fill" || tooling.how === "letters") {
      const sp = tooling.spacingMm || (t.tool === "letter" ? size * 0.8 : t.spacing || t.size);
      out.push(stepper("Spacing", mm(sp) + (tooling.spacingMm ? "" : " (usual)"), () => { tooling.spacingMm = Math.max(0.5, Math.round((sp - 0.5) * 10) / 10); notify(); }, () => { tooling.spacingMm = Math.round((sp + 0.5) * 10) / 10; notify(); }, tooling.spacingMm ? () => { tooling.spacingMm = 0; notify(); } : undefined));
    }
  }
  out.push(h("div", { class: "tl-row" }, h("button", { type: "button", class: "tl-btn", onclick: () => { stopTooling(); setStatus("Done. Click any tooling to change it."); } }, "I'm done (Esc)")));
  return out;
}

const KIND_NAMES: Record<StrokeKind, string> = { cut: "Cut line", line: "Row of stamps", fill: "Stamped area", stamp: "Stamp", letters: "Letters" };

/** Controls for the selected tooling stroke (used by the Tooling panel and the inspector). */
export function strokeControls(): Node[] {
  const cur = selectedStrokes();
  if (!cur) return [];
  const { s, group, pc } = cur;
  const out: Node[] = [h("h3", {}, "Selected")];
  const what = s.kind === "cut" ? "Swivel-knife cut" : s.kind === "letters" ? `Letters “${s.text ?? ""}”` : `${toolName(s.tool)}: ${KIND_NAMES[s.kind].toLowerCase()}`;
  out.push(h("p", { class: "tl-say" }, `${what} on ${pc.name}.${group.length > 1 ? ` Part of a design of ${group.length} lines; moving moves them all.` : ""} Drag it to move it.`));
  if (s.kind !== "cut" && s.kind !== "letters") {
    const row = h("div", { class: "tl-hows" }, h("span", { class: "tl-step-label" }, "Tool"));
    for (const t of TOOLS) {
      if (t.tool === "letter") continue;
      if (t.tool === "swivelKnife" && s.kind === "stamp") continue;
      row.append(h("button", { type: "button", class: `tl-how${t.tool === s.tool ? " tl-on" : ""}`, onclick: () => setOnSelected((x) => {
        if (t.tool === "swivelKnife") {
          x.kind = "cut";
          x.side = 0;
        }
        x.tool = t.tool;
        x.sizeMm = 0;
        x.spacingMm = 0;
      }) }, t.name));
    }
    out.push(row);
  }
  if (s.kind === "letters") {
    const inp = h("input", { type: "text", class: "tl-text", value: s.text ?? "", "data-key": "tl-sel-text", "aria-label": "Letters" });
    inp.addEventListener("change", () => setOnSelected((x) => (x.text = inp.value)));
    out.push(h("label", { class: "tl-field" }, h("span", {}, "Letters"), inp));
  }
  if (s.kind !== "cut") {
    const size = strokeSize(s);
    out.push(stepper(s.kind === "letters" ? "Letter height" : "Stamp size", mm(size), () => setOnSelected((x) => (x.sizeMm = Math.max(1, size - 1))), () => setOnSelected((x) => (x.sizeMm = size + 1))));
  }
  if (s.kind === "line" || s.kind === "fill" || s.kind === "letters") {
    const sp = strokeSpacing(s);
    out.push(stepper("Spacing", mm(sp), () => setOnSelected((x) => (x.spacingMm = Math.max(0.5, Math.round((sp - 0.5) * 10) / 10))), () => setOnSelected((x) => (x.spacingMm = Math.round((sp + 0.5) * 10) / 10))));
  }
  if (s.kind !== "cut") {
    out.push(stepper("Turn", `${Math.round(s.angleDeg ?? 0)}°`, () => setOnSelected((x) => (x.angleDeg = (x.angleDeg ?? 0) - 15)), () => setOnSelected((x) => (x.angleDeg = (x.angleDeg ?? 0) + 15))));
  }
  if (s.kind === "line") {
    const row = h("div", { class: "tl-hows" }, h("span", { class: "tl-step-label" }, "Where"));
    for (const [v, label] of [[0, "On the line"], [1, "One side"], [-1, "Other side"]] as [number, string][]) {
      row.append(h("button", { type: "button", class: `tl-how${Math.sign(s.side ?? 0) === v ? " tl-on" : ""}`, onclick: () => setOnSelected((x) => (x.side = v)) }, label));
    }
    out.push(row);
  }
  const btns = h("div", { class: "tl-row" });
  if (s.kind === "cut") btns.append(h("button", { type: "button", class: "tl-btn", onclick: bevelAlong }, "Bevel along this cut"));
  if (s.kind === "cut" || s.kind === "line") btns.append(h("button", { type: "button", class: "tl-btn", onclick: () => setOnSelected((x) => (x.smooth = !x.smooth)) }, s.smooth ? "Make it straight" : "Make it smooth"));
  if (group.length > 1 || s.points.length > 1) {
    btns.append(h("button", { type: "button", class: "tl-btn", onclick: () => scaleStrokes(1.1) }, "Bigger"), h("button", { type: "button", class: "tl-btn", onclick: () => scaleStrokes(1 / 1.1) }, "Smaller"));
  }
  btns.append(h("button", { type: "button", class: "tl-btn tl-danger", onclick: () => deleteStrokes(true) }, group.length > 1 ? "Delete this design" : "Delete"));
  if (group.length > 1) btns.append(h("button", { type: "button", class: "tl-btn tl-danger", onclick: () => deleteStrokes(false) }, "Delete just this line"));
  out.push(btns);
  return out;
}

/** Let a panel be dragged by its title bar. */
function dragBy(handle: HTMLElement, el: HTMLElement): void {
  handle.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (m: MouseEvent) => {
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, m.clientX - dx))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, m.clientY - dy))}px`;
      el.style.right = "auto";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

// ---------- pictures ----------

const PIC_W = 96;
const PIC_H = 64;

function picCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = h("canvas", { class: "tl-pic", width: PIC_W * 2, height: PIC_H * 2 });
  const g = c.getContext("2d")!;
  g.scale(2, 2);
  g.fillStyle = "#d9b98f";
  g.fillRect(0, 0, PIC_W, PIC_H);
  return [c, g];
}

const pictures = new Map<string, HTMLCanvasElement>();

function cached(key: string, draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  let c = pictures.get(key);
  if (!c) {
    const [cv, g] = picCanvas();
    draw(g);
    c = cv;
    pictures.set(key, c);
  }
  // Canvas pixels do not survive cloneNode, so each card gets its own copy.
  return copyCanvas(c);
}

function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = h("canvas", { class: "tl-pic", width: src.width, height: src.height });
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

/** Draw a stroke into a 2D context at `k` px per mm, as tooled leather. */
export function paintStroke(g: CanvasRenderingContext2D, s: ToolingStroke, k: number, map: (p: V) => V = (p) => p, sel = false): void {
  const ink = sel ? "#8a2620" : "#3a210f";
  if (s.kind === "cut") {
    const pts = flatten(s).map(map);
    if (pts.length < 2) return;
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x * k, p.y * k) : g.moveTo(p.x * k, p.y * k)));
    if (s.closed) g.closePath();
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = ink;
    g.lineWidth = Math.max(1, strokeSize(s) * k * (sel ? 1.8 : 1));
    g.stroke();
    return;
  }
  const size = strokeSize(s);
  const shape = face(s.tool, size);
  g.save();
  if (s.kind === "fill") {
    const region = flatten(s).map(map);
    g.beginPath();
    region.forEach((p, i) => (i ? g.lineTo(p.x * k, p.y * k) : g.moveTo(p.x * k, p.y * k)));
    g.closePath();
    g.clip();
  }
  const fill = s.tool === "backgrounder" ? "rgba(52,28,10,0.55)" : s.tool === "beveler" ? "rgba(70,40,16,0.45)" : "rgba(80,46,18,0.32)";
  for (const imp of impressions(s)) {
    const at = map(imp.at);
    g.save();
    g.translate(at.x * k, at.y * k);
    g.rotate((imp.angleDeg * Math.PI) / 180);
    if (imp.ch) {
      g.fillStyle = sel ? "#8a2620" : "rgba(50,28,10,0.85)";
      g.font = `700 ${Math.max(4, size * k)}px Cinzel, Georgia, serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(imp.ch, 0, size * k * 0.05);
    } else {
      shape.forEach(([pts, closed], i) => {
        g.beginPath();
        pts.forEach((p, j) => (j ? g.lineTo(p.x * k, p.y * k) : g.moveTo(p.x * k, p.y * k)));
        if (closed) g.closePath();
        if (closed && i === 0) {
          g.fillStyle = fill;
          g.fill();
        }
        g.strokeStyle = sel ? "rgba(138,38,32,0.9)" : "rgba(45,25,10,0.75)";
        g.lineWidth = Math.max(0.6, Math.min(1.4, 0.15 * k));
        g.stroke();
      });
    }
    g.restore();
  }
  g.restore();
}

function toolPicture(t: ToolKind): HTMLCanvasElement {
  return cached(`t:${t}`, (g) => {
    const def = toolDef(t);
    const k = t === "letter" ? 2.4 : t === "basketweave" ? 2.2 : 3.2;
    const cx = PIC_W / 2 / k, cy = PIC_H / 2 / k;
    if (t === "swivelKnife") {
      const cut: ToolingStroke = { id: "", kind: "cut", tool: t, points: [{ x: 4, y: 14 }, { x: 11, y: 6 }, { x: 18, y: 13 }, { x: 25, y: 6 }], smooth: true, sizeMm: 0.7 };
      paintStroke(g, cut, k);
      return;
    }
    if (t === "letter") {
      paintStroke(g, { id: "", kind: "letters", tool: t, points: [{ x: cx - 11, y: cy }], text: "ABC", sizeMm: 10, spacingMm: 11 }, k);
      return;
    }
    if (t === "basketweave") {
      paintStroke(g, { id: "", kind: "fill", tool: t, points: [{ x: 1, y: 1 }, { x: 43, y: 1 }, { x: 43, y: 28 }, { x: 1, y: 28 }], spacingMm: 10 }, k);
      return;
    }
    if (t === "backgrounder") {
      paintStroke(g, { id: "", kind: "fill", tool: t, points: [{ x: 2, y: 2 }, { x: 28, y: 2 }, { x: 28, y: 18 }, { x: 2, y: 18 }] }, k);
      return;
    }
    if (def.hows[0] === "line") {
      const w = PIC_W / k;
      // A beveler walks just beside a cut.
      const y = t === "beveler" ? cy - 1.5 : cy;
      if (t === "beveler") paintStroke(g, { id: "", kind: "cut", tool: "swivelKnife", points: [{ x: 3, y }, { x: w - 3, y }] }, k);
      paintStroke(g, { id: "", kind: "line", tool: t, points: [{ x: 4, y }, { x: w - 4, y }], side: t === "beveler" ? 1 : 0 }, k);
      return;
    }
    // One big impression, plus a smaller row.
    paintStroke(g, { id: "", kind: "stamp", tool: t, points: [{ x: cx, y: cy }], sizeMm: def.size * 1.4 }, k);
  });
}

function designPicture(d: Design): HTMLCanvasElement {
  return cached(`d:${d}`, (g) => {
    const k = 1;
    const W = PIC_W, H = PIC_H;
    const cut = (pts: V[], closed = false, smooth = true): ToolingStroke => ({ id: "", kind: "cut", tool: "swivelKnife", points: pts, closed, smooth, sizeMm: 1 });
    switch (d) {
      case "border": {
        const r = [{ x: 8, y: 8 }, { x: W - 8, y: 8 }, { x: W - 8, y: H - 8 }, { x: 8, y: H - 8 }];
        paintStroke(g, cut(r, true, false), k);
        paintStroke(g, { id: "", kind: "line", tool: "border", points: [{ x: 15, y: 15 }, { x: W - 15, y: 15 }, { x: W - 15, y: H - 15 }, { x: 15, y: H - 15 }], closed: true, sizeMm: 7, spacingMm: 8 }, k);
        break;
      }
      case "basketweave":
        paintStroke(g, cut([{ x: 5, y: 5 }, { x: W - 5, y: 5 }, { x: W - 5, y: H - 5 }, { x: 5, y: H - 5 }], true, false), k);
        paintStroke(g, { id: "", kind: "fill", tool: "basketweave", points: [{ x: 7, y: 7 }, { x: W - 7, y: 7 }, { x: W - 7, y: H - 7 }, { x: 7, y: H - 7 }], sizeMm: 14, spacingMm: 12 }, k);
        break;
      case "floral": {
        const c = { x: W / 2, y: H / 2 - 4 };
        for (let i = 0; i < 5; i++) {
          const a = ((i * 72 - 90) * Math.PI) / 180;
          const p = (da: number, r: number) => ({ x: c.x + Math.cos(a + da) * r, y: c.y + Math.sin(a + da) * r });
          paintStroke(g, cut([p(-0.42, 4), p(-0.3, 10), p(0, 17), p(0.3, 10), p(0.42, 4)], true), k);
        }
        paintStroke(g, cut([{ x: c.x - 18, y: c.y + 18 }, { x: c.x - 28, y: c.y + 12 }, { x: c.x - 38, y: c.y + 20 }, { x: c.x - 28, y: c.y + 23 }], true), k);
        paintStroke(g, cut([{ x: c.x + 18, y: c.y + 18 }, { x: c.x + 28, y: c.y + 12 }, { x: c.x + 38, y: c.y + 20 }, { x: c.x + 28, y: c.y + 23 }], true), k);
        paintStroke(g, { id: "", kind: "stamp", tool: "seeder", points: [c], sizeMm: 5 }, k);
        break;
      }
      case "corner":
        paintStroke(g, cut([{ x: 10, y: 10 }, { x: 34, y: 8 }, { x: 52, y: 14 }, { x: 54, y: 26 }, { x: 44, y: 28 }, { x: 44, y: 21 }]), k);
        paintStroke(g, cut([{ x: 10, y: 10 }, { x: 8, y: 30 }, { x: 14, y: 46 }, { x: 26, y: 48 }, { x: 28, y: 38 }, { x: 21, y: 38 }]), k);
        paintStroke(g, cut([{ x: 16, y: 16 }, { x: 26, y: 20 }, { x: 34, y: 34 }, { x: 20, y: 26 }], true), k);
        g.strokeStyle = "rgba(60,35,15,0.6)";
        g.lineWidth = 1;
        g.strokeRect(3, 3, W + 10, H + 10);
        break;
      case "checkerboard": {
        const s = 12, x0 = W / 2 - 2 * s, y0 = H / 2 - 2 * s;
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 4; i++)
            if ((i + j) % 2 === 0) paintStroke(g, { id: "", kind: "fill", tool: "backgrounder", points: [{ x: x0 + i * s, y: y0 + j * s }, { x: x0 + (i + 1) * s, y: y0 + j * s }, { x: x0 + (i + 1) * s, y: y0 + (j + 1) * s }, { x: x0 + i * s, y: y0 + (j + 1) * s }], sizeMm: 3, spacingMm: 2.6 }, k);
        for (let i = 0; i <= 4; i++) {
          paintStroke(g, cut([{ x: x0 + i * s, y: y0 }, { x: x0 + i * s, y: y0 + 4 * s }], false, false), k);
          paintStroke(g, cut([{ x: x0, y: y0 + i * s }, { x: x0 + 4 * s, y: y0 + i * s }], false, false), k);
        }
        break;
      }
      case "diamond": {
        const s = 52, x0 = W / 2 - s / 2, y0 = H / 2 - s / 2;
        paintStroke(g, cut([{ x: x0, y: y0 }, { x: x0 + s, y: y0 }, { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s }], true, false), k);
        g.save();
        g.beginPath();
        g.rect(x0, y0, s, s);
        g.clip();
        for (let o = -s; o <= 2 * s; o += 13) {
          paintStroke(g, cut([{ x: x0 + o, y: y0 }, { x: x0 + o + s, y: y0 + s }], false, false), k);
          paintStroke(g, cut([{ x: x0 + o, y: y0 }, { x: x0 + o - s, y: y0 + s }], false, false), k);
        }
        g.restore();
        break;
      }
      case "monogram": {
        const pts: V[] = [];
        for (let i = 0; i < 12; i++) pts.push({ x: W / 2 + Math.cos((i * Math.PI) / 6) * 36, y: H / 2 + Math.sin((i * Math.PI) / 6) * 24 });
        paintStroke(g, cut(pts, true), k);
        paintStroke(g, { id: "", kind: "letters", tool: "letter", points: [{ x: W / 2 - 10, y: H / 2 }], text: "AB", sizeMm: 24, spacingMm: 20 }, k);
        break;
      }
    }
  });
}

// ---------- keys ----------

function typing(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "SELECT" || a.tagName === "TEXTAREA" || (a as HTMLElement).isContentEditable);
}

function onKey(e: KeyboardEvent): void {
  if (e.isComposing || typing()) return;
  const stop = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  if (e.key === "Escape" && state.tool === "tooling") {
    stop();
    stopTooling();
    setStatus("Done. Click any tooling to change it, or pick another tool.");
    return;
  }
  if (e.key === "Enter" && state.tool === "tooling") {
    if (hooks.finish()) stop();
    return;
  }
  if (state.sel.kind !== "tooling" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    stop();
    deleteStrokes(true);
    return;
  }
  const arrows: Record<string, V> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
  const d = arrows[e.key];
  if (d) {
    stop();
    nudgeStrokes(mul(d, e.shiftKey ? 10 : 1));
  }
}

if (typeof window !== "undefined") window.addEventListener("keydown", onKey, { capture: true });
