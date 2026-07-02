/**
 * Extension-pin helpers.
 *
 * The bridge pins the first extension it sees to
 * ~/.browserops/extension_id and refuses every other origin at /pair and
 * WS upgrade. That's the right behavior when the pinned extension is
 * still installed — it defeats race attacks where a rogue extension
 * tries to claim the token — but it becomes a silent-403 trap when the
 * pinned extension is uninstalled, replaced, or side-loaded as a fresh
 * unpacked build with a different chrome-extension:// ID.
 *
 * These helpers give us two things:
 *   1. `readPinnedExtensionId` + `clearPinnedExtensionId` — the moving
 *      parts of the recovery flow, so `init --repair`, `uninstall
 *      --purge`, and a dedicated `reset-extension-pin` command all
 *      speak to the pin file through one code path.
 *   2. `detectPinMismatch` — scans the log for the specific pattern
 *      (repeated *_pin_rejected with no recent ws_ready) that turns a
 *      cold silent failure into a discoverable warning in status /
 *      doctor.
 */
import * as fs from "node:fs/promises";
import { extensionIdPath, logPath } from "./paths.js";

/**
 * Read the pinned extension ID from ~/.browserops/extension_id. Returns
 * null when the file is missing or empty (== not yet pinned).
 */
export async function readPinnedExtensionId(): Promise<string | null> {
  try {
    const raw = await fs.readFile(extensionIdPath(), "utf8");
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Delete ~/.browserops/extension_id. Returns true if a pin was cleared,
 * false when nothing existed. Any other error propagates.
 */
export async function clearPinnedExtensionId(): Promise<boolean> {
  try {
    await fs.unlink(extensionIdPath());
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export interface PinMismatchSignal {
  /** True when the pattern strongly suggests a stale pin. */
  mismatch: boolean;
  /** The origin(s) currently being refused (chrome-extension://…). */
  rejectedOrigins: string[];
  /** How many rejections we saw in the scan window. */
  rejectCount: number;
  /** Currently-pinned extension ID, or null if no pin file is present. */
  pinnedId: string | null;
  /**
   * ms-since-epoch of the last successful ws_ready, or null when no
   * successful pair has ever landed in the scanned window.
   */
  lastWsReadyMs: number | null;
}

const REJECT_EVENTS = new Set(["upgrade_pin_rejected", "pair_pin_rejected"]);
const WS_READY_EVENT = "ws_ready";
const LOG_TAIL_BYTES = 512_000;
const MIN_REJECTS_TO_WARN = 3;

/**
 * Scan the tail of ~/.browserops/log.jsonl for pin-rejection events.
 *
 * Heuristic: if we see >= MIN_REJECTS_TO_WARN pin-rejection events
 * *after* the most recent ws_ready (or in the entire tail if there is
 * no ws_ready), the pinned extension is almost certainly gone — either
 * uninstalled, replaced, or was a dev build that got a new ID.
 *
 * Returns null when the log can't be read; callers should treat that as
 * "no signal" and stay quiet. Doctor already fails on missing state dir
 * via a separate check.
 */
export async function detectPinMismatch(): Promise<PinMismatchSignal | null> {
  let raw: string;
  try {
    const buf = await fs.readFile(logPath());
    const total = buf.byteLength;
    const slice = total > LOG_TAIL_BYTES ? buf.slice(total - LOG_TAIL_BYTES) : buf;
    raw = slice.toString("utf8");
  } catch {
    return null;
  }

  let lastWsReadyMs: number | null = null;
  const rejects: { ts: number; origin: string }[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = typeof parsed["event"] === "string" ? parsed["event"] : null;
    if (!event) continue;
    const tsStr = typeof parsed["ts"] === "string" ? parsed["ts"] : null;
    const ts = tsStr ? Date.parse(tsStr) : NaN;
    if (event === WS_READY_EVENT && Number.isFinite(ts)) {
      lastWsReadyMs = ts;
      continue;
    }
    if (REJECT_EVENTS.has(event)) {
      const origin = typeof parsed["origin"] === "string" ? parsed["origin"] : "";
      rejects.push({ ts: Number.isFinite(ts) ? ts : 0, origin });
    }
  }

  // Only rejections that landed after the last successful hello count.
  // If we've never seen a hello, take everything in the window.
  const relevant = rejects.filter(
    (r) => lastWsReadyMs === null || r.ts === 0 || r.ts > lastWsReadyMs,
  );

  const pinnedId = await readPinnedExtensionId().catch(() => null);
  const rejectedOrigins = uniqueOrigins(relevant.map((r) => r.origin));

  return {
    mismatch: relevant.length >= MIN_REJECTS_TO_WARN,
    rejectedOrigins,
    rejectCount: relevant.length,
    pinnedId,
    lastWsReadyMs,
  };
}

function uniqueOrigins(origins: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of origins) {
    if (!o || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
  }
  return out;
}

/**
 * Short label for a chrome-extension:// origin ("chrome-extension://fcjc…").
 * Used by CLI output that has to fit on one line.
 */
export function shortOrigin(origin: string): string {
  if (!origin) return "(unknown)";
  const m = origin.match(/^chrome-extension:\/\/([a-p]+)/i);
  if (!m || !m[1]) return origin;
  const id = m[1];
  return id.length <= 8 ? `chrome-extension://${id}` : `chrome-extension://${id.slice(0, 4)}…`;
}

/**
 * Short label for a pinned ID (bare, no scheme).
 */
export function shortId(id: string | null): string {
  if (!id) return "(none)";
  return id.length <= 8 ? id : `${id.slice(0, 4)}…`;
}
