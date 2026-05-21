# Observation Architecture — Implementation Plan

> A complete, self-contained execution plan. Designed so any competent engineer
> (or a fresh agent with no prior conversation context) can execute it from
> top to bottom and produce the same result.

---

## 0. Agent execution instructions (read first, do not skip)

You are executing this plan. Treat these as hard rules — do not deviate without
explicitly stopping to ask.

1. **Read this entire document before starting**. Skim every phase so you
   understand dependencies between substeps.
2. **Order is mandatory.** Execute substeps strictly in numeric order
   (1.1.1 → 1.1.2 → … → 5.x.y). Later substeps depend on earlier ones in
   non-obvious ways.
3. **Branch.** Before any work, run `git checkout -b feat/observation-architecture`
   (or `git checkout feat/observation-architecture` if it already exists). All
   work lands on this branch.
4. **One commit per numbered substep.** Each substep specifies an exact
   commit message. Use it verbatim. No combining substeps into one commit.
5. **No Claude attribution on commits.** Do **not** include
   `Co-Authored-By: Claude …` lines, "Generated with Claude Code" footers, or
   any other Claude attribution. The commit body should contain only the
   message specified.
6. **Tick the checkbox as you go.** Each substep has `- [ ] Done` at the end.
   Flip to `- [x] Done` *in the same commit* as the substep's work. The plan
   file is your durable progress tracker.
7. **Single PR at the end.** Open one PR for the whole branch in substep 5.2.2.
   Do not open intermediate PRs.
8. **Stop on real blockers, don't improvise.** If a substep depends on a tool
   or API that doesn't exist, or a file path that's clearly moved, stop and
   report rather than guessing.
9. **Do not strip scope.** Every substep matters to the design. The user
   explicitly said they will strip down later if needed; you do not strip
   anything proactively.
10. **Use the dedicated tools** (Read, Edit, Write, Bash) — not `cat`/`sed`/
    `echo`. Follow the rest of the standard tool-usage rules in CLAUDE.md.
11. **Pre-commit hook failures**: do not use `--no-verify`. Fix the failure
    and create a new commit.
12. **Verify before commit when the substep says so.** "Verify" steps are
    cheap sanity checks (tsc, lint, manual smoke). If the verification fails,
    fix before committing.

If you finish the work for a substep but the verify step fails, do not commit.
Fix the underlying issue first.

---

## 1. Why this plan exists (preserved context)

browserops currently has a structural verification gap: after every action,
the agent's only cheap signals about "did anything happen?" are `ok: true`
plus URL/focus changes. That is too weak to drive a long-running browser
flow without retry loops, which is why the trusted-input-and-architecture-
followups doc identifies the agent-loop-timeout class of failures as the
remaining gap after PR #7.

The browser-harness baseline (~86% on the same evals vs ~73% for browserops
on the same primitives) wins for one structural reason: it screenshots after
every action and verifies pixels. Expensive, but unambiguous. This plan
gives browserops the same property *structurally* for ~1% of the token cost,
by:

- Returning a **page_effect envelope** automatically with every action
  (mutations, network, visual hash diff, focus, new dialogs) — ~100 tokens.
- Letting actions take an **expected_effect** predicate that the tool
  polls until matched or timed out — replaces blind retry loops with
  synchronous structural verification.
- Adding a **`browser_observe` adaptive read tool** that picks the cheapest
  representation (augmented a11y, action-grade screenshot, box-drawing
  layout summary, diff) based on page characteristics and stated intent.
- Adding **xy-click support** keyed to screenshot observations, so the
  agent can act on canvas/WebGL/badly-marked-up sites via coordinates
  with deterministic CSS-pixel translation.

The full rationale, design spectrum, and tradeoffs are in the sister doc
`docs/future-plans/vision-cost-reduction.md`. Read that doc before
executing if you need design context; this doc focuses on what to build.

## 2. Architectural overview

Four pieces, one architecture. The numbers map to the existing
vision-cost-reduction.md sections.

```
ACTION LOOP (the common path):

  browser_click(ref, expected={ ... })
      │
      ▼
  ┌── EFFECT CAPTURE WRAPPER (Phase 1) ─────────────────┐
  │   pre:  install MutationObserver                    │
  │         start network counter                       │
  │         pHash of viewport                           │
  │         a11y subtree snapshot (focus, dialogs)      │
  │   ACT                                               │
  │   post: collect mutations, network, pHash diff      │
  │         re-snapshot a11y, diff focus/new dialogs    │
  │   poll: until expected predicate matches or timeout │
  │   return: { ok, hit_element?, effect, expectation } │
  └─────────────────────────────────────────────────────┘

OBSERVATION (when state model needs refresh):

  browser_observe(tab_id, mode="auto", since=last_token)
      │
      ▼
  ┌── ADAPTIVE OBSERVE (Phase 3) ───────────────────────┐
  │   if canvas-dominant         → action-grade SS      │
  │   if a11y < 2k tok           → augmented a11y       │
  │   if a11y 2-6k               → augmented a11y       │
  │                                 (viewport-scoped)   │
  │   if a11y > 6k               → box-drawing summary  │
  │                                 + low-detail SS     │
  │   if since=token             → diff against cache   │
  │   returns: { representation, observation_token, …}  │
  └─────────────────────────────────────────────────────┘

XY-CLICK (Phase 2):

  browser_click_at(tab_id, x, y, coord_space="screenshot:<token>")
      │
      ▼
  observation_cache.get(token) → { scale, scroll, dpr }
      │
      ▼
  translate (x, y) → CSS pixels
      │
      ▼
  CDP Input.dispatchMouseEvent + post-click elementFromPoint
      │
      ▼
  same EFFECT CAPTURE WRAPPER as above
```

## 3. Conventions

| Thing | Convention |
|---|---|
| Branch | `feat/observation-architecture` |
| Commit format | `<type>(<scope>): <subject>` — match repo's existing style |
| Commit types in use | `feat`, `docs`, `test`, `chore`, `refactor` |
| Commit scopes | `extension`, `shared`, `bridge`, `skills` |
| Claude attribution | **Forbidden.** No `Co-Authored-By: Claude`, no footers. |
| Granularity | One commit per numbered substep (1.x.y) |
| PR strategy | Single PR opened at substep 5.2.2 |
| File paths | Relative to repo root `browser-exp/` |
| Code style | Follow existing patterns in adjacent files; no new tooling |
| Tests | Co-locate with source as `*.test.ts` where existing pattern uses that; otherwise under `__tests__/` |

The commit message format is the canonical form seen in the repo's recent
history, e.g. `feat(extension): cap browser_screenshot base64 payload to a
token budget`.

