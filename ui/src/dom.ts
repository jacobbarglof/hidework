// Tiny DOM helpers for the panels.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function field(label: string, control: Node, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("span", { class: "field-hint" }, hint) : null);
}

export function num(key: string, value: number, commit: (v: number) => void, opts: { step?: number; min?: number; max?: number } = {}): HTMLInputElement {
  return h("input", {
    type: "number",
    value: String(value),
    step: String(opts.step ?? "any"),
    min: opts.min !== undefined ? String(opts.min) : undefined,
    max: opts.max !== undefined ? String(opts.max) : undefined,
    "data-key": key,
    onchange: (e: Event) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) commit(v);
    },
  });
}

export function text(key: string, value: string, commit: (v: string) => void): HTMLInputElement {
  return h("input", {
    type: "text",
    value,
    "data-key": key,
    onchange: (e: Event) => commit((e.target as HTMLInputElement).value),
  });
}

export function choose<T extends string>(key: string, options: [T, string][], value: T, commit: (v: T) => void): HTMLSelectElement {
  const s = h("select", { "data-key": key, onchange: (e: Event) => commit((e.target as HTMLSelectElement).value as T) });
  for (const [v, label] of options) s.append(h("option", { value: v, selected: v === value }, label));
  return s;
}

export function check(key: string, value: boolean, commit: (v: boolean) => void): HTMLInputElement {
  return h("input", { type: "checkbox", checked: value, "data-key": key, onchange: (e: Event) => commit((e.target as HTMLInputElement).checked) });
}

export function button(label: string, onclick: () => void, cls = ""): HTMLButtonElement {
  return h("button", { class: `btn ${cls}`, onclick, type: "button" }, label);
}

/** Re-render a container while keeping keyboard focus and caret on the same field. */
export function rerender(container: HTMLElement, build: () => Node[]): void {
  const active = document.activeElement as HTMLInputElement | null;
  const key = active && container.contains(active) ? active.getAttribute("data-key") : null;
  let caret: number | null = null;
  try {
    caret = key && active ? active.selectionStart : null;
  } catch {
    caret = null;
  }
  const scroll = container.scrollTop;
  container.replaceChildren(...build().filter((n): n is Node => !!n));
  container.scrollTop = scroll;
  if (key) {
    const el = container.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`);
    if (el) {
      el.focus();
      try {
        if (caret !== null) el.setSelectionRange(caret, caret);
      } catch {
        /* number inputs have no caret */
      }
    }
  }
}
