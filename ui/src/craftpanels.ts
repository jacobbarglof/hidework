// Property-editor sections for the leatherworker's choices: stitch and lacing, seam construction
// and glue, edge finishes, hardware, surface work (stamps, tooling, perforation), where a piece
// sits in 3D, and the bag builder.

import { api } from "./api";
import { button, check, choose, field, h, num, text } from "./dom";
import { edit, notify, piece, placing, setProject, setStatus, state } from "./store";
import { DESIGNS, strokeControls, toolName } from "./tooling";
import { fmtLen } from "./units";
import { lenBox, unitLabel } from "./lenbox";
import type { Adhesive, BagParams, BagStyle, Bom, Catalogue, Construction, EdgeFinish, Face, Join, MarkKind, Piece, StitchKind } from "./types";

export const craft = { catalogue: null as Catalogue | null, loading: false };

export function loadCatalogue(): Catalogue | null {
  if (!craft.catalogue && !craft.loading) {
    craft.loading = true;
    void api.catalogue().then((c) => {
      craft.catalogue = c;
      craft.loading = false;
      notify();
    });
  }
  return craft.catalogue;
}

const head = (title: string) => h("div", { class: "section-head" }, h("h2", {}, title));

export const FACES: [Face, string][] = [
  ["flat", "Flat (template layout)"],
  ["front", "Front"],
  ["back", "Back"],
  ["left", "Left side"],
  ["right", "Right side"],
  ["bottom", "Bottom"],
  ["top", "Top"],
  ["wrapSides", "Gusset: sides and bottom"],
  ["wrapAround", "Wrap all round"],
  ["backFlap", "Back, over the top, flap"],
  ["handleFront", "Handle on the front"],
  ["handleBack", "Handle on the back"],
  ["strapSides", "Shoulder strap"],
];

export const MARKS: [MarkKind, string][] = [
  ["stamp", "Stamp"],
  ["tooling", "Tooling"],
  ["emboss", "Emboss"],
  ["engrave", "Engrave"],
  ["paint", "Paint / dye"],
  ["text", "Lettering"],
  ["perforate", "Perforation"],
];

export const TOOLING: [string, string][] = [
  ["floral", "Floral (Sheridan)"],
  ["geometric", "Geometric"],
  ["basketweave", "Basketweave"],
  ["border", "Border line"],
  ["pebble", "Pebble / background"],
];

// ---------- stitching (piece) ----------

export function stitchSection(pc: Piece): Node[] {
  const cat = loadCatalogue();
  const kind = pc.stitch.kind ?? "saddle";
  const info = cat?.stitches.find((s) => s.kind === kind);
  const kinds = (cat?.stitches ?? []).map((s) => [s.kind, `${s.name}`] as [StitchKind, string]);
  return [
    h(
      "div",
      { class: "grid3" },
      field("Stitch", kinds.length ? choose("st-kind", kinds, kind, (v) => edit(() => {
        const next = cat?.stitches.find((s) => s.kind === v);
        pc.stitch.kind = v;
        // Lacing uses wider spacing and slits as wide as the lace.
        if (next?.lace && !info?.lace) {
          pc.stitch.pitchMm = next.defaultPitchMm;
          pc.stitch.holeMm = 3;
          pc.stitch.marginMm = Math.max(pc.stitch.marginMm, 4);
        } else if (!next?.lace && info?.lace) {
          pc.stitch.pitchMm = next?.defaultPitchMm ?? 3.85;
          pc.stitch.holeMm = 1;
        }
      })) : h("span", {}, "…")),
      field("Rows", num("st-rows", pc.stitch.rows ?? 1, (v) => edit(() => (pc.stitch.rows = Math.max(1, Math.min(4, Math.round(v))))), { step: 1, min: 1, max: 4 })),
      field(`Row gap, ${unitLabel()}`, lenBox("st-gap", pc.stitch.rowGapMm || 4, (v) => edit(() => (pc.stitch.rowGapMm = Math.max(1, v))), 1)),
    ),
    info ? h("p", { class: "hint" }, `${info.description} About ${info.threadFactor}× the seam length in ${info.lace ? "lace" : "thread"}.`) : null,
  ].filter(Boolean) as Node[];
}

