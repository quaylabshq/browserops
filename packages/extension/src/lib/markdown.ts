/**
 * Small, DOM-only Markdown renderer for the extension chat. It deliberately
 * treats HTML as text and constructs every node with textContent, so provider
 * output can never inject markup into the privileged extension page.
 */

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*(?:[-+*])\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)
  );
}

function appendText(parent: HTMLElement, text: string): void {
  if (text) parent.append(document.createTextNode(text));
}

function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Append common inline Markdown without ever interpreting HTML. */
export function appendMarkdownInline(parent: HTMLElement, text: string): void {
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);

    if (rest.startsWith("\n")) {
      parent.append(document.createElement("br"));
      at += 1;
      continue;
    }

    if (rest.startsWith("`")) {
      const end = text.indexOf("`", at + 1);
      if (end > at + 1) {
        const code = document.createElement("code");
        code.textContent = text.slice(at + 1, end);
        parent.append(code);
        at = end + 1;
        continue;
      }
    }

    const link = /^\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]!);
      if (href) {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        appendMarkdownInline(anchor, link[1]!);
        parent.append(anchor);
        at += link[0].length;
        continue;
      }
    }

    const marker = rest.startsWith("**") || rest.startsWith("__") ? rest.slice(0, 2) : undefined;
    if (marker) {
      const end = text.indexOf(marker, at + marker.length);
      if (end > at + marker.length) {
        const strong = document.createElement("strong");
        appendMarkdownInline(strong, text.slice(at + marker.length, end));
        parent.append(strong);
        at = end + marker.length;
        continue;
      }
    }

    if (rest.startsWith("~~")) {
      const end = text.indexOf("~~", at + 2);
      if (end > at + 2) {
        const strike = document.createElement("s");
        appendMarkdownInline(strike, text.slice(at + 2, end));
        parent.append(strike);
        at = end + 2;
        continue;
      }
    }

    const emphasis = rest[0] === "*" || rest[0] === "_" ? rest[0] : undefined;
    if (emphasis && (emphasis !== "_" || at === 0 || /\W/.test(text[at - 1]!))) {
      const end = text.indexOf(emphasis, at + 1);
      if (end > at + 1) {
        const em = document.createElement("em");
        appendMarkdownInline(em, text.slice(at + 1, end));
        parent.append(em);
        at = end + 1;
        continue;
      }
    }

    const special = text.slice(at + 1).search(/[\n`[*_~]/);
    const end = special === -1 ? text.length : at + 1 + special;
    appendText(parent, text.slice(at, end));
    at = end;
  }
}

function appendParagraph(parent: HTMLElement, lines: string[]): void {
  const paragraph = document.createElement("p");
  appendMarkdownInline(paragraph, lines.join("\n"));
  parent.append(paragraph);
}

/** Render headings, paragraphs, lists, quotes, fenced code, and inline Markdown safely. */
export function appendMarkdown(parent: HTMLElement, markdown: string): void {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }

    const fence = /^\s*```\s*([^\s`]*)?.*$/.exec(line);
    if (fence) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !/^\s*```/.test(lines[index]!))
        codeLines.push(lines[index++]!);
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1] && /^[a-z0-9_+-]+$/i.test(fence[1])) code.dataset["language"] = fence[1];
      code.textContent = codeLines.join("\n");
      pre.append(code);
      parent.append(pre);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1]!.length}`);
      appendMarkdownInline(element, heading[2]!);
      parent.append(element);
      index += 1;
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      parent.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index]!)) {
        quoteLines.push(lines[index++]!.replace(/^\s*>\s?/, ""));
      }
      const quote = document.createElement("blockquote");
      appendParagraph(quote, quoteLines);
      parent.append(quote);
      continue;
    }

    const unordered = /^\s*[-+*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      const matcher = unordered ? /^\s*[-+*]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      while (index < lines.length) {
        const item = matcher.exec(lines[index]!);
        if (!item) break;
        const entry = document.createElement("li");
        appendMarkdownInline(entry, item[1]!);
        list.append(entry);
        index += 1;
      }
      parent.append(list);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !/^\s*$/.test(lines[index]!) && !isBlockStart(lines[index]!)) {
      paragraphLines.push(lines[index++]!);
    }
    if (paragraphLines.length > 0) {
      appendParagraph(parent, paragraphLines);
    } else {
      // Defensive progress for a malformed edge case the recognisers did not consume.
      appendParagraph(parent, [line]);
      index += 1;
    }
  }
}
