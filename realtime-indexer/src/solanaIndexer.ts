import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { createCampaignLeaseRegistry, type CampaignLeaseState } from "./solanaCampaignLease.js";
import { createIndexerSql } from "./solanaRepairSql.js";
import { isDerivedFanoutSuppressed, runWithDerivedFanoutSuppressed } from "./derivedFanout.js";
import {
  campaignHistoryComplete,
  persistDecodedAnchorEvents,
  shouldMarkPdaSignatureProcessed,
} from "./solanaIngestResult.js";
import { repairStateFromBackfill } from "./solanaHistoryStatus.js";
import { checkMilestones } from "./milestones.js";
import { publishCandle, publishLeague, publishStats, publishTrade } from "./ably.js";
import { createLeagueFeedPublisher } from "./leagueFeed.js";
import { buildCampaignCreatedMessage } from "./solanaLeaguePublish.js";
import { candleUpsertPayload } from "./candlePublish.js";
import { TIMEFRAMES, bucketStart, type TF } from "./timeframes.js";
import {
  SOLANA_MAINNET_GENESIS,
  collectAccountSignatures,
  healthStatus,
  signatureScanFrontier,
  nextCampaignPdaCursor,
  nextBackfillCheckpoint,
  recoverFutureCursor,
  selectUnknownPdaTipSignatures,
  sortSignaturesAscending,
  type IndexedSignature,
  type ProcessedSignature,
} from "./solanaIndexerCheckpoint.js";

const SOLANA_CHAIN_ID = 101;
const leagueFeed = createLeagueFeedPublisher({ pool, flushMs: 500 });
leagueFeed.start();
const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const FALLBACK_SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://solana.drpc.org",
];
const DEFAULT_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const TOKEN_UNITS = 10 ** TOKEN_DECIMALS;
const PROGRAM_DATA_PREFIX = "Program data: ";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CAMPAIGN_BACKFILL_COOLDOWN_MS = 60_000;
const CAMPAIGN_TIP_COOLDOWN_MS = 8_000;
const CAMPAIGN_TIP_SIG_LIMIT = 40;
const CAMPAIGN_TIP_INGEST_MAX = 15;
const SOLANA_RPC_TIMEOUT_MS = 20_000;
const CAMPAIGN_BACKFILL_DEADLINE_MS = 90_000;
const CAMPAIGN_SIGNATURE_PAGE_CAP = Math.max(
  1,
  Math.min(32, Number(process.env.SOLANA_CAMPAIGN_SIGNATURE_PAGES_PER_TICK || 2)),
);
const CAMPAIGN_INGEST_MAX_PER_TICK = Math.max(
  5,
  Math.min(80, Number(process.env.SOLANA_CAMPAIGN_INGEST_MAX_PER_TICK || 40)),
);
const REPAIR_PG_STATEMENT_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.SOLANA_REPAIR_PG_STATEMENT_TIMEOUT_MS || 15_000),
);

const campaignLeases = createCampaignLeaseRegistry();
const campaignTipLastRunMs = new Map<string, number>();
const campaignTipInFlight = new Set<string>();
const repairSql = new AsyncLocalStorage<boolean>();

async function timedRepairQuery(text: string, values?: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query({
      text: `SET statement_timeout = ${REPAIR_PG_STATEMENT_TIMEOUT_MS}`,
      simple: true,
    } as any);
    return await client.query({ text, values, simple: true } as any);
  } finally {
    try {
      await client.query({ text: "RESET statement_timeout", simple: true } as any);
    } catch {
      // Connection may already be cancelled; still release.
    }
    client.release();
  }
}

const sql = createIndexerSql(pool, () => Boolean(repairSql.getStore()), timedRepairQuery);

let lastSolanaError: string | null = null;
let lastSolanaRepairAt: string | null = null;
let lastSolanaRepairSummary: Record<string, unknown> | null = null;

function noteSolanaError(message: string) {
  lastSolanaError = message;
}

export function solanaIndexerPublicHealth() {
  return {
    rpcConfigured: Boolean(String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || "").trim()),
    rpcEndpointCount: solanaRpcUrls().length,
    lastError: lastSolanaError,
    lastRepairAt: lastSolanaRepairAt,
    lastRepair: lastSolanaRepairSummary,
    leases: campaignLeases.list(),
  };
}

export function isSolanaCampaignRepairRunning(campaign: string): boolean {
  return campaignLeases.get(String(campaign || "").trim())?.status === "running";
}

