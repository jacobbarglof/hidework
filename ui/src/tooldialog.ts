// The floating command dialog, as in Fusion: a compact panel near the top right of the window a
// command works in, with its inputs, what it needs selected, and OK / Cancel.
//
// Two kinds:
// - Forms (Round corner, Add dart, Nudge, Align, Space evenly, Rotate, Rounded rectangle): picking
//   the command from the toolbar, a menu, the marking menu or the S box opens the dialog; OK runs
//   the command with the typed values, exactly as if they were typed on the command line.
//   Keyboard shortcuts and typed commands still run at once.
// - Tools (Punch, Fold, Sew, Hang a weight, Drop object): the dialog shows while the tool is on,
//   and its inputs change the tool's settings straight away. OK or Cancel puts the tool down.
// Full tools only; Simple mode keeps the property panel.

import { COMMANDS, runCommand, type Command } from "./commands";
import { selectedPieces } from "./editing";
import { button, h } from "./dom";
import { icon } from "./icons";
import { prefs } from "./prefs";
import { notify, piece, placing, state, subscribe } from "./store";
import { round, toDisp } from "./units";
import { OBJECT_PRESETS, sim3d } from "./view3d";

interface Input {
  key: string;
  label: string;
  kind: "len" | "num" | "select";
  /** Default: a length in mm ("len"), a plain number or an option value. */
  value: number | string;
  unit?: string;
  step?: number;
  min?: number;
  options?: [string, string][];
}

interface Spec {
  kind: "form" | "tool";
  win: "2d" | "3d";
  inputs?(): Input[];
  /** What must be selected, in words, and whether it is. */
  needs?(): { text: string; ok: boolean };
  /** Form: the typed arguments for OK, in input order unless given. */
  args?(v: Record<string, string>): string[];
  /** Tool: apply a changed input right away. */
  live?(key: string, value: string): void;
  /** Tool: how to put it down. */
  done?: string;
}

const PUNCH_SIZES = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 8, 10];

const units = () => state.project.units;
const pieceName = (id: string) => piece(id)?.name ?? "piece";

function needVertex(): { text: string; ok: boolean } {
  const s = state.sel;
  return s.kind === "vertex" ? { text: `Corner ${s.index + 1} of ${pieceName(s.piece)}`, ok: true } : { text: "Click a corner point in the pattern", ok: false };
}

function needEdge(): { text: string; ok: boolean } {
  const s = state.sel;
  return s.kind === "edge" ? { text: `Edge ${s.index + 1} of ${pieceName(s.piece)}`, ok: true } : { text: "Click a straight edge in the pattern", ok: false };
}

function needPieces(n: number): () => { text: string; ok: boolean } {
  return () => {
    const k = selectedPieces().length;
    if (k >= n) return { text: k === 1 ? `${pieceName(selectedPieces()[0])} selected` : `${k} pieces selected`, ok: true };
    return { text: n === 1 ? "Click a piece in the pattern" : `Select ${n} or more pieces (Shift+click)`, ok: false };
  };
}

