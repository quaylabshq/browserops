import * as fs from "node:fs/promises";
import { status } from "../lib/daemon.js";
import { logPath, daemonSocketPath } from "../lib/paths.js";
import { DEFAULT_WS_PORT, ENV } from "@browserops/shared";
import { c, dim } from "../lib/ui.js";

export async function runStatus(): Promise<void> {
  const st = await status();
  const port = process.env[ENV.PORT] ?? String(DEFAULT_WS_PORT);

  const statusLabel = st.running ? c.green("running") : c.red("stopped");
  const pidLabel = st.running && st.pid != null ? String(st.pid) : "—";
  const socketLabel = st.running ? daemonSocketPath() : "—";

  process.stdout.write(`\nbrowserops daemon\n`);
  process.stdout.write(`  status:    ${statusLabel}\n`);
  process.stdout.write(`  pid:       ${pidLabel}\n`);
  process.stdout.write(`  socket:    ${socketLabel}\n`);
  process.stdout.write(`  port:      ${port}\n`);
  process.stdout.write(`  log:       ${logPath()}\n`);
  process.stdout.write(`  recent errors:\n`);

  const errors = await readRecentErrors();
  if (errors.length === 0) {
    process.stdout.write(`    ${dim("(none)")}\n`);
  } else {
    for (const line of errors) {
      process.stdout.write(`    ${dim("·")} ${line}\n`);
    }
  }
  process.stdout.write(`\n`);
}

async function readRecentErrors(): Promise<string[]> {
  let raw: string;
  try {
    const buf = await fs.readFile(logPath());
    const totalBytes = buf.byteLength;
    const slice = totalBytes > 256_000 ? buf.slice(totalBytes - 256_000) : buf;
    raw = slice.toString("utf8");
  } catch {
    return ["(no log yet)"];
  }

  const errorLines: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const isError =
        parsed["level"] === "error" ||
        "error" in parsed ||
        parsed["dir"] === "error";
      if (!isError) continue;
      const ts =
        typeof parsed["time"] === "string" || typeof parsed["time"] === "number"
          ? new Date(parsed["time"] as string | number).toISOString()
          : "";
      const event =
        typeof parsed["event"] === "string"
          ? parsed["event"]
          : typeof parsed["message"] === "string"
          ? parsed["message"]
          : typeof parsed["msg"] === "string"
          ? parsed["msg"]
          : trimmed.slice(0, 120);
      errorLines.push(ts ? `${ts} ${event}` : event);
    } catch {
      // skip unparseable lines
    }
  }

  return errorLines.slice(-3);
}
