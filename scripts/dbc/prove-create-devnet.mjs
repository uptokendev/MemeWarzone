#!/usr/bin/env node
/**
 * Devnet proof of DBC create (step 2). Throwaway keys only.
 * Optional DBC_PROVE_FUNDER_KEYPAIR=<path to json keypair>.
 * Claude runs this with a funder. Do not use founder keys.
 */
import { createRequire } from "node:module";
import { createDbcCreateHandler } from "../../frontend/api/dbc/create.js";
import { DBC_DEVNET_TEST_TARGET_USD_MICROS } from "../../frontend/shared/dbcEconomics.mjs";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Connection, Keypair } = requireFromFrontend("@solana/web3.js");

const DEVNET = SOLANA_GENESIS.devnet;
const RPC = process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

console.log("DBC create proof: Claude to run with a throwaway funder.");
console.log("RPC", RPC);
console.log("Expected genesis", DEVNET);
console.log("Target micros", DBC_DEVNET_TEST_TARGET_USD_MICROS.toString());
console.log("Handler export", typeof createDbcCreateHandler);
console.log("Connection ctor", typeof Connection);
console.log("Keypair ctor", typeof Keypair);
console.log("ALL CHECKS: not executed in this session (no founder keys; Claude runs with a funder).");
process.exit(0);
