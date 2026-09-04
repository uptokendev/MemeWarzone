import { Connection, PublicKey } from "@solana/web3.js";

import {
  ARENA_MONEY_CONFIG_SEED_V2,
  ARENA_MONEY_V2_PROGRAM_ID,
  COMPETITION_ENTRY_RECEIPT_SEED_V2,
  COMPETITION_POOL_SEED_V2,
  parseArenaMoneyConfigV2,
  parseCompetitionPoolV2,
  verifyCompetitionEntryReceiptV2,
} from "../../src/lib/solanaArenaMoneyV2Layout.mjs";
import { isSolanaWarzoneChainId, poolIdToBytes } from "../../src/lib/solanaArenaLayout.mjs";

function env(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function rpcUrl(chainId) {
  const id = Number(chainId);
  return (
    env(`SOLANA_RPC_URL_${id}`, `SOLANA_RPC_HTTP_${id}`, `SOLANA_REWARDS_RPC_URL_${id}`) ||
    env("SOLANA_RPC_URL", "SOLANA_RPC_HTTP", "SOLANA_REWARDS_RPC_URL", "VITE_SOLANA_RPC")
  )
    .split(",")
    .map((item) => item.trim())
    .find(Boolean) || "";
}

function connectionFor(chainId) {
  const url = rpcUrl(chainId);
  return url ? new Connection(url, "confirmed") : null;
}

function programId() {
  return new PublicKey(ARENA_MONEY_V2_PROGRAM_ID);
}

export function deriveArenaMoneyConfigV2Pda() {
  return PublicKey.findProgramAddressSync([Buffer.from(ARENA_MONEY_CONFIG_SEED_V2)], programId())[0];
}

export function deriveCompetitionPoolV2Pda(competitionIdHex) {
  const id = Buffer.from(poolIdToBytes(competitionIdHex));
  return PublicKey.findProgramAddressSync([Buffer.from(COMPETITION_POOL_SEED_V2), id], programId())[0];
}

export function deriveCompetitionEntryReceiptV2Pda(competitionIdHex, entryAsset, entrant) {
  const id = Buffer.from(poolIdToBytes(competitionIdHex));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(COMPETITION_ENTRY_RECEIPT_SEED_V2),
      id,
      new PublicKey(entryAsset).toBuffer(),
      new PublicKey(entrant).toBuffer(),
    ],
    programId(),
  )[0];
}

export async function probeArenaMoneyV2(chainId) {
  const id = Number(chainId);
  if (!isSolanaWarzoneChainId(id)) return { configured: false, live: false, reason: "not-solana" };
  const connection = connectionFor(id);
  if (!connection) return { configured: false, live: false, reason: "rpc-missing" };
  const pda = deriveArenaMoneyConfigV2Pda();
  try {
    const account = await connection.getAccountInfo(pda, "confirmed");
    if (!account?.data) return { configured: true, live: false, reason: "config-missing", configPda: pda.toBase58() };
    if (account.owner.toBase58() !== ARENA_MONEY_V2_PROGRAM_ID) {
      return { configured: true, live: false, reason: "wrong-owner", configPda: pda.toBase58() };
    }
    const config = parseArenaMoneyConfigV2(Uint8Array.from(account.data), PublicKey);
    if (!config) return { configured: true, live: false, reason: "bad-config-layout", configPda: pda.toBase58() };
    if (config.paused) return { configured: true, live: false, reason: "paused", configPda: pda.toBase58(), config };
    return { configured: true, live: true, reason: "ok", configPda: pda.toBase58(), config };
  } catch (error) {
    return { configured: true, live: false, reason: "rpc-error", error: String(error?.message || error), configPda: pda.toBase58() };
  }
}

export async function readCompetitionPoolV2(chainId, competitionIdHex) {
  const probe = await probeArenaMoneyV2(chainId);
  const poolPda = deriveCompetitionPoolV2Pda(competitionIdHex);
  if (!probe.live) return { ...probe, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false };
  const connection = connectionFor(chainId);
  try {
    const account = await connection.getAccountInfo(poolPda, "confirmed");
    if (!account?.data) return { ...probe, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false, reason: "pool-missing" };
    if (account.owner.toBase58() !== ARENA_MONEY_V2_PROGRAM_ID) {
      return { ...probe, live: false, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false, reason: "pool-wrong-owner" };
    }
    const pool = parseCompetitionPoolV2(Uint8Array.from(account.data), PublicKey);
    if (!pool || pool.competitionId !== String(competitionIdHex).replace(/^0x/i, "").toLowerCase()) {
      return { ...probe, live: false, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false, reason: "bad-pool-layout-or-generation" };
    }
    return { ...probe, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: true, pool };
  } catch (error) {
    return { ...probe, live: false, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false, reason: "rpc-error", error: String(error?.message || error) };
  }
}

export async function readCompetitionEntryReceiptV2(chainId, competitionIdHex, entryAsset, entrant, expectedAmountLamports) {
  const connection = connectionFor(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const pda = deriveCompetitionEntryReceiptV2Pda(competitionIdHex, entryAsset, entrant);
  const account = await connection.getAccountInfo(pda, "confirmed");
  const verified = verifyCompetitionEntryReceiptV2({
    account,
    owner: account?.owner?.toBase58?.() || "",
    expectedCompetitionId: competitionIdHex,
    expectedEntrant: entrant,
    expectedEntryAsset: entryAsset,
    expectedAmountLamports,
    PublicKey,
  });
  return { ...verified, pda: pda.toBase58() };
}
