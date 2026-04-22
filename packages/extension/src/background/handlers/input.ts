import type { ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";
import type { RefCache } from "../ref-cache.js";
import type { CdpManager } from "../cdp.js";

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
  cdp: CdpManager;
}

type Modifier = "Control" | "Alt" | "Shift" | "Meta";
type ClickMode = "synthetic" | "trusted";

// CDP Input modifier bitmask (see Input.dispatchKeyEvent).
const CDP_MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
function cdpModifiers(mods: readonly Modifier[]): number {
  let mask = 0;
  for (const m of mods) mask |= CDP_MOD[m];
  return mask;
}
const CDP_BUTTON_NAME: Record<0 | 1 | 2, "left" | "middle" | "right"> = {
  0: "left",
  1: "middle",
  2: "right",
};
const CDP_BUTTONS_MASK: Record<0 | 1 | 2, number> = { 0: 1, 1: 4, 2: 2 };

interface ClickParams {
  tab_id: string;
  ref: number;
  button?: "left" | "middle" | "right";
  modifiers?: readonly Modifier[];
  mode?: ClickMode;
}

interface ClickAtParams {
  tab_id: string;
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  modifiers?: readonly Modifier[];
  mode?: ClickMode;
}

type TypeMode = "keystroke" | "paste" | "trusted";
const KEYSTROKE_AUTO_THRESHOLD = 64;

interface TypeParams {
  tab_id: string;
  ref: number;
  text: string;
  mode?: TypeMode;
  submit?: boolean;
  clear_first?: boolean;
  delay_ms?: number;
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
): Promise<Awaited<R>> {
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
  return first.result as Awaited<R>;
}

// ---------------------------------------------------------------------------
// Injected functions. These execute in the page's MAIN world and cannot
// close over module scope — every input arrives through `args`.
// ---------------------------------------------------------------------------

function injectedClick(
  selector: string,
  button: number,
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
): {
  found: boolean;
  occluded?: boolean;
  occluder?: { tag: string; text: string; role: string | null } | null;
  retargeted?: boolean;
} {
  const initialEl = document.querySelector(selector) as HTMLElement | null;
  if (initialEl === null) return { found: false };

  // If the selector landed on a non-interactive descendant (common with
  // React wrapping label text in spans inside a <button>), walk up to the
  // nearest interactive ancestor.
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);
  const isInteractive = (node: Element): boolean => {
    if (INTERACTIVE_TAGS.has(node.tagName)) return true;
    const role = node.getAttribute("role");
    if (role !== null && /^(button|link|menuitem|tab|switch|checkbox|radio|option)$/.test(role)) {
      return true;
    }
    if (node.getAttribute("contenteditable") === "true") return true;
    const ti = node.getAttribute("tabindex");
    if (ti !== null && Number.parseInt(ti, 10) >= 0) return true;
    return false;
  };
  let el: HTMLElement = initialEl;
  let retargeted = false;
  if (!isInteractive(el)) {
    let up: Element | null = el.parentElement;
    while (up !== null && up !== document.body) {
      if (isInteractive(up)) {
        el = up as HTMLElement;
        retargeted = true;
        break;
      }
      up = up.parentElement;
    }
  }

  try {
    el.scrollIntoView({ block: "center", inline: "center" });
  } catch {
    /* ignore */
  }

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  // Occlusion check: did the browser's hit-testing land on our target (or a
  // descendant) at this coordinate? If not, the element is covered by some
  // other layer and a real click would miss. We still dispatch the synthetic
  // sequence (some pages route events at the document level) but surface the
  // finding so the caller can decide to retry.
  const hit = document.elementFromPoint(x, y);
  let occluded = false;
  let occluder: { tag: string; text: string; role: string | null } | null = null;
  if (hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    occluded = true;
    occluder = {
      tag: hit.tagName.toLowerCase(),
      text: (hit.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      role: hit.getAttribute("role"),
    };
  }

  const baseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button,
    buttons: button === 0 ? 1 : button === 1 ? 4 : 2,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    ctrlKey: modifiers.ctrl,
    altKey: modifiers.alt,
    shiftKey: modifiers.shift,
    metaKey: modifiers.meta,
  };
  // Many modern frameworks (React synthetic pointer events, artdeco, etc.)
  // bind on pointer events, not mouse events. Include both.
  const pointerInit: PointerEventInit = {
    ...baseInit,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5,
  };

  el.dispatchEvent(new PointerEvent("pointerover", pointerInit));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...pointerInit, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mouseover", baseInit));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...baseInit, bubbles: false }));

  el.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
  el.dispatchEvent(new MouseEvent("mousedown", baseInit));

  // Focus between down and up matches native sequencing. Some handlers key
  // off document.activeElement at mouseup time.
  try {
    el.focus();
  } catch {
    /* ignore */
  }

  el.dispatchEvent(new PointerEvent("pointerup", pointerInit));
  el.dispatchEvent(new MouseEvent("mouseup", baseInit));

  // `click()` dispatches a click event with default-action side effects
  // (form submission, checkbox toggling, <a> navigation) that bare
  // dispatchEvent("click", ...) does not. Untrusted, but most React handlers
  // don't gate on isTrusted.
  el.click();

  return { found: true, occluded, occluder, retargeted };
}

