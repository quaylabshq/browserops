# Future plans — reducing vision token cost for browser tasks

A survey of options for the recurring problem: some browser tasks genuinely
need pixels (canvas apps, visual state, spatial layout, occlusion), but
screenshots are the most expensive thing the agent can send to the model.
Captured here so the design space survives the conversation that produced it.

## The myth to bust first

**B&W images and JPEG compression do not save tokens.** Claude's image
tokenizer counts pixel patches, not bits. A 1024×768 PNG, the same image at
30%-quality JPEG, and the same image converted to grayscale all cost
identical tokens (~1568 at high detail). File size shrinks; token count
does not.

What actually reduces image tokens:

- **Resolution.** 512×384 costs ~4× less than 1024×768. Roughly linear in
  pixel count up to the model's tile size.
- **Cropping.** A 200×80 button shot is ~100 tokens vs ~1500 for a full
  viewport. Biggest single lever.
- **"low" detail mode** (when the API surface exposes it) — caps at ~258
  tokens regardless of dimensions, at the cost of fine-text legibility.

So the cheap answer is *crop tighter and scale down*, not *desaturate*.

## The "image-like state object" idea

The user-proposed approach: build an engine that parses the live page into
a structured object an LLM can read, capturing the visual context a
screenshot would convey, without paying screenshot prices. This is exactly
the direction most serious browser-automation stacks have converged on, and
browserops already ships the cheapest version of it via `browser_read` (the
a11y tree).

The full spectrum, in increasing fidelity and cost:

| Approach | What it captures | Approx. cost | Weakness |
|---|---|---|---|
| **a11y tree** (current `browser_read`) | role, name, value, hierarchy | ~50–200 tok per visible interactive | No visual state; useless on canvas |
| **Augmented a11y tree** | a11y + bounding box + visibility + occlusion + fg/bg color + in-viewport | ~30 tok/element extra | Bigger payload; still misses non-interactive visuals |
| **Set-of-Mark (SoM)** | a11y JSON + low-res screenshot with numbered boxes over interactive elements | a11y + ~400 tok screenshot | Still needs one screenshot |
| **Full structured render** | every visual property as JSON | 3–9k tok on dense pages | Significant engineering; still no help for canvas |
| **OCR sidecar** | text + bounding boxes extracted from pixels | ~500 tok | Slow; misses semantics |
| **Pure screenshot** (current `browser_screenshot`) | everything | 1.5k+ tok | Most of those tokens are wasted on chrome/whitespace |

The thing a structured render buys you over the existing a11y tree is
**visual state**: is this button greyed/disabled-looking? Is this row
highlighted? Is the error red? Did the spinner stop spinning? Is element X
occluded by a modal? These are questions where the DOM lies or stays silent
but the rendered page clearly shows the answer.

## Ranked recommendations for browserops

Highest ROI first.

### 1. Augment `browser_read` / `browser_quick_read` with visual fields

Add per-node: `visible`, `in_viewport`, `occluded_by`, `bg_color`,
`fg_color`, `bounds`, computed-style essentials (opacity, pointer-events,
disabled state inferred from style not just ARIA).

Cheap to compute via CDP: `Accessibility.getFullAXTree` +
`DOM.getBoxModel` + one server-side `Page.captureScreenshot` for color
sampling (sample a 4×4 pixel patch per element center; don't ship the
screenshot to the model).

Solves ~70% of "do I need vision?" cases in one change.

### 2. Vision-on-demand with mandatory cropping

Make `browser_screenshot` *require* a `ref` (element) or `region` (bbox)
parameter by default; full-viewport becomes opt-in with an explicit flag.
Forces 100–400 token shots instead of 1500+.

Codifies what the rules already encourage ("Screenshots only on failure")
at the tool boundary, so it can't be sidestepped by accident.

### 3. Differential reads

Second and subsequent `browser_read` calls in the same tab return only
subtrees that changed since the last call. Hash each node by stable id +
content fingerprint and diff.

Multi-step flows currently re-pay the full a11y cost every step; this is
the largest unrealized saving in long sessions. Cache key lives on the
extension side, keyed by `(tab_id, frame_id, last_read_token)`.

### 4. SoM "observe" tool

