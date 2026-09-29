/**
 * DBC step 5b: paying out the creator pot of platform coins (holders / split / buyback, D5 + D19).
 *
 * The pot of a coin is the creator_pool its accruals left on the collector (dbc_fee_accruals rows
 * claimed/routing/routed: trade fees and, after graduation, LP fees). Entitlements are computed from
 * the pot's lifetime total, so nothing leaks between parts when a holder share rolls over:
 *   split:    creator due = floor(total x pct / 100) - creator paid; holders due = rest - holders paid
 *   holders:  holders due = total - holders paid
 *   buyback:  buyback due = total - buyback spent
 * A coin paired with another quote (USDC, USDT, an xStock) keeps its pot in that quote on the
 * collector, so its ledger is in quote raw units: the split creator is paid in the quote, buybacks
 * spend the quote on the coin's own pool, and the holders' part is swapped to SOL (Jupiter, keyed)
 * and joins the weekly SOL round.
 * Every movement: sign, store sending + signature + lastValidBlockHeight, send; the next pass
 * resolves it with getTransaction, then getSignatureStatuses + getBlockHeight. A send that may have
 * landed is never reset. Rows are updated by id.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createBurnCheckedInstruction, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { solanaMinPayoutLamports } from "../rewards/pokerPayout.js";
import { bs58Encode, resolveSignature } from "./dbcFeePending.js";
import { rewardVaults } from "./dbcFeeRouter.js";
import { isNativeQuoteMint, quoteDecimalsFromMeta, quoteMintFromMeta, quoteTokenProgram } from "./dbcQuoteNative.js";
import { buildD7CompensationIxs } from "./dbcQuoteTransfers.js";
import { resolvePendingQuoteSwaps, swapClaimedQuoteIfNeeded, type SwapQuoteFn } from "./dbcQuoteToSolSwap.js";
import { jupiterRawUnitUsd } from "../solanaMarketStats.js";
import {
  allocateToHolders,
  buybackMoments,
  holderLeaves,
  previousWeek,
  snapshotMoment,
  weekCommitment,
  weekOf,
  weekSecret,
  type HolderBalance,
} from "./dbcCreatorChoice.js";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export const DBC_TOKEN_DECIMALS = 6;
const TOKEN_ACCOUNT_SIZE = 165;

export type PlatformCoin = {
  pool: string;
  mint: string;
  creator: string;
  choice: "holders" | "split" | "buyback";
  creatorSharePct: number;
  dammPool: string | null;
  quoteMint: string;
  quoteDecimals: number;
};

/**
 * total and paid are in the pot's unit (lamports, or quote raw for a bound coin). holdersSwap is the
 * quote a bound coin swapped for its holders; holdersSolIn is the SOL that swap brought, and
 * paid.holders (always SOL) is what went into holder rounds.
 */
export type CoinLedger = {
  total: bigint;
  paid: { holders: bigint; creator: bigint; buyback: bigint; holdersSwap?: bigint };
  holdersSolIn?: bigint;
};

