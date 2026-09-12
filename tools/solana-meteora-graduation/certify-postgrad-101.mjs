#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { CpAmm, deriveCustomizablePoolAddress } from "@meteora-ag/cp-amm-sdk";

const { BN } = anchor;
const EXPECTED_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const REPORT = process.env.SOLANA_POSTGRAD_CANARY_REPORT || "/tmp/mwz-solana-101-postgrad.json";
const BUY_LAMPORTS = BigInt(process.env.SOLANA_POSTGRAD_BUY_LAMPORTS || "1000000");
const SLIPPAGE = Number(process.env.SOLANA_POSTGRAD_SLIPPAGE_PCT || "1");

function fail(message) { throw new Error(`[solana-101-postgrad] ${message}`); }
function required(name) { const value = String(process.env[name] || "").trim(); if (!value) fail(`${name} is required`); return value; }
function loadKeypair(file) { const value = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(value) || value.length !== 64) fail(`invalid keypair ${file}`); return Keypair.fromSecretKey(Uint8Array.from(value)); }
function collectKeys(instructions) {
  const out = [];
  const seen = new Set();
  for (const ix of instructions) {
    for (const key of [ix.programId, ...(ix.keys || []).map((entry) => entry.pubkey)]) {
      const text = key.toBase58();
      if (!seen.has(text)) { seen.add(text); out.push(key); }
    }
  }
  return out;
}
async function sendLegacy(connection, payer, instructions) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) fail(`ALT control failed ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}
async function createAlt(connection, payer, addresses) {
  const slot = await connection.getSlot("confirmed");
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: Math.max(0, slot - 1) });
  await sendLegacy(connection, payer, [createIx]);
  const unique = [...new Map(addresses.map((key) => [key.toBase58(), key])).values()];
  for (let index = 0; index < unique.length; index += 20) {
    await sendLegacy(connection, payer, [AddressLookupTableProgram.extendLookupTable({ authority: payer.publicKey, payer: payer.publicKey, lookupTable: address, addresses: unique.slice(index, index + 20) })]);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const table = (await connection.getAddressLookupTable(address, { commitment: "confirmed" })).value;
    const current = await connection.getSlot("confirmed");
    if (table && current > Number(table.state.lastExtendedSlot || 0)) return table;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`post-grad ALT ${address.toBase58()} did not activate`);
}
async function builderTransaction(built) {
  if (typeof built?.transaction === "function") return built.transaction();
  if (typeof built?.build === "function") return built.build();
  if (built?.instructions) return new Transaction().add(...built.instructions);
  return built;
}
async function quote(cpAmm, connection, poolState, inputMint, amountIn, launchDecimals) {
  const slot = await connection.getSlot("confirmed");
  const blockTime = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  return cpAmm.getQuote({
    inAmount: new BN(amountIn.toString()),
    inputTokenMint: inputMint,
    slippage: SLIPPAGE,
    poolState,
    currentTime: blockTime,
    currentSlot: slot,
    tokenADecimal: poolState.tokenAMint.equals(NATIVE_MINT) ? 9 : launchDecimals,
    tokenBDecimal: poolState.tokenBMint.equals(NATIVE_MINT) ? 9 : launchDecimals,
    hasReferral: false,
  });
}
async function buildSwap(cpAmm, pool, poolState, payer, inputMint, outputMint, amountIn, minimumAmountOut) {
  return builderTransaction(await cpAmm.swap({
    payer: payer.publicKey,
    pool,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(minimumAmountOut.toString()),
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
    poolState,
  }));
}
async function sendV0(connection, payer, legacyTx, lookupTable, label) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: latest.blockhash, instructions: legacyTx.instructions }).compileToV0Message([lookupTable]);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const simulation = await connection.simulateTransaction(tx, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });
  if (simulation.value.err) fail(`${label} simulation failed ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs || []).join(" | ")}`);
  const raw = tx.serialize();
  if (raw.length > 1232) fail(`${label} V0 packet exceeds 1232 bytes (${raw.length})`);
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) fail(`${label} confirmation failed ${JSON.stringify(confirmation.value.err)}`);
  const retrySignature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  if (retrySignature !== signature) fail(`${label} same-packet retry changed signature`);
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err) fail(`${label} reconciliation could not prove successful landed transaction`);
  return { signature, version: "V0", alt: lookupTable.key.toBase58(), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, retry: "same-packet-deduped", reconciliation: status.confirmationStatus || "confirmed", packetBytes: raw.length, simulationUnits: simulation.value.unitsConsumed ?? null };
}

async function main() {
  if (required("SOLANA_APPLICATION_CHAIN_ID") !== "101") fail("canonical post-grad certification requires application chain 101");
  const connection = new Connection(required("SOLANA_RPC_URL"), "confirmed");
  if ((await connection.getGenesisHash()) !== EXPECTED_GENESIS) fail("refusing to certify outside Solana devnet");
  const payer = loadKeypair(required("SOLANA_GRADUATION_OPERATOR_KEYPAIR"));
  const mint = new PublicKey(required("SOLANA_POSTGRAD_MINT"));
  const mintState = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  const launchDecimals = Number(mintState.decimals);
  const expectedPoolRaw = String(process.env.SOLANA_POSTGRAD_POOL || "").trim();
  const pool = deriveCustomizablePoolAddress(mint, NATIVE_MINT);
  if (expectedPoolRaw && !pool.equals(new PublicKey(expectedPoolRaw))) fail(`graduation pool mismatch expected=${expectedPoolRaw} derived=${pool}`);
  const cpAmm = new CpAmm(connection);
  let poolState = await cpAmm.fetchPoolState(pool);
  const pairOk = (poolState.tokenAMint.equals(mint) && poolState.tokenBMint.equals(NATIVE_MINT)) || (poolState.tokenBMint.equals(mint) && poolState.tokenAMint.equals(NATIVE_MINT));
  if (!pairOk) fail("graduated Meteora pool is not launch-token/WSOL");

  const buyQuote = await quote(cpAmm, connection, poolState, NATIVE_MINT, BUY_LAMPORTS, launchDecimals);
  const buyTx = await buildSwap(cpAmm, pool, poolState, payer, NATIVE_MINT, mint, BUY_LAMPORTS, BigInt(buyQuote.minSwapOutAmount.toString()));
  const staticKeys = [SystemProgram.programId, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, pool, mint, NATIVE_MINT, ...collectKeys(buyTx.instructions)];
  const alt = await createAlt(connection, payer, staticKeys);
  const beforeTokenAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  let beforeTokens = 0n;
  try { beforeTokens = BigInt((await getAccount(connection, beforeTokenAta, "confirmed")).amount.toString()); } catch {}
  const buy = await sendV0(connection, payer, buyTx, alt, "POST_GRAD_BUY");
  const afterBuy = BigInt((await getAccount(connection, beforeTokenAta, "confirmed")).amount.toString());
  const received = afterBuy - beforeTokens;
  if (received <= 1n) fail("post-grad BUY did not increase launch-token balance");

  poolState = await cpAmm.fetchPoolState(pool);
  const sellAmount = received / 2n;
  const sellQuote = await quote(cpAmm, connection, poolState, mint, sellAmount, launchDecimals);
  const sellTx = await buildSwap(cpAmm, pool, poolState, payer, mint, NATIVE_MINT, sellAmount, BigInt(sellQuote.minSwapOutAmount.toString()));
  const sell = await sendV0(connection, payer, sellTx, alt, "POST_GRAD_SELL");
  const afterSell = BigInt((await getAccount(connection, beforeTokenAta, "confirmed")).amount.toString());
  if (afterSell >= afterBuy) fail("post-grad SELL did not reduce launch-token balance");
  const reloaded = await cpAmm.fetchPoolState(pool);
  const fingerprint = crypto.createHash("sha256").update(Buffer.concat([reloaded.tokenAMint.toBuffer(), reloaded.tokenBMint.toBuffer(), reloaded.tokenAVault.toBuffer(), reloaded.tokenBVault.toBuffer()])).digest("hex");
  const report = { schemaVersion: 1, applicationChainId: 101, cluster: "devnet", mint: mint.toBase58(), launchDecimals, pool: pool.toBase58(), payer: payer.publicKey.toBase58(), buy, sell, beforeTokens: beforeTokens.toString(), afterBuyTokens: afterBuy.toString(), afterSellTokens: afterSell.toString(), reload: { status: "PASS", poolFingerprint: fingerprint } };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
