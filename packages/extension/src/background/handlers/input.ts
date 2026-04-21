import type { ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";
import type { RefCache } from "../ref-cache.js";

/**
 * browser.click / type / press / scroll / hover / execute_js handlers.
 *
 * v1 coverage (plan 04 §4.3.12–4.3.18): DOM-only via
 * chrome.scripting.executeScript. No CDP attach; the richer CDP-based
 * implementations described in plan 04 are deferred until we add a
 * debugger-session manager. In practice a DOM-only path handles ~90% of
 * real pages (React/Vue/plain HTML) — the gap is sites that bind on the
 * untrusted-event flag of KeyboardEvent or require trusted MouseEvents,
 * which we accept as a known limitation for v1.
 *
 * Ref lookup contract: the parallel plan 05 task writes an a11y snapshot
 * to RefCache during browser.read(mode: "a11y_tree"). Each entry has a
 * `.selector` field which is what we feed to document.querySelector in
 * the injected world.
 */

interface InputOpts {
  tabIdMap: Map<string, number>;
  refCache: RefCache;
}

type Modifier = "Control" | "Alt" | "Shift" | "Meta";

interface ClickParams {
  tab_id: string;
  ref: number;
  button?: "left" | "middle" | "right";
  modifiers?: readonly Modifier[];
}

interface TypeParams {
  tab_id: string;
  ref: number;
  text: string;
  submit?: boolean;
  clear_first?: boolean;
}

interface PressParams {
  tab_id: string;
  keys: readonly string[];
}

interface ScrollParams {
  tab_id: string;
  direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
  amount?: number;
  ref?: number;
}

interface HoverParams {
  tab_id: string;
  ref: number;
}

interface ExecuteJsParams {
  tab_id: string;
  code: string;
  args?: readonly unknown[];
}

function codedError(code: ErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: ErrorCode };
  err.code = code;
  return err;
}

function resolveChromeId(tabIdMap: Map<string, number>, tabId: unknown): number {
  if (typeof tabId !== "string") {
    throw codedError("INVALID_PARAMS", "tab_id must be a string");
  }
  const chromeId = tabIdMap.get(tabId);
  if (chromeId === undefined) {
    throw codedError("TAB_NOT_FOUND", `unknown tab_id: ${tabId}`);
  }
  return chromeId;
}

function resolveSelector(refCache: RefCache, tabId: string, ref: number): string {
  const snap = refCache.get(tabId);
  if (snap === undefined) {
    throw codedError("REF_STALE", `no a11y snapshot for tab ${tabId}; call browser.read first`);
  }
  const entry = snap.entries.get(ref);
  if (entry === undefined) {
    throw codedError("REF_NOT_FOUND", `ref ${ref} not present in current snapshot for ${tabId}`);
  }
  return entry.selector;
}

/**
 * Run `fn` in the target tab's MAIN world and return its serialised result.
 * Throws INTERNAL when executeScript returns an empty/broken result frame.
 */
async function execInTab<A extends readonly unknown[], R>(
  chromeTabId: number,
  fn: (...args: A) => R,
  args: A,
): Promise<R> {
  const results = (await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    world: "MAIN",
    func: fn,
    args: args as unknown as unknown[],
  })) as chrome.scripting.InjectionResult[];
  if (!Array.isArray(results) || results.length === 0) {
    throw codedError("INTERNAL", "executeScript returned no frames");
  }
  const first = results[0];
  if (first === undefined) {
    throw codedError("INTERNAL", "executeScript main-frame result missing");
  }
  return first.result as R;
}

// ---------------------------------------------------------------------------
// Injected functions. These execute in the page's MAIN world and cannot
// close over module scope — every input arrives through `args`.
// ---------------------------------------------------------------------------

