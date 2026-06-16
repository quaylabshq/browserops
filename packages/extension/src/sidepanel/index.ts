export {};

import { AGENTS, DEFAULT_AGENT_ID, getAgent } from "@browserops/shared";
import {
  LAUNCH_ENDPOINT,
  buildLaunchBody,
  grabPageMeta,
  launchedMessage,
  launchStatusMessage,
  type PageMeta,
} from "../lib/launch-client.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
};

const statusPill = $<HTMLSpanElement>("status");
const newSessionBtn = $<HTMLButtonElement>("new-session");
const disconnectedEl = $<HTMLDivElement>("disconnected");
const agentsEl = $<HTMLDivElement>("agents");
const transcriptEl = $<HTMLDivElement>("transcript");
const emptyEl = $<HTMLDivElement>("empty");
const contextEl = $<HTMLDivElement>("context");
const composerForm = $<HTMLFormElement>("composer");
const messageEl = $<HTMLTextAreaElement>("message");
const sendBtn = $<HTMLButtonElement>("send");

let selectedAgent: string = DEFAULT_AGENT_ID;
let connected = false;
// Once a session is launched, the conversation continues in the terminal;
// the panel input is parked until the user starts a New session. "for now":
// no in-panel streaming.
let launched = false;

// --- agent picker -----------------------------------------------------------

function renderAgents(): void {
  agentsEl.replaceChildren();
  for (const a of AGENTS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "agent-chip";
    chip.setAttribute("role", "radio");
    chip.dataset["agent"] = a.id;
    chip.append(a.label);
    if (a.note) {
      const note = document.createElement("span");
      note.className = "agent-note";
      note.textContent = a.note;
      chip.appendChild(note);
    }
    if (a.enabled) {
      chip.addEventListener("click", () => selectAgent(a.id));
    } else {
      chip.disabled = true;
    }
    agentsEl.appendChild(chip);
  }
  syncAgentSelection();
}

function selectAgent(id: string): void {
  selectedAgent = id;
  syncAgentSelection();
}

function syncAgentSelection(): void {
  for (const chip of agentsEl.querySelectorAll<HTMLButtonElement>(".agent-chip")) {
    chip.setAttribute("aria-checked", String(chip.dataset["agent"] === selectedAgent));
  }
}

// --- transcript -------------------------------------------------------------

function appendMessage(role: "user" | "system", text: string): void {
  emptyEl.hidden = true;
  const bubble = document.createElement("div");
  bubble.className = `msg msg--${role}`;
  bubble.textContent = text;
  transcriptEl.appendChild(bubble);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function resetSession(): void {
  launched = false;
  for (const b of transcriptEl.querySelectorAll(".msg")) b.remove();
  emptyEl.hidden = false;
  syncComposer();
  messageEl.focus();
}

// --- connection + composer state -------------------------------------------

function syncComposer(): void {
  const canSend = connected && !launched;
  messageEl.disabled = !canSend;
  sendBtn.disabled = !canSend;
  newSessionBtn.hidden = !launched;
  messageEl.placeholder = !connected
    ? "Connect the bridge to start…"
    : launched
      ? "Launched — continue in your terminal"
      : "Message…";
}

function renderConnection(isConnected: boolean): void {
  connected = isConnected;
  statusPill.textContent = isConnected ? "Connected" : "Disconnected";
  statusPill.className = `pill ${isConnected ? "pill--on" : "pill--off"}`;
  disconnectedEl.style.display = isConnected ? "none" : "block";
  syncComposer();
}

async function refreshConnection(): Promise<void> {
  const local = await chrome.storage.local.get("connected");
  renderConnection(local["connected"] === true);
}

async function refreshContext(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const title = tab?.title ?? "";
    let host = "";
    try {
      host = tab?.url ? new URL(tab.url).host : "";
    } catch {
      /* non-http url */
    }
    const label = title || host;
    contextEl.textContent = label
      ? `context · ${label}${title && host ? " — " + host : ""}`
      : "context · (none)";
  } catch {
    contextEl.textContent = "context · (unavailable)";
  }
}

async function capturePageMeta(): Promise<PageMeta> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url ?? "";
  const title = tab?.title ?? "";
  if (tab?.id === undefined) return { url, title };
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabPageMeta,
    });
    const r = injected?.result as
      | { title?: string; description?: string; siteName?: string }
      | undefined;
    if (r) {
      return { url, title: r.title || title, description: r.description, siteName: r.siteName };
    }
  } catch {
    // Restricted page (chrome://, Web Store, PDF viewer) — url + title only.
  }
  return { url, title };
}

// --- send → launch ----------------------------------------------------------

async function sendMessage(): Promise<void> {
  if (!connected || launched) return;
  const text = messageEl.value.trim();
  if (text.length === 0) return;

  appendMessage("user", text);
  messageEl.value = "";
  autoGrow();
  launched = true; // optimistic; reverted on failure so the user can retry
  syncComposer();

  const result = await launch(text);
  if (result.ok) {
    const label = getAgent(selectedAgent)?.label ?? selectedAgent;
    appendMessage("system", launchedMessage(label));
  } else {
    appendMessage("system", result.message);
    launched = false;
    syncComposer();
  }
}

async function launch(instruction: string): Promise<{ ok: boolean; message: string }> {
  const meta = await capturePageMeta();
  const local = await chrome.storage.local.get("token");
  const token = local["token"];
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, message: "Run setup first (no token)." };
  }

  let response: Response | null = null;
  try {
    response = await fetch(LAUNCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildLaunchBody({ token, agent: selectedAgent, instruction, meta })),
    });
  } catch {
    response = null; // connection refused = bridge not running
  }

  let payloadError: string | undefined;
  if (response !== null && !response.ok) {
    try {
      payloadError = ((await response.json()) as { error?: string }).error;
    } catch {
      /* non-JSON error body */
    }
  }
  const ok = response !== null && response.ok;
  return {
    ok,
    message: launchStatusMessage(
      response !== null ? { ok: response.ok, status: response.status } : null,
      payloadError,
    ),
  };
}

// --- wiring -----------------------------------------------------------------

function autoGrow(): void {
  messageEl.style.height = "auto";
  messageEl.style.height = `${Math.min(messageEl.scrollHeight, 120)}px`;
}

composerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void sendMessage();
});
messageEl.addEventListener("input", autoGrow);
messageEl.addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter inserts a newline.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});
newSessionBtn.addEventListener("click", () => resetSession());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "connected" in changes) void refreshConnection();
});
chrome.tabs.onActivated.addListener(() => void refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url !== undefined || info.title !== undefined) void refreshContext();
});

renderAgents();
void refreshConnection();
void refreshContext();
