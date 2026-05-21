// Set-of-Marks (SoM) overlay renderer. Given a base screenshot and the
// CSS-pixel bounding boxes of interactive elements, draws numbered labels
// at each box so a vision model can issue "click the element labeled 3"
// dispatches. Returns the annotated image + a map from label number to
// ref/role/name so the agent can translate model output to action params.

export interface SomCandidate {
  ref: string;
  role: string;
  name: string;
  // CSS pixels relative to the viewport.
  rect: { x: number; y: number; w: number; h: number };
}

export interface SomResult {
  base64: string;
  width: number;
  height: number;
  som_map: Record<string, { ref: string; role: string; name: string }>;
}

const LABEL_BG = "#FF1744";
const LABEL_FG = "#FFFFFF";
const LABEL_FONT = "bold 14px ui-sans-serif, system-ui, -apple-system, sans-serif";
const LABEL_PAD = 4;
const LABEL_RADIUS = 4;

export async function renderSom(
  imageBase64: string,
  imageMime: "image/jpeg" | "image/png",
  candidates: readonly SomCandidate[],
  scale: number,
  region: { x: number; y: number } | undefined,
  outputQuality: number,
): Promise<SomResult> {
  const res = await fetch(`data:${imageMime};base64,${imageBase64}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    bitmap.close();
    throw new Error("OffscreenCanvas 2d context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const offX = region?.x ?? 0;
  const offY = region?.y ?? 0;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "top";

  const som_map: Record<string, { ref: string; role: string; name: string }> = {};
  let label = 1;
  for (const cand of candidates) {
    const x = (cand.rect.x - offX) * scale;
    const y = (cand.rect.y - offY) * scale;
    const rectW = cand.rect.w * scale;
    const rectH = cand.rect.h * scale;
    if (x + rectW < 0 || y + rectH < 0 || x > w || y > h) continue;

    ctx.strokeStyle = LABEL_BG;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, rectW, rectH);

    const text = String(label);
    const metrics = ctx.measureText(text);
    const tw = metrics.width + LABEL_PAD * 2;
    const th = 14 + LABEL_PAD * 2;
    const lx = Math.max(0, x);
    const ly = Math.max(0, y - th);
    ctx.fillStyle = LABEL_BG;
    if ("roundRect" in ctx && typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(lx, ly, tw, th, LABEL_RADIUS);
      ctx.fill();
    } else {
      ctx.fillRect(lx, ly, tw, th);
    }
    ctx.fillStyle = LABEL_FG;
    ctx.fillText(text, lx + LABEL_PAD, ly + LABEL_PAD);

    som_map[String(label)] = {
      ref: cand.ref,
      role: cand.role,
      name: cand.name,
    };
    label++;
  }

  const outBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: Math.max(0, Math.min(1, outputQuality / 100)),
  });
  const buf = await outBlob.arrayBuffer();
  return { base64: arrayBufferToBase64(buf), width: w, height: h, som_map };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** Injected into the target tab's MAIN world. Walks the DOM for interactive
 *  elements and returns their CSS-pixel bounding boxes plus a stable
 *  identifier the agent can dereference (here: a CSS selector). */
export function collectSomCandidates(): SomCandidate[] {
  const sel =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], [role="textbox"], [contenteditable=""], [contenteditable="true"]';

  function selectorFor(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node !== null && node !== document.documentElement && node !== document.body) {
      const id = node.id;
      if (id) {
        parts.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent !== null) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === (node as Element).tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          parts.unshift(`${tag}:nth-child(${idx})`);
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      node = node.parentElement;
    }
    return parts.length > 0 ? parts.join(" > ") : el.tagName.toLowerCase();
  }

  function accName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim() !== "") return aria.trim().slice(0, 40);
    const text = (el.textContent ?? "").trim();
    return text.slice(0, 40);
  }

  const out: SomCandidate[] = [];
  const nodes = document.querySelectorAll<HTMLElement>(sel);
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.left > window.innerWidth) continue;
    if (rect.top > window.innerHeight) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (parseFloat(style.opacity) < 0.05) continue;
    out.push({
      ref: selectorFor(el),
      role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      name: accName(el),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    });
    if (out.length >= 80) break;
  }
  return out;
}