/**
 * "paste" mode — bulk-assign the element's value in one shot. Fires a single
 * input + change event at the end. Best for long text where per-character
 * events would be wasteful and no per-keystroke handler cares.
 */
function injectedTypePaste(
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

  if (submit) dispatchEnterAndSubmit(el);
  return { found: true, typed: text.length };
}

/**
 * "keystroke" mode — fires a real per-character event sequence
 * (keydown → beforeinput → value mutation → input → keyup). Each event
 * carries the right `key`, `code`, and InputEvent `data`, so handlers that
 * key off individual keystrokes (search autocompletes, live validators,
 * controlled React inputs) react correctly.
 *
 * Still untrusted (isTrusted=false); for sites that gate on trusted
 * events, use mode=trusted (CDP path, v2).
 */
function injectedTypeKeystroke(
  selector: string,
  text: string,
  submit: boolean,
  clearFirst: boolean,
  delayMs: number,
): Promise<{ found: boolean; typed: number }> {
  return new Promise<{ found: boolean; typed: number }>((resolve) => {
    const el = document.querySelector(selector) as
      | (HTMLElement & { value?: string; form?: HTMLFormElement })
      | null;
    if (el === null) {
      resolve({ found: false, typed: 0 });
      return;
    }
    el.focus();

    if (clearFirst) {
      if (el.isContentEditable) {
        const sel = window.getSelection();
        if (sel !== null) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand("delete", false);
      } else {
        (el as unknown as { select?: () => void }).select?.();
        document.execCommand("delete", false);
      }
    }

    const proto = Object.getPrototypeOf(el) as object | null;
    const setter = proto === null
      ? undefined
      : (Object.getOwnPropertyDescriptor(proto, "value")?.set as ((v: string) => void) | undefined);

    const keyInitFor = (ch: string): KeyboardEventInit => {
      const isPrintable = ch.length === 1;
      const code = /^[a-zA-Z]$/.test(ch)
        ? `Key${ch.toUpperCase()}`
        : /^[0-9]$/.test(ch)
          ? `Digit${ch}`
          : ch === " "
            ? "Space"
            : "";
      return {
        key: ch,
        code,
        bubbles: true,
        cancelable: true,
        composed: true,
      } satisfies KeyboardEventInit & { [k: string]: unknown };
      // isPrintable isn't an event init; we only need it below for keypress.
      void isPrintable;
    };

    let index = 0;
    const typeOne = (): void => {
      if (index >= text.length) {
        if (submit) dispatchEnterAndSubmit(el);
        resolve({ found: true, typed: text.length });
        return;
      }
      const ch = text.charAt(index);
      const init = keyInitFor(ch);

      // keydown
      const kd = new KeyboardEvent("keydown", init);
      const kdAllowed = el.dispatchEvent(kd);

      if (kdAllowed) {
        // beforeinput — modern handlers (React 18+, Draft.js, Lexical) gate here.
        // InputEvent is supported in all target browsers (Chrome 120+).
        const beforeInput = new InputEvent("beforeinput", {
          data: ch,
          inputType: "insertText",
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        const biAllowed = el.dispatchEvent(beforeInput);

        if (biAllowed) {
          if (el.isContentEditable) {
            document.execCommand("insertText", false, ch);
          } else {
            const next = (el.value ?? "") + ch;
            if (setter !== undefined) setter.call(el, next);
            else el.value = next;
            el.dispatchEvent(
              new InputEvent("input", {
                data: ch,
                inputType: "insertText",
                bubbles: true,
                composed: true,
              }),
            );
          }
        }
      }

      // keyup — always fire, even if keydown was prevented.
      el.dispatchEvent(new KeyboardEvent("keyup", init));

      index += 1;
      if (delayMs > 0) {
        setTimeout(typeOne, delayMs);
      } else {
        typeOne();
      }
    };
    typeOne();
  });
}

function dispatchEnterAndSubmit(
  el: HTMLElement & { form?: HTMLFormElement },
): void {
  const keyInit: KeyboardEventInit = {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent("keydown", keyInit));
  el.dispatchEvent(new KeyboardEvent("keypress", keyInit));
  el.dispatchEvent(new KeyboardEvent("keyup", keyInit));
  const form = el.form;
  if (form !== undefined && form !== null) {
    const submitter = form as HTMLFormElement & { requestSubmit?: () => void };
    submitter.requestSubmit?.();
  }
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

interface ClickByTextSpec {
  text: string;
  matchMode: "exact" | "prefix" | "substring";
  roleFilter: string | null;
  caseSensitive: boolean;
  button: number;
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
}

/**
 * Find the best visible element whose accessible name matches `text` and
 * dispatch a synthetic click sequence on it. Mirrors injectedClick's dispatch
 * logic but locates the target by text rather than selector — use this when
 * the a11y walker didn't surface a ref for the target (SPA click-handler
 * divs, off-screen-rendered components, etc.).
 *
 * Scoring (higher is better):
 *   + exact name match          +100
 *   + prefix name match          +60
 *   + substring name match       +20
 *   + role matches filter        +30  (only when roleFilter is set)
 *   + interactive tag/role       +15
 *   + has an onclick / cursor:pointer signal  +10
 *   − per-100 pixels of area     −1    (prefer the leafiest match)
 * Ties break on DOM order (first wins).
 */
function injectedClickByText(spec: ClickByTextSpec): {
  found: boolean;
  matched?: { role: string; name: string; tag: string };
  occluded?: boolean;
  occluder?: { tag: string; text: string; role: string | null } | null;
} {
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "combobox",
    "listbox", "option", "menuitem", "tab", "switch", "radio",
  ]);
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);

  const normalize = (s: string): string =>
    (spec.caseSensitive ? s : s.toLowerCase()).replace(/\s+/g, " ").trim();
  const needle = normalize(spec.text);

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria !== null && aria.trim().length > 0) return aria;
    const lb = el.getAttribute("aria-labelledby");
    if (lb !== null) {
      const parts: string[] = [];
      for (const id of lb.split(/\s+/)) {
        if (id.length === 0) continue;
        const ref = document.getElementById(id);
        if (ref !== null) parts.push(ref.textContent ?? "");
      }
      const joined = parts.join(" ").trim();
      if (joined.length > 0) return joined;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt !== null && alt.length > 0) return alt;
    }
    if (tag === "input") {
      const placeholder = el.getAttribute("placeholder");
      if (placeholder !== null && placeholder.length > 0) return placeholder;
      const v = (el as HTMLInputElement).value;
      if (typeof v === "string" && v.length > 0) return v;
    }
    const title = el.getAttribute("title");
    if (title !== null && title.length > 0) return title;
    return (el.textContent ?? "").trim();
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit !== null) return explicit.toLowerCase();
    const t = el.tagName.toLowerCase();
    if (t === "a") return el.hasAttribute("href") ? "link" : "";
    if (t === "button") return "button";
    if (t === "input") return "textbox";
    if (t === "textarea") return "textbox";
    if (t === "select") return "combobox";
    return "";
  };

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity === "0") return false;
    return true;
  };

  const matchScore = (name: string): number | null => {
    const n = normalize(name);
    if (n.length === 0) return null;
    if (spec.matchMode === "exact") {
      return n === needle ? 100 : null;
    }
    if (spec.matchMode === "prefix") {
      return n.startsWith(needle) ? 60 + (n === needle ? 40 : 0) : null;
    }
    // substring
    const idx = n.indexOf(needle);
    if (idx < 0) return null;
    return n === needle ? 100 : n.startsWith(needle) ? 60 : 20;
  };

  interface Candidate {
    el: Element;
    score: number;
    name: string;
    role: string;
    tag: string;
  }

  const candidates: Candidate[] = [];
  const all = document.querySelectorAll("*");
  for (const el of Array.from(all)) {
    if (!isVisible(el)) continue;
    const name = nameOf(el);
    if (name.length === 0) continue;
    const baseScore = matchScore(name);
    if (baseScore === null) continue;
    const role = roleOf(el);
    if (spec.roleFilter !== null && role !== spec.roleFilter) continue;
    let score = baseScore;
    if (spec.roleFilter !== null && role === spec.roleFilter) score += 30;
    if (INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(el.tagName)) {
      score += 15;
    }
    if (
      el.hasAttribute("onclick") ||
      window.getComputedStyle(el).cursor === "pointer"
    ) {
      score += 10;
    }
    const rect = el.getBoundingClientRect();
    score -= Math.floor((rect.width * rect.height) / 100);
    candidates.push({
      el,
      score,
      name: name.replace(/\s+/g, " ").trim().slice(0, 120),
      role,
      tag: el.tagName.toLowerCase(),
    });
  }

  if (candidates.length === 0) return { found: false };

  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];
  if (winner === undefined) return { found: false };

  let el = winner.el as HTMLElement;

  const isInteractive = (node: Element): boolean => {
    if (INTERACTIVE_TAGS.has(node.tagName)) return true;
    const r = node.getAttribute("role");
    if (r !== null && /^(button|link|menuitem|tab|switch|checkbox|radio|option)$/.test(r)) {
      return true;
    }
    if (node.getAttribute("contenteditable") === "true") return true;
    if (node.hasAttribute("onclick")) return true;
    return window.getComputedStyle(node).cursor === "pointer";
  };
  if (!isInteractive(el)) {
    let up: Element | null = el.parentElement;
    while (up !== null && up !== document.body) {
      if (isInteractive(up)) {
        el = up as HTMLElement;
        break;
      }
      up = up.parentElement;
    }
  }

  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch { /* ignore */ }

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const hit = document.elementFromPoint(x, y);
  let occluded = false;
  let occluder: { tag: string; text: string; role: string | null } | null = null;
  if (hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    occluded = true;
    occluder = {
      tag: hit.tagName.toLowerCase(),
      text: (hit.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      role: hit.getAttribute("role"),
    };
  }

  const baseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: spec.button,
    buttons: spec.button === 0 ? 1 : spec.button === 1 ? 4 : 2,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    ctrlKey: spec.modifiers.ctrl,
    altKey: spec.modifiers.alt,
    shiftKey: spec.modifiers.shift,
    metaKey: spec.modifiers.meta,
  };
  const pointerInit: PointerEventInit = {
    ...baseInit,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5,
  };

  el.dispatchEvent(new PointerEvent("pointerover", pointerInit));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...pointerInit, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mouseover", baseInit));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...baseInit, bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
  el.dispatchEvent(new MouseEvent("mousedown", baseInit));
  try { el.focus(); } catch { /* ignore */ }
  el.dispatchEvent(new PointerEvent("pointerup", pointerInit));
  el.dispatchEvent(new MouseEvent("mouseup", baseInit));
  el.click();

  return {
    found: true,
    matched: { role: winner.role, name: winner.name, tag: winner.tag },
    occluded,
    occluder,
  };
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

