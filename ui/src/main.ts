import { invoke } from "@tauri-apps/api/core";
import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/cinzel-decorative/700.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/600.css";
import "./style.css";
import "./easy.css";

import { api } from "./api";
import { app, loadTemplates } from "./actions";
import { renderBrowser, renderLibrary } from "./browser";
import { fitView, initCanvas, requestDraw } from "./canvas";
import { initCommandLine, renderStatus } from "./commandline";
import { onRun, runId } from "./commands";
import { initAutosave } from "./autosave";
import { renderEasy3d } from "./easy3d";
import { initSteps, markStep, renderSteps } from "./guide";
import { openSizes } from "./sizes";
import { showWelcome } from "./welcome";
import { initControl } from "./control";
import { h } from "./dom";
import { initDrapeView, loadPresets, setDrapeVisible } from "./drape";
import { snap } from "./editing";
import { initLayout, visible } from "./layout";
import { closeFabricTest, fabricTestOpen, renderFabricTest, renderInspector } from "./panels";
import { initPrefs, prefs, simple } from "./prefs";
import { initRibbon, refreshRibbon } from "./ribbon";
import { notify, setProject, setStatus, state, subscribe, version } from "./store";
import { initView3d, needsRebuild, rebuild, sim3d } from "./view3d";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function renderHud(): void {
  const m = sim3d.status?.metrics;
  const hud = $("hud3d");
  if (!m || !sim3d.info) {
    hud.textContent = sim3d.error ? (simple() ? "The 3D view could not be made. Click Start over, or Check my pattern to find out why." : sim3d.error) : "";
    return;
  }
  if (simple()) {
    // Plain words, no forces: how to move it, and later how much it carries.
    const kg = m.capacityKg;
    hud.replaceChildren(h("span", {}, m.loadG > 0 && kg !== null ? `Strong enough for about ${kg.toFixed(1)} kg.` : "Drag the leather to pull it. Drag the background to turn round it. Roll the mouse wheel to come closer."));
    return;
  }
  if (m.loadG === 0 && m.pins === 0) {
    hud.replaceChildren(h("span", {}, "Space simulates · drag the leather to pull it · I pin · W weight · O drop an object"));
    return;
  }
  const parts = [`Load ${(m.loadG / 1000).toFixed(2)} kg`, `stitch ${m.maxStitchN.toFixed(1)}/${m.stitchCapacityN.toFixed(0)} N`];
  if (m.maxPinN > 0) parts.push(`pin ${m.maxPinN.toFixed(1)}/${m.pinCapacityN.toFixed(0)} N`);
  const spans: Node[] = [h("span", {}, parts.join(" · "))];
  if (m.capacityKg !== null) spans.push(h("span", { class: "cap" }, `  ·  carries ~${m.capacityKg.toFixed(1)} kg`));
  hud.replaceChildren(...spans);
}

let rebuildTimer: number | undefined;

function refreshChrome(): void {
  if (!state.project) return;
  renderStatus();
  const page = state.page === "a4" ? "A4" : "Letter";
  $("info").textContent = `${state.pages} ${page} page${state.pages === 1 ? "" : "s"}  ·  ${state.project.units}${snap.on ? `  ·  snap ${snap.gridMm} mm` : ""}`;
  refreshRibbon();
  renderLibrary($("library"));
  renderBrowser($("browser"));
  renderInspector($("inspector"));
  renderFabricTest($("fabric-controls"));
  setDrapeVisible(fabricTestOpen());
  renderHud();
  renderEasy3d($("easy3d"));
  renderSteps($("steps"));
  // Fit once the new project's own outlines have come back (not the previous project's).
  const fresh = !!state.computed && state.computed.pieces.length === state.project.pieces.length && state.computed.pieces.every((c, i) => c.id === state.project.pieces[i]?.id);
  if (app.firstFit && fresh) {
    app.firstFit = false;
    fitView();
  }
  // The 3D window follows the pattern live (CLO-style) when it is on screen: an edit updates the
  // model in place, keeping its current shape and position and carrying on simulating.
  if (state.computed && visible("3d") && needsRebuild() && !sim3d.building) {
    window.clearTimeout(rebuildTimer);
    const v = version;
    rebuildTimer = window.setTimeout(() => { if (v === version && visible("3d") && needsRebuild() && !sim3d.building) void rebuild(true, true); }, 350);
  }
  requestDraw();
}

function wire(): void {
  $("fabric-close").addEventListener("click", () => { closeFabricTest(); setDrapeVisible(false); });
  // Clicking the dimmed backdrop closes a dialog.
  $("modal").addEventListener("mousedown", (e) => { if (e.target === $("modal")) $("modal").classList.add("hidden"); });
}

async function main(): Promise<void> {
  // Browser preview only (npm run dev in a plain browser): stand in for the desktop backend.
  // Dead code in production builds, and skipped inside the desktop app.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) await (await import("./devmock")).installDevMock();
  initPrefs();
  initLayout();
  initCanvas($<HTMLCanvasElement>("canvas"));
  initView3d($("view3d"));
  initDrapeView($("drape-view"));
  initRibbon();
  initCommandLine();
  subscribe(refreshChrome);
  wire();
  // The checklist's buttons, and ticking steps off when their command runs from anywhere.
  initSteps((what) => (what === "welcome" ? void showWelcome() : what === "size" ? openSizes() : runId(what)));
  onRun((c) => {
    if (c.id === "check") markStep("check");
    else if (c.id === "see3d" || c.id === "simulate") markStep("see3d");
    else if (c.id === "print" || c.id === "pdf") markStep("print");
  });
  await initControl();
  await initAutosave();
  void loadTemplates().then(notify).catch(() => {});
  // Opened by double-clicking a .hidework file: show it; otherwise start with the wallet.
  const file = await invoke<string | null>("startup_file").catch(() => null);
  if (file) {
    try {
      setProject(await api.load(file), file);
    } catch (e) {
      setStatus(`Could not open ${file}: ${e}`);
      setProject(await api.fromTemplate("card-wallet"), null);
    }
  } else {
    setProject(await api.fromTemplate("card-wallet"), null);
  }
  void loadPresets().then(notify);
  setStatus(prefs.mode === "simple" ? "Welcome. Click New project to choose what to make. Help is at the top right." : "Welcome. Space simulates in 3D. Type a command (F1 for help), or pick a tool in the ribbon.");
  if (!file && prefs.welcome) void showWelcome();
}

void main();
