// "Check my pattern": a calm side panel that looks the pattern over for anything that will go
// wrong when it is cut and made, in plain words, with "Show me" and one-click "Fix it" buttons,
// and a "Test it in 3D" section that runs the simulator for a few seconds and lists what it found.
// The checks themselves live in crates/hidework-core/src/check.rs.

import "./checker.css";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { h, keepScroll } from "./dom";
import { ensureVisible } from "./layout";
import { edit, notify, state, subscribe, undo, version, whenComputed } from "./store";
import type { Sel } from "./store";
import type { FixAction, Issue, Severity, SimFinding } from "./checktypes";
import type { Project, V } from "./types";

const panel = {
  el: null as HTMLElement | null,
  open: false,
  issues: [] as Issue[],
  checkedVersion: -1,
  busy: false,
  error: "",
  /** A line under the headline after a fix, with an Undo button. */
  notice: "",
  sim: { state: "idle" as "idle" | "running" | "done" | "missing" | "failed", findings: [] as SimFinding[], error: "" },
  timer: 0 as number | undefined,
  subscribed: false,
};

const GROUPS: { severity: Severity; title: string; blurb: string }[] = [
  { severity: "problem", title: "Problems", blurb: "These will stop the pattern going together. Fix them before you cut leather." },
  { severity: "warning", title: "Worth a look", blurb: "Probably not what you meant, or likely to make a weak or untidy job." },
  { severity: "tip", title: "Tips", blurb: "Things worth knowing. They may well be just what you intended." },
];

/** Open the checker panel (or bring it up to date if it is already open). */
export function openChecker(): void {
  if (!panel.el) {
    panel.el = h("aside", { id: "checker", class: "checker", role: "dialog", "aria-label": "Check my pattern" });
    panel.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeChecker();
      }
    });
    document.body.append(panel.el);
    // Esc closes it from anywhere, unless the user is typing in a field.
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Escape" || !panel.open || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      closeChecker();
    }, true);
  }
  if (!panel.subscribed) {
    panel.subscribed = true;
    // Re-check a moment after each edit while the panel is open.
    subscribe(() => {
      if (!panel.open || panel.busy || version === panel.checkedVersion) return;
      window.clearTimeout(panel.timer);
      panel.timer = window.setTimeout(() => void runCheck(), 400);
    });
  }
  panel.open = true;
  panel.el.classList.remove("hidden");
  panel.notice = "";
  render();
  void runCheck();
  window.setTimeout(() => panel.el?.querySelector<HTMLButtonElement>(".checker-close")?.focus(), 0);
}

function closeChecker(): void {
  panel.open = false;
  panel.el?.classList.add("hidden");
}

async function runCheck(): Promise<void> {
  if (!state.project) return;
  panel.busy = true;
  render();
  try {
    await whenComputed();
    const v = version;
    panel.issues = await api.check(state.project);
    panel.checkedVersion = v;
    panel.error = "";
  } catch (e) {
    panel.error = `The checker could not run: ${e}`;
  }
  panel.busy = false;
  render();
}

// ---------- rendering ----------

function headline(): { text: string; sub: string; good: boolean } {
  const serious = panel.issues.filter((i) => i.severity !== "tip").length;
  const tips = panel.issues.length - serious;
  if (serious === 0) {
    return {
      text: "Your pattern looks good",
      sub: tips ? `Nothing needs fixing. There ${tips === 1 ? "is 1 tip" : `are ${tips} tips`} below you may like to read.` : "Every seam matches and nothing is in the wrong place.",
      good: true,
    };
  }
  return {
    text: serious === 1 ? "1 thing to look at" : `${serious} things to look at`,
    sub: tips ? `There ${tips === 1 ? "is also 1 tip" : `are also ${tips} tips`} further down.` : "Each one says what is wrong and how to put it right.",
    good: false,
  };
}

