export {};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

const statusPill = $<HTMLSpanElement>("status");
const killBtn = $<HTMLButtonElement>("kill");
const optionsLink = $<HTMLAnchorElement>("options");
const yoloBox = $<HTMLInputElement>("yolo");
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

function renderStatus(connected: boolean): void {
  statusPill.textContent = connected ? "connected" : "disconnected";
  statusPill.classList.toggle("on", connected);
  statusPill.classList.toggle("off", !connected);
  killBtn.disabled = !connected;
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
    chrome.storage.local.get("connected"),
    chrome.storage.session.get(["pendingSafetyPrompt", "autoApprove"]),
  ]);
  renderStatus(local["connected"] === true);
  const raw = session["pendingSafetyPrompt"];
  const prompt =
    raw !== undefined && raw !== null && typeof raw === "object"
      ? (raw as PendingSafetyPrompt)
      : null;
  renderSafety(prompt);
  yoloBox.checked = session["autoApprove"] === true;
}

yoloBox.addEventListener("change", () => {
  const next = yoloBox.checked;
  // The background service worker listens on storage.onChanged to update the
  // badge and to let the safety handler short-circuit future prompts.
  void (next
    ? chrome.storage.session.set({ autoApprove: true })
    : chrome.storage.session.remove("autoApprove"));
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
  chrome.runtime.sendMessage({ type: "kill_switch" }).catch(() => {});
  renderStatus(false);
});

optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.session.onChanged.addListener((changes) => {
  if ("pendingSafetyPrompt" in changes) void refresh();
});

void refresh();
window.setInterval(() => {
  void refresh();
}, 1000);
