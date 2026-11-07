// Handles calls from AI agents (via hidework-mcp and the Rust control channel). Each method maps
// to the same edits a person makes in the interface, so everything stays undoable and visible.

import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { captureCanvas, fitView, zoomBy } from "./canvas";
import { captureDrape, defaultsFor, drape, loadPresets, setDrapeVisible } from "./drape";
import { deleteVertex, duplicatePiece, insertVertex, mirrorPiece, rectPiece, rotatePiece, roundedRectPiece, toggleCurve } from "./ops";
import { addStrap, closeFabricTest, deletePiece, makeGusset, openFabricTest, panel } from "./panels";
import { OBJECT_PRESETS, bounds, capture3d, dropObject, frameView, needsRebuild, rebuild, refreshStatus, removeSceneItem, resetSim, runFrames, setHeat, setProps, sim3d, viewPreset } from "./view3d";
import { invoke } from "@tauri-apps/api/core";
import type { Prop } from "./simtypes";
import { edit, notify, piece, redo, setProject, state, uid, undo, whenComputed, type Sel } from "./store";
import { OZ_MM } from "./units";
import type { Edge, Material, Physics, Piece, Project, Scene, StrapParams, V } from "./types";

type Params = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (p: Params) => Promise<unknown> | unknown;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`${what} not found.`);
  return v;
}

function pc(p: Params): Piece {
  return need(piece(String(p.pieceId ?? "")), `Piece ${p.pieceId}`);
}

function summary(includeProject: boolean): unknown {
  const c = state.computed;
  const proj = state.project;
  return {
    name: proj.name,
    units: proj.units,
    file: state.filePath,
    unsaved: state.dirty,
    view: lastView,
    tool: state.tool,
    selection: state.sel,
    printPages: state.pages,
    materials: proj.materials.map((m) => ({ id: m.id, name: m.name, kind: m.kind, thicknessMm: +m.thicknessMm.toFixed(3), oz: +(m.thicknessMm / OZ_MM).toFixed(2), costPerSqft: m.costPerSqft ?? null, physics: m.physics ?? "kind defaults" })),
    pieces: proj.pieces.map((p) => {
      const cp = c?.pieces.find((x) => x.id === p.id);
      return {
        id: p.id,
        name: p.name,
        materialId: p.materialId,
        position: p.position,
        cutCount: p.cutCount,
        grainDeg: p.grainDeg,
        notes: p.notes ?? "",
        stitch: p.stitch,
        seamAllowanceMm: p.seamAllowanceMm,
        size: cp ? { width: +(cp.bounds.max.x - cp.bounds.min.x).toFixed(2), height: +(cp.bounds.max.y - cp.bounds.min.y).toFixed(2) } : null,
        vertices: p.vertices,
        edges: p.edges.map((e, i) => ({
          index: i,
          type: e.type,
          stitched: e.stitched,
          skiveMm: e.skiveMm ?? 0,
          lengthMm: cp ? +cp.edges[i].lengthMm.toFixed(2) : null,
          stitchLengthMm: cp ? +cp.edges[i].stitchLengthMm.toFixed(2) : null,
          holes: cp ? cp.edges[i].holeCount : null,
        })),
        folds: p.folds.map((f) => ({ ...f, allowanceMm: cp?.folds.find((g) => g.id === f.id)?.shiftMm ?? null })),
        holes: p.holes,
      };
    }),
    seams: proj.joins.map((j) => ({ ...j, check: c?.joins.find((r) => r.id === j.id) ?? null })),
    warnings: c?.warnings ?? [],
    project: includeProject ? proj : undefined,
  };
}

/** Which window the last action concerned, for its automatic screenshot. */
let lastView: "pattern" | "3d" | "fabric" = "pattern";

async function shot(view?: string): Promise<string> {
  await whenComputed();
  const v = (view as typeof lastView) ?? lastView;
  await nextFrame();
  await nextFrame();
  if (v === "fabric") return captureDrape();
  if (v === "3d") return capture3d();
  return captureCanvas();
}

async function ensureSim(): Promise<void> {
  if (!sim3d.info || needsRebuild()) await rebuild();
  if (!sim3d.info) throw new Error(sim3d.error || "Could not start the simulation.");
}

function physicsFromPreset(id: string): { name: string; kind: Material["kind"]; thicknessMm: number; physics: Physics } {
  const p = need(drape.presets.find((x) => x.id === id), `Preset ${id}`);
  return { name: p.name, kind: p.kind, thicknessMm: p.thicknessMm, physics: { ...p.physics } };
}

