# Plan 06 — Procedure memory (reusable action graphs)

**Source:** User request, 2026-04-23. New initiative; not a session-retrospective §5 item.

## 1. Summary

Ship a persistent procedure-memory subsystem that lets the agent capture, discover, and replay multi-step browser flows without re-planning from a screenshot every time. Procedures are authored once (hand-written at first; captured from session history later), stored as versioned YAML on disk outside any Claude Code state, and surfaced to the agent exclusively through six new MCP tools: `procedures.list`, `procedures.search`, `procedures.get`, `procedures.save`, `procedures.promote`, `procedures.delete`.

Three design commitments, load-bearing:

1. **Metadata-only at discovery.** `list` and `search` return names, descriptions, input signatures, trigger phrases — never YAML bodies. Retrieving a full body requires an explicit `get`. This keeps main-context cost bounded as the catalogue grows.
2. **Bridge is a dumb store.** The bridge persists procedures, validates schemas, builds the search index, and ranks matches. It does **not** execute procedures. Execution is agent-side: the agent reads the YAML, interprets it, calls the existing `browser.*` primitives itself, and reasons about failures using LLM capability — no state-machine runner.
3. **Composition is hierarchical with explicit `uses:` links.** A composite procedure owns its subprocedures in a `subs/` folder; reusable procedures live in a sibling `shared/` folder. Every cross-reference is declared in a `uses:` block. Bridge refuses to delete a procedure that is listed in any other's `uses:`.

On-disk root: `~/browserops/procedures/` (user-visible, non-hidden, per-user). Deliberately **not** under `~/.browserops/` (which holds transient runtime state — token, log, socket) and **not** under any Claude Code memory tree.

## 2. Files touched

New files:

- `packages/shared/src/procedures.ts` — procedure YAML JSON-Schema, `ProcedureManifestEntry` type, `tokenize()` helper.
- `packages/shared/src/procedures.test.ts` — schema roundtrip + tokenizer tests.
- `packages/bridge/src/procedures/paths.ts` — resolve `~/browserops/procedures/` (overridable via `BROWSEROPS_PROCEDURES_DIR`).
- `packages/bridge/src/procedures/store.ts` — filesystem read/write for `procedure.yaml` files and the `subs/` hierarchy; atomic write via tmpfile + rename.
- `packages/bridge/src/procedures/index-builder.ts` — walk tree, build/refresh `index.json`.
- `packages/bridge/src/procedures/search.ts` — tokenizer, stop-word strip, weighted-field ranker.
- `packages/bridge/src/procedures/validator.ts` — Ajv-compiled validator over the procedure JSON-Schema.
- `packages/bridge/src/procedures/handlers.ts` — six MCP tool handlers.
- `packages/bridge/src/procedures/handlers.test.ts` — unit tests per handler.

Modified files:

- `packages/shared/src/errors.ts` — add `PROC_NOT_FOUND`, `PROC_ALREADY_EXISTS`, `PROC_SCHEMA_INVALID`, `PROC_IN_USE`, `PROC_OWNER_INVALID`, `PROC_DOMAIN_INVALID` to the `ErrorCode` union.
- `packages/shared/src/tools.ts` — add `PROC_CODES` bundle (~line 105 after other `*_CODES`); add six `ToolDef` constants after the last browser tool; append to `TOOL_DEFS` (bumps 24 → 30).
- `packages/shared/src/tools.test.ts` — bump `toHaveLength(24)` → `30`; per-tool schema assertions.
- `packages/bridge/src/mcp-server.ts` — (a) import `registerProcedureHandlers` and dispatch `procedures.*` tool calls in-process, bypassing the WebSocket hop; (b) extend the MCP server `instructions` string with the discovery protocol (§9).
- `packages/bridge/src/index.ts` — on startup: ensure `~/browserops/procedures/` exists, build index if missing or stale.
- `packages/bridge/package.json` — add `yaml: ^2.5.0` dependency.
- `plans/impl-00-index.md` — append a row for this plan.
- `plans/00-overview.md` — short subsection referencing the procedure-memory subsystem.

## 3. Current state

