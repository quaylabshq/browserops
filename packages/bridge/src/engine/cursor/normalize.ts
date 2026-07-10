import type { ChatBlock, ChatEvent, ChatMessage } from "@browserops/shared";
import type { NormalizedLine } from "../process-driver.js";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function eventId(o: Record<string, unknown>, prefix: string): string {
  const id =
    asString(o["id"]) ||
    asString(o["uuid"]) ||
    asString(o["message_id"]) ||
    asString(o["timestamp_ms"]);
  return id ? `${prefix}-${id}` : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function textFromMessage(value: unknown): string {
  if (typeof value === "string") return value;
  const o = asObject(value);
  if (!o) return "";
  if (typeof o["text"] === "string") return o["text"];
  if (typeof o["content"] === "string") return o["content"];
  if (Array.isArray(o["content"])) {
    return o["content"]
      .map((part) => {
        const p = asObject(part);
        return p ? asString(p["text"]) || asString(p["content"]) : "";
      })
      .join("");
  }
  return "";
}

function textFromEvent(o: Record<string, unknown>): string {
  return (
    asString(o["text"]) ||
    asString(o["delta"]) ||
    asString(o["result"]) ||
    textFromMessage(o["message"])
  );
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolName(tool: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(tool)) {
    const o = asObject(value);
    if (o && (o["args"] !== undefined || o["result"] !== undefined)) return key;
  }
  return asString(tool["name"]) || "tool";
}

function toolUseBlock(tool: Record<string, unknown>): ChatBlock {
  const name = toolName(tool);
  const inner = asObject(tool[name]) ?? tool;
  return {
    kind: "tool_use",
    id: asString(tool["id"]) || name,
    name,
    input: inner["args"] ?? tool["args"] ?? tool,
  };
}

function toolResultBlock(tool: Record<string, unknown>): ChatBlock {
  const name = toolName(tool);
  const inner = asObject(tool[name]) ?? tool;
  const raw = inner["result"] ?? tool["result"] ?? tool;
  const preview = stringify(raw);
  return {
    kind: "tool_result",
    id: asString(tool["id"]) || name,
    ok: asObject(raw)?.["error"] === undefined && tool["error"] === undefined,
    preview: preview.length > 2000 ? preview.slice(0, 2000) + "…" : preview,
  };
}

function nativeSessionId(o: Record<string, unknown>): string | undefined {
  for (const key of ["chatId", "chat_id", "sessionId", "session_id"]) {
    const value = o[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function cursorLineToEvents(raw: unknown, turnId?: string): NormalizedLine {
  const o = asObject(raw);
  if (!o) return { events: [] };
  const type = asString(o["type"]);
  const subtype = asString(o["subtype"]);
  const native = nativeSessionId(o);
  const events: ChatEvent[] = [];

  if (type === "assistant") {
    const text = textFromEvent(o);
    if (text.trim()) {
      const partial = o["timestamp_ms"] !== undefined;
      const message: ChatMessage = {
        id: partial && turnId ? `${turnId}-assistant` : eventId(o, "cursor-assistant"),
        role: "assistant",
        blocks: [{ kind: "text", text }],
        ...(partial ? { partial: true } : {}),
      };
      events.push({ type: "message", message });
    }
  } else if (type === "tool_call") {
    const tool = asObject(o["tool_call"]) ?? o;
    if (subtype === "completed") {
      events.push({
        type: "message",
        message: {
          id: eventId(o, "cursor-tool-result"),
          role: "tool",
          blocks: [toolResultBlock(tool)],
        },
      });
    } else {
      events.push({
        type: "message",
        message: {
          id: eventId(o, "cursor-tool"),
          role: "assistant",
          blocks: [toolUseBlock(tool)],
        },
      });
    }
  } else if (type === "result") {
    const text = textFromEvent(o);
    if (text.trim()) {
      events.push({
        type: "message",
        message: {
          id: turnId ? `${turnId}-assistant` : eventId(o, "cursor-result"),
          role: "assistant",
          blocks: [{ kind: "text", text }],
        },
      });
    }
    events.push({ type: "status", state: o["error"] === undefined ? "idle" : "error" });
  } else if (type === "error") {
    events.push({ type: "status", state: "error", detail: textFromEvent(o) || "error" });
  }

  return native ? { events, nativeSessionId: native } : { events };
}
