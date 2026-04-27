import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { isBridgeAlive } from "../lib/daemon.js";
import { STATE_DIR, tokenPath, bundledAssetsDir } from "../lib/paths.js";
import { DEFAULT_WS_PORT, ENV } from "@browserops/shared";
import { ok, err, info, warn } from "../lib/ui.js";

interface Check {
  ok: boolean;
  informational?: boolean;
  label: string;
  detail?: string;
}

export async function runDoctor(): Promise<void> {
  const checks = await runAllChecks();
  let anyFailed = false;

  for (const check of checks) {
    if (check.ok) {
      ok(check.label + (check.detail ? `  ${check.detail}` : ""));
    } else if (check.informational) {
      warn(check.label + (check.detail ? `  ${check.detail}` : ""));
    } else {
      err(check.label + (check.detail ? `  ${check.detail}` : ""));
      anyFailed = true;
    }
  }

  if (anyFailed) process.exit(1);
}

async function runAllChecks(): Promise<Check[]> {
  const port = Number(process.env[ENV.PORT] ?? DEFAULT_WS_PORT);
  const [nodeCheck, stateDirCheck, tokenCheck, portCheck, socketCheck, extensionCheck, ...clientChecks] =
    await Promise.all([
      checkNode(),
      checkStateDir(),
      checkToken(),
      checkPort(port),
      checkSocket(),
      checkExtension(),
      ...checkClients(),
    ]);

  return [nodeCheck, stateDirCheck, tokenCheck, portCheck, socketCheck, extensionCheck, ...clientChecks];
}

function checkNode(): Check {
  const version = process.versions["node"] ?? "0.0.0";
  const [major, minor] = version.split(".").map(Number);
  const pass = (major ?? 0) > 20 || ((major ?? 0) === 20 && (minor ?? 0) >= 10);
  return {
    ok: pass,
    label: `Node ${pass ? "20.10+" : "< 20.10 — upgrade required"}`,
    detail: pass ? `(${version})` : `(${version})`,
  };
}

async function checkStateDir(): Promise<Check> {
  const exists = existsSync(STATE_DIR);
  return {
    ok: exists,
    label: exists ? `State dir ${STATE_DIR}` : `State dir missing — run \`browserops init\``,
  };
}

async function checkToken(): Promise<Check> {
  try {
    await fs.access(tokenPath());
    return { ok: true, label: "Token present" };
  } catch {
    return { ok: false, label: "Token missing — run `browserops init`" };
  }
}

async function checkPort(port: number): Promise<Check> {
  const connectable = await tcpConnect(port);
  if (!connectable) {
    return { ok: true, label: `Port ${port} free` };
  }
  const bridgeOwns = await isBridgeAlive();
  if (bridgeOwns) {
    return { ok: true, label: `Port ${port} owned by bridge` };
  }
  return {
    ok: false,
    label: `Port ${port} conflict`,
    detail: `another process is on port ${port}`,
  };
}

function tcpConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const conn = createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean): void => {
      conn.removeAllListeners();
      try { conn.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}

async function checkSocket(): Promise<Check> {
  const alive = await isBridgeAlive();
  return {
    ok: alive,
    informational: true,
    label: alive ? "Control socket reachable" : "Control socket not reachable (bridge not running)",
  };
}

async function checkExtension(): Promise<Check> {
  const manifestPath = join(bundledAssetsDir(), "extension", "manifest.json");
  try {
    await fs.access(manifestPath);
    return { ok: true, label: "Bundled extension present" };
  } catch {
    return { ok: false, label: "Bundled extension missing", detail: manifestPath };
  }
}

function checkClients(): Promise<Check>[] {
  return (["claude", "cursor", "codex"] as const).map((bin) => checkBin(bin));
}

function checkBin(bin: string): Promise<Check> {
  return new Promise<Check>((resolve) => {
    execFile("which", [bin], (error) => {
      resolve({
        ok: error === null,
        informational: true,
        label: error === null ? `${bin} on PATH` : `${bin} not found on PATH`,
      });
    });
  });
}
