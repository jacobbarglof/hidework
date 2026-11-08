// Object browser (right dock, upper half) and Library (left dock), laid out like CLO3D's.
// The library has four tabs on one row: Patterns (starter patterns by category), Fabrics,
// Hardware (hardware, punches, surface work, stitches and edges) and Scene (what is in the 3D
// scene, objects to drop and props).

import { byCategory, cachedTemplates, loadTemplates, newFrom, setTool } from "./actions";
import { h, rerender } from "./dom";
import { drape, loadPresets } from "./drape";
import { panel, reports, seamName, select } from "./panels";
import { edit, notify, placing, selectedPieceId, selectedPieceIds, setStatus, state, uid } from "./store";
import { toggleInSelection } from "./editing";
import { colorFor } from "./textures";
import { OZ_MM } from "./units";
import { OBJECT_PRESETS, bounds, dropObject, removeSceneItem, setProps, sim3d } from "./view3d";
import type { Prop } from "./simtypes";
import { MARKS, finishAll, loadCatalogue } from "./craftpanels";
import { simple } from "./prefs";
import { revealPanel } from "./docks";

/** The few hardware items most projects use: shown on their own in Simple mode. */
const COMMON_HARDWARE = ["rivet-m", "snap-20", "magnet-18", "buckle", "d-ring", "key-ring"];

type BrowserTab = "pieces" | "fabrics" | "seams";
export type LibraryTab = "patterns" | "fabrics" | "hardware" | "scene";
const ui = { browser: "pieces" as BrowserTab, library: "patterns" as LibraryTab, filter: "", scrollTo: "" };

const COLLAPSE_KEY = "hidework.collapsed";
const collapsed = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  })(),
);

function toggleSection(key: string): void {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* storage unavailable */
  }
  notify();
}

/** A collapsible library section with a heading, an optional count and an optional button. */
function section(key: string, title: string, body: Node[], opts: { count?: number; extra?: Node } = {}): HTMLElement {
  const closed = collapsed.has(key) && !ui.filter;
  return h(
    "div",
    { class: `lib-sec${closed ? " closed" : ""}`, "data-sec": key },
    h(
      "div",
      { class: "lib-sec-head" },
      h(
        "button",
        { type: "button", class: "lib-sec-toggle", onclick: () => toggleSection(key), title: closed ? "Show" : "Hide" },
        h("span", { class: "chev" }, closed ? "▸" : "▾"),
        h("span", { class: "lib-sec-title" }, title),
        opts.count !== undefined ? h("span", { class: "lib-sec-count" }, String(opts.count)) : null,
      ),
      opts.extra ?? null,
    ),
    closed ? null : h("div", { class: "lib-sec-body" }, ...body),
  );
}

function tabs<T extends string>(items: [T, string, string][], current: T, set: (t: T) => void): HTMLElement {
  return h("div", { class: "tabs" }, ...items.map(([k, label, title]) => h("button", { type: "button", class: k === current ? "active" : "", title, onclick: () => { set(k); notify(); } }, label)));
}

/** Show a library tab, optionally opening and scrolling to one of its sections. */
export function showLibraryTab(t: LibraryTab, sectionKey?: string): void {
  revealPanel("library");
  ui.library = t;
  if (sectionKey) {
    collapsed.delete(sectionKey);
    ui.scrollTo = sectionKey;
  }
  notify();
}

export function showBrowserTab(t: BrowserTab): void {
  revealPanel("browser");
  ui.browser = t;
  notify();
}

// ---------- object browser ----------

export function renderBrowser(el: HTMLElement): void {
  // Simple mode: the pieces and the seams; leathers are chosen on each piece.
  const easy = simple();
  if (easy && ui.browser === "fabrics") ui.browser = "pieces";
  const items: [BrowserTab, string, string][] = easy
    ? [["pieces", "Pieces", "The pieces of this project"], ["seams", "Seams", "Every seam and whether its two sides match"]]
    : [["pieces", "Pieces", "Pattern pieces"], ["fabrics", "Fabrics", "Leathers and linings in this project"], ["seams", "Seams", "Every seam and whether it matches"]];
  rerender(el, () => [tabs<BrowserTab>(items, ui.browser, (t) => (ui.browser = t)), h("div", { class: "tab-body" }, ...browserBody())]);
}

