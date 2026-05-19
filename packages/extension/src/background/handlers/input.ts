import type { Effect, ErrorCode, PageEffect } from "@browserops/shared";
import { isDestructiveChord } from "@browserops/shared";
import type { Router } from "../router.js";
import type { RefCache } from "../ref-cache.js";
import type { CdpManager } from "../cdp.js";
import type { NetworkTracker } from "../network-tracker.js";
import { withEffectObservation, checkEffectExpectation } from "./effects.js";
import { captureEffect } from "../effect.js";
import { resolveKey } from "./key-resolver.js";

type ExpectEffect = "any" | "dom" | "navigation" | "none";

function parseExpectEffect(raw: unknown): ExpectEffect | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "any" && raw !== "dom" && raw !== "navigation" && raw !== "none") {
    throw Object.assign(new Error("expect_effect must be any|dom|navigation|none"), { code: "INVALID_PARAMS" as ErrorCode });
  }
  return raw;
}

/**
 * browser_click / type / press / scroll / hover / click_by_text /
 * execute_js handlers.
 *
 * Dispatch model: CDP-trusted is the default. Every http(s) tab gets
 * persistent chrome.debugger attached (see CdpManager.autoAttachAlways
 * + the call site in handlers/navigation.ts). When cdp.isPersistent
 * returns true for a tab, click/type/press/hover/click_by_text dispatch
 * via Input.dispatchMouseEvent / Input.insertText / Input.dispatchKeyEvent
 * — trusted compositor events that traverse iframes, shadow DOM, and
 * isTrusted-gated handlers (Slack, Discord, Linear, Notion, Gmail, …).
 *
 * Synthetic dispatch (DOM events via chrome.scripting.executeScript)
 * remains as the fallback for non-http URLs and tabs the user opted
 * out via browser_set_cdp(tab_id, false). browser_execute_js still
 * runs through CDP Runtime.evaluate to bypass Trusted Types CSP.
 *
 * Ref lookup contract: browser_read(mode: "a11y_tree") populates RefCache.
 * Each entry has a `.selector` field used by document.querySelector in
 * the injected world; the CDP path then reads the element's center via
 * injectedElementCenter and dispatches at those viewport coords.
 */

interface InputOpts {
  tabIdMap: Map<string, number>;
  refCache: RefCache;
  cdp: CdpManager;
  network: NetworkTracker;
}

type Modifier = "Control" | "Alt" | "Shift" | "Meta";
/**
 * Accepted on input; `Primary` is a logical alias resolved at dispatch time
 * to either Meta (macOS) or Control (elsewhere) so chords are portable.
 */
type ModifierInput = Modifier | "Primary";
// Platform detection for the Primary alias. navigator.userAgentData.platform
// is the modern signal and returns "macOS" / "Windows" / "Linux"; fall back
// to the legacy navigator.platform string when it's not available (Firefox,
// older Chrome). The extension background service worker has a real
// navigator, so this reflects the user's OS.
function isMacPlatform(): boolean {
  const uaData = (navigator as unknown as {
    userAgentData?: { platform?: string };
  }).userAgentData;
  if (uaData?.platform) return /mac/i.test(uaData.platform);
  return /mac/i.test(navigator.platform);
}
const PRIMARY_RESOLVES_TO: Modifier = isMacPlatform() ? "Meta" : "Control";

function resolvePrimary(mods: readonly ModifierInput[]): Modifier[] {
  // Dedupe: Primary on mac is Meta, so [Primary, Meta] collapses to [Meta].
  const out = new Set<Modifier>();
  for (const m of mods) {
    out.add(m === "Primary" ? PRIMARY_RESOLVES_TO : m);
  }
  return [...out];
}

interface ClickParams {
  tab_id: string;
  ref: number;
  button?: "left" | "middle" | "right";
  modifiers?: readonly Modifier[];
  observe_effects?: boolean;
  expect_effect?: ExpectEffect;
}

interface ClickAtParams {
  tab_id: string;
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  modifiers?: readonly Modifier[];
}

type TypeMode = "keystroke" | "paste";
type ClearMode = "value" | "select_all" | "auto";
const KEYSTROKE_AUTO_THRESHOLD = 64;

interface TypeParams {
  tab_id: string;
  ref: number;
  text: string;
  mode?: TypeMode;
  submit?: boolean;
  clear_mode?: ClearMode;
  delay_ms?: number;
  observe_effects?: boolean;
  expect_effect?: ExpectEffect;
}

interface PressParams {
  tab_id: string;
  keys: readonly string[];
  observe_effects?: boolean;
  expect_effect?: ExpectEffect;
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

interface ErrorHints {
  next_action?: string;
  diagnostic?: Record<string, unknown>;
}

function codedError(code: ErrorCode, message: string, hints?: ErrorHints): Error {
  const err = new Error(message) as Error & {
    code: ErrorCode;
    next_action?: string;
    diagnostic?: Record<string, unknown>;
  };
  err.code = code;
  if (hints?.next_action !== undefined) err.next_action = hints.next_action;
  if (hints?.diagnostic !== undefined) err.diagnostic = hints.diagnostic;
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

interface ResolvedRef {
  selector: string;
  role: string;
}

function resolveRef(refCache: RefCache, tabId: string, ref: number): ResolvedRef {
  const snap = refCache.get(tabId);
  if (snap === undefined) {
    throw codedError(
      "REF_STALE",
      `no a11y snapshot for tab ${tabId}; call browser_read first`,
      {
        next_action:
          "no a11y snapshot exists — call browser_quick_read or browser_read first to populate refs, then retry the action",
        diagnostic: { tab_id: tabId, ref, snapshot_present: false },
      },
    );
  }
  const entry = snap.entries.get(ref);
  if (entry === undefined) {
    throw codedError(
      "REF_NOT_FOUND",
      `ref ${ref} not present in current snapshot for ${tabId}`,
      {
        next_action:
          "element ref is stale — call browser_quick_read again to get a fresh ref, do not reuse the old one",
        diagnostic: {
          tab_id: tabId,
          ref,
          snapshot_url: snap.url,
          snapshot_size: snap.entries.size,
        },
      },
    );
  }
  return { selector: entry.selector, role: entry.role };
}

function resolveSelector(refCache: RefCache, tabId: string, ref: number): string {
  return resolveRef(refCache, tabId, ref).selector;
}

/**
 * Run `fn` in the target tab's MAIN world and return its serialised result.
 * Throws INTERNAL when executeScript returns an empty/broken result frame.
 */
export async function execInTab<A extends readonly unknown[], R>(
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
// CDP Input dispatch helpers (used when a tab has persistent CDP attachment)
// ---------------------------------------------------------------------------

function cdpModBits(mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }): number {
  return (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
}

async function cdpClick(
  cdp: CdpManager, chromeId: number,
  x: number, y: number,
  button: "left" | "middle" | "right",
  mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
): Promise<void> {
  const m = cdpModBits(mods);
  await cdp.send(chromeId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button, clickCount: 1, modifiers: m,
  });
  await cdp.send(chromeId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button, clickCount: 1, modifiers: m,
  });
}

async function cdpType(cdp: CdpManager, chromeId: number, text: string): Promise<void> {
  await cdp.send(chromeId, "Input.insertText", { text });
}

async function cdpPress(
  cdp: CdpManager, chromeId: number,
  token: string,
  mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
): Promise<void> {
  const k = resolveKey(token);
  const m = cdpModBits(mods);
  // Always send key + code + windowsVirtualKeyCode + nativeVirtualKeyCode.
  // CDP does not auto-fill the VK codes from `key` alone — legacy editors
  // (Quill / Sheets formula bar / ProseMirror) that gate on
  // `event.keyCode === 13` would see 0 and bail. text is emitted on
  // keyDown only for printables, and only when no chord modifier is set
  // so Cmd+A doesn't accidentally also insert the character "a".
  const downParams: Record<string, unknown> = {
    type: "keyDown",
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vkCode,
    nativeVirtualKeyCode: k.vkCode,
    modifiers: m,
  };
  if (k.text !== undefined && !mods.ctrl && !mods.meta) {
    downParams["text"] = k.text;
  }
  await cdp.send(chromeId, "Input.dispatchKeyEvent", downParams);
  await cdp.send(chromeId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vkCode,
    nativeVirtualKeyCode: k.vkCode,
    modifiers: m,
  });
}