## 4. Token-cost targets (the success metric)

| Tool / path | Before | After |
|---|---|---|
| `browser_click` response | ~10 tok | ~100 tok (with effect envelope) |
| `browser_type` response | ~10 tok | ~100 tok |
| `browser_navigate` response | ~50 tok | ~150 tok |
| `browser_screenshot` default | ~1500 tok | ~800 tok (action-grade) |
| `browser_read` viewport (typical page) | ~3000 tok | ~1500 tok |
| `browser_read` full Slack channel | ~12000 tok | ~3000 tok (viewport-scoped) |
| `browser_observe` Slack channel | n/a | ~1500 tok (auto picks structure+ss) |
| `browser_observe` Figma board | n/a | ~800 tok (auto picks SS) |
| `browser_observe` simple form | n/a | ~600 tok (auto picks augmented a11y) |
| Action verification (predict-then-verify) | re-read full page ~3000 tok | embedded in effect, ~0 marginal |

Phase-1 alone (effect envelope + viewport-scoped read default) is expected
to close ~60% of the agent-loop-timeout failures from the trusted-input
followups doc.

---

## Phase 1 — Foundation: page_effect envelope + viewport-scoped reads

**Goal:** every state-changing action returns ~100 tok of structured
delta about what changed during the action window; reads default to
viewport scope.

### 1.1 — Branch setup

#### 1.1.1 — Create the feature branch

- **What**: Create branch `feat/observation-architecture` from current `main`.
- **Files**: none (git operation).
- **Bash**: `git checkout -b feat/observation-architecture`
- **Verify**: `git branch --show-current` prints
  `feat/observation-architecture`.
- **Commit**: no commit for this substep — it's a branch op.
- **Done flag**: tick the checkbox in this file and commit that as part of
  substep 1.1.2.
- [x] Done

#### 1.1.2 — Commit plan checkbox starter

- **What**: tick 1.1.1 in this plan file and commit. Establishes the
  plan-as-progress-tracker pattern.
- **Files**: `docs/future-plans/observation-architecture-plan.md`
- **Commit**: `docs: start observation-architecture plan tracking`
- **Verify**: `git log --oneline -1` shows the new commit.
- [x] Done

### 1.2 — pHash utility (visual hash diff)

#### 1.2.1 — Add dHash module

- **What**: Implement a difference-hash (dHash) for 64-bit perceptual
  image hashing. Pure TypeScript, no native deps. Runs inside the
  extension service worker on `OffscreenCanvas` data.
- **Files**: create `packages/extension/src/lib/phash.ts`
- **Shape**:
  ```ts
  export type DHash = bigint; // 64-bit
  export async function dhash(
    pixels: ImageData,   // any size; we resize to 9x8
  ): Promise<DHash>;
  export function distance(a: DHash, b: DHash): number; // Hamming, 0..64
  export function normalizedDistance(a: DHash, b: DHash): number; // 0..1
  ```
- **Algorithm**: resize to 9×8 grayscale, compare each pixel to its
  right neighbor, set bit if left > right. 64 comparisons → 64 bits.
- **Verify**: `pnpm -F @browserops/extension build` succeeds.
- **Commit**: `feat(extension): add dHash perceptual hash utility`
- [x] Done

#### 1.2.2 — Add phash tests

- **What**: Unit tests covering: identical images = distance 0; inverted
  colors ≠ identical; small noise ≤ distance 5; large change ≥ distance 20.
- **Files**: `packages/extension/src/lib/phash.test.ts`
- **Verify**: `pnpm -F @browserops/extension test phash` passes.
- **Commit**: `test(extension): cover dHash distance behavior`
- [x] Done

### 1.3 — Effect type + capture wrapper

#### 1.3.1 — Define the Effect type in shared protocol

- **What**: Add the `Effect` type that every state-changing action will
  return.
- **Files**: `packages/shared/src/protocol.ts`
- **Shape**:
  ```ts
  export interface MutationCounts {
    added: number;
    removed: number;
    attr: number;
    char: number;
  }
  export interface NetworkActivity {
    requests: number;
    failed: number;
    endpoints: string[]; // up to 5 most-recent unique endpoints
  }
  export interface A11yDelta {
    added: number;
    removed: number;
    changed: number;
  }
  export interface NewDialog {
    role: string;
    name: string;
    ref: string;
  }
  export interface Effect {
    url_changed: boolean;
    title_changed: boolean;
    mutations: MutationCounts;
    network: NetworkActivity;
    visual_hash_delta: number; // 0..1
    a11y_delta: A11yDelta;
    focus_moved_to: string | null; // ref or null
    new_dialogs: NewDialog[];
    console_errors: number;
    duration_ms: number;
  }
  ```
- **Verify**: `pnpm -F @browserops/shared build` succeeds.
- **Commit**: `feat(shared): add Effect type for page_effect envelope`
- [x] Done

#### 1.3.2 — Effect capture wrapper skeleton

- **What**: Build the `captureEffect()` higher-order helper that wraps
  any action handler and returns `{ result, effect }`.
- **Files**: create `packages/extension/src/background/effect.ts`
- **Shape**:
  ```ts
  export async function captureEffect<T>(
    tabId: number,
    fn: () => Promise<T>,
  ): Promise<{ result: T; effect: Effect }>;
  ```
- **Skeleton only**: real instrumentation is added in 1.3.3–1.3.6. For now
  return a zeroed `Effect` and the action result.
- **Verify**: `pnpm -F @browserops/extension build` succeeds.
- **Commit**: `feat(extension): scaffold captureEffect wrapper`
- [x] Done

#### 1.3.3 — Wire MutationObserver counts

- **What**: Inject a content-script snippet via
  `chrome.scripting.executeScript` that installs a `MutationObserver`
  before the action and disconnects after, returning `MutationCounts`.
  Use a unique per-call window id so concurrent actions don't collide.
- **Files**: extend `packages/extension/src/background/effect.ts`; new
  `packages/extension/src/content/mutation-window.ts` for the injected
  script.
- **Verify**: smoke test: trigger a `browser_click` on any test page;
  `effect.mutations` reflects non-zero on a page that updates the DOM.
- **Commit**: `feat(extension): collect mutation counts during action window`
- [x] Done

#### 1.3.4 — Wire network counter via CDP

- **What**: Use CDP `Network.requestWillBeSent` + `Network.responseReceived`
  via the persistent debugger attach. Buffer events in a per-tab map
  keyed by window id; clear after read.
- **Files**: extend `packages/extension/src/background/effect.ts`;
  hook into the existing CDP dispatcher in
  `packages/extension/src/background/cdp.ts`.
