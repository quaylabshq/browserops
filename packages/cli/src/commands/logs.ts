import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { logPath } from "../lib/paths.js";
import { dim } from "../lib/ui.js";

export async function runLogs(opts: {
  follow?: boolean;
  lines?: number | string;
}): Promise<void> {
  const maxLines = Number(opts.lines ?? 50);
  const lp = logPath();

  const initial = await readLastLines(lp, maxLines);
  for (const line of initial) {
    printLogLine(line);
  }

  if (!opts.follow) return;

  let position: number;
  try {
    const stat = await fsPromises.stat(lp);
    position = stat.size;
  } catch {
    position = 0;
  }

  let buffer = "";
  const watcher = fs.watch(lp, { persistent: true }, () => {
    try {
      const fd = fs.openSync(lp, "r");
      const stat = fs.fstatSync(fd);
      if (stat.size <= position) {
        fs.closeSync(fd);
        return;
      }
      const toRead = stat.size - position;
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, position);
      fs.closeSync(fd);
      position = stat.size;
      buffer += buf.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) printLogLine(part);
      }
    } catch {
      // file may have been rotated or not yet exist
    }
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });

  await new Promise<void>(() => {
    // stays alive until SIGINT
  });
}

async function readLastLines(filePath: string, n: number): Promise<string[]> {
  let raw: string;
  try {
    const buf = await fsPromises.readFile(filePath);
    raw = buf.toString("utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

function printLogLine(raw: string): void {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ts =
      typeof parsed["time"] === "string" || typeof parsed["time"] === "number"
        ? new Date(parsed["time"] as string | number).toISOString()
        : "";
    const event =
      typeof parsed["event"] === "string"
        ? parsed["event"]
        : typeof parsed["msg"] === "string"
        ? parsed["msg"]
        : "";
    const extra =
      typeof parsed["message"] === "string"
        ? parsed["message"]
        : typeof parsed["reason"] === "string"
        ? parsed["reason"]
        : typeof parsed["error"] === "string"
        ? parsed["error"]
        : "";
    const main = [event, extra].filter(Boolean).join("  ");
    process.stdout.write(`${dim(ts)}  ${main || raw.slice(0, 160)}\n`);
  } catch {
    process.stdout.write(`${raw}\n`);
  }
}
