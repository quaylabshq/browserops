/**
 * Pure helpers for the side-panel launcher. Kept out of the page scripts
 * (which touch the DOM + chrome APIs on import) so they can be unit-tested
 * in plain Node.
 *
 * The launcher POSTs the chosen agent + optional instruction + page metadata
 * and the loopback token to the bridge's /launch endpoint; the bridge opens a
 * new terminal running that agent.
 */

/** Loopback bridge endpoint. Hardcoded like the onboard page's /pair fetch. */
export const LAUNCH_ENDPOINT = "http://127.0.0.1:57321/launch";

export interface PageMeta {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
}

export interface LaunchInput {
  token: string;
  agent: string;
  instruction?: string;
  meta: PageMeta;
}

/** Trim, drop empties, and cap length. Returns undefined for unusable input. */
export function clampText(s: string | undefined | null, max = 500): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (t.length === 0) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Build the JSON body for POST /launch. */
export function buildLaunchBody(input: LaunchInput): Record<string, string> {
  const body: Record<string, string> = {
    token: input.token,
    agent: input.agent,
    url: input.meta.url,
  };
  const instruction = clampText(input.instruction, 8000);
  if (instruction) body["instruction"] = instruction;
  const title = clampText(input.meta.title);
  if (title) body["title"] = title;
  const description = clampText(input.meta.description);
  if (description) body["description"] = description;
  const siteName = clampText(input.meta.siteName);
  if (siteName) body["site_name"] = siteName;
  return body;
}

/** The assistant-bubble copy shown after a successful launch. */
export function launchedMessage(agentLabel: string): string {
  return `Launched ${agentLabel} in your terminal — continue the conversation there.`;
}

/** Map a /launch response (or a null = unreachable bridge) to launcher copy. */
export function launchStatusMessage(
  res: { ok: boolean; status: number } | null,
  payloadError?: string,
): string {
  if (res === null) return "Bridge not running — start it, then retry.";
  if (res.ok) return "Launched ✓ — see your terminal.";
  if (res.status === 401 || res.status === 403) return "Not authorized — re-run setup.";
  if (payloadError === "agent_disabled") return "That agent isn't available yet.";
  if (payloadError === "no_terminal") return "Couldn't open a terminal window.";
  if (payloadError === "launch_unavailable") return "Launch isn't available on this bridge.";
  return "Couldn't launch.";
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
