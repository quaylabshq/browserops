# Plan 01 — Lower `browser_screenshot` default resolution and JPEG quality

**Source:** `session-retrospective.md` §2c / §5 priority #2.

## 1. Summary

Flip `browser.screenshot` to capture at JPEG `quality: 40` and downscale so the longest edge is ≤ `1024` px by default, while keeping the inline base64 return path (no filesystem round-trip). Add three opt-outs — `max_dimension`, `quality`, and `full_quality: true` — so callers who need pixel-level fidelity (or a specific resolution) can still get it. Expected win: ~200k chars → ~30–50k chars per shot, legibility preserved for LLM vision.

## 2. Files touched

All paths absolute.

- `/Users/saket/Documents/GitHub/browser-exp/packages/shared/src/tools.ts`, lines **380–412** — the `screenshot` `ToolDef` (inputSchema, description). New param plumbing and new defaults go here.
- `/Users/saket/Documents/GitHub/browser-exp/packages/shared/src/tools.test.ts`, lines **5–63** — existing catalogue tests (tool count stays 23, `action_weight` stays 0.5). Add focused screenshot schema assertions here (description mentions new defaults; `max_dimension` / `full_quality` declared; default `format` flipped to `"jpeg"`).
- `/Users/saket/Documents/GitHub/browser-exp/packages/extension/src/background/handlers/screenshot.ts`, lines **1–131** — the entire handler. Extends `ScreenshotParams`, adds downscale + re-encode helpers, changes the default capture format to JPEG, and threads `full_quality` as the bypass.
- `/Users/saket/Documents/GitHub/browser-exp/plans/04-tools.md` — reference-only update if the screenshot section (search: `browser.screenshot`) documents the old defaults. Only touch the paragraph(s) that explicitly state defaults.

No changes needed in `/Users/saket/Documents/GitHub/browser-exp/packages/bridge/src/mcp-server.ts`. It forwards the tool definition verbatim via `ListToolsRequestSchema` (line 193) and passes result through `toolOk` (line 369) as `structuredContent` + a JSON text mirror — it is payload-agnostic.

## 3. Current behavior

**Schema surface (shared).** `packages/shared/src/tools.ts` lines 380–412 declare:
- `format: { enum: ["png","jpeg"], default: "png" }`
- `quality: { type: "integer", minimum: 0, maximum: 100 }` (no default)
- Required output: `image_base64`, `width`, `height`, `format`.

**MCP bridge (bridge).** `packages/bridge/src/mcp-server.ts`:
- Line 193: `ListToolsRequestSchema` handler emits `TOOL_DEFS` with `inputSchema` stripped of top-level `oneOf/allOf/anyOf`.
- Line 204: `CallToolRequestSchema` handler parses params, consults safety, forwards to the extension via `callExtension` (line 320), then wraps the returned object with `toolOk` (line 369) — i.e. the result becomes `content: [{ type: "text", text: JSON.stringify(result) }]` plus `structuredContent`. There is no special "image content" path — the base64 rides inside JSON.

**Extension handler.** `packages/extension/src/background/handlers/screenshot.ts`:
- Accepts `{ tab_id, full_page?, format?, quality? }`.
- Rejects `full_page: true` with `INTERNAL` (deferred to CDP path).
- Calls `chrome.tabs.captureVisibleTab(windowId, { format, quality })`. Quality defaults to `90` when unset (line 112) and format defaults to `"png"` (line 111). `chrome.tabs.captureVisibleTab` honors `quality` only for `jpeg`.
- Strips the `data:image/...;base64,` prefix (line 67) and returns the raw base64 plus `tab.width` / `tab.height` from `chrome.tabs.get` (fallback 0,0).
- There is **no PNG→JPEG re-encode step** and **no downscaling** anywhere today. The image bytes are whatever `captureVisibleTab` produced at the tab's native viewport resolution.

