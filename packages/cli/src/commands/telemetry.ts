import { c, dim, err, info, ok } from "../lib/ui.js";
import {
  isCliTelemetryEnabled,
  loadOrCreateCliInstallId,
  setTelemetryEnabledInConfig,
  getCliTelemetry,
} from "../lib/telemetry.js";

const VALID_ACTIONS = ["status", "on", "off"] as const;
type Action = (typeof VALID_ACTIONS)[number];

function isAction(v: string | undefined): v is Action {
  return typeof v === "string" && (VALID_ACTIONS as readonly string[]).includes(v);
}

export async function runTelemetry(action: string | undefined): Promise<void> {
  if (action === undefined) {
    await runStatus();
    return;
  }
  if (!isAction(action)) {
    err(`unknown action "${action}". Expected: ${VALID_ACTIONS.join(", ")}.`);
    process.exit(1);
  }
  if (action === "status") await runStatus();
  else if (action === "on") await runEnable();
  else await runDisable();
}

async function runStatus(): Promise<void> {
  const enabled = await isCliTelemetryEnabled();
  const { id } = await loadOrCreateCliInstallId();
  const label = enabled ? c.green("enabled") : c.yellow("disabled");
  process.stdout.write(`telemetry: ${label}\n`);
  process.stdout.write(`install id: ${dim(id)}\n`);
  process.stdout.write(
    `\nbrowserops sends anonymous usage telemetry: tool names, error\n` +
      `codes, durations, MCP client name + version, and tab hostnames\n` +
      `(no paths, no params, no page content). Disable with:\n` +
      `  ${c.cyan("browserops telemetry off")}\n` +
      `  ${dim("# or BROWSEROPS_TELEMETRY=0 / DO_NOT_TRACK=1")}\n`,
  );
}

async function runEnable(): Promise<void> {
  await setTelemetryEnabledInConfig(true);
  ok("telemetry enabled");
  getCliTelemetry()?.capture("telemetry_changed", { enabled: true });
  info(`restart the daemon to apply: ${c.cyan("browserops restart")}`);
}

async function runDisable(): Promise<void> {
  // Capture BEFORE persisting the flip, while the singleton may still be
  // enabled — the user opted out, but it's reasonable for that final
  // event to land so we know who turned it off.
  getCliTelemetry()?.capture("telemetry_changed", { enabled: false });
  await setTelemetryEnabledInConfig(false);
  ok("telemetry disabled");
  info(`restart the daemon to apply: ${c.cyan("browserops restart")}`);
}