// ---------- arrangement (piece) ----------

export function arrangeSection(pc: Piece): Node[] {
  const pl = pc.place ?? { face: "flat" as Face };
  const set = (fn: (p: NonNullable<Piece["place"]>) => void) =>
    edit(() => {
      const next = { face: "flat" as Face, ...(pc.place ?? {}) };
      fn(next);
      pc.place = next;
    });
  const out: Node[] = [
    head("3D arrangement"),
    field("Place on", choose("pl-face", FACES, pl.face, (v) => set((p) => (p.face = v)))),
  ];
  if (pl.face !== "flat") {
    const handle = pl.face === "handleFront" || pl.face === "handleBack" || pl.face === "strapSides";
    out.push(
      h(
        "div",
        { class: "grid3" },
        field("Shift across", num("pl-ox", pl.offset?.x ?? 0, (v) => set((p) => (p.offset = { x: v, y: p.offset?.y ?? 0 })), { step: 5 })),
        field("Shift down", num("pl-oy", pl.offset?.y ?? 0, (v) => set((p) => (p.offset = { x: p.offset?.x ?? 0, y: v })), { step: 5 })),
        field("Out from form", num("pl-layer", pl.layerMm ?? 0, (v) => set((p) => (p.layerMm = v)), { step: 0.5 })),
        handle ? field("Span", num("pl-span", pl.spanMm ?? 0, (v) => set((p) => (p.spanMm = Math.max(0, v))), { step: 5, min: 0 })) : null,
        handle ? field("End tab", num("pl-tab", pl.tabMm ?? 0, (v) => set((p) => (p.tabMm = Math.max(0, v))), { step: 5, min: 0 })) : null,
      ),
      h("p", { class: "hint" }, "Pieces start on the form (Project › Bag form) the way CLO places them on an avatar, then the seams pull them together. Negative 'out from form' puts a piece inside (linings)."),
    );
  }
  return out;
}

// ---------- edges ----------

export function edgeFinishSection(pc: Piece, i: number): Node[] {
  const cat = loadCatalogue();
  const e = pc.edges[i];
  const fin = e.finish ?? "raw";
  const opts = (cat?.finishes ?? []).map((f) => [f.finish, f.name] as [EdgeFinish, string]);
  const info = cat?.finishes.find((f) => f.finish === fin);
  return [
    head("Edge finish"),
    h(
      "div",
      { class: "grid3" },
      field("Finish", opts.length ? choose("e-fin", opts, fin, (v) => edit(() => (pc.edges[i].finish = v))) : h("span", {}, "…")),
      fin === "turned" ? field(`Turn, ${unitLabel()}`, lenBox("e-turn", e.turnMm || 6, (v) => edit(() => (pc.edges[i].turnMm = Math.max(1, v))), 1)) : null,
      field("Crease line", check("e-crease", !!e.crease, (v) => edit(() => (pc.edges[i].crease = v)))),
    ),
    info ? h("p", { class: "hint" }, info.description) : null,
  ].filter(Boolean) as Node[];
}

/** Apply one finish to every edge. */
export function finishAll(pc: Piece, finish: EdgeFinish): void {
  edit(() => pc.edges.forEach((e) => (e.finish = finish)));
}

// ---------- seams ----------

