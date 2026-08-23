import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { checkMilestones } from "./milestones.js";
import { publishCandle, publishLeague, publishStats, publishTrade } from "./ably.js";
import { createLeagueFeedPublisher } from "./leagueFeed.js";
import { buildCampaignCreatedMessage } from "./solanaLeaguePublish.js";
import { candleUpsertPayload } from "./candlePublish.js";
import { TIMEFRAMES, bucketStart, type TF } from "./timeframes.js";
import {
  SOLANA_MAINNET_GENESIS,
  healthStatus,
  nextBackfillCheckpoint,
  recoverFutureCursor,
  sortSignaturesAscending,
  type IndexedSignature,
  type ProcessedSignature,
} from "./solanaIndexerCheckpoint.js";

const SOLANA_CHAIN_ID = 101;
const leagueFeed = createLeagueFeedPublisher({ pool, flushMs: 500 });
leagueFeed.start();
const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const TOKEN_UNITS = 10 ** TOKEN_DECIMALS;
const PROGRAM_DATA_PREFIX = "Program data: ";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type RpcSignature = {
  signature: string;
  slot: number;
  err: unknown;
  blockTime?: number | null;
};

type RpcTransaction = {
  slot: number;
  blockTime?: number | null;
  meta?: { logMessages?: string[] | null } | null;
} | null;

type CampaignCreatedEvent = {
  kind: "CampaignCreated";
  campaign: string;
  creator: string;
  mint: string;
  tokenVault: string;
  solVault: string;
};

