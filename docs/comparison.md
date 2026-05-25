# How browserops compares

A short take on what browserops is, what's distinctive about it, and how it lines up against the four browser-agent stacks people ask about most: **browser-use/browser-harness**, **microsoft/playwright-mcp**, **Claude for Chrome**, and **Gemini in Chrome**.

---

## What browserops is

An **MCP server that drives your live Chrome profile.** Any MCP-compatible client (Claude Code, Cursor, Zed, Continue, Windsurf, Codex, custom SDK agents) calls `browser_*` tools → a local Node bridge forwards them to a Chrome MV3 extension over WebSocket → the extension uses `chrome.tabs` / `chrome.scripting` / `chrome.debugger` against your existing logged-in tabs.

No headless Chromium. No second profile. No Anthropic or Google account. Bring your own model.

```
MCP client (Claude Code / Cursor / Zed / Codex / …)
      │ stdio MCP
      ▼
browserops bridge (rate limit · risky-action gate · procedure store · memory)
      │ WebSocket on 127.0.0.1:57321
      ▼
Chrome MV3 extension  →  your real, logged-in tabs
```

---

## Top features

- **Real Chrome, real logins.** Acts on the same tab you're looking at — Gmail, Slack, Linear, Figma all run inside your existing session.
- **One bridge, every coding agent.** Same Chrome surface from Claude Code, Cursor, Zed, Continue, Windsurf, Codex, or any custom MCP client. Multiple clients can share a single Chrome profile concurrently.
- **Auto-snapshot on every interaction.** Every state-changing tool returns a fresh compact a11y tree by default — no separate `browser_read` after every click. Modes: `compact | full | screenshot | a11y+screenshot | none`.
- **Cheap targeted reads.** `browser_quick_read` searches the a11y tree by accessible name and returns only matching refs, far cheaper than a full read.
- **Batch form fill.** `browser_fill_form` lands N fields with a single settle/snapshot — a 10-field form pays one settle (1–5s) instead of ten.
- **Procedure memory** *(opt-in)*. Named, parameterized YAML action graphs — discoverable, executable, replayable across sessions and across agents. Five `procedures_*` tools: `search`, `get`, `save`, `delete`, `execute`.
- **Cross-agent memory** *(opt-in)*. Markdown store at `~/browserops/memory/` shared between every MCP client hitting the same bridge — a lesson saved from Claude Code is visible from Cursor next time.
- **Trusted vs synthetic dispatch.** Auto-CDP on canvas apps (Figma, Docs, Sheets, Canva, Miro) and rich-editor domains (Gmail, Slack, Notion, Linear, Discord). Synthetic everywhere else — no automation banner.
- **Console errors and native dialogs handled for free.** Tab responses surface a `console_summary` whenever new errors fire; `window.alert/confirm/prompt` are auto-trapped with safe defaults and queued for explicit acknowledgment.
- **Safety rails.** 16 actions/min/tab + 60/min global rate limit, risky-action gate (auto-approve by default; `BROWSEROPS_APPROVAL=gate` to require confirms), destructive-keyboard-chord deny-list, toolbar kill switch.
- **Autonomous procedure authoring.** The `browserops-teach` skill probes the live page, drafts YAML in-context, verifies via `procedures_execute`, then saves with `bump_success: true` — one prompt in, one report out.
- **Feature-flagged prompt budget.** `procedures` and `memory` are off by default. With them off, their tools and docs are stripped from `tools/list` and the MCP `initialize` instructions — minimum token overhead.

---

## How it stacks up

The grid is split by axis. Each section is read independently; ✓ / – / opt-in / implicit / n/a have specific meanings (see legend at the bottom).

### A. Identity & licensing

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| Form factor | MCP server + Chrome MV3 ext | Python harness over CDP | MCP server (Playwright-driven) | Chrome extension | Built-in Chrome feature |
| Vendor | OSS / community | OSS / Browser Use | OSS / Microsoft | Anthropic (closed) | Google (closed) |
| Cost | Free | Free | Free | Paid Claude plan (Pro/Max/Team/Ent) | Paid Google AI sub |
| Install | `npm i -g browserops` | `pip` + Chrome relaunch | `npx @playwright/mcp` | Chrome Web Store | Bundled in Chrome |

