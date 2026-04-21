import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "BrowserOps",
  description: "Autonomous browser control for Claude Code.",
  version: "0.1.0",
  minimum_chrome_version: "120",
  permissions: ["tabs", "scripting", "debugger", "storage", "alarms", "webNavigation"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "BrowserOps",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
});