type TokensBoughtEvent = {
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

type TokensSoldEvent = {
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

type FeeSlicesAccruedEvent = {
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

type FeeEscrowInitializedEvent = {
  kind: "FeeEscrowInitialized";
  campaign: string;
  escrow: string;
  payer: string;
};

type FeeEscrowFlushedEvent = {
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

type CampaignGraduatedEvent = {
  kind: "CampaignGraduated";
  campaign: string;
  creator: string;
  mint: string;
  meteoraPool: string;
  meteoraPosition: string;
  liquidityTokens: bigint;
  liquidityLamports: bigint;
  finalizeFeeLamports: bigint;
  creatorPayoutLamports: bigint;
  burnedUnsoldCurveTokens: bigint;
  burnedUnusedLiquidityTokens: bigint;
  creatorReserveTokens: bigint;
  finalSpotNanoLamports: bigint;
  graduatedAt: bigint;
};

type AnchorEvent =
  | CampaignCreatedEvent
  | TokensBoughtEvent
  | TokensSoldEvent
  | CampaignGraduatedEvent
  | FeeSlicesAccruedEvent
  | FeeEscrowInitializedEvent
  | FeeEscrowFlushedEvent;
type Decoder = (reader: EventReader) => AnchorEvent;

class EventReader {
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
}

function eventDiscriminator(name: string): string {
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
  [eventDiscriminator("CampaignGraduated"), (r) => ({
    kind: "CampaignGraduated",
    campaign: r.pubkey(),
    creator: r.pubkey(),
    mint: r.pubkey(),
    meteoraPool: r.pubkey(),
    meteoraPosition: r.pubkey(),
    liquidityTokens: r.u64(),
    liquidityLamports: r.u64(),
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
  for (let i = digits.length - 1; i >= 0; i -= 1) encoded += BASE58_ALPHABET[digits[i]];
  return encoded;
}

function parseRpcList(value: string): string[] {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function programId() {
  return String(ENV.SOLANA_LAUNCHPAD_PROGRAM_ID || process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || DEFAULT_PROGRAM_ID).trim();
}

export function deriveFeeEscrowAddress(campaign: string, launchpadProgramId = programId()): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee-escrow"), new PublicKey(campaign).toBuffer()],
    new PublicKey(launchpadProgramId),
  )[0].toBase58();
}

function solanaRpcUrls(): string[] {
  const configured = String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || "").trim();
  return parseRpcList(configured || DEFAULT_SOLANA_RPC);
}

function toSol(raw: bigint): number {
  return Number(raw) / LAMPORTS_PER_SOL;
}

function toTokens(raw: bigint): number {
  return Number(raw) / TOKEN_UNITS;
}

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

/** Same field order as frontend decodeSolanaCampaignAccount. */
function decodeCampaignSpot(data: Buffer): {
  economicsVersion: number;
  tokenDecimals: number;
  basePriceLamports: number;
  priceSlopeLamports: number;
  soldTokens: bigint;
  netRaisedLamports: bigint;
} | null {
  if (data.length < 8 + 400) return null;
  let o = 8;
  const skip = (n: number) => {
    o += n;
  };
  skip(32 * 12); // campaign id, generation, hashes, creator, mint, vaults
  skip(8); // reservation_version
  skip(8); // launch_at
  skip(8); // graduation_target
  skip(1); // cluster_kind
  const economicsVersion = data.readUInt16LE(o);
  o += 2;
  skip(1); // curve_kind
  skip(8 * 4); // supplies
  const tokenDecimals = data.readUInt8(o);
  o += 1;
  skip(2); // curve_supply_bps
  skip(2); // liquidity_token_bps
  const basePriceLamports = Number(readU64LE(data, o));
  o += 8;
  const priceSlopeLamports = Number(readU64LE(data, o));
  o += 8;
  skip(2 * 5); // fee bps
  skip(1); // dex_adapter
  skip(32 * 5); // route/treasury/dex/oracle profiles
  skip(8); // creator_buy_lock
  skip(2); // creator_buy_cap_bps
  skip(8); // created_at
  if (o + 16 > data.length) return null;
  const soldTokens = readU64LE(data, o);
  o += 8;
  const netRaisedLamports = readU64LE(data, o);
  return {
    economicsVersion,
    tokenDecimals,
    basePriceLamports,
    priceSlopeLamports,
    soldTokens,
    netRaisedLamports,
  };
}

function spotSolFromCurve(curve: NonNullable<ReturnType<typeof decodeCampaignSpot>>): number {
  const decimals = Math.max(0, Number(curve.tokenDecimals || 6));
  const soldWhole = Number(curve.soldTokens) / 10 ** decimals;
  const slopeLamports =
    curve.economicsVersion >= 3
      ? (curve.priceSlopeLamports * soldWhole) / 1_000_000_000
      : curve.priceSlopeLamports * soldWhole;
  const spot = (curve.basePriceLamports + slopeLamports) / LAMPORTS_PER_SOL;
  return Number.isFinite(spot) && spot > 0 ? spot : 0;
}

async function fetchCampaignCurveSpot(campaign: string): Promise<{
  soldWhole: number;
  spotSol: number;
  marketcapSol: number;
} | null> {
  try {
    const info = await rpc<{ value?: { data?: [string, string] } | null }>("getAccountInfo", [
      campaign,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const encoded = info?.value?.data?.[0];
    if (!encoded) return null;
    const curve = decodeCampaignSpot(Buffer.from(encoded, "base64"));
    if (!curve || curve.soldTokens <= 0n) return null;
    const decimals = Math.max(0, Number(curve.tokenDecimals || 6));
    const soldWhole = Number(curve.soldTokens) / 10 ** decimals;
    const spotSol = spotSolFromCurve(curve);
    if (!(soldWhole > 0) || !(spotSol > 0)) return null;
    return { soldWhole, spotSol, marketcapSol: spotSol * soldWhole };
  } catch (error) {
    console.warn(
      "[solana-indexer] curve spot read failed",
      campaign,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function timestampFrom(blockTime: number | null | undefined): Date {
  return new Date(Number(blockTime || Math.floor(Date.now() / 1000)) * 1000);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (const url of solanaRpcUrls()) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw new Error(`Solana RPC ${method} HTTP ${response.status}`);
      const payload = await response.json() as { result?: T; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message || `Solana RPC ${method} failed`);
      return payload.result as T;
    } catch (error) {
      lastError = error;
      console.warn("[solana-indexer] RPC endpoint failed", {
        method,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `Solana RPC ${method} failed`));
}

async function getState(): Promise<number> {
  const result = await pool.query(
    `select last_indexed_block from public.indexer_state where chain_id=$1 and cursor=$2`,
    [SOLANA_CHAIN_ID, "solana:v4:program"],
  );
  return result.rowCount ? Number(result.rows[0].last_indexed_block) : 0;
}

async function setState(nextSlot: number) {
  await pool.query(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict (chain_id,cursor) do update
       set last_indexed_block = greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
           updated_at=now()`,
    [SOLANA_CHAIN_ID, "solana:v4:program", nextSlot],
  );
}

async function resetState(nextSlot: number) {
  await pool.query(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict (chain_id,cursor) do update
       set last_indexed_block = excluded.last_indexed_block,
           updated_at=now()`,
    [SOLANA_CHAIN_ID, "solana:v4:program", nextSlot],
  );
}

async function getHeadSlot(): Promise<number> {
  return rpc<number>("getSlot", [{ commitment: "confirmed" }]);
}

let genesisChecked = false;
async function assertMainnetGenesis(): Promise<void> {
  if (genesisChecked) return;
  const genesis = await rpc<string>("getGenesisHash", []);
  if (genesis !== SOLANA_MAINNET_GENESIS) {
    throw new Error(`[solana-indexer] refusing non-mainnet genesis ${genesis}`);
  }
  genesisChecked = true;
}

function signatureLimit(): number {
  return Math.max(1, Math.min(1000, ENV.SOLANA_SIGNATURE_LIMIT || 500));
}

async function fetchSignaturePage(before?: string): Promise<RpcSignature[]> {
  const batch = await rpc<RpcSignature[]>("getSignaturesForAddress", [
    programId(),
    { limit: signatureLimit(), ...(before ? { before } : {}) },
  ]);
  return Array.isArray(batch) ? batch : [];
}

function toIndexed(item: RpcSignature): IndexedSignature {
  return { signature: item.signature, slot: item.slot, err: item.err };
}

async function fetchTipSignatures(): Promise<IndexedSignature[]> {
  const batch = await fetchSignaturePage();
  return batch.filter((item) => !item.err).map(toIndexed);
}

async function fetchBackfillSignatures(checkpoint: number): Promise<{
  items: IndexedSignature[];
  reachedHistoricalFrontier: boolean;
}> {
  const maxPages = Math.max(1, ENV.SOLANA_SIGNATURE_PAGE_LIMIT || 5);
  const collected: IndexedSignature[] = [];
  let before: string | undefined;
  let reachedHistoricalFrontier = false;

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await fetchSignaturePage(before);
    if (!batch.length) {
      reachedHistoricalFrontier = true;
      break;
    }
    for (const item of batch) {
      if (item.err) continue;
      if (item.slot <= checkpoint) reachedHistoricalFrontier = true;
      else collected.push(toIndexed(item));
    }
    const last = batch[batch.length - 1];
    if (!last || last.slot <= checkpoint) {
      reachedHistoricalFrontier = true;
      break;
    }
    before = last.signature;
  }

  return {
    items: sortSignaturesAscending(collected),
    reachedHistoricalFrontier,
  };
}

async function getTransaction(signature: string): Promise<RpcTransaction> {
  return rpc<RpcTransaction>("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
}

function decodeEvents(logMessages: string[] | null | undefined): AnchorEvent[] {
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

async function upsertCampaign(event: CampaignCreatedEvent, slot: number, blockTime: Date, signature: string, logIndex: number) {
  await pool.query(
    `insert into public.campaigns(
       chain_id,factory_address,campaign_address,token_address,creator_address,name,symbol,created_block,created_at_chain,is_active,meta
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10::jsonb)
     on conflict (chain_id,campaign_address) do update set
       factory_address=coalesce(public.campaigns.factory_address, excluded.factory_address),
       token_address=coalesce(excluded.token_address, public.campaigns.token_address),
       creator_address=coalesce(excluded.creator_address, public.campaigns.creator_address),
       created_block=(case
         when public.campaigns.created_block is null or public.campaigns.created_block=0 then excluded.created_block
         else least(public.campaigns.created_block, excluded.created_block)
       end),
       created_at_chain=coalesce(public.campaigns.created_at_chain, excluded.created_at_chain),
       is_active=true,
       meta=coalesce(public.campaigns.meta,'{}'::jsonb) || excluded.meta,
       updated_at=now()`,
    [
      SOLANA_CHAIN_ID,
      programId(),
      event.campaign,
      event.mint,
      event.creator,
      "Solana Launch",
      "SOL",
      slot,
      blockTime,
      JSON.stringify({
        source: "solana-v4-indexer",
        solana: { programId: programId(), tokenVault: event.tokenVault, solVault: event.solVault },
      }),
    ],
  );

  await insertActivityEvent({
    eventType: "CREATE_CAMPAIGN",
    txHash: signature,
    logIndex,
    blockNumber: slot,
    blockTime,
    actor: event.creator,
    campaign: event.campaign,
    token: event.mint,
    meta: { tokenVault: event.tokenVault, solVault: event.solVault },
  });

  // Fire-and-forget: tip lane must not wait on Ably.
  void publishLeague(
    SOLANA_CHAIN_ID,
    "campaign_created",
    buildCampaignCreatedMessage(event, slot, blockTime),
  ).catch(() => {});
}

async function touchCampaignActivity(campaign: string, at: Date) {
  await pool.query(
    `insert into public.campaign_activity (chain_id, campaign_address, last_activity_at, updated_at)
     values ($1, $2, $3, now())
     on conflict (chain_id, campaign_address) do update set
       last_activity_at = greatest(excluded.last_activity_at, coalesce(public.campaign_activity.last_activity_at, to_timestamp(0))),
       updated_at = now()`,
    [SOLANA_CHAIN_ID, campaign, at],
  ).catch((error) => {
    const msg = String(error?.message || error);
    if (!msg.includes("campaign_activity")) console.warn("[solana-indexer] campaign activity touch failed", msg);
  });
}

async function insertActivityEvent(row: {
  eventType: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  actor: string;
  campaign?: string | null;
  token?: string | null;
  amountInWei?: bigint | null;
  amountOutWei?: bigint | null;
  costWei?: bigint | null;
  payoutWei?: bigint | null;
  meta?: Record<string, unknown> | null;
}) {
  await pool.query(
    `insert into public.activity_events(
       chain_id,event_type,tx_hash,log_index,block_number,block_time,
       actor_address,campaign_address,token_address,
       amount_in_wei,amount_out_wei,cost_wei,payout_wei,meta
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (chain_id,tx_hash,log_index) do nothing`,
    [
      SOLANA_CHAIN_ID,
      row.eventType,
      row.txHash,
      row.logIndex,
      row.blockNumber,
      row.blockTime,
      row.actor,
      row.campaign ?? null,
      row.token ?? null,
      row.amountInWei ? row.amountInWei.toString() : null,
      row.amountOutWei ? row.amountOutWei.toString() : null,
      row.costWei ? row.costWei.toString() : null,
      row.payoutWei ? row.payoutWei.toString() : null,
      row.meta ? JSON.stringify(row.meta) : "{}",
    ],
  ).catch((error) => {
    const msg = String(error?.message || error);
    if (!msg.includes("activity_events")) console.warn("[solana-indexer] activity insert failed", msg);
  });
}

async function upsertCandle(campaign: string, tf: TF, bucketSec: number, priceSol: number, volumeSol: number, soldWhole = 0) {
  const mcapSol = Number.isFinite(soldWhole) && soldWhole > 0 ? priceSol * soldWhole : null;
  const written = await pool.query(
    `insert into public.token_candles(
       chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
       mcap_o,mcap_h,mcap_l,mcap_c
     ) values($1,$2,$3,$4,$5,$5,$5,$5,$6,1,$7,$7,$7,$7)
     on conflict (chain_id,campaign_address,timeframe,bucket_start) do update set
       h=greatest(public.token_candles.h, excluded.h),
       l=least(public.token_candles.l, excluded.l),
       c=excluded.c,
       volume_bnb=public.token_candles.volume_bnb + excluded.volume_bnb,
       trades_count=public.token_candles.trades_count + 1,
       mcap_o=coalesce(public.token_candles.mcap_o, excluded.mcap_o),
       mcap_h=case
         when excluded.mcap_h is null then public.token_candles.mcap_h
         else greatest(coalesce(public.token_candles.mcap_h, excluded.mcap_h), excluded.mcap_h)
       end,
       mcap_l=case
         when excluded.mcap_l is null then public.token_candles.mcap_l
         else least(coalesce(public.token_candles.mcap_l, excluded.mcap_l), excluded.mcap_l)
       end,
       mcap_c=coalesce(excluded.mcap_c, public.token_candles.mcap_c),
       updated_at=now()
     returning o,h,l,c,volume_bnb,trades_count,mcap_o,mcap_h,mcap_l,mcap_c`,
    [SOLANA_CHAIN_ID, campaign, tf, new Date(bucketSec * 1000), priceSol, volumeSol, mcapSol],
  );

  const row = written.rows[0] || {
    o: priceSol,
    h: priceSol,
    l: priceSol,
    c: priceSol,
    volume_bnb: volumeSol,
    trades_count: 1,
  };
  void publishCandle(SOLANA_CHAIN_ID, campaign, candleUpsertPayload(tf, bucketSec, row)).catch(() => undefined);
}

async function patchStats(campaign: string) {
  const latest = await pool.query(
    `with t as (
       select price_bnb, sold_tokens_after_raw, block_time
       from public.curve_trades
       where chain_id=$1 and campaign_address=$2
       order by block_number desc, log_index desc
       limit 1
     ),
     v as (
       select coalesce(sum(
         case
           when bnb_amount_raw::text ~ '^[0-9]+(\.0+)?$' then bnb_amount_raw::numeric / 1e9
           else coalesce(bnb_amount, 0)
         end
       ), 0) as vol24h
       from public.curve_trades
       where chain_id=$1 and campaign_address=$2
         and block_time >= now() - interval '24 hours'
     )
     select (select price_bnb from t) as last_fill_price,
            (select sold_tokens_after_raw from t) as sold_after_raw,
            (select vol24h from v) as vol24h_bnb`,
    [SOLANA_CHAIN_ID, campaign],
  );

  const vol24h = Number(latest.rows[0]?.vol24h_bnb ?? 0);
  const fillPrice = latest.rows[0]?.last_fill_price != null ? Number(latest.rows[0].last_fill_price) : null;
  const soldAfterRaw = latest.rows[0]?.sold_after_raw;
  const curve = await fetchCampaignCurveSpot(campaign);
  // True mcap is current marginal spot × circulating sold, not last-fill VWAP × sold.
  const lastPrice = curve?.spotSol ?? (fillPrice != null && Number.isFinite(fillPrice) && fillPrice > 0 ? fillPrice : null);
  const soldTokens =
    curve?.soldWhole ??
    (soldAfterRaw != null && String(soldAfterRaw).trim() !== ""
      ? Number(soldAfterRaw) / TOKEN_UNITS
      : 0);
  const marketcap =
    curve?.marketcapSol ??
    (lastPrice != null && soldTokens > 0 ? lastPrice * soldTokens : null);

  await pool.query(
    `insert into public.token_stats(
       chain_id,campaign_address,last_price_bnb,sold_tokens,marketcap_bnb,vol_24h_bnb,updated_at
     ) values($1,$2,$3,$4,$5,$6,now())
     on conflict (chain_id,campaign_address) do update set
       last_price_bnb=excluded.last_price_bnb,
       sold_tokens=excluded.sold_tokens,
       marketcap_bnb=excluded.marketcap_bnb,
       vol_24h_bnb=excluded.vol_24h_bnb,
       updated_at=now()`,
    [SOLANA_CHAIN_ID, campaign, lastPrice, soldTokens, marketcap, vol24h],
  );

  void publishStats(SOLANA_CHAIN_ID, campaign, {
    type: "stats_patch",
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    marketcapBnb: marketcap !== null ? String(marketcap) : null,
    vol24hBnb: String(vol24h),
  }).catch(() => undefined);

  leagueFeed.queueStats(SOLANA_CHAIN_ID, campaign, {
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    marketcapBnb: marketcap !== null ? String(marketcap) : null,
    vol24hBnb: String(vol24h),
  });
}

async function insertTrade(event: TokensBoughtEvent | TokensSoldEvent, signature: string, logIndex: number, slot: number, blockTime: Date) {
  const isBuy = event.kind === "TokensBought";
  const campaign = event.campaign;
  const wallet = event.trader;
  const tokenRaw = isBuy ? event.tokensOut : event.tokensIn;
  // Match BNB user-facing fill semantics: gross/actual spend for buys, net payout for sells.
  const nativeRaw = isBuy ? event.lamportsIn : event.lamportsOut;
  const tokenAmount = toTokens(tokenRaw);
  const nativeAmount = toSol(nativeRaw);
  const priceNative = tokenAmount > 0 ? nativeAmount / tokenAmount : null;

  // Only complete *partial* rows (missing sold_tokens_after_raw). A match on a
  // fully processed row used to return before publish/candles/stats forever.
  const completedPartial = await pool.query(
    `update public.curve_trades
        set sold_tokens_after_raw=$4
      where chain_id=$1 and tx_hash=$2 and log_index=$3
        and sold_tokens_after_raw is null
      returning tx_hash`,
    [
      SOLANA_CHAIN_ID,
      signature,
      logIndex,
      event.soldTokensAfter.toString(),
    ],
  );

  let firstFanout = (completedPartial.rowCount ?? 0) > 0;
  if (!firstFanout) {
    const inserted = await pool.query(
      `insert into public.curve_trades(
         chain_id,campaign_address,tx_hash,log_index,block_number,block_time,
         side,wallet,token_amount_raw,bnb_amount_raw,token_amount,bnb_amount,price_bnb,
         sold_tokens_after_raw
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (chain_id,tx_hash,log_index) do nothing
       returning tx_hash`,
      [
        SOLANA_CHAIN_ID,
        campaign,
        signature,
        logIndex,
        slot,
        blockTime,
        isBuy ? "buy" : "sell",
        wallet,
        tokenRaw.toString(),
        nativeRaw.toString(),
        tokenAmount,
        nativeAmount,
        priceNative,
        event.soldTokensAfter.toString(),
      ],
    );
    firstFanout = (inserted.rowCount ?? 0) > 0;
  }

  const realtimeRow = {
    tx_hash: signature,
    log_index: logIndex,
    block_number: slot,
    block_time: blockTime.toISOString(),
    side: isBuy ? "buy" : "sell",
    wallet,
    token_amount_raw: tokenRaw.toString(),
    bnb_amount_raw: nativeRaw.toString(),
    token_amount: tokenAmount,
    bnb_amount: nativeAmount,
    price_bnb: priceNative,
    sold_tokens_after_raw: event.soldTokensAfter.toString(),
  };
  void publishTrade(SOLANA_CHAIN_ID, campaign, realtimeRow).catch(() => undefined);

  if (!firstFanout) {
    await patchStats(campaign);
    return;
  }

  await touchCampaignActivity(campaign, blockTime);
  await insertActivityEvent({
    eventType: isBuy ? "BUY" : "SELL",
    txHash: signature,
    logIndex,
    blockNumber: slot,
    blockTime,
    actor: wallet,
    campaign,
    amountInWei: isBuy ? nativeRaw : tokenRaw,
    amountOutWei: isBuy ? tokenRaw : nativeRaw,
    costWei: isBuy ? nativeRaw : null,
    payoutWei: isBuy ? null : nativeRaw,
    meta: {
      priceSol: priceNative,
      feeLamports: event.feeLamports.toString(),
      curveNetLamports: isBuy ? event.netLamports.toString() : event.grossLamports.toString(),
      soldTokensAfter: event.soldTokensAfter.toString(),
      netRaisedAfter: event.netRaisedAfter.toString(),
    },
  });

  leagueFeed.queueActivity(SOLANA_CHAIN_ID, campaign, Math.floor(blockTime.getTime() / 1000));
  leagueFeed.queueRaisedDelta(SOLANA_CHAIN_ID, campaign, isBuy ? nativeAmount : -nativeAmount);

  if (priceNative !== null && priceNative > 0) {
    const tsSec = Math.floor(blockTime.getTime() / 1000);
    for (const tf of TIMEFRAMES) {
      await upsertCandle(
        campaign,
        tf,
        bucketStart(tsSec, tf),
        priceNative,
        nativeAmount,
        toTokens(event.soldTokensAfter),
      );
    }
  }
  await patchStats(campaign);
}

async function persistGraduation(
  event: CampaignGraduatedEvent,
  signature: string,
  logIndex: number,
  slot: number,
  blockTime: Date,
) {
  const graduatedAtChain =
    event.graduatedAt > 0n
      ? new Date(Number(event.graduatedAt) * 1000)
      : blockTime;

  const graduationMeta = {
    dex: "meteora-damm-v2",
    pool: event.meteoraPool,
    position: event.meteoraPosition,
    liquidityTokensRaw: event.liquidityTokens.toString(),
    liquidityLamports: event.liquidityLamports.toString(),
    finalizeFeeLamports: event.finalizeFeeLamports.toString(),
    creatorPayoutLamports: event.creatorPayoutLamports.toString(),
    burnedUnsoldCurveTokens: event.burnedUnsoldCurveTokens.toString(),
    burnedUnusedLiquidityTokens: event.burnedUnusedLiquidityTokens.toString(),
    creatorReserveTokens: event.creatorReserveTokens.toString(),
    finalSpotNanoLamports: event.finalSpotNanoLamports.toString(),
    graduatedAt: event.graduatedAt.toString(),
    transactionSignature: signature,
    slot,
  };

  await pool.query(
    `insert into public.campaigns(
       chain_id,factory_address,campaign_address,token_address,creator_address,name,symbol,
       created_block,created_at_chain,is_active,launched,bonding_active,support_enabled,
       indexing_enabled,graduated_block,graduated_at_chain,meta
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,true,false,true,true,$10,$11,$12::jsonb)
     on conflict (chain_id,campaign_address) do update set
       token_address=coalesce(excluded.token_address, public.campaigns.token_address),
       creator_address=coalesce(excluded.creator_address, public.campaigns.creator_address),
       is_active=false,
       launched=true,
       bonding_active=false,
       support_enabled=true,
       indexing_enabled=true,
       graduated_block=greatest(coalesce(public.campaigns.graduated_block, 0), excluded.graduated_block),
       graduated_at_chain=coalesce(public.campaigns.graduated_at_chain, excluded.graduated_at_chain),
       meta=coalesce(public.campaigns.meta,'{}'::jsonb) || excluded.meta,
       updated_at=now()`,
    [
      SOLANA_CHAIN_ID,
      programId(),
      event.campaign,
      event.mint,
      event.creator,
      "Solana Launch",
      "SOL",
      slot,
      graduatedAtChain,
      slot,
      graduatedAtChain,
      JSON.stringify({ source: "solana-v4-graduation", solanaGraduation: graduationMeta }),
    ],
  );

  await touchCampaignActivity(event.campaign, blockTime);
  await insertActivityEvent({
    eventType: "GRADUATED",
    txHash: signature,
    logIndex,
    blockNumber: slot,
    blockTime,
    actor: event.creator,
    campaign: event.campaign,
    token: event.mint,
    meta: graduationMeta,
  });
  void publishStats(SOLANA_CHAIN_ID, event.campaign, {
    type: "stats_patch",
    graduated: true,
    dex: "meteora-damm-v2",
    dexPool: event.meteoraPool,
    dexPosition: event.meteoraPosition,
    graduationLiquiditySol: toSol(event.liquidityLamports),
    graduationLiquidityTokensRaw: event.liquidityTokens.toString(),
    graduatedAt: graduatedAtChain.toISOString(),
    txHash: signature,
  }).catch(() => undefined);
  leagueFeed.queueActivity(SOLANA_CHAIN_ID, event.campaign, Math.floor(blockTime.getTime() / 1000));
}

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }>;
};

async function withFeeEscrowTransaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect() as Queryable & { query: (...args: any[]) => any; release: () => void };
  const origQuery = client.query.bind(client);
  client.query = (...args: any[]) => {
    if (typeof args[0] === "string") {
      return origQuery({ text: args[0], values: Array.isArray(args[1]) ? args[1] : undefined, simple: true });
    }
    if (args[0] && typeof args[0] === "object" && typeof args[0].text === "string") {
      return origQuery({ ...args[0], simple: true });
    }
    return origQuery.apply(client, args);
  };
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore rollback errors */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function insertFeeEscrowEvent(db: Queryable, input: {
  signature: string;
  logIndex: number;
  eventKind: string;
  campaign: string;
  escrow: string;
  weekly: string;
  monthly: string;
  recruiter: string;
  airdrop: string;
  squad: string;
  protocol: string;
  total: string;
}): Promise<boolean> {
  const inserted = await db.query(
    `insert into public.solana_fee_escrow_events(
       chain_id, tx_hash, log_index, event_kind, campaign_address, escrow_address,
       weekly_lamports, monthly_lamports, recruiter_lamports, airdrop_lamports,
       squad_lamports, protocol_lamports, total_lamports
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (chain_id, tx_hash, log_index, event_kind) do nothing
     returning id`,
    [
      SOLANA_CHAIN_ID,
      input.signature,
      input.logIndex,
      input.eventKind,
      input.campaign,
      input.escrow,
      input.weekly,
      input.monthly,
      input.recruiter,
      input.airdrop,
      input.squad,
      input.protocol,
      input.total,
    ],
  );
  return (inserted.rowCount ?? 0) > 0;
}

async function enqueueFeeEscrowInit(campaign: string) {
  const escrow = deriveFeeEscrowAddress(campaign);
  await pool.query(
    `insert into public.solana_fee_escrow_accruals(chain_id, campaign_address, escrow_address, init_status)
     values ($1, $2, $3, 'pending')
     on conflict (chain_id, campaign_address) do update set
       escrow_address = excluded.escrow_address,
       updated_at = now()`,
    [SOLANA_CHAIN_ID, campaign, escrow],
  ).catch((error) => {
    console.warn("[solana-indexer] fee escrow enqueue failed", error instanceof Error ? error.message : String(error));
  });
}

async function persistFeeAccrual(
  event: FeeSlicesAccruedEvent,
  signature: string,
  logIndex: number,
  blockTime: Date,
) {
  const escrow = deriveFeeEscrowAddress(event.campaign);
  await withFeeEscrowTransaction(async (db) => {
    const isNew = await insertFeeEscrowEvent(db, {
      signature,
      logIndex,
      eventKind: "FeeSlicesAccrued",
      campaign: event.campaign,
      escrow,
      weekly: event.weekly.toString(),
      monthly: event.monthly.toString(),
      recruiter: event.recruiter.toString(),
      airdrop: event.airdrop.toString(),
      squad: event.squad.toString(),
      protocol: event.protocol.toString(),
      total: event.feeLamports.toString(),
    });
    if (!isNew) return;
    await db.query(
      `insert into public.solana_fee_escrow_accruals(
         chain_id, campaign_address, escrow_address, init_status,
         weekly_accrued, monthly_accrued, recruiter_accrued, airdrop_accrued, squad_accrued, protocol_accrued,
         first_accrued_at, last_accrued_at, flush_status, updated_at
       ) values ($1,$2,$3,'initialized',$4,$5,$6,$7,$8,$9,$10,$10,'queued', now())
       on conflict (chain_id, campaign_address) do update set
         escrow_address = excluded.escrow_address,
         weekly_accrued = public.solana_fee_escrow_accruals.weekly_accrued + excluded.weekly_accrued,
         monthly_accrued = public.solana_fee_escrow_accruals.monthly_accrued + excluded.monthly_accrued,
         recruiter_accrued = public.solana_fee_escrow_accruals.recruiter_accrued + excluded.recruiter_accrued,
         airdrop_accrued = public.solana_fee_escrow_accruals.airdrop_accrued + excluded.airdrop_accrued,
         squad_accrued = public.solana_fee_escrow_accruals.squad_accrued + excluded.squad_accrued,
         protocol_accrued = public.solana_fee_escrow_accruals.protocol_accrued + excluded.protocol_accrued,
         first_accrued_at = coalesce(public.solana_fee_escrow_accruals.first_accrued_at, excluded.first_accrued_at),
         last_accrued_at = excluded.last_accrued_at,
         flush_status = 'queued',
         updated_at = now()`,
      [
        SOLANA_CHAIN_ID,
        event.campaign,
        escrow,
        event.weekly.toString(),
        event.monthly.toString(),
        event.recruiter.toString(),
        event.airdrop.toString(),
        event.squad.toString(),
        event.protocol.toString(),
        blockTime,
      ],
    );
  });
}

async function persistFeeEscrowInitialized(event: FeeEscrowInitializedEvent, signature: string, logIndex: number) {
  await withFeeEscrowTransaction(async (db) => {
    const isNew = await insertFeeEscrowEvent(db, {
      signature,
      logIndex,
      eventKind: "FeeEscrowInitialized",
      campaign: event.campaign,
      escrow: event.escrow,
      weekly: "0",
      monthly: "0",
      recruiter: "0",
      airdrop: "0",
      squad: "0",
      protocol: "0",
      total: "0",
    });
    if (!isNew) return;
    await db.query(
      `insert into public.solana_fee_escrow_accruals(
         chain_id, campaign_address, escrow_address, init_status, init_signature, updated_at
       ) values ($1,$2,$3,'initialized',$4, now())
       on conflict (chain_id, campaign_address) do update set
         escrow_address = excluded.escrow_address,
         init_status = 'initialized',
         init_signature = coalesce(public.solana_fee_escrow_accruals.init_signature, excluded.init_signature),
         updated_at = now()`,
      [SOLANA_CHAIN_ID, event.campaign, event.escrow, signature],
    );
  });
}

async function persistFeeEscrowFlushed(
  event: FeeEscrowFlushedEvent,
  signature: string,
  logIndex: number,
  blockTime: Date,
) {
  await withFeeEscrowTransaction(async (db) => {
    const isNew = await insertFeeEscrowEvent(db, {
      signature,
      logIndex,
      eventKind: "FeeEscrowFlushed",
      campaign: event.campaign,
      escrow: event.escrow,
      weekly: event.weekly.toString(),
      monthly: event.monthly.toString(),
      recruiter: event.recruiter.toString(),
      airdrop: event.airdrop.toString(),
      squad: event.squad.toString(),
      protocol: event.protocol.toString(),
      total: event.total.toString(),
    });
    if (!isNew) return;
    await db.query(
      `insert into public.solana_fee_escrow_accruals(
         chain_id, campaign_address, escrow_address, init_status,
         weekly_flushed, monthly_flushed, recruiter_flushed, airdrop_flushed, squad_flushed, protocol_flushed,
         last_flush_at, last_flush_signature, flush_status, updated_at
       ) values ($1,$2,$3,'initialized',$4,$5,$6,$7,$8,$9,$10,$11,'confirmed', now())
       on conflict (chain_id, campaign_address) do update set
         escrow_address = excluded.escrow_address,
         weekly_flushed = public.solana_fee_escrow_accruals.weekly_flushed + excluded.weekly_flushed,
         monthly_flushed = public.solana_fee_escrow_accruals.monthly_flushed + excluded.monthly_flushed,
         recruiter_flushed = public.solana_fee_escrow_accruals.recruiter_flushed + excluded.recruiter_flushed,
         airdrop_flushed = public.solana_fee_escrow_accruals.airdrop_flushed + excluded.airdrop_flushed,
         squad_flushed = public.solana_fee_escrow_accruals.squad_flushed + excluded.squad_flushed,
         protocol_flushed = public.solana_fee_escrow_accruals.protocol_flushed + excluded.protocol_flushed,
         last_flush_at = excluded.last_flush_at,
         last_flush_signature = excluded.last_flush_signature,
         flush_status = 'confirmed',
         updated_at = now()`,
      [
        SOLANA_CHAIN_ID,
        event.campaign,
        event.escrow,
        event.weekly.toString(),
        event.monthly.toString(),
        event.recruiter.toString(),
        event.airdrop.toString(),
        event.squad.toString(),
        event.protocol.toString(),
        blockTime,
        signature,
      ],
    );
  });
}

async function handleEvent(event: AnchorEvent, signature: string, logIndex: number, slot: number, blockTime: Date) {
  if (event.kind === "CampaignCreated") {
    await upsertCampaign(event, slot, blockTime, signature, logIndex);
    await enqueueFeeEscrowInit(event.campaign);
    return;
  }
  if (event.kind === "FeeEscrowInitialized") {
    await persistFeeEscrowInitialized(event, signature, logIndex);
    return;
  }
  if (event.kind === "FeeSlicesAccrued") {
    await persistFeeAccrual(event, signature, logIndex, blockTime);
    return;
  }
  if (event.kind === "FeeEscrowFlushed") {
    await persistFeeEscrowFlushed(event, signature, logIndex, blockTime);
    return;
  }
  if (event.kind === "CampaignGraduated") {
    await persistGraduation(event, signature, logIndex, slot, blockTime);
    return;
  }
  await insertTrade(event, signature, logIndex, slot, blockTime);
}

export async function backfillSolanaTradeCurveState(limit = 500) {
  const rows = await pool.query(
    `select campaign_address, tx_hash, log_index
       from public.curve_trades
      where chain_id=$1
        and sold_tokens_after_raw is null
      order by block_number asc, log_index asc
      limit $2`,
    [SOLANA_CHAIN_ID, Math.max(1, Math.min(5000, Number(limit || 500)))],
  );

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows.rows) {
    const signature = String(row.tx_hash || "").trim();
    const campaign = String(row.campaign_address || "").trim();
    const logIndex = Number(row.log_index);

    if (!signature || !campaign || !Number.isInteger(logIndex) || logIndex < 0) {
      skipped += 1;
      continue;
    }

    try {
      const tx = await getTransaction(signature);
      const events = decodeEvents(tx?.meta?.logMessages);
      const event = events[logIndex];

      if (
        !event ||
        (event.kind !== "TokensBought" && event.kind !== "TokensSold") ||
        event.campaign !== campaign
      ) {
        console.warn("[solana-backfill] event mismatch", {
          signature,
          campaign,
          logIndex,
          decodedKind: event?.kind ?? null,
          decodedCampaign:
            event && "campaign" in event ? event.campaign : null,
          decodedEvents: events.length,
        });
        skipped += 1;
        continue;
      }

      const result = await pool.query(
        `update public.curve_trades
            set sold_tokens_after_raw=$4
          where chain_id=$1
            and tx_hash=$2
            and log_index=$3
            and sold_tokens_after_raw is null
          returning tx_hash`,
        [
          SOLANA_CHAIN_ID,
          signature,
          logIndex,
          event.soldTokensAfter.toString(),
        ],
      );

      if ((result.rowCount ?? 0) > 0) updated += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      console.error("[solana-backfill] failed", {
        signature,
        campaign,
        logIndex,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const remaining = await pool.query(
    `select count(*)::int as count
       from public.curve_trades
      where chain_id=$1
        and sold_tokens_after_raw is null`,
    [SOLANA_CHAIN_ID],
  );

  return {
    scanned: rows.rowCount ?? 0,
    updated,
    skipped,
    failed,
    remaining: Number(remaining.rows[0]?.count ?? 0),
  };
}

async function ingestSignature(item: IndexedSignature): Promise<boolean> {
  let tx: RpcTransaction = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      tx = await getTransaction(item.signature);
      if (tx) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!tx) {
    console.warn("[solana-indexer] tx unavailable", {
      signature: item.signature,
      slot: item.slot,
      error: lastError instanceof Error ? lastError.message : String(lastError || "null"),
    });
    return false;
  }
  const events = decodeEvents(tx.meta?.logMessages);
  const blockTime = timestampFrom(tx.blockTime ?? null);
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    try {
      await handleEvent(events[eventIndex], item.signature, eventIndex, item.slot, blockTime);
    } catch (error) {
      console.warn("[solana-indexer] event failed", {
        signature: item.signature,
        eventIndex,
        error: error instanceof Error ? error.message : String(error),
      });
      // Do not abort remaining events — a failed FeeSlices row used to skip TokensBought/Sold.
    }
  }
  return true;
}

let lastLiveIngestMs = 0;
let lastBackfillMs = 0;
let lastTipSlot = 0;

async function runTipLane(head: number): Promise<void> {
  const signatures = await fetchTipSignatures();
  let maxOk = 0;
  for (const item of signatures) {
    const ok = await ingestSignature(item);
    if (ok) maxOk = Math.max(maxOk, item.slot);
  }
  if (maxOk > 0) {
    lastTipSlot = Math.max(lastTipSlot, maxOk);
    lastLiveIngestMs = Date.now();
    await pool.query(
      `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
       values ($1,$2,$3)
       on conflict (chain_id,cursor) do update
         set last_indexed_block = greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
             updated_at=now()`,
      [SOLANA_CHAIN_ID, "solana:v4:tip", Math.min(maxOk, head + 64)],
    );
  }
}

async function runBackfillLane(head: number): Promise<void> {
  const configuredStart = Number(ENV.SOLANA_START_SLOT || 0);
  const lookback = Math.max(1, Number(ENV.SOLANA_LOOKBACK_SLOTS || 50_000));
  const recovered = recoverFutureCursor({
    storedCursor: await getState(),
    head,
    startSlot: configuredStart,
    lookback,
  });
  if (recovered.corrupt) {
    console.warn("[solana-indexer] future cursor; resetting", {
      head,
      resetTo: recovered.cursor,
    });
    await resetState(recovered.cursor);
  }
  const checkpoint = recovered.cursor;
  const fetched = await fetchBackfillSignatures(checkpoint);
  const maxTxPerTick = Math.max(20, Math.min(200, Number(process.env.SOLANA_INDEXER_MAX_TX_PER_TICK || 80)));
  const processed: ProcessedSignature[] = [];
  for (const item of fetched.items.slice(0, maxTxPerTick)) {
    const ok = await ingestSignature(item);
    processed.push({ ...item, ok });
    if (!ok) break;
  }
  const next = nextBackfillCheckpoint({
    currentCheckpoint: checkpoint,
    reachedHistoricalFrontier: fetched.reachedHistoricalFrontier,
    processedOldestFirst: processed,
  });
  if (next > checkpoint) {
    await setState(Math.min(next, head + 64));
    lastBackfillMs = Date.now();
  } else if (checkpoint === 0 && fetched.reachedHistoricalFrontier) {
    await setState(Math.min(head, Math.max(checkpoint, configuredStart)));
  }
}

export async function runSolanaIndexerOnce() {
  await assertMainnetGenesis();
  const head = await getHeadSlot();
  await runTipLane(head);
  await runBackfillLane(head);
  const historical = await getState();
  console.log("[solana-indexer] health", {
    status: healthStatus({
      head,
      liveIndexedSlot: lastTipSlot || historical,
      historicalCheckpoint: historical,
      lastLiveIngestMs: lastLiveIngestMs || Date.now(),
      nowMs: Date.now(),
    }),
    head,
    liveIndexedSlot: lastTipSlot,
    historicalCheckpoint: historical,
    liveLag: Math.max(0, head - (lastTipSlot || 0)),
    backfillLag: Math.max(0, head - historical),
    lastLiveIngestMs,
    lastBackfillMs,
  });
}

let tipRunning = false;
let backfillRunning = false;
let started = false;

export function startSolanaIndexerLoop() {
  if (started) return;
  started = true;
  const tipMs = Math.max(2_000, Math.min(5_000, ENV.SOLANA_INDEXER_INTERVAL_MS || 10_000));
  const backfillMs = Math.max(tipMs, ENV.SOLANA_INDEXER_INTERVAL_MS || 10_000);

  console.log("[solana-indexer] enabled", {
    chainId: SOLANA_CHAIN_ID,
    programId: programId(),
    rpcCount: solanaRpcUrls().length,
    tipIntervalMs: tipMs,
    backfillIntervalMs: backfillMs,
  });

  const tipTick = async () => {
    if (tipRunning) return;
    tipRunning = true;
    try {
      await assertMainnetGenesis();
      await runTipLane(await getHeadSlot());
    } catch (error) {
      console.error("[solana-indexer] tip loop error", error);
    } finally {
      tipRunning = false;
    }
  };
  const backfillTick = async () => {
    if (backfillRunning) return;
    backfillRunning = true;
    try {
      await assertMainnetGenesis();
      const head = await getHeadSlot();
      await runBackfillLane(head);
      const historical = await getState();
      console.log("[solana-indexer] health", {
        status: healthStatus({
          head,
          liveIndexedSlot: lastTipSlot || historical,
          historicalCheckpoint: historical,
          lastLiveIngestMs: lastLiveIngestMs || Date.now(),
          nowMs: Date.now(),
        }),
        head,
        liveIndexedSlot: lastTipSlot,
        historicalCheckpoint: historical,
        liveLag: Math.max(0, head - (lastTipSlot || 0)),
        backfillLag: Math.max(0, head - historical),
        lastLiveIngestMs,
        lastBackfillMs,
      });
    } catch (error) {
      console.error("[solana-indexer] backfill loop error", error);
    } finally {
      backfillRunning = false;
    }
  };

  setTimeout(() => { void tipTick(); }, 1_000);
  setTimeout(() => { void backfillTick(); }, 2_000);
  setInterval(() => { void tipTick(); }, tipMs);
  setInterval(() => { void backfillTick(); }, backfillMs);
}