function injectedClick(
  selector: string,
  button: number,
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
): { found: boolean } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el === null) return { found: false };
  // Scroll into view so off-screen clicks still dispatch coordinates the
  // page can resolve; no-op if already visible.
  try {
    el.scrollIntoView({ block: "center", inline: "center" });
  } catch {
    /* ignore */
  }
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    button,
    buttons: button === 0 ? 1 : button === 1 ? 4 : 2,
    clientX: x,
    clientY: y,
    ctrlKey: modifiers.ctrl,
    altKey: modifiers.alt,
    shiftKey: modifiers.shift,
    metaKey: modifiers.meta,
  };
  el.dispatchEvent(new MouseEvent("mousedown", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  // `click()` dispatches a trusted-adjacent click that also fires form
  // submission on <button type="submit"> and toggles checkboxes — richer
  // than a bare dispatchEvent("click", ...).
  el.click();
  return { found: true };
}

function injectedType(
  selector: string,
  text: string,
  submit: boolean,
  clearFirst: boolean,
): { found: boolean; typed: number } {
  const el = document.querySelector(selector) as
    | (HTMLElement & { value?: string; form?: HTMLFormElement })
    | null;
  if (el === null) return { found: false, typed: 0 };
  el.focus();

  if (el.isContentEditable) {
    if (clearFirst) {
      const sel = window.getSelection();
      if (sel !== null) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand("delete", false);
    }
    document.execCommand("insertText", false, text);
  } else {
    if (clearFirst) {
      const selectable = el as unknown as { select?: () => void };
      selectable.select?.();
      document.execCommand("delete", false);
    }
    const proto = Object.getPrototypeOf(el) as object | null;
    const setter = proto === null
      ? undefined
      : (Object.getOwnPropertyDescriptor(proto, "value")?.set as ((v: string) => void) | undefined);
    const next = (el.value ?? "") + text;
    if (setter !== undefined) {
      setter.call(el, next);
    } else {
      el.value = next;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (submit) {
    const keyInit: KeyboardEventInit = {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", keyInit));
    el.dispatchEvent(new KeyboardEvent("keypress", keyInit));
    el.dispatchEvent(new KeyboardEvent("keyup", keyInit));
    const form = (el as { form?: HTMLFormElement }).form;
    if (form !== undefined && form !== null) {
      const submitter = form as HTMLFormElement & { requestSubmit?: () => void };
      submitter.requestSubmit?.();
    }
  }
  return { found: true, typed: text.length };
}

function injectedPress(
  key: string,
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
): void {
  const active = (document.activeElement as HTMLElement | null) ?? document.body;
  const init: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.ctrl,
    altKey: modifiers.alt,
    shiftKey: modifiers.shift,
    metaKey: modifiers.meta,
  };
  active.dispatchEvent(new KeyboardEvent("keydown", init));
  // keypress is only meaningful for printable characters; firing it
  // unconditionally is harmless — listeners that don't want it filter on key.
  if (key.length === 1) {
    active.dispatchEvent(new KeyboardEvent("keypress", init));
  }
  active.dispatchEvent(new KeyboardEvent("keyup", init));
}

function injectedScrollRef(selector: string): { found: boolean } {
  const el = document.querySelector(selector);
  if (el === null) return { found: false };
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  return { found: true };
}

function injectedScrollDir(direction: string, amount: number): void {
  const opts: ScrollToOptions = { behavior: "smooth" };
  if (direction === "up") opts.top = -amount;
  else if (direction === "down") opts.top = amount;
  else if (direction === "left") opts.left = -amount;
  else if (direction === "right") opts.left = amount;
  else if (direction === "top") {
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    return;
  } else if (direction === "bottom") {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      left: 0,
      behavior: "smooth",
    });
    return;
  }
  window.scrollBy(opts);
}

function injectedHover(selector: string): { found: boolean } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el === null) return { found: false };
  const rect = el.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  el.dispatchEvent(new MouseEvent("mouseover", init));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mousemove", init));
  return { found: true };
}

