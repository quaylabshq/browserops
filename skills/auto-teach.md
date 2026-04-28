---
name: auto-teach
description: >
  Bootstrap a browserops procedure from a single user demonstration (or one
  cold-start exploration), then iteratively replay-and-optimize until the
  metrics stop improving. Auto-teach drives the procedures_autoteach_*
  tool family; the ultimate output is a trusted procedure saved into the
  procedures store. TRIGGER when the user asks to "learn to do X",
  "auto-teach <flow>", "figure out how to <task>", "optimize this
  procedure", or anything that says "do this once and remember it for
  next time". DO NOT TRIGGER for: one-shot tasks the user clearly won't
  repeat, or any flow where there's already a trusted procedure that
  procedures_search returns at score >= 0.5 (use that procedure
  instead — auto-teach is for new flows, not reruns of existing ones).
metadata:
  category: browser-automation
  tags: "browserops, autoteach, procedures, optimization-loop"
---

# auto-teach

One skill, one goal: turn a user demonstration into a trusted, optimized procedure with the minimum tool-call cost achievable. Read top-to-bottom the first time the user asks you to learn a flow; after that, jump to the section that matches what the loop just told you.

The bridge owns the heavy machinery — the distiller, convergence detector, variance gate, picker. **You** drive the agent loop: ask consent, capture the demo (or explore), call distill, replay, record, repeat. Don't reinvent any of those — the bridge is the source of truth for "did this run improve?" and "what should I try next?".

---

## 1. Pre-flight check — does the user actually need auto-teach?

Before opening a session, run `procedures_search` with tokens from the user's request. If the top trusted match scores >= 0.5, **stop**: that procedure already exists, and auto-teach would just re-derive it. Tell the user the existing procedure name and ask if they want to run it instead. Auto-teach is for flows that have no procedure yet OR for explicit optimization of one the user is dissatisfied with.

