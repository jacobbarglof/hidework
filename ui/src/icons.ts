// Command icons: literal pictures of the real things a leatherworker uses (swivel knife, pricking
// iron, round punch, rivet setter, mallet and stamp, steel rule, edge slicker, glue pot…) and of
// real objects for actions (printer, scissors, clipboard, magnifier, cube), drawn like a
// professional CAD tool's: one outline colour that follows the theme, a light tint for leather,
// wood and paper, and one muted brass accent used only on the working part. 24 × 24 grid, 1.8 px
// strokes, butt caps and mitred corners; thin detail lines are 1.1 to 1.3 px. Long hand tools
// are drawn upright and turned 45° (handle top right, working end bottom left), like a pencil.
// Colours come from CSS (`.ico`, `.f-t`, `.f-a`, `.f-l`, `.s-a`), so every theme works.

const T = "f-t"; // tint: leather, paper, wood, a body
const A = "f-a"; // brass accent: the working part
const L = "f-l"; // solid in the outline colour (arrowheads, dots, steel)

/** A filled shape with the same outline drawn on top. */
const fo = (cls: string, shape: string): string => shape.replace(/^<(\w+)/, `<$1 class="${cls}"`) + shape;
/** A small solid square dot (holes, eyes, stitch points). */
const dot = (x: number, y: number, r = 0.9): string => `<rect class="${L}" x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}"/>`;
/** An upright tool turned 45° clockwise: its top goes to the top right. */
const tilt = (body: string): string => `<g transform="rotate(45 12 12)">${body}</g>`;
const STITCH = `stroke-width="1.3" stroke-dasharray="1.6 1.4"`;
const THIN = `stroke-width="1.2"`;

const CUBE = "M12 3l8 4.5v9L12 21l-8-4.5v-9z";
const CUBE_LINES = "M4 7.5l8 4.5 8-4.5M12 12v9";
const PAGE = "M5 2.5h10l4 4v15H5z";
const FOLD = "M15 2.5v4h4";
/** The outline of a whole hide. */
const HIDE = "M5 3.5c2 1 4.5.5 7 .5s5 .5 7-.5c-.5 3 1 5 2.5 7-1.5 2-3 3.5-2.5 6.5-2 0-3.5 1.5-4.5 3.5-1-.8-1.8-1-2.5-1s-1.5.2-2.5 1c-1-2-2.5-3.5-4.5-3.5.5-3-1-4.5-2.5-6.5 1.5-2 3-4 2.5-7z";
/** A wooden tool handle for the upright templates (y 1 to 11). */
const HANDLE = fo(T, `<path d="M9.4 1h5.2v9.2l-1 1.6h-3.2l-1-1.6z"/>`) + fo(L, `<rect x="10.4" y="11.8" width="3.2" height="1.8"/>`);
/** A tooling stamp's knurled shaft (x 10.3 to 13.7). */
const shaft = (top: number, bottom: number): string =>
  fo(T, `<rect x="10.3" y="${top}" width="3.4" height="${bottom - top}"/>`) + `<path d="M10.3 ${top + 3}h3.4M10.3 ${top + 5.5}h3.4" stroke-width="1.1"/>`;

