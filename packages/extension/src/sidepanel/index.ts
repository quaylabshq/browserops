export {};

import {
  AGENTS,
  DEFAULT_AGENT_ID,
  type ChatEvent,
  type ChatMessage,
  type ChatSettings,
} from "@browserops/shared";
import {
  appendUserMessage,
  chatAgents,
  chatHistory,
  chatMigrate,
  chatNew,
  chatSend,
  chatSettings,
  chatSessions,
  chatTerminal,
  chatUpdateSettings,
  grabPageMeta,
  initialChatState,
  reduceChat,
  statusLabel,
  streamUrl,
  type ChatEndpoint,
  type ChatState,
  type PageMeta,
  type SessionSummary,
} from "../lib/chat-client.js";
import type { EmbeddedTerminal } from "../lib/pty-terminal.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
};

const statusPill = $<HTMLSpanElement>("status");
const newSessionBtn = $<HTMLButtonElement>("new-session");
const termMirrorBtn = $<HTMLButtonElement>("term-mirror");
const termTakeoverBtn = $<HTMLButtonElement>("term-takeover");
const disconnectedEl = $<HTMLDivElement>("disconnected");
const agentsEl = $<HTMLDivElement>("agents");
const sessionsEl = $<HTMLDivElement>("sessions");
const transcriptEl = $<HTMLDivElement>("transcript");
const emptyEl = $<HTMLDivElement>("empty");
const agentStatusEl = $<HTMLDivElement>("agent-status");
const contextEl = $<HTMLDivElement>("context");
const composerForm = $<HTMLFormElement>("composer");
const messageEl = $<HTMLTextAreaElement>("message");
const sendBtn = $<HTMLButtonElement>("send");
const panelEl = $<HTMLDivElement>("panel");
const termHost = $<HTMLDivElement>("terminal-host");
const showSettingsBtn = $<HTMLButtonElement>("show-settings");
const closeSettingsBtn = $<HTMLButtonElement>("close-settings");
const settingsPane = $<HTMLElement>("settings-pane");
const settingsForm = $<HTMLFormElement>("settings-form");
const settingsToken = $<HTMLInputElement>("settings-token");
const settingsHost = $<HTMLInputElement>("settings-host");
const settingsPort = $<HTMLInputElement>("settings-port");
const settingsAgent = $<HTMLSelectElement>("settings-agent");
const settingsModel = $<HTMLInputElement>("settings-model");
const settingsEffort = $<HTMLInputElement>("settings-effort");
const settingsSafeMode = $<HTMLInputElement>("settings-safe-mode");
const settingsTransport = $<HTMLSelectElement>("settings-transport");
const settingsSaved = $<HTMLSpanElement>("settings-saved");
const agentAvailability = $<HTMLDivElement>("agent-availability");

let selectedAgent: string = DEFAULT_AGENT_ID;
let connected = false;
let state: ChatState = initialChatState();
let stream: EventSource | null = null;
let terminal: EmbeddedTerminal | null = null;
let view: "chat" | "terminal" | "settings" = "chat";
let tokenCache: string | null = null;
let systemSeq = 0;
let savedChatSettings: ChatSettings | undefined;
let agentAvailabilityById = new Map<string, boolean>();

function sessionCaps(value: {
  capabilities?: ChatState["capabilities"];
  terminal?: boolean;
}): ChatState["capabilities"] {
  return (
    value.capabilities ?? {
      embeddedTerminal: value.terminal === true,
      externalTakeover: value.terminal === true,
      migrationSource: true,
      migrationTarget: true,
    }
  );
}

// --- token ------------------------------------------------------------------

async function getToken(): Promise<string | null> {
  if (tokenCache) return tokenCache;
  const local = await chrome.storage.local.get("token");
  const token = local["token"];
  tokenCache = typeof token === "string" && token.length > 0 ? token : null;
  return tokenCache;
}

async function getEndpoint(): Promise<ChatEndpoint> {
  const local = await chrome.storage.local.get({ host: "127.0.0.1", port: 57321 });
  return {
    host: typeof local["host"] === "string" ? local["host"] : "127.0.0.1",
    port: typeof local["port"] === "number" ? local["port"] : 57321,
  };
}

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
    if (a.caps.chat && agentAvailabilityById.get(a.id) !== false) {
      chip.addEventListener("click", () => selectAgent(a.id));
    } else {
      chip.disabled = true;
      if (agentAvailabilityById.get(a.id) === false) chip.title = "CLI unavailable";
    }
    agentsEl.appendChild(chip);
  }
  syncAgentSelection();
}

