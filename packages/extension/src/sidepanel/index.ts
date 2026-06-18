export {};

import {
  AGENTS,
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
import { formatAction, type ActionIcon } from "../lib/chat-format.js";
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
const engineEl = $<HTMLDivElement>("engine");
const streamEl = $<HTMLDivElement>("stream");
const emptyEl = $<HTMLDivElement>("empty");
const emptyChipsEl = $<HTMLDivElement>("empty-chips");
const contextEl = $<HTMLDivElement>("context");
const contextFav = $<HTMLSpanElement>("context-fav");
const contextLabel = $<HTMLSpanElement>("context-label");
const contextLive = $<HTMLSpanElement>("context-live");
const contextHistoryEl = $<HTMLDivElement>("context-history");
const composerForm = $<HTMLFormElement>("composer");
const messageEl = $<HTMLTextAreaElement>("message");
const sendBtn = $<HTMLButtonElement>("send");
const termStatusEl = $<HTMLDivElement>("term-status");
const termStatusNewBtn = $<HTMLButtonElement>("term-status-new");
const panelEl = $<HTMLDivElement>("panel");
const termHost = $<HTMLDivElement>("terminal-host");
const termTitleEl = $<HTMLSpanElement>("terminal-title");
const termCloseBtn = $<HTMLButtonElement>("term-close");

// Recent sessions, kept so the empty/header re-renders don't re-fetch.
let sessions: SessionSummary[] = [];

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

// --- engine selector (header; pre-session only) -----------------------------

// The engine is chosen before a chat starts; once a session is live its agent
// is fixed, so render() hides this. Labels are shortened ("Claude Code" →
// "Claude") to fit the segmented control in a narrow header.
function renderEngine(): void {
  engineEl.replaceChildren();
  for (const a of AGENTS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "engine__chip";
    chip.setAttribute("role", "radio");
    chip.dataset["agent"] = a.id;
    chip.textContent = a.label.split(" ")[0] ?? a.label;
    chip.title = a.note ? `${a.label} — ${a.note}` : a.label;
    if (a.caps.chat) chip.addEventListener("click", () => selectAgent(a.id));
    else chip.disabled = true;
    engineEl.appendChild(chip);
  }
  syncEngineSelection();
}

function selectAgent(id: string): void {
  selectedAgent = id;
  syncEngineSelection();
}

function syncEngineSelection(): void {
  for (const chip of engineEl.querySelectorAll<HTMLButtonElement>(".engine__chip")) {
    chip.setAttribute("aria-checked", String(chip.dataset["agent"] === selectedAgent));
  }
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

// Compact 14px stroke icons keyed by action category. Paths are static
// constants, so innerHTML carries no user data.
const ICON_PATHS: Record<ActionIcon, string> = {
  navigate: '<path d="M3 8h9"/><path d="M8 4l4 4-4 4"/>',
  back: '<path d="M13 8H4"/><path d="M8 4 4 8l4 4"/>',
  forward: '<path d="M3 8h9"/><path d="M8 4l4 4-4 4"/>',
  tab: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M2.5 6.2h11"/>',
  click:
    '<circle cx="8" cy="8" r="4.3"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/>',
  hover: '<path d="M5 4l7 3.2-3 1-1 3z"/>',
  type: '<rect x="2.5" y="4.5" width="11" height="7" rx="1.5"/><path d="M5.2 9.2h5.6"/>',
  press: '<path d="M12 5v2.2a1.8 1.8 0 0 1-1.8 1.8H4"/><path d="M6.4 6.6 4 9l2.4 2.4"/>',
  read: '<path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="1.7"/>',
  camera:
    '<path d="M2.6 5.6h2l1-1.5h2.8l1 1.5h2a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1V6.6a1 1 0 0 1 1-1Z"/><circle cx="8" cy="8.4" r="2"/>',
  scroll: '<path d="M8 3.2v9.6"/><path d="M5.2 6 8 3.2 10.8 6"/><path d="M5.2 10 8 12.8 10.8 10"/>',
  wait: '<circle cx="8" cy="8" r="5.4"/><path d="M8 5v3l2 1.4"/>',
  code: '<path d="M6 5 3 8l3 3"/><path d="M10 5l3 3-3 3"/>',
  procedure: '<path d="M5.6 4.4 11.6 8l-6 3.6z"/>',
  search: '<circle cx="7" cy="7" r="3.6"/><path d="M9.8 9.8 13 13"/>',
  locate: '<circle cx="8" cy="8" r="2.4"/><path d="M8 2v2.2M8 11.8V14M2 8h2.2M11.8 8H14"/>',
  dot: '<circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none"/>',
};

function actionIcon(key: ActionIcon): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = ICON_PATHS[key] ?? ICON_PATHS.dot;
  return svg;
}

function textOf(blocks: ChatBlock[]): string {
  return blocks
    .flatMap((b) => (b.kind === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

function agentName(): string {
  const id = state.session?.agent ?? selectedAgent;
  return AGENTS.find((a) => a.id === id)?.label ?? "Agent";
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

  const icon = el("span", "action__icon");
  icon.append(actionIcon(view.icon));
  li.append(icon);

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
  const who = el("span", "turn__who");
  who.textContent = "You";
  const body = el("div", "turn__body");
  body.textContent = textOf(blocks);
  turn.append(who, body);
  return turn;
}

function renderSystemNote(blocks: ChatBlock[]): HTMLElement {
  const note = el("div", "sysnote");
  note.textContent = textOf(blocks);
  return note;
}

function renderAgentTurn(blocks: ChatBlock[], isLast: boolean): HTMLElement {
  const turn = el("div", "turn turn--agent");
  const head = el("div", "turn__head");
  const who = el("span", "turn__who");
  const glyph = el("span", "turn__glyph");
  glyph.textContent = "◇";
  who.append(glyph, document.createTextNode(agentName()));
  head.append(who);
  const working = isLast && state.status === "thinking" && !state.ejected;
  if (working) {
    const chip = el("span", "status-chip status-chip--working");
    chip.textContent = "working…";
    head.append(chip);
  }
  turn.append(head);

  const body = el("div", "turn__body");
  const results = new Map<string, Extract<ChatBlock, { kind: "tool_result" }>>();
  for (const b of blocks) if (b.kind === "tool_result") results.set(b.id, b);
  const consumed = new Set<string>();

  const actionsList = (): HTMLUListElement => {
    const last = body.lastElementChild;
    if (last instanceof HTMLUListElement && last.classList.contains("actions")) return last;
    const ul = el("ul", "actions");
    body.append(ul);
    return ul;
  };

  // A hairline rule when prose follows a run of actions (trace → output).
  const ruleIfAfterActions = (): void => {
    if (body.lastElementChild?.classList.contains("actions")) body.append(el("hr", "turn__rule"));
  };

  for (const b of blocks) {
    if (b.kind === "text") {
      if (!b.text.trim()) continue;
      ruleIfAfterActions();
      const t = el("div", "block-text");
      renderMarkdown(t, b.text);
      body.append(t);
    } else if (b.kind === "thinking") {
      const t = el("div", "block-thinking");
      t.textContent = b.text;
      body.append(t);
    } else if (b.kind === "tool_use") {
      if (results.has(b.id)) consumed.add(b.id);
      actionsList().append(renderAction(b, results.get(b.id)));
    } else if (!consumed.has(b.id)) {
      const li = el("li", `action action--${b.ok ? "ok" : "err"}`);
      const status = el("span", "action__status");
      status.textContent = b.ok ? "✓" : "✗";
      const icon = el("span", "action__icon");
      icon.append(actionIcon("dot"));
      const main = el("span", "action__main");
      const verb = el("span", "action__verb");
      verb.textContent = "result";
      main.append(verb);
      li.append(status, icon, main, el("span", "action__trail"));
      actionsList().append(li);
    }
  }

  if (working && body.childElementCount === 0) {
    const think = el("div", "thinking");
    think.append(el("div", "thinking__bar"), document.createTextNode("working…"));
    body.append(think);
  }

  turn.append(body);
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

  // Rebuild the activity stream from grouped turns.
  for (const node of streamEl.querySelectorAll(".turn, .sysnote")) node.remove();
  const groups = groupMessages(state.messages);
  groups.forEach((g, i) => streamEl.appendChild(renderGroup(g, i === groups.length - 1)));

  const hasMessages = state.messages.length > 0;
  const hasSession = state.session !== undefined;
  emptyEl.hidden = !connected || hasMessages;
  disconnectedEl.hidden = connected || hasMessages;
  streamEl.scrollTop = streamEl.scrollHeight;

  // Context bar — pulse the live dot while a session can drive the tab.
  contextLive.hidden = !(hasSession && connected && !state.ejected);

  // Status dot — solid when connected, pinging while it's working / live.
  const busy =
    connected && (state.status === "thinking" || state.status === "starting" || state.ejected);
  statusDot.className = `dot ${connected ? "dot--on" : "dot--off"}${busy ? " dot--busy" : ""}`;

  // Header — engine selector pre-session; session title + controls once live.
  engineEl.hidden = hasSession;
  headTitle.textContent = state.session?.title?.trim() || "BrowserOps";
  termTitleEl.textContent = `${state.session?.title?.trim() || "session"} · ● live`;
  termMirrorBtn.hidden = !hasSession || !connected || !state.terminalCapable;
  termTakeoverBtn.hidden = !hasSession || !connected || state.ejected;
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

// --- recent sessions (context-bar history tags) -----------------------------

async function loadSessions(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  renderSessions(await chatSessions(token));
}

function renderSessions(list: SessionSummary[]): void {
  sessions = list;
  contextHistoryEl.replaceChildren();
  for (const s of list.slice(0, 6)) {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "history__tag";
    if (state.session?.sessionId === s.sessionId) tag.classList.add("history__tag--active");
    const label = s.title?.trim() || s.sessionId.slice(0, 8);
    tag.textContent = `↑ ${label}`;
    tag.title = s.title ?? s.sessionId;
    tag.addEventListener("click", () => void openSession(s));
    contextHistoryEl.appendChild(tag);
  }
  // History lives in the context bar; make sure it's shown when sessions exist.
  if (list.length > 0) contextEl.hidden = false;
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

// Example prompts for the empty state — two generic, one seeded from the host.
function renderEmptyChips(host: string): void {
  const prompts = ["Summarize this page", "Extract the main content"];
  prompts.push(host ? `What can I do on ${host}?` : "Find and fill a form");
  emptyChipsEl.replaceChildren();
  for (const text of prompts) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      messageEl.value = text;
      autoGrow();
      syncSendState();
      messageEl.focus();
    });
    emptyChipsEl.appendChild(chip);
  }
}

async function refreshContext(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const title = tab?.title ?? "";
    let hostStr = "";
    try {
      hostStr = tab?.url ? new URL(tab.url).host : "";
    } catch {
      /* non-http url */
    }
    renderEmptyChips(hostStr);
    if (!hostStr && !title && sessions.length === 0) {
      contextEl.hidden = true;
      return;
    }
    contextEl.hidden = false;
    contextLabel.textContent = hostStr && title ? `${hostStr} · ${title}` : hostStr || title;
    contextLabel.title = title || hostStr;
    const fav = tab?.favIconUrl;
    contextFav.style.backgroundImage =
      typeof fav === "string" && (fav.startsWith("http") || fav.startsWith("data:"))
        ? `url("${fav}")`
        : "";
  } catch {
    if (sessions.length === 0) contextEl.hidden = true;
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

renderEngine();
renderEmptyChips("");
render();
void loadTheme();
void refreshConnection();
void refreshContext();
