import { ENV, RISKY_CONFIRM_TIMEOUT_MS } from "@browserops/shared";
import type { RiskyDomainMatcher } from "./risky-domains.js";
import type { Logger } from "./logger.js";

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
 * Bridge-side safety layer. See plans/06-autonomy-safety.md.
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
  private readonly autoConfirm: boolean;

  constructor(
    private readonly matcher: RiskyDomainMatcher,
    private readonly channel: ConfirmationChannel,
    private readonly logger: Logger,
  ) {
    this.autoConfirm = process.env[ENV.AUTOCONFIRM] === "1";
    if (this.autoConfirm) {
      process.stderr.write(
        `browserops: WARNING — ${ENV.AUTOCONFIRM}=1; risky-action prompts auto-approve. For testing only.\n`,
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
  }): Promise<{ allow: boolean }> {
    const decision_id = cryptoRandomId();
    await this.logger.write({
      dir: "safety",
      method: input.tool,
      decision_id,
      reason: input.reason,
      phase: "prompted",
    });

    if (this.autoConfirm) {
      await this.logger.write({
        dir: "safety",
        decision_id,
        phase: "auto_approved",
      });
      return { allow: true };
    }

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