const SPECS: Record<string, Spec> = {
  round: { kind: "form", win: "2d", needs: needVertex, inputs: () => [{ key: "r", label: "Radius", kind: "len", value: 8 }] },
  dart: { kind: "form", win: "2d", needs: needEdge, inputs: () => [{ key: "w", label: "Width", kind: "len", value: 20 }, { key: "d", label: "Depth", kind: "len", value: 40 }] },
  nudge: { kind: "form", win: "2d", needs: needPieces(1), inputs: () => [{ key: "x", label: "Across", kind: "len", value: 10 }, { key: "y", label: "Down", kind: "len", value: 0 }] },
  rotate: { kind: "form", win: "2d", needs: needPieces(1), inputs: () => [{ key: "dir", label: "Turn", kind: "select", value: "cw", options: [["cw", "Clockwise 90°"], ["ccw", "Anticlockwise 90°"]] }] },
  align: { kind: "form", win: "2d", needs: needPieces(2), inputs: () => [{ key: "to", label: "Line up", kind: "select", value: "left", options: [["left", "Left edges"], ["centre", "Centres across"], ["right", "Right edges"], ["top", "Top edges"], ["middle", "Middles down"], ["bottom", "Bottom edges"]] }] },
  distribute: { kind: "form", win: "2d", needs: needPieces(3), inputs: () => [{ key: "dir", label: "Space", kind: "select", value: "x", options: [["x", "Across"], ["y", "Down"]] }] },
  roundrect: { kind: "form", win: "2d", inputs: () => [{ key: "w", label: "Width", kind: "len", value: 80 }, { key: "h", label: "Height", kind: "len", value: 50 }, { key: "r", label: "Corners", kind: "len", value: 6 }] },
  punch: {
    kind: "tool", win: "2d", done: "select",
    needs: () => ({ text: "Click inside a piece to punch", ok: true }),
    inputs: () => [{ key: "d", label: "Diameter", kind: "select", value: String(placing.hardware?.diameterMm ?? 3), options: PUNCH_SIZES.map((d) => [String(d), `${d} mm`] as [string, string]) }],
    live: (_k, v) => { const d = parseFloat(v); placing.hardware = { label: `Punch ${d} mm`, diameterMm: d, lengthMm: 0 }; },
  },
  fold: {
    kind: "tool", win: "2d", done: "select",
    needs: () => ({ text: "Click a piece where it folds", ok: true }),
    inputs: () => [{ key: "o", label: "Direction", kind: "select", value: state.foldOrientation, options: [["horizontal", "Across"], ["vertical", "Down"]] }],
    live: (_k, v) => { state.foldOrientation = v as typeof state.foldOrientation; notify(); },
  },
  sew: {
    kind: "tool", win: "2d", done: "select",
    needs: () => (state.joinPending ? { text: `First edge: ${pieceName(state.joinPending.piece)} edge ${state.joinPending.edge + 1}. Now click the edge it sews to`, ok: false } : { text: "Click the first edge", ok: false }),
  },
  weight: {
    kind: "tool", win: "3d", done: "orbit",
    needs: () => ({ text: "Click the leather to hang it", ok: true }),
    inputs: () => [{ key: "g", label: "Weight", kind: "num", value: sim3d.weightGrams, unit: "g", step: 50, min: 1 }],
    live: (_k, v) => { sim3d.weightGrams = Math.max(1, parseFloat(v) || 100); },
  },
  object: {
    kind: "tool", win: "3d", done: "orbit",
    needs: () => ({ text: "Click in the 3D window to drop it", ok: true }),
    inputs: () => [{ key: "o", label: "Object", kind: "select", value: sim3d.objectPreset, options: Object.entries(OBJECT_PRESETS).map(([k, p]) => [k, p.name] as [string, string]) }],
    live: (_k, v) => { sim3d.objectPreset = v; },
  },
};

/** Values typed last time, per command, so a dialog opens with them. */
const memo = new Map<string, Record<string, string>>();

let shown: { cmd: Command; spec: Spec; el: HTMLElement; refresh(): void } | null = null;

const byId = () => new Map(COMMANDS.map((c) => [c.id, c]));

/** Run a command picked in the chrome: forms open their dialog (full tools), others run. */
export function invoke(c: Command): void {
  const spec = SPECS[c.id];
  if (spec?.kind === "form" && prefs.mode === "full") open(c, spec);
  else runCommand(c);
}

export function closeDialog(): void {
  shown?.el.remove();
  shown = null;
}

function startValue(c: Command, i: Input): string {
  const saved = memo.get(c.id)?.[i.key];
  if (saved !== undefined) return saved;
  if (i.kind === "len") return String(round(toDisp(i.value as number, units()), units()));
  return String(i.value);
}