function parseClickMode(raw: unknown): ClickMode | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "synthetic" && raw !== "trusted") {
    throw codedError("INVALID_PARAMS", "mode must be synthetic|trusted");
  }
  return raw;
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
  const result: ClickParams = {
    tab_id,
    ref,
    button: (button as ClickParams["button"]) ?? "left",
    modifiers: parseModifiers(raw["modifiers"]),
  };
  const mode = parseClickMode(raw["mode"]);
  if (mode !== undefined) result.mode = mode;
  return result;
}

function parseClickAt(raw: Record<string, unknown>): ClickAtParams {
  const tab_id = raw["tab_id"];
  if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
  const x = raw["x"];
  const y = raw["y"];
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) {
    throw codedError("INVALID_PARAMS", "x must be a non-negative number");
  }
  if (typeof y !== "number" || !Number.isFinite(y) || y < 0) {
    throw codedError("INVALID_PARAMS", "y must be a non-negative number");
  }
  const button = raw["button"];
  if (button !== undefined && button !== "left" && button !== "middle" && button !== "right") {
    throw codedError("INVALID_PARAMS", "button must be left|middle|right");
  }
  const mods = parseModifiers(raw["modifiers"]);
  const result: ClickAtParams = {
    tab_id,
    x,
    y,
    button: (button as ClickAtParams["button"]) ?? "left",
    modifiers: mods,
  };
  const mode = parseClickMode(raw["mode"]);
  if (mode !== undefined) result.mode = mode;
  return result;
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
  const mode = raw["mode"];
  if (mode !== undefined && mode !== "keystroke" && mode !== "paste" && mode !== "trusted") {
    throw codedError("INVALID_PARAMS", "mode must be keystroke|paste|trusted");
  }
  const submit = raw["submit"];
  const clearFirst = raw["clear_first"];
  const delay = raw["delay_ms"];
  if (delay !== undefined && (typeof delay !== "number" || !Number.isInteger(delay) || delay < 0)) {
    throw codedError("INVALID_PARAMS", "delay_ms must be a non-negative integer");
  }
  const result: TypeParams = {
    tab_id,
    ref,
    text,
    submit: typeof submit === "boolean" ? submit : false,
    clear_first: typeof clearFirst === "boolean" ? clearFirst : false,
  };
  if (mode !== undefined) result.mode = mode as TypeMode;
  if (typeof delay === "number") result.delay_ms = delay;
  return result;
}

