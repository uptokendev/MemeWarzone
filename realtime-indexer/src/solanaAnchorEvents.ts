/**
 * Anchor event decoding for the memewarzone_solana launchpad program.
 *
 * Pure: no database, no RPC, no env. The field order of every decoder must
 * match target/idl/memewarzone_solana.json; src/tests/solanaGraduationEventDecode.test.ts
 * pins CampaignGraduated against the IDL because a silent drift there
 * misreads every amount after meteora_position.
 */
import { createHash } from "node:crypto";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const PROGRAM_DATA_PREFIX = "Program data: ";

export type CampaignCreatedEvent = {
  kind: "CampaignCreated";
  campaign: string;
  creator: string;
  mint: string;
  tokenVault: string;
  solVault: string;
};

export type TokensBoughtEvent = {
  kind: "TokensBought";
  campaign: string;
  trader: string;
  lamportsIn: bigint;
  feeLamports: bigint;
  netLamports: bigint;
  tokensOut: bigint;
  soldTokensAfter: bigint;
  netRaisedAfter: bigint;
};

export type TokensSoldEvent = {
  kind: "TokensSold";
  campaign: string;
  trader: string;
  tokensIn: bigint;
  grossLamports: bigint;
  feeLamports: bigint;
  lamportsOut: bigint;
  soldTokensAfter: bigint;
  netRaisedAfter: bigint;
};

export type FeeSlicesAccruedEvent = {
  kind: "FeeSlicesAccrued";
  campaign: string;
  trader: string;
  side: number;
  routeProfile: number;
  feeLamports: bigint;
  weekly: bigint;
  monthly: bigint;
  recruiter: bigint;
  airdrop: bigint;
  squad: bigint;
  protocol: bigint;
};

export type FeeEscrowInitializedEvent = {
  kind: "FeeEscrowInitialized";
  campaign: string;
  escrow: string;
  payer: string;
};

export type FeeEscrowFlushedEvent = {
  kind: "FeeEscrowFlushed";
  campaign: string;
  escrow: string;
  weekly: bigint;
  monthly: bigint;
  recruiter: bigint;
  airdrop: bigint;
  squad: bigint;
  protocol: bigint;
  total: bigint;
  caller: string;
};

export type CampaignGraduatedEvent = {
  kind: "CampaignGraduated";
  campaign: string;
  creator: string;
  mint: string;
  meteoraPool: string;
  meteoraPosition: string;
  quoteMint: string;
  quoteConfigId: string;
  liquidityTokens: bigint;
  liquidityLamports: bigint;
  liquidityQuoteRaw: bigint;
  finalizeFeeLamports: bigint;
  creatorPayoutLamports: bigint;
  burnedUnsoldCurveTokens: bigint;
  burnedUnusedLiquidityTokens: bigint;
  creatorReserveTokens: bigint;
  finalSpotNanoLamports: bigint;
  graduatedAt: bigint;
};

export type AnchorEvent =
  | CampaignCreatedEvent
  | TokensBoughtEvent
  | TokensSoldEvent
  | CampaignGraduatedEvent
  | FeeSlicesAccruedEvent
  | FeeEscrowInitializedEvent
  | FeeEscrowFlushedEvent;
export type Decoder = (reader: EventReader) => AnchorEvent;

export class EventReader {
  private offset = 8;
  constructor(private readonly data: Buffer) {}

  skip(bytes: number) {
    const end = this.offset + bytes;
    if (end > this.data.length) throw new Error("Anchor event skip out of bounds");
    this.offset = end;
  }

  pubkey(): string {
    const end = this.offset + 32;
    if (end > this.data.length) throw new Error("Anchor event pubkey out of bounds");
    const value = base58Encode(this.data.subarray(this.offset, end));
    this.offset = end;
    return value;
  }

