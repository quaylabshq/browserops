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
  // `codex exec` is non-interactive. Without an explicit approval policy,
  // Codex cancels MCP calls because there is no TUI available to answer its
  // confirmation. BrowserOps has its own risky-action gate, so outside safe
  // mode we let Codex invoke its BrowserOps MCP server and preserve the bridge
  // as the final authority for browser-side sensitive actions.
  if (!input.safeMode) {
    args.push(
      "-c",
      'approval_policy="never"',
      "-c",
      'mcp_servers.browserops.default_tools_approval_mode="auto"',
    );
  }
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
    return codexLineToEvents(raw, _context.turnId);
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
