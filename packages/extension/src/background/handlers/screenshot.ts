import type { ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";
import { execInTab } from "./input.js";
import { put as cacheObservation } from "../observation-cache.js";
import { renderSom, collectSomCandidates } from "../../lib/som-overlay.js";

function readPageMetrics(): {
  dpr: number;
  scroll_x: number;
  scroll_y: number;
  inner_w: number;
  inner_h: number;
} {
  return {
    dpr: window.devicePixelRatio || 1,
    scroll_x: window.scrollX,
    scroll_y: window.scrollY,
    inner_w: window.innerWidth,
    inner_h: window.innerHeight,
  };
}

/**
 * browser_screenshot handler.
 *
 * Params: { tab_id, full_page?, format?, quality? }
 * Result: { image_base64, width, height, format }
 *
 * v1: viewport-only capture via chrome.tabs.captureVisibleTab. full_page
 * requires CDP Page.captureScreenshot (deferred — see plan 04-tools.md
 *). width/height are sourced from chrome.tabs.get; if the view
 * geometry is unavailable we fall back to 0/0 placeholders so the result
 * still matches the schema's required keys.
 */

type ScreenshotIntent = "glance" | "verify" | "read_text" | "user_requested";

interface ScreenshotParams {
  tab_id: string;
  intent?: ScreenshotIntent;
  full_page?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
  max_dimension?: number;
  full_quality?: boolean;
  dimensions?: { longest_edge?: number };
  region?: { x: number; y: number; w: number; h: number };
  annotate?: "som" | "none";
}

// Default longest-edge for the action-grade screenshot path introduced by the
// observation-architecture plan. Hits the Anthropic image-token budget at
// ~800 tokens — markedly cheaper than the legacy 1024px verify-intent default.
const DEFAULT_LONGEST_EDGE = 768;

const INTENT_PRESETS: Record<ScreenshotIntent, { quality: number; max_dimension: number; full_quality: boolean }> = {
  glance:         { quality: 20,  max_dimension: 512,  full_quality: false },
  verify:         { quality: 50,  max_dimension: 1024, full_quality: false },
  read_text:      { quality: 95,  max_dimension: 2048, full_quality: false },
  user_requested: { quality: 95,  max_dimension: 8192, full_quality: true  },
};

// (ScreenshotResult type retired — the action-grade response shape is
// inlined at the return site so the agent-visible fields match the
// observation-architecture additions exactly.)

function codedError(code: ErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: ErrorCode };
  err.code = code;
  return err;
}