function resolveTypeMode(text: string, explicit: TypeMode | undefined): TypeMode {
  if (explicit !== undefined) return explicit;
  return text.length <= KEYSTROKE_AUTO_THRESHOLD ? "keystroke" : "paste";
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

type FindReplaceMode = "synthetic" | "trusted";
type FindReplaceOccurrence = "first" | "all";

interface FindReplaceParams {
  tab_id: string;
  ref?: number;
  find: string;
  replace: string;
  occurrence: FindReplaceOccurrence;
  mode?: FindReplaceMode;
  case_sensitive: boolean;
}

function parseFindAndReplace(raw: Record<string, unknown>): FindReplaceParams {
  const tab_id = raw["tab_id"];
  if (typeof tab_id !== "string") {
    throw codedError("INVALID_PARAMS", "tab_id must be a string");
  }
  const find = raw["find"];
  if (typeof find !== "string" || find.length === 0 || find.length > 4096) {
    throw codedError("INVALID_PARAMS", "find must be a 1-4096 char string");
  }
  const replace = raw["replace"];
  if (typeof replace !== "string" || replace.length > 32768) {
    throw codedError("INVALID_PARAMS", "replace must be a string up to 32768 chars");
  }
  const refRaw = raw["ref"];
  let ref: number | undefined;
  if (refRaw !== undefined) {
    if (typeof refRaw !== "number" || !Number.isInteger(refRaw) || refRaw < 1) {
      throw codedError("INVALID_PARAMS", "ref must be a positive integer");
    }
    ref = refRaw;
  }
  const occurrenceRaw = raw["occurrence"];
  let occurrence: FindReplaceOccurrence = "first";
  if (occurrenceRaw !== undefined) {
    if (occurrenceRaw !== "first" && occurrenceRaw !== "all") {
      throw codedError("INVALID_PARAMS", "occurrence must be 'first' or 'all'");
    }
    occurrence = occurrenceRaw;
  }
  const modeRaw = raw["mode"];
  let mode: FindReplaceMode | undefined;
  if (modeRaw !== undefined) {
    if (modeRaw !== "synthetic" && modeRaw !== "trusted") {
      throw codedError("INVALID_PARAMS", "mode must be 'synthetic' or 'trusted'");
    }
    mode = modeRaw;
  }
  const caseRaw = raw["case_sensitive"];
  let case_sensitive = true;
  if (caseRaw !== undefined) {
    if (typeof caseRaw !== "boolean") {
      throw codedError("INVALID_PARAMS", "case_sensitive must be boolean");
    }
    case_sensitive = caseRaw;
  }
  const out: FindReplaceParams = {
    tab_id,
    find,
    replace,
    occurrence,
    case_sensitive,
  };
  if (ref !== undefined) out.ref = ref;
  if (mode !== undefined) out.mode = mode;
  return out;
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

/**
 * Resolve a selector to its viewport-centered (x, y), scrolling it into view.
 * Used by trusted-mode click; CDP's Input.dispatchMouseEvent wants coords.
 */
function injectedResolveCenter(selector: string): { found: boolean; x?: number; y?: number } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el === null) return { found: false };
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch { /* ignore */ }
  const rect = el.getBoundingClientRect();
  return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function injectedFocusSelector(selector: string): { found: boolean } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el === null) return { found: false };
  try { el.focus(); } catch { /* ignore */ }
  return { found: true };
}

