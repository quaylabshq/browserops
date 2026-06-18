export {};

import {
  DEFAULT_AGENT_ID,
  type ChatBlock,
  type ChatEvent,
  type ChatMessage,
} from "@browserops/shared";
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
  streamUrl,
  type ChatState,
  type PageMeta,
  type SessionSummary,
} from "../lib/chat-client.js";
import { formatAction } from "../lib/chat-format.js";
import { renderMarkdown } from "../lib/markdown.js";
import type { EmbeddedTerminal } from "../lib/pty-terminal.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
};

const statusDot = $<HTMLSpanElement>("status-dot");
const headTitle = $<HTMLSpanElement>("head-title");
const newSessionBtn = $<HTMLButtonElement>("new-session");
const termMirrorBtn = $<HTMLButtonElement>("term-mirror");
const termTakeoverBtn = $<HTMLButtonElement>("term-takeover");
const themeToggleBtn = $<HTMLButtonElement>("theme-toggle");
const disconnectedEl = $<HTMLDivElement>("disconnected");
const tabAgentBtn = $<HTMLButtonElement>("tab-agent");
const tabHistoryBtn = $<HTMLButtonElement>("tab-history");
const streamEl = $<HTMLDivElement>("stream");
const emptyEl = $<HTMLDivElement>("empty");
const emptyChipsEl = $<HTMLDivElement>("empty-chips");
const contextEl = $<HTMLDivElement>("context");
const contextFav = $<HTMLSpanElement>("context-fav");
const contextLabel = $<HTMLSpanElement>("context-label");
const contextLive = $<HTMLSpanElement>("context-live");
const historyEl = $<HTMLDivElement>("history");
const composerForm = $<HTMLFormElement>("composer");
const messageEl = $<HTMLTextAreaElement>("message");
const sendBtn = $<HTMLButtonElement>("send");
const termStatusEl = $<HTMLDivElement>("term-status");
const termStatusNewBtn = $<HTMLButtonElement>("term-status-new");
const panelEl = $<HTMLDivElement>("panel");
const termHost = $<HTMLDivElement>("terminal-host");
const termTitleEl = $<HTMLSpanElement>("terminal-title");
const termCloseBtn = $<HTMLButtonElement>("term-close");

const selectedAgent: string = DEFAULT_AGENT_ID;
let connected = false;
let state: ChatState = initialChatState();
let stream: EventSource | null = null;
let terminal: EmbeddedTerminal | null = null;
let view: "chat" | "terminal" = "chat";
let tab: "agent" | "history" = "agent";
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

// --- theme ------------------------------------------------------------------

// "system" follows the OS; light/dark force a skin. We resolve to a concrete
// light|dark and set it on <html data-theme> so the CSS needs only a light
// default + a [data-theme="dark"] override (no media-query duplication).
type ThemePref = "system" | "light" | "dark";
const THEME_CYCLE: ThemePref[] = ["system", "light", "dark"];
const THEME_GLYPH: Record<ThemePref, string> = { system: "◐", light: "☀", dark: "☾" };
const THEME_LABEL: Record<ThemePref, string> = { system: "Auto", light: "Light", dark: "Dark" };
const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
let themePref: ThemePref = "system";

function isThemePref(v: unknown): v is ThemePref {
  return v === "system" || v === "light" || v === "dark";
}

function applyTheme(): void {
  const resolved = themePref === "system" ? (darkMq.matches ? "dark" : "light") : themePref;
  document.documentElement.dataset["theme"] = resolved;
  themeToggleBtn.textContent = THEME_GLYPH[themePref];
  themeToggleBtn.title = `Theme: ${THEME_LABEL[themePref]}`;
  themeToggleBtn.setAttribute("aria-label", `Theme: ${THEME_LABEL[themePref]}`);
}

async function loadTheme(): Promise<void> {
  const stored = (await chrome.storage.local.get("theme"))["theme"];
  themePref = isThemePref(stored) ? stored : "system";
  applyTheme();
}

