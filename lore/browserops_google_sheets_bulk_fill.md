---
name: browserops_google_sheets_bulk_fill
description: Google Sheets bulk-fill from a table is NOT authorable as a trusted
  procedure with current primitives; needs a browser_fill_range primitive (CDP
  paste command). Live-verified failure modes + the working sequence.
type: reference
source: mcp-tool
created: 2026-07-02T08:43:02.962Z
updated: 2026-07-02T08:43:02.962Z
---

# Google Sheets: filling cells from a table (why it can't be a trusted procedure yet)

**Verdict (2026-07-02, live-tested):** A "fill a range from tabular data" flow in Google Sheets CANNOT currently be authored as a working, trusted browserops procedure. The grid is canvas-rendered (cell values are NOT in the DOM/a11y tree — `browser_read`/`quick_read` can't see or verify them; only the formula bar `#t-formula-bar-input` reflects the _active_ cell). Every data-entry path is blocked or unreliable with today's tools. Do not attempt to author this until a bulk-write primitive exists.

## Failure modes, each reproduced live

1. **Clipboard paste via `navigator.clipboard.writeText`** → blocked with `NotAllowedError: Document is not focused` whenever the Chrome tab is not the OS-foreground window (the normal automation case). Also needs the clipboard-write permission.
2. **Trusted copy (CDP Cmd+C) from an injected textarea** → Sheets intercepts Cmd+C at the keydown layer; the OS clipboard is NOT updated with your text (observed: clipboard kept a stale prior value).
3. **`browser_type` ref-less** → uses `Input.insertText` (paste mode); Sheets ignores it because the cell never enters edit mode (no real keydowns). Text buffers in the hidden `#waffle-rich-text-editor` and never commits; tab chars collapse to spaces.
4. **`browser_type` WITH a ref (keystroke mode)** → inconsistent (`typed:2` of a longer string; tabs/newlines did not distribute across cells). Also O(cells) — defeats the purpose.
5. **Trusted Cmd+V (`browser_press ["Primary","KeyV"]`)** → delivers the keystroke but does NOT invoke the browser's actual _Paste edit-command_, so Sheets never reads the clipboard. Grid stays empty; `expect: mutations_at_least` gave a FALSE POSITIVE here (trust cell content via formula bar, not the mutation count).
6. **Edit menu → Paste** → Google defers to "press ⌘V"; no programmatic paste.

## The sequence that DOES work (once the missing piece exists)

Empirically, with the tab OS-focused AND clipboard-write permission granted, `navigator.clipboard.writeText(tsv)` succeeds and a read-back matches. So the only remaining gap is invoking a real paste. The full working recipe for a `browser_fill_range` primitive:

1. `Browser.grantPermissions(origin, ["clipboardReadWrite","clipboardSanitizedWrite"])` — manual grant verified to work.
2. `Page.bringToFront()` — gives the tab OS focus so the async Clipboard API stops throwing "Document is not focused" (verified: manually focusing Chrome flipped `document.hasFocus()` to true and unblocked writeText).
3. `navigator.clipboard.writeText(tsv)` — verified working once 1+2 hold (1960-char TSV, read-back `matches:true`).
4. Select anchor: drive the name box `#t-name-box` → type "A1" → Enter (focuses grid `#waffle-rich-text-editor` at the anchor). Verified working.
5. **THE MISSING PIECE:** `Input.dispatchKeyEvent({type:"rawKeyDown"/"keyUp", ..., commands:["Paste"]})` — the plain synthetic Cmd+V from `browser_press` does NOT carry the `commands` field, so Sheets never pastes. The primitive must dispatch the paste edit-command explicitly. Sheets then splits the TSV across the range in one shot.
6. Verify by sampling cells via the formula bar (select cell → read `#t-formula-bar-input` innerText) — do NOT rely on mutation counts or a11y search (canvas).

## Selectors / facts worth reusing

- New blank sheet: navigate `https://sheets.new` (lands on `/spreadsheets/d/<id>/edit`). This part IS deterministic and verifiable (url + title).
- Do NOT use `browser_wait_for_idle` on Sheets — it keeps long-poll connections open, so the network never idles (30s timeout). Wait on a DOM marker (`#t-name-box`) instead.
- Name box input: `#t-name-box` (value = current cell ref). Name box dropdown: `#t-name-box-dropdown`.
- Grid key-input sink / active cell editor: `#waffle-rich-text-editor` (hidden, positioned off-screen at y≈-9998).
- Formula bar (active cell content): `#t-formula-bar-input` (contains `.cell-input` contenteditable).
- Cell contents are canvas-drawn → invisible to a11y/DOM reads; formula bar is the only per-cell oracle.

Full writeup + build spec lives in the user's Notion: "sheet-fill was slow — why (and the fix)" under Work (BrowserOps).
