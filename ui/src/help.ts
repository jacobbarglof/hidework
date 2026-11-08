// The Shortcuts and commands dialog, generated from the command registry.

import { button, h } from "./dom";
import { icon } from "./icons";
import { SCALE_MAX, SCALE_MIN, prefs, setMode, setScale, setTheme } from "./prefs";
import type { Command, TabId } from "./commands";
import { showSteps } from "./guide";

const TAB_NAMES: Partial<Record<TabId, string>> = { file: "File", edit: "Edit", help: "Help" };

const word = (c: Command) => c.word ?? c.name.replace(/[^A-Za-z0-9]/g, "");
const keys = (c: Command) => [...(c.keys ?? []), ...(c.keyHint ? [c.keyHint] : [])];

function kbd(text: string): HTMLElement {
  return h("span", { class: "kbd" }, text);
}

export function showShortcuts(commands: Command[], tabs: { id: TabId; label: string }[]): void {
  const modal = document.getElementById("modal")!;
  const close = () => modal.classList.add("hidden");
  const filter = h("input", { type: "text", placeholder: "Find a command or key…", class: "modal-filter" }) as HTMLInputElement;
  const body = h("div", { class: "help-body" });
  const tabName = (id: TabId) => tabs.find((t) => t.id === id)?.label ?? TAB_NAMES[id] ?? id;
  const order: TabId[] = [...tabs.map((t) => t.id), "file", "edit", "help"];

  const fill = () => {
    const q = filter.value.trim().toLowerCase();
    const rows: Node[] = [];
    if (!q) {
      rows.push(
        h("div", { class: "help-intro" },
          h("p", {}, h("strong", {}, "Typing commands. "), "Type a command name anywhere (focus outside a text box) and it goes into the Command line at the bottom, like Rhino: ", kbd("Rectangle 80 50"), " ", kbd("Strap 600 25"), " ", kbd("Weight 500"), " ", kbd("Round 8"), " ", kbd("Grid 5"), " ", kbd("Units in"), " ", kbd("View pattern"), ". Lengths are in the project's units; 3in, 80mm and 8cm also work."),
          h("p", {}, kbd("↑"), kbd("↓"), " choose a match, ", kbd("Tab"), " completes, ", kbd("Enter"), " runs (", kbd("Space"), " runs a command that needs no numbers), ", kbd("Esc"), " cancels. ", kbd("Enter"), " on an empty line repeats the last command. ", kbd("↑"), " on an empty line goes back through what you typed."),
          h("p", {}, h("strong", {}, "In Simple mode "), "single letters do not act as shortcuts: typing a letter only starts the command line, and nothing depends on how fast you type. The shortcuts below with Ctrl, F-keys, Space, Delete, Esc and the arrows work in both modes."),
          h("p", {}, h("strong", {}, "With All tools, single-key shortcuts fire at once "), "(R, P, V, H, K, E, F, S, M, G, I, W, O, 0, 1, 3, 7…). To type a word that starts with one of those letters, just keep typing: a second letter within half a second that continues a command name (\"re\", \"sa\", \"ex\") switches to the command line and undoes the tool change. A letter that is not a shortcut (A, B, C, D, L, N, Q, T, U, X, Y, Z) starts the command line straight away, and so does clicking it."),
          h("p", {}, h("strong", {}, "Finding a command. "), "Press ", kbd("S"), " for a search box at the mouse: type part of a name, ", kbd("↑"), kbd("↓"), " to choose, ", kbd("Enter"), " to run. It lists the commands you used last first. With All tools, a right-click (without dragging) on a piece, an edge, a corner, a hole, empty paper or the 3D leather opens a ring of the commands that fit it, with more below. Each toolbar group's name (CREATE ▾, MODIFY ▾…) lists every command in it; the pin beside one puts it on the toolbar."),
          h("p", {}, h("strong", {}, "Mouse. "), "3D: drag the leather to pull it, Shift+drag moves a whole piece, drag empty space or right-drag to orbit, middle-drag pans, wheel zooms. 2D: right-drag or middle-drag or Space+drag pans, wheel zooms, Shift+click selects several pieces."),
        ),
      );
    }
    for (const tab of order) {
      const cmds = commands.filter((c) => c.tab === tab && (!q || `${c.name} ${word(c)} ${(c.aliases ?? []).join(" ")} ${keys(c).join(" ")} ${c.help}`.toLowerCase().includes(q)));
      if (!cmds.length) continue;
      rows.push(h("h2", {}, tabName(tab)));
      const table = h("table", { class: "report help-table" }, h("tr", {}, h("th", {}, "Command"), h("th", {}, "Type"), h("th", {}, "Keys"), h("th", {}, "What it does")));
      for (const c of cmds) {
        table.append(
          h(
            "tr",
            {},
            h("td", { class: "help-name" }, icon(c.icon, 18), h("span", {}, c.name)),
            h("td", { class: "help-word" }, word(c), c.args ? h("span", { class: "args" }, ` ${c.args}`) : null, c.aliases?.length ? h("div", { class: "aliases" }, c.aliases.join(", ")) : null),
            h("td", {}, ...keys(c).map(kbd)),
            h("td", { class: "help-desc" }, c.help),
          ),
        );
      }
      rows.push(table);
    }
    if (!rows.length) rows.push(h("p", { class: "hint" }, "Nothing matches."));
    body.replaceChildren(...rows);
  };
  filter.addEventListener("input", fill);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    e.stopPropagation();
  });
  fill();
  modal.replaceChildren(h("div", { class: "modal-card help-card" }, h("div", { class: "help-head" }, h("h2", {}, "Shortcuts and commands"), filter), body, h("div", { class: "btn-row spaced" }, h("span", { class: "hint" }, "F1 opens this list."), button("Close", close, "quiet"))));
  modal.classList.remove("hidden");
  filter.focus();
}

