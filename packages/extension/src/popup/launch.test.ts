import { describe, it, expect } from "vitest";
import { buildLaunchBody, clampText, launchStatusMessage } from "./launch.js";

describe("clampText", () => {
  it("trims, drops empties, and caps length", () => {
    expect(clampText("  hi  ")).toBe("hi");
    expect(clampText("")).toBeUndefined();
    expect(clampText("   ")).toBeUndefined();
    expect(clampText(undefined)).toBeUndefined();
    expect(clampText(null)).toBeUndefined();
    expect(clampText("a".repeat(600), 500)).toHaveLength(500);
  });
});

describe("buildLaunchBody", () => {
  it("always includes token + url, and present optional fields mapped to wire names", () => {
    expect(
      buildLaunchBody("tok", {
        url: "https://x.test",
        title: "T",
        description: "D",
        siteName: "S",
      }),
    ).toEqual({
      token: "tok",
      url: "https://x.test",
      title: "T",
      description: "D",
      site_name: "S",
    });
  });

  it("omits optional fields that are blank/missing", () => {
    expect(buildLaunchBody("tok", { url: "https://x.test", title: "  ", description: "" })).toEqual(
      {
        token: "tok",
        url: "https://x.test",
      },
    );
  });
});

describe("launchStatusMessage", () => {
  it("reports an unreachable bridge", () => {
    expect(launchStatusMessage(null)).toMatch(/Bridge not running/);
  });

  it("reports success", () => {
    expect(launchStatusMessage({ ok: true, status: 200 })).toMatch(/launched/);
  });

  it("maps auth failures and known error codes", () => {
    expect(launchStatusMessage({ ok: false, status: 401 })).toMatch(/Not authorized/);
    expect(launchStatusMessage({ ok: false, status: 403 })).toMatch(/Not authorized/);
    expect(launchStatusMessage({ ok: false, status: 502 }, "no_terminal")).toMatch(/terminal/);
    expect(launchStatusMessage({ ok: false, status: 503 }, "launch_unavailable")).toMatch(
      /isn't available/,
    );
  });

  it("falls back to a generic message for unknown failures", () => {
    expect(launchStatusMessage({ ok: false, status: 500 })).toBe("Couldn't launch Claude.");
  });
});
