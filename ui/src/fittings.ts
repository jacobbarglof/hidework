// What sits on and along the leather in the 3D window: set hardware (rivets, snaps, locks, rings,
// buckles, zips...), seam inserts (welt, piping, binding, zipper teeth), stitch and lacing styles,
// and surface work (stamps, tooling, embossing, paint) drawn onto the grain.

import * as THREE from "three";
import { piece } from "./store";
import { face, faceDepth, flatten, impressions, strokeDepth, strokeSize, toStaged } from "./tooling";
import type { ComputedPiece, Mark, ToolingStroke, V } from "./types";
import { metalFinish, tape, type Metal } from "./hardware/metals";
import { hardwareParts, type PartFinish, type Role } from "./hardware/models";

export type { Metal } from "./hardware/metals";
export { METALS } from "./hardware/metals";

/** The polished material for a metal (shared). */
export function metal(m: Metal): THREE.MeshPhysicalMaterial {
  return metalFinish(m, "polished");
}

/** The material for a part's finish in the chosen metal (copper rivets are always copper). */
export function partMaterial(finish: PartFinish, m: Metal): THREE.Material {
  if (finish === "tape") return tape();
  if (finish === "copper") return metalFinish("copper", "polished");
  if (finish === "copperDark") return metalFinish("copper", "dark");
  return metalFinish(m, finish);
}

/**
 * A piece of hardware in its own frame: origin on the grain surface, +z out of the leather, +x
 * along the hardware's angle. `t` is the leather thickness (backs go at z = -t). `role` picks the
 * half of a two-layer fastener (see hardware/models.ts). Geometry is shared: do not dispose it.
 */
