import type { Units } from "./types";

export const MM_PER_IN = 25.4;
/** One leather ounce of thickness is 1/64 inch. */
export const OZ_MM = 25.4 / 64;

export function toDisp(mm: number, u: Units): number {
  return u === "in" ? mm / MM_PER_IN : mm;
}

export function fromDisp(v: number, u: Units): number {
  return u === "in" ? v * MM_PER_IN : v;
}

export function round(v: number, u: Units): number {
  const f = u === "in" ? 1000 : 100;
  return Math.round(v * f) / f;
}

export function fmtLen(mm: number, u: Units): string {
  return u === "in" ? `${(mm / MM_PER_IN).toFixed(3)} in` : `${mm.toFixed(1)} mm`;
}

export function fmtThickness(mm: number): string {
  const oz = mm / OZ_MM;
  const ozTxt = Math.abs(oz - Math.round(oz)) < 0.05 ? Math.round(oz).toString() : oz.toFixed(1);
  return `${mm.toFixed(2)} mm (${ozTxt} oz)`;
}

/** Grid snap step: half a millimetre, or 1/32 inch. */
export function snapStep(u: Units): number {
  return u === "in" ? MM_PER_IN / 32 : 0.5;
}

/**
 * Plain numbers typed while this is set are read in these units instead of the project's
 * (the MCP run_command tool works in millimetres whatever the project shows).
 */
export const typing = { force: null as Units | null };

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: MM_PER_IN, inch: MM_PER_IN, inches: MM_PER_IN, '"': MM_PER_IN, ft: 304.8, feet: 304.8, "'": 304.8 };

/**
 * A length typed by a person, in mm: "120", "4.5", "3/8", "3 1/2", "3-1/2", with an optional
 * unit (mm, cm, m, in, ", ft, '). Plain numbers are in `u` (the project's units). Null when it is
 * not a length.
 */
export function parseLength(s: string | undefined, u: Units): number | null {
  if (!s) return null;
  const m = /^(-?)\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:(?:\s+|-)(\d+)\/(\d+))?|(\d+)\/(\d+))\s*(mm|cm|m|inches|inch|in|"|ft|feet|')?$/i.exec(s.trim());
  if (!m) return null;
  let v = m[2] !== undefined ? parseFloat(m[2]) + (m[3] !== undefined ? Number(m[3]) / Number(m[4]) : 0) : Number(m[5]) / Number(m[6]);
  if (!Number.isFinite(v)) return null;
  if (m[1]) v = -v;
  const unit = (m[7] ?? "").toLowerCase();
  if (unit) return v * UNIT_MM[unit];
  return fromDisp(v, typing.force ?? u);
}

/**
 * Split typed sizes ("120 80", "3 1/2 x 2", "80,50") into one string per size, keeping a whole
 * number and the fraction after it ("3 1/2") together.
 */
export function splitLengths(s: string): string[] {
  return s
    .trim()
    .replace(/(\d)\s+(\d+\/\d+)/g, "$1-$2")
    .split(/\s*[\s,x*×]\s*/i)
    .filter(Boolean);
}

/** The unit word for the screen: "mm" or "in". */
export function unitWord(u: Units): string {
  return u === "in" ? "in" : "mm";
}
