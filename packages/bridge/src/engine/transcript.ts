import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChatBlock, ChatMessage, ChatRole } from "@browserops/shared";
import { chatDir as defaultChatDir } from "../paths.js";

interface TranscriptRecord {
  type: "message";
  message: ChatMessage;
}

const ROLES = new Set<ChatRole>(["user", "assistant", "system", "tool"]);

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
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const record: TranscriptRecord = { type: "message", message };
    await fs.appendFile(browserTranscriptPath(sessionId, dir), JSON.stringify(record) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    /* transcript is best-effort */
  }
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
  const lines: string[] = [];
  let total = 0;
  for (const message of messages.slice(-40)) {
    const text = messageText(message).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `${message.role}: ${text}`;
    total += line.length + 1;
    if (total > cap) {
      lines.unshift("[earlier transcript omitted]");
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}
