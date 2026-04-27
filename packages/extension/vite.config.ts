import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import manifest from "./src/manifest.js";

export default defineConfig({
  plugins: [crx({ manifest }), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome120",
    // Disable base64 inlining of imported assets — chrome.action.setIcon
    // requires real file paths in `path`, and data URLs would silently fail.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        onboard: "src/onboard/index.html",
      },
    },
  },
});
