import {
  NAVIGATE_TIMEOUT_MS,
  WAIT_FOR_TIMEOUT_CAP_MS,
  type ActionExpectation,
  type Effect,
  type ErrorCode,
  type PageEffect,
} from "@browserops/shared";
import { checkEffectExpectation } from "./effects.js";
import { captureEffect } from "../effect.js";
import { pollUntilMet } from "../expectation-poller.js";
import type { Router } from "../router.js";
import type { RefCache } from "../ref-cache.js";
import type { NetworkTracker } from "../network-tracker.js";
import type { CdpManager } from "../cdp.js";

interface NavigationOpts {
  tabIdMap: Map<string, number>;
  refCache: RefCache;
  network: NetworkTracker;
  cdp: CdpManager;
}

const WAIT_FOR_POLL_DEFAULT_MS = 250;
const WAIT_FOR_POLL_MIN_MS = 50;
const WAIT_FOR_POLL_MAX_MS = 5000;

function makeError(code: ErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function resolveChromeId(tabIdMap: Map<string, number>, tabId: unknown): number {
  if (typeof tabId !== "string") {
    throw makeError("INVALID_PARAMS", "tab_id must be a string");
  }
  const chromeId = tabIdMap.get(tabId);
  if (chromeId === undefined) {
    throw makeError("TAB_NOT_FOUND", `no chrome tab for tab_id: ${tabId}`);
  }
  return chromeId;
}

function waitForLoadComplete(chromeTabId: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
      if (id !== chromeTabId) return;
      if (changeInfo.status !== "complete") return;
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(makeError("TIMEOUT", `navigation did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function readTabUrl(chromeTabId: number): Promise<string> {
  const tab = await chrome.tabs.get(chromeTabId);
  return tab.url ?? tab.pendingUrl ?? "";
}

/**
 * Injected into the target tab's MAIN world to check wait_for conditions
 * for text/ref modes in a single round trip. Returns which (if any) matched.
 *
 * "text" matches if the substring appears anywhere in document.body.innerText.
 * "ref" matches if the selector resolves to an element that is present,
 * connected, and has a non-zero bounding box (a minimal DOM-only visibility
 * proxy — a fuller CDP-based visibility check is intentionally deferred).
 */
function injectedCheckWaitFor(
  selector: string | null,
  text: string | null,
): { matched: "ref" | "text" | null } {
  if (text !== null) {
    const body = document.body;
    const hay = body === null ? "" : body.innerText;
    if (hay.includes(text)) return { matched: "text" };
  }
  if (selector !== null) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el !== null && el.isConnected) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { matched: "ref" };
    }
  }
  return { matched: null };
}

export function registerNavigationHandlers(router: Router, opts: NavigationOpts): void {
  const { tabIdMap, refCache, network, cdp } = opts;

  router.register(
    "browser_navigate",
    async (
      params,
    ): Promise<{
      final_url: string;
      page_effect?: PageEffect;
      effect?: Effect;
      expectation_met?: boolean;
      mismatch_reason?: string;
      warnings?: string[];
    }> => {
      const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
      const url = params["url"];
      if (typeof url !== "string") {
        throw makeError("INVALID_PARAMS", "url must be a string");
      }
      const { result: handlerResult, effect: navEffect } = await captureEffect(
        chromeId,
        async () => {
          const waitForLoadRaw = params["wait_for_load"];
          const shouldWait = waitForLoadRaw !== false;
          // observe_effects defaults to true; only explicit false opts out.
          const observeEffects = params["observe_effects"] !== false;

          // Parse expect_effect
          const expectEffectRaw = params["expect_effect"];
          type ExpectEffect = "any" | "dom" | "navigation" | "none";
          let expectEffect: ExpectEffect | undefined;
          if (expectEffectRaw !== undefined) {
            if (
              expectEffectRaw !== "any" &&
              expectEffectRaw !== "dom" &&
              expectEffectRaw !== "navigation" &&
              expectEffectRaw !== "none"
            ) {
              throw makeError("INVALID_PARAMS", "expect_effect must be any|dom|navigation|none");
            }
            expectEffect = expectEffectRaw as ExpectEffect;
          }

          // Capture baseline before navigation begins.
          const baselineUrl = observeEffects ? await readTabUrl(chromeId) : "";
          const netBefore = observeEffects ? network.snapshot(chromeId) : null;

          await chrome.tabs.update(chromeId, { url });
          if (shouldWait) {
            await waitForLoadComplete(chromeId, NAVIGATE_TIMEOUT_MS);
          }
          const finalUrl = await readTabUrl(chromeId);

          // CDP-trusted input is the default: every http(s) navigation gets
          // persistent CDP attach so click/type/press/hover dispatch through
          // Input.dispatchMouseEvent / Input.insertText (trusted events that
          // traverse iframes, shadow DOM, and survive isTrusted-gated handlers).
          // The "controlled by automation" banner appears as a result; callers
          // can opt a tab out with browser_set_cdp(tab_id, false).
          void cdp.autoAttachAlways(chromeId, finalUrl);

          if (!observeEffects || netBefore === null) {
            if (expectEffect !== undefined) {
              return {
                final_url: finalUrl,
                warnings: [
                  "expect_effect set but observe_effects:false — no effect data to verify against",
                ],
              };
            }
            return { final_url: finalUrl };
          }

          // 300ms post-load settle window to capture JS rendering and late network activity.
          await new Promise<void>((r) => setTimeout(r, 300));

          const netAfter = network.snapshot(chromeId);
          const urlChanged = baselineUrl !== finalUrl;

          const effect: PageEffect = {
            dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
            url: {
              changed: urlChanged,
              ...(urlChanged ? { before: baselineUrl, after: finalUrl } : {}),
            },
            focus: { changed: false },
            network: {
              requests_started: Math.max(0, netAfter.totalStarted - netBefore.totalStarted),
              requests_completed: Math.max(0, netAfter.totalCompleted - netBefore.totalCompleted),
              in_flight_at_end: netAfter.inFlight,
            },
            console_errors: 0,
            window_ms: 300,
          };

          const warning = checkEffectExpectation(effect, expectEffect);
          const out: { final_url: string; page_effect: PageEffect; warnings?: string[] } = {
            final_url: finalUrl,
            page_effect: effect,
          };
          if (warning !== null) out.warnings = [warning];
          return out;
        },
      );
      let verification: { expectation_met?: boolean; mismatch_reason?: string } = {};
      const expectedRaw = params["expected"];
      if (expectedRaw !== undefined && typeof expectedRaw === "object" && expectedRaw !== null) {
        const v = await pollUntilMet(chromeId, navEffect, expectedRaw as ActionExpectation);
        verification.expectation_met = v.expectation_met;
        if (v.mismatch_reason !== undefined) verification.mismatch_reason = v.mismatch_reason;
      }
      return { ...handlerResult, effect: navEffect, ...verification };
    },
  );

  router.register(
    "browser_back",
    async (params): Promise<{ final_url: string; effect: Effect }> => {
      const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
      const { result, effect } = await captureEffect(chromeId, async () => {
        await chrome.tabs.goBack(chromeId);
        return { final_url: await readTabUrl(chromeId) };
      });
      return { ...result, effect };
    },
  );

  router.register(
    "browser_forward",
    async (params): Promise<{ final_url: string; effect: Effect }> => {
      const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
      const { result, effect } = await captureEffect(chromeId, async () => {
        await chrome.tabs.goForward(chromeId);
        return { final_url: await readTabUrl(chromeId) };
      });
      return { ...result, effect };
    },
  );

  router.register(
    "browser_reload",
    async (params): Promise<{ final_url: string; effect: Effect }> => {
      const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
      const hardRaw = params["hard"];
      const bypassCache = hardRaw === true;
      const { result, effect } = await captureEffect(chromeId, async () => {
        await chrome.tabs.reload(chromeId, { bypassCache });
        return { final_url: await readTabUrl(chromeId) };
      });
      return { ...result, effect };
    },
  );

  router.register(
    "browser_wait_for",
    async (
      params,
      ctx,
    ): Promise<{
      matched: "ref" | "text" | "url_pattern";
      elapsed_ms: number;
      action_result?: unknown;
    }> => {
      const tabIdRaw = params["tab_id"];
      if (typeof tabIdRaw !== "string") {
        throw makeError("INVALID_PARAMS", "tab_id must be a string");
      }
      const chromeId = resolveChromeId(tabIdMap, tabIdRaw);
      const urlPattern = params["url_pattern"];
      const refRaw = params["ref"];
      const textRaw = params["text"];

      if (urlPattern === undefined && refRaw === undefined && textRaw === undefined) {
        throw makeError(
          "INVALID_PARAMS",
          "wait_for requires at least one of url_pattern, ref, text",
        );
      }

      // Parse chained action params up front.
      const thenClick = params["then_click"] as { ref?: unknown } | undefined;
      const thenType = params["then_type"] as { ref?: unknown; text?: unknown } | undefined;
      if (thenClick !== undefined && thenType !== undefined) {
        throw makeError("INVALID_PARAMS", "then_click and then_type are mutually exclusive");
      }
      if (thenClick !== undefined) {
        if (typeof thenClick !== "object" || thenClick === null) {
          throw makeError("INVALID_PARAMS", "then_click must be an object with ref");
        }
        if (
          typeof thenClick.ref !== "number" ||
          !Number.isInteger(thenClick.ref) ||
          (thenClick.ref as number) < 1
        ) {
          throw makeError("INVALID_PARAMS", "then_click.ref must be a positive integer");
        }
      }
      if (thenType !== undefined) {
        if (typeof thenType !== "object" || thenType === null) {
          throw makeError("INVALID_PARAMS", "then_type must be an object with ref and text");
        }
        if (
          typeof thenType.ref !== "number" ||
          !Number.isInteger(thenType.ref) ||
          (thenType.ref as number) < 1
        ) {
          throw makeError("INVALID_PARAMS", "then_type.ref must be a positive integer");
        }
        if (typeof thenType.text !== "string") {
          throw makeError("INVALID_PARAMS", "then_type.text must be a string");
        }
      }
      if (urlPattern !== undefined && typeof urlPattern !== "string") {
        throw makeError("INVALID_PARAMS", "url_pattern must be a string");
      }
      if (textRaw !== undefined && typeof textRaw !== "string") {
        throw makeError("INVALID_PARAMS", "text must be a string");
      }
      if (refRaw !== undefined) {
        if (typeof refRaw !== "number" || !Number.isInteger(refRaw) || refRaw < 1) {
          throw makeError("INVALID_PARAMS", "ref must be a positive integer");
        }
      }

      const rawTimeout = params["timeout_ms"];
      const requestedTimeout =
        typeof rawTimeout === "number" && Number.isFinite(rawTimeout) ? rawTimeout : 10_000;
      const timeoutMs = Math.min(Math.max(requestedTimeout, 0), WAIT_FOR_TIMEOUT_CAP_MS);

      const rawPoll = params["poll_ms"];
      const requestedPoll =
        typeof rawPoll === "number" && Number.isFinite(rawPoll)
          ? rawPoll
          : WAIT_FOR_POLL_DEFAULT_MS;
      const pollMs = Math.min(Math.max(requestedPoll, WAIT_FOR_POLL_MIN_MS), WAIT_FOR_POLL_MAX_MS);

      let regex: RegExp | undefined;
      if (typeof urlPattern === "string") {
        try {
          regex = new RegExp(urlPattern);
        } catch (err) {
          throw makeError(
            "INVALID_PARAMS",
            `url_pattern is not a valid regex: ${(err as Error).message}`,
          );
        }
      }

      let refSelector: string | null = null;
      if (typeof refRaw === "number") {
        const hit = refCache.lookupWithFallback(tabIdRaw, refRaw);
        if (hit === undefined) {
          const snap = refCache.get(tabIdRaw);
          if (snap === undefined) {
            throw makeError(
              "REF_STALE",
              `no a11y snapshot for tab ${tabIdRaw}; call browser_read first`,
            );
          }
          throw makeError(
            "REF_NOT_FOUND",
            `ref ${refRaw} not present in current snapshot for ${tabIdRaw}`,
          );
        }
        const entry = hit.entry;
        refSelector = entry.selector;
      }
      const text = typeof textRaw === "string" ? textRaw : null;

      // Helper to dispatch chained action after wait succeeds.
      const dispatchChainedAction = async (): Promise<unknown | undefined> => {
        if (thenClick !== undefined) {
          const resp = await router.dispatch(
            {
              type: "request",
              id: `chain-${Date.now()}`,
              method: "browser_click",
              params: { tab_id: tabIdRaw, ref: thenClick.ref as number, observe_effects: false },
              timeout_ms: 30_000,
            },
            ctx,
          );
          if (!resp.ok) {
            throw makeError(
              "CHAINED_ACTION_FAILED",
              `then_click failed: ${(resp.error as { message?: string })?.message ?? "unknown error"}`,
            );
          }
          return resp.result;
        }
        if (thenType !== undefined) {
          const resp = await router.dispatch(
            {
              type: "request",
              id: `chain-${Date.now()}`,
              method: "browser_type",
              params: {
                tab_id: tabIdRaw,
                ref: thenType.ref as number,
                text: thenType.text as string,
                observe_effects: false,
              },
              timeout_ms: 30_000,
            },
            ctx,
          );
          if (!resp.ok) {
            throw makeError(
              "CHAINED_ACTION_FAILED",
              `then_type failed: ${(resp.error as { message?: string })?.message ?? "unknown error"}`,
            );
          }
          return resp.result;
        }
        return undefined;
      };

      const started = Date.now();
      const deadline = started + timeoutMs;
      for (;;) {
        if (regex !== undefined) {
          const currentUrl = await readTabUrl(chromeId);
          if (regex.test(currentUrl)) {
            const actionResult = await dispatchChainedAction();
            const out: { matched: "url_pattern"; elapsed_ms: number; action_result?: unknown } = {
              matched: "url_pattern",
              elapsed_ms: Date.now() - started,
            };
            if (actionResult !== undefined) out.action_result = actionResult;
            return out;
          }
        }
        if (refSelector !== null || text !== null) {
          const results = (await chrome.scripting.executeScript({
            target: { tabId: chromeId },
            world: "MAIN",
            func: injectedCheckWaitFor,
            args: [refSelector, text],
          })) as chrome.scripting.InjectionResult[];
          const first = results[0];
          const matched = first?.result?.matched;
          if (matched === "ref" || matched === "text") {
            const actionResult = await dispatchChainedAction();
            const out: { matched: "ref" | "text"; elapsed_ms: number; action_result?: unknown } = {
              matched,
              elapsed_ms: Date.now() - started,
            };
            if (actionResult !== undefined) out.action_result = actionResult;
            return out;
          }
        }
        if (Date.now() >= deadline) {
          throw makeError("TIMEOUT", `wait_for did not match within ${timeoutMs}ms`);
        }
        const remaining = deadline - Date.now();
        const sleep = Math.min(pollMs, Math.max(remaining, 0));
        if (sleep === 0) continue;
        await new Promise<void>((r) => setTimeout(r, sleep));
      }
    },
  );

  router.register(
    "browser_wait_for_idle",
    async (params): Promise<{ idle: true; elapsed_ms: number; peak_in_flight: number }> => {
      const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
      const quietRaw = params["quiet_ms"];
      const quietMs = typeof quietRaw === "number" && Number.isFinite(quietRaw) ? quietRaw : 500;
      const timeoutRaw = params["timeout_ms"];
      const requestedTimeout =
        typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) ? timeoutRaw : 10_000;
      const timeoutMs = Math.min(Math.max(requestedTimeout, 100), WAIT_FOR_TIMEOUT_CAP_MS);
      const started = Date.now();
      const deadline = started + timeoutMs;

      let peak = network.inFlight(chromeId);
      let quietSince: number | null = null;
      for (;;) {
        const current = network.inFlight(chromeId);
        if (current > peak) peak = current;
        const now = Date.now();
        if (current === 0) {
          if (quietSince === null) quietSince = now;
          if (now - quietSince >= quietMs) {
            return { idle: true, elapsed_ms: now - started, peak_in_flight: peak };
          }
        } else {
          quietSince = null;
        }
        if (now >= deadline) {
          throw makeError(
            "TIMEOUT",
            `wait_for_idle did not see ${quietMs}ms of quiet within ${timeoutMs}ms (current=${current}, peak=${peak})`,
          );
        }
        const remaining = deadline - now;
        const sleep = Math.min(100, Math.max(remaining, 0));
        if (sleep === 0) continue;
        await new Promise<void>((r) => setTimeout(r, sleep));
      }
    },
  );
}