export function hardwareMesh(kind: string, size: number, t: number, m: Metal, role: Role = "single"): THREE.Group {
  const g = new THREE.Group();
  for (const part of hardwareParts(kind, size, t, role)) {
    const mesh = new THREE.Mesh(part.geo, partMaterial(part.finish, m));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

// ---------- stitches and seam inserts ----------
// Built in hardware/stitches.ts (instanced twisted thread, slanted saddle stitches, flat lace and
// the slits they pass through) and hardware/decor.ts (welts, piping, bindings and zippers).

export { stitchMeshes, updateStitches, type StitchMeshes, type Surface } from "./hardware/stitches";
export { updateDecor } from "./hardware/decor";

// ---------- surface work ----------

const TOOL = "rgba(45,25,12,0.62)";

function drawMark(g: CanvasRenderingContext2D, mk: Mark, k: number, bump: boolean): void {
  g.save();
  g.translate(mk.center.x * k, mk.center.y * k);
  g.rotate(((mk.angleDeg ?? 0) * Math.PI) / 180);
  const w = mk.size.x * k;
  const h = mk.size.y * k;
  const ink = bump ? "#000" : TOOL;
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineCap = "round";
  const text = (str: string, weight: string, color: string) => {
    g.fillStyle = color;
    g.font = `${weight} ${Math.max(6, h * 0.62)}px Cinzel, 'Times New Roman', serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(str, 0, h * 0.04, w * 0.96);
  };
  switch (mk.kind) {
    case "paint":
      g.fillStyle = bump ? "rgba(0,0,0,0)" : mk.pattern || "#1d1d1f";
      g.fillRect(-w / 2, -h / 2, w, h);
      break;
    case "stamp": {
      g.lineWidth = Math.max(2, k * 0.6);
      const r = Math.min(w, h) * 0.2;
      g.beginPath();
      g.roundRect(-w / 2, -h / 2, w, h, r);
      g.stroke();
      g.beginPath();
      g.roundRect(-w / 2 + k * 1.5, -h / 2 + k * 1.5, w - k * 3, h - k * 3, r * 0.7);
      g.stroke();
      text(mk.text || "HW", "700", ink);
      break;
    }
    case "text":
      text(mk.text || "", "600", ink);
      break;
    case "engrave":
      g.lineWidth = Math.max(1, k * 0.25);
      g.strokeRect(-w / 2, -h / 2, w, h);
      if (mk.text) {
        g.font = `400 ${Math.max(6, h * 0.5)}px 'EB Garamond', serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.lineWidth = Math.max(0.8, k * 0.18);
        g.strokeText(mk.text, 0, 0, w * 0.95);
      }
      break;
    case "emboss":
      if (!bump) {
        g.fillStyle = "rgba(255,240,215,0.35)";
        g.font = `700 ${Math.max(6, h * 0.62)}px Cinzel, serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(mk.text || "◆", -k * 0.4, -k * 0.4, w * 0.95);
        text(mk.text || "◆", "700", "rgba(30,16,6,0.45)");
      } else {
        text(mk.text || "◆", "700", "#fff");
      }
      break;
    case "tooling": {
      g.lineWidth = Math.max(1.5, k * 0.45);
      g.beginPath();
      g.rect(-w / 2, -h / 2, w, h);
      g.stroke();
      const p = mk.pattern || "floral";
      if (p === "basketweave") {
        const s = 6 * k;
        for (let y = -h / 2; y < h / 2; y += s) {
          for (let x = -w / 2; x < w / 2; x += s) {
            const flip = (Math.round((x + w) / s) + Math.round((y + h) / s)) % 2;
            for (let l = 1; l < 4; l++) {
              g.beginPath();
              if (flip) {
                g.moveTo(x + (l * s) / 4, y + 1);
                g.lineTo(x + (l * s) / 4, y + s - 1);
              } else {
                g.moveTo(x + 1, y + (l * s) / 4);
                g.lineTo(x + s - 1, y + (l * s) / 4);
              }
              g.stroke();
            }
          }
        }
      } else if (p === "geometric") {
        const s = 8 * k;
        for (let y = -h / 2; y < h / 2 + s; y += s) {
          for (let x = -w / 2; x < w / 2 + s; x += s) {
            g.beginPath();
            g.moveTo(x, y - s / 2);
            g.lineTo(x + s / 2, y);
            g.lineTo(x, y + s / 2);
            g.lineTo(x - s / 2, y);
            g.closePath();
            g.stroke();
          }
        }
      } else if (p === "border") {
        g.strokeRect(-w / 2 + 3 * k, -h / 2 + 3 * k, w - 6 * k, h - 6 * k);
      } else if (p === "pebble") {
        for (let i = 0; i < (w * h) / (k * k * 3); i++) {
          g.beginPath();
          g.arc((Math.sin(i * 12.9898) * 0.5) * w, (Math.sin(i * 78.233) * 0.5) * h, k * 0.5, 0, Math.PI * 2);
          g.fill();
        }
      } else {
        // Floral: scrolls with leaves, like a Sheridan panel.
        const n = Math.max(1, Math.round(w / (h * 1.2)));
        for (let i = 0; i < n; i++) {
          const cx = -w / 2 + ((i + 0.5) * w) / n;
          const r = Math.min(h, w / n) * 0.36;
          g.beginPath();
          for (let a = 0; a < Math.PI * 3.2; a += 0.05) {
            const rr = r * (1 - a / (Math.PI * 3.6));
            const x = cx + Math.cos(a + i) * rr;
            const y = Math.sin(a + i) * rr;
            if (a === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
          for (const s of [-1, 1]) {
            g.beginPath();
            g.ellipse(cx + s * r * 0.95, s * r * 0.55, r * 0.42, r * 0.16, s * 0.7, 0, Math.PI * 2);
            g.stroke();
          }
        }
      }
      break;
    }
    default:
      break;
  }
  g.restore();
}

// ---------- tooling ----------

/** A bump-map grey for a depth: 0 is the grain surface (white), 1 the bottom of a deep cut (black). */
function grey(level: number): string {
  const v = Math.round(255 * (1 - Math.max(0, Math.min(1, level))));
  return `rgb(${v},${v},${v})`;
}

function polyPath(g: CanvasRenderingContext2D, pts: V[], k: number, closed: boolean): void {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x * k, p.y * k) : g.moveTo(p.x * k, p.y * k)));
  if (closed) g.closePath();
}

/**
 * Tooling pressed into the grain: in the colour map the tooled leather darkens (as damp veg-tan
 * does where it is compressed); in the bump map white is the grain surface and darker is deeper.
 * Cuts are narrow V grooves, bevels slope down to the cut beside them, backgrounding is a dark,
 * matte, pebbled area, and each stamp leaves its face's shape.
 */
function drawTooling(g: CanvasRenderingContext2D, list: ToolingStroke[], cp: ComputedPiece, k: number, bump: boolean): void {
  const map = (p: V): V => toStaged(cp, p);
  const rank = (s: ToolingStroke) => (s.kind === "fill" ? 0 : s.kind === "cut" ? 2 : 1);
  for (const s of [...list].sort((a, b) => rank(a) - rank(b))) {
    const deep = Math.max(0.4, Math.min(2, strokeDepth(s) / 0.5));
    g.save();
    g.lineCap = "round";
    g.lineJoin = "round";
    if (s.kind === "cut") {
      const pts = flatten(s).map(map);
      const w = Math.max(0.3, strokeSize(s)) * k;
      // A V groove: a wide shallow shoulder down to a narrow deep bottom.
      const layers: [number, string][] = bump
        ? [[w * 4, grey(0.18 * deep)], [w * 2.4, grey(0.45 * deep)], [w * 1.2, grey(0.8 * deep)], [w * 0.5, grey(1)]]
        : [[w * 3.2, "rgba(60,30,12,0.16)"], [w * 1.4, "rgba(34,16,6,0.62)"], [w * 0.6, "rgba(20,9,3,0.85)"]];
      for (const [lw, c] of layers) {
        polyPath(g, pts, k, !!s.closed);
        g.strokeStyle = c;
        g.lineWidth = Math.max(1, lw);
        g.stroke();
      }
      g.restore();
      continue;
    }
    if (s.kind === "fill") {
      polyPath(g, flatten(s).map(map), k, true);
      g.clip();
    }
    const size = strokeSize(s);
    const shape = face(s.tool, size);
    const across = faceDepth(s.tool, size);
    const side = Math.sign(s.side ?? 0);
    let n = 0;
    for (const imp of impressions(s)) {
      const at = map(imp.at);
      g.save();
      g.translate(at.x * k, at.y * k);
      g.rotate((imp.angleDeg * Math.PI) / 180);
      n++;
      if (imp.ch) {
        g.font = `700 ${Math.max(4, size * k)}px Cinzel, 'Times New Roman', serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillStyle = bump ? grey(0.75 * deep) : "rgba(30,15,5,0.7)";
        g.fillText(imp.ch, 0, size * k * 0.05);
        g.restore();
        continue;
      }
      const [outline] = shape;
      if (!outline) {
        g.restore();
        continue;
      }
      polyPath(g, outline[0], k, outline[1]);
      switch (s.tool) {
        case "beveler": {
          // Deepest against the cut, rising to the surface away from it.
          const y0 = (-across / 2) * k, y1 = (across / 2) * k;
          const grad = side < 0 ? g.createLinearGradient(0, y1, 0, y0) : g.createLinearGradient(0, y0, 0, y1);
          if (side === 0) {
            grad.addColorStop(0, bump ? grey(0.1) : "rgba(40,20,8,0.1)");
            grad.addColorStop(0.5, bump ? grey(0.7 * deep) : "rgba(30,15,5,0.55)");
            grad.addColorStop(1, bump ? grey(0.1) : "rgba(40,20,8,0.1)");
          } else {
            grad.addColorStop(0, bump ? grey(0.8 * deep) : "rgba(28,14,5,0.62)");
            grad.addColorStop(1, bump ? grey(0.05) : "rgba(60,30,12,0.08)");
          }
          g.fillStyle = grad;
          g.fill();
          break;
        }
        case "backgrounder": {
          g.fillStyle = bump ? grey(0.55 * deep) : "rgba(32,16,6,0.62)";
          g.fill();
          // The pebbled, matte face of a backgrounder.
          g.fillStyle = bump ? grey(0.85 * deep) : "rgba(18,8,2,0.5)";
          for (let i = 0; i < 4; i++) {
            const a = Math.sin((n * 7 + i) * 12.9898) * 0.35 * size;
            const b = Math.sin((n * 3 + i) * 78.233) * 0.35 * size;
            g.beginPath();
            g.arc(a * k, b * k, Math.max(0.6, 0.12 * size * k), 0, Math.PI * 2);
            g.fill();
          }
          break;
        }
        case "pearShader": {
          const grad = g.createRadialGradient(size * 0.15 * k, 0, 0, 0, 0, (size / 2) * k);
          grad.addColorStop(0, bump ? grey(0.6 * deep) : "rgba(30,15,5,0.45)");
          grad.addColorStop(1, bump ? grey(0) : "rgba(60,30,12,0)");
          g.fillStyle = grad;
          g.fill();
          break;
        }
        case "seeder": {
          g.fillStyle = bump ? grey(0.85 * deep) : "rgba(25,12,4,0.7)";
          g.fill();
          // The seed itself stands up in the middle of the ring.
          const inner = shape[1];
          if (inner) {
            polyPath(g, inner[0], k, true);
            g.fillStyle = bump ? grey(0.25 * deep) : "rgba(70,36,14,0.35)";
            g.fill();
          }
          break;
        }
        default: {
          g.fillStyle = bump ? grey(0.45 * deep) : "rgba(40,20,8,0.4)";
          if (outline[1]) g.fill();
          g.strokeStyle = bump ? grey(0.8 * deep) : "rgba(25,12,4,0.7)";
          g.lineWidth = Math.max(1, 0.35 * k);
          g.stroke();
          for (const [pts, closed] of shape.slice(1)) {
            polyPath(g, pts, k, closed);
            g.stroke();
          }
        }
      }
      g.restore();
    }
    g.restore();
  }
}

