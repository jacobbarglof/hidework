// A length box for the property panels, in the project's units (mm or inches). It is a text box,
// not a number box, so inches can be typed as fractions (3/8, 4 1/2), and 25mm or 1in work in
// either unit. Lengths are kept in millimetres.

import { h } from "./dom";
import { setStatus, state } from "./store";
import { parseLength, round, toDisp } from "./units";

export function lenBox(key: string, mm: number, commit: (mm: number) => void, min?: number): HTMLInputElement {
  const u = state.project.units;
  const shown = String(round(toDisp(mm, u), u));
  const i = h("input", { type: "text", inputMode: "decimal", autocomplete: "off", spellcheck: false, value: shown, "data-key": key });
  i.addEventListener("change", () => {
    const v = parseLength(i.value, u);
    if (v === null) {
      setStatus(`"${i.value}" is not a length. Type a number${u === "in" ? " such as 0.25 or 1/4" : ""}.`);
      i.value = shown;
      return;
    }
    commit(min !== undefined ? Math.max(min, v) : v);
  });
  return i;
}

/** "mm" or "in", for field labels. */
export const unitLabel = (): string => (state.project.units === "in" ? "in" : "mm");
