---
name: browserops-teach
description: Author a browserops procedure autonomously — one user prompt in, single message out. Drives the deterministic-first authoring loop (semantic locators picked by browser_propose_locator, retrying expect predicates, per-step LLM-fallback ladder). Pre-flight searches existing trusted procedures; only authors when nothing already covers the goal. Reads lore for app priors, probes the live page with browser_read + browser_propose_locator to derive tier-1 stable locators, drafts the YAML in-context, verifies via procedures_execute({strict: true}) against a goal-grounded predicate, then saves with bump_success on a clean run. Asks the user at most one question, only when a hard safety gate fires (cross-user side effects with no safe self-test path / money or account-level irreversibility / goal genuinely unparseable). TRIGGER when the user asks to "learn to do X", "teach browserops to <flow>", "remember how to <task>", "save a procedure for <flow>", "figure out and save <flow>", or anything that implies "do this once durably and reuse it later" AND the procedures feature is enabled. DO NOT TRIGGER for one-shot tasks the user clearly won't repeat, or any flow where procedures_search already returns a trusted match for the goal — use that procedure instead.
---

# browserops-teach

One human message in, one message out. Everything in between is autonomous.

The goal is to produce a working, verified, **trusted** procedure in the
browserops procedures store with the minimum tool calls and tokens. No demo
recording. No mid-flight check-ins with the user. The agent's own context
is the session.

Procedures are deterministic-first: each step targets an element via a
semantic Locator descriptor (re-resolved against the live a11y tree every
step), polls a retrying `expect:` predicate, and escalates through an
explicit per-step fallback ladder when reality doesn't match the spec.
The authoring discipline below produces YAML that takes advantage of all
three.

---

## 1. Pre-flight (zero tool cost, before any browser_*)

Four checks. Run in order; short-circuit at the first that resolves.

1. **Parse the goal.** Extract `{app, intent, named_entities, destructive_class}`
   from the user's prompt. e.g. *"save a procedure for sending Gmail email"* →
   `{app: "gmail", intent: "send_email", named_entities: [], destructive_class: "send"}`.

2. **Read lore.** Load every lore file matching `browserops_*` (app
   priors, dummy registry, known failures, locator patterns that worked
   before). After ~3 successful runs against an app, the priors collapse
   exploration to ~2 probes.

3. **Search existing artefacts.** Call `procedures_search(goal_tokens)`.
   If any trusted match scores ≥0.5:
   - **Trusted match:** stop. Tell the user the procedure name and the
     call signature; don't author a duplicate.
   - **Draft match:** offer to verify+promote rather than re-author. Author
     only if the user explicitly says to.

4. **Run the three hard gates.** If any fires, ask exactly one focused
   question, wait for the answer, then proceed silent. If none fires,
   proceed silent immediately.

### The three hard gates

1. **Cross-user side effects with no safe self-test path.** Real recipients,
   real visibility, no way to dry-run by sending to yourself. Posting
   publicly, DM-ing strangers, inviting users, calendar invites to others.
2. **Money or account-level irreversibility.** Payments, transfers,
   deletions, plan changes, downgrades, anything that costs money or
   removes data.
3. **Goal genuinely unparseable AND no app context in tabs/lore.** Rare
   in practice. If it fires, ask for the specific missing piece and
   nothing else.

For named-recipient flows like "save a procedure to DM Pratham on Slack":
no gate fires. Pratham is named, the user already knows we'll send to him.

---

## 2. Per-app safe-dummy registry (verification inputs)

When destructive inputs need a verification value, default to
**send-to-self** for messaging surfaces.

| App        | Safe dummy when goal is ambiguous                                         |
|------------|---------------------------------------------------------------------------|
| Slack      | DM yourself (own user_id from xoxc token in localConfig_v2)               |
| Gmail      | Email yourself                                                            |
| Discord    | Self-DM                                                                   |
| Telegram   | Saved Messages                                                            |
| Linear     | Test issue in your personal/test project (NEVER a team-wide project)      |
| Notion     | Page in private workspace                                                 |
| Twitter/X  | **Draft only.** Never publish autonomously.                               |
| GitHub     | Comment on a private repo / draft PR / draft issue                        |
| Calendar   | Event with only yourself as attendee                                      |

---

## 3. The autonomous flow

