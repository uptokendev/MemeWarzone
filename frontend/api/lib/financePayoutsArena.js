// Finance payouts: war pool and arena prizes, read from chain.
//
// Every battle or tournament with money has its own pool. On Solana that is a
// pool account plus a vault account per battle (seeds arena_pool / arena_vault
// + pool id, programs/mwz_rewards_treasury/src/arena.rs); on BNB and Robinhood
// it is one entry in ArenaWarPoolTreasuryV2.pools(poolId). The database only
// says which battles exist: what was staked, boosted, won, claimed and still
// owed comes from the pool itself. The app's deposit table misses stakes (it is
// written only when the browser posts a receipt after the deposit), so it is
// shown as a cross-check, never as the figure.
//
// Strictly read-only: SELECTs, getMultipleAccounts, getSignaturesForAddress,
// getMinimumBalanceForRentExemption and eth_call. Nothing is built, signed or
// sent. A pool that could not be read is "unknown" with no amount, never 0.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";

import { atomicToDecimal } from "./financeFeeRouting.js";
import { battlePoolId, tournamentPoolId } from "./arenaWarPoolEscrow.js";
import { publicHiddenWhere } from "./publicHiddenSql.js";
import { REWARDS_TREASURY_PROGRAM_ID, parseArenaPool } from "../../src/lib/solanaArenaLayout.mjs";

// Shares (programs/mwz_rewards_treasury/src/arena.rs:36-41,
// contracts/ArenaWarPoolTreasuryV2.sol:77-80): entries 75% prize / 20% MWL /
// 5% protocol, boosts 90% prize / 10% protocol. Rounded down, remainder to the prize.
export const ENTRY_PROTOCOL_BPS = 500n;
export const ENTRY_MWL_BPS = 2_000n;
export const BOOST_PROTOCOL_BPS = 1_000n;
const BPS = 10_000n;

const READ_TTL_MS = 5 * 60_000;
const MAX_POOLS = 500;
const MAX_ROWS_OUT = 200;
const MAX_CLAIM_TX_LOOKUPS = 60;
const SOLANA_CHUNK = 50;
const RPC_TIMEOUT_MS = 8000;
const ARENA_VAULT_ACCOUNT_BYTES = 9; // 8 discriminator + ArenaVault { kind: u8 }

const CLAIM_WINNER = 0;
const CLAIM_PROTOCOL = 1;
const CLAIM_MWL = 2;
const CLAIM_PLACE_BASE = 10;

const readCache = new Map();

export function clearArenaPayoutsCache() {
  readCache.clear();
}

function anchorDiscriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

export const ARENA_CLAIM_RECEIPT_DISCRIMINATOR = anchorDiscriminator("ArenaClaimReceipt");
export const ARENA_REFUND_RECEIPT_DISCRIMINATOR = anchorDiscriminator("ArenaRefundReceipt");

