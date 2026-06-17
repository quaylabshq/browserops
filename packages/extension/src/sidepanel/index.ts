export {};

import { AGENTS, DEFAULT_AGENT_ID, type ChatEvent, type ChatMessage } from "@browserops/shared";
import {
  appendUserMessage,
  chatHistory,
  chatNew,
  chatSend,
  chatSessions,
  chatTerminal,
  grabPageMeta,
  initialChatState,
  reduceChat,
  statusLabel,
  streamUrl,
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

let selectedAgent: string = DEFAULT_AGENT_ID;
let connected = false;
let state: ChatState = initialChatState();
let stream: EventSource | null = null;
let terminal: EmbeddedTerminal | null = null;
let view: "chat" | "terminal" = "chat";
let tokenCache: string | null = null;
let systemSeq = 0;

// --- token ------------------------------------------------------------------

async function getToken(): Promise<string | null> {
  if (tokenCache) return tokenCache;
  const local = await chrome.storage.local.get("token");
  const token = local["token"];
  tokenCache = typeof token === "string" && token.length > 0 ? token : null;
  return tokenCache;
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
    if (a.caps.chat) chip.addEventListener("click", () => selectAgent(a.id));
    else chip.disabled = true;
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
  if (view === "terminal" && (!connected || !state.session || !state.terminalCapable)) {
    closeTerminal();
  }
  panelEl.classList.toggle("view-terminal", view === "terminal");

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
  termMirrorBtn.hidden = !hasSession || !connected || !state.terminalCapable;
  termTakeoverBtn.hidden = !hasSession || !connected || state.ejected;
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
  renderSessions(await chatSessions(token));
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
  closeStream();
  closeTerminal();
  state = reduceChat(initialChatState(), { type: "session", ref: summary });
  state = { ...state, terminalCapable: summary.terminal === true };
  render();
  const history = await chatHistory(token, summary.sessionId);
  state = { ...state, messages: history };
  render();
  openStream(token, summary.sessionId);
  await loadSessions();
}

// --- live stream ------------------------------------------------------------

function openStream(token: string, sessionId: string): void {
  closeStream();
  stream = new EventSource(streamUrl(token, sessionId));
  stream.onmessage = (e: MessageEvent<string>) => {
    let event: ChatEvent;
    try {
      event = JSON.parse(e.data) as ChatEvent;
    } catch {
      return;
    }
    state = reduceChat(state, event);
    render();
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
  if (isConnected) void loadSessions();
}

async function refreshConnection(): Promise<void> {
  const local = await chrome.storage.local.get("connected");
  renderConnection(local["connected"] === true);
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

  if (!state.session) {
    const meta = await capturePageMeta();
    const res = await chatNew({ token, agent: selectedAgent, instruction: text, meta });
    if (!res.ok || !res.session) {
      state = { ...state, status: "idle" };
      pushSystem(newError(res.status, res.error));
      return;
    }
    state = reduceChat(state, { type: "session", ref: res.session });
    state = { ...state, terminalCapable: res.terminal === true };
    openStream(token, res.session.sessionId);
    render();
    await loadSessions();
  } else {
    const res = await chatSend(token, state.session.sessionId, text);
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
  if (!state.session || !state.terminalCapable || !connected) return;
  const token = await getToken();
  if (!token) {
    pushSystem("Run setup first (no token).");
    return;
  }
  view = "terminal";
  render(); // applies .view-terminal first so the pane is laid out at full size
  try {
    const { mountTerminal } = await import("../lib/pty-terminal.js");
    terminal = mountTerminal({ container: termHost, token, sessionId: state.session.sessionId });
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

// ⤢ Take over: eject the session into a real external terminal (claude --resume).
async function takeoverTerminal(): Promise<void> {
  if (!state.session) return;
  const token = await getToken();
  if (!token) {
    pushSystem("Run setup first (no token).");
    return;
  }
  const res = await chatTerminal(token, state.session.sessionId, "takeover");
  if (!res.ok) {
    pushSystem("Couldn't open the terminal.");
    return;
  }
  closeStream();
  closeTerminal();
  state = reduceChat(state, { type: "status", state: "ejected" });
  pushSystem("Taken over in your terminal — continue there.");
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