/**
 * Decorative crease lines along the edges: a narrow pressed groove, darkened where the hot
 * creaser glazed the grain, with a faint highlight on its outer shoulder.
 */
function drawCreases(g: CanvasRenderingContext2D, lines: V[][], k: number, bump: boolean): void {
  if (!lines.length) return;
  g.save();
  g.lineCap = "round";
  g.lineJoin = "round";
  const layers: [number, string][] = bump
    ? [[0.9, grey(0.25)], [0.45, grey(0.7)]]
    : [[0.9, "rgba(255,235,205,0.10)"], [0.5, "rgba(35,17,6,0.55)"]];
  for (const [w, c] of layers) {
    g.strokeStyle = c;
    g.lineWidth = Math.max(1, w * k);
    for (const pts of lines) {
      polyPath(g, pts, k, false);
      g.stroke();
    }
  }
  g.restore();
}

/** A transparent picture of a piece's surface work and tooling, laid over its grain side. */
export function markTextures(cp: ComputedPiece): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture; min: { x: number; y: number }; size: { x: number; y: number } } | null {
  const marks = (cp.marks ?? []).filter((m) => m.kind !== "perforate");
  const tooling = piece(cp.id)?.tooling ?? [];
  const creases = (cp.creases ?? []).filter((c) => c.length > 1);
  if (!marks.length && !tooling.length && !creases.length) return null;
  const b = cp.bounds;
  const size = { x: b.max.x - b.min.x, y: b.max.y - b.min.y };
  const k = Math.min(8, 2048 / Math.max(size.x, size.y));
  const make = (bump: boolean) => {
    const c = document.createElement("canvas");
    c.width = Math.ceil(size.x * k);
    c.height = Math.ceil(size.y * k);
    const g = c.getContext("2d")!;
    if (bump) {
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
    }
    g.translate(-b.min.x * k, -b.min.y * k);
    drawCreases(g, creases, k, bump);
    for (const mk of marks) drawMark(g, mk, k, bump);
    if (tooling.length) drawTooling(g, tooling, cp, k, bump);
    const t = new THREE.CanvasTexture(c);
    if (!bump) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: make(false), bump: make(true), min: b.min, size };
}