If `procedures_search` is not in your tool catalogue, the procedures feature is off. Ask the user to enable it: `browserops feature enable procedures` (and `teach` if they want demo mode, `autoteach` to expose this skill's tools at all).

---

## 2. The consent script — ask all four, in one message

When you've decided auto-teach applies, ask these four questions in a single user-facing turn (not four turns). Wait for one bundled answer before the first tool call:

1. **Goal**: state your understanding of what they want to learn back to them in one line. Confirm or correct.
2. **Mode**: demo (you show me once) or explore (I figure it out)? Default demo unless the user asks otherwise.
3. **Side-effect policy**: I'll scan for destructive steps (sends / payments / posts / deletes). If I find any, I'll need dummy values during training. Three options:
   - `use_dummies` — replay normally with dummy inputs you provide
   - `pause_at_destructive` — skip the destructive leaf during training; run it once at finalize
   - `read_only_only` — refuse the session if anything is destructive
4. **Run budget**: convergence-detected (default — stop when 2 noop runs in a row) or fixed N?

If the user's goal description contains obvious destructive verbs (send, pay, post, delete, transfer, message), pre-emptively ask for a dummy in question 3 ("dummy recipient email?"). Don't ask later — having to interrupt mid-loop for a dummy value is the failure mode this rule prevents.

When the user answers, summarise back in ≤2 lines and call `procedures_autoteach_start` with the captured `goal`, `mode`, and `consent`. Save the returned `session_id`.

---

## 3. Run 0 — capture the starting trace

### Demo mode (default)

`procedures_autoteach_start({mode: "demo", ...})` returns a `teach_session_id`. The bridge has already started a teach-mode recording. Tell the user:

> "Recording. Go ahead — show me the flow once. When you're done, just tell me and I'll stop the recording."

Stay silent while they work. Don't poll, don't narrate, don't ask "are you done yet?" — let them finish. When the user signals they're done, call `procedures_teach_stop` (no `session_id` needed). Then call `procedures_autoteach_distill({session_id})` — the distiller reads the teach session via the recorded events and writes draft v1.

### Explore mode

`procedures_autoteach_start({mode: "explore", ...})` returns no `teach_session_id`. You drive run 0 yourself:

1. Pick / open the right tab (`browser_current_tab` or `browser_new_tab`).
2. Call `procedures_autoteach_attach({session_id, tab_id, run_index: 0})` — every browser_* call on this tab now lands in the session's trace.
3. Drive the flow with `browser_*` calls until you reach the goal state.
4. Call `procedures_autoteach_record_trace({session_id, run_index: 0})`.
5. Call `procedures_autoteach_distill({session_id})`.

Distill returns the draft YAML, leaf summaries, and `validation_errors`. If `validation_errors` is non-empty, surface them to the user in ≤3 lines and ask whether to continue or refine the demo.

---

## 4. The optimization loop

Each iteration:

```
status = procedures_autoteach_status({session_id})
if status.convergence.verdict == "converged":
    break  # go to step 5 — finalize
if status.convergence.verdict == "stalled":
    surface status.convergence.reasons to the user
    ask: "metrics aren't improving — finalize as-is, or abort?"
    break

opt = status.next_optimization
if opt is undefined:
    # Picker has nothing further to suggest; one more replay should converge.
    apply_no_change()
else:
    apply_optimization_to_local_draft(opt)
    # The bridge has not modified the YAML — the picker emits intent.
    # Apply the change yourself before replaying:
    #   cache_selector       → swap the step's text/selector to the new tier
    #   swap_to_execute_js   → rewrite the step as browser_execute_js with
    #                          the equivalent selector logic
    #   tighten_wait         → reduce the wait_for timeout to the new value
    #   split_leaf           → split the leaf at at_step_id, write a new
    #                          composite that uses both halves

run_index = (last run_index in history) + 1
procedures_autoteach_attach({session_id, tab_id, run_index})
replay_steps_with_dummy_inputs()    # always use dummies for destructive inputs
metrics = collect(tool_count, wall_clock_ms, retries, errors, succeeded)
procedures_autoteach_record_run({session_id, run_index, metrics, optimization_tried: opt})
procedures_autoteach_record_trace({session_id, run_index})
procedures_autoteach_distill({session_id})    # re-distill from the latest run
```

**Sub-agent rule.** Each replay should run as a sonnet sub-agent with a minimal brief: session_id, current best YAML (from `status.best_procedure_yaml`), dummy inputs, tab_id. The sub-agent reports tool_count + wall_clock + retries + errors. Main agent only ever sees the run summary — no page dumps, no screenshots, no intermediate `browser_read` output.

**Replay must use dummy inputs for every destructive input.** If `consent.side_effect_policy == "use_dummies"` and the procedure has `inputs[<name>].destructive: true` set, swap in the dummy from `consent.dummies` for that input on every replay. The `inputs.<name>.destructive` flag is the load-bearing signal — if it's true and there's no dummy, refuse to replay and surface the gap to the user.

**Don't apply more than one optimization per run.** A regression must be bisectable to one change. If a run regresses, revert that one optimization on the local draft before the next replay (the bridge's picker will then skip it since it's already in `optimization_tried`).

---

## 5. Finalize

When the loop converges (or the user explicitly approves a stalled session), call `procedures_autoteach_finalize({session_id})`. The bridge runs the variance gate (last 3 runs all succeeded, no regression, no retries) and then promotes the leaves + composite into `~/browserops/procedures/`.

If `force: true` is set, the gate is skipped — the saved procedure is marked trusted but with weaker evidence. Use this only when the user asks for it explicitly.

The result `{saved: [...names], failed: [{name, reason}]}` tells you what made it. If anything failed, surface the reason in ≤2 lines.

---

## 6. Side-effect policies — concrete rules

**use_dummies (default for sending / posting flows).**
- Every input flagged `destructive: true` must have a value in `consent.dummies`.
- During replays the agent substitutes the dummy.
- The destructive leaf still runs each time, so dummies must be safe to actually trigger (a real send to a dummy address, a real submit to a sandbox endpoint).
- At finalize, the procedure is saved with `inputs[X].destructive: true` retained, so future callers know the input feeds a destructive surface.

**pause_at_destructive (for booking flights, transferring money — flows where no dummy is acceptable).**
- The loop only optimizes the leading non-destructive leaves.
- The destructive leaf is replayed exactly once during finalize, with the real input the user provides at that moment.
- If the destructive leaf fails finalize, the entire promotion fails — leaves stay drafts, the user can retry.

**read_only_only (default for scraping / inspection flows).**
- If the distiller flags any leaf with non-empty `side_effects`, refuse the session and ask the user to either pick a different policy or remove the destructive step from the demo.

---

## 7. Failure-mode → fix-it map

| Symptom | What it usually is | Fix |
|---|---|---|
| `validation_errors` lists "no expected_effect" | Step ran in 0 ms or the trace lost page_effect | Re-record the leaf, or add a `wait_for` manually before `procedures_autoteach_finalize` |
| Replay regressed and `swap_to_execute_js` was the optimization | Native setter trick failed on a framework-controlled input | Revert; the picker will skip it next time. If this is a typing step, leave it as `browser_type` |
| Convergence stalls early (≤3 optimization runs) | Run 0 was already near-optimal, OR the picker has no levers (single navigate, no clicks) | Accept it — finalize. There's no work left to do. |
| Variance gate fails with "need at least 3 runs" | User invoked finalize too early | Run a few more replays first; convergence usually arrives within 4-6 runs |
| `procedures_autoteach_distill` returns a placeholder leaf | Trace was empty (explore mode driver bailed before any browser_* fired, OR teach session captured nothing) | Re-record / re-explore; the demo didn't actually capture anything |
| Session list shows your previous session but not this one | You're in a multi-session daemon and the previous session was started by another MCP client | Each MCP session sees only its own auto-teach sessions — that's by design |
| Side-effect leaf shows `destructive: true` on no inputs | Distiller couldn't find the type-event that feeds the click | Add a manual demonstration of typing the destructive value, then re-distill |

---

## 8. Reuse-first reminder

If the user asks "learn to send an email", the very first thing you do is `procedures_search("send email")`. If a trusted procedure exists, point them at it instead of starting an auto-teach session. Auto-teach is for new flows. The repo compounds — every time you suggest the existing procedure instead of re-learning, the user's "learn this once" investment from a previous session pays off.

When auto-teach DOES emit a procedure, that procedure goes into the same store the search reads from. Future sessions naturally reuse it. The loop's `reuse_existing` optimization is the explicit hook for this — but the easier win is to never have auto-teach run on something it could have looked up.
