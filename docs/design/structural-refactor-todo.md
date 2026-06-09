# Structural refactor TODO

Five mechanical refactors identified in the pre-public structural audit (2026-06-09) were intentionally deferred from the launch-prep sweep. They're behaviour-preserving, but each touches a 1k+ line file or relocates entry-point sources, and the audit recommended landing each as its own focused PR with full `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm pack` verification rather than bundling them into one omnibus change.

The audit's leverage-ordered top 8 list ranked these as #1, #2/#3, #4, #5 (already swept), #6/#7 (already done), and #8 (already done). The remaining ones below are the highest-impact unfinished structural work — ideally land before external PRs start arriving against the current shape.

## 1. Split `packages/shared/src/tools.ts` (2543 lines) by tool family

Target layout:

```
packages/shared/src/tools/
├── _shared.ts        // shared schema fragments + error-code arrays (lines 56–336)
├── tabs.ts           // list/current/new/close/switch/set_session_name/release_tab
├── navigation.ts     // navigate/back/forward/reload
├── read.ts           // screenshot/read/quick_read/observe/describe_ref/query_selector
├── input.ts          // click/click_at/click_by_text/type/find_and_replace/press/scroll/hover/wait_for/wait_for_idle/execute_js/set_cdp
├── procedures.ts     // procedures_* (6) + locator helpers (browser_locate, browser_propose_locator)
├── lore.ts           // lore_* (4)
└── index.ts          // re-export TOOL_DEFS, TOOL_DEF_MAP, getToolDef
```

`tools.ts` becomes a thin re-export from `tools/index.js` so downstream consumers (bridge dispatch loop, skill docs) don't change.

Verification: `pnpm -F @browserops/shared test` should keep all 9 test files green without modification.

## 2. Split `packages/extension/src/background/handlers/input.ts` (3104 lines)

Target layout:

```
packages/extension/src/background/handlers/input/
├── click.ts          // browser_click, browser_click_at, browser_click_by_text (input.ts:2171–2842)
├── type.ts           // browser_type, browser_find_and_replace
├── press.ts          // browser_press, browser_scroll, browser_hover
├── execute-js.ts     // browser_execute_js, browser_set_cdp
├── cdp-dispatch.ts   // cdpClick/cdpType/cdpTypeKeystroke/cdpPress/cdpHover + CHAR_TO_KEY table
├── injected.ts       // injectedX(...) MAIN/ISOLATED-world functions (must stay self-contained for chrome.scripting.executeScript serialisation)
└── index.ts          // registerInputHandlers aggregator
```

`input.ts` becomes a re-export shim from `input/index.js` so `from "./input.js"` keeps working.

The split is purely mechanical; behaviour identical. Verify by running the full extension test suite + a manual smoke test of click + type + press against Gmail.

## 3. Extract `withActionPipeline` helper (depends on #2)

Six input handlers (click, click_at, type, press, hover, click_by_text) each contain ~30 lines of identical boilerplate:

```ts
captureEffect(...)
  → withEffectObservation(...)
  → checkEffectExpectation(...)
  → pollUntilMet(...)
```

Lift into `packages/extension/src/background/handlers/input/lib/action-pipeline.ts`:

```ts
export async function withActionPipeline(
  args: { chromeId; expected; expectEffect; observeEffects; network },
  dispatchFn: () => Promise<void>,
): Promise<ActionResult>;
```

Reduces `input.ts` by ~600 lines.

## 4. Move `daemon-*` siblings into `packages/bridge/src/daemon/`

Files to relocate:

- `daemon.ts`
- `daemon-runtime.ts`
- `daemon-sessions.ts`
- `daemon-socket.ts`
- `socket-mcp-transport.ts`
- `shim.ts`

Required follow-up edits:

- `packages/bridge/tsup.config.ts` — update `entry: ["src/daemon.ts", "src/shim.ts"]` to the new paths. tsup's `outBase` derivation will produce `dist/daemon.js` and `dist/shim.js` at the same flat output paths, so `bin` in `package.json` does not change.
- Intra-cluster relative imports (`./daemon-socket.js`, etc.) become `./daemon-socket.js` (same dir — no change) within the new dir.

Surfaces which files are "single-process bridge" (`mcp-server.ts`, `ws-server.ts`, `safety.ts`, …) vs "multi-session daemon" (everything in `daemon/`).

## 5. Discriminated union for `StepDef.do` / `with:` (depends on #1)

Today `StepDef.do: StepAction` (string union) and `with: Record<string, unknown>` are decoupled. A discriminated union catches invalid `with:` payloads at compile time and would have caught the duplicate `case "procedure_call"` bug (already fixed in `mapStepDoToToolName`):

```ts
export type StepDef = (
  | { do: "click"; with: ClickArgs }
  | { do: "type"; with: TypeArgs }
  | { do: "press"; with: PressArgs }
  | { do: "hover"; with: HoverArgs }
  | { do: "navigate"; with: NavigateArgs }
  | { do: "scroll"; with: ScrollArgs }
  | { do: "wait"; with: WaitArgs }
  | { do: "observe"; with: ObserveArgs }
  | { do: "js"; with: JsArgs }
  | { do: "procedure_call"; with: ProcedureCallArgs }
) & {
  id: string;
  goal?: string;
  bind?: string;
  expect?: ExpectDef;
  fallback?: FallbackDef;
  forbidden?: ForbiddenDef;
  locator?: Locator;
};
```

Pair with `mapStepDoToToolName` exhaustiveness check (already added — the `default: throw` arm will compile-time enforce coverage).

## Out of scope for the launch sweep

- **Font diet** for the extension bundle (2.2 MB across 7 files → ~600 KB via variable-axis builds + Latin-subset). Requires `glyphhanger` / `fonttools subset` outside the Node toolchain.
- **Codegen TS types from JSON-Schema** for handler param parsing. Would remove ~200 lines of boilerplate in `parseClick`/`parseType`/etc. Either codegen via `json-schema-to-typescript` or a smaller `narrow<T>(schema, raw)` Ajv helper.
- **Per-procedure dist tarball verification** in CI — would catch the `@browserops/shared` private-while-published regression at build time. Add to the release workflow when it lands.
