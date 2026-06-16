/**
 * Claude → normalized chat, the agent-specific half of the engine.
 *
 * Two feeds, one normalizer:
 *  - LIVE: objects parsed from `claude --output-format stream-json` stdout.
 *    Each line is one envelope: `{type:"system",subtype:"init",session_id,cwd}`,
 *    `{type:"assistant",message,uuid}`, `{type:"user",message,uuid}` (tool
 *    results), `{type:"result",is_error,subtype}`, `{type:"rate_limit_event"}`.
 *    A non-partial assistant event carries the WHOLE message (all blocks).
 *  - HISTORY: records from the on-disk `~/.claude/projects/.../<id>.jsonl`.
 *    Same inner `message` object, but camelCase wrapper (`sessionId`,
 *    `parentUuid`, `isSidechain`) and — crucially — one record PER content
 *    block, several sharing a `message.id`. The transcript reader (see
 *    transcript.ts) re-joins those; this module only normalizes a single
 *    `message` object.
 *
 * The inner `message` is an Anthropic message: `{ role, content }` where
 * `content` is a string or an array of `text` / `thinking` / `tool_use` /
 * `tool_result` blocks. That mapping is the shared core below.
 */
import type { ChatBlock, ChatEvent, ChatMessage, ChatRole } from "@browserops/shared";

const PREVIEW_CAP = 2000;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Stringify a tool_result `content` (string | text-block array | object) for display. */
export function previewToolResult(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = content.map((b) => {
      const o = asObject(b);
      if (o && o["type"] === "text") return asString(o["text"]);
      return o ? JSON.stringify(o) : String(b);
    });
    text = parts.join("\n");
  } else if (content === undefined || content === null) {
    text = "";
  } else {
    text = JSON.stringify(content);
  }
  return text.length > PREVIEW_CAP ? text.slice(0, PREVIEW_CAP) + "…" : text;
}

/** One Anthropic content value (string | block[]) → renderable blocks. */
export function normalizeContent(content: unknown): ChatBlock[] {
  if (typeof content === "string") {
    const text = content;
    return text.trim().length > 0 ? [{ kind: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: ChatBlock[] = [];
  for (const raw of content) {
    const b = asObject(raw);
    if (!b) continue;
    switch (b["type"]) {
      case "text": {
        const text = asString(b["text"]);
        if (text.trim().length > 0) blocks.push({ kind: "text", text });
        break;
      }
      case "thinking": {
        const text = asString(b["thinking"]);
        if (text.trim().length > 0) blocks.push({ kind: "thinking", text });
        break;
      }
      case "tool_use": {
        blocks.push({
          kind: "tool_use",
          id: asString(b["id"]),
          name: asString(b["name"]),
          input: b["input"],
        });
        break;
      }
      case "tool_result": {
        blocks.push({
          kind: "tool_result",
          id: asString(b["tool_use_id"]),
          ok: b["is_error"] !== true,
          preview: previewToolResult(b["content"]),
        });
        break;
      }
      case "image": {
        blocks.push({ kind: "text", text: "[image]" });
        break;
      }
      default:
        break; // redacted_thinking and any future block types: skip silently
    }
  }
  return blocks;
}

function roleFor(rawRole: unknown, blocks: ChatBlock[]): ChatRole {
  if (rawRole === "assistant") return "assistant";
  if (rawRole === "system") return "system";
  // A user-role message that is only tool results is a tool turn, not the user.
  if (blocks.length > 0 && blocks.every((b) => b.kind === "tool_result")) return "tool";
  return "user";
}

export interface NormalizeMeta {
  id: string;
  ts?: number;
  partial?: boolean;
}

/**
 * Normalize one Anthropic `message` object. Returns null when nothing
 * renderable survives (e.g. an assistant record carrying only an empty
 * thinking block — Claude writes those).
 */
export function normalizeMessage(message: unknown, meta: NormalizeMeta): ChatMessage | null {
  const m = asObject(message);
  if (!m) return null;
  const blocks = normalizeContent(m["content"]);
  if (blocks.length === 0) return null;
  const msg: ChatMessage = { id: meta.id, role: roleFor(m["role"], blocks), blocks };
  if (meta.ts !== undefined) msg.ts = meta.ts;
  if (meta.partial) msg.partial = true;
  return msg;
}

/** The `message.id` Claude uses to group on-disk block-records, if present. */
export function messageIdOf(record: unknown): string | undefined {
  const m = asObject(asObject(record)?.["message"]);
  const id = m?.["id"];
  return typeof id === "string" ? id : undefined;
}

/** Pull `{ sessionId, cwd }` from a stream-json `system/init` envelope. */
export function parseInit(raw: unknown): { sessionId?: string; cwd?: string } | null {
  const o = asObject(raw);
  if (!o || o["type"] !== "system" || o["subtype"] !== "init") return null;
  const out: { sessionId?: string; cwd?: string } = {};
  if (typeof o["session_id"] === "string") out.sessionId = o["session_id"];
  if (typeof o["cwd"] === "string") out.cwd = o["cwd"];
  return out;
}

/**
 * Map one LIVE stream-json stdout envelope to zero or more ChatEvents.
 * `system/init` is handled by the runtime (it owns session lifecycle) and
 * yields nothing here. A turn-closing `result` becomes an idle/error status.
 */
export function liveEventToEvents(raw: unknown): ChatEvent[] {
  const o = asObject(raw);
  if (!o) return [];
  switch (o["type"]) {
    case "assistant":
    case "user": {
      const msg = normalizeMessage(o["message"], { id: asString(o["uuid"]) || cryptoishId(o) });
      return msg ? [{ type: "message", message: msg }] : [];
    }
    case "result": {
      if (o["is_error"] === true) {
        return [{ type: "status", state: "error", detail: asString(o["subtype"]) || "error" }];
      }
      return [{ type: "status", state: "idle" }];
    }
    case "rate_limit_event": {
      const info = asObject(o["rate_limit_info"]);
      if (info && info["status"] !== "allowed") {
        return [{ type: "status", state: "error", detail: "rate_limited" }];
      }
      return [];
    }
    default:
      return [];
  }
}

/** Deterministic-ish fallback id when an envelope lacks a uuid. */
function cryptoishId(o: Record<string, unknown>): string {
  const t = asString(o["type"]) || "evt";
  const r = asString(o["request_id"]);
  return r ? `${t}-${r}` : `${t}-${asString(o["session_id"])}`;
}
