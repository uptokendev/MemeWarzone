// Arena war pool money, indexed from the chain into arena_war_pool_deposits / arena_war_pool_claims.
//
// Why: a stake used to get a row only when the staker's browser posted a stake receipt after the
// deposit (POST /api/arena/war-pools/:id/stake-receipt, a second wallet signature). A closed tab
// meant no row, and claims were never recorded at all. This reads every money movement of every
// pool from the chain itself:
//
//   Solana (rewards treasury program, arena.rs): open_battle_pool_v2 / deposit_stake_v2 (stake),
//     donate_support_v2 (support), deposit_buy_in_v2 (buy_in), deposit_prize_boost_v2 (boost),
//     claim_winner / claim_place_v2 / claim_protocol / claim_mwl and the four refunds.
//     Deposit amounts come from the program's own events (ArenaStakeDeposited, ...). Claims and
//     refunds emit no event: the amount is what left the pool's vault in that transaction, or,
//     when one transaction moved the same vault twice, the receipt account the program wrote.
//   EVM (ArenaWarPoolTreasuryV2): StakeDeposited, BuyInDeposited, BattleBoosted, TournamentBoosted,
//     Claimed (winner / place / operator / protocol / league), StakeRefunded, BuyInRefunded,
//     BoostRefunded.
//
// Every chain row is source = 'chain' and unique by (chain_id, tx_hash, ix_index): the top-level
// instruction index on Solana, the log index on EVM. A browser receipt row (source = 'receipt',
// ix_index null) for the same transaction is replaced by the chain row, so one deposit is never
// counted twice; the receipt route also skips its insert once the chain row exists.
//
// Read-only on chain: getSignaturesForAddress, getTransaction, getAccountInfo, eth_getLogs,
// eth_getBlockByNumber, eth_blockNumber. Nothing is built, signed or sent. No ethers import: this
// also runs in the slim resolve-due image.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";

import { REWARDS_TREASURY_PROGRAM_ID } from "../../src/lib/solanaArenaLayout.mjs";
import { decodeClaimReceipt, decodeRefundReceipt, deriveSolanaArenaAccounts } from "./arenaPoolAccounts.js";

export const SOLANA_ARENA_CHAIN_IDS = Object.freeze([101, 102, 103]);

export function isSolanaArenaChain(chainId) {
  return SOLANA_ARENA_CHAIN_IDS.includes(Number(chainId));
}

// --------------------------------------------------------------------------
// Pool ids (same as arenaWarPoolEscrow.battlePoolId / tournamentPoolId = ethers.id(...))

function keccakHex(bytes) {
  return `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`;
}

export function battlePoolIdHex(battleId) {
  return keccakHex(Buffer.from(`arena-battle:${String(battleId)}`, "utf8"));
}

export function tournamentPoolIdHex(tournamentId) {
  return keccakHex(Buffer.from(`arena-tournament:${String(tournamentId)}`, "utf8"));
}

export function subjectPoolId(subject) {
  return subject.kind === "tournament" ? tournamentPoolIdHex(subject.id) : battlePoolIdHex(subject.id);
}

// --------------------------------------------------------------------------
// Solana decode (pure)

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58].map((c, i) => [c, BigInt(i)]));

export function base58Decode(text) {
  const value = String(text || "");
  let n = 0n;
  for (const c of value) {
    const digit = BASE58_MAP.get(c);
    if (digit === undefined) throw new Error("invalid base58");
    n = n * 58n + digit;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of value) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function anchorHash(prefix, name) {
  return createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8).toString("hex");
}

/**
 * Money instructions of the arena program. `recipient` / `receipt` are account positions in the
 * instruction (arena.rs account structs); deposits take their amount from the event.
 */
