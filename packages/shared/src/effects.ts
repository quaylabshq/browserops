export interface PageEffect {
  dom: {
    added: number;          // node add mutations observed
    removed: number;        // node remove mutations
    attr_changes: number;   // attribute mutations
    text_changes: number;   // characterData mutations
  };
  url: {
    changed: boolean;
    before?: string;
    after?: string;
  };
  focus: {
    changed: boolean;
    before_selector?: string | null;
    after_selector?: string | null;
  };
  network: {
    requests_started: number;
    requests_completed: number;
    in_flight_at_end: number;
  };
  window_ms: number;
  truncated?: boolean;
}