async function cdpHover(
  cdp: CdpManager, chromeId: number,
  x: number, y: number,
): Promise<void> {
  // Two-stage move. Chrome's input pipeline tracks the last mouse position;
  // when a prior click landed at the same (x, y) the compositor sees the
  // follow-up mouseMoved as a zero-delta no-op and does not dispatch new
  // mouseover/mouseenter DOM events. React derives onMouseEnter from
  // native mouseenter, which only fires on an outside-to-inside transition
  // — so hover-gated UIs (Slack message-action toolbar, GitHub tooltip
  // stacks, Linear sidebar peek) silently fail. Moving to (0, 0) first
  // forces a position transition; the second move into (x, y) then
  // generates the trusted mouseover/mouseenter pair.
  await cdp.send(chromeId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: 0, y: 0, button: "none", modifiers: 0,
  });
  await cdp.send(chromeId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", modifiers: 0,
  });
}

/** Scroll an element into view and return its viewport center. MAIN world. */
function injectedElementCenter(selector: string): { x: number; y: number } | null {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el === null) return null;
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch { /* ignore */ }
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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
 * Clear the element's current value/content. Three strategies:
 *
 *   "value"      — el.value = ""  (fast, but silently no-ops on
 *                  contenteditable — docs flag this as the opt-in behaviour).
 *   "select_all" — range-select or .select() + execCommand("delete"), falling
 *                  back to keyboard Delete/Backspace events if content
 *                  remains.
 *   "auto"       — "value" for form inputs, "select_all" for contenteditable.
 *                  Verifies emptiness afterwards and retries with the
 *                  select_all+keyboard path if content remains.
 *
 * Returns { found, cleared } where `cleared` is true only if the element
 * appears empty at the end.
 */