function parseParams(raw: Record<string, unknown>): ScreenshotParams {
  const tabId = raw["tab_id"];
  if (typeof tabId !== "string") {
    throw codedError("INVALID_PARAMS", "screenshot requires tab_id:string");
  }
  const out: ScreenshotParams = { tab_id: tabId };
  const fullPage = raw["full_page"];
  if (fullPage !== undefined) {
    if (typeof fullPage !== "boolean") {
      throw codedError("INVALID_PARAMS", "full_page must be boolean");
    }
    out.full_page = fullPage;
  }
  const format = raw["format"];
  if (format !== undefined) {
    if (format !== "png" && format !== "jpeg") {
      throw codedError("INVALID_PARAMS", "format must be 'png' or 'jpeg'");
    }
    out.format = format;
  }
  const quality = raw["quality"];
  if (quality !== undefined) {
    if (typeof quality !== "number" || !Number.isInteger(quality) || quality < 0 || quality > 100) {
      throw codedError("INVALID_PARAMS", "quality must be integer in [0,100]");
    }
    out.quality = quality;
  }
  const maxDim = raw["max_dimension"];
  if (maxDim !== undefined) {
    if (typeof maxDim !== "number" || !Number.isInteger(maxDim) || maxDim < 1 || maxDim > 8192) {
      throw codedError("INVALID_PARAMS", "max_dimension must be integer in [1,8192]");
    }
    out.max_dimension = maxDim;
  }
  const fullQuality = raw["full_quality"];
  if (fullQuality !== undefined) {
    if (typeof fullQuality !== "boolean") {
      throw codedError("INVALID_PARAMS", "full_quality must be boolean");
    }
    out.full_quality = fullQuality;
  }
  const intent = raw["intent"];
  if (intent !== undefined) {
    if (intent !== "glance" && intent !== "verify" && intent !== "read_text" && intent !== "user_requested") {
      throw codedError("INVALID_PARAMS", "intent must be one of: glance, verify, read_text, user_requested");
    }
    out.intent = intent;
  }
  const annotate = raw["annotate"];
  if (annotate !== undefined) {
    if (annotate !== "som" && annotate !== "none") {
      throw codedError("INVALID_PARAMS", "annotate must be 'som' or 'none'");
    }
    out.annotate = annotate;
  }
  const region = raw["region"];
  if (region !== undefined) {
    if (typeof region !== "object" || region === null || Array.isArray(region)) {
      throw codedError("INVALID_PARAMS", "region must be an object");
    }
    const r = region as Record<string, unknown>;
    const x = r["x"];
    const y = r["y"];
    const w = r["w"];
    const h = r["h"];
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof w !== "number" ||
      typeof h !== "number" ||
      w <= 0 ||
      h <= 0
    ) {
      throw codedError("INVALID_PARAMS", "region must be {x,y,w,h} with positive w,h");
    }
    out.region = { x, y, w, h };
  }
  const dims = raw["dimensions"];
  if (dims !== undefined) {
    if (typeof dims !== "object" || dims === null || Array.isArray(dims)) {
      throw codedError("INVALID_PARAMS", "dimensions must be an object");
    }
    const longest = (dims as Record<string, unknown>)["longest_edge"];
    if (longest !== undefined) {
      if (typeof longest !== "number" || !Number.isInteger(longest) || longest < 1 || longest > 8192) {
        throw codedError("INVALID_PARAMS", "dimensions.longest_edge must be integer in [1,8192]");
      }
      out.dimensions = { longest_edge: longest };
    } else {
      out.dimensions = {};
    }
  }
  return out;
}

