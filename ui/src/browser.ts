// Object browser (right dock, upper half) and Library (left dock), laid out like CLO3D's.

import { api } from "./api";
import { h, rerender } from "./dom";
import { drape, loadPresets } from "./drape";
import { addStrap, panel, reports, seamName, select } from "./panels";
import { rectPiece, roundedRectPiece } from "./ops";
import { viewCenter } from "./canvas";
import { edit, notify, placing, selectedPieceId, setProject, setStatus, state, uid, type Tool } from "./store";
import { colorFor } from "./textures";
import { OZ_MM } from "./units";
import { OBJECT_PRESETS, bounds, dropObject, removeSceneItem, setProps, sim3d } from "./view3d";
import type { Prop } from "./simtypes";

type BrowserTab = "pieces" | "fabrics" | "seams" | "scene";
type LibraryTab = "templates" | "fabrics" | "hardware" | "objects" | "props";
const ui = { browser: "pieces" as BrowserTab, library: "templates" as LibraryTab };


function tabs<T extends string>(items: [T, string][], current: T, set: (t: T) => void): HTMLElement {
  return h("div", { class: "tabs" }, ...items.map(([k, label]) => h("button", { type: "button", class: k === current ? "active" : "", onclick: () => { set(k); notify(); } }, label)));
}

// ---------- object browser ----------

export function renderBrowser(el: HTMLElement): void {
  rerender(el, () => [
    tabs<BrowserTab>([["pieces", "Pieces"], ["fabrics", "Fabrics"], ["seams", "Seams"], ["scene", "Scene"]], ui.browser, (t) => (ui.browser = t)),
    h("div", { class: "tab-body" }, ...browserBody()),
  ]);
}

function browserBody(): Node[] {
  const p = state.project;
  if (ui.browser === "pieces") {
    const list = h("ul", { class: "list" });
    for (const pc of p.pieces) {
      const m = p.materials.find((x) => x.id === pc.materialId);
      list.append(
        h(
          "li",
          { class: selectedPieceId() === pc.id ? "selected" : "", onclick: select({ kind: "piece", piece: pc.id }) },
          h("span", { class: "swatch", style: `background:${m?.color ?? colorFor(m?.kind ?? "leather", m?.name ?? "")}` }),
          h("span", { class: "name" }, pc.name),
          h("span", { class: "meta" }, `×${pc.cutCount}`),
        ),
      );
    }
    if (!p.pieces.length) list.append(h("li", { class: "empty" }, "No pieces. Draw one in the 2D window."));
    return [list];
  }
  if (ui.browser === "fabrics") {
    const list = h("ul", { class: "list" });
    for (const m of p.materials) {
      const stats = reports.stats.find((s) => s.id === m.id);
      list.append(
        h(
          "li",
          { class: state.sel.kind === "material" && state.sel.id === m.id ? "selected" : "", onclick: select({ kind: "material", id: m.id }) },
          h("span", { class: "swatch", style: `background:${m.color ?? colorFor(m.kind, m.name)}` }),
          h("span", { class: "name" }, m.name),
          h("span", { class: "meta" }, `${(m.thicknessMm / OZ_MM).toFixed(1)} oz${stats ? ` · c ${stats.bendingLengthMm.toFixed(0)}` : ""}`),
        ),
      );
    }
    return [list, h("p", { class: "hint" }, "Add fabrics from the library. Select one to edit its physical properties or run a fabric test.")];
  }
  if (ui.browser === "seams") {
    const out: Node[] = [];
    for (const j of p.joins) {
      const rep = state.computed?.joins.find((r) => r.id === j.id);
      out.push(h("div", { class: `seam ${rep?.ok ? "ok" : "bad"}`, onclick: select({ kind: "join", id: j.id }) }, h("strong", {}, `${seamName(j.a)} ↔ ${seamName(j.b)}`), h("span", {}, rep?.message ?? "…")));
    }
    if (!p.joins.length) out.push(h("p", { class: "hint" }, "Segment sewing (S): click an edge, then the edge it sews to."));
    return out;
  }
  // Scene: what is in the 3D window besides the pattern.
  const st = sim3d.status;
  const list = h("ul", { class: "list" });
  const row = (label: string, meta: string, id: string) =>
    h("li", {}, h("span", { class: "name" }, label), h("span", { class: "meta" }, meta), h("button", { class: "btn icon quiet", type: "button", title: "Remove", onclick: () => void removeSceneItem(id) }, "✕"));
  for (const o of st?.objects ?? []) list.append(row(o.name, `${o.grams} g`, o.id));
  for (const [id, g] of st?.weights ?? []) list.append(row("Weight", `${g} g`, id));
  for (const [id] of st?.pins ?? []) list.append(row("Pin", "", id));
  for (const pr of sim3d.props) list.append(h("li", {}, h("span", { class: "name" }, pr.type === "box" ? "Table" : pr.type === "pedestal" ? "Pedestal" : "Hook bar"), h("span", { class: "meta" }, "prop")));
  if (!list.children.length) list.append(h("li", { class: "empty" }, "Empty. Add objects or props from the library, or pin and weight in 3D."));
  return [list, sim3d.props.length ? h("div", { class: "btn-row" }, h("button", { class: "btn quiet", type: "button", onclick: () => void setProps([], 0) }, "Clear props")) : null].filter(Boolean) as Node[];
}

