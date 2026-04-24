/**
 * Deny-list for destructive keyboard chords.
 *
 * The extension calls {@link isDestructiveChord} from its browser_press
 * handler AFTER resolving `Primary` to `Meta`/`Control`. If it returns a
 * reason string, the handler throws RISKY_ACTION_DENIED with that reason.
 *
 * We refuse rather than gate: these chords would close the user's tabs,
 * quit the browser, or open new windows the user didn't ask for. There's
 * no legitimate agent workflow that requires them — procedures that want
 * to close a tab have `browser_close_tab`, procedures that want to open
 * one have `browser_new_tab`.
 */

/** Canonical modifier names, post-Primary-resolution. */
export type ResolvedModifier = "Control" | "Alt" | "Shift" | "Meta";

interface DenyRule {
  /** Modifiers required (a superset of these must be present). */
  mods: readonly ResolvedModifier[];
  /** Disallowed extra modifiers — rule only matches when these are ABSENT. */
  noMods?: readonly ResolvedModifier[];
  /** Terminal key (CDP-style code OR KeyboardEvent.key). Matched case-insensitively. */
  key: string;
  /** User-facing reason if the rule matches. */
  reason: string;
}

/**
 * Rules are matched post-Primary-resolution. On mac `Primary` becomes `Meta`,
 * on others `Control` — we only list the canonical resolved forms and rely on
 * the resolver having run.
 */
const DENY_RULES: readonly DenyRule[] = [
  // Close tab
  { mods: ["Meta"], noMods: ["Shift"], key: "KeyW", reason: "Primary+W closes the tab" },
  { mods: ["Control"], noMods: ["Shift"], key: "KeyW", reason: "Primary+W closes the tab" },
  // Close window
  { mods: ["Meta", "Shift"], key: "KeyW", reason: "Primary+Shift+W closes the window" },
  { mods: ["Control", "Shift"], key: "KeyW", reason: "Primary+Shift+W closes the window" },
  { mods: ["Alt"], key: "F4", reason: "Alt+F4 closes the window" },
  // Quit browser (mac)
  { mods: ["Meta"], key: "KeyQ", reason: "Primary+Q quits the browser" },
  // New tab / window / incognito
  { mods: ["Meta"], noMods: ["Shift"], key: "KeyT", reason: "Primary+T opens a new tab — use browser_new_tab instead" },
  { mods: ["Control"], noMods: ["Shift"], key: "KeyT", reason: "Primary+T opens a new tab — use browser_new_tab instead" },
  { mods: ["Meta"], noMods: ["Shift"], key: "KeyN", reason: "Primary+N opens a new window" },
  { mods: ["Control"], noMods: ["Shift"], key: "KeyN", reason: "Primary+N opens a new window" },
  { mods: ["Meta", "Shift"], key: "KeyN", reason: "Primary+Shift+N opens a new incognito window" },
  { mods: ["Control", "Shift"], key: "KeyN", reason: "Primary+Shift+N opens a new incognito window" },
];

/** Normalise a key to a single canonical form for comparison. */
function normaliseKey(k: string): string {
  const lower = k.toLowerCase();
  // Accept KeyA / a / A interchangeably for letter chords.
  if (/^key[a-z]$/.test(lower)) return lower;
  if (/^[a-z]$/.test(lower)) return `key${lower}`;
  return lower;
}

/**
 * Returns a human-readable reason if the chord is deny-listed, else null.
 *
 * @param terminalKey  The final entry of the `keys:` array (the key being pressed).
 * @param modifiers    Resolved modifiers (Primary already mapped to Meta/Control).
 */
export function isDestructiveChord(
  terminalKey: string,
  modifiers: readonly ResolvedModifier[],
): string | null {
  const key = normaliseKey(terminalKey);
  const mods = new Set<ResolvedModifier>(modifiers);
  for (const rule of DENY_RULES) {
    if (normaliseKey(rule.key) !== key) continue;
    let matches = true;
    for (const m of rule.mods) {
      if (!mods.has(m)) { matches = false; break; }
    }
    if (!matches) continue;
    if (rule.noMods !== undefined) {
      for (const m of rule.noMods) {
        if (mods.has(m)) { matches = false; break; }
      }
    }
    if (matches) return rule.reason;
  }
  return null;
}