// ---------- plain-English help ----------

const GUIDE: [string, string[]][] = [
  ["Start a new project", [
    "Click New project. Hidework asks: What would you like to make? Click a picture, such as Wallets, then the one you want.",
    "Everything is already drawn for you: the pieces, the stitching and the holes.",
  ]],
  ["Your steps", [
    "The list on the left shows the five steps to make something: choose a pattern, change the size, check it, see it in 3D, and print it. Each step has one big button.",
    "Click Hide to put the list away. Click Help, then Show my steps, to bring it back.",
  ]],
  ["Change the size", [
    "Click Change the size. Type how wide and how tall you want the finished piece, then press Enter. Or click the − and + buttons.",
    "All the pieces change together, so the seams still match. To change just one piece, click it in the pattern first.",
  ]],
  ["See what it will look like", [
    "Click See it in 3D. The leather is folded and sewn up on screen, as if you had made it.",
    "Pick it up lets you lift it with the mouse. Put it down lets it settle. Start over puts it back as it began.",
  ]],
  ["Check before you cut", [
    "Click Check my pattern. It tells you in plain words about anything that will not fit together.",
  ]],
  ["Print the pattern", [
    "Click Print. Your PDF viewer opens. Print at Actual size (100%), not Fit to page.",
    "Measure the small test square on the first page with a ruler to make sure the size is right.",
  ]],
  ["Made a mistake?", [
    "Click Undo. You can undo many times. Redo puts it back again.",
    "After you delete or change something, an Undo button also shows at the bottom of the screen.",
  ]],
  ["Save your work", [
    "Click Save. The first time, choose a folder and a name. After that, Save keeps it up to date.",
    "Hidework also keeps a copy of your work every minute. If the computer is switched off before you save, click Pick up where you left off the next time Hidework starts.",
  ]],
  ["Make the text bigger", [
    "Click Text size, then the bigger A. Or hold Ctrl and press the + key. Ctrl and − makes it smaller.",
    "You can also choose light colours or high contrast colours there.",
  ]],
  ["More tools", [
    "Click Show all tools for every tool: drawing new pieces, sewing, hardware, tooling, exporting for a laser cutter and more.",
    "Click Simple tools to go back to the big buttons.",
  ]],
];

export function showGuide(openShortcuts: () => void): void {
  const modal = document.getElementById("modal")!;
  const close = () => modal.classList.add("hidden");
  modal.replaceChildren(
    h(
      "div",
      { class: "modal-card guide-card" },
      h("div", { class: "help-head" }, h("h2", {}, "Help"), h("span", { class: "spacer" }), button("Close", close, "quiet big")),
      h(
        "div",
        { class: "guide-body" },
        ...GUIDE.map(([title, lines]) => h("section", { class: "guide-sec" }, h("h3", {}, title), ...lines.map((l) => h("p", {}, l)))),
        h("p", { class: "guide-foot" }, "Press F1 at any time to open this help again."),
      ),
      h("div", { class: "btn-row spaced" }, button("Show my steps", () => { close(); showSteps(); }, "big"), button("All commands and keyboard shortcuts", () => { close(); openShortcuts(); }, "quiet big"), button("Close", close, "primary big")),
    ),
  );
  modal.classList.remove("hidden");
}

// ---------- text size and colours ----------

export function showSettings(): void {
  const modal = document.getElementById("modal")!;
  const close = () => modal.classList.add("hidden");
  const fill = () => {
    const pct = Math.round(prefs.scale * 100);
    const choice = (on: boolean, label: string, desc: string, act: () => void) =>
      h("button", { type: "button", class: `choice${on ? " on" : ""}`, onclick: () => { act(); fill(); } }, h("strong", {}, label), h("span", {}, desc));
    modal.replaceChildren(
      h(
        "div",
        { class: "modal-card settings-card" },
        h("h2", {}, "Text size and colours"),
        h("h3", {}, "Size of text and buttons"),
        h(
          "div",
          { class: "size-row" },
          h("button", { type: "button", class: "btn big", disabled: prefs.scale <= SCALE_MIN, onclick: () => { setScale(prefs.scale - 0.1); fill(); } }, "A  Smaller"),
          h("span", { class: "size-now" }, `${pct}%`),
          h("button", { type: "button", class: "btn big", disabled: prefs.scale >= SCALE_MAX, onclick: () => { setScale(prefs.scale + 0.1); fill(); } }, "A  Bigger"),
        ),
        h("p", { class: "hint" }, "You can also hold Ctrl and press + or −. Ctrl and 0 goes back to the usual size."),
        h("h3", {}, "Colours"),
        h(
          "div",
          { class: "choice-row" },
          choice(prefs.theme === "leather", "Leather", "Dark brown, like tooled leather", () => setTheme("leather")),
          choice(prefs.theme === "light", "Light", "Dark writing on a light page", () => setTheme("light")),
          choice(prefs.theme === "contrast", "High contrast", "White and yellow on black, easiest to read", () => setTheme("contrast")),
        ),
        h("h3", {}, "Tools"),
        h(
          "div",
          { class: "choice-row" },
          choice(prefs.mode === "simple", "Simple", "A short row of big buttons for the main jobs", () => setMode("simple")),
          choice(prefs.mode === "full", "All tools", "The full ribbon, shortcuts and typed commands", () => setMode("full")),
        ),
        h("div", { class: "btn-row spaced" }, h("span", {}), button("Done", close, "primary big")),
      ),
    );
  };
  fill();
  modal.classList.remove("hidden");
}
