import { createHash } from "crypto";

/**
 * Pure helpers for sweeping expired TradeAuthorization PDAs straight from
 * chain state.
 *
 * Every Solana trade parks 0.0016 SOL of rent in a TradeAuthorization PDA.
 * The program's close_expired_trade_authorization is permissionless and
 * always refunds the trader, but the worker only closed PDAs it had a
 * bookkeeping row for -- and eight expired ones sat on mainnet with no row.
 * Scanning the program's accounts needs no bookkeeping at all.
 *
 * Layout (Anchor): discriminator(8) trader(32) campaign(32) side(1)
 * nonce(32) deadline(i64) used_at(i64) route_signer(32) message_hash(32)
 * schema_version(u16) bump(u8) = 188 bytes.
 */

export const TRADE_AUTHORIZATION_BYTES = 188;
export const TRADE_AUTHORIZATION_DISC = createHash("sha256")
  .update("account:TradeAuthorization")
  .digest()
  .subarray(0, 8);

const OFF_TRADER = 8;
const OFF_CAMPAIGN = 40;
const OFF_SIDE = 72;
const OFF_NONCE = 73;
const OFF_DEADLINE = 105;
const OFF_USED_AT = 113;

export type DecodedTradeAuthorization = {
  address: string;
  traderBytes: Buffer;
  campaignBytes: Buffer;
  side: number;
  nonce: Buffer;
  deadline: number;
  usedAt: number;
  lamports: number;
};

export function decodeTradeAuthorization(
  address: string,
  data: Buffer,
  lamports: number,
): DecodedTradeAuthorization | null {
  if (data.length !== TRADE_AUTHORIZATION_BYTES) return null;
  if (!data.subarray(0, 8).equals(TRADE_AUTHORIZATION_DISC)) return null;
  return {
    address,
    traderBytes: Buffer.from(data.subarray(OFF_TRADER, OFF_TRADER + 32)),
    campaignBytes: Buffer.from(data.subarray(OFF_CAMPAIGN, OFF_CAMPAIGN + 32)),
    side: data[OFF_SIDE],
    nonce: Buffer.from(data.subarray(OFF_NONCE, OFF_NONCE + 32)),
    deadline: Number(data.readBigInt64LE(OFF_DEADLINE)),
    usedAt: Number(data.readBigInt64LE(OFF_USED_AT)),
    lamports,
  };
}

/**
 * The program requires now > deadline. The grace keeps the worker from
 * racing a trade that is being confirmed right at its deadline, and from
 * disagreeing with the validator clock by a few seconds.
 */
export function selectExpiredAuthorizations<T extends { deadline: number }>(
  items: T[],
  nowSec: number,
  graceSec = 30,
): T[] {
  return items
    .filter((item) => Number.isFinite(item.deadline) && item.deadline + graceSec < nowSec)
    .sort((a, b) => a.deadline - b.deadline);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
