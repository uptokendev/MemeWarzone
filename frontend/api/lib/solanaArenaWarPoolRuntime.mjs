import crypto from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { connectionForArenaMoneyV2 } from "./solanaArenaMoneyV2Read.js";
import {
  ARENA_CONFIG_SEED,
  ARENA_POOL_SEED,
  ARENA_VAULT_SEED,
  REWARDS_TREASURY_PROGRAM_ID,
  parseArenaPool,
} from "../../src/lib/solanaArenaLayout.mjs";

/**
 * Solana war pool money path -- the generation battles and tournaments
 * actually run on (open_battle_pool_v2 / open_tournament_pool_v2 / ...).
 *
 * Boosts go through deposit_prize_boost_v2: the funder's transaction credits
 * the pool vault and the funder's own receipt, nothing else. The 90/10 split
 * is applied by the program at resolve, so a boost is verified on its gross
 * amount only. Same shape the launchpad's fee escrow taught us wallets accept.
 */

export const ARENA_WAR_POOL_PROGRAM_ID = REWARDS_TREASURY_PROGRAM_ID;
export const ARENA_BOOST_SEED = "arena_boost";
export const ARENA_KIND_BATTLE = 0;
export const ARENA_KIND_TOURNAMENT = 1;
export const ARENA_STATE_OPEN = 0;
export const ARENA_STATE_LIVE = 1;
export const BOOST_PRIZE_BPS = 9_000n;
export const BOOST_PROTOCOL_BPS = 1_000n;
const BPS = 10_000n;

// sha256("account:ArenaBoostReceipt")[..8]
export const ARENA_BOOST_RECEIPT_DISCRIMINATOR = crypto.createHash("sha256").update("account:ArenaBoostReceipt").digest().subarray(0, 8);
export const ARENA_BOOST_RECEIPT_SIZE = 8 + 32 + 32 + 32 + 8 + 1 + 1;

