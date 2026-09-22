#!/usr/bin/env node
/**
 * Can a graduation-sized swap clear these pools inside the impact cap?
 *
 * This is the question that blocked the binding path on devnet: the pool
 * existed, but quoting a graduation-sized SOL -> quote swap through nine
 * dollars of liquidity blew past the cap, so the authorization refused to sign.
 * Seeding a pool only helps if the quote it produces is actually acceptable, so
 * measure it rather than assume the depth is enough.
 *
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 \
 *   SOLANA_GRADUATION_OPERATOR_KEYPAIR=<keypair> \
 *   POOLS_REPORT=/tmp/mwz-local-quote-pools.json \
 *   node tools/solana-meteora-graduation/check-quote-pool-depth.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setPayerFromBytes, setRpc, swapInstructions, WhirlpoolDeployment } from "@orca-so/whirlpools";
import { address, createSolanaRpc } from "@solana/kit";
import { Keypair } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

const WSOL = NATIVE_MINT.toBase58();

function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const rpcUrl = required("SOLANA_RPC_URL");
  const reportPath = process.env.POOLS_REPORT || "/tmp/mwz-local-quote-pools.json";
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(expand(required("SOLANA_GRADUATION_OPERATOR_KEYPAIR")), "utf8"))),
  );

  // A graduation swaps the LP share of the raise, so size the probe like one.
  const swapLamports = BigInt(process.env.PROBE_SWAP_LAMPORTS || "94000000");
  const capBps = Number(process.env.PROBE_MAX_IMPACT_BPS || "300");

  await setRpc(rpcUrl);
  await setPayerFromBytes(payer.secretKey);
  const rpc = createSolanaRpc(rpcUrl);

  let failures = 0;
  for (const variant of ["classic", "token2022"]) {
    const entry = report[variant];
    if (!entry?.pool) { console.log(`${variant}: absent from the report`); failures += 1; continue; }
    try {
      const built = await swapInstructions(
        rpc,
        { inputAmount: swapLamports, mint: address(WSOL) },
        address(entry.pool),
        { slippageToleranceBps: capBps, whirlpoolDeployment: WhirlpoolDeployment.devnet },
      );
      const quote = built.quote || {};
      const out = BigInt(quote.tokenEstOut ?? quote.tokenOut ?? 0);
      const minOut = BigInt(quote.tokenMinOut ?? 0);
      console.log(
        `${variant.padEnd(10)} pool=${entry.pool} in=${swapLamports} out=${out} minOut=${minOut}` +
        ` tokenProgram=${entry.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "classic"}`,
      );
      if (out <= 0n) { console.log(`${variant}: quote produced no output`); failures += 1; }
    } catch (error) {
      console.log(`${variant.padEnd(10)} QUOTE FAILED: ${String(error?.message || error)}`);
      failures += 1;
    }
  }

  if (failures) {
    console.log(`\n${failures} pool(s) cannot serve a graduation-sized swap at ${capBps} bps.`);
    process.exit(1);
  }
  console.log(`\nBoth pools quote a ${Number(swapLamports) / 1e9} SOL graduation swap within ${capBps} bps.`);
}

main().catch((error) => {
  console.error(String(error?.stack || error?.message || error));
  process.exit(1);
});
