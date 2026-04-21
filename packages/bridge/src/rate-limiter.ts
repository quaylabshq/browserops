import { RATE_LIMIT_PER_TAB_PER_MIN, RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT } from "@browserops/shared";

export interface TryConsumeResult {
  ok: boolean;
  retry_after_ms?: number;
  scope?: "tab" | "global";
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Token-bucket rate limiter. See plans/06-autonomy-safety.md §4.1.
 *
 * Per-tab capacity: 16 tokens, refill 16/60s (continuous).
 * Global capacity: 60 tokens, refill 60/60s (continuous).
 * Check global first; if it fails, no per-tab charge is made.
 */
export class RateLimiter {
  private readonly perTabCapacity: number;
  private readonly perTabRefillPerMs: number;
  private readonly globalCapacity: number;
  private readonly globalRefillPerMs: number;

  private readonly tabs = new Map<string, Bucket>();
  private global: Bucket;

  constructor(
    perTabCapacity: number = RATE_LIMIT_PER_TAB_PER_MIN,
    globalCapacity: number = RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.perTabCapacity = perTabCapacity;
    this.perTabRefillPerMs = perTabCapacity / 60_000;
    this.globalCapacity = globalCapacity;
    this.globalRefillPerMs = globalCapacity / 60_000;
    this.global = { tokens: globalCapacity, lastRefill: this.now() };
  }

  tryConsume(tabId: string, weight: number): TryConsumeResult {
    if (weight === 0) return { ok: true };

    const t = this.now();
    this.refill(this.global, this.globalCapacity, this.globalRefillPerMs, t);
    if (this.global.tokens < weight) {
      const retryMs = Math.ceil((weight - this.global.tokens) / this.globalRefillPerMs);
      return { ok: false, retry_after_ms: retryMs, scope: "global" };
    }

    const bucket = this.getOrCreateTab(tabId, t);
    this.refill(bucket, this.perTabCapacity, this.perTabRefillPerMs, t);
    if (bucket.tokens < weight) {
      const retryMs = Math.ceil((weight - bucket.tokens) / this.perTabRefillPerMs);
      return { ok: false, retry_after_ms: retryMs, scope: "tab" };
    }

    this.global.tokens -= weight;
    bucket.tokens -= weight;
    return { ok: true };
  }

  forgetTab(tabId: string): void {
    this.tabs.delete(tabId);
  }

  private getOrCreateTab(tabId: string, t: number): Bucket {
    let bucket = this.tabs.get(tabId);
    if (!bucket) {
      bucket = { tokens: this.perTabCapacity, lastRefill: t };
      this.tabs.set(tabId, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket, capacity: number, perMs: number, t: number): void {
    const elapsed = t - bucket.lastRefill;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * perMs);
    bucket.lastRefill = t;
  }
}