const handlers: Record<string, Handler> = {
  get_state: (p) => summary(!!p.includeProject),
  screenshot: async (p) => {
    if (p.fit) fitView();
    if (p.view) lastView = p.view === "drape" ? "fabric" : p.view; return { view: lastView };
  },
  list_templates: () => api.templates(),
  new_project: async (p) => {
    setProject(await api.fromTemplate(String(p.template)), null);
    await whenComputed();
    fitView();
    return summary(false);
  },
  open_project: async (p) => {
    setProject(await api.load(String(p.path)), String(p.path));
    await whenComputed();
    fitView();
    return summary(false);
  },
  save_project: async (p) => {
    const path = String(p.path ?? state.filePath ?? "");
    if (!path) throw new Error("This project has never been saved; give a path.");
    await api.save(state.project, path);
    state.filePath = path;
    state.dirty = false;
    notify();
    return { saved: path };
  },
  set_project: async (p) => {
    const proj = p.project as Project;
    if (!proj || !Array.isArray(proj.pieces)) throw new Error("project must be a Hidework project object.");
    edit((x) => Object.assign(x, proj));
    return summary(false);
  },
  add_piece: (p) => {
    const at: V = { x: Number(p.x ?? 20), y: Number(p.y ?? 20) };
    const w = Number(p.width ?? 80);
    const ht = Number(p.height ?? 50);
    let piece: Piece;
    if (p.shape === "polygon") {
      const verts = (p.vertices ?? []) as V[];
      if (verts.length < 3) throw new Error("A polygon needs at least three vertices.");
      piece = rectPiece(at, 1, 1, String(p.name ?? "Panel"));
      piece.vertices = verts.map((v) => ({ x: Number(v.x), y: Number(v.y) }));
      piece.edges = verts.map(() => ({ type: "line", stitched: false }) as Edge);
    } else if (p.shape === "rounded") {
      piece = roundedRectPiece(at, w, ht, Number(p.radius ?? 6), String(p.name ?? "Panel"));
    } else piece = rectPiece(at, w, ht, String(p.name ?? "Panel"));
    if (p.materialId) piece.materialId = String(p.materialId);
    if (p.stitchAll) piece.edges.forEach((e) => (e.stitched = true));
    edit((x) => x.pieces.push(piece));
    state.sel = { kind: "piece", piece: piece.id };
    return { pieceId: piece.id };
  },
  update_piece: (p) => {
    const x = pc(p);
    edit(() => {
      if (p.name !== undefined) x.name = String(p.name);
      if (p.materialId !== undefined) x.materialId = String(p.materialId);
      if (p.cutCount !== undefined) x.cutCount = Math.max(1, Math.round(p.cutCount));
      if (p.seamAllowanceMm !== undefined) x.seamAllowanceMm = Math.max(0, p.seamAllowanceMm);
      if (p.grainDeg !== undefined) x.grainDeg = Number(p.grainDeg);
      if (p.notes !== undefined) x.notes = String(p.notes);
      if (p.x !== undefined) x.position.x = Number(p.x);
      if (p.y !== undefined) x.position.y = Number(p.y);
      if (p.stitchMarginMm !== undefined) x.stitch.marginMm = Number(p.stitchMarginMm);
      if (p.pitchMm !== undefined) x.stitch.pitchMm = Number(p.pitchMm);
      if (p.holeMm !== undefined) x.stitch.holeMm = Number(p.holeMm);
    });
    return { pieceId: x.id };
  },
  delete_piece: (p) => {
    deletePiece(pc(p).id);
    return { deleted: p.pieceId };
  },
  transform_piece: (p) => {
    const x = pc(p);
    if (p.op === "duplicate") {
      const copy = duplicatePiece(x);
      edit((proj) => proj.pieces.push(copy));
      return { pieceId: copy.id };
    }
    edit(() => {
      if (p.op === "mirror_x") mirrorPiece(x, "x");
      else if (p.op === "mirror_y") mirrorPiece(x, "y");
      else if (p.op === "rotate_cw") rotatePiece(x, true);
      else if (p.op === "rotate_ccw") rotatePiece(x, false);
      else throw new Error(`Unknown op ${p.op}`);
    });
    return { pieceId: x.id };
  },
  edit_vertex: (p) => {
    const x = pc(p);
    const i = Number(p.index);
    if (p.op === "move") {
      need(x.vertices[i], `Vertex ${i}`);
      edit(() => (x.vertices[i] = { x: Number(p.x), y: Number(p.y) }));
      return { vertex: i };
    }
    if (p.op === "insert") {
      need(x.edges[i], `Edge ${i}`);
      let k = 0;
      edit((proj) => (k = insertVertex(proj, x, i, { x: Number(p.x), y: Number(p.y) })));
      return { vertex: k };
    }
    let ok = false;
    edit((proj) => (ok = deleteVertex(proj, x, i)));
    if (!ok) throw new Error("A piece needs at least three corners.");
    return { deleted: i };
  },
  set_edge: (p) => {
    const x = pc(p);
    const idx: number[] = p.indices ?? (p.index !== undefined ? [p.index] : []);
    if (!idx.length) throw new Error("Give index or indices.");
    edit(() => {
      for (const i of idx) {
        const e = need(x.edges[i], `Edge ${i}`);
        if (p.stitched !== undefined) e.stitched = !!p.stitched;
        if (p.skiveMm !== undefined) e.skiveMm = Math.max(0, Number(p.skiveMm));
        if (p.curved !== undefined && p.curved !== (e.type === "cubic")) toggleCurve(x, i);
        const e2 = x.edges[i];
        if (e2.type === "cubic") {
          if (p.c1) e2.c1 = { x: Number(p.c1.x), y: Number(p.c1.y) };
          if (p.c2) e2.c2 = { x: Number(p.c2.x), y: Number(p.c2.y) };
        }
      }
    });
    return { edges: idx };
  },
  add_fold: (p) => {
    const x = pc(p);
    const id = uid("f");
    edit(() => x.folds.push({ id, orientation: p.orientation === "vertical" ? "vertical" : "horizontal", position: Number(p.position), contentsMm: Number(p.contentsMm ?? 0) }));
    return { foldId: id };
  },
  update_fold: (p) => {
    const x = pc(p);
    const f = need(x.folds.find((y) => y.id === p.foldId), `Fold ${p.foldId}`);
    edit(() => {
      if (p.orientation) f.orientation = p.orientation;
      if (p.position !== undefined) f.position = Number(p.position);
      if (p.contentsMm !== undefined) f.contentsMm = Math.max(0, Number(p.contentsMm));
    });
    return { foldId: f.id };
  },
  add_hole: (p) => {
    const x = pc(p);
    const id = uid("h");
    edit(() =>
      x.holes.push({ id, center: { x: Number(p.x), y: Number(p.y) }, diameterMm: Number(p.diameterMm ?? 3), label: String(p.label ?? ""), lengthMm: Number(p.lengthMm ?? 0), angleDeg: Number(p.angleDeg ?? 0) }),
    );
    return { holeId: id };
  },
  update_hole: (p) => {
    const x = pc(p);
    const hd = need(x.holes.find((y) => y.id === p.holeId), `Hole ${p.holeId}`);
    edit(() => {
      if (p.x !== undefined) hd.center.x = Number(p.x);
      if (p.y !== undefined) hd.center.y = Number(p.y);
      if (p.diameterMm !== undefined) hd.diameterMm = Number(p.diameterMm);
      if (p.label !== undefined) hd.label = String(p.label);
      if (p.lengthMm !== undefined) hd.lengthMm = Number(p.lengthMm);
      if (p.angleDeg !== undefined) hd.angleDeg = Number(p.angleDeg);
    });
    return { holeId: hd.id };
  },
  add_join: (p) => {
    for (const side of [p.a, p.b]) {
      const x = need(piece(String(side?.pieceId)), `Piece ${side?.pieceId}`);
      for (const e of side.edges ?? []) need(x.edges[e], `Edge ${e} of ${x.name}`);
    }
    const id = uid("j");
    edit((proj) => proj.joins.push({ id, a: { pieceId: p.a.pieceId, edges: p.a.edges }, b: { pieceId: p.b.pieceId, edges: p.b.edges } }));
    return { joinId: id };
  },
  delete_item: (p) => {
    const id = String(p.id);
    edit((proj) => {
      if (p.kind === "join") proj.joins = proj.joins.filter((j) => j.id !== id);
      else if (p.kind === "material") {
        if (proj.pieces.some((x) => x.materialId === id)) throw new Error("That material is still used by a piece.");
        proj.materials = proj.materials.filter((m) => m.id !== id);
      } else
        for (const x of proj.pieces) {
          if (p.kind === "fold") x.folds = x.folds.filter((f) => f.id !== id);
          if (p.kind === "hole") x.holes = x.holes.filter((f) => f.id !== id);
        }
    });
    return { deleted: id };
  },
  add_strap: async (p) => {
    const params: StrapParams = { ...p };
    const id = await addStrap(params, p.materialId, p.x !== undefined ? { x: Number(p.x), y: Number(p.y ?? 20) } : undefined);
    state.sel = { kind: "piece", piece: id };
    return { pieceId: id };
  },
  add_gusset: async (p) => {
    pc(p);
    await whenComputed();
    const id = await makeGusset(String(p.pieceId), (p.edges ?? []).map(Number), Number(p.widthMm ?? 40));
    return { pieceId: id };
  },
  add_lining: async (p) => {
    pc(p);
    const id = uid("p");
    const lining = await api.lining(state.project, String(p.pieceId), Number(p.insetMm ?? 2), id);
    edit((proj) => proj.pieces.push(lining));
    return { pieceId: id };
  },
  list_material_presets: async () => {
    await loadPresets();
    return drape.presets.map((x) => ({ ...x, oz: +(x.thicknessMm / OZ_MM).toFixed(1) }));
  },
  add_material: async (p) => {
    await loadPresets();
    const base = p.preset ? physicsFromPreset(String(p.preset)) : { name: "New material", kind: "leather" as const, thicknessMm: 4 * OZ_MM, physics: null as Physics | null };
    const id = uid("m");
    const thickness = p.thicknessMm !== undefined ? Number(p.thicknessMm) : p.oz !== undefined ? Number(p.oz) * OZ_MM : base.thicknessMm;
    edit((proj) =>
      proj.materials.push({ id, name: String(p.name ?? base.name), kind: p.kind ?? base.kind, thicknessMm: thickness, physics: base.physics, costPerSqft: p.costPerSqft ?? null }),
    );
    return { materialId: id };
  },
  update_material: (p) => {
    const m = need(state.project.materials.find((x) => x.id === p.materialId), `Material ${p.materialId}`);
    edit(() => {
      if (p.name !== undefined) m.name = String(p.name);
      if (p.kind !== undefined) m.kind = p.kind;
      if (p.thicknessMm !== undefined) m.thicknessMm = Number(p.thicknessMm);
      if (p.oz !== undefined) m.thicknessMm = Number(p.oz) * OZ_MM;
      if (p.costPerSqft !== undefined) m.costPerSqft = p.costPerSqft;
      const keys: (keyof Physics)[] = ["densityKgM3", "bendingModulusMpa", "tensileModulusMpa", "anisotropy", "biasStiffness", "friction"];
      if (keys.some((k) => p[k] !== undefined)) {
        const cur: Physics = m.physics ?? { densityKgM3: 900, bendingModulusMpa: 20, tensileModulusMpa: 80, anisotropy: 0.85, biasStiffness: 0.9, friction: 0.6 };
        for (const k of keys) if (p[k] !== undefined) cur[k] = Number(p[k]);
        m.physics = { ...cur };
      }
    });
    return { materialId: m.id };
  },
  calibrate_material: async (p) => {
    const m = need(state.project.materials.find((x) => x.id === p.materialId), `Material ${p.materialId}`);
    const cur: Physics = m.physics ?? { densityKgM3: 900, bendingModulusMpa: 20, tensileModulusMpa: 80, anisotropy: 0.85, biasStiffness: 0.9, friction: 0.6 };
    const e = await api.calibrate(m.thicknessMm, cur.densityKgM3, Number(p.overhangMm));
    edit(() => (m.physics = { ...cur, bendingModulusMpa: e }));
    return { materialId: m.id, bendingModulusMpa: +e.toFixed(3) };
  },
  bill_of_materials: (p) => api.bom(state.project, Number(p.wastePct ?? state.wastePct)),
  run_drape: async (p) => {
    await loadPresets();
    const x = pc(p);
    await whenComputed();
    defaultsFor(x.id);
    if (p.scene) drape.scene = { ...drape.scene, ...p.scene } as Scene;
    if (p.seconds) drape.seconds = Number(p.seconds);
    if (Array.isArray(p.variants) && p.variants.length) {
      drape.variants = p.variants.map((v: Params) => {
        const source = v.materialId ? `m:${v.materialId}` : `p:${v.preset ?? "vegtan-soft"}`;
        const mat = v.materialId ? state.project.materials.find((m) => m.id === v.materialId) : undefined;
        const presetT = v.preset ? drape.presets.find((q) => q.id === v.preset)?.thicknessMm : undefined;
        const mm = v.thicknessMm ?? (v.oz !== undefined ? Number(v.oz) * OZ_MM : mat?.thicknessMm ?? presetT ?? 3 * OZ_MM);
        return { source, oz: Math.round((Number(mm) / OZ_MM) * 100) / 100 };
      });
    }
    openFabricTest();
    setDrapeVisible(true);
    lastView = "fabric";
    notify();
    const { runDrape } = await import("./drape");
    const r = await runDrape();
    // Let the animation settle on its final frame before the screenshot.
    const { applyFrame, maxFrame } = await import("./drape");
    drape.playing = false;
    applyFrame(maxFrame());
    return { scene: drape.scene, results: r.variants.map((v) => ({ label: v.label, ...v.metrics })) };
  },
  export: async (p) => {
    const path = String(p.path);
    const opts = { kerfMm: p.kerfMm, stitchHoleMm: p.stitchHoleMm, plateMm: p.plateMm, pieces: p.pieces ?? [] };
    const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    switch (p.format) {
      case "pdf":
        return { path, pages: await api.exportPdf(state.project, path, p.page ?? state.page) };
      case "svg":
        await api.exportSvg(state.project, path);
        return { path };
      case "laser_svg":
        await api.exportLaserSvg(state.project, path, clean);
        return { path };
      case "dxf":
        await api.exportDxf(state.project, path, clean);
        return { path };
      case "stl":
        return { path, triangles: await api.exportStl(state.project, path, clean) };
      default:
        throw new Error(`Unknown format ${p.format}`);
    }
  },
  select: (p) => {
    const kind = String(p.kind);
    const s: Sel =
      kind === "none"
        ? { kind: "none" }
        : kind === "join"
          ? { kind: "join", id: String(p.id) }
          : kind === "piece"
            ? { kind: "piece", piece: String(p.pieceId) }
            : kind === "edge" || kind === "vertex"
              ? { kind, piece: String(p.pieceId), index: Number(p.index) }
              : { kind: kind as "hole" | "fold", piece: String(p.pieceId), id: String(p.id) };
    state.sel = s;
    panel.special = null;
    notify();
    return { selection: s };
  },
  view: (p) => {
    if (p.op === "fit") {
      fitView();
      frameView();
    }
    if (p.op === "zoom_in") zoomBy(1.4);
    if (p.op === "zoom_out") zoomBy(1 / 1.4);
    if (["front", "back", "top", "side", "iso"].includes(p.op)) {
      viewPreset(p.op);
      lastView = "3d";
    }
    if (p.op === "pattern") lastView = "pattern";
    if (p.op === "3d") lastView = "3d";
    if (p.op === "close_fabric_test") {
      closeFabricTest();
      setDrapeVisible(false);
    }
    return { view: lastView };
  },
  simulate: async (p) => {
    if (p.rebuild || p.foldAngleDeg !== undefined) {
      if (p.foldAngleDeg !== undefined) sim3d.foldAngle = Number(p.foldAngleDeg);
      await rebuild();
    }
    await ensureSim();
    if (p.reset) await resetSim();
    const seconds = Math.min(30, Math.max(0, Number(p.seconds ?? 3)));
    await runFrames(Math.round(seconds * 90));
    if (p.stressMap !== undefined) setHeat(!!p.stressMap);
    lastView = "3d";
    frameView();
    return sim3d.status;
  },
  sim_pin: async (p) => {
    await ensureSim();
    const id = String(p.id ?? uid("pin"));
    const target = p.world ? { world: p.world } : { pieceId: p.pieceId, at: { x: Number(p.x), y: Number(p.y) } };
    await invoke("sim_pin", { id, target });
    await refreshStatus();
    lastView = "3d";
    return { pinId: id };
  },
  sim_weight: async (p) => {
    await ensureSim();
    const id = String(p.id ?? uid("w"));
    const target = p.world ? { world: p.world } : { pieceId: p.pieceId, at: { x: Number(p.x), y: Number(p.y) } };
    await invoke("sim_add_weight", { id, target, grams: Number(p.grams ?? 200) });
    await refreshStatus();
    lastView = "3d";
    return { weightId: id };
  },
  sim_object: async (p) => {
    await ensureSim();
    let id: string;
    if (p.preset) {
      const at = p.world ? new (await import("three")).Vector3(p.world[0], p.world[1], p.world[2]) : null;
      id = await dropObject(String(p.preset), at);
    } else {
      id = String(p.id ?? uid("o"));
      const b = bounds();
      const pos = p.world ?? (b ? [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z + 60] : [0, 0, 60]);
      await invoke("sim_add_object", { object: { id, name: String(p.name ?? "Object"), shape: p.shape, grams: Number(p.grams ?? 100), pos } });
      await refreshStatus();
    }
    sim3d.running = false;
    lastView = "3d";
    return { objectId: id, presets: Object.keys(OBJECT_PRESETS) };
  },
  sim_remove: async (p) => {
    await removeSceneItem(String(p.id));
    sim3d.running = false;
    lastView = "3d";
    return { removed: p.id };
  },
  sim_props: async (p) => {
    const preset = String(p.preset ?? "floor");
    await ensureSim();
    const b = bounds();
    if (!b) throw new Error("Nothing in 3D yet.");
    let props: Prop[] = [];
    let lift = 0;
    if (preset === "table_edge") {
      const mid = (b.min.x + b.max.x) / 2;
      props = [{ type: "box", min: [b.min.x - 300, b.min.y - 200, 0], max: [mid, b.max.y + 200, 300] }];
      lift = 301;
    } else if (preset === "pedestal") {
      const r = Math.max(15, Math.min(b.max.x - b.min.x, b.max.y - b.min.y) * 0.3);
      props = [{ type: "pedestal", center: [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2], radius: Number(p.radiusMm ?? r), top: 250 }];
      lift = 251;
    } else if (preset === "hook_bar") {
      const cx = (b.min.x + b.max.x) / 2;
      const cy = (b.min.y + b.max.y) / 2;
      const along = b.max.x - b.min.x >= b.max.y - b.min.y;
      props = [along ? { type: "bar", a: [cx, b.min.y - 100, 400], b: [cx, b.max.y + 100, 400], radius: 8 } : { type: "bar", a: [b.min.x - 100, cy, 400], b: [b.max.x + 100, cy, 400], radius: 8 }];
      lift = 415;
    } else if (preset === "custom") {
      props = (p.props ?? []) as Prop[];
      lift = Number(p.liftMm ?? 0);
    }
    await setProps(props, lift);
    lastView = "3d";
    return { props, liftMm: lift };
  },
  sim_status: async () => {
    await ensureSim();
    await refreshStatus();
    return sim3d.status;
  },
  history: (p) => {
    const n = Math.max(1, Number(p.steps ?? 1));
    for (let i = 0; i < n; i++) (p.op === "redo" ? redo : undo)();
    return { done: n };
  },
};


