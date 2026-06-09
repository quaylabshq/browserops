/**
 * Tiny client for the bridge's /status HTTP endpoint. Used by
 * `browserops init` to poll for "the user has installed the extension
 * and it has paired" without grepping the daemon log file.
 *
 * The endpoint binds to 127.0.0.1 only, returns JSON, and carries no
 * secret material — it's safe to call repeatedly.
 */

export interface BridgeStatus {
  pair_consumed: boolean;
  extension_connected: boolean;
  extension_id: string | null;
  bridge_version: string;
}

export async function fetchBridgeStatus(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 1500,
): Promise<BridgeStatus | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/status`, { signal: ac.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!isStatus(body)) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isStatus(v: unknown): v is BridgeStatus {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["pair_consumed"] === "boolean" &&
    typeof o["extension_connected"] === "boolean" &&
    (o["extension_id"] === null || typeof o["extension_id"] === "string") &&
    typeof o["bridge_version"] === "string"
  );
}

export interface WaitForPairOpts {
  port: number;
  host?: string;
  /** Total time we'll wait. Default 5 min — matches the time most users
   *  take to install + click Add-to-Chrome + accept the install prompt. */
  timeoutMs?: number;
  /** Time between polls. Default 750ms — keeps the spinner lively
   *  without thrashing the bridge. */
  intervalMs?: number;
  /** Called once on the first time we observe pair_consumed flipping
   *  to true (i.e. the extension has fetched /pair). The CLI uses this
   *  to update the progress line. */
  onPairConsumed?: () => void;
  /** Called periodically (every intervalMs) so the spinner can advance. */
  onTick?: (elapsedMs: number, status: BridgeStatus | null) => void;
}

export type WaitForPairResult =
  | { ok: true; status: BridgeStatus }
  | { ok: false; reason: "timeout" | "bridge_unreachable" };

/**
 * Poll /status until the extension is connected. Returns ok: false
 * when the deadline lapses, or when the bridge stops responding for
 * the full polling window (e.g. the daemon crashed).
 */
export async function waitForExtensionPair(opts: WaitForPairOpts): Promise<WaitForPairResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const intervalMs = opts.intervalMs ?? 750;
  const start = Date.now();
  let sawPairConsumed = false;
  let lastOk = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await fetchBridgeStatus(opts.port, opts.host);
    const elapsed = Date.now() - start;
    if (status !== null) {
      lastOk = Date.now();
      if (!sawPairConsumed && status.pair_consumed) {
        sawPairConsumed = true;
        opts.onPairConsumed?.();
      }
      if (status.extension_connected) {
        opts.onTick?.(elapsed, status);
        return { ok: true, status };
      }
    } else if (Date.now() - lastOk > 30_000) {
      // The bridge has been silent for 30s — assume it died.
      return { ok: false, reason: "bridge_unreachable" };
    }
    opts.onTick?.(elapsed, status);
    await sleep(intervalMs);
  }
  return { ok: false, reason: "timeout" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