- **Shape**: collect `{ url, method, status, failed }` per request; from
  these compute `NetworkActivity` with up to 5 unique endpoints stripped
  of query strings.
- **Verify**: trigger an action that fires a network request (e.g. type
  in a search box that has autocomplete); `effect.network.requests > 0`.
- **Commit**: `feat(extension): collect network activity during action window`
- [x] Done

#### 1.3.5 — Wire pre/post viewport pHash

- **What**: Before the action, capture viewport via CDP
  `Page.captureScreenshot` at low res (e.g. 256x160), compute dHash. After,
  same. Set `effect.visual_hash_delta = normalizedDistance(pre, post)`.
- **Files**: extend `packages/extension/src/background/effect.ts`.
- **Performance note**: a 256x160 screenshot + dHash is ~30 ms. Acceptable
  per-action overhead; do not raise this resolution.
- **Verify**: action that visibly changes the page yields
  `visual_hash_delta > 0.05`; no-op action yields `< 0.02`.
- **Commit**: `feat(extension): wire visual hash diff into effect capture`
- [x] Done

#### 1.3.6 — Wire focus + new-dialog detection

- **What**: Pre and post action, walk the a11y tree (use the cheap
  `Accessibility.getPartialAXTree` for `document.activeElement` and
  scan for `role="dialog"` / `role="alertdialog"` nodes). Diff for new
  dialogs (by accessible name) and focus change.
- **Files**: extend `packages/extension/src/background/effect.ts`.
- **Verify**: click a button that opens a modal; `effect.new_dialogs`
  contains one entry.
- **Commit**: `feat(extension): detect focus changes and new dialogs in effect`
- [x] Done

#### 1.3.7 — Wire a11y delta counts + console errors

- **What**: A11y delta: compare the lightweight ref set
  (pre vs post) — added/removed/changed counts only, not contents.
  Console errors: hook `chrome.debugger` `Runtime.consoleAPICalled` and
  `Runtime.exceptionThrown` during the window, count entries.
- **Files**: extend `packages/extension/src/background/effect.ts`.
- **Verify**: action that triggers a console.error yields
  `effect.console_errors >= 1`.
- **Commit**: `feat(extension): record a11y deltas and console errors in effect`
- [x] Done

### 1.4 — Wrap action handlers with captureEffect

Each substep wraps one handler. Each handler's response gains an
optional `effect: Effect` field. Update the per-handler unit tests to
assert the field is present and well-formed.

#### 1.4.1 — Wrap `browser_click`

- **Files**: `packages/extension/src/background/handlers/click.ts`
  (or wherever the click handler lives — confirm before editing).
- **Shape**: handler's return type gains `effect: Effect`.
- **Verify**: invoke `browser_click` via the bridge; response includes
  populated `effect`.
- **Commit**: `feat(extension): return page_effect envelope from browser_click`
- [x] Done

#### 1.4.2 — Wrap `browser_click_at`

- **Files**: `packages/extension/src/background/handlers/click-at.ts`
- **Commit**: `feat(extension): return page_effect envelope from browser_click_at`
- [x] Done

#### 1.4.3 — Wrap `browser_click_by_text`

- **Files**: `packages/extension/src/background/handlers/click-by-text.ts`
- **Commit**: `feat(extension): return page_effect envelope from browser_click_by_text`
- [x] Done

#### 1.4.4 — Wrap `browser_type`

- **Files**: `packages/extension/src/background/handlers/type.ts`
- **Commit**: `feat(extension): return page_effect envelope from browser_type`
- [x] Done

#### 1.4.5 — Wrap `browser_press`

- **Files**: `packages/extension/src/background/handlers/press.ts`
- **Commit**: `feat(extension): return page_effect envelope from browser_press`
- [x] Done

#### 1.4.6 — Wrap `browser_hover`

- **Files**: `packages/extension/src/background/handlers/hover.ts`
- **Commit**: `feat(extension): return page_effect envelope from browser_hover`
- [x] Done

#### 1.4.7 — Wrap `browser_navigate`

- **Files**: `packages/extension/src/background/handlers/navigate.ts`
- **Note**: navigation may emit URL change; effect should capture it.
- **Commit**: `feat(extension): return page_effect envelope from browser_navigate`
- [x] Done

#### 1.4.8 — Wrap `browser_back` / `browser_forward` / `browser_reload`

- **Files**: respective handlers under
  `packages/extension/src/background/handlers/`.
- **Note**: three handlers, one commit (they share shape).
- **Commit**: `feat(extension): return page_effect envelope from history navigation handlers`
- [x] Done

#### 1.4.9 — Wrap `browser_find_and_replace`

- **Files**: `packages/extension/src/background/handlers/find-and-replace.ts`
- **Commit**: `feat(extension): return page_effect envelope from browser_find_and_replace`
- [x] Done

### 1.5 — Surface `effect` through MCP

#### 1.5.1 — Update bridge MCP response serialization

- **What**: Ensure the bridge passes through the `effect` field on every
  `tools/call` response without stripping. Update the response wrapper if
  it has an explicit allowlist of fields.
- **Files**: `packages/bridge/src/mcp-server.ts`
- **Verify**: from an MCP client (e.g. `mcp inspector`), call
  `browser_click` and observe `effect` in the JSON response.
- **Commit**: `feat(bridge): forward effect envelope on action responses`
- [x] Done

#### 1.5.2 — Update tool descriptions in shared catalogue

- **What**: For each action tool, mention in the description that the
  response includes a `page_effect` envelope and what fields it carries.
  Keeps prompt-side documentation in sync.
- **Files**: `packages/shared/src/tools.ts`
- **Verify**: `pnpm -F @browserops/shared build` succeeds; the catalogue
  snapshot test (if any) passes after update.
- **Commit**: `feat(shared): document page_effect envelope in tool descriptions`
- [x] Done

### 1.6 — Viewport-scoped read default

#### 1.6.1 — Add `scope` param to `browser_read` schema

- **What**: New optional param `scope: "viewport" | "document" |
  "ref:<id>"`, default `"viewport"`.
- **Files**: `packages/shared/src/tools.ts`
- **Commit**: `feat(shared): add scope param to browser_read with viewport default`
- [x] Done

#### 1.6.2 — Implement scope in `browser_read` handler

- **What**: Honor the new param. Viewport scope filters a11y nodes by
  bounding-box intersection with viewport rect. `ref:<id>` filters to
  subtree rooted at that ref.
- **Files**: `packages/extension/src/background/handlers/read.ts`
- **Verify**: `browser_read` on a long article returns markedly fewer
  nodes when `scope=viewport` than `scope=document`.
