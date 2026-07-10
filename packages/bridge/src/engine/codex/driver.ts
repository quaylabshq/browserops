import {
  HeadlessProcessDriver,
  type BuildArgsInput,
  type HeadlessProcessDriverDeps,
  type NormalizeContext,
  type NormalizedLine,
  type ProcessDriverState,
} from "../process-driver.js";
import { codexLineToEvents } from "./normalize.js";

export interface CodexDriverDeps extends HeadlessProcessDriverDeps {
  /** Reserved for legacy builds; current arguments are intentionally capability-safe. */
  legacyFullAuto?: boolean;
}

export function buildCodexArgs(input: BuildArgsInput & { legacyFullAuto?: boolean }): string[] {
  const args = ["exec"];
  const resuming = !input.first && input.nativeSessionId !== undefined;
  if (resuming) args.push("resume", input.nativeSessionId!);
  // Current Codex resume accepts a smaller flag surface than initial exec:
  // no sandbox, working-directory, or old ask-for-approval flags.
  if (input.model) args.push("--model", input.model);
  if (input.reasoningEffort) {
    args.push("-c", 'model_reasoning_effort="' + input.reasoningEffort + '"');
  }
  args.push("--json", "--skip-git-repo-check");
  if (!resuming) {
    args.push("--sandbox", "workspace-write", "-C", input.cwd);
  }
  args.push("--", input.prompt);
  return args;
}

export class CodexDriver extends HeadlessProcessDriver {
  private readonly legacyFullAuto: boolean;

  constructor(deps: CodexDriverDeps = {}) {
    super("codex", "codex", deps);
    this.legacyFullAuto = deps.legacyFullAuto ?? false;
  }

  protected buildArgs(input: BuildArgsInput): string[] {
    return buildCodexArgs({ ...input, legacyFullAuto: this.legacyFullAuto });
  }

  protected normalizeLine(raw: unknown, _context: NormalizeContext): NormalizedLine {
    return codexLineToEvents(raw);
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
