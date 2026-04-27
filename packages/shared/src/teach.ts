/**
 * Teach-mode protocol types.
 *
 * Teach mode lets the user demonstrate a flow in their real browser while the
 * agent watches live. The extension records each user action as a TeachEvent
 * and pushes it to the bridge via the unsolicited Event channel
 * (name: "teach_event"). The bridge appends to a session JSONL file and
 * exposes the stream to the agent through procedures_teach_observe.
 *
 * After the user stops the session, the agent runs the distiller
 * (procedures_teach_distill) to turn the timeline into draft procedure(s),
 * replays them, and saves the ones that succeed.
 */

/** Stable name of the live event the extension emits per recorded action. */
export const TEACH_EVENT_NAME = "teach_event" as const;

/**
 * Best-effort identifiers for the element a user interacted with. The
 * distiller picks the cheapest stable addressing scheme on replay (text,
 * selector, or coordinates fallback) — we capture all three so the choice
 * happens at distill time, not record time.
 */
export interface TeachTargetRef {
  /** CSS selector — id-preferring, then [data-testid], then DFS-stable path. */
  selector: string;
  /** ARIA role, or computed implicit role for native HTML elements. */
  role?: string;
  /** Accessible name (aria-label, label, alt, or trimmed text). */
  name?: string;
  /** Visible text snippet, truncated to 200 chars. */
  text?: string;
  /** Lowercased tag name. */
  tag?: string;
  /** input.type value for <input> elements. */
  input_type?: string;
  /** Whether the element was contenteditable at capture time. */
  contenteditable?: boolean;
}

export interface TeachClickStep {
  kind: "click";
  target: TeachTargetRef;
  /** Viewport-relative click point — fallback only. */
  x?: number;
  y?: number;
  button: "left" | "right" | "middle";
  modifiers: ReadonlyArray<"Control" | "Alt" | "Shift" | "Meta">;
}

export interface TeachTypeStep {
  kind: "type";
  target: TeachTargetRef;
  /**
   * The text the user entered. Set to empty string and `redacted: true` for
   * password fields, autocomplete=current-password, autocomplete=one-time-code,
   * or anything matching the recorder's secret regex list.
   */
  value: string;
  redacted: boolean;
  /** Reason for redaction so the agent can request a parameter from the user. */
  redaction_reason?: "password" | "otp" | "secret_pattern" | "user_marked";
}

export interface TeachKeyStep {
  kind: "key";
  /** browser_press-style chord; modifiers in Primary form already. */
  keys: string[];
  target?: TeachTargetRef;
}

export interface TeachNavigateStep {
  kind: "navigate";
  url: string;
  /** webNavigation transition_type, lowercased. */
  transition?: string;
}

export interface TeachScrollStep {
  kind: "scroll";
  target?: TeachTargetRef;
  delta_y: number;
}

/** Free-form text the user typed in the popup teach pane during recording. */
export interface TeachNarrationStep {
  kind: "narration";
  text: string;
}

/** User-pressed split point — distiller respects these as hard leaf boundaries. */
export interface TeachMarkerStep {
  kind: "marker";
  label?: string;
}

export type TeachStep =
  | TeachClickStep
  | TeachTypeStep
  | TeachKeyStep
  | TeachNavigateStep
  | TeachScrollStep
  | TeachNarrationStep
  | TeachMarkerStep;

export type TeachStepKind = TeachStep["kind"];

export interface TeachEvent {
  session_id: string;
  /** Monotonic per session, starts at 1. */
  seq: number;
  /** ms epoch when the event fired in the page. */
  ts: number;
  /** browserops tab_id (stable across same-tab navigations). */
  tab_id: string;
  url: string;
  step: TeachStep;
}

export interface TeachSessionMeta {
  session_id: string;
  started_at: number;
  stopped_at?: number;
  scope: TeachScope;
  narration_hint?: string;
  event_count: number;
}

export type TeachScope = "active_tab" | "all_tabs";

/** Default secret patterns the content script redacts at capture time. */
export const TEACH_SECRET_REGEXES: readonly RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/, // generic API keys (sk-…)
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access keys
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub personal access tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWTs
] as const;