No existing macro/procedure/recording concept. Tool catalogue at 24 (impl-05 shipped). `paths.ts` in the bridge resolves `~/.browserops/` via `STATE_DIR_NAME = ".browserops"` — we deliberately don't reuse it; procedures live in a separate visible directory. `ajv` + `ajv-formats` already a bridge dependency for MCP input/output validation — reuse for procedure schema validation. No YAML parser yet → new `yaml` dep.

## 4. On-disk layout

```
~/browserops/
└── procedures/
    ├── index.json                                  # denormalized manifest; rebuilt on write
    ├── shared/                                     # reusable leaves or composites
    │   ├── gmail.send_email/
    │   │   └── procedure.yaml
    │   └── posthog.export_cohort/
    │       └── procedure.yaml
    └── email_posthog_users/                        # top-level composite
        ├── procedure.yaml                          # orchestration; refs shared + subs
        └── subs/                                   # composite-local, not cross-usable
            ├── find_users_by_event/
            │   └── procedure.yaml
            └── craft_email_body/
                └── procedure.yaml
```

Rules:

- Every procedure is a directory containing `procedure.yaml`. Directory-form (not flat files) lets a leaf grow into a composite with a `subs/` folder without renaming.
- `shared/` is the only non-composite-owned top-level location. Its children may be leaf or composite.
- Composite-owned subs live in `<composite>/subs/<name>/procedure.yaml`. Depth cap = 2: a sub cannot own its own `subs/`. A sub that is itself composite must live in `shared/`.
- Promotion from a composite's `subs/` to `shared/` goes through `procedures.promote(name, from_owner)`: filesystem move + rewrite the owning composite's `uses:` entry + rebuild index. User-confirmed, not automatic.
- Directory names are derived from the `name:` field by replacing characters outside `[a-z0-9._-]` with `_`. The canonical handle is always `name:`, never the path.
- All reads/writes go through the bridge store module — callers must not manipulate the tree directly. Enforces index freshness.

## 5. Procedure YAML schema (schema_version 1)

Full shape. `//` comments are annotations only — not part of the on-disk format.

```yaml
schema_version: 1

# Identity
name: gmail.send_email                  # required; unique across the whole tree
description: Compose and send a Gmail email via the web UI   # required; <=200 chars
kind: leaf                              # required: "leaf" | "composite"
domain: gmail                           # optional; if name has dotted prefix (x.y), defaults to "x"

# Discovery
triggers:                               # optional; author-written, in *request voice*
  - email users who did
  - send an email to
  - message someone about
tags: [email, outreach]                 # optional; <=10 short lowercase tokens

# Inputs
inputs:
  to: { type: string, required: true, description: "Recipient email address" }
  subject: { type: string, required: true }
  body: { type: string, required: true }

# Preconditions (optional, evaluated before steps; declarative only — no side effects unless fallback fires)
preconditions:
  - url_matches: "^https://mail\\.google\\.com/"
    fallback:
      action: browser.navigate
      with: { url: "https://mail.google.com/mail/u/0/" }

# Composition (composites only)
uses:                                   # required if kind=composite; listed for rename/delete safety
  - find_users_by_event                 # resolved first in ./subs/, then in ../../shared/
  - gmail.send_email

# Orchestration / concrete steps
steps:
  - id: open_compose
    action: browser.click_by_text       # primitive (any browser.* tool) OR a name listed in `uses:`
    with:
      tab_id: "{{tab_id}}"              # templating: {{input.name}} | {{step_id.field}} | {{tab_id}}
      text: Compose
    wait_for:                           # optional; primitive-style wait clause
      selector: ".compose-dialog"
    bind: compose_ref                   # optional; binds this step's return value for later {{compose_ref.*}}
    on_fail:                            # optional; alt step(s) tried before bubbling error
      - action: browser.click
        with: { tab_id: "{{tab_id}}", ref: 1 }
  - id: send_all                        # for-each form
    for_each: "{{users}}"
    as: user
    do:
      - action: gmail.send_email        # sub-procedure call by name (must appear in `uses:`)
        with:
          to: "{{user.email}}"
          subject: "{{input.subject}}"
          body: "{{input.body}}"

# Verification (optional)
success_criteria:
  - toast_text: "Message sent"

# Bridge-managed metadata (callers must not set these; save overwrites with server-controlled values)
meta:
  version: 3
  created: "2026-04-01T10:00:00Z"
  last_verified: "2026-04-20T14:22:00Z"
  success_count: 12
  failure_count: 1
```

