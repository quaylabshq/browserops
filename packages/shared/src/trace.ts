export interface TraceEvent {
  id: string;                       // correlates with MCP request id
  timestamp: string;                // ISO-8601 at the time of result
  tool_name: string;                // e.g. "browser_click"
  duration_ms: number;              // from request receipt to response
  input: Record<string, unknown>;   // the tool's input params (as received)
  result:
    | {
        ok: true;
        value: unknown;             // the tool's output object
      }
    | {
        ok: false;
        error_code: string;         // e.g. "WRITE_NOT_REFLECTED"
        error_message: string;
      };
  // For mutating tools with page_effect in the result, the effect is
  // already inside result.value. We don't duplicate it here — keeps
  // the trace flat and the compile step (Phase 4) extracts it from
  // result.value.page_effect when present.
}

export interface AutoApprovedEvent {
  type: "auto_approved";            // discriminates from TraceEvent
  tool: string;                      // the risky tool name
  tab_hostname?: string;             // hostname of the tab (if available)
  ts: string;                        // ISO-8601 timestamp
  decision_id: string;               // correlates with safety decision log
}