const SOLANA_IX = {
  open_battle_pool_v2: { kind: "deposit" },
  deposit_stake_v2: { kind: "deposit" },
  donate_support_v2: { kind: "deposit" },
  deposit_buy_in_v2: { kind: "deposit" },
  deposit_prize_boost_v2: { kind: "deposit" },
  claim_winner: { kind: "claim", bucket: "winner", place: 1, recipient: 0, receipt: 3 },
  claim_place_v2: { kind: "claim", bucket: "winner", placeArg: true, recipient: 0, receipt: 3 },
  claim_protocol: { kind: "claim", bucket: "protocol", recipient: 4, receipt: 5 },
  claim_mwl: { kind: "claim", bucket: "mwl", recipient: 4, receipt: 5 },
  refund_stake: { kind: "claim", bucket: "refund", refundOf: "stake", recipient: 0, receipt: 3 },
  refund_buy_in_v2: { kind: "claim", bucket: "refund", refundOf: "buy_in", recipient: 0, receipt: 4 },
  refund_support_v2: { kind: "claim", bucket: "refund", refundOf: "support", recipient: 0, receipt: 4 },
  refund_prize_boost_v2: { kind: "claim", bucket: "refund", refundOf: "boost", recipient: 0, receipt: 4 },
};
const IX_BY_DISCRIMINATOR = new Map(Object.keys(SOLANA_IX).map((name) => [anchorHash("global", name), name]));

/** Deposit events: name -> purpose and the byte offsets of wallet and amount after the discriminator. */
const SOLANA_EVENTS = {
  ArenaStakeDeposited: { purpose: "stake", wallet: 40, amount: 72 },
  ArenaSupportDonated: { purpose: "support", wallet: 40, amount: 72 },
  ArenaBuyInDepositedV2: { purpose: "buy_in", wallet: 72, amount: 104 },
  ArenaPrizeBoostDeposited: { purpose: "boost", wallet: 72, amount: 104 },
};
const EVENT_BY_DISCRIMINATOR = new Map(Object.keys(SOLANA_EVENTS).map((name) => [anchorHash("event", name), name]));

/** One deposit event from a "Program data:" payload, or null for any other event. */
export function decodeSolanaArenaEvent(base64) {
  const bytes = Buffer.from(String(base64 || ""), "base64");
  if (bytes.length < 8) return null;
  const name = EVENT_BY_DISCRIMINATOR.get(bytes.subarray(0, 8).toString("hex"));
  if (!name) return null;
  const layout = SOLANA_EVENTS[name];
  if (bytes.length < layout.amount + 8) return null;
  return {
    name,
    purpose: layout.purpose,
    poolId: `0x${bytes.subarray(8, 40).toString("hex")}`,
    wallet: new PublicKey(bytes.subarray(layout.wallet, layout.wallet + 32)).toBase58(),
    amount: bytes.readBigUInt64LE(layout.amount),
  };
}

// Precompiles run without "invoke" log lines, so they are skipped when log lines are matched to
// instructions (the resolve transaction's Ed25519 check is one).
const NON_LOGGING_PROGRAMS = new Set([
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
]);

/**
 * "Program data:" lines grouped by the top-level instruction that emitted them, for one program.
 * `instructionPrograms` is the program id of every top-level instruction, in order. Returns null
 * when the log cannot be trusted for attribution (truncated, or the number of top-level invokes
 * differs from the number of logging instructions).
 */
export function programDataByInstruction(logMessages, programId, instructionPrograms) {
  const logging = [];
  (instructionPrograms || []).forEach((program, index) => {
    if (!NON_LOGGING_PROGRAMS.has(program)) logging.push(index);
  });
  const out = new Map();
  const stack = [];
  let top = -1;
  for (const line of logMessages || []) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (invoke[2] === "1") {
        top += 1;
        stack.length = 0;
      }
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \S+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Program data: ") && stack.length === 1 && stack[0] === programId && top >= 0) {
      const index = logging[top];
      if (index === undefined) return null;
      if (!out.has(index)) out.set(index, []);
      out.get(index).push(line.slice("Program data: ".length));
      continue;
    }
    if (/^Log truncated/.test(line)) return null;
  }
  if (top + 1 !== logging.length) return null;
  return out;
}

function transactionKeys(tx) {
  const message = tx?.transaction?.message || {};
  const loaded = tx?.meta?.loadedAddresses || {};
  return [...(message.accountKeys || []), ...(loaded.writable || []), ...(loaded.readonly || [])].map(String);
}

/**
 * Every arena money movement in one Solana transaction (getTransaction, encoding "json").
 * Pure. Movements carry amount null when the vault delta is ambiguous; the runner then reads the
 * receipt account named in `receipt`.
 */
