import { randomBytes } from "crypto";

import { pool } from "../server/db.js";
import {
  badMethod,
  getQuery,
  isAddress,
  isSolanaAddress,
  json,
  normalizeAddress,
  normalizeWalletFlexible,
  readJson,
} from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { requireAdminOrOps, isAuthEnforceArenaMutations } from "./lib/apiAuth.js";
import { notifyChallenge, notifyCounterOffer } from "./lib/arenaNotify.js";
import { recordFinishedBattle } from "./lib/arenaLeagueScore.js";
import {
  battleSettlementPatch,
  canSettleBattle,
  decideBattleSettlement,
  decorateSettledParticipants,
} from "./lib/arenaBattleSettle.js";
import {
  arenaMatchProfileFromCoin,
  arenaMatchProfileFromParticipant,
  calculateMatchQuality,
  recommendMatchCandidates,
} from "./lib/arenaMatchQuality.js";
import { advanceTournamentFromBattle } from "./arenaTournaments.js";
import { solanaLiveTransition, solanaMatchedLifecyclePatch, solanaMayGoLive } from "./lib/arenaBattleLive.js";
import { captureLiveBaselines } from "./lib/arenaBattleMetrics.js";
import { escrowRequired, readOnchainPool } from "./lib/arenaWarPoolLive.js";
import { isSolanaWarzoneChainId } from "./lib/solanaArenaPoolRead.js";
import { nativeSymbolFor } from "./lib/chainNative.js";

const LIVE_HOURS = 24;
const CHALLENGE_HOURS = 24;
const DEPOSIT_WINDOW_HOURS = 24;
const STAKE_BAND = 1.2;
const MAX_COUNTERS = 12;
const DURATION_HOURS = new Set([24, 72, 168]);
const ACTIVE_STATES = ["waiting", "challenged", "matched", "live"];
const LIST_STATES = ["waiting", "challenged", "matched", "live", "finished"];

const ADMIN_TRANSITIONS = {
  waiting: ["live", "expired"],
  challenged: ["live", "expired"],
  matched: ["live", "expired"],
  live: ["finished"],
  finished: [],
  expired: [],
};

const NATIVE_COIN_SELECT = `c.chain_id, c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol,
        c.is_active, c.support_enabled, c.graduated_at_chain, c.created_at,
        ms.market_stage, ms.market_cap_bnb, ms.liquidity_bnb, ms.volume_24h_bnb, ms.holders,
        ms.last_trade_at, ms.updated_at as market_updated_at, ms.data_lag_seconds,
        ts.marketcap_bnb, ts.vol_24h_bnb, coalesce(ms.holders, va.votes_24h, 0) as holders_count`;
const NATIVE_COIN_FROM = `from public.campaigns c
       left join public.market_stats ms on ms.chain_id = c.chain_id and ms.campaign_address = c.campaign_address
       left join public.token_stats ts on ts.chain_id = c.chain_id and ts.campaign_address = c.campaign_address
       left join public.vote_aggregates va on va.chain_id = c.chain_id and va.campaign_address = c.campaign_address`;
const IMPORT_COIN_SELECT = `chain_id, token_address, owner_wallet as creator_address, name, symbol, status, scan_json, created_at`;

function nowIso() {
  return new Date().toISOString();
}

function plusHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ident(value, chainId) {
  const flexible = normalizeWalletFlexible(value);
  if (flexible) return isAddress(flexible) ? flexible.toLowerCase() : flexible;
  return normalizeAddress(value, chainId) || String(value ?? "").trim();
}

function isWallet(value) {
  return Boolean(normalizeWalletFlexible(value) || isAddress(value) || isSolanaAddress(value));
}