function injectedClearField(
  selector: string,
  clearMode: string,
): { found: boolean; cleared: boolean } {
  const root = document.querySelector(selector) as
    | (HTMLElement & { value?: string })
    | null;
  if (root === null) return { found: false, cleared: false };
  // Drill through role="textbox" wrappers (Slack Quill, Notion ProseMirror,
  // Linear Lexical, Gmail Draft.js): the resolved element often isn't itself
  // contenteditable and has no native value setter, so .value = "" would be a
  // silent no-op on a plain <div>. Prefer the nearest descendant editor.
  const elProto = Object.getPrototypeOf(root) as object | null;
  const rootHasValueSetter = elProto !== null
    && Object.getOwnPropertyDescriptor(elProto, "value")?.set !== undefined;
  const inner = root.isContentEditable || rootHasValueSetter
    ? null
    : root.querySelector<HTMLElement & { value?: string }>(
        '[contenteditable="true"], [contenteditable=""], .ql-editor, [data-slate-editor="true"], .ProseMirror, .public-DraftEditor-content',
      );
  const el = (inner ?? root) as HTMLElement & { value?: string };
  try { el.focus(); } catch { /* ignore */ }

  const isCE = el.isContentEditable;

  function currentContent(): string {
    if (isCE) return (el!.textContent ?? "").trim();
    return ((el as { value?: string }).value ?? "").trim();
  }

  function assignValue(): void {
    if (isCE) return;
    const proto = Object.getPrototypeOf(el as object) as object | null;
    const setter = proto === null
      ? undefined
      : (Object.getOwnPropertyDescriptor(proto, "value")?.set as
          | ((v: string) => void)
          | undefined);
    if (setter !== undefined) setter.call(el, "");
    else (el as { value?: string }).value = "";
    el!.dispatchEvent(new Event("input", { bubbles: true }));
    el!.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function selectAllAndDelete(): void {
    if (isCE) {
      const sel = window.getSelection();
      if (sel !== null) {
        const range = document.createRange();
        range.selectNodeContents(el as Node);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand("delete", false);
    } else {
      (el as unknown as { select?: () => void }).select?.();
      document.execCommand("delete", false);
    }
  }

  function keyboardDelete(): void {
    // Real key events at the focused element. Some rich editors (Monaco,
    // CodeMirror, ProseMirror) handle Delete via keydown listeners rather
    // than execCommand, so this is the last-resort fallback.
    for (const key of ["Delete", "Backspace"]) {
      el!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      el!.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    }
  }

  if (clearMode === "value") {
    assignValue();
  } else if (clearMode === "select_all") {
    selectAllAndDelete();
    if (currentContent() !== "") keyboardDelete();
  } else {
    // auto
    if (isCE) selectAllAndDelete();
    else assignValue();
    if (currentContent() !== "") {
      selectAllAndDelete();
      if (currentContent() !== "") keyboardDelete();
    }
  }

  return { found: true, cleared: currentContent() === "" };
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
): { found: boolean; typed: number; reflected: number; content_verified: boolean } {
  const root = document.querySelector(selector) as
    | (HTMLElement & { value?: string; form?: HTMLFormElement })
    | null;
  if (root === null) return { found: false, typed: 0, reflected: 0, content_verified: false };
  // Drill into wrapper role="textbox" nodes (Slack Quill, Notion ProseMirror,
  // Linear Lexical, Gmail Draft.js) so we hit the real contenteditable instead
  // of silently no-op'ing a .value assignment on a plain <div>.
  const rootProto = Object.getPrototypeOf(root) as object | null;
  const rootHasValueSetter = rootProto !== null
    && Object.getOwnPropertyDescriptor(rootProto, "value")?.set !== undefined;
  const inner = root.isContentEditable || rootHasValueSetter
    ? null
    : root.querySelector<HTMLElement & { value?: string; form?: HTMLFormElement }>(
        '[contenteditable="true"], [contenteditable=""], .ql-editor, [data-slate-editor="true"], .ProseMirror, .public-DraftEditor-content',
      );
  const el = (inner ?? root) as HTMLElement & { value?: string; form?: HTMLFormElement };
  el.focus();

  const before = el.isContentEditable ? (el.textContent ?? "") : (el.value ?? "");
  if (el.isContentEditable) {
    document.execCommand("insertText", false, text);
  } else {
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
  const after = el.isContentEditable ? (el.textContent ?? "") : (el.value ?? "");
  const lengthDelta = Math.max(0, after.length - before.length);
  const contentPresent = text.length > 0 && after.includes(text);
  return { found: true, typed: text.length, reflected: contentPresent ? text.length : lengthDelta, content_verified: contentPresent };
}

/**
 * "keystroke" mode — fires a real per-character event sequence
 * (keydown → beforeinput → value mutation → input → keyup). Each event
 * carries the right `key`, `code`, and InputEvent `data`, so handlers that
 * key off individual keystrokes (search autocompletes, live validators,
 * controlled React inputs) react correctly.
 *
 * Still untrusted (isTrusted=false).
 */
function injectedTypeKeystroke(
  selector: string,
  text: string,
  submit: boolean,
  delayMs: number,
): Promise<{ found: boolean; typed: number; reflected: number; content_verified: boolean }> {
  return new Promise<{ found: boolean; typed: number; reflected: number; content_verified: boolean }>((resolve) => {
    const root = document.querySelector(selector) as
      | (HTMLElement & { value?: string; form?: HTMLFormElement })
      | null;
    if (root === null) {
      resolve({ found: false, typed: 0, reflected: 0, content_verified: false });
      return;
    }
    // Drill past role="textbox" wrappers into the real editor so we don't fire
    // per-char events at a plain <div> that no framework is listening to.
    const rootProto = Object.getPrototypeOf(root) as object | null;
    const rootHasValueSetter = rootProto !== null
      && Object.getOwnPropertyDescriptor(rootProto, "value")?.set !== undefined;
    const inner = root.isContentEditable || rootHasValueSetter
      ? null
      : root.querySelector<HTMLElement & { value?: string; form?: HTMLFormElement }>(
          '[contenteditable="true"], [contenteditable=""], .ql-editor, [data-slate-editor="true"], .ProseMirror, .public-DraftEditor-content',
        );
    const el = (inner ?? root) as HTMLElement & { value?: string; form?: HTMLFormElement };
    el.focus();
    const before = el.isContentEditable ? (el.textContent ?? "") : (el.value ?? "");

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
        const after = el.isContentEditable ? (el.textContent ?? "") : (el.value ?? "");
        const lengthDelta = Math.max(0, after.length - before.length);
        const contentPresent = text.length > 0 && after.includes(text);
        resolve({
          found: true,
          typed: text.length,
          reflected: contentPresent ? text.length : lengthDelta,
          content_verified: contentPresent,
        });
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
            // If the framework's beforeinput handler already inserted the
            // character (Quill, ProseMirror, Slate, Draft.js, Lexical, Gmail,
            // etc.), calling execCommand would double-insert. Check whether
            // content grew — if it did, the framework handled it.
            const contentGrew =
              (el.textContent ?? "").length > before.length + index;
            if (!contentGrew) {
              document.execCommand("insertText", false, ch);
            }
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

/**
 * "clipboard" mode — last-resort fallback for rich editors that ignore synthetic
 * keystroke and execCommand events. Simulates a paste via ClipboardEvent with a
 * DataTransfer payload, then falls back to execCommand("insertText").
 */
function injectedTypeClipboard(
  selector: string,
  text: string,
  submit: boolean,
): { found: boolean; typed: number; reflected: number; content_verified: boolean } {
  const root = document.querySelector(selector) as
    | (HTMLElement & { value?: string; form?: HTMLFormElement })
    | null;
  if (root === null) return { found: false, typed: 0, reflected: 0, content_verified: false };
  const rootProto = Object.getPrototypeOf(root) as object | null;
  const rootHasValueSetter = rootProto !== null
    && Object.getOwnPropertyDescriptor(rootProto, "value")?.set !== undefined;
  const inner = root.isContentEditable || rootHasValueSetter
    ? null
    : root.querySelector<HTMLElement & { value?: string; form?: HTMLFormElement }>(
        '[contenteditable="true"], [contenteditable=""], .ql-editor, [data-slate-editor="true"], .ProseMirror, .public-DraftEditor-content',
      );
  const el = (inner ?? root) as HTMLElement & { value?: string; form?: HTMLFormElement };
  el.focus();

  const before = el.isContentEditable ? (el.textContent ?? "") : (el.value ?? "");

  // Strategy 1: Synthetic paste event with DataTransfer.
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const pasteEvent = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(pasteEvent);
  } catch {
    // ClipboardEvent constructor may not support clipboardData in all contexts.
  }

  let after = el.isContentEditable ? (el.textContent ?? "") : (el.value ?? "");
  if (after.includes(text)) {
    if (submit) dispatchEnterAndSubmit(el);
    return { found: true, typed: text.length, reflected: text.length, content_verified: true };
  }

  // Strategy 2: execCommand insertText (may work on editors that handle this).
  if (el.isContentEditable) {
    document.execCommand("insertText", false, text);
    after = el.textContent ?? "";
  }

  if (submit) dispatchEnterAndSubmit(el);
  after = el.isContentEditable ? (el.textContent ?? "") : (el.value ?? "");
  const lengthDelta = Math.max(0, after.length - before.length);
  const contentPresent = text.length > 0 && after.includes(text);
  return { found: true, typed: text.length, reflected: contentPresent ? text.length : lengthDelta, content_verified: contentPresent };
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
  code: string,
  vkCode: number,
  text: string | null,
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
): void {
  const active: HTMLElement =
    (document.activeElement as HTMLElement | null) ??
    document.body;
  const init: KeyboardEventInit = {
    key,
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: modifiers.ctrl,
    altKey: modifiers.alt,
    shiftKey: modifiers.shift,
    metaKey: modifiers.meta,
  };
  const fire = (type: "keydown" | "keypress" | "keyup"): void => {
    const ev = new KeyboardEvent(type, init);
    // keyCode / which are deprecated on the spec but legacy editors still
    // gate on them. KeyboardEventInit does not officially carry these, so
    // patch the event after construction.
    if (vkCode !== 0) {
      try { Object.defineProperty(ev, "keyCode", { value: vkCode, configurable: true }); } catch { /* ignore */ }
      try { Object.defineProperty(ev, "which",   { value: vkCode, configurable: true }); } catch { /* ignore */ }
    }
    active.dispatchEvent(ev);
  };
  fire("keydown");
  // keypress is only meaningful for true printables and chord-free presses.
  if (text !== null && !modifiers.ctrl && !modifiers.meta) {
    fire("keypress");
  }
  fire("keyup");
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
  /** When true, locate the target and return its center coords without
   *  dispatching the synthetic click sequence. Used by the CDP path so the
   *  trusted Input.dispatchMouseEvent can fire at the resolved coordinates. */
  dryRun: boolean;
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
  x?: number;
  y?: number;
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

  if (spec.dryRun) {
    return {
      found: true,
      matched: { role: winner.role, name: winner.name, tag: winner.tag },
      x, y, occluded, occluder,
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

/**
 * Injected: synthetic substring find-and-replace. Runs in MAIN world so the
 * prototype-descriptor value setter reaches the React-controlled getter.
 *
 * Strategy per element kind:
 *   - <input>/<textarea>: character offset into `.value`, splice via the
 *     prototype setter, emit `beforeinput(insertReplacementText)` +
 *     `input(insertReplacementText)`. Caret lands at end of replacement.
 *   - contenteditable: Step 5.
 *
 * Returns a tagged result so the service-worker side can surface structured
 * errors. The `occurrence === "all"` loop is added in Step 6; for now this
 * function always replaces the first match.
 */
type FindReplaceSyntheticResult =
  | { status: "ok"; replaced: number; used_fallback: boolean; kind: "input" | "textarea" | "contenteditable" }
  | { status: "no_target" }
  | { status: "not_found" }
  | { status: "unsupported_kind"; tag: string };

function injectedFindAndReplaceSynthetic(
  selectorOrNull: string | null,
  find: string,
  replace: string,
  occurrence: "first" | "all",
  caseSensitive: boolean,
): FindReplaceSyntheticResult {
  const MAX_ITERATIONS = 1024;
  const root: Element | null =
    selectorOrNull !== null
      ? document.querySelector(selectorOrNull)
      : document.activeElement;
  if (root === null || !(root instanceof Element)) {
    return { status: "no_target" };
  }
  const tag = root.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const field = root as HTMLInputElement | HTMLTextAreaElement;
    const haystack = typeof field.value === "string" ? field.value : "";
    // Compute the next value by walking occurrences and splicing, advancing
    // the cursor past each inserted replacement so `replace` containing
    // `find` never loops.
    const nCmp = caseSensitive ? haystack : haystack.toLowerCase();
    const needle = caseSensitive ? find : find.toLowerCase();
    let pos = 0;
    let replaced = 0;
    let rebuilt = "";
    let firstHit = -1;
    while (replaced < MAX_ITERATIONS) {
      const idx = nCmp.indexOf(needle, pos);
      if (idx < 0) {
        rebuilt += haystack.slice(pos);
        break;
      }
      if (replaced === 0) firstHit = idx;
      rebuilt += haystack.slice(pos, idx) + replace;
      pos = idx + needle.length;
      replaced += 1;
      if (occurrence === "first") {
        rebuilt += haystack.slice(pos);
        break;
      }
    }
    if (replaced === 0) return { status: "not_found" };
    field.focus();
    field.selectionStart = firstHit;
    field.selectionEnd = firstHit + find.length;
    try {
      const evt = new InputEvent("beforeinput", {
        inputType: "insertReplacementText",
        data: replace,
        cancelable: true,
        bubbles: true,
      });
      field.dispatchEvent(evt);
    } catch {
      // older browsers: beforeinput constructor may reject unknown inputType;
      // fall through and do the splice anyway.
    }
    const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter !== undefined) {
      setter.call(field, rebuilt);
    } else {
      field.value = rebuilt;
    }
    // Caret lands at end of the last replacement. For "first", that is
    // firstHit + replace.length; for "all" we know pos advanced past the
    // final needle (or break exited earlier), so the replacement ends at
    // rebuilt.length - (tail after last replacement).length. Simplest: place
    // caret at end of last inserted token. Track it during the loop.
    // Re-compute by scanning rebuilt for the last replace occurrence isn't
    // reliable when replace is empty; use the invariant that the last
    // replacement ends at rebuilt.length - (haystack.length - pos).
    const caret = rebuilt.length - (haystack.length - pos);
    field.selectionStart = caret;
    field.selectionEnd = caret;
    try {
      const evt = new InputEvent("input", {
        inputType: "insertReplacementText",
        data: replace,
        bubbles: true,
      });
      field.dispatchEvent(evt);
    } catch {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return { status: "ok", replaced, used_fallback: false, kind: tag };
  }
  if ((root as HTMLElement).isContentEditable === true) {
    const host = root as HTMLElement;
    // Do one replacement per iteration, re-walking the subtree each time
    // since the prior replacement mutated the text-node layout. Advancing
    // past the inserted replacement avoids re-matching when replace
    // contains find.
    host.focus();
    let replaced = 0;
    let usedFallback = false;
    let searchFromLogical = 0;
    while (replaced < MAX_ITERATIONS) {
      interface Seg { node: Text; start: number; end: number }
      const segs: Seg[] = [];
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let running = 0;
      let logical = "";
      let cur: Node | null = walker.nextNode();
      while (cur !== null) {
        const t = cur as Text;
        const data = t.data;
        segs.push({ node: t, start: running, end: running + data.length });
        running += data.length;
        logical += data;
        cur = walker.nextNode();
      }
      const haystack = caseSensitive ? logical : logical.toLowerCase();
      const needle = caseSensitive ? find : find.toLowerCase();
      const hit = haystack.indexOf(needle, searchFromLogical);
      if (hit < 0) break;
      const hitEnd = hit + find.length;
      const locate = (pos: number): { node: Text; offset: number } | null => {
        for (const seg of segs) {
          if (pos >= seg.start && pos <= seg.end) {
            return { node: seg.node, offset: pos - seg.start };
          }
        }
        return null;
      };
      const startPt = locate(hit);
      const endPt = locate(hitEnd);
      if (startPt === null || endPt === null) break;
      const range = document.createRange();
      range.setStart(startPt.node, startPt.offset);
      range.setEnd(endPt.node, endPt.offset);
      const sel = window.getSelection();
      if (sel !== null) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      try {
        const evt = new InputEvent("beforeinput", {
          inputType: "insertReplacementText",
          data: replace,
          cancelable: true,
          bubbles: true,
        });
        host.dispatchEvent(evt);
      } catch {
        // ignore constructor quirks
      }
      let ok = false;
      try {
        ok = document.execCommand("insertText", false, replace);
      } catch {
        ok = false;
      }
      if (!ok) {
        usedFallback = true;
        range.deleteContents();
        const tn = document.createTextNode(replace);
        range.insertNode(tn);
        range.setStart(tn, replace.length);
        range.setEnd(tn, replace.length);
        if (sel !== null) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        try {
          const evt = new InputEvent("input", {
            inputType: "insertReplacementText",
            data: replace,
            bubbles: true,
          });
          host.dispatchEvent(evt);
        } catch {
          host.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      replaced += 1;
      if (occurrence === "first") break;
      searchFromLogical = hit + replace.length;
    }
    if (replaced === 0) return { status: "not_found" };
    return { status: "ok", replaced, used_fallback: usedFallback, kind: "contenteditable" };
  }
  return { status: "unsupported_kind", tag };
}

// ---------------------------------------------------------------------------
// Param parsing
// ---------------------------------------------------------------------------

const MODIFIER_NAMES: readonly Modifier[] = ["Control", "Alt", "Shift", "Meta"] as const;
const MODIFIER_INPUT_NAMES: readonly ModifierInput[] = [
  ...MODIFIER_NAMES,
  "Primary",
] as const;

function parseModifiers(raw: unknown): Modifier[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw codedError("INVALID_PARAMS", "modifiers must be an array");
  }
  const out: ModifierInput[] = [];
  for (const m of raw) {
    if (
      typeof m !== "string" ||
      !(MODIFIER_INPUT_NAMES as readonly string[]).includes(m)
    ) {
      throw codedError(
        "INVALID_PARAMS",
        `modifier must be one of ${MODIFIER_INPUT_NAMES.join(", ")}`,
      );
    }
    out.push(m as ModifierInput);
  }
  return resolvePrimary(out);
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
  const result: ClickParams = {
    tab_id,
    ref,
    button: (button as ClickParams["button"]) ?? "left",
    modifiers: parseModifiers(raw["modifiers"]),
  };
  // observe_effects defaults to true; only false explicitly disables observation.
  if (raw["observe_effects"] === false) result.observe_effects = false;
  const expectEffect = parseExpectEffect(raw["expect_effect"]);
  if (expectEffect !== undefined) result.expect_effect = expectEffect;
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
  return {
    tab_id,
    x,
    y,
    button: (button as ClickAtParams["button"]) ?? "left",
    modifiers: mods,
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
  const mode = raw["mode"];
  if (mode !== undefined && mode !== "keystroke" && mode !== "paste") {
    throw codedError("INVALID_PARAMS", "mode must be keystroke|paste");
  }
  const submit = raw["submit"];
  const clearMode = raw["clear_mode"];
  if (
    clearMode !== undefined &&
    clearMode !== "value" &&
    clearMode !== "select_all" &&
    clearMode !== "auto"
  ) {
    throw codedError("INVALID_PARAMS", "clear_mode must be value|select_all|auto");
  }
  const delay = raw["delay_ms"];
  if (delay !== undefined && (typeof delay !== "number" || !Number.isInteger(delay) || delay < 0)) {
    throw codedError("INVALID_PARAMS", "delay_ms must be a non-negative integer");
  }
  const result: TypeParams = {
    tab_id,
    ref,
    text,
    submit: typeof submit === "boolean" ? submit : false,
    mode: mode !== undefined ? (mode as TypeMode) : undefined,
  };
  if (clearMode !== undefined) result.clear_mode = clearMode as ClearMode;
  if (typeof delay === "number") result.delay_ms = delay;
  // observe_effects defaults to true; only false explicitly disables observation.
  if (raw["observe_effects"] === false) result.observe_effects = false;
  const expectEffect = parseExpectEffect(raw["expect_effect"]);
  if (expectEffect !== undefined) result.expect_effect = expectEffect;
  return result;
}

/** Resolve the effective clearMode for this call (undefined = no pre-clear). */
function resolveClearMode(params: TypeParams): ClearMode | undefined {
  return params.clear_mode;
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
  const result: PressParams = { tab_id, keys: keys as string[] };
  // observe_effects defaults to true; only false explicitly disables observation.
  if (raw["observe_effects"] === false) result.observe_effects = false;
  const expectEffect = parseExpectEffect(raw["expect_effect"]);
  if (expectEffect !== undefined) result.expect_effect = expectEffect;
  return result;
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

type FindReplaceOccurrence = "first" | "all";

interface FindReplaceParams {
  tab_id: string;
  ref?: number;
  find: string;
  replace: string;
  occurrence: FindReplaceOccurrence;
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

/**
 * Smarter overlay dismissal that classifies the occluder and tries multiple
 * strategies. Returns richer info about what was found and what was dismissed.
 */
function injectedAutoDismiss(targetSelector: string): {
  dismissed: boolean;
  strategy?: string;
  occluder_type?: string;
  close_candidates?: Array<{ tag: string; text: string; aria_label?: string }>;
} {
  const el = document.querySelector(targetSelector) as HTMLElement | null;
  if (el === null) return { dismissed: false };
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  if (hit === null || hit === el || el.contains(hit) || hit.contains(el)) {
    return { dismissed: false };
  }

  // Classify the occluder.
  const classifyOccluder = (node: Element): string => {
    let current: Element | null = node;
    for (let i = 0; i < 5 && current !== null; i++) {
      const role = (current.getAttribute("role") ?? "").toLowerCase();
      if (role === "dialog" || role === "alertdialog") return "dialog";
      const cls = (current.getAttribute("class") ?? "").toLowerCase();
      if (/\b(modal|overlay|popup)\b/.test(cls)) return "dialog";
      if (/\b(banner|toast|notification|snackbar)\b/.test(cls)) return "banner";
      if (/\b(consent|cookie|gdpr)\b/.test(cls)) return "consent";
      const style = window.getComputedStyle(current);
      if ((style.position === "fixed" || style.position === "sticky") && parseInt(style.zIndex ?? "0", 10) > 100) {
        return "fixed-overlay";
      }
      current = current.parentElement;
    }
    return "unknown";
  };
  const occluder_type = classifyOccluder(hit);

  const isCloseLike = (el: Element): boolean => {
    const label = (el.getAttribute("aria-label") ?? "").toLowerCase();
    if (/\b(close|dismiss)\b/.test(label)) return true;
    const title = (el.getAttribute("title") ?? "").toLowerCase();
    if (/\b(close|dismiss)\b/.test(title)) return true;
    const text = (el.textContent ?? "").replace(/\s+/g, "").toLowerCase();
    if (text === "×" || text === "✕" || text === "x" || text === "close" || text === "notnow" || text === "dismiss" || text === "gotit") return true;
    return false;
  };

  // Strategy 1: ESC.
  const escInit: KeyboardEventInit = { key: "Escape", code: "Escape", bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent("keydown", escInit));
  document.dispatchEvent(new KeyboardEvent("keyup", escInit));
  // Check if ESC worked.
  const hitAfterEsc = document.elementFromPoint(x, y) as HTMLElement | null;
  if (hitAfterEsc === el || (hitAfterEsc !== null && (el.contains(hitAfterEsc) || hitAfterEsc.contains(el)))) {
    return { dismissed: true, strategy: "escape", occluder_type };
  }

  // Strategy 2: Close button hunt — scan occluder subtree up to 5 ancestor levels.
  let scope: Element | null = hit;
  for (let depth = 0; depth < 5 && scope !== null; depth++) {
    const candidates = scope.querySelectorAll("button, [role='button'], a, [tabindex]");
    for (const c of Array.from(candidates)) {
      if (!isCloseLike(c)) continue;
      (c as HTMLElement).click();
      // Verify target is now accessible.
      const hitAfter = document.elementFromPoint(x, y) as HTMLElement | null;
      if (hitAfter === el || (hitAfter !== null && (el.contains(hitAfter) || hitAfter.contains(el)))) {
        return { dismissed: true, strategy: "close_button", occluder_type };
      }
    }
    scope = scope.parentElement;
  }

  // Strategy 3: Click on backdrop (if a semi-transparent overlay behind the dialog).
  const backdrop = hit.parentElement;
  if (backdrop !== null) {
    const style = window.getComputedStyle(backdrop);
    if (style.position === "fixed" || style.position === "absolute") {
      backdrop.click();
      const hitAfter = document.elementFromPoint(x, y) as HTMLElement | null;
      if (hitAfter === el || (hitAfter !== null && (el.contains(hitAfter) || hitAfter.contains(el)))) {
        return { dismissed: true, strategy: "backdrop_click", occluder_type };
      }
    }
  }

  // Collect close candidates for suggestion even if we couldn't dismiss.
  const close_candidates: Array<{ tag: string; text: string; aria_label?: string }> = [];
  scope = hit;
  for (let depth = 0; depth < 3 && scope !== null; depth++) {
    const candidates = scope.querySelectorAll("button, [role='button'], a");
    for (const c of Array.from(candidates)) {
      if (isCloseLike(c)) {
        const entry: { tag: string; text: string; aria_label?: string } = {
          tag: c.tagName.toLowerCase(),
          text: (c.textContent ?? "").trim().slice(0, 40),
        };
        const al = c.getAttribute("aria-label");
        if (al) entry.aria_label = al;
        close_candidates.push(entry);
      }
    }
    scope = scope.parentElement;
  }

  return { dismissed: false, occluder_type, close_candidates };
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

export function registerInputHandlers(router: Router, opts: InputOpts): void {
  const { tabIdMap, refCache, cdp, network } = opts;

  router.register(
    "browser_click",
    async (
      raw,
    ): Promise<{
      clicked: boolean;
      dismissed_overlay?: boolean;
      occluded?: boolean;
      occluder?: { tag: string; text: string; role: string | null } | null;
      retargeted?: boolean;
      suggestion?: string;
      page_effect?: PageEffect;
      effect?: Effect;
      warnings?: string[];
    }> => {
      const params = parseClick(raw);
      const chromeId = resolveChromeId(tabIdMap, params.tab_id);
      const selector = resolveSelector(refCache, params.tab_id, params.ref);
      const button = BUTTON_INDEX[params.button ?? "left"];
      const modifiers = params.modifiers ?? [];
      const observeEffects = params.observe_effects !== false;
      const expectEffect = params.expect_effect;
      const mods = modifierFlags(modifiers);
      const buttonName = params.button ?? "left";

      const { result: handlerResult, effect } = await captureEffect(chromeId, async () => {

      // Persistent CDP path: trusted click via Input.dispatchMouseEvent.
      if (cdp.isPersistent(chromeId)) {
        const center = await execInTab(chromeId, injectedElementCenter, [selector] as const);
        if (center === null) {
          throw codedError(
            "REF_STALE",
            `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
            {
              next_action:
                "element ref is stale (DOM changed since last read) — call browser_quick_read again to get a fresh ref, do not reuse the old one",
              diagnostic: {
                ref: params.ref,
                tab_id: params.tab_id,
                last_known_selector: selector,
                stage: "click_cdp_pre_dispatch",
              },
            },
          );
        }
        const dispatch = async () => {
          await cdpClick(cdp, chromeId, center.x, center.y, buttonName, mods);
          return { clicked: true as const };
        };
        if (observeEffects) {
          const { result, effect } = await withEffectObservation(
            { chromeTabId: chromeId, windowMs: 300, networkTracker: network }, dispatch,
          );
          const warning = checkEffectExpectation(effect, expectEffect);
          return { ...result, page_effect: effect, ...(warning ? { warnings: [warning] } : {}) };
        }
        return dispatch();
      }

      // Synthetic path.
      const overlayRaw = raw["overlay"];
      if (
        overlayRaw !== undefined &&
        overlayRaw !== "none" &&
        overlayRaw !== "simple" &&
        overlayRaw !== "smart"
      ) {
        throw codedError("INVALID_PARAMS", "overlay must be none|simple|smart");
      }
      const overlay: "none" | "simple" | "smart" =
        overlayRaw === "simple" || overlayRaw === "smart" ? overlayRaw : "none";
      let res = await execInTab(chromeId, injectedClick, [selector, button, mods] as const);
      if (res.found === false) {
        throw codedError(
          "REF_STALE",
          `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
        );
      }
      let dismissedOverlay = false;
      let dismissStrategy: string | undefined;
      if (overlay !== "none" && res.occluded === true) {
        const injected = overlay === "smart" ? injectedAutoDismiss : injectedDismissOverlay;
        const dismiss = await execInTab(chromeId, injected, [selector] as const) as {
          dismissed: boolean;
          strategy?: string;
        };
        if (dismiss.dismissed) {
          dismissedOverlay = true;
          if (overlay === "smart") dismissStrategy = dismiss.strategy;
          res = await execInTab(chromeId, injectedClick, [selector, button, mods] as const);
          if (res.found === false) {
            throw codedError(
              "REF_STALE",
              `ref ${params.ref} became stale after overlay dismissal in tab ${params.tab_id}`,
            );
          }
        }
      }

      type ClickResult = {
        clicked: boolean;
        dismissed_overlay?: boolean;
        occluded?: boolean;
        occluder?: { tag: string; text: string; role: string | null } | null;
        retargeted?: boolean;
        suggestion?: string;
      };
      const buildResult = (): ClickResult => {
        const r: ClickResult = { clicked: true };
        if (dismissedOverlay) {
          r.dismissed_overlay = true;
          if (dismissStrategy !== undefined) {
            r.suggestion = `overlay dismissed via ${dismissStrategy}`;
          }
        }
        if (res.occluded === true) {
          r.occluded = true;
          r.occluder = res.occluder ?? null;
          r.clicked = false;
          if (overlay === "none") {
            const occText = (res.occluder?.text ?? "").toLowerCase();
            if (/cookie|consent|gdpr|accept/.test(occText)) {
              r.suggestion = "cookie/consent overlay detected — retry with overlay: 'smart'";
            } else if (res.occluder?.role === "dialog" || res.occluder?.role === "alertdialog") {
              r.suggestion = "dialog overlay detected — retry with overlay: 'smart'";
            } else {
              r.suggestion = "retry with overlay: 'simple' or overlay: 'smart'";
            }
          } else {
            r.suggestion =
              "overlay could not be dismissed; target element may be permanently covered";
          }
        }
        if (res.retargeted === true) r.retargeted = true;
        return r;
      };

      if (observeEffects) {
        const { result, effect } = await withEffectObservation(
          { chromeTabId: chromeId, windowMs: 300, networkTracker: network },
          async () => buildResult(),
        );
        const warning = checkEffectExpectation(effect, expectEffect);
        const out: typeof result & { page_effect: PageEffect; warnings?: string[] } = { ...result, page_effect: effect };
        if (warning !== null) out.warnings = [warning];
        return out;
      }
      if (expectEffect !== undefined) {
        const r = buildResult();
        return { ...r, warnings: ["expect_effect set but observe_effects:false — no effect data to verify against"] };
      }
      return buildResult();
      });
      return { ...handlerResult, effect };
    },
  );

  router.register(
    "browser_click_at",
    async (
      raw,
    ): Promise<{ clicked: true; x: number; y: number; effect: Effect }> => {
      const params = parseClickAt(raw);
      const chromeId = resolveChromeId(tabIdMap, params.tab_id);
      const buttonName = params.button ?? "left";
      const button = BUTTON_INDEX[buttonName];
      const modifiers = params.modifiers ?? [];
      const { result, effect } = await captureEffect(chromeId, async () => {
        if (cdp.isPersistent(chromeId)) {
          await cdpClick(cdp, chromeId, params.x, params.y, buttonName, modifierFlags(modifiers));
          return { clicked: true as const, x: params.x, y: params.y };
        }
        await execInTab(
          chromeId,
          injectedClickAtPoint,
          [params.x, params.y, button, modifierFlags(modifiers)] as const,
        );
        return { clicked: true as const, x: params.x, y: params.y };
      });
      return { ...result, effect };
    },
  );

  router.register(
    "browser_click_by_text",
    async (
      raw,
    ): Promise<{
      clicked: true;
      matched: { role: string; name: string; tag: string };
      occluded?: boolean;
      occluder?: { tag: string; text: string; role: string | null } | null;
      effect: Effect;
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
      const buttonName = (button as ClickParams["button"]) ?? "left";
      const { result, effect } = await captureEffect(chromeId, async () => {
        const useCdp = cdp.isPersistent(chromeId);
        const spec: ClickByTextSpec = {
          text,
          matchMode: (match as ClickByTextSpec["matchMode"]) ?? "substring",
          roleFilter: typeof roleRaw === "string" && roleRaw.length > 0 ? roleRaw.toLowerCase() : null,
          caseSensitive,
          button: BUTTON_INDEX[buttonName],
          modifiers: modifierFlags(mods),
          // Locate-only when CDP is attached so the trusted Input.dispatchMouseEvent
          // is what actually fires — synthetic dispatch is silently ignored by
          // Slack/Discord/Linear handlers that gate on event.isTrusted.
          dryRun: useCdp,
        };
        const res = await execInTab(chromeId, injectedClickByText, [spec] as const);
        if (res.found === false) {
          throw codedError(
            "TEXT_NOT_FOUND",
            `no visible element matched text "${text}" (${spec.matchMode}${spec.roleFilter ? `, role=${spec.roleFilter}` : ""})`,
          );
        }
        if (useCdp) {
          if (typeof res.x !== "number" || typeof res.y !== "number") {
            throw codedError("INTERNAL", "click_by_text dry run did not return coordinates");
          }
          await cdpClick(cdp, chromeId, res.x, res.y, buttonName, modifierFlags(mods));
        }
        const inner: {
          clicked: true;
          matched: { role: string; name: string; tag: string };
          occluded?: boolean;
          occluder?: { tag: string; text: string; role: string | null } | null;
        } = {
          clicked: true,
          matched: res.matched ?? { role: "", name: "", tag: "" },
        };
        if (res.occluded === true) {
          inner.occluded = true;
          inner.occluder = res.occluder ?? null;
        }
        return inner;
      });
      return { ...result, effect };
    },
  );

  router.register(
    "browser_type",
    async (raw): Promise<{
      typed: number;
      mode: TypeMode;
      cleared?: boolean;
      escalated_to_cdp?: true;
      page_effect?: PageEffect;
      effect?: Effect;
      warnings?: string[];
    }> => {
      const params = parseType(raw);
      const chromeId = resolveChromeId(tabIdMap, params.tab_id);
      const { result: handlerResult, effect } = await captureEffect(chromeId, async () => {
      const ref = resolveRef(refCache, params.tab_id, params.ref);
      const selector = ref.selector;
      const submit = params.submit ?? false;
      const clearMode = resolveClearMode(params);
      const observeEffects = params.observe_effects !== false;
      const expectEffect = params.expect_effect;
      let cleared: boolean | undefined;

      // Infer mode from the ref metadata when agent didn't specify one.
      // Contenteditable / rich-editor targets (role=textbox with editor
      // class selectors, or any contenteditable) use paste mode — one-shot
      // execCommand("insertText") that avoids focus-stealing between chars.
      const RICH_SELECTOR_HINTS = [".ql-editor", ".ProseMirror", "[data-slate-editor", ".public-DraftEditor", "contenteditable", ".cm-content"];
      const looksRichEditor = ref.role === "textbox" && RICH_SELECTOR_HINTS.some(h => selector.includes(h));
      const mode: TypeMode = params.mode !== undefined
        ? resolveTypeMode(params.text, params.mode)
        : looksRichEditor ? "paste" : resolveTypeMode(params.text, undefined);

      // Persistent CDP path: trusted type via Input.insertText.
      if (cdp.isPersistent(chromeId)) {
        if (clearMode !== undefined) {
          const selectAllMod = isMacPlatform()
            ? { ctrl: false, alt: false, shift: false, meta: true }
            : { ctrl: true, alt: false, shift: false, meta: false };
          await cdpPress(cdp, chromeId, "a", selectAllMod);
          await cdpPress(cdp, chromeId, "Backspace", { ctrl: false, alt: false, shift: false, meta: false });
          cleared = true;
        }
        const dispatch = async () => {
          // Click the element to focus it, then insert text.
          const center = await execInTab(chromeId, injectedElementCenter, [selector] as const);
          if (center === null) {
            throw codedError("REF_STALE", `ref ${params.ref} no longer resolves in tab ${params.tab_id}`);
          }
          await cdpClick(cdp, chromeId, center.x, center.y, "left", { ctrl: false, alt: false, shift: false, meta: false });
          await cdpType(cdp, chromeId, params.text);
          if (submit) {
            await cdpPress(cdp, chromeId, "Enter", { ctrl: false, alt: false, shift: false, meta: false });
          }
          const r: { typed: number; mode: TypeMode; cleared?: boolean } = { typed: params.text.length, mode };
          if (cleared !== undefined) r.cleared = cleared;
          return r;
        };
        if (observeEffects) {
          const { result, effect } = await withEffectObservation(
            { chromeTabId: chromeId, windowMs: 300, networkTracker: network }, dispatch,
          );
          const warning = checkEffectExpectation(effect, expectEffect);
          return { ...result, page_effect: effect, ...(warning ? { warnings: [warning] } : {}) };
        }
        return dispatch();
      }

      // Synthetic path.
      if (clearMode !== undefined) {
        const clearRes = await execInTab(
          chromeId,
          injectedClearField,
          [selector, clearMode] as const,
        );
        if (clearRes.found === false) {
          throw codedError(
            "REF_STALE",
            `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
          );
        }
        cleared = clearRes.cleared;
      }

      type TypeResult = {
        typed: number;
        mode: TypeMode;
        cleared?: boolean;
        escalated_to_cdp?: true;
      };

      const dispatchSynthetic = async (): Promise<TypeResult> => {
        let res: { found: boolean; typed: number; reflected: number; content_verified?: boolean };
        if (mode === "paste") {
          res = await execInTab(
            chromeId,
            injectedTypePaste,
            [selector, params.text, submit] as const,
          );
        } else {
          // keystroke mode. injectedTypeKeystroke already detects
          // contenteditable and uses execCommand fallback per-char
          // when beforeinput doesn't land.
          const delayMs = params.delay_ms ?? 0;
          res = await execInTab(
            chromeId,
            injectedTypeKeystroke,
            [selector, params.text, submit, delayMs] as const,
          );
        }
        if (res.found === false) {
          throw codedError(
            "REF_STALE",
            `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
            {
              next_action:
                "element ref is stale (DOM changed between read and type) — call browser_quick_read again to get a fresh ref, do not reuse the old one",
              diagnostic: {
                ref: params.ref,
                tab_id: params.tab_id,
                last_known_selector: selector,
                role: ref.role,
                stage: "type_synthetic_dispatch",
                mode,
              },
            },
          );
        }
        // If the write didn't land, auto-retry with escalating strategies:
        // 1. paste mode (execCommand insertText in one shot)
        // 2. clipboard fallback (synthetic ClipboardEvent paste)
        // Rich editors (Slack ProseMirror, Gmail Draft.js, Notion) may ignore
        // synthetic keystrokes but respond to paste or execCommand.
        if (params.text.length > 0 && res.reflected === 0) {
          // Strategy 2: paste mode (if we weren't already in paste mode).
          if (mode !== "paste") {
            res = await execInTab(
              chromeId,
              injectedTypePaste,
              [selector, params.text, submit] as const,
            );
            if (res.found && res.reflected > 0) {
              const r: TypeResult = { typed: res.reflected, mode: "paste" };
              if (cleared !== undefined) r.cleared = cleared;
              return r;
            }
          }
          // Strategy 3: clipboard fallback (synthetic paste event + execCommand).
          res = await execInTab(
            chromeId,
            injectedTypeClipboard,
            [selector, params.text, submit] as const,
          );
          if (res.found && res.reflected > 0) {
            const r: TypeResult = { typed: res.reflected, mode: "paste" };
            if (cleared !== undefined) r.cleared = cleared;
            return r;
          }
          const isContentEditable =
            looksRichEditor || ref.role === "textbox" && /contenteditable/i.test(selector);
          throw codedError(
            "WRITE_NOT_REFLECTED",
            `typed ${params.text.length} characters via keystroke, paste, and clipboard strategies but field content did not change; try browser_set_cdp enabled:true for trusted events`,
            {
              next_action: isContentEditable
                ? "contenteditable / rich editor detected — switch to browser_execute_js with `el.focus(); document.execCommand('insertText', false, <text>)` instead of retrying browser_type"
                : "value did not reflect — call browser_quick_read again to confirm element is still focusable, then retry once with clear_mode:'auto'; if still failing, fall back to browser_execute_js",
              diagnostic: {
                ref: params.ref,
                tab_id: params.tab_id,
                selector,
                role: ref.role,
                is_contenteditable: isContentEditable,
                looks_rich_editor: looksRichEditor,
                expected_value_length: params.text.length,
                observed_reflected_length: res.reflected,
                strategies_tried:
                  mode === "paste"
                    ? ["paste", "clipboard"]
                    : ["keystroke", "paste", "clipboard"],
              },
            },
          );
        }
        if (params.text.length > 0 && res.reflected >= params.text.length * 2) {
          throw codedError(
            "WRITE_AMPLIFIED",
            `typed ${res.typed} characters but field reflected ${res.reflected} — likely double-insertion by a stacked beforeinput handler`,
          );
        }
        const r: TypeResult = { typed: res.reflected, mode };
        if (cleared !== undefined) r.cleared = cleared;
        return r;
      };

      // Auto-escalate to CDP when all synthetic strategies fail. Without
      // this, the agent would see WRITE_NOT_REFLECTED, manually call
      // browser_set_cdp, and re-issue the type — three round-trips plus
      // model reasoning latency before CDP kicks in. Doing it in-handler
      // collapses that to one ~500ms attach + one Input.insertText. See
      // the comment block under the WRITE_NOT_REFLECTED throw above for
      // the synthetic-strategy ladder we exhausted before getting here.
      const dispatchWithRescue = async (): Promise<TypeResult> => {
        try {
          return await dispatchSynthetic();
        } catch (err) {
          const e = err as Error & {
            code?: string;
            next_action?: string;
            diagnostic?: Record<string, unknown>;
          };
          if (e.code !== "WRITE_NOT_REFLECTED") throw err;
          // CDP rescue: attach the debugger persistently so this and
          // subsequent ops on the tab use trusted dispatch.
          try {
            await cdp.setPersistent(chromeId, true);
          } catch (attachErr) {
            const m = (attachErr as Error)?.message ?? String(attachErr);
            throw codedError(
              "WRITE_NOT_REFLECTED",
              `${e.message}; CDP rescue attach failed: ${m}`,
              {
                next_action:
                  "synthetic dispatch failed and chrome.debugger could not attach for CDP rescue — DevTools or another extension may already be attached to this tab; close it and retry",
                diagnostic: { ...(e.diagnostic ?? {}), cdp_attach_error: m },
              },
            );
          }
          const center = await execInTab(
            chromeId,
            injectedElementCenter,
            [selector] as const,
          );
          if (center === null) {
            throw codedError(
              "REF_STALE",
              `ref ${params.ref} no longer resolves in tab ${params.tab_id}`,
              {
                next_action:
                  "element ref went stale during CDP escalation — call browser_quick_read again",
                diagnostic: {
                  ref: params.ref,
                  tab_id: params.tab_id,
                  selector,
                  stage: "type_cdp_rescue",
                },
              },
            );
          }
          await cdpClick(
            cdp, chromeId, center.x, center.y, "left",
            { ctrl: false, alt: false, shift: false, meta: false },
          );
          await cdpType(cdp, chromeId, params.text);
          if (submit) {
            await cdpPress(
              cdp, chromeId, "Enter",
              { ctrl: false, alt: false, shift: false, meta: false },
            );
          }
          const out: TypeResult = {
            typed: params.text.length,
            mode,
            escalated_to_cdp: true,
          };
          if (cleared !== undefined) out.cleared = cleared;
          return out;
        }
      };

      if (observeEffects) {
        const { result, effect } = await withEffectObservation(
          { chromeTabId: chromeId, windowMs: 300, networkTracker: network },
          dispatchWithRescue,
        );
        const warning = checkEffectExpectation(effect, expectEffect);
        const out: typeof result & { page_effect: PageEffect; warnings?: string[] } = { ...result, page_effect: effect };
        if (warning !== null) out.warnings = [warning];
        return out;
      }
      if (expectEffect !== undefined) {
        const r = await dispatchWithRescue();
        return { ...r, warnings: ["expect_effect set but observe_effects:false — no effect data to verify against"] };
      }
      return dispatchWithRescue();
      });
      return { ...handlerResult, effect };
    },
  );

  router.register("browser_press", async (raw): Promise<{
    pressed: true;
    page_effect?: PageEffect;
    effect?: Effect;
    warnings?: string[];
  }> => {
    const params = parsePress(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    const { result: handlerResult, effect: pressEffect } = await captureEffect(chromeId, async () => {
    const observeEffects = params.observe_effects !== false;
    const expectEffect = params.expect_effect;
    const keys = params.keys;
    const terminal = keys[keys.length - 1] ?? "";
    const modsIn: ModifierInput[] = [];
    for (let i = 0; i < keys.length - 1; i += 1) {
      const k = keys[i];
      if (k !== undefined && (MODIFIER_INPUT_NAMES as readonly string[]).includes(k)) {
        modsIn.push(k as ModifierInput);
      }
    }
    const mods = resolvePrimary(modsIn);
    const denyReason = isDestructiveChord(terminal, mods);
    if (denyReason !== null) {
      throw codedError("RISKY_ACTION_DENIED", `refused destructive chord: ${denyReason}`);
    }

    // Persistent CDP path: trusted key events.
    if (cdp.isPersistent(chromeId)) {
      const dispatch = async (): Promise<{ pressed: true }> => {
        await cdpPress(cdp, chromeId, terminal, modifierFlags(mods));
        return { pressed: true };
      };
      if (observeEffects) {
        const { result, effect } = await withEffectObservation(
          { chromeTabId: chromeId, windowMs: 300, networkTracker: network }, dispatch,
        );
        const warning = checkEffectExpectation(effect, expectEffect);
        return { ...result, page_effect: effect, ...(warning ? { warnings: [warning] } : {}) };
      }
      return dispatch();
    }

    // Synthetic path. Pre-resolve the key tuple here so the injected fn
    // ships only the data it needs and stays free of imports.
    const dispatchPress = async (): Promise<{ pressed: true }> => {
      const kTuple = resolveKey(terminal);
      await execInTab(
        chromeId,
        injectedPress,
        [
          kTuple.key,
          kTuple.code,
          kTuple.vkCode,
          kTuple.text ?? null,
          modifierFlags(mods),
        ] as const,
      );
      return { pressed: true };
    };

    if (observeEffects) {
      const { result, effect } = await withEffectObservation(
        { chromeTabId: chromeId, windowMs: 300, networkTracker: network },
        dispatchPress,
      );
      const warning = checkEffectExpectation(effect, expectEffect);
      const out: typeof result & { page_effect: PageEffect; warnings?: string[] } = { ...result, page_effect: effect };
      if (warning !== null) out.warnings = [warning];
      return out;
    }
    if (expectEffect !== undefined) {
      const r = await dispatchPress();
      return { ...r, warnings: ["expect_effect set but observe_effects:false — no effect data to verify against"] };
    }
    return dispatchPress();
    });
    return { ...handlerResult, effect: pressEffect };
  });

  router.register("browser_scroll", async (raw): Promise<{ scrolled: true }> => {
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

  router.register("browser_hover", async (raw): Promise<{ hovered: true }> => {
    const params = parseHover(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    const selector = resolveSelector(refCache, params.tab_id, params.ref);

    // Persistent CDP path: trusted hover via Input.dispatchMouseEvent.
    // Synthetic mouseover/mouseenter is silently ignored by hover-gated UIs
    // (Slack message-action toolbar, GitHub tooltip stacks) — only a real
    // mouse move surfaces them.
    if (cdp.isPersistent(chromeId)) {
      const center = await execInTab(chromeId, injectedElementCenter, [selector] as const);
      if (center === null) {
        throw codedError("REF_STALE", `ref ${params.ref} no longer resolves in tab ${params.tab_id}`);
      }
      await cdpHover(cdp, chromeId, center.x, center.y);
      return { hovered: true };
    }

    const res = await execInTab(chromeId, injectedHover, [selector] as const);
    if (res.found === false) {
      throw codedError("REF_STALE", `ref ${params.ref} no longer resolves in tab ${params.tab_id}`);
    }
    return { hovered: true };
  });

  router.register("browser_find_and_replace", async (raw) => {
    const params = parseFindAndReplace(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    const selectorArg: string | null =
      params.ref !== undefined
        ? resolveSelector(refCache, params.tab_id, params.ref)
        : null;
    const res = await execInTab(chromeId, injectedFindAndReplaceSynthetic, [
      selectorArg,
      params.find,
      params.replace,
      params.occurrence,
      params.case_sensitive,
    ] as const);
    if (res.status === "no_target") {
      throw codedError(
        "INVALID_PARAMS",
        "no target element (ref was not provided and document.activeElement is not editable)",
      );
    }
    if (res.status === "not_found") {
      throw codedError("TEXT_NOT_FOUND", `substring not found in target element`);
    }
    if (res.status === "unsupported_kind") {
      throw codedError(
        "INTERNAL",
        `element <${res.tag}> is not editable (expected input, textarea, or contenteditable)`,
      );
    }
    return {
      replaced: res.replaced,
      used_fallback: res.used_fallback,
    };
  });

  router.register("browser_execute_js", async (raw) => {
    const params = parseExecuteJs(raw);
    const chromeId = resolveChromeId(tabIdMap, params.tab_id);
    // Use CDP Runtime.evaluate instead of injected eval so this works on pages
    // with Trusted Types CSP (e.g. Gmail), where string-based eval is blocked.
    type EvalResult = {
      result: { type: string; value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    const evaluate = (expression: string): Promise<EvalResult> =>
      cdp.withAttach(chromeId, () =>
        cdp.send<EvalResult>(chromeId, "Runtime.evaluate", {
          expression,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true,
          // Resolve top-level Promises (async IIFEs, fetch().then chains)
          // before serialising the result. Without this Chrome serialises
          // the Promise object itself, which round-trips to the agent as
          // an empty {} and forces a JSON.stringify-and-avoid-async dance.
          awaitPromise: true,
        }),
      );
    try {
      let res = await evaluate(params.code);
      // Agents reach for browser_execute_js the same way they reach for a
      // browser devtools console — they write `const x = ...; return x;` as
      // if execute_js takes a function body. CDP's Runtime.evaluate runs the
      // expression at script scope, where a top-level `return` is a
      // SyntaxError. Detect the canonical message and retry the code wrapped
      // in an IIFE so the natural pattern just works.
      if (res.exceptionDetails !== undefined) {
        const errText = `${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ""}`;
        if (/Illegal return|return\s+(?:statement\s+is\s+)?outside(?:\s+of)?\s+(?:a\s+)?function/i.test(errText)) {
          res = await evaluate(`(() => { ${params.code} })()`);
        }
      }
      if (res.exceptionDetails !== undefined) {
        const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
        return { thrown: true, value: null, error: msg ?? "runtime exception" };
      }
      return { thrown: false, value: res.result.value ?? null };
    } catch (e) {
      return { thrown: true, value: null, error: String(e) };
    }
  });

  router.register("browser_set_cdp", async (raw): Promise<{ enabled: boolean }> => {
    const tab_id = raw["tab_id"];
    const enabled = raw["enabled"];
    if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
    if (typeof enabled !== "boolean") throw codedError("INVALID_PARAMS", "enabled must be a boolean");
    const chromeId = resolveChromeId(tabIdMap, tab_id);
    await cdp.setPersistent(chromeId, enabled);
    return { enabled };
  });
}
