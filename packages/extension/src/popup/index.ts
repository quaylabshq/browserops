export {};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

const killBtn = $<HTMLButtonElement>("kill");
const optionsBtn = $<HTMLButtonElement>("options");
const statusPill = $<HTMLSpanElement>("status");
const yoloBox = $<HTMLInputElement>("yolo");
const setupPane = $<HTMLDivElement>("setup");
const runSetupBtn = $<HTMLButtonElement>("run-setup");
const mainPane = $<HTMLDivElement>("main");
const safetyPane = $<HTMLDivElement>("safety");
const safetyTool = $<HTMLDivElement>("safety-tool");
const safetyReason = $<HTMLDivElement>("safety-reason");
const safetyAllow = $<HTMLButtonElement>("safety-allow");
const safetyDeny = $<HTMLButtonElement>("safety-deny");

interface PendingSafetyPrompt {
  tool: string;
  params: Record<string, unknown>;
  reason: string;
  decision_id: string;
  timeout_ms: number;
  ts: number;
}

let connectedState = false;

// Single user-facing axis: connected ↔ disconnected. The backend "disabled"
// flag still exists (it controls whether the SW auto-reconnects on boot),
// but we don't surface it as its own state in the UI — the user just sees
// the consequence: not connected.
function renderStatus(connected: boolean): void {
  connectedState = connected;
  statusPill.className = "pill";
  if (connected) {
    statusPill.textContent = "Connected";
    statusPill.classList.add("pill--on");
    killBtn.textContent = "Disconnect";
    killBtn.classList.add("btn--danger");
  } else {
    statusPill.textContent = "Disconnected";
    statusPill.classList.add("pill--off");
    killBtn.textContent = "Connect";
    killBtn.classList.remove("btn--danger");
  }
  killBtn.disabled = false;
}

function renderSetup(hasToken: boolean): void {
  setupPane.classList.toggle("active", !hasToken);
  mainPane.classList.toggle("unconfigured", !hasToken);
}

function renderSafety(prompt: PendingSafetyPrompt | null): void {
  if (prompt === null) {
    safetyPane.classList.remove("active");
    mainPane.classList.remove("hidden");
    return;
  }
  safetyTool.textContent = prompt.tool;
  safetyReason.textContent = prompt.reason;
  safetyPane.classList.add("active");
  mainPane.classList.add("hidden");
}

async function refresh(): Promise<void> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(["connected", "token"]),
    chrome.storage.session.get(["pendingSafetyPrompt", "requireApproval", "autoApprove"]),
  ]);

  // Migration: if old autoApprove key exists, translate to new requireApproval key
  if (session["autoApprove"] !== undefined && session["requireApproval"] === undefined) {
    const requireApproval = !session["autoApprove"];
    if (requireApproval) {
      await chrome.storage.session.set({ requireApproval });
    }
    await chrome.storage.session.remove("autoApprove");
  }

  const hasToken = typeof local["token"] === "string" && local["token"].length > 0;
  renderSetup(hasToken);
  renderStatus(local["connected"] === true);
  const raw = session["pendingSafetyPrompt"];
  const prompt =
    raw !== undefined && raw !== null && typeof raw === "object"
      ? (raw as PendingSafetyPrompt)
      : null;
  renderSafety(prompt);

  // checked = requireApproval = true; unchecked = auto-approve (default)
  yoloBox.checked = session["requireApproval"] === true;
}

yoloBox.addEventListener("change", () => {
  const requireApproval = yoloBox.checked;
  // The background service worker listens on storage.onChanged to update the
  // toolbar icon (yellow when auto-approve is on).
  void (requireApproval
    ? chrome.storage.session.set({ requireApproval: true })
    : chrome.storage.session.remove("requireApproval"));
});

function sendDecision(allow: boolean): void {
  void chrome.storage.session.get("pendingSafetyPrompt").then((s) => {
    const raw = s["pendingSafetyPrompt"];
    if (raw === undefined || raw === null || typeof raw !== "object") return;
    const decision_id = (raw as { decision_id?: unknown }).decision_id;
    if (typeof decision_id !== "string") return;
    safetyAllow.disabled = true;
    safetyDeny.disabled = true;
    chrome.runtime
      .sendMessage({ type: "safety_decision", decision_id, allow })
      .catch(() => {})
      .finally(() => {
        safetyAllow.disabled = false;
        safetyDeny.disabled = false;
        void refresh();
      });
  });
}

safetyAllow.addEventListener("click", () => sendDecision(true));
safetyDeny.addEventListener("click", () => sendDecision(false));

killBtn.addEventListener("click", () => {
  if (connectedState) {
    // Connected → Disconnect: stop the WS and set the persistent "disabled"
    // flag in storage so the SW does not auto-reconnect on next boot.
    chrome.runtime.sendMessage({ type: "kill_switch" }).catch(() => {});
    renderStatus(false);
  } else {
    // Disconnected → Connect: clear the "disabled" flag and start the WS.
    killBtn.disabled = true;
    chrome.runtime
      .sendMessage({ type: "reconnect" })
      .catch(() => {})
      .finally(() => {
        void refresh();
      });
  }
});

optionsBtn.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

runSetupBtn.addEventListener("click", () => {
  const url = chrome.runtime.getURL("src/onboard/index.html");
  chrome.tabs.create({ url }).catch(() => {});
  window.close();
});

chrome.storage.session.onChanged.addListener((changes) => {
  if ("pendingSafetyPrompt" in changes) void refresh();
});

void refresh();
window.setInterval(() => {
  void refresh();
}, 1000);