function parseStake(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseDurationHours(value, fallback = 24) {
  const n = Number(value);
  if (DURATION_HOURS.has(n)) return n;
  if (n === 1) return 24;
  if (n === 3) return 72;
  if (n === 7) return 168;
  return DURATION_HOURS.has(fallback) ? fallback : 24;
}

function durationLabel(hours) {
  if (Number(hours) === 72) return "3 days";
  if (Number(hours) === 168) return "7 days";
  return "24 hours";
}

function stakeCompatible(a, b) {
  const left = toNumber(a);
  const right = toNumber(b);
  if (left <= 0 || right <= 0) return false;
  return Math.max(left, right) / Math.min(left, right) <= STAKE_BAND;
}

function coinMatchProfile(coin) {
  return arenaMatchProfileFromCoin(coin);
}

function participant(coin) {
  const chainId = Number(coin?.chain_id ?? coin?.chainId ?? 0);
  const tokenAddress = ident(coin.token_address || coin.tokenAddress, chainId);
  const campaignAddress = ident(coin.campaign_address || coin.campaignAddress, chainId);
  const profile = coinMatchProfile(coin);
  const mcap = Math.max(0, toNumber(profile.marketCapUsd));
  return {
    tokenId: tokenAddress || campaignAddress,
    campaignAddress: campaignAddress || "",
    tokenAddress: tokenAddress || null,
    tokenName: String(coin.name || coin.symbol || "Unknown token"),
    symbol: String(coin.symbol || "TBD"),
    score: Math.round(mcap * 100) / 100,
    priceChangePct: 0,
    volumeUsd: Math.max(0, toNumber(profile.volumeUsd)),
    uniqueTraders: 0,
    holderCount: Math.max(0, Math.floor(toNumber(profile.holderCount))),
    holdersDelta: 0,
    marketCapUsd: mcap,
    liquidityUsd: Math.max(0, toNumber(profile.liquidityUsd)),
    launchedAt: profile.launchedAt || null,
    ownerWallet: profile.ownerWallet,
  };
}

function placeholder() {
  return {
    tokenId: "pending-rival",
    campaignAddress: "",
    tokenAddress: null,
    tokenName: "Awaiting rival",
    symbol: "TBD",
    score: 0,
    priceChangePct: 0,
    volumeUsd: 0,
    uniqueTraders: 0,
    holderCount: 0,
    holdersDelta: 0,
    marketCapUsd: 0,
    liquidityUsd: 0,
    launchedAt: null,
    ownerWallet: null,
  };
}

function publicLane(state) {
  if (state === "live") return "live_battles";
  if (state === "finished") return "live_battles";
  return "open_for_battle";
}

function hasMatchSnapshot(participantRow) {
  return Boolean(
    participantRow &&
      Object.prototype.hasOwnProperty.call(participantRow, "liquidityUsd") &&
      Object.prototype.hasOwnProperty.call(participantRow, "launchedAt"),
  );
}

function matchSummaryFromParticipants(participants) {
  if (!Array.isArray(participants) || participants.length < 2) return null;
  const [left, right] = participants;
  if (!left || !right) return null;
  if (String(left.tokenId || "").startsWith("pending-") || String(right.tokenId || "").startsWith("pending-")) return null;
  if (!hasMatchSnapshot(left) || !hasMatchSnapshot(right)) return null;
  return calculateMatchQuality(arenaMatchProfileFromParticipant(left), arenaMatchProfileFromParticipant(right));
}

function mapBattle(row) {
  if (!row) return null;
  const state = String(row.state || "waiting");
  const participants = Array.isArray(row.participants) ? [...row.participants] : [];
  while (participants.length < 2) participants.push(placeholder());
  const match = matchSummaryFromParticipants(participants);
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    state,
    source: String(row.source || "queue"),
    tournamentId: row.tournament_id || null,
    format: "duel",
    stakeNative: toNumber(row.offered_stake_native ?? row.stake_native),
    originalStakeNative: toNumber(row.stake_native),
    offeredStakeNative: toNumber(row.offered_stake_native ?? row.stake_native),
    offerFromToken: row.offer_from_token ? ident(row.offer_from_token, row.chain_id) : ident(row.challenger_token, row.chain_id),
    offerCount: Math.max(0, Number(row.offer_count || 0)),
    durationHours: parseDurationHours(row.offered_duration_hours ?? row.duration_hours, 24),
    originalDurationHours: parseDurationHours(row.duration_hours, 24),
    offeredDurationHours: parseDurationHours(row.offered_duration_hours ?? row.duration_hours, 24),
    nativeSymbol: String(row.native_symbol || nativeSymbolFor(row.chain_id)),
    startedAt: row.started_at || row.created_at || nowIso(),
    endsAt: row.ends_at || null,
    settlementAt: row.settled_at || row.finished_at || null,
    featured: Boolean(row.featured),
    arenaLane: publicLane(state),
    scoreBasis: "mcap_pct_change",
    leaderSide: row.mwl_winner_token
      ? ident(row.mwl_winner_token, row.chain_id) === ident(row.challenger_token, row.chain_id)
        ? "left"
        : "right"
      : null,
    winnerToken: row.money_winner_token || row.winner_token || null,
    moneyWinnerToken: row.money_winner_token || null,
    mwlDraw: row.mwl_draw === true,
    mwlResult: row.mwl_result || null,
    mwlWinnerToken: row.mwl_winner_token || null,
    moneyTieBreak: row.money_tie_break || null,
    settlementVersion: row.settlement_version || null,
    matchQuality: match?.matchScore ?? null,
    matchClassification: match?.classification || null,
    rankedMode: match ? (match.rankedEligible ? "competitive" : "open_war") : null,
    matchComponents: match?.components || null,
    matchReasons: match?.reasons || [],
    updatedAt: row.updated_at || row.created_at || nowIso(),
    participants,
  };
}

function feedFromBattles(battles) {
  const sorted = [...battles].sort(
    (a, b) => Date.parse(b.updatedAt || b.startedAt || 0) - Date.parse(a.updatedAt || a.startedAt || 0),
  );
  return {
    liveBattles: sorted.filter((battle) => battle.state === "live"),
    openForBattleQueue: sorted.filter((battle) => battle.state === "waiting" || battle.state === "challenged" || battle.state === "matched"),
    archivedBattles: sorted
      .filter((battle) => battle.state === "finished" || battle.state === "expired")
      .slice(0, 24)
      .map((battle) => ({ battle, archivedAt: battle.settlementAt || battle.endsAt || battle.startedAt || nowIso() })),
  };
}

const BATTLE_COLUMNS = `id, chain_id, state, source, stake_native, offered_stake_native, offer_from_token, offer_count, duration_hours, offered_duration_hours, native_symbol, challenger_token, defender_token, tournament_id,
        participants, challenger_start_mcap_usd, defender_start_mcap_usd, challenger_end_mcap_usd, defender_end_mcap_usd,
        challenger_pct_change, defender_pct_change, winner_token, money_winner_token, money_tie_break, mwl_result, mwl_draw,
        mwl_winner_token, settlement_version, settled_at, started_at, ends_at, finished_at,
        creator_address, featured, created_at, updated_at`;

async function listBattles() {
  const result = await pool.query(
    `select ${BATTLE_COLUMNS}
       from public.arena_battles
      where state = any($1)
      order by coalesce(updated_at, created_at) desc
      limit 200`,
    [LIST_STATES],
  );
  return result.rows.map(mapBattle).filter(Boolean);
}

async function findBattle(id) {
  const result = await pool.query(`select ${BATTLE_COLUMNS} from public.arena_battles where id = $1 limit 1`, [id]);
  return result.rows[0] || null;
}

async function refreshBattle(id) {
  return mapBattle(await findBattle(id));
}

async function nativeCoin(chainId, identity) {
  const normalized = ident(identity, chainId);
  if (!normalized) return null;
  const result = await pool.query(
    `select ${NATIVE_COIN_SELECT}
       ${NATIVE_COIN_FROM}
      where c.chain_id = $1
        and (lower(c.campaign_address::text) = lower($2) or lower(coalesce(c.token_address::text, '')) = lower($2))
      order by c.created_block desc nulls last
      limit 1`,
    [chainId, normalized],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, origin: "native" };
}

async function importedCoin(chainId, identity) {
  const normalized = ident(identity, chainId);
  if (!normalized) return null;
  const result = await pool.query(
    `select ${IMPORT_COIN_SELECT}
       from public.arena_token_imports
      where chain_id = $1 and lower(token_address) = lower($2)
      limit 1`,
    [chainId, normalized],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    origin: "import",
    campaign_address: null,
    graduated_at_chain: row.status === "passed" ? row.created_at : null,
    is_active: true,
    support_enabled: true,
    market_stage: "EXTERNAL_IMPORT",
    market_cap_bnb: 0,
    liquidity_bnb: 0,
    volume_24h_bnb: 0,
    holders_count: 0,
  };
}

async function coinByIdentity(chainId, identity) {
  return (await nativeCoin(chainId, identity)) || (await importedCoin(chainId, identity));
}

