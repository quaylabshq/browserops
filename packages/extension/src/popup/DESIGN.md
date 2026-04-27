# Popup design system

Reference for the BrowserOps Chrome extension toolbar popup. The system is Tailwind v4-based; tokens live as `@theme` declarations in `popup.css`. The legacy `ui/tokens.css` sheet is retained only for the options page — do not extend it.

## Aesthetic direction

**Single panel, one action.** The popup is a 320 px white surface with no internal dividers in the main flow — whitespace and a single hero CTA do the work. State-altering surfaces (`#safety`, `#setup`) take over with a divider so they read as "different".

- **Surface**: pure white (`#ffffff`).
- **Ink**: near-black `#19181B`. The hex carries a faint plum tint — intentional brand warmth. Do not flatten to `#1c1c1e` or `#000`.
- **Brand**: blue `#2E5EC4` is the primary action color (Connect / Run setup / Allow). Lime `#EAF6D2` is the highlight surface (used at 50% opacity behind the pinned-empty state).
- **Whitespace**: 14 px section padding, 8 px gap stack. Dividers are reserved for takeover surfaces.
- **Type**: single weight (500) default; 400 only for body prose and helper copy. Inter Display is tracked tight (`-0.02em`); the wordmark and pinned-title go tighter still (`-0.025em`).
- **No gradients, no decorative shadows.** Elevation is a 1 px hairline at most.

## Typography

Two families, both bundled locally as `@font-face` in `popup.css` so the popup renders identically with no network dependency.

| Role | Family | Weights | When to use |
|---|---|---|---|
| Sans | Inter Display | 400, 500, 600 | All UI text. 500 default; 400 for body prose; 600 for the rare emphatic moment. |
| Mono | Commit Mono | 400, 700 (each + italic) | Technical strings: tab IDs, URLs, refs, tool names in safety prompts, JSON snippets. |

**Scale.**

| Token | Size | Use |
|---|---|---|
| `text-[10px]` | 10 px | Section titles (uppercase), pill labels, pinned URL line. |
| `text-[11px]` | 11 px | Base body, button labels, inputs. |
| `text-[12px]` | 12 px | Headings (`h2`), inline prose emphasis. |
| `text-[13px]` | 13 px | `h1` in the popup header. |
| `text-[20px]` | 20 px | Hero numerals (reserved; not used in the popup today). |

**Global metrics.** Base font-size 11 px. Default weight 500. Line-height 1.45. Letter-spacing `-0.02em` for body, `-0.025em` for the wordmark and pinned-title. Antialiasing on. Mono text inherits the same 11 px size unless otherwise specified.

**The wordmark is a brand serif** living in `assets/browserops-logo.svg`. Inter Display is for UI text only — never re-render the wordmark in Inter Display.

## Color palette

Hex first, Tailwind utility second. The Tailwind classes assume the `@theme` declarations in `popup.css` register the colors as `--color-ink`, `--color-ink-60`, etc.

### Brand (BrowserOps brand guidelines)

| Token | Hex / rgba | Tailwind | Use |
|---|---|---|---|
| Brand blue | `#2E5EC4` | `bg-brand` / `text-brand` | Primary button surface, brand-led emphasis. |
| Brand blue deep | `#2347A6` | `bg-brand-deep` | Primary button hover. |
| Brand blue 12 | `rgba(46,94,196,0.12)` | `bg-brand-12` | Subtle blue washes (rare). |
| Brand blue 08 | `rgba(46,94,196,0.08)` | `ring-brand-08` | Primary button focus ring. |
| Brand blue 04 | `rgba(46,94,196,0.04)` | `bg-brand-04` | Faintest brand wash. |
| Brand cream | `#EAF6D2` | `bg-brand-cream` | Highlight surface (hero blocks, inverse icon bg). |
| Brand cream 50 | `rgba(234,246,210,0.5)` | `bg-brand-cream-50` | Behind the pinned-empty state — soft brand presence without taking over. |

### Ink

| Token | Hex / rgba | Tailwind | Use |
|---|---|---|---|
| Ink | `#19181B` | `text-ink` / `bg-ink` | Primary text, primary button background. |
| Ink 60 | `rgba(25,24,27,0.60)` | `text-ink-60` | Secondary text, ghost button label, link default. |
| Ink 45 | `rgba(25,24,27,0.45)` | `text-ink-45` | Section titles, helper copy, pinned URL line. |
| Ink 30 | `rgba(25,24,27,0.30)` | `text-ink-30` / `bg-ink-30` | Placeholder text, `pill--off` background. |
| Ink 12 | `rgba(25,24,27,0.12)` | `border-ink-12` | Stronger 1 px borders (focus ring base). |
| Ink 08 | `rgba(25,24,27,0.08)` | `border-ink-08` | Default input borders, ghost button borders. |
| Ink 06 | `rgba(25,24,27,0.06)` | `border-ink-06` / `bg-ink-06` | Section dividers, neutral pill bg, yolo banner bg. |
| Ink 04 | `rgba(25,24,27,0.04)` | `bg-ink-04` | Ghost button hover. |

