// Mirrors crates/hidework-core/src/check.rs (camelCase JSON): what the pattern checker reports.

import type { EdgeRef, Hole, V } from "./types";

/** problem: will not go together as drawn. warning: probably wrong or weak. tip: worth knowing. */
export type Severity = "problem" | "warning" | "tip";

/**
 * A one-click fix. Coordinates are design coordinates (as stored in the project, before fold
 * allowances). `matchSeam` stretches a piece: everything beyond `atMm` along `axis` moves by
 * `byMm` (negative shrinks).
 */
export type FixAction =
  | { kind: "matchSeam"; joinId: string; pieceId: string; axis: "x" | "y"; atMm: number; byMm: number }
  | { kind: "setStitchPitch"; pieceId: string; pitchMm: number }
  | { kind: "setStitchMargin"; pieceId: string; marginMm: number }
  | { kind: "setStitched"; pieceId: string; edges: number[]; stitched: boolean }
  | { kind: "setSkive"; pieceId: string; edges: number[]; skiveMm: number }
  | { kind: "setTurn"; pieceId: string; edges: number[]; turnMm: number }
  | { kind: "setFoldContents"; pieceId: string; foldId: string; contentsMm: number }
  | { kind: "moveHole"; pieceId: string; holeId: string; to: V }
  | { kind: "moveHardware"; pieceId: string; hardwareId: string; to: V }
  | { kind: "addHole"; pieceId: string; hole: Hole }
  | { kind: "movePiece"; pieceId: string; to: V }
  | { kind: "setGrain"; pieceId: string; grainDeg: number }
  | { kind: "setMaterial"; pieceId: string; materialId: string }
  | { kind: "setThread"; thread: string }
  | { kind: "removeJoin"; joinId: string };

export interface Issue {
  /** Stable for the same problem across runs. */
  id: string;
  /** Which check found it, e.g. "seamLength", "holeEdge", "fastenerAlign". */
  check: string;
  severity: Severity;
  /** Pieces involved; the first is the one to show. */
  pieceIds: string[];
  edges: EdgeRef[];
  joinId: string | null;
  holeId: string | null;
  hardwareId: string | null;
  foldId: string | null;
  /** On the first piece, piece-local mm as drawn (after fold allowances). */
  at: V | null;
  /** The same point on the template sheet. */
  sheetAt: V | null;
  /** In 3D (mm, z up), for bags arranged on a form. */
  world: [number, number, number] | null;
  title: string;
  /** What is wrong and why it matters. */
  message: string;
  /** Exactly how to fix it. */
  fix: string;
  fixAction: FixAction | null;
}

/** One finding from the 3D test (`sim_diagnose`), normalised from whatever the simulator sends. */
export interface SimFinding {
  severity: Severity;
  title: string;
  message: string;
  fix: string;
  pieceIds: string[];
}