/**
 * Best-effort overlay dismissal: press ESC, then if we can identify the
 * occluding element, search it (and its ancestors up to 3 levels) for a
 * close-looking control. Returns true if we believe we dismissed something.
 *
 * The close-button hunt is intentionally conservative — aria-label/title
 * containing "close" | "dismiss", or a button whose text is × / ✕ / "Close".
 * Misfires on carousels labelled "Close preview" etc. are acceptable; they
 * don't typically break the subsequent retry-click.
 */
function injectedDismissOverlay(targetSelector: string): { dismissed: boolean } {
  // 1) ESC — many modals listen for it at the document level.
  const escInit: KeyboardEventInit = {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  };
  document.dispatchEvent(new KeyboardEvent("keydown", escInit));
  document.dispatchEvent(new KeyboardEvent("keyup", escInit));

  // 2) Re-hit-test the target coordinate to find what's covering it, then
  // hunt for a close-looking control within that occluder's tree.
  const el = document.querySelector(targetSelector) as HTMLElement | null;
  if (el === null) return { dismissed: false };
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const occluder = document.elementFromPoint(x, y) as HTMLElement | null;
  if (occluder === null || occluder === el || el.contains(occluder) || occluder.contains(el)) {
    // Either no occluder, or ESC already dismissed it.
    return { dismissed: false };
  }

  const isCloseLike = (el: Element): boolean => {
    const label = (el.getAttribute("aria-label") ?? "").toLowerCase();
    if (/\b(close|dismiss)\b/.test(label)) return true;
    const title = (el.getAttribute("title") ?? "").toLowerCase();
    if (/\b(close|dismiss)\b/.test(title)) return true;
    const text = (el.textContent ?? "").replace(/\s+/g, "").toLowerCase();
    if (text === "×" || text === "✕" || text === "x" || text === "close") return true;
    return false;
  };

  // Walk ancestors up to 3 levels so we also find close controls in a
  // header sibling of the occluder.
  let scope: Element | null = occluder;
  for (let depth = 0; depth < 3 && scope !== null; depth += 1) {
    const candidates = scope.querySelectorAll("button, [role='button'], a");
    for (const c of Array.from(candidates)) {
      if (!isCloseLike(c)) continue;
      (c as HTMLElement).click();
      return { dismissed: true };
    }
    scope = scope.parentElement;
  }
  return { dismissed: false };
}