JSON-Schema (abbreviated structural shape; authoritative definition lives in `packages/shared/src/procedures.ts`):

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "name", "description", "kind", "steps"],
  "properties": {
    "schema_version": { "const": 1 },
    "name": { "type": "string", "pattern": "^[a-z][a-z0-9_.-]{0,79}$" },
    "description": { "type": "string", "minLength": 1, "maxLength": 200 },
    "kind": { "enum": ["leaf", "composite"] },
    "domain": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 40 },
    "triggers": { "type": "array", "items": { "type": "string", "maxLength": 80 }, "maxItems": 10 },
    "tags": { "type": "array", "items": { "type": "string", "pattern": "^[a-z0-9_-]+$", "maxLength": 24 }, "maxItems": 10 },
    "inputs": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type"],
        "properties": {
          "type": { "enum": ["string", "number", "boolean", "array", "object"] },
          "required": { "type": "boolean", "default": true },
          "description": { "type": "string", "maxLength": 200 }
        }
      }
    },
    "preconditions": { "type": "array", "items": { "$ref": "#/$defs/precondition" }, "maxItems": 5 },
    "uses": { "type": "array", "items": { "type": "string" }, "uniqueItems": true, "maxItems": 20 },
    "steps": { "type": "array", "items": { "$ref": "#/$defs/step" }, "minItems": 1, "maxItems": 40 },
    "success_criteria": { "type": "array", "items": { "$ref": "#/$defs/assertion" }, "maxItems": 5 },
    "meta": { "$ref": "#/$defs/meta" }
  },
  "if": { "properties": { "kind": { "const": "composite" } } },
  "then": { "required": ["uses"] }
}
```

Conservative caps (`maxItems: 40` on steps, `maxProperties: 20` on inputs, etc.) prevent runaway files. Exceed those → `PROC_SCHEMA_INVALID`.

**Templating** is intentionally minimal: `{{input.X}}`, `{{X}}` (where X is a `bind` name or a preset like `tab_id`), and dotted field access (`{{user.email}}`). No expressions, no conditionals, no string concatenation. Anything more complex is the agent's job to compute before invoking the procedure.

## 6. `index.json` shape

```jsonc
{
  "version": 1,
  "updated": "2026-04-23T14:00:00Z",
  "procedures": {
    "gmail.send_email": {
      "path": "shared/gmail.send_email/procedure.yaml",
      "kind": "leaf",
      "domain": "gmail",
      "description": "Compose and send a Gmail email via the web UI",
      "inputs": ["to", "subject", "body"],
      "triggers": ["email users who did", "send an email to", "message someone about"],
      "tags": ["email", "outreach"],
      "owner": null,                                 // null = top-level; "<composite>" = owned sub
      "usedBy": ["email_posthog_users", "daily_digest"],
      "tokens": ["email", "gmail", "send", "compose", "outreach", "users", "message"]
      // ^ pre-tokenized union of name + description + triggers + tags + input names,
      //   stop-words stripped, lowercased. Search reads this, never the YAML.
    },
    "email_posthog_users": {
      "path": "email_posthog_users/procedure.yaml",
      "kind": "composite",
      "domain": null,
      "description": "Find PostHog users by behavior and email them",
      "inputs": ["event_filter", "email_template"],
      "triggers": ["email posthog users who did", "reach out to users with filter"],
      "tags": ["posthog", "email"],
      "owner": null,
      "uses": ["find_users_by_event", "craft_email_body", "gmail.send_email", "posthog.export_cohort"],
      "subs": ["find_users_by_event", "craft_email_body"],
      "usedBy": [],
      "tokens": ["email", "posthog", "users", "filter", "behavior", "reach", "out", "campaign"]
    },
    "find_users_by_event": {
      "path": "email_posthog_users/subs/find_users_by_event/procedure.yaml",
      "kind": "leaf",
      "owner": "email_posthog_users",
      "usedBy": ["email_posthog_users"],
      // ... other fields
    }
  }
}
```

Rebuild triggers: `save`, `delete`, `promote`, or on startup if file is missing / malformed / older than the newest `procedure.yaml` mtime. Rebuild scans the tree, re-parses each YAML, re-tokenizes. Cheap (≤O(n) on <1000 procedures).

## 7. MCP tool surface

All six tools register in `packages/shared/src/tools.ts`. They share the `PROC_CODES` bundle and all have `action_weight: 0`, `risky: "never"` except `save`, `promote`, `delete` which are `risky: "never"` but `action_weight: 0.5` (they mutate state, but not the browser).

### 7.1 `procedures.list`

```
Input: { scope?: "all" | "shared" | "composite:<name>", domain?: string }
Output: { tree: { shared: Entry[], composites: { <name>: { composite: Entry, subs: Entry[] } } } }
```

`Entry` = `{ name, kind, domain?, description, inputs, triggers, tags, usedBy? }`. No bodies. Scope defaults to `"all"`. `domain` filter applies to both top-level and subs. Listing a specific composite returns only that composite + its subs.

### 7.2 `procedures.search`

```
Input: {
  query: string,
  limit?: number = 10,       // 1..25
  min_score?: number = 0.2,  // 0..1
  domain?: string,
  scope?: "all" | "shared" | "composite:<name>" = "all",
  deep?: boolean = false     // when true, also scores tokens from step bodies
}
Output: {
  matches: Array<{ name, kind, domain?, description, inputs, triggers, score, snippet? }>,
  total: number,
  truncated: boolean
}
```

Errors: `INVALID_PARAMS` on empty query; never errors on zero matches (returns `matches: []`).

### 7.3 `procedures.get`

```
Input: { name: string }
Output: { yaml: string, path: string, meta: { version, created, last_verified, success_count, failure_count } }
```

Returns the raw YAML string (not a parsed object) — lets the agent read and reason about it verbatim. The meta fields are surfaced separately for quick freshness checks without parsing. Errors: `PROC_NOT_FOUND`.

### 7.4 `procedures.save`

```
Input: {
  name: string,              // must match the `name:` field in the yaml
  yaml: string,
  owner?: string,            // if set: saves under <owner>/subs/<name>/; else shared/<name>/
  overwrite?: boolean = false
}
Output: { saved: true, path: string, version: number }
```

Steps: (1) parse YAML → object; (2) validate against JSON-Schema; (3) validate `uses:` — every referenced name must already exist in the index or fail with `PROC_NOT_FOUND`; (4) if path exists and `overwrite: false` → `PROC_ALREADY_EXISTS`; (5) atomic write (tmp + rename); (6) rebuild index; (7) surface the new `version` (incremented if overwrite, else 1).

`meta:` fields submitted by the caller are ignored — server controls them. On save, `meta.version++`, `meta.last_verified` = now, counts preserved from prior version if overwriting.

Errors: `PROC_SCHEMA_INVALID`, `PROC_ALREADY_EXISTS`, `PROC_NOT_FOUND` (bad `uses:` ref), `PROC_OWNER_INVALID` (owner doesn't exist or isn't composite), `PROC_DOMAIN_INVALID` (domain doesn't match dotted-prefix in name).

### 7.5 `procedures.promote`

```
Input: { name: string, from_owner: string }
Output: { promoted: true, old_path: string, new_path: string, rewrote: string[] }
```

Moves `<from_owner>/subs/<name>/` → `shared/<name>/`. Rewrites the owner's `uses:` entry to reference the shared name (if the sub was named `foo` and promotion keeps the name, no rewrite needed — only needed if the name gains/loses a dotted prefix, which it shouldn't here). `rewrote` lists any files modified. Rebuilds index. Errors: `PROC_NOT_FOUND`, `PROC_OWNER_INVALID`.

### 7.6 `procedures.delete`

```
Input: { name: string, force?: boolean = false }
Output: { deleted: true, path: string }
```

Default refuses if `usedBy` is non-empty → `PROC_IN_USE` with the list of referrers in the error details. `force: true` deletes anyway (caller's problem — intended for cleanup of orphaned entries). Deleting a composite cascades to its `subs/`. Rebuilds index.

## 8. Search: ranking + tokenization + stop words

**Tokenizer** (`search.ts → tokenize(s)`):
1. Lowercase.
2. Split on `/[^a-z0-9]+/`.
3. Drop empty tokens, drop tokens ≤1 char.
4. Drop stop words. Stop-word list (fixed constant, English-only v1):
   ```
   a an the and or but if then else of for in on at to from by with
   is are was were be been being am has have had do does did
   me my you your he his she her it its we our they their them us
   this that these those what which who whom where when why how
   do dont just so not no yes maybe also please want need
   ```
5. Optional light stemming: strip trailing `s`, `ing`, `ed` if token length after strip ≥3. Keep it conservative — aggressive stemming causes false positives at this corpus size.

**Ranker** — simple weighted field match, not true BM25:

```
score(proc, queryTokens) =
    10 * |queryTokens ∩ name_tokens(proc)|
  +  8 * |queryTokens ∩ trigger_tokens(proc)|
  +  5 * (queryTokens ∩ {proc.domain})           // 0 or 1
  +  3 * |queryTokens ∩ description_tokens(proc)|
  +  2 * |queryTokens ∩ input_name_tokens(proc)|
  +  2 * |queryTokens ∩ tag_tokens(proc)|
  + (deep ? 0.5 * |queryTokens ∩ step_body_tokens(proc)| : 0)