function injectedExecuteJs(code: string): {
  thrown: boolean;
  value?: unknown;
  error?: string;
} {
  try {
    // Indirect eval forces global scope, matching the "main world" intent
    // and preventing the wrapper's locals from leaking into `code`.
    const value = (0, eval)(code) as unknown;
    return { thrown: false, value };
  } catch (e) {
    return { thrown: true, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Param parsing
// ---------------------------------------------------------------------------

const MODIFIER_NAMES: readonly Modifier[] = ["Control", "Alt", "Shift", "Meta"] as const;

function parseModifiers(raw: unknown): Modifier[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw codedError("INVALID_PARAMS", "modifiers must be an array");
  }
  const out: Modifier[] = [];
  for (const m of raw) {
    if (typeof m !== "string" || !(MODIFIER_NAMES as readonly string[]).includes(m)) {
      throw codedError(
        "INVALID_PARAMS",
        `modifier must be one of ${MODIFIER_NAMES.join(", ")}`,
      );
    }
    out.push(m as Modifier);
  }
  return out;
}

function modifierFlags(mods: readonly Modifier[]): {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
} {
  return {
    ctrl: mods.includes("Control"),
    alt: mods.includes("Alt"),
    shift: mods.includes("Shift"),
    meta: mods.includes("Meta"),
  };
}

function parseClick(raw: Record<string, unknown>): ClickParams {
  const tab_id = raw["tab_id"];
  const ref = raw["ref"];
  if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
  if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
    throw codedError("INVALID_PARAMS", "ref must be a positive integer");
  }
  const button = raw["button"];
  if (button !== undefined && button !== "left" && button !== "middle" && button !== "right") {
    throw codedError("INVALID_PARAMS", "button must be left|middle|right");
  }
  return {
    tab_id,
    ref,
    button: (button as ClickParams["button"]) ?? "left",
    modifiers: parseModifiers(raw["modifiers"]),
  };
}

function parseType(raw: Record<string, unknown>): TypeParams {
  const tab_id = raw["tab_id"];
  const ref = raw["ref"];
  const text = raw["text"];
  if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
  if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
    throw codedError("INVALID_PARAMS", "ref must be a positive integer");
  }
  if (typeof text !== "string") throw codedError("INVALID_PARAMS", "text must be a string");
  const submit = raw["submit"];
  const clearFirst = raw["clear_first"];
  return {
    tab_id,
    ref,
    text,
    submit: typeof submit === "boolean" ? submit : false,
    clear_first: typeof clearFirst === "boolean" ? clearFirst : false,
  };
}

function parsePress(raw: Record<string, unknown>): PressParams {
  const tab_id = raw["tab_id"];
  const keys = raw["keys"];
  if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
  if (!Array.isArray(keys) || keys.length === 0) {
    throw codedError("INVALID_PARAMS", "keys must be a non-empty array");
  }
  for (const k of keys) {
    if (typeof k !== "string" || k.length === 0) {
      throw codedError("INVALID_PARAMS", "each key must be a non-empty string");
    }
  }
  return { tab_id, keys: keys as string[] };
}

function parseScroll(raw: Record<string, unknown>): ScrollParams {
  const tab_id = raw["tab_id"];
  if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
  const direction = raw["direction"];
  const ref = raw["ref"];
  if (direction === undefined && ref === undefined) {
    throw codedError("INVALID_PARAMS", "scroll requires either direction or ref");
  }
  if (direction !== undefined && ref !== undefined) {
    throw codedError("INVALID_PARAMS", "scroll accepts direction OR ref, not both");
  }
  const params: ScrollParams = { tab_id };
  if (direction !== undefined) {
    const allowed = ["up", "down", "left", "right", "top", "bottom"] as const;
    if (typeof direction !== "string" || !(allowed as readonly string[]).includes(direction)) {
      throw codedError(
        "INVALID_PARAMS",
        `direction must be one of ${allowed.join(", ")}`,
      );
    }
    params.direction = direction as ScrollParams["direction"];
    const amount = raw["amount"];
    if (amount !== undefined) {
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
        throw codedError("INVALID_PARAMS", "amount must be a positive integer");
      }
      params.amount = amount;
    }
  } else {
    if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
      throw codedError("INVALID_PARAMS", "ref must be a positive integer");
    }
    params.ref = ref;
  }
  return params;
}

function parseHover(raw: Record<string, unknown>): HoverParams {
  const tab_id = raw["tab_id"];
  const ref = raw["ref"];
  if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
  if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
    throw codedError("INVALID_PARAMS", "ref must be a positive integer");
  }
  return { tab_id, ref };
}

