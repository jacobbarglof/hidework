// A round piece with a side wall: a circle, oval or D-shaped end panel (or a round piece already
// drawn) and a gusset strip that wraps round it, as in a drum bag, a round coin pouch, a pen cup
// or a D-shaped belt pouch. The strip's stitched long edges come out exactly as long as the end's
// stitch line (plus the stitch margin at each end, as the Make gusset button does), and it is
// joined to one end (a cup or bucket) or to both (a closed cylinder). Wrapped all the way round,
// the strip's two short ends are sewn to each other and the pieces are placed on a round 3D form,
// so the 3D window makes a cylinder of them.

import { api } from "./api";
import { viewCenter } from "./canvas";
import { duplicatePiece, rectPiece } from "./ops";
import { ovalPiece, pieceFromOutline } from "./shapeops";
import { edit, notify, piece, selectedPieceId, setStatus, state, uid } from "./store";
import { fmtLen } from "./units";
import type { Edge, Piece, Project, V } from "./types";

export type RoundShape = "circle" | "oval" | "d" | "selected";

export interface RoundGusset {
  shape: RoundShape;
  /** Across (and down, for an oval or a D), mm. Ignored for a selected piece. */
  acrossMm: number;
  downMm: number;
  /** How tall the side wall is (the gusset's width), mm. */
  wallMm: number;
  /** "all": the wall goes all the way round; "part": only round the curved edges (a D-shaped pouch). */
  wrap: "all" | "part";
  /** One end (a cup or bucket) or two (a closed cylinder or pouch). */
  ends: 1 | 2;
}

const K = 0.5522847498;

/** A D shape: straight across the top, a half oval below it. */
export function dPiece(at: V, w: number, h: number, name = "End"): Piece {
  const cubic = (c1: V, c2: V): Edge => ({ type: "cubic", c1, c2, stitched: false });
  const P = (x: number, y: number): V => ({ x: at.x + x, y: at.y + y });
  const pts = [P(0, 0), P(w, 0), P(w / 2, h)];
  const edges: Edge[] = [{ type: "line", stitched: false }, cubic(P(w, K * h), P(w / 2 + (K * w) / 2, h)), cubic(P(w / 2 - (K * w) / 2, h), P(0, K * h))];
  return pieceFromOutline(pts, edges, name);
}

