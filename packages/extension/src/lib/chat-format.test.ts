import { describe, expect, it } from "vitest";
import type { ChatBlock } from "@browserops/shared";
import { formatAction, host, truncate } from "./chat-format.js";

const use = (name: string, input: unknown): Extract<ChatBlock, { kind: "tool_use" }> => ({
  kind: "tool_use",
  id: "t1",
  name,
  input,
});

describe("host", () => {
  it("extracts the hostname", () => {
    expect(host("https://mail.google.com/mail/u/0")).toBe("mail.google.com");
  });
  it("falls back to the raw string when unparseable", () => {
    expect(host("not a url")).toBe("not a url");
  });
});

describe("truncate", () => {
  it("collapses whitespace and clamps with an ellipsis", () => {
    expect(truncate("a\n  b   c", 4)).toBe("a b…");
    expect(truncate("short")).toBe("short");
  });
});

describe("formatAction", () => {
  it("navigate → host of the url", () => {
    expect(formatAction(use("browser_navigate", { url: "https://x.test/path" }))).toEqual({
      icon: "navigate",
      verb: "navigate",
      target: "x.test",
      risky: false,
    });
  });

  it("click prefers visible text, else the ref", () => {
    expect(formatAction(use("browser_click", { text: "Compose" })).target).toBe("Compose");
    expect(formatAction(use("browser_click", { ref: "e42" })).target).toBe("e42");
  });

  it("type truncates the typed text", () => {
    const long =
      "hello there friend, this is a really quite long message that runs well past the cap";
    const v = formatAction(use("browser_type", { text: long }));
    expect(v.icon).toBe("type");
    expect(v.target.endsWith("…")).toBe(true);
  });

  it("press joins the chord", () => {
    expect(formatAction(use("browser_press", { keys: ["Primary", "KeyA"] })).target).toBe(
      "Primary+KeyA",
    );
  });

  it("run JS is flagged risky", () => {
    const v = formatAction(use("browser_execute_js", { code: "document.title" }));
    expect(v).toMatchObject({ icon: "code", verb: "run JS", risky: true });
  });

  it("procedures_execute shows the procedure name", () => {
    expect(formatAction(use("procedures_execute", { name: "gmail.send_email" })).target).toBe(
      "gmail.send_email",
    );
  });

  it("an unknown tool never renders blank — de-prefixed name as the verb", () => {
    const v = formatAction(use("mcp__browserops__browser_some_new_thing", {}));
    expect(v.icon).toBe("dot");
    expect(v.verb).toBe("some new thing");
  });
});
