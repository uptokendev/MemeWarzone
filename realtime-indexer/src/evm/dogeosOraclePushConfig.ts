/**
 * Pure configuration and decisions of the DogeOS DOGE/USD oracle push (env names: see
 * dogeosOraclePushWorker.ts). No I/O here: the worker feeds chain reads and the Binance price in.
 *
 * Units are load-bearing. DogeosTestnetDogeUsdOracle has `decimals() == 8` and GraduationOracle
 * normalises with `answer * 10^(18-8)`. The oracle accepts any positive int256, so an 18-decimal push
 * would be taken and every campaign created in that window would be priced 10^10 off. The conversion
 * below owns that unit and is pinned by dogeosOraclePush.test.ts.
 */
import { ethers } from "ethers";
import { DOGEOS_TESTNET_CHAIN_ID } from "../evmIndexerChains.js";
import { parseRpcList } from "../rpcProvider.js";

export const DOGEOS_ORACLE_PUSH_CHAIN_ID = DOGEOS_TESTNET_CHAIN_ID;
export const ORACLE_DECIMALS = 8;
/** GraduationOracle(feed, 3600): a round older than this blocks graduation pricing (createCampaign fails closed). */
export const ORACLE_MAX_AGE_SECONDS = 3600;
/** Health warns from this age on: one missed 1800 s push plus 15 minutes, still 15 minutes before 3600. */
export const ORACLE_WARN_AGE_SECONDS = 2700;
export const DEFAULT_MAX_INTERVAL_SECONDS = 1800;
/** Spec §4: pushes at least every 30 minutes. Env can lower the interval, never raise it past this. */
export const MAX_INTERVAL_CEILING_SECONDS = 1800;
export const MIN_INTERVAL_SECONDS = 60;
export const DEFAULT_DEVIATION_BPS = 100;

/** DogeOS keys that must never sign an oracle push, even if an oracle were deployed with one as updater. */
export const FORBIDDEN_ORACLE_PUSH_SIGNERS: Record<string, string> = {
  "0x6c5c684d8ddf1d4338dbed21beb7d342dc8382f8": "DogeOS testnet deployer",
  "0xb07b9e70d1759fc42103458039aae2413026b078": "DogeOS testnet graduation keeper",
  "0x4fcd24d620f8ecd298bf4d43cb1ca2f4d23876ff": "DogeOS testnet route authority",
};

export class OraclePushRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OraclePushRefused";
  }
}

export type OraclePushDecisionConfig = { maxIntervalSeconds: number; deviationBps: number };

export type OraclePushConfig = OraclePushDecisionConfig & {
  enabled: boolean;
  oracleAddress: string | null;
  rpcUrl: string;
};

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function positiveInt(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function oraclePushConfig(env: NodeJS.ProcessEnv = process.env): OraclePushConfig {
  const rawAddress = String(env.DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971 || "").trim();
  const oracleAddress = rawAddress && ethers.isAddress(rawAddress) && rawAddress.toLowerCase() !== ethers.ZeroAddress ? ethers.getAddress(rawAddress) : null;
  const interval = positiveInt(env.DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS) ?? DEFAULT_MAX_INTERVAL_SECONDS;
  const bps = positiveInt(env.DOGEOS_ORACLE_PUSH_DEVIATION_BPS) ?? DEFAULT_DEVIATION_BPS;
  return {
    enabled: truthy(env.DOGEOS_ORACLE_PUSH_ENABLED),
    oracleAddress,
    rpcUrl: parseRpcList(String(env.DOGEOS_RPC_HTTP_6281971 || ""))[0] || "",
    maxIntervalSeconds: Math.min(MAX_INTERVAL_CEILING_SECONDS, Math.max(MIN_INTERVAL_SECONDS, interval)),
    deviationBps: Math.min(10_000, bps),
  };
}

/**
 * The updater signer. Reads only DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY (no DEPLOYER_PK /
 * PRIVATE_KEY_DEPLOY fallback). A forbidden address or an unparsable key throws; the key never
 * appears in a message.
 */
export function oraclePushWallet(env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  const raw = String(env.DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY || "").trim();
  if (!raw) return null;
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  } catch {
    throw new OraclePushRefused("DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY is not a valid private key");
  }
  assertSignerNotForbidden(wallet.address);
  return wallet;
}