export function decodeSolanaArenaTransaction(tx, { programId = REWARDS_TREASURY_PROGRAM_ID } = {}) {
  const signature = String(tx?.transaction?.signatures?.[0] || "");
  const out = { signature, slot: Number(tx?.slot || 0), blockTime: tx?.blockTime ? new Date(Number(tx.blockTime) * 1000).toISOString() : null, failed: Boolean(tx?.meta?.err), movements: [], warnings: [] };
  if (!tx || out.failed) return out;
  const keys = transactionKeys(tx);
  const instructions = tx.transaction?.message?.instructions || [];
  const logs = programDataByInstruction(tx.meta?.logMessages, programId, instructions.map((ix) => keys[ix.programIdIndex]));
  if (!logs) out.warnings.push("log attribution unavailable; deposit events matched by order");
  const orderedEvents = [];
  if (!logs) {
    for (const line of tx.meta?.logMessages || []) {
      if (!line.startsWith("Program data: ")) continue;
      const event = decodeSolanaArenaEvent(line.slice("Program data: ".length));
      if (event) orderedEvents.push(event);
    }
  }

  const decoded = [];
  instructions.forEach((ix, index) => {
    if (keys[ix.programIdIndex] !== programId) return;
    let data;
    try {
      data = base58Decode(ix.data);
    } catch {
      return;
    }
    const name = IX_BY_DISCRIMINATOR.get(data.subarray(0, 8).toString("hex"));
    if (!name || data.length < 40) return;
    decoded.push({ index, name, spec: SOLANA_IX[name], data, accounts: (ix.accounts || []).map((i) => keys[i]), poolId: `0x${data.subarray(8, 40).toString("hex")}` });
  });
  for (const inner of tx.meta?.innerInstructions || []) {
    for (const ix of inner.instructions || []) {
      if (keys[ix.programIdIndex] === programId) out.warnings.push(`arena instruction inside a CPI (instruction ${inner.index}) is not indexed`);
    }
  }

  // Vault debits per vault, to know whether a vault delta belongs to one instruction.
  const debitsPerVault = new Map();
  for (const d of decoded) {
    if (d.spec.kind !== "claim") continue;
    d.vault = deriveSolanaArenaAccounts(d.poolId, programId).vault;
    debitsPerVault.set(d.vault, (debitsPerVault.get(d.vault) || 0) + 1);
  }

  for (const d of decoded) {
    if (d.spec.kind === "deposit") {
      const events = logs
        ? (logs.get(d.index) || []).map(decodeSolanaArenaEvent).filter(Boolean)
        : orderedEvents.length ? [orderedEvents.shift()] : [];
      for (const event of events) {
        if (event.poolId !== d.poolId) continue;
        out.movements.push({ table: "deposits", ixIndex: d.index, instruction: d.name, poolId: d.poolId, purpose: event.purpose, wallet: event.wallet, amount: event.amount });
      }
      if (!events.length) out.warnings.push(`${d.name} at instruction ${d.index} has no deposit event`);
      continue;
    }
    const place = d.spec.placeArg ? d.data[40] : d.spec.place || null;
    const vaultIndex = keys.indexOf(d.vault);
    let amount = null;
    if (vaultIndex >= 0 && debitsPerVault.get(d.vault) === 1) {
      const delta = BigInt(tx.meta.preBalances[vaultIndex]) - BigInt(tx.meta.postBalances[vaultIndex]);
      if (delta > 0n) amount = delta;
    }
    out.movements.push({
      table: "claims",
      ixIndex: d.index,
      instruction: d.name,
      poolId: d.poolId,
      bucket: d.spec.bucket,
      place,
      refundOf: d.spec.refundOf || null,
      wallet: d.accounts[d.spec.recipient] || null,
      amount,
      receipt: d.accounts[d.spec.receipt] || null,
    });
  }
  return out;
}

/** Amount (and recipient) of a claim or refund from the receipt account the program wrote. */
export function amountFromReceipt(movement, accountData) {
  if (!accountData) return null;
  const decoded = movement.bucket === "refund" ? decodeRefundReceipt(accountData) : decodeClaimReceipt(accountData);
  if (!decoded || `0x${decoded.poolId}` !== movement.poolId) return null;
  return { amount: decoded.amount, wallet: decoded.recipient || decoded.wallet || movement.wallet };
}

// --------------------------------------------------------------------------
// EVM decode (pure): ArenaWarPoolTreasuryV2 events

