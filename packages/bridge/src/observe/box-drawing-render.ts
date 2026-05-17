// Pure function: augmented a11y → ASCII box-drawing layout + ref map.
//
// The renderer runs bridge-side (no DOM access needed). Given a list of
// augmented a11y nodes plus the viewport size, it groups nodes by their
// nearest ARIA landmark, labels flex/grid containers, renders ARIA tables
// as ASCII tables, and emits one line per interactive leaf with an inline
// `[Label r42]` ref token.
//
// Lands incrementally across 3.2.1–3.2.5; this skeleton just lays out the
// public API.

export interface BoxDrawingNode {
  ref: string;
  role: string;
  name: string;
  selector: string;
  bounds: { x: number; y: number; w: number; h: number } | null;
  visible: boolean;
  in_viewport: boolean;
  occluded_by: string | null;
  bg_color: string | null;
  fg_color: string | null;
  opacity: number;
  disabled_visual: boolean;
  display?: string;
  flex_direction?: string;
  // Optional parent landmark id used by the grouping walker.
  landmark?: string;
}

export interface BoxDrawingResult {
  text: string;
  ref_map: Record<string, string>;
}

export function renderBoxDrawing(
  _nodes: readonly BoxDrawingNode[],
  _viewport: { w: number; h: number },
): BoxDrawingResult {
  return { text: "", ref_map: {} };
}
