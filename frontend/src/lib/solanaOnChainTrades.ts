/**
 * Campaign-PDA trade recovery when the indexer book is empty or incomplete.
 * Decodes the same Anchor events as realtime-indexer so txHash:logIndex matches.
 */
import type { CurveTradePoint } from "@/hooks/useCurveTrades";
import { getSolanaReadConnection } from "@/lib/solanaReadConnection";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import { isValidTradeTxHash, normalizeTradeTxHash } from "@/lib/tradeDedupe";

const PROGRAM_DATA_PREFIX = "Program data: ";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_UNITS = 1_000_000;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// sha256("event:" + name)[0:8] — keep in lockstep with realtime-indexer/src/solanaIndexer.ts
const DISC_TOKENS_BOUGHT = "9794ade2801ef9be";
const DISC_TOKENS_SOLD = "d953448986e15e2d";
const KNOWN_DISCS = new Set([
  "0962453d35834098", // CampaignCreated
  DISC_TOKENS_BOUGHT,
  DISC_TOKENS_SOLD,
  "939643a9455d5720", // CampaignGraduated
  "a052efc1216d9fac", // FeeSlicesAccrued
  "844378b0bacf7fd2", // FeeSlicesRouted
  "ce4bf413d54f7774", // FeeEscrowInitialized
  "91c5861a7b19b790", // FeeEscrowFlushed
]);

type DecodedTrade = {
  kind: "TokensBought" | "TokensSold";
  eventIndex: number;
  campaign: string;
  trader: string;
  tokenRaw: bigint;
  nativeRaw: bigint;
  soldTokensAfter: bigint;
};

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let encoded = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) encoded += BASE58_ALPHABET[digits[i]!]!;
  return encoded;
}

function readPubkey(data: Uint8Array, offset: number): string {
  return base58Encode(data.subarray(offset, offset + 32));
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function toTokens(raw: bigint): number {
  return Number(raw) / TOKEN_UNITS;
}

function toSol(raw: bigint): number {
  return Number(raw) / LAMPORTS_PER_SOL;
}

export function decodeSolanaTradeEvents(
  logMessages: string[] | null | undefined,
  campaignAddress?: string,
): DecodedTrade[] {
  const target = String(campaignAddress || "").trim();
  const trades: DecodedTrade[] = [];
  let eventIndex = 0;

  for (const line of logMessages || []) {
    const idx = line.indexOf(PROGRAM_DATA_PREFIX);
    if (idx < 0) continue;
    const encoded = line.slice(idx + PROGRAM_DATA_PREFIX.length).trim();
    if (!encoded) continue;
    let data: Uint8Array;
    try {
      const binary = atob(encoded);
      data = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    } catch {
      continue;
    }
    if (data.length < 8) continue;
    const disc = Array.from(data.subarray(0, 8))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (!KNOWN_DISCS.has(disc)) continue;

    if (disc === DISC_TOKENS_BOUGHT || disc === DISC_TOKENS_SOLD) {
      if (data.length < 8 + 64 + 48) {
        eventIndex += 1;
        continue;
      }
      const campaign = readPubkey(data, 8);
      const trader = readPubkey(data, 40);
      const isBuy = disc === DISC_TOKENS_BOUGHT;
      const tokenRaw = isBuy ? readU64LE(data, 8 + 64 + 24) : readU64LE(data, 8 + 64);
      const nativeRaw = isBuy ? readU64LE(data, 8 + 64) : readU64LE(data, 8 + 64 + 24);
      const soldTokensAfter = readU64LE(data, 8 + 64 + 32);
      if (!target || campaign === target) {
        trades.push({
          kind: isBuy ? "TokensBought" : "TokensSold",
          eventIndex,
          campaign,
          trader,
          tokenRaw,
          nativeRaw,
          soldTokensAfter,
        });
      }
    }
    eventIndex += 1;
  }
  return trades;
}

export function decodedTradeToPoint(
  trade: DecodedTrade,
  signature: string,
  slot: number,
  blockTimeSec: number,
): CurveTradePoint | null {
  const txHash = normalizeTradeTxHash(signature);
  if (!txHash || !isValidTradeTxHash(txHash)) return null;
  const tokens = toTokens(trade.tokenRaw);
  const native = toSol(trade.nativeRaw);
  if (!(tokens > 0) || !(native >= 0)) return null;
  return {
    type: trade.kind === "TokensSold" ? "sell" : "buy",
    from: trade.trader,
    to: trade.campaign,
    tokensWei: trade.tokenRaw,
    nativeWei: trade.nativeRaw,
    pricePerToken: tokens > 0 ? native / tokens : 0,
    soldTokensAfterRaw: trade.soldTokensAfter,
    venue: "curve",
    timestamp: blockTimeSec,
    txHash,
    blockNumber: slot,
    logIndex: trade.eventIndex,
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R | null>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      const value = await fn(item);
      if (value) out.push(value);
    }
  });
  await Promise.all(workers);
  return out;
}