export function envBigint(name: string, fallback: bigint): bigint {
  const raw = String(process.env[name] || "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  return BigInt(raw);
}

// ---------------------------------------------------------------- entitlements (pure given a ledger)

export function dues(coin: Pick<PlatformCoin, "choice" | "creatorSharePct"> & { quoteMint?: string }, ledger: CoinLedger) {
  const { total, paid } = ledger;
  // A bound coin's holder share leaves the pot when it is swapped to SOL, not when the SOL is paid.
  const holdersPaid = isNativeQuoteMint(coin.quoteMint) ? paid.holders : (paid.holdersSwap || 0n);
  if (coin.choice === "buyback") return { creator: 0n, holders: 0n, buyback: total - paid.buyback };
  if (coin.choice === "holders") return { creator: 0n, holders: total - holdersPaid, buyback: 0n };
  const creatorShare = (total * BigInt(Math.trunc(coin.creatorSharePct))) / 100n;
  return { creator: creatorShare - paid.creator, holders: total - creatorShare - holdersPaid, buyback: 0n };
}

/** SOL a bound coin's holders are owed: what its swaps brought in minus what rounds already paid. */
export function boundHoldersSol(ledger: CoinLedger): bigint {
  const left = (ledger.holdersSolIn || 0n) - ledger.paid.holders;
  return left > 0n ? left : 0n;
}

// ---------------------------------------------------------------- database reads

export async function platformCoins(db: Queryable): Promise<PlatformCoin[]> {
  const { rows } = await db.query(
    `select campaign_address, token_address, creator_address, meta
       from public.campaigns
      where chain_id = 101
        and coalesce(launch_type, 'launchpad') = 'dbc'
        and meta #>> '{dbc,feeChoice}' in ('holders', 'split', 'buyback')`,
  );
  return rows.map((row: any) => ({
    pool: String(row.campaign_address),
    mint: String(row.token_address),
    creator: String(row.creator_address || ""),
    choice: String(row.meta?.dbc?.feeChoice) as PlatformCoin["choice"],
    creatorSharePct: Number(row.meta?.dbc?.creatorSharePct || 0),
    dammPool: String(row.meta?.dbc?.migration?.pool || row.meta?.solanaGraduation?.pool || "") || null,
    quoteMint: quoteMintFromMeta(row.meta),
    quoteDecimals: quoteDecimalsFromMeta(row.meta, isNativeQuoteMint(quoteMintFromMeta(row.meta)) ? 9 : 6),
  }));
}

export async function coinLedgers(db: Queryable): Promise<Map<string, CoinLedger>> {
  const pot = await db.query(
    `select pool, coalesce(sum(creator_pool), 0)::text as total
       from public.dbc_fee_accruals
      where status in ('claimed', 'routing', 'routed') and creator_pool > 0
      group by pool`,
  );
  const paid = await db.query(
    `select pool, kind, coalesce(sum(lamports), 0)::text as paid,
            coalesce(sum(case when status = 'landed' then sol_received else 0 end), 0)::text as sol_in
       from public.dbc_creator_pool_payouts
      where status in ('sending', 'landed')
      group by pool, kind`,
  );
  const out = new Map<string, CoinLedger>();
  const ledger = (pool: string) => {
    let row = out.get(pool);
    if (!row) {
      row = { total: 0n, paid: { holders: 0n, creator: 0n, buyback: 0n } };
      out.set(pool, row);
    }
    return row;
  };
  for (const row of pot.rows) ledger(String(row.pool)).total = BigInt(String(row.total));
  for (const row of paid.rows) {
    const target = ledger(String(row.pool));
    if (String(row.kind) === "holders_swap") {
      target.paid.holdersSwap = BigInt(String(row.paid));
      target.holdersSolIn = BigInt(String(row.sol_in));
      continue;
    }
    const kind = String(row.kind) as "holders" | "creator" | "buyback";
    target.paid[kind] = BigInt(String(row.paid));
  }
  return out;
}

// ---------------------------------------------------------------- the week's secret

export async function ensureWeekSecrets(db: Queryable, masterSecret: string, now: Date) {
  const current = weekOf(now);
  const next = weekOf(new Date(current.end.getTime() + 1));
  for (const week of [current, next]) {
    await db.query(
      `insert into public.dbc_buyback_weeks (week_id, commitment) values ($1, $2) on conflict (week_id) do nothing`,
      [week.weekId, weekCommitment(weekSecret(masterSecret, week.weekId))],
    );
  }
  // Reveal every finished week so anyone can recompute its moments.
  const { rows } = await db.query(`select week_id from public.dbc_buyback_weeks where secret is null`);
  for (const row of rows) {
    const week = weekOf(new Date(`${row.week_id}T00:00:00Z`));
    if (week.end.getTime() > now.getTime()) continue;
    const secret = weekSecret(masterSecret, week.weekId);
    await db.query(
      `update public.dbc_buyback_weeks set secret = $2, revealed_at = now() where week_id = $1 and commitment = $3`,
      [week.weekId, secret, weekCommitment(secret)],
    );
  }
}

// ---------------------------------------------------------------- holder snapshot

export function parseTokenAccount(data: Buffer): { mint: string; owner: string; amount: bigint } {
  return {
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64),
  };
}

/**
 * Wallets only: an owner off the ed25519 curve is a program account (the DBC pool vault, DAMM vaults,
 * Jupiter Lock escrows), never a holder. Excluded wallets (creator, collector, referral owner, extra)
 * are dropped too. Balances are summed per owner.
 */
export function holderBalances(accounts: Array<{ owner: string; amount: bigint }>, excluded: Set<string>): HolderBalance[] {
  const byOwner = new Map<string, bigint>();
  for (const account of accounts) {
    if (account.amount <= 0n || excluded.has(account.owner)) continue;
    if (!PublicKey.isOnCurve(new PublicKey(account.owner).toBytes())) continue;
    byOwner.set(account.owner, (byOwner.get(account.owner) || 0n) + account.amount);
  }
  return [...byOwner.entries()].map(([owner, amount]) => ({ owner, amount }));
}

export async function takeDueSnapshots(input: {
  db: Queryable;
  connection: Connection;
  masterSecret: string;
  excluded: Set<string>;
  now: Date;
}): Promise<number> {
  const week = weekOf(input.now);
  const due = snapshotMoment(weekSecret(input.masterSecret, week.weekId), week.start);
  if (input.now.getTime() < due.getTime()) return 0;
  const coins = (await platformCoins(input.db)).filter((coin) => coin.choice !== "buyback");
  let taken = 0;
  for (const coin of coins) {
    const done = await input.db.query(
      `select 1 from public.dbc_holder_snapshot_runs where week_id = $1 and mint = $2`,
      [week.weekId, coin.mint],
    );
    if ((done.rowCount ?? done.rows.length) > 0) continue;
    const slot = await input.connection.getSlot("confirmed");
    const accounts = await input.connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: coin.mint } }],
    });
    const excluded = new Set([...input.excluded, coin.creator]);
    const balances = holderBalances(accounts.map((a) => parseTokenAccount(Buffer.from(a.account.data))), excluded);
    for (const b of balances) {
      await input.db.query(
        `insert into public.dbc_holder_snapshots (week_id, mint, owner, amount) values ($1,$2,$3,$4)
         on conflict (week_id, mint, owner) do nothing`,
        [week.weekId, coin.mint, b.owner, b.amount.toString()],
      );
    }
    await input.db.query(
      `insert into public.dbc_holder_snapshot_runs (week_id, mint, pool, slot, holders) values ($1,$2,$3,$4,$5)
       on conflict (week_id, mint) do nothing`,
      [week.weekId, coin.mint, coin.pool, slot, balances.length],
    );
    taken += 1;
  }
  return taken;
}

