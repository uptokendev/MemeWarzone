import { defineConfig } from "vite";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The embeddable swap widget (src/widget/mwzSwapWidget.ts), built after the app into
// dist/widget/mwz-swap.js: one IIFE that defines window.MemeWarzoneSwap. Buffer is polyfilled
// as a module only, never as a global, so the host page's own globals stay untouched.
export default defineConfig({
  plugins: [nodePolyfills({ include: ["buffer"], globals: { Buffer: false, global: false, process: false } })],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
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
  },
});
