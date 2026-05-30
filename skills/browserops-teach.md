---
name: browserops-teach
description: Author a browserops procedure for any browser flow autonomously — one user prompt in, single message out. Pre-flight checks for an existing trusted procedure first; only authors when nothing already covers the goal. Reads lore for app priors, probes the live page directly with browser_* tools, drafts the YAML in-context, verifies via procedures_execute against a goal-grounded predicate, then saves with bump_success on a clean run. Asks the user at most one question, only when a hard safety gate fires (cross-user side effects with no safe self-test path / money or account-level irreversibility / goal genuinely unparseable). TRIGGER when the user asks to "learn to do X", "teach browserops to <flow>", "remember how to <task>", "figure out and save <flow>", or anything that implies "do this once and reuse it later". DO NOT TRIGGER for one-shot tasks the user clearly won't repeat, or any flow where procedures_search already returns a trusted match for the goal — use that procedure instead.
---

# browserops-teach

One human message in, one message out. Everything in between is autonomous.

The goal is to produce a working, verified, **trusted** procedure in the
browserops procedures store with the minimum tool calls and tokens. No demo
recording. No iterative replay loop. No mid-flight check-ins with the user.
The agent's own context is the session.

---

## 1. Pre-flight (zero tool cost, before any browser_*)

These four checks happen entirely from your context. None of them spend a
tool call. Run them in order and short-circuit at the first one that resolves.

1. **Parse the goal.** Extract `{app, intent, named_entities, destructive_class}`
   from the user's prompt. e.g. *"DM Pratham on Slack"* → `{app: "slack",
   intent: "dm_person", named_entities: ["Pratham"], destructive_class: "send"}`.

2. **Read lore.** Load every lore file matching `browserops_*` (app
   priors, dummy registry, known failures). After ~3 successful runs against
   an app, this folds the rest of the work down to a few seconds of probing.

3. **Search for an existing procedure.** `procedures_search(goal_tokens)`. If
   any trusted match scores ≥0.5, **stop**. Tell the user the procedure name
   and the call signature; don't author a duplicate. Auto-teach is for new
   flows, not reruns of existing ones.

4. **Run the three hard gates.** If any fires, ask exactly one focused
   question synchronously, wait for the answer, then proceed silent. If
   none fires, proceed silent immediately.

### The three hard gates

You ask exactly one clarifier when one of these fires. Otherwise: silent.

1. **Cross-user side effects with no safe self-test path.** Real recipients,
   real visibility, no way to dry-run by sending to yourself. Examples:
   posting publicly, sending to a list, DM-ing strangers, inviting users.
2. **Money or account-level irreversibility.** Payments, transfers, deletions,
   plan changes, downgrades, anything that costs money or removes data.
3. **Goal genuinely unparseable AND no app context in tabs/lore.** Rare in
   practice — memory + `browser_list_tabs` inspection eliminates almost all
   cases. If it does fire, ask for the specific missing piece and nothing else.

For named-recipient messaging like "DM Pratham": **no gate fires**. Pratham
is named, the user already knows we'll send to him. Send. Don't ask.

---

## 2. Per-app safe-dummy registry

When the goal is ambiguous about who/what to test against, fall back to
**send-to-self** for any messaging surface. It's reversible, private, and
verifiable via the same API the post call uses.

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

Goal text wins over default. *"DM Pratham"* → Pratham. *"DM someone"* → self.
Memory can extend the registry per user (e.g. *"my Linear test project is
'Sandbox'"*).

---

## 3. The autonomous flow

```
1. Open or claim the app's tab. Prefer existing tabs — browser_list_tabs and
   match by domain. New tab only if nothing's open.

2. Probe page state with browser_execute_js. Pull auth tokens, sidebar items,
   any client config the app exposes (localConfig_v2 / cookies / page DOM).
   Cap probe at ~10 calls; if the API path isn't obvious by then, fall to UI.

3. Author the procedure YAML directly in your own context. Use lore priors
   plus probe data. Important schema rules — DON'T relearn these the hard way:
     - Use `{{input.NAME}}` for input refs. The bridge resolves it against
       the bare key in the inputs object at execute time.
     - Mark destructive inputs with `destructive: true`. Mark the procedure's
       side_effects list when relevant (send_message / payment / post_public
       / modify_account / delete).
     - Description is ≤200 chars. Trim it.
     - Keep the leaf as small as possible. Composites are for genuine
       orchestration, not for splitting one logical action.