const ICONS: Record<string, string> = {
  // ---------- pieces (leather shapes with their stitch line) ----------
  rect: fo(T, `<rect x="3" y="6" width="18" height="12" rx="1"/>`) + `<rect x="5.5" y="8.5" width="13" height="7" ${STITCH}/>`,
  roundrect: fo(T, `<rect x="3" y="6" width="18" height="12" rx="4"/>`) + `<rect x="5.5" y="8.5" width="13" height="7" rx="2" ${STITCH}/>`,
  circle: fo(T, `<circle cx="12" cy="12" r="9.5"/>`) + `<circle cx="12" cy="12" r="6.7" ${STITCH}/>`,
  ellipse: fo(T, `<ellipse cx="12" cy="12" rx="10" ry="6.5"/>`) + `<ellipse cx="12" cy="12" rx="7.3" ry="3.9" ${STITCH}/>`,
  // Slot: a long piece with both ends fully round (a keeper or belt loop).
  slot: fo(T, `<rect x="1.5" y="8" width="21" height="8" rx="4"/>`) + `<path d="M6 10.5h12" ${STITCH}/><path d="M6 13.5h12" ${STITCH}/>`,
  // Strap end: one square end and one rounded end, with its stitch line.
  strapend: fo(T, `<path d="M2 7.5h15.5a4.5 4.5 0 010 9H2z"/>`) + `<path d="M2 10h15.5a2 2 0 010 4H2" ${STITCH}/>`,
  polygon: fo(T, `<path d="M12 3l9 6.5-3.5 10.5h-11L3 9.5z"/>`) + `<path d="M12 6.2l6.3 4.5-2.4 7.4H8.1l-2.4-7.4z" ${STITCH}/>`,
  strap: fo(T, `<path d="M7 9.5h10l4.5 2.5-4.5 2.5H7z"/>`) + fo(A, `<rect x="2" y="7.5" width="5" height="9"/>`) + `<path d="M4.5 12h5"/>` + dot(12, 12) + dot(15, 12),
  bag: fo(T, `<path d="M4 9.5h16l-1.5 11h-13z"/>`) + `<path d="M8.5 9.5V7a3.5 3.5 0 017 0v2.5"/><path d="M5.6 12.5h12.8" ${STITCH}/>`,
  // New project: a pattern sheet with a stitched piece on it and a pencil.
  template: fo(T, `<path d="M4 2.5h11l4 4V21H4z"/>`) + `<path d="M7 8h7v8H7z" ${STITCH}/>` + fo(A, `<path d="M14.5 21.5l-.8-3.2 6.8-6.8 2.4 2.4-6.8 6.8z"/>`),
  // ---------- drawing tools ----------
  // Pen: click the points of an outline; the nib sets the last one.
  pen: `<path d="M3.5 20.5l3-10 6.5 4"/>` + fo(T, `<rect x="2.2" y="19.2" width="2.6" height="2.6"/>`) + fo(T, `<rect x="5.2" y="9.2" width="2.6" height="2.6"/>`) + fo(A, `<path d="M13 14.5l1.2-5.2 5.3-5.3 3 3-5.3 5.3z"/>`) + `<path d="M13 14.5l3.4-3.4" stroke-width="1.1"/>`,
  // Freehand: a pencil drawing a loose line.
  freehand: `<path d="M2.5 15.5c2-2.5 3.5-2.5 4 0s2 4 4.5 1.5"/>` + fo(T, `<path d="M12 13.5l6.2-6.25 2.55 2.55-6.25 6.2z"/>`) + fo(A, `<path d="M11 17l1-3.5 2.5 2.5z"/>`),
  // Mirror half: draw one half; the other half (dashed) follows across the centre line.
  mirrorhalf: fo(T, `<path d="M12 3.5H7L3 9v6.5l4 5h5z"/>`) + `<path d="M12 3.5h5l4 5.5v6.5l-4 5h-5" stroke-dasharray="2 1.6"/><path class="s-a" d="M12 1.5v21"/>`,
  addpoint: `<path d="M2.5 21l19-8"/>` + dot(2.5, 21, 1.3) + dot(21.5, 13, 1.3) + fo(A, `<rect x="9.8" y="14.8" width="4.4" height="4.4"/>`) + `<path d="M6.5 2.5v8M2.5 6.5h8" stroke-width="2"/>`,
  deletepoint: `<path d="M2.5 21l19-8"/>` + dot(2.5, 21, 1.3) + dot(21.5, 13, 1.3) + `<path d="M9.5 13.5l5 5M14.5 13.5l-5 5" stroke-width="1.6"/><path d="M2.5 6.5h8" stroke-width="2"/>`,
  // Curve an edge: a curved edge with its two bezier handles.
  curveedge: `<path d="M3 20.5C4 14 8 12 12 12s8-2 9-8.5"/><path d="M5 12h14" ${THIN}/>` + dot(3, 20.5, 1.3) + dot(21, 3.5, 1.3) + fo(L, `<rect x="10.4" y="10.4" width="3.2" height="3.2"/>`) + fo(A, `<circle cx="4.5" cy="12" r="1.9"/>`) + fo(A, `<circle cx="19.5" cy="12" r="1.9"/>`),
  // Edge length: the selected edge with a dimension line over it.
  edgelength: `<path class="s-a" d="M3 18h18"/>` + dot(3, 18, 1.3) + dot(21, 18, 1.3) + `<path d="M3 5v9M21 5v9" ${THIN}/><path d="M6.5 9.5h11"/>` + fo(L, `<path d="M3.5 9.5l3.5-2.6v5.2zM20.5 9.5L17 6.9v5.2z"/>`),
  // Edge angle: the selected edge turned up from level, with the angle marked.
  edgeangle: `<path d="M4 19h17" stroke-dasharray="2 1.6"/><path class="s-a" d="M4 19L16 4.5"/><path d="M12.5 19a8.5 8.5 0 00-3.1-6.6"/>` + dot(4, 19, 1.4),
  // Snap to objects: a dragged point lands on another piece's corner (square snap marker).
  snapobjects: fo(T, `<rect x="2.5" y="11.5" width="10" height="10"/>`) + `<rect class="s-a" x="9.5" y="8.5" width="6" height="6"/><path d="M21.5 2.5l-5 5"/>` + fo(L, `<path d="M15.8 8.2l.6-4 3.4 3.4z"/>`),
  // Guides: rulers along the top and left with a guide line pulled from each.
  guides: fo(T, `<path d="M2 2h20v4.5H6.5V22H2z"/>`) + `<path d="M10 2v2.5M14 2v2.5M18 2v2.5M2 10h2.5M2 14h2.5M2 18h2.5" ${THIN}/><path class="s-a" d="M15.5 6.5V22M6.5 15.5H22" stroke-dasharray="2.2 1.6"/>`,
  // ---------- files ----------
  new: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M12 10v7.5M8.25 13.75h7.5"/>`,
  open: fo(T, `<path d="M2.5 5.5h7l2 2h10v13h-19z"/>`) + `<path d="M2.5 10.5h19"/>`,
  // Pick up where you left off: a page with a bookmark ribbon in it.
  resume: fo(T, `<path d="${PAGE}"/>`) + `<path d="${FOLD}"/>` + fo(A, `<path d="M8 2.5h4.5v9l-2.25-2-2.25 2z"/>`) + `<path d="M8 15h7.5M8 18h5" ${THIN}/>`,
  save: fo(T, `<path d="M4 3.5h13l3 3v14H4z"/>`) + `<path d="M7.5 3.5V8h8V3.5"/><rect x="7" y="13" width="10" height="7.5"/>`,
  saveas: `<path d="M3 6h10l3 3v12H3z"/><path d="M6 6v3.5h6V6"/><rect x="5.5" y="14" width="8" height="7"/>` + fo(A, `<path d="M14.5 13.5l-.6-2.6 6-6 2.1 2.1-6 6z"/>`),
  // Bring in a pattern: a sheet with an arrow coming in from the left.
  import: `<path d="M8 2.5h8l4 4v15H8z"/><path d="M16 2.5v4h4"/>` + `<path d="M2 13.5h10.5"/>` + fo(L, `<path d="M10 10.5l3.5 3-3.5 3z"/>`),
  // Export: a sheet with an arrow going out to the right.
  export: `<path d="M3 2.5h8l4 4v15H3z"/><path d="M11 2.5v4h4"/>` + `<path d="M9 13.5h10.5"/>` + fo(L, `<path d="M18.5 10.5l3.5 3-3.5 3z"/>`),
  print: `<path d="M7 9V3h10v6"/>` + fo(T, `<path d="M3 9h18v8H3z"/>`) + fo(T, `<path d="M7 14h10v7.5H7z"/>`) + `<path d="M9 16.5h6v3H9z" ${STITCH}/>`,
  paper: fo(T, `<path d="M6 3h12v18H6z"/>`) + `<path d="M6 6.5h3M6 10h2M6 13.5h3M6 17h2"/>`,
  pdf: `<path d="${PAGE}"/><path d="${FOLD}"/>` + fo(T, `<path d="M7.5 9h4v4.5h-4zM12.5 9h4v4.5h-4zM7.5 14.5h4V19h-4zM12.5 14.5h4V19h-4z"/>`),
  svg: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M8 18c.5-5 7.5-5 8 0"/>` + fo(L, `<path d="M6.8 16.8h2.4v2.4H6.8zM14.8 16.8h2.4v2.4h-2.4zM10.8 11.3h2.4v2.4h-2.4z"/>`),
  laser: fo(T, `<rect x="7" y="2" width="10" height="6"/>`) + `<path d="M10 8h4l-1 2.5h-2z"/><path class="s-a" d="M12 10.5V18"/><path d="M2.5 19.5h7.5M14 19.5h7.5"/>`,
  dxf: fo(T, `<path d="M3 15l9 4 9-4-9-4z"/>`) + `<path d="M3 11.5l9 4 9-4M3 8l9 4 9-4-9-4z"/>`,
  stl: fo(T, `<path d="M3 13l9-4.5 9 4.5-9 4.5z"/>`) + `<path d="M3 13v2.5l9 4.5 9-4.5V13"/>` + dot(9, 13) + dot(12, 11.5) + dot(15, 13) + dot(12, 14.5),
  image: fo(T, `<rect x="3" y="5" width="18" height="14"/>`) + `<path d="M3 16l5-5 4 4 3-3 6 6"/>` + dot(16, 9, 1.2),
  image3d: `<rect x="3" y="4" width="18" height="16"/>` + fo(T, `<path d="M12 7.5l4.5 2.2v4.6L12 16.5l-4.5-2.2V9.7z"/>`) + `<path d="M7.5 9.7l4.5 2.2 4.5-2.2M12 11.9v4.6"/>`,
  // ---------- edit ----------
  undo: `<path d="M5 9.5h9.5a6 6 0 010 12H9"/>` + fo(L, `<path d="M9.5 4.5L3 9.5l6.5 5z"/>`),
  redo: `<path d="M19 9.5H9.5a6 6 0 000 12H15"/>` + fo(L, `<path d="M14.5 4.5l6.5 5-6.5 5z"/>`),
  select: fo(T, `<path d="M6 3l12 9.5-5.2.8 3 5.6-2.6 1.4-3-5.6L6 18.5z"/>`),
  selectall: `<rect x="2.5" y="2.5" width="19" height="19" stroke-dasharray="2.6 2"/>` + fo(T, `<path d="M8.5 7l8.5 6.5-3.6.6 2 3.8-1.9 1-2-3.8-3 2.8z"/>`),
  cut: `<circle cx="7" cy="18" r="3"/><circle cx="17" cy="18" r="3"/><path d="M9 15.6L18.5 3M15 15.6L5.5 3"/>`,
  copy: `<path d="M15 7V3H3v13h4"/>` + fo(T, `<rect x="8" y="7" width="13" height="14"/>`),
  paste: fo(T, `<rect x="4.5" y="4" width="15" height="17.5"/>`) + fo(A, `<rect x="8.5" y="2.5" width="7" height="3.5"/>`) + `<path d="M8 11h8M8 15h6"/>`,
  cancel: `<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>`,
  // ---------- modify ----------
  mirror: fo(T, `<path d="M3 6l7 6-7 6z"/>`) + `<path d="M21 6l-7 6 7 6z"/><path d="M12 2.5v19" stroke-dasharray="2 2"/>`,
  flip: fo(T, `<path d="M6 3l6 7 6-7z"/>`) + `<path d="M6 21l6-7 6 7z"/><path d="M2.5 12h19" stroke-dasharray="2 2"/>`,
  rotate: fo(T, `<rect x="7" y="10" width="10" height="10"/>`) + `<path d="M4.5 9A8 8 0 0117.5 5"/>` + fo(L, `<path d="M15.5 2l4.5 2.8-3.9 3.5z"/>`),
  duplicate: `<rect x="3" y="3" width="12" height="12"/>` + fo(T, `<rect x="9" y="9" width="12" height="12"/>`) + `<rect x="11" y="11" width="8" height="8" ${STITCH}/>`,
  roundcorner: fo(T, `<path d="M4 21V12a8 8 0 018-8h9v17z"/>`) + `<path class="s-a" d="M12 12L6.3 6.3"/>` + dot(12, 12),
  dart: fo(T, `<path d="M3 4h6l3 9.5L15 4h6v16H3z"/>`) + `<path d="M12 13.5V20" stroke-dasharray="1.6 1.4"/>`,
  merge: fo(T, `<path d="M3 4h10v6h8v10H11v-6H3z"/>`) + `<path class="s-a" d="M11 10v4h2"/>`,
  delete: `<path d="M4 6.5h16M9 6.5V3.5h6v3"/>` + fo(T, `<path d="M6 6.5h12l-1 14.5H7z"/>`) + `<path d="M10 10.5v7M14 10.5v7"/>`,
  // Nudge: the four arrow keys.
  nudge: fo(T, `<rect x="8.8" y="3" width="6.4" height="6.4"/>`) + fo(T, `<rect x="1.6" y="11.5" width="6.4" height="6.4"/>`) + fo(T, `<rect x="8.8" y="11.5" width="6.4" height="6.4"/>`) + fo(T, `<rect x="16" y="11.5" width="6.4" height="6.4"/>`) +
    fo(L, `<path d="M12 4.7l1.9 2.6h-3.8zM12 16.2l1.9-2.6h-3.8zM3.3 14.7L5.9 12.8v3.8zM20.7 14.7L18.1 12.8v3.8z"/>`) + `<path d="M1.6 21.5h20.8" ${THIN}/>`,
  // Align: pieces moving across to meet a line.
  align: `<path class="s-a" d="M3 2.5v19"/>` + fo(T, `<rect x="10" y="4" width="11" height="6"/>`) + fo(T, `<rect x="13" y="14" width="8" height="6"/>`) + `<path d="M10 7H6.5M13 17H6.5"/>` + fo(L, `<path d="M4 7l3-2.2v4.4zM4 17l3-2.2v4.4z"/>`),
  alignleft: `<path d="M3.5 2.5v19"/>` + fo(T, `<rect x="6" y="5" width="13" height="5"/>`) + fo(T, `<rect x="6" y="14" width="8" height="5"/>`),
  aligncentre: `<path d="M12 2.5v19"/>` + fo(T, `<rect x="4.5" y="5" width="15" height="5"/>`) + fo(T, `<rect x="7.5" y="14" width="9" height="5"/>`),
  alignright: `<path d="M20.5 2.5v19"/>` + fo(T, `<rect x="5" y="5" width="13" height="5"/>`) + fo(T, `<rect x="10" y="14" width="8" height="5"/>`),
  aligntop: `<path d="M2.5 3.5h19"/>` + fo(T, `<rect x="5" y="6" width="5" height="13"/>`) + fo(T, `<rect x="14" y="6" width="5" height="8"/>`),
  alignmiddle: `<path d="M2.5 12h19"/>` + fo(T, `<rect x="5" y="4.5" width="5" height="15"/>`) + fo(T, `<rect x="14" y="7.5" width="5" height="9"/>`),
  alignbottom: `<path d="M2.5 20.5h19"/>` + fo(T, `<rect x="5" y="5" width="5" height="13"/>`) + fo(T, `<rect x="14" y="10" width="5" height="8"/>`),
  distribute: `<path d="M2.5 3v18M21.5 3v18"/>` + fo(T, `<rect x="5.5" y="7" width="3" height="10"/>`) + fo(T, `<rect x="10.5" y="7" width="3" height="10"/>`) + fo(T, `<rect x="15.5" y="7" width="3" height="10"/>`),
  distributey: `<path d="M3 2.5h18M3 21.5h18"/>` + fo(T, `<rect x="7" y="5.5" width="10" height="3"/>`) + fo(T, `<rect x="7" y="10.5" width="10" height="3"/>`) + fo(T, `<rect x="7" y="15.5" width="10" height="3"/>`),
  // ---------- pattern marks ----------
  fold: fo(T, `<path d="M2 20l6-5h14l-6 5z"/>`) + `<path d="M8 15V5h14v10"/><path d="M8 15h14" stroke-dasharray="2 1.6"/>`,
  folddir: `<path d="M3 12h18" stroke-dasharray="2.2 1.8"/>` + fo(L, `<path d="M12 2l-3 4h6zM12 22l-3-4h6z"/>`) + `<path d="M12 6v3.5M12 14.5V18"/>`,
  measure: fo(T, `<rect x="2" y="8" width="20" height="8"/>`) + `<path d="M5 8v3.5M8 8v2M11 8v3.5M14 8v2M17 8v3.5M20 8v2"/>`,
  snap: `<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18" stroke-width="1.2"/>` + fo(A, `<rect x="12.6" y="6.6" width="4.8" height="4.8"/>`),
  grid: `<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18" stroke-width="1.2"/>`,
  // Check my pattern: a stitched piece with a large tick.
  check: fo(T, `<rect x="2.5" y="3" width="14" height="14"/>`) + `<rect x="5" y="5.5" width="9" height="9" ${STITCH}/><path class="s-a" d="M10.5 16.5l3.5 3.5 7.5-8.5" stroke-width="2.8"/>`,
  // ---------- sewing ----------
  // Sew: a harness needle with its thread.
  sew: tilt(fo(T, `<path d="M10 1h4v15.5l-2 7-2-7z"/>`) + `<path d="M12 2.8v4.4" stroke-width="1.2"/><path class="s-a" d="M12 5c3.5-.5 6 1.5 6 5s-2.5 5.5-2.5 9 1.5 4.5 3 4.5"/>`),
  // Stitch type: a pricking iron, whose teeth set the stitch.
  prickingiron: fo(T, `<path d="M3.5 3.5h17v9h-17z"/>`) + `<path d="M3.5 6.5h17" ${THIN}/>` + fo(A, `<path d="M4.4 12.5h2.4l-.6 3.5-1.2.6zM8.6 12.5H11l-.6 3.5-1.2.6zM12.8 12.5h2.4l-.6 3.5-1.2.6zM17 12.5h2.4l-.6 3.5-1.2.6z"/>`) + fo(T, `<rect x="2" y="18" width="20" height="3.5"/>`) + `<path d="M5 18.5l1 2.5M9.2 18.5l1 2.5M13.4 18.5l1 2.5M17.6 18.5l1 2.5" stroke-width="1.3"/>`,
  // A stitching chisel: a striking cap and long flat prongs.
  stitchingchisel: fo(T, `<rect x="8.5" y="1.5" width="7" height="3"/>`) + fo(T, `<rect x="10.5" y="4.5" width="3" height="3"/>`) + fo(T, `<rect x="4" y="7.5" width="16" height="4"/>`) + fo(A, `<path d="M5 11.5h2.4v6.5l-1.2 1.5-1.2-1.5zM9.2 11.5h2.4v6.5l-1.2 1.5-1.2-1.5zM13.4 11.5h2.4v6.5l-1.2 1.5-1.2-1.5zM17.6 11.5H20v6.5l-1.2 1.5-1.2-1.5z"/>`) + `<path d="M2 21.5h20"/>`,
  seams: fo(T, `<path d="M2 4h7v16H2z"/>`) + fo(T, `<path d="M15 4h7v16h-7z"/>`) + `<path d="M9 8h6M9 12h6M9 16h6" stroke-dasharray="1.6 1.4"/>`,
  edgetoedge: fo(T, `<path d="M2 7h9.2v10H2z"/>`) + fo(T, `<path d="M12.8 7H22v10h-9.2z"/>`) + `<path d="M9 9.5l6 5M15 9.5l-6 5" stroke-width="1.3"/>`,
  turned: fo(T, `<path d="M3 6h11a6 6 0 010 12H3v-3h11a3 3 0 000-6H3z"/>`) + `<path d="M5 7.5h9M5 16.5h9" stroke-dasharray="1.6 1.4" stroke-width="1.2"/>`,
  construction: fo(T, `<path d="M3 14h18v5H3z"/>`) + `<path d="M12 4v10" stroke-dasharray="2 2"/>`,
  // Glue pot: a jar of cement with its brush standing in it.
  glue: fo(T, `<path d="M4.5 10.5h12v11h-12z"/>`) + `<path d="M3.5 10.5h14M4.5 14h12" ${THIN}/><path d="M12.5 10l7.5-7.5"/>` + fo(A, `<path d="M10 9.2l2.6-2.6 2.2 2.2-1.6 3.7z"/>`),
  stitches: `<path d="M2.5 16h19"/>` + fo(A, `<path d="M4 12.5l3.2-3 1.4 1.4-3.2 3zM10 12.5l3.2-3 1.4 1.4-3.2 3zM16 12.5l3.2-3 1.4 1.4-3.2 3z"/>`),
  // ---------- hardware ----------
  // Set hardware: a buckle on a strap end.
  hardware: fo(T, `<path d="M9 8.5h13v7H9z"/>`) + fo(A, `<path fill-rule="evenodd" d="M12.5 4H7.5a5 5 0 00-5 5v6a5 5 0 005 5h5zM9.8 6.8H7.6a2.3 2.3 0 00-2.3 2.3v5.8a2.3 2.3 0 002.3 2.3h2.2z"/>`) + `<path d="M4 12h11"/>` + dot(18.5, 12, 1.1),
  // A rivet, side on: cap, post and back.
  rivet: fo(A, `<path d="M4.5 10a7.5 4.5 0 0115 0z"/>`) + `<path d="M10.5 10v7.5h3V10"/>` + fo(A, `<path d="M6 17.5h12V20H6z"/>`),
  // Hardware metal: the same rivet cap in three finishes.
  metal: fo(L, `<path d="M1.5 15a3.5 3.5 0 017 0z"/>`) + fo(A, `<path d="M8.5 15a3.5 3.5 0 017 0z"/>`) + fo(T, `<path d="M15.5 15a3.5 3.5 0 017 0z"/>`) + `<path d="M1.5 18.5h21"/>`,
  // ---------- leather tools ----------
  // Round drive punch over the leather.
  punch: fo(T, `<path d="M9 2h6v9H9z"/>`) + `<path d="M9 11l1.5 4h3l1.5-4"/>` + fo(A, `<rect x="10.5" y="15" width="3" height="3"/>`) + `<path d="M2 20.5h7.5M14.5 20.5H22"/>`,
  // Swivel knife: yoke, knurled barrel and angled blade, cutting the leather.
  swivelknife: `<path d="M7 6.5c0-2.6 2.2-4 5-4s5 1.4 5 4"/>` + fo(T, `<rect x="10" y="4.5" width="4" height="11"/>`) + `<path d="M10 8h4M10 10.5h4M10 13h4" stroke-width="1.1"/>` + fo(A, `<path d="M10.5 15.5h3v2.5l-3 3.5z"/>`) + `<path d="M2.5 21.5h6.5M15 21.5h6.5"/>`,
  // Surface work: a stamp with a patterned face, struck onto the leather.
  stamp: shaft(2, 14.5) + fo(A, `<rect x="8" y="14.5" width="8" height="4"/>`) + `<path d="M2.5 21.5h19"/>`,
  // Beveler: a stamp with a sloped face, walked beside a cut.
  beveler: shaft(2, 14) + fo(A, `<path d="M9 14h6v4L9 21z"/>`) + `<path d="M2.5 21.5h5M12 21.5h9.5M16.5 21.5v-3"/>`,
  // Letter stamps: a stamp and the letter it struck.
  letterstamp: `<g transform="translate(4 0)">${shaft(2, 12)}</g>` + fo(A, `<rect x="13" y="12" width="7.5" height="3.5"/>`) + `<path d="M2.5 21.5l3.5-10 3.5 10M4 17.5h4"/>`,
  // Tooling (decorate): a mallet striking a stamp.
  tooling: fo(T, `<rect x="7" y="12.2" width="3" height="6.8"/>`) + fo(A, `<rect x="6" y="19" width="5" height="1.6"/>`) + `<path d="M2.5 21.5h19"/>` +
    `<g transform="rotate(-45 13 8.5)">${fo(T, `<rect x="11.8" y="11" width="2.4" height="8.5"/>`)}${fo(T, `<rect x="8" y="6" width="10" height="5"/>`)}${fo(L, `<rect x="8" y="6" width="1.8" height="5"/>`)}</g>`,
  // Rawhide mallet.
  mallet: fo(T, `<rect x="10.5" y="10" width="3" height="12"/>`) + fo(T, `<rect x="4" y="3" width="16" height="7"/>`) + fo(A, `<rect x="4" y="3" width="3" height="7"/>`) + fo(A, `<rect x="17" y="3" width="3" height="7"/>`),
  // Hand tools with wooden handles, turned like a pencil.
  awl: tilt(HANDLE + `<path class="s-a" d="M12 13.6V21"/>` + fo(A, `<path d="M10.9 21h2.2L12 24z"/>`)),
  creaser: tilt(HANDLE + `<path d="M12 13.6V19"/>` + fo(A, `<path d="M10 19h4v4.5h-1.3v-2.7h-1.4v2.7H10z"/>`)),
  skiving: tilt(fo(T, `<path d="M9.5 0h5v10h-5z"/>`) + fo(A, `<path d="M9.5 10h5v9l-5 4.5z"/>`)),
  edgebeveler: `<g transform="rotate(45 12 12) translate(0 -5)">${HANDLE}<path d="M12 13.6v4.5"/>${fo(A, `<path d="M10.4 18h3.2v2.2c0 1-.7 1.8-1.6 2.3-.9-.5-1.6-1.3-1.6-2.3z"/>`)}</g>` +
    fo(T, `<path d="M2 17h5l3 3v2H2z"/>`) + `<path class="s-a" d="M7 17l3 3"/>`,
  // Round (head) knife: a half-moon blade under a short handle.
  roundknife: fo(T, `<rect x="10.2" y="2" width="3.6" height="8"/>`) + `<path d="M12 10v3"/>` + fo(A, `<path d="M3 13.5c4 1.6 14 1.6 18 0 0 4.6-4 8-9 8s-9-3.4-9-8z"/>`),
  // Strap cutter: a wooden bar with a blade, cutting a strap from the side of a hide.
  strapcutter: fo(T, `<rect x="6" y="14" width="16" height="4"/>`) + fo(T, `<rect x="2" y="4" width="20" height="4"/>`) + `<path d="M9 4v1.8M12 4v1.8M15 4v1.8M18 4v1.8" ${THIN}/>` + fo(T, `<rect x="2" y="8" width="4" height="10"/>`) + fo(A, `<path d="M15.5 8h2.5v8l-1.25 2.5-1.25-2.5z"/>`) + `<path d="M2 21.5h20"/>`,
  // Wing divider: two legs, a hinge, and the wing with its locking screw.
  wingdivider: `<path d="M12 5L5.5 22M12 5l6.5 17"/><path d="M7.4 16c3-1.3 6.2-1.3 9.2 0"/>` + fo(A, `<circle cx="12" cy="4" r="2.5"/>`) + dot(15.6, 15.4, 1.1),
  // Rivet setter: a cupped rod over a rivet cap in the leather.
  rivetsetter: fo(T, `<path d="M10 2h4v13.5c-.6-.8-1.3-1.2-2-1.2s-1.4.4-2 1.2z"/>`) + fo(T, `<rect x="2.5" y="18.5" width="19" height="3.5"/>`) + fo(A, `<path d="M8.5 18.5a3.5 2.6 0 017 0z"/>`),
  // Snap setter: a rod over a snap cap, the leather on a dark anvil.
  snapsetter: fo(T, `<path d="M10 2h4v12.5c-.6-.8-1.3-1.2-2-1.2s-1.4.4-2 1.2z"/>`) + fo(A, `<path d="M7 17.5a5 3 0 0110 0z"/>`) + `<path d="M3 17.5h18"/>` + fo(L, `<rect x="5" y="19.5" width="14" height="2.5"/>`),
  // Edge slicker (burnisher): a turned wooden spindle with grooves.
  burnisher: tilt(fo(T, `<path d="M8.5 1h7v4l-1.5 1.5 1.5 1.5v3.5l-2 2 2 2v3L12 23l-3.5-4.5v-3l2-2-2-2V8l1.5-1.5L8.5 5z"/>`)),
  // ---------- tooling designs (what the finished leather looks like) ----------
  "design-border": fo(T, `<rect x="2.5" y="4" width="19" height="16"/>`) + `<rect x="5" y="6.5" width="14" height="11" ${THIN}/>` + `<rect class="s-a" x="7.5" y="9" width="9" height="6" stroke-dasharray="1.5 1.5"/>`,
  "design-basketweave": fo(T, `<rect x="3" y="3" width="18" height="18"/>`) + `<path d="M5 6h5M5 9h5M14 5v5M17 5v5M6 14v5M9 14v5M14 15h5M14 18h5" ${THIN}/><path d="M12 3v18M3 12h18"/>`,
  "design-floral": `<path d="M12 2.5c2.5 2 2.5 5.5 0 7.5-2.5-2-2.5-5.5 0-7.5zM21.5 12c-2 2.5-5.5 2.5-7.5 0 2-2.5 5.5-2.5 7.5 0zM12 21.5c-2.5-2-2.5-5.5 0-7.5 2.5 2 2.5 5.5 0 7.5zM2.5 12c2-2.5 5.5-2.5 7.5 0-2 2.5-5.5 2.5-7.5 0z"/><path d="M5.3 5.3c3 .3 5.2 2.5 5 5-2.5.2-4.7-2-5-5zM18.7 5.3c-.3 3-2.5 5.2-5 5-.2-2.5 2-4.7 5-5zM18.7 18.7c-3-.3-5.2-2.5-5-5 2.5-.2 4.7 2 5 5zM5.3 18.7c.3-3 2.5-5.2 5-5 .2 2.5-2 4.7-5 5z" ${THIN}/>` + fo(A, `<circle cx="12" cy="12" r="2"/>`),
  "design-corner": fo(T, `<path d="M2.5 21.5v-19h19v19z"/>`) + `<path class="s-a" d="M5.5 16.5c0-6 5-11 11-11"/><path d="M5.5 21.5V5.5h16" ${THIN}/>` + fo(A, `<path d="M8.5 6l2.5 2.5-2.5 2.5L6 8.5z"/>`),
  "design-checkerboard": `<rect x="3" y="3" width="18" height="18"/>` + fo(A, `<path d="M3 3h4.5v4.5H3zM12 3h4.5v4.5H12zM7.5 7.5H12V12H7.5zM16.5 7.5H21V12h-4.5zM3 12h4.5v4.5H3zM12 12h4.5v4.5H12zM7.5 16.5H12V21H7.5zM16.5 16.5H21V21h-4.5z"/>`),
  "design-diamond": fo(T, `<rect x="3" y="3" width="18" height="18"/>`) + `<path d="M3 9l6-6M3 15L15 3M3 21L21 3M9 21L21 9M15 21l6-6M3 3l18 18M3 9l12 12M9 3l12 12M3 15l6 6M15 3l6 6" ${THIN}/>` + fo(A, `<path d="M9 9l3-3 3 3-3 3z"/>`),
  "design-monogram": fo(T, `<path d="M5 3.5h14l2.5 2.5v12L19 20.5H5L2.5 18V6z"/>`) + `<path d="M5 17l3-10 3 10M6.1 13.5h3.8M14 7h3.2a2.5 2.5 0 010 5H14zM14 12h3.6a2.5 2.5 0 010 5H14z" class="s-a" stroke-width="1.8"/>`,
  // ---------- simulate ----------
  // Simulate: the 3D piece with a play mark.
  simulate: fo(T, `<path d="M10 2l7 3.9v7.8L10 17.6l-7-3.9V5.9z"/>`) + `<path d="M3 5.9l7 3.9 7-3.9M10 9.8v7.8"/>` + fo(A, `<path d="M14 12.5l8 5-8 5z"/>`),
  pause: fo(L, `<rect x="6" y="4" width="4" height="16"/>`) + fo(L, `<rect x="14" y="4" width="4" height="16"/>`),
  // See it in 3D: a solid cube.
  see3d: fo(T, `<path d="${CUBE}"/>`) + `<path d="${CUBE_LINES}"/>`,
  reset: `<path d="M4.5 13A7.5 7.5 0 1012 5.5H8"/>` + fo(L, `<path d="M9.5 1.5L5 5.5l4.5 4z"/>`) + fo(T, `<rect x="9.5" y="10.5" width="5" height="5"/>`),
  // Rebuild from pattern: a flat piece, an arrow, the 3D shape.
  rebuild: fo(T, `<rect x="2" y="13.5" width="9" height="8"/>`) + `<path d="M6.5 13.5V9a4 4 0 014-4H13"/>` + fo(L, `<path d="M12.5 2l3.5 3-3.5 3z"/>`) +
    fo(T, `<path d="M18 9.5l4 2.2v4.6L18 18.5l-4-2.2v-4.6z"/>`) + `<path d="M14 11.7l4 2.2 4-2.2M18 13.9v4.6"/>`,
  pull: fo(T, `<rect x="3" y="9" width="11" height="12"/>`) + `<path d="M14 9l6-6"/><path d="M15 3h5v5"/>`,
  // Pick it up: leather lifted by one point, clear of the floor.
  lift: fo(T, `<path d="M3 12.5l9-3 9 3-9 3z"/>`) + `<path d="M12 9.5V4"/>` + fo(L, `<path d="M12 1l-2.8 3.4h5.6z"/>`) + `<path d="M3 21.5h18"/><path d="M6.5 18.5h11" ${THIN} stroke-dasharray="1.5 1.5"/>`,
  // Put it down: leather settled flat on the floor.
  settle: `<path d="M12 2v6"/>` + fo(L, `<path d="M12 11.5L9.2 8h5.6z"/>`) + fo(T, `<path d="M3 17.5l9-3 9 3-9 3z"/>`) + `<path d="M1.5 21.5h21"/>`,
  pin: fo(A, `<path d="M8 2.5h8v2.2H8z"/>`) + fo(A, `<path d="M9.5 4.7h5l-.6 5.3 2.6 2.7h-9l2.6-2.7z"/>`) + `<path d="M12 12.7V22"/>`,
  weight: `<path d="M8.5 9.5V7a3.5 3.5 0 017 0v2.5"/>` + fo(T, `<circle cx="12" cy="15" r="6.5"/>`) + `<path d="M7.5 21.5h9"/>`,
  // Drop object: the things it can drop (a bottle, a phone).
  object: fo(T, `<path d="M5 2.5h3v3.5l1.8 2.2v13.3H3.2V8.2L5 6z"/>`) + `<path d="M3.2 12h6.6M3.2 17h6.6" ${THIN}/>` + fo(T, `<rect x="12.5" y="6.5" width="8.5" height="15" rx="1"/>`) + `<path d="M15 19h3.5" ${THIN}/>`,
  drop: fo(T, `<rect x="7" y="2.5" width="10" height="6.5"/>`) + `<path d="M12 11v7"/>` + fo(L, `<path d="M8.5 15.5h7L12 19.5z"/>`) + `<path d="M2.5 21.5h19"/>`,
  props: fo(T, `<path d="M2.5 8h19v3.5h-19z"/>`) + `<path d="M5 11.5V21M19 11.5V21"/>`,
  stress: `<rect class="${T}" x="3" y="4" width="6" height="16" style="fill-opacity:.1"/><rect class="${T}" x="9" y="4" width="6" height="16" style="fill-opacity:.32"/><rect class="${A}" x="15" y="4" width="6" height="16"/><rect x="3" y="4" width="18" height="16"/><path d="M9 4v16M15 4v16"/>`,
  foldangle: fo(T, `<path d="M2.5 19.5h10l6-12.5z"/>`) + `<path class="s-a" d="M7.5 19.5a5 5 0 012.4-4.3"/>`,
  // Leathers: a whole hide (the shape every leatherworker buys).
  fabric: fo(T, `<path d="${HIDE}"/>`),
  // Fabric test: a strip of leather draped over a rod.
  fabrictest: fo(T, `<path d="M3.5 21.5c0-8.5 4-13.5 8.5-13.5s8.5 5 8.5 13.5h-3c0-6-2.5-9.5-5.5-9.5s-5.5 3.5-5.5 9.5z"/>`) + fo(A, `<circle cx="12" cy="6" r="2.6"/>`),
  // How many can I make: pieces laid out on a hide.
  hidelayout: fo(T, `<path d="${HIDE}"/>`) + `<path class="s-a" d="M6.5 6.5h5v10h-5zM13.5 9h4.5v8.5h-4.5z" stroke-width="1.5"/>`,
  // ---------- view ----------
  fit: `<path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>` + fo(T, `<rect x="8" y="8" width="8" height="8"/>`),
  home: fo(T, `<path d="M4 11l8-7 8 7v9.5H4z"/>`) + `<path d="M10 20.5V15h4v5.5"/>`,
  orbit: `<ellipse cx="12" cy="12" rx="9.5" ry="4"/>` + fo(L, `<path d="M18 4.6l3.8 2.6-4.5 1.3z"/>`) + fo(T, `<circle cx="12" cy="12" r="2.6"/>`),
  pan: `<path d="M12 2v20M2 12h20"/>` + fo(L, `<path d="M12 1l-2.5 3h5zM12 23l-2.5-3h5zM1 12l3-2.5v5zM23 12l-3-2.5v5z"/>`) + fo(T, `<rect x="9" y="9" width="6" height="6"/>`),
  move: `<path d="M12 4v16M4 12h16"/>` + fo(L, `<path d="M12 1.5l-3 3.5h6zM12 22.5l-3-3.5h6zM1.5 12l3.5-3v6zM22.5 12l-3.5-3v6z"/>`),
  zoomin: fo(T, `<circle cx="10" cy="10" r="6.5"/>`) + `<path d="M15 15l6 6" stroke-width="2.4"/><path d="M7 10h6M10 7v6"/>`,
  zoomout: fo(T, `<circle cx="10" cy="10" r="6.5"/>`) + `<path d="M15 15l6 6" stroke-width="2.4"/><path d="M7 10h6"/>`,
  // Views: an open cube standing in its compass ring.
  views: `<path d="M12 2.5l6.5 3.6v7.3L12 17l-6.5-3.6V6.1z"/><path d="M5.5 6.1l6.5 3.6 6.5-3.6M12 9.7V17"/><path d="M5.5 14c-2 .8-3 1.8-3 2.8 0 2.4 4.3 4.2 9.5 4.2s9.5-1.8 9.5-4.2c0-1-1-2-3-2.8" ${THIN}/>`,
  viewfront: `<path d="${CUBE}"/><path d="${CUBE_LINES}"/>` + fo(A, `<path d="M4 7.5L12 12v9l-8-4.5z"/>`),
  viewside: `<path d="${CUBE}"/><path d="${CUBE_LINES}"/>` + fo(A, `<path d="M12 12l8-4.5v9L12 21z"/>`),
  viewtop: `<path d="${CUBE}"/><path d="${CUBE_LINES}"/>` + fo(A, `<path d="M4 7.5L12 3l8 4.5-8 4.5z"/>`),
  viewback: `<path d="${CUBE}" stroke-dasharray="2 1.6"/><path d="${CUBE_LINES}" stroke-dasharray="2 1.6"/>` + fo(T, `<path d="M4 7.5L12 12v9l-8-4.5z"/>`),
  layout3d: `<rect x="2" y="4" width="20" height="16"/>` + fo(T, `<path d="M12 7l5 2.5v5L12 17l-5-2.5v-5z"/>`) + `<path d="M7 9.5l5 2.5 5-2.5M12 12v5"/>`,
  layoutboth: `<rect x="2" y="4" width="20" height="16"/><path d="M12 4v16"/>` + fo(T, `<path d="M7 8.5l3 1.5v3.2l-3 1.6-3-1.6V10z"/>`) + fo(T, `<path d="M14.5 9h5v6h-5z"/>`),
  layoutpattern: `<rect x="2" y="4" width="20" height="16"/>` + fo(T, `<path d="M6 8h12v8H6z"/>`) + `<path d="M8 10h8v4H8z" stroke-dasharray="1.4 1.2" stroke-width="1.2"/>`,
  units: fo(T, `<rect x="2" y="7" width="20" height="10"/>`) + `<path d="M4 7v3.5M7 7v2M10 7v3.5M13 7v2M16 7v3.5M19 7v2M5 17v-3.5M12 17v-3.5M19 17v-3.5M8.5 17v-2M15.5 17v-2" ${THIN}/>`,
  // ---------- help and settings ----------
  help: fo(T, `<path d="M3 3.5h18v13h-9l-5 4.5v-4.5H3z"/>`) + `<path d="M9.5 8.3a2.5 2.5 0 114 2c-.9.6-1.5 1-1.5 2.2"/>` + dot(12, 14.6),
  // My steps: a checklist, the first steps done.
  steps: fo(A, `<rect x="2.5" y="3" width="5" height="5"/>`) + fo(A, `<rect x="2.5" y="10" width="5" height="5"/>`) + fo(T, `<rect x="2.5" y="17" width="5" height="5"/>`) + `<path d="M10.5 5.5H21M10.5 12.5H21M10.5 19.5H18"/>`,
  // What would you like to make: a pattern book open at two pictures.
  welcome: fo(T, `<path d="M2 5c3.5-1.3 6.5-1 10 1 3.5-2 6.5-2.3 10-1v15c-3.5-1.3-6.5-1-10 1-3.5-2-6.5-2.3-10-1z"/>`) + `<path d="M12 6v15"/><path d="M5 10.5h4v4.5H5zM15 9.5l2.5 1.5v3l-2.5 1.5" ${THIN}/>`,
  // All patterns in one list: rows of little pictures with their names.
  catalog: fo(T, `<rect x="2.5" y="2.5" width="6" height="5"/>`) + fo(T, `<rect x="2.5" y="9.5" width="6" height="5"/>`) + fo(T, `<rect x="2.5" y="16.5" width="6" height="5"/>`) + `<path d="M11 5h10.5M11 12h10.5M11 19h8"/>`,
  // Search commands: a list with a magnifier over it.
  search: `<path d="M2.5 4.5h12M2.5 8.5h7M2.5 12.5h4M2.5 16.5h4" ${THIN}/>` + fo(T, `<circle cx="14" cy="13" r="5.5"/>`) + `<path d="M18 17l4 4" stroke-width="2.6"/>`,
  keyboard: fo(T, `<rect x="2" y="6" width="20" height="12"/>`) + dot(6, 10) + dot(10, 10) + dot(14, 10) + dot(18, 10) + `<path d="M7 14.5h10"/>`,
  command: fo(T, `<rect x="2" y="4" width="20" height="16"/>`) + `<path d="M6 9l3 3-3 3M11 15h6"/>`,
  agent: fo(T, `<rect x="6" y="6" width="12" height="12"/>`) + `<path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>` + fo(A, `<rect x="10" y="10" width="4" height="4"/>`),
  settings: `<path d="M10.3 2.5h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9-2.6-.5v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8z"/>` + fo(A, `<circle cx="12" cy="12" r="3"/>`),
  textbigger: `<path d="M2.5 20l5.5-15 5.5 15M4.6 14.5h6.8"/><path d="M18.5 4v8M14.5 8h8"/>`,
  textsmaller: `<path d="M2.5 20l5.5-15 5.5 15M4.6 14.5h6.8"/><path d="M14.5 8h8"/>`,
  // Text size: a large and a small letter.
  textsize: `<path d="M1.5 20.5l5.5-16 5.5 16M3.6 15h6.8"/><path d="M13.5 20.5l4-10.5 4 10.5M15 16.5h5" ${THIN}/>`,
  theme: `<circle cx="12" cy="12" r="9"/>` + fo(L, `<path d="M12 3a9 9 0 010 18z"/>`),
  tools: fo(T, `<rect x="2.5" y="4" width="19" height="6"/>`) + `<path d="M5 14h3M10.5 14h3M16 14h3M5 18h3M10.5 18h3M16 18h3"/>`,
  // ---------- what to make (welcome and template categories) ----------
  wallet: fo(T, `<path d="M3 6h18v13H3z"/>`) + `<path d="M3 10h18"/><path d="M5 17h14" ${STITCH}/>`,
  // A card holder: leather body with two stepped card slots and a card standing in the top one.
  cardholder: fo(A, `<path d="M7 3.5h10v6H7z"/>`) + fo(T, `<path d="M3.5 7h17v13.5h-17z"/>`) + `<path d="M3.5 11h17M3.5 15h17"/><path d="M5.5 18.5h13" ${STITCH}/>`,
  // Change the size: a leather panel with dimension arrows along its right side and bottom.
  resize: fo(T, `<rect x="3" y="3" width="13" height="13"/>`) + `<path d="M20 3v13M3 20h13"/>` + fo(L, `<path d="M18.2 6l1.8-3 1.8 3zM18.2 13l1.8 3 1.8-3zM6 18.2l-3 1.8 3 1.8zM13 18.2l3 1.8-3 1.8z"/>`),
  book: fo(T, `<path d="M5 3h13v18H5z"/>`) + `<path d="M8 3v18" ${STITCH}/>`,
  case: fo(T, `<rect x="4" y="7" width="16" height="13"/>`) + `<path d="M9 7V4.5h6V7M4 12h16"/>`,
  smallgoods: fo(T, `<path d="M8 3h8v10l-4 4-4-4z"/>`) + `<circle cx="12" cy="7" r="1.6"/><path d="M12 17v4.5"/>`,
  // For the home: a valet tray, its corners folded up and snapped.
  homegoods: fo(T, `<rect x="2.5" y="4.5" width="19" height="15"/>`) + `<rect x="6" y="8" width="12" height="8"/><path d="M2.5 4.5L6 8M21.5 4.5L18 8M2.5 19.5L6 16M21.5 19.5L18 16" ${THIN}/>` + dot(4.5, 9.5, 1.1) + dot(19.5, 9.5, 1.1) + dot(4.5, 14.5, 1.1) + dot(19.5, 14.5, 1.1),
  // Other things: an assortment of shapes.
  assorted: fo(T, `<rect x="2.5" y="2.5" width="8.5" height="8.5"/>`) + fo(T, `<circle cx="17.2" cy="6.8" r="4.5"/>`) + fo(T, `<rect x="2.5" y="14.5" width="19" height="6" rx="3"/>`),
  // ---------- materials, kept for panels that may ask for them ----------
  gusset: fo(T, `<path d="M3 6h18v4H3z"/>`) + `<path d="M3 14h18v4H3z"/><path d="M6 10v4M18 10v4" stroke-dasharray="1.5 1.5"/>`,
  lining: `<rect x="3" y="3" width="18" height="18"/>` + fo(T, `<rect x="6" y="6" width="12" height="12"/>`),
  laminate: fo(T, `<path d="M3 8l9-4 9 4-9 4z"/>`) + `<path d="M3 12l9 4 9-4M3 16l9 4 9-4"/>`,
  bom: fo(T, `<rect x="4" y="3" width="16" height="18"/>`) + `<path d="M8 8h8M8 12h8M8 16h8"/>`,
};

