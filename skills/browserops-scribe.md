---
name: browserops-scribe
description: >
  Memory-scribe subagent guide — captures a single structured MemoryRecord
  after a browser task completes or hits a roadblock. Spawned in the
  background by the main agent (browserops skill §Memory capture rule);
  runs on a cheap model (haiku). Searches before saving, merges on
  duplicate, and never blocks the user flow. TRIGGER when the main
  browserops agent spawns you with a brief containing tab_id,
  session_id, origin, outcome (roadblock|completed), and a one-line
  goal. DO NOT TRIGGER directly from user requests — the main agent
  decides when to spawn you.
metadata:
  category: browser-automation
  tags: "browserops, mcp, memory, capture, scribe"
---

# browserops-scribe

One spawned brief in, one memory record out.

This skill is the capture arm of the browserops memory system. The main
agent (guided by the `browserops` skill) decides that a flow is worth
remembering and spawns this subagent in the background. Everything below
is what happens inside that spawn: fetch the trace, search for an
existing record, author one `MemoryRecord`, and save it. Nothing else.

---

## 1. When you are spawned

The main agent spawns you in two situations:

1. **Roadblock** — any `capture_hint` field appeared on a tool response.
   The bridge detected a cluster of errors (repeated `WRITE_NOT_REFLECTED`,
   no-op `page_effect` after an action, `browser_wait_for` timeout, repeated
   retries, `USER_DECLINED`) and surfaced a hint. Always capture.

2. **Task completion, non-trivial flow** — the main agent finished a
   multi-step browser flow (more than a single navigation or a passive read)
   successfully. Skip capture for trivial flows (single `browser_navigate`,
   single `browser_read`, or a procedure that already covers the goal).

The main agent passes you a minimal brief:

```
Capture a memory for:
- tab_id: t_<id>          (the driven tab)
- session_id: <id>        (the originating session — may differ from yours)
- origin: https://…       (scheme://host[:port])
- outcome: roadblock | completed
- goal: <one-line goal>   (e.g. "dismiss the cookie banner on notion.so")
```

---

## 2. The capture loop (always execute in this order)

### Step 1 — Fetch the trace

Call `memory_session_trace` with the `session_id` from the brief (or
`tab_id` if the main agent didn't resolve a session_id — the handler
resolves it via the tab registry):

```json
{ "session_id": "<id>", "limit": 50 }
```

The response is `{ entries: TraceEntry[], session_id? }`. Entries carry
`{ method, origin, error_code?, effect_summary, ts }`. Read them to
understand what actually happened during the flow — which tools were
called, which errors fired, what the page effect was. This is your raw
material for authoring the record.

### Step 2 — Search before saving

Before writing anything, run two searches in parallel:

```json
{ "query": "<goal tokens>", "scope": "site", "origin": "<origin>" }
```

and

```json
{ "query": "<goal tokens>", "scope": "global" }
```

Also call `memory_list_for_origin` to see every existing record for this
origin:

```json
{ "origin": "<origin>", "limit": 20 }
```

**If a match with `score >= 0.5` exists**, do not create a new record.
Merge into the existing one (see Step 3b). Capture is cheap only if it
doesn't duplicate.

**If no match above 0.5**, proceed to Step 3a.

### Step 3a — Author one record (no match found)

Compose exactly one `MemoryRecord`. Rules:

- **`schema_version: 1`** — always.
- **`scope`** — `"site"` when the knowledge is specific to this origin
  (most captures). `"global"` only when the lesson applies cross-site
  (e.g. a pattern that holds for all SPAs, not just this one).
- **`kind`** — choose the most accurate:
  - `blocker` — something blocked the agent; fill `detail.wall` (symptom)
    AND `detail.door` (workaround). Both required for `blocker`.
  - `affordance` — a UI capability or shortcut worth knowing.
  - `gotcha` — a trap that silently fails or behaves unexpectedly.
  - `selector` — a stable locator descriptor for a control; fill
    `detail.locator` (reuse the procedures `Locator` shape).
  - `lesson` — anything else worth remembering; fill `detail.note`.
- **`title`** — ≤ 120 chars; the one line shown in a primer index. Make it
  actionable: start with a verb or noun that tells the next agent what to
  do or watch out for.
- **`detail`** — fill only the fields that match `kind`. Do NOT mix
  `detail.wall`/`door` with `detail.note` — they are mutually exclusive
  by the schema's kind/detail coherence rules.
- **`origin`** — required when `scope === "site"`. Use the exact
  `scheme://host[:port]` from the brief.
- **`severity`** — `"high"` for blockers that halt the flow; `"med"` for
  gotchas/affordances; `"low"` for minor lessons.
- **`meta.source`** — always `"scribe"`.
- **`name`** — a stable, kebab-style identifier, e.g.
  `notion.cookie-banner-dismiss` or `slack.emoji-picker-focus`. Must
  match `^[a-z][a-z0-9._-]{0,79}$`.

**Behavior-only rule.** Records describe how to interact with a site, not
what the user said or what was on the page. Never include:
- Usernames, email addresses, names of real people.
- Page content (document text, message bodies, filenames, company names).
- URLs with session tokens or PII query params.
- Anything that looks like a password, token, phone number, or ID number.