function stripDataUrlPrefix(dataUrl: string): string {
  // dataUrl is like "data:image/png;base64,<b64>"
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

async function captureVisible(
  windowId: number,
  format: "png" | "jpeg",
  quality: number,
): Promise<string> {
  // chrome.tabs.captureVisibleTab quality is only meaningful for jpeg, but
  // passing it for png is harmless.
  const opts: chrome.tabs.CaptureVisibleTabOptions = { format, quality };
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    throw codedError("INTERNAL", "captureVisibleTab returned empty payload");
  }
  return stripDataUrlPrefix(dataUrl);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // btoa(String.fromCharCode(...)) blows the call stack past ~100KB inputs,
  // so encode in 32KB chunks.
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function downscaleAndEncode(
  sourceBase64: string,
  sourceFormat: "png" | "jpeg",
  maxDimension: number,
  quality: number,
  region: { x: number; y: number; w: number; h: number } | undefined,
  dpr: number,
): Promise<{ base64: string; width: number; height: number }> {
  const mime = sourceFormat === "png" ? "image/png" : "image/jpeg";
  const res = await fetch(`data:${mime};base64,${sourceBase64}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  // captureVisibleTab returns device-pixel imagery on Retina. The region
  // is supplied in CSS pixels; multiply by dpr to project into source pixels.
  let srcX = 0;
  let srcY = 0;
  let srcW = bitmap.width;
  let srcH = bitmap.height;
  if (region !== undefined) {
    srcX = Math.max(0, Math.round(region.x * dpr));
    srcY = Math.max(0, Math.round(region.y * dpr));
    srcW = Math.max(1, Math.min(bitmap.width - srcX, Math.round(region.w * dpr)));
    srcH = Math.max(1, Math.min(bitmap.height - srcY, Math.round(region.h * dpr)));
  }
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw codedError("INTERNAL", "OffscreenCanvas 2d context unavailable");
  }
  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, w, h);
  bitmap.close();
  const outBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: Math.max(0, Math.min(1, quality / 100)),
  });
  const buf = await outBlob.arrayBuffer();
  return { base64: arrayBufferToBase64(buf), width: w, height: h };
}

/** Maximum base64-encoded image bytes returned in a tool result. Agents
 *  consistently overflow their context envelope past ~30KB of base64 image
 *  payload, so we re-encode at successively smaller dimensions / qualities
 *  until we clear this budget. Picked from the post-trusted-input eval —
 *  default-intent screenshots on 1376+ wide pages routinely came back at
 *  60-90KB before this. */
const SCREENSHOT_BYTE_BUDGET = 28 * 1024;
const SCREENSHOT_FLOOR_DIM = 256;

async function downscaleToBudget(
  sourceBase64: string,
  sourceFormat: "png" | "jpeg",
  startMaxDimension: number,
  startQuality: number,
  region: { x: number; y: number; w: number; h: number } | undefined,
  dpr: number,
): Promise<{ base64: string; width: number; height: number }> {
  let dim = startMaxDimension;
  let q = startQuality;
  let r = await downscaleAndEncode(sourceBase64, sourceFormat, dim, q, region, dpr);
  // Up to 3 retries. Each backs off the longest dimension 50% (floor
  // SCREENSHOT_FLOOR_DIM) and drops quality 20 points (floor 15). Content-rich
  // pages typically clear the budget by attempt 2; the loop bounds the
  // total work to ~4 encode passes worst case.
  for (let i = 0; i < 3 && r.base64.length > SCREENSHOT_BYTE_BUDGET; i += 1) {
    if (dim <= SCREENSHOT_FLOOR_DIM && q <= 15) break;
    if (dim > SCREENSHOT_FLOOR_DIM) {
      dim = Math.max(SCREENSHOT_FLOOR_DIM, Math.floor(dim / 2));
    }
    q = Math.max(15, q - 20);
    r = await downscaleAndEncode(sourceBase64, sourceFormat, dim, q, region, dpr);
  }
  return r;
}

export function registerScreenshotHandler(
  router: Router,
  opts: { tabIdMap: Map<string, number> },
): void {
  router.register("browser_screenshot", async (rawParams) => {
    const params = parseParams(rawParams);

    const chromeTabId = opts.tabIdMap.get(params.tab_id);
    if (chromeTabId === undefined) {
      throw codedError("TAB_NOT_FOUND", `unknown tab_id: ${params.tab_id}`);
    }

    if (params.full_page === true) {
      throw codedError("INTERNAL", "full_page requires CDP attach (deferred to v2)");
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(chromeTabId);
    } catch {
      throw codedError("TAB_NOT_FOUND", `chrome tab ${chromeTabId} no longer exists`);
    }

    const preset = params.intent !== undefined ? INTENT_PRESETS[params.intent] : undefined;
    const fullQuality = params.full_quality ?? preset?.full_quality ?? false;
    const explicitFormat = params.format;
    const format: "png" | "jpeg" = explicitFormat ?? "jpeg";
    const quality: number = params.quality ?? preset?.quality ?? (fullQuality ? 95 : 40);
    // dimensions.longest_edge wins over max_dimension when both are set —
    // the observation-architecture plan's action-grade default (768px) is
    // the new preferred knob; max_dimension stays for back-compat callers.
    const longestEdge =
      params.dimensions?.longest_edge ??
      params.max_dimension ??
      preset?.max_dimension ??
      DEFAULT_LONGEST_EDGE;
    const maxDimension = longestEdge;

    let metrics = { dpr: 1, scroll_x: 0, scroll_y: 0, inner_w: 0, inner_h: 0 };
    try {
      metrics = await execInTab(chromeTabId, readPageMetrics, [] as const);
    } catch (err) {
      console.warn("[browserops] readPageMetrics failed:", err);
    }

    if (fullQuality) {
      // Bypass: capture at the requested format/quality and skip downscale.
      const image_base64 = await captureVisible(tab.windowId, format, quality);
      const cssW =
        typeof tab.width === "number" && tab.width > 0 ? tab.width : metrics.inner_w;
      const cssH =
        typeof tab.height === "number" && tab.height > 0 ? tab.height : metrics.inner_h;
      const ssW = Math.round(cssW * metrics.dpr);
      const ssH = Math.round(cssH * metrics.dpr);
      const observation_token = cacheObservation({
        tab_id: chromeTabId,
        css_pixel_dims: { w: cssW, h: cssH },
        screenshot_dims: { w: ssW, h: ssH },
        scale: cssW > 0 ? ssW / cssW : 1,
        scroll: { x: metrics.scroll_x, y: metrics.scroll_y },
        dpr: metrics.dpr,
        representation: "screenshot",
      });
      return {
        image_base64,
        width: cssW,
        height: cssH,
        format,
        observation_token,
        css_pixel_dims: { w: cssW, h: cssH },
        screenshot_dims: { w: ssW, h: ssH },
        scale: cssW > 0 ? ssW / cssW : 1,
        scroll: { x: metrics.scroll_x, y: metrics.scroll_y },
        dpr: metrics.dpr,
        representation: "screenshot" as const,
      };
    }

    // Downscale path always emits JPEG regardless of requested format (that is
    // the point of the new defaults). Callers who need true PNG should pass
    // full_quality:true. The budget-aware downscale enforces a hard ceiling
    // on the returned base64 size so default-intent screenshots stop blowing
    // the agent's context envelope on wide / content-rich pages.
    const captured = await captureVisible(tab.windowId, "png", 100);
    const encoded = await downscaleToBudget(captured, "png", maxDimension, quality, params.region, metrics.dpr);
    const cssW = params.region?.w ?? metrics.inner_w;
    const cssH = params.region?.h ?? metrics.inner_h;
    const scaleVal = cssW > 0 ? encoded.width / cssW : 1;

    let finalBase64 = encoded.base64;
    let finalW = encoded.width;
    let finalH = encoded.height;
    let som_map: Record<string, { ref: string; role: string; name: string }> | undefined;
    let representation: "screenshot" | "screenshot_som" = "screenshot";

    if (params.annotate === "som") {
      let candidates: ReturnType<typeof collectSomCandidates> = [];
      try {
        candidates = await execInTab(chromeTabId, collectSomCandidates, [] as const);
      } catch (err) {
        console.warn("[browserops] SoM candidate collection failed:", err);
      }
      try {
        const annotated = await renderSom(
          encoded.base64,
          "image/jpeg",
          candidates,
          scaleVal,
          params.region ? { x: params.region.x, y: params.region.y } : undefined,
          quality,
        );
        finalBase64 = annotated.base64;
        finalW = annotated.width;
        finalH = annotated.height;
        som_map = annotated.som_map;
        representation = "screenshot_som";
      } catch (err) {
        console.warn("[browserops] SoM render failed; returning unannotated:", err);
      }
    }

    const observation_token = cacheObservation({
      tab_id: chromeTabId,
      css_pixel_dims: { w: cssW, h: cssH },
      screenshot_dims: { w: finalW, h: finalH },
      scale: cssW > 0 ? finalW / cssW : 1,
      scroll: { x: metrics.scroll_x, y: metrics.scroll_y },
      dpr: metrics.dpr,
      representation,
    });
    return {
      image_base64: finalBase64,
      width: finalW,
      height: finalH,
      format: "jpeg" as const,
      observation_token,
      css_pixel_dims: { w: cssW, h: cssH },
      screenshot_dims: { w: finalW, h: finalH },
      scale: cssW > 0 ? finalW / cssW : 1,
      scroll: { x: metrics.scroll_x, y: metrics.scroll_y },
      dpr: metrics.dpr,
      representation,
      ...(som_map !== undefined ? { som_map } : {}),
    };
  });
}
