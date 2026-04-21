import { describe, expect, it } from "vitest";

// Re-export the internal matchGlob for testing by importing a tiny shim.
// We can't import it directly because it's not exported. Instead, drive the
// public matcher through loadRiskyDomainMatcher in a way that doesn't touch
// the filesystem, by spying on readFile — or simpler, just verify behavior
// via the publicly exported defaults.

import { loadRiskyDomainMatcher } from "./risky-domains.js";

describe("risky-domain matcher", () => {
  it("matches the default list", async () => {
    const m = await loadRiskyDomainMatcher();
    expect(m.matches("https://chase.com/")).toBe(true);
    expect(m.matches("https://www.chase.com/login")).toBe(true);
    expect(m.matches("https://paypal.com/")).toBe(true);
    expect(m.matches("https://venmo.com/")).toBe(true);
    expect(m.matches("https://1password.com/")).toBe(true);
  });

  it("does not match unrelated hosts", async () => {
    const m = await loadRiskyDomainMatcher();
    expect(m.matches("https://google.com/")).toBe(false);
    expect(m.matches("https://example.com/")).toBe(false);
    expect(m.matches("https://banksy.art/")).toBe(false); // must not false-positive on "bank" substring
    expect(m.matches("https://not-a-bank.com/")).toBe(false);
  });

  it("is case-insensitive on host", async () => {
    const m = await loadRiskyDomainMatcher();
    expect(m.matches("https://PAYPAL.com/")).toBe(true);
    expect(m.matches("https://WWW.chase.COM/")).toBe(true);
  });

  it("returns false on invalid URLs", async () => {
    const m = await loadRiskyDomainMatcher();
    expect(m.matches("not-a-url")).toBe(false);
    expect(m.matches("")).toBe(false);
  });

  it("subdomain wildcards match any level but do not leak across hosts", async () => {
    const m = await loadRiskyDomainMatcher();
    expect(m.matches("https://deep.sub.chase.com/")).toBe(true);
    expect(m.matches("https://chase.com/")).toBe(true);
    expect(m.matches("https://chase.com.evil.example/")).toBe(false);
  });
});