// ---------------------------------------------------------------- sending

async function signForSend(connection: Connection, collector: Keypair, tx: Transaction) {
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = collector.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.partialSign(collector);
  const serialized = tx.serialize();
  return { serialized, signature: bs58Encode(serialized.subarray(1, 65)), latest };
}

async function sendSigned(connection: Connection, serialized: Buffer, signature: string, latest: { blockhash: string; lastValidBlockHeight: number }) {
  try {
    await connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 8 });
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return confirmation.value.err ? "failed" : "landed";
  } catch (error) {
    console.warn("[dbc-5b] send/confirm error; left pending for the resolver", {
      signature,
      error: String(error instanceof Error ? error.message : error),
    });
    return "pending";
  }
}

async function collectorCanPay(connection: Connection, collector: Keypair, spend: bigint): Promise<boolean> {
  const have = BigInt(await connection.getBalance(collector.publicKey, "confirmed"));
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  return have >= spend + rent + 10_000n;
}

type Outcome = "landed" | "failed" | "expired" | "pending";

async function signatureOutcome(connection: Connection, signature: string, lastValid: number): Promise<Outcome> {
  const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (tx) return tx.meta?.err ? "failed" : "landed";
  return resolveSignature(connection, signature, lastValid);
}

/** Resolve payouts and holder rounds left in 'sending' by an earlier pass. */
export async function resolvePendingPayouts(db: Queryable, connection: Connection, collector?: string) {
  // Holder-share swaps of bound coins follow their dbc_quote_swaps row.
  const swaps = await db.query(
    `select p.id, s.status as swap_status, s.sol_out
       from public.dbc_creator_pool_payouts p
       join public.dbc_quote_swaps s on s.id = p.quote_swap_id
      where p.kind = 'holders_swap' and p.status = 'sending'`,
  );
  if (swaps.rows.some((row: any) => row.swap_status === "sending")) {
    await resolvePendingQuoteSwaps({ db, connection, collector });
  }
  for (const row of swaps.rows) {
    const now = (await db.query(
      `select s.status, s.sol_out from public.dbc_quote_swaps s join public.dbc_creator_pool_payouts p on p.quote_swap_id = s.id where p.id = $1`,
      [row.id],
    )).rows[0];
    if (!now || now.status === "sending") continue;
    if (now.status === "done") {
      await db.query(
        `update public.dbc_creator_pool_payouts set status = 'landed', sol_received = $2, updated_at = now() where id = $1`,
        [row.id, String(now.sol_out || "0")],
      );
    } else {
      await db.query(`update public.dbc_creator_pool_payouts set status = 'failed', updated_at = now() where id = $1`, [row.id]);
    }
  }
  const rounds = await db.query(`select * from public.dbc_holder_rounds where status = 'sending'`);
  for (const round of rounds.rows) {
    const outcome = await signatureOutcome(connection, String(round.signature), Number(round.last_valid_block_height || 0));
    if (outcome === "pending") continue;
    const landed = outcome === "landed";
    await db.query(
      `update public.dbc_holder_rounds set status = $2, signature = case when $2 = 'ready' then null else signature end,
              updated_at = now() where week_id = $1`,
      [round.week_id, landed ? "landed" : "ready"],
    );
    await db.query(
      `update public.dbc_creator_pool_payouts set status = $2, updated_at = now()
        where kind = 'holders' and week_id = $1 and status = 'sending'`,
      [round.week_id, landed ? "landed" : "failed"],
    );
  }
  const payouts = await db.query(
    `select id, signature, last_valid_block_height from public.dbc_creator_pool_payouts
      where status = 'sending' and kind not in ('holders', 'holders_swap')`,
  );
  for (const row of payouts.rows) {
    const outcome = await signatureOutcome(connection, String(row.signature), Number(row.last_valid_block_height || 0));
    if (outcome === "pending") continue;
    await db.query(
      `update public.dbc_creator_pool_payouts set status = $2, updated_at = now() where id = $1`,
      [row.id, outcome === "landed" ? "landed" : "failed"],
    );
  }
}

async function collectorQuoteBalance(connection: Connection, collector: PublicKey, mint: string, program: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), collector, false, program);
  const info = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
  return info ? BigInt(info.value.amount) : 0n;
}

/**
 * Swap each bound coin's holder share to SOL for this week's round. Returns "waiting" while any of
 * this week's swaps is still sending. Only coins with a snapshot this week swap (the others roll over,
 * as SOL coins do), so the SOL is never stranded outside a round.
 */
