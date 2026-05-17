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

const LANDMARK_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "form",
  "region",
  "search",
]);

interface LandmarkGroup {
  role: string;
  name: string;
  nodes: BoxDrawingNode[];
}

function groupByLandmark(
  nodes: readonly BoxDrawingNode[],
): LandmarkGroup[] {
  const groups = new Map<string, LandmarkGroup>();
  const unassigned: LandmarkGroup = { role: "unassigned", name: "", nodes: [] };
  for (const n of nodes) {
    const landmarkKey =
      n.landmark !== undefined && n.landmark !== ""
        ? n.landmark
        : LANDMARK_ROLES.has(n.role)
          ? n.ref
          : null;
    if (landmarkKey === null) {
      unassigned.nodes.push(n);
      continue;
    }
    let g = groups.get(landmarkKey);
    if (g === undefined) {
      g = {
        role: LANDMARK_ROLES.has(n.role) ? n.role : "region",
        name: LANDMARK_ROLES.has(n.role) ? n.name : "",
        nodes: [],
      };
      groups.set(landmarkKey, g);
    }
    g.nodes.push(n);
  }
  const out: LandmarkGroup[] = [...groups.values()];
  if (unassigned.nodes.length > 0) out.push(unassigned);
  return out;
}

function renderLandmarkHeader(group: LandmarkGroup): string {
  const label = group.name !== ""
    ? `${group.role.toUpperCase()}: ${group.name}`
    : group.role.toUpperCase();
  return `┌── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}┐`;
}

function renderLandmarkFooter(): string {
  return `└${"─".repeat(64)}┘`;
}

export function renderBoxDrawing(
  nodes: readonly BoxDrawingNode[],
  _viewport: { w: number; h: number },
): BoxDrawingResult {
  const ref_map: Record<string, string> = {};
  for (const n of nodes) ref_map[n.ref] = n.selector;
  const groups = groupByLandmark(nodes);
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(renderLandmarkHeader(g));
    lines.push(renderLandmarkFooter());
  }
  return { text: lines.join("\n"), ref_map };
}