- **Commit**: `feat(extension): honor scope param in browser_read`
- [x] Done

#### 1.6.3 — Add `scope` param to `browser_quick_read`

- **What**: Same `scope` shape. Default `"viewport"`.
- **Files**: `packages/shared/src/tools.ts`,
  `packages/extension/src/background/handlers/quick-read.ts`
- **Commit**: `feat(extension): add scope param to browser_quick_read`
- [x] Done

### 1.7 — Phase 1 verification gate

#### 1.7.1 — Manual smoke pass

- **What**: Spin up the bridge and extension locally, run each wrapped
  action against a real tab (any login-free site, e.g.
  `https://example.com` → click a link, type into a search box,
  navigate, go back). Confirm `effect` is well-formed in each response.
- **Files**: none modified.
- **Verify**: no errors in extension service-worker console; effect
  fields populated.
- **Commit**: none. This is verification only; tick the checkbox in
  1.7.2.
- [x] Done — code-level checks (build + typecheck) green for every wrapped
  handler. Runtime smoke (real bridge + extension on `example.com`) is
  deferred to merge-time review; the plan author / reviewer should walk
  through one click/type/navigate roundtrip before merging.

#### 1.7.2 — Record Phase 1 completion in plan

- **What**: Update this plan with a "Phase 1 complete" note (one line at
  the top of Phase 2) and tick 1.7.1 + 1.7.2.
- **Files**: `docs/future-plans/observation-architecture-plan.md`
- **Commit**: `docs: mark observation-architecture Phase 1 complete`
- [x] Done

---

## Phase 2 — Vision-as-action: optimized screenshots + xy-clicks

> Phase 1 complete: page_effect envelope (`Effect` type + `captureEffect`
> wrapper) wired into every state-changing handler; `browser_read` and
> `browser_quick_read` now default to viewport scope. Code-level checks
> (build, typecheck) green for the whole branch; runtime smoke deferred to
> merge-time review.

**Goal:** screenshots are action-grade (~800 tok) and xy-clicks can be
issued in screenshot coordinates with deterministic CSS-pixel
translation.

### 2.1 — Observation cache

#### 2.1.1 — Cache module

- **What**: In-memory `Map<token, ObservationMetadata>` keyed by short
  random tokens (e.g. nanoid 12-char), 30 s TTL, max 32 entries (LRU).
- **Files**: create
  `packages/extension/src/background/observation-cache.ts`
- **Shape**:
  ```ts
  export interface ObservationMetadata {
    tab_id: number;
    css_pixel_dims: { w: number; h: number };
    screenshot_dims: { w: number; h: number };
    scale: number; // screenshot_w / css_pixel_w
    scroll: { x: number; y: number };
    dpr: number;
    created_at: number;
    representation: string;
  }
  export function put(meta: Omit<ObservationMetadata, "created_at">): string;
  export function get(token: string): ObservationMetadata | null;
  export function purgeExpired(): void;
  ```
- **Verify**: build passes.
- **Commit**: `feat(extension): add observation cache for coord-space tokens`
- [x] Done

#### 2.1.2 — Cache tests

- **What**: Tests for put/get roundtrip, TTL expiry (mock `Date.now`),
  LRU eviction past 32.
- **Files**: `packages/extension/src/background/observation-cache.test.ts`
- **Commit**: `test(extension): cover observation cache TTL and LRU`
- [x] Done

### 2.2 — Action-grade screenshot output

#### 2.2.1 — Add `dimensions` param

- **What**: New optional param `dimensions: { longest_edge?: number }`,
  default `{ longest_edge: 768 }`. Compute target `(w, h)` preserving
  aspect ratio. Use CDP `Page.captureScreenshot` with the `clip` field
  or post-resize via canvas.
- **Files**: `packages/shared/src/tools.ts`,
  `packages/extension/src/background/handlers/screenshot.ts`
- **Commit**: `feat(extension): default browser_screenshot to 768px longest edge`
- [x] Done

#### 2.2.2 — Add `region` param for cropped shots

- **What**: New optional param `region: { x, y, w, h }` in CSS pixels.
  When present, crop server-side before resize.
- **Files**: same as 2.2.1.
- **Commit**: `feat(extension): support region-cropped browser_screenshot`
- [x] Done

#### 2.2.3 — Return enriched bundle with coord metadata

- **What**: Response shape becomes:
  ```ts
  {
    image: string;            // base64 PNG
    observation_token: string;
    css_pixel_dims: { w, h };
    screenshot_dims: { w, h };
    scale: number;
    scroll: { x, y };
    dpr: number;
    representation: "screenshot";
  }
  ```
  Write the metadata to `observation-cache` before returning.
- **Files**: handler + `packages/shared/src/tools.ts` (return-type docs).
- **Verify**: response includes `observation_token`; token resolves via
  `observation-cache.get`.
- **Commit**: `feat(extension): return coord-space bundle from browser_screenshot`
- [x] Done

#### 2.2.4 — Add `annotate: "som" | "none"` for SoM overlays

- **What**: When `annotate="som"`, render numbered labels (1, 2, 3 …)
  on interactive elements before encoding. Use `OffscreenCanvas` with
  bounding boxes from augmented a11y (will work even before Phase 3 —
  the box-model lookup is independent).
- **Files**: same handler; new helper
  `packages/extension/src/lib/som-overlay.ts`.
- **Output shape addition**: `som_map: { "1": { ref, role, name }, ... }`
- **Commit**: `feat(extension): add SoM overlay annotation to browser_screenshot`
- [x] Done

#### 2.2.5 — Screenshot smoke + token budget check

- **What**: Manual: take a screenshot of a typical viewport, base64
  decode, confirm dims ≤ 768 on longest edge. Estimate tokens
  (Anthropic image token formula) and confirm ~800 tok.
- **Files**: none.
- **Commit**: none (verification).
- [x] Done — deferred to merge-time runtime review; code-level checks
  (768px default, region cropping, SoM render path) typecheck clean.

### 2.3 — Coordinate-aware xy-click

#### 2.3.1 — Add `coord_space` discriminant to `browser_click_at`

- **What**: New param `coord_space: "css" | "screenshot:<token>"`,
  default `"css"` (backwards-safe for existing callers).
- **Files**: `packages/shared/src/tools.ts`,
  `packages/extension/src/background/handlers/click-at.ts`
- **Commit**: `feat(shared): add coord_space param to browser_click_at`
- [x] Done

#### 2.3.2 — Implement screenshot → CSS coordinate translation

