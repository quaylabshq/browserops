/**
 * browser_propose_locator handler.
 *
 * Params: { tab_id, ref }
 * Result: { unique, locator, tier, fragile, warnings, candidates }
 *
 * Uses the in-memory RefCache snapshot for the tab — the caller is
 * expected to have primed it via browser_read (a11y_tree, augment:true)
 * first. Same contract as browser_locate; the playbook executor's
 * auto-prime applies here too once this is invoked from inside the
 * execute loop.
 *
 * The actual algorithm lives in ../../lib/locator-propose.ts. This module
 * is the thin MCP/HTTP-style adapter: param validation, snapshot fetch,
 * error coding.
 */
import type { ErrorCode } from "@browserops/shared";
import type { Router, Context } from "../router.js";
import type { RefCache } from "../ref-cache.js";
import { proposeLocator } from "../../lib/locator-propose.js";

interface ProposeDeps {
  tabIdMap: Map<string, number>;
  refCache: RefCache;
}

interface ProposeParams {
  tab_id: string;
  ref: number;
}

function codedError(code: ErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: ErrorCode };
  err.code = code;
  return err;
}

function parseParams(raw: Record<string, unknown>): ProposeParams {
  const tabId = raw["tab_id"];
  if (typeof tabId !== "string") {
    throw codedError(
      "INVALID_PARAMS",
      "browser_propose_locator requires tab_id:string",
    );
  }
  const ref = raw["ref"];
  if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
    throw codedError(
      "INVALID_PARAMS",
      "browser_propose_locator requires ref:integer (>=1)",
    );
  }
  return { tab_id: tabId, ref };
}

export function registerProposeLocatorHandler(
  router: Router,
  deps: ProposeDeps,
): void {
  router.register(
    "browser_propose_locator",
    async (raw: Record<string, unknown>, _ctx: Context) => {
      const params = parseParams(raw);

      const chromeTabId = deps.tabIdMap.get(params.tab_id);
      if (chromeTabId === undefined) {
        throw codedError(
          "TAB_NOT_FOUND",
          `tab ${params.tab_id} not registered`,
        );
      }

      const snapshot = deps.refCache.get(params.tab_id);
      if (snapshot === undefined) {
        throw codedError(
          "LOCATOR_NOT_FOUND",
          "no ref-cache snapshot for this tab; call browser_read first",
        );
      }

      const entries = Array.from(snapshot.entries.values());

      // Resolve the target — early-fail with REF_NOT_FOUND if the caller
      // passed a ref that isn't in the snapshot.
      const target = entries.find((e) => e.ref === params.ref);
      if (target === undefined) {
        throw codedError(
          "REF_NOT_FOUND",
          `ref ${params.ref} is not present in the current snapshot`,
        );
      }

      const result = proposeLocator(entries, params.ref);
      return {
        unique: result.unique,
        locator: result.locator,
        tier: result.tier,
        fragile: result.fragile,
        warnings: result.warnings,
        candidates: result.candidates,
      };
    },
    { feature: "playbooks" },
  );
}
