import { describe, expect, it } from "vitest";
import { syncExistingTabs } from "./tab-sync.js";

describe("syncExistingTabs", () => {
  it("re-announces existing Chrome tabs after a bridge reconnect", async () => {
    const events: unknown[] = [];
    await syncExistingTabs(
      async () => [
        { id: 7, url: "https://mail.example", windowId: 2, index: 0, active: true },
        { pendingUrl: "https://pending.example", windowId: 2, index: 1, active: false },
      ],
      (name, payload) => events.push({ name, payload }),
    );

    expect(events).toEqual([
      {
        name: "tab_created",
        payload: {
          chrome_tab_id: 7,
          url: "https://mail.example",
          window_id: 2,
          index: 0,
          active: true,
        },
      },
    ]);
  });
});
