/**
 * Minimal PostHog HTTP client. No SDK dependency — uses Node's built-in
 * fetch + AbortSignal.timeout (Node 18.17+). All capture/identify calls
 * are queued in memory and flushed in batches of up to maxBatchSize
 * either on a timer or when the queue fills.
 *
 * Failure modes are intentional, not bugs:
 *   - Network errors are swallowed via opts.onError (default no-op) so
 *     telemetry can never surface as a user-visible error.
 *   - Failed batches are dropped, never retried — the queue must not
 *     grow unbounded under sustained outages.
 *   - Queue overflow drops oldest events first (capacity is fixed).
 *   - Shutdown drain is bounded: queued events that don't fit the final
 *     in-flight flush are abandoned rather than blocking exit.
 */

export interface PostHogEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
  /** Person properties to set (overwrites). */
  $set?: Record<string, unknown>;
  /** Person properties to set only on first observation (e.g. first_seen). */
  $set_once?: Record<string, unknown>;
}

export interface PostHogClientOptions {
  apiKey: string;
  host: string;
  distinctId: string;
  enabled: boolean;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  requestTimeoutMs?: number;
  /** Override fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Optional error sink. Default is silent. */
  onError?: (err: unknown) => void;
}

interface ResolvedOptions {
  apiKey: string;
  host: string;
  distinctId: string;
  enabled: boolean;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
  onError: (err: unknown) => void;
}

const DEFAULT_HOST = "https://us.i.posthog.com";
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

export class PostHogHttpClient {
  private readonly opts: ResolvedOptions;
  private queue: PostHogEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inflightFlush: Promise<void> | null = null;
  private closed = false;

  constructor(options: PostHogClientOptions) {
    this.opts = {
      apiKey: options.apiKey,
      host: options.host || DEFAULT_HOST,
      distinctId: options.distinctId,
      enabled: options.enabled,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxQueueSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      onError: options.onError ?? ((): void => undefined),
    };
  }

  get enabled(): boolean {
    return this.opts.enabled && !this.closed;
  }

  /** Test/diagnostic accessor — not part of the public contract. */
  get queueSize(): number {
    return this.queue.length;
  }

  capture(event: string, properties: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.enqueue({
      event,
      distinct_id: this.opts.distinctId,
      properties,
      timestamp: new Date().toISOString(),
    });
  }

  identify(set: Record<string, unknown>, setOnce: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const e: PostHogEvent = {
      event: "$identify",
      distinct_id: this.opts.distinctId,
      properties: {},
      $set: set,
      timestamp: new Date().toISOString(),
    };
    if (Object.keys(setOnce).length > 0) e.$set_once = setOnce;
    this.enqueue(e);
  }

  private enqueue(e: PostHogEvent): void {
    this.queue.push(e);
    if (this.queue.length > this.opts.maxQueueSize) {
      // Drop oldest. Bounded queue beats unbounded growth under network
      // outage.
      this.queue.splice(0, this.queue.length - this.opts.maxQueueSize);
    }
    if (this.queue.length >= this.opts.maxBatchSize) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), this.opts.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.inflightFlush) return this.inflightFlush;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.opts.maxBatchSize);
    const body = JSON.stringify({
      api_key: this.opts.apiKey,
      batch: batch.map((e) => {
        const out: Record<string, unknown> = {
          event: e.event,
          distinct_id: e.distinct_id,
          properties: e.properties,
          timestamp: e.timestamp,
        };
        if (e.$set) out["$set"] = e.$set;
        if (e.$set_once) out["$set_once"] = e.$set_once;
        return out;
      }),
    });

    const url = `${this.opts.host.replace(/\/+$/, "")}/batch/`;
    this.inflightFlush = (async () => {
      try {
        const res = await this.opts.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
        });
        if (!res.ok) throw new Error(`posthog responded ${res.status}`);
      } catch (err) {
        this.opts.onError(err);
        // Drop the batch on failure. Re-enqueueing risks unbounded growth.
      } finally {
        this.inflightFlush = null;
      }
    })();
    return this.inflightFlush;
  }

  /**
   * Drain pending events. Returns when the queue is empty or when
   * timeoutMs has elapsed, whichever comes first. Events that don't
   * fit in the final in-flight batch are abandoned by design.
   */
  async shutdown(timeoutMs = 1_500): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0 && !this.inflightFlush) return;

    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        t.unref?.();
      }),
    ]);
  }
}