async function swapBoundHolderShares(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  week: string;
  coins: PlatformCoin[];
  ledgers: Map<string, CoinLedger>;
  swapQuote?: SwapQuoteFn;
}): Promise<"ready" | "waiting"> {
  if (!input.send) return "ready";
  await resolvePendingPayouts(input.db, input.connection, input.collector.publicKey.toBase58());
  const empty: CoinLedger = { total: 0n, paid: { holders: 0n, creator: 0n, buyback: 0n } };
  let waiting = false;
  for (const coin of input.coins.filter((c) => (c.choice === "holders" || c.choice === "split") && !isNativeQuoteMint(c.quoteMint))) {
    const live = (await input.db.query(
      `select status from public.dbc_creator_pool_payouts
        where pool = $1 and kind = 'holders_swap' and moment_key = $2 and status <> 'failed'`,
      [coin.pool, `week:${input.week}`],
    )).rows[0];
    if (live?.status === "sending") { waiting = true; continue; }
    if (live) continue;
    const due = dues(coin, input.ledgers.get(coin.pool) || empty).holders;
    if (due <= 0n) continue;
    const snap = await input.db.query(`select 1 from public.dbc_holder_snapshots where week_id = $1 and mint = $2 limit 1`, [input.week, coin.mint]);
    if (!snap.rows.length) continue;
    const program = await quoteTokenProgram(input.connection as any, coin.quoteMint);
    if ((await collectorQuoteBalance(input.connection, input.collector.publicKey, coin.quoteMint, program)) < due) {
      console.error("[dbc-5b] collector holds less quote than a holder share; retry next pass", { pool: coin.pool, due: due.toString() });
      continue;
    }
    const swapped = await swapClaimedQuoteIfNeeded({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      quoteMint: coin.quoteMint,
      quoteIn: due,
      send: true,
      swapQuote: input.swapQuote,
      key: `holders:${coin.pool}:${input.week}`,
    });
    if (swapped.skipped === "impact-cap" || swapped.skipped === "failed-on-chain" || !swapped.id) continue; // rolls over
    const sending = swapped.skipped === "sending";
    await input.db.query(
      `insert into public.dbc_creator_pool_payouts
         (pool, kind, week_id, moment_key, lamports, recipient, status, quote_mint, quote_swap_id, sol_received)
       values ($1,'holders_swap',$2,$3,$4,'jupiter',$5,$6,$7,$8)`,
      [coin.pool, input.week, `week:${input.week}`, due.toString(), sending ? "sending" : "landed", coin.quoteMint, swapped.id, sending ? null : swapped.solOut.toString()],
    );
    if (sending) waiting = true;
  }
  return waiting ? "waiting" : "ready";
}

// ---------------------------------------------------------------- the weekly run (split + holders)

