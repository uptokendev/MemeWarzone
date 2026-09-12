#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  INFRA_MANIFEST_PATH,
  validateInfrastructureManifest,
} from "./robinhoodTestnetInfrastructureAuthority.mjs";

const manifestPath = path.resolve(process.env.ROBINHOOD_TESTNET_INFRA_MANIFEST || INFRA_MANIFEST_PATH);
if (!fs.existsSync(manifestPath)) throw new Error(`Robinhood testnet infrastructure manifest missing: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
validateInfrastructureManifest(manifest);

for (const [name, value] of Object.entries(manifest.mwzEnvironment)) {
  process.stdout.write(`${name}=${value}\n`);
}