/** Hardware metal swatches: a rivet drawn in its metal's colour. */
export const METAL_COLORS: Record<string, string> = {
  brass: "#b8923e",
  nickel: "#b9bcc1",
  gunmetal: "#5a5d63",
  copper: "#a8603a",
  black: "#26262a",
};
for (const [k, c] of Object.entries(METAL_COLORS)) {
  ICONS[`metal-${k}`] = `<path d="M4.5 10a7.5 4.5 0 0115 0z" style="fill:${c};stroke:none"/><path d="M6 17.5h12V20H6z" style="fill:${c};stroke:none"/><path d="M4.5 10a7.5 4.5 0 0115 0zM10.5 10v7.5h3V10M6 17.5h12V20H6z"/>`;
}

/** Older names that still draw: kept so a panel asking for one does not show the crossed square. */
const ALIASES: Record<string, string> = { thread: "sew", needle: "sew", stitchtype: "prickingiron", edge: "burnisher", hide: "hidelayout", oval: "ellipse", magnet: "snapobjects" };

const drawing = (name: string): string | undefined => ICONS[name] ?? ICONS[ALIASES[name] ?? ""];

export function hasIcon(name: string): boolean {
  return drawing(name) !== undefined;
}

/** Every icon name, for the contact sheet (aliases left out). */
export function iconNames(): string[] {
  return Object.keys(ICONS);
}

/** An inline SVG icon. Unknown names draw a crossed square so a typo shows up on screen. */
export function icon(name: string, size = 24): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" class="ico" aria-hidden="true">${drawing(name) ?? '<rect x="4" y="4" width="16" height="16"/><path d="M4 4l16 16"/>'}</svg>`;
  return wrap.firstChild as SVGSVGElement;
}
