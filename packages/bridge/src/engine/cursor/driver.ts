import {
  HeadlessProcessDriver,
  type BuildArgsInput,
  type HeadlessProcessDriverDeps,
  type NormalizeContext,
  type NormalizedLine,
  type ProcessDriverState,
} from "../process-driver.js";
import { cursorLineToEvents } from "./normalize.js";

interface CursorStreamState {
  /** Zero-based contiguous text stream within a BrowserOps turn. */
  segment: number;
  sawAssistantText: boolean;
  sawTextInSegment: boolean;
}

function streamType(raw: unknown): string {
  return typeof raw === "object" &&
    raw !== null &&
    typeof (raw as Record<string, unknown>)["type"] === "string"
    ? ((raw as Record<string, unknown>)["type"] as string)
    : "";
}

export function buildCursorArgs(input: BuildArgsInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--workspace",
    input.cwd,
  ];
  if (!input.first && input.nativeSessionId) args.push("--resume", input.nativeSessionId);
  if (input.model) args.push("--model", input.model);
  if (!input.safeMode) args.push("--force");
  args.push(input.prompt);
  return args;
}

export class CursorDriver extends HeadlessProcessDriver {
  private readonly streams = new Map<string, CursorStreamState>();

  constructor(deps: HeadlessProcessDriverDeps = {}) {
    super("cursor", "agent", deps);
  }

  protected buildArgs(input: BuildArgsInput): string[] {
    return buildCursorArgs(input);
  }

  protected normalizeLine(raw: unknown, context: NormalizeContext): NormalizedLine {
    const type = streamType(raw);
    const stream = this.streams.get(context.turnId) ?? {
      segment: 0,
      sawAssistantText: false,
      sawTextInSegment: false,
    };

    // A Cursor tool call is a hard prose boundary. The following assistant
    // deltas are a new stream and must render as a new message bubble.
    if (type === "tool_call" && stream.sawTextInSegment) {
      stream.segment += 1;
      stream.sawTextInSegment = false;
    }

    const normal = cursorLineToEvents(raw, context.turnId, {
      streamSegment: stream.segment,
      // Cursor's `result` text is a full aggregate of partial output. Once
      // prose has streamed, publishing it again would duplicate prior bubbles.
      suppressResultText: type === "result" && stream.sawAssistantText,
    });
    if (
      type === "assistant" &&
      normal.events.some(
        (event) =>
          event.type === "message" &&
          event.message.role === "assistant" &&
          event.message.blocks.some(
            (block) => block.kind === "text" && block.text.trim().length > 0,
          ),
      )
    ) {
      stream.sawAssistantText = true;
      stream.sawTextInSegment = true;
    }
    if (type === "result" || type === "error") this.streams.delete(context.turnId);
    else this.streams.set(context.turnId, stream);
    return normal;
  }

  protected override async buildTurnPrompt(
    state: ProcessDriverState,
    text: string,
    first: boolean,
  ): Promise<string> {
    if (first || state.ref.nativeSessionId) return text;
    return this.replayPrompt(state, text);
  }
}
