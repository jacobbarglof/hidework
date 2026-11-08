// Browser preview only (npm run dev): URL settings that put the chrome in a given state, for
// screenshots. Never loaded in the desktop app. Examples:
//   ?ui=full&ws=finish&sub=1           full tools, Hardware & Finish workspace, Tooling tab
//   ?ui=full&group=Create              the Create group's list open
//   ?ui=full&menu=View                 the View menu open
//   ?ui=full&search=1&q=ro             the S box with "ro" typed
//   ?ui=full&mark=piece                the marking menu over the first piece
//   ?ui=full&dlg=round                 the Round corner dialog
//   ?theme=light&scale=125             colours and text size

import { COMMANDS } from "./commands";
import { showMarking } from "./marking";
import { setMode, setScale, setTheme, type Theme } from "./prefs";
import { setTab } from "./ribbon";
import { showSearch } from "./search";
import { notify, state } from "./store";
import { invoke } from "./tooldialog";
import type { TabId } from "./commands";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runDemo(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const ui = q.get("ui");
  if (ui === "full" || ui === "simple") setMode(ui);
  const theme = q.get("theme");
  if (theme) setTheme(theme as Theme);
  const scale = q.get("scale");
  if (scale) setScale(parseInt(scale, 10) / 100);
  if (q.get("ws")) setTab(q.get("ws") as TabId);
  if (q.get("sub")) (document.querySelectorAll<HTMLButtonElement>(".rtab")[parseInt(q.get("sub")!, 10)])?.click();
  // Wait for the first pattern (and the welcome, which opens after it), then the extra wait.
  for (let i = 0; i < 100 && !(state.project && state.computed); i++) await wait(100);
  await wait(parseInt(q.get("wait") ?? "800", 10));
  if (q.get("welcome") !== "1") document.getElementById("modal")?.classList.add("hidden");
  const pc = state.project?.pieces[0];
  if (q.get("sel") === "piece" && pc) state.sel = { kind: "piece", piece: pc.id };
  if (q.get("sel") === "vertex" && pc) state.sel = { kind: "vertex", piece: pc.id, index: 1 };
  if (q.get("tool")) COMMANDS.find((c) => c.id === q.get("tool"))?.run([]);
  notify();
  const group = q.get("group");
  if (group) [...document.querySelectorAll<HTMLButtonElement>(".tg-cap")].find((b) => b.textContent?.startsWith(group))?.click();
  const menu = q.get("menu");
  if (menu) {
    [...document.querySelectorAll<HTMLButtonElement>(".mb-btn")].find((b) => b.textContent === menu)?.click();
    for (let i = 0; i < parseInt(q.get("down") ?? "0", 10); i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    if (q.get("right")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  }
  if (q.get("search")) {
    const r = document.getElementById("stage")!.getBoundingClientRect();
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: r.left + r.width * 0.35, clientY: r.top + r.height * 0.3 }));
    showSearch();
    const box = document.querySelector<HTMLInputElement>(".sx-input");
    if (box && q.get("q")) {
      box.value = q.get("q")!;
      box.dispatchEvent(new Event("input"));
    }
  }
  const mark = q.get("mark");
  if (mark) {
    const in3d = mark === "leather" || mark === "space3d";
    const r = document.getElementById(in3d ? "view3d" : "stage")!.getBoundingClientRect();
    showMarking(mark as Parameters<typeof showMarking>[0], r.left + r.width * 0.5, r.top + r.height * 0.36);
  }
  const dlg = q.get("dlg");
  if (dlg) {
    const c = COMMANDS.find((x) => x.id === dlg);
    if (c) invoke(c);
  }
}
