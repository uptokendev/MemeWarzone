// Re-runs the AI-audit proofs of concept (audit-A bedf8806, audit-B bf5695ff, audit-C d15839cf, audit-D c10ef8a9)
// against the CURRENT gen-8 contracts. scripts/gen8/audit-rerun.sh copies the PoCs into ./audit-rerun (gitignored)
// with path-only import fixes, then runs this config. Same pinned compiler as hardhat.gen8.config.ts; fresh
// deterministic test keys (never the standard hardhat / anvil keys); local in-process network only.
import { HardhatUserConfig } from "hardhat/config";
import base from "./hardhat.gen8.config";

const config: HardhatUserConfig = {
  ...base,
  paths: { sources: "./audit-rerun/contracts", tests: "./audit-rerun/tests", cache: "./cache-audit-rerun", artifacts: "./artifacts-audit-rerun" },
  typechain: { outDir: "typechain-types-audit-rerun", dontOverrideCompile: true },
  mocha: { timeout: 1_200_000 },
};

export default config;