function topic(signature) {
  return keccakHex(Buffer.from(signature, "utf8"));
}

export const EVM_TOPICS = Object.freeze({
  StakeDeposited: topic("StakeDeposited(bytes32,address,uint256)"),
  BuyInDeposited: topic("BuyInDeposited(bytes32,address,uint256)"),
  BattleBoosted: topic("BattleBoosted(bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256)"),
  TournamentBoosted: topic("TournamentBoosted(bytes32,bytes32,uint256,address,address,uint256,uint256,uint256,uint256,uint256,uint256)"),
  Claimed: topic("Claimed(bytes32,bytes32,address,uint256)"),
  StakeRefunded: topic("StakeRefunded(bytes32,address,uint256)"),
  BuyInRefunded: topic("BuyInRefunded(bytes32,address,uint256)"),
  BoostRefunded: topic("BoostRefunded(bytes32,address,uint256)"),
});
const EVM_EVENT_BY_TOPIC = new Map(Object.entries(EVM_TOPICS).map(([name, t]) => [t, name]));

function evmWords(hex) {
  const text = String(hex || "").replace(/^0x/, "");
  const out = [];
  for (let i = 0; i + 64 <= text.length; i += 64) out.push(text.slice(i, i + 64));
  return out;
}

const wordBig = (w) => BigInt(`0x${w}`);
const wordAddr = (w) => `0x${String(w).replace(/^0x/, "").slice(-40)}`.toLowerCase();
const PLACE_TAG = 0x706c616365n; // "place"

/** Claimed's bytes32 bucket: "winner" | "operator" | "protocol" | "league" | place n. */
export function decodeEvmBucket(word) {
  const value = wordBig(word);
  if (value >> 8n === PLACE_TAG) return { bucket: "winner", place: Number(value & 0xffn) };
  const text = Buffer.from(word, "hex").toString("utf8").replace(/\0+$/, "");
  if (text === "winner") return { bucket: "winner", place: 1 };
  if (text === "league") return { bucket: "mwl", place: null };
  if (text === "protocol" || text === "operator") return { bucket: text, place: null };
  return null;
}

/** One ArenaWarPoolTreasuryV2 log (eth_getLogs shape) -> movement, or null. */
export function decodeEvmArenaLog(log) {
  const topics = (log?.topics || []).map((t) => String(t).toLowerCase());
  const name = EVM_EVENT_BY_TOPIC.get(topics[0]);
  if (!name || log.removed) return null;
  const words = evmWords(log.data);
  const base = { ixIndex: Number(BigInt(log.logIndex)), poolId: topics[1], event: name };
  switch (name) {
    case "StakeDeposited":
      return { ...base, table: "deposits", purpose: "stake", wallet: wordAddr(topics[2]), amount: wordBig(words[0]) };
    case "BuyInDeposited":
      return { ...base, table: "deposits", purpose: "buy_in", wallet: wordAddr(topics[2]), amount: wordBig(words[0]) };
    case "BattleBoosted":
      return { ...base, table: "deposits", purpose: "boost", wallet: wordAddr(topics[2]), amount: wordBig(words[2]) };
    case "TournamentBoosted":
      return { ...base, table: "deposits", purpose: "boost", wallet: wordAddr(words[0]), amount: wordBig(words[4]) };
    case "Claimed": {
      const bucket = decodeEvmBucket(words[0]);
      if (!bucket) return null;
      return { ...base, table: "claims", bucket: bucket.bucket, place: bucket.place, refundOf: null, wallet: wordAddr(topics[2]), amount: wordBig(words[1]) };
    }
    case "StakeRefunded":
      return { ...base, table: "claims", bucket: "refund", place: null, refundOf: "stake", wallet: wordAddr(topics[2]), amount: wordBig(words[0]) };
    case "BuyInRefunded":
      return { ...base, table: "claims", bucket: "refund", place: null, refundOf: "buy_in", wallet: wordAddr(topics[2]), amount: wordBig(words[0]) };
    case "BoostRefunded":
      return { ...base, table: "claims", bucket: "refund", place: null, refundOf: "boost", wallet: wordAddr(topics[2]), amount: wordBig(words[0]) };
    default:
      return null;
  }
}

// --------------------------------------------------------------------------
// Rows and database