/** Make the end panel(s) and the side wall, joined, as one undo step. Returns the gusset's id. */
export async function makeRoundGusset(o: RoundGusset): Promise<string> {
  if (!(o.wallMm > 0)) throw new Error("Type how tall the side wall is.");
  const draft: Project = JSON.parse(JSON.stringify(state.project));
  let end: Piece;
  if (o.shape === "selected") {
    const id = selectedPieceId();
    const found = id ? draft.pieces.find((x) => x.id === id) : undefined;
    if (!found) throw new Error("Click the round piece the wall goes round first, or choose Circle, Oval or D shape.");
    end = found;
  } else {
    if (!(o.acrossMm > 0) || (o.shape !== "circle" && !(o.downMm > 0))) throw new Error("Type the size of the round end.");
    const w = o.acrossMm;
    const h = o.shape === "circle" ? w : o.downMm;
    const c = viewCenter();
    const at = { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2) };
    const name = o.ends === 2 ? "End" : "Base";
    end = o.shape === "d" ? dPiece(at, w, h, name) : ovalPiece(at, w, h, name);
    end.materialId = draft.materials[0]?.id ?? end.materialId;
    draft.pieces.push(end);
  }
  // The edges the wall sews to: every edge, or only the curved ones.
  const edges = end.edges.map((_, i) => i).filter((i) => o.wrap === "all" || end.edges[i].type === "cubic");
  if (!edges.length) throw new Error(`${end.name} has no curved edges for the wall to go round. Choose All the way round.`);
  for (const i of edges) end.edges[i].stitched = true;
  // Measure the end's stitch line with the real core, before anything changes.
  const computed = await api.compute(draft);
  const cp = computed.pieces.find((x) => x.id === end.id);
  if (!cp) throw new Error("The round end could not be measured.");
  const stitchLen = edges.reduce((s, i) => s + (cp.edges[i]?.stitchLengthMm ?? 0), 0);
  if (!(stitchLen > 0)) throw new Error("The round end has no stitch line to measure. Is it too small for its stitching?");
  const margin = end.stitch.marginMm;
  const total = stitchLen + 2 * margin;
  const gid = uid("p");
  const at = { x: end.position.x, y: cp.bounds.max.y + end.position.y + 25 };
  let g: Piece;
  try {
    g = await api.gusset(`${end.name} side wall`, total, o.wallMm, end.materialId, at, gid);
  } catch {
    // No core to ask (the browser preview without the bridge): the same strip, made here.
    g = rectPiece(at, total, o.wallMm, `${end.name} side wall`);
    g.id = gid;
    g.edges = [true, false, true, false].map((s) => ({ type: "line", stitched: s }) as Edge);
    g.materialId = end.materialId;
    g.notes = "Gusset: sews to the panel edge it was made from.";
  }
  g.stitch = { ...end.stitch };
  g.notes = o.wrap === "all" ? "Side wall: sew the two short ends together first, then sew in the round end(s)." : "Side wall: sews round the curved edge of the end(s).";
  const all = o.wrap === "all";
  if (all) {
    g.edges[1].stitched = true;
    g.edges[3].stitched = true;
  }
  draft.pieces.push(g);
  // Edge 2 (the bottom of the strip) to the base; edge 0 (the top) to the second end.
  draft.joins.push({ id: uid("j"), a: { pieceId: gid, edges: [2] }, b: { pieceId: end.id, edges } });
  let top: Piece | null = null;
  if (o.ends === 2) {
    top = duplicatePiece(end);
    top.name = o.shape === "selected" ? `${end.name} (other end)` : "Other end";
    const b = cp.bounds;
    top.position = { x: end.position.x + (b.max.x - b.min.x) + 25, y: end.position.y };
    draft.pieces.push(top);
    draft.joins.push({ id: uid("j"), a: { pieceId: gid, edges: [0] }, b: { pieceId: top.id, edges } });
  }
  if (all) draft.joins.push({ id: uid("j"), a: { pieceId: gid, edges: [1] }, b: { pieceId: gid, edges: [3] } });
  // In 3D: a round form the size of the end, the base at the bottom, the wall round it, the other end on top.
  let in3d = false;
  if (all && !draft.form) {
    const w = cp.bounds.max.x - cp.bounds.min.x;
    const d = cp.bounds.max.y - cp.bounds.min.y;
    draft.form = { widthMm: Math.max(1, w - 2 * margin), depthMm: Math.max(1, d - 2 * margin), heightMm: Math.max(1, o.wallMm - margin), round: true, cornerMm: 0 };
    end.place = { face: "bottom" };
    g.place = { face: "wrapAround" };
    if (top) top.place = { face: "top" };
    in3d = true;
  }
  edit((p) => {
    p.pieces = draft.pieces;
    p.joins = draft.joins;
    p.form = draft.form;
  });
  state.sel = { kind: "piece", piece: gid };
  const u = state.project.units;
  setStatus(
    `Made ${o.shape === "selected" ? "" : o.ends === 2 ? "two round ends and " : "a round base and "}a side wall ${fmtLen(total, u)} long and ${fmtLen(o.wallMm, u)} tall. Its stitch line matches the end's, ${fmtLen(stitchLen, u)}${all ? ", and its two short ends sew together" : ""}.${in3d ? " See it in 3D to check the shape." : ""} Ctrl+Z takes it back.`.replace(/\s+/g, " "),
  );
  notify();
  return gid;
}

/** Read typed words and lengths: RoundGusset [circle|oval|d|selected] [across [down]] [wall] [all|part] [one|two]. */
export function roundArgs(args: string[], parseLen: (s: string) => number | null): Partial<RoundGusset> & { nums: number[] } {
  const out: Partial<RoundGusset> & { nums: number[] } = { nums: [] };
  for (const a of args) {
    const w = a.toLowerCase();
    if (/^(circle|round|disc)$/.test(w)) out.shape = "circle";
    else if (/^(oval|ellipse)$/.test(w)) out.shape = "oval";
    else if (/^(d|dshape|d-shape|half)$/.test(w)) out.shape = "d";
    else if (/^(selected|piece|this)$/.test(w)) out.shape = "selected";
    else if (/^(all|full|around|round-all)$/.test(w)) out.wrap = "all";
    else if (/^(part|curve|curved|partway)$/.test(w)) out.wrap = "part";
    else if (/^(one|1end|cup|bucket|open)$/.test(w)) out.ends = 1;
    else if (/^(two|2ends|closed|both)$/.test(w)) out.ends = 2;
    else {
      const v = parseLen(a);
      if (v !== null) out.nums.push(v);
    }
  }
  return out;
}

/** Run from the command line or the dialog: fill in what was not typed, then make it. */
export async function roundGussetCommand(args: string[], parseLen: (s: string) => number | null): Promise<void> {
  const r = roundArgs(args, parseLen);
  const shape: RoundShape = r.shape ?? (piece(selectedPieceId() ?? "") && !r.nums.length ? "selected" : "circle");
  const n = r.nums;
  // Circle: across, wall. Oval or D: across, down, wall. A selected piece: wall.
  const across = shape === "selected" ? 0 : n[0] ?? 0;
  const down = shape === "oval" || shape === "d" ? n[1] ?? 0 : across;
  const wall = shape === "selected" ? n[0] ?? 0 : shape === "circle" ? n[1] ?? 0 : n[2] ?? 0;
  const o: RoundGusset = { shape, acrossMm: across, downMm: down, wallMm: wall, wrap: r.wrap ?? (shape === "d" ? "part" : "all"), ends: r.ends ?? 2 };
  try {
    await makeRoundGusset(o);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
    notify();
  }
}
