// "Your steps": a short numbered checklist that stays on screen at the top of the left side while a
// new project is made: choose a pattern, change the size, check it, see it in 3D, print it. Each
// step is one big button with a sentence of plain explanation. It never blocks anything and never
// times out; Hide puts it away and Help › Show my steps brings it back.

import { h, keepScroll } from "./dom";
import { notify } from "./store";

export type StepId = "choose" | "size" | "check" | "see3d" | "print";

interface Step {
  id: StepId;
  title: string;
  explain: string;
  button: string;
  again: string;
  /** A command id (commands.ts) or a special action. */
  run: string;
}

const STEPS: Step[] = [
  { id: "choose", title: "Choose a pattern", explain: "Pick a picture of what you want to make. Every piece, seam and hole is drawn for you.", button: "Choose a pattern", again: "Choose another", run: "welcome" },
  { id: "size", title: "Change the size", explain: "Type how wide and how tall you want it. All the pieces change together.", button: "Change the size", again: "Change it again", run: "size" },
  { id: "check", title: "Check my pattern", explain: "Hidework looks for anything that will not fit together, and tells you in plain words.", button: "Check my pattern", again: "Check again", run: "check" },
  { id: "see3d", title: "See it in 3D", explain: "See it folded and sewn up on screen, as if you had made it.", button: "See it in 3D", again: "See it again", run: "see3d" },
  { id: "print", title: "Print the pattern", explain: "Print at Actual size (100%), then measure the test square with a ruler.", button: "Print", again: "Print again", run: "print" },
];

const KEY = "hidework.steps";
const st = { open: false, done: new Set<StepId>() };

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ open: st.open, done: [...st.done] }));
  } catch {
    /* storage unavailable */
  }
}

function load(): void {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { open?: boolean; done?: StepId[] } | null;
    if (v) {
      st.open = !!v.open;
      st.done = new Set((v.done ?? []).filter((d) => STEPS.some((s) => s.id === d)));
    }
  } catch {
    /* keep the defaults */
  }
}

let runner: (what: string) => void = () => {};

/** `run` performs a step's action (wired in main.ts, to keep this file free of the commands). */
export function initSteps(run: (what: string) => void): void {
  runner = run;
  load();
}

/** A new project was chosen: start the checklist again with step 1 ticked. */
export function startSteps(): void {
  st.open = true;
  st.done = new Set(["choose"]);
  save();
  notify();
}

export function showSteps(): void {
  st.open = true;
  save();
  notify();
}

export function hideSteps(): void {
  st.open = false;
  save();
  notify();
}

export function stepsOpen(): boolean {
  return st.open;
}

export function markStep(id: StepId): void {
  if (st.done.has(id)) return;
  st.done.add(id);
  save();
  notify();
}

export function renderSteps(el: HTMLElement): void {
  el.classList.toggle("hidden", !st.open);
  if (!st.open) {
    if (el.childElementCount) el.replaceChildren();
    return;
  }
  const next = STEPS.find((s) => !st.done.has(s.id));
  const sig = `${[...st.done].join(",")}|${next?.id ?? ""}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const items = STEPS.map((s, i) => {
    const done = st.done.has(s.id);
    const isNext = s === next;
    const btn = h("button", { type: "button", class: `btn step-btn${isNext ? " primary" : ""}`, onclick: () => runner(s.run) }, done ? s.again : s.button);
    return h(
      "li",
      { class: `step${done ? " done" : ""}${isNext ? " next" : ""}` },
      h("span", { class: "step-num", "aria-hidden": "true" }, done ? "✓" : String(i + 1)),
      h(
        "div",
        { class: "step-body" },
        h("strong", {}, s.title, done ? h("span", { class: "sr-only" }, " (done)") : null),
        isNext ? h("p", {}, s.explain) : null,
        btn,
      ),
    );
  });
  keepScroll(el, () => el.replaceChildren(
    h(
      "div",
      { class: "steps-head" },
      h("h2", {}, "Your steps"),
      h("button", { type: "button", class: "btn quiet steps-hide", title: "Put the steps away. Help › Show my steps brings them back.", onclick: hideSteps }, "Hide"),
    ),
    h("ol", { class: "steps-list" }, ...items),
    ...(next ? [] : [h("p", { class: "steps-done" }, "All five steps are done. Click Hide to put this list away.")]),
  ));
}
