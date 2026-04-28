import type { Router } from "../router.js";

/**
 * chrome.tabGroups.ColorEnum values, mirrored from the spec. Daemon
 * supplies a colour string that came from this list — anything else
 * falls back to grey.
 */
const VALID_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

interface SessionRecord {
  session_id: string;
  name: string;
  color: chrome.tabGroups.ColorEnum;
  /**
   * Resolved Chrome tab-group id. Created lazily on the first
   * claim_tab — Chrome refuses tabGroups.update on a group that has
   * never had a tab assigned to it, and returns -1 from groupings
   * with zero members.
   */
  group_id?: number;
}

const sessions = new Map<string, SessionRecord>();

/**
 * Map<chrome_tab_id, session_id>. Keeps claim/release accounting
 * cheap and lets us hide a tab from the wrong group on Chrome
 * restoration races.
 */
const tabOwners = new Map<number, string>();

function pickColor(raw: unknown): chrome.tabGroups.ColorEnum {
  if (typeof raw === "string" && VALID_COLORS.has(raw)) {
    return raw as chrome.tabGroups.ColorEnum;
  }
  return "grey";
}

/**
 * Group a tab into the session's Chrome tab group, creating the group
 * lazily if needed (Chrome only materialises a group id once at least
 * one tab is in it). Updates the title + colour after creation so the
 * agent's session label is visible from the tab strip.
 */
async function ensureGroupedInto(record: SessionRecord, chromeTabId: number): Promise<void> {
  const tab = await chrome.tabs.get(chromeTabId).catch(() => undefined);
  if (!tab) return;

  if (record.group_id !== undefined && record.group_id !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    await chrome.tabs
      .group({ tabIds: chromeTabId, groupId: record.group_id })
      .catch(() => undefined);
    return;
  }

  // First tab in this session — create a group, then style it.
  const groupId = await chrome.tabs.group({ tabIds: chromeTabId });
  record.group_id = groupId;
  await chrome.tabGroups
    .update(groupId, { title: record.name, color: record.color })
    .catch(() => undefined);
}

async function ungroup(chromeTabId: number): Promise<void> {
  await chrome.tabs.ungroup(chromeTabId).catch(() => undefined);
}

/**
 * Wire session-group RPCs called by the daemon when sessions and tab
 * ownership change. Methods are intentionally tolerant — the
 * extension cannot block daemon dispatch on missing Chrome state, so
 * everything best-efforts and logs to the SW console.
 */
export function registerSessionGroupHandlers(router: Router): void {
  router.register("session_started", async (params) => {
    const session_id = stringField(params, "session_id");
    const name = stringField(params, "name") ?? "session";
    const color = pickColor(params["color"]);
    if (!session_id) return { ok: false, reason: "missing_session_id" };

    const existing = sessions.get(session_id);
    if (existing) {
      existing.name = name;
      existing.color = color;
      if (existing.group_id !== undefined && existing.group_id !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await chrome.tabGroups.update(existing.group_id, { title: name, color }).catch(() => undefined);
      }
    } else {
      sessions.set(session_id, { session_id, name, color });
    }
    return { ok: true };
  });

  router.register("session_renamed", async (params) => {
    const session_id = stringField(params, "session_id");
    const name = stringField(params, "name");
    if (!session_id || name === undefined) return { ok: false, reason: "invalid_params" };
    const record = sessions.get(session_id);
    if (!record) return { ok: false, reason: "unknown_session" };
    record.name = name;
    if (params["color"] !== undefined) record.color = pickColor(params["color"]);
    if (record.group_id !== undefined && record.group_id !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      await chrome.tabGroups
        .update(record.group_id, { title: record.name, color: record.color })
        .catch(() => undefined);
    }
    return { ok: true };
  });

  router.register("session_ended", async (params) => {
    const session_id = stringField(params, "session_id");
    if (!session_id) return { ok: false };
    const record = sessions.get(session_id);
    sessions.delete(session_id);
    // Remove the group label so any tabs the user has *not* yet closed
    // make it visually obvious they were left behind by an agent.
    if (record?.group_id !== undefined && record.group_id !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      await chrome.tabGroups
        .update(record.group_id, { title: `orphaned: ${record.name}`, color: "grey" })
        .catch(() => undefined);
    }
    // Drop tabOwners entries belonging to this session so a later
    // release_tab on those tabs doesn't double-process.
    for (const [tabId, owner] of tabOwners) {
      if (owner === session_id) tabOwners.delete(tabId);
    }
    return { ok: true };
  });

  router.register("claim_tab", async (params) => {
    const session_id = stringField(params, "session_id");
    const chrome_tab_id = numberField(params, "chrome_tab_id");
    if (!session_id || chrome_tab_id == null) return { ok: false };
    const record = sessions.get(session_id);
    if (!record) return { ok: false, reason: "unknown_session" };

    // If another session already owned this tab in our local view (race
    // with a release that hasn't reached us yet), ungroup first to keep
    // the state machine simple — Chrome would reject re-grouping into a
    // different group otherwise.
    const prior = tabOwners.get(chrome_tab_id);
    if (prior && prior !== session_id) {
      await ungroup(chrome_tab_id);
    }
    tabOwners.set(chrome_tab_id, session_id);
    await ensureGroupedInto(record, chrome_tab_id);
    return { ok: true };
  });

  router.register("release_tab", async (params) => {
    const chrome_tab_id = numberField(params, "chrome_tab_id");
    if (chrome_tab_id == null) return { ok: false };
    tabOwners.delete(chrome_tab_id);
    await ungroup(chrome_tab_id);
    return { ok: true };
  });
}

function stringField(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

function numberField(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" ? v : undefined;
}
