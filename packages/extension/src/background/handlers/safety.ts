import type { ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";

/**
 * Extension-side handler for the bridge's `safety_prompt` request.
 *
 * Bridge-side autoconfirm (BROWSEROPS_AUTOCONFIRM) short-circuits before
 * the request is sent, so we always assume a real user decision is required.
 * See plans/06-autonomy-safety.md §4.5.
 *
 * UX (v1): flip action badge to "!", persist prompt to chrome.storage.session,
 * attempt to openPopup (MV3 requires a user gesture, so this often no-ops —
 * the red badge signals the user to click the action). The popup reads the
 * pending prompt, renders Allow/Deny, and routes the decision back via
 * chrome.runtime.sendMessage({ type: "safety_decision", decision_id, allow }).
 */

interface SafetyPromptParams {
  tool: string;
  params: Record<string, unknown>;
  reason: string;
  decision_id: string;
  timeout_ms: number;
}

const SESSION_KEY = "pendingSafetyPrompt";
const AUTO_APPROVE_KEY = "autoApprove";

const pending = new Map<
  string,
  (result: { decision_id: string; allow: boolean }) => void
>();

async function isAutoApprove(): Promise<boolean> {
  const s = await chrome.storage.session.get(AUTO_APPROVE_KEY);
  return s[AUTO_APPROVE_KEY] === true;
}

function codedError(code: ErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: ErrorCode };
  err.code = code;
  return err;
}

function parse(raw: Record<string, unknown>): SafetyPromptParams {
  const tool = raw["tool"];
  const params = raw["params"];
  const reason = raw["reason"];
  const decision_id = raw["decision_id"];
  const timeout_ms = raw["timeout_ms"];
  if (typeof tool !== "string") throw codedError("INVALID_PARAMS", "tool must be a string");
  if (typeof params !== "object" || params === null) {
    throw codedError("INVALID_PARAMS", "params must be an object");
  }
  if (typeof reason !== "string") throw codedError("INVALID_PARAMS", "reason must be a string");
  if (typeof decision_id !== "string" || decision_id === "") {
    throw codedError("INVALID_PARAMS", "decision_id must be a non-empty string");
  }
  if (typeof timeout_ms !== "number" || !Number.isFinite(timeout_ms) || timeout_ms <= 0) {
    throw codedError("INVALID_PARAMS", "timeout_ms must be a positive number");
  }
  return {
    tool,
    params: params as Record<string, unknown>,
    reason,
    decision_id,
    timeout_ms,
  };
}

function setPendingBadge(): void {
  chrome.action.setBadgeText({ text: "!" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#c1121f" }).catch(() => {});
}

export function registerSafetyHandler(
  router: Router,
  opts: { restoreBadge: () => void },
): void {
  router.register("safety_prompt", async (raw) => {
    const p = parse(raw);

    if (await isAutoApprove()) {
      // Extension-side "yolo" mode — session-scoped toggle in the popup.
      // The paper trail lives in the bridge safety log (phase: decided,
      // allow: true); we also emit a console warning so it's obvious in
      // the service-worker devtools that the prompt was not user-seen.
      console.warn(
        `[safety] auto-approved ${p.tool} (decision_id=${p.decision_id}) — yolo mode on`,
      );
      return { decision_id: p.decision_id, allow: true };
    }

    setPendingBadge();
    await chrome.storage.session.set({
      [SESSION_KEY]: {
        tool: p.tool,
        params: p.params,
        reason: p.reason,
        decision_id: p.decision_id,
        timeout_ms: p.timeout_ms,
        ts: Date.now(),
      },
    });

    // openPopup requires a user gesture on MV3 in most channels; it may throw
    // or silently no-op. The badge "!" is the primary signal.
    try {
      await chrome.action.openPopup();
    } catch {
      /* ignore — user will click the action manually */
    }

    return new Promise<{ decision_id: string; allow: boolean }>((resolve) => {
      const finalize = (allow: boolean): void => {
        pending.delete(p.decision_id);
        void chrome.storage.session.remove(SESSION_KEY);
        opts.restoreBadge();
        resolve({ decision_id: p.decision_id, allow });
      };

      const timer = setTimeout(() => finalize(false), p.timeout_ms);

      pending.set(p.decision_id, (result) => {
        clearTimeout(timer);
        finalize(result.allow);
      });
    });
  });
}

/** Called from the background runtime.onMessage listener when the popup
 *  reports a user decision. Returns true if a matching prompt was resolved. */
export function resolveSafetyDecision(decisionId: string, allow: boolean): boolean {
  const fn = pending.get(decisionId);
  if (fn === undefined) return false;
  fn({ decision_id: decisionId, allow });
  return true;
}
