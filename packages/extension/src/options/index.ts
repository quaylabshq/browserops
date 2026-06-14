import { DEFAULT_WS_PORT } from "@browserops/shared";
export {};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

const tokenInput = $<HTMLInputElement>("token");
const hostInput = $<HTMLInputElement>("host");
const portInput = $<HTMLInputElement>("port");
const form = $<HTMLFormElement>("form");
const statusPill = $<HTMLSpanElement>("status");
const saved = $<HTMLSpanElement>("saved");
const tokenCmd = $<HTMLElement>("token-cmd");
const copyTokenCmd = $<HTMLButtonElement>("copy-token-cmd");

async function loadValues(): Promise<void> {
  const s = await chrome.storage.local.get({ token: "", host: "127.0.0.1", port: DEFAULT_WS_PORT });
  tokenInput.value = typeof s["token"] === "string" ? s["token"] : "";
  hostInput.value = typeof s["host"] === "string" ? s["host"] : "127.0.0.1";
  portInput.value = String(typeof s["port"] === "number" ? s["port"] : DEFAULT_WS_PORT);
}

function renderStatus(connected: boolean): void {
  statusPill.textContent = connected ? "Connected" : "Disconnected";
  statusPill.classList.toggle("pill--on", connected);
  statusPill.classList.toggle("pill--off", !connected);
}

async function pollStatus(): Promise<void> {
  const s = await chrome.storage.local.get("connected");
  renderStatus(s["connected"] === true);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const port = Number.parseInt(portInput.value, 10);
  const next = {
    token: tokenInput.value.trim(),
    host: hostInput.value.trim() || "127.0.0.1",
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_WS_PORT,
  };
  void chrome.storage.local.set(next).then(() => {
    saved.classList.add("show");
    window.setTimeout(() => saved.classList.remove("show"), 1200);
    chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  });
});

let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
copyTokenCmd.addEventListener("click", () => {
  void navigator.clipboard
    .writeText(tokenCmd.textContent ?? "")
    .then(() => {
      copyTokenCmd.classList.add("copied");
      copyTokenCmd.title = "Copied";
      if (copyResetTimer !== null) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copyTokenCmd.classList.remove("copied");
        copyTokenCmd.title = "Copy command";
      }, 1500);
    })
    .catch(() => {
      // Clipboard write can be denied; fall back to selecting the text so the
      // user can copy manually rather than silently doing nothing.
      const range = document.createRange();
      range.selectNodeContents(tokenCmd);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
});

void loadValues();
void pollStatus();
window.setInterval(() => {
  void pollStatus();
}, 1000);
