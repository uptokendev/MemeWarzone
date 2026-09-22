#!/usr/bin/env node
/**
 * Mint devnet test quote assets we control, and seed an Orca pool for each.
 *
 * The graduation binding path could not be proven end to end because the only
 * devnet quote with an Orca pool is Circle's USDC, whose pool holds ~9 USDC --
 * far too thin for a graduation-sized swap -- and whose mint authority is
 * Circle's, so we cannot deepen it. A faucet cannot realistically supply enough
 * either.
 *
 * On devnet there is no reason to depend on someone else's asset. These mints
 * are ours, so supply is free; only the SOL side of each pool costs anything.
 * One classic SPL quote and one Token-2022 quote, because the Token-2022
 * binding path has no devnet asset at all and cannot otherwise be exercised.
 *
 * Devnet only: it refuses any other genesis before touching a key.
 *
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   SOLANA_GRADUATION_OPERATOR_KEYPAIR=~/.config/memewarzone/solana-devnet/deployer.json \
 *   SEED_POOL_SOL=2 SEED_PRICE_USD=117 \
 *   node tools/solana-meteora-graduation/seed-devnet-quote-pools.mjs [--execute]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createConcentratedLiquidityPool,
  openFullRangePosition,
  setNativeMintWrappingStrategy,
  orderMints,
  setPayerFromBytes,
  setRpc,
  WhirlpoolDeployment,
} from "@orca-so/whirlpools";
import { address, createSolanaRpc, devnet } from "@solana/kit";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMint,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  mintTo,
} from "@solana/spl-token";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DECIMALS = 6;
const execute = process.argv.includes("--execute");

function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expand(file), "utf8"))));
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** A Token-2022 mint carrying only a metadata pointer: nothing that can move a balance. */
async function createToken2022Mint(connection, payer) {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.MetadataPointer]);
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      space, lamports, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(mint.publicKey, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ), [payer, mint], { commitment: "confirmed" });
  return mint.publicKey;
}

async function ensureAta(connection, payer, mint, programId) {
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, programId);
  if (!(await connection.getAccountInfo(ata, "confirmed"))) {
    await sendAndConfirmTransaction(connection, new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, mint, programId),
    ), [payer], { commitment: "confirmed" });
  }
  return ata;
}

/** Wraps SOL so the pool's SOL side can be funded. */
async function wrapSol(connection, payer, lamports) {
  const ata = await ensureAta(connection, payer, NATIVE_MINT, TOKEN_PROGRAM_ID);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports: Number(lamports) }),
    createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
  ), [payer], { commitment: "confirmed" });
  return ata;
}

