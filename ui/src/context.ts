// Right-click menus for everything outside the 3D and pattern windows (those have the marking
// menu in marking.ts): panel headers, toolbar and other command buttons, window strips, the
// history timeline, library items, the browser's pieces, fabrics and seams, and the property
// editor's number fields. Every row is a command from the registry or runs the same code as a
// click, so an action lives in one place. Menus use the dense menu component (menus.ts); in
// Simple mode their rows are big. Text boxes keep the system menu (cut, copy, paste).

import { showTemplates } from "./actions";
import { COMMANDS, command, type Command } from "./commands";
import { panelMenu, panelOf } from "./docks";
import { layout, setLayout } from "./layout";
import { openMenu, type Entry, type MenuItem } from "./menus";
import { openFabricTest } from "./panels";
import { simple } from "./prefs";
import { toolbarPin } from "./ribbon";
import { edit, notify, piece, selectedPieceIds, setStatus, state } from "./store";
import { sim3d } from "./view3d";

const has = (id: string) => COMMANDS.some((c) => c.id === id);
const cmds = (...ids: string[]): MenuItem[] => ids.flatMap((id): MenuItem[] => (id === "-" ? ["-"] : has(id) ? [command(id)] : []));

/** Click an element as if the user had (the same code path as a left click). */
const clickRow = (label: string, el: HTMLElement, iconName?: string, help?: string): Entry => ({ label, icon: iconName, help, run: () => el.click() });