function selectAgent(id: string): void {
  if (state.session && state.session.agent !== id) {
    void migrateSession(id);
    return;
  }
  selectedAgent = id;
  syncAgentSelection();
}

function syncAgentSelection(): void {
  for (const chip of agentsEl.querySelectorAll<HTMLButtonElement>(".agent-chip")) {
    chip.setAttribute("aria-checked", String(chip.dataset["agent"] === selectedAgent));
  }
}

// --- transcript render ------------------------------------------------------

function oneLine(text: string, cap = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap) + "…" : flat;
}

function renderBlocks(parent: HTMLElement, message: ChatMessage): void {
  for (const b of message.blocks) {
    const el = document.createElement("div");
    if (b.kind === "text") {
      el.className = "block-text";
      el.textContent = b.text;
    } else if (b.kind === "thinking") {
      el.className = "block-thinking";
      el.textContent = b.text;
    } else if (b.kind === "tool_use") {
      el.className = "tool-chip";
      el.textContent = `▸ ${b.name}`;
    } else {
      el.className = `tool-chip tool-chip--${b.ok ? "ok" : "err"}`;
      el.textContent = `${b.ok ? "✓" : "✗"} ${oneLine(b.preview)}`;
    }
    parent.appendChild(el);
  }
}

function render(): void {
  // Terminal view falls back to chat if the session lost its pty (eject,
  // disconnect, or a new/cold session that has none).
  if (
    view === "terminal" &&
    (!connected || !state.session || !state.capabilities.embeddedTerminal)
  ) {
    closeTerminal();
  }
  panelEl.classList.toggle("view-terminal", view === "terminal");
  panelEl.classList.toggle("view-settings", view === "settings");
  settingsPane.hidden = view !== "settings";
  showSettingsBtn.hidden = view === "terminal";

  // Conversation.
  for (const node of transcriptEl.querySelectorAll(".msg, .thinking-dots")) node.remove();
  emptyEl.hidden = state.messages.length > 0;
  for (const m of state.messages) {
    const bubble = document.createElement("div");
    bubble.className = `msg msg--${m.role}`;
    renderBlocks(bubble, m);
    transcriptEl.appendChild(bubble);
  }
  if (state.status === "thinking" && !state.ejected) {
    const dots = document.createElement("div");
    dots.className = "thinking-dots";
    dots.textContent = "•••";
    transcriptEl.appendChild(dots);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  // Status line.
  const label = statusLabel(state.status, state.ejected);
  agentStatusEl.textContent = label;
  agentStatusEl.hidden = label.length === 0;

  // Header controls + composer.
  const hasSession = state.session !== undefined;
  // Embedded-terminal toggle: only when this live session has a pty to attach.
  termMirrorBtn.hidden = !hasSession || !connected || !state.capabilities.embeddedTerminal;
  termTakeoverBtn.hidden =
    !hasSession || !connected || state.ejected || !state.capabilities.externalTakeover;
  newSessionBtn.hidden = state.messages.length === 0 && !hasSession;
  syncTerminalBtn();
  syncComposer();
}

function pushSystem(text: string): void {
  state = {
    ...state,
    messages: [
      ...state.messages,
      { id: `sys-${++systemSeq}`, role: "system", blocks: [{ kind: "text", text }] },
    ],
  };
  render();
}

// --- sessions strip ---------------------------------------------------------

async function loadSessions(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  renderSessions(await chatSessions(token, await getEndpoint()));
}

function renderSessions(sessions: SessionSummary[]): void {
  sessionsEl.replaceChildren();
  const recent = sessions.slice(0, 8);
  sessionsEl.hidden = recent.length === 0;
  for (const s of recent) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "session-chip";
    if (state.session?.sessionId === s.sessionId) chip.classList.add("session-chip--active");
    chip.textContent = s.title?.trim() || s.sessionId.slice(0, 8);
    chip.title = s.title ?? s.sessionId;
    chip.addEventListener("click", () => void openSession(s));
    sessionsEl.appendChild(chip);
  }
}

async function openSession(summary: SessionSummary): Promise<void> {
  const token = await getToken();
  if (!token) return;
  const endpoint = await getEndpoint();
  closeStream();
  closeTerminal();
  state = reduceChat(initialChatState(), { type: "session", ref: summary });
  state = { ...state, capabilities: sessionCaps(summary) };
  render();
  const history = await chatHistory(token, summary.sessionId, endpoint);
  state = { ...state, messages: history };
  render();
  openStream(token, summary.sessionId, endpoint);
  await loadSessions();
}

