import { DEFAULT_WS_PORT } from "@browserops/shared";
export {};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

const viewLoading = $<HTMLDivElement>("view-loading");
const viewReady = $<HTMLDivElement>("view-ready");
const viewError = $<HTMLDivElement>("view-error");
const viewPaired = $<HTMLDivElement>("view-paired");
const viewConsumed = $<HTMLDivElement>("view-consumed");
const pairCodeEl = $<HTMLDivElement>("pair-code");
const retryBtn = $<HTMLButtonElement>("retry");
const errorMsg = $<HTMLParagraphElement>("error-msg");
const advHost = $<HTMLInputElement>("adv-host");
const advPort = $<HTMLInputElement>("adv-port");
const openOptionsBtn = $<HTMLButtonElement>("open-options");
const openOptionsBtn2 = $<HTMLButtonElement>("open-options-2");
const copyInstallBtn = $<HTMLButtonElement>("copy-install");
const installCmd = $<HTMLElement>("install-cmd");

type View = "loading" | "ready" | "error" | "paired" | "consumed";

function show(view: View): void {
  viewLoading.hidden = view !== "loading";
  viewReady.hidden = view !== "ready";
  viewError.hidden = view !== "error";
  viewPaired.hidden = view !== "paired";
  viewConsumed.hidden = view !== "consumed";
}

interface PairResponse {
  code: string;
  token: string;
  bridge_version: string;
}

let pendingPair: PairResponse | null = null;
let pendingHost = "127.0.0.1";
let pendingPort = DEFAULT_WS_PORT;

async function attemptPair(host: string, port: number): Promise<void> {
  show("loading");
  pendingHost = host;
  pendingPort = port;
  const url = `http://${host}:${port}/pair`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (err) {
    errorMsg.textContent =
      `Couldn't reach ${url}. Make sure the bridge is running ` +
      `(your MCP client should spawn it automatically once configured). ` +
      `Details: ${err instanceof Error ? err.message : String(err)}`;
    show("error");
    return;
  }

  if (res.status === 410) {
    show("consumed");
    return;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body ? ` — ${body}` : "";
    errorMsg.textContent = `Bridge replied ${res.status} ${res.statusText}${detail}.`;
    show("error");
    return;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    errorMsg.textContent = "Bridge returned a non-JSON response.";
    show("error");
    return;
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { code?: unknown }).code !== "string" ||
    typeof (body as { token?: unknown }).token !== "string"
  ) {
    errorMsg.textContent = "Bridge returned a malformed pair response.";
    show("error");
    return;
  }

  pendingPair = body as PairResponse;
  pairCodeEl.textContent = pendingPair.code;
  show("ready");
  // Auto-confirm: no human click. The bridge's first-pair-wins
  // extension-ID pin protects against a rogue extension racing this
  // call — once we successfully /pair, the bridge persists *this*
  // extension's chrome-extension://<id> origin and refuses all others.
  void completePair(pendingPair);
}

async function completePair(pair: PairResponse): Promise<void> {
  await chrome.storage.local.set({
    token: pair.token,
    host: pendingHost,
    port: pendingPort,
  });
  // Kick the background service worker to reconnect with the new token.
  try {
    await chrome.runtime.sendMessage({ type: "reconnect" });
  } catch {
    /* ignore */
  }
  show("paired");
}

retryBtn.addEventListener("click", () => {
  const hostVal = advHost.value.trim() || "127.0.0.1";
  const portVal = Number.parseInt(advPort.value, 10);
  const port = Number.isFinite(portVal) && portVal > 0 ? portVal : DEFAULT_WS_PORT;
  void attemptPair(hostVal, port);
});

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
}
openOptionsBtn.addEventListener("click", openOptions);
openOptionsBtn2.addEventListener("click", openOptions);

let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
copyInstallBtn.addEventListener("click", () => {
  void navigator.clipboard
    .writeText(installCmd.textContent ?? "")
    .then(() => {
      copyInstallBtn.textContent = "Copied";
      if (copyResetTimer !== null) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copyInstallBtn.textContent = "Copy";
      }, 1500);
    })
    .catch(() => {
      const range = document.createRange();
      range.selectNodeContents(installCmd);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
});

void attemptPair("127.0.0.1", DEFAULT_WS_PORT);
