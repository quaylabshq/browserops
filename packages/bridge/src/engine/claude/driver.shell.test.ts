import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "@browserops/shared";
import { ClaudeDriver } from "./driver.js";

// Real-process E2E: drive ClaudeDriver against a FAKE `claude` bash script using
// the real child_process.spawn (no injected spawn). Proves the genuine execve
// path works and that a $(...) message is inert — it reaches the process as one
// argv element and is never shell-evaluated (we spawn with no shell).
const onPosix = process.platform === "win32" ? describe.skip : describe;

// The fake never interpolates the prompt; it just emits canned stream-json.
const FAKE_CLAUDE = `#!/bin/bash
sid=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--resume) sid="$2"; shift 2;;
    --) shift; break;;
    *) shift;;
  esac
done
printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$sid\\",\\"cwd\\":\\"$PWD\\"}"
printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"uuid\\":\\"u1\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"id\\":\\"m1\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ack\\"}]}}"
printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"ack\\"}"
`;

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

onPosix("ClaudeDriver real-process E2E", () => {
  let dir: string;
  let bin: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-driver-e2e-"));
    bin = join(dir, "claude");
    await fs.writeFile(bin, FAKE_CLAUDE, { mode: 0o755 });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function driverWith(uuid: string): ClaudeDriver {
    return new ClaudeDriver({
      bin,
      env: process.env,
      chatDir: join(dir, "chat"),
      randomUUID: () => uuid,
      now: () => 1,
      buildSystemPrompt: () => "SYS",
      buildPrompt: (p) => `PAGE ${p.url}`,
    });
  }

  it("streams a turn through a real spawned process", async () => {
    const driver = driverWith("sess-e2e");
    const events: ChatEvent[] = [];
    const ref = await driver.start({ page: { url: "https://x.test" }, cwd: join(dir, "cwd") });
    driver.subscribe(ref, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "status" && e.state === "idle"));
    expect(events.some((e) => e.type === "message" && e.message.role === "assistant")).toBe(true);
  });

  it("treats a $(...) message as inert data — no shell execution", async () => {
    const driver = driverWith("sess-evil");
    const ref = await driver.start({ page: { url: "https://x.test" }, cwd: join(dir, "cwd") });
    const pwned = join(dir, "PWNED");
    await driver.send(ref, `$(touch ${pwned}) \`id\`; rm -rf ~`);
    await expect(fs.access(pwned)).rejects.toThrow(); // never created
  });
});
