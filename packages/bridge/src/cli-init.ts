/**
 * `browserops-bridge init` — first-run scaffolding.
 *
 *   1. Generate (or reuse) the WebSocket auth token.
 *   2. Seed bundled procedure examples into ~/browserops/procedures/shared/.
 *   3. Print MCP-client config snippets for the major hosts so the user
 *      can copy-paste without a docs lookup.
 *
 * Stays read-only on the host — no client config files are written. The
 * snippets reference the absolute path of the running binary so they
 * work whether the user invoked via npx, a global install, or a clone.
 */
import { DEFAULT_WS_HOST, DEFAULT_WS_PORT } from "@browserops/shared";
import { loadOrCreateToken } from "./token.js";
import { tokenPath } from "./paths.js";
import { proceduresRoot } from "./procedures/paths.js";
import { seedBundledProcedures } from "./procedures/seed.js";

function binaryInvocation(): string {
  // process.argv[1] is the resolved bin path. For npx-launched runs this
  // points inside the npx cache, which is fine for users to copy.
  const bin = process.argv[1] ?? "browserops-bridge";
  return bin;
}

function printSnippets(bin: string, host: string, port: number): void {
  const out = process.stdout;
  out.write("\n");
  out.write("MCP client config snippets — copy the one for your client:\n");
  out.write("\n");

  // Claude Code
  out.write("─── Claude Code (~/.claude/mcp.json or project .mcp.json) ───\n");
  out.write(JSON.stringify({
    mcpServers: {
      browserops: { command: bin },
    },
  }, null, 2));
  out.write("\n\n");

  // Cursor
  out.write("─── Cursor (~/.cursor/mcp.json or .cursor/mcp.json) ───\n");
  out.write(JSON.stringify({
    mcpServers: {
      browserops: { command: bin },
    },
  }, null, 2));
  out.write("\n\n");

  // Zed
  out.write("─── Zed (settings.json → context_servers) ───\n");
  out.write(JSON.stringify({
    context_servers: {
      browserops: { command: { path: bin, args: [] } },
    },
  }, null, 2));
  out.write("\n\n");

  // Continue
  out.write("─── Continue (.continue/config.yaml mcpServers) ───\n");
  out.write(`mcpServers:\n  - name: browserops\n    command: ${bin}\n`);
  out.write("\n");

  out.write(`(WebSocket: ws://${host}:${port}; token at ${tokenPath()})\n`);
  out.write("\n");
}

export async function runInit(): Promise<void> {
  const out = process.stdout;
  out.write("browserops init: scaffolding…\n");

  // 1. Token
  const token = await loadOrCreateToken();
  out.write(`  ✓ token at ${tokenPath()} (${token.length} chars)\n`);

  // 2. Seed
  const report = await seedBundledProcedures();
  if (report.bundledDir === null) {
    out.write("  ! bundled examples dir not found — skipping seed\n");
  } else {
    out.write(`  ✓ procedures root: ${proceduresRoot()}\n`);
    if (report.copied.length > 0) {
      out.write(`    copied: ${report.copied.join(", ")}\n`);
    }
    if (report.skipped.length > 0) {
      out.write(`    skipped (local copy present): ${report.skipped.join(", ")}\n`);
    }
  }

  // 3. Snippets
  const host = process.env["BROWSEROPS_HOST"] ?? DEFAULT_WS_HOST;
  const port = Number.parseInt(
    process.env["BROWSEROPS_PORT"] ?? String(DEFAULT_WS_PORT),
    10,
  );
  printSnippets(binaryInvocation(), host, port);

  out.write("Next: load the Chrome extension (chrome://extensions → Load unpacked).\n");
  out.write("An onboarding tab opens automatically — once your MCP client starts the\n");
  out.write("bridge, click 'Confirm & connect' to pair. (No token copy-paste required;\n");
  out.write("the bridge prints a 6-digit pair code to its stderr for visual verification.)\n");
}