function parseExecuteJs(raw: Record<string, unknown>): ExecuteJsParams {
  const tab_id = raw["tab_id"];
  const code = raw["code"];
  if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
  if (typeof code !== "string" || code.length === 0) {
    throw codedError("INVALID_PARAMS", "code must be a non-empty string");
  }
  const args = raw["args"];
  if (args !== undefined && !Array.isArray(args)) {
    throw codedError("INVALID_PARAMS", "args must be an array");
  }
  return { tab_id, code, args: Array.isArray(args) ? (args as unknown[]) : undefined };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const BUTTON_INDEX: Record<NonNullable<ClickParams["button"]>, number> = {
  left: 0,
  middle: 1,
  right: 2,
};

export function registerInputHandlers(router: Router, opts: InputOpts): void {
  const { tabIdMap, refCache } = opts;

  router.register("browser.click", async (raw): Promise<{ clicked: true }> => {
    const params = parseClick(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    const selector = resolveSelector(refCache, params.tab_id, params.ref);
    const mods = modifierFlags(params.modifiers ?? []);
    const button = BUTTON_INDEX[params.button ?? "left"];
    const res = await execInTab(chromeId, injectedClick, [selector, button, mods] as const);
    if (res.found === false) {
      throw codedError("REF_STALE", `ref ${params.ref} no longer resolves in tab ${params.tab_id}`);
    }
    return { clicked: true };
  });

  router.register("browser.type", async (raw): Promise<{ typed: number }> => {
    const params = parseType(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    const selector = resolveSelector(refCache, params.tab_id, params.ref);
    const res = await execInTab(
      chromeId,
      injectedType,
      [selector, params.text, params.submit ?? false, params.clear_first ?? false] as const,
    );
    if (res.found === false) {
      throw codedError("REF_STALE", `ref ${params.ref} no longer resolves in tab ${params.tab_id}`);
    }
    return { typed: res.typed };
  });

  router.register("browser.press", async (raw): Promise<{ pressed: true }> => {
    const params = parsePress(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    // Partition into leading modifiers + trailing key. If the array is
    // entirely modifiers, fire the last one as the key (matches "hold Ctrl"
    // semantics for chord primitives).
    const keys = params.keys;
    const terminal = keys[keys.length - 1] ?? "";
    const mods: Modifier[] = [];
    for (let i = 0; i < keys.length - 1; i += 1) {
      const k = keys[i];
      if (k !== undefined && (MODIFIER_NAMES as readonly string[]).includes(k)) {
        mods.push(k as Modifier);
      }
    }
    await execInTab(chromeId, injectedPress, [terminal, modifierFlags(mods)] as const);
    return { pressed: true };
  });

  router.register("browser.scroll", async (raw): Promise<{ scrolled: true }> => {
    const params = parseScroll(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    if (params.ref !== undefined) {
      const selector = resolveSelector(refCache, params.tab_id, params.ref);
      const res = await execInTab(chromeId, injectedScrollRef, [selector] as const);
      if (res.found === false) {
        throw codedError(
          "REF_STALE",
          `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
        );
      }
    } else {
      const direction = params.direction ?? "down";
      const amount = params.amount ?? 600;
      await execInTab(chromeId, injectedScrollDir, [direction, amount] as const);
    }
    return { scrolled: true };
  });

  router.register("browser.hover", async (raw): Promise<{ hovered: true }> => {
    const params = parseHover(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    const selector = resolveSelector(refCache, params.tab_id, params.ref);
    const res = await execInTab(chromeId, injectedHover, [selector] as const);
    if (res.found === false) {
      throw codedError("REF_STALE", `ref ${params.ref} no longer resolves in tab ${params.tab_id}`);
    }
    return { hovered: true };
  });

  router.register("browser.execute_js", async (raw) => {
    const params = parseExecuteJs(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    // args are intentionally ignored for v1: the injected wrapper uses
    // indirect eval which has no parameter-binding site. Passing user args
    // through would require wrapping `code` in a Function(...args) body,
    // which re-introduces the string-interpolation attack surface the plan
    // explicitly wants us to avoid. Document and move on.
    const res = await execInTab(chromeId, injectedExecuteJs, [params.code] as const);
    if (res.thrown) {
      return { thrown: true, value: null, error: res.error ?? "" };
    }
    return { thrown: false, value: res.value ?? null };
  });
}
