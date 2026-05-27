/**
 * Translate a browserops key token (the public surface accepted by
 * `browser_press` and the chord-final terminal key) into the full event
 * geometry required by CDP `Input.dispatchKeyEvent` and the legacy DOM
 * `KeyboardEvent` constructor.
 *
 * Why this exists: rich editors (Quill in Slack, ProseMirror in Linear /
 * Notion, the Sheets formula cell editor, Gmail's send-on-Enter handler)
 * gate their keydown listeners on `event.keyCode === 13` / `event.code ===
 * "Enter"` for legacy compatibility. CDP's dispatchKeyEvent does NOT
 * auto-populate `windowsVirtualKeyCode` from `key` — if a caller only sets
 * `key: "Enter"`, the dispatched DOM event has `keyCode: 0`, every legacy
 * Enter-handler bails, and the press is silently ignored. Resolving the
 * full tuple here closes that gap.
 *
 * Browserops accepts two stylistic dialects in chords: DOM `event.code`
 * form for letters/digits (`KeyA`, `Digit3`) and named special keys
 * (`Enter`, `ArrowUp`). Single printable characters are also accepted.
 * This resolver normalises all three.
 */

export interface KeyTuple {
  /** DOM `event.key` value. Lowercase for unshifted letters. */
  key: string;
  /** DOM `event.code` value. `KeyA`, `Digit3`, `Enter`, … */
  code: string;
  /** Character text to emit on keyDown — only for true printables, never
   *  for named keys or chord components (callers strip it under modifier
   *  pressure to avoid Cmd+A inserting an "a"). */
  text?: string;
  /** Windows Virtual-Key code, also reused as native VK. 0 for unknown. */
  vkCode: number;
}

interface NamedKey {
  key: string;
  code: string;
  vkCode: number;
  text?: string;
}

const NAMED_KEYS: Readonly<Record<string, NamedKey>> = (() => {
  const t: Record<string, NamedKey> = {
    Enter:     { key: "Enter",      code: "Enter",       vkCode: 13 },
    Tab:       { key: "Tab",        code: "Tab",         vkCode:  9 },
    Escape:    { key: "Escape",     code: "Escape",      vkCode: 27 },
    Backspace: { key: "Backspace",  code: "Backspace",   vkCode:  8 },
    Delete:    { key: "Delete",     code: "Delete",      vkCode: 46 },
    Space:     { key: " ",          code: "Space",       vkCode: 32, text: " " },
    ArrowUp:   { key: "ArrowUp",    code: "ArrowUp",     vkCode: 38 },
    ArrowDown: { key: "ArrowDown",  code: "ArrowDown",   vkCode: 40 },
    ArrowLeft: { key: "ArrowLeft",  code: "ArrowLeft",   vkCode: 37 },
    ArrowRight:{ key: "ArrowRight", code: "ArrowRight",  vkCode: 39 },
    Home:      { key: "Home",       code: "Home",        vkCode: 36 },
    End:       { key: "End",        code: "End",         vkCode: 35 },
    PageUp:    { key: "PageUp",     code: "PageUp",      vkCode: 33 },
    PageDown:  { key: "PageDown",   code: "PageDown",    vkCode: 34 },
    Insert:    { key: "Insert",     code: "Insert",      vkCode: 45 },
    Shift:     { key: "Shift",      code: "ShiftLeft",   vkCode: 16 },
    Control:   { key: "Control",    code: "ControlLeft", vkCode: 17 },
    Alt:       { key: "Alt",        code: "AltLeft",     vkCode: 18 },
    Meta:      { key: "Meta",       code: "MetaLeft",    vkCode: 91 },
    // US-layout punctuation event.code names. Without these, callers passing
    // chord-style tokens (e.g. ["Shift","Slash"] for "?", or bare "Slash" for
    // "/" — which is what triggers the Notion / Linear / Discord slash menu)
    // fall through to the unknown-token branch and dispatch a key event with
    // no `text`, so the page receives the keydown but no character is
    // inserted. Slot in the US base-layer text up front; shifted text is
    // computed later in `resolveKey` from SHIFTED_TEXT when mods.shift is set.
    Slash:        { key: "/",  code: "Slash",        vkCode: 191, text: "/"  },
    Period:       { key: ".",  code: "Period",       vkCode: 190, text: "."  },
    Comma:        { key: ",",  code: "Comma",        vkCode: 188, text: ","  },
    Semicolon:    { key: ";",  code: "Semicolon",    vkCode: 186, text: ";"  },
    Quote:        { key: "'",  code: "Quote",        vkCode: 222, text: "'"  },
    Backquote:    { key: "`",  code: "Backquote",    vkCode: 192, text: "`"  },
    Minus:        { key: "-",  code: "Minus",        vkCode: 189, text: "-"  },
    Equal:        { key: "=",  code: "Equal",        vkCode: 187, text: "="  },
    BracketLeft:  { key: "[",  code: "BracketLeft",  vkCode: 219, text: "["  },
    BracketRight: { key: "]",  code: "BracketRight", vkCode: 221, text: "]"  },
    Backslash:    { key: "\\", code: "Backslash",    vkCode: 220, text: "\\" },
  };
  for (let i = 1; i <= 12; i += 1) {
    t[`F${i}`] = { key: `F${i}`, code: `F${i}`, vkCode: 111 + i };
  }
  return t;
})();

export function resolveKey(token: string): KeyTuple {
  const named = NAMED_KEYS[token];
  if (named !== undefined) {
    const out: KeyTuple = { key: named.key, code: named.code, vkCode: named.vkCode };
    if (named.text !== undefined) out.text = named.text;
    return out;
  }

  // event.code-style letter: "KeyA".."KeyZ".
  if (token.length === 4 && token.startsWith("Key")) {
    const upper = token.charAt(3);
    if (upper >= "A" && upper <= "Z") {
      const lower = upper.toLowerCase();
      return { key: lower, code: token, text: lower, vkCode: upper.charCodeAt(0) };
    }
  }

  // event.code-style digit: "Digit0".."Digit9".
  if (token.length === 6 && token.startsWith("Digit")) {
    const d = token.charAt(5);
    if (d >= "0" && d <= "9") {
      return { key: d, code: token, text: d, vkCode: d.charCodeAt(0) };
    }
  }

  // Single printable character.
  if (token.length === 1) {
    const c = token;
    if (c >= "a" && c <= "z") {
      return { key: c, code: `Key${c.toUpperCase()}`, text: c, vkCode: c.toUpperCase().charCodeAt(0) };
    }
    if (c >= "A" && c <= "Z") {
      return { key: c, code: `Key${c}`, text: c, vkCode: c.charCodeAt(0) };
    }
    if (c >= "0" && c <= "9") {
      return { key: c, code: `Digit${c}`, text: c, vkCode: c.charCodeAt(0) };
    }
    if (c === " ") {
      return { key: " ", code: "Space", text: " ", vkCode: 32 };
    }
    // Other printables (symbols) — no portable code mapping, pass key + text.
    return { key: c, code: "", text: c, vkCode: c.charCodeAt(0) };
  }

  // Unknown token — preserve prior behaviour (key passes through, no vk).
  return { key: token, code: token, vkCode: 0 };
}
