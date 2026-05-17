// Diff two augmented a11y payloads at the ref level. Returns added /
// removed / changed lists keyed by ref. The payload shape mirrors what
// browser_observe mode=text returns: { nodes: AugmentedNode[] }.

export interface DiffEntry {
  ref: string;
  role: string;
  name: string;
}

export interface A11yDiffResult {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
}

interface MinimalNode {
  ref: string;
  role: string;
  name: string;
  visible?: boolean;
  in_viewport?: boolean;
  disabled_visual?: boolean;
}

function nodeFingerprint(n: MinimalNode): string {
  return `${n.role}|${n.name}|${n.visible ?? false}|${n.in_viewport ?? false}|${n.disabled_visual ?? false}`;
}

export function diffA11y(
  before: readonly MinimalNode[],
  after: readonly MinimalNode[],
): A11yDiffResult {
  const beforeMap = new Map<string, MinimalNode>();
  const afterMap = new Map<string, MinimalNode>();
  for (const n of before) beforeMap.set(n.ref, n);
  for (const n of after) afterMap.set(n.ref, n);
  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  for (const [ref, a] of afterMap) {
    const b = beforeMap.get(ref);
    if (b === undefined) {
      added.push({ ref, role: a.role, name: a.name });
    } else if (nodeFingerprint(b) !== nodeFingerprint(a)) {
      changed.push({ ref, role: a.role, name: a.name });
    }
  }
  for (const [ref, b] of beforeMap) {
    if (!afterMap.has(ref)) {
      removed.push({ ref, role: b.role, name: b.name });
    }
  }
  return { added, removed, changed };
}