Single call returns augmented a11y JSON + one low-detail screenshot with
numbered labels rendered over interactive elements (server-side via
canvas overlay before encoding). Gives the agent spatial grounding cheaply
when text alone is ambiguous ("the third button from the left in the
header").

This is the standard pattern in WebArena / SeeAct / Anthropic's own
computer-use research, and it composes well with #1 and #2.

### 5. Local vision proxy for canvas apps

A tiny local VLM (Moondream-2, LLaVA-1.5-7B, or similar) runs alongside the
bridge and answers yes/no/bbox questions on screenshots without round-
tripping pixels to Claude. Agent asks "is the upload progress bar full?"
→ local model returns one token → Claude reasons on that.

Keeps the expensive pixels off the wire. Particularly valuable for canvas
and WebGL apps (Figma, Miro, Maps, games, charts) where the DOM is empty
and nothing structural rescues you.

### 6. Full structured render-to-JSON

The maximalist version of #1: every visual property as queryable JSON. The
right end state, but #1 + #2 captures most of the value at maybe 10% of
the engineering cost. Defer until #1 has been in use long enough to know
which additional fields actually get queried.

## Text-visual rendering — the box-drawing layout option

Separate axis from the table above: render the page as text-shaped visual
output (ASCII art, box-drawing characters, tables) instead of pixels or
JSON. Worth its own treatment because the naive form ("just render like
Lynx") fails for reasons that aren't obvious until you try.

### Three flavors, only two worth building

**Flavor A — literal ASCII grid.** Map the viewport pixels to a fixed
character grid (~160×50 cells) and render each element at its scaled pixel
position. Looks like Lynx output. Costs ~1500–3000 tokens, often *more*
than a low-detail screenshot. Killer weakness: modern flex/grid, sticky
headers, overlapping z-index, scroll containers, variable font widths, and
CJK all break the alignment. Same reason terminal browsers stopped being
viable on the modern web. **Skip.**

**Flavor B — semantic box-drawing layout summary.** Don't honor pixel
positions. Render *groupings and ordering* derived from the layout tree
(landmarks → sections → flex/grid containers → leaf interactive elements):

```
┌─ HEADER ──────────────────────────────────────────────┐
│ [Logo]  Home · About · Pricing            [Sign in]   │
└───────────────────────────────────────────────────────┘
┌─ HERO ────────────────────────────────────────────────┐
│  ## Welcome to Acme                                   │
│  [email________________] [Subscribe r42]              │
└───────────────────────────────────────────────────────┘
┌─ FEATURES (3-col grid) ───────────────────────────────┐
│ Feature 1      │ Feature 2      │ Feature 3           │
└───────────────────────────────────────────────────────┘
```

Cost: ~400–1200 tokens for a typical page. **Cheaper than the augmented
a11y tree** because per-element fields are elided in favor of structure
only. Inline refs (`[Subscribe r42]`) keep the rendered string directly
actionable. Pairs with augmented a11y — emit the box-drawing summary
first, then the augmented a11y tree behind it for elements the agent wants
to act on.

**Flavor C — ASCII tables, narrowly.** Detect `<table>` / `role=table` /
`role=grid` and render as actual ASCII tables:

```
| Date       | Amount  | Status   | r   |
|------------|---------|----------|-----|
| 2026-05-12 | $42.00  | paid     | r12 |
```

Lossless for tabular data, trivially cheap, no layout-tree heuristics
needed. Worth doing as a narrow special-case independent of Flavor B.

### Where text-visual fits in the matrix

|  | Tokens | Spatial info | Visual state | Works on canvas |
|---|---|---|---|---|
| a11y tree | low | none | none | no |
| augmented a11y | low-med | coordinates only | yes | no |
| **box-drawing summary (B)** | **low-med** | **rendered structure** | none | no |
| SoM | med | rendered structure | partial | partial |
| literal ASCII grid (A) | med-high | rendered (brittle) | none | no |
| full screenshot | high | full | full | yes |

Flavor B sits in a genuinely empty spot — cheapest way to give the agent
*rendered* spatial relationships. Beats bounding-box JSON because the LLM
doesn't have to mentally rasterize coordinates, and beats screenshots
because there are no pixels.

### Where Flavor B fails

- Canvas/WebGL — same blind spot as every text-based approach.
- Dense editing apps (Figma, Notion editor, Linear, multi-pane Slack) —
  the nested-boxes output becomes a noisy wall. Gate or auto-disable for
  these domains via the gated-domains advisor.
- Heavily image-driven pages (Pinterest, Instagram, e-commerce grids) —
  most cells say `[img]` and the summary doesn't help.

### Implementation sketch

`browser_layout` handler in `packages/extension/src/background/handlers/`:

1. Walk landmarks/`role=region` + visible sections from the a11y tree.
2. For each container, inspect computed `display` to detect flex/grid;
   label the container with its layout kind ("3-col grid", "vertical
   stack").
3. Recurse to leaf interactive elements; render each with its accessible
   name and a `r<id>` token.
4. Emit the box-drawing string plus a flat ref-map (`r42 → element ref`).
5. Domain-gate: skip or simplify on `gated_domain` apps where the output
   would be noise.

Slot into the existing roadmap between #1 (augmented a11y) and #4 (SoM).
Most valuable on form/checkout/dashboard flows where positional reasoning
currently forces a screenshot.

## The escape hatch nothing fixes

**Canvas / WebGL apps** (Figma, Maps, charts, games) have empty DOMs. No
amount of a11y augmentation rescues these. The two paths are:

- Introspect the app's own state via `browser_execute_js` against its
  internal API (Figma plugin API, Maps viewport API, framework devtools
  globals).
- The local-vision-proxy escape hatch (#5).

Worth marking these domains in the gated-domains advisor so the agent
knows up-front that vision-on-demand is the only path.

## Recommended starting point

Do #1 (augmented a11y) and #2 (mandatory-crop screenshots) first. These
two together should cut the vision budget 5–10× on flows that currently
reach for screenshots, with maybe a week of work in
`packages/extension/src/background/handlers/`. The structured-JSON engine
is the right end state but is overkill as the first step.

#3 (differential reads) is the next thing to add once #1 is in place — the
hash/diff plumbing is cleaner to build on top of an a11y tree that already
includes stable visual fingerprints per node.