// --- live stream ------------------------------------------------------------

function openStream(token: string, sessionId: string, endpoint: ChatEndpoint): void {
  closeStream();
  const expectedSession = sessionId;
  stream = new EventSource(streamUrl(token, sessionId, endpoint));
  stream.onmessage = (e: MessageEvent<string>) => {
    let event: ChatEvent;
    try {
      event = JSON.parse(e.data) as ChatEvent;
    } catch {
      return;
    }
    // A delayed callback from a closed EventSource must never contaminate a
    // newly selected conversation.
    if (state.session?.sessionId !== expectedSession) return;
    state = reduceChat(state, event);
    render();
  };
  stream.onerror = () => {
    // EventSource retries automatically. Reconcile durable history once so a
    // daemon restart or bounded replay buffer cannot silently lose messages.
    void chatHistory(token, expectedSession, endpoint).then((history) => {
      if (state.session?.sessionId === expectedSession && history.length > 0) {
        state = { ...state, messages: history };
        render();
      }
    });
  };
}

function closeStream(): void {
  if (stream) {
    stream.close();
    stream = null;
  }
}

// --- context ----------------------------------------------------------------

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
    if (r)
      return { url, title: r.title || title, description: r.description, siteName: r.siteName };
  } catch {
    // Restricted page (chrome://, Web Store, PDF viewer) — url + title only.
  }
  return { url, title };
}

// --- connection + composer state -------------------------------------------

function syncComposer(): void {
  const canSend = connected && !state.ejected;
  messageEl.disabled = !canSend;
  sendBtn.disabled = !canSend;
  messageEl.placeholder = !connected
    ? "Connect the bridge to start…"
    : state.ejected
      ? "This session is now controlled in your terminal"
      : "Message…";
}

function renderConnection(isConnected: boolean): void {
  connected = isConnected;
  statusPill.textContent = isConnected ? "Connected" : "Disconnected";
  statusPill.className = `pill ${isConnected ? "pill--on" : "pill--off"}`;
  disconnectedEl.style.display = isConnected ? "none" : "block";
  render();
  if (isConnected) {
    void loadSessions();
    void loadAgentAvailability();
  }
}

async function refreshConnection(): Promise<void> {
  const local = await chrome.storage.local.get("connected");
  renderConnection(local["connected"] === true);
}

async function loadChatDefaults(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  const settings = await chatSettings(token, await getEndpoint());
  if (!settings) return;
  savedChatSettings = settings;
  selectedAgent = settings.defaultAgent;
  syncAgentSelection();
}

async function loadAgentAvailability(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  const statuses = await chatAgents(token, await getEndpoint());
  agentAvailabilityById = new Map(statuses.map((status) => [status.agent, status.available]));
  renderAgents();
}

// --- send -------------------------------------------------------------------

async function sendMessage(): Promise<void> {
  if (!connected || state.ejected) return;
  const text = messageEl.value.trim();
  if (text.length === 0) return;
  messageEl.value = "";
  autoGrow();

  state = appendUserMessage(state, text);
  render();

  const token = await getToken();
  if (!token) {
    pushSystem("Run setup first (no token).");
    return;
  }
  const endpoint = await getEndpoint();

  if (!state.session) {
    const meta = await capturePageMeta();
    const res = await chatNew({ token, agent: selectedAgent, instruction: text, meta, endpoint });
    if (!res.ok || !res.session) {
      state = { ...state, status: "idle" };
      pushSystem(newError(res.status, res.error));
      return;
    }
    state = reduceChat(state, { type: "session", ref: res.session });
    state = { ...state, capabilities: sessionCaps(res) };
    openStream(token, res.session.sessionId, endpoint);
    render();
    await loadSessions();
  } else {
    const res = await chatSend(token, state.session.sessionId, text, endpoint);
    if (!res.ok) {
      state = { ...state, status: "idle" };
      pushSystem(sendError(res.status, res.error));
    }
  }
}

function newError(status: number, error?: string): string {
  if (status === 0) return "Bridge not running — start it, then retry.";
  if (status === 401 || status === 403) return "Not authorized — re-run setup.";
  if (error === "chat_unavailable") return "Chat isn't available on this bridge.";
  if (error === "agent_unavailable") return "That agent isn't available yet.";
  return "Couldn't start the chat.";
}

