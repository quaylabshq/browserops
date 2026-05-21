import { describe, expect, it } from "vitest";
import { substituteVars } from "./substitute.js";

describe("substituteVars", () => {
  it("resolves {{tab_id}}", () => {
    expect(substituteVars("Hello {{tab_id}}", { tab_id: "t_1" })).toBe(
      "Hello t_1",
    );
  });

  it("resolves {{input.NAME}}", () => {
    expect(
      substituteVars("To: {{input.to}}", { to: "alice@example.com" }),
    ).toBe("To: alice@example.com");
  });

  it("resolves bare {{NAME}} as input shorthand", () => {
    expect(
      substituteVars("Subject: {{subject}}", { subject: "Hi" }),
    ).toBe("Subject: Hi");
  });

  it("recurses into objects", () => {
    const out = substituteVars(
      { url: "https://{{host}}/{{input.path}}" },
      { host: "example.com", path: "abc" },
    );
    expect(out).toEqual({ url: "https://example.com/abc" });
  });

  it("recurses into arrays", () => {
    const out = substituteVars(["{{a}}", "{{b}}"], { a: "x", b: "y" });
    expect(out).toEqual(["x", "y"]);
  });

  it("leaves unresolved placeholders intact", () => {
    expect(substituteVars("Hi {{missing}}", {})).toBe("Hi {{missing}}");
  });

  it("JSON-stringifies non-string scalars", () => {
    expect(substituteVars("count={{n}}", { n: 5 })).toBe("count=5");
    expect(substituteVars("flag={{ok}}", { ok: true })).toBe("flag=true");
  });

  it("traverses bind subfields", () => {
    const out = substituteVars(
      "ref={{open.matches.0.ref}}",
      {},
      { open: { matches: [{ ref: 7 }] } },
    );
    expect(out).toBe("ref=7");
  });

  it("ignores 'input' as a bind head — falls through to input map", () => {
    const out = substituteVars(
      "{{input.subject}}",
      { subject: "Hi" },
      { input: { subject: "wrong" } },
    );
    // Should pick from inputs, not from binds.input
    expect(out).toBe("Hi");
  });
});
