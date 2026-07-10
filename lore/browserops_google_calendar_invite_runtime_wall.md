---
name: browserops_google_calendar_invite_runtime_wall
description: Draft Google Calendar invite procedure has live locators, but
  cannot be safely trusted without a distinct test attendee.
type: reference
source: mcp-tool
created: 2026-07-10T10:09:29.313Z
updated: 2026-07-10T10:18:40.233Z
---

# Google Calendar invite procedure — verification blocker (2026-07-10)

Draft: `google_calendar.invite_product_walkthrough`

## Live coverage

- Strict execution now completes deterministically through title, date, start/end time, and the guest field.
- Stable tier-1 locators verified: Add title, Start date, Start time, End time, Guests.
- Date input uses US order in this Calendar profile: `07/11/2026` opens 11 July 2026.
- The original real invitation was successfully sent outside the procedure.

## Why it remains draft

- The Calendar safe dummy is the organiser's own account. Google normalizes the available `+browserops` Gmail alias back to the organiser, so it never becomes a distinct attendee.
- A strict test therefore cannot validate the actual guest-selection, save-confirmation, and send-email path. The test form was discarded; no verification event or email was sent.
- Earlier, the executor also showed an initial Add-title ref-staleness and an intermittent 45-second Calendar navigation timeout; a rendered-form readiness wait fixed the stale ref.

## Trust requirement

A trusted promotion needs three consecutive strict runs with a distinct, controlled test recipient and fresh event titles. Do not use a real prospect without explicit permission for those three test invitations.
