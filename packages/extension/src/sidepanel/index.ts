export {};

import {
  AGENTS,
  DEFAULT_AGENT_ID,
  type ChatAgentStatus,
  type ChatEvent,
  type ChatMessage,
  type ChatSettings,
} from "@browserops/shared";
import {
  appendUserMessage,
  chatAgents,
  chatCancel,
  chatConfigureAgent,
  chatHistory,
  chatMigrate,
  chatNew,
  chatSend,
  chatSettings,
  chatSessions,
  chatTerminal,
  chatUpdateSettings,
  collectToolActivity,
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
import { appendMarkdown } from "../lib/markdown.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
};

const statusPill = $<HTMLSpanElement>("status");
const mcpBadge = $<HTMLSpanElement>("mcp-badge");
const newSessionBtn = $<HTMLButtonElement>("new-session");
const stopResponseBtn = $<HTMLButtonElement>("stop-response");
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
const agentSwitchDialog = $<HTMLDialogElement>("agent-switch-dialog");
const agentSwitchTitle = $<HTMLHeadingElement>("agent-switch-title");
const agentSwitchCopy = $<HTMLParagraphElement>("agent-switch-copy");
const agentSwitchNote = $<HTMLParagraphElement>("agent-switch-note");
const agentSwitchCancel = $<HTMLButtonElement>("agent-switch-cancel");
const agentSwitchConfirm = $<HTMLButtonElement>("agent-switch-confirm");

let selectedAgent: string = DEFAULT_AGENT_ID;
let connected = false;
let state: ChatState = initialChatState();
let stream: EventSource | null = null;
let terminal: EmbeddedTerminal | null = null;
let view: "chat" | "terminal" | "settings" = "chat";
let tokenCache: string | null = null;
let systemSeq = 0;
let savedChatSettings: ChatSettings | undefined;
let agentAvailabilityById = new Map<string, ChatAgentStatus>();
let toolActivityExpanded = false;
let toolActivitySessionId: string | undefined;
let pendingAgentSwitch: string | undefined;
let stoppingResponse = false;
let configuringAgent: string | undefined;
let agentReadinessLoaded = false;

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
    const availability = agentAvailabilityById.get(a.id);
    const needsSetup = availability?.available === false;
    if (needsSetup) {
      chip.classList.add("agent-chip--needs-setup");
      chip.title = agentAvailabilityMessage(a.label, availability?.reason);
    }
    if (a.caps.chat && (!state.session || !needsSetup)) {
      chip.addEventListener("click", () => selectAgent(a.id));
    } else {
      chip.disabled = true;
      if (!chip.title) chip.title = agentAvailabilityMessage(a.label, availability?.reason);
    }
    agentsEl.appendChild(chip);
  }
  syncAgentSelection();
}

function agentLabel(id: string): string {
  return AGENTS.find((agent) => agent.id === id)?.label ?? id;
}

function agentAvailabilityMessage(label: string, reason?: string): string {
  if (reason === "agent_not_found" || reason === "claude_not_found") {
    return `${label} CLI was not found by BrowserOps. Install or sign in, then reopen Chat.`;
  }
  if (reason === "mcp_missing") {
    return `${label} needs its BrowserOps MCP connection before a chat can start.`;
  }
  if (reason === "config_invalid") {
    return `${label}'s BrowserOps MCP entry needs manual repair.`;
  }
  if (reason === "driver_unavailable") return `${label} is not enabled by this BrowserOps bridge.`;
  return reason ? `${label} is unavailable: ${reason}` : `${label} is unavailable.`;
}

function mcpConnectionMessage(status: ChatAgentStatus): string {
  const mcp = status.mcp;
  if (!mcp) return "Checking BrowserOps MCP connection…";
  if (!mcp.extensionConnected) return "BrowserOps extension bridge is offline.";
  if (mcp.state === "connected") {
    const sessions = mcp.activeSessions;
    return `BrowserOps MCP connected now${sessions === 1 ? "" : ` (${sessions} sessions)`}.`;
  }
  if (mcp.state === "configured") {
    return mcp.lastConnectedAt
      ? "BrowserOps MCP is configured; the last provider connection has finished."
      : "BrowserOps MCP is configured; it will connect when this provider starts a chat.";
  }
  if (mcp.state === "configuration_invalid")
    return "BrowserOps MCP configuration needs manual repair.";
  if (mcp.state === "cli_unavailable") return "The provider CLI is not available yet.";
  return "BrowserOps MCP has not been configured.";
}

/** A compact, always-visible summary; configuration details stay in Settings. */
function renderMcpBadge(): void {
  const status = agentAvailabilityById.get(selectedAgent);
  const show = connected && status !== undefined;
  mcpBadge.hidden = !show;
  if (!show || !status) return;

  const state = status.mcp?.state ?? (status.available ? "configured" : "not_configured");
  mcpBadge.className = `mcp-badge mcp-badge--${state}`;
  mcpBadge.textContent = `MCP · ${agentLabel(status.agent)}`;
  mcpBadge.title = mcpConnectionMessage(status);
}

