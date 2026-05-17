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

/** Injected: takes the selector list and returns one entry per node with
 *  bounds in a single round-trip. Subsequent substeps extend this same
 *  function with visibility / occlusion / style fields. Self-contained —
 *  no closures over module scope. */
export function collectAugmentedFields(
  selectors: readonly string[],
): Array<VisualFields & { resolved: boolean }> {
  const out: Array<VisualFields & { resolved: boolean }> = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  function parseRgb(s: string): [number, number, number] | null {
    const m = s.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
    if (m === null) return null;
    return [parseInt(m[1] ?? "0", 10), parseInt(m[2] ?? "0", 10), parseInt(m[3] ?? "0", 10)];
  }

  function relLum(rgb: [number, number, number]): number {
    const ch = rgb.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
  }

  function toHex(rgb: [number, number, number]): string {
    const h = (n: number): string => n.toString(16).padStart(2, "0");
    return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
  }

  function selectorFor(node: Element): string {
    const parts: string[] = [];
    let n: Element | null = node;
    while (n !== null && n !== document.documentElement && n !== document.body) {
      const id = n.id;
      if (id) {
        parts.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const tag = n.tagName.toLowerCase();
      const parent: Element | null = n.parentElement;
      if (parent !== null) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === (n as Element).tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(n) + 1;
          parts.unshift(`${tag}:nth-child(${idx})`);
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      n = n.parentElement;
    }
    return parts.length > 0 ? parts.join(" > ") : node.tagName.toLowerCase();
  }

  // Occlusion via elementFromPoint is O(visible nodes); cap so wildly long
  // a11y trees don't pay 10k forced-layouts.
  let occlusionsRemaining = 200;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el === null) {
      out.push({
        resolved: false,
        bounds: null,
        visible: false,
        in_viewport: false,
        occluded_by: null,
        bg_color: null,
        fg_color: null,
        opacity: 1,
        disabled_visual: false,
      });
      continue;
    }
    const rect = el.getBoundingClientRect();
    const bounds =
      rect.width === 0 && rect.height === 0
        ? null
        : { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    const style = window.getComputedStyle(el);
    const opacity = Number.parseFloat(style.opacity);
    const visible =
      bounds !== null &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      opacity > 0.01;
    const in_viewport =
      bounds !== null &&
      bounds.x + bounds.w >= 0 &&
      bounds.y + bounds.h >= 0 &&
      bounds.x <= vw &&
      bounds.y <= vh;
    const bgRgb = parseRgb(style.backgroundColor);
    const fgRgb = parseRgb(style.color);
    const bg_color = bgRgb ? toHex(bgRgb) : null;
    const fg_color = fgRgb ? toHex(fgRgb) : null;
    let contrastFlag = false;
    if (bgRgb && fgRgb) {
      const lum1 = relLum(bgRgb);
      const lum2 = relLum(fgRgb);
      const lighter = Math.max(lum1, lum2);
      const darker = Math.min(lum1, lum2);
      const ratio = (lighter + 0.05) / (darker + 0.05);
      contrastFlag = ratio < 3;
    }
    const disabled_visual =
      contrastFlag ||
      style.pointerEvents === "none" ||
      style.cursor === "not-allowed";

    let occluded_by: string | null = null;
    if (visible && in_viewport && occlusionsRemaining > 0 && bounds !== null) {
      occlusionsRemaining -= 1;
      const cx = bounds.x + bounds.w / 2;
      const cy = bounds.y + bounds.h / 2;
      if (cx >= 0 && cy >= 0 && cx <= vw && cy <= vh) {
        const hit = document.elementFromPoint(cx, cy);
        if (hit !== null && hit !== el && !el.contains(hit)) {
          occluded_by = selectorFor(hit);
        }
      }
    }
    out.push({
      resolved: true,
      bounds,
      visible,
      in_viewport,
      occluded_by,
      bg_color,
      fg_color,
      opacity: isFinite(opacity) ? opacity : 1,
      disabled_visual,
      display: style.display,
      flex_direction: style.flexDirection,
    });
  }
  return out;
}

export async function augment(
  tabId: number,
  nodes: readonly A11yNode[],
): Promise<AugmentedNode[]> {
  if (nodes.length === 0) return [];
  const { execInTab } = await import("../background/handlers/input.js");
  const selectors = nodes.map((n) => n.selector);
  let fields: Array<VisualFields & { resolved: boolean }> = [];
  try {
    fields = await execInTab(tabId, collectAugmentedFields, [selectors] as const);
  } catch (err) {
    console.warn("[browserops] a11y augmentation failed:", err);
  }
  return nodes.map((node, i) => {
    const f = fields[i] ?? {
      resolved: false,
      bounds: null,
      visible: false,
      in_viewport: false,
      occluded_by: null,
      bg_color: null,
      fg_color: null,
      opacity: 1,
      disabled_visual: false,
    };
    const { resolved: _resolved, ...visual } = f;
    return { ...node, ...visual };
  });
}
