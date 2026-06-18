import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.js";

describe("parseInline", () => {
  it("plain text is a single text node", () => {
    expect(parseInline("hello world")).toEqual([{ t: "text", v: "hello world" }]);
  });

  it("**bold** and *italic*", () => {
    expect(parseInline("a **b** c")).toEqual([
      { t: "text", v: "a " },
      { t: "strong", v: [{ t: "text", v: "b" }] },
      { t: "text", v: " c" },
    ]);
    expect(parseInline("x *y* z")).toEqual([
      { t: "text", v: "x " },
      { t: "em", v: [{ t: "text", v: "y" }] },
      { t: "text", v: " z" },
    ]);
  });

  it("inline `code` is verbatim, no nested parsing", () => {
    expect(parseInline("run `a **b**` now")).toEqual([
      { t: "text", v: "run " },
      { t: "code", v: "a **b**" },
      { t: "text", v: " now" },
    ]);
  });

  it("[label](href) becomes a link; javascript: is left literal", () => {
    expect(parseInline("see [docs](https://x.test)")).toEqual([
      { t: "text", v: "see " },
      { t: "link", href: "https://x.test", v: "docs" },
    ]);
    const danger = parseInline("[x](javascript:alert(1))");
    expect(danger.every((n) => n.t !== "link")).toBe(true);
  });

  it("bare URLs linkify without trailing punctuation", () => {
    expect(parseInline("go https://x.test/a.")).toEqual([
      { t: "text", v: "go " },
      { t: "link", href: "https://x.test/a", v: "https://x.test/a" },
      { t: "text", v: "." },
    ]);
  });

  it("an unmatched * stays literal", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ t: "text", v: "2 * 3 = 6" }]);
  });
});

describe("parseMarkdown", () => {
  it("splits paragraphs on blank lines and soft-wraps within one", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toEqual([
      { t: "p", v: [{ t: "text", v: "one two" }] },
      { t: "p", v: [{ t: "text", v: "three" }] },
    ]);
  });

  it("headings by level", () => {
    expect(parseMarkdown("## Title")).toEqual([
      { t: "h", level: 2, v: [{ t: "text", v: "Title" }] },
    ]);
  });

  it("unordered list collects consecutive items", () => {
    const blocks = parseMarkdown("- a\n- b\n- c");
    expect(blocks).toEqual([
      {
        t: "ul",
        items: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }], [{ t: "text", v: "c" }]],
      },
    ]);
  });

  it("ordered list", () => {
    const blocks = parseMarkdown("1. first\n2. second");
    expect(blocks[0]).toMatchObject({ t: "ol" });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("blockquote joins its lines", () => {
    expect(parseMarkdown("> a\n> b")).toEqual([{ t: "quote", v: [{ t: "text", v: "a b" }] }]);
  });

  it("fenced code is captured verbatim with the fence stripped", () => {
    const blocks = parseMarkdown("```\nconst x = 1\n```");
    expect(blocks).toEqual([{ t: "code", v: "const x = 1" }]);
  });

  it("a list immediately after a paragraph stays its own block", () => {
    const blocks = parseMarkdown("intro\n- one\n- two");
    expect(blocks.map((b) => b.t)).toEqual(["p", "ul"]);
  });
});
