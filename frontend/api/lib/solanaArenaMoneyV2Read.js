import { Connection, PublicKey } from "@solana/web3.js";

import {
  ARENA_MONEY_CONFIG_SEED_V2,
  ARENA_MONEY_V2_PROGRAM_ID,
  BOOST_RECEIPT_SEED_V2,
  COMPETITION_ENTRY_RECEIPT_SEED_V2,
  COMPETITION_POOL_SEED_V2,
  EVENT_PRIZE_VAULT_SEED_V1,
  LEAGUE_SOURCE_RECEIPT_SEED_V2,
  POSTGRAD_LEAGUE_TREASURY_SEED_V2,
  SPONSORSHIP_EVENT_SEED_V1,
  SPONSORSHIP_RECEIPT_SEED_V1,
  parseArenaMoneyConfigV2,
  parseCompetitionPoolV2,
  verifyBoostReceiptV2,
  verifyCompetitionEntryReceiptV2,
  verifyEventPrizeVaultV1,
  verifyLeagueSourceReceiptV2,
  verifyPostGradLeagueTreasuryV2,
  verifySponsorshipEventV1,
  verifySponsorshipReceiptV1,
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
  ).split(",").map((item) => item.trim()).find(Boolean) || "";
}

export function connectionForArenaMoneyV2(chainId) {
  const url = rpcUrl(chainId);
  return url ? new Connection(url, "confirmed") : null;
}

function programId() { return new PublicKey(ARENA_MONEY_V2_PROGRAM_ID); }
function idBytes(hex) { return Buffer.from(poolIdToBytes(hex)); }
function pda(seeds) { return PublicKey.findProgramAddressSync(seeds, programId())[0]; }

export function deriveArenaMoneyConfigV2Pda() { return pda([Buffer.from(ARENA_MONEY_CONFIG_SEED_V2)]); }
export function deriveCompetitionPoolV2Pda(competitionIdHex) { return pda([Buffer.from(COMPETITION_POOL_SEED_V2), idBytes(competitionIdHex)]); }
export function deriveCompetitionEntryReceiptV2Pda(competitionIdHex, entryAsset, entrant) {
  return pda([Buffer.from(COMPETITION_ENTRY_RECEIPT_SEED_V2), idBytes(competitionIdHex), new PublicKey(entryAsset).toBuffer(), new PublicKey(entrant).toBuffer()]);
}
export function deriveBoostReceiptV2Pda(competitionIdHex, fundingIdHex, funder) {
  return pda([Buffer.from(BOOST_RECEIPT_SEED_V2), idBytes(competitionIdHex), idBytes(fundingIdHex), new PublicKey(funder).toBuffer()]);
}
export function derivePostGradLeagueTreasuryV2Pda() { return pda([Buffer.from(POSTGRAD_LEAGUE_TREASURY_SEED_V2)]); }
export function deriveLeagueSourceReceiptV2Pda(sourceIdHex) { return pda([Buffer.from(LEAGUE_SOURCE_RECEIPT_SEED_V2), idBytes(sourceIdHex)]); }
export function deriveSponsorshipEventV1Pda(eventIdHex) { return pda([Buffer.from(SPONSORSHIP_EVENT_SEED_V1), idBytes(eventIdHex)]); }
export function deriveEventPrizeVaultV1Pda(eventIdHex) { return pda([Buffer.from(EVENT_PRIZE_VAULT_SEED_V1), idBytes(eventIdHex)]); }
export function deriveSponsorshipReceiptV1Pda(eventIdHex, paymentIdHex, sponsor) {
  return pda([Buffer.from(SPONSORSHIP_RECEIPT_SEED_V1), idBytes(eventIdHex), idBytes(paymentIdHex), new PublicKey(sponsor).toBuffer()]);
}

async function accountAt(connection, address) {
  const account = await connection.getAccountInfo(address, "confirmed");
  return { account, owner: account?.owner?.toBase58?.() || "", accountAddress: address.toBase58() };
}

export async function probeArenaMoneyV2(chainId) {
  const id = Number(chainId);
  if (!isSolanaWarzoneChainId(id)) return { configured: false, live: false, reason: "not-solana" };
  const connection = connectionForArenaMoneyV2(id);
  if (!connection) return { configured: false, live: false, reason: "rpc-missing" };
  const configPda = deriveArenaMoneyConfigV2Pda();
  try {
    const { account, owner } = await accountAt(connection, configPda);
    if (!account?.data) return { configured: true, live: false, reason: "config-missing", configPda: configPda.toBase58() };
    if (owner !== ARENA_MONEY_V2_PROGRAM_ID) return { configured: true, live: false, reason: "wrong-owner", configPda: configPda.toBase58() };
    const config = parseArenaMoneyConfigV2(Uint8Array.from(account.data), PublicKey);
    if (!config) return { configured: true, live: false, reason: "bad-config-layout", configPda: configPda.toBase58() };
    if (config.paused) return { configured: true, live: false, reason: "paused", configPda: configPda.toBase58(), config };
    return { configured: true, live: true, reason: "ok", configPda: configPda.toBase58(), config };
  } catch (error) {
    return { configured: true, live: false, reason: "rpc-error", error: String(error?.message || error), configPda: configPda.toBase58() };
  }
}