### B. Browser & profile model

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| Drives your real, logged-in Chrome | ✓ default | ✓ (needs `--remote-debugging-port`) | opt-in ("Browser Extension" mode) | ✓ default | ✓ default |
| Browser support | Chrome ≥ 120 | Chrome | Chromium / Firefox / WebKit | Chrome | Chrome |
| "Controlled by automation" banner | Only on canvas / gated domains | Always (CDP) | When CDP attached | None | None |
| Headless mode | – | ✓ via cloud | ✓ | – | – |
| Concurrent multi-client (one Chrome, many agents) | ✓ primary/secondary bridge | – | – | – | – |
| Per-project rules (`AGENTS.md`/`CLAUDE.md`) | ✓ auto-loaded by client | – | – | – | – |

### C. Model & account

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| Model choice | Any (BYOM via launcher) | Any | Any | Claude only | Gemini only |
| Account required | None | None | None | Anthropic paid | Google + AI sub |
| Where the LLM runs | Wherever your MCP client lives | Wherever your script runs | Wherever your MCP client lives | Anthropic servers | Google servers |
| Region availability | Global | Global | Global | Global | US-first (Auto Browse US-only) |

### D. Integration surface

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| MCP server | ✓ | – | ✓ | – | – |
| Works from terminal / CLI | ✓ any MCP client | ✓ Python only | ✓ any MCP client | partial (via Claude Code) | – |
| Works inside the browser UI | – | – | – | ✓ side panel | ✓ side panel |
| Documented multi-IDE matrix | ✓ Claude Code, Cursor, Zed, Continue, Windsurf, Codex, custom SDK | – | ✓ same set | – | – |
| Programmatic API for automation users | ✓ | ✓ | ✓ | – | – |