export async function runWeeklyPayouts(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  now: Date;
  treasuryProgram?: string;
  swapQuote?: SwapQuoteFn;
}): Promise<{ weekId: string; creatorPayouts: number; holderRound: string }> {
  const week = previousWeek(input.now);
  const coins = await platformCoins(input.db);
  let ledgers = await coinLedgers(input.db);
  const empty: CoinLedger = { total: 0n, paid: { holders: 0n, creator: 0n, buyback: 0n } };
  let creatorPayouts = 0;

  // 1. Split: the creator's percent goes straight to the creator's wallet.
  for (const coin of coins.filter((c) => c.choice === "split")) {
    const due = dues(coin, ledgers.get(coin.pool) || empty).creator;
    if (due <= 0n || !input.send) continue;
    const exists = await input.db.query(
      `select 1 from public.dbc_creator_pool_payouts
        where pool = $1 and kind = 'creator' and moment_key = $2 and status <> 'failed'`,
      [coin.pool, `week:${week.weekId}`],
    );
    if ((exists.rowCount ?? exists.rows.length) > 0) continue;
    const bound = !isNativeQuoteMint(coin.quoteMint);
    let tx: Transaction;
    if (bound) {
      // D21: the creator is paid in the coin's quote.
      const program = await quoteTokenProgram(input.connection as any, coin.quoteMint);
      if ((await collectorQuoteBalance(input.connection, input.collector.publicKey, coin.quoteMint, program)) < due
        || !(await collectorCanPay(input.connection, input.collector, 0n))) {
        console.error("[dbc-5b] collector short for a split payout; retry next pass", { pool: coin.pool, due: due.toString(), quote: coin.quoteMint });
        continue;
      }
      const decimals = (await getMint(input.connection as any, new PublicKey(coin.quoteMint), "confirmed", program)).decimals;
      tx = new Transaction();
      for (const ix of buildD7CompensationIxs({
        collector: input.collector.publicKey, creator: new PublicKey(coin.creator), quoteMint: coin.quoteMint, amount: due, decimals, tokenProgram: program,
      })) tx.add(ix);
    } else {
      if (!(await collectorCanPay(input.connection, input.collector, due))) {
        console.error("[dbc-5b] collector short for a split payout; retry next pass", { pool: coin.pool, due: due.toString() });
        continue;
      }
      tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: input.collector.publicKey, toPubkey: new PublicKey(coin.creator), lamports: Number(due),
      }));
    }
    const signed = await signForSend(input.connection, input.collector, tx);
    const inserted = await input.db.query(
      `insert into public.dbc_creator_pool_payouts
         (pool, kind, week_id, moment_key, lamports, recipient, signature, last_valid_block_height, status, quote_mint)
       values ($1,'creator',$2,$3,$4,$5,$6,$7,'sending',$8) returning id`,
      [coin.pool, week.weekId, `week:${week.weekId}`, due.toString(), coin.creator, signed.signature, signed.latest.lastValidBlockHeight, bound ? coin.quoteMint : null],
    );
    const outcome = await sendSigned(input.connection, signed.serialized, signed.signature, signed.latest);
    if (outcome !== "pending") {
      await input.db.query(`update public.dbc_creator_pool_payouts set status = $2, updated_at = now() where id = $1`, [inserted.rows[0].id, outcome]);
    }
    creatorPayouts += 1;
  }

  // 2. Holders: one round per week, leaves fixed once computed, one deposit into airdrop_vault.
  let round = (await input.db.query(`select * from public.dbc_holder_rounds where week_id = $1`, [week.weekId])).rows[0];
  if (!round) {
    // 2a. A bound coin's holder share is quote tokens: swap it to SOL first (keyed per coin and week,
    // so a retry resumes the same swap). The round waits until no swap is still sending.
    const swapState = await swapBoundHolderShares({ ...input, week: week.weekId, coins, ledgers });
    if (swapState === "waiting") return { weekId: week.weekId, creatorPayouts, holderRound: "waiting-swap" };
    ledgers = await coinLedgers(input.db);
    const perCoin = new Map<string, Map<string, bigint>>();
    for (const coin of coins.filter((c) => c.choice === "holders" || c.choice === "split")) {
      const ledger = ledgers.get(coin.pool) || empty;
      const pot = isNativeQuoteMint(coin.quoteMint) ? dues(coin, ledger).holders : boundHoldersSol(ledger);
      if (pot <= 0n) continue;
      const snap = await input.db.query(
        `select owner, amount from public.dbc_holder_snapshots where week_id = $1 and mint = $2`,
        [week.weekId, coin.mint],
      );
      if (!snap.rows.length) continue; // no snapshot this week (launched after it): rolls over
      const balances = snap.rows.map((r: any) => ({ owner: String(r.owner), amount: BigInt(String(r.amount)) }));
      perCoin.set(coin.pool, allocateToHolders(pot, balances));
    }
    const { leaves, paidByPool } = holderLeaves(perCoin, solanaMinPayoutLamports());
    const total = [...leaves.values()].reduce((sum, v) => sum + v, 0n);
    if (total <= 0n) return { weekId: week.weekId, creatorPayouts, holderRound: "nothing-to-pay" };
    await input.db.query(
      `insert into public.dbc_holder_rounds (week_id, total_lamports, leaves, status) values ($1,$2,$3::jsonb,'ready')
       on conflict (week_id) do nothing`,
      [
        week.weekId,
        total.toString(),
        JSON.stringify({
          leaves: [...leaves.entries()].map(([owner, amount]) => ({ owner, amount: amount.toString() })),
          byPool: [...paidByPool.entries()].filter(([, v]) => v > 0n).map(([pool, amount]) => ({ pool, amount: amount.toString() })),
        }),
      ],
    );
    round = (await input.db.query(`select * from public.dbc_holder_rounds where week_id = $1`, [week.weekId])).rows[0];
  }
  if (round.status !== "ready") return { weekId: week.weekId, creatorPayouts, holderRound: round.status };
  if (!input.send) return { weekId: week.weekId, creatorPayouts, holderRound: "dry-run" };

  const total = BigInt(String(round.total_lamports));
  if (!(await collectorCanPay(input.connection, input.collector, total))) {
    console.error("[dbc-5b] collector short for the holder deposit; retry next pass", { week: week.weekId, total: total.toString() });
    return { weekId: week.weekId, creatorPayouts, holderRound: "collector-short" };
  }
  const vaults = rewardVaults(input.treasuryProgram);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: input.collector.publicKey, toPubkey: vaults.airdrop, lamports: Number(total),
  }));
  const signed = await signForSend(input.connection, input.collector, tx);
  await input.db.query(
    `update public.dbc_holder_rounds set status = 'sending', signature = $2, last_valid_block_height = $3, updated_at = now()
      where week_id = $1 and status = 'ready'`,
    [week.weekId, signed.signature, signed.latest.lastValidBlockHeight],
  );
  const byPool = (round.leaves?.byPool || []) as Array<{ pool: string; amount: string }>;
  for (const entry of byPool) {
    await input.db.query(
      `insert into public.dbc_creator_pool_payouts
         (pool, kind, week_id, moment_key, lamports, recipient, signature, last_valid_block_height, status)
       values ($1,'holders',$2,$3,$4,$5,$6,$7,'sending')`,
      [entry.pool, week.weekId, `week:${week.weekId}`, entry.amount, vaults.airdrop.toBase58(), signed.signature, signed.latest.lastValidBlockHeight],
    );
  }
  const outcome = await sendSigned(input.connection, signed.serialized, signed.signature, signed.latest);
  if (outcome !== "pending") {
    await input.db.query(
      `update public.dbc_holder_rounds set status = $2, updated_at = now() where week_id = $1`,
      [week.weekId, outcome === "landed" ? "landed" : "ready"],
    );
    await input.db.query(
      `update public.dbc_creator_pool_payouts set status = $2, updated_at = now()
        where kind = 'holders' and week_id = $1 and status = 'sending'`,
      [week.weekId, outcome === "landed" ? "landed" : "failed"],
    );
  }
  return { weekId: week.weekId, creatorPayouts, holderRound: outcome === "pending" ? "sending" : outcome };
}

