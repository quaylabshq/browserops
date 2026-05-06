import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CliTelemetry,
  isCliTelemetryEnabled,
  loadOrCreateCliInstallId,
} from "./telemetry.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("CLI telemetry", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedDnt: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bops-cli-tel-"));
    savedHome = process.env["HOME"];
    process.env["HOME"] = dir;
    savedDnt = process.env["DO_NOT_TRACK"];
    delete process.env["DO_NOT_TRACK"];
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedDnt === undefined) delete process.env["DO_NOT_TRACK"];
    else process.env["DO_NOT_TRACK"] = savedDnt;
    rmSync(dir, { recursive: true, force: true });
  });

  it("isCliTelemetryEnabled defaults to true", () => {
    expect(isCliTelemetryEnabled()).toBe(true);
  });

  it("DO_NOT_TRACK=1 disables", () => {
    process.env["DO_NOT_TRACK"] = "1";
    expect(isCliTelemetryEnabled()).toBe(false);
  });

  it("DO_NOT_TRACK=true disables", () => {
    process.env["DO_NOT_TRACK"] = "true";
    expect(isCliTelemetryEnabled()).toBe(false);
  });

  it("DO_NOT_TRACK=0 keeps telemetry on", () => {
    process.env["DO_NOT_TRACK"] = "0";
    expect(isCliTelemetryEnabled()).toBe(true);
  });

  it("loadOrCreateCliInstallId persists across calls", async () => {
    const a = await loadOrCreateCliInstallId();
    expect(UUID_RE.test(a.id)).toBe(true);
    expect(a.created).toBe(true);
    const b = await loadOrCreateCliInstallId();
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
  });

  it("CliTelemetry.flush sends a batch with redacted properties", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const t = new CliTelemetry("0.0.0-test");
    const r = await t.init();
    expect(r.enabled).toBe(true);

    t.capture("cli_command_invoked", {
      command: "init",
      exit_code: 0,
      duration_ms: 42,
      // adversarial — should be dropped by redact
      home_dir: "/Users/secretuser",
      raw_argv: ["init", "--secret"],
    });
    await t.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body)) as {
      api_key: string;
      batch: Array<{ event: string; properties: Record<string, unknown> }>;
    };
    expect(body.batch).toHaveLength(1);
    const props = body.batch[0]!.properties;
    expect(props["command"]).toBe("init");
    expect(props["exit_code"]).toBe(0);
    expect(props["duration_ms"]).toBe(42);
    expect(props["cli_version"]).toBe("0.0.0-test");
    expect(props["os_platform"]).toBe(process.platform);
    expect(props).not.toHaveProperty("home_dir");
    expect(props).not.toHaveProperty("raw_argv");
    const json = JSON.stringify(props);
    expect(json).not.toContain("secretuser");
    expect(json).not.toContain("--secret");

    vi.unstubAllGlobals();
  });

  it("CliTelemetry.flush is a no-op when disabled", async () => {
    process.env["DO_NOT_TRACK"] = "1";
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const t = new CliTelemetry("0.0.0-test");
    await t.init();
    t.capture("cli_command_invoked", { command: "doctor", exit_code: 0, duration_ms: 1 });
    await t.flush();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("CliTelemetry.capture drops events with unknown event name", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const t = new CliTelemetry("0.0.0-test");
    await t.init();
    t.capture("not_in_allowlist", { whatever: "value" });
    await t.flush();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("install-id file is created", async () => {
    await loadOrCreateCliInstallId();
    expect(existsSync(join(dir, ".browserops", "install-id"))).toBe(true);
  });
});
