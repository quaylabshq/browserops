---
name: browserops_chrome_web_store_unscriptable
description: 'HARD WALL: the Chrome Web Store (chromewebstore.google.com) cannot
  be scripted by browserops at all — every browser_* call returns "The
  extensions gallery cannot be scripted." Any flow that reads/scrapes Web Store
  listings or reviews is impossible via browserops.'
type: reference
source: mcp-tool
created: 2026-07-09T19:44:43.516Z
updated: 2026-07-09T19:44:43.516Z
---

# Chrome Web Store — cannot be scripted (hard platform wall)

**Verified live 2026-07-10.** Navigating browserops to
`https://chromewebstore.google.com/...` and calling ANY primitive fails:

- `browser_wait_for` → `INTERNAL: The extensions gallery cannot be scripted.`
- `browser_read` → same error.

This is a Chrome security policy: the extensions gallery (like `chrome://`,
`about:`, `devtools://`) blocks all content-script injection AND CDP
scripting. It is NOT a browserops bug and there is no per-tab opt-out that
fixes it — `browser_set_cdp`, synthetic dispatch, JS injection are all
blocked at the platform layer.

## Consequence

Any procedure whose SOURCE is a Web Store listing or its reviews is
**impossible via browserops** — the page is unreadable. Do not author a
YAML for it; step 1 can never run. Blocked at the source, not the locator.

## Alternatives if the goal is Web Store review data

- No public Chrome Web Store reviews API exists.
- The developer must pull reviews from the **Chrome Web Store developer
  dashboard** (separate surface, requires publisher auth) or via the
  Chrome Web Store API for their own item — out of scope for scraping a
  third-party listing.
- Scraping a third-party extension's reviewers is not automatable here and
  (for the negative-reviewer + LinkedIn cross-reference variant) is a
  privacy problem regardless.

## Related

See [[browserops_google_sheets_bulk_fill]] — the WRITE half of a
"reviews → Google Sheet" flow is ALSO walled (canvas grid, needs a
browser_fill_range primitive). So that end-to-end flow is double-blocked.