async function activeBattleForToken(chainId, token) {
  const normalized = ident(token, chainId);
  if (!normalized) return null;
  const result = await pool.query(
    `select ${BATTLE_COLUMNS}
       from public.arena_battles
      where chain_id = $1
        and state = any($2)
        and (
          lower(coalesce(challenger_token, '')) = lower($3)
          or lower(coalesce(defender_token, '')) = lower($3)
          or participants::text ilike $4
        )
      order by coalesce(updated_at, created_at) desc
      limit 1`,
    [chainId, ACTIVE_STATES, normalized, `%${normalized}%`],
  );
  return result.rows[0] || null;
}

async function creatorCoins(chainId, creatorAddress, limit) {
  const creator = ident(creatorAddress, chainId) || normalizeWalletFlexible(creatorAddress);
  if (!isWallet(creator)) return [];
  const natives = await pool.query(
    `select ${NATIVE_COIN_SELECT}
       ${NATIVE_COIN_FROM}
      where c.chain_id = $1 and lower(c.creator_address::text) = lower($2) and c.campaign_address is not null
      order by c.created_block desc nulls last
      limit $3`,
    [chainId, creator, limit],
  );
  const imports = await pool.query(
    `select ${IMPORT_COIN_SELECT}
       from public.arena_token_imports
      where chain_id = $1 and lower(owner_wallet) = lower($2)
      order by created_at desc
      limit $3`,
    [chainId, creator, limit],
  );
  return [
    ...natives.rows.map((row) => ({ ...row, origin: "native" })),
    ...imports.rows.map((row) => ({
      ...row,
      origin: "import",
      campaign_address: null,
      graduated_at_chain: row.status === "passed" ? row.created_at : null,
      is_active: true,
      support_enabled: true,
      market_stage: "EXTERNAL_IMPORT",
      market_cap_bnb: 0,
      liquidity_bnb: 0,
      volume_24h_bnb: 0,
      holders_count: 0,
    })),
  ];
}

async function statusFor(coin) {
  const chainId = Number(coin.chain_id);
  const token = ident(coin.token_address || coin.campaign_address, chainId);
  const base = {
    tokenId: token,
    campaignAddress: ident(coin.campaign_address, chainId),
    tokenAddress: ident(coin.token_address, chainId) || null,
    tokenName: String(coin.name || coin.symbol || "Unknown token"),
    symbol: String(coin.symbol || ""),
    origin: coin.origin || "native",
  };
  const battle = await activeBattleForToken(chainId, token);
  if (battle) {
    const waiting = battle.state === "waiting" || battle.state === "challenged";
    return {
      ...base,
      eligibility: false,
      currentState: battle.state,
      battleState: battle.state,
      battleId: battle.id,
      openForBattleState: waiting ? "open" : "matched",
      unavailableReason: waiting ? "already_waiting" : "already_in_battle",
    };
  }
  if (coin.origin === "import" && coin.status !== "passed") {
    return { ...base, eligibility: false, currentState: "unavailable", battleState: null, battleId: null, openForBattleState: "not_open", unavailableReason: "import_not_approved" };
  }
  if (coin.origin !== "import" && !coin.graduated_at_chain) {
    return { ...base, eligibility: false, currentState: "unavailable", battleState: null, battleId: null, openForBattleState: "not_open", unavailableReason: "bonding_not_graduated" };
  }
  if (coin.origin !== "import" && coin.is_active === false) {
    return { ...base, eligibility: false, currentState: "unavailable", battleState: null, battleId: null, openForBattleState: "not_open", unavailableReason: "campaign_inactive" };
  }
  if (coin.origin !== "import" && coin.support_enabled === false) {
    return { ...base, eligibility: false, currentState: "unavailable", battleState: null, battleId: null, openForBattleState: "not_open", unavailableReason: "campaign_unsupported" };
  }
  return { ...base, eligibility: true, currentState: "eligible", battleState: null, battleId: null, openForBattleState: "not_open", unavailableReason: null };
}

async function insertBattle(fields) {
  const id = fields.id || `arena-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  await pool.query(
    `insert into public.arena_battles (
        id, chain_id, state, source, stake_native, offered_stake_native, offer_from_token, offer_count, duration_hours, offered_duration_hours, native_symbol, challenger_token, defender_token, tournament_id,
        participants, challenger_start_mcap_usd, defender_start_mcap_usd, winner_token, started_at, ends_at, finished_at,
        creator_address, featured
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      id,
      fields.chainId,
      fields.state,
      fields.source,
      fields.stakeNative,
      fields.offeredStakeNative ?? fields.stakeNative,
      fields.offerFromToken || fields.challengerToken || null,
      Number(fields.offerCount || 0),
      parseDurationHours(fields.durationHours ?? fields.duration_hours, 24),
      parseDurationHours(fields.offeredDurationHours ?? fields.offered_duration_hours ?? fields.durationHours ?? fields.duration_hours, 24),
      fields.nativeSymbol,
      fields.challengerToken || null,
      fields.defenderToken || null,
      fields.tournamentId || null,
      JSON.stringify(fields.participants || []),
      fields.challengerStartMcap ?? null,
      fields.defenderStartMcap ?? null,
      fields.winnerToken || null,
      fields.startedAt || null,
      fields.endsAt || null,
      fields.finishedAt || null,
      fields.creatorAddress || null,
      Boolean(fields.featured),
    ],
  );
  return refreshBattle(id);
}

async function updateBattle(id, patch) {
  const row = await findBattle(id);
  if (!row) return null;
  const next = { ...row, ...patch };
  await pool.query(
    `update public.arena_battles set
        state = $2, source = $3, stake_native = $4, offered_stake_native = $5, offer_from_token = $6, offer_count = $7,
        duration_hours = $8, offered_duration_hours = $9,
        native_symbol = $10, challenger_token = $11, defender_token = $12,
        participants = $13::jsonb, challenger_start_mcap_usd = $14, defender_start_mcap_usd = $15, winner_token = $16,
        started_at = $17, ends_at = $18, finished_at = $19, featured = $20, updated_at = now()
      where id = $1`,
    [
      id,
      next.state,
      next.source,
      next.stake_native,
      next.offered_stake_native ?? next.stake_native,
      next.offer_from_token || next.challenger_token || null,
      Math.max(0, Number(next.offer_count || 0)),
      parseDurationHours(next.duration_hours ?? next.durationHours, 24),
      parseDurationHours(next.offered_duration_hours ?? next.offeredDurationHours ?? next.duration_hours, 24),
      next.native_symbol,
      next.challenger_token,
      next.defender_token,
      JSON.stringify(next.participants || []),
      next.challenger_start_mcap_usd,
      next.defender_start_mcap_usd,
      next.winner_token,
      next.started_at,
      next.ends_at,
      next.finished_at,
      Boolean(next.featured),
    ],
  );
  return refreshBattle(id);
}

