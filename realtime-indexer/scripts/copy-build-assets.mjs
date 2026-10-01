// tsc emits only code. Files the runtime reads with readFileSync next to its module are copied here,
// or the container starts and dies on ENOENT (2026-10-01: the Meteora DBC IDL).
import { cpSync, existsSync } from "node:fs";

const ASSETS = ["dbc/dynamicBondingCurve.idl.json"];

for (const asset of ASSETS) {
  const from = `src/${asset}`;
  if (!existsSync(from)) throw new Error(`build asset missing: ${from}`);
  cpSync(from, `dist/${asset}`);
  console.log(`[build] copied ${from} -> dist/${asset}`);
}
