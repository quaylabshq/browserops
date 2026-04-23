import { describe, expect, test } from "vitest";
import { resolveSite } from "./editors.js";

describe("resolveSite", () => {
  test("app.slack.com matches slack entry with quill and semanticKeyMode trusted", () => {
    const entry = resolveSite("app.slack.com");
    expect(entry).not.toBeNull();
    expect(entry?.framework).toBe("quill");
    expect(entry?.semanticKeyMode).toBe("trusted");
  });

  test("slack.com (top-level) also matches slack entry", () => {
    const entry = resolveSite("slack.com");
    expect(entry).not.toBeNull();
    expect(entry?.framework).toBe("quill");
  });

  test("example.com returns null", () => {
    expect(resolveSite("example.com")).toBeNull();
  });

  test("mail.google.com returns gmail entry", () => {
    const entry = resolveSite("mail.google.com");
    expect(entry).not.toBeNull();
    expect(entry?.framework).toBe("gmail");
    expect(entry?.semanticKeyMode).toBe("trusted");
  });

  test("docs.google.com returns gdocs-canvas entry", () => {
    const entry = resolveSite("docs.google.com");
    expect(entry).not.toBeNull();
    expect(entry?.framework).toBe("gdocs-canvas");
    expect(entry?.clickMode).toBe("trusted");
  });

  test("mail.google.com and docs.google.com are distinct entries", () => {
    const gmail = resolveSite("mail.google.com");
    const gdocs = resolveSite("docs.google.com");
    expect(gmail?.framework).not.toBe(gdocs?.framework);
  });

  test("www.figma.com returns figma-canvas with clickMode trusted", () => {
    const entry = resolveSite("www.figma.com");
    expect(entry).not.toBeNull();
    expect(entry?.framework).toBe("figma-canvas");
    expect(entry?.clickMode).toBe("trusted");
  });

  test("notslack.com does NOT match slack (substring, not proper domain suffix)", () => {
    expect(resolveSite("notslack.com")).toBeNull();
  });

  test("slack.com.evil.example does NOT match slack", () => {
    expect(resolveSite("slack.com.evil.example")).toBeNull();
  });

  test("www.reddit.com matches reddit entry", () => {
    const entry = resolveSite("www.reddit.com");
    expect(entry).not.toBeNull();
    expect(entry?.framework).toBe("slate");
  });
});