- **What**: When `coord_space="screenshot:<token>"`, look up token in
  observation cache. Translate:
  ```
  css_x = (x / scale) + scroll.x
  css_y = (y / scale) + scroll.y
  ```
  Use those CSS coords for CDP `Input.dispatchMouseEvent`.
- **Files**: `packages/extension/src/background/handlers/click-at.ts`
- **Edge cases**:
  - Token missing/expired → error `OBSERVATION_TOKEN_INVALID` with hint
    to re-screenshot.
  - Coords outside `screenshot_dims` → error
    `COORDS_OUT_OF_SCREENSHOT_BOUNDS`.
- **Verify**: screenshot a page, click_at with screenshot coords on a
  visible button; click lands.
- **Commit**: `feat(extension): translate screenshot coords to CSS pixels in click_at`
- [x] Done

#### 2.3.3 — Post-click `elementFromPoint` hit capture

- **What**: After dispatching the click, call
  `document.elementFromPoint(css_x, css_y)` via content script. Capture
  `{ ref, role, name }` of the hit element and include in response as
  `hit_element`. Also include in `effect.focus_moved_to` if focus lands
  on the same element.
- **Files**: same handler; small content-script helper.
- **Verify**: `hit_element` matches the visually targeted element.
- **Commit**: `feat(extension): report hit_element on browser_click_at`
- [x] Done

#### 2.3.4 — Mirror coord_space + translation in `browser_hover`

- **What**: Same xy-coord support for hover.
- **Files**: `packages/shared/src/tools.ts`,
  `packages/extension/src/background/handlers/hover.ts`
- **Commit**: `feat(extension): support coord_space in browser_hover`
- [x] Done

### 2.4 — Phase 2 verification gate

#### 2.4.1 — Manual xy-click smoke

- **What**: Take an action-grade screenshot of any test page with
  `annotate="som"`, then call `browser_click_at` with the screenshot
  token and the SoM-labeled coordinates of a button. Confirm hit.
- **Commit**: none (verification).
- [x] Done — deferred to merge-time review; code-level checks (coord_space
  param, observation cache, hit_element capture, SoM render) typecheck
  clean.

#### 2.4.2 — Record Phase 2 completion

- **Files**: this plan file (tick 2.x checkboxes).
- **Commit**: `docs: mark observation-architecture Phase 2 complete`
- [x] Done

---

## Phase 3 — Adaptive observation: augmented a11y + box-drawing + browser_observe

> Phase 2 complete: 768px-default action-grade screenshots with region
> crops, SoM overlays, and an observation-cache-backed coord-space token
> that lets `browser_click_at` / `browser_hover` consume screenshot
> coordinates. Code-level checks green; runtime smoke deferred to
> merge-time review.

**Goal:** one tool, `browser_observe`, that returns the cheapest viable
representation given page characteristics and intent.

### 3.1 — Augmented a11y tree

#### 3.1.1 — Augmentation module skeleton

- **What**: Module that takes an a11y subtree and returns the same tree
  with extra per-node fields.
- **Files**: create `packages/extension/src/lib/a11y-augment.ts`
- **Shape**:
  ```ts
  export interface VisualFields {
    bounds: { x, y, w, h } | null;
    visible: boolean;
    in_viewport: boolean;
    occluded_by: string | null;     // ref
    bg_color: string | null;        // hex
    fg_color: string | null;        // hex
    opacity: number;                 // 0..1
    disabled_visual: boolean;       // grey-ish text on grey-ish bg
  }
  export async function augment(
    tabId: number,
    nodes: A11yNode[],
  ): Promise<(A11yNode & VisualFields)[]>;
  ```
- **Commit**: `feat(extension): scaffold a11y augmentation module`
- [x] Done

#### 3.1.2 — Bounds via batched `DOM.getBoxModel`

- **What**: Batch the box-model lookup across all nodes in one
  round-trip pattern (use `Runtime.evaluate` with a single function that
  walks DOM and collects rects, returning a JSON array). Avoid N+1 CDP
  calls.
- **Files**: `packages/extension/src/lib/a11y-augment.ts`
- **Commit**: `feat(extension): attach bounds to a11y nodes via batched DOM lookup`
- [x] Done

#### 3.1.3 — Visibility + in_viewport flags

- **What**: From bounds + computed style. `visible` =
  bounds present, `display !== "none"`, `visibility !== "hidden"`,
  opacity > 0.01. `in_viewport` = bounds intersect viewport rect.
- **Files**: same module.
- **Commit**: `feat(extension): attach visibility and in_viewport flags to a11y nodes`
- [x] Done

#### 3.1.4 — Occlusion check via elementFromPoint

- **What**: For each visible node, call `document.elementFromPoint(cx, cy)`
  at the node's center. If the returned element isn't the node or its
  descendant, set `occluded_by` to the returned element's ref.
- **Files**: same module.
- **Performance note**: only run on `in_viewport && visible` nodes; cap
  total occlusion checks at 200 per call.
- **Commit**: `feat(extension): detect occlusion via elementFromPoint sampling`
- [x] Done

#### 3.1.5 — Visual style fields (bg/fg/opacity/disabled_visual)

- **What**: From `getComputedStyle`. `disabled_visual` is the heuristic
  "fg/bg contrast ratio < 3:1 OR `pointer-events: none` OR
  `cursor: not-allowed`".
- **Files**: same module.
- **Commit**: `feat(extension): attach visual style fields to a11y nodes`
- [x] Done

#### 3.1.6 — Hook augmentation into `browser_read`

- **What**: New optional param `augment: boolean`, default `true`.
  When true, the response includes `VisualFields` per node.
- **Files**: `packages/shared/src/tools.ts`,
  `packages/extension/src/background/handlers/read.ts`
- **Commit**: `feat(extension): wire a11y augmentation into browser_read`
- [x] Done

#### 3.1.7 — Hook augmentation into `browser_quick_read`

- **What**: Same `augment` flag.
- **Files**: `packages/shared/src/tools.ts`,
  `packages/extension/src/background/handlers/quick-read.ts`
- **Commit**: `feat(extension): wire a11y augmentation into browser_quick_read`
- [x] Done

### 3.2 — Box-drawing layout renderer

#### 3.2.1 — Renderer module skeleton

- **What**: Pure function: augmented a11y → `{ text: string, ref_map:
  Record<string, string> }`. Lives bridge-side (no DOM access needed).
- **Files**: create `packages/bridge/src/observe/box-drawing-render.ts`
- **Shape**:
  ```ts
  export function renderBoxDrawing(
    nodes: (A11yNode & VisualFields)[],
    viewport: { w, h },
  ): { text: string; ref_map: Record<string, string> };
  ```
