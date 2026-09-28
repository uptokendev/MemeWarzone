#!/usr/bin/env node
/**
 * Keep the current SOL-price step ±2 ready for every DBC target and both fee modes.
 * --dry-run prints the keys and sends nothing.
 */
import { pool } from "../server/db.js";
import {
  DBC_CREATOR_FEE_MODES,
  DBC_SOL_USD_MAX_STALE_MS,
  allowedTargetUsdMicros,
} from "../shared/dbcEconomics.mjs";
import { readSolUsdMicros } from "../api/lib/solUsdMicros.js";
import { solPriceStep, stepUsdMicrosFromIndex } from "../api/lib/dbc/dbcPriceSteps.mjs";
import { createDbcConfigLadder, requiredCluster } from "../api/lib/dbc/dbcConfigLadder.js";

const DRY = process.argv.includes("--dry-run");

async function main() {
  const cluster = requiredCluster();
  const solUsdMicros = await readSolUsdMicros({ maxStaleMs: DBC_SOL_USD_MAX_STALE_MS });
  const { stepIndex } = solPriceStep(solUsdMicros);
  const targets = allowedTargetUsdMicros(cluster);
  const keys = [];
  for (const targetUsdMicros of targets) {
    for (const creatorFeeMode of DBC_CREATOR_FEE_MODES) {
      for (let d = -2; d <= 2; d += 1) {
        const index = stepIndex + d;
        keys.push({
          targetUsdMicros: targetUsdMicros.toString(),
          stepIndex: index,
          stepUsdMicros: stepUsdMicrosFromIndex(index).toString(),
          creatorFeeMode,
        });
      }
    }
  }

  console.log(`cluster ${cluster}  solUsdMicros ${solUsdMicros}  step ${stepIndex}  keys ${keys.length}${DRY ? "  DRY RUN" : ""}`);
  if (DRY) {
    console.table(keys);
    return;
  }

  const ladder = createDbcConfigLadder({ db: pool, cluster });
  for (const key of keys) {
    const row = await ladder.ensureLaunchConfig({
      targetUsdMicros: BigInt(key.targetUsdMicros),
      stepIndex: key.stepIndex,
      stepUsdMicros: BigInt(key.stepUsdMicros),
      creatorFeeMode: key.creatorFeeMode,
    });
    console.log(`  ${row.status}  ${key.creatorFeeMode}  target=${key.targetUsdMicros}  step=${key.stepIndex}  ${row.configAddress}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
