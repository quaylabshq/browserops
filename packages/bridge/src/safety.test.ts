import { describe, expect, it } from "vitest";
import { Safety } from "./safety.js";
import type { RiskyDomainMatcher } from "./risky-domains.js";
import type { ConfirmationChannel } from "./safety.js";
import type { Logger } from "./logger.js";

function stubMatcher(sensitiveHosts: readonly string[]): RiskyDomainMatcher {
  return {
    patterns: sensitiveHosts,
    matches(url: string): boolean {
      try {
        const host = new URL(url).hostname.toLowerCase();
        return sensitiveHosts.some((h) => host === h || host.endsWith(`.${h}`));
      } catch {
        return false;
      }
    },
  };
}

function stubChannel(): ConfirmationChannel {
  return {
    async awaitConfirmation() {
      return { allow: false };
    },
  };
}

function stubLogger(): Logger {
  return { async write() {} } as unknown as Logger;
}

function makeSafety(sensitive: readonly string[]): Safety {
  return new Safety(stubMatcher(sensitive), stubChannel(), stubLogger());
}

describe("Safety.checkRisky for browser.find_and_replace", () => {
  it("is risky on a sensitive domain", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser.find_and_replace",
      params: { tab_id: "t_1", find: "x", replace: "y" },
      tab: { url: "https://www.chase.com/transfer" },
    });
    expect(v.risky).toBe(true);
    expect(v.reason).toContain("find_and_replace");
  });

  it("is not risky on a non-sensitive domain", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser.find_and_replace",
      params: { tab_id: "t_1", find: "x", replace: "y" },
      tab: { url: "https://example.com/" },
    });
    expect(v.risky).toBe(false);
  });

  it("is not risky without a tab (no URL to classify)", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser.find_and_replace",
      params: { tab_id: "t_1", find: "x", replace: "y" },
      tab: undefined,
    });
    expect(v.risky).toBe(false);
  });
});
