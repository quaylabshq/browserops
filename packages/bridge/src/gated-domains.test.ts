import { describe, expect, it } from "vitest";
import { loadGatedDomainMatcher } from "./gated-domains.js";

describe("gated-domain matcher", () => {
  it("matches the default list", async () => {
    const m = await loadGatedDomainMatcher();
    expect(m.matches("https://mail.google.com/u/0/")).toBe(true);
    expect(m.matches("https://acme.slack.com/c/general")).toBe(true);
    expect(m.matches("https://team.notion.so/page")).toBe(true);
    expect(m.matches("https://linear.app/team")).toBe(true);
    expect(m.matches("https://discord.com/channels/1")).toBe(true);
  });

  it("does not match unrelated hosts", async () => {
    const m = await loadGatedDomainMatcher();
    expect(m.matches("https://example.com/")).toBe(false);
    expect(m.matches("https://github.com/")).toBe(false);
  });

  it("is case-insensitive on host", async () => {
    const m = await loadGatedDomainMatcher();
    expect(m.matches("https://LINEAR.APP/team")).toBe(true);
    expect(m.matches("https://Mail.Google.COM/")).toBe(true);
  });

  it("returns false on invalid URLs", async () => {
    const m = await loadGatedDomainMatcher();
    expect(m.matches("not-a-url")).toBe(false);
    expect(m.matches("")).toBe(false);
  });

  it("exposes the merged pattern list", async () => {
    const m = await loadGatedDomainMatcher();
    expect(m.patterns.length).toBeGreaterThan(0);
    expect(m.patterns).toContain("linear.app");
  });
});
