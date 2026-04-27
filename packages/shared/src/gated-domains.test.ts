import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATED_DOMAINS,
  GATED_DOMAIN_DIRECTIVE,
  hostnameOf,
  matchGatedDomain,
} from "./gated-domains.js";

describe("hostnameOf", () => {
  it("extracts hostname (lowercased) from a valid URL", () => {
    expect(hostnameOf("https://Mail.Google.com/inbox")).toBe("mail.google.com");
  });

  it("returns null for an invalid URL", () => {
    expect(hostnameOf("not-a-url")).toBeNull();
  });

  it("handles URLs with ports and paths", () => {
    expect(hostnameOf("http://example.com:8080/path?q=1")).toBe("example.com");
  });
});

describe("matchGatedDomain", () => {
  it("matches an exact hostname (case-insensitive)", () => {
    expect(matchGatedDomain("https://linear.app/team", ["linear.app"])).toBe(true);
    expect(matchGatedDomain("https://LINEAR.APP/", ["linear.app"])).toBe(true);
  });

  it("does not match a different hostname", () => {
    expect(matchGatedDomain("https://example.com", ["linear.app"])).toBe(false);
  });

  it("matches subdomains via leading *.", () => {
    expect(matchGatedDomain("https://acme.slack.com/c/general", ["*.slack.com"])).toBe(true);
    expect(matchGatedDomain("https://deep.team.slack.com/", ["*.slack.com"])).toBe(true);
  });

  it("matches the bare apex via leading *.", () => {
    expect(matchGatedDomain("https://slack.com/", ["*.slack.com"])).toBe(true);
  });

  it("does not match an unrelated suffix", () => {
    expect(matchGatedDomain("https://notslack.com/", ["*.slack.com"])).toBe(false);
    expect(matchGatedDomain("https://slack.com.evil.com/", ["*.slack.com"])).toBe(false);
  });

  it("returns false on URL parse error", () => {
    expect(matchGatedDomain("nope", ["*.slack.com"])).toBe(false);
  });

  it("returns false on empty patterns list", () => {
    expect(matchGatedDomain("https://linear.app", [])).toBe(false);
  });

  it("matches when any pattern in the list matches", () => {
    expect(
      matchGatedDomain("https://discord.com/channels/1", ["*.slack.com", "discord.com"]),
    ).toBe(true);
  });
});

describe("DEFAULT_GATED_DOMAINS", () => {
  it("covers expected rich-editor / SPA domains", () => {
    expect(matchGatedDomain("https://mail.google.com/u/0/", DEFAULT_GATED_DOMAINS)).toBe(true);
    expect(matchGatedDomain("https://acme.slack.com/c/general", DEFAULT_GATED_DOMAINS)).toBe(true);
    expect(matchGatedDomain("https://team.notion.so/page", DEFAULT_GATED_DOMAINS)).toBe(true);
    expect(matchGatedDomain("https://linear.app/team", DEFAULT_GATED_DOMAINS)).toBe(true);
    expect(matchGatedDomain("https://discord.com/channels/1", DEFAULT_GATED_DOMAINS)).toBe(true);
  });

  it("does not match unrelated sites", () => {
    expect(matchGatedDomain("https://example.com/", DEFAULT_GATED_DOMAINS)).toBe(false);
    expect(matchGatedDomain("https://github.com/", DEFAULT_GATED_DOMAINS)).toBe(false);
  });
});

describe("GATED_DOMAIN_DIRECTIVE", () => {
  it("mentions browser_execute_js as the preferred path", () => {
    expect(GATED_DOMAIN_DIRECTIVE).toMatch(/browser_execute_js/);
  });
});
