---
name: browserops_x_send_dm_flow
description: X/Twitter send-DM UI flow + tier-1 locators, FULL flow verified
  end-to-end (recipient search → select-by-handle → composer → Enter-send). X
  has NO self-DM, so send_dm can't be self-tested/trusted — draft only.
type: reference
source: mcp-tool
created: 2026-07-02T08:50:13.344Z
updated: 2026-07-02T08:53:10.952Z
---

# X / Twitter — send a DM (UI flow + tier-1 locators)

Verified end-to-end live 2026-07-02 on the new `x.com/i/chat` DM interface (redirect target of `x.com/messages`), account @prthmo. A real "hi" was sent successfully to @whysosaket and confirmed in-thread.

## Flow (all steps verified)

1. Navigate `https://x.com/messages` → redirects to `https://x.com/i/chat`.
2. Open composer: click **New message** button → "New message" dialog opens (verified via `expect.new_dialog:"New message"`).
3. Type recipient into the search box → typeahead suggestion buttons appear (one per matching account).
4. Click the suggestion whose **@handle** matches (match by handle, NOT display name — a common first name returns 10+ strangers). On click: URL changes to `/i/chat/<myUserId>-<theirUserId>`, the thread opens, and **focus auto-moves to the message composer textarea** (no extra click needed).
5. Type the message into the composer (it already has focus).
6. **Press Enter to send** (Shift+Enter = newline). Composer clears; message renders in thread; inbox row shows "You: <msg> · Now".

## Tier-1 locators (data-testid — stable)

- New-message button (inbox header): `data-testid="dm-new-chat-button"` (aria-label "New message"). Empty-state variant: `data-testid="dm-empty-conversation-new-chat-button"`.
- New-message dialog: `data-testid="dm-new-chat-modal"` (role dialog, name "New message").
- Recipient search input: `data-testid="new-dm-search-input"` (placeholder "Search name or username").
- Suggestion rows: `data-testid="new-dm-user-suggestion-<userId>"`, id `#new-dm-suggestion-<n>`, accessible name "<Display>@<handle>". To pick by handle in a procedure, use a `has_text: "@<handle>"` locator on the suggestion button (userId isn't known ahead of time).
- Message composer: a `<textarea>` inside `#dm-main-container ... > form`. It auto-focuses on recipient-select, so a ref-less/keystroke type or a `role: textbox` within `#dm-main-container` locator works. (Did NOT confirm a data-testid on the textarea — grab it next pass; likely `dmComposerTextInput`.)
- Send: press **Enter** (no reliable named "Send" button — quick_read for role=button name="Send" returned nothing; it's an icon button).

## Verification predicate (important)

- Sending an encrypted DM fires `GetPublicKeysQuery` (key fetch), NOT an obvious "/dm/new" endpoint — a `network_endpoint: "dm|message"` expect FAILS even on success. Verify instead by **thread text**: read `#dm-main-container` and assert the sent message appears (`You: <msg>` in the inbox row, or the message bubble at thread end). Use `text_visible`/thread-read, not network.

## Gotchas

- **X has NO self-DM.** No send-to-self safe dummy → a `send_dm` procedure cannot be dry-run or reconfirmed (the 3x strict streak) without messaging a real person. => cannot be promoted to `trusted` via the normal path; save as **draft** + single real send, OR verify against a second account you own.
- **Resolve recipient by @handle, lifted to an input.** Never select by display name; never blind-send.
- `browser_wait_for_idle` times out on X (persistent connections) — wait on DOM markers instead.
- Ref-less `insertText` into the search box registered text and typeahead populated by next read; if it ever fails to fire, retype into `new-dm-search-input` in keystroke mode.