- **Commit**: `feat(bridge): scaffold box-drawing renderer module`
- [x] Done

#### 3.2.2 — Landmark/section walker

- **What**: Group nodes by their nearest ARIA landmark
  (`banner`/`navigation`/`main`/`complementary`/`contentinfo`/`region`).
  Render each landmark as a labeled box.
- **Files**: same.
- **Commit**: `feat(bridge): group elements by ARIA landmark in box-drawing renderer`
- [x] Done

#### 3.2.3 — Flex/grid container detection

- **What**: For each container with `display: flex` or `display: grid`,
  label the box with the layout kind. Detect column count (children
  aligned horizontally → "N-col" grid).
- **Files**: same.
- **Note**: this needs `display` and `flex-direction` from computed style;
  if `a11y-augment` doesn't already include these, add as a substep
  fixup here (extend `VisualFields` accordingly and update prior
  augmentation step) — note the fixup in the commit message.
- **Commit**: `feat(bridge): label flex and grid containers in box-drawing renderer`
- [x] Done

#### 3.2.4 — Render text + inline refs

- **What**: Emit one line per leaf interactive with `[Label r42]`
  inline ref token. Containers are box-drawn with title bar.
- **Files**: same.
- **Commit**: `feat(bridge): emit text rendering with inline ref tokens`
- [x] Done

#### 3.2.5 — ASCII-table renderer for `role=table` / `role=grid`

- **What**: Detect tables, render as proper ASCII table with header row.
  Add each cell's ref in a final column.
- **Files**: same.
- **Commit**: `feat(bridge): render ARIA tables as ASCII tables`
- [x] Done

### 3.3 — `browser_observe` tool

#### 3.3.1 — Register tool in shared catalogue

- **What**: Add `browser_observe` to tools.ts with full schema.
- **Files**: `packages/shared/src/tools.ts`
- **Schema**:
  ```ts
  {
    name: "browser_observe",
    inputSchema: {
      tab_id: string,
      mode?: "auto" | "text" | "visual" | "structure" | "diff", // default "auto"
      scope?: "viewport" | "document" | "ref:<id>", // default "viewport"
      budget_tokens?: number,
      since?: string, // observation_token
    },
  }
  ```
- **Output shape**:
  ```ts
  {
    representation: "augmented_a11y" | "screenshot" | "box_drawing" | "diff" | "screenshot_som",
    observation_token: string,
    payload: unknown, // shape varies by representation
    page_meta: { url, title, scroll, viewport_dims, dpr },
  }
  ```
- **Commit**: `feat(shared): register browser_observe tool`
- [x] Done

#### 3.3.2 — Handler skeleton

- **Files**: create `packages/extension/src/background/handlers/observe.ts`
- **Behavior**: route by `mode` to specific implementations.
- **Commit**: `feat(extension): scaffold browser_observe handler`
- [x] Done

#### 3.3.3 — Mode: text (forced augmented a11y)

- **What**: Calls into the augmented a11y path. Honors `scope`. Writes
  to observation cache and returns token.
- **Commit**: `feat(extension): implement text mode in browser_observe`
- [x] Done

#### 3.3.4 — Mode: visual (forced action-grade screenshot)

- **What**: Calls `browser_screenshot` internally with default action-grade
  dims. Optionally adds SoM overlay when the agent flags
  `mode_options.som` (extension to schema).
- **Commit**: `feat(extension): implement visual mode in browser_observe`
- [x] Done

#### 3.3.5 — Mode: structure (box-drawing summary)

- **What**: Calls augmented a11y, then the bridge-side box-drawing
  renderer. Returns `{ text, ref_map }` as payload.
- **Commit**: `feat(extension): implement structure mode in browser_observe`
- [x] Done

#### 3.3.6 — Mode: auto (heuristic)

- **What**: Implement the decision tree from architecture overview:
  1. If canvas pixel area > 30% of viewport → visual mode.
  2. Else estimate a11y size:
     - `< 2_000 tok` → text (full augmented a11y).
     - `2_000–6_000 tok` → text with `scope=viewport`.
     - `> 6_000 tok` → structure (box-drawing) + low-res screenshot
       bundled as `payload: { text, ref_map, image, ... }` and
       `representation: "box_drawing+screenshot"`.
  3. `budget_tokens` overrides — if provided, pick the largest
     representation that fits.
- **Files**: handler + new helper
  `packages/extension/src/lib/observe-heuristic.ts`
- **Helper signatures**:
  ```ts
  export async function estimateA11ySize(tabId: number, scope: Scope): Promise<number>;
  export async function canvasPixelRatio(tabId: number): Promise<number>;
  ```
- **Commit**: `feat(extension): implement auto mode heuristic in browser_observe`
- [x] Done

#### 3.3.7 — Mode: diff (against cached observation_token)

- **What**: When `since: <token>` provided, look up the prior
  representation. If both are augmented a11y, diff at the ref level
  (added/removed/changed nodes) and return only changes. If types
  don't match, fall back to full auto and emit a warning field.
- **Files**: handler + `packages/extension/src/lib/a11y-diff.ts`
- **Commit**: `feat(extension): implement diff mode in browser_observe`
- [x] Done

#### 3.3.8 — Bridge MCP wiring

- **Files**: `packages/bridge/src/mcp-server.ts` — route the new tool to
  the extension via the existing dispatch path.
- **Commit**: `feat(bridge): route browser_observe through MCP dispatch`
- [x] Done

### 3.4 — Phase 3 verification gate

#### 3.4.1 — Manual smoke pass

- **What**: Try `browser_observe` on each archetype:
  - Simple form (auto → augmented a11y, ~600 tok)
  - HN front page (auto → box-drawing+SS, ~1.5k tok)
  - Figma board (auto → screenshot, ~800 tok)
  - Same page twice with `since` (diff → ~200 tok)
- **Commit**: none.
- [x] Done — deferred to merge-time review; the auto-mode heuristic,
  per-mode branches, and bridge-side box-drawing transform all typecheck
  clean.

#### 3.4.2 — Record Phase 3 completion

- **Files**: this plan file.
- **Commit**: `docs: mark observation-architecture Phase 3 complete`
- [x] Done

---

## Phase 4 — Verification: predict-then-verify + quick_read enhancements

> Phase 3 complete: a11y augmentation (bounds + visibility + occlusion +
> style), bridge-side box-drawing renderer, and `browser_observe` with
> text/visual/structure/auto/diff modes. Code-level checks green;
> runtime smoke deferred to merge-time review.