function sendError(status: number, error?: string): string {
  if (status === 0) return "Bridge not running — start it, then retry.";
  if (status === 404) return "This session is no longer available. Start a new chat.";
  if (status === 409 || error === "session_ejected")
    return "This session is controlled in your terminal.";
  return "Couldn't send that message.";
}

// --- migration --------------------------------------------------------------

async function migrateSession(targetAgent: string): Promise<void> {
  const source = state.session;
  if (!source || source.agent === targetAgent) {
    selectedAgent = targetAgent;
    syncAgentSelection();
    return;
  }
  const token = await getToken();
  if (!token) {
    pushSystem("Run setup first (no token).");
    return;
  }
  state = { ...state, status: "thinking" };
  render();
  const endpoint = await getEndpoint();
  const result = await chatMigrate({
    token,
    sessionId: source.sessionId,
    targetAgent,
    endpoint,
  });
  if (!result.ok || !result.session) {
    state = { ...state, status: "idle" };
    pushSystem("Couldn't switch this conversation to that agent.");
    return;
  }
  closeStream();
  closeTerminal();
  selectedAgent = targetAgent;
  state = reduceChat(initialChatState(), { type: "session", ref: result.session });
  const canonicalHistory = await chatHistory(token, result.session.sessionId, endpoint);
  state = {
    ...state,
    capabilities: sessionCaps(result),
    messages: canonicalHistory,
  };
  openStream(token, result.session.sessionId, endpoint);
  render();
  await loadSessions();
}

// --- settings ---------------------------------------------------------------

function ensureSettingsAgents(): void {
  if (settingsAgent.options.length > 0) return;
  for (const agent of AGENTS.filter((a) => a.caps.chat)) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.label;
    settingsAgent.appendChild(option);
  }
}

function syncInferenceInputs(): void {
  const agent = settingsAgent.value;
  settingsModel.value = savedChatSettings?.models[agent as keyof ChatSettings["models"]] ?? "";
  settingsEffort.value =
    savedChatSettings?.reasoningEfforts[agent as keyof ChatSettings["reasoningEfforts"]] ?? "";
}

function renderAgentAvailability(agents: Awaited<ReturnType<typeof chatAgents>>): void {
  agentAvailability.replaceChildren();
  for (const status of agents) {
    const line = document.createElement("div");
    line.textContent = `${status.agent}: ${status.available ? "available" : (status.reason ?? "unavailable")}`;
    if (!status.available) line.className = "unavailable";
    agentAvailability.appendChild(line);
  }
}

async function openSettings(): Promise<void> {
  closeTerminal();
  view = "settings";
  ensureSettingsAgents();
  const local = await chrome.storage.local.get({ token: "", host: "127.0.0.1", port: 57321 });
  settingsToken.value = typeof local["token"] === "string" ? local["token"] : "";
  settingsHost.value = typeof local["host"] === "string" ? local["host"] : "127.0.0.1";
  settingsPort.value = String(typeof local["port"] === "number" ? local["port"] : 57321);
  const token = await getToken();
  const endpoint = await getEndpoint();
  savedChatSettings = token ? await chatSettings(token, endpoint) : undefined;
  if (savedChatSettings) {
    settingsAgent.value = savedChatSettings.defaultAgent;
    settingsSafeMode.checked = savedChatSettings.safeMode;
    settingsTransport.value = savedChatSettings.transport;
    selectedAgent = savedChatSettings.defaultAgent;
    syncAgentSelection();
  }
  syncInferenceInputs();
  renderAgentAvailability(token ? await chatAgents(token, endpoint) : []);
  render();
}

