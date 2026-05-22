// A11y tree augmentation. Takes a list of a11y nodes and decorates each
// with the visual fields the agent needs to ground its reasoning —
// bounding box, visibility, occlusion, computed colors, opacity, and a
// "disabled_visual" heuristic for elements that *look* disabled even when
// ARIA says otherwise (greyed out, pointer-events:none, etc.).
//
// Skeleton only. Per-field collection lands in subsequent substeps
// (3.1.2–3.1.5).

export interface VisualFields {
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
}

export interface A11yNode {
  ref: string;
  role: string;
  name: string;
  selector: string;
}

export type AugmentedNode = A11yNode & VisualFields;

export async function augment(
  _tabId: number,
  nodes: readonly A11yNode[],
): Promise<AugmentedNode[]> {
  return nodes.map((n) => ({
    ...n,
    bounds: null,
    visible: false,
    in_viewport: false,
    occluded_by: null,
    bg_color: null,
    fg_color: null,
    opacity: 1,
    disabled_visual: false,
  }));
}
