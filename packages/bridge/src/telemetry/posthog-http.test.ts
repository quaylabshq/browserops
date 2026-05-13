import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostHogHttpClient } from "./posthog-http.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
  setResponse: (r: Response | (() => Promise<Response>)) => void;
} {
  const calls: FetchCall[] = [];
  let next: Response | (() => Promise<Response>) = new Response("", { status: 200 });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    setResponse: (r) => {
      next = r;
    },
  };
}

describe("PostHogHttpClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops captures when disabled", async () => {
    const f = makeFetch();
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: false,
      fetchImpl: f.fetchImpl,
    });
    c.capture("evt", { a: 1 });
    c.identify({ x: 2 });
    expect(c.queueSize).toBe(0);
    await c.flush();
    expect(f.calls.length).toBe(0);
  });

  it("queues captures and flushes on shutdown", async () => {
    const f = makeFetch();
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
      flushIntervalMs: 60_000,
    });
    c.capture("evt", { a: 1 });
    c.capture("evt2", { b: 2 });
    expect(c.queueSize).toBe(2);
    await c.shutdown(1000);
    expect(f.calls.length).toBe(1);
    const body = JSON.parse(String(f.calls[0]?.init.body)) as {
      api_key: string;
      batch: Array<{ event: string }>;
    };
    expect(body.api_key).toBe("k");
    expect(body.batch.map((e) => e.event)).toEqual(["evt", "evt2"]);
    expect(f.calls[0]?.url).toBe("https://x/batch/");
  });

  it("flushes immediately when queue reaches maxBatchSize", async () => {
    const f = makeFetch();
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
      flushIntervalMs: 60_000,
      maxBatchSize: 2,
    });
    c.capture("a", {});
    expect(f.calls.length).toBe(0);
    c.capture("b", {});
    // flush is fire-and-forget; let microtasks settle.
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(f.calls.length).toBe(1);
    const body = JSON.parse(String(f.calls[0]?.init.body)) as {
      batch: Array<{ event: string }>;
    };
    expect(body.batch).toHaveLength(2);
  });

  it("drops oldest events when queue exceeds maxQueueSize", () => {
    const f = makeFetch();
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
      flushIntervalMs: 60_000,
      maxBatchSize: 1000,
      maxQueueSize: 3,
    });
    c.capture("a", {});
    c.capture("b", {});
    c.capture("c", {});
    c.capture("d", {});
    c.capture("e", {});
    expect(c.queueSize).toBe(3);
  });

  it("alias enqueues a $create_alias event", async () => {
    const f = makeFetch();
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
    });
    c.alias("saket@example.com");
    await c.shutdown(1000);
    const body = JSON.parse(String(f.calls[0]?.init.body)) as {
      batch: Array<{ event: string; properties: Record<string, unknown> }>;
    };
    expect(body.batch[0]?.event).toBe("$create_alias");
    expect(body.batch[0]?.properties).toMatchObject({
      alias: "saket@example.com",
      distinct_id: "did",
    });
  });

  it("identify includes $set and $set_once", async () => {
    const f = makeFetch();
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
    });
    c.identify({ a: 1 }, { first_seen: "2024-01-01" });
    await c.shutdown(1000);
    const body = JSON.parse(String(f.calls[0]?.init.body)) as {
      batch: Array<{
        event: string;
        $set: Record<string, unknown>;
        $set_once: Record<string, unknown>;
      }>;
    };
    expect(body.batch[0]?.event).toBe("$identify");
    expect(body.batch[0]?.$set).toEqual({ a: 1 });
    expect(body.batch[0]?.$set_once).toEqual({ first_seen: "2024-01-01" });
  });

  it("swallows fetch failures via onError", async () => {
    const f = makeFetch();
    f.setResponse(() => Promise.reject(new Error("boom")));
    const errors: unknown[] = [];
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
      onError: (e) => errors.push(e),
    });
    c.capture("a", {});
    await c.shutdown(1000);
    expect(errors).toHaveLength(1);
    expect(c.queueSize).toBe(0); // batch was dropped, not re-queued
  });

  it("treats non-2xx as failure", async () => {
    const f = makeFetch();
    f.setResponse(new Response("nope", { status: 500 }));
    const errors: unknown[] = [];
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
      onError: (e) => errors.push(e),
    });
    c.capture("a", {});
    await c.shutdown(1000);
    expect(errors).toHaveLength(1);
  });

  it("shutdown returns even if flush hangs", async () => {
    const f = makeFetch();
    f.setResponse(() => new Promise<Response>(() => {})); // never resolves
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
    });
    c.capture("a", {});
    const start = Date.now();
    const shutdown = c.shutdown(50);
    await vi.advanceTimersByTimeAsync(60);
    await shutdown;
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("strips trailing slashes from host", async () => {
    const f = makeFetch();
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x///",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
    });
    c.capture("a", {});
    await c.shutdown(1000);
    expect(f.calls[0]?.url).toBe("https://x/batch/");
  });

  it("enabled=false after shutdown", async () => {
    const f = makeFetch();
    const c = new PostHogHttpClient({
      apiKey: "k",
      host: "https://x",
      distinctId: "did",
      enabled: true,
      fetchImpl: f.fetchImpl,
    });
    expect(c.enabled).toBe(true);
    await c.shutdown(50);
    expect(c.enabled).toBe(false);
    c.capture("a", {});
    expect(c.queueSize).toBe(0);
  });
});