function responseIsActive(): boolean {
  return state.status === "starting" || state.status === "thinking";
}

function selectAgent(id: string): void {
  if (state.session && state.session.agent !== id) {
    pendingAgentSwitch = id;
    const source = agentLabel(state.session.agent);
    const target = agentLabel(id);
    const busy = responseIsActive();
    agentSwitchTitle.textContent = busy
      ? "Stop the response before switching"
      : "Switch chat provider?";
    agentSwitchCopy.textContent = busy
      ? `${source} is still generating a response. Stop it before switching to ${target}.`
      : `Switch from ${source} to ${target}? BrowserOps will create a linked ${target} session with this conversation’s history.`;
    agentSwitchNote.textContent = busy
      ? "This prevents a response from continuing in a provider you are no longer viewing."
      : "Your current chat stays in Recent sessions. The new provider will wait until your next message before responding.";
    agentSwitchCancel.textContent = busy ? "Back to chat" : "Keep current chat";
    agentSwitchConfirm.hidden = busy;
    if (!agentSwitchDialog.open) agentSwitchDialog.showModal();
    agentSwitchCancel.focus();
    return;
  }
  selectedAgent = id;
  syncAgentSelection();
  render();
}

function dismissAgentSwitch(): void {
  pendingAgentSwitch = undefined;
  agentSwitchConfirm.hidden = false;
  agentSwitchDialog.close();
}

async function confirmAgentSwitch(): Promise<void> {
  const targetAgent = pendingAgentSwitch;
  dismissAgentSwitch();
  if (targetAgent && !responseIsActive()) await migrateSession(targetAgent);
}

function syncAgentSelection(): void {
  for (const chip of agentsEl.querySelectorAll<HTMLButtonElement>(".agent-chip")) {
    chip.setAttribute("aria-checked", String(chip.dataset["agent"] === selectedAgent));
  }
}

async function configureAgent(agent: string): Promise<void> {
  const status = agentAvailabilityById.get(agent);
  if (!status?.canConfigure || configuringAgent !== undefined) return;
  const token = await getToken();
  if (!token) {
    settingsSaved.textContent = "Run BrowserOps setup first (no connection token).";
    render();
    return;
  }

  configuringAgent = agent;
  settingsSaved.textContent = "";
  render();
  const result = await chatConfigureAgent(token, agent, await getEndpoint());
  configuringAgent = undefined;
  settingsSaved.textContent = result.ok
    ? `${agentLabel(agent)} is configured for BrowserOps.`
    : result.status === 0
      ? "The BrowserOps bridge is not reachable."
      : result.error === "mcp_config_invalid"
        ? "The existing BrowserOps MCP entry needs manual repair."
        : `BrowserOps could not configure ${agentLabel(agent)}.`;
  await loadAgentAvailability();
  renderAgentAvailability([...agentAvailabilityById.values()]);
  render();
}

// --- transcript render ------------------------------------------------------

function oneLine(text: string, cap = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap) + "…" : flat;
}

function renderBlocks(parent: HTMLElement, message: ChatMessage): boolean {
  let rendered = false;
  for (const b of message.blocks) {
    // Tool activity is rendered once, below the conversation, rather than as
    // a chain of raw provider events interleaved with assistant prose.
    if (b.kind === "tool_use" || b.kind === "tool_result") continue;
    const el = document.createElement("div");
    if (b.kind === "text") {
      el.className = "block-text markdown";
      appendMarkdown(el, b.text);
      rendered = true;
    } else if (b.kind === "thinking") {
      el.className = "block-thinking";
      el.textContent = b.text;
      rendered = true;
    }
    parent.appendChild(el);
  }
  return rendered;
}

