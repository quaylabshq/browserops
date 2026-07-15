/** Interactive Codex TUI driver backed by a hidden PTY and Codex's JSONL session log. */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatEvent, ChatMessage, SessionRef } from "@browserops/shared";
import {
  InteractivePtyDriver,
  type InteractivePtyBuildInput,
  type InteractivePtyDriverDeps,
  type InteractivePtyTailerContext,
} from "../interactive-pty-driver.js";
import {
  PollingJsonlTranscriptTailer,
  asRecord,
  textFromContent,
  type DiscoveredTranscript,
  type TranscriptReducer,
} from "../pty-transcript.js";

export interface CodexPtyDriverDeps extends InteractivePtyDriverDeps {
  sessionsRoot?: string;
  tailer?: { pollMs?: number; quiescenceMs?: number };
}

export function codexSessionsDir(home: string = homedir()): string {
  return join(home, ".codex", "sessions");
}

export function buildCodexInteractiveArgs(input: InteractivePtyBuildInput): string[] {
  const args = input.resume ? ["resume", input.ref.nativeSessionId ?? ""] : [];
  args.push(
    "--no-alt-screen",
    "--sandbox",
    input.safeMode ? "read-only" : "workspace-write",
    "--ask-for-approval",
    input.safeMode ? "on-request" : "never",
  );
  if (!input.safeMode) {
    args.push("-c", 'mcp_servers.browserops.default_tools_approval_mode="auto"');
  }
  if (input.ref.model) args.push("--model", input.ref.model);
  if (input.ref.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${input.ref.reasoningEffort}"`);
  }
  args.push("-C", input.ref.cwd);
  return args;
}

async function jsonlFiles(root: string): Promise<string[]> {
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

async function codexMeta(path: string): Promise<{ id?: string; cwd?: string } | undefined> {
  try {
    const first = (await fs.readFile(path, "utf8")).split("\n", 1)[0];
    if (!first) return undefined;
    const record = JSON.parse(first) as Record<string, unknown>;
    if (record["type"] !== "session_meta") return undefined;
    const payload = asRecord(record["payload"]);
    return {
      ...(typeof payload?.["session_id"] === "string" ? { id: payload["session_id"] } : {}),
      ...(typeof payload?.["cwd"] === "string" ? { cwd: payload["cwd"] } : {}),
    };
  } catch {
    return undefined;
  }
}

function contentText(value: unknown): string {
  return textFromContent(value).trim();
}

export function createCodexTranscriptReducer(): TranscriptReducer {
  let generated = 0;
  return {
    push(record) {
      const events: ChatEvent[] = [];
      let nativeSessionId: string | undefined;
      if (record["type"] === "session_meta") {
        const meta = asRecord(record["payload"]);
        if (typeof meta?.["session_id"] === "string") nativeSessionId = meta["session_id"];
      }

      const payload = asRecord(record["payload"]);
      if (record["type"] === "response_item" && payload?.["type"] === "message") {
        const role = payload["role"];
        const text = contentText(payload["content"]);
        if ((role === "user" || role === "assistant") && text) {
          const id =
            typeof payload["id"] === "string" ? payload["id"] : `codex-${role}-${++generated}`;
          events.push({
            type: "message",
            message: { id, role, blocks: [{ kind: "text", text }] },
          });
        }
      } else if (record["type"] === "response_item" && payload?.["type"] === "custom_tool_call") {
        const callId =
          typeof payload["call_id"] === "string"
            ? payload["call_id"]
            : typeof payload["id"] === "string"
              ? payload["id"]
              : `codex-tool-${++generated}`;
        const name = typeof payload["name"] === "string" ? payload["name"] : "tool";
        events.push({
          type: "message",
          message: {
            id: `codex-tool-${callId}`,
            role: "assistant",
            blocks: [{ kind: "tool_use", id: callId, name, input: payload["input"] ?? {} }],
          },
        });
        const status = typeof payload["status"] === "string" ? payload["status"] : "";
        if (status === "completed" || status === "failed") {
          events.push({
            type: "message",
            message: {
              id: `codex-tool-result-${callId}`,
              role: "tool",
              blocks: [
                {
                  kind: "tool_result",
                  id: callId,
                  ok: status === "completed",
                  preview: typeof payload["output"] === "string" ? payload["output"] : status,
                },
              ],
            },
          });
        }
      } else if (record["type"] === "event_msg") {
        const eventType = typeof payload?.["type"] === "string" ? payload["type"] : "";
        if (eventType === "task_started") events.push({ type: "status", state: "thinking" });
        if (eventType === "task_complete" || eventType === "turn_aborted") {
          events.push({ type: "status", state: "idle" });
        }
      }
      return {
        events,
        ...(nativeSessionId ? { nativeSessionId } : {}),
      };
    },
  };
}

async function findCodexTranscript(
  root: string,
  cwd: string,
  baseline: ReadonlySet<string>,
  nativeSessionId?: string,
): Promise<DiscoveredTranscript | null> {
  const files = await jsonlFiles(root);
  const candidates: Array<{ path: string; id: string; mtime: number }> = [];
  for (const path of files) {
    if (!nativeSessionId && baseline.has(path)) continue;
    const meta = await codexMeta(path);
    if (!meta?.id || meta.cwd !== cwd) continue;
    if (nativeSessionId && meta.id !== nativeSessionId) continue;
    try {
      candidates.push({ path, id: meta.id, mtime: (await fs.stat(path)).mtimeMs });
    } catch {
      /* file rotated while scanning */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const found = candidates[0];
  return found ? { path: found.path, nativeSessionId: found.id } : null;
}

async function readCodexHistory(root: string, ref: SessionRef): Promise<ChatMessage[]> {
  if (!ref.nativeSessionId) return [];
  const found = await findCodexTranscript(root, ref.cwd, new Set(), ref.nativeSessionId);
  if (!found) return [];
  let text: string;
  try {
    text = await fs.readFile(found.path, "utf8");
  } catch {
    return [];
  }
  const reducer = createCodexTranscriptReducer();
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

export class CodexPtyDriver extends InteractivePtyDriver {
  override readonly id = "codex" as const;
  private readonly sessionsRoot: string;
  private readonly tailerOpts: { pollMs?: number; quiescenceMs?: number };

  constructor(deps: CodexPtyDriverDeps = {}) {
    super("codex", "codex", deps);
    this.sessionsRoot = deps.sessionsRoot ?? codexSessionsDir();
    this.tailerOpts = deps.tailer ?? {};
  }

  protected buildInteractiveArgs(input: InteractivePtyBuildInput): string[] {
    return buildCodexInteractiveArgs(input);
  }

  protected createTranscriptTailer(
    context: InteractivePtyTailerContext,
  ): PollingJsonlTranscriptTailer {
    const baseline = new Set<string>();
    return new PollingJsonlTranscriptTailer({
      prepare: async () => {
        for (const path of await jsonlFiles(this.sessionsRoot)) baseline.add(path);
      },
      discover: () =>
        findCodexTranscript(
          this.sessionsRoot,
          context.ref.cwd,
          baseline,
          context.ref.nativeSessionId,
        ),
      createReducer: createCodexTranscriptReducer,
      listener: context.emit,
      onNativeSession: context.onNativeSession,
      ...this.tailerOpts,
    });
  }

  protected async loadNativeHistory(ref: SessionRef): Promise<ChatMessage[]> {
    return readCodexHistory(this.sessionsRoot, ref);
  }
}