function injectedClickAtPoint(
  x: number,
  y: number,
  button: number,
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
): void {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (el === null) return;
  const baseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button,
    buttons: button === 0 ? 1 : button === 1 ? 4 : 2,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    ctrlKey: modifiers.ctrl,
    altKey: modifiers.alt,
    shiftKey: modifiers.shift,
    metaKey: modifiers.meta,
  };
  const pointerInit: PointerEventInit = {
    ...baseInit,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
  el.dispatchEvent(new MouseEvent("mousedown", baseInit));
  try { el.focus(); } catch { /* ignore */ }
  el.dispatchEvent(new PointerEvent("pointerup", pointerInit));
  el.dispatchEvent(new MouseEvent("mouseup", baseInit));
  el.click();
}

async function performTrustedClick(
  cdp: CdpManager,
  chromeTabId: number,
  x: number,
  y: number,
  button: 0 | 1 | 2,
  modifiers: readonly Modifier[],
): Promise<void> {
  const btn = CDP_BUTTON_NAME[button];
  const buttons = CDP_BUTTONS_MASK[button];
  const mods = cdpModifiers(modifiers);
  await cdp.withAttach(chromeTabId, async () => {
    await cdp.send(chromeTabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x, y,
      button: "none",
      buttons: 0,
      modifiers: mods,
    });
    await cdp.send(chromeTabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x, y,
      button: btn,
      buttons,
      clickCount: 1,
      modifiers: mods,
    });
    await cdp.send(chromeTabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x, y,
      button: btn,
      buttons: 0,
      clickCount: 1,
      modifiers: mods,
    });
  });
}

async function performTrustedType(
  cdp: CdpManager,
  chromeTabId: number,
  text: string,
  delayMs: number,
): Promise<void> {
  await cdp.withAttach(chromeTabId, async () => {
    for (const ch of text) {
      // keyDown + char + keyUp is what CDP treats as a full keystroke. The
      // "char" event with `text` is the one that actually inserts into
      // focused fields — keyDown/keyUp alone don't mutate value.
      await cdp.send(chromeTabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        text: ch.length === 1 ? ch : undefined,
        unmodifiedText: ch.length === 1 ? ch : undefined,
        key: ch,
      });
      await cdp.send(chromeTabId, "Input.dispatchKeyEvent", {
        type: "char",
        text: ch,
        unmodifiedText: ch,
        key: ch,
      });
      await cdp.send(chromeTabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: ch,
      });
      if (delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
  });
}

