import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CloseCode, HELLO_TIMEOUT_MS, PROTOCOL_VERSION } from "@browserops/shared";
import { WSBridge } from "./ws-server.js";
import type { Logger } from "./logger.js";

const VALID_TOKEN = "a".repeat(64);

function stubLogger(): Logger {
  return { async write() {} } as unknown as Logger;
}

interface BridgeFixture {
  bridge: WSBridge;
  port: number;
}

interface StartOpts {
  token?: string;
  pinnedExtensionId?: string | null;
  onExtensionPin?: (extId: string) => Promise<void>;
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
