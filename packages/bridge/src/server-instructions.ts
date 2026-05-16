/**
 * MCP `initialize.result.instructions` builder.
 *
 * The text returned here is what every MCP-compatible client (Claude Code,
 * Cursor, Zed, Continue, Windsurf, custom SDK agents, …) sees on connection.
 * Goal: nudge the agent toward anchoring on the user's pinned tab and
 * consulting available lore primitives before re-planning a flow.
 *
 * The instructions adapt to the currently enabled feature set:
 *  - procedures off → the "Procedure runtime" section is replaced with a
 *    one-line opt-in hint, and procedure-specific phrasing in the
 *    orchestration / tool-invocation blocks is stripped.
 *  - lore on        → a short paragraph about lore_save / _search / _get /
 *    _delete is appended.
 *
 * That keeps disabled-feature documentation out of the prompt — agents don't
 * burn tokens on tools they can't call, and don't get steered toward
 * FEATURE_DISABLED responses.
 */
import type { FeatureName } from "@browserops/shared";

type Lines = readonly string[];

function header(enabledFeatures: ReadonlySet<FeatureName>): Lines {
  const skillCallTargets = enabledFeatures.has("procedures")
    ? "browser_* or procedures_*"
    : "browser_*";
  return [
    "browserops controls a real Chrome profile via a companion extension.",
    "",
    "Full operating guide: if your host supports Claude skills, invoke the",
    `\`browserops\` skill before your first ${skillCallTargets} call. It`,
    "covers the observation-centric execution model (page_effect), per-tool",
    "cookbook, failure-mode → fix-it map, sub-agent delegation rules, and",
    "procedure authoring discipline. The summary below is the minimum; the",
    "skill is the canonical reference.",
  ];
}

const autonomousByDefault: Lines = [
  "AUTONOMOUS BY DEFAULT — the #1 rule. Do NOT ask the user to disambiguate",
  "a short ask. Interpret it charitably, state the interpretation in ≤1",
  "line, and attempt. The observation runtime (page_effect) catches wrong",
  "interpretations within one call — that loop is faster than a clarifying",
  "round-trip. A three-part clarifying-question dump like \"did you mean",
  "amazon.in or amazon.com/in? what is 'delivery info task'? did you mean",
  "mouse click or keyboard?\" is the specific failure mode this rule bans.",
  "Ask at most ONE short question, and only when the task literally cannot",
  "be attempted without a specific value (credentials, amount, recipient),",
  "OR is irreversible and the target is genuinely ambiguous. Everything",
  "else: interpret, attempt, verify, report.",
];

function toolInvocation(enabledFeatures: ReadonlySet<FeatureName>): Lines {
  const examples = enabledFeatures.has("procedures")
    ? '  procedures_search needs {"query": "..."}, browser_navigate needs\n' +
      '  {"tab_id": "...", "url": "..."}'
    : '  browser_navigate needs {"tab_id": "...", "url": "..."}, browser_quick_read\n' +
      '  needs {"tab_id": "...", "query": "..."}';
  return [
    "Tool invocation:",
    "- Every tool takes a JSON arguments object per its inputSchema (e.g.",
    examples + "). If your host exposes a generic",
    "  MCP wrapper that does not forward arguments, the call will error",
    "  with INVALID_PARAMS — use the host's native per-tool invocation path",
    "  instead.",
  ];
}

