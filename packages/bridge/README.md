# @browserops/bridge

> MCP stdio server for [browserops](https://www.npmjs.com/package/browserops). End-users typically want the [`browserops`](https://www.npmjs.com/package/browserops) CLI package — it installs this transitively.

`@browserops/bridge` ships two binaries:

- **`browserops-daemon`** — long-running Node process. Hosts the WebSocket primary on `ws://127.0.0.1:57321` that the [browserops Chrome extension](https://github.com/quaylabshq/browserops/tree/main/packages/extension) connects to, plus the rate limiter, risky-action gate, and procedure runtime.
- **`browserops-shim`** — per-MCP-client stdio adapter. Speaks MCP over stdio to your AI client (Claude Code, Cursor, Codex CLI, Continue, Windsurf, …) and forwards `browser_*` / `procedures_*` calls into the daemon over a local Unix socket.

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
    "browserops": { "command": "browserops-shim" }
  }
}
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.browserops]
command = "browserops-shim"
args = []
```

The shim auto-starts the daemon on first use and reuses it across MCP clients.

## Exposed prompts

- `browserops {task}` — operating guide + task as a user message
- `browserops_procedure {name, task?}` — inlines a saved procedure's YAML

## Source & docs

[github.com/quaylabshq/browserops](https://github.com/quaylabshq/browserops)

## License

MIT
