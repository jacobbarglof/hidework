// Mirrors crates/hidework-core/src/model.rs and compute.rs (camelCase JSON).

export type V = { x: number; y: number };
export type Units = "mm" | "in";
export type MaterialKind = "leather" | "waxedCanvas" | "other";
export type Orientation = "horizontal" | "vertical";
export type PageSize = "letter" | "a4";

export interface Physics {
  densityKgM3: number;
  bendingModulusMpa: number;
  tensileModulusMpa: number;
  anisotropy: number;
  biasStiffness: number;
  friction: number;
  tensileStrengthMpa?: number;
}

export interface Material {
  id: string;
  name: string;
  kind: MaterialKind;
  thicknessMm: number;
  physics?: (Physics & { tensileStrengthMpa?: number }) | null;
  costPerSqft?: number | null;
  color?: string | null;
}

export type Edge =
  | { type: "line"; stitched: boolean; skiveMm?: number }
  | { type: "cubic"; c1: V; c2: V; stitched: boolean; skiveMm?: number };

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
  lengthMm?: number;
  angleDeg?: number;
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
  notes?: string;
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
  threadColor?: string | null;
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
  skive: V[][];
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

export interface Preset {
  id: string;
  name: string;
  kind: MaterialKind;
  typicalOz: string;
  thicknessMm: number;
  physics: Physics;
  note: string;
}

export interface MaterialStats {
  id: string;
  physics: Physics;
  bendingLengthMm: number;
  flexuralRigidityUnm: number;
  gramsPerM2: number;
  ozPerYd2: number;
}

export type Side = "left" | "right" | "top" | "bottom";
export type Scene =
  | { type: "cantilever"; side: Side; overhangMm: number }
  | { type: "pedestal"; radiusMm: number }
  | { type: "hang"; side: Side };

export interface DrapeVariant {
  label: string;
  thicknessMm: number;
  physics: Physics;
}

export interface DrapeRequest {
  outline: V[];
  grainDeg: number;
  scene: Scene;
  variants: DrapeVariant[];
  resolution?: number;
  seconds?: number;
}

export interface DrapeMetrics {
  bendingLengthMm: number;
  flexuralRigidityUnm: number;
  massG: number;
  areaCm2: number;
  tipDropMm: number;
  droopDeg: number | null;
  drapeCoefficient: number | null;
  maxStretchPct: number;
  settled: boolean;
  secondsSimulated: number;
}

export type Support =
  | { type: "table"; side: Side; edgeMm: number }
  | { type: "disc"; center: V; radiusMm: number }
  | { type: "pins"; side: Side };

export interface DrapeResult {
  rest: V[];
  triangles: [number, number, number][];
  support: Support;
  variants: { label: string; frames: number[][]; metrics: DrapeMetrics }[];
}

export interface Bom {
  wastePct: number;
  materials: { materialId: string; name: string; pieces: number; areaCm2: number; sqft: number; sqftWithWaste: number; cost: number | null }[];
  pieces: { name: string; material: string; cutCount: number; areaCm2: number; stitchHoles: number }[];
  hardware: { label: string; diameterMm: number; slotMm: number; count: number }[];
  seamMm: number;
  threadM: number;
  stitchHoles: number;
  totalCost: number | null;
}

export interface FabOptions {
  pieces?: string[];
  stitchHoleMm?: number;
  kerfMm?: number;
  plateMm?: number;
  includeStitchHoles?: boolean;
  includePunchHoles?: boolean;
  includeFolds?: boolean;
  includeLabels?: boolean;
}

export interface StrapParams {
  name?: string;
  lengthMm?: number;
  widthMm?: number;
  tip?: "round" | "point" | "square";
  holes?: number;
  holeSpacingMm?: number;
  firstHoleMm?: number;
  holeMm?: number;
  buckleEnd?: boolean;
  buckleFoldMm?: number;
  tongueSlotMm?: number;
  rivetMm?: number;
  stitched?: boolean;
}