function orchestration(enabledFeatures: ReadonlySet<FeatureName>): Lines {
  const briefBullets: string[] = [
    "- Each brief must be minimal: the primitive sequence for THAT subtask",
    "  only. Never batch two subtasks into one brief, and never let a sub-",
    "  agent's intermediate output (page dumps, screenshots) leak back into",
    "  the main context. Example:",
    '  "Open https://news.ycombinator.com on a fresh tab and return the top headline."',
  ];
  if (enabledFeatures.has("procedures")) {
    briefBullets.push(
      "- When delegating an existing procedure, the brief is procedure name +",
      "  inputs + tab_id. Never inline the procedure's steps — the delegate",
      "  calls `procedures_get` itself. Example:",
      '  "Run gmail.send_email on tab t_3 with to=x subject=y body=z. Report success."',
    );
  }
  return [
    "Orchestration (plan-if-complex → decompose → list → delegate in parallel):",
    "- Classify each piece of the request as easy (known site, low-stakes,",
    "  known procedure) or tricky (canvas/SPA gotcha, unfamiliar tool,",
    "  branching, high-stakes, ambiguous goal, recovering from a failure).",
    "- For tricky pieces, the FIRST list item is a planner spawn, e.g.",
    '  "0. Spawn planner sub-agent (sonnet) — produce plan covering goal,',
    "  tab strategy, tools to use, tools to AVOID and why, expected",
    '  page_effect signatures, failure recovery. ≤15 lines."',
    "- Externalize the planning so the main context only ever sees the",
    "  finished plan, not the deliberation. This is the #1 reason the full",
    "  discipline collapses on complex tasks — task state crowds out the",
    "  rules in working memory.",
    "- PARALLELIZE: if a request has both easy and tricky pieces, fire them",
    "  in one turn (multiple Agent calls per message). Planner sub-agent on",
    "  the tricky site runs concurrently with the easy execution sub-agent.",
    "  Parallelism rule: sub-agents may run in parallel iff they operate on",
    "  different tabs. Same-tab subtasks must serialize (they race).",
    "- Before calling any tool, decompose the user's request into a flat list",
    "  of concrete subtasks and record it with your host's task-tracking",
    "  primitive. The list is the source of truth — it's how the main agent",
    "  avoids losing the overall goal as intermediate output piles up.",
    "- IMPORTANT: each non-trivial list item must be phrased as a spawn-sub-",
    '  agent instruction, not a task description. Write "Spawn sub-agent —',
    '  search for Kartik in Slack, return tab_id", NOT "Search for Kartik".',
    "  Agents that see the word 'spawn' in the list actually delegate; agents",
    "  that see a plain task description frequently forget and run inline,",
    "  especially for the 2nd/3rd/Nth subtask.",
    "- Run each subtask in its own sub-agent (if the host supports it) so the",
    "  main context stays an orchestrator: no page dumps, no screenshots, no",
    "  intermediate tool results accumulating. Hosts without sub-agent support",
    "  can run inline, but should still maintain the subtask list.",
    "- Recursive decomposition is allowed: if a sub-agent receives a brief",
    "  that is itself compound, it writes its own spawn-sub-agent list and",
    "  delegates further. Only the final ≤5-line summary rolls back up.",
    "- Trivial single primitives (one browser_navigate, one browser_read, a",
    "  one-shot factual query) can run directly. Anything compound, branching,",
    "  or likely to need retries (REF_STALE, occluded clicks, wait_for loops)",
    "  goes through one-sub-agent-per-subtask.",
    ...briefBullets,
    "- After each sub-agent returns (≤5 lines: what it did, pass/fail gate,",
    "  result summary), update the list and dispatch the next subtask.",
  ];
}

const tabSelection: Lines = [
  "Tab selection (stay autonomous — recover without asking the user):",
  "- Call browser_current_tab to operate on whatever the user is looking at;",
  "  if no usable tab is returned, call browser_new_tab and proceed.",
  "- For cross-tab work, call browser_list_tabs and pick explicitly.",
];

const dispatch: Lines = [
  "Dispatch model (CDP-trusted, universal):",
  "- Every http(s) tab gets persistent chrome.debugger attached on navigation.",
  "  browser_click / click_at / click_by_text / type / press / hover all",
  "  dispatch through CDP Input.* — trusted compositor events that traverse",
  "  iframes, shadow DOM, and isTrusted-gated handlers. The \"Chrome is being",
  "  controlled by automated test software\" banner appears as a result — that",
  "  is expected and not a sign of failure.",
];