/**
 * Browser receipt row for a deposit. The chain indexer (arenaWarPoolChainIndex.js) records the
 * same deposit from the transaction itself, so the receipt is skipped once any row of that
 * transaction exists, and the indexer replaces a receipt row with its chain row: one deposit is
 * never counted twice. No conflict target, so it works with the (chain_id, tx_hash) unique index
 * and with the (chain_id, tx_hash, ix_index) one that replaces it.
 */
export function receiptDepositSql(purpose) {
  if (purpose !== "stake" && purpose !== "support") throw new Error(`unknown receipt purpose ${purpose}`);
  return `insert into public.arena_war_pool_deposits (pool_id, purpose, wallet, amount_wei, tx_hash, chain_id)
          select $1::text, '${purpose}', $2::text, $3::numeric, $4::text, $5::integer
           where not exists (
             select 1 from public.arena_war_pool_deposits d
              where d.chain_id = $5::integer
                and (d.tx_hash = $4::text or ($4::text like '0x%' and lower(d.tx_hash) = lower($4::text))))
          on conflict do nothing`;
}

/** Database row for one movement. `subjects` maps pool id -> { kind, id }. */
export function movementRow(movement, { chainId, txHash, slot, blockTime, subjects }) {
  const subject = subjects?.get(String(movement.poolId).toLowerCase()) || null;
  return {
    table: movement.table,
    chainId: Number(chainId),
    poolId: String(movement.poolId).toLowerCase(),
    purpose: movement.purpose || null,
    bucket: movement.bucket || null,
    place: movement.place ?? null,
    refundOf: movement.refundOf || null,
    wallet: movement.wallet,
    amount: movement.amount == null ? null : BigInt(movement.amount).toString(),
    txHash,
    ixIndex: Number(movement.ixIndex),
    slot: slot == null ? null : Number(slot),
    blockTime: blockTime || null,
    subjectKind: subject?.kind || null,
    subjectId: subject?.id || null,
  };
}

const SAME_TX = `(tx_hash = $TX or ($TX like '0x%' and lower(tx_hash) = lower($TX)))`;
const sameTx = (n) => SAME_TX.replaceAll("$TX", `$${n}`);

export const UPSERT_DEPOSIT_SQL = `
  with absorbed as (
    delete from public.arena_war_pool_deposits
     where chain_id = $6 and ${sameTx(5)} and source = 'receipt' and purpose = $2
     returning id
  )
  insert into public.arena_war_pool_deposits
    (pool_id, purpose, wallet, amount_wei, tx_hash, chain_id, created_at, source, ix_index, slot, block_time, subject_kind, subject_id)
  values ($1, $2, $3, $4::numeric, $5, $6, coalesce($9::timestamptz, now()), 'chain', $7, $8, $9::timestamptz, $10, $11)
  on conflict (chain_id, tx_hash, (coalesce(ix_index, -1))) do update set
    pool_id = excluded.pool_id, purpose = excluded.purpose, wallet = excluded.wallet, amount_wei = excluded.amount_wei,
    created_at = excluded.created_at, source = 'chain', slot = excluded.slot, block_time = excluded.block_time,
    subject_kind = coalesce(excluded.subject_kind, public.arena_war_pool_deposits.subject_kind),
    subject_id = coalesce(excluded.subject_id, public.arena_war_pool_deposits.subject_id)
  returning (xmax = 0) as inserted, (select count(*)::int from absorbed) as absorbed`;

export const UPSERT_CLAIM_SQL = `
  insert into public.arena_war_pool_claims
    (pool_id, bucket, wallet, amount_wei, tx_hash, chain_id, created_at, source, ix_index, slot, block_time, subject_kind, subject_id, place, refund_of)
  values ($1, $2, $3, $4::numeric, $5, $6, coalesce($9::timestamptz, now()), 'chain', $7, $8, $9::timestamptz, $10, $11, $12, $13)
  on conflict (chain_id, tx_hash, (coalesce(ix_index, -1))) do update set
    pool_id = excluded.pool_id, bucket = excluded.bucket, wallet = excluded.wallet, amount_wei = excluded.amount_wei,
    created_at = excluded.created_at, source = 'chain', slot = excluded.slot, block_time = excluded.block_time,
    subject_kind = coalesce(excluded.subject_kind, public.arena_war_pool_claims.subject_kind),
    subject_id = coalesce(excluded.subject_id, public.arena_war_pool_claims.subject_id),
    place = excluded.place, refund_of = excluded.refund_of
  returning (xmax = 0) as inserted, 0 as absorbed`;

