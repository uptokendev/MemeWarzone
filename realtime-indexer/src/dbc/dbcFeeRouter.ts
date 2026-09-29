/**
 * Route claimed DBC collector slices to the rewards treasury vaults.
 * One System-transfer transaction per run. Creator-pool amounts stay on the collector.
 * Sign, persist routing + signature, then send. Update by id.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { bs58Encode, resolveSignature } from "./dbcFeePending.js";
import { WSOL_MINT, isNativeQuoteMint, quoteMintsForPools } from "./dbcQuoteNative.js";
import { splitSolFromQuoteSwap, quoteRoutedTotal, type QuoteSlices } from "./dbcQuoteSolSplit.js";
import { resolvePendingQuoteSwaps, swapClaimedQuoteIfNeeded, type SwapQuoteFn } from "./dbcQuoteToSolSwap.js";

export const TREASURY_PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export function deriveRewardVault(seed: string, programId = TREASURY_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(programId))[0];
}

export function rewardVaults(programId = TREASURY_PROGRAM_ID) {
  return {
    leagueWeekly: deriveRewardVault("league_vault", programId),
    leagueMonthly: deriveRewardVault("monthly_league_vault", programId),
    recruiter: deriveRewardVault("recruiter_vault", programId),
    squad: deriveRewardVault("squad_vault", programId),
    airdrop: deriveRewardVault("airdrop_vault", programId),
    protocol: deriveRewardVault("protocol_vault", programId),
  };
}

export type RouteTotals = {
  leagueWeekly: bigint;
  leagueMonthly: bigint;
  recruiter: bigint;
  squad: bigint;
  airdrop: bigint;
  protocol: bigint;
  creatorPool: bigint;
  routed: bigint;
};

export function sumClaimedSlices(rows: Array<Record<string, unknown>>): RouteTotals {
  const read = (row: Record<string, unknown>, key: string) => BigInt(String(row[key] ?? 0));
  const totals: RouteTotals = {
    leagueWeekly: 0n, leagueMonthly: 0n, recruiter: 0n, squad: 0n, airdrop: 0n, protocol: 0n, creatorPool: 0n, routed: 0n,
  };
  for (const row of rows) {
    totals.leagueWeekly += read(row, "league_weekly");
    totals.leagueMonthly += read(row, "league_monthly");
    totals.recruiter += read(row, "recruiter");
    totals.squad += read(row, "squad");
    totals.airdrop += read(row, "airdrop");
    totals.protocol += read(row, "protocol");
    totals.creatorPool += read(row, "creator_pool");
  }
  totals.routed =
    totals.leagueWeekly + totals.leagueMonthly + totals.recruiter + totals.squad + totals.airdrop + totals.protocol;
  return totals;
}

export function collectorNeed(routed: bigint, heldCreatorPool: bigint, rent: bigint, fee: bigint): bigint {
  return routed + heldCreatorPool + rent + fee;
}

export async function heldCreatorPoolSum(db: Queryable): Promise<bigint> {
  // Bound-quote creator_pool is still quote tokens on the collector. Only SOL-quoted
  // pots are reserved as lamports.
  const held = await db.query(
    `select coalesce(sum(a.creator_pool), 0)::text as held
       from public.dbc_fee_accruals a
       left join public.campaigns c
         on c.chain_id = 101 and c.campaign_address = a.pool
      where a.status in ('claimed', 'routing', 'routed')
        and coalesce(
          nullif(c.meta #>> '{dbc,quoteMint}', ''),
          nullif(c.meta #>> '{solanaGraduation,quoteMint}', ''),
          $1
        ) = $1`,
    [WSOL_MINT],
  );
  // Step 5b pays the creator pot out (holders deposit, split transfer, buyback). A payout that is
  // sending or landed has left, or is leaving, the collector, so it is no longer held. Only SOL rows
  // count: holder deposits are always SOL; a bound coin's creator and buyback rows are quote units.
  // A bound coin's holder share becomes SOL when swapped; that SOL is held until its round deposit.
  const paid = await db.query(
    `select coalesce(sum(lamports) filter (where kind = 'holders' or (kind in ('creator', 'buyback') and quote_mint is null)), 0)::text as paid,
            coalesce(sum(sol_received) filter (where kind = 'holders_swap' and status = 'landed'), 0)::text as swapped_in
       from public.dbc_creator_pool_payouts
      where status in ('sending', 'landed')`,
  );
  const value = BigInt(String(held.rows[0]?.held || "0"))
    + BigInt(String(paid.rows[0]?.swapped_in || "0"))
    - BigInt(String(paid.rows[0]?.paid || "0"));
  return value > 0n ? value : 0n;
}

export function buildRouteTransfers(input: {
  collector: PublicKey;
  totals: RouteTotals;
  vaults?: ReturnType<typeof rewardVaults>;
}): { instructions: ReturnType<typeof SystemProgram.transfer>[]; destinations: Array<{ seed: string; lamports: bigint; to: string }> } {
  const vaults = input.vaults || rewardVaults();
  const plan: Array<{ seed: string; lamports: bigint; to: PublicKey }> = [
    { seed: "league_vault", lamports: input.totals.leagueWeekly, to: vaults.leagueWeekly },
    { seed: "monthly_league_vault", lamports: input.totals.leagueMonthly, to: vaults.leagueMonthly },
    { seed: "recruiter_vault", lamports: input.totals.recruiter, to: vaults.recruiter },
    { seed: "squad_vault", lamports: input.totals.squad, to: vaults.squad },
    { seed: "airdrop_vault", lamports: input.totals.airdrop, to: vaults.airdrop },
    { seed: "protocol_vault", lamports: input.totals.protocol, to: vaults.protocol },
  ];
  const live = plan.filter((item) => item.lamports > 0n);
  return {
    instructions: live.map((item) => SystemProgram.transfer({
      fromPubkey: input.collector,
      toPubkey: item.to,
      lamports: Number(item.lamports),
    })),
    destinations: live.map((item) => ({ seed: item.seed, lamports: item.lamports, to: item.to.toBase58() })),
  };
}

export class CollectorShortError extends Error {
  constructor(public have: bigint, public need: bigint) {
    super(`DBC collector is short: have ${have.toString()} need ${need.toString()}`);
    this.name = "CollectorShortError";
  }
}

export function nativeDelta(tx: any, pubkey: string): bigint {
  const message = tx?.transaction?.message;
  let keys: any[] = [];
  if (message && typeof message.getAccountKeys === "function") {
    try {
      keys = message.getAccountKeys().staticAccountKeys || [];
    } catch {
      keys = [];
    }
  }
  if (!keys.length) keys = message?.staticAccountKeys || message?.accountKeys || [];
  const keyStr = (entry: any) => (typeof entry === "string" ? entry : String(entry?.pubkey || entry?.toBase58?.() || ""));
  const want = typeof pubkey === "string" ? pubkey : String((pubkey as { toBase58?: () => string })?.toBase58?.() || pubkey);
  const index = keys.findIndex((entry: any) => keyStr(entry) === want);
  if (index < 0) return 0n;
  return BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
}

async function updateIds(db: Queryable, ids: string[], sql: string, params: unknown[] = []) {
  if (!ids.length) return;
  await db.query(sql, [ids, ...params]);
}

export async function resolvePendingRoutes(input: {
  db: Queryable;
  connection: Connection;
}): Promise<{ resolved: number; waiting: number }> {
  const pending = await input.db.query(
    `select id, route_signature, last_valid_block_height
       from public.dbc_fee_accruals
      where status = 'routing'
      order by id`,
  );
  const bySig = new Map<string, { ids: string[]; lastValid: number }>();
  for (const row of pending.rows) {
    const signature = String(row.route_signature || "");
    if (!signature) continue;
    const group = bySig.get(signature) || { ids: [], lastValid: Number(row.last_valid_block_height || 0) };
    group.ids.push(String(row.id));
    bySig.set(signature, group);
  }
  let resolved = 0;
  let waiting = 0;
  for (const [signature, group] of bySig) {
    const confirmed = await input.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const outcome = confirmed
      ? (confirmed.meta?.err ? "failed" : "landed")
      : await resolveSignature(input.connection, signature, group.lastValid);
    if (outcome === "pending") {
      waiting += group.ids.length;
      continue;
    }
    if (outcome === "failed" || outcome === "expired") {
      await updateIds(
        input.db,
        group.ids,
        `update public.dbc_fee_accruals
            set status = 'claimed', route_signature = null, last_valid_block_height = null
          where id = any($1::bigint[])`,
      );
      resolved += group.ids.length;
      continue;
    }
    await updateIds(
      input.db,
      group.ids,
      `update public.dbc_fee_accruals
          set status = 'routed'
        where id = any($1::bigint[])`,
    );
    resolved += group.ids.length;
  }
  return { resolved, waiting };
}

async function sendRouteForIds(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  treasuryProgram?: string;
  ids: string[];
  totals: RouteTotals;
}): Promise<{
  totals: RouteTotals;
  ids: string[];
  signature: string | null;
  destinations: Array<{ seed: string; lamports: bigint; to: string }>;
  skipped: string | null;
}> {
  const { ids, totals } = input;
  if (!ids.length || totals.routed <= 0n) {
    return { totals, ids, signature: null, destinations: [], skipped: "nothing-to-route" };
  }
  const heldCreatorPool = await heldCreatorPoolSum(input.db);
  const vaults = rewardVaults(input.treasuryProgram);
  const built = buildRouteTransfers({ collector: input.collector.publicKey, totals, vaults });
  const have = BigInt(await input.connection.getBalance(input.collector.publicKey, "confirmed"));
  const rent = BigInt(await input.connection.getMinimumBalanceForRentExemption(0));
  const latest = await input.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.feePayer = input.collector.publicKey;
  tx.recentBlockhash = latest.blockhash;
  for (const ix of built.instructions) tx.add(ix);
  const feeMsg = await input.connection.getFeeForMessage(tx.compileMessage(), "confirmed");
  const fee = BigInt(feeMsg?.value ?? 5_000);
  const need = collectorNeed(totals.routed, heldCreatorPool, rent, fee);
  if (have < need) {
    throw new CollectorShortError(have, need);
  }
  if (!input.send) {
    return { totals, ids, signature: null, destinations: built.destinations, skipped: "dry-run" };
  }
  tx.partialSign(input.collector);
  const serialized = tx.serialize();
  let signature = bs58Encode(serialized.subarray(1, 65));
  await updateIds(
    input.db,
    ids,
    `update public.dbc_fee_accruals
        set status = 'routing', route_signature = $2, last_valid_block_height = $3
      where id = any($1::bigint[])`,
    [signature, latest.lastValidBlockHeight],
  );
  try {
    const sent = await input.connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 8 });
    if (sent && sent !== signature) {
      await updateIds(
        input.db,
        ids,
        `update public.dbc_fee_accruals
            set route_signature = $2
          where id = any($1::bigint[])`,
        [sent],
      );
      signature = sent;
    }
    const confirmation = await input.connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) {
      await updateIds(
        input.db,
        ids,
        `update public.dbc_fee_accruals
            set status = 'claimed', route_signature = null, last_valid_block_height = null
          where id = any($1::bigint[])`,
      );
      return { totals, ids, signature, destinations: built.destinations, skipped: "route-failed-on-chain" };
    }
  } catch (error) {
    // Once the signed transaction may have reached the network, an error here does not prove it
    // did not land. Leave the rows pending; the resolver returns them to 'claimed' only when the
    // signature failed or its blockhash has expired.
    console.warn("[dbc-fee] route send/confirm error; left pending for the resolver", {
      signature,
      error: String(error instanceof Error ? error.message : error),
    });
    return { totals, ids, signature, destinations: built.destinations, skipped: "routing" };
  }
  return { totals, ids, signature, destinations: built.destinations, skipped: "routing" };
}

function slicesFromTotals(totals: RouteTotals): QuoteSlices {
  return {
    leagueWeekly: totals.leagueWeekly,
    leagueMonthly: totals.leagueMonthly,
    recruiter: totals.recruiter,
    squad: totals.squad,
    airdrop: totals.airdrop,
    protocol: totals.protocol,
    creatorPool: totals.creatorPool,
  };
}

function totalsFromSolSlices(sol: QuoteSlices): RouteTotals {
  const routed = quoteRoutedTotal(sol);
  return {
    leagueWeekly: sol.leagueWeekly,
    leagueMonthly: sol.leagueMonthly,
    recruiter: sol.recruiter,
    squad: sol.squad,
    airdrop: sol.airdrop,
    protocol: sol.protocol,
    creatorPool: 0n,
    routed,
  };
}

export async function routeClaimedAccruals(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  treasuryProgram?: string;
  swapQuote?: SwapQuoteFn;
}): Promise<{
  totals: RouteTotals;
  ids: string[];
  signature: string | null;
  destinations: Array<{ seed: string; lamports: bigint; to: string }>;
  skipped: string | null;
}> {
  await resolvePendingRoutes({ db: input.db, connection: input.connection });
  await resolvePendingQuoteSwaps({ db: input.db, connection: input.connection, collector: input.collector.publicKey.toBase58() });
  const stillRouting = await input.db.query(
    `select id from public.dbc_fee_accruals where status = 'routing' limit 1`,
  );
  if ((stillRouting.rowCount ?? stillRouting.rows.length) > 0) {
    return { totals: sumClaimedSlices([]), ids: [], signature: null, destinations: [], skipped: "routing-in-flight" };
  }
  const blocked = await input.db.query(
    `select distinct pool, blocked_reason from public.dbc_fee_accruals where status = 'blocked'`,
  );
  if (blocked.rows.length) {
    console.error("[dbc-fee] blocked pools (other pools still route)", blocked.rows.map((row: { pool: string; blocked_reason: string }) => ({
      pool: row.pool,
      reason: row.blocked_reason,
    })));
  }
  const rows = await input.db.query(
    `select id, pool, league_weekly, league_monthly, recruiter, squad, airdrop, protocol, creator_pool,
            quote_swap_id, sol_received
       from public.dbc_fee_accruals where status = 'claimed' order by id`,
  );
  if (!rows.rows.length) {
    return { totals: sumClaimedSlices([]), ids: [], signature: null, destinations: [], skipped: "nothing-to-route" };
  }
  const mintByPool = await quoteMintsForPools(input.db, rows.rows.map((row: { pool: string }) => String(row.pool)));
  const groups = new Map<string, any[]>();
  for (const row of rows.rows) {
    const mint = mintByPool.get(String(row.pool)) || WSOL_MINT;
    const list = groups.get(mint) || [];
    list.push(row);
    groups.set(mint, list);
  }
  const nativeRows = groups.get(WSOL_MINT) || [];
  const nativeTotals = sumClaimedSlices(nativeRows);
  if (nativeRows.length && nativeTotals.routed > 0n) {
    return sendRouteForIds({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      send: input.send,
      treasuryProgram: input.treasuryProgram,
      ids: nativeRows.map((row) => String(row.id)),
      totals: nativeTotals,
    });
  }
  let boundMint = "";
  let boundRows: any[] = [];
  for (const [mint, list] of groups) {
    if (isNativeQuoteMint(mint)) continue;
    const totals = sumClaimedSlices(list);
    if (totals.routed > 0n) {
      boundMint = mint;
      boundRows = list;
      break;
    }
  }
  if (!boundMint.length) {
    const ids = rows.rows.map((row: { id: unknown }) => String(row.id));
    return { totals: sumClaimedSlices(rows.rows), ids, signature: null, destinations: [], skipped: "nothing-to-route" };
  }
  const alreadySol = boundRows.filter((row) => BigInt(String(row.sol_received || "0")) > 0n && !row.quote_swap_id);
  const alreadyTotals = sumClaimedSlices(alreadySol);
  if (alreadySol.length && alreadyTotals.routed > 0n) {
    return sendRouteForIds({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      send: input.send,
      treasuryProgram: input.treasuryProgram,
      ids: alreadySol.map((row) => String(row.id)),
      totals: alreadyTotals,
    });
  }
  const quoteTotals = sumClaimedSlices(boundRows);
  const ids = boundRows.map((row) => String(row.id));
  const existingSwapId = boundRows.find((row) => row.quote_swap_id)?.quote_swap_id;
  let solOut = 0n;
  let swapId: number | undefined;
  if (existingSwapId) {
    const existing = await input.db.query(
      `select sol_out, status from public.dbc_quote_swaps where id = $1`,
      [existingSwapId],
    );
    const status = String(existing.rows[0]?.status || "");
    if (status === "sending") {
      return { totals: quoteTotals, ids, signature: null, destinations: [], skipped: "swap-in-flight" };
    }
    if (status === "done") {
      solOut = BigInt(String(existing.rows[0]?.sol_out || "0"));
      swapId = Number(existingSwapId);
    }
  }
  if (!swapId) {
    const swapped = await swapClaimedQuoteIfNeeded({
      db: input.db,
      connection: input.connection,
      collector: input.collector,
      quoteMint: boundMint,
      quoteIn: quoteTotals.routed,
      send: input.send,
      swapQuote: input.swapQuote,
    });
    if (swapped.skipped === "impact-cap" || swapped.skipped === "sending" || swapped.skipped === "failed-on-chain") {
      return { totals: quoteTotals, ids, signature: null, destinations: [], skipped: swapped.skipped };
    }
    solOut = swapped.solOut;
    swapId = swapped.id;
  }
  if (solOut <= 0n) {
    return { totals: quoteTotals, ids, signature: null, destinations: [], skipped: "nothing-to-route" };
  }
  const solTotals = totalsFromSolSlices(splitSolFromQuoteSwap(slicesFromTotals(quoteTotals), solOut));
  await updateIds(
    input.db,
    ids,
    `update public.dbc_fee_accruals
        set quote_swap_id = $2, sol_received = $3
      where id = any($1::bigint[])`,
    [swapId ?? null, solOut.toString()],
  );
  return sendRouteForIds({
    db: input.db,
    connection: input.connection,
    collector: input.collector,
    send: input.send,
    treasuryProgram: input.treasuryProgram,
    ids,
    totals: solTotals,
  });
}
