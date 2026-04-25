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

export const SITE_REGISTRY: readonly SiteEntry[] = [
  // Quill
  { match: /(^|\.)slack\.com$/, framework: 'quill', semanticKeyMode: 'trusted' },
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
  return SITE_REGISTRY.find((entry) => entry.match.test(hostname)) ?? null;
}