// ---------- library ----------

export function renderLibrary(el: HTMLElement): void {
  rerender(el, () => [
    tabs<LibraryTab>([["templates", "Patterns"], ["fabrics", "Fabrics"], ["hardware", "Hardware"], ["objects", "Objects"], ["props", "Props"]], ui.library, (t) => (ui.library = t)),
    h("div", { class: "tab-body" }, ...libraryBody()),
  ]);
}

let templateCache: { id: string; name: string; description: string }[] = [];

function item(title: string, desc: string, onclick: () => void, extra?: { active?: boolean; color?: string }): HTMLElement {
  return h(
    "button",
    { class: `lib-item${extra?.active ? " active" : ""}`, type: "button", onclick },
    extra?.color ? h("div", { class: "swatch", style: `background:${extra.color}` }) : null,
    h("strong", {}, title),
    h("span", {}, desc),
  );
}

function libraryBody(): Node[] {
  if (ui.library === "templates") {
    if (!templateCache.length) void api.templates().then((t) => { templateCache = t; notify(); });
    const at = () => {
      const c = viewCenter();
      return { x: Math.round(c.x - 40), y: Math.round(c.y - 25) };
    };
    const add = (pc: ReturnType<typeof rectPiece>) => {
      edit((p) => p.pieces.push(pc));
      state.sel = { kind: "piece", piece: pc.id };
      notify();
    };
    return [
      h("div", { class: "section-head" }, h("h2", {}, "Starter projects")),
      h("div", { class: "lib-grid" }, ...templateCache.map((t) => item(t.name, t.description, async () => {
        if (state.dirty && !confirm("Discard unsaved changes?")) return;
        setProject(await api.fromTemplate(t.id), null);
      }))),
      h("div", { class: "section-head" }, h("h2", {}, "Add a piece")),
      h(
        "div",
        { class: "lib-grid" },
        item("Rectangle", "80 × 50 mm panel", () => add(rectPiece(at(), 80, 50, "Panel"))),
        item("Rounded", "Panel with 6 mm corners", () => add(roundedRectPiece(at(), 80, 50, 6, "Panel"))),
        item("Strap or belt", "Tip, holes, buckle end", () => { panel.special = "strap"; notify(); }),
        item("Quick strap", "600 × 25 mm, round tip", async () => { const id = await addStrap({ name: "Strap", lengthMm: 600, widthMm: 25, holes: 0, buckleEnd: false }); state.sel = { kind: "piece", piece: id }; notify(); }),
      ),
    ];
  }
  if (ui.library === "fabrics") {
    if (!drape.presets.length) void loadPresets().then(notify);
    const target = selectedPieceId();
    return [
      h("p", { class: "hint" }, target ? "Click a fabric to apply it to the selected piece." : "Click a fabric to add it to the project."),
      h(
        "div",
        { class: "lib-grid" },
        ...drape.presets.map((p) =>
          item(p.name, `${p.typicalOz} · ${p.note}`, () => {
            let id = state.project.materials.find((m) => m.name === p.name)?.id;
            edit((proj) => {
              if (!id) {
                id = uid("m");
                proj.materials.push({ id, name: p.name, kind: p.kind, thicknessMm: p.thicknessMm, physics: { ...p.physics }, costPerSqft: null, color: null });
              }
              const pc = target ? proj.pieces.find((x) => x.id === target) : undefined;
              if (pc) pc.materialId = id;
            });
            setStatus(`${p.name}${target ? " applied" : " added"}. Physics are starting estimates; calibrate in the fabric's properties.`);
          }, { color: colorFor(p.kind, p.name) }),
        ),
      ),
    ];
  }
  if (ui.library === "hardware") {
    const hw: [string, string, number, number][] = [
      ["Rivet", "Double-cap rivet hole", 3, 0],
      ["Snap", "Line 24 style snap hole", 4, 0],
      ["Chicago screw", "Screw post hole", 4.5, 0],
      ["Sam Browne stud", "Stud hole", 4, 0],
      ["Strap slot", "Slot for a 20 mm strap", 4, 22],
      ["Buckle tongue", "Tongue slot", 4, 20],
      ["Punch 2 mm", "Plain round hole", 2, 0],
      ["Punch 3 mm", "Plain round hole", 3, 0],
    ];
    return [
      h("p", { class: "hint" }, "Pick hardware, then click the pattern in the 2D window to place it. Check sizes against your own hardware."),
      h(
        "div",
        { class: "lib-grid" },
        ...hw.map(([label, desc, d, l]) =>
          item(label, `${desc} · ${d} mm${l ? ` × ${l}` : ""}`, () => {
            placing.hardware = { label, diameterMm: d, lengthMm: l };
            setTool2d("hole");
            setStatus(`Click a piece to place: ${label}.`);
          }, { active: placing.hardware?.label === label && state.tool === "hole" }),
        ),
      ),
    ];
  }
  if (ui.library === "objects") {
    return [
      h("p", { class: "hint" }, "Choose an object, then click in the 3D window to drop it there (or press Drop to drop it in the middle)."),
      h(
        "div",
        { class: "lib-grid" },
        ...Object.entries(OBJECT_PRESETS).map(([k, o]) =>
          item(o.name, `${o.grams} g`, () => {
            sim3d.objectPreset = k;
            sim3d.tool = "object";
            notify();
          }, { active: sim3d.tool === "object" && sim3d.objectPreset === k, color: o.color }),
        ),
      ),
      h("div", { class: "btn-row" }, h("button", { class: "btn primary", type: "button", onclick: () => void dropObject(sim3d.objectPreset, null) }, "Drop in the middle")),
    ];
  }
  // Props: scenery in the 3D window.
  const box = bounds();
  const props: [string, string, () => void][] = [
    ["Floor only", "Lie flat on the floor", () => void setProps([], 0)],
    ["Table edge", "Half on a table, half hanging off", () => {
      if (!box) return;
      const top = 300;
      const mid = (box.min.x + box.max.x) / 2;
      const p: Prop = { type: "box", min: [box.min.x - 300, box.min.y - 200, 0], max: [mid, box.max.y + 200, top] };
      void setProps([p], top + 1);
    }],
    ["Pedestal", "Centred on a round stand", () => {
      if (!box) return;
      const top = 250;
      const r = Math.min(box.max.x - box.min.x, box.max.y - box.min.y) * 0.3;
      void setProps([{ type: "pedestal", center: [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2], radius: Math.max(15, r), top }], top + 1);
    }],
    ["Hook bar", "A bar to hang straps over", () => {
      if (!box) return;
      const z = 400;
      const cx = (box.min.x + box.max.x) / 2;
      const cy = (box.min.y + box.max.y) / 2;
      // Across the longer side, through the middle, so the piece drapes over it.
      const along = box.max.x - box.min.x >= box.max.y - box.min.y;
      const bar: Prop = along ? { type: "bar", a: [cx, box.min.y - 100, z], b: [cx, box.max.y + 100, z], radius: 8 } : { type: "bar", a: [box.min.x - 100, cy, z], b: [box.max.x + 100, cy, z], radius: 8 };
      void setProps([bar], z + 15);
    }],
  ];
  return [
    h("p", { class: "hint" }, "Props stay put; the piece rests on them. Changing props restarts the simulation."),
    h("div", { class: "lib-grid" }, ...props.map(([t, d, f]) => item(t, d, f))),
  ];
}

// The 2D tool setter lives in main; registered here to avoid a cycle.
let toolSetter: (t: Tool) => void = () => {};
export function registerToolSetter(f: (t: Tool) => void): void {
  toolSetter = f;
}
function setTool2d(t: Tool): void {
  toolSetter(t);
}
