import crypto from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { unitPriceNativeRawFromUsdMicros } from "./arenaBoostQuote.mjs";
import {
  connectionForArenaMoneyV2,
  deriveArenaMoneyConfigV2Pda,
  deriveBoostReceiptV2Pda,
  deriveCompetitionPoolV2Pda,
  deriveEventPrizeVaultV1Pda,
  deriveSponsorshipEventV1Pda,
  deriveSponsorshipReceiptV1Pda,
  readBoostReceiptV2,
  readEventPrizeVaultV1,
  readSponsorshipReceiptV1,
} from "./solanaArenaMoneyV2Read.js";
import { ARENA_MONEY_V2_PROGRAM_ID } from "../../src/lib/solanaArenaMoneyV2Layout.mjs";

const SOLANA_NATIVE_DECIMALS = 9;
const BPS = 10_000n;
const BOOST_PROTOCOL_BPS = 1_000n;
const SPONSORSHIP_MARKETING_BPS = 2_000n;
const SPONSORSHIP_PROTOCOL_BPS = 1_000n;
const DEFAULT_PRICE_MAX_AGE_SECONDS = 300n;

function positiveBigInt(value, label) {
  try {
    const n = BigInt(String(value));
    if (n <= 0n) throw new Error(`${label} must be positive`);
    return n;
  } catch (error) {
    if (String(error?.message || "").includes("must be positive")) throw error;
    throw new Error(`${label} must be a positive integer`);
  }
}