const clicking: Lines = [
  "Clicking (escalation ladder — stop when page_effect shows intended effect):",
  "  1. browser_click with a ref (cheapest, most addressable).",
  "  2. browser_click with dismiss_overlay:true if (1) returns occluded, or",
  "     returns clicked:true with zero page_effect.",
  "  3. browser_click_by_text with the visible label — for div-with-onclick",
  "     targets that never surface as a ref.",
  "  4. browser_click_at with viewport coordinates — last resort, genuinely",
  "     useful on complex SPAs (Instagram, TikTok, some retail checkouts)",
  "     where the clickable surface is a gesture handler on a parent div",
  "     or canvas.",
  "- Coordinate clicks are trusted (CDP) but still unaddressable: clicked:true",
  "  only means a mouse event fired at that point — it could have landed on a",
  "  sibling overlay or dead space. ALWAYS verify page_effect immediately",
  "  after browser_click_at. Zero effect = retry with adjusted coords or fall",
  "  back to click_by_text.",
];

const risky: Lines = [
  "Risky actions (browser_execute_js, click/type on sensitive domains) prompt the",
  "user in the extension popup by default. They can be auto-approved via --yolo",
  "on the bridge CLI or the popup auto-approve toggle (session-scoped).",
];

function proceduresSection(enabledFeatures: ReadonlySet<FeatureName>): Lines {
  if (!enabledFeatures.has("procedures")) {
    return [
      "Procedure runtime is opt-in via `browserops feature enable procedures`",
      "(then `browserops restart`). With the feature off, the agent has only",
      "the always-on browser_* tools — plan flows from scratch each time.",
    ];
  }
  return [
    "Procedure runtime:",
    "- Procedures are named, parameterized, reusable action graphs living in",
    "  `~/browserops/procedures/`. Before planning any browser task, call",
    "  `procedures_search(<tokens from user's request>)` once. If the top match",
    "  has score >= 0.5, load it with `procedures_get` and run its steps. If",
    "  multiple matches are relevant (common for composite tasks like",
    '  "email posthog users" — both posthog and gmail procedures), load all of',
    "  them; they are meant to compose.",
    "- `list`/`search` return metadata only; `get` returns the YAML body. Do",
    "  not dump the full catalogue — scope via `domain` or `scope` when you",
    "  can narrow.",
    "- A composite procedure declares `uses: [...]`. After a `get`, fetch each",
    "  name in `uses:` (parallel `get` calls) — that loads the full pack for",
    "  execution.",
    "- If no match clears threshold, plan from scratch, then offer",
    "  `procedures_save` at the end.",
    "- You interpret and execute procedures yourself by calling the",
    "  `browser_*` primitives in their `steps:` — the bridge does not run",
    "  procedures.",
    "- Never take a screenshot to verify a step that declares `wait_for`.",
    "  Only screenshot on error or unexpected state.",
  ];
}

function loreSection(enabledFeatures: ReadonlySet<FeatureName>): Lines {
  if (!enabledFeatures.has("lore")) return [];
  return [
    "Cross-agent lore:",
    "- `lore_save` / `lore_search` / `lore_get` / `lore_delete` persist",
    "  named markdown notes at `~/browserops/lore/`, visible to every MCP",
    "  client (Claude Code, Cursor, Zed, custom SDK). Use them when a lesson",
    "  about a flow, selector, or project would help any agent picking up the",
    "  same browserops bridge later — not for host-private prefs (response",
    "  style, keybindings) which belong in the host's own lore store.",
    "- Search before saving: a near-duplicate name should be `replace:true`",
    "  rather than a new entry. Names match `^[a-z][a-z0-9._-]{0,79}$`.",
  ];
}

/**
 * Build the MCP server instructions for the given feature set.
 *
 * The blocks above each return `readonly string[]`; this function joins them
 * with blank lines between sections and a final newline-joined string.
 */
export function buildServerInstructions(
  enabledFeatures: ReadonlySet<FeatureName>,
): string {
  const blocks: Lines[] = [
    header(enabledFeatures),
    autonomousByDefault,
    toolInvocation(enabledFeatures),
    orchestration(enabledFeatures),
    tabSelection,
    dispatch,
    clicking,
    risky,
    proceduresSection(enabledFeatures),
    loreSection(enabledFeatures),
  ].filter((b) => b.length > 0);

  return blocks.map((b) => b.join("\n")).join("\n\n");
}