function exactId32(value, label) {
  const normalized = String(value || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be bytes32 hex`);
  return normalized;
}
function idBuffer(value, label) {
  return Buffer.from(exactId32(value, label), "hex");
}
function u64le(value) {
  const n = BigInt(String(value));
  if (n <= 0n || n > 0xffffffffffffffffn) throw new Error("amount must be a positive u64");
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(n);
  return out;
}
function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function programId() {
  return new PublicKey(ARENA_WAR_POOL_PROGRAM_ID);
}
function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, programId())[0];
}
function account(pubkey, isSigner, isWritable) {
  return { pubkey: String(pubkey), isSigner, isWritable };
}

export function splitWarPoolBoost(grossLamports) {
  const gross = BigInt(String(grossLamports));
  if (gross <= 0n) throw new Error("boost gross must be positive");
  const protocol = (gross * BOOST_PROTOCOL_BPS) / BPS;
  return { gross, prize: gross - protocol, protocol };
}

export function deriveArenaWarPoolPdas(poolIdHex) {
  const id = idBuffer(poolIdHex, "poolId");
  return {
    config: pda([Buffer.from(ARENA_CONFIG_SEED)]),
    pool: pda([Buffer.from(ARENA_POOL_SEED), id]),
    vault: pda([Buffer.from(ARENA_VAULT_SEED), id]),
  };
}

export function deriveArenaBoostReceiptPda(poolIdHex, fundingIdHex, funder) {
  return pda([
    Buffer.from(ARENA_BOOST_SEED),
    idBuffer(poolIdHex, "poolId"),
    idBuffer(fundingIdHex, "fundingId"),
    new PublicKey(funder).toBuffer(),
  ]);
}

/** deposit_prize_boost_v2: funder, arena_config, pool, vault, boost_receipt, system_program. */
export function buildSolanaBoostInstructionRequirements({ poolId, competitionId, fundingId, wallet, grossLamports }) {
  const id = poolId ?? competitionId;
  const pdas = deriveArenaWarPoolPdas(id);
  const receipt = deriveArenaBoostReceiptPda(id, fundingId, wallet);
  const data = Buffer.concat([
    discriminator("deposit_prize_boost_v2"),
    idBuffer(id, "poolId"),
    idBuffer(fundingId, "fundingId"),
    u64le(grossLamports),
  ]);
  return {
    programId: ARENA_WAR_POOL_PROGRAM_ID,
    instruction: "deposit_prize_boost_v2",
    dataBase64: data.toString("base64"),
    accounts: [
      account(wallet, true, true),
      account(pdas.config.toBase58(), false, false),
      account(pdas.pool.toBase58(), false, true),
      account(pdas.vault.toBase58(), false, true),
      account(receipt.toBase58(), false, true),
      account(SystemProgram.programId.toBase58(), false, false),
    ],
    configPda: pdas.config.toBase58(),
    poolPda: pdas.pool.toBase58(),
    vaultPda: pdas.vault.toBase58(),
    receiptPda: receipt.toBase58(),
  };
}

export function parseArenaBoostReceipt(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < ARENA_BOOST_RECEIPT_SIZE) return null;
  if (!buf.subarray(0, 8).equals(ARENA_BOOST_RECEIPT_DISCRIMINATOR)) return null;
  return {
    poolId: buf.subarray(8, 40).toString("hex"),
    fundingId: buf.subarray(40, 72).toString("hex"),
    funder: new PublicKey(buf.subarray(72, 104)).toBase58(),
    amountLamports: buf.readBigUInt64LE(104),
    refunded: buf[112] === 1,
    bump: buf[113],
  };
}

export async function readArenaWarPool(chainId, poolIdHex) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, opened: false, live: false, reason: "rpc-missing" };
  const pdas = deriveArenaWarPoolPdas(poolIdHex);
  const info = await connection.getAccountInfo(pdas.pool, "confirmed");
  if (!info) return { ok: false, opened: false, live: false, reason: "pool-missing", pda: pdas.pool.toBase58() };
  if (info.owner.toBase58() !== ARENA_WAR_POOL_PROGRAM_ID) return { ok: false, opened: true, live: false, reason: "pool-owner-mismatch", pda: pdas.pool.toBase58() };
  let pool;
  try {
    pool = parseArenaPool(info.data, PublicKey);
  } catch (error) {
    return { ok: false, opened: true, live: false, reason: `pool-unparsable:${error?.message || error}`, pda: pdas.pool.toBase58() };
  }
  const state = Number(pool?.state);
  return {
    ok: true,
    opened: true,
    live: state === ARENA_STATE_OPEN || state === ARENA_STATE_LIVE,
    pool,
    pda: pdas.pool.toBase58(),
    vaultPda: pdas.vault.toBase58(),
  };
}

export async function readArenaBoostReceipt(chainId, expected) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const receiptPda = deriveArenaBoostReceiptPda(expected.poolId ?? expected.competitionId, expected.fundingId, expected.funder);
  const info = await connection.getAccountInfo(receiptPda, "confirmed");
  if (!info) return { ok: false, reason: "receipt-missing", pda: receiptPda.toBase58() };
  if (info.owner.toBase58() !== ARENA_WAR_POOL_PROGRAM_ID) return { ok: false, reason: "receipt-owner-mismatch", pda: receiptPda.toBase58() };
  const receipt = parseArenaBoostReceipt(info.data);
  if (!receipt) return { ok: false, reason: "receipt-unparsable", pda: receiptPda.toBase58() };
  const id = exactId32(expected.poolId ?? expected.competitionId, "poolId");
  if (receipt.poolId !== id) return { ok: false, reason: "receipt-pool-mismatch", pda: receiptPda.toBase58() };
  if (receipt.fundingId !== exactId32(expected.fundingId, "fundingId")) return { ok: false, reason: "receipt-funding-mismatch", pda: receiptPda.toBase58() };
  if (receipt.funder !== new PublicKey(expected.funder).toBase58()) return { ok: false, reason: "receipt-funder-mismatch", pda: receiptPda.toBase58() };
  if (receipt.amountLamports !== BigInt(String(expected.grossLamports))) return { ok: false, reason: "receipt-amount-mismatch", pda: receiptPda.toBase58() };
  if (receipt.refunded) return { ok: false, reason: "receipt-refunded", pda: receiptPda.toBase58() };
  return { ok: true, pda: receiptPda.toBase58(), receipt };
}

export async function verifyConfirmedSolanaSignature(chainId, signature) {
  const sig = String(signature || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(sig)) throw new Error("invalid Solana transaction signature");
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) throw new Error("Solana Arena RPC is unavailable");
  const result = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
  const status = result?.value?.[0];
  if (!status || status.err) throw new Error("Solana transaction is missing or failed");
  if (!status.confirmationStatus || !["confirmed", "finalized"].includes(status.confirmationStatus)) throw new Error("Solana transaction is not confirmed");
  let blockTime = null;
  try {
    blockTime = await connection.getBlockTime(status.slot);
  } catch {
    blockTime = null;
  }
  return { signature: sig, slot: status.slot, confirmationStatus: status.confirmationStatus, blockTime };
}

/**
 * A boost is proven by the war-pool receipt the program created for exactly
 * this pool, funding id, funder and gross amount. The prize/protocol split is
 * the program's at resolve; nothing about it is recorded on the receipt.
 */
export async function verifySolanaBoostPayment({ chainId, signature, poolId, competitionId, fundingId, funder, grossLamports }) {
  const tx = await verifyConfirmedSolanaSignature(chainId, signature);
  const receipt = await readArenaBoostReceipt(chainId, { poolId: poolId ?? competitionId, fundingId, funder, grossLamports });
  if (!receipt.ok) throw new Error(`ArenaBoostReceipt verification failed: ${receipt.reason}`);
  return {
    ...tx,
    receiptPda: receipt.pda,
    receipt: { ...receipt.receipt, createdAt: tx.blockTime ?? Math.floor(Date.now() / 1000) },
    split: splitWarPoolBoost(grossLamports),
  };
}
