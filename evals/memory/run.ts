/**
 * Entry point: `pnpm eval:memory` (optionally `-- --filter delivery` / `-- --json`).
 *
 * Every `cases/*.eval.ts` module is discovered and imported; importing it
 * triggers its defineEval() registrations as a side effect. runAll() then
 * executes the registered cases and sets the process exit code. Adding a new
 * eval is just dropping a `cases/<name>.eval.ts` file — no edits here.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runAll, type RunOptions } from "./harness.js";

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--filter") opts.filter = argv[++i];
    else if (a?.startsWith("--filter=")) opts.filter = a.slice("--filter=".length);
  }
  return opts;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, "cases");
const files = (await fs.readdir(casesDir)).filter((f) => f.endsWith(".eval.ts")).sort();
for (const f of files) {
  await import(path.join(casesDir, f));
}

const code = await runAll(parseArgs(process.argv.slice(2)));
process.exit(code);
