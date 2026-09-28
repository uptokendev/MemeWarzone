#!/usr/bin/env node
/**
 * D19 gate: a 0% creator / 100% partner permanent lock must simulate createConfig
 * on devnet. Sends nothing. Throwaway keys only.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import {
  DBC_DEVNET_TEST_TARGET_USD_MICROS,
  DBC_PLATFORM_CREATOR_PERM_LOCK_PCT,
  DBC_PLATFORM_PARTNER_PERM_LOCK_PCT,
  DBC_TARGET_USD_MICROS,
} from "../../frontend/shared/dbcEconomics.mjs";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { solPriceStepIndex, stepUsdMicrosFromIndex } from "../../frontend/api/lib/dbc/dbcPriceSteps.mjs";
import { buildLaunchConfigParams } from "../../frontend/api/lib/dbc/dbcLaunchConfigParams.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Connection, Keypair, Transaction, VersionedTransaction } = requireFromFrontend("@solana/web3.js");
const { NATIVE_MINT } = requireFromFrontend("@solana/spl-token");
const { DynamicBondingCurveClient } = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");

const DEVNET = SOLANA_GENESIS.devnet;
const RPC = process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET) throw new Error(`Refusing: not devnet (${genesis})`);
  const funderPath = process.env.DBC_PROVE_FUNDER_KEYPAIR;
  const payer = funderPath
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(funderPath, "utf8"))))
    : Keypair.generate();
  const collector = Keypair.generate();
  console.log(`payer ${payer.publicKey.toBase58()}  ${await conn.getBalance(payer.publicKey)} lamports`);
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const step = stepUsdMicrosFromIndex(solPriceStepIndex(118_000_000n));
  const cases = [
    { label: "$15k platform", target: DBC_TARGET_USD_MICROS[15000], mode: "platform" },
    { label: "$150 platform", target: DBC_DEVNET_TEST_TARGET_USD_MICROS, mode: "platform" },
    { label: "$150 keep", target: DBC_DEVNET_TEST_TARGET_USD_MICROS, mode: "creator" },
  ];
  let fail = 0;
  for (const c of cases) {
    const built = buildLaunchConfigParams(c.target, step, c.mode);
    const dist = built.configParams;
    const partner = Number(dist.partnerPermanentLockedLiquidityPercentage);
    const creator = Number(dist.creatorPermanentLockedLiquidityPercentage);
    const wantPartner = c.mode === "platform" ? DBC_PLATFORM_PARTNER_PERM_LOCK_PCT : 20;
    const wantCreator = c.mode === "platform" ? DBC_PLATFORM_CREATOR_PERM_LOCK_PCT : 80;
    const lockOk = partner === wantPartner && creator === wantCreator;
    console.log(`  ${lockOk ? "PASS" : "FAIL"}  ${c.label} lock partner ${partner} creator ${creator}`);
    if (!lockOk) fail += 1;
    const configKp = Keypair.generate();
    const tx = await client.partner.createConfig({
      config: configKp.publicKey,
      feeClaimer: collector.publicKey,
      leftoverReceiver: collector.publicKey,
      quoteMint: NATIVE_MINT,
      payer: payer.publicKey,
      ...built.configParams,
    });
    tx.feePayer = payer.publicKey;
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.partialSign(payer, configKp);
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    const err = sim.value?.err ?? sim.err;
    const ok = err == null;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.label} createConfig simulate${ok ? "" : `  ${JSON.stringify(err)}`}`);
    if (!ok) {
      fail += 1;
      const logs = sim.value?.logs || sim.logs;
      if (logs) console.log(logs.slice(-8).join("\n"));
    }
  }
  console.log(fail ? `FAILED ${fail}` : "ALL CHECKS PASS");
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