async function waitingCandidates(chainId, excludeId, stakeNative, durationHours) {
  const result = await pool.query(
    `select ${BATTLE_COLUMNS}
       from public.arena_battles
      where chain_id = $1 and state = 'waiting' and id <> $2
      order by created_at asc
      limit 50`,
    [chainId, excludeId],
  );
  const hours = parseDurationHours(durationHours, 24);
  return result.rows.filter((row) => stakeCompatible(stakeNative, row.stake_native) && parseDurationHours(row.offered_duration_hours ?? row.duration_hours, 24) === hours);
}

function coinMcap(coin) {
  return Math.max(0, toNumber(coinMatchProfile(coin).marketCapUsd));
}

async function beginFight(id, patch, chainId) {
  const hours = parseDurationHours(patch.duration_hours ?? patch.offered_duration_hours, LIVE_HOURS);
  let updated;
  if (isSolanaWarzoneChainId(chainId)) {
    const onchain = await readOnchainPool(chainId, id);
    const transition = solanaLiveTransition({
      arenaLive: onchain.live === true,
      bothPaid: onchain.bothPaid === true,
    });
    updated = await updateBattle(id, {
      ...patch,
      duration_hours: hours,
      offered_duration_hours: hours,
      state: transition.state,
      started_at: transition.startFightClock ? nowIso() : null,
      ends_at: transition.startFightClock
        ? plusHours(hours)
        : transition.startDepositWindow
          ? plusHours(DEPOSIT_WINDOW_HOURS)
          : null,
    });
  } else {
    const requireEscrow = escrowRequired(chainId);
    updated = await updateBattle(id, {
      ...patch,
      duration_hours: hours,
      offered_duration_hours: hours,
      state: requireEscrow ? "matched" : "live",
      started_at: requireEscrow ? null : nowIso(),
      ends_at: requireEscrow ? plusHours(DEPOSIT_WINDOW_HOURS) : plusHours(hours),
    });
  }
  if (updated?.state === "live") {
    try {
      await captureLiveBaselines(await findBattle(id));
    } catch (error) {
      console.warn("[api/arenaBattles] baseline capture failed", error?.message || error);
    }
  }
  return updated;
}

async function goLiveFromMatched(row) {
  const chainId = Number(row.chain_id);
  if (isSolanaWarzoneChainId(chainId)) {
    const onchain = await readOnchainPool(chainId, row.id);
    if (!solanaMayGoLive(onchain)) return mapBattle(row);
  }
  const leftNow = await currentMcap(chainId, row.challenger_token);
  const rightNow = await currentMcap(chainId, row.defender_token);
  const hours = parseDurationHours(row.duration_hours ?? row.offered_duration_hours, LIVE_HOURS);
  const updated = await updateBattle(row.id, {
    state: "live",
    duration_hours: hours,
    started_at: nowIso(),
    ends_at: plusHours(hours),
    challenger_start_mcap_usd: row.challenger_start_mcap_usd ?? leftNow,
    defender_start_mcap_usd: row.defender_start_mcap_usd ?? rightNow,
  });
  try {
    await captureLiveBaselines(await findBattle(row.id));
  } catch (error) {
    console.warn("[api/arenaBattles] baseline capture failed", error?.message || error);
  }
  return updated;
}

export async function promoteMatchedIfFunded(row) {
  if (!row || row.state !== "matched") return mapBattle(row);
  const onchain = await readOnchainPool(row.chain_id, row.id);
  if (isSolanaWarzoneChainId(row.chain_id)) {
    const transition = solanaLiveTransition({
      arenaLive: onchain.live === true,
      bothPaid: onchain.bothPaid === true,
    });
    const lifecycle = solanaMatchedLifecyclePatch(transition, row, {
      nowMs: Date.now(),
      depositEndsAt: plusHours(DEPOSIT_WINDOW_HOURS),
    });
    if (lifecycle.action === "go-live") return goLiveFromMatched(row);
    if (lifecycle.patch) return updateBattle(row.id, lifecycle.patch);
    return mapBattle(row);
  }
  if (onchain.bothPaid) return goLiveFromMatched(row);
  const deadline = row.ends_at ? Date.parse(row.ends_at) : 0;
  const depositDeadline = Number(onchain.depositDeadline || 0) * 1000;
  const timedOut = (deadline && deadline < Date.now()) || (depositDeadline && depositDeadline < Date.now());
  if (timedOut && !onchain.bothPaid) {
    return updateBattle(row.id, { state: "expired", finished_at: nowIso() });
  }
  return mapBattle(row);
}

async function activeBattleTokenSet(chainId) {
  const tokens = new Set();
  const result = await pool.query(
    `select challenger_token, defender_token, participants
       from public.arena_battles
      where chain_id = $1 and state = any($2)`,
    [chainId, ACTIVE_STATES],
  );
  for (const row of result.rows) {
    if (row.challenger_token) tokens.add(ident(row.challenger_token, chainId));
    if (row.defender_token) tokens.add(ident(row.defender_token, chainId));
    const participants = Array.isArray(row.participants) ? row.participants : [];
    for (const entry of participants) {
      const tokenId = ident(entry?.tokenId || entry?.tokenAddress || entry?.campaignAddress, chainId);
      if (tokenId) tokens.add(tokenId);
    }
  }
  return tokens;
}

