// The 3D window in Simple mode: one big "See it in 3D" button until the piece has been made up, then
// three plain buttons, Pick it up / Put it down / Start over, instead of the simulation tools.

import { setTool3d } from "./actions";
import { runId } from "./commands";
import { h } from "./dom";
import { icon } from "./icons";
import { simple } from "./prefs";
import { notify, setStatus } from "./store";
import { resetSim, setRunning, sim3d } from "./view3d";

function big(label: string, sub: string, run: () => void): HTMLButtonElement {
  const b = h("button", { type: "button", class: "easy3d-cta" }, icon("see3d", 34), h("span", {}, h("strong", {}, label), h("small", {}, sub)));
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", run);
  return b;
}

function small(ico: string, label: string, title: string, on: boolean, run: () => void): HTMLButtonElement {
  const b = h("button", { type: "button", class: `easy3d-btn${on ? " on" : ""}`, title, "aria-pressed": String(on) }, icon(ico, 22), h("span", {}, label));
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", run);
  return b;
}

export function renderEasy3d(el: HTMLElement): void {
  const show = simple() && !sim3d.building;
  const fresh = !sim3d.running && sim3d.frames === 0;
  const holding = sim3d.tool === "move";
  const sig = show ? `${fresh}|${holding}|${sim3d.running}` : "off";
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.classList.toggle("hidden", !show);
  if (!show) {
    el.replaceChildren();
    return;
  }
  if (fresh) {
    el.replaceChildren(big("See it in 3D", "Watch it fold and settle, as if you had made it", () => runId("see3d")));
    el.className = "easy3d cta";
    return;
  }
  el.className = "easy3d bar";
  el.replaceChildren(
    small("lift", "Pick it up", "Then hold the mouse button down on the leather and move the mouse to lift it.", holding, () => {
      setTool3d("move", false);
      if (!sim3d.running) setRunning(true);
      setStatus("Hold the left mouse button down on the leather and move the mouse to lift it. Let go to put it down.");
    }),
    small("settle", "Put it down", "Let go of it and let it settle.", !holding && sim3d.running, () => {
      setTool3d("orbit", false);
      setRunning(true);
      setStatus("Settling. It stops by itself when it has come to rest.");
    }),
    small("reset", "Start over", "Put it back as it started.", false, () => {
      setTool3d("orbit", false);
      setRunning(false);
      void resetSim().then(() => {
        sim3d.frames = 0;
        setStatus("Back as it started. Click See it in 3D to watch it settle again.");
        notify();
      });
    }),
  );
}
