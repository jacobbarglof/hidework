// Window layout: the 3D window only, the pattern window only, or both side by side with a
// draggable splitter. Also tracks which window the mouse is over, so zoom keys act on it.

import { notify, setStatus } from "./store";

export type Layout = "3d" | "both" | "pattern";

const KEY = "hidework.layout";
let current: Layout = "both";
/** The window under the mouse (or the last one it was over). */
export let hovered: "3d" | "2d" = "2d";

function load(): Layout {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "3d" || v === "both" || v === "pattern") return v;
  } catch {
    /* storage unavailable */
  }
  return "both";
}

export function layout(): Layout {
  return current;
}

/** Re-lay out the canvases after the windows change size. */
export function relayout(): void {
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

export function setLayout(l: Layout, quiet = false): void {
  current = l;
  const ws = document.getElementById("workspace");
  if (ws) {
    ws.classList.toggle("layout-3d", l === "3d");
    ws.classList.toggle("layout-pattern", l === "pattern");
    ws.classList.toggle("layout-both", l === "both");
  }
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* storage unavailable */
  }
  relayout();
  if (!quiet) setStatus(l === "3d" ? "3D window only. F3 shows both." : l === "pattern" ? "Pattern window only. F3 shows both." : "3D and pattern side by side.");
  else notify();
}

/** Make sure a window is on screen before a tool that needs it starts. */
export function ensureVisible(w: "3d" | "2d"): void {
  if ((w === "3d" && current === "pattern") || (w === "2d" && current === "3d")) setLayout("both", true);
}

export function visible(w: "3d" | "2d"): boolean {
  return w === "3d" ? current !== "pattern" : current !== "3d";
}

export function initLayout(): void {
  setLayout(load(), true);
  const w3 = document.querySelector<HTMLElement>(".w3d")!;
  const w2 = document.querySelector<HTMLElement>(".w2d")!;
  w3.addEventListener("pointerenter", () => (hovered = "3d"));
  w2.addEventListener("pointerenter", () => (hovered = "2d"));
  // Splitter between the 3D and 2D windows.
  const split = document.getElementById("splitter")!;
  split.addEventListener("pointerdown", (e) => {
    split.setPointerCapture(e.pointerId);
    const total = w3.getBoundingClientRect().width + w2.getBoundingClientRect().width;
    const left = w3.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => {
      const f = Math.min(0.85, Math.max(0.15, (ev.clientX - left) / total));
      // Proportional, so the split holds when the app window is resized.
      w3.style.flex = `${f} 1 0`;
      w2.style.flex = `${1 - f} 1 0`;
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", () => { split.removeEventListener("pointermove", move); relayout(); }, { once: true });
  });
  // Double-click the splitter: back to an even split.
  split.addEventListener("dblclick", () => {
    w3.style.flex = "";
    w2.style.flex = "";
    relayout();
  });
}