async function persistSolanaHistoryMeta(
  campaign: string,
  result: {
    skipped?: boolean;
    incomplete?: boolean;
    failed?: number;
    reachedCreationSlot?: boolean;
    createdSlot?: number;
    trades?: number;
    candles?: number;
    scanBefore?: string | null;
    scanOldestSlot?: number | null;
  },
) {
  const derived = repairStateFromBackfill(result);
  if (!derived) return;
  await pool.query(
    `update public.campaigns
        set meta = coalesce(meta, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
      where chain_id=$1 and campaign_address=$2`,
    [
      SOLANA_CHAIN_ID,
      campaign,
      JSON.stringify({
        solanaHistory: {
          historyComplete: derived.historyComplete,
          repairState: derived.repairState,
          creationSlot: Number(result.createdSlot || 0) || null,
          tradeCount: Number(result.trades || 0),
          candleCount: Number(result.candles || 0),
          scanBefore: result.scanBefore || null,
          scanOldestSlot: result.scanOldestSlot ?? null,
          at: new Date().toISOString(),
        },
      }),
    ],
  );
}

async function loadSolanaHistoryMeta(campaign: string): Promise<{
  historyComplete?: boolean;
  repairState?: string | null;
  scanBefore?: string | null;
  scanOldestSlot?: number | null;
  creationSlot?: number | null;
}> {
  const result = await sql(
    `select meta from public.campaigns where chain_id=$1 and campaign_address=$2`,
    [SOLANA_CHAIN_ID, campaign],
  );
  const stored = (result.rows[0]?.meta as { solanaHistory?: Record<string, unknown> } | null)?.solanaHistory || {};
  return {
    historyComplete: stored.historyComplete === true,
    repairState: stored.repairState != null ? String(stored.repairState) : null,
    scanBefore: stored.scanBefore ? String(stored.scanBefore) : null,
    scanOldestSlot: stored.scanOldestSlot != null ? Number(stored.scanOldestSlot) : null,
    creationSlot: stored.creationSlot != null ? Number(stored.creationSlot) : null,
  };
}

function expireStaleCampaignLeases() {
  const expired = campaignLeases.expireStale(CAMPAIGN_BACKFILL_DEADLINE_MS + 5_000);
  if (expired.length) {
    console.warn("[solana-indexer] expired stale campaign leases", { campaigns: expired });
  }
  return expired;
}
const campaignBackfillLastRunMs = new Map<string, number>();
let athColumnReady = false;

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
  const configured = parseRpcList(String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || "").trim());
  const urls = configured.length ? [...configured] : [];
  for (const fallback of FALLBACK_SOLANA_RPCS) {
    if (!urls.includes(fallback)) urls.push(fallback);
  }
  if (!urls.length) urls.push(DEFAULT_SOLANA_RPC);
  return urls;
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

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("aborted");
  error.name = "AbortError";
  throw error;
}

function mergeAbortSignals(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onParentAbort = () => ac.abort();
  if (parent?.aborted) {
    clearTimeout(timer);
    ac.abort();
    return { signal: ac.signal, cleanup: () => undefined };
  }
  parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: ac.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function runWithAbortDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const timedOut = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(`${label} timed out after ${ms}ms`));
    if (ac.signal.aborted) fail();
    else ac.signal.addEventListener("abort", fail, { once: true });
  });
  const running = work(ac.signal);
  try {
    throwIfAborted(ac.signal);
    return await Promise.race([running, timedOut]);
  } finally {
    clearTimeout(timer);
    void running.catch(() => undefined);
  }
}

async function rpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let lastError: unknown;
  for (const url of solanaRpcUrls()) {
    throwIfAborted(signal);
    const merged = mergeAbortSignals(signal, SOLANA_RPC_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: merged.signal,
      });
      if (!response.ok) throw new Error(`Solana RPC ${method} HTTP ${response.status}`);
      const payload = await response.json() as { result?: T; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message || `Solana RPC ${method} failed`);
      return payload.result as T;
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      lastError = aborted ? new Error(`Solana RPC ${method} timed out after ${SOLANA_RPC_TIMEOUT_MS}ms`) : error;
      noteSolanaError(lastError instanceof Error ? lastError.message : String(lastError));
      console.warn("[solana-indexer] RPC endpoint failed", {
        method,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
    } finally {
      merged.cleanup();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `Solana RPC ${method} failed`));
}

async function getState(): Promise<number> {
  const result = await sql(
    `select last_indexed_block from public.indexer_state where chain_id=$1 and cursor=$2`,
    [SOLANA_CHAIN_ID, "solana:v4:program"],
  );
  return result.rowCount ? Number(result.rows[0].last_indexed_block) : 0;
}

