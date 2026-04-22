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
const pinBtn = $<HTMLButtonElement>("pin");
const unpinBtn = $<HTMLButtonElement>("unpin");
const pinnedEmpty = $<HTMLDivElement>("pinned-empty");
const pinnedInfo = $<HTMLDivElement>("pinned-info");
const pinnedTitle = $<HTMLDivElement>("pinned-title");
const pinnedUrl = $<HTMLDivElement>("pinned-url");
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

async function renderPinned(): Promise<void> {
  const s = await chrome.storage.local.get("pinnedTabId");
  // Storage shape is now a number (Chrome tab id); string is the old shape
  // kept for migration compatibility. Either way a truthy value means pinned.
  const hasPinned = typeof s["pinnedTabId"] === "number" || typeof s["pinnedTabId"] === "string";
  if (!hasPinned) {
    pinnedEmpty.hidden = false;
    pinnedInfo.hidden = true;
    pinBtn.hidden = false;
    unpinBtn.hidden = true;
    return;
  }
  // Look up the chrome tab for the pinned tab_id by querying all tabs. We
  // don't keep the chromeId↔tab_id map in the popup; the popup stays thin.
  // If we can't resolve (tabs not connected yet, tab closed while we were
  // closed), show the pin-id only — the background will clean up eventually.
  const allTabs = await chrome.tabs.query({});
  let matched: chrome.tabs.Tab | undefined;
  // We only have the opaque tab_id string; resolve via a roundtrip through
  // the background which owns the mapping. For now, show the URL of the
  // currently-focused window's active tab if pinned matches nothing — the
  // best-effort title will get repainted once the bridge round-trips.
  for (const t of allTabs) {
    if (t.url !== undefined || t.title !== undefined) matched = matched ?? t;
  }
  // Ask the background for the pinned tab's metadata via a thin message so
  // we don't recreate tab-map state in the popup.
  try {
    const resp = (await chrome.runtime.sendMessage({ type: "describe_pinned" })) as
      | { ok: true; tab_id: string; url: string; title: string }
      | { ok: false; error: string }
      | undefined;
    if (resp && resp.ok === true) {
      pinnedTitle.textContent = resp.title.length > 0 ? resp.title : "(untitled)";
      pinnedUrl.textContent = resp.url;
      pinnedEmpty.hidden = true;
      pinnedInfo.hidden = false;
      pinBtn.hidden = true;
      unpinBtn.hidden = false;
      return;
    }
  } catch {
    /* fall through to placeholder */
  }
  // Placeholder when background can't resolve (e.g. tab closed mid-pin).
  pinnedTitle.textContent = "(pinned)";
  pinnedUrl.textContent = matched?.url ?? "";
  pinnedEmpty.hidden = true;
  pinnedInfo.hidden = false;
  pinBtn.hidden = true;
  unpinBtn.hidden = false;
}

pinBtn.addEventListener("click", () => {
  pinBtn.disabled = true;
  chrome.runtime
    .sendMessage({ type: "pin_tab" })
    .then((res: unknown) => {
      if (res && typeof res === "object" && "ok" in res && !(res as { ok: boolean }).ok) {
        const err = (res as { error?: string }).error ?? "unknown error";
        console.warn("[popup] pin_tab failed:", err);
      }
    })
    .catch((e: unknown) => {
      console.warn("[popup] pin_tab message error:", e);
    })
    .finally(() => {
      pinBtn.disabled = false;
      void renderPinned();
    });
});

unpinBtn.addEventListener("click", () => {
  unpinBtn.disabled = true;
  chrome.runtime
    .sendMessage({ type: "unpin_tab" })
    .catch(() => {})
    .finally(() => {
      unpinBtn.disabled = false;
      void renderPinned();
    });
});

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
  await renderPinned();
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
