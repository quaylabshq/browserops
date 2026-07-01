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
const viewAlready = $<HTMLDivElement>("view-already");
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
const copyRestartBtn = $<HTMLButtonElement>("copy-restart");
const restartCmd = $<HTMLElement>("restart-cmd");
const alreadyStatus = $<HTMLSpanElement>("already-status");

type View = "loading" | "ready" | "error" | "paired" | "already" | "consumed";

function show(view: View): void {
  viewLoading.hidden = view !== "loading";
  viewReady.hidden = view !== "ready";
  viewError.hidden = view !== "error";
  viewPaired.hidden = view !== "paired";
  viewAlready.hidden = view !== "already";
  viewConsumed.hidden = view !== "consumed";
}

async function hasStoredToken(): Promise<boolean> {
  const s = await chrome.storage.local.get("token");
  return typeof s["token"] === "string" && s["token"].length > 0;
}

// Live connection pill for the "already set up" view. The background SW writes
// `connected` to storage.local; poll it so the user sees the real state rather
// than a static claim.
let alreadyStatusTimer: ReturnType<typeof setInterval> | null = null;
function startAlreadyStatusPoll(): void {
  const tick = (): void => {
    void chrome.storage.local.get("connected").then((s) => {
      const connected = s["connected"] === true;
      alreadyStatus.textContent = connected ? "Connected" : "Connecting…";
      alreadyStatus.classList.toggle("pill--on", connected);
      alreadyStatus.classList.toggle("pill--off", !connected);
    });
  };
  tick();
  if (alreadyStatusTimer === null) alreadyStatusTimer = setInterval(tick, 1000);
}

// Already-paired path: this extension holds a token, so a one-shot /pair
// refusal (or a reopened tab) is benign. Nudge a reconnect (a no-op if the
// socket is already live) and show the live status instead of an error.
function showAlready(): void {
  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  show("already");
  startAlreadyStatusPoll();
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
    // cache: "no-store" — bypass the browser HTTP cache entirely. A 410
    // "already_paired" is cacheable by default, and a cached one would be
    // replayed without ever reaching the (possibly restarted) bridge,
    // permanently wedging re-pairing. Never read or write the cache here.
    res = await fetch(url, { method: "GET", cache: "no-store" });
  } catch (err) {
    errorMsg.textContent =
      `Couldn't reach ${url}. Make sure the bridge is running ` +
      `(your MCP client should spawn it automatically once configured). ` +
      `Details: ${err instanceof Error ? err.message : String(err)}`;
    show("error");
    return;
  }

  if (res.status === 410) {
    // The pair endpoint is one-shot. If this extension already holds a token,
    // it's the paired one — surface the friendly "already set up" state. Only
    // when we have no token is 410 a genuine dead-end (another extension
    // claimed the token, or a stale bridge process), which needs a restart.
    if (await hasStoredToken()) showAlready();
    else show("consumed");
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
  // Hand the freshly-paired user off to the welcome page after a beat so they
  // see the "Paired" confirmation and the check animation first.
  window.setTimeout(() => {
    window.location.href = "https://www.browserops.ai/welcome";
  }, 5000);
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

// Copy-to-clipboard for a command chip: writes the source element's text and
// flips the button label to "Copied" for 1.5s, falling back to selecting the
// text if the clipboard write is denied.
function wireCopy(btn: HTMLButtonElement, src: HTMLElement): void {
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  btn.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(src.textContent ?? "")
      .then(() => {
        btn.textContent = "Copied";
        if (resetTimer !== null) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          btn.textContent = "Copy";
        }, 1500);
      })
      .catch(() => {
        const range = document.createRange();
        range.selectNodeContents(src);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
  });
}
wireCopy(copyInstallBtn, installCmd);
wireCopy(copyRestartBtn, restartCmd);

// Boot. If this extension is already paired and connected, skip the /pair
// round-trip (which would just return 410) and go straight to the "already
// set up" view — the common case when a user reopens this tab.
void (async () => {
  const s = await chrome.storage.local.get(["token", "connected"]);
  const haveToken = typeof s["token"] === "string" && s["token"].length > 0;
  if (haveToken && s["connected"] === true) {
    showAlready();
    return;
  }
  await attemptPair("127.0.0.1", DEFAULT_WS_PORT);
})();
