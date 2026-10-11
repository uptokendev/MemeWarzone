// Writes the ABIs of the gen-8 production contracts to contracts/gen8/abi/ for step 2 (fork suite), step 3 (indexer)
// and step 4/5 (API, app). Run after `npx hardhat --config hardhat.gen8.config.ts compile`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadArtifacts } from "./fork-suite/artifacts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "..", "..", "contracts", "gen8", "abi");
const NAMES = [
  "MwzLaunchHook", "MwzLaunchLens", "MwzV4Launcher", "MwzV4Token", "MwzReserveLock", "MwzCreatorEscrow", "MwzFeeSplitter",
  "MwzCreatorChoiceVault", "MwzDisplayPair", "MwzDisplayPairFactory", "MwzSwapSim",
];
const { contracts } = loadArtifacts();
fs.mkdirSync(OUT, { recursive: true });
for (const n of NAMES) {
  fs.writeFileSync(path.join(OUT, `${n}.abi.json`), JSON.stringify(contracts[n].abi, null, 2) + "\n");
  console.log(`${n}: ${contracts[n].abi.length} entries`);
}
