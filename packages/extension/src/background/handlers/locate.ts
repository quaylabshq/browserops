/**
 * browser_locate handler.
 *
 * Params: { tab_id, locator, scope? }
 * Result: { matches: Array<{ref, role, name, selector}>, used_snapshot: "current" | "previous" | "none" }
 *
 * Strategy in v1: operate against the in-memory RefCache snapshot for the
 * tab. The procedure executor on the bridge takes care of refreshing the
 * snapshot via browser_read before each locate call (and polling on miss).
 *
 * No polling here — the extension side is one-shot. Polling lives in the
 * bridge's procedure execute loop so it can apply retry/relocate budgets
 * uniformly across primitives.
 */
import type { ErrorCode, Locator } from "@browserops/shared";
import { isLocatorEmpty } from "@browserops/shared";
import type { Router, Context } from "../router.js";
import type { RefCache } from "../ref-cache.js";
import { resolveLocator } from "../../lib/locator-resolver.js";

interface LocateDeps {
  tabIdMap: Map<string, number>;
  refCache: RefCache;
}

interface LocateParams {
  tab_id: string;
  locator: Locator;
}

interface LocateResultEntry {
  ref: number;
  role: string;
  name: string;
  selector: string;
}

interface LocateResult {
  matches: LocateResultEntry[];
  used_snapshot: "current" | "previous" | "none";
}

function codedError(code: ErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: ErrorCode };
  err.code = code;
  return err;
}

function parseParams(raw: Record<string, unknown>): LocateParams {
  const tabId = raw["tab_id"];
  if (typeof tabId !== "string") {
    throw codedError("INVALID_PARAMS", "browser_locate requires tab_id:string");
  }
  const locator = raw["locator"];
  if (typeof locator !== "object" || locator === null || Array.isArray(locator)) {
    throw codedError("INVALID_PARAMS", "browser_locate requires locator:object");
  }
  if (isLocatorEmpty(locator as Locator)) {
    throw codedError(
      "INVALID_PARAMS",
      "browser_locate requires at least one of: role, name, has_text, has_text_not, in_frame, near, nth",
    );
  }
  return { tab_id: tabId, locator: locator as Locator };
}

export function registerLocateHandler(router: Router, deps: LocateDeps): void {
  router.register(
    "browser_locate",
    async (raw: Record<string, unknown>, _ctx: Context): Promise<LocateResult> => {
      const params = parseParams(raw);

      const chromeTabId = deps.tabIdMap.get(params.tab_id);
      if (chromeTabId === undefined) {
        throw codedError("TAB_NOT_FOUND", `tab ${params.tab_id} not registered`);
      }

      const snapshot = deps.refCache.get(params.tab_id);
      if (snapshot === undefined) {
        // No snapshot — the caller (procedure executor) is expected to have
        // primed the cache via browser_read before locating. Surface a
        // distinct error so the bridge can decide whether to refresh-and-
        // retry vs. fail outright.
        throw codedError(
          "LOCATOR_NOT_FOUND",
          "no ref-cache snapshot for this tab; call browser_read first",
        );
      }

      const entries = Array.from(snapshot.entries.values());
      const matches = resolveLocator(entries, params.locator);

      if (matches.length === 0) {
        throw codedError(
          "LOCATOR_NOT_FOUND",
          `no element matched locator (snapshot had ${entries.length} refs)`,
        );
      }

      return {
        matches,
        used_snapshot: "current",
      };
    },
    { feature: "procedures" },
  );
}
