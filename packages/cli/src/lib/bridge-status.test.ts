import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchBridgeStatus, waitForExtensionPair } from "./bridge-status.js";

interface FakeBridge {
  server: Server;
  port: number;
  setStatus: (s: {
    pair_consumed: boolean;
    extension_connected: boolean;
    extension_id: string | null;
  }) => void;
}

async function startFakeBridge(): Promise<FakeBridge> {
  let current = {
    pair_consumed: false,
    extension_connected: false,
    extension_id: null as string | null,
    bridge_version: "test-0.0.0",
  };
  const server = createServer((req, res) => {
    if (req.url === "/status") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(current));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    server,
    port: addr.port,
    setStatus: (s) => {
      current = { ...current, ...s };
    },
  };
}

let fixture: FakeBridge;

beforeEach(async () => {
  fixture = await startFakeBridge();
});

afterEach(async () => {
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
});

describe("fetchBridgeStatus", () => {
  it("returns the parsed body when /status is reachable", async () => {
    fixture.setStatus({ pair_consumed: false, extension_connected: false, extension_id: null });
    const status = await fetchBridgeStatus(fixture.port);
    expect(status?.pair_consumed).toBe(false);
    expect(status?.extension_connected).toBe(false);
    expect(status?.extension_id).toBeNull();
  });

  it("returns null when the bridge is unreachable", async () => {
    const status = await fetchBridgeStatus(1, "127.0.0.1", 200);
    expect(status).toBeNull();
  });
});

describe("waitForExtensionPair", () => {
  it("resolves ok:true as soon as extension_connected flips", async () => {
    const flipAfter = setTimeout(() => {
      fixture.setStatus({
        pair_consumed: true,
        extension_connected: true,
        extension_id: "aaaabbbb",
      });
    }, 200);
    try {
      const result = await waitForExtensionPair({
        port: fixture.port,
        intervalMs: 50,
        timeoutMs: 3_000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status.extension_id).toBe("aaaabbbb");
      }
    } finally {
      clearTimeout(flipAfter);
    }
  });

  it("fires onPairConsumed exactly once when pair_consumed transitions to true", async () => {
    let calls = 0;
    const flip = setTimeout(() => {
      fixture.setStatus({
        pair_consumed: true,
        extension_connected: false,
        extension_id: null,
      });
    }, 100);
    const flipConnected = setTimeout(() => {
      fixture.setStatus({
        pair_consumed: true,
        extension_connected: true,
        extension_id: "aaaabbbb",
      });
    }, 300);
    try {
      const result = await waitForExtensionPair({
        port: fixture.port,
        intervalMs: 50,
        timeoutMs: 3_000,
        onPairConsumed: () => {
          calls += 1;
        },
      });
      expect(result.ok).toBe(true);
      expect(calls).toBe(1);
    } finally {
      clearTimeout(flip);
      clearTimeout(flipConnected);
    }
  });

  it("resolves ok:false / timeout when the extension never connects", async () => {
    const result = await waitForExtensionPair({
      port: fixture.port,
      intervalMs: 50,
      timeoutMs: 400,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
  });
});
