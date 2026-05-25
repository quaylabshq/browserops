/**
 * Tiny eval harness for the browserops memory system.
 *
 * Evals are higher-level than unit tests: each one asserts a named, end-to-end
 * BEHAVIOR of the memory system (does delivery prime-once-then-suppress? does a
 * captured blocker stop the agent hitting the same wall twice?) and the runner
 * prints a capability-grouped scorecard with a non-zero exit on any failure.
 *
 * Cases run against the REAL memory modules (imported from packages/bridge and
 * @browserops/shared) inside an isolated temp store, so the user's real
 * ~/browserops/memory/ is never touched.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type Capability =
  | "schema"
  | "store"
  | "migrate"
  | "search"
  | "delivery"
  | "signals"
  | "trace"
  | "integration";

export interface EvalCtx {
  /** Isolated BROWSEROPS_MEMORY_DIR for this case (already set in process.env). */
  dir: string;
}

export interface EvalCase {
  id: string;
  capability: Capability;
  title: string;
  run: (ctx: EvalCtx) => Promise<void> | void;
}

const registry: EvalCase[] = [];

/** Register an eval case. Called at module load by every cases/*.eval.ts file. */
export function defineEval(c: EvalCase): void {
  if (registry.some((r) => r.id === c.id)) {
    throw new Error(`duplicate eval id: ${c.id}`);
  }
  registry.push(c);
}

export class EvalAssertionError extends Error {}

/** Assert a condition; throws an EvalAssertionError (treated as a clean fail). */
export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new EvalAssertionError(msg);
}

export function checkEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new EvalAssertionError(
      `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Assert that `fn` throws (optionally matching a substring of the message). */
export async function checkThrows(
  fn: () => Promise<unknown> | unknown,
  msg: string,
  matching?: string,
): Promise<void> {
  let threw = false;
  let err = "";
  try {
    await fn();
  } catch (e) {
    threw = true;
    err = e instanceof Error ? e.message : String(e);
  }
  check(threw, `${msg} — expected a throw, got none`);
  if (matching !== undefined) {
    check(
      err.toLowerCase().includes(matching.toLowerCase()),
      `${msg} — expected error matching "${matching}", got "${err}"`,
    );
  }
}

/**
 * Run `fn` with a fresh temp directory wired as BROWSEROPS_MEMORY_DIR, restoring
 * the prior value and deleting the temp dir afterwards. memoryRoot() reads the
 * env per call, so this fully isolates each case's on-disk store.
 */
export async function withTempStore<T>(
  fn: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "browserops-eval-"));
  const prev = process.env["BROWSEROPS_MEMORY_DIR"];
  process.env["BROWSEROPS_MEMORY_DIR"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["BROWSEROPS_MEMORY_DIR"];
    else process.env["BROWSEROPS_MEMORY_DIR"] = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

interface RunResult {
  id: string;
  capability: Capability;
  title: string;
  passed: boolean;
  ms: number;
  error?: string;
}

export interface RunOptions {
  filter?: string;
  json?: boolean;
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  bold: "\x1b[1m",
};

/** Run all registered cases (optionally filtered), print the scorecard, return an exit code. */
export async function runAll(opts: RunOptions = {}): Promise<number> {
  const cases = opts.filter
    ? registry.filter(
        (c) => c.capability === opts.filter || c.id.includes(opts.filter!),
      )
    : registry;

  const results: RunResult[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      await withTempStore(async () => {
        await c.run({ dir: process.env["BROWSEROPS_MEMORY_DIR"] as string });
      });
      results.push({
        id: c.id,
        capability: c.capability,
        title: c.title,
        passed: true,
        ms: Date.now() - t0,
      });
    } catch (e) {
      results.push({
        id: c.id,
        capability: c.capability,
        title: c.title,
        passed: false,
        ms: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  if (opts.json) {
    process.stdout.write(JSON.stringify({ passed, failed, cases: results }, null, 2) + "\n");
    return failed > 0 ? 1 : 0;
  }

  // Grouped scorecard.
  const byCap = new Map<Capability, RunResult[]>();
  for (const r of results) {
    const arr = byCap.get(r.capability) ?? [];
    arr.push(r);
    byCap.set(r.capability, arr);
  }

  process.stdout.write(`\n${C.bold}browserops memory evals${C.reset}\n`);
  for (const [cap, arr] of byCap) {
    const capPass = arr.every((r) => r.passed);
    const mark = capPass ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    process.stdout.write(`\n${mark} ${C.bold}${cap}${C.reset}\n`);
    for (const r of arr) {
      const m = r.passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      process.stdout.write(
        `  ${m} ${r.id} — ${r.title} ${C.dim}(${r.ms}ms)${C.reset}\n`,
      );
      if (!r.passed) process.stdout.write(`      ${C.red}${r.error}${C.reset}\n`);
    }
  }

  const summaryColor = failed > 0 ? C.red : C.green;
  process.stdout.write(
    `\n${summaryColor}${C.bold}${passed}/${results.length} passed${
      failed > 0 ? `, ${failed} failed` : ""
    }${C.reset}\n\n`,
  );

  return failed > 0 ? 1 : 0;
}
