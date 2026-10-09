import { defineConfig } from "vite";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The embeddable swap widget (src/widget/mwzSwapWidget.ts), built after the app into
// dist/widget/mwz-swap.js: one IIFE that defines window.MemeWarzoneSwap. Buffer is polyfilled
// as a module only, never as a global, so the host page's own globals stay untouched.
export default defineConfig({
  // Buffer/global/process are injected per module where the bundled code uses them, never assigned on the
  // host page's window (the e2e test checks window.Buffer stays the host's).
  plugins: [nodePolyfills({ include: ["buffer", "process"], globals: { Buffer: "build", global: "build", process: "build" } })],
  resolve: {
    alias: [
      // The app's Solana trade code is bundled unchanged; only these app-only helpers are swapped (src/widget/shims).
      { find: /^@\/lib\/apiBase$/, replacement: path.resolve(__dirname, "./src/widget/shims/apiBase.ts") },
      { find: /^@\/lib\/solanaWallet$/, replacement: path.resolve(__dirname, "./src/widget/shims/solanaWallet.ts") },
      { find: /^@\/lib\/analytics\/actions$/, replacement: path.resolve(__dirname, "./src/widget/shims/analyticsActions.ts") },
      { find: /^@\/polyfills$/, replacement: path.resolve(__dirname, "./src/widget/shims/polyfills.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  // ASCII-only output: host pages without a charset would garble the widget text.
  esbuild: { charset: "ascii" },
  build: {
    outDir: "dist/widget",
    emptyOutDir: false,
    copyPublicDir: false,
    sourcemap: false,
    lib: {
      entry: path.resolve(__dirname, "src/widget/mwzSwapWidget.ts"),
      name: "MemeWarzoneSwapModule",
      formats: ["iife"],
      fileName: () => "mwz-swap.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
