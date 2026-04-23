# browser-exp

## browserops orchestration rules

### Procedure-first: always search before planning
Before any browser task, call `procedures_search` with tokens from the user's request.
If score >= 0.5, use that procedure. Do not re-plan steps that are already encoded.

### Sub-agent threshold
- **≤ 8 steps, no retries needed**: run browser tool calls directly from the main agent. No sub-agent.
- **> 8 steps OR retry/branching logic needed**: delegate to a sub-agent.

### Sub-agent brief must be minimal
Pass only: procedure name, inputs, tab_id.
Do NOT copy procedure steps into the prompt — the sub-agent calls `procedures_get` itself.

```
Run the gmail.send_email procedure on tab t_3 with:
- to: foo@example.com
- subject: Hello
- body: Hi there.
Report success or failure.
```

### Screenshots only on failure
Never take a screenshot to "verify" a step that has a `wait_for` condition.
Only screenshot when a step returns an error or unexpected state.

### Known procedure bugs fixed
- `gmail.send_email` v2: `mode: trusted` removed from `fill_body` — caused doubled characters in Gmail's rich-text editor.