function render(): void {
  const el = panel.el;
  if (!el || !panel.open) return;
  const scroll = el.querySelector(".checker-body")?.scrollTop ?? 0;
  const head = h(
    "div",
    { class: "checker-head" },
    h("h2", {}, "Check my pattern"),
    h("button", { type: "button", class: "checker-btn checker-close", onclick: closeChecker, "aria-label": "Close the checker" }, "Close"),
  );
  const body = h("div", { class: "checker-body" });
  if (panel.error) {
    body.append(h("p", { class: "checker-error" }, panel.error));
  } else if (panel.busy && panel.checkedVersion < 0) {
    body.append(h("p", { class: "checker-sub" }, "Looking over your pattern…"));
  } else {
    const hl = headline();
    body.append(
      h("div", { class: `checker-headline${hl.good ? " good" : ""}` }, h("div", { class: "checker-big" }, hl.text), h("p", { class: "checker-sub" }, hl.sub)),
    );
    if (panel.notice) {
      body.append(
        h(
          "div",
          { class: "checker-notice", role: "status" },
          h("span", {}, panel.notice),
          h("button", { type: "button", class: "checker-btn", onclick: () => { panel.notice = ""; undo(); } }, "Undo"),
        ),
      );
    }
    for (const g of GROUPS) {
      const list = panel.issues.filter((i) => i.severity === g.severity);
      if (!list.length) continue;
      body.append(
        h(
          "section",
          { class: `checker-group ${g.severity}` },
          h("h3", {}, `${g.title} (${list.length})`),
          h("p", { class: "checker-blurb" }, g.blurb),
          ...list.map(card),
        ),
      );
    }
  }
  body.append(simSection());
  keepScroll(el, () => el.replaceChildren(head, body));
  body.scrollTop = scroll;
}

function card(i: Issue): HTMLElement {
  const buttons: HTMLElement[] = [];
  if (i.pieceIds.length || i.joinId) buttons.push(h("button", { type: "button", class: "checker-btn", onclick: () => showMe(i) }, "Show me"));
  if (i.fixAction) buttons.push(h("button", { type: "button", class: "checker-btn primary", onclick: () => fixIt(i) }, "Fix it"));
  return h(
    "article",
    { class: `checker-card ${i.severity}` },
    h("h4", {}, i.title),
    h("p", { class: "checker-msg" }, i.message),
    h("p", { class: "checker-fix" }, h("strong", {}, "How to fix it: "), i.fix),
    buttons.length ? h("div", { class: "checker-actions" }, ...buttons) : null,
  );
}

// ---------- Show me ----------

function selectionFor(i: Issue): Sel {
  const p = state.project;
  const pid = i.pieceIds[0];
  const pc = pid ? p.pieces.find((x) => x.id === pid) : undefined;
  if (pc) {
    if (i.holeId && pc.holes.some((x) => x.id === i.holeId)) return { kind: "hole", piece: pc.id, id: i.holeId };
    if (i.hardwareId && (pc.hardware ?? []).some((x) => x.id === i.hardwareId)) return { kind: "hardware", piece: pc.id, id: i.hardwareId };
    if (i.foldId && pc.folds.some((x) => x.id === i.foldId)) return { kind: "fold", piece: pc.id, id: i.foldId };
    const e = i.edges.find((r) => r.pieceId === pc.id && r.edges.length);
    if (e && e.edges[0] < pc.edges.length) return { kind: "edge", piece: pc.id, index: e.edges[0] };
  }
  if (i.joinId && p.joins.some((j) => j.id === i.joinId)) return { kind: "join", id: i.joinId };
  if (pc) return { kind: "piece", piece: pc.id };
  return { kind: "none" };
}

function showMe(i: Issue): void {
  const sel = selectionFor(i);
  if (sel.kind === "none") {
    panel.notice = "That part is no longer in the pattern.";
    render();
    return;
  }
  ensureVisible("2d");
  state.sel = sel;
  state.status = `Showing: ${i.title}. It is highlighted in the pattern.`;
  notify();
}

// ---------- Fix it ----------