4. Verify by procedures_execute against a goal-grounded predicate. The
   predicate is *what success looks like for this exact goal*. Examples:
     - "DM Pratham 'hi'" → call conversations.history(D-channel-id),
       assert latest message text == "hi" && from == self.
     - "Open #engineering" → assert location.pathname endsWith engineering's
       channel id.
     - "Star a Notion page" → fetch the page, assert starred:true.
   Use safe dummies during verification when destructive side effects exist
   (send to self, post in private project, etc.).

5. On pass: procedures_save(name, yaml, bump_success: true). The procedure
   is now status:trusted and discoverable via procedures_search.

6. On fail: edit the YAML, re-execute. Up to ~3 self-correction attempts.
   If still failing after 3, write a structured failure note to lore and
   tell the user what blocked you — do not ask them to demonstrate. (If they
   want to demonstrate, they will offer.)

7. Update lore with what you learned about the app — auth pattern, working
   selectors, working API endpoints, things that DIDN'T work. The next run
   for the same app rides on this.

8. Report once.
```

---

## 4. The final report

One message back to the user. No mid-flight pings. Tight format:

```
✓ Saved: <names>
  Tested: <how, briefly>
  Cost: <tool calls, time>
  Notes: <caveats / lore updates / next-time hints>
```

Anything that *would have been* a mid-flight question lands here as a footnote
with what you decided and why. That's the user's only opportunity to push
back, and they only get one shot — so the report has to be honest about every
non-obvious choice you made (the dummy you picked, the strategy you chose,
anything that surprised you).

---

## 5. Don'ts (these are the failure modes from past sessions)

- **Don't ask which mode to use.** Demo mode no longer exists.
- **Don't ask for a dummy when the goal already names the target.** "DM
  Pratham" means Pratham, not self.
- **Don't ask for a workspace URL.** `browser_list_tabs` finds the existing
  tab, or memory has the URL, or the app's home redirects on its own.
- **Don't burn replay runs on a draft you already know is broken.** If
  `procedures_execute` returns `completed: true` but the predicate fails,
  that's a silent bug — fix the YAML, don't claim success.
- **Don't trust `completed: true` alone.** The runtime auto-matches steps
  that have no `expected_effect`. Always verify against a goal predicate
  outside the procedure.
- **Don't author a procedure that hardcodes a person's name in selectors.**
  Lift it to an input. If you can't easily lift it (one example only),
  use the API path instead of the UI path so the input maps cleanly.
- **Don't start a run without checking lore first.** App priors compound;
  every successful run should make the next one cheaper.

---

## 6. What "minimum tool calls" actually means

For a flow against a known SaaS app with priors in lore:
- 1 `procedures_search` (pre-flight reuse check)
- 1-3 `browser_*` to confirm tab + auth state
- 1 `procedures_execute` to verify
- 1 `procedures_save` with `bump_success: true`
- 1 final report

That's <8 tool calls for the happy path. Anything more is friction the agent
should examine — usually a sign that priors are missing from memory, the
verification predicate isn't tight, or the YAML is doing too much.

For a brand-new app with no lore: budget ~20-30 calls (probe + author +
verify + save + lore write). After 2-3 successful runs against that app,
the budget collapses to the happy-path number above.

---

## 7. Observation-architecture authoring guidance

When the observation-architecture changes are live in the agent's tool
catalogue, prefer these patterns over their pre-observation equivalents:

- **Use `browser_observe` for verification waits.** A leaf whose intent is
  "wait until the modal is gone" should call `browser_observe(tab_id,
  mode: "diff", since: <token-from-pre-action-observe>)` — the response
  is a small added/removed/changed delta instead of a full re-read. Falls
  back to augmented a11y when the prior token is stale.
- **Set `expected:` predicates on action steps with a known success
  criterion.** A click that "should" open a dialog gains
  `expected: { new_dialog: true }`; a navigate that "should" change URL
  gains `expected: { url_matches: "<regex>" }`. The handler polls
  synchronously and returns `expectation_met: boolean`, so the procedure
  step can branch on the result without a separate read.
- **Drop `browser_read` from procedure leaves whose only purpose was to
  check post-action state.** The `effect` envelope already carries
  mutations / new dialogs / focus / visual hash delta / a11y delta —
  cheaper than re-reading the tree.
- **Prefer screenshot+SoM+xy-click only when ref-based dispatch can't
  address the target** (canvas/WebGL, badly-marked-up SPAs). The
  observation-cache token enforces tight coupling between the screenshot
  state and the click coordinates, so don't reuse a token past its 30s
  TTL.