export function selectSolanaSignaturesToFetch(input: {
  signatures: Array<{ signature?: string | null; slot?: number | null; err?: unknown | null }>;
  knownTxHashes: Iterable<string>;
  minSlot?: number | null;
  maxFetch?: number;
}): Array<{ signature: string; slot: number }> {
  const known = new Set(
    Array.from(input.knownTxHashes || [])
      .map((value) => normalizeTradeTxHash(value))
      .filter(Boolean),
  );
  const minSlot = Number(input.minSlot || 0);
  const maxFetch = Math.max(1, Math.min(20, Number(input.maxFetch || 8)));
  const out: Array<{ signature: string; slot: number }> = [];
  for (const item of input.signatures || []) {
    if (item?.err || !item?.signature) continue;
    const signature = String(item.signature);
    const slot = Number(item.slot || 0);
    const newerThanBook = minSlot > 0 && slot > minSlot;
    if (!newerThanBook && known.has(signature)) continue;
    out.push({ signature, slot });
    if (out.length >= maxFetch) break;
  }
  return out;
}

export async function fetchSolanaOnChainTrades(
  campaignAddress: string,
  opts?: {
    knownTxHashes?: Iterable<string>;
    knownIdentities?: Iterable<string>;
    minSlot?: number | null;
    maxFetch?: number;
    signal?: AbortSignal;
    limit?: number;
  },
): Promise<CurveTradePoint[]> {
  const campaign = String(campaignAddress || "").trim();
  if (!SOLANA_ADDRESS_RE.test(campaign)) return [];
  if (opts?.signal?.aborted) return [];

  const known = new Set(
    Array.from(opts?.knownTxHashes || [])
      .map((value) => normalizeTradeTxHash(value))
      .filter(Boolean),
  );
  const knownIdentities = new Set(
    Array.from(opts?.knownIdentities || []).map((value) => String(value || "").trim()).filter(Boolean),
  );
  const minSlot = Number(opts?.minSlot || 0);
  const limit = Math.min(Math.max(Number(opts?.limit ?? 50), 1), 100);
  const web3 = await loadSolanaWeb3();
  const connection = getSolanaReadConnection();
  const pubkey = new web3.PublicKey(campaign);
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit });
  const missing = selectSolanaSignaturesToFetch({
    signatures,
    knownTxHashes: known,
    minSlot,
    maxFetch: opts?.maxFetch ?? 8,
  });
  if (!missing.length) return [];

  const nested = await mapPool(
    missing,
    3,
    async (item) => {
      if (opts?.signal?.aborted) return null;
      try {
        const tx = await connection.getTransaction(item.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        const events = decodeSolanaTradeEvents(tx?.meta?.logMessages, campaign);
        if (!events.length) return [];
        const blockTime = Number(tx?.blockTime || item.blockTime || 0);
        const slot = Number(tx?.slot || item.slot || 0);
        return events
          .map((event) => decodedTradeToPoint(event, item.signature, slot, blockTime))
          .filter((point): point is CurveTradePoint => Boolean(point));
      } catch {
        return [];
      }
    },
    opts?.signal,
  );

  return nested.flat().filter((point) => {
    if (!(point.blockNumber > 0 && point.timestamp > 0)) return false;
    if (!knownIdentities.size) return true;
    const key = `${normalizeTradeTxHash(point.txHash)}:${Number(point.logIndex)}`;
    return !knownIdentities.has(key);
  });
}
