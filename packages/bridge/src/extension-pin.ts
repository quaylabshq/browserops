import { chmod, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { extensionIdPath, stateDir } from "./paths.js";

// Chrome extension IDs are 32 lowercase letters in the range a-p. Tests use
// shorter ascii so we tolerate that here; the format check is paranoia, not
// security — the security boundary is "Origin equals the value we wrote".
const EXT_ID_RE = /^[a-z0-9-]{1,64}$/i;

/**
 * Read the pinned extension ID from `~/.browserops/extension_id`. Returns
 * null when the file is missing or malformed (treated as "not yet
 * pinned"). The bridge accepts the first hello on a fresh install and
 * writes this file via persistPinnedExtensionId.
 */
export async function loadPinnedExtensionId(): Promise<string | null> {
  try {
    const raw = (await readFile(extensionIdPath(), "utf8")).trim();
    if (!EXT_ID_RE.test(raw)) return null;
    return raw;
  } catch (err: unknown) {
    if (isENOENT(err)) return null;
    // Unreadable file → treat as unpinned, but don't throw — the bridge
    // should still come up. A subsequent successful hello will overwrite.
    process.stderr.write(
      `browserops: warn: could not read ${extensionIdPath()}: ${stringify(err)}\n`,
    );
    return null;
  }
}

/**
 * Persist a pinned extension ID with 0600 perms. Idempotent: writing the
 * same value over itself is a no-op for the caller. Called once on the
 * first successful WebSocket hello for a fresh install.
 */
export async function persistPinnedExtensionId(extensionId: string): Promise<void> {
  if (!EXT_ID_RE.test(extensionId)) {
    throw new Error(`refusing to persist malformed extension id: ${extensionId}`);
  }
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await chmod(stateDir(), 0o700).catch(() => {
    // chmod may fail on Windows / rare filesystems — mkdir's mode is best-effort.
  });
  await writeFile(extensionIdPath(), extensionId + "\n", { mode: 0o600 });
  await chmod(extensionIdPath(), 0o600).catch(() => {});
}

/**
 * Delete the pinned extension ID. Used by `browserops init --repair` to
 * allow re-pairing after a Chrome reinstall, profile reset, or extension
 * uninstall. No-op when the file does not exist.
 */
export async function clearPinnedExtensionId(): Promise<void> {
  try {
    await unlink(extensionIdPath());
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err;
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
