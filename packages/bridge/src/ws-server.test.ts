import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CloseCode, HELLO_TIMEOUT_MS, PROTOCOL_VERSION, type SessionRef } from "@browserops/shared";
import {
  WSBridge,
  type ChatService,
  type LaunchOutcome,
  type LaunchRequestParams,
} from "./ws-server.js";
import { EngineError } from "./engine/errors.js";
import type { Logger } from "./logger.js";

const VALID_TOKEN = "a".repeat(64);
const PIN = "aaaabbbb";
const PIN_ORIGIN = `chrome-extension://${PIN}`;

function stubLogger(): Logger {
  return { async write() {} } as unknown as Logger;
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface BridgeFixture {
  bridge: WSBridge;
  port: number;
}

interface StartOpts {
  token?: string;
  pinnedExtensionId?: string | null;
  onExtensionPin?: (extId: string) => Promise<void>;
  onLaunch?: (params: LaunchRequestParams) => Promise<LaunchOutcome>;
  chat?: ChatService;
}

async function startBridge(opts: StartOpts = {}): Promise<BridgeFixture> {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const bridge = new WSBridge({
    host: "127.0.0.1",
    port,
    token: opts.token ?? VALID_TOKEN,
    bridgeVersion: "test-0.0.0",
    logger: stubLogger(),
    onEvent: () => {},
    onLaunch: opts.onLaunch,
    chat: opts.chat,
    pinnedExtensionId: opts.pinnedExtensionId ?? null,
    onExtensionPin: opts.onExtensionPin,
  });
  await bridge.start();
  return { bridge, port };
}

function connect(port: number, origin = "chrome-extension://test"): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/`, {
    headers: { Origin: origin },
  });
}

function awaitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason?.toString() ?? "" });
    });
  });
}

function awaitFirstMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse((data as Buffer).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
  });
}

describe("WSBridge handshake", () => {
  let fixture: BridgeFixture;

  beforeEach(async () => {
    fixture = await startBridge();
  });

  afterEach(async () => {
    await fixture.bridge.stop();
  });

  it("refuses to bind a non-loopback host", async () => {
    const bad = new WSBridge({
      host: "0.0.0.0",
      port: 49999,
      token: VALID_TOKEN,
      bridgeVersion: "test-0.0.0",
      logger: stubLogger(),
      onEvent: () => {},
    });
    await expect(bad.start()).rejects.toThrow(/non-loopback/);
  });

  it("closes with BAD_TOKEN (4001) when the hello frame carries a wrong token", async () => {
    const ws = connect(fixture.port);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(
      JSON.stringify({
        type: "hello",
        token: "wrong-token",
        protocol_version: PROTOCOL_VERSION,
        extension_version: "test",
      }),
    );
    const { code } = await awaitClose(ws);
    expect(code).toBe(CloseCode.BAD_TOKEN);
  });

  it("closes with PROTOCOL_MISMATCH (4002) when the protocol version is unsupported", async () => {
    const ws = connect(fixture.port);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(
      JSON.stringify({
        type: "hello",
        token: VALID_TOKEN,
        protocol_version: 99,
        extension_version: "test",
      }),
    );
    const { code } = await awaitClose(ws);
    expect(code).toBe(CloseCode.PROTOCOL_MISMATCH);
  });

  it("closes with MALFORMED_HELLO (4004) when the first frame is not a hello envelope", async () => {
    const ws = connect(fixture.port);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "request", id: "x", method: "ping", params: {} }));
    const { code } = await awaitClose(ws);
    expect(code).toBe(CloseCode.MALFORMED_HELLO);
  });

  it("closes with MALFORMED_HELLO (4004) when the first frame is not JSON", async () => {
    const ws = connect(fixture.port);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send("this is not json");
    const { code } = await awaitClose(ws);
    expect(code).toBe(CloseCode.MALFORMED_HELLO);
  });

  it(
    "closes with HELLO_TIMEOUT (4003) when no hello frame arrives",
    async () => {
      // The HELLO_TIMEOUT_MS in the codebase is shorter than test runs typically need;
      // we just confirm the timer fires by waiting a touch over it.
      expect(HELLO_TIMEOUT_MS).toBeLessThan(10_000);
      const ws = connect(fixture.port);
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      const { code } = await awaitClose(ws);
      expect(code).toBe(CloseCode.HELLO_TIMEOUT);
    },
    HELLO_TIMEOUT_MS + 2_000,
  );

  it("acks a valid hello and surfaces the bridge version + protocol version", async () => {
    const ws = connect(fixture.port);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(
      JSON.stringify({
        type: "hello",
        token: VALID_TOKEN,
        protocol_version: PROTOCOL_VERSION,
        extension_version: "test",
      }),
    );
    const ack = (await awaitFirstMessage(ws)) as Record<string, unknown>;
    expect(ack["type"]).toBe("hello_ack");
    expect(ack["bridge_version"]).toBe("test-0.0.0");
    expect(ack["protocol_version"]).toBe(PROTOCOL_VERSION);
    expect(fixture.bridge.isConnected()).toBe(true);
    ws.close();
  });

  it("supersedes a prior connection with SUPERSEDED (4005) when a second client handshakes", async () => {
    const first = connect(fixture.port);
    await new Promise<void>((resolve) => first.once("open", () => resolve()));
    first.send(
      JSON.stringify({
        type: "hello",
        token: VALID_TOKEN,
        protocol_version: PROTOCOL_VERSION,
        extension_version: "test",
      }),
    );
    await awaitFirstMessage(first); // wait for ack

    const second = connect(fixture.port);
    await new Promise<void>((resolve) => second.once("open", () => resolve()));
    second.send(
      JSON.stringify({
        type: "hello",
        token: VALID_TOKEN,
        protocol_version: PROTOCOL_VERSION,
        extension_version: "test",
      }),
    );
    await awaitFirstMessage(second); // ack for second

    const { code } = await awaitClose(first);
    expect(code).toBe(CloseCode.SUPERSEDED);
    second.close();
  });

  it("rejects upgrade requests with a non-chrome-extension Origin", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/`, {
      headers: { Origin: "https://evil.com" },
    });
    await new Promise<void>((resolve) => {
      ws.once("error", () => resolve());
      ws.once("unexpected-response", () => resolve());
    });
  });
});

