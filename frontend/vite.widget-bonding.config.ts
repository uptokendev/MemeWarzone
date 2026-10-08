import { defineConfig, mergeConfig } from "vite";
import path from "path";
import base from "./vite.widget.config";

// mwz-swap-bonding.js: the bonding part of the swap widget (src/widget/bondingEntry.ts), same build
// settings and module swaps as mwz-swap.js, loaded by it only for launchpad / DBC coins.
export default mergeConfig(base, defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/widget/bondingEntry.ts"),
      name: "MemeWarzoneSwapBondingModule",
      formats: ["iife"],
      fileName: () => "mwz-swap-bonding.js",
    },
  },
}));