**Existing tests.** `packages/shared/src/tools.test.ts` contains catalogue-level assertions only (tool count 23, `action_weight` 0.5 for screenshot). No handler-level tests exist for the extension screenshot path (`grep -rn vitest packages/extension/src` returns nothing).

## 4. Proposed implementation

Each step is independently committable and keeps `pnpm -r typecheck && pnpm test` green.

### Step 1 — Schema: add `max_dimension` and `full_quality` without changing defaults

- **Goal:** declare the new params in the shared schema so consumers (MCP clients) see them. Do not change defaults yet — this step should be a pure-additive change with no runtime behavior shift.
- **Files:** `packages/shared/src/tools.ts` (lines 380–412).
- **Change:** extend the `properties` block of `screenshot.inputSchema` with:
  - `max_dimension: { type: "integer", minimum: 1, maximum: 8192 }` (no default yet).
  - `full_quality: { type: "boolean", default: false }`.
  - Update the tool `description` to read something like: `"Capture a JPEG (default) or PNG of the visible tab, optionally downscaled, and return it base64-encoded."` — but **leave `format.default` as `"png"` and leave `quality` without a default** to keep behavior identical in this step.
- **Extension handler update (same commit):** in `parseParams` accept and validate `max_dimension` (integer ≥ 1) and `full_quality` (boolean); thread them onto `ScreenshotParams`. Do not yet use them in capture logic — just parse + ignore (with a short comment pointing to Step 3). This keeps the schema and parser aligned.
- **Verify:**
  - `pnpm -r typecheck` — catches any union/type drift from the extended `ScreenshotParams`.
  - `pnpm test` — catalogue tests still pass (tool count unchanged, `action_weight` unchanged).
  - Manual: re-run an existing screenshot call through the MCP client and confirm byte-size is unchanged.

### Step 2 — Add downscale + JPEG-re-encode helpers (behind a flag path) — still no default change

- **Goal:** implement the image-processing primitives so Step 3 is a pure defaults flip.
- **Files:** `packages/extension/src/background/handlers/screenshot.ts`.
- **Change:**
  - Add a helper `async function downscaleAndEncode(base64: string, { maxDimension, quality, targetFormat }): Promise<{ base64: string; width: number; height: number }>`.
    - Decode the incoming base64 via `fetch("data:image/" + srcFmt + ";base64," + b64).then(r => r.blob())` to get a `Blob` (MV3 service-worker safe) and then `createImageBitmap(blob)` to avoid needing a DOM `<img>`.
    - Compute new `(w, h)` preserving aspect ratio such that `max(w, h) === maxDimension` when the original exceeds it; otherwise pass-through (no upscale).
    - Draw onto an `OffscreenCanvas(w, h).getContext("2d")` and call `canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 })`.
    - Read blob bytes via `blob.arrayBuffer()` → chunked base64 encode (32 KB chunks — `btoa(String.fromCharCode(...))` blows the stack above ~100 KB).
    - Return `{ base64, width, height }`.
  - Wire a **guarded call-site** inside the existing handler that only runs when a hidden debug flag is set. The goal is to compile the code without activating it.
- **Verify:**
  - `pnpm -r typecheck` — confirms `OffscreenCanvas`, `createImageBitmap`, `convertToBlob` are known in the extension's TS lib set. If they aren't, extend `lib` in the extension's tsconfig — prefer the minimal fix.
  - `pnpm test` — unchanged.
  - Manual: byte-for-byte identical screenshot output vs. pre-change (dead code path).

### Step 3 — Flip defaults: format → jpeg, quality → 40, max_dimension → 1024

- **Goal:** make the user-facing behavior match the new defaults, honoring opt-outs.
- **Files:**
  - `packages/shared/src/tools.ts` (schema defaults).
  - `packages/extension/src/background/handlers/screenshot.ts` (runtime defaults + pipeline activation).