describe("WSBridge extension-id pin", () => {
  it("calls onExtensionPin with the Origin's extension ID on first successful hello", async () => {
    const pinned: string[] = [];
    const fixture = await startBridge({
      onExtensionPin: async (id) => {
        pinned.push(id);
      },
    });
    try {
      const ws = connect(fixture.port, "chrome-extension://aaaabbbb");
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(
        JSON.stringify({
          type: "hello",
          token: VALID_TOKEN,
          protocol_version: PROTOCOL_VERSION,
          extension_version: "test",
        }),
      );
      await awaitFirstMessage(ws); // ack
      // onExtensionPin is fire-and-forget; await a microtask.
      await new Promise((r) => setTimeout(r, 50));
      expect(pinned).toEqual(["aaaabbbb"]);
      expect(fixture.bridge.pinnedExtension).toBe("aaaabbbb");
      ws.close();
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("does NOT call onExtensionPin a second time once already pinned", async () => {
    const pinned: string[] = [];
    const fixture = await startBridge({
      pinnedExtensionId: "aaaabbbb",
      onExtensionPin: async (id) => {
        pinned.push(id);
      },
    });
    try {
      const ws = connect(fixture.port, "chrome-extension://aaaabbbb");
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(
        JSON.stringify({
          type: "hello",
          token: VALID_TOKEN,
          protocol_version: PROTOCOL_VERSION,
          extension_version: "test",
        }),
      );
      await awaitFirstMessage(ws);
      await new Promise((r) => setTimeout(r, 50));
      expect(pinned).toEqual([]);
      ws.close();
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("rejects WS upgrade from an extension origin that does not match the pin", async () => {
    const fixture = await startBridge({ pinnedExtensionId: "aaaabbbb" });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/`, {
        headers: { Origin: "chrome-extension://ccccdddd" },
      });
      await new Promise<void>((resolve) => {
        ws.once("error", () => resolve());
        ws.once("unexpected-response", () => resolve());
      });
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("still accepts WS upgrade from the pinned extension origin", async () => {
    const fixture = await startBridge({ pinnedExtensionId: "aaaabbbb" });
    try {
      const ws = connect(fixture.port, "chrome-extension://aaaabbbb");
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(
        JSON.stringify({
          type: "hello",
          token: VALID_TOKEN,
          protocol_version: PROTOCOL_VERSION,
          extension_version: "test",
        }),
      );
      const ack = (await awaitFirstMessage(ws)) as Record<string, unknown>;
      expect(ack["type"]).toBe("hello_ack");
      ws.close();
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("rejects /pair from an extension origin that does not match the pin", async () => {
    const fixture = await startBridge({ pinnedExtensionId: "aaaabbbb" });
    try {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/pair`, {
        headers: { Origin: "chrome-extension://ccccdddd" },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("extension_pinned");
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("accepts /pair from the pinned extension origin", async () => {
    const fixture = await startBridge({ pinnedExtensionId: "aaaabbbb" });
    try {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/pair`, {
        headers: { Origin: "chrome-extension://aaaabbbb" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        code?: string;
        token?: string;
        bridge_version?: string;
      };
      expect(body.token).toBe(VALID_TOKEN);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("sets Cache-Control: no-store on /pair so the browser never caches a 410", async () => {
    // 410 "already_paired" is cacheable by default; a cached copy would be
    // replayed across bridge restarts and wedge re-pairing. The 200 path here
    // and every other /pair response must carry no-store.
    const fixture = await startBridge({ pinnedExtensionId: "aaaabbbb" });
    try {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/pair`, {
        headers: { Origin: "chrome-extension://aaaabbbb" },
      });
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("re-pairs the pinned extension after the token was already consumed", async () => {
    // The pinned extension reinstalled / cleared storage and asks again. It is
    // the already-trusted origin reclaiming its own token, so this must NOT
    // require a bridge restart (no 410).
    const fixture = await startBridge({ pinnedExtensionId: "aaaabbbb" });
    try {
      const first = await fetch(`http://127.0.0.1:${fixture.port}/pair`, {
        headers: { Origin: "chrome-extension://aaaabbbb" },
      });
      expect(first.status).toBe(200);

      const second = await fetch(`http://127.0.0.1:${fixture.port}/pair`, {
        headers: { Origin: "chrome-extension://aaaabbbb" },
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as { token?: string };
      expect(body.token).toBe(VALID_TOKEN);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("still returns 410 for a second /pair from a different origin before any pin is set", async () => {
    // Race-guard: token handed out but the recipient hasn't connected yet (no
    // pin). A different, unidentifiable origin must not be able to grab it.
    const fixture = await startBridge();
    try {
      const first = await fetch(`http://127.0.0.1:${fixture.port}/pair`, {
        headers: { Origin: "chrome-extension://aaaabbbb" },
      });
      expect(first.status).toBe(200);

      const second = await fetch(`http://127.0.0.1:${fixture.port}/pair`, {
        headers: { Origin: "chrome-extension://ccccdddd" },
      });
      expect(second.status).toBe(410);
      const body = (await second.json()) as { error?: string };
      expect(body.error).toBe("already_paired");
    } finally {
      await fixture.bridge.stop();
    }
  });
});

describe("WSBridge /status endpoint", () => {
  it("returns pair_consumed=false, extension_connected=false on a fresh bridge", async () => {
    const fixture = await startBridge();
    try {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pair_consumed?: boolean;
        extension_connected?: boolean;
        extension_id?: string | null;
      };
      expect(body.pair_consumed).toBe(false);
      expect(body.extension_connected).toBe(false);
      expect(body.extension_id).toBeNull();
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("reflects pair_consumed after /pair is hit", async () => {
    const fixture = await startBridge();
    try {
      await fetch(`http://127.0.0.1:${fixture.port}/pair`, {
        headers: { Origin: "chrome-extension://aaaabbbb" },
      });
      const res = await fetch(`http://127.0.0.1:${fixture.port}/status`);
      const body = (await res.json()) as { pair_consumed?: boolean };
      expect(body.pair_consumed).toBe(true);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("reflects extension_connected=true and the pinned ID after hello", async () => {
    const fixture = await startBridge();
    try {
      const ws = connect(fixture.port, "chrome-extension://aaaabbbb");
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(
        JSON.stringify({
          type: "hello",
          token: VALID_TOKEN,
          protocol_version: PROTOCOL_VERSION,
          extension_version: "test",
        }),
      );
      await awaitFirstMessage(ws);
      const res = await fetch(`http://127.0.0.1:${fixture.port}/status`);
      const body = (await res.json()) as {
        extension_connected?: boolean;
        extension_id?: string | null;
      };
      expect(body.extension_connected).toBe(true);
      expect(body.extension_id).toBe("aaaabbbb");
      ws.close();
    } finally {
      await fixture.bridge.stop();
    }
  });
});

describe("WSBridge POST /launch", () => {
  function recorder(outcome: LaunchOutcome = { ok: true }) {
    const seen: LaunchRequestParams[] = [];
    const onLaunch = async (params: LaunchRequestParams): Promise<LaunchOutcome> => {
      seen.push(params);
      return outcome;
    };
    return { onLaunch, seen };
  }

  function postLaunch(
    port: number,
    body: unknown,
    origin: string | undefined = PIN_ORIGIN,
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/launch`, {
      method: "POST",
      headers: origin
        ? { "content-type": "application/json", Origin: origin }
        : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("launches and maps body fields (site_name → siteName) when token + origin are valid", async () => {
    const rec = recorder();
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: rec.onLaunch });
    try {
      const res = await postLaunch(fixture.port, {
        token: VALID_TOKEN,
        url: "https://x.test/a",
        title: "T",
        description: "D",
        site_name: "S",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(rec.seen).toEqual([
        { url: "https://x.test/a", title: "T", description: "D", siteName: "S" },
      ]);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("forwards agent + instruction to the launch handler", async () => {
    const rec = recorder();
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: rec.onLaunch });
    try {
      const res = await postLaunch(fixture.port, {
        token: VALID_TOKEN,
        agent: "claude",
        instruction: "summarize this page",
        url: "https://x.test",
      });
      expect(res.status).toBe(200);
      expect(rec.seen[0]?.agent).toBe("claude");
      expect(rec.seen[0]?.instruction).toBe("summarize this page");
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("rejects a wrong token with 401 and never calls onLaunch", async () => {
    const rec = recorder();
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: rec.onLaunch });
    try {
      const res = await postLaunch(fixture.port, { token: "nope", url: "https://x.test" });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error?: string }).error).toBe("unauthorized");
      expect(rec.seen).toHaveLength(0);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("rejects a missing token with 401", async () => {
    const rec = recorder();
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: rec.onLaunch });
    try {
      const res = await postLaunch(fixture.port, { url: "https://x.test" });
      expect(res.status).toBe(401);
      expect(rec.seen).toHaveLength(0);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("rejects a non-pinned chrome-extension origin with 403 extension_pinned", async () => {
    const rec = recorder();
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: rec.onLaunch });
    try {
      const res = await postLaunch(
        fixture.port,
        { token: VALID_TOKEN, url: "https://x.test" },
        "chrome-extension://ccccdddd",
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error?: string }).error).toBe("extension_pinned");
      expect(rec.seen).toHaveLength(0);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("rejects a web-page origin with 403 even if it somehow had the token", async () => {
    const rec = recorder();
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: rec.onLaunch });
    try {
      const res = await postLaunch(
        fixture.port,
        { token: VALID_TOKEN, url: "https://x.test" },
        "https://evil.com",
      );
      expect(res.status).toBe(403);
      expect(rec.seen).toHaveLength(0);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("allows an empty Origin with a valid token (host_permissions case)", async () => {
    const rec = recorder();
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: rec.onLaunch });
    try {
      const res = await postLaunch(
        fixture.port,
        { token: VALID_TOKEN, url: "https://x.test" },
        undefined,
      );
      expect(res.status).toBe(200);
      expect(rec.seen).toHaveLength(1);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("returns 502 with the error when the launch handler reports failure", async () => {
    const rec = recorder({ ok: false, error: "no_terminal" });
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: rec.onLaunch });
    try {
      const res = await postLaunch(fixture.port, { token: VALID_TOKEN, url: "https://x.test" });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: "no_terminal" });
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("returns 503 launch_unavailable when no onLaunch is wired", async () => {
    const fixture = await startBridge({ pinnedExtensionId: PIN });
    try {
      const res = await postLaunch(fixture.port, { token: VALID_TOKEN, url: "https://x.test" });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error?: string }).error).toBe("launch_unavailable");
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("returns 400 on malformed JSON", async () => {
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: recorder().onLaunch });
    try {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: PIN_ORIGIN },
        body: "{ not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("rejects non-POST methods with 405", async () => {
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: recorder().onLaunch });
    try {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/launch`, {
        method: "GET",
        headers: { Origin: PIN_ORIGIN },
      });
      expect(res.status).toBe(405);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("answers an OPTIONS preflight with CORS headers", async () => {
    const fixture = await startBridge({ pinnedExtensionId: PIN, onLaunch: recorder().onLaunch });
    try {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/launch`, {
        method: "OPTIONS",
        headers: { Origin: PIN_ORIGIN },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    } finally {
      await fixture.bridge.stop();
    }
  });
});

describe("WSBridge /chat/*", () => {
  function fakeChat() {
    const sent: { id: string; text: string }[] = [];
    const terminals: { id: string; mode: string }[] = [];
    const sessions: (SessionRef & { lastActive: number })[] = [];
    const ptyWrites: string[] = [];
    const ptyResizes: { cols: number; rows: number }[] = [];
    const chat: ChatService = {
      async start(params) {
        const ref: SessionRef = {
          agent: "claude",
          sessionId: "s1",
          cwd: "/w",
          createdAt: 1,
          ...(params.instruction !== undefined ? { title: params.instruction } : {}),
        };
        sessions.unshift({ ...ref, lastActive: 1 });
        return ref;
      },
      async send(id, text) {
        if (id === "missing") throw new EngineError("unknown_session");
        if (id === "noterm") throw new EngineError("pty_unavailable");
        sent.push({ id, text });
      },
      async subscribe(id, listener) {
        if (id === "missing") throw new EngineError("unknown_session");
        listener({ type: "status", state: "thinking" }); // exercises replay-before-headers
        return () => {};
      },
      async history(id) {
        if (id === "missing") throw new EngineError("unknown_session");
        return [{ id: "m", role: "assistant", blocks: [{ kind: "text", text: "hist" }] }];
      },
      async listSessions() {
        return sessions;
      },
      async terminal(id, mode) {
        terminals.push({ id, mode });
        return { ok: true };
      },
      attachTerminal(id) {
        if (id === "missing") throw new EngineError("unknown_session");
        return {
          onData: (cb) => {
            cb("REPLAY"); // simulated scrollback replay on attach
            return () => {};
          },
          write: (d) => void ptyWrites.push(d),
          resize: (cols, rows) => void ptyResizes.push({ cols, rows }),
        };
      },
    };
    return { chat, sent, terminals, sessions, ptyWrites, ptyResizes };
  }

  function postChat(
    port: number,
    path: string,
    body: unknown,
    origin: string | undefined = PIN_ORIGIN,
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: origin
        ? { "content-type": "application/json", Origin: origin }
        : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function getChat(port: number, path: string, origin = PIN_ORIGIN): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, { headers: { Origin: origin } });
  }

  /** Read an SSE body until `needle` appears or a timeout cancels it. */
  async function readStream(res: Response, needle: string, ms = 1500): Promise<string> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), ms);
    try {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
      }
    } catch {
      /* cancelled */
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
    }
    return buf;
  }

  it("POST /chat/new starts a session and returns its ref", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      const res = await postChat(fixture.port, "/chat/new", {
        token: VALID_TOKEN,
        agent: "claude",
        instruction: "hello",
        url: "https://x.test",
        title: "T",
        site_name: "S",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; session: SessionRef & { title?: string } };
      expect(body.ok).toBe(true);
      expect(body.session.sessionId).toBe("s1");
      expect(body.session.title).toBe("hello");
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("POST /chat/new is gated by token and origin-pin", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      expect((await postChat(fixture.port, "/chat/new", { token: "nope", url: "x" })).status).toBe(
        401,
      );
      expect(
        (
          await postChat(
            fixture.port,
            "/chat/new",
            { token: VALID_TOKEN, url: "x" },
            "https://evil.com",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await postChat(
            fixture.port,
            "/chat/new",
            { token: VALID_TOKEN, url: "x" },
            "chrome-extension://ccccdddd",
          )
        ).status,
      ).toBe(403);
      expect(f.sessions).toHaveLength(0);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("POST /chat/* returns 503 chat_unavailable when no chat service is wired", async () => {
    const fixture = await startBridge({ pinnedExtensionId: PIN });
    try {
      const res = await postChat(fixture.port, "/chat/new", { token: VALID_TOKEN, url: "x" });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error?: string }).error).toBe("chat_unavailable");
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("POST /chat/send routes the turn; bad input → 400; unknown session → 404; pty_unavailable → 503", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      expect(
        (
          await postChat(fixture.port, "/chat/send", {
            token: VALID_TOKEN,
            session_id: "s1",
            text: "hi",
          })
        ).status,
      ).toBe(200);
      expect(f.sent).toEqual([{ id: "s1", text: "hi" }]);
      expect(
        (await postChat(fixture.port, "/chat/send", { token: VALID_TOKEN, session_id: "s1" }))
          .status,
      ).toBe(400);
      expect(
        (
          await postChat(fixture.port, "/chat/send", {
            token: VALID_TOKEN,
            session_id: "missing",
            text: "hi",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await postChat(fixture.port, "/chat/send", {
            token: VALID_TOKEN,
            session_id: "noterm",
            text: "hi",
          })
        ).status,
      ).toBe(503);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("POST /chat/terminal forwards a valid mode; rejects an invalid one", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      const ok = await postChat(fixture.port, "/chat/terminal", {
        token: VALID_TOKEN,
        session_id: "s1",
        mode: "mirror",
      });
      expect(ok.status).toBe(200);
      expect(f.terminals).toEqual([{ id: "s1", mode: "mirror" }]);
      const bad = await postChat(fixture.port, "/chat/terminal", {
        token: VALID_TOKEN,
        session_id: "s1",
        mode: "explode",
      });
      expect(bad.status).toBe(400);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("GET /chat/sessions lists sessions (token in query)", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      await postChat(fixture.port, "/chat/new", { token: VALID_TOKEN, url: "x" });
      const res = await getChat(fixture.port, `/chat/sessions?token=${VALID_TOKEN}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: { sessionId: string }[] };
      expect(body.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
      expect((await getChat(fixture.port, `/chat/sessions?token=wrong`)).status).toBe(401);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("GET /chat/history returns normalized messages; unknown → 404", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      const res = await getChat(fixture.port, `/chat/history?token=${VALID_TOKEN}&session_id=s1`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: { role: string }[] };
      expect(body.messages.map((m) => m.role)).toEqual(["assistant"]);
      expect((await getChat(fixture.port, `/chat/history?token=${VALID_TOKEN}`)).status).toBe(400);
      expect(
        (await getChat(fixture.port, `/chat/history?token=${VALID_TOKEN}&session_id=missing`))
          .status,
      ).toBe(404);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("GET /chat/stream is an SSE feed that replays buffered events", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      const res = await getChat(fixture.port, `/chat/stream?token=${VALID_TOKEN}&session_id=s1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await readStream(res, "thinking");
      expect(text).toContain(`"state":"thinking"`);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("GET /chat/stream maps a wrong token to 401 and an unknown session to 404", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      expect((await getChat(fixture.port, `/chat/stream?token=wrong&session_id=s1`)).status).toBe(
        401,
      );
      const unknown = await getChat(
        fixture.port,
        `/chat/stream?token=${VALID_TOKEN}&session_id=missing`,
      );
      expect(unknown.status).toBe(404);
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("WS /chat/pty bridges raw output out and JSON input/resize in", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${fixture.port}/chat/pty?token=${VALID_TOKEN}&session_id=s1`,
        { headers: { Origin: PIN_ORIGIN } },
      );
      const got: string[] = [];
      ws.on("message", (d) => got.push(d.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await waitFor(() => got.includes("REPLAY")); // scrollback replay on attach
      ws.send(JSON.stringify({ type: "input", data: "hi there" }));
      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      await waitFor(() => f.ptyWrites.length > 0 && f.ptyResizes.length > 0);
      expect(f.ptyWrites).toEqual(["hi there"]);
      expect(f.ptyResizes).toEqual([{ cols: 80, rows: 24 }]);
      ws.close();
    } finally {
      await fixture.bridge.stop();
    }
  });

  it("WS /chat/pty rejects a bad token at the upgrade", async () => {
    const f = fakeChat();
    const fixture = await startBridge({ pinnedExtensionId: PIN, chat: f.chat });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/chat/pty?token=nope&session_id=s1`, {
        headers: { Origin: PIN_ORIGIN },
      });
      const outcome = await new Promise<string>((resolve) => {
        ws.on("open", () => resolve("opened"));
        ws.on("error", () => resolve("rejected"));
      });
      expect(outcome).toBe("rejected");
    } finally {
      await fixture.bridge.stop();
    }
  });
});
