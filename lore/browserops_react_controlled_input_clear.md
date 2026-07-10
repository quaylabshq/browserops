---
name: browserops_react_controlled_input_clear
description: 'browser_type clear_mode ("value" AND "select_all") fails to clear
  React controlled inputs — insertText appends at caret and the value mangles
  across retries. Fix: reload for a pristine field and type ONCE without clear,
  then verify via input.value.'
type: reference
source: mcp-tool
created: 2026-07-08T23:34:03.833Z
updated: 2026-07-08T23:34:03.833Z
---

# React controlled inputs: clear_mode does not clear

Verified live 2026-07-09 on a Next.js dev app (localhost, `<input type="email">` controlled via `value={state}` + `onChange`).

## Symptom

- `browser_type` with `clear_mode: "auto"` or `"value"` or `"select_all"` reports `cleared: true`, but the field is NOT empty.
- Each retry appends the new text at the caret inside the old value → mangled strings like `notanemaiqa-test@qa-test@browserops.aibrowserops.a`.
- Downstream effect: native `type="email"` validation fails on the mangled value, form submit is silently blocked, and every click on the submit button returns zero `page_effect` mutations. Looks like a broken button; it's a broken clear.

## Diagnosis path that worked

`browser_execute_js` → `document.querySelector('input').value` + `.validity.valid`. One call revealed the mangled value immediately.

## Fix

1. Reload the page (or otherwise remount the component) to get a pristine empty field.
2. Type ONCE with plain `browser_type` (no clear_mode). Paste-mode `Input.insertText` fires proper beforeinput/input events, so React state tracks it fine — the problem is only clearing, not typing.
3. Verify with `input.value` via execute_js (or `expected.value_contains`) before clicking submit.

## Also observed

- `submit: true` on `browser_type` (Enter after paste) did NOT trigger the React form's onSubmit; a real `browser_click` on the submit button did.
- `expected.value_contains` threw `INTERNAL: Cannot read properties of null (reading 'field_values')` on this page — don't rely on it for verification here; use execute_js.
