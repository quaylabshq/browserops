import { spawnSync } from "node:child_process";
import { firstPathLine } from "./claude/bin.js";

function loginShell(): string {
  return process.env["SHELL"] || "/bin/zsh";
}

const cachedBins = new Map<string, string | null>();

export function resolveAgentBin(name: string, override?: string | null): string | null {
  if (override !== undefined) return override;
  const cached = cachedBins.get(name);
  if (cached !== undefined) return cached;

  const whichCmd = process.platform === "win32" ? "where" : "which";
  let found: string | null = null;
  try {
    const r = spawnSync(whichCmd, [name], { encoding: "utf8" });
    if (r.status === 0) found = firstPathLine(r.stdout);
  } catch {
    /* ignore */
  }

  if (!found && process.platform !== "win32") {
    try {
      const r = spawnSync(loginShell(), ["-lic", `command -v ${name}`], { encoding: "utf8" });
      if (r.status === 0) found = firstPathLine(r.stdout);
    } catch {
      /* ignore */
    }
  }

  cachedBins.set(name, found);
  return found;
}

export function resetAgentBinCache(): void {
  cachedBins.clear();
}