export function joinCraftSection(j: Join): Node[] {
  const cat = loadCatalogue();
  const cons = (cat?.constructions ?? []).map((c) => [c.construction, c.name] as [Construction, string]);
  const glues = (cat?.adhesives ?? []).map((a) => [a.adhesive, a.name] as [Adhesive, string]);
  const con = j.construction ?? "edgeToEdge";
  const glue = j.glue ?? "none";
  const cInfo = cat?.constructions.find((c) => c.construction === con);
  const gInfo = cat?.adhesives.find((a) => a.adhesive === glue);
  const mats = state.project.materials.map((m) => [m.id, m.name] as [string, string]);
  const insert = con === "welted" || con === "piped" || con === "bound";
  return [
    head("Construction"),
    field("Seam", cons.length ? choose("j-con", cons, con, (v) => edit(() => (j.construction = v))) : h("span", {}, "…")),
    cInfo ? h("p", { class: "hint" }, cInfo.description) : null,
    insert
      ? h(
          "div",
          { class: "grid2" },
          field(con === "piped" ? "Piping cover" : con === "bound" ? "Binding" : "Welt", choose("j-ins", [["", "Same leather"], ...mats], j.insertMaterialId ?? "", (v) => edit(() => (j.insertMaterialId = v || null)))),
          field(`${con === "piped" ? "Cord" : "Width"}, ${unitLabel()}`, lenBox("j-insw", j.insertMm ?? 0, (v) => edit(() => (j.insertMm = Math.max(0, v))), 0)),
        )
      : null,
    head("Bonding"),
    h(
      "div",
      { class: "grid2" },
      field("Glue", glues.length ? choose("j-glue", glues, glue, (v) => edit(() => (j.glue = v))) : h("span", {}, "…")),
      glue !== "none" ? field(`Glue band, ${unitLabel()}`, lenBox("j-gw", j.glueWidthMm ?? 0, (v) => edit(() => (j.glueWidthMm = Math.max(0, v))), 0)) : null,
    ),
    gInfo && glue !== "none" ? h("p", { class: "hint" }, `${gInfo.description} About ${gInfo.shearMpa} MPa in shear (estimate). The template shows the band to glue.`) : null,
  ].filter(Boolean) as Node[];
}

// ---------- hardware ----------

export function hardwareList(pc: Piece, select: (id: string) => () => void): Node[] {
  const cat = loadCatalogue();
  const u = state.project.units;
  return (pc.hardware ?? []).map((hw) => {
    const info = cat?.hardware.find((x) => x.id === hw.kind);
    return h("div", { class: "seam", onclick: select(hw.id) }, h("strong", {}, hw.label || info?.name || hw.kind), h("span", {}, `at ${fmtLen(hw.at.x, u)}, ${fmtLen(hw.at.y, u)}`));
  });
}

export function hardwareInspector(pid: string, id: string, back: Node): Node[] {
  const pc = piece(pid);
  const hw = pc?.hardware?.find((x) => x.id === id);
  if (!pc || !hw) return [];
  const cat = loadCatalogue();
  const info = cat?.hardware.find((x) => x.id === hw.kind);
  const kinds = (cat?.hardware ?? []).map((x) => [x.id, `${x.group}: ${x.name}`] as [string, string]);
  return [
    back,
    head(info?.name ?? "Hardware"),
    field("Type", kinds.length ? choose("hw-kind", kinds, hw.kind, (v) => edit(() => (hw.kind = v))) : h("span", {}, hw.kind)),
    info ? h("p", { class: "hint" }, `${info.description} ${info.grams} g.${info.fastens ? " Fastens to matching hardware on a piece it touches in 3D." : ""}`) : null,
    h(
      "div",
      { class: "grid3" },
      field(`Size (${info?.sizeLabel ?? "mm"})`, num("hw-size", hw.sizeMm || info?.defaultSizeMm || 0, (v) => edit(() => (hw.sizeMm = Math.max(0, v))), { step: 0.5, min: 0 })),
      field("Angle °", num("hw-ang", hw.angleDeg ?? 0, (v) => edit(() => (hw.angleDeg = v)), { step: 15 })),
      field("Label", text("hw-label", hw.label ?? "", (v) => edit(() => (hw.label = v)))),
      field("X", num("hw-x", Math.round(hw.at.x * 10) / 10, (v) => edit(() => (hw.at.x = v)), { step: 0.5 })),
      field("Y", num("hw-y", Math.round(hw.at.y * 10) / 10, (v) => edit(() => (hw.at.y = v)), { step: 0.5 })),
    ),
    h(
      "div",
      { class: "btn-row" },
      button("Through the piece below", () => void throughBelow(pid, id), "quiet"),
      button("Delete", () => {
        edit(() => (pc.hardware = (pc.hardware ?? []).filter((x) => x.id !== id)));
        state.sel = { kind: "piece", piece: pid };
        notify();
      }, "danger"),
    ),
  ].filter(Boolean) as Node[];
}

