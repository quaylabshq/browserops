/**
 * A deliberately small Markdown renderer for assistant prose — the "extracted
 * output" half of the activity stream. Agents (Claude today) reply in Markdown:
 * paragraphs, **bold**, *italic*, `code`, links, lists, blockquotes, fenced code.
 * We render exactly that subset and nothing exotic.
 *
 * Two halves, split so the hard part stays pure:
 *  - `parseMarkdown` / `parseInline` return a plain AST — unit-tested in Node,
 *    no DOM.
 *  - `renderMarkdown` walks the AST into real nodes using textContent + typed
 *    element props only (never innerHTML), so agent text can't inject markup.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; v: Inline[] }
  | { t: "em"; v: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; v: string };

export type Block =
  | { t: "p"; v: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; v: Inline[] }
  | { t: "quote"; v: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "code"; v: string };

/** Only these schemes become real links; anything else renders as plain text. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

const BARE_URL = /^https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]/;

/** Find the index just past a closing delimiter `close` starting at `from`. */
function findClose(s: string, close: string, from: number): number {
  const idx = s.indexOf(close, from);
  return idx < 0 ? -1 : idx;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // `inline code` — verbatim, no nested parsing.
    if (text[i] === "`") {
      const end = findClose(text, "`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // **strong** (checked before single *).
    if (rest.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        out.push({ t: "strong", v: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // [label](href)
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren > close) {
          const href = safeHref(text.slice(close + 2, paren));
          if (href) {
            flush();
            out.push({ t: "link", href, v: text.slice(i + 1, close) });
            i = paren + 1;
            continue;
          }
        }
      }
    }

    // bare URL
    const bare = BARE_URL.exec(rest);
    if (bare) {
      flush();
      out.push({ t: "link", href: bare[0], v: bare[0] });
      i += bare[0].length;
      continue;
    }

    // *italic* — require a non-space right after the opener so `a * b` is literal.
    if (text[i] === "*" && text[i + 1] !== undefined && text[i + 1] !== " ") {
      const end = text.indexOf("*", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "em", v: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

const FENCE = /^```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const UL = /^[-*+]\s+(.*)$/;
const OL = /^\d+\.\s+(.*)$/;

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    UL.test(line) ||
    OL.test(line) ||
    line.trim() === ""
  );
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      if (i < lines.length) i += 1; // closing fence
      blocks.push({ t: "code", v: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        t: "h",
        level: heading[1]!.length as 1 | 2 | 3,
        v: parseInline(heading[2]!),
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        parts.push(QUOTE.exec(lines[i++]!)![1]!);
      }
      blocks.push({ t: "quote", v: parseInline(parts.join(" ")) });
      continue;
    }

    if (UL.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && UL.test(lines[i]!)) {
        items.push(parseInline(UL.exec(lines[i++]!)![1]!));
      }
      blocks.push({ t: "ul", items });
      continue;
    }

    if (OL.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && OL.test(lines[i]!)) {
        items.push(parseInline(OL.exec(lines[i++]!)![1]!));
      }
      blocks.push({ t: "ol", items });
      continue;
    }

    // Paragraph — gather soft-wrapped lines until a blank or a new block start.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && !isBlockStart(lines[i]!)) para.push(lines[i++]!);
    blocks.push({ t: "p", v: parseInline(para.join(" ")) });
  }

  return blocks;
}

// --- DOM rendering (textContent + typed props only) -------------------------

function appendInline(parent: Node, nodes: Inline[]): void {
  const doc = parent.ownerDocument ?? document;
  for (const n of nodes) {
    if (n.t === "text") {
      parent.appendChild(doc.createTextNode(n.v));
    } else if (n.t === "code") {
      const c = doc.createElement("code");
      c.textContent = n.v;
      parent.appendChild(c);
    } else if (n.t === "strong") {
      const s = doc.createElement("strong");
      appendInline(s, n.v);
      parent.appendChild(s);
    } else if (n.t === "em") {
      const e = doc.createElement("em");
      appendInline(e, n.v);
      parent.appendChild(e);
    } else {
      const a = doc.createElement("a");
      a.href = n.href;
      a.textContent = n.v;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      parent.appendChild(a);
    }
  }
}

/** Render Markdown into `container` as real DOM (safe — no innerHTML). */
export function renderMarkdown(container: HTMLElement, src: string): void {
  const doc = container.ownerDocument;
  for (const block of parseMarkdown(src)) {
    if (block.t === "code") {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = block.v;
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }
    if (block.t === "h") {
      const h = doc.createElement(`h${block.level}` as "h1" | "h2" | "h3");
      appendInline(h, block.v);
      container.appendChild(h);
      continue;
    }
    if (block.t === "quote") {
      const q = doc.createElement("blockquote");
      appendInline(q, block.v);
      container.appendChild(q);
      continue;
    }
    if (block.t === "ul" || block.t === "ol") {
      const list = doc.createElement(block.t);
      for (const item of block.items) {
        const li = doc.createElement("li");
        appendInline(li, item);
        list.appendChild(li);
      }
      container.appendChild(list);
      continue;
    }
    const p = doc.createElement("p");
    appendInline(p, block.v);
    container.appendChild(p);
  }
}
