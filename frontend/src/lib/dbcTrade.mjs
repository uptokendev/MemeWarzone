/**
 * DBC bonding-curve quote and swap. Modeled on solanaMeteoraTrade.ts and dbcCreateIntent.mjs.
 * A legacy Transaction is simulated with no config object (web3.js 1.x).
 */
import BN from "bn.js";
import { PublicKey, Transaction } from "@solana/web3.js";

import {
  DynamicBondingCurveClient,
  SwapMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DBC_JUPITER_LOCK_PROGRAM_ID, DBC_PROGRAM_ID } from "../../shared/dbcEconomics.mjs";
import { WSOL_MINT } from "../../shared/dbcQuotes.mjs";
import { antiSniperFeeBps } from "../../shared/dbcAntiSniper.mjs";
import { lockAmountDivisible } from "../../shared/dbcLockSchedule.mjs";
import {
  DBC_ASSOCIATED_TOKEN_PROGRAM_ID,
  DBC_COMPUTE_BUDGET_PROGRAM_ID,
  DBC_SYSTEM_PROGRAM_ID,
  DBC_TOKEN_PROGRAM_ID,
} from "./dbcCreateIntent.mjs";

export const DBC_TRADE_SLIPPAGE_PCT = 5;
export { DBC_JUPITER_LOCK_PROGRAM_ID, lockAmountDivisible };

export const DBC_TRADE_ALLOWED_PROGRAM_IDS = new Set([
  DBC_PROGRAM_ID,
  DBC_SYSTEM_PROGRAM_ID,
  DBC_TOKEN_PROGRAM_ID,
  DBC_ASSOCIATED_TOKEN_PROGRAM_ID,
  DBC_COMPUTE_BUDGET_PROGRAM_ID,
]);

export const DBC_LOCKED_BUY_ALLOWED_PROGRAM_IDS = new Set([
  ...DBC_TRADE_ALLOWED_PROGRAM_IDS,
  DBC_JUPITER_LOCK_PROGRAM_ID,
]);

function keyOf(value) {
  if (!value) return "";
  if (typeof value.toBase58 === "function") return value.toBase58();
  return String(value);
}

function referencedAddresses(tx) {
  const out = new Set();
  if (tx.feePayer) out.add(keyOf(tx.feePayer));
  for (const ix of tx.instructions || []) {
    out.add(keyOf(ix.programId));
    for (const account of ix.keys || []) out.add(keyOf(account.pubkey));
  }
  return out;
}

export function assertDbcTradeIntent(tx, { trader, pool, allowLock = false, requirePool = true, extraPrograms = [] }) {
  const feePayer = keyOf(tx.feePayer);
  if (!feePayer || feePayer !== String(trader)) {
    throw new Error("DBC trade fee payer is not the trader.");
  }
  const allowed = new Set(allowLock ? DBC_LOCKED_BUY_ALLOWED_PROGRAM_IDS : DBC_TRADE_ALLOWED_PROGRAM_IDS);
  for (const programId of extraPrograms || []) allowed.add(String(programId));
  const instructions = tx.instructions || [];
  if (!instructions.length) throw new Error("DBC trade transaction has no instructions.");
  for (const ix of instructions) {
    const programId = keyOf(ix.programId);
    if (!allowed.has(programId)) {
      throw new Error(`Unexpected program in DBC trade: ${programId}`);
    }
  }
  if (requirePool && pool && !referencedAddresses(tx).has(String(pool))) {
    throw new Error("DBC trade is missing the pool account.");
  }
}

const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