async function saveSettings(): Promise<void> {
  const port = Number.parseInt(settingsPort.value, 10);
  const endpoint: ChatEndpoint = {
    host: settingsHost.value.trim() || "127.0.0.1",
    port: Number.isFinite(port) && port > 0 ? port : 57321,
  };
  const nextToken = settingsToken.value.trim();
  await chrome.storage.local.set({ token: nextToken, host: endpoint.host, port: endpoint.port });
  tokenCache = nextToken || null;
  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  if (!nextToken) {
    settingsSaved.textContent = "Connection saved";
    return;
  }
  const models = { ...(savedChatSettings?.models ?? {}) } as Record<string, string>;
  const efforts = { ...(savedChatSettings?.reasoningEfforts ?? {}) } as Record<string, string>;
  const selected = settingsAgent.value;
  const model = settingsModel.value.trim();
  const effort = settingsEffort.value.trim();
  if (model) models[selected] = model;
  else delete models[selected];
  if (effort) efforts[selected] = effort;
  else delete efforts[selected];
  const updated = await chatUpdateSettings(
    nextToken,
    {
      defaultAgent: selected,
      safeMode: settingsSafeMode.checked,
      transport: settingsTransport.value as "terminal" | "headless",
      models,
      reasoningEfforts: efforts,
    },
    endpoint,
  );
  if (!updated) {
    settingsSaved.textContent = "Bridge settings could not be saved";
    return;
  }
  savedChatSettings = updated;
  selectedAgent = updated.defaultAgent;
  syncAgentSelection();
  settingsSaved.textContent = "Saved";
  window.setTimeout(() => {
    settingsSaved.textContent = "";
  }, 1600);
}

// --- terminal affordances ---------------------------------------------------

// ▤ Terminal: a full-window VIEW toggle. The panel shows EITHER the chat OR a
// full-window live terminal bound to this session's pty — never both at once.
// The pty session keeps running across the toggle; typing in the terminal drives
// the same interactive Claude the chat does (and shows up in the chat via the
// transcript). xterm is lazy-imported the first time the terminal opens.
async function setView(next: "chat" | "terminal"): Promise<void> {
  if (next === view) return;
  if (next === "chat") {
    closeTerminal();
    render();
    return;
  }
  if (!state.session || !state.capabilities.embeddedTerminal || !connected) return;
  const token = await getToken();
  if (!token) {
    pushSystem("Run setup first (no token).");
    return;
  }
  const endpoint = await getEndpoint();
  view = "terminal";
  render(); // applies .view-terminal first so the pane is laid out at full size
  try {
    const { mountTerminal } = await import("../lib/pty-terminal.js");
    terminal = mountTerminal({
      container: termHost,
      token,
      sessionId: state.session.sessionId,
      endpoint,
    });
    requestAnimationFrame(() => terminal?.fit());
  } catch {
    closeTerminal();
    render();
    pushSystem("Couldn't open the embedded terminal.");
  }
}

function closeTerminal(): void {
  if (terminal) {
    terminal.dispose();
    terminal = null;
  }
  termHost.replaceChildren();
  view = "chat";
  syncTerminalBtn();
}

function syncTerminalBtn(): void {
  termMirrorBtn.textContent = view === "terminal" ? "✕ Close terminal" : "▤ Terminal";
}

// ⤢ Take over: eject the session into your own external terminal (claude
// --resume). The daemon keeps tailing the transcript, so we KEEP the SSE stream
// open — the chat here becomes a LIVE read-only mirror of the turns you type in
// the external terminal. Only input is locked (composer + embedded terminal).
async function takeoverTerminal(): Promise<void> {
  if (!state.session) return;
  const token = await getToken();
  if (!token) {
    pushSystem("Run setup first (no token).");
    return;
  }
  const res = await chatTerminal(token, state.session.sessionId, "takeover", await getEndpoint());
  if (!res.ok) {
    pushSystem(
      res.error === "session_not_persisted"
        ? "This Claude chat has not been persisted yet, so it cannot be taken over safely."
        : "Couldn't open the terminal.",
    );
    return;
  }
  closeTerminal(); // leave the embedded terminal view; you drive in the external one now
  state = reduceChat(state, { type: "status", state: "ejected" });
  pushSystem("Taken over in your terminal — the chat here is now a live read-only view.");
}

function newSession(): void {
  closeStream();
  closeTerminal();
  state = initialChatState();
  render();
  messageEl.focus();
  void loadSessions();
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
newSessionBtn.addEventListener("click", newSession);
termMirrorBtn.addEventListener("click", () => {
  void setView(view === "terminal" ? "chat" : "terminal");
});
termTakeoverBtn.addEventListener("click", () => void takeoverTerminal());
showSettingsBtn.addEventListener("click", () => void openSettings());
closeSettingsBtn.addEventListener("click", () => {
  view = "chat";
  render();
});
settingsAgent.addEventListener("change", syncInferenceInputs);
settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("token" in changes) tokenCache = null;
  if ("connected" in changes) void refreshConnection();
});
chrome.tabs.onActivated.addListener(() => void refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url !== undefined || info.title !== undefined) void refreshContext();
});

renderAgents();
render();
void refreshConnection();
void refreshContext();
void loadChatDefaults();
void loadAgentAvailability();