async function eligibleRecommendationCoins(chainId, limit = 120) {
  const nativeLimit = Math.max(limit, 60);
  const nativeRows = await pool.query(
    `select ${NATIVE_COIN_SELECT}
       ${NATIVE_COIN_FROM}
      where c.chain_id = $1
        and c.campaign_address is not null
        and c.graduated_at_chain is not null
        and coalesce(c.is_active, true) = true
        and coalesce(c.support_enabled, true) = true
      order by coalesce(ms.market_cap_bnb, ts.marketcap_bnb, 0) desc, c.created_block desc nulls last
      limit $2`,
    [chainId, nativeLimit],
  );
  const importRows = await pool.query(
    `select ${IMPORT_COIN_SELECT}
       from public.arena_token_imports
      where chain_id = $1 and status = 'passed'
      order by created_at desc
      limit $2`,
    [chainId, nativeLimit],
  );
  const deduped = new Map();
  for (const row of nativeRows.rows) {
    const tokenId = ident(row.token_address || row.campaign_address, chainId);
    if (!tokenId || deduped.has(tokenId)) continue;
    deduped.set(tokenId, { ...row, origin: "native" });
  }
  for (const row of importRows.rows) {
    const tokenId = ident(row.token_address, chainId);
    if (!tokenId || deduped.has(tokenId)) continue;
    deduped.set(tokenId, {
      ...row,
      origin: "import",
      campaign_address: null,
      graduated_at_chain: row.created_at,
      is_active: true,
      support_enabled: true,
      market_stage: "EXTERNAL_IMPORT",
      market_cap_bnb: 0,
      liquidity_bnb: 0,
      volume_24h_bnb: 0,
      holders_count: 0,
    });
  }
  return [...deduped.values()];
}

async function tryAutoMatch(openBattle, openerCoin) {
  const chainId = Number(openBattle.chainId);
  const candidates = await waitingCandidates(chainId, openBattle.id, openBattle.stakeNative, openBattle.durationHours);
  if (!candidates.length) return openBattle;

  const openerProfile = coinMatchProfile(openerCoin);
  const scored = [];
  for (const row of candidates) {
    const rivalCoin = await coinByIdentity(chainId, row.challenger_token);
    const rivalProfile = rivalCoin ? coinMatchProfile(rivalCoin) : arenaMatchProfileFromParticipant(Array.isArray(row.participants) ? row.participants[0] : null);
    if (!rivalProfile.tokenId) continue;
    scored.push({ row, rivalCoin, rivalProfile });
  }
  const best = recommendMatchCandidates(openerProfile, scored, {
    limit: 1,
    getProfile: (entry) => entry.rivalProfile,
  })[0];
  if (!best) return openBattle;

  const rivalRow = best.candidate.row;
  const rival = best.candidate.rivalCoin
    ? participant(best.candidate.rivalCoin)
    : {
        ...(Array.isArray(rivalRow.participants) ? rivalRow.participants[0] : null),
        tokenId: ident(rivalRow.challenger_token, chainId),
      };
  if (!rival?.tokenId) return openBattle;

  const live = await beginFight(openBattle.id, {
    source: "queue",
    defender_token: rivalRow.challenger_token,
    participants: [openBattle.participants[0], rival],
    challenger_start_mcap_usd: coinMcap(openerCoin),
    defender_start_mcap_usd: toNumber(rivalRow.challenger_start_mcap_usd ?? rival.marketCapUsd),
  }, chainId);
  await pool.query(`update public.arena_battles set state = 'expired', finished_at = now(), updated_at = now() where id = $1`, [rivalRow.id]);
  return live;
}

async function currentMcap(chainId, token) {
  const coin = await coinByIdentity(chainId, token);
  return coin ? coinMcap(coin) : 0;
}

async function settleLive(row) {
  if (!canSettleBattle(row)) return mapBattle(row);

  const chainId = Number(row.chain_id);
  const leftNow = await currentMcap(chainId, row.challenger_token);
  const rightNow = await currentMcap(chainId, row.defender_token);
  const preview = decideBattleSettlement({
    leftToken: row.challenger_token,
    rightToken: row.defender_token,
    leftStartMcap: row.challenger_start_mcap_usd,
    rightStartMcap: row.defender_start_mcap_usd,
    leftEndMcap: leftNow,
    rightEndMcap: rightNow,
  });
  if (!preview.ok) return mapBattle(row);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query(
      `select ${BATTLE_COLUMNS}
         from public.arena_battles
        where id = $1 and state = 'live' and ends_at is not null and ends_at <= now()
        for update`,
      [row.id],
    );
    const current = locked.rows[0];
    if (!current) {
      await client.query("commit");
      return mapBattle(await findBattle(row.id));
    }

    const decision = decideBattleSettlement({
      leftToken: current.challenger_token,
      rightToken: current.defender_token,
      leftStartMcap: current.challenger_start_mcap_usd,
      rightStartMcap: current.defender_start_mcap_usd,
      leftEndMcap: leftNow,
      rightEndMcap: rightNow,
    });
    if (!decision.ok) {
      await client.query("commit");
      return mapBattle(current);
    }

    const participants = decorateSettledParticipants(current.participants, decision);
    await recordFinishedBattle({
      ...current,
      mwlDraw: decision.mwlDraw,
      mwlWinnerToken: decision.mwlWinnerToken,
      mwlResult: decision.mwlResult,
      participants,
    }, client);

    const write = battleSettlementPatch(decision, { nowIso: nowIso(), participants });
    const finished = await client.query(
      `update public.arena_battles set
          state = 'finished',
          winner_token = $2,
          money_winner_token = $3,
          money_tie_break = $4,
          mwl_result = $5,
          mwl_draw = $6,
          mwl_winner_token = $7,
          challenger_end_mcap_usd = $8,
          defender_end_mcap_usd = $9,
          challenger_pct_change = $10,
          defender_pct_change = $11,
          settlement_version = $12,
          settled_at = $13::timestamptz,
          finished_at = $13::timestamptz,
          participants = $14::jsonb,
          updated_at = now()
        where id = $1 and state = 'live' and ends_at is not null and ends_at <= now()
        returning ${BATTLE_COLUMNS}`,
      [
        current.id,
        write.patch.winner_token,
        write.patch.money_winner_token,
        write.patch.money_tie_break,
        write.patch.mwl_result,
        write.patch.mwl_draw,
        write.patch.mwl_winner_token,
        write.patch.challenger_end_mcap_usd,
        write.patch.defender_end_mcap_usd,
        write.patch.challenger_pct_change,
        write.patch.defender_pct_change,
        write.patch.settlement_version,
        write.patch.settled_at,
        JSON.stringify(write.patch.participants || []),
      ],
    );
    if (!finished.rows[0]) {
      await client.query("rollback");
      return mapBattle(await findBattle(row.id));
    }
    await client.query("commit");

    try {
      // 4c: this post-commit advance can lag; reconcile finished battles whose money winner exists.
      if (finished.rows[0].tournament_id && decision.moneyWinnerToken) {
        await advanceTournamentFromBattle({
          ...finished.rows[0],
          winner_token: decision.moneyWinnerToken,
          id: finished.rows[0].id,
        });
      }
    } catch (error) {
      console.warn("[api/arenaBattles] tournament advance failed", error?.message || error);
    }
    return mapBattle(finished.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.warn("[api/arenaBattles] settle failed", error?.message || error);
    return mapBattle(row);
  } finally {
    client.release();
  }
}

