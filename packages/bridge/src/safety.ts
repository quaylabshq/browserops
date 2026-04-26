import { ENV, RISKY_CONFIRM_TIMEOUT_MS } from "@browserops/shared";
import type { RiskyDomainMatcher } from "./risky-domains.js";
import type { Logger } from "./logger.js";
import type { TraceWriter } from "./trace-writer.js";

export interface TabInfo {
  url?: string;
}

export interface SafetyCheckInput {
  tool: string;
  params: Record<string, unknown>;
  tab: TabInfo | undefined;
}

export interface RiskVerdict {
  risky: boolean;
  reason?: string;
}

export interface ConfirmationChannel {
  /** Sends a `safety_prompt` Request to the extension and resolves with user's decision. */
  awaitConfirmation(input: {
    tool: string;
    params: Record<string, unknown>;
    reason: string;
    decision_id: string;
    timeout_ms: number;
  }): Promise<{ allow: boolean }>;
}

/**
 * Bridge-side safety layer.
 *
 * Coarse heuristic in v1:
 * - `browser_execute_js` → always risky.
 * - `browser_type` with `submit: true` on a sensitive URL → risky.
 * - `browser_click` on a sensitive URL → risky (no ref-metadata inspection yet).
 *
 * Refinement to include ref role/name and password-field detection is
 * deferred to v2 per plan 06 open questions.
 */
export class Safety {
  private readonly approvalMode: "auto" | "gate";

  constructor(
    private readonly matcher: RiskyDomainMatcher,
    private readonly channel: ConfirmationChannel,
    private readonly logger: Logger,
    private readonly traceWriter?: TraceWriter,
  ) {
    // Determine approval mode: default to "auto", opt in to "gate" via env var or explicit flag.
    const approvalEnv = process.env[ENV.APPROVAL];
    const autoconfirmEnv = process.env[ENV.AUTOCONFIRM];

    // New BROWSEROPS_APPROVAL=gate takes precedence; also support old BROWSEROPS_AUTOCONFIRM=0
    // for backwards compatibility.
    if (approvalEnv === "gate" || autoconfirmEnv === "0") {
      this.approvalMode = "gate";
    } else {
      this.approvalMode = "auto";
    }

    // Log startup state. --autoconfirm (sets BROWSEROPS_AUTOCONFIRM=1) is now a no-op since
    // auto-approve is the default.
    if (autoconfirmEnv === "1") {
      process.stderr.write(
        `[browserops] ${ENV.AUTOCONFIRM}=1 is now the default; ignoring.\n`,
      );
    }
  }

  checkRisky(input: SafetyCheckInput): RiskVerdict {
    const { tool, params, tab } = input;

    if (tool === "browser_execute_js") {
      return { risky: true, reason: "execute_js is always treated as risky" };
    }

    const url = tab?.url;
    const sensitive = url ? this.matcher.matches(url) : false;

    if (tool === "browser_type" && params["submit"] === true && sensitive) {
      return { risky: true, reason: `type with submit on sensitive domain (${hostOf(url)})` };
    }

    if (tool === "browser_click" && sensitive) {
      return { risky: true, reason: `click on sensitive domain (${hostOf(url)})` };
    }

    if (tool === "browser_find_and_replace" && sensitive) {
      return {
        risky: true,
        reason: `find_and_replace on sensitive domain (${hostOf(url)})`,
      };
    }

    return { risky: false };
  }

  async requireApproval(input: {
    tool: string;
    params: Record<string, unknown>;
    reason: string;
    tab_hostname?: string;
  }): Promise<{ allow: boolean }> {
    const decision_id = cryptoRandomId();

    // In "auto" mode, short-circuit to approval without prompting.
    if (this.approvalMode === "auto") {
      await this.logger.write({
        dir: "safety",
        decision_id,
        phase: "auto_approved",
      });
      // Emit auto_approved trace event.
      if (this.traceWriter?.enabled) {
        this.traceWriter.append({
          type: "auto_approved",
          tool: input.tool,
          tab_hostname: input.tab_hostname,
          ts: new Date().toISOString(),
          decision_id,
        });
      }
      return { allow: true };
    }

    // "gate" mode: prompt the user.
    await this.logger.write({
      dir: "safety",
      method: input.tool,
      decision_id,
      reason: input.reason,
      phase: "prompted",
    });

    try {
      const result = await this.channel.awaitConfirmation({
        tool: input.tool,
        params: input.params,
        reason: input.reason,
        decision_id,
        timeout_ms: RISKY_CONFIRM_TIMEOUT_MS,
      });
      await this.logger.write({
        dir: "safety",
        decision_id,
        phase: "decided",
        allow: result.allow,
      });
      return result;
    } catch {
      await this.logger.write({
        dir: "safety",
        decision_id,
        phase: "timeout_or_error",
        allow: false,
      });
      return { allow: false };
    }
  }
}

function hostOf(url: string | undefined): string {
  if (!url) return "?";
  try {
    return new URL(url).hostname;
  } catch {
    return "?";
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
