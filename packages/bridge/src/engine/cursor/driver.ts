import {
  HeadlessProcessDriver,
  type BuildArgsInput,
  type HeadlessProcessDriverDeps,
  type NormalizedLine,
  type ProcessDriverState,
} from "../process-driver.js";
import { cursorLineToEvents } from "./normalize.js";

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
  if (!input.safeMode) args.push("--force");
  args.push(input.prompt);
  return args;
}

export class CursorDriver extends HeadlessProcessDriver {
  constructor(deps: HeadlessProcessDriverDeps = {}) {
    super("cursor", "agent", deps);
  }

  protected buildArgs(input: BuildArgsInput): string[] {
    return buildCursorArgs(input);
  }

  protected normalizeLine(raw: unknown): NormalizedLine {
    return cursorLineToEvents(raw);
  }

  protected override async buildTurnPrompt(
    state: ProcessDriverState,
    text: string,
    first: boolean,
  ): Promise<string> {
    if (first) return text;
    return this.replayPrompt(state, text);
  }
}