async function expireChallenge(row) {
  if (!row || row.state !== "challenged") return mapBattle(row);
  const created = Date.parse(row.created_at || 0);
  if (created && Date.now() - created < CHALLENGE_HOURS * 3600 * 1000) return mapBattle(row);
  return updateBattle(row.id, { state: "expired", finished_at: nowIso() });
}

async function hydrateLifecycle(row) {
  if (!row) return null;
  if (row.state === "live") return settleLive(row);
  if (row.state === "challenged") return expireChallenge(row);
  if (row.state === "matched") return promoteMatchedIfFunded(row);
  return mapBattle(row);
}

async function handleList(_req, res) {
  try {
    const rows = await pool.query(
      `select ${BATTLE_COLUMNS} from public.arena_battles where state = any($1) order by coalesce(updated_at, created_at) desc limit 200`,
      [LIST_STATES.concat("expired")],
    );
    const battles = [];
    for (const row of rows.rows) {
      const mapped = await hydrateLifecycle(row);
      if (mapped) battles.push(mapped);
    }
    return json(res, 200, feedFromBattles(battles));
  } catch (error) {
    console.error("[api/arenaBattles] list failed", error);
    return json(res, 200, { ...feedFromBattles([]), warning: "Arena battle data is unavailable." });
  }
}

async function handleCreatorStatus(req, res) {
  const query = getQuery(req);
  const chainId = Number(query.chainId) || 56;
  const creator = String(query.creator || query.creatorAddress || "");
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
  if (!isWallet(creator)) return json(res, 200, { items: [], updatedAt: nowIso() });
  try {
    const rows = await creatorCoins(chainId, creator, limit);
    return json(res, 200, { items: await Promise.all(rows.map(statusFor)), updatedAt: nowIso() });
  } catch (error) {
    console.error("[api/arenaBattles] creator status failed", error);
    return json(res, 200, { items: [], updatedAt: nowIso(), warning: "Creator battle status is unavailable." });
  }
}

async function handleMatches(req, res) {
  const query = getQuery(req);
  const chainId = Number(query.chainId) || 56;
  const identity = String(query.tokenId || query.campaignAddress || query.identity || "");
  const limit = Math.max(1, Math.min(10, Number(query.limit) || 5));
  if (!identity) return json(res, 400, { ok: false, error: "tokenId is required" });

  const coin = await coinByIdentity(chainId, identity);
  if (!coin) return json(res, 404, { ok: false, error: "Coin not found", reason: "coin_not_found" });
  const creatorStatus = await statusFor(coin);
  if (!creatorStatus.eligibility) return json(res, 409, { ok: false, reason: creatorStatus.unavailableReason || "unavailable", status: creatorStatus });

  const activeTokens = await activeBattleTokenSet(chainId);
  activeTokens.delete(creatorStatus.tokenId);
  const candidates = (await eligibleRecommendationCoins(chainId, Math.max(60, limit * 20))).filter((candidate) => {
    const tokenId = ident(candidate.token_address || candidate.campaign_address, chainId);
    return Boolean(tokenId) && tokenId !== creatorStatus.tokenId && !activeTokens.has(tokenId);
  });
  const recommendations = recommendMatchCandidates(coinMatchProfile(coin), candidates, {
    limit,
    getProfile: (candidate) => coinMatchProfile(candidate),
  });

  return json(res, 200, {
    tokenId: creatorStatus.tokenId,
    candidates: recommendations.map((entry) => ({
      token: participant(entry.candidate),
      matchQuality: entry.matchScore,
      classification: entry.classification,
      components: entry.components,
      ranked: entry.rankedEligible,
    })),
    updatedAt: nowIso(),
  });
}

async function handleOpen(req, res) {
  const body = await readJson(req);
  const chainId = Number(body?.chainId) || 56;
  const identity = String(body?.tokenId || body?.campaignAddress || body?.identity || "");
  const stakeNative = parseStake(body?.stakeNative ?? body?.initialPotBnb);
  const durationHours = parseDurationHours(body?.durationHours ?? body?.duration_hours, 24);
  if (!identity) return json(res, 400, { ok: false, error: "tokenId is required" });
  if (stakeNative == null) return json(res, 400, { ok: false, error: "stakeNative must be a positive number" });

  const coin = await coinByIdentity(chainId, identity);
  if (!coin) return json(res, 404, { ok: false, error: "Coin not found", reason: "coin_not_found" });
  const creatorStatus = await statusFor(coin);
  if (!creatorStatus.eligibility) return json(res, 409, { ok: false, reason: creatorStatus.unavailableReason || "unavailable", status: creatorStatus });

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: ident(coin.creator_address, chainId) || coin.creator_address,
    chainId,
    action: "arena_open_battle",
    routeLabel: "arena/battles/open",
    extraLines: [`Token: ${ident(coin.token_address || coin.campaign_address, chainId)}`, `Stake: ${stakeNative}`, `Duration: ${durationHours}`],
  });
  if (!verified) return;

  const opener = participant(coin);
  const opened = await insertBattle({
    chainId,
    state: "waiting",
    source: "queue",
    stakeNative,
    durationHours,
    offeredDurationHours: durationHours,
    nativeSymbol: nativeSymbolFor(chainId),
    challengerToken: opener.tokenId,
    defenderToken: null,
    participants: [opener, placeholder()],
    challengerStartMcap: coinMcap(coin),
    creatorAddress: ident(coin.creator_address, chainId),
    featured: false,
  });
  const matched = await tryAutoMatch(opened, coin);
  return json(res, 200, { ok: true, battle: matched, creatorStatus: await statusFor(coin) });
}

