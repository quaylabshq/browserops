---
name: browserops-playbook
description: Author a browserops playbook autonomously — one user prompt in, single message out. Drives the deterministic-first authoring loop for playbooks (semantic locators, retrying expect predicates, per-step LLM-fallback ladder). Pre-flight searches existing trusted playbooks AND procedures; only authors when nothing already covers the goal. Reads memory for app priors, probes the live page with browser_observe / browser_read to derive role+name locators, drafts the YAML in-context, verifies via playbooks_execute({strict: true}) against a goal-grounded predicate, then saves with bump_success on a clean run. Asks the user at most one question, only when a hard safety gate fires (cross-user side effects with no safe self-test path / money or account-level irreversibility / goal genuinely unparseable). TRIGGER when the user asks to "save a playbook for <flow>", "teach playbooks to <flow>", "learn <task> as a playbook", "convert <procedure> to a playbook", "remember how to <task> as a playbook", or anything that implies "do this once durably and reuse it later" AND the playbooks feature is enabled. DO NOT TRIGGER when only the procedures feature is on (use browserops-teach), for one-shot tasks the user clearly won't repeat, or when playbooks_search already returns a trusted match for the goal — use that playbook instead.
---

# browserops-playbook

One human message in, one message out. Everything in between is autonomous.

The goal is to produce a working, verified, **trusted** playbook in the
browserops playbooks store with the minimum tool calls and tokens. No demo
recording. No mid-flight check-ins with the user. The agent's own context
is the session.

Playbooks differ from procedures: semantic locators replace baked refs,
`expect:` predicates poll until match, and each step carries an explicit
fallback strategy. The authoring discipline below produces YAML that
takes advantage of all three.

---

## 1. Pre-flight (zero tool cost, before any browser_*)

Four checks. Run in order; short-circuit at the first that resolves.

1. **Parse the goal.** Extract `{app, intent, named_entities, destructive_class}`
   from the user's prompt. e.g. *"save a playbook for sending Gmail email"* →
   `{app: "gmail", intent: "send_email", named_entities: [], destructive_class: "send"}`.

2. **Read memory.** Load every memory file matching `browserops_*` (app
   priors, dummy registry, known failures, locator patterns that worked
   before). After ~3 successful playbook runs against an app, the priors
   collapse exploration to ~2 probes.

3. **Search existing artefacts.** Call `playbooks_search(goal_tokens)`
   AND `procedures_search(goal_tokens)` (if procedures is enabled). If any
   trusted match scores ≥0.5:
   - **Trusted playbook match:** stop. Tell the user the playbook name and
     the call signature; don't author a duplicate.
   - **Trusted procedure match:** offer to convert. The conversion path is
     short — read the procedure YAML, restructure each `action + bind`
     chain into a `do + locator` step, replace `expected_effect` with the
     equivalent `expect:` predicate, then save. Don't re-explore the UI.
   - **Draft playbook match:** offer to verify+promote rather than re-
     author. Author only if the user explicitly says to.

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
3. **Goal genuinely unparseable AND no app context in tabs/memory.** Rare
   in practice. If it fires, ask for the specific missing piece and
   nothing else.

For named-recipient flows like "save a playbook to DM Pratham on Slack":
no gate fires. Pratham is named, the user already knows we'll send to him.

---

## 2. Per-app safe-dummy registry (verification inputs)

