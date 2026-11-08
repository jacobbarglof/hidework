// The welcome: one calm question, "What would you like to make?", with big picture cards. Choosing
// a kind shows the patterns of that kind; choosing one opens it and starts the "Your steps"
// checklist. Also: pick up where you left off, start from a blank page, bring in my own pattern,
// open a saved project. It is shown when Hidework starts (unless turned off) and by New project.

import { cachedTemplates, closeModal, loadTemplates, newFrom, openFile, showModal, thumbnail, type Template } from "./actions";
import { forgetRecovery, recovery, restore, when } from "./autosave";
import { button, h } from "./dom";
import { startSteps } from "./guide";
import { icon } from "./icons";
import { openImport } from "./importer";
import { prefs, setWelcome } from "./prefs";
import { state } from "./store";

interface Kind {
  key: string;
  title: string;
  icon: string;
  pick: (t: Template) => boolean;
}

const isCard = (t: Template) => /card/i.test(t.name) && !/wallet/i.test(t.name);

const KINDS: Kind[] = [
  { key: "wallets", title: "Wallets", icon: "wallet", pick: (t) => t.category === "Wallets" && !isCard(t) },
  { key: "cards", title: "Card holders", icon: "cardholder", pick: (t) => t.category === "Wallets" && isCard(t) },
  { key: "bags", title: "Bags", icon: "bag", pick: (t) => t.category === "Bags" },
  { key: "straps", title: "Belts and straps", icon: "strap", pick: (t) => t.category === "Straps" },
  { key: "covers", title: "Covers for books and notebooks", icon: "book", pick: (t) => t.category === "Covers" },
  { key: "cases", title: "Cases and sheaths", icon: "case", pick: (t) => t.category === "Cases" || t.category === "Outdoor" },
  { key: "small", title: "Small goods", icon: "smallgoods", pick: (t) => t.category === "Small goods" },
  { key: "home", title: "For the home", icon: "homegoods", pick: (t) => t.category === "Home" },
];

/** Patterns no kind above takes (a category added later) show under "Other things". */
const other = (t: Template) => t.category !== "Start" && !KINDS.some((k) => k.pick(t));

function bringInPattern(): void {
  closeModal();
  forgetRecovery();
  openImport();
}

function card(title: string, sub: string, ico: string, onclick: () => void, extra = ""): HTMLButtonElement {
  return h("button", { type: "button", class: `wl-card${extra ? ` ${extra}` : ""}`, onclick }, h("span", { class: "wl-pic" }, icon(ico, 48)), h("span", { class: "wl-text" }, h("strong", {}, title), sub ? h("span", {}, sub) : null));
}

function plural(n: number): string {
  return `${n} pattern${n === 1 ? "" : "s"}`;
}

async function choose(id: string): Promise<void> {
  closeModal();
  const before = state.project;
  await newFrom(id);
  if (state.project !== before) {
    forgetRecovery();
    startSteps();
  }
}

function footer(): HTMLElement {
  const box = h("input", { type: "checkbox", checked: prefs.welcome, id: "wl-again", onchange: (e: Event) => setWelcome((e.target as HTMLInputElement).checked) });
  return h(
    "div",
    { class: "wl-foot" },
    h("label", { class: "wl-again" }, box, h("span", {}, "Show this when Hidework starts")),
    button("Just look around", closeModal, "quiet big"),
  );
}

function kinds(): void {
  const ts = cachedTemplates();
  const r = recovery();
  const rows: Node[] = [];
  if (r) {
    rows.push(
      card("Pick up where you left off", `${r.name}, ${r.where === "saved" ? "saved" : "kept for you"} ${when(r.at)}`, "resume", async () => {
        closeModal();
        await restore();
      }, "wl-resume"),
    );
  }
  const cards = KINDS.map((k) => {
    const list = ts.filter(k.pick);
    return list.length ? card(k.title, plural(list.length), k.icon, () => patterns(k.title, list, k.icon)) : null;
  }).filter((c): c is HTMLButtonElement => !!c);
  const rest = ts.filter(other);
  if (rest.length) cards.push(card("Other things", plural(rest.length), "assorted", () => patterns("Other things", rest, "assorted")));
  const blank = ts.find((t) => t.id === "blank");
  rows.push(
    h("div", { class: "wl-grid" }, ...cards),
    h("h3", { class: "wl-sub" }, "Or"),
    h(
      "div",
      { class: "wl-grid wl-actions" },
      card("Start from a blank page", "Draw your own pieces", "new", () => void choose(blank?.id ?? "blank")),
      card("Bring in my own pattern", "From a drawing, PDF or photo", "import", bringInPattern),
      card("Open a saved project", "One you made before", "open", () => {
        closeModal();
        forgetRecovery();
        void openFile();
      }),
    ),
  );
  if (!ts.length) rows.splice(r ? 1 : 0, 0, h("p", { class: "hint" }, "Getting the patterns ready…"));
  fill("What would you like to make?", "Click a picture. You can change the size afterwards.", rows);
}

function patterns(title: string, list: Template[], ico: string): void {
  const pics: [HTMLElement, string][] = [];
  const cards = list.map((t) => {
    const pic = h("span", { class: "wl-thumb" }, icon(ico, 44));
    pics.push([pic, t.id]);
    return h("button", { type: "button", class: "wl-tpl", onclick: () => void choose(t.id) }, pic, h("strong", {}, t.name), h("span", {}, t.description));
  });
  fill(`${title}: which one?`, "Click the one you want to make.", [h("div", { class: "wl-tpls" }, ...cards)], () => kinds());
  // Draw each pattern's real pieces into its picture, one at a time.
  void (async () => {
    for (const [pic, id] of pics) {
      const svg = await thumbnail(id);
      if (svg && pic.isConnected) pic.innerHTML = svg;
    }
  })();
}

function fill(title: string, sub: string, body: Node[], back?: () => void): void {
  const card = showModal(
    h(
      "div",
      { class: "wl-head" },
      back ? button("‹ Back", back, "quiet big wl-back") : null,
      h("div", {}, h("h1", { class: "wl-title" }, title), h("p", { class: "wl-lead" }, sub)),
    ),
    h("div", { class: "wl-body" }, ...body),
    footer(),
  );
  card.classList.add("welcome");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", title);
  (card.querySelector(".wl-card, .wl-tpl") as HTMLElement | null)?.focus({ preventScroll: true });
}

export async function showWelcome(): Promise<void> {
  kinds();
  if (!cachedTemplates().length) {
    await loadTemplates().catch(() => []);
    if (document.querySelector(".modal-card.welcome")) kinds();
  }
}