### Surface

| Token | Hex | Tailwind | Use |
|---|---|---|---|
| Surface | `#ffffff` | `bg-surface` | Primary popup canvas. |
| Surface 2 | `#fafafa` | `bg-surface-2` | Footer, recessed sections. |

### Background canvas

| Token | Hex | Tailwind | Use |
|---|---|---|---|
| Canvas | `#eaeaef` | `bg-canvas` | Dashboard-scale background. **Not used inside the 320 px popup** — the popup is a single white surface. Listed for parity with the wider design system. |

### Danger

| Token | Hex | Tailwind | Use |
|---|---|---|---|
| Danger ink | `#dc2626` | `text-danger` | Danger button label, safety tool name. |
| Danger bg | `#fef2f2` | `bg-danger-bg` | Danger button bg, safety section bg, `pill--off` (alternative). |
| Danger border | `#fecaca` | `border-danger-border` | Danger button border, safety section border. |
| Danger ink deep | `#991b1b` | `text-danger-ink` | Danger button hover label, safety tool name on hover, `pill--off` text. |

### Success

| Token | Hex | Tailwind | Use |
|---|---|---|---|
| Success ink | `#15803d` | `text-success` | Success accents (rare in the popup). |
| Success bg | `#f0fdf4` | `bg-success-bg` | `pill--on` background. |
| Success border | `#bbf7d0` | `border-success-border` | `pill--on` border. |
| Success ink deep | `#166534` | `text-success-ink` | `pill--on` text. |

## Spacing & radii

**Radii.**

| Token | Value | Use |
|---|---|---|
| `rounded-[4px]` | 4 px | Buttons, inputs, the yolo banner. |
| `rounded-[6px]` | 6 px | Cards (when used; the popup proper is flat). |
| `rounded-full` | 999 px | Pills. |

**Spacing.**

| Slot | Value |
|---|---|
| Section padding | 12 px vertical, 14 px horizontal |
| Default stack gap | 8 px |
| Tight inline gap (button icon + label, pill label) | 6 px / 4 px |
| Button height (popup scale) | 26–28 px (26 px for the paired pinned-tab actions, 28 px for solo block buttons) |
| Pill height | 18 px |
| Input height | 28 px |

**Dividers.** A 1 px `border-ink-06` top border on every section after the first. The first section (`.head`) drops the divider — nothing above to divide from.

## Components

### Button

Block-width by default in the popup. **Only one primary visible per state** — Connect *or* Disable, not both. All other CTAs are ghost. Three variants:

| Variant | Surface | Text | Border | Hover |
|---|---|---|---|---|
| Primary | `bg-brand` (`#2E5EC4`) | `text-surface` (`#fff`) | none | `bg-brand-deep` (`#2347A6`). |
| Ghost | transparent | `text-ink-60` | `border-ink-12` (inset) | `bg-ink-04`, `text-ink`. |
| Danger | `bg-danger-bg` | `text-danger-ink` | `border-danger-border` | bg → `#fde6e6`. |

**Active**: `scale-[0.98]` for 80 ms. **Disabled**: `opacity-50`, no transform. **Focus**: 3 px outer ring at `--color-brand-08` (primary), `--color-ink-08` (ghost), or `rgba(220,38,38,0.12)` (danger).

Heights: 28 px standard, 26 px in paired action rows (e.g. pin / unpin).

### Header layout

A single horizontal row holding two things, separated by `space-between`:

1. **Brand** (`.brand`) on the left — 16 px tall serif wordmark SVG.
2. **Status pill** (`.pill`) on the right — labels the connection state in 10 px text (`Connected` / `Disconnected`). Two variants: `pill--on` (green) when connected, `pill--off` (muted ink) when not. Bottom CTA text echoes the state (Connect / Disconnect).

### Toggle (iOS-style switch)

A native `<input type="checkbox">` styled as a track-and-thumb switch. Track 28 × 16 px, `rounded-full`. Thumb 12 × 12 px. Off: track `bg-ink-12`, thumb at left. On: track `bg-brand`, thumb translates 12 px right. Transition 120 ms. Focus ring 3 px in `--color-brand-08`.

