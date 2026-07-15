/** Interactive Cursor Agent driver backed by its native on-disk transcript. */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ChatBlock, ChatEvent, ChatMessage, SessionRef } from "@browserops/shared";
import {
  InteractivePtyDriver,
  type InteractivePtyBuildInput,
  type InteractivePtyDriverDeps,
  type InteractivePtyTailerContext,
} from "../interactive-pty-driver.js";
import {
  PollingJsonlTranscriptTailer,
  asRecord,
  type DiscoveredTranscript,
  type TranscriptReducer,
} from "../pty-transcript.js";

export interface CursorPtyDriverDeps extends InteractivePtyDriverDeps {
  projectsRoot?: string;
  tailer?: { pollMs?: number; quiescenceMs?: number };
}

export function cursorProjectSlug(cwd: string): string {
  // Cursor strips leading/trailing separators and collapses runs such as `/.`
  // into one dash: `/Users/me/.browserops` → `Users-me-browserops`.
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function cursorTranscriptDir(cwd: string, home: string = homedir()): string {
  return join(home, ".cursor", "projects", cursorProjectSlug(cwd), "agent-transcripts");
}

export function buildCursorInteractiveArgs(input: InteractivePtyBuildInput): string[] {
  if (input.resume) {
    return input.ref.nativeSessionId ? ["--resume", input.ref.nativeSessionId] : ["resume"];
  }
  const args = ["--workspace", input.ref.cwd];
  // Keep Cursor in its ordinary interactive approval flow. `--force` is useful
  // for the print driver, but turns a live TUI into an automation surface and
  // can end a session after a completed run instead of waiting for the next turn.
  if (input.safeMode) args.push("--mode", "ask");
  if (input.ref.model) args.push("--model", input.ref.model);
  return args;
}

async function transcriptFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  await walk(root);
  return out;
}

function textFromParts(content: unknown): { text: string; blocks: ChatBlock[] } {
  if (typeof content === "string")
    return { text: content, blocks: [{ kind: "text", text: content }] };
  if (!Array.isArray(content)) return { text: "", blocks: [] };
  const text: string[] = [];
  const blocks: ChatBlock[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    const type = typeof record["type"] === "string" ? record["type"] : "";
    const value = typeof record["text"] === "string" ? record["text"] : "";
    if (value) {
      text.push(value);
      blocks.push({ kind: "text", text: value });
      continue;
    }
    const callId =
      typeof record["call_id"] === "string"
        ? record["call_id"]
        : typeof record["id"] === "string"
          ? record["id"]
          : `cursor-tool-${blocks.length}`;
    const name =
      typeof record["name"] === "string"
        ? record["name"]
        : typeof record["tool_name"] === "string"
          ? record["tool_name"]
          : type;
    if (type.includes("tool") && !type.includes("result")) {
      blocks.push({
        kind: "tool_use",
        id: callId,
        name: name || "tool",
        input: record["args"] ?? {},
      });
    } else if (type.includes("result")) {
      const raw = record["result"] ?? record["output"] ?? "";
      blocks.push({
        kind: "tool_result",
        id: callId,
        ok: record["error"] === undefined,
        preview: typeof raw === "string" ? raw : JSON.stringify(raw),
      });
    }
  }
  return { text: text.join(""), blocks };
}

function cursorUserText(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (match?.[1] ?? text).trim();
}

export function createCursorTranscriptReducer(): TranscriptReducer {
  let sequence = 0;
  return {
    push(record) {
      const events: ChatEvent[] = [];
      if (record["type"] === "turn_ended") {
        events.push({
          type: "status",
          state: record["status"] === "success" ? "idle" : "error",
        });
        return { events };
      }
      const role = record["role"];
      const message = asRecord(record["message"]);
      if (role !== "user" && role !== "assistant") return { events };
      const parsed = textFromParts(message?.["content"]);
      const blocks = parsed.blocks;
      if (role === "user") {
        const text = cursorUserText(parsed.text);
        if (!text) return { events };
        events.push({
          type: "message",
          message: {
            id: typeof message?.["id"] === "string" ? message["id"] : `cursor-user-${++sequence}`,
            role,
            blocks: [{ kind: "text", text }],
          },
        });
      } else if (blocks.length > 0) {
        events.push({
          type: "message",
          message: {
            id:
              typeof message?.["id"] === "string"
                ? message["id"]
                : `cursor-assistant-${++sequence}`,
            role,
            blocks,
          },
        });
      }
      return { events };
    },
  };
}

async function findCursorTranscript(
  root: string,
  baseline: ReadonlySet<string>,
  nativeSessionId?: string,
): Promise<DiscoveredTranscript | null> {
  if (nativeSessionId) {
    const direct = join(root, nativeSessionId, `${nativeSessionId}.jsonl`);
    try {
      await fs.access(direct);
      return { path: direct, nativeSessionId };
    } catch {
      // Fall through: older Cursor versions can place the file differently.
    }
  }
  const files = await transcriptFiles(root);
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const path of files) {
    if (baseline.has(path)) continue;
    try {
      candidates.push({ path, mtime: (await fs.stat(path)).mtimeMs });
    } catch {
      /* file rotated while scanning */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const found = candidates[0];
  if (!found) return null;
  const native = basename(found.path, ".jsonl");
  return { path: found.path, nativeSessionId: native };
}

async function readCursorHistory(root: string, ref: SessionRef): Promise<ChatMessage[]> {
  if (!ref.nativeSessionId) return [];
  const found = await findCursorTranscript(root, new Set(), ref.nativeSessionId);
  if (!found) return [];
  let text: string;
  try {
    text = await fs.readFile(found.path, "utf8");
  } catch {
    return [];
  }
  const reducer = createCursorTranscriptReducer();
  const messages = new Map<string, ChatMessage>();
  for (const line of text.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      for (const event of reducer.push(record).events) {
        if (event.type === "message") messages.set(event.message.id, event.message);
      }
    } catch {
      /* tolerate incomplete append */
    }
  }
  return [...messages.values()];
}

export class CursorPtyDriver extends InteractivePtyDriver {
  override readonly id = "cursor" as const;
  private readonly projectsRoot?: string;
  private readonly tailerOpts: { pollMs?: number; quiescenceMs?: number };

  constructor(deps: CursorPtyDriverDeps = {}) {
    super("cursor", "agent", deps);
    this.projectsRoot = deps.projectsRoot;
    this.tailerOpts = deps.tailer ?? {};
  }

  protected buildInteractiveArgs(input: InteractivePtyBuildInput): string[] {
    return buildCursorInteractiveArgs(input);
  }

  protected createTranscriptTailer(
    context: InteractivePtyTailerContext,
  ): PollingJsonlTranscriptTailer {
    const root = this.projectsRoot ?? cursorTranscriptDir(context.ref.cwd);
    const baseline = new Set<string>();
    return new PollingJsonlTranscriptTailer({
      prepare: async () => {
        for (const path of await transcriptFiles(root)) baseline.add(path);
      },
      discover: () => findCursorTranscript(root, baseline, context.ref.nativeSessionId),
      createReducer: createCursorTranscriptReducer,
      listener: context.emit,
      onNativeSession: context.onNativeSession,
      ...this.tailerOpts,
    });
  }

  protected async loadNativeHistory(ref: SessionRef): Promise<ChatMessage[]> {
    const root = this.projectsRoot ?? cursorTranscriptDir(ref.cwd);
    return readCursorHistory(root, ref);
  }
}
