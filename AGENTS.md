# browserops — agent instructions

Guidance for any MCP-compatible coding agent (Claude Code, Cursor, Zed, Continue, Windsurf, custom SDK agents) working in this repo or consuming the `browserops` MCP server. Claude Code auto-loads this file via the `CLAUDE.md` symlink.

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

### Composite procedures = single fetch
When a composite procedure covers the full flow, the sub-agent brief references ONLY the composite name — one `procedures_get`, no re-planning steps.

```
Run mem0.qa_signup. Report the temp email used and the API key string.
```

### Known procedure bugs fixed
- `gmail.send_email` v2: `mode: trusted` removed from `fill_body` — caused doubled characters in Gmail's rich-text editor.

## Procedure authoring rules

### Never save an untested procedure
- Write the procedure → run it in the same session → fix what breaks → then call `procedures_save`.
- A procedure is trusted only when `success_count >= 1`.
- For multi-step flows: test each leaf individually first, then compose.

### Use `browser.wait_for` for polling, not manual reloads
- Any step that waits for async state (email arriving, page loading, element appearing) must use a `browser.wait_for` action step with an explicit `timeout`.
- Never use `browser.reload` as a substitute for polling — it fires once and does not retry.