  u8(): number {
    if (this.offset + 1 > this.data.length) throw new Error("Anchor event u8 out of bounds");
    const value = this.data.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u64(): bigint {
    if (this.offset + 8 > this.data.length) throw new Error("Anchor event u64 out of bounds");
    const value = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    if (this.offset + 8 > this.data.length) throw new Error("Anchor event i64 out of bounds");
    const value = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  u128(): bigint {
    if (this.offset + 16 > this.data.length) throw new Error("Anchor event u128 out of bounds");
    const lo = this.data.readBigUInt64LE(this.offset);
    const hi = this.data.readBigUInt64LE(this.offset + 8);
    this.offset += 16;
    return lo + (hi << 64n);
  }

  /** Fixed-size byte array (e.g. [u8; 32]) as lowercase hex. */
  hex(bytes: number): string {
    const end = this.offset + bytes;
    if (end > this.data.length) throw new Error("Anchor event bytes out of bounds");
    const value = this.data.subarray(this.offset, end).toString("hex");
    this.offset = end;
    return value;
  }
}

export function eventDiscriminator(name: string): string {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8).toString("hex");
}

const EVENT_DECODERS = new Map<string, Decoder>([
  [eventDiscriminator("CampaignCreated"), (r) => {
    // Current V4 event prefix:
    // campaign, campaign_id[32], generation_id[32], generation_config,
    // generation_manifest_hash[32], creator, mint, token_vault, sol_vault, ...
    const campaign = r.pubkey();
    r.skip(32);
    r.skip(32);
    r.pubkey();
    r.skip(32);
    const creator = r.pubkey();
    const mint = r.pubkey();
    const tokenVault = r.pubkey();
    const solVault = r.pubkey();
    return { kind: "CampaignCreated", campaign, creator, mint, tokenVault, solVault };
  }],
  [eventDiscriminator("TokensBought"), (r) => ({
    kind: "TokensBought",
    campaign: r.pubkey(),
    trader: r.pubkey(),
    lamportsIn: r.u64(),
    feeLamports: r.u64(),
    netLamports: r.u64(),
    tokensOut: r.u64(),
    soldTokensAfter: r.u64(),
    netRaisedAfter: r.u64(),
  })],
  [eventDiscriminator("TokensSold"), (r) => ({
    kind: "TokensSold",
    campaign: r.pubkey(),
    trader: r.pubkey(),
    tokensIn: r.u64(),
    grossLamports: r.u64(),
    feeLamports: r.u64(),
    lamportsOut: r.u64(),
    soldTokensAfter: r.u64(),
    netRaisedAfter: r.u64(),
  })],
  // Field order is the program's CampaignGraduated event (target/idl): the
  // quote binding (quote_mint, quote_config_id, liquidity_quote_raw) sits
  // between the position and the lamport amounts. Skipping it shifted every
  // amount after meteora_position by 72 bytes.
  [eventDiscriminator("CampaignGraduated"), (r) => ({
    kind: "CampaignGraduated",
    campaign: r.pubkey(),
    creator: r.pubkey(),
    mint: r.pubkey(),
    meteoraPool: r.pubkey(),
    meteoraPosition: r.pubkey(),
    quoteMint: r.pubkey(),
    quoteConfigId: r.hex(32),
    liquidityTokens: r.u64(),
    liquidityLamports: r.u64(),
    liquidityQuoteRaw: r.u64(),
    finalizeFeeLamports: r.u64(),
    creatorPayoutLamports: r.u64(),
    burnedUnsoldCurveTokens: r.u64(),
    burnedUnusedLiquidityTokens: r.u64(),
    creatorReserveTokens: r.u64(),
    finalSpotNanoLamports: r.u128(),
    graduatedAt: r.i64(),
  })],
  [eventDiscriminator("FeeSlicesAccrued"), (r) => ({
    kind: "FeeSlicesAccrued",
    campaign: r.pubkey(),
    trader: r.pubkey(),
    side: r.u8(),
    routeProfile: r.u8(),
    feeLamports: r.u64(),
    weekly: r.u64(),
    monthly: r.u64(),
    recruiter: r.u64(),
    airdrop: r.u64(),
    squad: r.u64(),
    protocol: r.u64(),
  })],
  [eventDiscriminator("FeeSlicesRouted"), (r) => {
    const campaign = r.pubkey();
    const trader = r.pubkey();
    const side = r.u8();
    const routeProfile = r.u8();
    r.u64();
    return {
      kind: "FeeSlicesAccrued" as const,
      campaign,
      trader,
      side,
      routeProfile,
      feeLamports: r.u64(),
      weekly: r.u64(),
      monthly: r.u64(),
      recruiter: r.u64(),
      airdrop: r.u64(),
      squad: r.u64(),
      protocol: r.u64(),
    };
  }],
  [eventDiscriminator("FeeEscrowInitialized"), (r) => ({
    kind: "FeeEscrowInitialized",
    campaign: r.pubkey(),
    escrow: r.pubkey(),
    payer: r.pubkey(),
  })],
  [eventDiscriminator("FeeEscrowFlushed"), (r) => ({
    kind: "FeeEscrowFlushed",
    campaign: r.pubkey(),
    escrow: r.pubkey(),
    weekly: r.u64(),
    monthly: r.u64(),
    recruiter: r.u64(),
    airdrop: r.u64(),
    squad: r.u64(),
    protocol: r.u64(),
    total: r.u64(),
    caller: r.pubkey(),
  })],
]);

export function base58Encode(bytes: Uint8Array): string {
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
  for (let i = digits.length - 1; i >= 0; i -= 1) encoded += BASE58_ALPHABET[digits[i]];
  return encoded;
}

export function decodeEvents(logMessages: string[] | null | undefined): AnchorEvent[] {
  const events: AnchorEvent[] = [];
  for (const line of logMessages || []) {
    const idx = line.indexOf(PROGRAM_DATA_PREFIX);
    if (idx < 0) continue;
    const encoded = line.slice(idx + PROGRAM_DATA_PREFIX.length).trim();
    if (!encoded) continue;
    try {
      const data = Buffer.from(encoded, "base64");
      if (data.length < 8) continue;
      const decoder = EVENT_DECODERS.get(data.subarray(0, 8).toString("hex"));
      if (!decoder) continue;
      events.push(decoder(new EventReader(data)));
    } catch (error) {
      console.warn("[solana-indexer] failed to decode Anchor event", error instanceof Error ? error.message : String(error));
    }
  }
  return events;
}

