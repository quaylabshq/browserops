import {
  HeadlessProcessDriver,
  type BuildArgsInput,
  type HeadlessProcessDriverDeps,
  type NormalizedLine,
  type ProcessDriverState,
} from "../process-driver.js";
import { codexLineToEvents } from "./normalize.js";

export interface CodexDriverDeps extends HeadlessProcessDriverDeps {
  /** Test/compat seam for older Codex builds that only support --full-auto. */
  legacyFullAuto?: boolean;
}

export function buildCodexArgs(input: BuildArgsInput & { legacyFullAuto?: boolean }): string[] {
  const args = ["exec"];
  if (!input.first && input.nativeSessionId) args.push("resume", input.nativeSessionId);
  args.push("--json", "--skip-git-repo-check", "--sandbox", "workspace-write");
  if (!input.safeMode) {
    if (input.legacyFullAuto) args.push("--full-auto");
    else args.push("--ask-for-approval", "never");
  }
  args.push("-C", input.cwd, "--", input.prompt);
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

  protected normalizeLine(raw: unknown): NormalizedLine {
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
