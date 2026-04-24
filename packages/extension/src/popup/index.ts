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
const yoloBanner = $<HTMLDivElement>("yolo-banner");
const setupPane = $<HTMLDivElement>("setup");
const runSetupBtn = $<HTMLButtonElement>("run-setup");
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

let connectedState = false;
let disabledState = false;

function renderStatus(connected: boolean, disabled: boolean): void {
  connectedState = connected;
  disabledState = disabled;
  statusPill.className = "pill";
  if (disabled) {
    statusPill.textContent = "disabled";
    // default .pill = neutral gray — no modifier
    killBtn.textContent = "Enable";
    killBtn.classList.remove("btn--danger");
  } else if (connected) {
    statusPill.textContent = "connected";
    statusPill.classList.add("pill--on");
    killBtn.textContent = "Disable";
    killBtn.classList.add("btn--danger");
  } else {
    statusPill.textContent = "disconnected";
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
    chrome.storage.local.get(["connected", "token", "disabled", "yoloFirstRunShown"]),
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
  renderStatus(local["connected"] === true, local["disabled"] === true);
  const raw = session["pendingSafetyPrompt"];
  const prompt =
    raw !== undefined && raw !== null && typeof raw === "object"
      ? (raw as PendingSafetyPrompt)
      : null;
  renderSafety(prompt);

  // Handle first-run banner
  const firstRunShown = local["yoloFirstRunShown"] === true;
  if (!firstRunShown) {
    yoloBanner.hidden = false;
    await chrome.storage.local.set({ yoloFirstRunShown: true });
  } else {
    yoloBanner.hidden = true;
  }

  // New semantics: checked = requireApproval = true; unchecked = auto-approve (default)
  yoloBox.checked = session["requireApproval"] === true;
  await renderPinned();
}

yoloBox.addEventListener("change", () => {
  const requireApproval = yoloBox.checked;
  // The background service worker listens on storage.onChanged to update the
  // badge and to let the safety handler short-circuit future prompts.
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
    // Connected → Disable: stop the connection and mark this browser disabled.
    chrome.runtime.sendMessage({ type: "kill_switch" }).catch(() => {});
    renderStatus(false, true);
  } else {
    // Disabled or disconnected → Enable/Connect: clear disabled flag and try to connect.
    killBtn.disabled = true;
    chrome.runtime
      .sendMessage({ type: "reconnect" })
      .catch(() => {})
      .finally(() => {
        void refresh();
      });
  }
});

optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
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
