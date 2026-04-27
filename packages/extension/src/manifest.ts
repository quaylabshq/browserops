import { defineManifest } from "@crxjs/vite-plugin";

// The `key` below pins the extension ID across `load-unpacked` sessions.
// Without it, Chrome derives a new ID from the install path every time the
// extension is loaded from a different directory, which breaks the bridge's
// BROWSEROPS_EXTENSION_ID origin check.
//
// Recipe to regenerate (keep the private key offline; only the public half
// ships here):
//   openssl genrsa 2048 > key.pem
//   openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
// Paste the base64 output as the value of `key`. The derived extension ID
// appears in chrome://extensions after first load — pin it via
// BROWSEROPS_EXTENSION_ID in the bridge environment.
const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5RYQVkFRtQzihnGuZ/L4Bli1lHszyyfcK7ZhKUj0Fp9KMXQ/UbsO98ucDeFxy/NCfX6OniD5IlJMqgAR6zlP9bffkTqv72ErNPRw/0y7GzLPJj1mM5LBA/aAm+y2a7xp1lLjGDm5QTuV44Cukn1aYGXtBspzDqeswgwH2A03Y7lfUe28xSdJ/AlbP6AC/KrzmzXPD3hBeqAXIjye96ijyD4slob+YSQrWGurND6RDgrVUITjpqjF2Jx4MCd8ijVULaPBSuFMnIAO/EQ2GWTGc04b1HS6d7zXGFsdq/98DCiZbveeCKq37kDgAhndaFOCIQFivRfntkARFvMGC3eswIDAQAB";

export default defineManifest({
  manifest_version: 3,
  name: "BrowserOps",
  description: "Autonomous browser control for MCP-compatible agents.",
  version: "0.0.2",
  minimum_chrome_version: "120",
  key: EXTENSION_KEY,
  permissions: ["tabs", "scripting", "debugger", "storage", "alarms", "webNavigation", "webRequest"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "BrowserOps",
    default_icon: {
      "16": "src/assets/icons/icon-16.png",
      "32": "src/assets/icons/icon-32.png",
      "48": "src/assets/icons/icon-48.png",
      "128": "src/assets/icons/icon-128.png",
    },
  },
  icons: {
    "16": "src/assets/icons/icon-16.png",
    "32": "src/assets/icons/icon-32.png",
    "48": "src/assets/icons/icon-48.png",
    "128": "src/assets/icons/icon-128.png",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  // Expose the onboarding page so it can be opened directly via
  // chrome.tabs.create(chrome.runtime.getURL("src/onboard/index.html")) and
  // so Chrome serves it with the extension origin (needed for the /pair
  // fetch to 127.0.0.1:57321 to be allowed by the bridge's origin check).
  web_accessible_resources: [
    {
      resources: ["src/onboard/index.html"],
      matches: ["<all_urls>"],
    },
  ],
});