// ---------------------------------------------------------------- buyback & burn

export type BuybackQuote = { amountIn: bigint; minOut: bigint; impactBps: number };

/**
 * Largest spend (<= budget) whose quote moves the price by at most maxImpactBps: binary search on the
 * caller's quote function, which returns null when the amount cannot be quoted.
 */
export async function sizeBuyback(
  budget: bigint,
  minSpend: bigint,
  maxImpactBps: number,
  quote: (amountIn: bigint) => Promise<BuybackQuote | null>,
): Promise<BuybackQuote | null> {
  if (budget < minSpend) return null;
  const full = await quote(budget);
  if (full && full.impactBps <= maxImpactBps) return full;
  let lo = minSpend;
  let hi = budget;
  let best: BuybackQuote | null = null;
  for (let i = 0; i < 24 && lo <= hi; i += 1) {
    const mid = (lo + hi) / 2n;
    const q = await quote(mid);
    if (q && q.impactBps <= maxImpactBps) {
      best = q;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  return best;
}

/** Price impact of a SOL-in buy on a constant-product pool, from the spot price and the quote. */
export function dammImpactBps(spotSolPerToken: number, solIn: bigint, tokensOut: bigint): number {
  if (!(spotSolPerToken > 0) || tokensOut <= 0n) return Number.POSITIVE_INFINITY;
  const exec = Number(solIn) / Number(tokensOut);
  return ((exec / spotSolPerToken) ** 2 - 1) * 10_000;
}

export function sqrtImpactBps(currentSqrt: bigint, nextSqrt: bigint): number {
  if (currentSqrt <= 0n) return Number.POSITIVE_INFINITY;
  // price = sqrt^2: impact = next^2 / current^2 - 1, in bps
  const scaled = (nextSqrt * nextSqrt * 10_000_000n) / (currentSqrt * currentSqrt);
  return (Number(scaled) - 10_000_000) / 1_000;
}

export async function runDueBuybacks(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  masterSecret: string;
  send: boolean;
  now: Date;
  client?: DynamicBondingCurveClient;
  fetchImpl?: typeof fetch;
}): Promise<Array<{ pool: string; moment: string; skipped: string | null; signature: string | null }>> {
  const perDay = Math.max(1, Math.min(24, Number(process.env.DBC_BUYBACK_MAX_PER_DAY || 4)));
  const maxImpactBps = Math.max(1, Number(process.env.DBC_BUYBACK_MAX_IMPACT_BPS || 50));
  const minSpend = envBigint("DBC_BUYBACK_MIN_LAMPORTS", 10_000_000n);
  const coins = (await platformCoins(input.db)).filter((c) => c.choice === "buyback");
  if (!coins.length) return [];
  const ledgers = await coinLedgers(input.db);
  const client = input.client || new DynamicBondingCurveClient(input.connection as any, "confirmed");
  const results = [];
  for (const coin of coins) {
    // The latest moment that has passed and has no live payout: at most one buy per coin per pass.
    const days = [new Date(input.now.getTime() - 24 * 3600 * 1000), input.now];
    let dueKey: string | null = null;
    for (const day of days) {
      const secret = weekSecret(input.masterSecret, weekOf(day).weekId);
      const moments = buybackMoments(secret, coin.pool, day, perDay);
      for (let i = 0; i < moments.length; i += 1) {
        if (moments[i].getTime() > input.now.getTime()) continue;
        const key = `${moments[i].toISOString().slice(0, 10)}:${i}`;
        const live = await input.db.query(
          `select 1 from public.dbc_creator_pool_payouts where pool = $1 and kind = 'buyback' and moment_key = $2 and status <> 'failed'`,
          [coin.pool, key],
        );
        if ((live.rowCount ?? live.rows.length) === 0) dueKey = key;
      }
    }
    if (!dueKey) continue;
    const ledger = ledgers.get(coin.pool) || { total: 0n, paid: { holders: 0n, creator: 0n, buyback: 0n } };
    const budget = dues(coin, ledger).buyback;
    // A bound coin buys back with its own quote (its pot), on its own curve or pool.
    const bound = !isNativeQuoteMint(coin.quoteMint);
    const coinMinSpend = bound ? await boundMinSpend(coin, input.fetchImpl) : minSpend;
    if (coinMinSpend == null) {
      results.push({ pool: coin.pool, moment: dueKey, skipped: "no-quote-price", signature: null });
      continue;
    }
    const built = coin.dammPool
      ? await buildDammBuyback({ connection: input.connection, collector: input.collector, coin, budget, minSpend: coinMinSpend, maxImpactBps })
      : await buildCurveBuyback({ connection: input.connection, client, collector: input.collector, coin, budget, minSpend: coinMinSpend, maxImpactBps, now: input.now });
    if ("skipped" in built) {
      results.push({ pool: coin.pool, moment: dueKey, skipped: built.skipped, signature: null });
      continue;
    }
    if (!input.send) {
      results.push({ pool: coin.pool, moment: dueKey, skipped: "dry-run", signature: null });
      continue;
    }
    const canPay = bound
      ? (await collectorQuoteBalance(input.connection, input.collector.publicKey, coin.quoteMint, await quoteTokenProgram(input.connection as any, coin.quoteMint))) >= built.amountIn
        && (await collectorCanPay(input.connection, input.collector, 5_000_000n))
      : await collectorCanPay(input.connection, input.collector, built.amountIn + 5_000_000n);
    if (!canPay) {
      results.push({ pool: coin.pool, moment: dueKey, skipped: "collector-short", signature: null });
      continue;
    }
    const signed = await signForSend(input.connection, input.collector, built.tx);
    const inserted = await input.db.query(
      `insert into public.dbc_creator_pool_payouts
         (pool, kind, week_id, moment_key, lamports, tokens_burned, recipient, signature, last_valid_block_height, status, quote_mint)
       values ($1,'buyback',$2,$3,$4,$5,$6,$7,$8,'sending',$9) returning id`,
      [coin.pool, weekOf(input.now).weekId, dueKey, built.amountIn.toString(), built.burn.toString(), coin.mint, signed.signature, signed.latest.lastValidBlockHeight, bound ? coin.quoteMint : null],
    );
    const outcome = await sendSigned(input.connection, signed.serialized, signed.signature, signed.latest);
    if (outcome !== "pending") {
      await input.db.query(`update public.dbc_creator_pool_payouts set status = $2, updated_at = now() where id = $1`, [inserted.rows[0].id, outcome]);
    }
    results.push({ pool: coin.pool, moment: dueKey, skipped: null, signature: signed.signature });
  }
  return results;
}

/**
 * The smallest buyback worth a transaction, for a coin paired with another quote: the same dollar
 * amount as DBC_BUYBACK_MIN_LAMPORTS at SOL's price is not known here, so it is set in dollars
 * (DBC_BUYBACK_MIN_USD_MICROS, default $2) and converted at Jupiter's price per raw unit.
 */
async function boundMinSpend(coin: PlatformCoin, fetchImpl?: typeof fetch): Promise<bigint | null> {
  const usdMicros = envBigint("DBC_BUYBACK_MIN_USD_MICROS", 2_000_000n);
  const price = await jupiterRawUnitUsd(coin.quoteMint, fetchImpl || fetch);
  if (!price || !(price.value > 0)) return null;
  const perRawMicros = BigInt(Math.round(price.value * 1_000_000));
  if (perRawMicros <= 0n) return null;
  const scale = 10n ** BigInt(coin.quoteDecimals);
  return (usdMicros * scale + perRawMicros - 1n) / perRawMicros;
}

type BuiltBuyback = { tx: Transaction; amountIn: bigint; burn: bigint } | { skipped: string };

async function collectorTokenBalance(connection: Connection, collector: PublicKey, mint: PublicKey): Promise<{ ata: PublicKey; amount: bigint }> {
  const ata = getAssociatedTokenAddressSync(mint, collector, false, TOKEN_PROGRAM_ID);
  const info = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
  return { ata, amount: info ? BigInt(info.value.amount) : 0n };
}

/**
 * Buy and burn in one transaction. The burn is what the collector already held of this mint (the
 * part above the minimum from earlier buys) plus this buy's guaranteed minimum output, so it can never
 * burn more than the transaction delivers; anything above the minimum is burned by the next buy.
 */
function withBurn(tx: Transaction, ata: PublicKey, mint: PublicKey, collector: PublicKey, burn: bigint) {
  tx.add(createBurnCheckedInstruction(ata, mint, collector, burn, DBC_TOKEN_DECIMALS, [], TOKEN_PROGRAM_ID));
  return tx;
}

async function buildCurveBuyback(input: {
  connection: Connection;
  client: DynamicBondingCurveClient;
  collector: Keypair;
  coin: PlatformCoin;
  budget: bigint;
  minSpend: bigint;
  maxImpactBps: number;
  now: Date;
}): Promise<BuiltBuyback> {
  const poolPk = new PublicKey(input.coin.pool);
  const wrap = await input.client.state.getPool(poolPk);
  const pool = (wrap as any)?.poolState ?? wrap;
  if (!pool) return { skipped: "pool-unreadable" };
  if (Number(pool.isMigrated) === 1) return { skipped: "migrated-without-pool-meta" };
  const cfgWrap = await input.client.state.getPoolConfig(pool.config);
  const config = (cfgWrap as any)?.poolConfig ?? cfgWrap;
  const threshold = BigInt(String(config.migrationQuoteThreshold));
  const reserve = BigInt(String(pool.quoteReserve));
  // A buyback is never the buy that completes the curve.
  if (reserve * 100n >= threshold * 95n) return { skipped: "curve-above-95pct" };
  const nowUnix = Math.floor(input.now.getTime() / 1000);
  if (nowUnix < Number(pool.activationPoint || 0) + 60) return { skipped: "anti-sniper-window" };
  const currentSqrt = BigInt(String(pool.sqrtPrice));
  const quote = async (amountIn: bigint): Promise<BuybackQuote | null> => {
    try {
      const q: any = input.client.pool.swapQuote2({
        virtualPool: { poolState: pool } as any,
        config,
        swapBaseForQuote: false,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint: new BN(String(nowUnix)),
        slippageBps: 100,
        swapMode: SwapMode.ExactIn,
        amountIn: new BN(amountIn.toString()),
      } as any);
      const next = BigInt(String(q.nextSqrtPrice));
      const minOut = BigInt(String(q.minimumAmountOut ?? q.outputAmount));
      return { amountIn, minOut, impactBps: sqrtImpactBps(currentSqrt, next) };
    } catch {
      return null;
    }
  };
  // Keep the buy clear of the 95% line too.
  const room = (threshold * 95n) / 100n - reserve;
  const sized = await sizeBuyback(input.budget < room ? input.budget : room, input.minSpend, input.maxImpactBps, quote);
  if (!sized) return { skipped: "below-minimum-or-impact" };
  const mint = new PublicKey(input.coin.mint);
  const held = await collectorTokenBalance(input.connection, input.collector.publicKey, mint);
  const tx: Transaction = (await input.client.pool.swap2({
    owner: input.collector.publicKey,
    payer: input.collector.publicKey,
    pool: poolPk,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(sized.amountIn.toString()),
    minimumAmountOut: new BN(sized.minOut.toString()),
  } as any)) as any;
  const burn = held.amount + sized.minOut;
  return { tx: withBurn(tx, held.ata, mint, input.collector.publicKey, burn), amountIn: sized.amountIn, burn };
}

async function buildDammBuyback(input: {
  connection: Connection;
  collector: Keypair;
  coin: PlatformCoin;
  budget: bigint;
  minSpend: bigint;
  maxImpactBps: number;
}): Promise<BuiltBuyback> {
  const cpAmm = new CpAmm(input.connection as any);
  const poolPk = new PublicKey(String(input.coin.dammPool));
  const poolState = await cpAmm.fetchPoolState(poolPk);
  const slot = await input.connection.getSlot("confirmed");
  const time = Number((await input.connection.getBlockTime(slot).catch(() => null)) || Math.floor(Date.now() / 1000));
  // The pool's quote: SOL, or the coin's bound quote. Impact is measured in that quote.
  const quoteMint = new PublicKey(isNativeQuoteMint(input.coin.quoteMint) ? NATIVE_MINT : input.coin.quoteMint);
  const solIsB = poolState.tokenBMint.equals(quoteMint);
  const rawPrice = Number(BigInt(poolState.sqrtPrice.toString())) ** 2 / 2 ** 128; // token B per token A, raw units
  const spotSolPerToken = solIsB ? rawPrice : 1 / rawPrice;
  const quote = async (amountIn: bigint): Promise<BuybackQuote | null> => {
    try {
      const q = cpAmm.getQuote({
        inAmount: new BN(amountIn.toString()),
        inputTokenMint: quoteMint,
        slippage: 1,
        poolState,
        currentTime: time,
        currentSlot: slot,
      } as any);
      // cp-amm 1.4.5's getQuote returns priceImpact = NaN on these pools (devnet, 2026-09-29), so the
      // impact is derived: in a constant-product pool the execution price is the geometric mean of the
      // price before and after, so after = exec^2 / before. exec uses the input after the pool fee
      // (quoted in SOL): counting the 0.25% fee would put every buy at ~50 bps before it moved the price.
      const out = BigInt(q.swapOutAmount.toString());
      const fee = BigInt(q.totalFee.toString());
      return { amountIn, minOut: BigInt(q.minSwapOutAmount.toString()), impactBps: dammImpactBps(spotSolPerToken, amountIn - fee, out) };
    } catch {
      return null;
    }
  };
  const sized = await sizeBuyback(input.budget, input.minSpend, input.maxImpactBps, quote);
  if (!sized) return { skipped: "below-minimum-or-impact" };
  const mint = new PublicKey(input.coin.mint);
  const held = await collectorTokenBalance(input.connection, input.collector.publicKey, mint);
  const tx: Transaction = (await cpAmm.swap({
    payer: input.collector.publicKey,
    pool: poolPk,
    inputTokenMint: quoteMint,
    outputTokenMint: mint,
    amountIn: new BN(sized.amountIn.toString()),
    minimumAmountOut: new BN(sized.minOut.toString()),
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    referralTokenAccount: null,
    poolState,
  } as any)) as any;
  const burn = held.amount + sized.minOut;
  return { tx: withBurn(tx, held.ata, mint, input.collector.publicKey, burn), amountIn: sized.amountIn, burn };
}