function browserBody(): Node[] {
  const p = state.project;
  if (ui.browser === "pieces") {
    const list = h("ul", { class: "list" });
    const chosen = new Set(selectedPieceIds());
    for (const pc of p.pieces) {
      const m = p.materials.find((x) => x.id === pc.materialId);
      const pick = (e: MouseEvent) => {
        // Shift or Ctrl+click adds or removes a piece from the selection.
        if (e.shiftKey || e.ctrlKey || e.metaKey) toggleInSelection(pc.id);
        else select({ kind: "piece", piece: pc.id })();
      };
      list.append(
        h(
          "li",
          { class: chosen.has(pc.id) ? "selected" : "", onclick: pick, title: `${pc.name} (Shift+click to select several; right-click for more)`, "data-piece": pc.id },
          h("span", { class: "swatch", style: `background:${m?.color ?? colorFor(m?.kind ?? "leather", m?.name ?? "")}` }),
          h("span", { class: "name" }, pc.name),
          h("span", { class: "meta" }, `×${pc.cutCount}`),
        ),
      );
    }
    if (!p.pieces.length) list.append(h("li", { class: "empty" }, simple() ? "No pieces yet. Click New project to choose what to make." : "No pieces. Draw one in the 2D window (R or P)."));
    return [list];
  }
  if (ui.browser === "fabrics") {
    const list = h("ul", { class: "list" });
    for (const m of p.materials) {
      const stats = reports.stats.find((s) => s.id === m.id);
      list.append(
        h(
          "li",
          { class: state.sel.kind === "material" && state.sel.id === m.id ? "selected" : "", onclick: select({ kind: "material", id: m.id }), title: m.name, "data-material": m.id },
          h("span", { class: "swatch", style: `background:${m.color ?? colorFor(m.kind, m.name)}` }),
          h("span", { class: "name" }, m.name),
          h("span", { class: "meta" }, `${(m.thicknessMm / OZ_MM).toFixed(1)} oz${stats ? ` · c ${stats.bendingLengthMm.toFixed(0)}` : ""}`),
        ),
      );
    }
    return [list, h("p", { class: "hint" }, "Add fabrics from Library › Fabrics. Select one to edit its physics or run a fabric test.")];
  }
  const out: Node[] = [];
  for (const j of p.joins) {
    const rep = state.computed?.joins.find((r) => r.id === j.id);
    const con = loadCatalogue()?.constructions.find((c) => c.construction === (j.construction ?? "edgeToEdge"))?.name ?? "";
    const glue = j.glue && j.glue !== "none" ? " · glued" : "";
    const other = j.b.edges.length ? seamName(j.b) : `face of ${state.project.pieces.find((x) => x.id === j.b.pieceId)?.name ?? "?"}`;
    const sel = state.sel.kind === "join" && state.sel.id === j.id;
    out.push(h("div", { class: `seam ${rep?.ok ? "ok" : "bad"}${sel ? " selected" : ""}`, onclick: select({ kind: "join", id: j.id }), "data-join": j.id }, h("strong", {}, `${seamName(j.a)} ↔ ${other}`), h("span", {}, `${con}${glue} · ${rep?.message ?? "…"}`)));
  }
  if (!p.joins.length) out.push(h("p", { class: "hint" }, simple() ? "No seams yet. To sew two edges together, click Show all tools, then Sew." : "Sew (S): click an edge, then the edge it sews to."));
  return out;
}

// ---------- library ----------