function big(value) {
  if (typeof value === "bigint") return value;
  const text = value == null ? "0" : String(value).split(".")[0];
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// --------------------------------------------------------------------------
// Pure money model

/** Prize, MWL and protocol parts of a pool, exactly as both programs compute them at resolve. */
export function splitPool({ entries, boosts }) {
  const entry = big(entries);
  const boost = big(boosts);
  const entryProtocol = (entry * ENTRY_PROTOCOL_BPS) / BPS;
  const mwl = (entry * ENTRY_MWL_BPS) / BPS;
  const boostProtocol = (boost * BOOST_PROTOCOL_BPS) / BPS;
  return {
    prize: entry - entryProtocol - mwl + (boost - boostProtocol),
    protocol: entryProtocol + boostProtocol,
    mwl,
  };
}

/**
 * What one pool took in, paid out, owes and holds. Input is the normalized
 * on-chain pool (see normalizeSolanaPool / normalizeEvmPool). Pure.
 *
 * - open / live: everything taken is held until the battle ends; nothing is owed yet.
 * - resolved: the unclaimed prize is owed to the winner(s); unclaimed protocol and
 *   MWL shares wait for the operator claim.
 * - cancelled: whatever is still in the stake, support, buy-in and boost totals is
 *   owed back (each refund lowers its total on chain).
 */
export function poolMoney(pool) {
  const stakes = big(pool.stakeA) + big(pool.stakeB);
  const support = big(pool.support);
  const buyIns = big(pool.buyIns);
  const boosts = big(pool.boosts);
  const entries = stakes + support + buyIns;
  const taken = entries + boosts;
  const zero = {
    stakes, support, buyIns, boosts, refundedStakes: big(pool.refundedStakes), paidIn: taken + big(pool.refundedStakes),
    prizePot: 0n, prizeClaimed: 0n, prizeOwed: 0n, held: 0n, refundsOwed: 0n,
    protocolPending: 0n, protocolClaimed: 0n, mwlPending: 0n, mwlClaimed: 0n, obligations: 0n,
  };
  if (pool.state === "open" || pool.state === "live") return { ...zero, held: taken, obligations: taken };
  if (pool.state === "cancelled") return { ...zero, refundsOwed: taken, obligations: taken };
  if (pool.state !== "resolved") return zero;
  const split = splitPool({ entries, boosts });
  const otherPlaces = (pool.places || []).slice(1).reduce((sum, p) => sum + (p.claimed ? 0n : big(p.pending)), 0n);
  const prizeOwed = (pool.claimedWinner ? 0n : big(pool.pendingWinner)) + otherPlaces;
  const protocolPending = pool.claimedProtocol ? 0n : big(pool.pendingProtocol);
  const mwlPending = pool.claimedMwl ? 0n : big(pool.pendingMwl);
  return {
    ...zero,
    prizePot: split.prize,
    prizeClaimed: split.prize > prizeOwed ? split.prize - prizeOwed : 0n,
    prizeOwed,
    protocolPending,
    protocolClaimed: pool.claimedProtocol ? split.protocol : 0n,
    mwlPending,
    mwlClaimed: pool.claimedMwl ? split.mwl : 0n,
    obligations: prizeOwed + protocolPending + mwlPending,
  };
}

const TOTAL_FIELDS = ["paidIn", "stakes", "support", "buyIns", "boosts", "prizePot", "prizeClaimed", "prizeOwed", "held", "refundsOwed", "protocolPending", "protocolClaimed", "mwlPending", "mwlClaimed", "obligations"];

/**
 * Sums pool rows into { real, test, all }. A real pool that could not be read
 * makes every real total unknown (null): a partial sum would read as a figure.
 */
export function summarizePools(rows) {
  const make = () => Object.fromEntries(TOTAL_FIELDS.map((f) => [f, 0n]));
  const out = { real: make(), test: make(), all: make(), unknownReal: 0, unknownTest: 0, counts: { open: 0, live: 0, resolved: 0, cancelled: 0, not_opened: 0, unknown: 0 } };
  for (const row of rows) {
    out.counts[row.status] = (out.counts[row.status] || 0) + 1;
    if (row.status === "unknown") {
      if (row.testCoin) out.unknownTest += 1; else out.unknownReal += 1;
      continue;
    }
    if (!row.money) continue;
    for (const f of TOTAL_FIELDS) {
      out.all[f] += row.money[f];
      (row.testCoin ? out.test : out.real)[f] += row.money[f];
    }
  }
  if (out.unknownReal) for (const f of TOTAL_FIELDS) { out.real[f] = null; out.all[f] = null; }
  if (out.unknownTest) for (const f of TOTAL_FIELDS) { out.test[f] = null; out.all[f] = null; }
  return out;
}

// --------------------------------------------------------------------------
// Solana decode

const SOLANA_STATES = ["open", "live", "resolved", "cancelled"];

/** Normalized pool from the decoded ArenaPool account (solanaArenaLayout.parseArenaPool). */
export function normalizeSolanaPool(parsed) {
  const state = SOLANA_STATES[parsed.state];
  if (!state) return null;
  const placeCount = Number(parsed.placeCount || 0);
  const places = placeCount > 0
    ? Array.from({ length: placeCount }, (_, i) => ({
        wallet: parsed.placeWallets?.[i] || null,
        pending: i === 0 ? big(parsed.pendingWinner) : big(parsed.placeLamports?.[i]),
        claimed: i === 0 ? Boolean(parsed.claimedWinner || parsed.placeClaimed?.[0]) : Boolean(parsed.placeClaimed?.[i]),
      }))
    : [{ wallet: parsed.winnerWallet || null, pending: big(parsed.pendingWinner), claimed: Boolean(parsed.claimedWinner) }];
  return {
    kind: parsed.kind === 1 ? "tournament" : "battle",
    state,
    ownerA: parsed.ownerA || null,
    ownerB: parsed.ownerB || null,
    stakeA: big(parsed.depositedStakeA),
    stakeB: big(parsed.depositedStakeB),
    support: big(parsed.supportTotal),
    buyIns: big(parsed.buyInTotal),
    boosts: big(parsed.prizeBoostTotal),
    pendingWinner: big(parsed.pendingWinner),
    pendingProtocol: big(parsed.pendingProtocol),
    pendingMwl: big(parsed.pendingMwl),
    claimedWinner: Boolean(parsed.claimedWinner || parsed.placeClaimed?.[0]),
    claimedProtocol: Boolean(parsed.claimedProtocol),
    claimedMwl: Boolean(parsed.claimedMwl),
    refundedA: Boolean(parsed.refundedA),
    refundedB: Boolean(parsed.refundedB),
    winnerSide: parsed.winnerSide === 1 ? "a" : parsed.winnerSide === 2 ? "b" : null,
    winnerWallet: parsed.winnerWallet || null,
    resolveDeadline: Number(parsed.resolveDeadline) || null,
    places,
  };
}

/** ArenaClaimReceipt { pool_id, bucket u8, recipient, amount_lamports u64, bump }. */
export function decodeClaimReceipt(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < 8 + 32 + 1 + 32 + 8 || !bytes.subarray(0, 8).equals(ARENA_CLAIM_RECEIPT_DISCRIMINATOR)) return null;
  return {
    poolId: bytes.subarray(8, 40).toString("hex"),
    bucket: bytes[40],
    recipient: new PublicKey(bytes.subarray(41, 73)).toBase58(),
    amount: bytes.readBigUInt64LE(73),
  };
}