function cycleTheme(): void {
  themePref = THEME_CYCLE[(THEME_CYCLE.indexOf(themePref) + 1) % THEME_CYCLE.length]!;
  void chrome.storage.local.set({ theme: themePref });
  applyTheme();
}

darkMq.addEventListener("change", () => {
  if (themePref === "system") applyTheme();
});

// --- view tabs (Agent ↔ History) --------------------------------------------

// Two top-level views: the chat ("Agent") and the recent-sessions list
// ("History"). Switching to History refreshes the list and leaves any
// full-window terminal view.
function setTab(next: "agent" | "history"): void {
  tab = next;
  if (next === "history") {
    if (view === "terminal") closeTerminal();
    void loadSessions();
  }
  render();
}

// Compact "5m ago" / "2h ago" / "3d ago" for the History list.
function relativeTime(ts: number | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return `${Math.floor(day / 30)}mo ago`;
}

// --- activity stream render -------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textOf(blocks: ChatBlock[]): string {
  return blocks
    .flatMap((b) => (b.kind === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

interface Group {
  kind: "user" | "agent" | "system";
  blocks: ChatBlock[];
}

// Consecutive assistant/tool messages collapse into one agent turn; user and
// system messages each stand alone.
function groupMessages(messages: ChatMessage[]): Group[] {
  const groups: Group[] = [];
  for (const m of messages) {
    const kind: Group["kind"] =
      m.role === "user" ? "user" : m.role === "system" ? "system" : "agent";
    const last = groups[groups.length - 1];
    if (kind === "agent" && last?.kind === "agent") last.blocks.push(...m.blocks);
    else groups.push({ kind, blocks: [...m.blocks] });
  }
  return groups;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function argsText(use: Extract<ChatBlock, { kind: "tool_use" }>): string {
  const input = asRecord(use.input);
  if (Object.keys(input).length === 0) return "";
  try {
    return JSON.stringify(input, null, 2).slice(0, 600);
  } catch {
    return "";
  }
}

function renderAction(
  use: Extract<ChatBlock, { kind: "tool_use" }>,
  result?: Extract<ChatBlock, { kind: "tool_result" }>,
): HTMLLIElement {
  const view = formatAction(use);
  const phase = result ? (result.ok ? "ok" : "err") : "run";
  const li = el("li", `action action--${phase}`);

  // Leading status marker — the execution-trace "✓ / ✗ / running" column.
  const status = el("span", "action__status");
  if (phase === "run") status.append(el("span", "action__spinner"));
  else status.textContent = phase === "ok" ? "✓" : "✗";
  li.append(status);

  const main = el("span", "action__main");
  const verb = el("span", "action__verb");
  verb.textContent = view.verb;
  main.append(verb);
  if (view.target) {
    const tgt = el("span", "action__target");
    tgt.textContent = view.target;
    tgt.title = view.target;
    main.append(tgt);
  }
  li.append(main);

  const trail = el("span", "action__trail");
  if (view.risky) {
    const r = el("span", "action__risky");
    r.textContent = "⚠";
    r.title = "Risky action";
    trail.append(r);
  }
  li.append(trail);

  // Expandable detail: input args (neutral block) + result/error (red on fail).
  const args = argsText(use);
  const preview = result?.preview.trim() ?? "";
  if (args || preview) {
    li.classList.add("is-expandable");
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    const chevron = el("span", "action__chevron");
    chevron.textContent = "▸";
    trail.append(chevron);

    const detail = el("div", "action__detail");
    if (args) {
      const pre = el("pre", "action__args");
      pre.textContent = args;
      detail.append(pre);
    }
    if (preview) {
      const block = el("div", phase === "err" ? "action__error" : "action__args");
      block.textContent = preview.slice(0, 1200);
      detail.append(block);
    }
    detail.hidden = phase !== "err"; // errors auto-expand
    li.setAttribute("aria-expanded", String(!detail.hidden));
    detail.addEventListener("click", (e) => e.stopPropagation());
    const toggle = (): void => {
      detail.hidden = !detail.hidden;
      li.setAttribute("aria-expanded", String(!detail.hidden));
    };
    li.addEventListener("click", toggle);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    li.append(detail);
  }
  return li;
}

function renderUserTurn(blocks: ChatBlock[]): HTMLElement {
  const turn = el("div", "turn turn--user");
  const prompt = el("span", "uprompt");
  prompt.textContent = "❯";
  const text = el("span", "utext");
  text.textContent = textOf(blocks);
  turn.append(prompt, text);
  return turn;
}

function sectionLabel(text: string): HTMLElement {
  const label = el("div", "section-label");
  label.textContent = text;
  return label;
}

function renderOrphanResult(b: Extract<ChatBlock, { kind: "tool_result" }>): HTMLLIElement {
  const li = el("li", `action action--${b.ok ? "ok" : "err"}`);
  const status = el("span", "action__status");
  status.textContent = b.ok ? "✓" : "✗";
  const main = el("span", "action__main");
  const verb = el("span", "action__verb");
  verb.textContent = "result";
  main.append(verb);
  li.append(status, main, el("span", "action__trail"));
  return li;
}

function renderSystemNote(blocks: ChatBlock[]): HTMLElement {
  const note = el("div", "sysnote");
  note.textContent = textOf(blocks);
  return note;
}

// An agent response renders as two sections — EXECUTION TRACE (the browser
// actions) then EXTRACTED OUTPUT (the prose) — mirroring the design language.
// Interleaved tool/text blocks are regrouped: all actions, then all prose.
function renderAgentTurn(blocks: ChatBlock[], isLast: boolean): HTMLElement {
  const turn = el("div", "turn turn--agent");
  const working = isLast && state.status === "thinking" && !state.ejected;

  const results = new Map<string, Extract<ChatBlock, { kind: "tool_result" }>>();
  for (const b of blocks) if (b.kind === "tool_result") results.set(b.id, b);
  const consumed = new Set<string>();

  const actions: HTMLLIElement[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_use") {
      if (results.has(b.id)) consumed.add(b.id);
      actions.push(renderAction(b, results.get(b.id)));
    } else if (b.kind === "tool_result" && !consumed.has(b.id)) {
      actions.push(renderOrphanResult(b));
    }
  }

  const thinkingText = blocks
    .flatMap((b) => (b.kind === "thinking" ? [b.text] : []))
    .join("\n")
    .trim();
  const replyText = textOf(blocks);

  // EXECUTION TRACE
  if (actions.length > 0) {
    turn.append(sectionLabel("Execution Trace"));
    const ul = el("ul", "actions");
    for (const a of actions) ul.append(a);
    turn.append(ul);
  }

  if (thinkingText) {
    const t = el("div", "block-thinking");
    t.textContent = thinkingText;
    turn.append(t);
  }

  // EXTRACTED OUTPUT — labelled only when it follows a trace, else clean prose.
  if (replyText) {
    if (actions.length > 0) {
      turn.append(el("hr", "turn__rule"));
      turn.append(sectionLabel("Extracted Output"));
    }
    const out = el("div", "block-text");
    renderMarkdown(out, replyText);
    turn.append(out);
  }

  // First-token wait — a shimmer when nothing has streamed in yet.
  if (working && actions.length === 0 && !replyText && !thinkingText) {
    const think = el("div", "thinking");
    think.append(el("div", "thinking__bar"), document.createTextNode("working…"));
    turn.append(think);
  }

  return turn;
}

function renderGroup(g: Group, isLast: boolean): HTMLElement {
  if (g.kind === "user") return renderUserTurn(g.blocks);
  if (g.kind === "system") return renderSystemNote(g.blocks);
  return renderAgentTurn(g.blocks, isLast);
}

function render(): void {
  // Terminal view falls back to chat if the session lost its pty (eject,
  // disconnect, or a new/cold session that has none).
  if (view === "terminal" && (!connected || !state.session || !state.terminalCapable)) {
    closeTerminal();
  }
  panelEl.classList.toggle("view-terminal", view === "terminal");
  panelEl.classList.toggle("view-history", view !== "terminal" && tab === "history");
  tabAgentBtn.setAttribute("aria-selected", String(tab === "agent"));
  tabHistoryBtn.setAttribute("aria-selected", String(tab === "history"));

  const hasMessages = state.messages.length > 0;
  const hasSession = state.session !== undefined;

  // Rebuild the stream. The first user instruction is the header title (below),
  // so it isn't repeated as a prompt line; later instructions render as ❯.
  for (const node of streamEl.querySelectorAll(".turn, .sysnote")) node.remove();
  const groups = groupMessages(state.messages);
  let rendered = 0;
  groups.forEach((g, i) => {
    if (i === 0 && g.kind === "user") return;
    streamEl.appendChild(renderGroup(g, i === groups.length - 1));
    rendered += 1;
  });
  // Awaiting the first reply (only the header instruction exists) — show a shimmer.
  if (rendered === 0 && hasSession && connected && state.status !== "idle" && !state.ejected) {
    const wrap = el("div", "turn turn--agent");
    const think = el("div", "thinking");
    think.append(el("div", "thinking__bar"), document.createTextNode("working…"));
    wrap.append(think);
    streamEl.appendChild(wrap);
  }

  emptyEl.hidden = !connected || hasMessages;
  disconnectedEl.hidden = connected || hasMessages;
  streamEl.scrollTop = streamEl.scrollHeight;

  // Context bar — pulse the live dot while a session can drive the tab.
  contextLive.hidden = !(hasSession && connected && !state.ejected);

  // Status dot — solid when connected, pinging while it's working / live.
  const busy =
    connected && (state.status === "thinking" || state.status === "starting" || state.ejected);
  statusDot.className = `dot ${connected ? "dot--on" : "dot--off"}${busy ? " dot--busy" : ""}`;

  // Header — the first instruction is the title (the task).
  const firstUser = state.messages.find((m) => m.role === "user");
  const task = firstUser ? textOf(firstUser.blocks).replace(/\s+/g, " ").trim() : "";
  headTitle.textContent = task || state.session?.title?.trim() || "BrowserOps";
  termTitleEl.textContent = `${state.session?.title?.trim() || "session"} · ● live`;

  // Chat-only controls; hidden on the History tab and in the terminal view.
  const onAgent = tab === "agent" && view !== "terminal";
  termMirrorBtn.hidden = !onAgent || !hasSession || !connected || !state.terminalCapable;
  termTakeoverBtn.hidden = !onAgent || !hasSession || !connected || state.ejected;
  newSessionBtn.hidden = !hasMessages && !hasSession;
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

// --- History view -----------------------------------------------------------

async function loadSessions(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  renderSessions(await chatSessions(token));
}

function renderSessions(list: SessionSummary[]): void {
  historyEl.replaceChildren();
  if (list.length === 0) {
    const empty = el("div", "history__empty");
    empty.textContent = connected ? "No sessions yet." : "Connect the bridge to see history.";
    historyEl.append(empty);
    return;
  }
  for (const s of list) {
    const item = el("button", "history__item");
    item.type = "button";
    if (state.session?.sessionId === s.sessionId) item.classList.add("history__item--active");
    const title = el("div", "history__title");
    title.textContent = s.title?.trim() || "Untitled session";
    const meta = el("div", "history__meta");
    meta.append(document.createTextNode(relativeTime(s.lastActive || s.createdAt)));
    if (s.terminal) {
      const badge = el("span", "history__badge");
      badge.textContent = "· live";
      meta.append(badge);
    }
    item.append(title, meta);
    item.addEventListener("click", () => {
      tab = "agent";
      void openSession(s);
    });
    historyEl.append(item);
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

// Example prompts for the empty state — one tap fills the composer.
function renderEmptyChips(): void {
  const prompts = ["Summarize this page", "Extract the key details", "What can I do here?"];
  emptyChipsEl.replaceChildren();
  for (const text of prompts) {
    const chip = el("button", "chip");
    chip.type = "button";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      messageEl.value = text;
      autoGrow();
      syncSendState();
      messageEl.focus();
    });
    emptyChipsEl.append(chip);
  }
}

async function refreshContext(): Promise<void> {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const title = activeTab?.title ?? "";
    let hostStr = "";
    try {
      hostStr = activeTab?.url ? new URL(activeTab.url).host : "";
    } catch {
      /* non-http url */
    }
    if (!hostStr && !title) {
      contextEl.hidden = true;
      return;
    }
    contextEl.hidden = false;
    contextLabel.textContent = hostStr && title ? `${hostStr} · ${title}` : hostStr || title;
    contextLabel.title = title || hostStr;
    const fav = activeTab?.favIconUrl;
    contextFav.style.backgroundImage =
      typeof fav === "string" && (fav.startsWith("http") || fav.startsWith("data:"))
        ? `url("${fav}")`
        : "";
  } catch {
    contextEl.hidden = true;
  }
}

async function capturePageMeta(): Promise<PageMeta> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = activeTab?.url ?? "";
  const title = activeTab?.title ?? "";
  if (activeTab?.id === undefined) return { url, title };
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
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
  // Read-only when ejected: swap the composer for the terminal status bar.
  composerForm.hidden = state.ejected;
  termStatusEl.hidden = !state.ejected;

  messageEl.disabled = !connected || state.ejected;
  messageEl.placeholder = connected
    ? "Type a command or ask a follow-up…"
    : "Connect the bridge to start…";
  syncSendState();
}

function syncSendState(): void {
  const hasText = messageEl.value.trim().length > 0;
  composerForm.classList.toggle("has-text", hasText);
  sendBtn.disabled = !(connected && !state.ejected && hasText);
}

function renderConnection(isConnected: boolean): void {
  connected = isConnected;
  statusDot.title = isConnected ? "Connected" : "Disconnected";
  statusDot.setAttribute("aria-label", isConnected ? "Connected" : "Disconnected");
  render();
  if (isConnected) {
    void loadSessions();
    void refreshContext();
  }
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
  const open = view === "terminal";
  termMirrorBtn.textContent = open ? "✕" : "▤";
  termMirrorBtn.title = open ? "Close terminal" : "Open the live terminal";
  termMirrorBtn.setAttribute("aria-label", termMirrorBtn.title);
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
  const res = await chatTerminal(token, state.session.sessionId, "takeover");
  if (!res.ok) {
    pushSystem("Couldn't open the terminal.");
    return;
  }
  closeTerminal(); // leave the embedded terminal view; you drive in the external one now
  state = reduceChat(state, { type: "status", state: "ejected" });
  pushSystem("Taken over in your terminal — the chat here is now a live read-only view.");
}

function newSession(): void {
  closeStream();
  closeTerminal();
  tab = "agent";
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
messageEl.addEventListener("input", () => {
  autoGrow();
  syncSendState();
});
messageEl.addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter inserts a newline.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});
tabAgentBtn.addEventListener("click", () => setTab("agent"));
tabHistoryBtn.addEventListener("click", () => setTab("history"));
newSessionBtn.addEventListener("click", newSession);
termStatusNewBtn.addEventListener("click", newSession);
termCloseBtn.addEventListener("click", () => void setView("chat"));
termMirrorBtn.addEventListener("click", () => {
  void setView(view === "terminal" ? "chat" : "terminal");
});
termTakeoverBtn.addEventListener("click", () => void takeoverTerminal());
themeToggleBtn.addEventListener("click", cycleTheme);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("token" in changes) tokenCache = null;
  if ("connected" in changes) void refreshConnection();
  if ("theme" in changes) void loadTheme();
});
chrome.tabs.onActivated.addListener(() => void refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url !== undefined || info.title !== undefined) void refreshContext();
});

renderEmptyChips();
render();
void loadTheme();
void refreshConnection();
void refreshContext();