- **Change (schema):**
  - `format.default` → `"jpeg"`.
  - Add `quality` default: `default: 40`.
  - Add `max_dimension` default: `default: 1024`.
  - Tighten the description to explicitly state: "Default is JPEG quality 40, downscaled so the longest edge is ≤ 1024 px. Set `full_quality: true` to bypass downscale and use quality 95. Override `max_dimension` or `quality` individually."
- **Change (handler):**
  - Replace the local defaults (`format ?? "png"`, `quality ?? 90`) with the new ones: `format ?? "jpeg"`, `quality ?? 40`, `maxDimension ?? 1024`.
  - Branch on `full_quality`:
    - If `full_quality === true`, skip `downscaleAndEncode`, use `quality` of 95 and `format` unchanged — mirror current pass-through behavior.
    - Otherwise, always run `downscaleAndEncode` with the computed `maxDimension`, `quality`, and `targetFormat: "jpeg"`. Return the real post-resize `width`/`height` (from the helper), not the raw tab dimensions.
  - When the user sets `format: "png"` without `full_quality: true`, resolve the conflict: re-encode via `downscaleAndEncode` still emits JPEG by design (the whole point is small bytes). Document this in the handler comment. If the user wants true PNG, they must pass `full_quality: true`. (Alternative: honor PNG and skip quality — see Open Questions.)
- **Verify:**
  - `pnpm -r typecheck`.
  - `pnpm test` — existing catalogue tests still pass.
  - Manual (load-bearing): in the extension dev build, run `browser.screenshot { tab_id }` on a ~1400×900 tab; confirm result `width` ≤ 1024, `height` scaled proportionally, `image_base64.length` within ~30–60k range, and the JPEG opens and is legible.
  - Manual bypass: run with `full_quality: true` and confirm output is ~original size.

### Step 4 — Tests: schema assertions + handler sanity

- **Goal:** lock in the new defaults and catch regressions.
- **Files:** `packages/shared/src/tools.test.ts` (add cases, not a new file).
- **Change:** add a `describe("browser.screenshot schema")` block with:
  - `screenshot` exists and its `inputSchema.properties.format.default === "jpeg"`.
  - `inputSchema.properties.quality.default === 40`.
  - `inputSchema.properties.max_dimension.default === 1024`.
  - `inputSchema.properties.full_quality.default === false`.
  - `inputSchema.required` still equals `["tab_id"]`.
- **Handler-level test (optional, only if fast):** current `grep` shows no extension-package vitest setup, so skip this and rely on the manual verification from Step 3. Leave a TODO comment in the handler referencing Step 4.
- **Verify:**
  - `pnpm -r typecheck`.
  - `pnpm test` — new assertions pass.

### Step 5 — Plan doc housekeeping (small)

- **Goal:** keep `plans/04-tools.md` honest about the new defaults.
- **Files:** `plans/04-tools.md` (narrow edit — only the `browser.screenshot` sub-section).
- **Change:** update any sentence that says the default is PNG / full-resolution to match the new defaults; keep the rest of the file alone.
- **Verify:** `pnpm -r typecheck && pnpm test` (both still green — no code change).

## 5. Sequencing

Run `pnpm -r typecheck && pnpm test` after each and commit. Commit messages terse and scope-prefixed, no Claude attribution.

1. **Step 1** — Add `max_dimension` and `full_quality` to the schema; parse them in the handler but ignore at runtime. No behavior change. Commit.
2. **Step 2** — Add `downscaleAndEncode` helper (OffscreenCanvas + JPEG encode) and wire it behind a dead branch. No behavior change. Commit.
3. **Step 3** — Flip defaults (`format: "jpeg"`, `quality: 40`, `max_dimension: 1024`) and activate the pipeline. `full_quality: true` bypasses. Behavior change lands here. Commit.
4. **Step 4** — Add schema tests to lock in defaults. Commit.
5. **Step 5** — Update `plans/04-tools.md` to reflect new defaults. Commit.