/** ArenaRefundReceipt { pool_id, wallet, identity, amount_lamports u64, kind u8, bump }. */
export function decodeRefundReceipt(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < 8 + 32 * 3 + 8 || !bytes.subarray(0, 8).equals(ARENA_REFUND_RECEIPT_DISCRIMINATOR)) return null;
  return { poolId: bytes.subarray(8, 40).toString("hex"), wallet: new PublicKey(bytes.subarray(40, 72)).toBase58(), amount: bytes.readBigUInt64LE(104) };
}

function programKey() {
  return new PublicKey(REWARDS_TREASURY_PROGRAM_ID);
}

function poolIdBytes(poolIdHex) {
  return Buffer.from(String(poolIdHex).replace(/^0x/i, ""), "hex");
}

export function deriveSolanaArenaAccounts(poolIdHex) {
  const id = poolIdBytes(poolIdHex);
  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programKey())[0].toBase58();
  return {
    pool: pda([Buffer.from("arena_pool"), id]),
    vault: pda([Buffer.from("arena_vault"), id]),
    claim: (bucket) => pda([Buffer.from("arena_claim"), id, Buffer.from([bucket])]),
    refund: (wallet, kind) => pda([Buffer.from("arena_refund"), id, new PublicKey(wallet).toBuffer(), Buffer.from([kind])]),
  };
}

// --------------------------------------------------------------------------
// EVM decode

const EVM_STATES = ["open", "live", "resolved", "cancelled"];
const POOLS_SELECTOR = ethers.id("pools(bytes32)").slice(0, 10);
const PLACE_COUNT_SELECTOR = ethers.id("placeCount(bytes32)").slice(0, 10);
const PLACE_OF_SELECTOR = ethers.id("placeOf(bytes32,uint8)").slice(0, 10);

function words(hex) {
  const text = String(hex || "").replace(/^0x/, "");
  const out = [];
  for (let i = 0; i + 64 <= text.length; i += 64) out.push(text.slice(i, i + 64));
  return out;
}

