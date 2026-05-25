/**
 * evals/memory/judge.ts
 *
 * CLI: tsx judge.ts <task-md> <candidate-file>
 *
 * Reads the "Pass rubric" section from a Tier-2 task spec and a candidate
 * artifact (saved record JSON/YAML, search-result dump, or store dump).
 *
 * - If ANTHROPIC_API_KEY is set: POST to the Anthropic Messages API (model
 *   claude-sonnet-4-6) asking it to score the candidate against the rubric;
 *   print the verdict + reasons.
 * - If no key: print the rubric as a manual checklist and exit 0.
 *
 * Rules:
 *   - No external dependencies (uses global `fetch`, available in Node 18+).
 *   - No writes to disk (side-effect-free).
 *   - Never throws when the key is absent.
 */

import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(): void {
  process.stderr.write(
    "Usage: tsx judge.ts <task-md> <candidate-file>\n" +
    "\n" +
    "  <task-md>        path to a Tier-2 task spec (evals/memory/tasks/*.md)\n" +
    "  <candidate-file> path to the candidate artifact (JSON/YAML/MD) to judge\n" +
    "                   Pass /dev/null or an empty file to get the manual checklist\n",
  );
}

/** Extract the content of the first H2 section whose heading matches `title`. */
function extractSection(md: string, title: string): string | null {
  const pattern = new RegExp(
    `^##\\s+${title}\\s*$`,
    "im",
  );
  const match = pattern.exec(md);
  if (!match) return null;
  const start = match.index + match[0].length;
  // Find the next H2 (or end of file)
  const nextH2 = /^##\s+/im.exec(md.slice(start));
  const end = nextH2 ? start + nextH2.index : md.length;
  return md.slice(start, end).trim();
}

/** Format the pass rubric as a human-readable checklist. */
function formatChecklist(rubricSection: string): string {
  const lines: string[] = [
    "Manual checklist — no ANTHROPIC_API_KEY set",
    "─".repeat(60),
    "",
  ];

  // Extract table rows: lines that start with "|" and contain "|"
  const tableRows = rubricSection
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.match(/^\|[-\s|]+$/));

  let inTable = false;
  for (const row of tableRows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length >= 3) {
      const [num, criterion, check] = cells;
      if (num === "#" || num === undefined) continue; // header row
      inTable = true;
      lines.push(`  [ ] ${num}: ${criterion}`);
      if (check) lines.push(`       → ${check}`);
    }
  }

  if (!inTable) {
    // No table found — dump the section verbatim
    lines.push(rubricSection);
  }

  lines.push("");
  lines.push("Score each item above and tally:");
  lines.push("  0 = most criteria fail");
  lines.push("  1 = partial pass");
  lines.push("  2 = all criteria pass");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM judge
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  content: Array<{ type: "text"; text: string }>;
  model: string;
  max_tokens: number;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

async function callAnthropic(
  apiKey: string,
  rubric: string,
  candidateContent: string,
): Promise<string> {
  const body: AnthropicMessage = {
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    content: [
      {
        type: "text",
        text:
          "You are a strict eval judge. Below is a pass rubric and a candidate artifact.\n" +
          "Score the candidate against EACH rubric criterion (pass/fail + one-line reason).\n" +
          "End with a final verdict: PASS (score 2), PARTIAL (score 1), or FAIL (score 0).\n" +
          "Be concise — one line per criterion, then the verdict line.\n\n" +
          "--- PASS RUBRIC ---\n" +
          rubric +
          "\n\n--- CANDIDATE ARTIFACT ---\n" +
          (candidateContent.length > 4000
            ? candidateContent.slice(0, 4000) + "\n[truncated to 4000 chars]"
            : candidateContent),
      },
    ],
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const json = (await resp.json()) as AnthropicResponse;

  if (!resp.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${resp.status}`;
    throw new Error(`Anthropic API error: ${msg}`);
  }

  const textBlock = json.content?.find((b) => b.type === "text");
  return textBlock?.text ?? "(no text in response)";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , taskMd, candidateFile] = process.argv;

  if (!taskMd || !candidateFile) {
    usage();
    process.exit(1);
  }

  // Read task spec
  let taskText: string;
  try {
    taskText = await fs.readFile(taskMd, "utf8");
  } catch (e) {
    process.stderr.write(`Cannot read task file: ${taskMd}\n  ${String(e)}\n`);
    process.exit(1);
  }

  // Extract the Pass rubric section
  const rubric = extractSection(taskText, "Pass rubric");
  if (!rubric) {
    process.stderr.write(
      `No "## Pass rubric" section found in ${taskMd}\n`,
    );
    process.exit(1);
  }

  // Read candidate artifact (may be /dev/null or empty)
  let candidateContent = "";
  try {
    candidateContent = await fs.readFile(candidateFile, "utf8");
  } catch {
    // /dev/null on some platforms or missing file — treat as empty artifact
    candidateContent = "(empty — no candidate artifact provided)";
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];

  if (!apiKey) {
    // No key — print manual checklist and exit 0
    process.stdout.write(formatChecklist(rubric) + "\n");
    return;
  }

  // LLM judge path
  process.stdout.write(`Judging: ${taskMd}\n`);
  process.stdout.write(`Candidate: ${candidateFile}\n`);
  process.stdout.write("─".repeat(60) + "\n");

  try {
    const verdict = await callAnthropic(apiKey, rubric, candidateContent);
    process.stdout.write(verdict + "\n");
  } catch (e) {
    process.stderr.write(`Judge error: ${String(e)}\n`);
    process.stdout.write("\nFalling back to manual checklist:\n\n");
    process.stdout.write(formatChecklist(rubric) + "\n");
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`Unexpected error: ${String(e)}\n`);
  process.exit(1);
});
