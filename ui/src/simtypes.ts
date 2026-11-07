// Mirrors crates/hidework-core/src/sim.rs.

export type Shape =
  | { type: "box"; size: [number, number, number] }
  | { type: "sphere"; radius: number }
  | { type: "cylinder"; radius: number; height: number };

export type Prop =
  | { type: "box"; min: [number, number, number]; max: [number, number, number] }
  | { type: "pedestal"; center: [number, number]; radius: number; top: number }
  | { type: "bar"; a: [number, number, number]; b: [number, number, number]; radius: number };

export interface SimObject {
  id: string;
  name: string;
  shape: Shape;
  grams: number;
  pos: [number, number, number];
}

export interface SurfacePoint {
  tri: number;
  bary: [number, number, number];
}

export interface SimInfo {
  pieces: { id: string; name: string; materialId: string; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number; thicknessMm: number }[];
  rest: number[];
  indices: number[];
  boundary: [number, number][];
  stitches: { pieceId: string; closed: boolean; holes: SurfacePoint[] }[];
  hardware: { pieceId: string; at: SurfacePoint; diameterMm: number; slotMm: number; angleDeg: number; label: string }[];
  seams: number;
  fasteners: number;
  warnings: string[];
}

export interface SimMetrics {
  timeS: number;
  loadG: number;
  clothG: number;
  maxStressMpa: number;
  maxStrainPct: number;
  maxStitchN: number;
  stitchCapacityN: number;
  maxPinN: number;
  pinCapacityN: number;
  panelStrengthMpa: number;
  capacityKg: number | null;
  limitedBy: string;
  sagMm: number;
  settled: boolean;
  pins: number;
}

export interface SimStatus {
  metrics: SimMetrics;
  pins: [string, [number, number, number]][];
  objects: SimObject[];
  objectPositions: [string, [number, number, number]][];
  weights: [string, number, [number, number, number]][];
  props: Prop[];
}
