/**
 * Read a Claude session's on-disk transcript back into normalized ChatMessages.
 *
 * This is the "history" feed (your instinct: keep the session id, re-read
 * Claude's own files). Transcripts live at
 * `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. The slug is the cwd with
 * non-alphanumerics turned into `-`, but dotted paths make that brittle, so the
 * resolver SCANS the project dirs for `<sessionId>.jsonl` — the session id is a
 * uuid, so a single match is unambiguous regardless of the slug rule.
 *
 * The JSONL is noisy (mode / permission-mode / file-history-snapshot /
 * attachment / ai-title / last-prompt / system records, sub-agent sidechains,
 * and synthetic skill/reminder injections). We whitelist user/assistant turns,
 * drop sidechains and injections, and re-join the per-block assistant records
 * Claude splits a turn into (they share a `message.id`).
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "@browserops/shared";
import { messageIdOf, normalizeMessage } from "./normalize.js";

export function claudeProjectsDir(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

/** Best-effort cwd→slug (documented fast-path; the resolver scans regardless). */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate `<sessionId>.jsonl`. Tries the computed slug first when a cwd is known,
 * then falls back to scanning every project dir (robust to the slug rule).
 */
export async function findTranscriptPath(
  sessionId: string,
  opts: { projectsRoot?: string; cwd?: string } = {},
): Promise<string | null> {
  const root = opts.projectsRoot ?? claudeProjectsDir();
  const file = `${sessionId}.jsonl`;

  if (opts.cwd) {
    const fast = join(root, slugForCwd(opts.cwd), file);
    if (await exists(fast)) return fast;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(root, entry, file);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

const INJECTION_PREFIXES = [
  "<system-reminder>",
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "Base directory for this skill:",
  "Caveat: The messages below were generated",
];

function looksLikeInjection(text: string): boolean {
  const t = text.trimStart();
  return INJECTION_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * A `user` record is a synthetic injection (skill body, system reminder, slash
 * command output) when its content is an ARRAY whose text blocks all look like
 * injections. Real user turns are either string content or non-injection text.
 */
function isInjectionUserRecord(record: Record<string, unknown>): boolean {
  if (record["type"] !== "user") return false;
  const message = record["message"];
  const content =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)["content"]
      : undefined;
  if (!Array.isArray(content)) return false;
  const texts = content
    .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    .filter((b) => b["type"] === "text")
    .map((b) => (typeof b["text"] === "string" ? b["text"] : ""));
  if (texts.length === 0) return false;
  const onlyText = content.every(
    (b) => typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "text",
  );
  return onlyText && texts.every(looksLikeInjection);
}

function tsOf(record: Record<string, unknown>): number | undefined {
  const raw = record["timestamp"];
  if (typeof raw !== "string") return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

/** Parse already-read JSONL text into normalized messages. Pure + sync. */
export function parseTranscript(text: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let lastAssistantId: string | undefined;

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = record["type"];
    if (type !== "user" && type !== "assistant") continue;
    if (record["isSidechain"] === true) continue;
    if (isInjectionUserRecord(record)) continue;

    const id = (typeof record["uuid"] === "string" && record["uuid"]) || `rec-${messages.length}`;
    const msg = normalizeMessage(record["message"], { id, ts: tsOf(record) });
    if (!msg) continue;

    // Re-join the per-block assistant records Claude splits a turn into.
    const recordMsgId = messageIdOf(record);
    if (
      type === "assistant" &&
      recordMsgId !== undefined &&
      recordMsgId === lastAssistantId &&
      messages.length > 0
    ) {
      messages[messages.length - 1]!.blocks.push(...msg.blocks);
      continue;
    }

    messages.push(msg);
    lastAssistantId = type === "assistant" ? recordMsgId : undefined;
  }
  return messages;
}

export async function readTranscript(path: string): Promise<ChatMessage[]> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch {
    return [];
  }
  return parseTranscript(text);
}

/** Resolve a session id to its transcript and normalize it. `[]` if not found. */
export async function loadHistory(
  sessionId: string,
  opts: { projectsRoot?: string; cwd?: string } = {},
): Promise<ChatMessage[]> {
  const path = await findTranscriptPath(sessionId, opts);
  return path ? readTranscript(path) : [];
}