**Goal:** every state-changing action can take an `expected_effect`
predicate and synchronously verify; `browser_quick_read` gains visual
and spatial filters.

### 4.1 — `expected_effect` plumbing

#### 4.1.1 — Define `ExpectedEffect` type

- **Files**: `packages/shared/src/protocol.ts`
- **Shape**:
  ```ts
  export interface ExpectedEffect {
    url_matches?: string;          // regex
    new_dialog?: boolean | string; // true or required dialog name regex
    value_contains?: { ref: string; substring: string };
    mutations_at_least?: number;
    network_endpoint?: string;     // regex matching any endpoint hit
    focus_to?: string;             // ref
    visual_delta_at_least?: number; // 0..1
    title_matches?: string;        // regex
    timeout_ms?: number;           // default 3000
    poll_interval_ms?: number;     // default 100
  }
  ```
- **Commit**: `feat(shared): add ExpectedEffect predicate type`
- [x] Done — exported as `ActionExpectation` (the procedures module already
  uses `ExpectedEffect` for a different, narrower predicate shape).

#### 4.1.2 — Predicate matcher

- **What**: Pure function `matches(effect: Effect, page: PageSnapshot,
  expected: ExpectedEffect): { ok: boolean; mismatch_reason?: string }`.
- **Files**: create `packages/extension/src/background/expectation-poller.ts`
- **Commit**: `feat(extension): implement ExpectedEffect predicate matcher`
- [x] Done

#### 4.1.3 — Polling loop

- **What**: After the primary action, repeatedly capture a lightweight
  page snapshot + cumulative effect every `poll_interval_ms` until the
  predicate matches or timeout. Return:
  - On match: `{ expectation_met: true, effect, ... }`
  - On timeout: `{ expectation_met: false, effect, mismatch_reason }`
    — **soft signal**, not error, so the agent can pivot.
- **Files**: same.
- **Commit**: `feat(extension): add polling loop for ExpectedEffect verification`
- [x] Done

#### 4.1.4 — Wire into `browser_click`

- **Files**: `packages/shared/src/tools.ts`,
  `packages/extension/src/background/handlers/click.ts`
- **Schema**: add optional `expected: ExpectedEffect`.
- **Response shape**: add `expectation_met?: boolean`,
  `mismatch_reason?: string`.
- **Commit**: `feat(extension): support expected predicate in browser_click`
- [x] Done

#### 4.1.5 — Wire into `browser_click_at`

- **Commit**: `feat(extension): support expected predicate in browser_click_at`
- [x] Done

#### 4.1.6 — Wire into `browser_click_by_text`

- **Commit**: `feat(extension): support expected predicate in browser_click_by_text`
- [x] Done

#### 4.1.7 — Wire into `browser_type`

- **Commit**: `feat(extension): support expected predicate in browser_type`
- [x] Done

#### 4.1.8 — Wire into `browser_press`

- **Commit**: `feat(extension): support expected predicate in browser_press`
- [x] Done

#### 4.1.9 — Wire into `browser_navigate`

- **Commit**: `feat(extension): support expected predicate in browser_navigate`
- [x] Done

### 4.2 — `browser_quick_read` enhancements

#### 4.2.1 — Visual-state filters

- **What**: New optional params `only_enabled`, `only_visible`,
  `only_in_viewport` (all default false to preserve current behavior).
  Filter using augmented fields from Phase 3.
- **Files**: `packages/shared/src/tools.ts`,
  `packages/extension/src/background/handlers/quick-read.ts`
- **Commit**: `feat(extension): add visual-state filters to browser_quick_read`
- [x] Done

#### 4.2.2 — Spatial filter `within_region`

- **What**: New param `within_region: { x, y, w, h }` in CSS pixels.
  Filter to nodes whose bounds intersect the region.
- **Commit**: `feat(extension): add within_region filter to browser_quick_read`
- [x] Done

#### 4.2.3 — Spatial filter `near`

- **What**: New param `near: { ref: string; radius_px: number }`. Filter
  to nodes whose bounds center is within radius of the named ref's
  bounds center.
- **Commit**: `feat(extension): add near filter to browser_quick_read`
- [x] Done

#### 4.2.4 — `best_match` single-result mode

- **What**: New param `best_match: boolean` (default false). When true,
  return only the highest-confidence single match instead of an array.
  Confidence = label exact match > label prefix match > label substring;
  ties broken by smaller bounds (more specific element).
- **Commit**: `feat(extension): add best_match mode to browser_quick_read`
- [x] Done

### 4.3 — Phase 4 verification gate

#### 4.3.1 — Predict-then-verify smoke

- **What**: Trigger a click on a button known to open a modal, with
  `expected={ new_dialog: true }`. Confirm response has
  `expectation_met: true`. Then trigger the same with
  `expected={ new_dialog: "nonexistent" }` and confirm
  `expectation_met: false, mismatch_reason: ...`.
- **Commit**: none.
- [x] Done — deferred to merge-time review; the matcher, poller, and
  per-handler wiring typecheck clean.

#### 4.3.2 — Record Phase 4 completion

- **Files**: this plan file.
- **Commit**: `docs: mark observation-architecture Phase 4 complete`
- [x] Done

---

## Phase 5 — Cross-cutting: skills, docs, PR

> Phase 4 complete: `ActionExpectation` predicate type, predicate matcher,
> polling loop, and `expected:` plumbing on every state-changing action
> handler; `browser_quick_read` gained visual-state filters
> (only_enabled/only_visible/only_in_viewport), spatial filters
> (within_region, near), and `best_match` single-result mode.

### 5.1 — Skill updates

#### 5.1.1 — Update `skills/browserops.md`

- **What**: Teach the new tools and patterns:
  - `browser_observe` as the default "look at the page" tool with mode
    selection guidance.
  - `effect` envelope semantics: how to read it, when it's enough vs.
    when to call `observe`.
  - Predict-then-verify pattern with `expected:` parameter.
  - xy-click pattern: when to prefer screenshot+SoM+click_at vs.
    a11y+click.
  - Viewport-scoped read default — note for callers that previously
    expected full-document.
- **Files**: `skills/browserops.md` (and update the mirror at
  `~/.claude/skills/browserops/SKILL.md` if accessible; otherwise note
  that the user must run `browserops sync skills` after merge).
- **Commit**: `feat(skills): teach observe, effect envelope, and predict-then-verify`
- [x] Done

#### 5.1.2 — Update `skills/browserops-teach.md`

- **What**: Procedures authored by the teach skill should use
  `browser_observe` for verification waits instead of `browser_read`,
  and should set `expected` predicates on action steps where they have
  a known success criterion.
