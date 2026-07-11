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

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizedItemType(o: Record<string, unknown>): string {
  return asString(o["type"]).replace(/[_-]/g, "").toLowerCase();
}

function isActionItem(type: string): boolean {
  return ["commandexecution", "mcptoolcall", "filechange", "websearch"].includes(type);
}

function toolBlock(o: Record<string, unknown>): ChatBlock | null {
  const type = normalizedItemType(o);
  const id = pickString(o, ["id", "call_id", "tool_call_id"]) ?? type;
  if (type === "mcptoolcall") {
    const server = pickString(o, ["server", "server_name", "serverName"]) ?? "mcp";
    const tool = pickString(o, ["tool", "name", "tool_name", "toolName"]) ?? "tool";
    return {
      kind: "tool_use",
      id,
      name: `mcp__${server}__${tool}`,
      input: parseArguments(o["arguments"] ?? o["input"] ?? o["args"]),
    };
  }
  if (type === "commandexecution") {
    return {
      kind: "tool_use",
      id,
      name: "command_execution",
      input: { command: o["command"], cwd: o["cwd"] },
    };
  }
  if (type === "filechange") {
    return { kind: "tool_use", id, name: "file_change", input: { changes: o["changes"] } };
  }
  if (type === "websearch") {
    return { kind: "tool_use", id, name: "web_search", input: { query: o["query"] } };
  }
  const name = pickString(o, ["name", "tool", "tool_name", "toolName", "command"]);
  if (!name) return null;
  return { kind: "tool_use", id, name, input: o["input"] ?? o["args"] ?? o["arguments"] };
}

function toolResultBlock(o: Record<string, unknown>): ChatBlock {
  const type = normalizedItemType(o);
  const raw =
    type === "commandexecution"
      ? {
          output: o["aggregated_output"] ?? o["output"],
          exitCode: o["exit_code"] ?? o["exitCode"],
          durationMs: o["duration_ms"] ?? o["durationMs"],
        }
      : type === "filechange"
        ? { changes: o["changes"] }
        : (o["result"] ?? o["output"] ?? o["content"] ?? o["message"] ?? o);
  const preview = typeof raw === "string" ? raw : JSON.stringify(raw);
  return {
    kind: "tool_result",
    id: pickString(o, ["id", "call_id", "tool_call_id"]) ?? (type || "tool"),
    ok:
      o["is_error"] !== true &&
      o["error"] === undefined &&
      o["status"] !== "failed" &&
      o["status"] !== "declined",
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
  const item = asObject(o["item"]);
  const itemType = asString(item?.["type"]);

  // Codex exec --json emits the app-server item lifecycle. Item completion is
  // not turn completion: a command/tool item can complete while the model is
  // still working, so never emit idle here.
  if (type === "item.completed" && item) {
    if (itemType === "agent_message" || itemType === "agentMessage") {
      const text = extractText(item);
      if (text.trim()) {
        events.push({
          type: "message",
          message: {
            id: eventId(item, "codex-assistant"),
            role: "assistant",
            blocks: [{ kind: "text", text }],
          },
        });
      }
    } else if (isActionItem(normalizedItemType(item))) {
      events.push({
        type: "message",
        message: {
          id: eventId(item, "codex-tool-result"),
          role: "tool",
          blocks: [toolResultBlock(item)],
        },
      });
    }
    return native ? { events, nativeSessionId: native } : { events };
  }

  if (
    type === "item.agent_message.delta" ||
    type === "item/agentMessage/delta" ||
    type === "agent_message.delta"
  ) {
    const text = extractText(o);
    if (text.trim()) {
      events.push({
        type: "message",
        message: {
          id: pickString(o, ["item_id", "itemId"]) ?? eventId(o, "codex-assistant"),
          role: "assistant",
          blocks: [{ kind: "text", text }],
          partial: true,
        },
      });
    }
    return native ? { events, nativeSessionId: native } : { events };
  }

  if (
    (type === "item.started" || type === "item/started") &&
    item &&
    isActionItem(normalizedItemType(item))
  ) {
    const block = toolBlock(item);
    if (block) {
      events.push({
        type: "message",
        message: { id: eventId(item, "codex-tool"), role: "assistant", blocks: [block] },
      });
    }
    return native ? { events, nativeSessionId: native } : { events };
  }

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
  } else if (type === "result" || type === "turn.completed" || type === "turn/completed") {
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
    if (o["is_error"] === true) events.push({ type: "status", state: "error" });
  } else if (type.includes("error")) {
    events.push({ type: "status", state: "error", detail: extractText(o) || type });
  }

  return native ? { events, nativeSessionId: native } : { events };
}
