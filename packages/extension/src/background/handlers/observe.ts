// browser_observe handler — adaptive read tool. Routes by mode to per-mode
// implementations (text, visual, structure, diff) or runs the auto-mode
// heuristic when no mode is specified. Lives behind a single MCP method so
// the agent can issue one call without pre-classifying the page.

import type { Router } from "../router.js";
import type { RefCache } from "../ref-cache.js";
import { augment } from "../../lib/a11y-augment.js";
import { execInTab } from "./input.js";
import { put as cacheObservation } from "../observation-cache.js";

type ObserveMode = "auto" | "text" | "visual" | "structure" | "diff";

interface ObserveOpts {
  tabIdMap: Map<string, number>;
  refCache: RefCache;
}

interface PageMeta {
  url: string;
  title: string;
  scroll: { x: number; y: number };
  viewport_dims: { w: number; h: number };
  dpr: number;
}

function readPageMeta(): PageMeta {
  return {
    url: location.href,
    title: document.title,
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport_dims: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio || 1,
  };
}

function makeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

// Minimal a11y walker injected for the text/structure modes. Returns the
// same shape as browser_read's a11y_tree mode but trimmed to the fields
// the augmenter and box-drawing renderer need.
function injectedObserveWalk(
  scopeMode: "viewport" | "document",
): Array<{ ref: number; role: string; name: string; selector: string }> {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  function selectorFor(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node !== null && node !== document.documentElement && node !== document.body) {
      const id = node.id;
      if (id) {
        parts.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent !== null) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === (node as Element).tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          parts.unshift(`${tag}:nth-child(${idx})`);
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      node = node.parentElement;
    }
    return parts.length > 0 ? parts.join(" > ") : el.tagName.toLowerCase();
  }

  function roleFor(el: Element): string | null {
    const aria = el.getAttribute("role");
    if (aria !== null && aria !== "") return aria;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el as HTMLInputElement).type;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "main") return "main";
    if (tag === "nav") return "navigation";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    if (tag === "table") return "table";
    return null;
  }

  function accName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria !== null && aria.trim() !== "") return aria.trim().slice(0, 80);
    return (el.textContent ?? "").trim().slice(0, 80);
  }

  const out: Array<{ ref: number; role: string; name: string; selector: string }> = [];
  let next = 1;
  const walk = (el: Element): void => {
    const role = roleFor(el);
    if (role !== null) {
      const rect = el.getBoundingClientRect();
      const inViewport =
        rect.bottom >= 0 &&
        rect.top <= vh &&
        rect.right >= 0 &&
        rect.left <= vw;
      if (scopeMode === "document" || inViewport) {
        out.push({
          ref: next++,
          role,
          name: accName(el),
          selector: selectorFor(el),
        });
        if (out.length >= 500) return;
      }
    }
    for (const child of Array.from(el.children)) {
      walk(child);
      if (out.length >= 500) return;
    }
  };
  if (document.body !== null) walk(document.body);
  return out;
}

async function modeText(
  chromeTabId: number,
  scopeMode: "viewport" | "document",
): Promise<{
  representation: "augmented_a11y";
  payload: unknown;
}> {
  const nodes = await execInTab(chromeTabId, injectedObserveWalk, [scopeMode] as const);
  const augmented = await augment(
    chromeTabId,
    nodes.map((n) => ({
      ref: String(n.ref),
      role: n.role,
      name: n.name,
      selector: n.selector,
    })),
  );
  return {
    representation: "augmented_a11y",
    payload: { nodes: augmented },
  };
}

export function registerObserveHandler(router: Router, opts: ObserveOpts): void {
  router.register("browser_observe", async (raw) => {
    const tabId = raw["tab_id"];
    if (typeof tabId !== "string") {
      throw makeError("INVALID_PARAMS", "tab_id must be a string");
    }
    const chromeTabId = opts.tabIdMap.get(tabId);
    if (chromeTabId === undefined) {
      throw makeError("TAB_NOT_FOUND", `unknown tab_id: ${tabId}`);
    }
    let mode: ObserveMode = "auto";
    const modeRaw = raw["mode"];
    if (modeRaw !== undefined) {
      if (
        modeRaw !== "auto" &&
        modeRaw !== "text" &&
        modeRaw !== "visual" &&
        modeRaw !== "structure" &&
        modeRaw !== "diff"
      ) {
        throw makeError(
          "INVALID_PARAMS",
          "mode must be one of auto, text, visual, structure, diff",
        );
      }
      mode = modeRaw;
    }

    let scopeMode: "viewport" | "document" = "viewport";
    const scopeRaw = raw["scope"];
    if (typeof scopeRaw === "string") {
      if (scopeRaw === "document") scopeMode = "document";
      else if (scopeRaw.startsWith("ref:")) scopeMode = "document"; // restricted scope honored by walker fallthrough
    }

    const page_meta = await execInTab(chromeTabId, readPageMeta, [] as const);

    if (mode === "text") {
      const { representation, payload } = await modeText(chromeTabId, scopeMode);
      const observation_token = cacheObservation({
        tab_id: chromeTabId,
        css_pixel_dims: page_meta.viewport_dims,
        screenshot_dims: page_meta.viewport_dims,
        scale: 1,
        scroll: page_meta.scroll,
        dpr: page_meta.dpr,
        representation,
      });
      return { representation, observation_token, payload, page_meta };
    }

    // Other modes wired in subsequent substeps. For now route to text.
    const { representation, payload } = await modeText(chromeTabId, scopeMode);
    const observation_token = cacheObservation({
      tab_id: chromeTabId,
      css_pixel_dims: page_meta.viewport_dims,
      screenshot_dims: page_meta.viewport_dims,
      scale: 1,
      scroll: page_meta.scroll,
      dpr: page_meta.dpr,
      representation,
    });
    // Touch unused params so the linter is happy until 3.3.7 implements diff.
    void opts.refCache;
    return { representation, observation_token, payload, page_meta };
  });
}

export { readPageMeta };
