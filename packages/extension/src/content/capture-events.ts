/**
 * Teach-mode capture script.
 *
 * Injected into every tab while a teach session is active via
 * chrome.scripting.executeScript({ func: captureEventsScript }). Runs in the
 * ISOLATED world of the page, so it has DOM access + chrome.runtime but is
 * sandboxed from page JS.
 *
 * All helpers are nested function declarations so executeScript's
 * .toString() serialization captures them. Outer closures are NOT available
 * — keep this self-contained.
 */

/**
 * The function passed to executeScript. The body must be entirely
 * self-contained — every helper is declared inside.
 */
export function captureEventsScript(): void {
  // Idempotent re-injection: webNavigation.onCommitted fires while the
  // background script is still attached and may run executeScript twice.
  // Skip if already attached.
  const FLAG = "__BROWSEROPS_TEACH_CAPTURE__";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as unknown as Record<string, unknown>;
  if (w[FLAG] === true) return;
  w[FLAG] = true;

  // ----- secret detection -------------------------------------------------
  const SECRET_REGEXES: RegExp[] = [
    /\bsk-[a-zA-Z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  ];

  function classifyValue(
    el: Element | null,
    value: string,
  ): { redact: boolean; reason?: string } {
    if (el instanceof HTMLInputElement) {
      const t = (el.type || "").toLowerCase();
      if (t === "password") return { redact: true, reason: "password" };
      const ac = (el.autocomplete || "").toLowerCase();
      if (ac.includes("current-password") || ac.includes("new-password")) {
        return { redact: true, reason: "password" };
      }
      if (ac.includes("one-time-code")) return { redact: true, reason: "otp" };
      const name = (el.name || "").toLowerCase();
      const id = (el.id || "").toLowerCase();
      if (/(password|passwd|secret|otp|2fa|mfa)/.test(name + " " + id)) {
        return { redact: true, reason: "password" };
      }
    }
    for (const re of SECRET_REGEXES) {
      if (re.test(value)) return { redact: true, reason: "secret_pattern" };
    }
    return { redact: false };
  }

  // ----- target derivation -----------------------------------------------
  function bestSelector(el: Element): string {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll("#" + cssEscape(el.id)).length === 1) {
      return "#" + cssEscape(el.id);
    }
    const testid = el.getAttribute("data-testid");
    if (testid !== null && testid !== "") {
      return `[data-testid=${JSON.stringify(testid)}]`;
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel !== null && ariaLabel.length > 0 && ariaLabel.length < 80) {
      const tag = el.tagName.toLowerCase();
      const sel = `${tag}[aria-label=${JSON.stringify(ariaLabel)}]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    return computePathSelector(el, 6);
  }

  function cssEscape(s: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
    return s.replace(/[^A-Za-z0-9_-]/g, (c) => "\\" + c);
  }

  function computePathSelector(el: Element, maxDepth: number): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur !== null && cur !== document.documentElement && depth < maxDepth) {
      const tag = cur.tagName.toLowerCase();
      let part = tag;
      if (cur.classList.length > 0) {
        const cls = Array.from(cur.classList)
          .filter((c) => /^[a-zA-Z][\w-]*$/.test(c) && c.length < 32)
          .slice(0, 2);
        if (cls.length > 0) part += "." + cls.map(cssEscape).join(".");
      }
      const parent: Element | null = cur.parentElement;
      if (parent !== null) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (sibs.length > 1) {
          const idx = sibs.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = parent;
      depth += 1;
    }
    return parts.join(" > ");
  }

  function implicitRole(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit !== null && explicit !== "") return explicit;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "button":
        return "button";
      case "a":
        return el.getAttribute("href") !== null ? "link" : "generic";
      case "input": {
        const t = (el as HTMLInputElement).type.toLowerCase();
        if (t === "button" || t === "submit" || t === "reset") return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "search") return "searchbox";
        return "textbox";
      }
      case "textarea":
        return "textbox";
      case "select":
        return "combobox";
      case "img":
        return "img";
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "header":
        return "banner";
      case "footer":
        return "contentinfo";
      default:
        return "generic";
    }
  }

  function accessibleName(el: Element): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel !== null && ariaLabel.trim() !== "") return ariaLabel.trim().slice(0, 200);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const ids = labelledBy.split(/\s+/).filter((s) => s !== "");
      const parts: string[] = [];
      for (const id of ids) {
        const r = document.getElementById(id);
        if (r !== null) parts.push((r.textContent ?? "").trim());
      }
      const joined = parts.join(" ").trim();
      if (joined !== "") return joined.slice(0, 200);
    }
    if (el instanceof HTMLImageElement && el.alt !== "") return el.alt.slice(0, 200);
    if (el instanceof HTMLInputElement) {
      const firstLabel = el.labels?.item(0) ?? null;
      if (firstLabel !== null) {
        const t = (firstLabel.textContent ?? "").trim();
        if (t !== "") return t.slice(0, 200);
      }
      if (el.placeholder !== "") return el.placeholder.slice(0, 200);
      if (el.name !== "") return el.name.slice(0, 200);
    }
    const title = el.getAttribute("title");
    if (title !== null && title.trim() !== "") return title.trim().slice(0, 200);
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return text.slice(0, 200);
  }

  function describeTarget(el: Element): {
    selector: string;
    role: string;
    name: string;
    text: string;
    tag: string;
    input_type?: string;
    contenteditable?: boolean;
  } {
    const target: ReturnType<typeof describeTarget> = {
      selector: bestSelector(el),
      role: implicitRole(el),
      name: accessibleName(el),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      tag: el.tagName.toLowerCase(),
    };
    if (el instanceof HTMLInputElement) target.input_type = el.type;
    const ce = el.getAttribute("contenteditable");
    if (ce === "true" || ce === "") target.contenteditable = true;
    return target;
  }

  // ----- modifier capture -------------------------------------------------
  function modifiersFrom(ev: MouseEvent | KeyboardEvent): Array<"Control" | "Alt" | "Shift" | "Meta"> {
    const out: Array<"Control" | "Alt" | "Shift" | "Meta"> = [];
    if (ev.ctrlKey) out.push("Control");
    if (ev.altKey) out.push("Alt");
    if (ev.shiftKey) out.push("Shift");
    if (ev.metaKey) out.push("Meta");
    return out;
  }

  // ----- send helper ------------------------------------------------------
  function send(step: unknown): void {
    try {
      chrome.runtime
        .sendMessage({
          type: "teach_capture",
          step,
          url: location.href,
          ts: Date.now(),
        })
        .catch(() => {});
    } catch {
      /* extension reloaded — content script orphaned */
    }
  }

  // ----- click handler ----------------------------------------------------
  function onClick(ev: Event): void {
    if (!(ev instanceof MouseEvent)) return;
    if (ev.button !== 0 && ev.button !== 1 && ev.button !== 2) return;
    // Use composedPath so we resolve through Shadow DOM.
    const path = (typeof ev.composedPath === "function" ? ev.composedPath() : []) as EventTarget[];
    const el = (path.find((n): n is Element => n instanceof Element) ?? ev.target) as Element | null;
    if (el === null) return;
    const button: "left" | "right" | "middle" =
      ev.button === 0 ? "left" : ev.button === 2 ? "right" : "middle";
    send({
      kind: "click",
      target: describeTarget(el),
      x: Math.round(ev.clientX),
      y: Math.round(ev.clientY),
      button,
      modifiers: modifiersFrom(ev),
    });
  }

  // ----- input (typing) handler ------------------------------------------
  // Coalesce per-target input events: emit only when the user pauses (200ms)
  // or the focused element changes. Single-emit-per-edit keeps the timeline
  // small and the value coherent.
  type PendingInput = { el: Element; lastTs: number };
  let pending: PendingInput | null = null;
  let flushTimer: number | null = null;

  function flushPending(): void {
    if (pending === null) return;
    const { el } = pending;
    pending = null;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    let value = "";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      value = el.value ?? "";
    } else if (el instanceof HTMLElement && el.isContentEditable) {
      value = (el.innerText ?? el.textContent ?? "");
    }
    const verdict = classifyValue(el, value);
    const out: Record<string, unknown> = {
      kind: "type",
      target: describeTarget(el),
      value: verdict.redact ? "" : value,
      redacted: verdict.redact,
    };
    if (verdict.reason !== undefined) out.redaction_reason = verdict.reason;
    send(out);
  }

  function onInput(ev: Event): void {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (
      !(t instanceof HTMLInputElement) &&
      !(t instanceof HTMLTextAreaElement) &&
      !(t instanceof HTMLElement && t.isContentEditable)
    ) {
      return;
    }
    if (pending !== null && pending.el !== t) flushPending();
    pending = { el: t, lastTs: Date.now() };
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = window.setTimeout(flushPending, 200);
  }

  function onFocusOut(): void {
    flushPending();
  }

  // ----- key handler ------------------------------------------------------
  // We capture only meaningful chords, not every keystroke — typing is
  // handled by the input listener above. A "meaningful" chord is any
  // keydown with at least one non-Shift modifier, OR a special key like
  // Enter / Escape / Tab / arrows / Delete / Backspace.
  const SPECIAL_KEYS: ReadonlySet<string> = new Set([
    "Enter",
    "Escape",
    "Tab",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Delete",
    "Backspace",
    "PageUp",
    "PageDown",
    "Home",
    "End",
  ]);

  function onKeyDown(ev: KeyboardEvent): void {
    const hasMod = ev.ctrlKey || ev.metaKey || ev.altKey;
    const isSpecial = SPECIAL_KEYS.has(ev.key);
    if (!hasMod && !isSpecial) return;
    // Flush any pending typing first so order is preserved.
    flushPending();
    const keys: string[] = modifiersFrom(ev);
    keys.push(ev.code !== "" ? ev.code : ev.key);
    const target =
      ev.target instanceof Element ? describeTarget(ev.target as Element) : undefined;
    const out: Record<string, unknown> = { kind: "key", keys };
    if (target !== undefined) out.target = target;
    send(out);
  }

  // ----- scroll handler ---------------------------------------------------
  // Coarse: emit at most once per 500ms while the user is scrolling. We
  // attach to the window scroll. delta_y is the cumulative delta over the
  // burst.
  let scrollAccum = 0;
  let scrollLastY = window.scrollY;
  let scrollTimer: number | null = null;

  function onScroll(): void {
    const y = window.scrollY;
    scrollAccum += y - scrollLastY;
    scrollLastY = y;
    if (scrollTimer !== null) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = null;
      const delta = scrollAccum;
      scrollAccum = 0;
      if (Math.abs(delta) < 24) return;
      send({ kind: "scroll", delta_y: delta });
    }, 500);
  }

  // ----- attach -----------------------------------------------------------
  document.addEventListener("click", onClick, true);
  document.addEventListener("contextmenu", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });

  // ----- detach on stop ---------------------------------------------------
  function detach(): void {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("contextmenu", onClick, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onInput, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, { capture: true });
    if (flushTimer !== null) clearTimeout(flushTimer);
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    delete w[FLAG];
  }

  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as { type?: unknown };
    if (m.type === "teach_stop_capture") detach();
  });
}
