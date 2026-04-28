import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  McpError,
  ErrorCode as McpErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { handleGet } from "./procedures/handlers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptListEntry {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

// ---------------------------------------------------------------------------
// Skill text loader
// ---------------------------------------------------------------------------

let cached: string | null = null;

function skillCandidates(): string[] {
  const userOverride = path.join(os.homedir(), ".browserops", "skill.md");
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    userOverride,
    // Published layout: dist/seed/skill.md  (this file is at dist/index.js after bundling)
    path.resolve(here, "seed", "skill.md"),
    // Dev layout: packages/bridge/src/ → repoRoot/skills/browserops.md
    path.resolve(here, "..", "..", "..", "..", "skills", "browserops.md"),
    // Dist dev layout: packages/bridge/dist/ → repoRoot/skills/browserops.md
    path.resolve(here, "..", "..", "..", "skills", "browserops.md"),
  ];
}

async function loadSkillText(): Promise<string> {
  if (cached !== null) return cached;
  for (const candidate of skillCandidates()) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      if (text.trim().length > 0) {
        cached = text;
        return cached;
      }
    } catch {
      // not found or unreadable — try next
    }
  }
  cached = "";
  return cached;
}

/** First ~80 lines of the skill, up to (but not including) the second ## heading. */
function shortPreamble(skillText: string): string {
  const sections = skillText.split(/\n## /);
  // sections[0] is everything before the first ## heading (or the whole text if no ## present)
  // Take that plus at most the first heading section, then truncate to 80 lines.
  const top = sections[0] ?? "";
  const lines = top.split("\n").slice(0, 80);
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Prompt catalogue
// ---------------------------------------------------------------------------

const PROMPTS: PromptListEntry[] = [
  {
    name: "browserops",
    description:
      "Run a browser task using the browserops operating guide and procedure-first orchestration.",
    arguments: [
      {
        name: "task",
        description: "What you want done in the browser.",
        required: true,
      },
    ],
  },
  {
    name: "browserops_procedure",
    description:
      "Run a saved browserops procedure by name. Inlines the procedure YAML so the agent has the exact step graph in context.",
    arguments: [
      {
        name: "name",
        description: "Procedure name (e.g. 'gmail.send_email').",
        required: true,
      },
      {
        name: "task",
        description: "Optional instance-specific task or input notes.",
        required: false,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// listPrompts
// ---------------------------------------------------------------------------

export function listPrompts(): { prompts: PromptListEntry[] } {
  return { prompts: PROMPTS };
}

// ---------------------------------------------------------------------------
// getPrompt
// ---------------------------------------------------------------------------

export async function getPrompt(
  name: string,
  args: Record<string, string> | undefined,
): Promise<{ description?: string; messages: PromptMessage[] }> {
  if (name === "browserops") {
    const skillText = await loadSkillText();
    if (!skillText) {
      throw new McpError(
        McpErrorCode.InternalError,
        "browserops skill content not bundled",
      );
    }

    const task = args?.["task"];
    if (!task || task.trim() === "") {
      throw new McpError(McpErrorCode.InvalidParams, "task argument required");
    }

    const text = skillText + "\n\n## Task\n" + task;

    return {
      description:
        "Run a browser task using the browserops operating guide and procedure-first orchestration.",
      messages: [
        {
          role: "user",
          content: { type: "text", text },
        },
      ],
    };
  }

  if (name === "browserops_procedure") {
    const procedureName = args?.["name"];
    if (!procedureName || procedureName.trim() === "") {
      throw new McpError(McpErrorCode.InvalidParams, "name argument required");
    }

    let yaml: string;
    try {
      const result = await handleGet({ name: procedureName });
      yaml = result.yaml;
    } catch (err) {
      throw new McpError(
        McpErrorCode.InvalidParams,
        `no procedure named ${procedureName} — discover with \`procedures_search\``,
      );
    }

    const skillText = await loadSkillText();
    const preamble = skillText
      ? "You are running a saved browserops procedure. Follow the step graph exactly, using the browser_* primitives.\n\n" +
        shortPreamble(skillText)
      : "You are running a saved browserops procedure. Follow the step graph exactly, using the browser_* primitives.";

    const task = args?.["task"];
    const taskSection = task ? `\n\n## Task\n${task}` : "";

    const text =
      preamble +
      `\n\n## Procedure: ${procedureName}\n\n` +
      "```yaml\n" +
      yaml +
      "\n```" +
      taskSection;

    return {
      description: `Run the saved browserops procedure: ${procedureName}.`,
      messages: [
        {
          role: "user",
          content: { type: "text", text },
        },
      ],
    };
  }

  throw new McpError(McpErrorCode.InvalidParams, `unknown prompt: ${name}`);
}
