export {};

import { AGENTS, DEFAULT_AGENT_ID } from "@browserops/shared";
import {
  LAUNCH_ENDPOINT,
  buildLaunchBody,
  grabPageMeta,
  launchStatusMessage,
  type PageMeta,
} from "../lib/launch-client.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
};

const statusPill = $<HTMLSpanElement>("status");
const disconnectedEl = $<HTMLDivElement>("disconnected");
const composerEl = $<HTMLDivElement>("composer");
const agentsEl = $<HTMLDivElement>("agents");
const instructionEl = $<HTMLTextAreaElement>("instruction");
const contextEl = $<HTMLDivElement>("context");
const launchBtn = $<HTMLButtonElement>("launch");
const launchStatus = $<HTMLDivElement>("launch-status");

let selectedAgent: string = DEFAULT_AGENT_ID;
let connected = false;

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

function renderConnection(isConnected: boolean): void {
  connected = isConnected;
  statusPill.textContent = isConnected ? "Connected" : "Disconnected";
  statusPill.className = `pill ${isConnected ? "pill--on" : "pill--off"}`;
  disconnectedEl.style.display = isConnected ? "none" : "block";
  composerEl.classList.toggle("disabled", !isConnected);
  launchBtn.disabled = !isConnected;
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
      ? `current tab: ${label}${title && host ? " — " + host : ""}`
      : "current tab: (none)";
  } catch {
    contextEl.textContent = "current tab: (unavailable)";
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

async function runLaunch(): Promise<void> {
  if (!connected) return;
  launchBtn.disabled = true;
  launchStatus.textContent = "Launching…";
  try {
    const meta = await capturePageMeta();
    const local = await chrome.storage.local.get("token");
    const token = local["token"];
    if (typeof token !== "string" || token.length === 0) {
      launchStatus.textContent = "Run setup first.";
      return;
    }

    let response: Response | null = null;
    try {
      response = await fetch(LAUNCH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildLaunchBody({ token, agent: selectedAgent, instruction: instructionEl.value, meta }),
        ),
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
    launchStatus.textContent = launchStatusMessage(
      response !== null ? { ok: response.ok, status: response.status } : null,
      payloadError,
    );
  } finally {
    launchBtn.disabled = !connected;
  }
}

launchBtn.addEventListener("click", () => void runLaunch());
instructionEl.addEventListener("keydown", (e) => {
  // Cmd/Ctrl+Enter launches without reaching for the mouse.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    void runLaunch();
  }
});

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