export function assertSignerNotForbidden(address: string): void {
  const role = FORBIDDEN_ORACLE_PUSH_SIGNERS[String(address).toLowerCase()];
  if (role) throw new OraclePushRefused(`DogeOS oracle push refuses signer ${address}: it is the ${role}`);
}

/** The checks that must pass before the first push (spec §4, plan t21). */
export function assertOraclePushAllowed(input: {
  chainId: number;
  signerAddress: string;
  oracleUpdater: string;
  oracleDecimals: number;
}): void {
  if (input.chainId !== DOGEOS_ORACLE_PUSH_CHAIN_ID) {
    throw new OraclePushRefused(`DogeOS oracle push refuses chain ${input.chainId}: only ${DOGEOS_ORACLE_PUSH_CHAIN_ID}`);
  }
  assertSignerNotForbidden(input.signerAddress);
  if (String(input.oracleUpdater).toLowerCase() !== String(input.signerAddress).toLowerCase()) {
    throw new OraclePushRefused(`DogeOS oracle push refuses signer ${input.signerAddress}: oracle updater() is ${input.oracleUpdater}`);
  }
  if (input.oracleDecimals !== ORACLE_DECIMALS) {
    throw new OraclePushRefused(`DogeOS oracle push refuses an oracle with ${input.oracleDecimals} decimals: the push converts to ${ORACLE_DECIMALS}`);
  }
}

/**
 * A decimal USD price (Binance returns a plain string such as "0.21340000") to the oracle's 8-decimal
 * integer, rounded half-up at the 9th decimal with exact string arithmetic. Anything that is not a
 * plain positive decimal, or that rounds to 0, is null: the caller skips and never pushes <= 0.
 */
export function toOracleAnswer(price: unknown): bigint | null {
  if (typeof price !== "string" && typeof price !== "number") return null;
  const text = String(price).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const frac = (match[2] || "").padEnd(ORACLE_DECIMALS + 1, "0");
  let answer = whole * 10n ** BigInt(ORACLE_DECIMALS) + BigInt(frac.slice(0, ORACLE_DECIMALS));
  if (Number(frac[ORACLE_DECIMALS]) >= 5) answer += 1n;
  return answer > 0n ? answer : null;
}

export type ShouldPushReason = "invalid-price" | "no-valid-round" | "interval" | "deviation" | "fresh";

/** Push when the last round is at least the interval old or the price moved by at least the deviation. */
export function shouldPush(input: {
  lastAnswer: bigint;
  lastUpdatedAt: number;
  price: bigint;
  now: number;
  cfg: OraclePushDecisionConfig;
}): { push: boolean; reason: ShouldPushReason } {
  if (input.price <= 0n) return { push: false, reason: "invalid-price" };
  if (input.lastAnswer <= 0n || !(input.lastUpdatedAt > 0)) return { push: true, reason: "no-valid-round" };
  if (input.now - input.lastUpdatedAt >= input.cfg.maxIntervalSeconds) return { push: true, reason: "interval" };
  const diff = input.price > input.lastAnswer ? input.price - input.lastAnswer : input.lastAnswer - input.price;
  if (diff * 10_000n >= BigInt(input.cfg.deviationBps) * input.lastAnswer) return { push: true, reason: "deviation" };
  return { push: false, reason: "fresh" };
}

/** ok below ORACLE_WARN_AGE_SECONDS, warn up to the 3600 s window, stale past it (or with no round). */
export function oracleHealth(updatedAt: number, now: number): { level: "ok" | "warn" | "stale"; ageSeconds: number } {
  if (!(updatedAt > 0)) return { level: "stale", ageSeconds: Number.POSITIVE_INFINITY };
  const ageSeconds = Math.max(0, Math.floor(now - updatedAt));
  const level = ageSeconds > ORACLE_MAX_AGE_SECONDS ? "stale" : ageSeconds >= ORACLE_WARN_AGE_SECONDS ? "warn" : "ok";
  return { level, ageSeconds };
}
