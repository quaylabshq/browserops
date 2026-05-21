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

function describeLayout(n: BoxDrawingNode): string {
  const d = n.display ?? "";
  if (d === "flex" || d === "inline-flex") {
    const dir = n.flex_direction ?? "row";
    return ` [flex ${dir}]`;
  }
  if (d === "grid" || d === "inline-grid") {
    return " [grid]";
  }
  return "";
}

function renderLandmarkHeader(group: LandmarkGroup): string {
  const layoutHint = group.nodes.length > 0 ? describeLayout(group.nodes[0]!) : "";
  const label = group.name !== ""
    ? `${group.role.toUpperCase()}${layoutHint}: ${group.name}`
    : `${group.role.toUpperCase()}${layoutHint}`;
  return `┌── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}┐`;
}

function renderLandmarkFooter(): string {
  return `└${"─".repeat(64)}┘`;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "radio",
  "slider",
  "spinbutton",
  "treeitem",
]);

function renderLeafLine(n: BoxDrawingNode): string {
  const label = n.name !== "" ? n.name : `<${n.role}>`;
  const flags: string[] = [];
  if (!n.visible) flags.push("hidden");
  else if (!n.in_viewport) flags.push("offscreen");
  if (n.occluded_by !== null) flags.push("occluded");
  if (n.disabled_visual) flags.push("disabled");
  const tail = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return `│  [${label} r${n.ref}]${tail}`;
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
    let tableMode: { table: BoxDrawingNode; rows: BoxDrawingNode[][] } | null = null;
    for (const n of g.nodes) {
      if (LANDMARK_ROLES.has(n.role)) continue; // skip the landmark itself
      if (n.role === "table" || n.role === "grid") {
        if (tableMode !== null) flushTable(lines, tableMode);
        tableMode = { table: n, rows: [[]] };
        continue;
      }
      if (tableMode !== null && (n.role === "row")) {
        tableMode.rows.push([]);
        continue;
      }
      if (tableMode !== null && (n.role === "cell" || n.role === "gridcell" || n.role === "columnheader" || n.role === "rowheader")) {
        const lastRow = tableMode.rows[tableMode.rows.length - 1] ?? [];
        if (tableMode.rows.length === 0) tableMode.rows.push([]);
        lastRow.push(n);
        continue;
      }
      if (tableMode !== null) {
        flushTable(lines, tableMode);
        tableMode = null;
      }
      if (INTERACTIVE_ROLES.has(n.role) || n.role === "heading") {
        lines.push(renderLeafLine(n));
      }
    }
    if (tableMode !== null) flushTable(lines, tableMode);
    lines.push(renderLandmarkFooter());
  }
  return { text: lines.join("\n"), ref_map };
}

function flushTable(
  lines: string[],
  table: { table: BoxDrawingNode; rows: BoxDrawingNode[][] },
): void {
  const nonEmpty = table.rows.filter((r) => r.length > 0);
  if (nonEmpty.length === 0) {
    lines.push(`│  [TABLE r${table.table.ref}] (empty)`);
    return;
  }
  const colWidths: number[] = [];
  for (const row of nonEmpty) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i]!;
      const text = `${cell.name} r${cell.ref}`;
      colWidths[i] = Math.max(colWidths[i] ?? 0, text.length);
    }
  }
  const sep = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  lines.push(`│  TABLE r${table.table.ref}`);
  lines.push(`│  ${sep}`);
  for (const row of nonEmpty) {
    const cells = row
      .map((c, i) => ` ${(`${c.name} r${c.ref}`).padEnd(colWidths[i] ?? 0)} `)
      .join("|");
    lines.push(`│  |${cells}|`);
    lines.push(`│  ${sep}`);
  }
}