/** Add the matching half of a fastener to whichever arranged piece lies under it in 3D. */
async function throughBelow(pid: string, id: string): Promise<void> {
  const pc = piece(pid);
  const hw = pc?.hardware?.find((x) => x.id === id);
  if (!pc || !hw) return;
  const world = await api.arrangePoint(state.project, pid, hw.at);
  let best: { id: string; at: { x: number; y: number }; d: number } | null = null;
  for (const other of state.project.pieces) {
    if (other.id === pid || !other.place || other.place.face === "flat") continue;
    const at = await api.arrangeInverse(state.project, other.id, world);
    const back = await api.arrangePoint(state.project, other.id, at);
    const d = Math.hypot(back[0] - world[0], back[1] - world[1], back[2] - world[2]);
    const cp = state.computed?.pieces.find((c) => c.id === other.id);
    const inside = cp && at.x >= cp.bounds.min.x && at.x <= cp.bounds.max.x && at.y >= cp.bounds.min.y && at.y <= cp.bounds.max.y;
    if (inside && d < 12 && (!best || d < best.d)) best = { id: other.id, at, d };
  }
  if (!best) return setStatus("No arranged piece lies under this hardware in 3D. Arrange both pieces on the form first.");
  const target = best;
  edit((p) => {
    const o = p.pieces.find((x) => x.id === target.id)!;
    o.hardware = [...(o.hardware ?? []), { id: `${id}b`, kind: hw.kind, at: target.at, sizeMm: hw.sizeMm, angleDeg: hw.angleDeg }];
  });
  setStatus(`Matching ${hw.kind} added to ${piece(target.id)?.name}.`);
}

// ---------- surface work ----------

export function marksList(pc: Piece, select: (id: string) => () => void): Node[] {
  const out: Node[] = (pc.marks ?? []).map((mk) =>
    h("div", { class: "seam", onclick: select(mk.id) }, h("strong", {}, MARKS.find((m) => m[0] === mk.kind)?.[1] ?? mk.kind), h("span", {}, mk.text || mk.pattern || `${fmtLen(mk.size.x, state.project.units)} × ${fmtLen(mk.size.y, state.project.units)}`)),
  );
  return [...out, ...toolingList(pc)];
}

/** One row per tooling line, or per ready-made design (its lines move together). */
export function toolingList(pc: Piece): Node[] {
  const seen = new Set<string>();
  const out: Node[] = [];
  for (const s of pc.tooling ?? []) {
    if (s.group) {
      if (seen.has(s.group)) continue;
      seen.add(s.group);
    }
    const n = s.group ? (pc.tooling ?? []).filter((x) => x.group === s.group).length : 1;
    const name = n > 1 ? "Tooled design" : s.kind === "cut" ? "Swivel-knife cut" : s.kind === "letters" ? "Letters" : toolName(s.tool);
    const what = n > 1 ? `${n} lines` : s.kind === "letters" ? s.text ?? "" : s.kind === "fill" ? "area" : s.kind === "line" ? "row" : s.kind === "stamp" ? `${s.points.length} strike${s.points.length === 1 ? "" : "s"}` : "line";
    out.push(h("div", { class: "seam", onclick: () => { state.sel = { kind: "tooling", piece: pc.id, id: s.id }; notify(); } }, h("strong", {}, name), h("span", {}, what)));
  }
  return out;
}