async function setState(nextSlot: number) {
  await sql(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict (chain_id,cursor) do update
       set last_indexed_block = greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
           updated_at=now()`,
    [SOLANA_CHAIN_ID, "solana:v4:program", nextSlot],
  );
}

async function resetState(nextSlot: number) {
  await sql(
    `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
     values($1,$2,$3)
     on conflict (chain_id,cursor) do update
       set last_indexed_block = excluded.last_indexed_block,
           updated_at=now()`,
    [SOLANA_CHAIN_ID, "solana:v4:program", nextSlot],
  );
}

async function getHeadSlot(signal?: AbortSignal): Promise<number> {
  return rpc<number>("getSlot", [{ commitment: "confirmed" }], signal);
}

let genesisChecked = false;
async function assertMainnetGenesis(signal?: AbortSignal): Promise<void> {
  if (genesisChecked) {
    throwIfAborted(signal);
    return;
  }
  const genesis = await rpc<string>("getGenesisHash", [], signal);
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

async function getTransaction(signature: string, signal?: AbortSignal): Promise<RpcTransaction> {
  return rpc<RpcTransaction>("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ], signal);
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
  await sql(
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
  if (!isDerivedFanoutSuppressed()) {
    void publishLeague(
      SOLANA_CHAIN_ID,
      "campaign_created",
      buildCampaignCreatedMessage(event, slot, blockTime),
    ).catch(() => {});
  }
}

async function touchCampaignActivity(campaign: string, at: Date) {
  await sql(
    `insert into public.campaign_activity (chain_id, campaign_address, last_activity_at, updated_at)
     values ($1, $2, $3, now())
     on conflict (chain_id, campaign_address) do update set
       last_activity_at = greatest(excluded.last_activity_at, coalesce(public.campaign_activity.last_activity_at, to_timestamp(0))),
       updated_at = now()`,
    [SOLANA_CHAIN_ID, campaign, at],
  ).catch((error: unknown) => {
    const msg = String((error as any)?.message || error);
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
  await sql(
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
  ).catch((error: unknown) => {
    const msg = String((error as any)?.message || error);
    if (!msg.includes("activity_events")) console.warn("[solana-indexer] activity insert failed", msg);
  });
}

async function upsertCandle(campaign: string, tf: TF, bucketSec: number, priceSol: number, volumeSol: number, soldWhole = 0) {
  const mcapSol = Number.isFinite(soldWhole) && soldWhole > 0 ? priceSol * soldWhole : null;
  const written = await sql(
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

async function ensureAthColumn() {
  if (athColumnReady) return;
  await sql(
    `alter table public.token_stats add column if not exists ath_marketcap_bnb double precision`,
  );
  athColumnReady = true;
}

async function patchStats(campaign: string) {
  const latest = await sql(
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

  await sql(
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

  let athMarketcap = marketcap;
  try {
    await ensureAthColumn();
    const ath = await sql(
      `update public.token_stats as s
          set ath_marketcap_bnb = greatest(
            coalesce(s.ath_marketcap_bnb, 0),
            coalesce($3::double precision, 0),
            coalesce((
              select max(mcap_h)
                from public.token_candles
               where chain_id=$1 and campaign_address=$2 and mcap_h is not null
            ), 0)
          )
        where s.chain_id=$1 and s.campaign_address=$2
        returning s.ath_marketcap_bnb`,
      [SOLANA_CHAIN_ID, campaign, marketcap],
    );
    const indexedAth = Number(ath.rows[0]?.ath_marketcap_bnb);
    if (Number.isFinite(indexedAth) && indexedAth > 0) athMarketcap = indexedAth;
  } catch (error) {
    console.warn(
      "[solana-indexer] ATH update skipped",
      campaign,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (isDerivedFanoutSuppressed()) return;

  void publishStats(SOLANA_CHAIN_ID, campaign, {
    type: "stats_patch",
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    marketcapBnb: marketcap !== null ? String(marketcap) : null,
    vol24hBnb: String(vol24h),
    athMarketcapBnb: athMarketcap !== null ? String(athMarketcap) : null,
  }).catch(() => undefined);

  leagueFeed.queueStats(SOLANA_CHAIN_ID, campaign, {
    lastPriceBnb: lastPrice !== null ? String(lastPrice) : null,
    marketcapBnb: marketcap !== null ? String(marketcap) : null,
    vol24hBnb: String(vol24h),
    athMarketcapBnb: athMarketcap !== null ? String(athMarketcap) : null,
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
  const completedPartial = await sql(
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
    const duplicate = await sql(
      `select tx_hash
         from public.curve_trades
        where chain_id=$1 and tx_hash=$2 and campaign_address=$3 and side=$4
          and sold_tokens_after_raw=$5
        limit 1`,
      [
        SOLANA_CHAIN_ID,
        signature,
        campaign,
        isBuy ? "buy" : "sell",
        event.soldTokensAfter.toString(),
      ],
    );
    if ((duplicate.rowCount ?? 0) > 0) {
      if (!isDerivedFanoutSuppressed()) await patchStats(campaign);
      return;
    }
    const inserted = await sql(
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
  if (!isDerivedFanoutSuppressed()) {
    void publishTrade(SOLANA_CHAIN_ID, campaign, realtimeRow).catch(() => undefined);
  }

  if (!firstFanout) {
    if (!isDerivedFanoutSuppressed()) await patchStats(campaign);
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

  if (isDerivedFanoutSuppressed()) return;

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

  await sql(
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
  leagueFeed.queueGraduation(SOLANA_CHAIN_ID, event.campaign, graduatedAtChain.toISOString());
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
  await sql(
    `insert into public.solana_fee_escrow_accruals(chain_id, campaign_address, escrow_address, init_status)
     values ($1, $2, $3, 'pending')
     on conflict (chain_id, campaign_address) do update set
       escrow_address = excluded.escrow_address,
       updated_at = now()`,
    [SOLANA_CHAIN_ID, campaign, escrow],
  ).catch((error: unknown) => {
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
  const rows = await sql(
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

      const result = await sql(
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

  const remaining = await sql(
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

async function ingestSignature(item: IndexedSignature, signal?: AbortSignal) {
  throwIfAborted(signal);
  let tx: RpcTransaction = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    try {
      tx = await getTransaction(item.signature, signal);
      if (tx) break;
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      lastError = error;
    }
  }
  if (!tx) {
    console.warn("[solana-indexer] tx unavailable", {
      signature: item.signature,
      slot: item.slot,
      error: lastError instanceof Error ? lastError.message : String(lastError || "null"),
    });
    return {
      fetched: false,
      decodedEvents: 0,
      tradeEvents: 0,
      persistedTradeEvents: 0,
      failedEvents: 0,
      retryableFailure: true,
    };
  }
  const events = decodeEvents(tx.meta?.logMessages);
  const blockTime = timestampFrom(tx.blockTime ?? null);
  const slot = Number(tx.slot || item.slot || 0);
  const persisted = await persistDecodedAnchorEvents({
    events,
    persistEvent: async (event, eventIndex) => {
      try {
        await handleEvent(events[eventIndex], item.signature, eventIndex, slot, blockTime);
      } catch (error) {
        console.warn("[solana-indexer] event failed", {
          signature: item.signature,
          eventIndex,
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });
  return {
    fetched: true,
    ...persisted,
  };
}

function isSolanaPublicKey(value: string): boolean {
  if (!SOLANA_ADDRESS_RE.test(value)) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

async function fetchSignaturesForAccount(
  address: string,
  fromSlot: number,
  head: number,
  signal?: AbortSignal,
  opts?: { before?: string | null; pageCap?: number },
): Promise<{
  items: IndexedSignature[];
  reachedCreationSlot: boolean;
  incomplete: boolean;
  pagesScanned: number;
  nextBefore: string | null;
  oldestSlot: number | null;
}> {
  const pages: RpcSignature[][] = [];
  let before: string | undefined = opts?.before || undefined;
  const limit = signatureLimit();
  const pageCap = Math.max(1, Math.min(CAMPAIGN_SIGNATURE_PAGE_CAP, Number(opts?.pageCap || CAMPAIGN_SIGNATURE_PAGE_CAP)));
  let reachedCreationSlot = false;
  let incomplete = false;

  for (let page = 0; page < pageCap; page += 1) {
    throwIfAborted(signal);
    const batch = await rpc<RpcSignature[]>("getSignaturesForAddress", [
      address,
      { limit, ...(before ? { before } : {}) },
    ], signal);
    if (!Array.isArray(batch) || !batch.length) {
      pages.push([]);
      reachedCreationSlot = true;
      incomplete = false;
      break;
    }
    pages.push(batch);
    const last = batch[batch.length - 1];
    const frontier = signatureScanFrontier({
      emptyBatch: false,
      lastSlot: last?.slot ?? null,
      fromSlot,
      pagesScanned: page + 1,
      pageCap,
      shortPage: batch.length < limit,
    });
    if (frontier.reachedCreationSlot) {
      reachedCreationSlot = true;
      incomplete = false;
      break;
    }
    if (frontier.incomplete) {
      incomplete = true;
      reachedCreationSlot = false;
      break;
    }
    before = last.signature;
  }

  if (pages.length >= pageCap && !reachedCreationSlot) incomplete = true;
  const lastPage = pages[pages.length - 1] || [];
  const last = lastPage[lastPage.length - 1];
  const cursor = nextCampaignPdaCursor({
    previousBefore: opts?.before,
    lastSignature: last?.signature,
    lastSlot: last?.slot,
    reachedCreationSlot,
  });

  return {
    items: collectAccountSignatures({ pages, fromSlot, head }).items,
    reachedCreationSlot,
    incomplete,
    pagesScanned: pages.length,
    nextBefore: cursor.beforeSignature,
    oldestSlot: cursor.oldestSlot,
  };
}

let pdaScanTableReady = false;
async function ensurePdaScanTable() {
  if (pdaScanTableReady) return;
  await sql(
    `create table if not exists public.solana_pda_scan_sigs (
       chain_id integer not null,
       campaign_address text not null,
       tx_hash text not null,
       processed_at timestamptz not null default now(),
       primary key (chain_id, campaign_address, tx_hash)
     )`,
  );
  pdaScanTableReady = true;
}

async function existingCampaignTradeSignatures(campaign: string, signatures: string[]): Promise<Set<string>> {
  if (!signatures.length) return new Set();
  await ensurePdaScanTable();
  const result = await sql(
    `select tx_hash from public.curve_trades
      where chain_id=$1 and campaign_address=$2 and tx_hash = any($3::text[])
     union
     select tx_hash from public.solana_pda_scan_sigs
      where chain_id=$1 and campaign_address=$2 and tx_hash = any($3::text[])`,
    [SOLANA_CHAIN_ID, campaign, signatures],
  );
  return new Set(result.rows.map((row: { tx_hash?: string }) => String(row.tx_hash || "")).filter(Boolean));
}

async function markPdaSignaturesProcessed(campaign: string, signatures: string[]) {
  if (!signatures.length) return;
  await ensurePdaScanTable();
  for (const signature of signatures) {
    await sql(
      `insert into public.solana_pda_scan_sigs(chain_id,campaign_address,tx_hash)
       values ($1,$2,$3)
       on conflict do nothing`,
      [SOLANA_CHAIN_ID, campaign, signature],
    );
  }
}

async function listBondingSolanaCampaigns(limit = 40): Promise<string[]> {
  const result = await sql(
    `select campaign_address
       from public.campaigns
      where chain_id=$1
        and is_active=true
        and graduated_at_chain is null
      order by updated_at desc nulls last
      limit $2`,
    [SOLANA_CHAIN_ID, Math.max(1, Math.min(80, Number(limit || 40)))],
  );
  return result.rows
    .map((row: { campaign_address?: string }) => String(row.campaign_address || "").trim())
    .filter((address: string) => isSolanaPublicKey(address));
}

/** Newest-page PDA ingest. History-complete campaigns still receive later buys. */
export async function ingestSolanaCampaignTip(
  campaignAddress: string,
  signal?: AbortSignal,
  opts?: { force?: boolean },
): Promise<{ campaign: string; scanned: number; unknown: number; ingested: number; trades: number }> {
  const campaign = String(campaignAddress || "").trim();
  const empty = { campaign, scanned: 0, unknown: 0, ingested: 0, trades: 0 };
  if (!isSolanaPublicKey(campaign)) return empty;
  throwIfAborted(signal);
  const last = campaignTipLastRunMs.get(campaign) || 0;
  if (!opts?.force && Date.now() - last < CAMPAIGN_TIP_COOLDOWN_MS) return empty;
  if (campaignTipInFlight.has(campaign)) return empty;
  campaignTipInFlight.add(campaign);
  try {
    const batch = await rpc<Array<{ signature: string; slot: number; err?: unknown | null }>>(
      "getSignaturesForAddress",
      [campaign, { limit: CAMPAIGN_TIP_SIG_LIMIT }],
      signal,
    );
    const signatures = Array.isArray(batch) ? batch : [];
    const known = await existingCampaignTradeSignatures(
      campaign,
      signatures.map((item) => String(item?.signature || "")).filter(Boolean),
    );
    const unknown = selectUnknownPdaTipSignatures({
      signatures,
      known,
      limit: CAMPAIGN_TIP_INGEST_MAX,
    });
    let ingested = 0;
    let trades = 0;
    const processed: string[] = [];
    for (const item of unknown) {
      throwIfAborted(signal);
      try {
        const result = await ingestSignature(item, signal);
        if (result.fetched) ingested += 1;
        trades += Number(result.persistedTradeEvents || 0);
        if (shouldMarkPdaSignatureProcessed(result)) processed.push(item.signature);
      } catch (error) {
        console.warn(
          "[solana-indexer] campaign tip signature failed",
          { campaign, signature: item.signature, error: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    await markPdaSignaturesProcessed(campaign, processed);
    campaignTipLastRunMs.set(campaign, Date.now());
    if (trades > 0) {
      console.log("[solana-indexer] campaign tip ingested trades", {
        campaign,
        scanned: signatures.length,
        unknown: unknown.length,
        ingested,
        trades,
      });
    }
    return { campaign, scanned: signatures.length, unknown: unknown.length, ingested, trades };
  } finally {
    campaignTipInFlight.delete(campaign);
  }
}

export async function ingestSolanaSignatures(
  campaignAddress: string,
  signatures: string[],
): Promise<{ ok: true; campaign: string; scanned: number; ingested: number; trades: number }> {
  const campaign = String(campaignAddress || "").trim();
  const unique = [...new Set(
    (signatures || [])
      .map((value) => String(value || "").trim())
      .filter((value) => /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(value)),
  )].slice(0, 20);
  let ingested = 0;
  let trades = 0;
  const processed: string[] = [];
  for (const signature of unique) {
    try {
      const result = await ingestSignature({ signature, slot: 0, err: null });
      if (result.fetched) ingested += 1;
      trades += Number(result.persistedTradeEvents || 0);
      if (shouldMarkPdaSignatureProcessed(result)) processed.push(signature);
    } catch (error) {
      console.warn("[solana-indexer] signature ingest failed", {
        campaign,
        signature,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (isSolanaPublicKey(campaign)) await markPdaSignaturesProcessed(campaign, processed);
  return { ok: true, campaign, scanned: unique.length, ingested, trades };
}

export function kickSolanaCampaignTipIngest(campaignAddress: string): void {
  const campaign = String(campaignAddress || "").trim();
  if (!isSolanaPublicKey(campaign)) return;
  void ingestSolanaCampaignTip(campaign).catch((error) => {
    console.warn(
      "[solana-indexer] campaign tip ingest failed",
      campaign,
      error instanceof Error ? error.message : String(error),
    );
  });
}

async function dedupeSolanaCurveTrades(campaign?: string): Promise<string[]> {
  const params: unknown[] = [SOLANA_CHAIN_ID];
  const campaignFilter = campaign
    ? (params.push(campaign), "and a.campaign_address=$2 and b.campaign_address=$2")
    : "";
  const result = await sql(
    `delete from public.curve_trades a
      using public.curve_trades b
     where a.chain_id=$1 and b.chain_id=$1
       ${campaignFilter}
       and a.campaign_address=b.campaign_address
       and a.tx_hash=b.tx_hash
       and a.side=b.side
       and a.sold_tokens_after_raw is not distinct from b.sold_tokens_after_raw
       and a.log_index < b.log_index
     returning a.campaign_address`,
    params,
  );
  const campaigns = new Set<string>();
  for (const row of result.rows as Array<{ campaign_address?: string }>) {
    const address = String(row.campaign_address || "").trim();
    if (address) campaigns.add(address);
  }
  return [...campaigns];
}

export async function rebuildSolanaDerivedFromTrades(campaign: string) {
  const normalized = String(campaign || "").trim();
  await dedupeSolanaCurveTrades(normalized);
  const started = await sql(`select clock_timestamp() as rebuild_started_at`);
  const rebuildStartedAt = started.rows[0]?.rebuild_started_at;
  const { materializeCanonicalCandles } = await import("./canonicalCandleMaterializer.js");
  const candles = await materializeCanonicalCandles(SOLANA_CHAIN_ID, normalized);
  await sql(
    `delete from public.token_candles
      where chain_id=$1 and campaign_address=$2
        and coalesce(dex_trade_count, 0)=0
        and coalesce(canonical_updated_at, to_timestamp(0)) < $3::timestamptz`,
    [SOLANA_CHAIN_ID, normalized, rebuildStartedAt],
  );
  await patchStats(normalized);
  const trades = await sql(
    `select count(*)::int as count
       from public.curve_trades
      where chain_id=$1 and campaign_address=$2`,
    [SOLANA_CHAIN_ID, normalized],
  );
  return {
    trades: Number(trades.rows[0]?.count ?? 0),
    candles: Number(candles.candles ?? 0),
  };
}

function combineAbortSignals(parent?: AbortSignal, child?: AbortSignal): AbortSignal | undefined {
  if (!parent) return child;
  if (!child) return parent;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (parent.aborted || child.aborted) {
    ac.abort();
    return ac.signal;
  }
  parent.addEventListener("abort", onAbort, { once: true });
  child.addEventListener("abort", onAbort, { once: true });
  return ac.signal;
}

async function runWithRepairSql<T>(fn: () => Promise<T>): Promise<T> {
  // Flag only — never hold a pool client across Solana RPC.
  return repairSql.run(true, fn);
}

export async function backfillSolanaCampaign(campaignAddress: string, signal?: AbortSignal) {
  const campaign = String(campaignAddress || "").trim();
  if (!isSolanaPublicKey(campaign)) {
    throw new Error("solana campaign PDA required");
  }
  throwIfAborted(signal);
  expireStaleCampaignLeases();
  const stored = await loadSolanaHistoryMeta(campaign);
  if (stored.historyComplete && stored.repairState === "complete") {
    return {
      campaign,
      createdSlot: Number(stored.creationSlot || 0),
      head: 0,
      scanned: 0,
      ingested: 0,
      failed: 0,
      trades: 0,
      candles: 0,
      reachedCreationSlot: true,
      incomplete: false,
      pagesScanned: 0,
      skipped: true,
      alreadyComplete: true,
      runId: null,
    };
  }
  const lease = campaignLeases.begin(campaign);
  if (!lease) {
    return {
      campaign,
      createdSlot: Number(stored.creationSlot || 0),
      head: 0,
      scanned: 0,
      ingested: 0,
      failed: 0,
      trades: 0,
      candles: 0,
      reachedCreationSlot: false,
      incomplete: true,
      pagesScanned: 0,
      skipped: true,
      runId: campaignLeases.get(campaign)?.runId ?? null,
    };
  }

  const runSignal = combineAbortSignals(signal, lease.abort.signal);
  let status: CampaignLeaseState = "failed";
  let createdSlot = Number(stored.creationSlot || 0);
  let scanBefore = stored.scanBefore || null;
  let scanOldestSlot = stored.scanOldestSlot ?? null;
  const persistProgress = async (extra: Record<string, unknown>) => {
    await persistSolanaHistoryMeta(campaign, {
      skipped: false,
      incomplete: extra.incomplete === true,
      failed: Number(extra.failed || 0),
      reachedCreationSlot: extra.reachedCreationSlot === true,
      createdSlot,
      trades: Number(extra.trades || 0),
      candles: Number(extra.candles || 0),
      scanBefore,
      scanOldestSlot,
    }).catch(() => undefined);
  };
  try {
    const result = await runWithRepairSql(async () => {
      await assertMainnetGenesis(runSignal);
      throwIfAborted(runSignal);
      const head = await getHeadSlot(runSignal);
      const created = await sql(
        `select created_block
           from public.campaigns
          where chain_id=$1 and campaign_address=$2`,
        [SOLANA_CHAIN_ID, campaign],
      );
      createdSlot = Number(created.rows[0]?.created_block || createdSlot || 0);
      const fetched = await fetchSignaturesForAccount(
        campaign,
        Number.isFinite(createdSlot) && createdSlot > 0 ? createdSlot : 0,
        head,
        runSignal,
        { before: scanBefore, pageCap: CAMPAIGN_SIGNATURE_PAGE_CAP },
      );
      if (!(createdSlot > 0) && fetched.items.length) createdSlot = fetched.items[0].slot;
      const window = createdSlot > 0 ? fetched.items.filter((item) => item.slot >= createdSlot) : fetched.items;
      const known = await existingCampaignTradeSignatures(
        campaign,
        window.map((item) => item.signature),
      );
      const unknown = window.filter((item) => !known.has(item.signature));
      const pending = unknown.slice(0, CAMPAIGN_INGEST_MAX_PER_TICK);
      const ingestCapped = pending.length < unknown.length;

      let ingested = 0;
      let failed = 0;
      const processed: string[] = [];
      await runWithDerivedFanoutSuppressed(async () => {
        for (const item of pending) {
          throwIfAborted(runSignal);
          const result = await ingestSignature(item, runSignal);
          if (result.fetched) ingested += 1;
          if (result.retryableFailure) failed += 1;
          if (shouldMarkPdaSignatureProcessed(result)) processed.push(item.signature);
        }
      });
      await markPdaSignaturesProcessed(campaign, processed);

      throwIfAborted(runSignal);
      const retryableFailures = failed;
      const unprocessedInWindow = unknown.length - processed.length;
      if (!ingestCapped && retryableFailures === 0) {
        scanBefore = fetched.nextBefore;
        scanOldestSlot = fetched.oldestSlot;
      }
      const reachedCreationSlot = campaignHistoryComplete({
        reachedCreationSlot: fetched.reachedCreationSlot,
        ingestCapped,
        retryableFailures,
        unprocessedInWindow,
      });
      const rebuilt = reachedCreationSlot
        ? await rebuildSolanaDerivedFromTrades(campaign)
        : { trades: 0, candles: 0 };
      return {
        campaign,
        createdSlot,
        head,
        scanned: window.length,
        ingested,
        skippedKnown: known.size,
        failed: retryableFailures,
        trades: rebuilt.trades,
        candles: rebuilt.candles,
        reachedCreationSlot,
        incomplete: !reachedCreationSlot,
        pagesScanned: fetched.pagesScanned,
        scanBefore,
        scanOldestSlot,
        skipped: false,
        runId: lease.runId,
      };
    });
    status = runSignal?.aborted ? "timeout" : "success";
    await persistSolanaHistoryMeta(campaign, result).catch(() => undefined);
    return result;
  } catch (error) {
    status = runSignal?.aborted || (error instanceof Error && /timed out/i.test(error.message))
      ? "timeout"
      : "failed";
    await persistProgress({
      incomplete: true,
      failed: 1,
      reachedCreationSlot: false,
    });
    throw error;
  } finally {
    if (!lease.abort.signal.aborted) lease.abort.abort();
    campaignLeases.release(campaign, lease.runId, status);
  }
}

export function kickSolanaCampaignHistoryBackfill(campaignAddress: string): void {
  const campaign = String(campaignAddress || "").trim();
  if (!isSolanaPublicKey(campaign)) {
    console.warn("[solana-indexer] campaign history backfill skipped; invalid PDA", campaign);
    return;
  }
  expireStaleCampaignLeases();
  if (campaignLeases.get(campaign)?.status === "running") return;
  const last = campaignBackfillLastRunMs.get(campaign) || 0;
  if (Date.now() - last < CAMPAIGN_BACKFILL_COOLDOWN_MS) return;
  void (async () => {
    const stored = await loadSolanaHistoryMeta(campaign);
    if (stored.historyComplete && stored.repairState === "complete") return;
    if (campaignLeases.get(campaign)?.status === "running") return;
    console.log("[solana-indexer] campaign history backfill start", campaign);
    try {
      const result = await runWithAbortDeadline(
        (signal) => backfillSolanaCampaign(campaign, signal),
        CAMPAIGN_BACKFILL_DEADLINE_MS,
        `solana campaign backfill ${campaign}`,
      );
      campaignBackfillLastRunMs.set(campaign, Date.now());
      console.log("[solana-indexer] campaign history backfill", result);
    } catch (error) {
      console.warn(
        "[solana-indexer] campaign history backfill failed",
        campaign,
        error instanceof Error ? error.message : String(error),
      );
    }
  })().catch((error) => {
    console.warn(
      "[solana-indexer] campaign history backfill kick failed",
      campaign,
      error instanceof Error ? error.message : String(error),
    );
  });
}

let campaignRepairRunning = false;

export async function repairKnownSolanaCampaignHistory() {
  if (campaignRepairRunning) return [];
  campaignRepairRunning = true;
  try {
    expireStaleCampaignLeases();
    const duplicated = await dedupeSolanaCurveTrades();
    const rows = await sql(
      `select campaign_address, meta
         from public.campaigns
        where chain_id=$1
        order by created_block asc nulls last, campaign_address asc`,
      [SOLANA_CHAIN_ID],
    );
    for (const campaign of duplicated) {
      try {
        const rebuilt = await rebuildSolanaDerivedFromTrades(campaign);
        console.log("[solana-indexer] duplicate trades removed", { campaign, ...rebuilt });
      } catch (error) {
        console.warn(
          "[solana-indexer] duplicate-trade rebuild failed",
          campaign,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const results: Array<Record<string, unknown>> = [];
    for (const row of rows.rows) {
      const campaign = String(row.campaign_address || "").trim();
      if (!isSolanaPublicKey(campaign)) continue;
      try {
        const result = await runWithAbortDeadline(
          (signal) => backfillSolanaCampaign(campaign, signal),
          CAMPAIGN_BACKFILL_DEADLINE_MS,
          `solana campaign backfill ${campaign}`,
        );
        results.push(result);
        console.log("[solana-indexer] campaign history repair", result);
      } catch (error) {
        results.push({
          campaign,
          error: error instanceof Error ? error.message : String(error),
        });
        const message = error instanceof Error ? error.message : String(error);
        noteSolanaError(`${campaign}: ${message}`);
        console.warn(
          "[solana-indexer] campaign history repair failed",
          campaign,
          message,
        );
      }
    }
    lastSolanaRepairAt = new Date().toISOString();
    lastSolanaRepairSummary = {
      campaigns: results.length,
      ok: results.filter((row) => !row.error && (row.alreadyComplete || (!row.skipped && !row.incomplete))).length,
      skipped: results.filter((row) => row.skipped).length,
      failed: results.filter((row) => row.error).length,
      incomplete: results.filter((row) => row.incomplete).length,
      trades: results.reduce((sum, row) => sum + Number(row.trades || 0), 0),
    };
    if (lastSolanaRepairSummary.failed === 0 && results.length) lastSolanaError = null;
    return results;
  } finally {
    campaignRepairRunning = false;
  }
}

let lastLiveIngestMs = 0;
let lastBackfillMs = 0;
let lastTipSlot = 0;

async function runTipLane(head: number): Promise<void> {
  const signatures = await fetchTipSignatures();
  let maxOk = 0;
  for (const item of signatures) {
    const result = await ingestSignature(item);
    if (result.fetched && !result.retryableFailure) maxOk = Math.max(maxOk, item.slot);
  }
  await runCampaignPdaTipLane();
  if (maxOk > 0) {
    lastTipSlot = Math.max(lastTipSlot, maxOk);
    lastLiveIngestMs = Date.now();
    await sql(
      `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
       values ($1,$2,$3)
       on conflict (chain_id,cursor) do update
         set last_indexed_block = greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
             updated_at=now()`,
      [SOLANA_CHAIN_ID, "solana:v4:tip", Math.min(maxOk, head + 64)],
    );
  }
}

async function runCampaignPdaTipLane(): Promise<void> {
  const deadline = Date.now() + 12_000;
  let campaigns: string[] = [];
  try {
    campaigns = await listBondingSolanaCampaigns(40);
  } catch (error) {
    console.warn(
      "[solana-indexer] list bonding campaigns for tip failed",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  for (const campaign of campaigns) {
    if (Date.now() >= deadline) break;
    try {
      await ingestSolanaCampaignTip(campaign);
    } catch (error) {
      console.warn(
        "[solana-indexer] campaign tip failed",
        campaign,
        error instanceof Error ? error.message : String(error),
      );
    }
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
    const result = await ingestSignature(item);
    const ok = result.fetched && !result.retryableFailure;
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
      expireStaleCampaignLeases();
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
      expireStaleCampaignLeases();
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
  setTimeout(() => { void repairKnownSolanaCampaignHistory(); }, 5_000);
  setInterval(() => { void tipTick(); }, tipMs);
  setInterval(() => { void backfillTick(); }, backfillMs);
  setInterval(() => { void repairKnownSolanaCampaignHistory(); }, 120_000);
}