/** Receipt rows whose transaction already has a chain row (a receipt that raced the indexer). */
export const ABSORB_SHADOWED_RECEIPTS_SQL = `
  delete from public.arena_war_pool_deposits r
   where r.chain_id = $1 and r.source = 'receipt'
     and exists (select 1 from public.arena_war_pool_deposits c
                  where c.chain_id = r.chain_id and c.source = 'chain' and c.purpose = r.purpose
                    and (c.tx_hash = r.tx_hash or (c.tx_hash like '0x%' and lower(c.tx_hash) = lower(r.tx_hash))))
  returning r.id`;

function upsertParams(row) {
  const base = [row.poolId, row.table === "deposits" ? row.purpose : row.bucket, row.wallet, row.amount, row.txHash, row.chainId, row.ixIndex, row.slot, row.blockTime, row.subjectKind, row.subjectId];
  return row.table === "deposits" ? base : [...base, row.place, row.refundOf];
}

/** Writes one chain row. Returns "inserted" | "updated" | "replaced-receipt". */
export async function writeChainRow(db, row) {
  if (!row.amount || BigInt(row.amount) <= 0n) throw new Error(`refusing a row without an amount (${row.txHash} #${row.ixIndex})`);
  const result = await db.query(row.table === "deposits" ? UPSERT_DEPOSIT_SQL : UPSERT_CLAIM_SQL, upsertParams(row));
  const r = result.rows?.[0] || {};
  if (Number(r.absorbed) > 0) return "replaced-receipt";
  return r.inserted ? "inserted" : "updated";
}

/** What writeChainRow would do, without writing: for --dry-run. */
export async function classifyChainRow(db, row) {
  const table = row.table === "deposits" ? "arena_war_pool_deposits" : "arena_war_pool_claims";
  let existing;
  try {
    existing = await db.query(
      `select tx_hash, amount_wei::text as amount, ${row.table === "deposits" ? "purpose" : "bucket as purpose"},
              coalesce(to_jsonb(t) ->> 'source', 'receipt') as source, (to_jsonb(t) ->> 'ix_index') as ix_index
         from public.${table} t
        where chain_id = $1 and ${sameTx(2)}`,
      [row.chainId, row.txHash],
    );
  } catch (error) {
    return `unknown (${String(error?.message || error).slice(0, 80)})`;
  }
  const rows = existing.rows || [];
  const same = rows.find((r) => r.source === "chain" && Number(r.ix_index) === row.ixIndex);
  if (same) return same.amount === row.amount ? "unchanged" : "update";
  const kind = row.table === "deposits" ? row.purpose : row.bucket;
  if (rows.some((r) => r.source === "receipt" && r.purpose === kind)) return "replace-receipt";
  return "insert";
}

export async function readCursor(db, chainId, scope) {
  const result = await db.query(`select cursor from public.arena_war_pool_index_cursors where chain_id = $1 and scope = $2`, [Number(chainId), scope]);
  return result.rows?.[0]?.cursor || null;
}

export async function writeCursor(db, chainId, scope, cursor) {
  await db.query(
    `insert into public.arena_war_pool_index_cursors (chain_id, scope, cursor, updated_at) values ($1, $2, $3, now())
     on conflict (chain_id, scope) do update set cursor = excluded.cursor, updated_at = now()`,
    [Number(chainId), scope, String(cursor)],
  );
}

/** Battles and tournaments that can have a pool on this chain, newest first (same filter as the finance read). */
export const INDEX_SUBJECTS_SQL = `
  select * from (
    select 'battle' as kind, b.id, b.created_at
      from public.arena_battles b
     where b.chain_id = $1 and b.tournament_id is null and coalesce(b.source, '') <> 'tournament'
       and (greatest(coalesce(b.stake_native, 0), coalesce(b.offered_stake_native, 0)) > 0
            or exists (select 1 from public.arena_contest_actions a where a.chain_id = b.chain_id and a.battle_id = b.id and a.action_type = 'boost'))
    union all
    select 'tournament' as kind, t.id, t.created_at from public.arena_tournaments t where t.chain_id = $1
  ) s
  order by created_at desc nulls last
  limit $2`;

