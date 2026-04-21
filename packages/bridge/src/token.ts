import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stateDir, tokenPath } from "./paths.js";

const TOKEN_BYTES = 32;

/**
 * Reads the shared secret, generating a new one on first run.
 * Always returns a 64-char hex token. Emits a stderr notice when newly generated.
 */
export async function loadOrCreateToken(): Promise<string> {
  const path = tokenPath();
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      return existing;
    }
    process.stderr.write(
      `browserops: token at ${path} is malformed (expected 64 hex chars); regenerating.\n`,
    );
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err;
  }

  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await chmod(stateDir(), 0o700).catch(() => {
    // chmod may fail on Windows / rare filesystems — mkdir's mode is best-effort.
  });
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await writeFile(path, token + "\n", { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});

  process.stderr.write(
    `browserops: generated new token at ${path} — paste its contents into the extension's options page.\n`,
  );
  return token;
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Ensures the directory for a given file exists with restrictive perms. Used by the logger.
 */
export async function ensureStateDir(): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await chmod(stateDir(), 0o700).catch(() => {});
}

export function _dirnameOf(path: string): string {
  return dirname(path);
}