normalized = score / (queryTokens.length * 10)    // cap at ~1.0
```

Deep mode (`deep: true`) loads and tokenizes each candidate's step bodies on the fly — the index does not pre-tokenize step bodies (too large, too churn-prone). Slower but still fast enough for <1000 procedures.

Returns sorted descending by score, filtered by `min_score`, truncated to `limit`. `snippet` is set (≤60 chars) only when the winning match wasn't purely on name — pulls the longest matched trigger or the matched description sentence.

## 9. MCP server instructions update

The existing `browserops` MCP instructions string in `mcp-server.ts` gets a new block appended. Text (copy into the `instructions:` literal; keep under 200 words):

```
Procedure memory:
- Procedures are named, parameterized, reusable action graphs living in
  `~/browserops/procedures/`. Before planning any browser task, call
  `procedures.search(<tokens from user's request>)` once. If the top match
  has score >= 0.5, load it with `procedures.get` and run its steps. If
  multiple matches are relevant (common for composite tasks like
  "email posthog users" — both posthog and gmail procedures), load all of
  them; they are meant to compose.
- `list`/`search` return metadata only; `get` returns the YAML body. Do
  not dump the full catalogue — scope via `domain` or `scope` when you
  can narrow.
- A composite procedure declares `uses: [...]`. After a `get`, fetch each
  name in `uses:` (parallel `get` calls) — that loads the full pack for
  execution.
