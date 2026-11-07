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
