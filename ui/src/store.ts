// Application state, undo history, and the recompute loop that asks the Rust core for geometry.

import { api } from "./api";
import type { Computed, ComputedPiece, Orientation, PageSize, Piece, Project } from "./types";

export type Sel =
  | { kind: "none" }
  | { kind: "piece"; piece: string }
  | { kind: "edge"; piece: string; index: number }
  | { kind: "vertex"; piece: string; index: number }
  | { kind: "hole"; piece: string; id: string }
  | { kind: "fold"; piece: string; id: string }
  | { kind: "join"; id: string };

export type Tool = "select" | "hole" | "fold" | "join";

export const state = {
  project: null as unknown as Project,
  computed: null as Computed | null,
  sel: { kind: "none" } as Sel,
  tool: "select" as Tool,
  foldOrientation: "horizontal" as Orientation,
  page: "letter" as PageSize,
  pages: 1,
  filePath: null as string | null,
  dirty: false,
  joinPending: null as { piece: string; edge: number } | null,
  status: "",
};

const undoStack: string[] = [];
const redoStack: string[] = [];
const listeners = new Set<() => void>();

export function subscribe(fn: () => void): void {
  listeners.add(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

export function setStatus(text: string): void {
  state.status = text;
  notify();
}

/** Record the current project for undo. Call once before a change (or a drag). */
export function snapshot(): void {
  undoStack.push(JSON.stringify(state.project));
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  state.dirty = true;
}

/** Make an undoable change and recompute. */
export function edit(fn: (p: Project) => void): void {
  snapshot();
  fn(state.project);
  changed();
}

export function changed(): void {
  recompute();
  notify();
}

export function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(JSON.stringify(state.project));
  state.project = JSON.parse(prev);
  fixSelection();
  changed();
}

export function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(JSON.stringify(state.project));
  state.project = JSON.parse(next);
  fixSelection();
  changed();
}

export function setProject(p: Project, path: string | null): void {
  state.project = p;
  state.filePath = path;
  state.dirty = false;
  state.sel = { kind: "none" };
  state.joinPending = null;
  undoStack.length = 0;
  redoStack.length = 0;
  changed();
}

/** Drop a selection that no longer points at anything (after undo or delete). */
export function fixSelection(): void {
  const s = state.sel;
  if (s.kind === "none") return;
  if (s.kind === "join") {
    if (!state.project.joins.some((j) => j.id === s.id)) state.sel = { kind: "none" };
    return;
  }
  const p = piece(s.piece);
  if (!p) state.sel = { kind: "none" };
  else if ((s.kind === "edge" || s.kind === "vertex") && s.index >= p.vertices.length) state.sel = { kind: "piece", piece: p.id };
  else if (s.kind === "hole" && !p.holes.some((h) => h.id === s.id)) state.sel = { kind: "piece", piece: p.id };
  else if (s.kind === "fold" && !p.folds.some((f) => f.id === s.id)) state.sel = { kind: "piece", piece: p.id };
}

let inflight = false;
let again = false;
let pageTimer: number | undefined;

async function recompute(): Promise<void> {
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  try {
    state.computed = await api.compute(state.project);
  } catch (e) {
    state.status = `Could not compute the pattern: ${e}`;
  }
  inflight = false;
  notify();
  if (again) {
    again = false;
    void recompute();
  }
  window.clearTimeout(pageTimer);
  pageTimer = window.setTimeout(async () => {
    try {
      state.pages = await api.pageCount(state.project, state.page);
      notify();
    } catch {
      /* page count is advisory */
    }
  }, 250);
}

export function piece(id: string): Piece | undefined {
  return state.project.pieces.find((p) => p.id === id);
}

export function computedPiece(id: string): ComputedPiece | undefined {
  return state.computed?.pieces.find((p) => p.id === id);
}

export function selectedPieceId(): string | null {
  const s = state.sel;
  return s.kind === "none" || s.kind === "join" ? null : s.piece;
}

export function uid(prefix: string): string {
  return `${prefix}${crypto.randomUUID().slice(0, 8)}`;
}
