export type Framework =
  | 'quill'
  | 'prosemirror'
  | 'slate'
  | 'codemirror'
  | 'gmail'
  | 'gdocs-canvas'
  | 'figma-canvas'
  | 'custom-contenteditable';

export interface SiteEntry {
  match: RegExp;
  framework: Framework;
  semanticKeyMode?: 'trusted';
  clickMode?: 'trusted';
}

/**
 * Framework-class defaults applied by resolveSite() when an entry does
 * not set a mode explicitly. Entries can still opt in to a stronger mode
 * than the default, but cannot opt out — framework classes listed here
 * have been observed to require the listed dispatch modes across the
 * sites that use them. (No known site needs to opt out; if one appears,
 * promote DispatchMode to a 'trusted' | 'synthetic' union and gate the
 * default.)
 *
 * Rationale per class:
 *  - quill / prosemirror / slate / gmail: rich-text editor embedded in
 *    an otherwise-standard React/HTML UI. Trusted semantic keys matter
 *    inside the editor; clicks on surrounding buttons rarely need it.
 *  - gdocs-canvas / figma-canvas: interaction surface is <canvas>, so
 *    every click must hit the canvas's CDP-dispatched trusted handler.
 *  - custom-contenteditable: gesture-heavy SPAs whose React event
 *    systems gate on isTrusted for BOTH clicks (sidebar rows, send
 *    buttons, reaction picker) AND semantic keys (Enter to send).
 *    Covers WhatsApp Web, Telegram, Messenger, X/Twitter, Claude,
 *    Perplexity. This default plugs the class of bug where a site was
 *    registered for one action (typing) and used for another (click).
 *  - codemirror: no known isTrusted dependency.
 */
const FRAMEWORK_DEFAULTS: Record<Framework, { clickMode?: 'trusted'; semanticKeyMode?: 'trusted' }> = {
  quill:                    { semanticKeyMode: 'trusted' },
  prosemirror:              { semanticKeyMode: 'trusted' },
  slate:                    { semanticKeyMode: 'trusted' },
  codemirror:               {},
  gmail:                    { semanticKeyMode: 'trusted' },
  'gdocs-canvas':           { clickMode: 'trusted' },
  'figma-canvas':           { clickMode: 'trusted' },
  'custom-contenteditable': { clickMode: 'trusted', semanticKeyMode: 'trusted' },
};

export const SITE_REGISTRY: readonly SiteEntry[] = [
  // Quill
  { match: /(^|\.)slack\.com$/, framework: 'quill', semanticKeyMode: 'trusted', clickMode: 'trusted' },
  { match: /(^|\.)zendesk\.com$/, framework: 'quill' },
  { match: /(^|\.)intercom\.com$/, framework: 'quill' },
  { match: /(^|\.)trello\.com$/, framework: 'quill' },

  // ProseMirror
  { match: /(^|\.)linear\.app$/, framework: 'prosemirror', semanticKeyMode: 'trusted' },
  { match: /(^|\.)notion\.so$/, framework: 'prosemirror', semanticKeyMode: 'trusted' },
  { match: /(^|\.)clickup\.com$/, framework: 'prosemirror' },
  { match: /(^|\.)substack\.com$/, framework: 'prosemirror' },
  { match: /(^|\.)medium\.com$/, framework: 'prosemirror' },
  { match: /(^|\.)atlassian\.net$/, framework: 'prosemirror' },

  // Slate
  { match: /(^|\.)discord\.com$/, framework: 'slate', semanticKeyMode: 'trusted' },
  { match: /(^|\.)reddit\.com$/, framework: 'slate' },

  // Google apps
  { match: /^mail\.google\.com$/, framework: 'gmail', semanticKeyMode: 'trusted' },
  { match: /^docs\.google\.com$/, framework: 'gdocs-canvas', clickMode: 'trusted' },
  { match: /^sheets\.google\.com$/, framework: 'gdocs-canvas', clickMode: 'trusted' },
  { match: /^meet\.google\.com$/, framework: 'custom-contenteditable' },

  // Canvas apps
  { match: /^www\.figma\.com$/, framework: 'figma-canvas', clickMode: 'trusted' },
  { match: /(^|\.)canva\.com$/, framework: 'figma-canvas', clickMode: 'trusted' },
  { match: /^miro\.com$/, framework: 'figma-canvas', clickMode: 'trusted' },
  { match: /(^|\.)whimsical\.com$/, framework: 'figma-canvas', clickMode: 'trusted' },
  { match: /^figjam\.com$/, framework: 'figma-canvas', clickMode: 'trusted' },

  // Chat apps
  { match: /^web\.whatsapp\.com$/, framework: 'custom-contenteditable', semanticKeyMode: 'trusted' },
  { match: /^web\.telegram\.org$/, framework: 'custom-contenteditable', semanticKeyMode: 'trusted' },
  { match: /(^|\.)messenger\.com$/, framework: 'custom-contenteditable', semanticKeyMode: 'trusted' },
  { match: /(^|\.)x\.com$/, framework: 'custom-contenteditable' },
  { match: /(^|\.)twitter\.com$/, framework: 'custom-contenteditable' },

  // AI apps
  { match: /(^|\.)chatgpt\.com$/, framework: 'prosemirror', semanticKeyMode: 'trusted' },
  { match: /(^|\.)claude\.ai$/, framework: 'custom-contenteditable', semanticKeyMode: 'trusted' },
  { match: /(^|\.)perplexity\.ai$/, framework: 'custom-contenteditable' },
] as const;

export function resolveSite(hostname: string): SiteEntry | null {
  const raw = SITE_REGISTRY.find((entry) => entry.match.test(hostname));
  if (!raw) return null;
  const defaults = FRAMEWORK_DEFAULTS[raw.framework];
  const clickMode = raw.clickMode ?? defaults.clickMode;
  const semanticKeyMode = raw.semanticKeyMode ?? defaults.semanticKeyMode;
  const resolved: SiteEntry = { match: raw.match, framework: raw.framework };
  if (clickMode) resolved.clickMode = clickMode;
  if (semanticKeyMode) resolved.semanticKeyMode = semanticKeyMode;
  return resolved;
}
