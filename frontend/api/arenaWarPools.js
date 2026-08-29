import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import {
  WAR_POOL_ABI,
  battlePoolId,
  signResolvePool,
  warPoolTreasuryAddress,
} from "./lib/arenaWarPoolEscrow.js";
import { ethers } from "ethers";

const STATES = new Set(["open", "locked", "settling", "paid"]);
const TRANSITIONS = { open: ["locked"], locked: ["settling"], settling: ["paid"], paid: ["open"] };

function futureIso(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function normalizeState(value) {
  const state = String(value || "open");
  return STATES.has(state) ? state : "open";
}

function sum(entries, sideTokenId) {
  return entries.filter((entry) => !sideTokenId || entry.sideTokenId === sideTokenId).reduce((total, entry) => total + Number(entry.amountUsd || 0), 0);
}

function routing(totalPotUsd) {
  return { winnersUsd: Math.round(totalPotUsd * 0.85), protocolUsd: Math.round(totalPotUsd * 0.05), featuredUsd: Math.round(totalPotUsd * 0.1) };
}

function mapEntry(row) {
  return {
    battleId: String(row.battle_id),
    sideTokenId: String(row.side_token_id),
    amountUsd: Number(row.amount_usd || 0),
    enteredAt: row.entered_at ? new Date(row.entered_at).toISOString() : new Date().toISOString(),
    payoutEligible: false,
  };
}

function poolPayload(record, entries) {
  const totalPotUsd = sum(entries);
  return {
    battleId: String(record.battle_id),
    state: normalizeState(record.state),
    totalPotUsd,
    cutoffAt: record.cutoff_at ? new Date(record.cutoff_at).toISOString() : futureIso(30),
    routingBreakdown: routing(totalPotUsd),
    entries,
  };
}

async function entriesFor(battleId) {
  const result = await pool.query(
    `select battle_id, side_token_id, amount_usd, entered_at, payout_eligible
       from public.arena_war_pool_entries
      where battle_id = $1
      order by entered_at asc, created_at asc`,
    [battleId],
  );
  return result.rows.map(mapEntry);
}

async function findPool(battleId) {
  const result = await pool.query(
    `select battle_id, state, cutoff_at, created_at, updated_at from public.arena_war_pools where battle_id = $1 limit 1`,
    [battleId],
  );
  const record = result.rows?.[0];
  return record ? poolPayload(record, await entriesFor(battleId)) : null;
}

async function ensurePool(battleId) {
  const existing = await pool.query(
    `select battle_id, state, cutoff_at, created_at, updated_at from public.arena_war_pools where battle_id = $1 limit 1`,
    [battleId],
  );
  if (existing.rows?.[0]) return existing.rows[0];
  const inserted = await pool.query(
    `insert into public.arena_war_pools (battle_id, state, cutoff_at) values ($1, 'open', now() + interval '30 minutes') returning battle_id, state, cutoff_at, created_at, updated_at`,
    [battleId],
  );
  return inserted.rows[0];
}

async function listPools() {
  const result = await pool.query(
    `select battle_id, state, cutoff_at, created_at, updated_at
       from public.arena_war_pools
      order by coalesce(updated_at, created_at) desc
      limit 200`,
  );
  const pools = [];
  for (const row of result.rows) pools.push(poolPayload(row, await entriesFor(row.battle_id)));
  return pools;
}

function settlementSummary(poolRecord) {
  return {
    winnerTokenId: null,
    winnerLabel: "Supporters are not paid",
    totalPotUsd: poolRecord.totalPotUsd,
    winnerSideUsd: 0,
    loserSideUsd: 0,
    projectedPayoutMultiple: 0,
    projectedWinnerPayoutUsd: 0,
    projectedNetProfitUsd: 0,
    eligibleWinningEntries: 0,
    settlementStateLabel: poolRecord.state,
    settlementStateBody: "Support is a donation, not betting. Supporters are not paid. 85% winning campaign / 5% protocol / 10% Major War League once escrow is live.",
    routingBreakdown: poolRecord.routingBreakdown,
  };
}

async function handleSummary(_req, res) {
  try {
    const pools = await listPools();
    return json(res, 200, { summary: { pools, totalPotUsd: pools.reduce((total, item) => total + item.totalPotUsd, 0), openPools: pools.filter((item) => item.state === "open").length, lockedPools: pools.filter((item) => item.state === "locked" || item.state === "settling").length, paidPools: pools.filter((item) => item.state === "paid").length } });
  } catch (error) {
    console.error("[api/arenaWarPools] summary failed", error);
    return json(res, 200, { summary: { pools: [], totalPotUsd: 0, openPools: 0, lockedPools: 0, paidPools: 0 }, warning: "War Pool data is unavailable." });
  }
}

async function handleDetail(_req, res, battleId) {
  const poolRecord = await findPool(battleId);
  if (!poolRecord) return json(res, 404, { error: "War Pool not found" });
  return json(res, 200, { pool: poolRecord, settlementSummary: settlementSummary(poolRecord) });
}

async function handleSupport(req, res, battleId) {
  const body = req._arenaSupportBody || (await readJson(req));
  const sideTokenId = String(body?.sideTokenId || "").trim();
  const amountUsd = Number(body?.amountUsd || 0);
  const supporterAddress = String(body?.supporterAddress || body?.walletAddress || "").trim().toLowerCase();
  if (!sideTokenId || !Number.isFinite(amountUsd) || amountUsd <= 0) return json(res, 400, { ok: false, error: "sideTokenId and positive amountUsd are required" });

  const record = await ensurePool(battleId);
  if (normalizeState(record.state) !== "open") return json(res, 409, { ok: false, error: "War Pool is not open" });
  await pool.query(
    `insert into public.arena_war_pool_entries (battle_id, side_token_id, amount_usd, supporter_address, payout_eligible) values ($1, $2, $3, $4, false)`,
    [battleId, sideTokenId, amountUsd, supporterAddress || null],
  );
  try {
    await pool.query(
      `insert into public.arena_support_entries (battle_id, side_token, supporter_wallet, amount_native, payouts_live)
       values ($1,$2,$3,$4,false)`,
      [battleId, sideTokenId, supporterAddress || "unknown", amountUsd],
    );
  } catch {
    // Support ledger is best-effort until escrow exists.
  }
  await pool.query(`update public.arena_war_pools set updated_at = now() where battle_id = $1`, [battleId]);
  const poolRecord = await findPool(battleId);
  return json(res, 200, { ok: true, pool: poolRecord, settlementSummary: settlementSummary(poolRecord) });
}

async function handleTransition(req, res, battleId) {
  const current = await findPool(battleId);
  if (!current) return json(res, 404, { ok: false, error: "War Pool not found" });
  const body = await readJson(req);
  const nextState = String(body?.state || "");
  if (!(TRANSITIONS[current.state] || []).includes(nextState)) return json(res, 409, { ok: false, error: "Invalid war-pool transition", currentState: current.state });
  const cutoffSql = nextState === "open" ? "now() + interval '30 minutes'" : "cutoff_at";
  await pool.query(`update public.arena_war_pools set state = $2, cutoff_at = ${cutoffSql}, updated_at = now() where battle_id = $1`, [battleId, nextState]);
  if (nextState === "open") await pool.query(`update public.arena_war_pool_entries set payout_eligible = false where battle_id = $1`, [battleId]);
  const poolRecord = await findPool(battleId);
  return json(res, 200, { ok: true, pool: poolRecord, settlementSummary: settlementSummary(poolRecord) });
}

async function battleRow(id) {
  const result = await pool.query(`select * from public.arena_battles where id = $1 limit 1`, [id]);
  return result.rows[0] || null;
}

function ownerOfWinner(row) {
  const parts = Array.isArray(row.participants) ? row.participants : [];
  const winner = String(row.winner_token || "").toLowerCase();
  const match = parts.find((part) => String(part.tokenAddress || part.tokenId || "").toLowerCase() === winner);
  return normalizeWalletFlexible(match?.ownerWallet || "") || "";
}

async function handleClaimIntent(req, res, battleId) {
  const row = await battleRow(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  if (row.state !== "finished") return json(res, 409, { ok: false, error: "Battle is not finished" });
  const chainId = Number(row.chain_id);
  const treasury = warPoolTreasuryAddress(chainId);
  if (!treasury) return json(res, 503, { ok: false, error: "Arena war pool treasury is not deployed on this chain.", code: "WAR_POOL_TREASURY_MISSING" });
  const winnerPayout = ownerOfWinner(row);
  if (!winnerPayout) return json(res, 409, { ok: false, error: "Winning campaign owner is unknown" });
  const poolId = battlePoolId(battleId);
  const provider = await getServerReadProvider(chainId);
  const contract = new ethers.Contract(treasury, WAR_POOL_ABI, provider);
  const onchain = await contract.pools(poolId);
  const stakeTotal = BigInt(onchain.stakeA || 0) + BigInt(onchain.stakeB || 0);
  const supportTotal = BigInt(onchain.supportTotal || 0);
  const buyInTotal = BigInt(onchain.buyInTotal || 0);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const signed = await signResolvePool({
    treasuryAddress: treasury,
    chainId,
    poolId,
    winnerPayout,
    stakeTotal,
    supportTotal,
    buyInTotal,
    deadline,
  });
  if (!signed) {
    return json(res, 503, { ok: false, error: "Resolver key is not configured (ARENA_WAR_POOL_RESOLVER_KEY).", code: "WAR_POOL_RESOLVER_MISSING" });
  }
  return json(res, 200, {
    ok: true,
    treasury,
    chainId,
    poolId,
    abi: WAR_POOL_ABI,
    winnerPayout,
    pendingWinner: String(onchain.pendingWinner || 0),
    resolve: {
      winnerPayout,
      deadline,
      signature: signed.signature,
      stakeTotal: stakeTotal.toString(),
      supportTotal: supportTotal.toString(),
      buyInTotal: buyInTotal.toString(),
    },
    claimMethod: "claimWinner",
  });
}

async function handleClaimable(req, res) {
  const query = getQuery(req);
  const wallet = normalizeWalletFlexible(query.wallet || query.walletAddress || "");
  if (!wallet) return json(res, 400, { ok: false, error: "wallet is required" });
  const result = await pool.query(
    `select id, chain_id, winner_token, participants, stake_native, native_symbol
       from public.arena_battles
      where state = 'finished' and winner_token is not null
      order by finished_at desc nulls last
      limit 50`,
  );
  const items = [];
  for (const row of result.rows) {
    if (ownerOfWinner(row).toLowerCase() !== wallet.toLowerCase()) continue;
    items.push({
      battleId: row.id,
      chainId: Number(row.chain_id),
      poolId: battlePoolId(row.id),
      nativeSymbol: row.native_symbol || "BNB",
      treasury: warPoolTreasuryAddress(row.chain_id) || null,
    });
  }
  return json(res, 200, { ok: true, items });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && path === "/arena/war-pools") return handleSummary(req, res);
    if (method === "GET" && path === "/arena/war-pools/claimable") return handleClaimable(req, res);
    const claimIntent = path.match(/^\/arena\/war-pools\/([^/]+)\/claim-intent$/);
    if (claimIntent) return method === "GET" ? handleClaimIntent(req, res, decodeURIComponent(claimIntent[1])) : badMethod(res);
    const support = path.match(/^\/arena\/war-pools\/([^/]+)\/support$/);
    if (support) return method === "POST" ? handleSupport(req, res, decodeURIComponent(support[1])) : badMethod(res);
    const transition = path.match(/^\/arena\/war-pools\/([^/]+)\/transition$/);
    if (transition) return method === "POST" ? handleTransition(req, res, decodeURIComponent(transition[1])) : badMethod(res);
    const detail = path.match(/^\/arena\/war-pools\/([^/]+)$/);
    if (detail) return method === "GET" ? handleDetail(req, res, decodeURIComponent(detail[1])) : badMethod(res);
    return json(res, 404, { error: `Unknown arena war-pools route: ${path}` });
  } catch (error) {
    console.error("[api/arenaWarPools] request failed", error);
    return json(res, 503, { ok: false, error: "War Pool storage is unavailable", detail: String(error?.message || error || "unknown error") });
  }
}