function open(c: Command, spec: Spec): void {
  closeDialog();
  const values: Record<string, string> = {};
  const rows: Node[] = [];
  for (const i of spec.inputs?.() ?? []) {
    values[i.key] = startValue(c, i);
    let ctl: HTMLInputElement | HTMLSelectElement;
    if (i.kind === "select") {
      const s = h("select", { class: "td-input", "data-key": `td-${i.key}` });
      for (const [v, t] of i.options ?? []) s.append(h("option", { value: v, selected: v === values[i.key] }, t));
      ctl = s;
    } else {
      ctl = h("input", { class: "td-input", type: "number", value: values[i.key], step: String(i.step ?? (i.kind === "len" && units() === "in" ? 0.0625 : 0.5)), min: i.min !== undefined ? String(i.min) : undefined, "data-key": `td-${i.key}` }) as HTMLInputElement;
    }
    const commit = () => {
      values[i.key] = ctl.value;
      memo.set(c.id, { ...(memo.get(c.id) ?? {}), [i.key]: ctl.value });
      if (spec.kind === "tool") spec.live?.(i.key, ctl.value);
    };
    ctl.addEventListener("change", commit);
    ctl.addEventListener("input", () => { if (ctl.tagName === "INPUT") values[i.key] = ctl.value; });
    ctl.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "Enter") {
        commit();
        ok();
        e.preventDefault();
      } else if (k === "Escape") {
        cancel();
        e.preventDefault();
      }
      e.stopPropagation();
    });
    const unit = i.kind === "len" ? units() : i.unit ?? "";
    rows.push(h("label", { class: "td-row" }, h("span", { class: "td-label" }, i.label), ctl, h("span", { class: "td-unit" }, unit)));
  }
  const need = h("div", { class: "td-need" });
  const okBtn = button(spec.kind === "tool" ? "Done" : "OK", () => ok(), "primary td-ok");
  const cancel = () => {
    closeDialog();
    if (spec.kind === "tool") runCommand(byId().get(spec.done ?? "select")!);
  };
  const ok = () => {
    if (spec.kind === "tool") return cancel();
    if (spec.needs && !spec.needs().ok) return;
    const args = spec.args ? spec.args(values) : (spec.inputs?.() ?? []).map((i) => values[i.key]);
    closeDialog();
    runCommand(c, args);
  };
  const close = h("button", { type: "button", class: "td-x", title: "Cancel (Esc)" }, "✕");
  close.addEventListener("click", cancel);
  const el = h(
    "div",
    { class: `tooldlg ${spec.kind}`, role: "dialog", "aria-label": c.name },
    h("div", { class: "td-head" }, icon(c.icon, 16), h("strong", {}, c.name), h("span", { class: "spacer" }), close),
    spec.needs ? h("div", { class: "td-sel" }, h("span", { class: "td-label" }, "Selection"), need) : null,
    ...rows,
    h("div", { class: "td-foot" }, h("span", { class: "td-help" }, c.help), spec.kind === "form" ? button("Cancel", cancel, "quiet") : null, okBtn),
  );
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  const refresh = () => {
    const n = spec.needs?.();
    if (n) {
      need.textContent = n.text;
      need.classList.toggle("ok", n.ok);
      if (spec.kind === "form") okBtn.disabled = !n.ok;
    }
  };
  refresh();
  const host = document.querySelector(spec.win === "3d" ? ".w3d" : ".w2d");
  (host ?? document.body).append(el);
  shown = { cmd: c, spec, el, refresh };
  // Forms take the keyboard; tool dialogs leave it with the window.
  if (spec.kind === "form") (el.querySelector(".td-input") as HTMLElement | null)?.focus();
}

/** Show the dialog of the tool that is on, or hide it. */
function sync(): void {
  if (prefs.mode !== "full") {
    if (shown) closeDialog();
    return;
  }
  if (shown?.spec.kind === "form") return shown.refresh();
  const cmds = byId();
  let on: Command | null = null;
  for (const [id, spec] of Object.entries(SPECS)) {
    if (spec.kind !== "tool") continue;
    const c = cmds.get(id);
    if (c?.active?.()) {
      on = c;
      break;
    }
  }
  if (!on) {
    if (shown) closeDialog();
    return;
  }
  if (shown?.cmd !== on) open(on, SPECS[on.id]);
  else shown.refresh();
}

export function initToolDialog(): void {
  subscribe(sync);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && shown?.spec.kind === "form" && !document.querySelector(".menu, .mk-overlay, .searchbox")) {
        closeDialog();
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
}