const wordInt = (w) => BigInt(`0x${w}`);
const wordAddress = (w) => `0x${w.slice(24)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * ArenaWarPoolTreasuryV2.pools(poolId): 21 words (contracts/ArenaWarPoolTreasuryV2.sol:42-64).
 * Returns null for a pool that was never opened (ownerA is zero).
 */
export function decodeEvmPool(hex) {
  const w = words(hex);
  if (w.length < 21) throw new Error(`pools() returned ${w.length} words, expected 21.`);
  const ownerA = wordAddress(w[2]);
  if (ownerA === ZERO_ADDRESS) return null;
  const state = EVM_STATES[Number(wordInt(w[1]))];
  if (!state) throw new Error("pools() returned an unknown state.");
  const pendingWinner = wordInt(w[11]);
  const claimedWinner = wordInt(w[16]) !== 0n;
  return {
    kind: wordInt(w[0]) === 1n ? "tournament" : "battle",
    state,
    ownerA,
    ownerB: wordAddress(w[3]),
    stakeA: wordInt(w[6]),
    stakeB: wordInt(w[7]),
    support: 0n,
    buyIns: wordInt(w[8]),
    boosts: wordInt(w[9]),
    winnerWallet: wordAddress(w[10]) === ZERO_ADDRESS ? null : wordAddress(w[10]),
    pendingWinner,
    pendingProtocol: wordInt(w[12]),
    pendingMwl: wordInt(w[13]),
    resolveDeadline: Number(wordInt(w[15])) || null,
    claimedWinner,
    claimedProtocol: wordInt(w[17]) !== 0n,
    claimedMwl: wordInt(w[18]) !== 0n,
    refundedA: wordInt(w[19]) !== 0n,
    refundedB: wordInt(w[20]) !== 0n,
    winnerSide: null,
    places: [{ wallet: null, pending: pendingWinner, claimed: claimedWinner }],
  };
}

// --------------------------------------------------------------------------
// Database: which pools exist

const TOKEN_EXPR = "coalesce(nullif(p->>'tokenAddress', ''), p->>'tokenId')";

function hiddenTokenSql(chainRef, tokenExpr) {
  return `exists (select 1 from public.campaigns hc
     where hc.chain_id = ${chainRef} and ${publicHiddenWhere("hc")}
       and (case when ${chainRef} in (101, 102) then ${tokenExpr} in (hc.token_address, hc.campaign_address)
                 else lower(${tokenExpr}) in (lower(hc.token_address), lower(hc.campaign_address)) end))`;
}

/**
 * Battles that can have a pool (a stake was offered or a boost was paid) and
 * every tournament, newest first. A battle or tournament with a hidden test
 * coin on either side is a test pool.
 */
export const ARENA_SUBJECTS_SQL = `
  select * from (
    select 'battle' as kind, b.id, b.chain_id, b.state as app_state, b.created_at,
           exists (select 1 from jsonb_array_elements(case when jsonb_typeof(b.participants) = 'array' then b.participants else '[]'::jsonb end) p
                    where ${TOKEN_EXPR} is not null and ${hiddenTokenSql("b.chain_id", TOKEN_EXPR)}) as test_coin
      from public.arena_battles b
     where b.chain_id = $1 and b.tournament_id is null and coalesce(b.source, '') <> 'tournament'
       and (greatest(coalesce(b.stake_native, 0), coalesce(b.offered_stake_native, 0)) > 0
            or exists (select 1 from public.arena_contest_actions a where a.chain_id = b.chain_id and a.battle_id = b.id and a.action_type = 'boost'))
    union all
    select 'tournament' as kind, t.id, t.chain_id, t.status as app_state, t.created_at,
           exists (select 1 from public.arena_tournament_entries e
                    where e.tournament_id = t.id and e.token_address is not null and ${hiddenTokenSql("t.chain_id", "e.token_address")}) as test_coin
      from public.arena_tournaments t
     where t.chain_id = $1
  ) s
  order by created_at desc nulls last
  limit $2`;

/** What the app itself recorded, per pool, so the chain figure can be compared with it. */
export const ARENA_RECORDED_SQL = `
  select 'deposit' as source, pool_id as ref, purpose, count(*)::int as n, coalesce(sum(amount_wei), 0)::text as raw
    from public.arena_war_pool_deposits where chain_id = $1 group by pool_id, purpose
  union all
  select 'boost' as source, battle_id as ref, 'boost' as purpose, count(*)::int as n, coalesce(sum(gross_native_raw), 0)::text as raw
    from public.arena_contest_actions
   where chain_id = $1 and action_type = 'boost' and confirmed_at is not null and battle_id is not null
     and coalesce(tx_hash, signature_reference) is not null and gross_native_raw > 0
   group by battle_id
  union all
  select 'claim' as source, pool_id as ref, bucket as purpose, count(*)::int as n, coalesce(sum(amount_wei), 0)::text as raw
    from public.arena_war_pool_claims where chain_id = $1 group by pool_id, bucket`;

export function poolIdFor(subject) {
  return subject.kind === "tournament" ? tournamentPoolId(subject.id) : battlePoolId(subject.id);
}

// --------------------------------------------------------------------------
// Chain reads

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function solanaRpc(ctx, method, params) {
  let last = new Error("No Solana RPC configured.");
  for (const url of ctx.solanaUrls || []) {
    try {
      const response = await withTimeout(ctx.fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), RPC_TIMEOUT_MS, method);
      if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(`${method}: ${payload.error.message || "rpc error"}`);
      return payload.result;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

async function multipleAccounts(ctx, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += SOLANA_CHUNK * 2) {
    const chunk = keys.slice(i, i + SOLANA_CHUNK * 2);
    const result = await solanaRpc(ctx, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
    const values = result?.value;
    if (!Array.isArray(values) || values.length !== chunk.length) throw new Error("getMultipleAccounts returned a malformed list.");
    out.push(...values);
  }
  return out;
}

function accountBytes(value) {
  return value?.data?.[0] ? Buffer.from(value.data[0], "base64") : null;
}

/** The transaction that created a receipt account: its oldest successful signature. */
async function receiptTransaction(ctx, address) {
  const sigs = await solanaRpc(ctx, "getSignaturesForAddress", [address, { limit: 10, commitment: "confirmed" }]);
  const ok = (sigs || []).filter((s) => !s.err);
  const first = ok[ok.length - 1];
  return first ? { tx: first.signature, at: first.blockTime ? new Date(first.blockTime * 1000).toISOString() : null } : null;
}

/** Reads every Solana pool. Returns one row per subject; a failed read is status "unknown". */
export async function readSolanaArenaPools(ctx, subjects) {
  const derived = subjects.map((s) => ({ subject: s, poolId: poolIdFor(s), accounts: deriveSolanaArenaAccounts(poolIdFor(s)) }));
  let values;
  let vaultRent;
  try {
    vaultRent = big(await solanaRpc(ctx, "getMinimumBalanceForRentExemption", [ARENA_VAULT_ACCOUNT_BYTES]));
    values = await multipleAccounts(ctx, derived.flatMap((d) => [d.accounts.pool, d.accounts.vault]));
  } catch (error) {
    const message = String(error?.message || "read failed").slice(0, 200);
    return derived.map((d) => ({ subject: d.subject, poolId: d.poolId, address: d.accounts.pool, vault: d.accounts.vault, status: "unknown", error: message }));
  }
  const rows = derived.map((d, i) => {
    const base = { subject: d.subject, poolId: d.poolId, address: d.accounts.pool, vault: d.accounts.vault };
    const poolAccount = values[i * 2];
    const vaultAccount = values[i * 2 + 1];
    if (!poolAccount) return { ...base, status: "not_opened" };
    if (poolAccount.owner !== REWARDS_TREASURY_PROGRAM_ID) return { ...base, status: "unknown", error: "Pool account is not owned by the arena program." };
    const parsed = parseArenaPool(Uint8Array.from(accountBytes(poolAccount) || []), PublicKey);
    const pool = parsed ? normalizeSolanaPool(parsed) : null;
    if (!pool) return { ...base, status: "unknown", error: "Pool account layout not understood." };
    const vaultLamports = vaultAccount ? big(vaultAccount.lamports) : 0n;
    return { ...base, status: pool.state, pool, vaultAvailable: vaultLamports > vaultRent ? vaultLamports - vaultRent : 0n };
  });

  // Claim receipts of resolved pools: who was paid how much, and in which transaction.
  const receiptKeys = [];
  for (const row of rows) {
    if (row.status !== "resolved") continue;
    const d = deriveSolanaArenaAccounts(row.poolId);
    const buckets = [CLAIM_WINNER, CLAIM_PROTOCOL, CLAIM_MWL];
    for (let place = 2; place <= row.pool.places.length; place += 1) buckets.push(CLAIM_PLACE_BASE + place);
    for (const bucket of buckets) receiptKeys.push({ row, bucket, address: d.claim(bucket) });
  }
  // Stake refund receipts of cancelled battles (owner A and B).
  const refundKeys = [];
  for (const row of rows) {
    if (row.status !== "cancelled" || row.pool.kind !== "battle") continue;
    const d = deriveSolanaArenaAccounts(row.poolId);
    for (const owner of [row.pool.ownerA, row.pool.ownerB]) if (owner) refundKeys.push({ row, address: d.refund(owner, 0) });
  }
  if (receiptKeys.length || refundKeys.length) {
    try {
      const got = await multipleAccounts(ctx, [...receiptKeys, ...refundKeys].map((k) => k.address));
      receiptKeys.forEach((k, i) => {
        const decoded = got[i] ? decodeClaimReceipt(accountBytes(got[i])) : null;
        if (decoded) (k.row.claims ||= []).push({ bucket: k.bucket, address: k.address, recipient: decoded.recipient, amount: decoded.amount });
      });
      refundKeys.forEach((k, i) => {
        const decoded = got[receiptKeys.length + i] ? decodeRefundReceipt(accountBytes(got[receiptKeys.length + i])) : null;
        if (decoded) k.row.pool.refundedStakes = big(k.row.pool.refundedStakes) + decoded.amount;
      });
    } catch (error) {
      for (const k of receiptKeys) k.row.claimsError = String(error?.message || "receipt read failed").slice(0, 200);
    }
  }
  let lookups = 0;
  for (const row of rows) {
    for (const claim of row.claims || []) {
      if (claim.bucket !== CLAIM_WINNER && claim.bucket < CLAIM_PLACE_BASE) continue;
      if (lookups >= MAX_CLAIM_TX_LOOKUPS) break;
      lookups += 1;
      try {
        Object.assign(claim, await receiptTransaction(ctx, claim.address));
      } catch {
        // No link; the amount still counts.
      }
    }
  }
  return rows;
}

/** Reads every EVM pool from ArenaWarPoolTreasuryV2. */
export async function readEvmArenaPools(ctx, subjects, treasury) {
  const rows = [];
  const call = async (data) => (await ctx.readers.readEvmCall({ urls: ctx.evmUrls, to: treasury, data, fetchImpl: ctx.fetchImpl })).hex;
  for (let i = 0; i < subjects.length; i += 10) {
    const chunk = subjects.slice(i, i + 10);
    rows.push(...await Promise.all(chunk.map(async (subject) => {
      const poolId = poolIdFor(subject);
      const base = { subject, poolId, address: treasury };
      if (!treasury) return { ...base, status: "unknown", error: "No ArenaWarPoolTreasuryV2 address for this chain." };
      try {
        const pool = decodeEvmPool(await call(`${POOLS_SELECTOR}${poolId.slice(2)}`));
        if (!pool) return { ...base, status: "not_opened" };
        if (pool.kind === "tournament" && pool.state === "resolved") {
          const count = Number(wordInt(words(await call(`${PLACE_COUNT_SELECTOR}${poolId.slice(2)}`))[0] || "0"));
          for (let place = 2; place <= Math.min(count, 3); place += 1) {
            const w = words(await call(`${PLACE_OF_SELECTOR}${poolId.slice(2)}${place.toString(16).padStart(64, "0")}`));
            pool.places.push({ wallet: wordAddress(w[0]), pending: wordInt(w[1]), claimed: wordInt(w[2]) !== 0n });
          }
        }
        return { ...base, status: pool.state, pool };
      } catch (error) {
        return { ...base, status: "unknown", error: String(error?.message || "read failed").slice(0, 200) };
      }
    })));
  }
  return rows;
}

// --------------------------------------------------------------------------
// Type builder

function dec(ctx, value) {
  return value == null ? null : atomicToDecimal(value.toString(), ctx.decimals);
}

function poolRowOut(ctx, row, h) {
  const m = row.money;
  const vaultShort = row.vaultAvailable != null && m ? m.obligations > row.vaultAvailable : null;
  const userClaims = (row.claims || []).filter((c) => c.bucket === CLAIM_WINNER || c.bucket >= CLAIM_PLACE_BASE);
  return {
    kind: row.subject.kind,
    id: row.subject.id,
    appState: row.subject.app_state || null,
    createdAt: toIso(row.subject.created_at),
    testCoin: Boolean(row.subject.test_coin),
    poolId: row.poolId,
    address: row.address,
    addressUrl: h.explorerAddressUrl(ctx.chainId, row.address),
    status: row.status,
    error: row.error || null,
    winnerSide: row.pool?.winnerSide || null,
    winnerWallet: row.pool?.winnerWallet || null,
    resolveDeadline: row.pool?.resolveDeadline ? new Date(row.pool.resolveDeadline * 1000).toISOString() : null,
    staked: m ? dec(ctx, m.stakes) : null,
    boosts: m ? dec(ctx, m.boosts) : null,
    supportAndBuyIns: m ? dec(ctx, m.support + m.buyIns) : null,
    paidIn: m ? dec(ctx, m.paidIn) : null,
    prizePot: m ? dec(ctx, m.prizePot) : null,
    prizeClaimed: m ? dec(ctx, m.prizeClaimed) : null,
    prizeOwed: m ? dec(ctx, m.prizeOwed) : null,
    held: m ? dec(ctx, m.held) : null,
    refundsOwed: m ? dec(ctx, m.refundsOwed) : null,
    protocolPending: m ? dec(ctx, m.protocolPending) : null,
    protocolClaimed: m ? dec(ctx, m.protocolClaimed) : null,
    mwlPending: m ? dec(ctx, m.mwlPending) : null,
    mwlClaimed: m ? dec(ctx, m.mwlClaimed) : null,
    vaultHolds: row.vaultAvailable != null ? dec(ctx, row.vaultAvailable) : null,
    cover: row.vaultAvailable == null || !m ? "shared" : vaultShort ? "short" : "covered",
    claims: userClaims.map((c) => ({ amount: dec(ctx, c.amount), recipient: c.recipient, at: c.at || null, txHash: c.tx || null, txUrl: h.explorerTxUrl(ctx.chainId, c.tx) })),
    recorded: row.recorded || null,
  };
}

function totalsOut(ctx, t) {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v == null ? null : dec(ctx, v)]));
}

/**
 * Payout type "War pool and arena prizes" for one mainnet. `h` carries the
 * shared helpers of financePayouts.js (typeShell, acc, addTo, priced, paidBlock,
 * owedBlock, unknownOwed, unrecordedPaid, coverageBlock, vaultFromDestination,
 * explorerTxUrl, explorerAddressUrl, safeQuery), so this file adds no second
 * copy of the payout shape.
 */
export async function arenaPrizesType(ctx, h) {
  const t = h.typeShell(ctx, "arena_prizes");
  t.upcoming = [{ label: "Winners claim after each battle ends", at: null, note: null }];
  const evmVault = ctx.solana ? null : h.vaultFromDestination(ctx, "war_pool");
  if (!ctx.dbRowsAllowed) {
    t.paid = h.unrecordedPaid("This API reads the test database, so mainnet battles are not listed here.");
    t.owed = h.unknownOwed("Mainnet battles are listed on the live API.");
    t.vaults = evmVault ? [evmVault] : [];
    t.coverage = await h.coverageBlock(ctx, null, t.vaults, null);
    return t;
  }

  const subjectsRead = await h.safeQuery(ctx.db, ARENA_SUBJECTS_SQL, [ctx.chainId, MAX_POOLS]);
  const recordedRead = await h.safeQuery(ctx.db, ARENA_RECORDED_SQL, [ctx.chainId]);
  t.sources.push("db:arena_battles + arena_tournaments (which pools exist)", ctx.solana ? "rpc: each battle's pool and vault account, claim receipts" : "rpc: ArenaWarPoolTreasuryV2.pools(poolId)");
  if (subjectsRead.error) {
    t.warnings.push({ level: "warning", message: `Battles could not be listed: ${subjectsRead.error}` });
    t.paid = h.unrecordedPaid("Battles could not be listed.");
    t.owed = h.unknownOwed("Battles could not be listed.");
    t.vaults = evmVault ? [evmVault] : [];
    t.coverage = await h.coverageBlock(ctx, null, t.vaults, null);
    return t;
  }
  const subjects = subjectsRead.rows || [];
  if (subjects.length >= MAX_POOLS) t.warnings.push({ level: "warning", message: `Only the newest ${MAX_POOLS} battles and tournaments are read.` });

  const treasury = ctx.solana ? null : ctx.destinations.get("war_pool")?.address || null;
  const cacheKey = `${ctx.chainId}:${treasury || ""}:${subjects.map((s) => `${s.kind}:${s.id}`).join(",")}`;
  let rows;
  const hit = readCache.get(ctx.chainId);
  if (hit && hit.key === cacheKey && Date.now() - hit.at < READ_TTL_MS) {
    rows = hit.rows;
  } else {
    rows = ctx.solana ? await readSolanaArenaPools(ctx, subjects) : await readEvmArenaPools(ctx, subjects, treasury);
    if (!rows.some((r) => r.status === "unknown")) readCache.set(ctx.chainId, { key: cacheKey, at: Date.now(), rows });
  }

  const recorded = new Map();
  for (const r of recordedRead.rows || []) {
    const key = String(r.ref || "").toLowerCase();
    const entry = recorded.get(key) || { stakes: 0n, stakeCount: 0, boosts: 0n, boostCount: 0, claims: 0 };
    if (r.source === "deposit") { entry.stakes += big(r.raw); entry.stakeCount += Number(r.n) || 0; }
    if (r.source === "boost") { entry.boosts += big(r.raw); entry.boostCount += Number(r.n) || 0; }
    if (r.source === "claim") entry.claims += Number(r.n) || 0;
    recorded.set(key, entry);
  }

  for (const row of rows) {
    if (row.pool) row.money = poolMoney(row.pool);
    // Deposits are keyed by pool id, boosts by battle id.
    const parts = [recorded.get(row.poolId.toLowerCase()), recorded.get(String(row.subject.id).toLowerCase())].filter(Boolean);
    if (parts.length) {
      const add = (field) => parts.reduce((s, p) => s + (typeof p[field] === "bigint" ? p[field] : BigInt(p[field] || 0)), 0n);
      row.recorded = { stakes: dec(ctx, add("stakes")), stakeCount: Number(add("stakeCount")), boosts: dec(ctx, add("boosts")), boostCount: Number(add("boostCount")) };
    }
  }
  const sum = summarizePools(rows);

  // Paid: prize claims (winner and places). Solana has a receipt per claim with
  // its transaction; EVM keeps only the claimed flag, so the amount is the
  // prize minus what is still unclaimed, with no time or link.
  const paidAll = h.acc();
  const paidPeriod = h.acc();
  const testPaid = h.acc();
  let untimed = 0;
  for (const row of rows) {
    if (row.status !== "resolved" || !row.money) continue;
    const claims = (row.claims || []).filter((c) => c.bucket === CLAIM_WINNER || c.bucket >= CLAIM_PLACE_BASE);
    const events = claims.length ? claims.map((c) => ({ raw: c.amount, at: c.at || null, tx: c.tx || null })) : row.money.prizeClaimed > 0n ? [{ raw: row.money.prizeClaimed, at: null, tx: null }] : [];
    for (const e of events) {
      if (row.subject.test_coin) { h.addTo(testPaid, e.raw.toString(), { at: e.at }); continue; }
      h.addTo(paidAll, e.raw.toString(), { at: e.at, tx: e.tx });
      if (!e.at) untimed += 1;
      else if (e.at >= ctx.since) h.addTo(paidPeriod, e.raw.toString(), { at: e.at, tx: e.tx });
    }
  }
  t.paid = await h.paidBlock(paidPeriod, paidAll, ctx, {
    note: ctx.solana
      ? "Prize claims read from each pool's claim receipt on chain, with the claim transaction."
      : `Prize claims read from the pool state on chain. The contract keeps no claim time${untimed ? `, so ${untimed} claim${untimed === 1 ? " is" : "s are"} in the all-time figure only` : ""}.`,
    ...(testPaid.count ? { testCoinsLeftOut: dec(ctx, testPaid.raw), testCoinsLeftOutCount: testPaid.count } : {}),
  });

  // Owed now: unclaimed prizes of resolved pools plus refunds of cancelled ones.
  if (sum.unknownReal) {
    t.owed = h.unknownOwed(`${sum.unknownReal} battle pool${sum.unknownReal === 1 ? "" : "s"} could not be read, so what is owed is not known. The pools that did read are listed below.`);
  } else {
    const claimable = h.acc();
    const testOwed = h.acc();
    for (const row of rows) {
      if (!row.money) continue;
      const owedRaw = row.money.prizeOwed + row.money.refundsOwed;
      if (owedRaw === 0n) continue;
      h.addTo(row.subject.test_coin ? testOwed : claimable, owedRaw.toString());
    }
    t.owed = await h.owedBlock(claimable, h.acc(), testOwed, ctx, { note: "Prizes won and not claimed yet, plus refunds owed for cancelled battles. Money in battles still running is held, not owed: see below." });
  }

  // Paid in, from chain: stakes, support, buy-ins and boosts in each pool.
  const inAll = h.acc();
  for (const row of rows) {
    if (!row.money || row.subject.test_coin || row.money.paidIn === 0n) continue;
    h.addTo(inAll, row.money.paidIn.toString(), { at: toIso(row.subject.created_at) });
  }
  const recStakes = [...recorded.values()].reduce((s, r) => s + r.stakes, 0n);
  const recBoosts = [...recorded.values()].reduce((s, r) => s + r.boosts, 0n);
  t.paidIn = {
    allTime: sum.unknownReal
      ? { amount: null, raw: null, count: null, amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null }
      : await h.priced(inAll, ctx, { events: true }),
    note: `Stakes and boosts in battle pools, read from each pool on chain (test coins left out; valued at the price when the battle was created). 75% of stakes and 90% of boosts are prize money. The app's own records show ${dec(ctx, recStakes)} ${ctx.asset} of stakes and ${dec(ctx, recBoosts)} ${ctx.asset} of boosts.`,
  };

  // Vault: Solana sums every pool's vault (rent left out); EVM is one contract.
  if (ctx.solana) {
    const read = rows.filter((r) => r.vaultAvailable != null);
    const anyUnknown = rows.some((r) => r.status === "unknown");
    const raw = read.reduce((s, r) => s + r.vaultAvailable, 0n);
    const amount = dec(ctx, raw);
    t.vaults = [{
      id: "arena_pool_vaults",
      label: `Battle pool accounts (${read.length})`,
      plain: "One program account per battle. Each holds that battle's stakes and boosts until the winner, the MWL vault and the protocol vault claim their parts. Rent is left out.",
      address: null,
      addressUrl: null,
      balance: anyUnknown
        ? { status: "unknown", amount: null, raw: null, amountUsd: null, error: "Some pool accounts could not be read.", source: "rpc", asOf: null }
        : { status: "ok", amount, raw: raw.toString(), ...(await ctx.prices.valueAtSpot(ctx.asset, amount)), source: "rpc:getMultipleAccounts", asOf: ctx.now },
    }];
  } else {
    // The event prize vault holds sponsorship prizes, not pool money: listed, not counted as cover.
    t.vaults = ctx.destinations.get("event_prize") ? [evmVault, h.vaultFromDestination(ctx, "event_prize")] : [evmVault];
  }
  const obligations = sum.all.obligations;
  t.coverage = await h.coverageBlock(ctx, obligations == null ? null : obligations.toString(), ctx.solana ? t.vaults : [evmVault], ctx.solana
    ? "Compared with everything the pool accounts still have to pay: unclaimed prizes, refunds, protocol and MWL shares, and the money in battles still running. Each pool is also checked on its own below."
    : "Compared with everything the listed pools still have to pay: unclaimed prizes, refunds, protocol and MWL shares, and the money in battles still running. All pools share this one contract balance.");

  // Pools that did not read: the cover is unknown, not "nothing fixed".
  if (sum.unknownReal || sum.unknownTest) t.coverage.status = "unknown";
  const shortPools = rows.filter((r) => r.money && r.vaultAvailable != null && r.money.obligations > r.vaultAvailable);
  for (const r of shortPools) t.warnings.push({ level: "critical", message: `Pool of ${r.subject.kind} ${r.subject.id} holds ${dec(ctx, r.vaultAvailable)} ${ctx.asset} but has to pay ${dec(ctx, r.money.obligations)} ${ctx.asset}.` });
  for (const r of rows.filter((x) => x.status === "unknown")) t.warnings.push({ level: "warning", message: `Pool of ${r.subject.kind} ${r.subject.id} could not be read: ${r.error || "unknown error"}` });
  if (sum.real.stakes != null && sum.real.stakes > recStakes) {
    t.notes.push(`The app's deposit table records ${dec(ctx, recStakes)} ${ctx.asset} of stakes; the pools hold ${dec(ctx, sum.real.stakes)} ${ctx.asset}. A stake is only recorded when the staker's browser sends a signed receipt after the deposit, so the chain figure is used.`);
  }
  if ((recordedRead.rows || []).every((r) => r.source !== "claim") && sum.real.prizeClaimed > 0n) {
    t.notes.push("The app records no prize claims (arena_war_pool_claims is empty); claims are read from chain.");
  }
  for (const r of rows.filter((x) => x.status === "live" && x.pool?.resolveDeadline)) {
    t.upcoming.push({ label: `${r.subject.kind === "tournament" ? "Tournament" : "Battle"} ${r.subject.id} must be resolved by`, at: new Date(r.pool.resolveDeadline * 1000).toISOString(), note: "After this anyone can cancel the pool and everyone gets their money back." });
  }

  t.arena = {
    pools: rows.slice(0, MAX_ROWS_OUT).map((r) => poolRowOut(ctx, r, h)),
    poolsListed: subjects.length,
    counts: sum.counts,
    unknown: sum.unknownReal + sum.unknownTest,
    totals: totalsOut(ctx, sum.real),
    testTotals: totalsOut(ctx, sum.test),
    recorded: { stakes: dec(ctx, recStakes), boosts: dec(ctx, recBoosts) },
    note: "Held: money in battles that have not ended, locked until the result; it is not owed to anyone yet. Protocol and MWL shares are claimed by our operator, not by players.",
  };
  return t;
}
