/**
 * The read-only terminal mirror. As the engine streams a session, it appends
 * human-readable lines here; "Show in terminal" just tails this file (`tail -f`
 * / `Get-Content -Wait`), so the terminal view is dead simple and agent-
 * agnostic. The engine remains the sole writer of the session — the mirror is
 * a reader, never a second driver.
 */
import { promises as fs } from "node:fs";
import type { ChatEvent } from "@browserops/shared";

const ONE_LINE_CAP = 200;
const INPUT_CAP = 160;

function oneLine(text: string, cap = ONE_LINE_CAP): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap) + "…" : flat;
}

function previewInput(input: unknown): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return oneLine(s ?? "", INPUT_CAP);
}

export function mirrorHeader(sessionId: string): string {
  return [
    "═══════════════════════════════════════════════",
    " BrowserOps · Claude session (read-only mirror)",
    ` ${sessionId}`,
    " Chat from the side panel; this view follows along.",
    "═══════════════════════════════════════════════",
    "",
  ].join("\n");
}

export function mirrorUserLine(text: string): string {
  return `\n▸ you:\n${text}\n`;
}

/** A human-readable line (or null when the event shouldn't surface) for the mirror. */
export function mirrorEventLine(event: ChatEvent): string | null {
  if (event.type === "status") {
    switch (event.state) {
      case "thinking":
        return "  · thinking…";
      case "error":
        return `  ✗ error: ${event.detail ?? ""}`;
      case "ejected":
        return "\n  ⤢ taken over in terminal — the engine has let go of this session.\n";
      default:
        return null; // starting / idle are silent
    }
  }
  if (event.type === "message") {
    const m = event.message;
    const lines: string[] = [];
    for (const b of m.blocks) {
      switch (b.kind) {
        case "text":
          lines.push(m.role === "assistant" ? `\n◆ claude:\n${b.text}` : b.text);
          break;
        case "thinking":
          lines.push(`  (thinking) ${oneLine(b.text)}`);
          break;
        case "tool_use":
          lines.push(`  ⚙ ${b.name}(${previewInput(b.input)})`);
          break;
        case "tool_result":
          lines.push(`  ${b.ok ? "✓" : "✗"} ${oneLine(b.preview)}`);
          break;
      }
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }
  return null;
}

/** Best-effort append — a failed mirror write never breaks a turn. */
export async function appendMirror(path: string, text: string): Promise<void> {
  try {
    await fs.appendFile(path, text.endsWith("\n") ? text : text + "\n", "utf8");
  } catch {
    /* mirror is best-effort */
  }
}
