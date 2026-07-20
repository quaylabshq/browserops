import { describe, expect, it, vi } from "vitest";
import { Safety } from "./safety.js";
import type { RiskyDomainMatcher } from "./risky-domains.js";
import type { ConfirmationChannel } from "./safety.js";
import type { Logger } from "./logger.js";
import type { TraceWriter } from "./trace-writer.js";

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

function stubTraceWriter(): TraceWriter {
  return {
    enabled: true,
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as TraceWriter;
}

function makeSafety(
  sensitive: readonly string[],
  traceWriter?: TraceWriter,
  channel?: ConfirmationChannel,
): Safety {
  return new Safety(stubMatcher(sensitive), channel ?? stubChannel(), stubLogger(), traceWriter);
}

describe("Safety.checkRisky for browser_find_and_replace", () => {
  it("is risky on a sensitive domain", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser_find_and_replace",
      params: { tab_id: "t_1", find: "x", replace: "y" },
      tab: { url: "https://www.chase.com/transfer" },
    });
    expect(v.risky).toBe(true);
    expect(v.reason).toContain("find_and_replace");
  });

  it("is not risky on a non-sensitive domain", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser_find_and_replace",
      params: { tab_id: "t_1", find: "x", replace: "y" },
      tab: { url: "https://example.com/" },
    });
    expect(v.risky).toBe(false);
  });

  it("is not risky without a tab (no URL to classify)", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser_find_and_replace",
      params: { tab_id: "t_1", find: "x", replace: "y" },
      tab: undefined,
    });
    expect(v.risky).toBe(false);
  });
});

describe("Safety.checkRisky for browser_drag", () => {
  it("is risky on a sensitive domain", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser_drag",
      params: { tab_id: "t_1", from_ref: 1, to_ref: 2 },
      tab: { url: "https://www.chase.com/transfer" },
    });
    expect(v.risky).toBe(true);
    expect(v.reason).toContain("drag");
  });

  it("is not risky on a non-sensitive domain", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser_drag",
      params: { tab_id: "t_1", from_ref: 1, to_ref: 2 },
      tab: { url: "https://example.com/" },
    });
    expect(v.risky).toBe(false);
  });

  it("is not risky without a tab (no URL to classify)", () => {
    const s = makeSafety(["chase.com"]);
    const v = s.checkRisky({
      tool: "browser_drag",
      params: { tab_id: "t_1", from_ref: 1, to_ref: 2 },
      tab: undefined,
    });
    expect(v.risky).toBe(false);
  });
});

describe("Safety.requireApproval — auto-approve default behavior", () => {
  it("auto-approves risky actions by default (no env var set)", async () => {
    const traceWriter = stubTraceWriter();
    const s = makeSafety(["chase.com"], traceWriter);

    const result = await s.requireApproval({
      tool: "browser_click",
      params: { tab_id: "t_1", ref: 42 },
      reason: "click on sensitive domain",
      tab_hostname: "chase.com",
    });

    expect(result.allow).toBe(true);
    // Should not call the confirmation channel (would log prompt event).
    // Verify trace writer was called with auto_approved event.
    expect(traceWriter.append).toHaveBeenCalledOnce();
    const appendFn = traceWriter.append as ReturnType<typeof vi.fn>;
    const event = appendFn.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      type: "auto_approved",
      tool: "browser_click",
      tab_hostname: "chase.com",
    });
  });

  it("emits auto_approved trace event with decision_id and timestamp", async () => {
    const traceWriter = stubTraceWriter();
    const s = makeSafety(["github.com"], traceWriter);

    await s.requireApproval({
      tool: "browser_type",
      params: { tab_id: "t_2", ref: 10, text: "secret" },
      reason: "type with submit on sensitive domain",
      tab_hostname: "github.com",
    });

    expect(traceWriter.append).toHaveBeenCalledOnce();
    const appendFn = traceWriter.append as ReturnType<typeof vi.fn>;
    const event = appendFn.mock.calls[0]?.[0];
    expect(event?.type).toBe("auto_approved");
    expect(event?.tool).toBe("browser_type");
    expect(event?.tab_hostname).toBe("github.com");
    expect(event?.decision_id).toBeDefined();
    expect(typeof event?.decision_id).toBe("string");
    expect(event?.ts).toBeDefined();
    expect(event?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601 timestamp
  });

  it("does not emit trace event to trace writer when traceWriter is undefined", async () => {
    const s = makeSafety(["bank.com"]); // No traceWriter passed

    const result = await s.requireApproval({
      tool: "browser_execute_js",
      params: { tab_id: "t_1", code: "alert('hi')" },
      reason: "execute_js is always treated as risky",
      tab_hostname: "bank.com",
    });

    expect(result.allow).toBe(true);
    // Should not crash or error — just no trace event.
  });

  it("does not emit trace event when traceWriter.enabled is false", async () => {
    const traceWriter: TraceWriter = {
      enabled: false,
      append: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as TraceWriter;
    const s = makeSafety(["example.com"], traceWriter);

    await s.requireApproval({
      tool: "browser_click",
      params: { tab_id: "t_1", ref: 1 },
      reason: "test",
      tab_hostname: "example.com",
    });

    expect(traceWriter.append).not.toHaveBeenCalled();
  });
});

