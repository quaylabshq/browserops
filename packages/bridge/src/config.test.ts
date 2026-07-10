import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChatSettings, loadChatTransport, loadSafeMode, updateChatSettings } from "./config.js";

describe("loadSafeMode", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-config-"));
    path = join(dir, "config.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns false when the config file does not exist", async () => {
    await expect(loadSafeMode(join(dir, "missing.json"))).resolves.toBe(false);
  });

  it("returns false when safe_mode is absent", async () => {
    await fs.writeFile(path, JSON.stringify({ features: { procedures: true } }));
    await expect(loadSafeMode(path)).resolves.toBe(false);
  });

  it("returns true only when safe_mode === true", async () => {
    await fs.writeFile(path, JSON.stringify({ safe_mode: true }));
    await expect(loadSafeMode(path)).resolves.toBe(true);
  });

  it("treats non-boolean / falsy safe_mode values as false", async () => {
    await fs.writeFile(path, JSON.stringify({ safe_mode: "true" }));
    await expect(loadSafeMode(path)).resolves.toBe(false);

    await fs.writeFile(path, JSON.stringify({ safe_mode: false }));
    await expect(loadSafeMode(path)).resolves.toBe(false);
  });

  it("returns false on malformed JSON rather than throwing", async () => {
    await fs.writeFile(path, "{ not json");
    await expect(loadSafeMode(path)).resolves.toBe(false);
  });
});

describe("loadChatTransport", () => {
  let dir: string;
  let path: string;
  const ENV = "BROWSEROPS_CHAT_TRANSPORT";
  let savedEnv: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-config-"));
    path = join(dir, "config.json");
    savedEnv = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("defaults to terminal when the file is missing", async () => {
    await expect(loadChatTransport(join(dir, "missing.json"))).resolves.toBe("terminal");
  });

  it("defaults to terminal when chat_transport is absent", async () => {
    await fs.writeFile(path, JSON.stringify({ safe_mode: true }));
    await expect(loadChatTransport(path)).resolves.toBe("terminal");
  });

  it("reads headless from the config file", async () => {
    await fs.writeFile(path, JSON.stringify({ chat_transport: "headless" }));
    await expect(loadChatTransport(path)).resolves.toBe("headless");
  });

  it("falls back to terminal on an unrecognised value", async () => {
    await fs.writeFile(path, JSON.stringify({ chat_transport: "tmux" }));
    await expect(loadChatTransport(path)).resolves.toBe("terminal");
  });

  it("falls back to terminal on malformed JSON rather than throwing", async () => {
    await fs.writeFile(path, "{ not json");
    await expect(loadChatTransport(path)).resolves.toBe("terminal");
  });

  it("lets the env override win over the file", async () => {
    await fs.writeFile(path, JSON.stringify({ chat_transport: "terminal" }));
    process.env[ENV] = "headless";
    await expect(loadChatTransport(path)).resolves.toBe("headless");
  });

  it("ignores an invalid env override and uses the file", async () => {
    await fs.writeFile(path, JSON.stringify({ chat_transport: "headless" }));
    process.env[ENV] = "bogus";
    await expect(loadChatTransport(path)).resolves.toBe("headless");
  });
});

describe("sidebar chat settings", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-chat-settings-"));
    path = join(dir, "config.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("uses safe defaults and round-trips non-secret inference preferences", async () => {
    await expect(loadChatSettings(path)).resolves.toMatchObject({
      defaultAgent: "claude",
      models: {},
      safeMode: false,
      transport: "terminal",
    });
    await expect(
      updateChatSettings(
        {
          defaultAgent: "codex",
          models: { codex: "gpt-5.6-terra" },
          reasoningEfforts: { codex: "xhigh" },
          safeMode: true,
          transport: "headless",
        },
        path,
      ),
    ).resolves.toMatchObject({
      defaultAgent: "codex",
      models: { codex: "gpt-5.6-terra" },
      reasoningEfforts: { codex: "xhigh" },
      safeMode: true,
      transport: "headless",
    });
    await expect(loadChatSettings(path)).resolves.toMatchObject({
      defaultAgent: "codex",
      models: { codex: "gpt-5.6-terra" },
    });
  });
});