/** Put the cursor in a property field (after the inspector redraws), e.g. to rename. */
function focusField(key: string): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`);
      if (!el) return;
      el.focus();
      el.select();
    }),
  );
}

// ---------- the browser's rows ----------

function pieceMenu(id: string): MenuItem[] {
  // Right-clicking a piece that is not selected selects it (as in Fusion's browser).
  if (!selectedPieceIds().includes(id)) {
    state.sel = { kind: "piece", piece: id };
    notify();
  }
  const many = selectedPieceIds().length > 1;
  return [
    { heading: many ? `${selectedPieceIds().length} pieces` : piece(id)?.name ?? "Piece" },
    ...(many ? [] : [{ label: "Rename", icon: "edgelength", help: "Type a new name in the properties.", run: () => { state.sel = { kind: "piece", piece: id }; notify(); focusField("pc-name"); } } as Entry]),
    ...cmds("duplicate", "mirror", "flip", "rotate", "-", many ? "align" : "size", many ? "merge" : "-", "delete"),
  ];
}

function materialMenu(id: string): MenuItem[] {
  state.sel = { kind: "material", id };
  notify();
  const m = state.project.materials.find((x) => x.id === id);
  const used = state.project.pieces.some((p) => p.materialId === id);
  return [
    { heading: m?.name ?? "Fabric" },
    { label: "Rename", icon: "edgelength", help: "Type a new name in the properties.", run: () => focusField(`mat-name-${id}`) },
    { label: "Fabric test…", icon: "fabrictest", help: "Drape a sample of this fabric and see how it hangs.", run: () => openFabricTest(id) },
    "-",
    {
      label: "Delete fabric",
      icon: "delete",
      help: used ? "Pieces still use this fabric. Give them another one first." : "Remove this fabric from the project.",
      enabled: () => !used,
      run: () => {
        edit((p) => (p.materials = p.materials.filter((x) => x.id !== id)));
        state.sel = { kind: "none" };
        notify();
      },
    },
  ];
}

function seamMenu(id: string): MenuItem[] {
  state.sel = { kind: "join", id };
  notify();
  return [{ heading: "Seam" }, ...cmds("stitchtype", "measure", "-", "delete")];
}

// ---------- command buttons, window strips, the timeline ----------

function buttonMenu(c: Command): MenuItem[] {
  const items: MenuItem[] = [c];
  const pin = simple() ? null : toolbarPin(c);
  if (pin)
    items.push({
      label: pin.pinned() ? "Take off the toolbar" : "Pin to the toolbar",
      help: pin.pinned() ? "It stays in the group's ▾ list, in the menus and in search (S)." : "Show it as a button in this toolbar group.",
      run: () => pin.toggle(),
    });
  items.push("-", ...cmds("shortcuts", simple() ? "help" : "search"));
  return items;
}

function windowMenu(w: "3d" | "pattern"): MenuItem[] {
  return [
    { heading: w === "3d" ? "3D window" : "Pattern window" },
    ...cmds("show3d", "showboth", "showpattern"),
    {
      label: w === "3d" ? "Close the 3D window" : "Close the pattern window",
      icon: "cancel",
      help: "The other window takes the room. F3 brings it back.",
      enabled: () => layout() === "both",
      run: () => {
        if (w === "3d") sim3d.running = false;
        setLayout(w === "3d" ? "pattern" : "3d");
      },
    },
    "-",
    ...(w === "3d" ? cmds("fit", "home", "simulate", "png3d") : cmds("fit", "zoomin", "zoomout", "png2d")),
  ];
}

function timelineMenu(el: HTMLElement): MenuItem[] {
  const name = el.querySelector("span")?.textContent ?? "the start";
  return [{ heading: el.classList.contains("tl-start") ? "Start" : name }, clickRow(el.classList.contains("tl-start") ? "Go back to the start" : "Go to this step", el, "undo", "Undo or redo up to just after this step."), "-", ...cmds("undo", "redo")];
}

// ---------- property fields ----------

function fieldMenu(input: HTMLInputElement | HTMLSelectElement): MenuItem[] {
  const label = input.closest(".field")?.querySelector(".field-label")?.textContent ?? "Value";
  const set = (v: string) => {
    input.value = v;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const d = input.dataset.default;
  const items: MenuItem[] = [{ heading: label }];
  if (d !== undefined) items.push({ label: `Reset to default (${d})`, icon: "reset", help: "Put back the standard value.", enabled: () => input.value !== d, run: () => set(d) });
  if (input instanceof HTMLInputElement) {
    items.push(
      { label: "Copy value", icon: "copy", help: "Copy this number.", run: () => void navigator.clipboard?.writeText(input.value).catch(() => {}) },
      {
        label: "Paste value",
        icon: "paste",
        help: "Use the number on the clipboard.",
        run: () =>
          void navigator.clipboard
            ?.readText()
            .then((t) => {
              const v = parseFloat(t);
              if (Number.isFinite(v)) set(String(v));
              else setStatus("The clipboard has no number in it.");
            })
            .catch(() => setStatus("Could not read the clipboard.")),
      },
    );
  }
  items.push("-", ...cmds("undo"));
  return items;
}

// ---------- anywhere else ----------

function generalMenu(): MenuItem[] {
  if (simple()) return [{ heading: "Hidework" }, ...cmds("undo", "-", "help", "settings", "tools")];
  return [{ heading: "Panels" }, ...cmds("librarypanel", "browserpanel", "-", "mergepanels", "panelstop", "collapsepanels", "resetpanels", "-", "search", "shortcuts", "tools")];
}

/** The menu for what was right-clicked, or null to leave the event alone. */
function menuFor(t: HTMLElement): MenuItem[] | null {
  // Text boxes keep the system menu: cut, copy, paste.
  if (t.closest("textarea, input:not([type]), input[type='text'], input[type='search'], [contenteditable='true']")) return null;
  // Dialogs and other popups have their own buttons.
  if (t.closest(".modal, .menu, .mk-overlay, .searchbox, .tooldlg, .fabric-card")) return [];
  const field = t.closest<HTMLInputElement | HTMLSelectElement>(".property-editor input[type='number'], .property-editor select");
  if (field) return fieldMenu(field);
  const head = t.closest<HTMLElement>(".panel-head");
  if (head) {
    const id = panelOf(head);
    return id && !simple() ? panelMenu(id) : generalMenu();
  }
  const btn = t.closest<HTMLElement>("[data-cmd]");
  if (btn && has(btn.dataset.cmd!)) return buttonMenu(command(btn.dataset.cmd!));
  const cap = t.closest<HTMLElement>(".tg-cap");
  if (cap) {
    cap.click();
    return [];
  }
  const win = t.closest<HTMLElement>(".win-head");
  if (win) return windowMenu(win.id === "head3d" ? "3d" : "pattern");
  const chip = t.closest<HTMLElement>(".tl-chip, .tl-start");
  if (chip) return timelineMenu(chip);
  const pc = t.closest<HTMLElement>("[data-piece]");
  if (pc) return pieceMenu(pc.dataset.piece!);
  const mat = t.closest<HTMLElement>("[data-material]");
  if (mat) return materialMenu(mat.dataset.material!);
  const seam = t.closest<HTMLElement>("[data-join]");
  if (seam) return seamMenu(seam.dataset.join!);
  const tpl = t.closest<HTMLElement>("[data-tpl]");
  if (tpl) {
    const name = tpl.querySelector("strong")?.textContent ?? "Pattern";
    return [{ heading: name }, clickRow("Open this pattern", tpl, "template", "Start a new project from it."), { label: "Show it with a picture…", icon: "catalog", help: "Open the pattern list at this pattern, with a drawing of its pieces.", run: () => void showTemplates(name) }];
  }
  const item = t.closest<HTMLElement>(".lib-item");
  if (item) return [{ heading: item.querySelector("strong")?.textContent ?? "Library" }, clickRow("Use this", item, "hardware", item.title)];
  const sec = t.closest<HTMLElement>(".lib-sec-head");
  if (sec) {
    const toggle = sec.querySelector<HTMLElement>(".lib-sec-toggle");
    const open = !sec.parentElement?.classList.contains("closed");
    if (toggle) return [{ heading: sec.querySelector(".lib-sec-title")?.textContent ?? "Section" }, clickRow(open ? "Fold this section" : "Open this section", toggle, undefined, "Show or hide the items in this section.")];
  }
  // Anywhere else in a panel: that panel's menu.
  const id = panelOf(t);
  if (id && !simple()) return panelMenu(id);
  return generalMenu();
}

export function initContextMenus(): void {
  document.addEventListener("contextmenu", (e) => {
    // The 3D and pattern windows handle their own (the marking menu).
    if (e.defaultPrevented) return;
    const t = e.target instanceof HTMLElement ? e.target : (e.target as Node | null)?.parentElement;
    if (!t) return;
    const items = menuFor(t);
    if (items === null) return;
    e.preventDefault();
    if (!items.length) return;
    openMenu(null, items, { at: { x: e.clientX, y: e.clientY }, big: simple() });
  });
}