Step ordering matters: Step 2 must land before Step 3 so the defaults flip has a working pipeline to call; Step 1 must land before Step 2 so the helper has params to read.

## 6. Risks / tradeoffs

- **Fine UI text at `quality: 40`.** Chroma subsampling and JPEG noise around small sans-serif rendering can blur sub-pixel anti-aliasing. Mitigation: `full_quality: true` escape hatch; callers who need to read dense tables or log output should bump `quality` to 80+ or pass `full_quality`.
- **`chrome.tabs.captureVisibleTab` vs `chrome.debugger` / CDP `Page.captureScreenshot`.** We stay on `captureVisibleTab`. Its `quality` applies only to JPEG (`format: "jpeg"` is mandatory for that to take effect, which the new defaults provide). CDP `Page.captureScreenshot` would allow native `clip` + capture at arbitrary scale, but it requires `chrome.debugger.attach` — deferred per existing comment in `screenshot.ts` line 10. Not in scope here.
- **Downscaling happens in the service worker.** MV3 service workers support `OffscreenCanvas` and `createImageBitmap`. If TS lib config doesn't include them, extend `lib` in the extension's tsconfig — a one-line change, still inside Step 2.
- **`format: "png"` semantics.** The plan converts everything except `full_quality: true` to JPEG regardless of requested `format`, because the point of the new defaults is byte reduction. This silently overrides the user's `format` choice in one direction. See Open Questions.
- **Width/height in the result.** Today they come from `chrome.tabs.get(tab)` (the physical viewport). After downscale they need to come from the processed image. Consumers that used `width`/`height` to reason about the tab viewport will get different numbers. Impact: low — no current callers in the repo rely on these values, and the schema contract is "image dims", not "viewport dims".
- **Base64 encoding of large buffers.** Use a chunked loop (32 KB chunks) inside `downscaleAndEncode`. Not a correctness risk once chunked; worth calling out so it lands in Step 2.
- **`captureVisibleTab` is already JPEG-capable.** We could skip the `OffscreenCanvas` step for the non-downscale case by passing `format: "jpeg", quality: 40` directly to `captureVisibleTab` and avoid an extra decode/re-encode. Optimization — see Open Questions.
- **Existing tests.** `packages/shared/src/tools.test.ts` asserts `TOOL_DEFS.length === 23` and `action_weight === 0.5`. Neither changes. No test assumes the old defaults.

## 7. Open questions

1. **PNG + non-`full_quality` interaction.** Should an explicit `format: "png"` request (without `full_quality: true`) (a) silently produce JPEG (current proposal), (b) produce a downscaled PNG at native compression, or (c) error with `INVALID_PARAMS`? Proposal: (a), documented. Decide before Step 3.
2. **Skip the round-trip when possible.** When the user opts out of downscale but not out of low quality, we could pass `format: "jpeg", quality` straight to `captureVisibleTab` and skip `OffscreenCanvas` entirely. Worth doing in Step 3 or keep it for a later optimization?
3. **`full_quality` quality floor.** Proposal: `full_quality: true` → `quality: 95` JPEG (or PNG if user explicitly asked). Does the user want `full_quality` to force PNG regardless? That gives true lossless.
4. **`max_dimension` upper bound.** Cap proposed at 8192. Is there a viewport-density story (e.g., retina 2× captures at 2880 physical px) that would justify raising it, or should we cap at the actual tab physical size?
5. **Viewport width/height vs image width/height in the result.** Should the response include both (e.g., add `viewport_width`/`viewport_height` alongside the image dims) so callers who care about UI coords still have ground truth? Low-cost schema addition if wanted.

### Critical Files for Implementation

- `packages/shared/src/tools.ts`
- `packages/extension/src/background/handlers/screenshot.ts`
- `packages/shared/src/tools.test.ts`
- `packages/bridge/src/mcp-server.ts` (read-only reference; payload-agnostic passthrough)
- `plans/04-tools.md` (doc-only update in Step 5)
