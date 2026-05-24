// browser_observe handler — adaptive read tool. Routes by mode to per-mode
// implementations (text, visual, structure, diff) or runs the auto-mode
// heuristic when no mode is specified. Lives behind a single MCP method so
// the agent can issue one call without pre-classifying the page.
//
// Lands incrementally across substeps 3.3.2–3.3.7; this skeleton wires
// dispatch + the page_meta helper. Per-mode bodies are filled in below
// in subsequent commits.

import type { Router } from "../router.js";

type ObserveMode = "auto" | "text" | "visual" | "structure" | "diff";

interface ObserveOpts {
  tabIdMap: Map<string, number>;
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
    // Skeleton dispatch — per-mode implementations land in subsequent
    // substeps. For now, any mode returns a stub payload so the wiring
    // is verifiable end-to-end.
    return {
      representation: "augmented_a11y" as const,
      observation_token: "",
      payload: null,
      page_meta: {
        url: "",
        title: "",
        scroll: { x: 0, y: 0 },
        viewport_dims: { w: 0, h: 0 },
        dpr: 1,
      } as PageMeta,
      mode_chosen: mode,
      chromeTabId,
    };
  });
}

export { readPageMeta };