/** Inspector for a selected tooling line (`state.sel.kind === "tooling"`). */
export function toolingInspector(pid: string, id: string, back: Node): Node[] {
  const s = piece(pid)?.tooling?.find((x) => x.id === id);
  if (!s) return [];
  return [back, head("Tooling"), ...strokeControls()];
}

/** The ready-made tooling designs, for menus: [id for startTooling, name]. */
export const TOOLING_DESIGNS: [string, string][] = DESIGNS.map((d) => [`design:${d.design}`, d.name]);

export function markInspector(pid: string, id: string, back: Node): Node[] {
  const pc = piece(pid);
  const mk = pc?.marks?.find((x) => x.id === id);
  if (!pc || !mk) return [];
  const out: Node[] = [
    back,
    head("Surface work"),
    field("Kind", choose("mk-kind", MARKS, mk.kind, (v) => edit(() => (mk.kind = v)))),
    h(
      "div",
      { class: "grid3" },
      field(`Width, ${unitLabel()}`, lenBox("mk-w", mk.size.x, (v) => edit(() => (mk.size.x = Math.max(2, v))), 2)),
      field(`Height, ${unitLabel()}`, lenBox("mk-h", mk.size.y, (v) => edit(() => (mk.size.y = Math.max(2, v))), 2)),
      field("Angle °", num("mk-a", mk.angleDeg ?? 0, (v) => edit(() => (mk.angleDeg = v)), { step: 15 })),
      field("X", num("mk-x", Math.round(mk.center.x * 10) / 10, (v) => edit(() => (mk.center.x = v)), { step: 0.5 })),
      field("Y", num("mk-y", Math.round(mk.center.y * 10) / 10, (v) => edit(() => (mk.center.y = v)), { step: 0.5 })),
    ),
  ];
  if (mk.kind === "tooling") out.push(field("Pattern", choose("mk-pat", TOOLING, (mk.pattern || "floral") as string, (v) => edit(() => (mk.pattern = v)))));
  if (mk.kind === "paint") {
    const c = h("input", { type: "color", value: mk.pattern || "#1d1d1f", "data-key": "mk-color" });
    c.addEventListener("change", () => edit(() => (mk.pattern = c.value)));
    out.push(field("Colour", c));
  }
  if (mk.kind === "perforate") out.push(field("Spacing / hole, mm", text("mk-perf", mk.pattern || "6/2", (v) => edit(() => (mk.pattern = v))), "For example 6/2: holes of 2 mm every 6 mm, staggered."));
  if (mk.kind !== "perforate" && mk.kind !== "paint") out.push(field("Text or stamp name", text("mk-text", mk.text ?? "", (v) => edit(() => (mk.text = v)))));
  out.push(
    h("div", { class: "btn-row" }, button("Delete", () => {
      edit(() => (pc.marks = (pc.marks ?? []).filter((x) => x.id !== id)));
      state.sel = { kind: "piece", piece: pid };
      notify();
    }, "danger")),
  );
  return out;
}

// ---------- project: thread, form, laminates ----------

