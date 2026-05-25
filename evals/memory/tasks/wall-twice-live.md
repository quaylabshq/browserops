# Task: wall-twice-live

Full-stack manual checklist: verify that an agent hits a cookie/modal wall in
session 1 (and the scribe captures a blocker record), then in session 2 receives
a `site_context` primer and navigates past the wall without getting stuck.

This is a Tier-2 agentic task. It requires a real browser, a real MCP server,
and a live site with a known modal or cookie wall. No harness runner covers it;
execute manually and record pass/fail for each step.

---

## Goal

Demonstrate the "stop hitting the same wall twice" headline behavior end-to-end
on a real, publicly reachable site.

---

## Recommended test site

`https://bbc.co.uk` — shows a GDPR cookie consent dialog on first visit from a
fresh Chrome profile (no cookies). The dialog blocks all main-content interaction
until dismissed.

Alternative sites with similar patterns: `https://theguardian.com`,
`https://spiegel.de`, `https://lemonde.fr`. Pick whichever currently shows a
modal on fresh load.

---

## Prerequisites

- browserops bridge running (`npx browserops start` or `pnpm dev` in
  `packages/bridge`).
- Chrome profile with no cookies for the test origin (use Incognito or a fresh
  profile directory).
- `memory` feature enabled: `browserops feature enable memory`.
- `ANTHROPIC_API_KEY` set (the scribe uses a model call).
- A fresh `BROWSEROPS_MEMORY_DIR` (or use the default `~/browserops/memory/`
  after confirming it has no pre-existing record for the test origin).

---

## Session 1 — Hit the wall, capture the blocker

### Steps

1. Open a new tab to the test site URL.
2. Ask the agent: `"Click the main headline link on <site>"`.
3. Observe the agent's tool calls:
   - It should attempt a click and hit an error (`ELEMENT_NOT_INTERACTABLE` or
     equivalent) or observe a dialog in the a11y tree.
   - `detectRoadblock` (capture-signals) should fire, surfacing a `capture_hint`
     on the response.
4. The main agent should spawn the scribe subagent (or the capture hook fires
   automatically if the bridge has capture-on-hint enabled).
5. The scribe should call `memory_search` (finding nothing), then `memory_save`
   with a `blocker` record.

### Session 1 checklist

- [ ] **S1.1** The agent attempted the task and encountered the modal/dialog
      (evidenced by an `error_code` or an a11y tree showing `role:dialog`).
- [ ] **S1.2** A `capture_hint` appeared on at least one tool response, OR the
      main agent explicitly spawned the scribe.
- [ ] **S1.3** The scribe called `memory_search` before `memory_save` (no
      duplicate write without searching first).
- [ ] **S1.4** `memory_save` returned `{ created: true }`.
- [ ] **S1.5** Inspect the saved record (`memory_get` or read the YAML file):
      `scope: site`, `kind: blocker`, `origin` matches the test site,
      `detail.wall` and `detail.door` both present.
- [ ] **S1.6** No PII in the saved record (no usernames, email addresses, or
      page content).

---

## Session 2 — Primer delivered, wall bypassed

### Steps

1. Start a new session (new `session_id`; reuse the same Chrome tab or open a
   fresh one to the same origin).
2. Ask the agent the same task: `"Click the main headline link on <site>"`.
3. Before any `browser_click`, the delivery layer should call
   `SiteContextManager.shouldPrime` for this (session, origin) pair and return
   a primer.
4. The agent receives the primer in the `site_context` field of the first
   tool response (or in the `initialize` MCP instructions if the bridge
   prepends it).
5. The agent reads the primer, sees the `blocker` record hint, and proactively
   dismisses the modal before attempting the CTA click.

### Session 2 checklist

- [ ] **S2.1** The agent received a `site_context` primer for the test origin
      on the first tool call of the session (check the tool response or MCP
      `initialize` payload).
- [ ] **S2.2** The primer contains at least the blocker record captured in
      session 1 (check `primer.records[*].name`).
- [ ] **S2.3** The agent dismissed the modal/cookie wall BEFORE attempting the
      main CTA click (check tool call order in the transcript).
- [ ] **S2.4** The agent completed the headline-click task without hitting the
      `ELEMENT_NOT_INTERACTABLE` error.
- [ ] **S2.5** `memory_save` was NOT called in session 2 (the existing record
      was sufficient; no duplicate capture).
- [ ] **S2.6** The delivery state for (session 2, test origin) is `PRIMED` after
      the first tool call and `SUPPRESSED` on subsequent calls (no re-delivery).

---

## Pass rubric

**Full pass:** all 12 checklist items (S1.1–S1.6, S2.1–S2.6) are checked.

**Acceptable pass:** S1.4–S1.6 and S2.1–S2.4 all pass (core behavior correct).
Checklist items S1.1–S1.3 and S2.5–S2.6 are observability checks; failure there
is worth noting but does not invalidate the end-to-end result.

**Fail:** S1.4 or S2.1 or S2.3 fails — the record was not saved, the primer was
not delivered, or the agent hit the wall again despite the primer.

---

## Scoring

- **0** — core pass criteria (S1.4, S2.1, S2.3) not all met
- **1** — core pass criteria met; some observability checks failed
- **2** — all 12 checklist items checked (full pass)

Record the site used, the time, and which checklist items passed. Attach the
saved record YAML (from `memory_get`) as the candidate artifact for the judge.
