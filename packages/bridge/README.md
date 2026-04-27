# @browserops/bridge

> MCP stdio server for [browserops](https://www.npmjs.com/package/browserops). End-users typically want the [`browserops`](https://www.npmjs.com/package/browserops) CLI package — it installs this transitively.

`@browserops/bridge` ships the `browserops-bridge` binary: a local Node process that

- speaks MCP over stdio to your AI client (Claude Code, Cursor, Codex CLI, Continue, Windsurf, …)
- runs a WebSocket primary on `ws://127.0.0.1:57321` that the [browserops Chrome extension](https://github.com/quaylabshq/browserops/tree/main/packages/extension) connects to
- forwards `browser_*` and `procedures_*` tool calls into the user's live Chrome tabs

## Install

Most users should install the [`browserops`](https://www.npmjs.com/package/browserops) CLI, which brings the bridge along:

```bash
npm i -g browserops
```

Standalone install (custom MCP-client setups only):

```bash
npm i -g @browserops/bridge
```

## MCP-client registration

```json
{
  "mcpServers": {
    "browserops": { "command": "browserops-bridge" }
  }
}
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.browserops]
command = "browserops-bridge"
args = []
```

## Exposed prompts

- `browserops {task}` — operating guide + task as a user message
- `browserops_procedure {name, task?}` — inlines a saved procedure's YAML

## Source & docs

[github.com/quaylabshq/browserops](https://github.com/quaylabshq/browserops)

## License

MIT