export function projectCraftSection(): Node[] {
  const p = state.project;
  const cat = loadCatalogue();
  const threads = (cat?.threads ?? []).map((t) => [t.id, `${t.name} (${t.breakN} N)`] as [string, string]);
  const f = p.form ?? { widthMm: 300, depthMm: 100, heightMm: 320 };
  const setForm = (fn: (x: NonNullable<typeof p.form>) => void) =>
    edit((proj) => {
      const next = { ...f, ...(proj.form ?? {}) };
      fn(next);
      proj.form = next;
    });
  const pcs = p.pieces.map((x) => [x.id, x.name] as [string, string]);
  const out: Node[] = [
    field("Thread or lace", threads.length ? choose("proj-thread", threads, p.thread ?? "poly-0.6", (v) => edit((x) => (x.thread = v))) : h("span", {}, "…"), "Strengths are rough estimates for planning; laced seams use the lace."),
    head("Bag form (3D)"),
    h(
      "div",
      { class: "grid3" },
      field("Width", num("form-w", f.widthMm, (v) => setForm((x) => (x.widthMm = Math.max(10, v))), { step: 5, min: 10 })),
      field("Depth", num("form-d", f.depthMm, (v) => setForm((x) => (x.depthMm = Math.max(1, v))), { step: 5, min: 1 })),
      field("Height", num("form-h", f.heightMm, (v) => setForm((x) => (x.heightMm = Math.max(10, v))), { step: 5, min: 10 })),
      field("Corner radius", num("form-r", f.cornerMm ?? 0, (v) => setForm((x) => (x.cornerMm = Math.max(0, v))), { step: 5, min: 0 })),
      field("Oval", check("form-round", !!f.round, (v) => setForm((x) => (x.round = v)))),
    ),
    h("p", { class: "hint" }, "The size of the finished bag along its stitch lines. Arranged pieces start on it."),
    head("Glued layers"),
  ];
  for (const lam of p.laminates ?? []) {
    out.push(h("div", { class: "seam" }, h("strong", {}, `${piece(lam.a)?.name ?? "?"} + ${piece(lam.b)?.name ?? "?"}`), h("span", {}, cat?.adhesives.find((a) => a.adhesive === (lam.glue ?? "contactCement"))?.name ?? ""), button("✕", () => edit((x) => (x.laminates = (x.laminates ?? []).filter((l) => l.id !== lam.id))), "quiet icon")));
  }
  if (pcs.length >= 2) {
    const a = choose("lam-a", pcs, pcs[0][0], () => {});
    const b = choose("lam-b", pcs, pcs[1][0], () => {});
    out.push(
      h("div", { class: "grid2" }, field("Piece", a), field("Glued to", b)),
      h("div", { class: "btn-row" }, button("Glue face to face", () => {
        if (a.value === b.value) return setStatus("Pick two different pieces.");
        edit((x) => (x.laminates = [...(x.laminates ?? []), { id: `lam${Date.now().toString(36)}`, a: a.value, b: b.value, glue: "contactCement" }]));
      }, "quiet")),
      h("p", { class: "hint" }, "Linings, stiffeners and doubled straps: arrange both on the same face (the inner one with a negative offset) so they meet in 3D."),
    );
  }
  return out;
}

export function bomCraftSection(bom: Bom): Node[] {
  const out: Node[] = [];
  if (bom.threads?.length) {
    const t = h("table", { class: "report" }, h("tr", {}, h("th", {}, "Thread / lace"), h("th", {}, "Stitch"), h("th", {}, "Length")));
    for (const x of bom.threads) t.append(h("tr", {}, h("td", {}, x.name), h("td", {}, x.stitch), h("td", {}, `${x.lengthM.toFixed(1)} m`)));
    out.push(t);
  }
  if (bom.glue?.length) {
    const t = h("table", { class: "report" }, h("tr", {}, h("th", {}, "Glue"), h("th", {}, "Area"), h("th", {}, "About")));
    for (const g of bom.glue) t.append(h("tr", {}, h("td", {}, g.name), h("td", {}, `${g.areaCm2.toFixed(0)} cm²`), h("td", {}, `${g.grams.toFixed(1)} g`)));
    out.push(t);
  }
  return out;
}

// ---------- bag builder ----------

export const bagForm = { params: null as BagParams | null, style: "tote" as BagStyle };

const STYLES: [BagStyle, string][] = [
  ["tote", "Tote (gusset)"],
  ["boxedTote", "Boxed tote"],
  ["messenger", "Messenger with flap"],
  ["bucket", "Bucket bag"],
  ["zipPouch", "Zip pouch"],
];

export async function setBagStyle(style: BagStyle): Promise<void> {
  bagForm.style = style;
  bagForm.params = await api.bagDefaults(style);
  notify();
}

