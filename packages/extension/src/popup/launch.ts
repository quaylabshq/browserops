/**
 * Pure helpers for the popup's "Launch Claude here" button. Kept out of
 * index.ts (which touches the DOM + chrome APIs on import) so they can be
 * unit-tested in plain Node.
 *
 * The popup POSTs page metadata + the loopback token to the bridge's
 * /launch endpoint; the bridge opens a new terminal running Claude.
 */

/** Loopback bridge endpoint. Hardcoded like the onboard page's /pair fetch. */
export const LAUNCH_ENDPOINT = "http://127.0.0.1:57321/launch";

export interface PageMeta {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
}

/** Trim, drop empties, and cap length. Returns undefined for unusable input. */
export function clampText(s: string | undefined | null, max = 500): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (t.length === 0) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Build the JSON body for POST /launch from the token + captured metadata. */
export function buildLaunchBody(token: string, meta: PageMeta): Record<string, string> {
  const body: Record<string, string> = { token, url: meta.url };
  const title = clampText(meta.title);
  if (title) body["title"] = title;
  const description = clampText(meta.description);
  if (description) body["description"] = description;
  const siteName = clampText(meta.siteName);
  if (siteName) body["site_name"] = siteName;
  return body;
}

/** Map a /launch response (or a null = unreachable bridge) to popup copy. */
export function launchStatusMessage(
  res: { ok: boolean; status: number } | null,
  payloadError?: string,
): string {
  if (res === null) return "Bridge not running — start it, then retry.";
  if (res.ok) return "Claude launched ✓";
  if (res.status === 401 || res.status === 403) return "Not authorized — re-run setup.";
  if (payloadError === "no_terminal") return "Couldn't open a terminal window.";
  if (payloadError === "launch_unavailable") return "Launch isn't available on this bridge.";
  return "Couldn't launch Claude.";
}

/**
 * Runs in the target page via chrome.scripting.executeScript — must be a
 * self-contained function (no closure refs). Reads cheap, high-signal
 * metadata; the agent decides from the user's request whether the page
 * matters, so we never capture page body content.
 */
export function grabPageMeta(): { title: string; description: string; siteName: string } {
  const meta = (selector: string): string => {
    const el = document.querySelector(selector) as { content?: string } | null;
    return el?.content ?? "";
  };
  return {
    title: document.title || "",
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]') || "",
    siteName: meta('meta[property="og:site_name"]') || "",
  };
}
