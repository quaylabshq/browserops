---
name: browserops_sheets_write_pr24_retest
description: 'SOLVED 2026-07-10: Google Sheets bulk-write IS possible via a
  synthetic ClipboardEvent(''paste'') carrying a constructed DataTransfer
  (text/plain TSV + text/html table) dispatched at the grid editor. One-shot, no
  OS clipboard, no manual paste. Overturns the earlier "canvas wall" verdict.
  browser_press Cmd+V and per-cell keystroke still fail; the synthetic paste is
  the working path.'
type: reference
source: mcp-tool
created: 2026-07-09T19:55:09.913Z
updated: 2026-07-09T19:58:55.198Z
---

# Google Sheets bulk-write — SOLVED via synthetic paste (2026-07-10)

Supersedes the "canvas wall" verdict in [[browserops_google_sheets_bulk_fill]].
Verified live on the PR #24 build: a **synthetic `ClipboardEvent('paste')`
carrying a constructed `DataTransfer` writes tabular data straight into the
Sheets canvas grid in ONE shot** — same class of trick that beat the X
Draft.js composer ([[browserops_x_publish_blocked]]).

## The working recipe (do: js)

1. Build the grid: rows → `text/plain` TSV (tab between cols, `\n` between
   rows) AND `text/html` `<table><tr><td>…`. Replace intra-cell newlines
   with spaces so a tweet body doesn't split into extra rows.
2. Select the anchor: focus `#t-name-box`, `execCommand('insertText', 'A1')`,
   dispatch an Enter `keydown` → grid editor `#waffle-rich-text-editor` gains
   focus at A1.
3. Paste WITHOUT the OS clipboard:
   ```js
   const dt = new DataTransfer();
   dt.setData("text/plain", tsv);
   dt.setData("text/html", html);
   const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
   document.querySelector("#waffle-rich-text-editor").dispatchEvent(ev);
   ```
   Sheets reads `clipboardData` directly and splits the payload across the
   range from the active cell. No `Page.bringToFront`, no clipboard
   permission, no manual Cmd+V.
4. Verify by sampling cells via the formula bar: focus name box → insertText
   the ref → Enter → read `#t-formula-bar-input` innerText (canvas cells are
   invisible to a11y/DOM reads; formula bar is the only per-cell oracle).

## Verified this session

14×5 table (header + 10 X posts + 3 drafts) pasted into a blank
`sheets.new`. Spot-read: B3="Posted", D6=full tweet text, E2=status URL,
B12="Draft (suggested)", D14=full draft text. All correct.

## What still does NOT work (so use the synthetic paste, not these)

- `browser_press ["Primary","KeyV"]` → keystroke only, no Paste edit-command
  → cells stay empty.
- `browser_type mode:keystroke` into the grid editor → `typed:N` but never
  commits (formula bar empty).
- `navigator.clipboard.writeText` now succeeds when the tab is OS-focused,
  but that's only needed for the manual-paste fallback; the synthetic paste
  makes it unnecessary.

## Implication

"<source> → Google Sheet" flows ARE now authorable. A procedure can't run
raw JS as cleanly as an inline call, but a `do: js` step carrying this
snippet (data templated in) writes the grid deterministically. Pair with a
formula-bar read step for the verify predicate. Next: fold this into a
`browser_fill_range`-style helper or a reusable sheets.bulk_write procedure.