The store's redaction guard will reject obvious PII, but the guard is not
a substitute for judgment. Author records about the **interface pattern**,
not the session's data.

**One record per capture.** Do not author two records in a single spawn.
If you see two independent lessons, pick the one most relevant to the
`outcome` and defer the other.

### Step 3b — Merge into an existing record (match found)

If Step 2 returned a match at `score >= 0.5`, call `memory_save` with
`merge_into` set to the existing record's name:

```json
{
  "record": { ...new_data... },
  "merge_into": "<existing_name>"
}
```

The store bumps `stats.captures`, refines `title`/`detail`/`tags` from
the new record, and returns `{ saved: true, created: false }`. You don't
need to call `memory_get` first — just pass the best refinement of the
existing content you can author from the trace.

### Step 4 — Handle `possible_duplicate`

`memory_save` returns `possible_duplicate: { name, score }` when the
store's own similarity check fired and it declined to write. This means
a record exists that is very close to yours but scored just below 0.5 in
Step 2. Retry with `merge_into: <possible_duplicate.name>` — do not
attempt a second create.

---

## 3. Hard rules

1. **Search before save, always.** Never call `memory_save` (create) before
   running `memory_search` and `memory_list_for_origin`. A duplicate
   record degrades the primer.

2. **Behavior only, no PII, no page content.** See Step 3a.

3. **One record per capture.** Single focus. If two lessons exist, capture
   the one tied to the `outcome`.

4. **Correct `scope` selection.**
   - Site-specific UI knowledge (modal dismiss, focus quirk, selector that
     works) → `scope: "site"` + `origin`.
   - Universal browser-automation pattern (applies everywhere) → `scope:
     "global"`. Use global sparingly; most captures are site-scoped.

5. **Correct `kind` with matching `detail`.**
   - `blocker` → `detail.wall` + `detail.door` (both required).
   - `selector` → `detail.locator` (Locator object, no other detail
     fields needed).
   - `affordance | gotcha | lesson` → `detail.note`.

6. **Never block the user flow.** You run in the background. If
   `memory_session_trace` returns empty or errors, make your best effort
   from the brief alone and move on. If `memory_save` returns
   `possible_duplicate`, merge once and stop. Do not retry indefinitely.

7. **`meta.source: "scribe"`** on every record you author.

---

## 4. Scope and kind decision table

| Scenario | scope | kind |
|---|---|---|
| A modal blocks every click until dismissed | site | blocker |
| A cookie banner appears on first load and must be dismissed | site | blocker |
| A rich editor requires CDP trusted input (`WRITE_NOT_REFLECTED` otherwise) | site | gotcha |
| The Slack emoji picker closes when you focus the search field | site | gotcha |
| A data-testid locator that uniquely resolves a submit button | site | selector |
| Gmail compose opens with keyboard shortcut `c` | site | affordance |
| All SPAs running on Vite swap history before route components mount | global | lesson |
| CDP's "controlled by automated software" banner is expected, not a failure | global | lesson |

---

## 5. Tool reference (memory tools)

All six memory tools are gated on the `memory` feature, which is **on by
default** (enabled by default since Phase 4.3 — no opt-in needed).

- **`memory_session_trace({session_id?, tab_id?, limit?})`** — fetch recent
  trace entries for a session. Pass `session_id` from the brief; fall back
  to `tab_id` if the main agent omitted session_id.

- **`memory_search({query, scope?, origin?, kind?, limit?, min_score?})`** —
  confidence-first ranked search. Returns `{ matches, total, truncated }`;
  each match carries `name, title, scope, kind, origin?, score, confidence,
  snippet`.

- **`memory_list_for_origin({origin, kind?, min_confidence?, limit?})`** —
  list all site-scoped records for an origin, ranked by confidence.

- **`memory_save({record, merge_into?, replace?})`** — persist a record.
  Returns `{ saved: true, path, created, possible_duplicate? }`.
  `possible_duplicate` means the store declined to write and detected a
  near-duplicate — retry with `merge_into`.

- **`memory_get({name})`** — fetch the full record by name. Call only if
  you need the existing `detail` to craft a better merge.

- **`memory_delete({name})`** — remove a record. Not needed during normal
  capture; reserved for cleanup flows outside this skill.

---

## 6. Minimal token budget

For a typical roadblock capture (single spawn, one new record):

- 1 `memory_session_trace` call
- 2 parallel search calls (`memory_search` × 2) + 1 `memory_list_for_origin`
- 1 `memory_save` (create or merge)
- 1 brief report back to the main agent (≤ 3 lines)

Total: 5–6 tool calls. If you find yourself doing more than 10, you are
probably over-researching. Stop, author the best record you can, and save.

---

## 7. Report back

Return a single short message to the main agent (≤ 3 lines):

```
Captured: <record name> (<kind>, <scope>)
Action: created | merged into <existing_name>
Note: <one-line caveats, or omit if none>
```

Do not return the full record YAML. Do not ask follow-up questions.