describe("Safety.requireApproval — gate mode opt-in", () => {
  it("prompts user when approvalMode is 'gate' (via constructor or env)", async () => {
    // Simulate gate mode by creating a Safety instance that explicitly uses gate logic.
    // Since the constructor reads process.env[ENV.APPROVAL] and ENV.AUTOCONFIRM,
    // we test by verifying the confirmation channel is called.
    const confirmationChannel = {
      awaitConfirmation: vi.fn().mockResolvedValue({ allow: true }),
    } as unknown as ConfirmationChannel;
    const logger = { async write() {} } as unknown as Logger;

    // Temporarily set env var to enable gate mode.
    const oldEnv = process.env.BROWSEROPS_APPROVAL;
    process.env.BROWSEROPS_APPROVAL = "gate";
    try {
      const s = new Safety(stubMatcher([]), confirmationChannel, logger);

      await s.requireApproval({
        tool: "browser_click",
        params: { tab_id: "t_1", ref: 1 },
        reason: "test",
        tab_hostname: "example.com",
      });

      // In gate mode, the confirmation channel should be called.
      expect(confirmationChannel.awaitConfirmation).toHaveBeenCalledOnce();
      const awaitFn = confirmationChannel.awaitConfirmation as ReturnType<typeof vi.fn>;
      const callArgs = awaitFn.mock.calls[0]?.[0];
      expect(callArgs).toMatchObject({
        tool: "browser_click",
        reason: "test",
        timeout_ms: expect.any(Number),
      });
    } finally {
      // Restore original env.
      if (oldEnv !== undefined) {
        process.env.BROWSEROPS_APPROVAL = oldEnv;
      } else {
        delete process.env.BROWSEROPS_APPROVAL;
      }
    }
  });

  it("gate mode rejects when user does not allow", async () => {
    const confirmationChannel = {
      awaitConfirmation: vi.fn().mockResolvedValue({ allow: false }),
    } as unknown as ConfirmationChannel;
    const logger = { async write() {} } as unknown as Logger;

    const oldEnv = process.env.BROWSEROPS_APPROVAL;
    process.env.BROWSEROPS_APPROVAL = "gate";
    try {
      const s = new Safety(stubMatcher(["example.com"]), confirmationChannel, logger);

      const result = await s.requireApproval({
        tool: "browser_click",
        params: { tab_id: "t_1", ref: 1 },
        reason: "test",
        tab_hostname: "example.com",
      });

      expect(result.allow).toBe(false);
    } finally {
      if (oldEnv !== undefined) {
        process.env.BROWSEROPS_APPROVAL = oldEnv;
      } else {
        delete process.env.BROWSEROPS_APPROVAL;
      }
    }
  });

  it("legacy BROWSEROPS_AUTOCONFIRM=0 still enables gate mode", async () => {
    const confirmationChannel = {
      awaitConfirmation: vi.fn().mockResolvedValue({ allow: true }),
    } as unknown as ConfirmationChannel;
    const logger = { async write() {} } as unknown as Logger;

    const oldApproval = process.env.BROWSEROPS_APPROVAL;
    const oldAutoconfirm = process.env.BROWSEROPS_AUTOCONFIRM;
    process.env.BROWSEROPS_APPROVAL = "";
    process.env.BROWSEROPS_AUTOCONFIRM = "0";
    try {
      const s = new Safety(stubMatcher([]), confirmationChannel, logger);

      await s.requireApproval({
        tool: "browser_click",
        params: { tab_id: "t_1", ref: 1 },
        reason: "test",
        tab_hostname: "example.com",
      });

      // Should call confirmation channel (gate mode active).
      expect(confirmationChannel.awaitConfirmation).toHaveBeenCalledOnce();
    } finally {
      if (oldApproval !== undefined) {
        process.env.BROWSEROPS_APPROVAL = oldApproval;
      } else {
        delete process.env.BROWSEROPS_APPROVAL;
      }
      if (oldAutoconfirm !== undefined) {
        process.env.BROWSEROPS_AUTOCONFIRM = oldAutoconfirm;
      } else {
        delete process.env.BROWSEROPS_AUTOCONFIRM;
      }
    }
  });
});
