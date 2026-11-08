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

export type EdgeFinish = "raw" | "burnished" | "painted" | "turned" | "bound";
interface EdgeCommon {
  stitched: boolean;
  skiveMm?: number;
  finish?: EdgeFinish;
  turnMm?: number;
  crease?: boolean;
}
export type Edge = ({ type: "line" } & EdgeCommon) | ({ type: "cubic"; c1: V; c2: V } & EdgeCommon);

export type StitchKind =
  | "saddle" | "lockstitch" | "running" | "backstitch" | "cross" | "baseball" | "whip" | "blanket"
  | "laceWhip" | "laceSingleLoop" | "laceDoubleLoop" | "laceCross";

export interface StitchSettings {
  marginMm: number;
  pitchMm: number;
  holeMm: number;
  kind?: StitchKind;
  rows?: number;
  rowGapMm?: number;
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
  hardware?: HardwarePlacement[];
  marks?: Mark[];
  /** Tooling on damp veg-tan: cuts and stamping (see ui/src/tooling.ts). */
  tooling?: ToolingStroke[];
  place?: Place | null;
}

export interface HardwarePlacement {
  id: string;
  kind: string;
  at: V;
  angleDeg?: number;
  sizeMm?: number;
  label?: string;
}

export type MarkKind = "stamp" | "tooling" | "emboss" | "engrave" | "paint" | "text" | "perforate";
export interface Mark {
  id: string;
  kind: MarkKind;
  center: V;
  size: V;
  angleDeg?: number;
  text?: string;
  pattern?: string;
}

/** What a tooling stroke does with its points (model.rs StrokeKind). */
export type StrokeKind = "cut" | "line" | "fill" | "stamp" | "letters";
/** The tool that makes it (model.rs ToolKind). */
export type ToolKind = "swivelKnife" | "beveler" | "backgrounder" | "pearShader" | "seeder" | "camouflage" | "veiner" | "muleFoot" | "basketweave" | "border" | "letter";
/** One cut line, row of stamps, stamped area or word of lettering; points in piece design mm. */
export interface ToolingStroke {
  id: string;
  kind: StrokeKind;
  tool: ToolKind;
  points: V[];
  /** A smooth curve through the points (Catmull-Rom, i.e. a chain of cubic Beziers). */
  smooth?: boolean;
  closed?: boolean;
  /** Stamp face (or cut) width; 0 = the tool's usual size. */
  sizeMm?: number;
  depthMm?: number;
  /** Distance between impressions; 0 = usual. */
  spacingMm?: number;
  angleDeg?: number;
  /** Line of stamps: +1 left of travel (the (-y, x) normal), -1 right, 0 on the line. */
  side?: number;
  text?: string;
  /** Strokes from one ready-made design share a group and move together. */
  group?: string;
}
export type Design = "border" | "basketweave" | "floral" | "corner" | "checkerboard" | "diamond" | "monogram";
export interface DesignRequest {
  design: Design;
  at: V;
  sizeMm?: number;
  tool?: ToolKind | null;
  insetMm?: number;
  text?: string;
  rect?: Rect | null;
}

export type Face = "flat" | "front" | "back" | "left" | "right" | "bottom" | "top" | "wrapSides" | "wrapAround" | "backFlap" | "handleFront" | "handleBack" | "strapSides";
export interface Place {
  face: Face;
  offset?: V;
  layerMm?: number;
  spanMm?: number;
  tabMm?: number;
}

export interface Form {
  widthMm: number;
  depthMm: number;
  heightMm: number;
  round?: boolean;
  cornerMm?: number;
}

export type Construction = "edgeToEdge" | "turned" | "lapped" | "butt" | "welted" | "piped" | "bound" | "zipper";
export type Adhesive = "none" | "contactCement" | "waterContact" | "pva" | "tape";

export interface Laminate {
  id: string;
  a: string;
  b: string;
  glue?: Adhesive;
}

export interface EdgeRef {
  pieceId: string;
  edges: number[];
}

export interface Join {
  id: string;
  a: EdgeRef;
  b: EdgeRef;
  construction?: Construction;
  glue?: Adhesive;
  glueWidthMm?: number;
  insertMaterialId?: string | null;
  insertMm?: number;
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
  thread?: string | null;
  form?: Form | null;
  laminates?: Laminate[];
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
  kind?: StitchKind;
  row?: number;
  lace?: boolean;
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
  glue?: V[][];
  creases?: V[][];
  marks?: Mark[];
  hardware?: HardwarePlacement[];
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
  hardware: { label: string; diameterMm: number; slotMm: number; count: number; kind: string; grams: number }[];
  seamMm: number;
  threadM: number;
  threads: { name: string; stitch: string; seamMm: number; lengthM: number }[];
  glue: { name: string; areaCm2: number; grams: number }[];
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

// ---------- craft catalogue (crates/hidework-core/src/craft.rs) ----------

export interface StitchInfo { kind: StitchKind; name: string; group: string; description: string; threadFactor: number; strands: number; wrapsEdge: boolean; lace: boolean; needles: number; defaultPitchMm: number }
export interface ThreadInfo { id: string; name: string; diameterMm: number; breakN: number; lace: boolean }
export interface ConstructionInfo { construction: Construction; name: string; description: string }
export interface AdhesiveInfo { adhesive: Adhesive; name: string; description: string; shearMpa: number; gramsPerM2: number }
export interface FinishInfo { finish: EdgeFinish; name: string; description: string }
export interface HardwareInfo { id: string; name: string; group: string; description: string; defaultSizeMm: number; sizeLabel: string; grams: number; fastens: boolean; holdN: number }
export interface Catalogue {
  stitches: StitchInfo[];
  threads: ThreadInfo[];
  constructions: ConstructionInfo[];
  adhesives: AdhesiveInfo[];
  finishes: FinishInfo[];
  hardware: HardwareInfo[];
}

export type BagStyle = "tote" | "boxedTote" | "messenger" | "zipPouch" | "bucket";
export interface BagParams {
  name: string;
  style: BagStyle;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  cornerMm: number;
  leather: string;
  thicknessMm: number;
  construction: Construction;
  glue: Adhesive;
  stitch: StitchKind;
  carry: "none" | "handles" | "shoulder" | "both";
  handleLengthMm: number;
  handleWidthMm: number;
  strapLengthMm: number;
  strapWidthMm: number;
  closure: "none" | "magnetic" | "turnLock" | "snap";
  flapMm: number;
  pocket: boolean;
  feet: boolean;
  edge: EdgeFinish;
  threadColor: string;
}