/** Methods that change the pattern return a screenshot by default. */
const READ_ONLY = new Set(["get_state", "list_templates", "list_material_presets", "bill_of_materials", "save_project", "export", "sim_status"]);
/** Methods whose screenshot should show the 3D window or the fabric test, not the pattern. */
const NON_PATTERN = new Set(["screenshot", "view", "simulate", "sim_pin", "sim_weight", "sim_object", "sim_remove", "sim_props", "sim_status", "run_drape"]);

export async function initControl(): Promise<void> {
  await listen<{ id: number; method: string; params: Params | null }>("hw-control", async (ev) => {
    const { id, method } = ev.payload;
    const params = ev.payload.params ?? {};
    const h = handlers[method];
    if (!h) {
      await api.controlReply(id, { ok: false, error: `Unknown method ${method}` });
      return;
    }
    try {
      const result = await h(params);
      await whenComputed();
      const wantShot = method === "screenshot" || (params.screenshot ?? !READ_ONLY.has(method));
      let image: string | undefined;
      if (wantShot) {
        if (!NON_PATTERN.has(method)) { lastView = "pattern"; fitView(); }
        image = await shot(method === "screenshot" ? params.view : undefined);
      }
      const joins = state.computed?.joins ?? [];
      const bad = joins.filter((j) => !j.ok).map((j) => ({ id: j.id, message: j.message }));
      const extra = NON_PATTERN.has(method) || READ_ONLY.has(method) ? {} : { seamsMatching: `${joins.length - bad.length}/${joins.length}`, ...(bad.length ? { seamProblems: bad } : {}) };
      await api.controlReply(id, { ok: true, result: result && typeof result === "object" ? { ...(result as object), ...extra } : result, image });
    } catch (e) {
      await api.controlReply(id, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