### E. Tool capabilities (what an agent can call)

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| Click / type / press / scroll / hover | ✓ | ✓ | ✓ | implicit | implicit |
| Coordinate-based click (`click_at`) | ✓ | ✓ | ✓ (vision opt-in) | implicit | implicit |
| Accessibility-tree read | ✓ compact / full | – (raw CDP) | ✓ snapshot | implicit | implicit |
| **Auto-snapshot after every interaction** | ✓ default | – | – (explicit `snapshot`) | n/a | n/a |
| **Cheap targeted read by accessible name** (`browser_quick_read`) | ✓ | – | – | n/a | n/a |
| **Batch form fill, single settle** (`browser_fill_form`) | ✓ | – | – | – | – |
| JavaScript execution | ✓ | ✓ | ✓ | – | – |
| Screenshots (viewport + a11y+screenshot combined mode) | ✓ | ✓ | ✓ + PDF/video/trace | implicit | implicit |
| Console capture | ✓ auto-summary + on-demand | via raw CDP | ✓ | – | – |
| Native dialog auto-trap (blocks other tools until ack'd) | ✓ | – | partial (handlers, no auto-block) | – | – |
| Tab management (list / switch / new / close) | ✓ | ✓ | ✓ | ✓ via tab groups | ✓ multi-tab |
| Network mocking / routing | – | via raw CDP | ✓ | – | – |
| Trace / video / test assertions | – | – | ✓ | – | – |

### F. Memory & reuse

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| Parameterized procedure store (agent-discoverable, MCP tools) | ✓ 5 `procedures_*` tools | partial (filesystem domain skills) | – | – | – |
| Cross-agent memory shared between IDEs | ✓ 4 `memory_*` tools | – | – | – | – |
| User-recorded workflow replay (UI-driven) | – | – | – | ✓ | – |
| Scheduled / recurring runs | – | – | – | ✓ | – |
| Agent-written helper code | – | ✓ `agent_helpers.py` | – | – | – |
| Procedure portability (YAML on disk, version-controllable) | ✓ | ✓ filesystem | – | tied to ext/account | – |

### G. Safety & control

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| Per-tab + global rate limit | ✓ 16/min/tab, 60/min global | – | – | – | – |
| Risky-action approval gate (configurable) | ✓ `auto` / `gate` | – | – | – | – |
| Destructive keyboard-chord deny-list | ✓ | – | – | – | – |
| URL scheme deny-list (`javascript:`, `file:`, `chrome:`) | ✓ | – | – | implicit | implicit |
| Kill switch | ✓ toolbar Disconnect | end script | quit driver | toggle ext | toggle |
| Audit trace | ✓ `BROWSEROPS_TRACE=1` | – | ✓ trace recording | – | – |
| Sensitive-domain list (extensible) | ✓ `risky-domains.json` | – | – | – | – |

### H. Token / prompt economics

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| Auto-snapshot collapses N reads → 0 explicit reads | ✓ | – | – | n/a | n/a |
| Feature flags strip whole tool families from prompt | ✓ (`procedures`, `memory` off by default) | – | – | n/a | n/a |
| Cheap quick-read by accessible name | ✓ | – | – | n/a | n/a |
| Batch fill collapses N settle waits → 1 | ✓ | – | – | n/a | n/a |
| Server `instructions` adapt to enabled features | ✓ | – | – | n/a | n/a |

### I. Privacy & data flow

| | **browserops** | browser-harness | playwright-mcp | Claude for Chrome | Gemini in Chrome |
|---|:---:|:---:|:---:|:---:|:---:|
| Bridge bound to `127.0.0.1` only (enforced) | ✓ | local CDP | local | n/a | n/a |
| Page content sent to vendor for reasoning | – (only to your model) | – (only to your model) | – (only to your model) | ✓ Anthropic | ✓ Google |
| Local-only operation possible (offline model) | ✓ | ✓ | ✓ | – | – |
| Token & extension secrets local | ✓ `~/.browserops/` | local | local | vendor-managed | vendor-managed |

**Legend**
- ✓ — supported, available, or default
- – — not supported / no exposed equivalent
- **opt-in** — supported but disabled by default; one flag flips it on
- **implicit** — the assistant can do it internally but there's no programmatic surface the user invokes
- **n/a** — the dimension doesn't apply to this product class
- **partial** — supported in a narrower form than the leftmost column claims

---

## The differentiators, by competitor

### vs **browser-use / browser-harness**

`browser-harness` is a Python harness that connects an agent to Chrome via raw CDP and lets the agent **write its own helper code** (`agent_helpers.py`) and accumulate site-specific skills. Slim by design — agent does the rest.

**Where browserops differs:**
- **Client surface.** browser-harness is Python-shaped. browserops is MCP — same Chrome surface from any IDE or SDK with no harness fork.
- **Procedures are first-class MCP tools.** browser-harness skills are filesystem playbooks the harness loads. browserops procedures are MCP tools (`procedures_search`, `_get`, `_execute`) any agent discovers via `tools/list`.
- **Dispatch.** browser-harness is always-on CDP, so Chrome always shows the automation banner. browserops uses synthetic dispatch by default and auto-escalates to CDP only on canvas + gated-domain tabs.
- **Connection model.** browser-harness needs Chrome relaunched with `--remote-debugging-port`. browserops uses a normal MV3 extension — no relaunch.
- **Cross-agent memory** is browserops-only.

> *Use browser-harness if you live in Python and want full CDP control with the agent inventing helpers. Use browserops for multi-IDE, multi-agent workflows that don't want a Python loop in the middle.*

### vs **microsoft/playwright-mcp**

Microsoft's official MCP server backed by Playwright. Cross-browser (Chromium/Firefox/WebKit), 70+ tools, network mocking, PDF/video/trace recording, deterministic accessibility-tree input.

**Where browserops differs:**
- **Real-profile-first.** playwright-mcp's default mode launches its **own Chromium with its own profile** — your Gmail and Slack aren't logged in. Connecting to your real browser requires the opt-in "Browser Extension" mode and isn't the default story. browserops is your real Chrome from the first call.
- **Stateful agent ergonomics.** browserops auto-snapshots after every interaction; playwright-mcp expects an explicit `snapshot` call. browserops batches form fields in one settle; playwright-mcp doesn't.
- **Memory layers.** Procedures + cross-agent memory are browserops-only. playwright-mcp ships no persistent skill store.
- **Token discipline.** browserops feature flags strip whole tool families and their docs from the prompt when off; playwright-mcp ships everything.
- **Scope.** playwright-mcp wins on cross-browser parity and test-automation features (network mocking, PDF, video, traces, assertions). browserops doesn't try to be a Playwright — it's optimized for "drive my actual browser."

> *Use playwright-mcp if you need WebKit/Firefox parity, network mocking, or trace recording for tests. Use browserops if you want one Chrome bridge that any IDE agent uses against your real logins.*

### vs **Claude for Chrome** (Anthropic's extension)

Anthropic's first-party extension. Side panel inside Chrome, multi-tab via Chrome's tab group, workflow recorder, scheduled recurring tasks, integrates with Claude Code so the CLI can drive the browser.

**Where browserops differs:**
- **Model and account lock-in.** Claude for Chrome is bundled with paid Claude plans (Pro/Max/Team/Enterprise) and uses Anthropic's models. browserops is free and works from Cursor, Zed, Continue, Windsurf, Codex, and custom SDK agents — not just Claude.
- **Tool surface.** browserops exposes a full agent-grade tool catalogue (refs, snapshots, `execute_js`, dialog handling, console capture, batch fill, procedures, memory). Claude for Chrome is a chat-driven extension with an opaque action surface.
- **Procedures vs recordings.** Claude's recorded workflows are internal to the extension and tied to that account. browserops procedures are YAML on disk under `~/browserops/procedures/` — agent-authored, agent-readable, portable, parameterized, version-controllable.
- **Multi-client.** Multiple MCP clients (one Claude Code window + one Cursor window) can share the same browserops bridge concurrently. Claude for Chrome is one-extension-one-Claude.
- **Safety.** Rate limiter, risky-action gate, destructive-chord deny-list, kill switch, audit trace are first-class in browserops.

> *Use Claude for Chrome if you live entirely in Claude.ai and want a turnkey product experience. Use browserops if you switch agents, share procedures across IDEs, or want the same Chrome bridge from your terminal.*

### vs **Gemini in Chrome**

Built into Chrome itself. Side panel, multi-tab summarize, "Auto Browse" agentic mode (US-only, AI Pro/Ultra), Nano Banana image edits, Personal Intelligence (Gmail/Search/YouTube/Photos integration).

**Where browserops differs:**
- **Closed product, not a tool.** Gemini in Chrome is an end-user assistant — there's no programmatic surface for your terminal agent or IDE. browserops is the inverse: an MCP server agents call from outside the browser.
- **Model + account lock-in.** Gemini's models, Google's account, paid Google AI subscription, US-first availability. browserops: any model, any account, any region, no subscription.
- **No procedure memory or cross-agent memory.** Auto Browse is opaque server-side reasoning per task — nothing the agent can `procedures_get` and replay deterministically.
- **Privacy posture.** Gemini sends page content to Google to reason over. browserops keeps the loop local: extension → bridge → your MCP client. Your model provider is whoever your launcher uses.

> *Use Gemini in Chrome if you want a consumer browsing assistant inside Chrome and you're already deep in Google's ecosystem. Use browserops if you want your coding agent — Claude, GPT, Gemini, local — to drive your real browser from your terminal.*

---

## TL;DR mental model

| | One-line positioning |
|---|---|
| **browserops** | Real Chrome + agent-grade MCP tools + procedure memory shared across IDEs. |
| browser-harness | Real Chrome + Python harness + agent writes its own helpers. |
| playwright-mcp | Synthetic Chromium (or opt-in real) + cross-browser test surface + 70 tools. |
| Claude for Chrome | Real Chrome + Claude-only chat assistant, paid plan, in-product only. |
| Gemini in Chrome | Real Chrome + Google's consumer assistant, paid plan, in-product only. |

The single sentence: **browserops is the only one of these that gives any coding agent, in any IDE, an agent-grade tool surface against your real Chrome — with shared procedure and cross-agent memory layered on top.**
