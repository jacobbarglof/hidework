// Browser preview only. When the interface is opened in an ordinary browser (`npm run dev`, then
// http://localhost:1420) there is no Tauri backend, so every call would fail. This file stands in
// for it:
//
// - If the dev bridge is running (tools/devbridge: `cargo run --manifest-path
//   tools/devbridge/Cargo.toml`), every call goes to the real Rust core over HTTP, so patterns,
//   checks and the 3D simulation are real.
// - Otherwise calls get canned answers from devmock-data.ts (the card wallet), enough to draw the
//   pattern and the panels.
//
// main.ts imports this only when `import.meta.env.DEV` is true and window.__TAURI_INTERNALS__ is
// missing, so it never runs inside the desktop app and is left out of production builds.

import { mockIPC } from "@tauri-apps/api/mocks";
import { data } from "./devmock-data";

const BRIDGE = "http://127.0.0.1:1430/invoke/";
const BINARY = new Set(["sim_step", "sim_utilisation"]);
let bridge: boolean | null = null;
let tmpDir = "";

async function viaBridge(cmd: string, args: unknown): Promise<unknown> {
  const r = await fetch(BRIDGE + cmd, { method: "POST", body: JSON.stringify(args ?? {}), headers: { "Content-Type": "text/plain" } });
  if (!r.ok) throw await r.json().catch(() => `${cmd} failed`);
  return BINARY.has(cmd) ? r.arrayBuffer() : r.json();
}

/** Dialogs: the desktop app shows the system's own; the preview answers them itself. */
function dialog(cmd: string, a: Record<string, unknown>): unknown {
  const o = (a.options ?? a) as Record<string, unknown>;
  const text = String(o.message ?? a.message ?? "");
  // Browser dialogs would freeze automated previews, so questions are answered yes and logged.
  if (cmd.endsWith("|ask") || cmd.endsWith("|confirm")) {
    console.info(`[devmock] Asked "${text}": answered yes.`);
    return true;
  }
  if (cmd.endsWith("|message")) {
    console.info(`[devmock] Message: ${text}`);
    return "Ok";
  }
  if (cmd.endsWith("|save")) {
    // Saves land in the bridge's temporary folder; there is no file chooser in the preview.
    const name = String(o.defaultPath ?? "project.hidework").split(/[\\/]/).pop();
    return bridge && tmpDir ? `${tmpDir}${name}` : null;
  }
  return null;
}

const canned: Record<string, (a: Record<string, unknown>) => unknown> = {
  list_templates: () => data.templates,
  from_template: (a) => {
    if (a.id !== "card-wallet" && a.id !== "blank") console.info(`[devmock] ${a.id}: start the dev bridge for real templates; showing the card wallet.`);
    return structuredClone(data.project);
  },
  compute_project: () => data.computed,
  check_project: () => data.check,
  material_presets: () => data.presets,
  craft_catalogue: () => data.catalogue,
  material_stats: () => data.stats,
  bill_of_materials: () => data.bom,
  page_count: () => 2,
  startup_file: () => null,
  mcp_path: () => null,
  autosave_path: () => null,
  control_ready: () => null,
  control_reply: () => null,
};

export async function installDevMock(): Promise<void> {
  try {
    await viaBridge("list_templates", {});
    bridge = true;
    const p = (await viaBridge("autosave_path", {})) as string;
    tmpDir = p.replace(/[^\\/]*$/, "");
  } catch {
    bridge = false;
  }
  console.info(bridge ? "[devmock] Using the dev bridge on 127.0.0.1:1430 (the real core)." : "[devmock] Dev bridge not running: canned card-wallet data.");
  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd.startsWith("plugin:dialog|")) return dialog(cmd, a);
      if (cmd.startsWith("plugin:opener|")) return null;
      if (bridge) return viaBridge(cmd, a);
      const f = canned[cmd];
      if (f) return f(a);
      throw `${cmd} needs the desktop app (or the dev bridge).`;
    },
    { shouldMockEvents: true },
  );
}
