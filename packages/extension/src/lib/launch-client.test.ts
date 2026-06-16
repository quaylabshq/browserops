import { describe, it, expect } from "vitest";
import {
  buildLaunchBody,
  clampText,
  launchedMessage,
  launchStatusMessage,
} from "./launch-client.js";

describe("launchedMessage", () => {
  it("names the agent and points to the terminal", () => {
    expect(launchedMessage("Claude Code")).toMatch(/Claude Code/);
    expect(launchedMessage("Claude Code")).toMatch(/terminal/);
  });
});

describe("clampText", () => {
  it("trims, drops empties, and caps length", () => {
    expect(clampText("  hi  ")).toBe("hi");
    expect(clampText("")).toBeUndefined();
    expect(clampText("   ")).toBeUndefined();
    expect(clampText(undefined)).toBeUndefined();
    expect(clampText("a".repeat(600), 500)).toHaveLength(500);
  });
});

describe("buildLaunchBody", () => {
  it("always includes token + agent + url, maps optional fields to wire names", () => {
    expect(
      buildLaunchBody({
        token: "tok",
        agent: "claude",
        instruction: "do X",
        meta: { url: "https://x.test", title: "T", description: "D", siteName: "S" },
      }),
    ).toEqual({
      token: "tok",
      agent: "claude",
      url: "https://x.test",
      instruction: "do X",
      title: "T",
      description: "D",
      site_name: "S",
    });
  });

  it("omits blank/missing optional fields incl. the instruction", () => {
    expect(
      buildLaunchBody({ token: "tok", agent: "claude", instruction: "  ", meta: { url: "u" } }),
    ).toEqual({ token: "tok", agent: "claude", url: "u" });
  });

  it("caps an over-long instruction", () => {
    const body = buildLaunchBody({
      token: "t",
      agent: "claude",
      instruction: "x".repeat(9000),
      meta: { url: "u" },
    });
    expect(body["instruction"]).toHaveLength(8000);
  });
});

describe("launchStatusMessage", () => {
  it("reports an unreachable bridge and success", () => {
    expect(launchStatusMessage(null)).toMatch(/Bridge not running/);
    expect(launchStatusMessage({ ok: true, status: 200 })).toMatch(/Launched/);
  });

  it("maps auth + known error codes", () => {
    expect(launchStatusMessage({ ok: false, status: 401 })).toMatch(/Not authorized/);
    expect(launchStatusMessage({ ok: false, status: 502 }, "agent_disabled")).toMatch(
      /isn't available/,
    );
    expect(launchStatusMessage({ ok: false, status: 502 }, "no_terminal")).toMatch(/terminal/);
    expect(launchStatusMessage({ ok: false, status: 503 }, "launch_unavailable")).toMatch(
      /isn't available on this bridge/,
    );
  });

  it("falls back to a generic message", () => {
    expect(launchStatusMessage({ ok: false, status: 500 })).toBe("Couldn't launch.");
  });
});