async function handleChallenge(req, res) {
  const body = await readJson(req);
  const chainId = Number(body?.chainId) || 56;
  const tokenId = String(body?.tokenId || "");
  const targetTokenId = String(body?.targetTokenId || body?.defenderTokenId || "");
  const stakeNative = parseStake(body?.stakeNative ?? body?.initialPotBnb);
  const durationHours = parseDurationHours(body?.durationHours ?? body?.duration_hours, 24);
  if (!tokenId || !targetTokenId) return json(res, 400, { ok: false, error: "tokenId and targetTokenId are required" });
  if (ident(tokenId, chainId) === ident(targetTokenId, chainId)) {
    return json(res, 400, { ok: false, error: "Cannot challenge the same coin" });
  }
  if (stakeNative == null) return json(res, 400, { ok: false, error: "stakeNative must be a positive number" });

  const challenger = await coinByIdentity(chainId, tokenId);
  const defender = await coinByIdentity(chainId, targetTokenId);
  if (!challenger || !defender) return json(res, 404, { ok: false, error: "Coin not found" });
  const challengerStatus = await statusFor(challenger);
  const defenderStatus = await statusFor(defender);
  if (!challengerStatus.eligibility) return json(res, 409, { ok: false, reason: challengerStatus.unavailableReason, status: challengerStatus });
  if (!defenderStatus.eligibility) return json(res, 409, { ok: false, reason: defenderStatus.unavailableReason || "target_unavailable", status: defenderStatus });

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: ident(challenger.creator_address, chainId) || challenger.creator_address,
    chainId,
    action: "arena_challenge_battle",
    routeLabel: "arena/battles/challenge",
    extraLines: [`Challenger: ${challengerStatus.tokenId}`, `Defender: ${defenderStatus.tokenId}`, `Stake: ${stakeNative}`, `Duration: ${durationHours}`],
  });
  if (!verified) return;

  const battle = await insertBattle({
    chainId,
    state: "challenged",
    source: "challenge",
    stakeNative,
    offeredStakeNative: stakeNative,
    offerFromToken: challengerStatus.tokenId,
    offerCount: 0,
    durationHours,
    offeredDurationHours: durationHours,
    nativeSymbol: nativeSymbolFor(chainId),
    challengerToken: challengerStatus.tokenId,
    defenderToken: defenderStatus.tokenId,
    participants: [participant(challenger), participant(defender)],
    challengerStartMcap: coinMcap(challenger),
    defenderStartMcap: coinMcap(defender),
    creatorAddress: ident(challenger.creator_address, chainId),
    endsAt: plusHours(CHALLENGE_HOURS),
  });
  const mailed = await notifyChallenge({
    defenderWallet: ident(defender.creator_address, chainId) || defender.creator_address,
    challengerSymbol: challengerStatus.symbol || challenger.name,
    defenderSymbol: defenderStatus.symbol || defender.name,
    battleId: battle?.id,
  });
  return json(res, 200, {
    ok: true,
    battle,
    notified: Boolean(mailed?.ok && !mailed?.skipped),
    notifySkipped: Boolean(mailed?.skipped),
    notifyReason: mailed?.reason || null,
  });
}

function offerFromToken(row) {
  return ident(row.offer_from_token || row.challenger_token, row.chain_id);
}

function responderToken(row) {
  const from = offerFromToken(row);
  const challengerTok = ident(row.challenger_token, row.chain_id);
  const defenderTok = ident(row.defender_token, row.chain_id);
  return from === challengerTok ? defenderTok : challengerTok;
}

async function handleAccept(req, res, battleId) {
  const body = await readJson(req);
  const row = await findBattle(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  const mapped = await hydrateLifecycle(row);
  if (!mapped || mapped.state !== "challenged") {
    return json(res, 409, { ok: false, error: "Battle is not an open challenge", currentState: mapped?.state || row.state });
  }
  const responder = await coinByIdentity(row.chain_id, responderToken(row));
  if (!responder) return json(res, 404, { ok: false, error: "Responding coin not found" });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: ident(responder.creator_address, row.chain_id) || responder.creator_address,
    chainId: Number(row.chain_id),
    action: "arena_accept_battle",
    routeLabel: "arena/battles/accept",
    extraLines: [`Battle: ${battleId}`],
  });
  if (!verified) return;

  const challengerCoin = await coinByIdentity(row.chain_id, row.challenger_token);
  const defenderCoin = await coinByIdentity(row.chain_id, row.defender_token);
  const agreedStake = toNumber(row.offered_stake_native ?? row.stake_native);
  const agreedDuration = parseDurationHours(row.offered_duration_hours ?? row.duration_hours, 24);
  const live = await beginFight(battleId, {
    stake_native: agreedStake,
    offered_stake_native: agreedStake,
    duration_hours: agreedDuration,
    offered_duration_hours: agreedDuration,
    challenger_start_mcap_usd: row.challenger_start_mcap_usd ?? (challengerCoin ? coinMcap(challengerCoin) : 0),
    defender_start_mcap_usd: row.defender_start_mcap_usd ?? (defenderCoin ? coinMcap(defenderCoin) : 0),
  }, Number(row.chain_id));
  return json(res, 200, { ok: true, battle: live, escrowRequired: live?.state === "matched" });
}

async function handleDecline(req, res, battleId) {
  const body = await readJson(req);
  const row = await findBattle(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  if (row.state !== "challenged") return json(res, 409, { ok: false, error: "Battle is not an open challenge", currentState: row.state });
  const responder = await coinByIdentity(row.chain_id, responderToken(row));
  if (!responder) return json(res, 404, { ok: false, error: "Responding coin not found" });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: ident(responder.creator_address, row.chain_id) || responder.creator_address,
    chainId: Number(row.chain_id),
    action: "arena_decline_battle",
    routeLabel: "arena/battles/decline",
    extraLines: [`Battle: ${battleId}`],
  });
  if (!verified) return;
  const expired = await updateBattle(battleId, { state: "expired", finished_at: nowIso() });
  return json(res, 200, { ok: true, battle: expired });
}