export async function loadIndexSubjects(db, chainId, limit = 500) {
  const result = await db.query(INDEX_SUBJECTS_SQL, [Number(chainId), Number(limit)]);
  return (result.rows || []).map((r) => ({ kind: r.kind, id: String(r.id), createdAt: r.created_at }));
}

export function subjectMap(subjects) {
  return new Map(subjects.map((s) => [subjectPoolId(s), { kind: s.kind, id: s.id }]));
}

// --------------------------------------------------------------------------
// RPC

export function jsonRpc({ urls, fetchImpl = fetch, timeoutMs = 15_000, minIntervalMs = 0, retries = 6 }) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  let nextAt = 0;
  const pace = async () => {
    const wait = nextAt - Date.now();
    nextAt = Math.max(Date.now(), nextAt) + Number(minIntervalMs || 0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  return async function call(method, params) {
    let last = new Error("No RPC URL configured.");
    for (const url of list) {
      for (let attempt = 0; attempt < retries; attempt += 1) {
        await pace();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
          if (response.status === 429) {
            last = new Error(`${method} rate limited`);
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            continue;
          }
          if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
          const payload = await response.json();
          if (payload?.error) throw new Error(`${method}: ${payload.error.message || "rpc error"}`);
          return payload.result;
        } catch (error) {
          last = error;
          break;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    throw last;
  };
}

// --------------------------------------------------------------------------
// Runners

async function emitRow({ db, row, dryRun, summary, logger }) {
  const action = dryRun ? await classifyChainRow(db, row) : await writeChainRow(db, row);
  summary.rows.push({ ...row, action });
  summary.actions[action] = (summary.actions[action] || 0) + 1;
  if (dryRun || action !== "updated") {
    logger.log?.(`[arena-war-pool-index] ${dryRun ? "would " : ""}${action} ${row.table === "deposits" ? row.purpose : row.bucket}${row.place ? ` place ${row.place}` : ""}${row.refundOf ? ` of ${row.refundOf}` : ""} ${row.amount} ${row.subjectId || row.poolId} ${row.wallet} ${row.txHash} #${row.ixIndex}`);
  }
}

async function signaturesSince(rpc, address, until, pageLimit = 1000) {
  const out = [];
  let before;
  for (;;) {
    const opts = { limit: pageLimit, commitment: "finalized" };
    if (until) opts.until = until;
    if (before) opts.before = before;
    const page = (await rpc("getSignaturesForAddress", [address, opts])) || [];
    out.push(...page);
    if (page.length < pageLimit) break;
    before = page[page.length - 1].signature;
  }
  return out.reverse(); // oldest first
}

/**
 * Indexes every Solana pool of the given subjects. Per pool: the signatures since the pool's
 * cursor (all of them with ignoreCursor), each transaction decoded, rows written (or classified
 * with dryRun), then the cursor moves to the newest signature fully handled.
 */
export async function indexSolanaArena({ db, rpc, chainId = 101, subjects, programId = REWARDS_TREASURY_PROGRAM_ID, dryRun = false, ignoreCursor = false, logger = console }) {
  const pools = subjectMap(subjects);
  const summary = { chainId: Number(chainId), pools: 0, signatures: 0, transactions: 0, rows: [], actions: {}, warnings: [], absorbed: 0 };
  for (const subject of subjects) {
    const poolId = subjectPoolId(subject);
    const accounts = deriveSolanaArenaAccounts(poolId, programId);
    const scope = `pool:${poolId}`;
    const cursor = ignoreCursor ? null : await readCursor(db, chainId, scope).catch(() => null);
    let signatures;
    try {
      signatures = await signaturesSince(rpc, accounts.pool, cursor);
    } catch (error) {
      summary.warnings.push(`${subject.id}: signatures could not be read: ${String(error?.message || error)}`);
      continue;
    }
    summary.pools += 1;
    summary.signatures += signatures.length;
    let newest = null;
    for (const sig of signatures) {
      if (sig.err) {
        newest = sig.signature;
        continue;
      }
      const tx = await rpc("getTransaction", [sig.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
      if (!tx) {
        summary.warnings.push(`${subject.id}: transaction ${sig.signature} not available yet; the pool resumes from here next pass`);
        break;
      }
      summary.transactions += 1;
      const decoded = decodeSolanaArenaTransaction(tx, { programId });
      for (const w of decoded.warnings) summary.warnings.push(`${sig.signature}: ${w}`);
      for (const movement of decoded.movements) {
        // Another pool's movement in the same transaction is written when that pool is read.
        if (movement.poolId !== poolId) continue;
        if (movement.amount == null && movement.receipt) {
          const info = await rpc("getAccountInfo", [movement.receipt, { encoding: "base64", commitment: "finalized" }]);
          const data = info?.value?.data?.[0] ? Buffer.from(info.value.data[0], "base64") : null;
          const fromReceipt = amountFromReceipt(movement, data);
          if (fromReceipt) {
            movement.amount = fromReceipt.amount;
            movement.wallet = fromReceipt.wallet;
          }
        }
        if (movement.amount == null) {
          summary.warnings.push(`${sig.signature} #${movement.ixIndex}: ${movement.instruction} amount unknown; not written`);
          continue;
        }
        const row = movementRow(movement, { chainId, txHash: decoded.signature || sig.signature, slot: decoded.slot, blockTime: decoded.blockTime, subjects: pools });
        await emitRow({ db, row, dryRun, summary, logger });
      }
      newest = sig.signature;
    }
    if (!dryRun && newest && newest !== cursor) await writeCursor(db, chainId, scope, newest);
  }
  if (!dryRun) {
    const absorbed = await db.query(ABSORB_SHADOWED_RECEIPTS_SQL, [Number(chainId)]);
    summary.absorbed = absorbed.rows?.length || 0;
  }
  return summary;
}

/**
 * Indexes ArenaWarPoolTreasuryV2 logs from the cursor block (or fromBlock on the first run) to
 * head - confirmations, in spans of blockSpan blocks.
 */
export async function indexEvmArena({ db, rpc, chainId, treasury, subjects, fromBlock, blockSpan = 5000, confirmations = 12, dryRun = false, ignoreCursor = false, logger = console }) {
  const address = String(treasury || "").toLowerCase();
  const summary = { chainId: Number(chainId), treasury: address, fromBlock: null, toBlock: null, logs: 0, rows: [], actions: {}, warnings: [], absorbed: 0 };
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    summary.warnings.push("no ArenaWarPoolTreasuryV2 address for this chain");
    return summary;
  }
  const scope = `logs:${address}`;
  const cursor = ignoreCursor ? null : await readCursor(db, chainId, scope).catch(() => null);
  let start = cursor != null ? Number(cursor) : Number(fromBlock);
  if (!Number.isFinite(start) || start < 0) {
    summary.warnings.push("no start block: pass --from-block (the treasury's deployment block) on the first run");
    return summary;
  }
  const head = Number(BigInt(await rpc("eth_blockNumber", []))) - Number(confirmations);
  summary.fromBlock = start;
  const pools = subjectMap(subjects);
  const blockTimes = new Map();
  const blockTime = async (hex) => {
    if (!blockTimes.has(hex)) {
      const block = await rpc("eth_getBlockByNumber", [hex, false]);
      blockTimes.set(hex, block?.timestamp ? new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() : null);
    }
    return blockTimes.get(hex);
  };
  while (start <= head) {
    const end = Math.min(head, start + Number(blockSpan) - 1);
    const logs = (await rpc("eth_getLogs", [{ address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: [Object.values(EVM_TOPICS)] }])) || [];
    summary.logs += logs.length;
    for (const log of logs) {
      const movement = decodeEvmArenaLog(log);
      if (!movement || movement.amount <= 0n) continue;
      const row = movementRow(movement, { chainId, txHash: String(log.transactionHash).toLowerCase(), slot: Number(BigInt(log.blockNumber)), blockTime: await blockTime(log.blockNumber), subjects: pools });
      await emitRow({ db, row, dryRun, summary, logger });
    }
    if (!dryRun) await writeCursor(db, chainId, scope, end + 1);
    summary.toBlock = end;
    start = end + 1;
  }
  if (!dryRun) {
    const absorbed = await db.query(ABSORB_SHADOWED_RECEIPTS_SQL, [Number(chainId)]);
    summary.absorbed = absorbed.rows?.length || 0;
  }
  return summary;
}
