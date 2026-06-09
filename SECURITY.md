# Security Policy

browserops drives a live, logged-in Chrome browser via a companion MV3 extension and CDP. Any vulnerability that lets a third party redirect that capability — through the bridge, the extension, the WebSocket transport, the procedure runtime, or the risky-action gate — is treated as high severity.

## Supported versions

Pre-1.0, only the **latest minor** is supported. Once 1.0 ships, the supported window will move to the latest two minors.

| Version  | Supported          |
| -------- | ------------------ |
| latest   | :white_check_mark: |
| < latest | :x:                |

## Reporting a vulnerability

**Please do not open public GitHub issues for security reports.**

Use one of the following private channels:

1. **GitHub Security Advisories** — go to <https://github.com/quaylabshq/browserops/security/advisories/new> and submit a private report. This is the preferred path.
2. **Email** — <security@quaylabs.io> (or, if unreachable, <saket@quaylabs.io>).

When reporting, include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept code, a sample procedure, a network trace, or screenshots).
- Affected version(s) and platform (macOS / Linux, Chrome version, Node version).
- Any mitigation you've already identified.

You'll get an acknowledgement within **3 business days** and a triage decision within **7 business days**.

## Disclosure timeline

We follow a **90-day coordinated disclosure window** by default:

- Day 0 — Report received, triage begins.
- Day ≤7 — Acknowledgement, severity assessment, fix-plan timeline shared with reporter.
- Day ≤30 — Fix landed in main; release candidate prepared.
- Day ≤60 — Patch release published, advisory drafted.
- Day 90 — Advisory and CVE (if applicable) published. We can extend or accelerate by mutual agreement with the reporter.

Critical vulnerabilities with active exploitation may be fast-tracked to a same-week patch and advisory.

## Scope

In scope:

- `packages/bridge` — the MCP stdio server, the WebSocket transport (loopback only, token-authed), the rate limiter, the risky-action gate, the procedure runtime, the token storage on disk (`~/.browserops/`).
- `packages/extension` — the MV3 service worker, all message handlers, the CDP attach surface, the destructive-chord deny-list, the content-script injection surface, the pair-code flow.
- `packages/cli` — the CLI commands that mutate the user's MCP-client config files (`~/.claude/`, `~/.cursor/`, etc.) and the daemon supervisor.
- `packages/shared` — the wire protocol, the procedure schema, the JSON-Schema tool catalogue.

Out of scope (will not be treated as security issues):

- Bugs in the user's MCP client (Claude Code, Cursor, Zed, …).
- Bugs in third-party sites that the user instructs browserops to drive.
- DoS via a malicious procedure that the user wrote themselves.
- Attacks that require pre-existing local code execution as the same user (the threat model assumes the local user is trusted; we defend against malicious _pages_ and malicious _MCP clients_ trying to escalate).
- Chrome zero-days unrelated to the extension's permission surface.

## Hardening notes for reviewers

- The bridge binds the WebSocket to `127.0.0.1` only and refuses non-loopback Origin and Host values.
- The token is 64 hex chars, generated with `crypto.randomBytes`, stored at `~/.browserops/token` with file mode `0600`.
- Destructive keyboard chords (close-tab, quit, new-window, etc.) are refused at the extension's input dispatcher before reaching CDP.
- Telemetry (PostHog) is field-allowlisted via `packages/bridge/src/telemetry/redact.ts`; no page text, URLs, tab titles, or input contents are ever transmitted.
- Auto-approve mode is the default; the user can opt into approval gating via `BROWSEROPS_APPROVAL=gate` or the extension popup toggle.

Thank you for helping keep browserops users safe.