async function main() {
  const rpcUrl = required("SOLANA_RPC_URL");
  const connection = new Connection(rpcUrl, "confirmed");
  // Devnet, or a local validator carrying a cloned Orca. A local validator has
  // a fresh genesis every reset, so it is identified by its endpoint instead --
  // and only a loopback endpoint qualifies, so no remote cluster can slip in.
  const isLocal = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:|$|\/)/.test(rpcUrl);
  const genesis = await connection.getGenesisHash();
  if (!isLocal && genesis !== DEVNET_GENESIS) {
    throw new Error(`Refusing genesis ${genesis}; this script runs on devnet or a local validator only.`);
  }
  console.log(`[seed] cluster ${isLocal ? "local validator" : "devnet"} genesis ${genesis}`);

  const payer = loadKeypair(required("SOLANA_GRADUATION_OPERATOR_KEYPAIR"));
  const poolSol = Number(process.env.SEED_POOL_SOL || "2");
  const tickSpacing = Number(process.env.SEED_TICK_SPACING || "64");
  const priceUsd = Number(process.env.SEED_PRICE_USD || "117");
  const poolLamports = BigInt(Math.round(poolSol * 1_000_000_000));
  // Enough of our own token to match the SOL side at the seeded price, twice
  // over, so a full-range position can be opened without running short.
  const quoteUnits = BigInt(Math.round(poolSol * priceUsd * 2)) * 10n ** BigInt(DECIMALS);

  const balance = await connection.getBalance(payer.publicKey, "confirmed");
  console.log(`[seed] payer ${payer.publicKey.toBase58()} balance ${balance / 1e9} SOL`);
  console.log(`[seed] per pool: ${poolSol} SOL + ${quoteUnits / 10n ** BigInt(DECIMALS)} test units at $${priceUsd}/SOL`);
  console.log(`[seed] two pools => about ${(poolSol * 2 + 0.1).toFixed(2)} SOL committed, tickSpacing ${tickSpacing}`);
  if (!execute) {
    console.log("[seed] dry run; re-run with --execute to mint and seed");
    return;
  }
  if (balance < Number(poolLamports) * 2 + 300_000_000) {
    throw new Error(`payer needs about ${(poolSol * 2 + 0.3).toFixed(2)} SOL; has ${balance / 1e9}`);
  }

  await setRpc(rpcUrl);
  // The pool and position builders need an explicit funder signer.
  const funder = await setPayerFromBytes(payer.secretKey);
  // Use the WSOL ATA this script funds rather than an ephemeral keypair account.
  setNativeMintWrappingStrategy("ata");
  const rpc = createSolanaRpc(devnet(rpcUrl));

  const results = {};
  for (const variant of ["classic", "token2022"]) {
    const programId = variant === "classic" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
    const mint = variant === "classic"
      ? await createMint(connection, payer, payer.publicKey, null, DECIMALS, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID)
      : await createToken2022Mint(connection, payer);
    const ata = await ensureAta(connection, payer, mint, programId);
    await mintTo(connection, payer, mint, ata, payer, quoteUnits, [], { commitment: "confirmed" }, programId);
    console.log(`[seed] ${variant} mint ${mint.toBase58()} supply ${quoteUnits}`);

    await wrapSol(connection, payer, poolLamports);

    // Orca orders the pair canonically; initialPrice is B per A, so it depends
    // on which side WSOL landed.
    const [mintA, mintB] = orderMints(address(NATIVE_MINT.toBase58()), address(mint.toBase58()));
    const wsolIsA = String(mintA) === NATIVE_MINT.toBase58();
    const initialPrice = wsolIsA ? priceUsd : 1 / priceUsd;

    // These builders return the instructions plus a callback that signs and
    // sends; without calling it nothing reaches the chain.
    // Splash pools need a 32768 fee tier, which this Orca deployment does not
    // have, so use a concentrated pool on a tier that exists.
    const pool = await createConcentratedLiquidityPool(mintA, mintB, tickSpacing, { initialPrice, funder, whirlpoolDeployment: WhirlpoolDeployment.devnet });
    const poolAddress = pool.poolAddress;
    const poolSignature = await pool.callback();
    console.log(`[seed] ${variant} pool ${String(poolAddress)} ${poolSignature}`);

    // Fund the side WSOL is on, so the pool holds the SOL a graduation swaps in
    // and our token on the other side.
    // Both sides are caps, not amounts: the SDK works out the split for a
    // full-range position and takes up to these.
    const tokenSide = quoteUnits / 2n;
    const position = await openFullRangePosition(
      poolAddress,
      wsolIsA
        ? { tokenMaxA: poolLamports, tokenMaxB: tokenSide }
        : { tokenMaxA: tokenSide, tokenMaxB: poolLamports },
      { funder, whirlpoolDeployment: WhirlpoolDeployment.devnet },
    );
    const positionSignature = await position.callback();
    console.log(`[seed] ${variant} position ${String(position.positionMint)} ${positionSignature}`);
    results[variant] = {
      mint: mint.toBase58(), pool: String(poolAddress), tokenProgram: programId.toBase58(),
      positionMint: String(position.positionMint), wsolIsTokenA: wsolIsA,
    };
  }

  const report = process.env.SEED_REPORT || "/tmp/mwz-devnet-quote-pools.json";
  fs.writeFileSync(report, JSON.stringify({ createdAt: new Date().toISOString(), cluster: isLocal ? "local-validator" : "devnet", priceUsd, poolSol, tickSpacing, ...results }, null, 2));
  console.log(`[seed] report=${report}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error?.message || error));
  process.exit(1);
});
