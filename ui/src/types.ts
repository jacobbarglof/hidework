// Mirrors crates/hidework-core/src/model.rs and compute.rs (camelCase JSON).

export type V = { x: number; y: number };
export type Units = "mm" | "in";
export type MaterialKind = "leather" | "waxedCanvas" | "other";
export type Orientation = "horizontal" | "vertical";
export type PageSize = "letter" | "a4";

export interface Material {
  id: string;
  name: string;
  kind: MaterialKind;
  thicknessMm: number;
}

export type Edge =
  | { type: "line"; stitched: boolean }
  | { type: "cubic"; c1: V; c2: V; stitched: boolean };

export interface StitchSettings {
  marginMm: number;
  pitchMm: number;
  holeMm: number;
}

export interface Fold {
  id: string;
  orientation: Orientation;
  position: number;
  contentsMm: number;
}

export interface Hole {
  id: string;
  center: V;
  diameterMm: number;
  label: string;
}

export interface Piece {
  id: string;
  name: string;
  materialId: string;
  position: V;
  vertices: V[];
  edges: Edge[];
  cutCount: number;
  seamAllowanceMm: number;
  stitch: StitchSettings;
  folds: Fold[];
  holes: Hole[];
  grainDeg: number;
}

export interface EdgeRef {
  pieceId: string;
  edges: number[];
}

export interface Join {
  id: string;
  a: EdgeRef;
  b: EdgeRef;
}

export interface Project {
  format: string;
  version: number;
  name: string;
  units: Units;
  materials: Material[];
  pieces: Piece[];
  joins: Join[];
}

export interface Rect {
  min: V;
  max: V;
}

export interface StitchRun {
  points: V[];
  closed: boolean;
  holes: V[];
  spacingMm: number;
}

export interface FoldGeom {
  id: string;
  orientation: Orientation;
  at: number;
  stageAt: number;
  shiftMm: number;
  start: [V, V][];
  end: [V, V][];
  center: [V, V][];
}

export interface EdgeReport {
  lengthMm: number;
  stitchLengthMm: number;
  holeCount: number;
}

export interface ComputedPiece {
  id: string;
  outline: V[];
  outlineEdges: (number | null)[];
  cut: V[];
  vertices: V[];
  controls: ([V, V] | null)[];
  stitchRuns: StitchRun[];
  folds: FoldGeom[];
  holes: Hole[];
  edges: EdgeReport[];
  thicknessMm: number;
  materialName: string;
  bounds: Rect;
}

export interface JoinReport {
  id: string;
  aLengthMm: number;
  bLengthMm: number;
  aStitchMm: number;
  bStitchMm: number;
  aHoles: number;
  bHoles: number;
  ok: boolean;
  message: string;
}

export interface Computed {
  pieces: ComputedPiece[];
  joins: JoinReport[];
  warnings: string[];
  bounds: Rect | null;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
}
