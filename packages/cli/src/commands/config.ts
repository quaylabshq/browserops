import {
  CONFIG_SCHEMA,
  KNOWN_CONFIG_KEYS,
  isKnownKey,
  readConfig,
  setConfigValue,
  unsetConfigValue,
  type ConfigKey,
} from "../lib/config.js";
import { configPath } from "../lib/paths.js";
import { c, dim, err, info, ok, warn } from "../lib/ui.js";

export async function runConfigList(): Promise<void> {
  const cfg = await readConfig();
  process.stdout.write(`\n${c.bold("browserops config")} ${dim(`(${configPath()})`)}\n\n`);

  for (const key of KNOWN_CONFIG_KEYS) {
    const v = cfg[key];
    const valueStr = v === undefined ? dim("(not set)") : c.cyan(String(v));
    process.stdout.write(
      `  ${c.bold(key)} ${valueStr}\n    ${dim(CONFIG_SCHEMA[key].description)}\n\n`,
    );
  }
}

export async function runConfigGet(key: string | undefined): Promise<void> {
  if (!key) {
    err("usage: browserops config get <key>");
    process.exit(1);
  }
  if (!isKnownKey(key)) {
    err(`unknown key "${key}" — valid: ${KNOWN_CONFIG_KEYS.join(", ")}`);
    process.exit(1);
  }
  const cfg = await readConfig();
  const v = cfg[key];
  if (v === undefined) {
    info(`${key}: (not set)`);
    process.exit(0);
  }
  process.stdout.write(`${String(v)}\n`);
}

export async function runConfigSet(
  key: string | undefined,
  value: string | undefined,
): Promise<void> {
  if (!key || value === undefined) {
    err("usage: browserops config set <key> <value>");
    process.exit(1);
  }
  if (!isKnownKey(key)) {
    err(`unknown key "${key}" — valid: ${KNOWN_CONFIG_KEYS.join(", ")}`);
    process.exit(1);
  }
  try {
    const { backupPath, coercedValue } = await setConfigValue(key as ConfigKey, value);
    const tail = backupPath ? ` ${dim(`(backup: ${backupPath})`)}` : "";
    ok(`${key} = ${String(coercedValue)}${tail}`);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

export async function runConfigUnset(key: string | undefined): Promise<void> {
  if (!key) {
    err("usage: browserops config unset <key>");
    process.exit(1);
  }
  if (!isKnownKey(key)) {
    err(`unknown key "${key}" — valid: ${KNOWN_CONFIG_KEYS.join(", ")}`);
    process.exit(1);
  }
  const { changed } = await unsetConfigValue(key as ConfigKey);
  if (changed) ok(`${key} cleared`);
  else info(`${key}: was not set`);
}

export async function runConfig(
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
): Promise<void> {
  switch (action) {
    case undefined:
    case "list":
      return runConfigList();
    case "get":
      return runConfigGet(key);
    case "set":
      return runConfigSet(key, value);
    case "unset":
      return runConfigUnset(key);
    default:
      warn(`unknown action "${action}" — try: list, get, set, unset`);
      process.exit(1);
  }
}
