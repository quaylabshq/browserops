/**
 * Anonymous installation ID stored at ~/.browserops/install-id. Created
 * on first run, persisted across daemon restarts and CLI invocations.
 *
 * Purpose: PostHog distinct_id. Distinct from the auth token at
 * ~/.browserops/token, which is a WS shared secret with the extension
 * and must never be sent over the network alongside any other data.
 *
 * Failure handling: a broken filesystem (permission errors, read-only
 * mount) falls back to a volatile in-memory UUID for the current
 * process. Telemetry still works, just without cross-restart continuity.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { STATE_DIR_NAME } from "@browserops/shared";

export const INSTALL_ID_FILENAME = "install-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function installIdPath(): string {
  return join(homedir(), STATE_DIR_NAME, INSTALL_ID_FILENAME);
}

export interface InstallIdResult {
  id: string;
  /** True iff this call generated and persisted a new ID. */
  created: boolean;
  /** True iff persistence failed and the ID is process-local only. */
  volatile: boolean;
}

export async function loadOrCreateInstallId(filePath?: string): Promise<InstallIdResult> {
  const path = filePath ?? installIdPath();

  try {
    const raw = (await fs.readFile(path, "utf8")).trim();
    if (UUID_RE.test(raw)) return { id: raw, created: false, volatile: false };
    // Malformed — fall through to regenerate.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Permission/IO error — keep a volatile ID for this process.
      return { id: randomUUID(), created: false, volatile: true };
    }
  }

  const id = randomUUID();
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, id + "\n", { mode: 0o600 });
    return { id, created: true, volatile: false };
  } catch {
    return { id, created: true, volatile: true };
  }
}