export function registerInputHandlers(router: Router, opts: InputOpts): void {
  const { tabIdMap, refCache, cdp } = opts;

  router.register(
    "browser.click",
    async (
      raw,
    ): Promise<{
      clicked: true;
      mode: ClickMode;
      occluded?: boolean;
      occluder?: { tag: string; text: string; role: string | null } | null;
      retargeted?: boolean;
    }> => {
      const params = parseClick(raw);
      const chromeId = resolveChromeId(tabIdMap, params.tab_id);
      const selector = resolveSelector(refCache, params.tab_id, params.ref);
      const mode: ClickMode = params.mode ?? "synthetic";
      const button = BUTTON_INDEX[params.button ?? "left"];
      const modifiers = params.modifiers ?? [];

      if (mode === "trusted") {
        const center = await execInTab(chromeId, injectedResolveCenter, [selector] as const);
        if (center.found === false || center.x === undefined || center.y === undefined) {
          throw codedError(
            "REF_STALE",
            `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
          );
        }
        await performTrustedClick(
          cdp,
          chromeId,
          center.x,
          center.y,
          button as 0 | 1 | 2,
          modifiers,
        );
        return { clicked: true, mode };
      }

      const mods = modifierFlags(modifiers);
      const dismissOverlay = raw["dismiss_overlay"] === true;
      let res = await execInTab(chromeId, injectedClick, [selector, button, mods] as const);
      if (res.found === false) {
        throw codedError(
          "REF_STALE",
          `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
        );
      }
      let dismissedOverlay = false;
      if (dismissOverlay && res.occluded === true) {
        const dismiss = await execInTab(chromeId, injectedDismissOverlay, [selector] as const);
        if (dismiss.dismissed) {
          dismissedOverlay = true;
          // One retry. If it's still occluded, surface that — the caller can
          // decide whether to escalate to trusted mode, navigate away, etc.
          res = await execInTab(chromeId, injectedClick, [selector, button, mods] as const);
          if (res.found === false) {
            throw codedError(
              "REF_STALE",
              `ref ${params.ref} became stale after overlay dismissal in tab ${params.tab_id}`,
            );
          }
        }
      }
      const result: {
        clicked: true;
        mode: ClickMode;
        dismissed_overlay?: boolean;
        occluded?: boolean;
        occluder?: { tag: string; text: string; role: string | null } | null;
        retargeted?: boolean;
      } = { clicked: true, mode };
      if (dismissedOverlay) result.dismissed_overlay = true;
      if (res.occluded === true) {
        result.occluded = true;
        result.occluder = res.occluder ?? null;
      }
      if (res.retargeted === true) result.retargeted = true;
      return result;
    },
  );

  router.register(
    "browser.click_at",
    async (
      raw,
    ): Promise<{ clicked: true; mode: ClickMode; x: number; y: number }> => {
      const params = parseClickAt(raw);
      const chromeId = resolveChromeId(tabIdMap, params.tab_id);
      const mode: ClickMode = params.mode ?? "synthetic";
      const button = BUTTON_INDEX[params.button ?? "left"];
      const modifiers = params.modifiers ?? [];
      if (mode === "trusted") {
        await performTrustedClick(
          cdp,
          chromeId,
          params.x,
          params.y,
          button as 0 | 1 | 2,
          modifiers,
        );
        return { clicked: true, mode, x: params.x, y: params.y };
      }
      // Synthetic fallback: synthesize the click via executeScript at the
      // coordinates. elementFromPoint picks the top element; we dispatch the
      // usual pointer/mouse sequence on it.
      await execInTab(
        chromeId,
        injectedClickAtPoint,
        [params.x, params.y, button, modifierFlags(modifiers)] as const,
      );
      return { clicked: true, mode, x: params.x, y: params.y };
    },
  );

  router.register(
    "browser.click_by_text",
    async (
      raw,
    ): Promise<{
      clicked: true;
      matched: { role: string; name: string; tag: string };
      occluded?: boolean;
      occluder?: { tag: string; text: string; role: string | null } | null;
    }> => {
      const tab_id = raw["tab_id"];
      const text = raw["text"];
      if (typeof tab_id !== "string") {
        throw codedError("INVALID_PARAMS", "tab_id must be a string");
      }
      if (typeof text !== "string" || text.length === 0) {
        throw codedError("INVALID_PARAMS", "text must be a non-empty string");
      }
      const match = raw["match"];
      if (
        match !== undefined &&
        match !== "exact" &&
        match !== "prefix" &&
        match !== "substring"
      ) {
        throw codedError("INVALID_PARAMS", "match must be exact|prefix|substring");
      }
      const roleRaw = raw["role"];
      if (roleRaw !== undefined && typeof roleRaw !== "string") {
        throw codedError("INVALID_PARAMS", "role must be a string");
      }
      const caseSensitive = raw["case_sensitive"] === true;
      const button = raw["button"];
      if (button !== undefined && button !== "left" && button !== "middle" && button !== "right") {
        throw codedError("INVALID_PARAMS", "button must be left|middle|right");
      }
      const mods = parseModifiers(raw["modifiers"]);
      const chromeId = resolveChromeId(tabIdMap, tab_id);
      const spec: ClickByTextSpec = {
        text,
        matchMode: (match as ClickByTextSpec["matchMode"]) ?? "substring",
        roleFilter: typeof roleRaw === "string" && roleRaw.length > 0 ? roleRaw.toLowerCase() : null,
        caseSensitive,
        button: BUTTON_INDEX[(button as ClickParams["button"]) ?? "left"],
        modifiers: modifierFlags(mods),
      };
      const res = await execInTab(chromeId, injectedClickByText, [spec] as const);
      if (res.found === false) {
        throw codedError(
          "TEXT_NOT_FOUND",
          `no visible element matched text "${text}" (${spec.matchMode}${spec.roleFilter ? `, role=${spec.roleFilter}` : ""})`,
        );
      }
      const result: {
        clicked: true;
        matched: { role: string; name: string; tag: string };
        occluded?: boolean;
        occluder?: { tag: string; text: string; role: string | null } | null;
      } = {
        clicked: true,
        matched: res.matched ?? { role: "", name: "", tag: "" },
      };
      if (res.occluded === true) {
        result.occluded = true;
        result.occluder = res.occluder ?? null;
      }
      return result;
    },
  );

  router.register(
    "browser.type",
    async (raw): Promise<{ typed: number; mode: TypeMode }> => {
      const params = parseType(raw);
      const mode = resolveTypeMode(params.text, params.mode);
      const chromeId = resolveChromeId(tabIdMap, params.tab_id);
      const selector = resolveSelector(refCache, params.tab_id, params.ref);
      const submit = params.submit ?? false;
      const clearFirst = params.clear_first ?? false;

      if (mode === "trusted") {
        // Focus the element first (via executeScript), then let CDP do the
        // trusted keystrokes at the currently-focused field. clear_first is
        // implemented via select-all + delete in the same focused context.
        const focused = await execInTab(chromeId, injectedFocusSelector, [selector] as const);
        if (focused.found === false) {
          throw codedError(
            "REF_STALE",
            `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
          );
        }
        if (clearFirst) {
          // Select-all + delete via CDP keystrokes. Meta on mac, Control elsewhere.
          // We can't easily detect platform from the SW; send both modifiers.
          await cdp.withAttach(chromeId, async () => {
            await cdp.send(chromeId, "Input.dispatchKeyEvent", {
              type: "keyDown", key: "a", text: "a",
              modifiers: CDP_MOD.Control | CDP_MOD.Meta,
            });
            await cdp.send(chromeId, "Input.dispatchKeyEvent", {
              type: "keyUp", key: "a",
              modifiers: CDP_MOD.Control | CDP_MOD.Meta,
            });
            await cdp.send(chromeId, "Input.dispatchKeyEvent", {
              type: "keyDown", key: "Delete",
            });
            await cdp.send(chromeId, "Input.dispatchKeyEvent", {
              type: "keyUp", key: "Delete",
            });
          });
        }
        await performTrustedType(cdp, chromeId, params.text, params.delay_ms ?? 0);
        if (submit) {
          await cdp.withAttach(chromeId, async () => {
            await cdp.send(chromeId, "Input.dispatchKeyEvent", {
              type: "keyDown", key: "Enter", text: "\r",
            });
            await cdp.send(chromeId, "Input.dispatchKeyEvent", {
              type: "keyUp", key: "Enter",
            });
          });
        }
        return { typed: params.text.length, mode };
      }

      let res: { found: boolean; typed: number };
      if (mode === "paste") {
        res = await execInTab(
          chromeId,
          injectedTypePaste,
          [selector, params.text, submit, clearFirst] as const,
        );
      } else {
        const delayMs = params.delay_ms ?? 0;
        res = await execInTab(
          chromeId,
          injectedTypeKeystroke,
          [selector, params.text, submit, clearFirst, delayMs] as const,
        );
      }
      if (res.found === false) {
        throw codedError("REF_STALE", `ref ${params.ref} no longer resolves in tab ${params.tab_id}`);
      }
      return { typed: res.typed, mode };
    },
  );

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

  router.register("browser.find_and_replace", async (raw) => {
    const params = parseFindAndReplace(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    // Stub: resolve tab and assert ref staleness up front so schema+wiring is
    // exercised end-to-end without touching DOM state. Full implementation
    // lands in Steps 4-7.
    if (params.ref !== undefined) {
      resolveSelector(refCache, params.tab_id, params.ref);
    }
    void chromeId;
    throw codedError(
      "INTERNAL",
      "browser.find_and_replace is not yet implemented (impl-04 Step 3 stub)",
    );
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