export function bagBuilder(close: () => void, presets: { id: string; name: string }[]): Node[] {
  if (!bagForm.params) {
    void setBagStyle(bagForm.style);
    return [h("p", { class: "hint" }, "Loading…")];
  }
  const p = bagForm.params;
  const cat = loadCatalogue();
  const n = (key: keyof BagParams, label: string, step = 5) => field(label, num(`bag-${key}`, Number(p[key]), (v) => ((p as unknown as Record<string, number>)[key] = Math.max(0, v)), { step, min: 0 }));
  return [
    h("a", { class: "back", href: "#", onclick: (e: Event) => { e.preventDefault(); close(); } }, "‹ Back"),
    head("Bag builder"),
    field("Style", choose("bag-style", STYLES, bagForm.style, (v) => void setBagStyle(v))),
    field("Name", text("bag-name", p.name, (v) => (p.name = v))),
    h("div", { class: "grid3" }, n("widthMm", "Width"), n("heightMm", "Height"), n("depthMm", "Depth"), n("cornerMm", "Corners"), bagForm.style === "messenger" ? n("flapMm", "Flap drop") : null),
    h(
      "div",
      { class: "grid2" },
      field("Leather", choose("bag-leather", presets.map((x) => [x.id, x.name] as [string, string]), p.leather, (v) => (p.leather = v))),
      field("Thickness, mm (0 = typical)", num("bag-t", p.thicknessMm, (v) => (p.thicknessMm = Math.max(0, v)), { step: 0.1, min: 0 })),
      field("Seams", choose("bag-con", (cat?.constructions ?? []).map((c) => [c.construction, c.name] as [Construction, string]), p.construction, (v) => (p.construction = v))),
      field("Glue", choose("bag-glue", (cat?.adhesives ?? []).map((a) => [a.adhesive, a.name] as [Adhesive, string]), p.glue, (v) => (p.glue = v))),
      field("Stitch", choose("bag-stitch", (cat?.stitches ?? []).map((s) => [s.kind, s.name] as [StitchKind, string]), p.stitch, (v) => (p.stitch = v))),
      field("Edges", choose("bag-edge", (cat?.finishes ?? []).filter((f) => f.finish !== "bound").map((f) => [f.finish, f.name] as [EdgeFinish, string]), p.edge, (v) => (p.edge = v))),
      field("Carry", choose("bag-carry", [["handles", "Two handles"], ["shoulder", "Shoulder strap"], ["both", "Both"], ["none", "None"]], p.carry, (v) => (p.carry = v))),
      field("Closure", choose("bag-close", [["magnetic", "Magnetic snap"], ["turnLock", "Turn lock"], ["snap", "Press stud"], ["none", "None"]], p.closure, (v) => (p.closure = v))),
    ),
    h("div", { class: "grid3" }, n("handleLengthMm", "Handle length"), n("handleWidthMm", "Handle width", 1), n("strapLengthMm", "Strap length"), n("strapWidthMm", "Strap width", 1)),
    h("div", { class: "grid3" }, field("Front pocket", check("bag-pocket", p.pocket, (v) => (p.pocket = v))), field("Feet", check("bag-feet", p.feet, (v) => (p.feet = v))), field("Thread", (() => {
      const c = h("input", { type: "color", value: p.threadColor, "data-key": "bag-thread" });
      c.addEventListener("change", () => (p.threadColor = c.value));
      return c;
    })())),
    h("p", { class: "hint" }, "Builds every piece with matching seams, rivets through both layers, closure and feet, arranged in 3D. Replaces the open project."),
    h("div", { class: "btn-row" }, button("Build bag", async () => {
      if (state.dirty && !confirm("Replace the open project with a new bag?")) return;
      setProject(await api.makeBag({ ...p }), null);
      close();
      setStatus(`${p.name}: ${state.project.pieces.length} pieces arranged on the form. Press Space to simulate.`);
    }, "primary")),
  ];
}

/** Place catalogue hardware from the library. */
export function pickHardware(kind: string): void {
  placing.kind = kind;
}
