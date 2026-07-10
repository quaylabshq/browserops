/** Legacy compatibility journal and prompt-formatting helpers. */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChatBlock, ChatMessage, ChatRole } from "@browserops/shared";
import { chatDir as defaultChatDir } from "../paths.js";

interface TranscriptRecord {
  type: "message";
  message: ChatMessage;
}

const ROLES = new Set<ChatRole>(["user", "assistant", "system", "tool"]);
const appendQueues = new Map<string, Promise<void>>();

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isBlock(value: unknown): value is ChatBlock {
  const o = asObject(value);
  if (!o || typeof o["kind"] !== "string") return false;
  switch (o["kind"]) {
    case "text":
    case "thinking":
      return typeof o["text"] === "string";
    case "tool_use":
      return typeof o["id"] === "string" && typeof o["name"] === "string";
    case "tool_result":
      return (
        typeof o["id"] === "string" &&
        typeof o["ok"] === "boolean" &&
        typeof o["preview"] === "string"
      );
    default:
      return false;
  }
}

function isMessage(value: unknown): value is ChatMessage {
  const o = asObject(value);
  return (
    !!o &&
    typeof o["id"] === "string" &&
    typeof o["role"] === "string" &&
    ROLES.has(o["role"] as ChatRole) &&
    Array.isArray(o["blocks"]) &&
    o["blocks"].every(isBlock)
  );
}

export function browserTranscriptPath(sessionId: string, dir: string = defaultChatDir()): string {
  return join(dir, `${sessionId}.jsonl`);
}

export async function appendBrowserTranscriptMessage(
  sessionId: string,
  message: ChatMessage,
  dir: string = defaultChatDir(),
): Promise<void> {
  const key = browserTranscriptPath(sessionId, dir);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const record: TranscriptRecord = { type: "message", message };
      await fs.appendFile(key, JSON.stringify(record) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    })
    .catch(() => {
      /* history is non-fatal, but writes must stay ordered after a failure */
    });
  appendQueues.set(key, write);
  await write;
}

export async function readBrowserTranscript(
  sessionId: string,
  dir: string = defaultChatDir(),
): Promise<ChatMessage[]> {
  let text: string;
  try {
    text = await fs.readFile(browserTranscriptPath(sessionId, dir), "utf8");
  } catch {
    return [];
  }

  const byId = new Map<string, ChatMessage>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as unknown;
      const o = asObject(record);
      if (o?.["type"] === "message" && isMessage(o["message"])) {
        byId.set(o["message"].id, o["message"]);
      }
    } catch {
      /* tolerate torn/corrupt lines */
    }
  }
  return [...byId.values()];
}

export function messageText(message: ChatMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    switch (block.kind) {
      case "text":
      case "thinking":
        parts.push(block.text);
        break;
      case "tool_use":
        parts.push(`[tool_use:${block.name}]`);
        break;
      case "tool_result":
        parts.push(`[tool_result:${block.ok ? "ok" : "error"}] ${block.preview}`);
        break;
    }
  }
  return parts.join("\n").trim();
}

export function formatMessagesForPrompt(messages: readonly ChatMessage[], cap = 20_000): string {
  return formatMessages(messages, cap, messageText);
}

/**
 * Canonical-to-provider projection. Deliberate reasoning is never forwarded
 * between providers; provider-private thought must not become another model's
 * prompt. Tool blocks retain only their compact, renderable context.
 */
export function formatMessagesForProvider(messages: readonly ChatMessage[], cap = 20_000): string {
  return formatMessages(messages, cap, (message) => {
    const parts: string[] = [];
    for (const block of message.blocks) {
      if (block.kind === "text") parts.push(block.text);
      else if (block.kind === "tool_use") parts.push(`[tool_use:${block.name}]`);
      else if (block.kind === "tool_result") {
        parts.push(`[tool_result:${block.ok ? "ok" : "error"}] ${block.preview}`);
      }
    }
    return parts.join("\n").trim();
  });
}

function formatMessages(
  messages: readonly ChatMessage[],
  cap: number,
  textFor: (message: ChatMessage) => string,
): string {
  const lines: string[] = [];
  let total = 0;
  // Work backwards so a cap never drops the newest user turn. The old forward
  // loop retained older messages first and could omit the message we were about
  // to answer when a conversation was long.
  for (const message of [...messages.slice(-40)].reverse()) {
    const text = textFor(message).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `${message.role}: ${text}`;
    total += line.length + 1;
    if (total > cap) {
      lines.unshift("[earlier transcript omitted]");
      break;
    }
    lines.unshift(line);
  }
  return lines.join("\n");
}

/** Merge native/provider and BrowserOps records without duplicating a replay. */
export function mergeChatHistory(
  first: readonly ChatMessage[],
  second: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...first, ...second]) byId.set(message.id, message);
  return [...byId.values()];
}
