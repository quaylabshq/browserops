import { FEATURES, isFeatureName, type FeatureName } from "@browserops/shared";
import {
  getFeatureStates,
  setFeatureEnabled,
  type FeatureState,
} from "../lib/config.js";
import { isDaemonAlive } from "../lib/daemon.js";
import { c, dim, err, header, info, ok, warn } from "../lib/ui.js";

const VALID_ACTIONS = ["list", "enable", "disable"] as const;
type Action = (typeof VALID_ACTIONS)[number];

function isAction(v: string | undefined): v is Action {
  return typeof v === "string" && (VALID_ACTIONS as readonly string[]).includes(v);
}

export async function runFeature(action: string | undefined, name: string | undefined): Promise<void> {
  if (action === undefined) {
    await runList();
    return;
  }
  if (!isAction(action)) {
    err(`unknown action "${action}". Expected one of: ${VALID_ACTIONS.join(", ")}.`);
    process.exit(1);
  }

  if (action === "list") {
    await runList();
    return;
  }

  if (name === undefined || name === "") {
    err(`browserops feature ${action} <name> — missing feature name. Available: ${FEATURES.join(", ")}.`);
    process.exit(1);
  }
  if (!isFeatureName(name)) {
    err(`unknown feature "${name}". Available: ${FEATURES.join(", ")}.`);
    process.exit(1);
  }

  if (action === "enable") await runEnable(name);
  else await runDisable(name);
}

async function runList(): Promise<void> {
  header("browserops features");
  const states = await getFeatureStates();
  for (const s of states) {
    const tag = s.stability === "experimental" ? c.yellow("experimental") : c.green("stable");
    const stateLabel = s.enabled ? c.green("enabled") : dim("disabled");
    const sourceLabel = s.source === "config" ? "" : ` ${dim("(default)")}`;
    process.stdout.write(`  ${c.cyan(s.name.padEnd(12))} ${stateLabel}${sourceLabel}  [${tag}]\n`);
    process.stdout.write(`    ${dim(s.description)}\n`);
  }
  process.stdout.write("\n");
  info(
    `enable with: ${c.cyan("browserops feature enable <name>")} — restart with ${c.cyan("browserops restart")} for changes to take effect.`,
  );
}

async function runEnable(name: FeatureName): Promise<void> {
  const result = await setFeatureEnabled(name, true);
  if (!result.changed) {
    info(`${name}: already enabled`);
  } else {
    ok(`${name}: enabled`);
  }
  await reloadHint();
}

async function runDisable(name: FeatureName): Promise<void> {
  const result = await setFeatureEnabled(name, false);
  if (!result.changed) {
    info(`${name}: already disabled`);
  } else {
    ok(`${name}: disabled`);
  }
  await reloadHint();
}

async function reloadHint(): Promise<void> {
  if (await isDaemonAlive()) {
    warn(
      `bridge is running with the previous feature set. Restart it with ${c.cyan("browserops restart")} to apply.`,
    );
  } else {
    info(`bridge is not running. Start it with ${c.cyan("browserops start")} when ready.`);
  }
}

/**
 * Print a one-line feature summary suitable for `browserops doctor` output.
 */
export async function describeFeaturesForDoctor(): Promise<string> {
  const states = await getFeatureStates();
  const items = states.map((s: FeatureState) =>
    s.enabled ? c.green(s.name) : dim(s.name),
  );
  return items.join(" ");
}