- If no match clears threshold, plan from scratch, then offer
  `procedures.save` at the end.
- You interpret and execute procedures yourself by calling the
  `browser.*` primitives in their `steps:` — the bridge does not run
  procedures.
```

This is the agent's protocol. Everything the agent "does automatically" lives here; no magic in the tool responses themselves.

## 10. Proposed implementation — commits

### Commit A — `yaml` dep + paths module + types

- `pnpm --filter @browserops/bridge add yaml@^2.5.0`.
- Add `packages/bridge/src/procedures/paths.ts`:
  ```ts
  const ROOT = process.env.BROWSEROPS_PROCEDURES_DIR ?? path.join(os.homedir(), "browserops", "procedures");
  export const proceduresRoot = () => ROOT;
  export const sharedDir = () => path.join(ROOT, "shared");
  export const indexPath = () => path.join(ROOT, "index.json");
  export const procedureYamlPath = (owner: string | null, name: string) =>
    owner === null
      ? path.join(ROOT, "shared", dirName(name), "procedure.yaml")
      : path.join(ROOT, dirName(owner), "subs", dirName(name), "procedure.yaml");
  ```
  `dirName(name)` = `name.replace(/[^a-z0-9._-]/g, "_")`.
- Add `packages/shared/src/procedures.ts` with the `ProcedureDef` type, the JSON-Schema, the `tokenize()` helper, and the fixed stop-word list.
- Add `packages/shared/src/procedures.test.ts` covering: schema accepts the §5 example; schema rejects (a) missing `uses` on composite, (b) `maxItems` violations, (c) invalid `name` pattern; tokenizer round-trips a few known cases including stop-word strip and light stemming.
- Typecheck + test. Commit.

### Commit B — error codes + ToolDefs in shared

- Add six new `ErrorCode` entries to `packages/shared/src/errors.ts`.
- Add `PROC_CODES` bundle in `tools.ts` (~line 105):
  ```ts
  const PROC_CODES = [
    "PROC_NOT_FOUND", "PROC_ALREADY_EXISTS", "PROC_SCHEMA_INVALID",
    "PROC_IN_USE", "PROC_OWNER_INVALID", "PROC_DOMAIN_INVALID"
  ] as const satisfies readonly ErrorCode[];
  ```
- Add six `ToolDef` constants (`proceduresList`, `proceduresSearch`, `proceduresGet`, `proceduresSave`, `proceduresPromote`, `proceduresDelete`) below the last browser tool, each with the schemas from §7.
- Append all six to `TOOL_DEFS`. Bump count.
- Update `tools.test.ts`: `toHaveLength(24)` → `30`; add per-tool schema assertions (name, action_weight, risky, key required fields). Follow the impl-05 pattern.
- Typecheck + test. Commit.

### Commit C — store module

- Add `packages/bridge/src/procedures/store.ts`: `readProcedure(path): string`, `writeProcedureAtomic(path, yaml)`, `deleteProcedure(path, cascade?)`, `moveProcedure(from, to)`. Writes go tmp+rename. Uses `node:fs/promises`.
- Add `packages/bridge/src/procedures/validator.ts`: compile the Ajv validator once at module init; export `validate(parsedProcedure)` → `{ valid: boolean; errors?: string[] }` that formats Ajv errors into human-readable strings.
- Unit tests: write/read roundtrip; atomic write doesn't leave partial files on simulated crash (mock `rename` to throw); validator accepts the §5 example and rejects shape violations.
- Typecheck + test. Commit.

### Commit D — index builder

- Add `packages/bridge/src/procedures/index-builder.ts`:
  - `scanTree(root): ManifestEntry[]` — walks `shared/` and all top-level composite dirs (including their `subs/`); for each `procedure.yaml`, parses via `yaml`, validates, extracts index fields, tokenizes, populates `usedBy` by reverse-indexing `uses:` across all scanned procedures.
  - `buildIndex(root): Manifest` — returns full `{ version, updated, procedures }`.
  - `writeIndex(root, manifest)` — atomic write of `index.json`.
  - `ensureIndex(root)` — on startup: build if missing; rebuild if any `procedure.yaml` mtime newer than `index.json` mtime.
- Tests with a fixture tree fixture under `test/fixtures/procedures/` containing one shared leaf, one composite with two subs, and one deliberately-broken YAML (must be skipped with a logged warning, not crash the build).
- Typecheck + test. Commit.

### Commit E — search module

- Add `packages/bridge/src/procedures/search.ts` implementing the §8 ranker. Pure function over a parsed `index.json`: `search(index, query, options): SearchResult`.
- `deep: true` path: for candidates with non-zero top-level score, load their step bodies via the store, tokenize, add the 0.5× contribution. Stream-style — load lazily so `deep` doesn't multiply cost when few candidates survive the shallow pass.
- Tests covering: exact-name-match wins; trigger match beats description match; stop-words stripped before scoring; deep opt-in uncovers matches invisible to shallow pass; `min_score` filtering; `limit` truncation with `truncated: true`.
- Typecheck + test. Commit.

### Commit F — handlers + mcp-server wiring

- Add `packages/bridge/src/procedures/handlers.ts` with six handler functions keyed by tool name: `"procedures.list"`, `"procedures.search"`, `"procedures.get"`, `"procedures.save"`, `"procedures.promote"`, `"procedures.delete"`. Each reads the current index, performs the op, (for mutating ops) writes to disk, triggers a rebuild, returns the shape from §7.
- Export `registerProcedureHandlers(mcpServer)` that binds them into the MCP server's tool dispatch.
- Modify `mcp-server.ts`: in the `CallTool` handler, if the tool name starts with `procedures.`, dispatch in-process to the handler map; otherwise, keep the existing extension-WebSocket path.
- Modify `bridge/src/index.ts` startup to call `ensureIndex(proceduresRoot())` — create the folder if missing.
- Unit tests per handler in `handlers.test.ts` using a fixture tree (temp dir via `mkdtemp`). Cover: `list` scopes, `search` deep toggle, `get` missing → `PROC_NOT_FOUND`, `save` with bad `uses:` → `PROC_NOT_FOUND`, `save` existing without `overwrite` → `PROC_ALREADY_EXISTS`, `promote` moves files and updates owner's `uses:`, `delete` with `usedBy` non-empty → `PROC_IN_USE`, `delete` with `force: true` succeeds.
- Typecheck + test (including `pnpm --filter @browserops/bridge test:integration` if the harness is present).
- Commit.

### Commit G — MCP server instructions update + docs

- Extend the `instructions` string in `mcp-server.ts` with the §9 block.
- Append a row to `plans/impl-00-index.md`:
  ```
  | 06 | [Procedure memory](impl-06-procedures.md) | User request 2026-04-23 | Reusable action graphs |
  ```
- Add a short subsection to `plans/00-overview.md` (under existing architecture sections) pointing at this plan.
- Commit.

### Commit H — one seed procedure + a manual smoke script (optional)

- Add `examples/procedures/gmail.send_email/procedure.yaml` as a hand-authored seed. Not copied to `~/browserops/procedures/` automatically — users copy it manually during setup. Serves as living documentation of the YAML format.
- Add a short section to `README.md` pointing at the examples dir.
- Commit.

## 11. Sequencing

| # | Commit | Gate |
|---|---|---|
| A | yaml dep + paths + shared types/schema + tokenizer | `pnpm -r typecheck && pnpm test` |
| B | error codes + 6 ToolDefs in shared | `pnpm -r typecheck && pnpm test` (count 24→30) |
| C | store + validator | `pnpm -r typecheck && pnpm test` |
| D | index builder | `pnpm -r typecheck && pnpm test` |
| E | search module | `pnpm -r typecheck && pnpm test` |
| F | handlers + mcp-server wiring | `pnpm -r typecheck && pnpm test` + integration if available |
| G | instructions + plans/index updates | `pnpm -r typecheck && pnpm test` |
| H | seed example (optional) | `pnpm -r typecheck` |

No Claude attribution in commit messages. One commit per step. A single revert at step F should cleanly remove the runtime behavior while keeping the schema/types in shared for future work.

## 12. Risks / tradeoffs

- **Schema too rigid vs. too permissive.** The §5 schema caps steps at 40, uses at 20, inputs at 20. These are guesses; over-restriction will surface as validation failures on real procedures. Bias: start strict, relax on demand. The `schema_version` field is the escape hatch — v2 can loosen caps without breaking v1 readers.
- **`uses:` resolution ambiguity.** A bare name `find_users` could resolve to a local sub OR a shared leaf. Rule: composite-local first (`./subs/<name>/`), then shared. Document this ordering in both the JSON-Schema description and the `save` handler's error message when resolution fails. A dotted name (`gmail.send_email`) always resolves to shared — dots are the disambiguator.
- **Index drift.** If two bridge processes ever run simultaneously (manual invocation + auto-start), concurrent writes can corrupt `index.json`. Mitigation: advisory lock file `~/browserops/procedures/.lock` acquired via `O_EXCL` for the duration of any mutating op. Flag in the code but defer hardening — the bridge is single-instance in the current architecture.
- **Stale `usedBy` after force-delete.** `delete --force` can leave dangling references in other procedures' `uses:`. The next `save` of those referrers will fail validation, which is the intended surface for the problem. Document this explicitly — users who force-delete should expect to fix up the referrers.
- **Ranker quality at small N.** Weighted-field scoring works well at <500 procedures. Above that, the ranker's lack of document-frequency awareness (BM25's IDF term) may over-score common-word procedures. When someone's catalogue exceeds a few hundred, re-evaluate — swap in proper BM25. Keep `search.ts` interface stable so this is a drop-in change.
- **YAML as surface.** YAML is forgiving (tabs vs spaces, quoted vs unquoted scalars). The `yaml` npm package in strict mode catches most sharp edges. Surface any parse error as `PROC_SCHEMA_INVALID` with the line number from `yaml`'s error object — don't let raw parser exceptions bubble up.
- **Template language creep.** Templating is intentionally `{{input.X}}` / `{{bind.X}}` with dot access only — no expressions. Resist pressure to add conditionals, arithmetic, filters. If a procedure needs logic, the agent should compute it before invoking. This keeps the runtime zero-surprise and leaves execution in the agent's reasoning rather than a hidden DSL evaluator.
- **Disk shape is user-editable.** `~/browserops/procedures/` is visible; users can `mv`, `rm`, or edit YAML. The index can go stale. Mitigation: `ensureIndex` rebuilds on mtime mismatch at every bridge start. Document that manual edits require either a bridge restart or a trivial "touch and save" cycle via MCP.
- **Bypass of risky-domain gating.** A saved procedure that uses `browser.execute_js` still triggers the normal risky-domain prompt on each execution — the bridge does not "trust" a procedure to bypass safety. Confirm this invariant in the handlers test (spec-level assertion that procedures don't route around safety).

## 13. Open questions

1. **Location default.** `~/browserops/procedures/` is the decided root. Is the env-var override `BROWSEROPS_PROCEDURES_DIR` spelled right, or should it match an existing `BROWSEROPS_*` convention from `paths.ts`? (Low-stakes; check at Commit A.)
2. **Depth cap: 2.** Hard cap for v1. If you want truly recursive composites-of-composites later, the rule becomes "sub-composites must live in `shared/`." Current plan enforces depth=2 at the `save`-handler level. Flag if you'd rather allow recursion from day one.
3. **Seed on first run?** Commit H leaves seeds in `examples/`. Alternative: on first `bridge` start, copy `examples/` into `~/browserops/procedures/shared/` if the tree is empty. Pro: user sees a working catalogue immediately. Con: auto-populating a user-owned directory is opinionated. Recommend Commit H as written — explicit copy by user.
4. **CLI subcommand.** Decided out-of-scope for v1 (see the brainstorm). If demand appears, single `browserops procedures search <query>` subcommand reusing `handlers.ts` logic is trivial to add as a later commit.
5. **Execution engine.** Not in this plan. Agent-side interpretation via existing `browser.*` tools + MCP server-instructions protocol is sufficient for v1. If, later, certain procedures want deterministic server-side replay (for speed or to amortize cache), a `procedures.execute` tool can be added without changing the storage or discovery surface — they're orthogonal.
6. **Search `deep` default.** Currently `false`. Agents may forget to pass `deep: true` and miss matches that only appear in step bodies. Counter-argument: `deep: true` is slower and noisier. Recommend keeping `false` as the default; surface in the server instructions that agents can retry with `deep: true` when a shallow search misses.

## Critical files

- `packages/shared/src/procedures.ts` (new)
- `packages/shared/src/tools.ts` (add 6 ToolDefs)
- `packages/shared/src/errors.ts` (add 6 codes)
- `packages/bridge/src/procedures/*` (new module)
- `packages/bridge/src/mcp-server.ts` (dispatch + instructions)
- `packages/bridge/src/index.ts` (startup `ensureIndex`)
- `packages/bridge/package.json` (add `yaml`)
- `plans/impl-00-index.md` (register plan)
- `plans/00-overview.md` (link subsystem)
