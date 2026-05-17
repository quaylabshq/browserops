// Heuristics for the browser_observe auto-mode decision tree. Estimates
// a11y token count and canvas-pixel ratio so the handler can pick the
// cheapest viable representation.

export type Scope = "viewport" | "document";

function injectedEstimate(scopeMode: Scope): { count: number; chars: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let count = 0;
  let chars = 0;
  const walk = (el: Element): void => {
    if (count > 5000) return;
    const role = el.getAttribute("role") ?? "";
    const tag = el.tagName.toLowerCase();
    const interesting =
      role !== "" ||
      tag === "a" ||
      tag === "button" ||
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      tag === "h1" ||
      tag === "h2" ||
      tag === "h3" ||
      tag === "h4" ||
      tag === "h5" ||
      tag === "h6";
    if (interesting) {
      const rect = el.getBoundingClientRect();
      const inViewport =
        rect.bottom >= 0 && rect.top <= vh && rect.right >= 0 && rect.left <= vw;
      if (scopeMode === "document" || inViewport) {
        count++;
        const name = el.getAttribute("aria-label") ?? el.textContent ?? "";
        chars += Math.min(80, name.length);
      }
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  if (document.body !== null) walk(document.body);
  return { count, chars };
}

function injectedCanvasRatio(): number {
  const canvases = Array.from(document.querySelectorAll("canvas"));
  if (canvases.length === 0) return 0;
  const viewportArea = window.innerWidth * window.innerHeight;
  if (viewportArea === 0) return 0;
  let covered = 0;
  for (const c of canvases) {
    const rect = (c as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const x0 = Math.max(0, rect.left);
    const y0 = Math.max(0, rect.top);
    const x1 = Math.min(window.innerWidth, rect.right);
    const y1 = Math.min(window.innerHeight, rect.bottom);
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    covered += w * h;
  }
  return Math.min(1, covered / viewportArea);
}

export async function estimateA11ySize(
  tabId: number,
  scope: Scope,
): Promise<number> {
  const { execInTab } = await import("../background/handlers/input.js");
  const { count, chars } = await execInTab(tabId, injectedEstimate, [scope] as const);
  // Rough token approximation: 1 token per ~4 chars, plus 4 tokens of
  // overhead per node (ref, role, name, separators).
  return Math.round(chars / 4 + count * 4);
}

export async function canvasPixelRatio(tabId: number): Promise<number> {
  const { execInTab } = await import("../background/handlers/input.js");
  return execInTab(tabId, injectedCanvasRatio, [] as const);
}