export async function prepareDbcTradeTransaction(connection, tx, expected) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const blockhash = String(latest?.blockhash || "");
  const lastValidBlockHeight = Number(latest?.lastValidBlockHeight);
  if (!blockhash || blockhash === PLACEHOLDER_BLOCKHASH) {
    throw new Error("RPC did not return a fresh blockhash.");
  }
  if (!Number.isFinite(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    throw new Error("RPC did not return lastValidBlockHeight.");
  }
  tx.recentBlockhash = blockhash;
  assertDbcTradeIntent(tx, expected);
  const simulation = await connection.simulateTransaction(tx);
  if (simulation?.value?.err) {
    throw new Error(`DBC trade simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  return { tx, blockhash, lastValidBlockHeight };
}

export async function submitPreparedDbcTrade({
  connection,
  transaction,
  trader,
  pool,
  allowLock = false,
  requirePool = true,
  extraPrograms = [],
  extraSigners = [],
  signTransaction,
}) {
  const prepared = await prepareDbcTradeTransaction(connection, transaction, {
    trader,
    pool,
    allowLock,
    requirePool,
    extraPrograms,
  });
  for (const signer of extraSigners) prepared.tx.partialSign(signer);
  const signed = await signTransaction(prepared.tx);
  const raw = typeof signed?.serialize === "function" ? signed.serialize() : signed;
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value?.err) {
    throw new Error(`DBC trade failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return {
    signature,
    blockhash: prepared.blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    serializedBytes: raw.length,
    signerCount: prepared.tx.compileMessage().header.numRequiredSignatures,
  };
}

export function resolveReferralTokenAccount(env = typeof process !== "undefined" ? process.env : {}, quoteMint = WSOL_MINT) {
  const mapRaw = String(
    env.DBC_REFERRAL_TOKEN_ACCOUNTS
      || (typeof import.meta !== "undefined" ? import.meta.env?.VITE_DBC_REFERRAL_TOKEN_ACCOUNTS : "")
      || "",
  ).trim();
  if (mapRaw) {
    try {
      const map = JSON.parse(mapRaw);
      const hit = map[String(quoteMint || WSOL_MINT)];
      if (hit) return String(hit);
    } catch {
      // fall through to the SOL account
    }
  }
  const raw = String(
    env.DBC_REFERRAL_TOKEN_ACCOUNT
      || (typeof import.meta !== "undefined" ? import.meta.env?.VITE_DBC_REFERRAL_TOKEN_ACCOUNT : "")
      || "",
  ).trim();
  if (raw && String(quoteMint || WSOL_MINT) !== WSOL_MINT) return null;
  return raw || null;
}

export async function loadReferralTokenAccount(connection, env, quoteMint = WSOL_MINT) {
  const address = resolveReferralTokenAccount(env, quoteMint);
  if (!address) {
    console.warn("[dbc-trade] referral token account is not configured; trading without referral");
    return null;
  }
  try {
    const info = await connection.getAccountInfo(new PublicKey(address), "confirmed");
    if (!info) {
      console.warn("[dbc-trade] referral token account missing on chain; trading without referral");
      return null;
    }
    const mint = new PublicKey(info.data.slice(0, 32));
    const want = new PublicKey(quoteMint || WSOL_MINT);
    if (!mint.equals(want)) {
      console.warn("[dbc-trade] referral token account mint does not match the quote; trading without referral");
      return null;
    }
    return new PublicKey(address);
  } catch (error) {
    console.warn("[dbc-trade] referral token account unreadable; trading without referral", error);
    return null;
  }
}

export function applySlippageMinOut(amountOut, pct = DBC_TRADE_SLIPPAGE_PCT) {
  return (BigInt(amountOut) * BigInt(100 - pct)) / 100n;
}

export function applySlippageMaxIn(amountIn, pct = DBC_TRADE_SLIPPAGE_PCT) {
  return (BigInt(amountIn) * BigInt(100 + pct)) / 100n;
}

export async function loadDbcPool(connection, poolAddress) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const poolPk = new PublicKey(poolAddress);
  const poolWrap = await client.state.getPool(poolPk);
  const pool = poolWrap?.poolState ?? poolWrap;
  if (!pool) throw new Error("DBC pool is not on chain.");
  const configPk = pool.config instanceof PublicKey ? pool.config : new PublicKey(String(pool.config));
  const configWrap = await client.state.getPoolConfig(configPk);
  const config = configWrap?.poolConfig ?? configWrap;
  if (!config) throw new Error("DBC pool config is not on chain.");
  const activation = Number(pool.activationPoint?.toString?.() || pool.activation_point || 0);
  const now = Math.floor(Date.now() / 1000);
  return { client, poolPk, pool, configPk, config, activationUnix: activation, nowUnix: now };
}

export function quoteDbcExactIn({
  client,
  pool,
  config,
  side,
  amountIn,
  hasReferral,
  nowUnix,
  activationUnix,
}) {
  const currentPoint = new BN(String(nowUnix));
  const swapBaseForQuote = side === "sell";
  // SDK 1.5.13: state.getPool returns { poolState } and swapQuote2 reads virtualPool.poolState.*
  // (other calls want the unwrapped pool). Pass the wrapped form whatever the caller holds.
  const quote = client.pool.swapQuote2({
    virtualPool: pool?.poolState ? pool : { poolState: pool },
    config,
    swapBaseForQuote,
    hasReferral: Boolean(hasReferral),
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps: DBC_TRADE_SLIPPAGE_PCT * 100,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(amountIn.toString()),
  });
  const amountOut = BigInt(quote.outputAmount?.toString?.() || quote.amountOut?.toString?.() || "0");
  const tradingFee = BigInt(quote.tradingFee?.toString?.() || "0");
  const elapsed = Number(nowUnix) - Number(activationUnix || 0);
  return {
    side,
    amountIn: BigInt(amountIn),
    amountOut,
    minimumAmountOut: applySlippageMinOut(amountOut),
    tradingFee,
    feeBps: antiSniperFeeBps(elapsed),
    elapsedSeconds: elapsed,
  };
}

export function quoteDbcExactOut({
  client,
  pool,
  config,
  amountOut,
  hasReferral,
  nowUnix,
  activationUnix,
}) {
  const currentPoint = new BN(String(nowUnix));
  // SDK 1.5.13: state.getPool returns { poolState } and swapQuote2 reads virtualPool.poolState.*
  // (other calls want the unwrapped pool). Pass the wrapped form whatever the caller holds.
  const quote = client.pool.swapQuote2({
    virtualPool: pool?.poolState ? pool : { poolState: pool },
    config,
    swapBaseForQuote: false,
    hasReferral: Boolean(hasReferral),
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
    slippageBps: DBC_TRADE_SLIPPAGE_PCT * 100,
    swapMode: SwapMode.ExactOut,
    amountOut: new BN(amountOut.toString()),
  });
  const amountIn = BigInt(quote.includedFeeInputAmount?.toString?.() || quote.amountIn?.toString?.() || "0");
  const elapsed = Number(nowUnix) - Number(activationUnix || 0);
  return {
    side: "buy",
    amountIn,
    amountOut: BigInt(amountOut),
    maximumAmountIn: applySlippageMaxIn(amountIn),
    feeBps: antiSniperFeeBps(elapsed),
    elapsedSeconds: elapsed,
  };
}

export async function buildDbcSwapTransaction({
  connection,
  poolAddress,
  trader,
  side,
  amountIn,
  env,
}) {
  const loaded = await loadDbcPool(connection, poolAddress);
  const quoteMint = keyOf(loaded.config?.quoteMint) || WSOL_MINT;
  const referral = await loadReferralTokenAccount(connection, env, quoteMint);
  const quoted = quoteDbcExactIn({
    client: loaded.client,
    pool: loaded.pool,
    config: loaded.config,
    side,
    amountIn,
    hasReferral: Boolean(referral),
    nowUnix: loaded.nowUnix,
    activationUnix: loaded.activationUnix,
  });
  const tx = await loaded.client.pool.swap2({
    owner: new PublicKey(trader),
    pool: loaded.poolPk,
    swapBaseForQuote: side === "sell",
    referralTokenAccount: referral,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(quoted.minimumAmountOut.toString()),
  });
  tx.feePayer = new PublicKey(trader);
  return { tx, quoted, referral: referral ? referral.toBase58() : null, loaded };
}
