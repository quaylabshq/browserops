import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Cross-platform "is Chrome installed?" check. Returns the platform-
 * native launch hint when found, otherwise null.
 *
 * We only look for Google Chrome — the browserops extension only ships
 * on the Chrome Web Store today (Brave/Arc/Edge support is a v1.5 flag).
 */
export function detectChrome(): { kind: "darwin" | "linux"; spawn: string[] } | null {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app",
      join(homedir(), "Applications/Google Chrome.app"),
    ];
    for (const path of candidates) {
      if (existsSync(path)) {
        return { kind: "darwin", spawn: ["open", "-a", "Google Chrome"] };
      }
    }
    return null;
  }
  if (process.platform === "linux") {
    for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      if (which(bin)) return { kind: "linux", spawn: [bin] };
    }
    return null;
  }
  return null;
}

/**
 * Open a URL in Chrome specifically. Falls back to silently doing nothing
 * when Chrome can't be located; callers should detect that case via
 * detectChrome() first and surface a useful error.
 *
 * Detaches the spawn so we don't block on Chrome's process lifetime —
 * the user's existing Chrome window picks up the URL and we don't care
 * when they close it.
 */
export function openInChrome(url: string): boolean {
  const chrome = detectChrome();
  if (chrome === null) return false;
  try {
    const [cmd, ...args] = chrome.spawn;
    if (cmd === undefined) return false;
    const proc = spawn(cmd, [...args, url], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

function which(bin: string): boolean {
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    if (existsSync(join(dir, bin))) return true;
  }
  return false;
}

/**
 * Where to send the user when Chrome is missing. Hosted by Google and
 * carries no UTM / tracking from us — keeps the install script's
 * abort-path link clean and stable.
 */
export const CHROME_DOWNLOAD_URL = "https://www.google.com/chrome/";

/**
 * Direct URL to the published browserops extension on the Chrome Web
 * Store. Hardcoded because the listing ID is stable for the lifetime of
 * the published extension; no need to thread it through config.
 */
export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/browserops/fcjcldlmaoincljnghkbhhalnjfmbhnp";
