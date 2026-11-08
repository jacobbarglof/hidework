// The small box that appears beside a selected edge in the 2D pattern window: type the edge's
// exact length or angle and press Enter. Level and upright edges stretch the piece so a
// rectangle stays a rectangle; a slanted edge moves its far end.

import { edgeAngle, edgeLength, edgeMiddle, setEdgeAngle, setEdgeLength } from "./shapeops";
import { prefs, simple } from "./prefs";
import { computedPiece, edit, isMulti, notify, piece, setStatus, state } from "./store";
import { toStaged } from "./tooling";
import { parseLength, unitWord } from "./units";
import type { V } from "./types";

interface Host {
  el: HTMLCanvasElement;
  toScreen(p: V): V;
}

let host: Host;
let box: HTMLElement;
let lenIn: HTMLInputElement;
let angIn: HTMLInputElement;
let unitEl: HTMLElement;
let curveEl: HTMLElement;

export function initEdgeBox(h: Host): void {
  host = h;
  box = document.createElement("div");
  box.className = "edge-box hidden";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "This edge: length and angle");
  const row = (text: string, input: HTMLInputElement, unit: HTMLElement) => {
    const l = document.createElement("label");
    const t = document.createElement("span");
    t.className = "eb-name";
    t.textContent = text;
    l.append(t, input, unit);
    return l;
  };
  const mk = (aria: string) => {
    const i = document.createElement("input");
    i.type = "text";
    i.inputMode = "decimal";
    i.autocomplete = "off";
    i.spellcheck = false;
    i.className = "eb-input";
    i.setAttribute("aria-label", aria);
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply(i);
        i.select();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        i.blur();
        place();
      }
    });
    i.addEventListener("change", () => apply(i));
    i.addEventListener("focus", () => i.select());
    return i;
  };
  lenIn = mk("Edge length");
  angIn = mk("Edge angle in degrees");
  unitEl = document.createElement("span");
  unitEl.className = "eb-unit";
  const deg = document.createElement("span");
  deg.className = "eb-unit";
  deg.textContent = "°";
  curveEl = document.createElement("div");
  curveEl.className = "eb-note";
  const head = document.createElement("div");
  head.className = "eb-head";
  head.textContent = "This edge";
  box.append(head, row("Length", lenIn, unitEl), row("Angle", angIn, deg), curveEl);
  box.addEventListener("mousedown", (e) => e.stopPropagation());
  h.el.parentElement!.append(box);
}

function current(): { id: string; index: number } | null {
  const s = state.sel;
  if (state.tool !== "select" || s.kind !== "edge" || isMulti()) return null;
  const pc = piece(s.piece);
  if (!pc || !pc.edges[s.index]) return null;
  return { id: s.piece, index: s.index };
}

const dispLen = (mm: number) => (state.project.units === "in" ? (mm / 25.4).toFixed(3) : (Math.round(mm * 10) / 10).toString());

/** Keep the box beside the selected edge (called every time the canvas is drawn). */
export function place(): void {
  if (!box) return;
  const cur = current();
  if (!cur) {
    box.classList.add("hidden");
    return;
  }
  const pc = piece(cur.id)!;
  const cp = computedPiece(cur.id);
  const focused = document.activeElement === lenIn || document.activeElement === angIn;
  if (!focused) {
    lenIn.value = dispLen(edgeLength(pc, cur.index));
    angIn.value = String(Math.round(edgeAngle(pc, cur.index) * 10) / 10);
  }
  unitEl.textContent = unitWord(state.project.units);
  const curved = pc.edges[cur.index].type === "cubic";
  curveEl.textContent = curved ? "Curved: the length is measured along the curve." : "Enter sets it.";
  // Beside the middle of the edge, on the outside of the piece.
  const n = pc.vertices.length;
  const a = pc.vertices[cur.index];
  const b = pc.vertices[(cur.index + 1) % n];
  const mid = edgeMiddle(pc, cur.index);
  const centre = pc.vertices.reduce((s, v) => ({ x: s.x + v.x / n, y: s.y + v.y / n }), { x: 0, y: 0 });
  let nx = -(b.y - a.y);
  let ny = b.x - a.x;
  const nl = Math.hypot(nx, ny) || 1;
  nx /= nl;
  ny /= nl;
  if ((mid.x - centre.x) * nx + (mid.y - centre.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const at = host.toScreen({ x: toStaged(cp, mid).x + pc.position.x, y: toStaged(cp, mid).y + pc.position.y });
  box.classList.toggle("big", simple());
  box.classList.remove("hidden");
  const z = prefs.scale;
  box.style.setProperty("zoom", String(z));
  const r = host.el.getBoundingClientRect();
  const bw = box.offsetWidth * z;
  const bh = box.offsetHeight * z;
  const gap = 34;
  let x = at.x + nx * gap - bw / 2 + nx * (bw / 2);
  let y = at.y + ny * gap - bh / 2 + ny * (bh / 2);
  x = Math.max(6, Math.min(r.width - bw - 6, x));
  y = Math.max(6, Math.min(r.height - bh - 6, y));
  box.style.left = `${x / z}px`;
  box.style.top = `${y / z}px`;
}

/** An angle in degrees ("30", "30°"). */
function parseAngle(s: string): number | null {
  const m = /^\s*(-?\d*\.?\d+)\s*°?\s*$/.exec(s);
  return m ? parseFloat(m[1]) : null;
}

function apply(input: HTMLInputElement): void {
  const cur = current();
  if (!cur) return;
  const pc = piece(cur.id)!;
  if (input === lenIn) {
    // A unit typed with the number wins (3in, 80mm, 8cm); otherwise the project's units. Inches
    // can be typed as fractions too: 3/8, 3 1/2, 3-1/2.
    const mm = parseLength(input.value, state.project.units);
    if (mm === null) {
      setStatus(`"${input.value}" is not a length. Type a number${state.project.units === "in" ? " such as 4.5 or 4 1/2" : ""}, then Enter.`);
      return;
    }
    if (Math.abs(mm - edgeLength(pc, cur.index)) < 0.005) return;
    if (mm <= 0.1) return setStatus("An edge needs some length. Type a number bigger than 0.");
    let ok = false;
    edit(() => (ok = setEdgeLength(pc, cur.index, mm)));
    setStatus(ok ? `The edge is now ${dispLen(mm)} ${unitWord(state.project.units)} long. Ctrl+Z takes it back.` : "That edge could not be changed.");
  } else {
    const v = parseAngle(input.value);
    if (v === null) {
      setStatus(`"${input.value}" is not an angle. Type a number of degrees, then Enter.`);
      return;
    }
    if (Math.abs(v - edgeAngle(pc, cur.index)) < 0.005) return;
    edit(() => setEdgeAngle(pc, cur.index, v));
    setStatus(`The edge now points at ${v}° (0 is level to the right, 90 is straight up). Ctrl+Z takes it back.`);
  }
  notify();
}

/** Put the cursor in the length box (Shift+L). False when no edge is selected. */
export function focusEdgeLength(): boolean {
  if (!current()) return false;
  place();
  lenIn.focus();
  return true;
}