| State | Track | Thumb | Use |
|---|---|---|---|
| Off | `bg-ink-12` | `bg-surface` (left) | Default — Safe mode disengaged. |
| On | `bg-brand` | `bg-surface` (right, translated 12 px) | Safe mode engaged: agent must request approval before risky actions. |
| Disabled | track 50% opacity | unchanged | Brief race-guard state. |

Used inside `.option-row` blocks — see the Option row component below.

### Section divider

A 1 px top border in `border-ink-06`. **Reserved for takeover surfaces only** (`#safety`, `#setup`). Main-flow sections are separated by whitespace, not rules. No shadows, no double rules.

### Section title

```
text-[10px] font-medium uppercase tracking-[0.06em] text-ink-45
```

Used for "Pinned tab", "Confirm risky action", and similar slot headers. Always sits at the top of its section.

### Link

Default: `text-ink-60`, no underline. Hover: `text-ink`, underline appears (1 px solid). No visited-state recolor — the popup is ephemeral and visited history is not meaningful here.

### Input

28 px tall, 10 px horizontal padding, `border-ink-08`, `rounded-[4px]`, `bg-surface`, 11 px text weight 500. Placeholder `text-ink-30`. Focus: border deepens to `border-ink-12`, plus a 3 px ring at `rgba(25,24,27,0.05)`. Mono variant swaps the family to Commit Mono for refs / tokens.

### Option row (`.option-row`)

Settings-list row: title + description on the left, toggle on the right, vertically centered. Used today for the single Safe mode option. Title is 12 px / weight 500 / `tracking-[-0.015em]`. Description is 11 px / weight 400 / `text-ink-45`. Click anywhere on the row toggles the switch (the row is wrapped in a `<label>`).

### Open options button

A `.btn--ghost.btn--block.btn--with-icon` placed inside `.section.options` directly under the Safe mode row. Holds the label "Open options" plus a trailing 12 px "external link" SVG. Click invokes `chrome.runtime.openOptionsPage()`, which opens the options page in a new tab (per `manifest.options_ui.open_in_tab: true`).

### Safety prompt block

A whole-section variant rendered in `bg-danger-bg` with the standard top divider. Contains a section title ("Confirm risky action"), a mono tool name (`text-danger-ink`), a one-line reason in default ink, and a paired Allow / Deny action row. Allow is the primary button; Deny is ghost.

## Asset inventory

| Asset | Path | Notes |
|---|---|---|
| Inter Display | `packages/extension/src/assets/fonts/InterDisplay-{Regular,Medium,SemiBold}.woff2` | 400 / 500 / 600. Loaded via `@font-face` in `popup.css`. |
| Commit Mono | `packages/extension/src/assets/fonts/CommitMono-{400,400-Italic,700,700-Italic}.woff2` | Roman + italic at 400 and 700. |
| Logo | `packages/extension/src/assets/browserops-logo.svg` | Recolored to `#19181B` for use on light surfaces. The original white-on-dark master lives at `/Users/pratham/Downloads/BrowserOps Logo.svg`. Display in the popup header at ~14 px height so the wordmark sits inline with the connection pill. |

## File map

```
packages/extension/src/
  popup/
    index.html       — popup markup; section structure
    popup.css        — Tailwind v4 entry: @theme tokens + @font-face declarations
    DESIGN.md        — this document
  assets/
    browserops-logo.svg       — ink-colored mark for light surfaces
    fonts/
      InterDisplay-Regular.woff2
      InterDisplay-Medium.woff2
      InterDisplay-SemiBold.woff2
      CommitMono-400.woff2
      CommitMono-400-Italic.woff2
      CommitMono-700.woff2
      CommitMono-700-Italic.woff2
  ui/
    tokens.css       — legacy CSS-variable sheet; consumed by options/onboarding only.
                       Do not extend; new work goes in popup.css @theme.
```

**Authoring rules.**

- Tokens are declared once in `popup.css` under `@theme { ... }` so Tailwind v4 generates `bg-ink`, `text-ink-60`, `border-danger-border`, etc. automatically.
- `@font-face` rules sit at the top of `popup.css`, ahead of `@theme`, and reference the woff2 files via the bundler's asset pipeline (`url(../assets/fonts/...)`).
- Ad-hoc hex values in markup are forbidden — every color goes through a token. If a needed shade isn't in the table above, add it to `@theme` and update this document in the same change.