Same registry as `browserops-teach`. When destructive inputs need a
verification value, default to **send-to-self** for messaging surfaces.

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
   capture refs (which won't survive replay) but to learn what role + name
   pairs the app exposes for each control you'll need.
     - Call browser_observe({mode: "text"}) once to get the augmented a11y
       tree. Look at the role + accessible-name of every control you'll
       touch.
     - For each control, decide the locator shape:
         simple, unique label    → { role: "<role>", name: "<exact>" }
         label varies slightly   → { role: "<role>", name: "/<substring>/i" }
         several similar buttons → add has_text_not / nth to disambiguate
         anchored exact          → name: "/^<word>$/i"
     - Capture: { open_compose, fill_to, fill_subject, fill_body, send }
       and any per-step locator.
   Cap probe at ~5 browser_* calls. If you're past that without clear
   locators, the UI may not be addressable — fall back to a procedure
   (use browserops-teach instead) and tell the user.

3. Author the playbook YAML directly in your context. Use memory priors
   plus the locator table from step 2. Schema rules to follow:

     - schema_version: 1, name dotted (e.g. gmail.send_email).
     - Every input that feeds a destructive surface gets destructive: true.
     - side_effects[] declared if any (send_message / payment / post_public
       / modify_account / delete).
     - forbidden{locators, actions} block declared for every observable
       footgun on the page (Delete, Discard, plan-change buttons).
     - verify{} block at top level — what success looks like in absolute
       terms. text_visible: "Sent" / url_matches: "/inbox/" /
       network_endpoint: "/sendmessage" all qualify.

   Per-step rules:

     - Before every step that uses locator, insert a one-line
       { id: "prime_*", do: "observe", with: { tab_id: "{{tab_id}}", mode: "text" } }
       step. This is a v1 rough edge — the runtime doesn't auto-seed the
       ref-cache before browser_locate, so each locator step needs a fresh
       observation. (When the auto-prime lands, this guidance goes away.)
     - Every action step with a positive success criterion gets an
       expect: { ... } block. expect is REQUIRED on any step whose
       fallback.strategy is "llm" — without it the runtime can't tell
       when to ask for help.
     - fallback.strategy: relocate_then_llm for steps whose label might
       drift (Compose button, Send button — Google A/B-tests these).
       fallback.strategy: llm for steps the user explicitly cares about
       getting right. fallback.strategy: strict for steps that genuinely
       MUST land exactly (payment confirmations).

4. Verify with playbooks_execute({strict: true}). strict is mandatory
   during authoring — it refuses every LLM fallback, so a clean run means
   the locators + expect predicates are good without help. Use the safe
   dummies from step 2 for destructive inputs.

5. Build a goal-grounded predicate OUTSIDE the playbook to confirm
   success. The runtime's verify{} block is the spec; the agent's external
   predicate is the ground truth. Examples:
     - "send Gmail" → call Gmail API messages.list, assert message with
       same subject+body appeared in Sent in last 30s.
     - "DM Pratham" → call Slack conversations.history(D-channel-id),
       assert latest message text matches body && from == self.
     - "Star a Notion page" → fetch the page, assert starred:true.
   If completed: true but the external predicate fails, the playbook is
   still broken — fix the verify block, fix the locators, do not save.

6. On clean strict run + external predicate pass:
   playbooks_save({ name, yaml, overwrite: true, bump_success: true })
   → playbook flips to status:trusted and becomes discoverable via
   playbooks_search by default.

7. On fail: edit the YAML, re-execute. Up to ~3 self-correction attempts.
   If still failing after 3, write a structured failure note to memory
   and tell the user what blocked you. Do not ask them to demonstrate;
   if they want to, they will offer.

8. Update memory with what you learned about the app — role/name pairs
   that worked, regex anchors that disambiguated, the working network
   endpoint, things that didn't work. The next playbook for the same
   app rides on this.

9. Report once.
```

---

## 4. The final report

One message back to the user. Tight format:

```
✓ Saved playbook: <name> (status: trusted)
  Locators verified for: <list of step ids>
  Tested with: <safe dummy summary>
  Cost: <tool calls, wall time>
  Notes: <caveats / memory updates / next-time hints>
```

Anything that *would have been* a mid-flight question lands here as a
footnote with what you decided and why — the agent's only opportunity to
get user pushback before the playbook ships.

---

## 5. Don'ts (failure modes specific to playbooks)

- **Don't author a locator step without a preceding observe step.** The
  ref-cache empties on a new tab and isn't auto-seeded by browser_locate
  in v1. Without an observe right before, the locator handler returns
  LOCATOR_NOT_FOUND on a perfectly valid descriptor.
- **Don't bake `ref: <number>` into a playbook step.** Refs are a
  procedures concept and don't survive replay. Playbook steps express
  their target via `locator:` and let the runtime resolve fresh.
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
- **Don't author a playbook when a procedure already exists at score
  ≥0.5.** Offer to convert. Most of the work is mechanical; you'll spend
  more time exploring the UI than you would lifting the existing flow.

---

## 6. What "minimum tool calls" actually means

For a flow against a known SaaS app with priors in memory:

- 1 `playbooks_search` + 1 `procedures_search` (pre-flight reuse check)
- 1-3 `browser_observe` to confirm role/name pairs for each control
- 1 `playbooks_save` (draft)
- 1 `playbooks_execute({strict: true})` to verify
- 1 external-API predicate call
- 1 `playbooks_save({overwrite: true, bump_success: true})` to promote
- 1 final report

That's <12 tool calls for the happy path on a known app. More than 20
is the signal that priors are missing from memory, the locator
descriptors are too loose, or the verify predicate isn't tight.

For a brand-new app with no memory: budget ~25-35 calls (explore +
author + verify + save + memory write). After 2-3 successful runs against
that app, the budget collapses to the happy-path number above.

---

## 7. Differences from `browserops-teach`

| Dimension | browserops-teach (procedures) | browserops-playbook (this skill) |
|---|---|---|
| Output artefact | procedure YAML | playbook YAML |
| Step shape | `{action, with, bind, expected_effect}` | `{do, locator, with, expect, fallback}` |
| How targets are addressed | refs from `browser_quick_read`, bound via `bind:` | semantic locator (`role`, `name`, `has_text`) |
| Drift resilience | low — refs stale on UI changes | high — locator re-resolves every step |
| Verification step | `procedures_execute` (one-shot expected_effect) | `playbooks_execute({strict: true})` (polling expect + verify block) |
| Promotion rule | clean run with `bump_success: true` | clean **strict-mode** run with `bump_success: true`; refused if any step used LLM fallback |
| LLM fallback inside artefact | no (`on_fail:` is advisory) | yes (per-step `fallback.strategy`) |
| Safety bar | per-procedure `risky: true` flag | per-playbook `forbidden{locators, actions}` block enforced on every dispatch including LLM patches |

When to pick which:

- **Use playbooks** for any flow you expect to use ≥3 times AND where the
  target UI is stable enough that semantic locators (role + name) are
  reliable.
- **Use procedures** for one-off automation, or for a flow whose only
  reliable interaction is `browser_execute_js` against a non-addressable
  UI.
- **When in doubt, playbooks.** The locator-based approach handles minor
  UI drift; the LLM fallback handles major drift; the forbidden block
  caps the blast radius.

---

## 8. Observation-architecture authoring guidance

- **Use `browser_observe({mode: "text"})` for locator probing.** That's
  the cheapest representation of the current a11y tree; it gives you
  role + name for every addressable control without burning a full
  `browser_read`.
- **Don't store screenshot tokens in the playbook.** Tokens expire after
  30s. If a step genuinely needs visual context (canvas apps), use
  `do: observe` with the token bound to the next step's `with.coord_space`
  and verify the run finishes inside the token TTL.
- **Drop `browser_read` from leaves whose only purpose was to check
  post-action state.** The `expect:` block already gates on observation
  (dom_added_min, network_endpoint, new_dialog, text_visible) — adding a
  raw read on top of it just doubles the cost.