async function handleCounter(req, res, battleId) {
  const body = await readJson(req);
  const row = await findBattle(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  if (row.state !== "challenged" || row.source !== "challenge") {
    return json(res, 409, { ok: false, error: "Only open challenges can take a counter-offer" });
  }
  if (Number(row.offer_count || 0) >= MAX_COUNTERS) {
    return json(res, 409, { ok: false, error: "Counter-offer limit reached. Accept or decline." });
  }
  const stakeNative = parseStake(body?.stakeNative ?? body?.offeredStakeNative);
  if (stakeNative == null) return json(res, 400, { ok: false, error: "stakeNative must be a positive number" });
  const durationHours = parseDurationHours(body?.durationHours ?? body?.duration_hours, row.offered_duration_hours ?? row.duration_hours);
  const currentOffer = toNumber(row.offered_stake_native ?? row.stake_native);
  const currentDuration = parseDurationHours(row.offered_duration_hours ?? row.duration_hours, 24);
  if (stakeNative === currentOffer && durationHours === currentDuration) {
    return json(res, 400, { ok: false, error: "Counter-offer must change the stake or the fight length." });
  }
  const responder = await coinByIdentity(row.chain_id, responderToken(row));
  const offerer = await coinByIdentity(row.chain_id, offerFromToken(row));
  if (!responder || !offerer) return json(res, 404, { ok: false, error: "Challenge coins not found" });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: ident(responder.creator_address, row.chain_id) || responder.creator_address,
    chainId: Number(row.chain_id),
    action: "arena_counter_battle",
    routeLabel: "arena/battles/counter",
    extraLines: [`Battle: ${battleId}`, `Stake: ${stakeNative}`, `Duration: ${durationHours}`],
  });
  if (!verified) return;

  const responderPart = participant(responder);
  const updated = await updateBattle(battleId, {
    offered_stake_native: stakeNative,
    offered_duration_hours: durationHours,
    offer_from_token: responderPart.tokenId,
    offer_count: Number(row.offer_count || 0) + 1,
    ends_at: plusHours(CHALLENGE_HOURS),
  });
  const mailed = await notifyCounterOffer({
    toWallet: ident(offerer.creator_address, row.chain_id) || offerer.creator_address,
    fromSymbol: responderPart.symbol,
    toSymbol: offerer.symbol || offerer.name,
    amount: stakeNative,
    nativeSymbol: nativeSymbolFor(row.chain_id),
    previousAmount: currentOffer,
    durationHours,
    previousDurationHours: currentDuration,
    battleId,
  });
  return json(res, 200, {
    ok: true,
    battle: updated,
    notified: Boolean(mailed?.ok && !mailed?.skipped),
    notifySkipped: Boolean(mailed?.skipped),
    notifyReason: mailed?.reason || null,
  });
}

async function handleTransition(req, res, battleId) {
  const row = await findBattle(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  const body = await readJson(req);
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/battles/transition", allowOps: true });
  if (!admin) return;
  if (admin.mode === "legacy-open" && isAuthEnforceArenaMutations()) {
    return json(res, 401, { ok: false, error: "Admin or ops auth required for battle transitions.", code: "ARENA_OPS_REQUIRED" });
  }
  const nextState = String(body?.state || "");
  if (!(ADMIN_TRANSITIONS[row.state] || []).includes(nextState)) {
    return json(res, 409, { ok: false, error: "Invalid battle transition", currentState: row.state });
  }
  const patch = { state: nextState };
  if (nextState === "live") {
    if (isSolanaWarzoneChainId(row.chain_id)) {
      const onchain = await readOnchainPool(row.chain_id, row.id);
      if (!solanaLiveTransition({ arenaLive: onchain.live === true, bothPaid: onchain.bothPaid === true }).startFightClock) {
        return json(res, 409, {
          ok: false,
          error: "Solana fights go live only when canonical Arena is live and both on-chain stakes are paid.",
          code: "SOLANA_BATTLE_NOT_FUNDED",
          arenaLive: onchain.live === true,
          bothPaid: Boolean(onchain.bothPaid),
        });
      }
    }
    patch.started_at = nowIso();
    patch.ends_at = plusHours(parseDurationHours(row.duration_hours ?? row.offered_duration_hours, LIVE_HOURS));
  }
  if (nextState === "finished" || nextState === "expired") patch.finished_at = nowIso();
  if (nextState === "finished") {
    const settled = await settleLive({ ...row, ends_at: nowIso() });
    return json(res, 200, { ok: true, battle: settled });
  }
  const updated = await updateBattle(battleId, patch);
  if (nextState === "live") {
    try {
      await captureLiveBaselines(await findBattle(battleId));
    } catch (error) {
      console.warn("[api/arenaBattles] baseline capture failed", error?.message || error);
    }
  }
  return json(res, 200, { ok: true, battle: updated });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);

  try {
    if (method === "GET" && path === "/arena/battles") return handleList(req, res);
    if (method === "GET" && path === "/arena/battles/creator-status") return handleCreatorStatus(req, res);
    if (method === "GET" && path === "/arena/battles/matches") return handleMatches(req, res);
    if (method === "POST" && path === "/arena/battles/open") return handleOpen(req, res);
    if (method === "POST" && path === "/arena/battles/challenge") return handleChallenge(req, res);

    const accept = path.match(/^\/arena\/battles\/([^/]+)\/accept$/);
    if (accept) return method === "POST" ? handleAccept(req, res, decodeURIComponent(accept[1])) : badMethod(res);
    const decline = path.match(/^\/arena\/battles\/([^/]+)\/decline$/);
    if (decline) return method === "POST" ? handleDecline(req, res, decodeURIComponent(decline[1])) : badMethod(res);
    const counter = path.match(/^\/arena\/battles\/([^/]+)\/counter$/);
    if (counter) return method === "POST" ? handleCounter(req, res, decodeURIComponent(counter[1])) : badMethod(res);
    const transition = path.match(/^\/arena\/battles\/([^/]+)\/transition$/);
    if (transition) return method === "POST" ? handleTransition(req, res, decodeURIComponent(transition[1])) : badMethod(res);

    const detail = path.match(/^\/arena\/battles\/([^/]+)$/);
    if (detail) {
      if (method !== "GET") return badMethod(res);
      const row = await findBattle(decodeURIComponent(detail[1]));
      const battle = await hydrateLifecycle(row);
      return battle ? json(res, 200, { battle }) : json(res, 404, { error: "Battle not found" });
    }
    return json(res, 404, { error: `Unknown arena battles route: ${path}` });
  } catch (error) {
    console.error("[api/arenaBattles] request failed", error);
    return json(res, 503, { ok: false, error: "Arena battles storage is unavailable", detail: String(error?.message || error || "unknown error") });
  }
}
