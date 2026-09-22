import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import {
  WAR_POOL_GENERATION_V2,
  battlePoolId,
  signResolvePlacesV2,
  signResolvePool,
  signResolvePoolV2,
  tournamentPoolId,
  warPoolAbiForGeneration,
  warPoolGeneration,
  warPoolTreasuryAddress,
} from "./lib/arenaWarPoolEscrow.js";
import { buildTournamentPlaces } from "./lib/arenaTournamentPlaces.js";
import { escrowRequired, readOnchainPool, stakeToWei } from "./lib/arenaWarPoolLive.js";
import { isSolanaWarzoneChainId, stakeToLamports, walletsEqual } from "./lib/solanaArenaPoolRead.js";
import { promoteMatchedIfFunded } from "./arenaBattles.js";
import { nativeSymbolFor } from "./lib/chainNative.js";
import { ethers } from "ethers";

const STATES = new Set(["open", "locked", "settling", "paid"]);
const TRANSITIONS = { open: ["locked"], locked: ["settling"], settling: ["paid"], paid: ["open"] };

function futureIso(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function ident(value, chainId) {
  const normalized = normalizeWalletFlexible(value);
  if (normalized) return normalized;
  const raw = String(value || "").trim();
  if (isSolanaWarzoneChainId(chainId)) return raw;
  return raw.toLowerCase();
}

function sameWallet(a, b, chainId) {
  if (isSolanaWarzoneChainId(chainId)) return walletsEqual(a, b);
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function normalizeState(value) {
  const state = String(value || "open");
  return STATES.has(state) ? state : "open";
}

function sum(entries, sideTokenId) {
  return entries.filter((entry) => !sideTokenId || entry.sideTokenId === sideTokenId).reduce((total, entry) => total + Number(entry.amountUsd || 0), 0);
}

/**
 * Solana's arena is the Competition V2 generation -- arena_config is version 2
 * and the program resolves through resolve_pool_v2 with the 75/20/5 entry split
 * -- but warPoolGeneration only recognises an EVM treasury address, and Solana
 * escrow is a program PDA probed on chain instead. Without this the UI would
 * quote chain 101 the old V1 numbers while the program pays the V2 ones.
 */
export function isCompetitionV2Chain(chainId, env = process.env) {
  if (Number(chainId) === 101) return true;
  return warPoolGeneration(chainId, env) === WAR_POOL_GENERATION_V2;
}

function routing(totalPotUsd, chainId) {
  const v2 = isCompetitionV2Chain(chainId);
  if (v2) {
    return {
      winnersUsd: Math.round(totalPotUsd * 0.75),
      prizeUsd: Math.round(totalPotUsd * 0.75),
      protocolUsd: Math.round(totalPotUsd * 0.05),
      leagueUsd: Math.round(totalPotUsd * 0.2),
      featuredUsd: Math.round(totalPotUsd * 0.2),
      split: "75/20/5",
    };
  }
  return { winnersUsd: Math.round(totalPotUsd * 0.85), protocolUsd: Math.round(totalPotUsd * 0.05), featuredUsd: Math.round(totalPotUsd * 0.1), split: "85/5/10" };
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

function poolPayload(record, entries, extraChainId) {
  const totalPotUsd = sum(entries);
  const kind = String(record.kind || "battle") === "tournament" ? "tournament" : "battle";
  return {
    battleId: String(record.battle_id),
    poolId: kind === "tournament" ? tournamentPoolId(record.battle_id) : battlePoolId(record.battle_id),
    kind,
    state: normalizeState(record.state),
    totalPotUsd,
    cutoffAt: record.cutoff_at ? new Date(record.cutoff_at).toISOString() : futureIso(30),
    routingBreakdown: routing(totalPotUsd, extraChainId),
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
    `select * from public.arena_war_pools where battle_id = $1 limit 1`,
    [battleId],
  );
  const record = result.rows?.[0];
  return record ? poolPayload(record, await entriesFor(battleId)) : null;
}

async function ensurePool(subjectId, { kind = "battle", cutoffAt } = {}) {
  const existing = await pool.query(
    `select * from public.arena_war_pools where battle_id = $1 limit 1`,
    [subjectId],
  );
  if (existing.rows?.[0]) return existing.rows[0];
  const cutoff = cutoffAt ? new Date(cutoffAt) : new Date(Date.now() + 30 * 60_000);
  const kindValue = kind === "tournament" ? "tournament" : "battle";
  try {
    const inserted = await pool.query(
      `insert into public.arena_war_pools (battle_id, state, cutoff_at, kind) values ($1, 'open', $2, $3)
       returning *`,
      [subjectId, cutoff.toISOString(), kindValue],
    );
    return inserted.rows[0];
  } catch {
    const inserted = await pool.query(
      `insert into public.arena_war_pools (battle_id, state, cutoff_at) values ($1, 'open', $2)
       returning *`,
      [subjectId, cutoff.toISOString()],
    );
    return inserted.rows[0];
  }
}

async function listPools(chainId) {
  const id = Number(chainId);
  let result;
  if (Number.isInteger(id) && id > 0) {
    try {
      result = await pool.query(
        `select p.*
           from public.arena_war_pools p
           left join public.arena_battles b on b.id = p.battle_id
           left join public.arena_tournaments t on t.id = p.battle_id
          where b.chain_id = $1 or t.chain_id = $1
          order by coalesce(p.updated_at, p.created_at) desc
          limit 200`,
        [id],
      );
    } catch (error) {
      console.warn("[api/arenaWarPools] chain-filtered list failed", error?.message || error);
      result = await pool.query(
        `select *
           from public.arena_war_pools
          order by coalesce(updated_at, created_at) desc
          limit 200`,
      );
    }
  } else {
    result = await pool.query(
      `select *
         from public.arena_war_pools
        order by coalesce(updated_at, created_at) desc
        limit 200`,
    );
  }
  const pools = [];
  for (const row of result.rows) pools.push(poolPayload(row, await entriesFor(row.battle_id), chainId));
  return pools;
}

function settlementSummary(poolRecord, extra = {}) {
  return {
    winnerTokenId: extra.winnerTokenId || null,
    winnerLabel: extra.winnerLabel || "Supporters are not paid",
    totalPotUsd: poolRecord.totalPotUsd,
    winnerSideUsd: extra.winnerSideUsd || 0,
    loserSideUsd: extra.loserSideUsd || 0,
    projectedPayoutMultiple: 0,
    projectedWinnerPayoutUsd: 0,
    projectedNetProfitUsd: 0,
    eligibleWinningEntries: 0,
    settlementStateLabel: poolRecord.state,
    settlementStateBody:
      extra.body ||
      (isCompetitionV2Chain(extra.chainId)
        ? "Support is a donation, not betting. Supporters are not paid. 75% prize / 20% league / 5% protocol once escrow is live."
        : "Support is a donation, not betting. Supporters are not paid. 85% winning campaign / 5% protocol / 10% Major War League once escrow is live."),
    routingBreakdown: poolRecord.routingBreakdown,
  };
}

async function battleRow(id) {
  const result = await pool.query(`select * from public.arena_battles where id = $1 limit 1`, [id]);
  return result.rows[0] || null;
}

async function tournamentRow(id) {
  const result = await pool.query(`select * from public.arena_tournaments where id = $1 limit 1`, [id]);
  return result.rows[0] || null;
}

async function listTournamentEntries(id) {
  const result = await pool.query(
    `select token_address, owner_wallet from public.arena_tournament_entries where tournament_id = $1 order by created_at asc`,
    [id],
  );
  return result.rows.map((row) => ({
    tokenAddress: ident(row.token_address),
    ownerWallet: ident(row.owner_wallet),
  }));
}

function aliveTokens(tournament) {
  const bracket = tournament?.bracket && typeof tournament.bracket === "object" ? tournament.bracket : { rounds: [] };
  const rounds = Array.isArray(bracket.rounds) ? bracket.rounds : [];
  const losers = new Set();
  for (const round of rounds) {
    for (const match of round.matches || []) {
      const winner = ident(match.winner);
      if (!winner) continue;
      for (const token of [match.tokenA, match.tokenB]) {
        const id = ident(token);
        if (id && id !== winner) losers.add(id);
      }
    }
  }
  return losers;
}

function tokenStillAlive(tournament, token, roster) {
  const id = ident(token);
  if (!id) return false;
  if (!roster.some((entry) => entry.tokenAddress === id)) return false;
  const status = String(tournament.status || "");
  if (status === "upcoming") return true;
  if (status === "finished" || status === "cancelled") return false;
  return !aliveTokens(tournament).has(id);
}

function tournamentCutoff(row) {
  if (row.ends_at) return new Date(row.ends_at);
  if (row.starts_at) return new Date(new Date(row.starts_at).getTime() + 30 * 24 * 3600_000);
  return new Date(Date.now() + 30 * 24 * 3600_000);
}

function ownerWallets(row) {
  const parts = Array.isArray(row.participants) ? row.participants : [];
  return {
    ownerA: normalizeWalletFlexible(parts[0]?.ownerWallet || row.creator_address || "") || "",
    ownerB: normalizeWalletFlexible(parts[1]?.ownerWallet || "") || "",
  };
}

function ownerOfWinner(row) {
  const parts = Array.isArray(row.participants) ? row.participants : [];
  const winner = String(row.winner_token || "").toLowerCase();
  const match = parts.find((part) => String(part.tokenAddress || part.tokenId || "").toLowerCase() === winner);
  return normalizeWalletFlexible(match?.ownerWallet || "") || "";
}

async function ownerOfTournamentWinner(tournament) {
  const winner = ident(tournament.winner_token);
  if (!winner) return "";
  const result = await pool.query(
    `select owner_wallet from public.arena_tournament_entries
      where tournament_id = $1 and lower(token_address) = lower($2) limit 1`,
    [tournament.id, winner],
  );
  return ident(result.rows[0]?.owner_wallet || "");
}

/**
 * Paid places of a finished tournament (1st / 2nd / 3rd by entrant count,
 * first place = bracket champion), joined to the paid entries' owner wallets.
 * { ok, places: [{ asset, wallet, bps }] } or { ok: false, reason }.
 */
async function tournamentPlacesFor(tournament) {
  const result = await pool.query(
    `select token_address, owner_wallet, buy_in_paid
       from public.arena_tournament_entries
      where tournament_id = $1 and buy_in_paid = true
      order by created_at asc`,
    [tournament.id],
  );
  const entries = result.rows.map((row) => ({ token_address: ident(row.token_address), owner_wallet: ident(row.owner_wallet) }));
  const built = buildTournamentPlaces({ bracket: tournament.bracket, entries, entrantCount: entries.length });
  if (!built.ok) return built;
  return { ok: true, places: built.places.map((place, index) => ({ place: index + 1, asset: place.asset, wallet: place.wallet, bps: place.bps })) };
}

function placeForWallet(places, wallet, chainId) {
  return (places || []).find((place) => sameWallet(place.wallet ?? place.payout, wallet, chainId)) || null;
}

function supportOpenForTournament(row) {
  const status = String(row.status || "");
  return status === "upcoming" || status === "live";
}

async function resolveSubject(id) {
  const tournament = await tournamentRow(id);
  if (tournament) return { kind: "tournament", tournament, battle: null };
  const battle = await battleRow(id);
  if (battle) return { kind: "battle", tournament: null, battle };
  return null;
}

function detailExtras(kind, onchain, chainId, nativeSymbol, sides, extra = {}) {
  return {
    kind,
    chainId,
    nativeSymbol,
    configured: Boolean(onchain?.configured),
    live: onchain?.live === true,
    treasury: onchain?.treasury || "",
    onchainPoolId: onchain?.poolId || null,
    onchainOpened: Boolean(onchain?.opened),
    escrowRequired: escrowRequired(chainId),
    supportOpen: extra.supportOpen !== false,
    sides,
    redirectTournamentId: extra.redirectTournamentId || null,
  };
}

async function handleSummary(req, res) {
  try {
    const chainId = Number(getQuery(req).chainId || 0) || undefined;
    const pools = await listPools(chainId);
    return json(res, 200, {
      summary: {
        pools,
        totalPotUsd: pools.reduce((total, item) => total + item.totalPotUsd, 0),
        openPools: pools.filter((item) => item.state === "open").length,
        lockedPools: pools.filter((item) => item.state === "locked" || item.state === "settling").length,
        paidPools: pools.filter((item) => item.state === "paid").length,
      },
    });
  } catch (error) {
    console.error("[api/arenaWarPools] summary failed", error);
    return json(res, 200, { summary: { pools: [], totalPotUsd: 0, openPools: 0, lockedPools: 0, paidPools: 0 }, warning: "War Pool data is unavailable." });
  }
}

async function handleDetail(_req, res, subjectId) {
  const subject = await resolveSubject(subjectId);
  if (!subject) return json(res, 404, { error: "War Pool not found" });

  if (subject.kind === "battle" && String(subject.battle.source || "") === "tournament" && subject.battle.tournament_id) {
    return json(res, 200, {
      pool: null,
      settlementSummary: null,
      ...detailExtras("battle", { configured: false }, Number(subject.battle.chain_id), subject.battle.native_symbol || nativeSymbolFor(subject.battle.chain_id), [], {
        supportOpen: false,
        redirectTournamentId: subject.battle.tournament_id,
      }),
      warning: "Tournament matches have no Support pot. Support the memecoin on the tournament page.",
    });
  }

  if (subject.kind === "tournament") {
    const roster = await listTournamentEntries(subject.tournament.id);
    const record = await ensurePool(subject.tournament.id, { kind: "tournament", cutoffAt: tournamentCutoff(subject.tournament) });
    if (!supportOpenForTournament(subject.tournament) && normalizeState(record.state) === "open") {
      await pool.query(`update public.arena_war_pools set state = 'locked', updated_at = now() where battle_id = $1`, [subject.tournament.id]);
      record.state = "locked";
    }
    const poolRecord = poolPayload(record, await entriesFor(subject.tournament.id), Number(subject.tournament.chain_id));
    const onchain = await readOnchainPool(Number(subject.tournament.chain_id), subject.tournament.id, "tournament");
    const sides = roster.map((entry) => ({
      tokenId: entry.tokenAddress,
      ownerWallet: entry.ownerWallet,
      eligible: tokenStillAlive(subject.tournament, entry.tokenAddress, roster),
    }));
    const winnerTokenId = ident(subject.tournament.winner_token) || null;
    return json(res, 200, {
      pool: poolRecord,
      settlementSummary: settlementSummary(poolRecord, {
        winnerTokenId,
        winnerLabel: winnerTokenId ? "Champion takes the tournament pot" : "Supporters are not paid",
        winnerSideUsd: winnerTokenId ? sum(poolRecord.entries, winnerTokenId) : 0,
        body: Number(subject.tournament.chain_id) === 46630 || isCompetitionV2Chain(Number(subject.tournament.chain_id))
          ? "Support is a donation to a roster memecoin. The overall champion takes 75% of buy-ins plus Support. 5% protocol / 20% league. Supporters are not paid."
          : "Support is a donation to a roster memecoin. The overall champion takes 85% of buy-ins plus Support. 5% protocol / 10% Major War League. Supporters are not paid.",
        chainId: Number(subject.tournament.chain_id),
      }),
      ...detailExtras("tournament", onchain, Number(subject.tournament.chain_id), subject.tournament.native_symbol || nativeSymbolFor(subject.tournament.chain_id), sides, {
        supportOpen: supportOpenForTournament(subject.tournament) && poolRecord.state === "open",
      }),
    });
  }

  const record = await ensurePool(subject.battle.id, { kind: "battle" });
  const poolRecord = poolPayload(record, await entriesFor(subject.battle.id), Number(subject.battle.chain_id));
  const onchain = await readOnchainPool(Number(subject.battle.chain_id), subject.battle.id, "battle");
  const parts = Array.isArray(subject.battle.participants) ? subject.battle.participants : [];
  const sides = parts
    .filter((part) => part?.tokenAddress || part?.tokenId)
    .map((part) => ({
      tokenId: ident(part.tokenAddress || part.tokenId),
      ownerWallet: ident(part.ownerWallet),
      eligible: subject.battle.state === "live" || subject.battle.state === "matched" || subject.battle.state === "challenged" || subject.battle.state === "waiting",
    }));
  return json(res, 200, {
    pool: poolRecord,
    settlementSummary: settlementSummary(poolRecord, {
      winnerTokenId: ident(subject.battle.winner_token) || null,
      chainId: Number(subject.battle.chain_id),
    }),
    ...detailExtras("battle", onchain, Number(subject.battle.chain_id), subject.battle.native_symbol || nativeSymbolFor(subject.battle.chain_id), sides, {
      supportOpen: poolRecord.state === "open" && subject.battle.state !== "finished" && subject.battle.state !== "expired",
    }),
  });
}

async function recordSupportLedger({ subjectId, kind, sideTokenId, supporterAddress, amountUsd, amountNative }) {
  await pool.query(
    `insert into public.arena_war_pool_entries (battle_id, side_token_id, amount_usd, supporter_address, payout_eligible) values ($1, $2, $3, $4, false)`,
    [subjectId, sideTokenId, amountUsd, supporterAddress || null],
  );
  try {
    if (kind === "tournament") {
      await pool.query(
        `insert into public.arena_support_entries (battle_id, tournament_id, side_token, supporter_wallet, amount_native, payouts_live)
         values (null,$1,$2,$3,$4,false)`,
        [subjectId, sideTokenId, supporterAddress || "unknown", amountNative],
      );
    } else {
      await pool.query(
        `insert into public.arena_support_entries (battle_id, tournament_id, side_token, supporter_wallet, amount_native, payouts_live)
         values ($1,null,$2,$3,$4,false)`,
        [subjectId, sideTokenId, supporterAddress || "unknown", amountNative],
      );
    }
  } catch (error) {
    console.warn("[api/arenaWarPools] support ledger insert failed", error?.message || error);
  }
  await pool.query(`update public.arena_war_pools set updated_at = now() where battle_id = $1`, [subjectId]);
}

async function handleSupport(req, res, subjectId) {
  const body = req._arenaSupportBody || (await readJson(req));
  const subject = await resolveSubject(subjectId);
  if (!subject) return json(res, 404, { ok: false, error: "War Pool not found" });

  if (subject.kind === "battle" && String(subject.battle.source || "") === "tournament" && subject.battle.tournament_id) {
    return json(res, 409, {
      ok: false,
      error: "Support this memecoin on the tournament page. Match fights have no Support pot.",
      code: "TOURNAMENT_SUPPORT_ONLY",
      tournamentId: subject.battle.tournament_id,
    });
  }

  const sideTokenId = ident(body?.sideTokenId || "");
  const amountNative = Number(body?.amountNative || 0);
  const amountUsd = Number(body?.amountUsd || (amountNative > 0 ? amountNative : 0));
  const supporterAddress = ident(body?.supporterAddress || body?.walletAddress || body?.auth?.walletAddress || "");
  if (!sideTokenId || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    return json(res, 400, { ok: false, error: "sideTokenId and a positive amount are required" });
  }
  if (!supporterAddress) return json(res, 400, { ok: false, error: "walletAddress is required" });

  const chainId = Number((subject.tournament || subject.battle).chain_id);
  {
    const verified = await requireWalletActionAuth({
      res,
      pool,
      auth: body.auth || body,
      expectedWallet: supporterAddress,
      chainId,
      action: "arena_war_pool_support",
      routeLabel: "arena/war-pools/support",
      extraLines: [
        `${subject.kind === "tournament" ? "Tournament" : "Battle"}: ${subjectId}`,
        `Token: ${sideTokenId}`,
        body.txHash ? `Tx: ${String(body.txHash).trim()}` : "",
      ].filter(Boolean),
    });
    if (!verified) return;
  }

  if (subject.kind === "tournament") {
    if (!supportOpenForTournament(subject.tournament)) {
      return json(res, 409, { ok: false, error: "Tournament Support is closed" });
    }
    const roster = await listTournamentEntries(subject.tournament.id);
    if (!tokenStillAlive(subject.tournament, sideTokenId, roster)) {
      return json(res, 409, { ok: false, error: "That memecoin is not on the live tournament roster" });
    }
    const record = await ensurePool(subject.tournament.id, { kind: "tournament", cutoffAt: tournamentCutoff(subject.tournament) });
    if (normalizeState(record.state) !== "open") return json(res, 409, { ok: false, error: "War Pool is not open" });
    const onchain = await readOnchainPool(chainId, subject.tournament.id, "tournament");
    if (onchain.configured) {
      const txHash = String(body.txHash || "").trim();
      if (!txHash) return json(res, 400, { ok: false, error: "On-chain donateSupport txHash is required", code: "SUPPORT_TX_REQUIRED" });
      if (!onchain.opened) return json(res, 503, { ok: false, error: "Tournament escrow is not open yet.", code: "WAR_POOL_NOT_OPEN" });
      try {
        await pool.query(
          `insert into public.arena_war_pool_deposits (pool_id, purpose, wallet, amount_wei, tx_hash, chain_id)
           values ($1,'support',$2,$3,$4,$5)
           on conflict (chain_id, tx_hash) do nothing`,
          [onchain.poolId, supporterAddress || "unknown", stakeToWei(amountNative || amountUsd).toString(), txHash, chainId],
        );
      } catch (error) {
        console.warn("[api/arenaWarPools] support deposit insert failed", error?.message || error);
      }
    }
    await recordSupportLedger({
      subjectId: subject.tournament.id,
      kind: "tournament",
      sideTokenId,
      supporterAddress,
      amountUsd,
      amountNative: amountNative || amountUsd,
    });
    return handleDetail(req, res, subject.tournament.id);
  }

  const record = await ensurePool(subject.battle.id, { kind: "battle" });
  if (normalizeState(record.state) !== "open") return json(res, 409, { ok: false, error: "War Pool is not open" });
  const parts = Array.isArray(subject.battle.participants) ? subject.battle.participants : [];
  const onRoster = parts.some((part) => ident(part.tokenAddress || part.tokenId) === sideTokenId);
  if (!onRoster) return json(res, 409, { ok: false, error: "That memecoin is not in this fight" });
  const onchain = await readOnchainPool(chainId, subject.battle.id, "battle");
  if (onchain.configured) {
    const txHash = String(body.txHash || "").trim();
    if (!txHash) return json(res, 400, { ok: false, error: "On-chain donateSupport txHash is required", code: "SUPPORT_TX_REQUIRED" });
    if (!onchain.opened) return json(res, 503, { ok: false, error: "Battle escrow is not open yet.", code: "WAR_POOL_NOT_OPEN" });
    try {
      await pool.query(
        `insert into public.arena_war_pool_deposits (pool_id, purpose, wallet, amount_wei, tx_hash, chain_id)
         values ($1,'support',$2,$3,$4,$5)
         on conflict (chain_id, tx_hash) do nothing`,
        [onchain.poolId, supporterAddress || "unknown", stakeToWei(amountNative || amountUsd).toString(), txHash, chainId],
      );
    } catch (error) {
      console.warn("[api/arenaWarPools] support deposit insert failed", error?.message || error);
    }
  }
  await recordSupportLedger({
    subjectId: subject.battle.id,
    kind: "battle",
    sideTokenId,
    supporterAddress,
    amountUsd,
    amountNative: amountNative || amountUsd,
  });
  return handleDetail(req, res, subject.battle.id);
}

async function handleSupportReceipt(req, res, subjectId) {
  req._arenaSupportBody = await readJson(req);
  return handleSupport(req, res, subjectId);
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
  return handleDetail(req, res, battleId);
}

async function handleStake(req, res, battleId) {
  const row = await battleRow(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  const chainId = Number(row.chain_id);
  const query = getQuery(req);
  const wallet = ident(query.wallet || query.walletAddress || "", chainId);
  const { ownerA, ownerB } = ownerWallets(row);
  const onchain = await readOnchainPool(chainId, battleId);
  const stakeNative = Number(row.offered_stake_native ?? row.stake_native ?? 0);
  const stakeWei = isSolanaWarzoneChainId(chainId)
    ? (stakeNative > 0 ? stakeToLamports(stakeNative).toString() : "0")
    : stakeToWei(stakeNative).toString();
  const now = Math.floor(Date.now() / 1000);
  const opened = Boolean(onchain.opened);
  const resolvedOwnerA = opened ? onchain.ownerA : ownerA;
  const resolvedOwnerB = opened ? onchain.ownerB : ownerB;
  const myRole = sameWallet(wallet, resolvedOwnerA, chainId)
    ? "a"
    : sameWallet(wallet, resolvedOwnerB, chainId)
      ? "b"
      : null;
  const durationHours = Number(row.offered_duration_hours ?? row.duration_hours ?? 24);
  const nowSec = now;
  const depositDeadline = Number(onchain.depositDeadline || nowSec + 24 * 3600);
  const resolveDeadline = Number(onchain.resolveDeadline || nowSec + (24 + durationHours + 24) * 3600);
  const minePaid = myRole === "a" ? Boolean(onchain.paidA) : myRole === "b" ? Boolean(onchain.paidB) : false;
  const mineRefunded = myRole === "a" ? Boolean(onchain.refundedA) : myRole === "b" ? Boolean(onchain.refundedB) : false;
  const canRefund =
    Boolean(onchain.configured && opened && myRole && minePaid && !onchain.bothPaid && !mineRefunded && nowSec > depositDeadline);
  let nextMethod = null;
  if (onchain.configured && row.state === "matched" && myRole && Number(onchain.onchainState || 0) !== 3) {
    if (!opened) nextMethod = "openBattlePool";
    else if (myRole === "a" && !onchain.paidA && !onchain.refundedA) nextMethod = "depositStake";
    else if (myRole === "b" && !onchain.paidB && !onchain.refundedB) nextMethod = "depositStake";
  }
  if (row.state === "matched") {
    try {
      await promoteMatchedIfFunded(row);
    } catch (error) {
      console.warn("[api/arenaWarPools] promote matched failed", error?.message || error);
    }
  }
  return json(res, 200, {
    ok: true,
    battleId,
    chainId,
    battleState: row.state,
    escrowRequired: isSolanaWarzoneChainId(chainId) ? Boolean(onchain.configured) : escrowRequired(chainId),
    configured: Boolean(onchain.configured),
    treasury: onchain.treasury || "",
    poolId: onchain.poolId,
    abi: onchain.abi || warPoolAbiForGeneration(warPoolGeneration(chainId)),
    poolGeneration: onchain.poolGeneration || warPoolGeneration(chainId) || null,
    nativeSymbol: row.native_symbol || nativeSymbolFor(chainId),
    stakeNative,
    stakeWei,
    ownerA: resolvedOwnerA,
    ownerB: resolvedOwnerB,
    opened,
    paidA: Boolean(onchain.paidA),
    paidB: Boolean(onchain.paidB),
    bothPaid: Boolean(onchain.bothPaid),
    myRole,
    nextMethod,
    openWithValue: isSolanaWarzoneChainId(chainId),
    live: onchain.live === true,
    programId: onchain.programId || "",
    assetA: onchain.assetA || participantsAsset(row, 0),
    assetB: onchain.assetB || participantsAsset(row, 1),
    requiredStakeA: onchain.requiredStakeA || stakeWei,
    requiredStakeB: onchain.requiredStakeB || stakeWei,
    supportDeadline: Number(onchain.supportDeadline || depositDeadline),
    canRefund,
    durationHours,
    depositDeadline,
    resolveDeadline,
    onchainState: Number(onchain.onchainState || 0),
    error: onchain.error || null,
  });
}

function participantsAsset(row, index) {
  const parts = Array.isArray(row.participants) ? row.participants : [];
  return String(parts[index]?.tokenAddress || parts[index]?.tokenId || "").trim();
}

async function handleStakeReceipt(req, res, battleId) {
  const body = await readJson(req).catch(() => ({}));
  const row = await battleRow(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  const chainId = Number(row.chain_id);
  const { ownerA, ownerB } = ownerWallets(row);
  const wallet = ident(body.auth?.walletAddress || body.walletAddress || body.wallet || "", chainId);
  const expected = [ownerA, ownerB].find((item) => sameWallet(item, wallet, chainId));
  if (!expected) return json(res, 403, { ok: false, error: "Only the two fighting owners can deposit stake." });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: expected,
    chainId,
    action: "arena_deposit_stake",
    routeLabel: "arena/war-pools/stake-receipt",
    extraLines: [`Battle: ${battleId}`, `Tx: ${String(body.txHash || "").trim()}`],
  });
  if (!verified) return;
  const txHash = String(body.txHash || "").trim();
  if (!txHash) return json(res, 400, { ok: false, error: "txHash is required" });
  const onchain = await readOnchainPool(chainId, battleId);
  const amount = onchain.stakeAmount || stakeToWei(row.offered_stake_native ?? row.stake_native).toString();
  try {
    await pool.query(
      `insert into public.arena_war_pool_deposits (pool_id, purpose, wallet, amount_wei, tx_hash, chain_id)
       values ($1,'stake',$2,$3,$4,$5)
       on conflict (chain_id, tx_hash) do nothing`,
      [onchain.poolId || battleId, expected, amount || "0", txHash, chainId],
    );
  } catch (error) {
    console.warn("[api/arenaWarPools] stake receipt insert failed", error?.message || error);
  }
  let battle = null;
  try {
    battle = await promoteMatchedIfFunded({ ...row, state: row.state === "matched" ? "matched" : row.state });
  } catch (error) {
    console.warn("[api/arenaWarPools] promote after stake failed", error?.message || error);
  }
  const latest = await readOnchainPool(chainId, battleId);
  if (latest.bothPaid && row.state !== "live" && row.state !== "finished") {
    try {
      battle = await promoteMatchedIfFunded({ ...row, state: "matched" });
    } catch (error) {
      console.warn("[api/arenaWarPools] force promote failed", error?.message || error);
    }
  }
  return json(res, 200, { ok: true, bothPaid: Boolean(latest.bothPaid), battle, onchain: latest });
}

async function signAndReturnClaim({ res, chainId, subjectId, kind, winnerPayout, places = null }) {
  const plannedPlaces = places?.ok ? places.places : null;
  if (isSolanaWarzoneChainId(chainId)) {
    const onchain = await readOnchainPool(chainId, subjectId, kind);
    if (onchain.configured !== true || onchain.live !== true) {
      return json(res, 503, {
        ok: false,
        error: "Solana Warzone escrow is not live yet.",
        code: "WAR_POOL_TREASURY_MISSING",
        configured: false,
        live: false,
      });
    }
    if (Number(onchain.onchainState) !== 2) {
      return json(res, 409, {
        ok: false,
        error: "Waiting for Warzone resolution. Resolve stays operator-side.",
        code: "WAR_POOL_NOT_RESOLVED",
        chain: "solana",
        configured: true,
        live: true,
        resolved: false,
        programId: onchain.programId,
        poolId: onchain.poolId,
        winnerWallet: onchain.winnerWallet || winnerPayout,
        places: plannedPlaces,
      });
    }
    // A tournament resolved with places pays each place through claim_place_v2
    // (place 1 is the same payout claim_winner would pay). The program's own
    // place list is authoritative here, never the database.
    const onchainPlaces = Array.isArray(onchain.places) ? onchain.places : [];
    const placesResolved = kind === "tournament" && onchainPlaces.length > 0;
    return json(res, 200, {
      ok: true,
      chain: "solana",
      configured: true,
      live: true,
      resolved: true,
      programId: onchain.programId,
      poolId: onchain.poolId,
      poolPda: onchain.poolPda,
      vaultPda: onchain.vaultPda,
      winnerWallet: onchain.winnerWallet || winnerPayout,
      claimedWinner: Boolean(onchain.claimedWinner),
      pendingWinner: String(onchain.pendingWinner || "0"),
      claimMethod: placesResolved ? "claimPlace" : "claimWinner",
      places: placesResolved ? onchainPlaces : null,
    });
  }
  const treasury = warPoolTreasuryAddress(chainId);
  if (!treasury) return json(res, 503, { ok: false, error: "Arena war pool treasury is not deployed on this chain.", code: "WAR_POOL_TREASURY_MISSING" });
  if (!winnerPayout) return json(res, 409, { ok: false, error: "Winning campaign owner is unknown" });
  const generation = warPoolGeneration(chainId);
  const abi = warPoolAbiForGeneration(generation);
  const poolId = kind === "tournament" ? tournamentPoolId(subjectId) : battlePoolId(subjectId);
  const provider = await getServerReadProvider(chainId);
  const contract = new ethers.Contract(treasury, abi, provider);
  const onchain = await contract.pools(poolId);
  const stakeTotal = BigInt(onchain.stakeA || 0) + BigInt(onchain.stakeB || 0);
  const buyInTotal = BigInt(onchain.buyInTotal || 0);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const v2 = generation === WAR_POOL_GENERATION_V2;
  const boostTotal = BigInt(onchain.boostTotal || 0);
  const supportTotal = BigInt(onchain.supportTotal || 0);
  if (kind === "tournament" && v2 && plannedPlaces) {
    // ArenaWarPoolTreasuryV2.resolvePlaces: 1-3 paid places, signed as one list.
    const payouts = plannedPlaces.map((place) => ethers.getAddress(place.wallet));
    const bps = plannedPlaces.map((place) => Number(place.bps));
    const signedPlaces = await signResolvePlacesV2({ treasuryAddress: treasury, chainId, poolId, payouts, bps, stakeTotal, buyInTotal, boostTotal, deadline });
    if (!signedPlaces) {
      return json(res, 503, { ok: false, error: "Resolver key is not configured (ARENA_WAR_POOL_RESOLVER_KEY).", code: "WAR_POOL_RESOLVER_MISSING" });
    }
    return json(res, 200, {
      ok: true,
      treasury,
      chainId,
      poolId,
      kind,
      abi,
      poolGeneration: generation || null,
      winnerPayout: payouts[0],
      nativeSymbol: nativeSymbolFor(chainId),
      pendingWinner: String(onchain.pendingWinner || 0),
      pendingProtocol: String(onchain.pendingProtocol || 0),
      pendingLeague: String(onchain.pendingLeague || onchain.pendingMwl || 0),
      claimedWinner: Boolean(onchain.claimedWinner),
      claimedProtocol: Boolean(onchain.claimedProtocol),
      claimedLeague: Boolean(onchain.claimedLeague || onchain.claimedMwl),
      resolved: Number(onchain.state) === 2,
      resolve: {
        version: "2-places",
        payouts,
        bps,
        deadline,
        signature: signedPlaces.signature,
        placesHash: signedPlaces.placesHash,
        stakeTotal: stakeTotal.toString(),
        buyInTotal: buyInTotal.toString(),
        boostTotal: boostTotal.toString(),
      },
      places: plannedPlaces.map((place, index) => ({ place: index + 1, payout: payouts[index], wallet: payouts[index], asset: place.asset, bps: bps[index] })),
      claimMethod: "claimPlace",
      claimMethods: ["claimPlace", "claimProtocol", "claimLeague"],
      leagueEpochs: {
        monthlyEpoch: ethers.id(`${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`),
        quarterlyEpoch: ethers.id(`${new Date().getUTCFullYear()}-Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`),
      },
    });
  }
  const signed = v2
    ? await signResolvePoolV2({
        treasuryAddress: treasury,
        chainId,
        poolId,
        winnerPayout,
        stakeTotal,
        buyInTotal,
        boostTotal,
        deadline,
      })
    : await signResolvePool({
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
    kind,
    abi,
    poolGeneration: generation || null,
    winnerPayout,
    nativeSymbol: nativeSymbolFor(chainId),
    pendingWinner: String(onchain.pendingWinner || 0),
    pendingProtocol: String(onchain.pendingProtocol || 0),
    pendingLeague: String(onchain.pendingLeague || onchain.pendingMwl || 0),
    claimedWinner: Boolean(onchain.claimedWinner),
    claimedProtocol: Boolean(onchain.claimedProtocol),
    claimedLeague: Boolean(onchain.claimedLeague || onchain.claimedMwl),
    resolve: v2
      ? {
          winnerPayout,
          deadline,
          signature: signed.signature,
          version: "2",
          stakeTotal: stakeTotal.toString(),
          buyInTotal: buyInTotal.toString(),
          boostTotal: boostTotal.toString(),
        }
      : {
          winnerPayout,
          deadline,
          signature: signed.signature,
          version: "1",
          stakeTotal: stakeTotal.toString(),
          supportTotal: supportTotal.toString(),
          buyInTotal: buyInTotal.toString(),
        },
    claimMethod: "claimWinner",
    claimMethods: v2 ? ["claimWinner", "claimProtocol", "claimLeague"] : ["claimWinner", "claimProtocol", "claimMwl"],
    leagueEpochs: v2
      ? {
          monthlyEpoch: ethers.id(`${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`),
          quarterlyEpoch: ethers.id(`${new Date().getUTCFullYear()}-Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`),
        }
      : null,
  });
}

async function handleClaimIntent(req, res, subjectId) {
  const subject = await resolveSubject(subjectId);
  if (!subject) return json(res, 404, { ok: false, error: "Pool not found" });
  if (subject.kind === "tournament") {
    if (subject.tournament.status !== "finished") return json(res, 409, { ok: false, error: "Tournament is not finished" });
    const winnerPayout = await ownerOfTournamentWinner(subject.tournament);
    const places = await tournamentPlacesFor(subject.tournament);
    if (!places.ok) {
      return json(res, 409, { ok: false, error: "Tournament places cannot be determined from the bracket and paid entries.", code: "TOURNAMENT_PLACES_UNRESOLVED", reason: places.reason });
    }
    return signAndReturnClaim({
      res,
      chainId: Number(subject.tournament.chain_id),
      subjectId: subject.tournament.id,
      kind: "tournament",
      winnerPayout,
      places,
    });
  }
  if (String(subject.battle.source || "") === "tournament") {
    return json(res, 409, { ok: false, error: "Claim tournament rewards from the tournament pot, not this match." });
  }
  if (subject.battle.state !== "finished") return json(res, 409, { ok: false, error: "Battle is not finished" });
  return signAndReturnClaim({
    res,
    chainId: Number(subject.battle.chain_id),
    subjectId: subject.battle.id,
    kind: "battle",
    winnerPayout: ownerOfWinner(subject.battle),
  });
}

async function handleClaimable(req, res) {
  const query = getQuery(req);
  const wallet = normalizeWalletFlexible(query.wallet || query.walletAddress || "");
  if (!wallet) return json(res, 400, { ok: false, error: "wallet is required" });
  const items = [];
  const battles = await pool.query(
    `select id, chain_id, winner_token, participants, stake_native, native_symbol, source
       from public.arena_battles
      where state = 'finished' and winner_token is not null and coalesce(source, '') <> 'tournament'
      order by finished_at desc nulls last
      limit 50`,
  );
  for (const row of battles.rows) {
    if (!sameWallet(ownerOfWinner(row), wallet, row.chain_id)) continue;
    items.push({
      battleId: row.id,
      kind: "battle",
      chainId: Number(row.chain_id),
      poolId: battlePoolId(row.id),
      nativeSymbol: row.native_symbol || nativeSymbolFor(row.chain_id),
      treasury: warPoolTreasuryAddress(row.chain_id) || null,
    });
  }
  const tournaments = await pool.query(
    `select id, chain_id, winner_token, native_symbol, bracket
       from public.arena_tournaments
      where status = 'finished' and winner_token is not null
      order by ends_at desc nulls last
      limit 50`,
  );
  for (const row of tournaments.rows) {
    // Every paid place (1st / 2nd / 3rd) has something to claim, not only the champion.
    const places = await tournamentPlacesFor(row);
    let place = null;
    if (places.ok) {
      place = placeForWallet(places.places, wallet, row.chain_id);
      if (!place) continue;
    } else {
      const owner = await ownerOfTournamentWinner(row);
      if (!owner || !sameWallet(owner, wallet, row.chain_id)) continue;
    }
    items.push({
      battleId: row.id,
      kind: "tournament",
      chainId: Number(row.chain_id),
      poolId: tournamentPoolId(row.id),
      nativeSymbol: row.native_symbol || nativeSymbolFor(row.chain_id),
      treasury: warPoolTreasuryAddress(row.chain_id) || null,
      place: place ? place.place : 1,
      placeBps: place ? place.bps : 10_000,
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
    const stake = path.match(/^\/arena\/war-pools\/([^/]+)\/stake$/);
    if (stake) return method === "GET" ? handleStake(req, res, decodeURIComponent(stake[1])) : badMethod(res);
    const stakeReceipt = path.match(/^\/arena\/war-pools\/([^/]+)\/stake-receipt$/);
    if (stakeReceipt) return method === "POST" ? handleStakeReceipt(req, res, decodeURIComponent(stakeReceipt[1])) : badMethod(res);
    const claimIntent = path.match(/^\/arena\/war-pools\/([^/]+)\/claim-intent$/);
    if (claimIntent) return method === "GET" ? handleClaimIntent(req, res, decodeURIComponent(claimIntent[1])) : badMethod(res);
    const supportReceipt = path.match(/^\/arena\/war-pools\/([^/]+)\/support-receipt$/);
    if (supportReceipt) return method === "POST" ? handleSupportReceipt(req, res, decodeURIComponent(supportReceipt[1])) : badMethod(res);
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