export function renderLibrary(el: HTMLElement): void {
  // Simple mode: the patterns and a few common pieces of hardware. All tools adds fabrics, every
  // kind of hardware and finish, and the 3D scene.
  const easy = simple();
  if (easy && (ui.library === "fabrics" || ui.library === "scene")) ui.library = "patterns";
  const items: [LibraryTab, string, string][] = easy
    ? [
        ["patterns", "Patterns", "Things to make, by kind"],
        ["hardware", "Hardware", "Rivets, snaps, buckles and rings"],
      ]
    : [
        ["patterns", "Patterns", "Starter patterns and bags, by category"],
        ["fabrics", "Fabrics", "Leathers and linings to add"],
        ["hardware", "Hardware", "Hardware, punches, surface work, stitches and edges"],
        ["scene", "Scene", "What is in the 3D scene, objects to drop and props"],
      ];
  rerender(el, () => [tabs<LibraryTab>(items, ui.library, (t) => (ui.library = t)), h("div", { class: "tab-body" }, ...libraryBody())]);
  if (ui.scrollTo) {
    const key = CSS.escape(ui.scrollTo);
    ui.scrollTo = "";
    requestAnimationFrame(() => el.querySelector(`[data-sec="${key}"], [data-anchor="${key}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }
}

function item(title: string, desc: string, onclick: () => void, extra?: { active?: boolean; color?: string }): HTMLElement {
  return h(
    "button",
    { class: `lib-item${extra?.active ? " active" : ""}`, type: "button", onclick, title: `${title}: ${desc}` },
    extra?.color ? h("div", { class: "swatch", style: `background:${extra.color}` }) : null,
    h("strong", {}, title),
    h("span", {}, desc),
  );
}

function libraryBody(): Node[] {
  if (ui.library === "patterns") return patternsBody();
  if (ui.library === "hardware" && simple()) return commonHardware();
  if (ui.library === "fabrics") return fabricsBody();
  if (ui.library === "hardware") return hardwareBody();
  return sceneBody();
}

function builderButton(label: string, title: string, special: "bag" | "strap"): HTMLElement {
  return h("button", { class: "btn quiet tiny", type: "button", title, onclick: () => { panel.special = special; notify(); } }, label);
}

function patternsBody(): Node[] {
  const all = cachedTemplates();
  if (!all.length) void loadTemplates().then(notify);
  const filter = h("input", { type: "text", class: "lib-filter", placeholder: "Find a pattern…", value: ui.filter, "data-key": "lib-filter" }) as HTMLInputElement;
  filter.addEventListener("input", () => {
    ui.filter = filter.value;
    notify();
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ui.filter = "";
      filter.blur();
      notify();
    }
    e.stopPropagation();
  });
  const q = ui.filter.trim().toLowerCase();
  const hits = all.filter((t) => !q || `${t.name} ${t.description} ${t.category ?? ""}`.toLowerCase().includes(q));
  const out: Node[] = [filter];
  for (const [cat, ts] of byCategory(hits)) {
    const extra = cat === "Bags" ? builderButton("Builder…", "Build a bag to your own sizes", "bag") : cat === "Straps" ? builderButton("Builder…", "Build a strap or belt to your own sizes", "strap") : undefined;
    out.push(
      section(
        `cat-${cat}`,
        cat,
        ts.map((t) => h("button", { class: "tpl-item", type: "button", title: t.description, onclick: () => void newFrom(t.id), "data-tpl": t.id }, h("strong", {}, t.name), h("span", {}, t.description))),
        { count: ts.length, extra },
      ),
    );
  }
  if (all.length && !hits.length) out.push(h("p", { class: "hint" }, "No pattern matches."));
  if (!all.length) out.push(h("p", { class: "hint" }, "Loading patterns…"));
  return out;
}

/** Simple mode's hardware: a handful of common items, each with what to do next. */
function commonHardware(): Node[] {
  const cat = loadCatalogue();
  const items = COMMON_HARDWARE.map((id) => cat?.hardware.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x);
  return [
    h("p", { class: "hint plain" }, "Click one, then click the pattern where it goes. The holes it needs are made for you."),
    h(
      "div",
      { class: "lib-grid one" },
      ...items.map((x) =>
        item(x.name, x.description, () => {
          placing.kind = x.id;
          setTool("hardware");
          setStatus(`Now click the pattern where the ${x.name.toLowerCase()} goes. Press Esc to stop.`);
        }, { active: placing.kind === x.id && state.tool === "hardware" }),
      ),
    ),
    !cat ? h("p", { class: "hint" }, "Getting the hardware ready…") : null,
    h("p", { class: "hint" }, "Every other kind of hardware is under Show all tools."),
  ].filter((n) => !!n) as Node[];
}

function fabricsBody(): Node[] {
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

function hardwareBody(): Node[] {
  const cat = loadCatalogue();
  const target = selectedPieceId();
  const pc = target ? state.project.pieces.find((x) => x.id === target) : undefined;
  const punches: [string, string, number, number][] = [
    ["Punch 2 mm", "Plain round hole", 2, 0],
    ["Punch 3 mm", "Plain round hole", 3, 0],
    ["Punch 4 mm", "Plain round hole", 4, 0],
    ["Strap slot", "Slot for a 20 mm strap", 4, 22],
  ];
  const markDesc: Record<string, string> = {
    stamp: "A maker's mark or stamp",
    tooling: "Carved and tooled area",
    emboss: "Raised or pressed design",
    engrave: "Laser or hand engraving",
    paint: "Dyed or painted area",
    text: "Stamped or engraved letters",
    perforate: "Grid of punched holes",
  };
  const groups = [...new Set((cat?.hardware ?? []).map((x) => x.group))];
  const out: Node[] = [h("p", { class: "hint" }, "Pick one, then click the pattern to place it. Hardware adds the holes it needs and its weight, and fastens in 3D.")];
  groups.forEach((g, i) => {
    const items = (cat?.hardware ?? []).filter((x) => x.group === g);
    const sec = section(
      `hw-${g}`,
      g,
      [
        h(
          "div",
          { class: "lib-grid" },
          ...items.map((x) =>
            item(x.name, x.description, () => {
              placing.kind = x.id;
              setTool("hardware");
              setStatus(`Click a piece to set: ${x.name}.`);
            }, { active: placing.kind === x.id && state.tool === "hardware" }),
          ),
        ),
      ],
      { count: items.length },
    );
    if (i === 0) sec.setAttribute("data-anchor", "hardware");
    out.push(sec);
  });
  if (!cat) out.push(h("p", { class: "hint" }, "Loading hardware…"));
  out.push(
    section("punch", "Plain punches", [
      h(
        "div",
        { class: "lib-grid" },
        ...punches.map(([label, desc, d, l]) =>
          item(label, `${desc} · ${d} mm${l ? ` × ${l}` : ""}`, () => {
            placing.hardware = { label, diameterMm: d, lengthMm: l };
            setTool("hole");
            setStatus(`Click a piece to punch: ${label}.`);
          }, { active: placing.hardware?.label === label && state.tool === "hole" }),
        ),
      ),
    ]),
  );
  out.push(
    section("surface", "Surface work", [
      h(
        "div",
        { class: "lib-grid" },
        ...MARKS.map(([k, name]) =>
          item(name, markDesc[k] ?? name, () => {
            placing.mark = {
              kind: k,
              size: k === "text" ? { x: 50, y: 10 } : k === "stamp" ? { x: 25, y: 25 } : { x: 60, y: 40 },
              text: k === "text" ? "HIDEWORK" : "",
              pattern: k === "tooling" ? "floral" : k === "perforate" ? "6/2" : k === "paint" ? "#1d1d1f" : "",
            };
            setTool("mark");
            setStatus(`Click a piece to place: ${name}. Drag to move it; size it in the properties.`);
          }, { active: state.tool === "mark" && placing.mark.kind === k }),
        ),
      ),
    ]),
  );
  out.push(
    section("stitch", "Stitch", [
      h("p", { class: "hint" }, pc ? `Click to use on ${pc.name}.` : "Select a piece first."),
      h(
        "div",
        { class: "lib-grid" },
        ...(cat?.stitches ?? []).map((st) =>
          item(st.name, `${st.group} · ${st.threadFactor}× seam`, () => {
            if (!pc) return setStatus("Select a piece first.");
            edit(() => {
              const was = cat?.stitches.find((k) => k.kind === (pc.stitch.kind ?? "saddle"));
              pc.stitch.kind = st.kind;
              if (st.lace !== !!was?.lace) {
                pc.stitch.pitchMm = st.defaultPitchMm;
                pc.stitch.holeMm = st.lace ? 3 : 1;
                if (st.lace) pc.stitch.marginMm = Math.max(pc.stitch.marginMm, 4);
              }
            });
            setStatus(`${pc.name}: ${st.name}.`);
          }, { active: pc?.stitch.kind === st.kind }),
        ),
      ),
    ]),
  );
  out.push(
    section("edges", "Edges", [
      h("p", { class: "hint" }, pc ? `Click to finish every edge of ${pc.name}.` : "Select a piece first."),
      h("div", { class: "lib-grid" }, ...(cat?.finishes ?? []).map((f) => item(f.name, f.description, () => (pc ? finishAll(pc, f.finish) : setStatus("Select a piece first."))))),
    ]),
  );
  return out;
}

// ---------- scene ----------

export type PropKind = "floor" | "table" | "pedestal" | "bar";

/** Put scenery under the piece in 3D. */
export async function applyProp(kind: PropKind): Promise<void> {
  const box = bounds();
  if (kind === "floor") return setProps([], 0);
  if (!box) return setStatus("Simulate first (Space), then add a prop.");
  if (kind === "table") {
    const top = 300;
    const mid = (box.min.x + box.max.x) / 2;
    const p: Prop = { type: "box", min: [box.min.x - 300, box.min.y - 200, 0], max: [mid, box.max.y + 200, top] };
    return setProps([p], top + 1);
  }
  if (kind === "pedestal") {
    const top = 250;
    const r = Math.min(box.max.x - box.min.x, box.max.y - box.min.y) * 0.3;
    return setProps([{ type: "pedestal", center: [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2], radius: Math.max(15, r), top }], top + 1);
  }
  const z = 400;
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  // Across the longer side, through the middle, so the piece drapes over it.
  const along = box.max.x - box.min.x >= box.max.y - box.min.y;
  const bar: Prop = along ? { type: "bar", a: [cx, box.min.y - 100, z], b: [cx, box.max.y + 100, z], radius: 8 } : { type: "bar", a: [box.min.x - 100, cy, z], b: [box.max.x + 100, cy, z], radius: 8 };
  return setProps([bar], z + 15);
}

function sceneBody(): Node[] {
  const st = sim3d.status;
  const list = h("ul", { class: "list" });
  const row = (label: string, meta: string, id: string) =>
    h("li", {}, h("span", { class: "name" }, label), h("span", { class: "meta" }, meta), h("button", { class: "btn quiet tiny", type: "button", title: "Take it out of the scene", onclick: () => void removeSceneItem(id) }, "Remove"));
  for (const o of st?.objects ?? []) list.append(row(o.name, `${o.grams} g`, o.id));
  for (const [id, g] of st?.weights ?? []) list.append(row("Weight", `${g} g`, id));
  for (const [id] of st?.pins ?? []) list.append(row("Pin", "", id));
  for (const pr of sim3d.props) list.append(h("li", {}, h("span", { class: "name" }, pr.type === "box" ? "Table" : pr.type === "pedestal" ? "Pedestal" : "Hook bar"), h("span", { class: "meta" }, "prop")));
  if (!list.children.length) list.append(h("li", { class: "empty" }, "Empty. Drop objects, pin (I) or hang weights (W) in 3D."));
  const props: [PropKind, string, string][] = [
    ["floor", "Floor only", "Lie flat on the floor"],
    ["table", "Table edge", "Half on a table, half hanging off"],
    ["pedestal", "Pedestal", "Centred on a round stand"],
    ["bar", "Hook bar", "A bar to hang straps over"],
  ];
  const now: Node[] = [list];
  if (sim3d.props.length) now.push(h("div", { class: "btn-row" }, h("button", { class: "btn quiet", type: "button", onclick: () => void setProps([], 0) }, "Clear props")));
  return [
    section("scene-now", "In the scene", now),
    section("objects", "Objects", [
      h("p", { class: "hint" }, "Choose one, then click in the 3D window to drop it there."),
      h(
        "div",
        { class: "lib-grid" },
        ...Object.entries(OBJECT_PRESETS).map(([k, o]) =>
          item(o.name, `${o.grams} g`, () => {
            sim3d.objectPreset = k;
            sim3d.tool = "object";
            setStatus(`Click in the 3D window to drop: ${o.name}.`);
          }, { active: sim3d.tool === "object" && sim3d.objectPreset === k, color: o.color }),
        ),
      ),
      h("div", { class: "btn-row" }, h("button", { class: "btn primary", type: "button", onclick: () => void dropObject(sim3d.objectPreset, null).catch((e) => setStatus(String(e))) }, "Drop in the middle")),
    ]),
    section("props", "Props", [
      h("p", { class: "hint" }, "Props stay put; the piece rests on them. Changing props restarts the simulation."),
      h("div", { class: "lib-grid" }, ...props.map(([k, t, d]) => item(t, d, () => void applyProp(k)))),
    ]),
  ];
}
