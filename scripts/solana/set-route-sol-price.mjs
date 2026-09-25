#!/usr/bin/env node
/**
 * Updates route_state.native_usd_micros -- the SOL/USD price flush_operator_fill uses to count the
 * operator wallet's $10k lifetime cap. Nothing else changes: operator, overflow treasury and cap are
 * read from chain and written back as they are.
 *
 * Why: the stored price was $77.19 on 2026-09-25 while SOL traded at $121.71, so every flushed
 * lamport counted ~37% fewer dollars against the cap and the operator would receive ~$15.8k in real
 * value before the cap closed. The price is only cap bookkeeping; it never prices a trade.
 *
 *   SOLANA_RPC_URL=<mainnet rpc> node scripts/solana/set-route-sol-price.mjs              # dry run (simulates)
 *   SOLANA_RPC_URL=<mainnet rpc> SOLANA_TREASURY_AUTHORITY_KEYPAIR=<deployer.json> \
 *     node scripts/solana/set-route-sol-price.mjs --execute                              # sends
 *   ... --price 121.71                                                                   # pin a price instead of Binance
 *
 * The signer must be rewards_config.authority (the deployer). Refuses any cluster but mainnet-beta.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const anchor = require(path.join(root, "tests/solana/node_modules/@coral-xyz/anchor"));
const { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } = require(path.join(root, "tests/solana/node_modules/@solana/web3.js"));
const { SOLANA_GENESIS } = await import(path.join(root, "frontend/src/lib/solanaArenaLayout.mjs"));

const PROGRAM_ID = new PublicKey(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const execute = process.argv.includes("--execute");
const priceFlag = process.argv.indexOf("--price");
const pinnedPrice = priceFlag > 0 ? Number(process.argv[priceFlag + 1]) : null;

const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8")], PROGRAM_ID)[0];
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const usd = (micros) => `$${(Number(micros) / 1e6).toFixed(2)}`;

async function spotSolUsd() {
  const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
  if (!response.ok) throw new Error(`Binance SOLUSDT HTTP ${response.status}`);
  const price = Number((await response.json())?.price);
  if (!Number.isFinite(price) || price < 1 || price > 100_000) throw new Error(`implausible SOL price ${price}`);
  return price;
}

async function main() {
  const rpc = String(process.env.SOLANA_RPC_URL || "").trim();
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(rpc, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== SOLANA_GENESIS["mainnet-beta"]) throw new Error(`refusing to run: ${rpc} reports genesis ${genesis}, not mainnet-beta`);
  console.log(`[route-price] cluster verified mainnet-beta by genesis ${genesis}`);

  let authority;
  try {
    authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expand(process.env.SOLANA_TREASURY_AUTHORITY_KEYPAIR || "~/mwz-deployer.json"), "utf8"))));
  } catch (error) {
    if (execute) throw error;
    authority = Keypair.generate();
    console.log("[route-price] no authority keypair readable; the dry run simulates as the on-chain authority, unsigned");
  }
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" });
  const program = new anchor.Program(JSON.parse(fs.readFileSync(path.join(root, "target/idl/mwz_rewards_treasury.json"), "utf8")), provider);

  const rewardsConfig = pda("rewards_config");
  const routeState = pda("route_state");
  const config = await program.account.rewardsConfig.fetch(rewardsConfig);
  const route = await program.account.routeState.fetch(routeState);
  if (execute && !config.authority.equals(authority.publicKey)) {
    throw new Error(`signer ${authority.publicKey.toBase58()} is not rewards_config.authority ${config.authority.toBase58()}`);
  }

  const price = pinnedPrice ?? (await spotSolUsd());
  if (!Number.isFinite(price) || price < 1 || price > 100_000) throw new Error(`implausible SOL price ${price}`);
  const nativeUsdMicros = new anchor.BN(Math.round(price * 1e6));
  console.log(`[route-price] operator ${route.operator.toBase58()}  overflow ${route.overflowTreasury.toBase58()}`);
  console.log(`[route-price] cap ${usd(route.operatorFillCapUsdMicros)}  filled ${usd(route.operatorFilledUsdMicros)}  (unchanged)`);
  console.log(`[route-price] SOL price ${usd(route.nativeUsdMicros)} -> ${usd(nativeUsdMicros)}`);

  const signer = execute ? authority.publicKey : config.authority;
  const method = program.methods
    .setRouteParams(route.operator, route.overflowTreasury, route.operatorFillCapUsdMicros, nativeUsdMicros)
    .accountsStrict({ authority: signer, config: rewardsConfig, routeState });
  if (!execute) {
    // Unsigned simulation as the real authority: proves the exact transaction without the key.
    const ix = await method.instruction();
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    if (sim.value.err) console.log(`[route-price] simulation FAILED: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-6).join("\n")}`);
    else console.log(`[route-price] simulation ok as ${signer.toBase58()} (${sim.value.unitsConsumed} CU). Re-run with --execute to send.`);
    return;
  }
  const signature = await method.rpc();
  const after = await program.account.routeState.fetch(routeState);
  console.log(`[route-price] sent ${signature}`);
  console.log(`[route-price] read back: price ${usd(after.nativeUsdMicros)}, operator ${after.operator.toBase58()}, overflow ${after.overflowTreasury.toBase58()}, cap ${usd(after.operatorFillCapUsdMicros)}`);
}

main().catch((error) => {
  console.error(`[route-price] ${error?.message || error}`);
  process.exit(1);
});
