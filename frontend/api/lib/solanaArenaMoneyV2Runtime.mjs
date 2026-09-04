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

export async function verifySolanaSponsorshipPayment({ chainId, signature, eventId, paymentId, sponsor, grossLamports, prizeLamports, marketingLamports, protocolLamports }) {
  const tx = await verifyConfirmedSolanaSignature(chainId, signature);
  const receipt = await readSponsorshipReceiptV1(chainId, { eventId, paymentId, sponsor, grossLamports, prizeLamports, marketingLamports, protocolLamports });
  if (!receipt.ok) throw new Error(`SponsorshipReceiptV1 verification failed: ${receipt.reason}`);
  return { ...tx, receiptPda: receipt.pda, receipt: receipt.receipt };
}

export function assertSolanaPubkey(value, label = "public key") {
  try { return new PublicKey(String(value)).toBase58(); } catch { throw new Error(`${label} is invalid`); }
}