function renderToolActivity(): HTMLElement | undefined {
  const activity = collectToolActivity(state.messages);
  if (activity.items.length === 0) return undefined;
  const sessionId = state.session?.sessionId;
  if (sessionId !== toolActivitySessionId) {
    toolActivitySessionId = sessionId;
    toolActivityExpanded = false;
  }

  const working = activity.active || (state.status === "thinking" && !state.ejected);
  const latest = activity.latest;
  const banner = document.createElement("section");
  banner.className = `tool-activity${working ? " tool-activity--working" : ""}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tool-activity-toggle";
  toggle.setAttribute("aria-expanded", String(toolActivityExpanded));
  toggle.title = toolActivityExpanded ? "Hide browser activity" : "Show browser activity";
  toggle.addEventListener("click", () => {
    toolActivityExpanded = !toolActivityExpanded;
    render();
  });

  const indicator = document.createElement("span");
  indicator.className = "tool-activity-indicator";
  indicator.setAttribute("aria-hidden", "true");
  toggle.appendChild(indicator);

  const copy = document.createElement("span");
  copy.className = "tool-activity-copy";
  const title = document.createElement("strong");
  title.textContent = working
    ? (latest?.label ?? "Working in the browser")
    : `${activity.completed} browser action${activity.completed === 1 ? "" : "s"} completed`;
  const detail = document.createElement("span");
  detail.textContent = working
    ? (latest?.detail ??
      `${activity.items.length} action${activity.items.length === 1 ? "" : "s"} in this response · live`)
    : "Select to review actions";
  copy.append(title, detail);
  toggle.appendChild(copy);

  const count = document.createElement("span");
  count.className = "tool-activity-count";
  count.textContent = `${toolActivityExpanded ? "−" : "+"} ${activity.items.length}`;
  toggle.appendChild(count);
  banner.appendChild(toggle);

  if (toolActivityExpanded) {
    const details = document.createElement("div");
    details.className = "tool-activity-details";
    for (const item of activity.items) {
      const row = document.createElement("article");
      row.className = `tool-activity-item${item.active ? " tool-activity-item--active" : ""}`;
      const heading = document.createElement("div");
      heading.className = "tool-activity-item-head";
      const label = document.createElement("strong");
      label.textContent = item.label;
      const outcome = document.createElement("span");
      outcome.textContent = item.active
        ? "Running"
        : item.ok === false
          ? "Needs attention"
          : "Done";
      outcome.className = item.active ? "is-running" : item.ok === false ? "is-error" : "is-done";
      heading.append(label, outcome);
      row.appendChild(heading);
      if (item.detail) {
        const detail = document.createElement("div");
        detail.className = "tool-activity-detail";
        detail.textContent = `Activity · ${item.detail}`;
        row.appendChild(detail);
      }
      if (item.input) {
        const input = document.createElement("div");
        input.className = "tool-activity-detail";
        input.textContent = `Input · ${oneLine(item.input, 260)}`;
        row.appendChild(input);
      }
      if (item.result) {
        const result = document.createElement("div");
        result.className = "tool-activity-detail";
        result.textContent = `Result · ${oneLine(item.result, 320)}`;
        row.appendChild(result);
      }
      details.appendChild(row);
    }
    banner.appendChild(details);
  }
  return banner;
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
  for (const node of transcriptEl.querySelectorAll(".msg, .thinking-dots, .tool-activity"))
    node.remove();
  emptyEl.hidden = state.messages.length > 0;
  renderMcpBadge();
  for (const m of state.messages) {
    const bubble = document.createElement("div");
    bubble.className = `msg msg--${m.role}${m.partial ? " msg--streaming" : ""}`;
    if (renderBlocks(bubble, m)) transcriptEl.appendChild(bubble);
  }
  const activity = renderToolActivity();
  if (activity) transcriptEl.appendChild(activity);
  if (state.status === "thinking" && !state.ejected) {
    const dots = document.createElement("div");
    dots.className = "thinking-dots";
    dots.textContent = "•••";
    transcriptEl.appendChild(dots);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  // Status line.
  const label = statusLabel(state.status, state.ejected, state.statusDetail, state.session?.agent);
  agentStatusEl.textContent = label;
  agentStatusEl.hidden = label.length === 0;

  // Header controls + composer.
  const hasSession = state.session !== undefined;
  // Embedded-terminal toggle: only when this live session has a pty to attach.
  termMirrorBtn.hidden = !hasSession || !connected || !state.capabilities.embeddedTerminal;
  termTakeoverBtn.hidden =
    !hasSession || !connected || state.ejected || !state.capabilities.externalTakeover;
  newSessionBtn.hidden = state.messages.length === 0 && !hasSession;
  newSessionBtn.disabled = responseIsActive();
  newSessionBtn.title = responseIsActive() ? "Stop the response before starting a new chat" : "";
  stopResponseBtn.hidden = !hasSession || !connected || state.ejected || !responseIsActive();
  stopResponseBtn.disabled = stoppingResponse;
  stopResponseBtn.textContent = stoppingResponse ? "■ Stopping…" : "■ Stop";
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
    if (event.type === "status" && !responseIsActive()) stoppingResponse = false;
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
  const needsSetup =
    !state.session && agentAvailabilityById.get(selectedAgent)?.available === false;
  const checkingReadiness = !state.session && !agentReadinessLoaded;
  const canSend =
    connected && !state.ejected && !responseIsActive() && !needsSetup && !checkingReadiness;
  messageEl.disabled = !canSend;
  sendBtn.disabled = !canSend;
  messageEl.placeholder = !connected
    ? "Connect the bridge to start…"
    : checkingReadiness
      ? "Checking provider setup…"
      : needsSetup
        ? `Configure ${agentLabel(selectedAgent)} to start…`
        : state.ejected
          ? "This session is now controlled in your terminal"
          : responseIsActive()
            ? "Wait for the current reply or stop it…"
            : "Message…";
}

function renderConnection(isConnected: boolean): void {
  connected = isConnected;
  if (!isConnected) agentReadinessLoaded = false;
  statusPill.textContent = isConnected ? "Bridge linked" : "Bridge offline";
  statusPill.title = isConnected
    ? "Extension ↔ BrowserOps bridge is linked. Provider MCP status is shown below."
    : "The extension cannot reach the BrowserOps bridge.";
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
  render();
}

async function loadAgentAvailability(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  const statuses = await chatAgents(token, await getEndpoint());
  agentAvailabilityById = new Map(statuses.map((status) => [status.agent, status]));
  agentReadinessLoaded = statuses.length > 0;
  renderAgents();
  render();
}

// --- send -------------------------------------------------------------------

async function sendMessage(): Promise<void> {
  if (!connected || state.ejected) return;
  if (!state.session && !agentReadinessLoaded) return;
  if (!state.session && agentAvailabilityById.get(selectedAgent)?.available === false) {
    render();
    return;
  }
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
    const meta = await capturePageMeta();
    const res = await chatSend(token, state.session.sessionId, text, endpoint, meta);
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
  if (error === "agent_not_configured") {
    return "Configure that provider's BrowserOps connection before starting a chat.";
  }
  if (error === "agent_not_found") {
    return "That provider's CLI is unavailable. Install or sign in, then retry.";
  }
  return "Couldn't start the chat.";
}

function sendError(status: number, error?: string): string {
  if (status === 0) return "Bridge not running — start it, then retry.";
  if (status === 404) return "This session is no longer available. Start a new chat.";
  if (status === 409 || error === "session_ejected")
    return "This session is controlled in your terminal.";
  if (error === "agent_not_found") {
    return "That provider's CLI is unavailable. Install or sign in, then retry.";
  }
  return "Couldn't send that message.";
}

async function stopResponse(): Promise<void> {
  if (!state.session || !responseIsActive() || stoppingResponse) return;
  const token = await getToken();
  if (!token) {
    pushSystem("Run setup first (no token).");
    return;
  }
  stoppingResponse = true;
  render();
  const result = await chatCancel(token, state.session.sessionId, await getEndpoint());
  stoppingResponse = false;
  if (!result.ok) {
    pushSystem(
      result.status === 404 ? "This chat is no longer available." : "Couldn't stop the response.",
    );
    return;
  }
  // The SSE status event is canonical; update locally as well so the control
  // responds immediately if that event arrives just after this request.
  state = reduceChat(state, { type: "status", state: "idle" });
  render();
}

// --- migration --------------------------------------------------------------

async function migrateSession(targetAgent: string): Promise<void> {
  const source = state.session;
  if (!source || source.agent === targetAgent) {
    selectedAgent = targetAgent;
    syncAgentSelection();
    return;
  }
  if (responseIsActive()) {
    pushSystem("Stop the current response before switching providers.");
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
    line.className = "agent-availability-row";
    const label = agentLabel(status.agent);
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = label;
    const detail = document.createElement("span");
    detail.textContent = status.available
      ? `CLI ready · ${mcpConnectionMessage(status)}`
      : agentAvailabilityMessage(label, status.reason);
    copy.append(title, detail);
    if (status.configPath) {
      const path = document.createElement("small");
      path.className = "agent-availability-path";
      path.textContent = `BrowserOps MCP configuration · ${status.configPath}`;
      copy.append(path);
    }
    line.appendChild(copy);
    if (!status.available) line.classList.add("unavailable");
    if (status.canConfigure) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "agent-configure";
      action.disabled = configuringAgent !== undefined;
      action.textContent =
        configuringAgent === status.agent ? "Configuring…" : `Configure ${label}`;
      action.addEventListener("click", () => void configureAgent(status.agent));
      line.appendChild(action);
    }
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
  const statuses = token ? await chatAgents(token, endpoint) : [];
  agentAvailabilityById = new Map(statuses.map((status) => [status.agent, status]));
  agentReadinessLoaded = statuses.length > 0;
  renderAgents();
  renderAgentAvailability(statuses);
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
  if (responseIsActive()) return;
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
stopResponseBtn.addEventListener("click", () => void stopResponse());
agentSwitchCancel.addEventListener("click", dismissAgentSwitch);
agentSwitchConfirm.addEventListener("click", () => void confirmAgentSwitch());
agentSwitchDialog.addEventListener("cancel", () => {
  pendingAgentSwitch = undefined;
});
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
  if ("mcpHealth" in changes && connected) void loadAgentAvailability();
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