function fixIt(i: Issue): void {
  const a = i.fixAction;
  if (!a) return;
  let error = "";
  edit((p) => {
    try {
      applyFix(p, a);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  });
  panel.notice = error ? `Could not fix that: ${error}` : `Fixed: ${i.title}. If you did not want that, press Undo.`;
  state.status = error ? panel.notice : "Fixed. Press Undo (Ctrl+Z) to put it back.";
  render();
  void runCheck();
}

function pieceOf(p: Project, id: string) {
  const pc = p.pieces.find((x) => x.id === id);
  if (!pc) throw new Error("that piece is no longer in the pattern");
  return pc;
}

/** Apply a checker fix to a project. Mirrors `apply` in crates/hidework-core/src/check.rs. */
export function applyFix(p: Project, a: FixAction): void {
  switch (a.kind) {
    case "matchSeam": {
      const pc = pieceOf(p, a.pieceId);
      const mv = (q: V) => {
        if (a.axis === "x" && q.x > a.atMm) q.x += a.byMm;
        if (a.axis === "y" && q.y > a.atMm) q.y += a.byMm;
      };
      pc.vertices.forEach(mv);
      for (const e of pc.edges) {
        if (e.type === "cubic") {
          mv(e.c1);
          mv(e.c2);
        }
      }
      for (const x of pc.holes) mv(x.center);
      for (const x of pc.hardware ?? []) mv(x.at);
      for (const x of pc.marks ?? []) mv(x.center);
      for (const f of pc.folds) {
        const along = (a.axis === "x" && f.orientation === "vertical") || (a.axis === "y" && f.orientation === "horizontal");
        if (along && f.position > a.atMm) f.position += a.byMm;
      }
      return;
    }
    case "setStitchPitch":
      pieceOf(p, a.pieceId).stitch.pitchMm = a.pitchMm;
      return;
    case "setStitchMargin":
      pieceOf(p, a.pieceId).stitch.marginMm = a.marginMm;
      return;
    case "setStitched": {
      const pc = pieceOf(p, a.pieceId);
      for (const e of a.edges) if (pc.edges[e]) pc.edges[e].stitched = a.stitched;
      return;
    }
    case "setSkive": {
      const pc = pieceOf(p, a.pieceId);
      for (const e of a.edges) if (pc.edges[e]) pc.edges[e].skiveMm = a.skiveMm;
      return;
    }
    case "setTurn": {
      const pc = pieceOf(p, a.pieceId);
      for (const e of a.edges) if (pc.edges[e]) pc.edges[e].turnMm = a.turnMm;
      return;
    }
    case "setFoldContents": {
      const f = pieceOf(p, a.pieceId).folds.find((x) => x.id === a.foldId);
      if (!f) throw new Error("that fold is no longer there");
      f.contentsMm = a.contentsMm;
      return;
    }
    case "moveHole": {
      const x = pieceOf(p, a.pieceId).holes.find((y) => y.id === a.holeId);
      if (!x) throw new Error("that hole is no longer there");
      x.center = { x: a.to.x, y: a.to.y };
      return;
    }
    case "moveHardware": {
      const x = (pieceOf(p, a.pieceId).hardware ?? []).find((y) => y.id === a.hardwareId);
      if (!x) throw new Error("that hardware is no longer there");
      x.at = { x: a.to.x, y: a.to.y };
      return;
    }
    case "addHole":
      pieceOf(p, a.pieceId).holes.push(JSON.parse(JSON.stringify(a.hole)));
      return;
    case "movePiece":
      pieceOf(p, a.pieceId).position = { x: a.to.x, y: a.to.y };
      return;
    case "setGrain":
      pieceOf(p, a.pieceId).grainDeg = a.grainDeg;
      return;
    case "setMaterial":
      pieceOf(p, a.pieceId).materialId = a.materialId;
      return;
    case "setThread":
      p.thread = a.thread;
      return;
    case "removeJoin":
      p.joins = p.joins.filter((j) => j.id !== a.joinId);
      return;
  }
}

// ---------- Test it in 3D ----------

function simSection(): HTMLElement {
  const s = panel.sim;
  const running = s.state === "running";
  const out: (Node | null)[] = [
    h("h3", {}, "Test it in 3D"),
    h(
      "p",
      { class: "checker-blurb" },
      "Hidework can sew the pieces together on screen and let them settle for a few seconds, then tell you if a seam won't close, a seam is under too much strain, leather pushes through leather, the leather stretches or bunches up, hardware doesn't meet, or a bag tips over.",
    ),
    h(
      "div",
      { class: "checker-actions" },
      h("button", { type: "button", class: "checker-btn primary", disabled: running, onclick: () => void runSim() }, running ? "Testing… please wait" : s.state === "idle" ? "Run the 3D test" : "Run the 3D test again"),
    ),
  ];
  if (running) out.push(h("p", { class: "checker-sub" }, "This takes a few seconds."));
  if (s.state === "missing") out.push(h("p", { class: "checker-sub" }, "The 3D test is not available in this version of Hidework. The checks above still apply."));
  if (s.state === "failed") out.push(h("p", { class: "checker-error" }, `The 3D test could not run: ${s.error}`));
  if (s.state === "done") {
    if (!s.findings.length) {
      out.push(h("div", { class: "checker-headline good" }, h("div", { class: "checker-big" }, "Nothing went wrong in the 3D test"), h("p", { class: "checker-sub" }, "The seams closed and the pieces settled without trouble.")));
    } else {
      out.push(h("p", { class: "checker-sub" }, s.findings.length === 1 ? "The 3D test found 1 thing:" : `The 3D test found ${s.findings.length} things:`));
      for (const f of s.findings) {
        const show = f.pieceIds.find((id) => state.project.pieces.some((p) => p.id === id));
        const showBtn = show
          ? h("div", { class: "checker-actions" }, h("button", { type: "button", class: "checker-btn", onclick: () => { ensureVisible("2d"); state.sel = { kind: "piece", piece: show }; notify(); } }, "Show me"))
          : null;
        out.push(
          h(
            "article",
            { class: `checker-card ${f.severity}` },
            h("h4", {}, f.title),
            f.message ? h("p", { class: "checker-msg" }, f.message) : null,
            f.fix ? h("p", { class: "checker-fix" }, h("strong", {}, "How to fix it: "), f.fix) : null,
            showBtn,
          ),
        );
      }
    }
  }
  return h("section", { class: "checker-group sim" }, ...out);
}

async function runSim(): Promise<void> {
  panel.sim = { state: "running", findings: [], error: "" };
  render();
  try {
    await whenComputed();
    const raw = await invoke<unknown>("sim_diagnose", { project: state.project, seconds: 4 });
    panel.sim = { state: "done", findings: normalise(raw), error: "" };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    // Tauri says "command sim_diagnose not found" when this build has no 3D test.
    const missing = /not found|unknown command|does not exist|no such command|__TAURI/i.test(msg);
    panel.sim = { state: missing ? "missing" : "failed", findings: [], error: msg };
  }
  render();
}

/** Accept whatever shape the simulator's report takes: a list, or an object holding one. */
function normalise(raw: unknown): SimFinding[] {
  const obj = raw as Record<string, unknown> | null;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : obj && typeof obj === "object"
      ? ((["issues", "findings", "problems", "diagnoses", "results"].map((k) => obj[k]).find(Array.isArray) as unknown[] | undefined) ?? [])
      : [];
  const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  const sev = (v: unknown): Severity => {
    const s = str(v).toLowerCase();
    if (/problem|error|critical|fail|severe|high/.test(s)) return "problem";
    if (/tip|info|note|low/.test(s)) return "tip";
    return "warning";
  };
  return list.map((it): SimFinding => {
    if (typeof it === "string") return { severity: "warning", title: it, message: "", fix: "", pieceIds: [] };
    const o = (it ?? {}) as Record<string, unknown>;
    const ids: unknown[] = Array.isArray(o.pieceIds) ? o.pieceIds : Array.isArray(o.pieces) ? o.pieces : o.pieceId ? [o.pieceId] : [];
    return {
      severity: sev(o.severity ?? o.level ?? o.kind),
      title: str(o.title ?? o.summary ?? o.name ?? o.kind) || "Something went wrong in the 3D test",
      message: str(o.message ?? o.detail ?? o.description ?? o.text),
      fix: str(o.fix ?? o.advice ?? o.suggestion ?? o.remedy),
      pieceIds: ids.map(str).filter(Boolean),
    };
  });
}