export async function readCompetitionPoolV2(chainId, competitionIdHex) {
  const probe = await probeArenaMoneyV2(chainId);
  const poolPda = deriveCompetitionPoolV2Pda(competitionIdHex);
  if (!probe.live) return { ...probe, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false };
  const connection = connectionForArenaMoneyV2(chainId);
  try {
    const { account, owner } = await accountAt(connection, poolPda);
    if (!account?.data) return { ...probe, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false, reason: "pool-missing" };
    if (owner !== ARENA_MONEY_V2_PROGRAM_ID) return { ...probe, live: false, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false, reason: "pool-wrong-owner" };
    const pool = parseCompetitionPoolV2(Uint8Array.from(account.data), PublicKey);
    if (!pool || pool.competitionId !== String(competitionIdHex).replace(/^0x/i, "").toLowerCase()) return { ...probe, live: false, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false, reason: "bad-pool-layout-or-generation" };
    return { ...probe, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: true, pool };
  } catch (error) {
    return { ...probe, live: false, competitionId: competitionIdHex, poolPda: poolPda.toBase58(), opened: false, reason: "rpc-error", error: String(error?.message || error) };
  }
}

export async function readCompetitionEntryReceiptV2(chainId, competitionIdHex, entryAsset, entrant, expectedAmountLamports) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const receiptPda = deriveCompetitionEntryReceiptV2Pda(competitionIdHex, entryAsset, entrant);
  const identity = await accountAt(connection, receiptPda);
  const verified = verifyCompetitionEntryReceiptV2({ ...identity, expectedPda: receiptPda.toBase58(), expectedCompetitionId: competitionIdHex, expectedEntrant: entrant, expectedEntryAsset: entryAsset, expectedAmountLamports, PublicKey });
  return { ...verified, pda: receiptPda.toBase58() };
}

export async function readBoostReceiptV2(chainId, expected) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const receiptPda = deriveBoostReceiptV2Pda(expected.competitionId, expected.fundingId, expected.funder);
  const identity = await accountAt(connection, receiptPda);
  return { ...verifyBoostReceiptV2({ ...identity, expectedPda: receiptPda.toBase58(), expectedCompetitionId: expected.competitionId, expectedFundingId: expected.fundingId, expectedFunder: expected.funder, expectedGrossLamports: expected.grossLamports, expectedPrizeLamports: expected.prizeLamports, expectedProtocolLamports: expected.protocolLamports, PublicKey }), pda: receiptPda.toBase58() };
}

export async function readPostGradLeagueTreasuryV2(chainId) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const treasuryPda = derivePostGradLeagueTreasuryV2Pda();
  const identity = await accountAt(connection, treasuryPda);
  return { ...verifyPostGradLeagueTreasuryV2({ ...identity, expectedPda: treasuryPda.toBase58(), PublicKey }), pda: treasuryPda.toBase58() };
}

export async function readLeagueSourceReceiptV2(chainId, sourceId, expectedAmountLamports = null) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const receiptPda = deriveLeagueSourceReceiptV2Pda(sourceId);
  const identity = await accountAt(connection, receiptPda);
  return { ...verifyLeagueSourceReceiptV2({ ...identity, expectedPda: receiptPda.toBase58(), expectedSourceId: sourceId, expectedAmountLamports }), pda: receiptPda.toBase58() };
}

export async function readSponsorshipEventV1(chainId, eventId) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const eventPda = deriveSponsorshipEventV1Pda(eventId);
  const identity = await accountAt(connection, eventPda);
  return { ...verifySponsorshipEventV1({ ...identity, expectedPda: eventPda.toBase58(), expectedEventId: eventId, PublicKey }), pda: eventPda.toBase58() };
}

export async function readEventPrizeVaultV1(chainId, eventId) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const vaultPda = deriveEventPrizeVaultV1Pda(eventId);
  const identity = await accountAt(connection, vaultPda);
  return { ...verifyEventPrizeVaultV1({ ...identity, expectedPda: vaultPda.toBase58(), expectedEventId: eventId }), pda: vaultPda.toBase58() };
}

export async function readSponsorshipReceiptV1(chainId, expected) {
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) return { ok: false, reason: "rpc-missing" };
  const receiptPda = deriveSponsorshipReceiptV1Pda(expected.eventId, expected.paymentId, expected.sponsor);
  const identity = await accountAt(connection, receiptPda);
  return { ...verifySponsorshipReceiptV1({ ...identity, expectedPda: receiptPda.toBase58(), expectedEventId: expected.eventId, expectedPaymentId: expected.paymentId, expectedSponsor: expected.sponsor, expectedGrossLamports: expected.grossLamports, expectedPrizeLamports: expected.prizeLamports, expectedMarketingLamports: expected.marketingLamports, expectedProtocolLamports: expected.protocolLamports, PublicKey }), pda: receiptPda.toBase58() };
}
