// In-memory cache mapping observation tokens (short random ids) to the
// metadata needed to translate screenshot-space coordinates back to CSS
// pixels. Lives only in the service-worker memory — service-worker
// lifetime is short and the 30-second TTL is tighter than the SW
// usually stays alive, so loss-on-restart is acceptable.

const TTL_MS = 30_000;
const MAX_ENTRIES = 32;
const TOKEN_LEN = 12;

const TOKEN_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface ObservationMetadata {
  tab_id: number;
  css_pixel_dims: { w: number; h: number };
  screenshot_dims: { w: number; h: number };
  scale: number;
  scroll: { x: number; y: number };
  dpr: number;
  created_at: number;
  representation: string;
}

const cache = new Map<string, ObservationMetadata>();

function randomToken(): string {
  const buf = new Uint8Array(TOKEN_LEN);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < TOKEN_LEN; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < TOKEN_LEN; i++) {
    out += TOKEN_ALPHABET[(buf[i] ?? 0) % TOKEN_ALPHABET.length];
  }
  return out;
}

function evictOldest(): void {
  // Map iteration is insertion-ordered; the first key is the oldest.
  const oldest = cache.keys().next();
  if (!oldest.done) cache.delete(oldest.value);
}

export function put(meta: Omit<ObservationMetadata, "created_at">): string {
  purgeExpired();
  while (cache.size >= MAX_ENTRIES) evictOldest();
  const token = randomToken();
  cache.set(token, { ...meta, created_at: Date.now() });
  return token;
}

export function get(token: string): ObservationMetadata | null {
  const entry = cache.get(token);
  if (entry === undefined) return null;
  if (Date.now() - entry.created_at > TTL_MS) {
    cache.delete(token);
    return null;
  }
  // Re-insert to refresh LRU position.
  cache.delete(token);
  cache.set(token, entry);
  return entry;
}

export function purgeExpired(): void {
  const now = Date.now();
  for (const [token, entry] of cache) {
    if (now - entry.created_at > TTL_MS) cache.delete(token);
  }
}

/** @internal exposed for testing. */
export function _clear(): void {
  cache.clear();
}

/** @internal exposed for testing. */
export function _size(): number {
  return cache.size;
}
