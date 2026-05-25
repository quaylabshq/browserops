# Task: retrieval-relevance

Verify that `memory_search` surfaces the intended record at the top of results
when queried with natural-language tokens derived from the original capture.

---

## Goal

Confirm that a set of N=8 seeded records, spanning multiple scopes, kinds, and
origins, is correctly ranked by the search+confidence engine so that the
_intended_ record is always top-1 for targeted queries and appears in the top-3
for broader queries.

---

## Setup

1. Create an isolated temp store (`BROWSEROPS_MEMORY_DIR` → fresh temp dir).
2. Save the following 8 records via the real `save` module (direct store write,
   not via MCP) so the test is independent of the MCP layer:

   | # | name | scope | kind | origin | title |
   |---|---|---|---|---|---|
   | 1 | `notion.cookie-banner` | site | blocker | `https://notion.so` | "Notion cookie consent modal blocks all clicks until dismissed" |
   | 2 | `slack.emoji-picker-focus` | site | gotcha | `https://app.slack.com` | "Slack emoji picker closes when the search field receives focus" |
   | 3 | `gmail.compose-shortcut` | site | affordance | `https://mail.google.com` | "Gmail compose window opens with keyboard shortcut 'c'" |
   | 4 | `global.spa-history-swap` | global | lesson | _(none)_ | "SPAs swap history before route components mount — wait for route stability" |
   | 5 | `trello.drag-drop-dnd` | site | gotcha | `https://trello.com` | "Trello drag-and-drop uses react-dnd; synthetic mouse events are ignored" |
   | 6 | `notion.sidebar-collapse` | site | affordance | `https://notion.so` | "Notion sidebar collapses when viewport width drops below 768px" |
   | 7 | `github.file-edit-codemirror` | site | gotcha | `https://github.com` | "GitHub file editor uses CodeMirror — browser_type requires CDP trusted input" |
   | 8 | `global.cdp-banner` | global | lesson | _(none)_ | "CDP 'controlled by automated software' banner is expected, not a failure signal" |

3. All records should have:
   - `schema_version: 1`
   - `severity: "high"` for blockers, `"med"` for gotchas/affordances, `"low"` for lessons
   - `stats.hits` between 1 and 10, `stats.captures: 1`
   - `meta.source: "scribe"`
   - Appropriate `detail` fields for their `kind`

---

## Action

Issue the following `memory_search` queries (in order). For each, record the
ranked list of returned names:

| Query ID | Query string | `scope` filter | `origin` filter | Expected top-1 |
|---|---|---|---|---|
| Q1 | `"cookie banner modal dismiss notion"` | `"site"` | `"https://notion.so"` | `notion.cookie-banner` |
| Q2 | `"emoji picker closes on focus slack"` | `"site"` | `"https://app.slack.com"` | `slack.emoji-picker-focus` |
| Q3 | `"compose keyboard shortcut gmail"` | — | — | `gmail.compose-shortcut` |
| Q4 | `"SPA history route before mount"` | `"global"` | — | `global.spa-history-swap` |
| Q5 | `"drag drop mouse events trello"` | — | — | `trello.drag-drop-dnd` |
| Q6 | `"CodeMirror editor input CDP github"` | — | — | `github.file-edit-codemirror` |
| Q7 | `"modal blocks clicks"` | — | — | `notion.cookie-banner` (top-3 acceptable) |
| Q8 | `"cdp banner automated software"` | `"global"` | — | `global.cdp-banner` |

---

## Pass rubric

| # | Criterion | Check |
|---|---|---|
| R1 | Q1–Q6: expected record is the top-ranked result (rank 1) | Top-1 precision for targeted queries |
| R2 | Q7: expected record appears in the top-3 results | Top-3 recall for broad queries |
| R3 | Q8: expected record is top-1 | Global scope filter works correctly |
| R4 | For Q1 and Q6 (origin-filtered), no records from other origins appear in the results | Scope/origin filtering is enforced |
| R5 | All returned `score` values are in `[0, 1]` and the list is sorted descending by score | Ranking invariant |
| R6 | `memory_search` with `scope: "global"` returns no site-scoped records | Scope isolation |

**Passes** when R1, R2, R3, R5, R6 hold (R4 is a bonus check; failure there
indicates a filter bug worth noting but does not fail the task alone).

---

## Scoring

- **0** — fewer than 4 of R1–R6 pass
- **1** — 4–5 of R1–R6 pass
- **2** — all 6 pass (full pass)

Candidate artifact for the judge: a JSON file with keys `Q1`–`Q8`, each
containing the ordered array of `name` strings returned by the search, e.g.:

```json
{
  "Q1": ["notion.cookie-banner", "notion.sidebar-collapse"],
  "Q2": ["slack.emoji-picker-focus"],
  ...
}
```