function nonNegativeBigInt(value, label) {
  try {
    const n = BigInt(String(value));
    if (n < 0n) throw new Error(`${label} must be non-negative`);
    return n;
  } catch (error) {
    if (String(error?.message || "").includes("must be non-negative")) throw error;
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function exactId32(value, label) {
  const normalized = String(value || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be bytes32 hex`);
  return normalized;
}

function idBuffer(value, label) {
  return Buffer.from(exactId32(value, label), "hex");
}

function u64le(value) {
  const n = positiveBigInt(value, "u64");
  if (n > 0xffffffffffffffffn) throw new Error("u64 overflow");
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(n);
  return out;
}

function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function account(pubkey, isSigner, isWritable) {
  return { pubkey: String(pubkey), isSigner: Boolean(isSigner), isWritable: Boolean(isWritable) };
}

function transactionAccountKeys(tx) {
  const message = tx?.transaction?.message;
  const base = Array.isArray(message?.staticAccountKeys)
    ? message.staticAccountKeys
    : Array.isArray(message?.accountKeys)
      ? message.accountKeys
      : [];
  const loaded = tx?.meta?.loadedAddresses;
  return [
    ...base,
    ...(loaded?.writable || []),
    ...(loaded?.readonly || []),
  ].map((key) => key?.toBase58?.() || String(key || ""));
}

export function randomMoneyId32() {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

export function splitSolanaBoost(grossLamports) {
  const gross = positiveBigInt(grossLamports, "grossLamports");
  const protocol = (gross * BOOST_PROTOCOL_BPS) / BPS;
  return { gross, prize: gross - protocol, protocol };
}

export function splitSolanaSponsorship(grossLamports) {
  const gross = positiveBigInt(grossLamports, "grossLamports");
  const marketing = (gross * SPONSORSHIP_MARKETING_BPS) / BPS;
  const protocol = (gross * SPONSORSHIP_PROTOCOL_BPS) / BPS;
  return { gross, prize: gross - marketing - protocol, marketing, protocol };
}

export function sponsorshipVaultLifetimeTotals(vault) {
  if (!vault) throw new Error("EventPrizeVaultV1 state is required");
  return {
    prize: nonNegativeBigInt(vault.prizeLamports, "vault.prizeLamports") + nonNegativeBigInt(vault.prizeClaimedLamports, "vault.prizeClaimedLamports"),
    marketing: nonNegativeBigInt(vault.marketingLamports, "vault.marketingLamports") + nonNegativeBigInt(vault.marketingClaimedLamports, "vault.marketingClaimedLamports"),
    protocol: nonNegativeBigInt(vault.protocolLamports, "vault.protocolLamports") + nonNegativeBigInt(vault.protocolClaimedLamports, "vault.protocolClaimedLamports"),
  };
}

export function verifySolanaSponsorshipVaultState({ eventId, receipt, vault, expectedSplit }) {
  const normalizedEventId = exactId32(eventId, "eventId");
  if (!receipt || exactId32(receipt.eventId, "receipt.eventId") !== normalizedEventId) throw new Error("Sponsorship receipt event identity mismatch");
  if (!vault || exactId32(vault.eventId, "vault.eventId") !== normalizedEventId) throw new Error("EventPrizeVaultV1 event identity mismatch");

  const gross = positiveBigInt(expectedSplit?.gross, "expected gross");
  const prize = nonNegativeBigInt(expectedSplit?.prize, "expected prize");
  const marketing = nonNegativeBigInt(expectedSplit?.marketing, "expected marketing");
  const protocol = nonNegativeBigInt(expectedSplit?.protocol, "expected protocol");
  if (prize + marketing + protocol !== gross) throw new Error("Sponsorship 70/20/10 split does not conserve gross payment");
  if (receipt.grossLamports !== gross || receipt.prizeLamports !== prize || receipt.marketingLamports !== marketing || receipt.protocolLamports !== protocol) {
    throw new Error("Sponsorship receipt split does not match expected 70/20/10 allocation");
  }

  const lifetime = sponsorshipVaultLifetimeTotals(vault);
  if (lifetime.prize < prize || lifetime.marketing < marketing || lifetime.protocol < protocol) {
    throw new Error("EventPrizeVaultV1 post-state does not contain the verified sponsorship contribution");
  }
  if (lifetime.prize + lifetime.marketing + lifetime.protocol < gross) {
    throw new Error("EventPrizeVaultV1 post-state does not conserve verified sponsorship value");
  }

  return { eventId: normalizedEventId, lifetime, contribution: { prize, marketing, protocol }, gross };
}

export async function verifyExactVaultLamportDelta({ connection, signature, vaultPda, grossLamports }) {
  const tx = await connection.getTransaction(String(signature), {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta || tx.meta.err) throw new Error("Solana sponsorship transaction details are unavailable or failed");
  const keys = transactionAccountKeys(tx);
  const index = keys.indexOf(String(vaultPda));
  if (index < 0) throw new Error("EventPrizeVaultV1 PDA is absent from sponsorship transaction");
  const pre = tx.meta.preBalances?.[index];
  const post = tx.meta.postBalances?.[index];
  if (!Number.isSafeInteger(pre) || !Number.isSafeInteger(post) || post < pre) throw new Error("EventPrizeVaultV1 transaction balances are invalid");
  const delta = BigInt(post) - BigInt(pre);
  const expected = positiveBigInt(grossLamports, "grossLamports");
  if (delta !== expected) throw new Error("EventPrizeVaultV1 transaction lamport delta does not equal gross sponsorship payment");
  return { preLamports: String(pre), postLamports: String(post), deltaLamports: delta.toString() };
}

export function readSolanaNativeUsdPricing(chainId, product = "BOOST", env = process.env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const chain = Number(chainId);
  if (![101, 102].includes(chain)) throw new Error("Solana Arena Money V2 only supports chain 101/102");
  const prefix = product === "SPONSORSHIP" ? "ARENA_SPONSORSHIP" : "ARENA_BOOST";
  const nativeUsdRaw = env[`${prefix}_NATIVE_USD_MICROS_${chain}`] || env[`${prefix}_NATIVE_USD_MICROS`] || env[`ARENA_BOOST_NATIVE_USD_MICROS_${chain}`] || env.ARENA_BOOST_NATIVE_USD_MICROS;
  const pricingVersionRaw = env[`${prefix}_PRICING_VERSION_${chain}`] || env[`${prefix}_PRICING_VERSION`] || env[`ARENA_BOOST_PRICING_VERSION_${chain}`] || env.ARENA_BOOST_PRICING_VERSION;
  const updatedAtRaw = env[`${prefix}_NATIVE_USD_UPDATED_AT_${chain}`] || env[`${prefix}_NATIVE_USD_UPDATED_AT`] || env[`ARENA_BOOST_NATIVE_USD_UPDATED_AT_${chain}`] || env.ARENA_BOOST_NATIVE_USD_UPDATED_AT;
  const maxAgeRaw = env[`${prefix}_PRICE_MAX_AGE_SECONDS_${chain}`] || env[`${prefix}_PRICE_MAX_AGE_SECONDS`] || env[`ARENA_BOOST_PRICE_MAX_AGE_SECONDS_${chain}`] || env.ARENA_BOOST_PRICE_MAX_AGE_SECONDS || DEFAULT_PRICE_MAX_AGE_SECONDS;
  if (!nativeUsdRaw || !pricingVersionRaw || !updatedAtRaw) throw new Error(`${product} SOL/USD pricing is not configured`);
  const nativeUsdMicros = positiveBigInt(nativeUsdRaw, "nativeUsdMicros");
  const pricingVersion = positiveBigInt(pricingVersionRaw, "pricingVersion");
  const oracleTimestamp = positiveBigInt(updatedAtRaw, "oracleTimestamp");
  const maxAgeSeconds = positiveBigInt(maxAgeRaw, "maxAgeSeconds");
  const now = BigInt(nowSeconds);
  if (oracleTimestamp > now || now - oracleTimestamp > maxAgeSeconds) throw new Error(`${product} SOL/USD price is stale`);
  return { chainId: chain, nativeUsdMicros, pricingVersion, oracleTimestamp, nativeDecimals: SOLANA_NATIVE_DECIMALS };
}

export function quoteSolanaBoost({ chainId, boostUnits, pricing = readSolanaNativeUsdPricing(chainId, "BOOST") }) {
  const units = positiveBigInt(boostUnits, "boostUnits");
  const unitPriceLamports = unitPriceNativeRawFromUsdMicros({ usdMicros: 1_000_000n, nativeUsdMicros: pricing.nativeUsdMicros, nativeDecimals: SOLANA_NATIVE_DECIMALS });
  const grossLamports = unitPriceLamports * units;
  return { ...pricing, units, unitPriceLamports, ...splitSolanaBoost(grossLamports) };
}

export function quoteSolanaSponsorship({ chainId, requestedUsdMicros, pricing = readSolanaNativeUsdPricing(chainId, "SPONSORSHIP") }) {
  const usdMicros = positiveBigInt(requestedUsdMicros, "requestedUsdMicros");
  const grossLamports = unitPriceNativeRawFromUsdMicros({ usdMicros, nativeUsdMicros: pricing.nativeUsdMicros, nativeDecimals: SOLANA_NATIVE_DECIMALS });
  return { ...pricing, usdMicros, ...splitSolanaSponsorship(grossLamports) };
}

export function buildSolanaBoostInstructionRequirements({ competitionId, fundingId, wallet, grossLamports }) {
  const config = deriveArenaMoneyConfigV2Pda();
  const pool = deriveCompetitionPoolV2Pda(competitionId);
  const receipt = deriveBoostReceiptV2Pda(competitionId, fundingId, wallet);
  const data = Buffer.concat([discriminator("deposit_competition_boost_v2"), idBuffer(competitionId, "competitionId"), idBuffer(fundingId, "fundingId"), u64le(grossLamports)]);
  return {
    programId: ARENA_MONEY_V2_PROGRAM_ID,
    instruction: "deposit_competition_boost_v2",
    dataBase64: data.toString("base64"),
    accounts: [
      account(wallet, true, true),
      account(config.toBase58(), false, false),
      account(pool.toBase58(), false, true),
      account(receipt.toBase58(), false, true),
      account(SystemProgram.programId.toBase58(), false, false),
    ],
    configPda: config.toBase58(),
    poolPda: pool.toBase58(),
    receiptPda: receipt.toBase58(),
  };
}

export function buildSolanaSponsorshipInstructionRequirements({ eventId, paymentId, sponsor, grossLamports }) {
  const config = deriveArenaMoneyConfigV2Pda();
  const event = deriveSponsorshipEventV1Pda(eventId);
  const vault = deriveEventPrizeVaultV1Pda(eventId);
  const receipt = deriveSponsorshipReceiptV1Pda(eventId, paymentId, sponsor);
  const data = Buffer.concat([discriminator("pay_sponsorship_v1"), idBuffer(eventId, "eventId"), idBuffer(paymentId, "paymentId"), u64le(grossLamports)]);
  return {
    programId: ARENA_MONEY_V2_PROGRAM_ID,
    instruction: "pay_sponsorship_v1",
    dataBase64: data.toString("base64"),
    accounts: [
      account(sponsor, true, true),
      account(config.toBase58(), false, false),
      account(event.toBase58(), false, false),
      account(vault.toBase58(), false, true),
      account(receipt.toBase58(), false, true),
      account(SystemProgram.programId.toBase58(), false, false),
    ],
    configPda: config.toBase58(),
    eventPda: event.toBase58(),
    vaultPda: vault.toBase58(),
    receiptPda: receipt.toBase58(),
  };
}

export async function verifyConfirmedSolanaSignature(chainId, signature) {
  const sig = String(signature || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(sig)) throw new Error("invalid Solana transaction signature");
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) throw new Error("Solana Arena Money V2 RPC is unavailable");
  const result = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
  const status = result?.value?.[0];
  if (!status || status.err) throw new Error("Solana transaction is missing or failed");
  if (!status.confirmationStatus || !["confirmed", "finalized"].includes(status.confirmationStatus)) throw new Error("Solana transaction is not confirmed");
  return { signature: sig, slot: status.slot, confirmationStatus: status.confirmationStatus };
}

export async function verifySolanaBoostPayment({ chainId, signature, competitionId, fundingId, funder, grossLamports, prizeLamports, protocolLamports }) {
  const tx = await verifyConfirmedSolanaSignature(chainId, signature);
  const receipt = await readBoostReceiptV2(chainId, { competitionId, fundingId, funder, grossLamports, prizeLamports, protocolLamports });
  if (!receipt.ok) throw new Error(`BoostReceiptV2 verification failed: ${receipt.reason}`);
  return { ...tx, receiptPda: receipt.pda, receipt: receipt.receipt };
}

export async function verifySolanaSponsorshipPayment({
  chainId,
  signature,
  eventId,
  paymentId,
  sponsor,
  grossLamports,
  prizeLamports,
  marketingLamports,
  protocolLamports,
}) {
  const tx = await verifyConfirmedSolanaSignature(chainId, signature);
  const receipt = await readSponsorshipReceiptV1(chainId, { eventId, paymentId, sponsor, grossLamports, prizeLamports, marketingLamports, protocolLamports });
  if (!receipt.ok) throw new Error(`SponsorshipReceiptV1 verification failed: ${receipt.reason}`);
  const vault = await readEventPrizeVaultV1(chainId, eventId);
  if (!vault.ok) throw new Error(`EventPrizeVaultV1 verification failed: ${vault.reason}`);
  const split = {
    gross: positiveBigInt(grossLamports, "grossLamports"),
    prize: nonNegativeBigInt(prizeLamports, "prizeLamports"),
    marketing: nonNegativeBigInt(marketingLamports, "marketingLamports"),
    protocol: nonNegativeBigInt(protocolLamports, "protocolLamports"),
  };
  const vaultState = verifySolanaSponsorshipVaultState({ eventId, receipt: receipt.receipt, vault: vault.vault, expectedSplit: split });
  const connection = connectionForArenaMoneyV2(chainId);
  if (!connection) throw new Error("Solana Arena Money V2 RPC is unavailable");
  const vaultTransaction = await verifyExactVaultLamportDelta({
    connection,
    signature,
    vaultPda: vault.pda,
    grossLamports: split.gross,
  });
  return {
    ...tx,
    receiptPda: receipt.pda,
    receipt: receipt.receipt,
    vaultPda: vault.pda,
    vault: vault.vault,
    vaultState,
    vaultTransaction,
  };
}

export function assertSolanaPubkey(value, label = "public key") {
  try { return new PublicKey(String(value)).toBase58(); } catch { throw new Error(`${label} is invalid`); }
}
