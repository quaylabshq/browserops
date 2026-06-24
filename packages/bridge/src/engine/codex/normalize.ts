import type { ChatBlock, ChatEvent, ChatMessage } from "@browserops/shared";
import type { NormalizedLine } from "../process-driver.js";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pickString(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    const o = asObject(item);
    if (!o) continue;
    const text = asString(o["text"]) || asString(o["content"]);
    if (text) parts.push(text);
  }
  return parts.join("");
}

function extractText(o: Record<string, unknown>): string {
  const direct = pickString(o, ["text", "delta", "content", "message", "result"]);
  if (direct) return direct;
  const message = asObject(o["message"]);
  if (message) {
    const msgText = pickString(message, ["text", "content"]);
    if (msgText) return msgText;
    return textFromContent(message["content"]);
  }
  const item = asObject(o["item"]);
  if (item) return extractText(item);
  const result = asObject(o["result"]);
  if (result) return extractText(result);
  return "";
}

function eventId(o: Record<string, unknown>, prefix: string): string {
  return (
    pickString(o, ["id", "uuid", "message_id", "item_id", "event_id", "turn_id"]) ??
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function nativeSessionId(o: Record<string, unknown>): string | undefined {
  return pickString(o, [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
  ]);
}

function toolBlock(o: Record<string, unknown>): ChatBlock | null {
  const name = pickString(o, ["name", "tool_name", "toolName", "command"]);
  if (!name) return null;
  return {
    kind: "tool_use",
    id: pickString(o, ["id", "call_id", "tool_call_id"]) ?? name,
    name,
    input: o["input"] ?? o["args"] ?? o["arguments"],
  };
}

function toolResultBlock(o: Record<string, unknown>): ChatBlock {
  const preview =
    pickString(o, ["preview", "output", "result", "content", "message"]) ?? JSON.stringify(o);
  return {
    kind: "tool_result",
    id: pickString(o, ["id", "call_id", "tool_call_id"]) ?? "tool",
    ok: o["is_error"] !== true && o["error"] === undefined,
    preview: preview.length > 2000 ? preview.slice(0, 2000) + "…" : preview,
  };
}

export function codexLineToEvents(raw: unknown): NormalizedLine {
  const o = asObject(raw);
  if (!o) return { events: [] };
  const type = asString(o["type"]) || asString(o["event"]) || asString(o["kind"]);
  const subtype = asString(o["subtype"]);
  const native = nativeSessionId(o);
  const events: ChatEvent[] = [];

  if (type.includes("assistant") || type.includes("message") || type === "agent_message") {
    const text = extractText(o);
    if (text.trim()) {
      const message: ChatMessage = {
        id: eventId(o, "codex-assistant"),
        role: "assistant",
        blocks: [{ kind: "text", text }],
      };
      events.push({ type: "message", message });
    }
  } else if (type.includes("tool") && (subtype === "started" || type.includes("started"))) {
    const block = toolBlock(asObject(o["tool_call"]) ?? o);
    if (block) {
      events.push({
        type: "message",
        message: { id: eventId(o, "codex-tool"), role: "assistant", blocks: [block] },
      });
    }
  } else if (type.includes("tool") && (subtype === "completed" || type.includes("completed"))) {
    events.push({
      type: "message",
      message: {
        id: eventId(o, "codex-tool-result"),
        role: "tool",
        blocks: [toolResultBlock(asObject(o["tool_call"]) ?? o)],
      },
    });
  } else if (type === "result" || type.endsWith(".completed") || type === "turn.completed") {
    const text = extractText(o);
    if (text.trim()) {
      events.push({
        type: "message",
        message: {
          id: eventId(o, "codex-result"),
          role: "assistant",
          blocks: [{ kind: "text", text }],
        },
      });
    }
    events.push({ type: "status", state: o["is_error"] === true ? "error" : "idle" });
  } else if (type.includes("error")) {
    events.push({ type: "status", state: "error", detail: extractText(o) || type });
  }

  return native ? { events, nativeSessionId: native } : { events };
}