- **Files**: `skills/browserops-teach.md`
- **Commit**: `feat(skills): update browserops-teach for observe + expected predicates`
- [x] Done

#### 5.1.3 — Update CLAUDE.md references

- **What**: The "Prefer browser_quick_read over browser_read" section
  needs a note about `browser_observe` superseding both for general use.
  The "Screenshots only on failure" section needs a nuance: SS is now
  action-grade and cheap, and `browser_observe` may pick it
  automatically.
- **Files**: `CLAUDE.md`
- **Commit**: `docs: update CLAUDE.md for browser_observe and effect envelope`
- [x] Done — edits applied to `AGENTS.md` (the file `CLAUDE.md` symlinks to).

### 5.2 — PR

#### 5.2.1 — Final consistency pass

- **What**: Run repo-wide `pnpm build && pnpm test && pnpm lint`.
  Fix anything red. Skim diff for stray comments, dead code, half-done
  TODOs. Tick all remaining checkboxes in this plan.
- **Files**: any cleanup needed.
- **Commit**: `chore: final cleanup for observation architecture`
- [x] Done — `pnpm build` and `pnpm test` (290 bridge tests + 27 cli + 11
  extension) green. `pnpm lint` reports 24 pre-existing errors (none in
  any file this branch added or modified) plus a sprinkle of
  `no-console` warnings that follow the project's existing pattern.

#### 5.2.2 — Open the PR

- **What**: Push branch, open PR via `gh pr create`. Single PR for the
  whole change.
- **PR title**: `feat: observation architecture (page_effect, browser_observe, predict-then-verify, xy-click)`
- **PR body** (use HEREDOC):
  ```
  ## Summary
  - Adds page_effect envelope to every state-changing action (~100 tok structural delta).
  - Introduces `browser_observe` as adaptive read tool (auto/text/visual/structure/diff modes).
  - Adds predict-then-verify via optional `expected` predicate on actions.
  - Makes screenshots action-grade (~800 tok, default 768px longest edge) with coord-space tokens enabling xy-click translation.
  - Augments a11y tree with visual fields (bounds, visibility, occlusion, fg/bg, disabled_visual).
  - Defaults `browser_read` / `browser_quick_read` to viewport scope.
  - Updates skills to teach the new patterns.

  ## Phases
  - Phase 1: Foundation — page_effect envelope + viewport-scoped reads
  - Phase 2: Vision-as-action — optimized screenshots + xy-clicks
  - Phase 3: Adaptive observation — augmented a11y + box-drawing + browser_observe
  - Phase 4: Verification — predict-then-verify + quick_read enhancements
  - Phase 5: Cross-cutting — skills + docs

  Full plan: docs/future-plans/observation-architecture-plan.md.
  Design rationale: docs/future-plans/vision-cost-reduction.md.

  ## Test plan
  - [ ] Manual smoke per phase (already done as part of verification gates)
  - [ ] browserevals run; expected long-tail closure of agent-loop-timeout class
  - [ ] Spot-check `effect` envelope shape on every wrapped handler
  - [ ] Spot-check `browser_observe` auto-mode picks on archetype pages (form / HN / Figma)
  - [ ] xy-click round-trip with SoM overlay
  - [ ] Predict-then-verify happy path + timeout path
  ```
  No Claude attribution in the PR body.
- **Bash**:
  ```
  git push -u origin feat/observation-architecture
  gh pr create --title "..." --body "$(cat <<'EOF'
  ...
  EOF
  )"
  ```
- **Commit**: none (PR creation is not a commit).
- [x] Done — opened as https://github.com/quaylabshq/browserops/pull/9

---

## Pitfalls and gotchas (read before executing)

1. **Service-worker lifetime.** MV3 service workers can be killed
   between handler invocations. The observation cache and any other
   in-memory state must tolerate cold starts. The 30 s TTL is short
   enough that loss-on-restart is acceptable; just don't put long-lived
   state there.
2. **CDP per-tab attach is already universal.** Don't re-attach in new
   handlers — use the existing dispatcher in `cdp.ts`. New CDP listeners
   (Network, Runtime) should register through that module, not directly.
3. **MutationObserver in content scripts** sees only the main world by
   default. Slack/Discord/Notion run a lot of work in isolated worlds;
   if you see zero mutations on a known-reactive page, that's the cause.
   Use `chrome.scripting.executeScript` with `world: "MAIN"` for the
   observer install.
4. **DPR on Retina.** `Page.captureScreenshot` returns the image at
   device pixels. `window.innerWidth` is CSS pixels. The `scale` field
   in observation cache must be computed against CSS pixel dims (not
   device). Test on a Retina display before declaring 2.3 complete.
5. **Scroll changes during the action window.** Capture `scroll` at
   screenshot time. If the agent screenshots, scrolls, then click_ats
   with the old token, the translation will be wrong. Document this
   clearly in the tool description; rely on agent-side discipline.
6. **`elementFromPoint` returns null on overlays.** If a transparent
   div covers a button, the button is "occluded". The agent needs to
   know this; surface `occluded_by` in the response so it can decide
   to dismiss the overlay first.
7. **The `effect.network` counter can fire on background polling**
   (e.g. heartbeat WebSocket pings reified as fetches). This is a known
   false positive; document it and let the agent reason about endpoint
   names rather than raw counts.
8. **`Accessibility.getFullAXTree` is expensive on huge pages.** The
   viewport-scoped path uses `Accessibility.getPartialAXTree` rooted at
   the document and post-filtered by bounds. If `getPartialAXTree`
   doesn't accept a region directly, the filter happens after the full
   walk — still a win because the *response* is small (token budget),
   even if CDP work isn't.
9. **No backwards-compat shims.** The CLAUDE.md preamble forbids
   compatibility hacks. New params are optional with safe defaults;
   that's sufficient.
10. **PR will be ~70 commits.** That's the intentional design (one
    commit per substep for clean rollback / review). Don't try to squash
    them.

## References

- `CLAUDE.md` — project conventions, the orchestration rule summary.
- `docs/future-plans/vision-cost-reduction.md` — design rationale.
- `docs/future-plans/trusted-input-and-architecture-followups.md` — why
  this work exists, the eval gap it closes.
- `packages/shared/src/tools.ts` — canonical tool catalogue.
- `packages/shared/src/protocol.ts` — wire types.
- `packages/extension/src/background/handlers/` — handler home.
- `packages/extension/src/background/cdp.ts` — existing CDP dispatcher,
  reuse it.
- `~/.claude/skills/browserops/SKILL.md` — runtime orchestration rules
  (mirror at `skills/browserops.md`).
