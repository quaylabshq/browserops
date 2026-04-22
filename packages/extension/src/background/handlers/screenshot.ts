import type { ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";

/**
 * browser.screenshot handler.
 *
 * Params: { tab_id, full_page?, format?, quality? }
 * Result: { image_base64, width, height, format }
 *
 * v1: viewport-only capture via chrome.tabs.captureVisibleTab. full_page
 * requires CDP Page.captureScreenshot (deferred — see plan 04-tools.md
 * §4.3.10). width/height are sourced from chrome.tabs.get; if the view
 * geometry is unavailable we fall back to 0/0 placeholders so the result
 * still matches the schema's required keys.
 */

interface ScreenshotParams {
  tab_id: string;
  full_page?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
  // Step 1 plumbing: parsed but not yet used at runtime. Step 3 activates these.
  max_dimension?: number;
  full_quality?: boolean;
}

interface ScreenshotResult {
  image_base64: string;
  width: number;
  height: number;
  format: "png" | "jpeg";
}

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
): Promise<{ base64: string; width: number; height: number }> {
  const mime = sourceFormat === "png" ? "image/png" : "image/jpeg";
  const res = await fetch(`data:${mime};base64,${sourceBase64}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw codedError("INTERNAL", "OffscreenCanvas 2d context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const outBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: Math.max(0, Math.min(1, quality / 100)),
  });
  const buf = await outBlob.arrayBuffer();
  return { base64: arrayBufferToBase64(buf), width: w, height: h };
}

export function registerScreenshotHandler(
  router: Router,
  opts: { tabIdMap: Map<string, number> },
): void {
  router.register("browser.screenshot", async (rawParams) => {
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

    const fullQuality = params.full_quality === true;
    const explicitFormat = params.format;
    const format: "png" | "jpeg" = explicitFormat ?? "jpeg";
    const quality: number = params.quality ?? (fullQuality ? 95 : 40);
    const maxDimension = params.max_dimension ?? 1024;

    if (fullQuality) {
      // Bypass: capture at the requested format/quality and skip downscale.
      const image_base64 = await captureVisible(tab.windowId, format, quality);
      const width =
        typeof tab.width === "number" && tab.width > 0 ? tab.width : 0;
      const height =
        typeof tab.height === "number" && tab.height > 0 ? tab.height : 0;
      return { image_base64, width, height, format };
    }

    // Downscale path always emits JPEG regardless of requested format (that is
    // the point of the new defaults). Callers who need true PNG should pass
    // full_quality:true.
    const captured = await captureVisible(tab.windowId, "png", 100);
    const encoded = await downscaleAndEncode(captured, "png", maxDimension, quality);
    const result: ScreenshotResult = {
      image_base64: encoded.base64,
      width: encoded.width,
      height: encoded.height,
      format: "jpeg",
    };
    return result;
  });
}