```
1. Open or claim the app's tab. Prefer existing tabs — browser_list_tabs and
   match by domain. New tab only if nothing's open.

2. Probe page state to derive locators. The point of probing is NOT to
   capture refs (which won't survive replay) but to learn the STABLE
   ATTRIBUTES each control exposes — the more author/contract-controlled
   the signal, the longer the locator survives.
     - Call browser_read({mode: "a11y_tree", augment: true}) once to
       populate the ref-cache with role + accessible-name + tier-1 attrs
       (aria-label, data-testid, href, form-control name).
     - For each control you'll touch, get its ref from the read, then
       call browser_propose_locator({tab_id, ref}). The proposer returns
       the SMALLEST, HIGHEST-TIER descriptor that resolves to exactly
       that element:
         { unique: true, locator: {...}, tier: 1|2|3, fragile: bool,
           warnings: [...], candidates: [...] }
     - Use the proposed locator verbatim in your step's `locator:` field.
       Don't second-guess — the proposer measured uniqueness against
       the live snapshot; you can't beat that by eyeballing.
     - If tier === 3 (fragile, fell through to nth) OR unique === false:
       the page lacks stable signals for this control. Either: (a) ask
       the user to inject a data-testid, (b) drop the locator and use
       `do: js` with a narrow document.evaluate call, or (c) declare
       fallback.strategy: relocate_then_llm so a future LLM patch can
       re-resolve at runtime.
   Cap probe at ~5 browser_* calls (one read + one propose per control).
   If propose returns tier-3 for every control, the UI may not be
   stably addressable — note it in the final report and ship a
   relocate_then_llm-heavy YAML so the runtime can recover.

   Stability tiers (what the proposer prefers, in order):
     Tier 1: aria_label, data_testid, href, attr{name,value}, role, in_frame
       → author/contract-controlled, survives rebuilds
     Tier 2: name, has_text, has_text_not, near
       → text/layout-derived, churns when copy or DOM order changes
     Tier 3: nth
       → fragile; only emitted as last resort, ALWAYS flagged in warnings

3. Author the procedure YAML directly in your context. Use lore priors
   plus the locator table from step 2. Schema rules to follow:

     - schema_version: 1, name dotted (e.g. gmail.send_email), kind: leaf
       or composite. Composites need uses: [...].
     - Every input that feeds a destructive surface gets destructive: true.
     - side_effects[] declared if any (send_message / payment / post_public
       / modify_account / delete).
     - forbidden{locators, actions} block declared for every observable
       footgun on the page (Delete, Discard, plan-change buttons). The
       runtime enforces this on every dispatch, including LLM-proposed
       resume patches.
     - verify{} block at top level — what success looks like in absolute
       terms. text_visible: "Sent" / url_matches: "/inbox/" /
       network_endpoint: "/sendmessage" all qualify.

   Per-step rules:

     - DO NOT add manual prime/observe steps before locator steps. The
       executor auto-calls browser_read before every browser_locate, so
       the ref-cache is fresh even after SPA hash transitions (Gmail's
       #inbox → #inbox?compose=new, etc.). A manual prime step is
       redundant and just slows the run down.
     - Every action step with a positive success criterion gets an
       expect: { ... } block. expect is REQUIRED on any step whose
       fallback.strategy is "llm" — without it the runtime can't tell
       when to ask for help.
     - fallback.strategy: relocate_then_llm for steps whose label might
       drift (Compose button, Send button — Google A/B-tests these).
       fallback.strategy: llm for steps the user explicitly cares about
       getting right. fallback.strategy: strict for steps that genuinely
       MUST land exactly (payment confirmations).
     - When a step recurses into another saved procedure, use
       `do: procedure_call` with `with: { name: "<sub.procedure>",
       inputs: {...}, tab_id: "{{tab_id}}" }`. tab_id MUST be threaded
       through with.inputs — procedures_execute ignores a top-level
       tab_id on a procedure_call step.

4. Verify with procedures_execute({strict: true}). strict is mandatory
   during authoring — it refuses every LLM fallback, so a clean run means
   the locators + expect predicates are good without help. Use the safe
   dummies from step 2 for destructive inputs.

5. Build a goal-grounded predicate OUTSIDE the procedure to confirm
   success. The runtime's verify{} block is the spec; the agent's external
   predicate is the ground truth. Examples:
     - "send Gmail" → call Gmail API messages.list, assert message with
       same subject+body appeared in Sent in last 30s.
     - "DM Pratham" → call Slack conversations.history(D-channel-id),
       assert latest message text matches body && from == self.
     - "Star a Notion page" → fetch the page, assert starred:true.
   If completed: true but the external predicate fails, the procedure is
   still broken — fix the verify block, fix the locators, do not save.

6. On clean strict run + external predicate pass:
   procedures_save({ name, yaml, overwrite: true, bump_success: true })
   → procedure flips to status:trusted and becomes discoverable via
   procedures_search by default.

   If the save response carries `demoted: true` plus `demote_reason`, the
   runtime refused the trusted flip because drift health from prior runs
   already degraded past threshold (relocate-rate > 0.4 across ≥5 runs,
   target_changed > 0 across ≥3 runs, or tier-3 + relocate-rate > 0.1).
   In that case: re-author the failing step's locator (use
   browser_propose_locator on a fresh snapshot — descriptors that
   worked last week may not be unique anymore), re-verify, then bump.
   Do NOT report success — surface the demote_reason in the final report.

7. On fail: edit the YAML, re-execute. Up to ~3 self-correction attempts.
   If still failing after 3, write a structured failure note to lore
   and tell the user what blocked you. Do not ask them to demonstrate;
   if they want to, they will offer.

8. Update lore with what you learned about the app — role/name pairs
   that worked, tier-1 attrs that disambiguated, the working network
   endpoint, things that didn't work. The next procedure for the same
   app rides on this.

9. Report once.
```

---

## 4. The final report

One message back to the user. Tight format:

```
✓ Saved procedure: <name> (status: trusted)
  Locators verified for: <list of step ids>
  Tested with: <safe dummy summary>
  Cost: <tool calls, wall time>
  Notes: <caveats / lore updates / next-time hints>
```

Anything that *would have been* a mid-flight question lands here as a
footnote with what you decided and why — the agent's only opportunity to
get user pushback before the procedure ships.

---

## 5. Don'ts (the failure modes that bite)

- **Don't hand-write a locator when browser_propose_locator would have
  proposed a better one.** The proposer reads the live snapshot and
  picks the smallest tier-1 descriptor that resolves uniquely. Your
  eyeballed `{role: "button", name: "Send"}` is probably tier 2 — let
  the proposer find the `aria_label` or `data_testid` that's tier 1.
- **Don't author a tier-3 (nth) locator without flagging it.** If
  browser_propose_locator returns `fragile: true`, either: refactor
  the step (add `near:`, `has_text:`, or a `forbidden:` exclusion of
  neighbouring elements), inject a data-testid, or set
  `fallback.strategy: relocate_then_llm` so the runtime can recover.
- **Don't add a manual `do: observe` step right before a locator step.**
  The executor auto-primes via browser_read internally; a manual prime
  is redundant.
- **Don't bake `ref: <number>` into a step.** Refs don't survive replay.
  Express the target via `locator:` and let the runtime resolve fresh.
- **Don't author an unanchored name for a unique button when an anchored
  regex would do.** `name: "send"` matches "Send", "Schedule send",
  "Resend invite". Use `name: "/^send$/i"` plus
  `has_text_not: "/schedule|resend/i"` and you're done.
- **Don't declare fallback.strategy: llm without an expect: block.** The
  runtime needs a positive predicate to know when to escalate. Without
  one, llm fires on every step that returns at all, including no-op
  toggles.
- **Don't omit the forbidden block when the page has destructive
  controls nearby.** A misfired LLM patch on Gmail can click "Delete
  message" instead of "Send". One regex (`{name: "/^delete/i"}`) in
  forbidden.locators stops it before dispatch.
- **Don't promote with bump_success: true after a hybrid run.** Trusted
  status implies the deterministic version works without LLM help. Save
  as draft if any step's strategy escalated, fix the locator instead,
  re-verify in strict mode, then bump.
- **Don't ask which mode to use.** Demo mode does not exist. There is
  one runtime: deterministic-first with optional LLM fallback.
- **Don't trust `completed: true` alone.** Always verify against a goal
  predicate outside the procedure — a missing or weak `expect:` makes
  the executor too generous.
- **Don't start a run without checking lore first.** App priors
  compound; every successful run should make the next one cheaper.
- **Don't hardcode a person's name in selectors.** Lift it to an input.
  If you can't easily lift it (one example only), use the API path
  instead of the UI path so the input maps cleanly.

---

## 6. What "minimum tool calls" actually means

For a flow against a known SaaS app with priors in lore:

- 1 `procedures_search` (pre-flight reuse check)
- 1 `browser_read({mode: "a11y_tree", augment: true})` to seed the snapshot
- N `browser_propose_locator` (one per control you'll touch)
- 1 `procedures_save` (draft)
- 1 `procedures_execute({strict: true})` to verify
- 1 external-API predicate call
- 1 `procedures_save({overwrite: true, bump_success: true})` to promote
- 1 final report

For a 5-step flow that's <14 tool calls on a known app. More than 25
is the signal that priors are missing, the proposer kept returning
fragile descriptors (the UI lacks stable signals), or the verify
predicate isn't tight.

For a brand-new app with no lore: budget ~25-35 calls (explore +
author + verify + save + lore write). After 2-3 successful runs against
that app, the budget collapses to the happy-path number above.

---

## 7. Composition + recursion

A `do: procedure_call` step runs another saved procedure in-process
(no extension round-trip). Compose two ways:

- **Same author, multi-flow:** save the leaves first, then a composite
  with `kind: composite`, `uses: [<leaf names>]`, and one
  `do: procedure_call` step per sub-call. The composite gets its own
  trusted-status independently of its leaves.
- **Recursive call into a known procedure:** if `procedures_search`
  returns a trusted match for a sub-step's intent, use it via
  `do: procedure_call` rather than re-implementing the steps inline.

Caveat: pass `tab_id: "{{tab_id}}"` inside `with.inputs` of the
procedure_call step — procedures_execute ignores a top-level tab_id on
the recursive call.

---

## 8. Observation-architecture authoring guidance

- **Drop `browser_read` from leaves whose only purpose was to check
  post-action state.** The `expect:` block already gates on observation
  (dom_added_min, network_endpoint, new_dialog, text_visible) — adding a
  raw read on top of it just doubles the cost.
- **Don't store screenshot tokens in the procedure.** Tokens expire after
  30s. If a step genuinely needs visual context (canvas apps), use
  `do: observe` with the token bound to the next step's `with.coord_space`
  and verify the run finishes inside the token TTL.
- **Prefer the proposer's tier-1 output** (aria_label / data_testid /
  href / attr) for selectors. Hand-written `{role, name}` is tier 2 at
  best — it works until the framework restyles or the copy changes.
