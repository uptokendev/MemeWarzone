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
import { notifyChallenge } from "./lib/arenaNotify.js";
import { recordFinishedBattle } from "./lib/arenaLeagueScore.js";
import { advanceTournamentFromBattle } from "./arenaTournaments.js";

const LIVE_HOURS = 12;
const CHALLENGE_HOURS = 24;
const STAKE_BAND = 1.2;
const ACTIVE_STATES = ["waiting", "challenged", "live"];
const LIST_STATES = ["waiting", "challenged", "live", "finished"];

const ADMIN_TRANSITIONS = {
  waiting: ["live", "expired"],
  challenged: ["live", "expired"],
  live: ["finished"],
  finished: [],
  expired: [],
};

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

function nativeSymbolFor(chainId) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "SOL";
  if (id === 4663 || id === 46630) return "RH";
  return "BNB";
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

function stakeCompatible(a, b) {
  const left = toNumber(a);
  const right = toNumber(b);
  if (left <= 0 || right <= 0) return false;
  return Math.max(left, right) / Math.min(left, right) <= STAKE_BAND;
}

function metricsFromCoin(coin) {
  return {
    marketCapUsd: Math.max(0, toNumber(coin.marketcap_usd ?? coin.marketcap_bnb)),
    holderCount: Math.max(0, Math.floor(toNumber(coin.holders_count ?? coin.votes_24h))),
    volumeUsd: Math.max(0, toNumber(coin.vol_24h_usd ?? coin.vol_24h_bnb)),
  };
}

function similarity(a, b) {
  const safeLogRatio = (x, y) => {
    if (!x || !y || x <= 0 || y <= 0) return 3;
    return Math.abs(Math.log(x / y));
  };
  const mcScore = 1 / (1 + safeLogRatio(a.marketCapUsd, b.marketCapUsd) * 0.65);
  const volScore = 1 / (1 + safeLogRatio(a.volumeUsd, b.volumeUsd) * 0.65);
  const hSum = a.holderCount + b.holderCount || 1;
  const hScore = 1 / (1 + (Math.abs(a.holderCount - b.holderCount) / hSum) * 0.9);
  return Math.max(0, Math.min(1, mcScore * 0.42 + volScore * 0.38 + hScore * 0.2));
}

function participant(coin) {
  const tokenAddress = ident(coin.token_address || coin.tokenAddress, coin.chain_id);
  const campaignAddress = ident(coin.campaign_address || coin.campaignAddress, coin.chain_id);
  const mcap = Math.max(0, toNumber(coin.marketcap_usd ?? coin.marketcap_bnb));
  return {
    tokenId: tokenAddress || campaignAddress,
    campaignAddress: campaignAddress || "",
    tokenAddress: tokenAddress || null,
    tokenName: String(coin.name || coin.symbol || "Unknown token"),
    symbol: String(coin.symbol || "TBD"),
    score: Math.round(mcap * 100) / 100,
    priceChangePct: 0,
    volumeUsd: Math.max(0, toNumber(coin.vol_24h_usd ?? coin.vol_24h_bnb)),
    uniqueTraders: 0,
    holderCount: Math.max(0, Math.floor(toNumber(coin.holders_count))),
    holdersDelta: 0,
    marketCapUsd: mcap,
    ownerWallet: ident(coin.creator_address || coin.owner_wallet, coin.chain_id),
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
  };
}

function publicLane(state) {
  if (state === "live") return "live_battles";
  if (state === "finished") return "live_battles";
  return "open_for_battle";
}

function mapBattle(row) {
  if (!row) return null;
  const state = String(row.state || "waiting");
  const participants = Array.isArray(row.participants) ? row.participants : [];
  while (participants.length < 2) participants.push(placeholder());
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    state,
    source: String(row.source || "queue"),
    format: "duel",
    stakeNative: toNumber(row.stake_native),
    nativeSymbol: String(row.native_symbol || nativeSymbolFor(row.chain_id)),
    startedAt: row.started_at || row.created_at || nowIso(),
    endsAt: row.ends_at || null,
    settlementAt: row.finished_at || null,
    featured: Boolean(row.featured),
    arenaLane: publicLane(state),
    scoreBasis: "mcap_pct_change",
    leaderSide: row.winner_token ? "left" : null,
    winnerToken: row.winner_token || null,
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
    openForBattleQueue: sorted.filter((battle) => battle.state === "waiting" || battle.state === "challenged"),
    archivedBattles: sorted
      .filter((battle) => battle.state === "finished" || battle.state === "expired")
      .slice(0, 24)
      .map((battle) => ({ battle, archivedAt: battle.settlementAt || battle.endsAt || battle.startedAt || nowIso() })),
  };
}

const BATTLE_COLUMNS = `id, chain_id, state, source, stake_native, native_symbol, challenger_token, defender_token, tournament_id,
        participants, challenger_start_mcap_usd, defender_start_mcap_usd, winner_token, started_at, ends_at, finished_at,
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
    `select c.chain_id, c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol, c.is_active, c.graduated_at_chain,
            ts.marketcap_bnb, ts.vol_24h_bnb, coalesce(va.votes_24h, 0) as votes_24h
       from public.campaigns c
       left join public.token_stats ts on ts.chain_id = c.chain_id and ts.campaign_address = c.campaign_address
       left join public.vote_aggregates va on va.chain_id = c.chain_id and va.campaign_address = c.campaign_address
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
    `select chain_id, token_address, owner_wallet as creator_address, name, symbol, status, scan_json
       from public.arena_token_imports
      where chain_id = $1 and lower(token_address) = lower($2)
      limit 1`,
    [chainId, normalized],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, origin: "import", campaign_address: null, graduated_at_chain: row.status === "passed" ? 1 : null, is_active: true };
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
    `select c.chain_id, c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol, c.is_active, c.graduated_at_chain,
            ts.marketcap_bnb, ts.vol_24h_bnb, coalesce(va.votes_24h, 0) as votes_24h
       from public.campaigns c
       left join public.token_stats ts on ts.chain_id = c.chain_id and ts.campaign_address = c.campaign_address
       left join public.vote_aggregates va on va.chain_id = c.chain_id and va.campaign_address = c.campaign_address
      where c.chain_id = $1 and lower(c.creator_address::text) = lower($2) and c.campaign_address is not null
      order by c.created_block desc nulls last
      limit $3`,
    [chainId, creator, limit],
  );
  const imports = await pool.query(
    `select chain_id, token_address, owner_wallet as creator_address, name, symbol, status, scan_json
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
      graduated_at_chain: row.status === "passed" ? 1 : null,
      is_active: true,
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
  return { ...base, eligibility: true, currentState: "eligible", battleState: null, battleId: null, openForBattleState: "not_open", unavailableReason: null };
}

async function insertBattle(fields) {
  const id = fields.id || `arena-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  await pool.query(
    `insert into public.arena_battles (
        id, chain_id, state, source, stake_native, native_symbol, challenger_token, defender_token, tournament_id,
        participants, challenger_start_mcap_usd, defender_start_mcap_usd, winner_token, started_at, ends_at, finished_at,
        creator_address, featured
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id,
      fields.chainId,
      fields.state,
      fields.source,
      fields.stakeNative,
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
        state = $2, source = $3, stake_native = $4, native_symbol = $5, challenger_token = $6, defender_token = $7,
        participants = $8::jsonb, challenger_start_mcap_usd = $9, defender_start_mcap_usd = $10, winner_token = $11,
        started_at = $12, ends_at = $13, finished_at = $14, featured = $15, updated_at = now()
      where id = $1`,
    [
      id,
      next.state,
      next.source,
      next.stake_native,
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

async function waitingCandidates(chainId, excludeId, stakeNative) {
  const result = await pool.query(
    `select ${BATTLE_COLUMNS}
       from public.arena_battles
      where chain_id = $1 and state = 'waiting' and id <> $2
      order by created_at asc
      limit 50`,
    [chainId, excludeId],
  );
  return result.rows.filter((row) => stakeCompatible(stakeNative, row.stake_native));
}

function coinMcap(coin) {
  return Math.max(0, toNumber(coin.marketcap_usd ?? coin.marketcap_bnb));
}

async function tryAutoMatch(openBattle, openerCoin) {
  const chainId = Number(openBattle.chainId);
  const candidates = await waitingCandidates(chainId, openBattle.id, openBattle.stakeNative);
  if (!candidates.length) return openBattle;

  const openerMetrics = metricsFromCoin(openerCoin);
  let best = null;
  let bestScore = 0;
  for (const row of candidates) {
    const rivalPart = Array.isArray(row.participants) ? row.participants[0] : null;
    if (!rivalPart) continue;
    const score = similarity(openerMetrics, {
      marketCapUsd: toNumber(rivalPart.marketCapUsd ?? rivalPart.score),
      holderCount: toNumber(rivalPart.holderCount),
      volumeUsd: toNumber(rivalPart.volumeUsd),
    });
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (!best || bestScore < 0.15) return openBattle;

  const rival = participant({
    chain_id: chainId,
    token_address: best.challenger_token,
    campaign_address: best.participants?.[0]?.campaignAddress,
    name: best.participants?.[0]?.tokenName,
    symbol: best.participants?.[0]?.symbol,
    marketcap_bnb: best.participants?.[0]?.marketCapUsd,
    vol_24h_bnb: best.participants?.[0]?.volumeUsd,
    holders_count: best.participants?.[0]?.holderCount,
    creator_address: best.creator_address,
  });
  const live = await updateBattle(openBattle.id, {
    state: "live",
    source: "queue",
    defender_token: best.challenger_token,
    participants: [openBattle.participants[0], rival],
    challenger_start_mcap_usd: coinMcap(openerCoin),
    defender_start_mcap_usd: toNumber(best.challenger_start_mcap_usd ?? rival.marketCapUsd),
    started_at: nowIso(),
    ends_at: plusHours(LIVE_HOURS),
  });
  await pool.query(`update public.arena_battles set state = 'expired', finished_at = now(), updated_at = now() where id = $1`, [best.id]);
  return live;
}

async function currentMcap(chainId, token) {
  const coin = await coinByIdentity(chainId, token);
  return coin ? coinMcap(coin) : 0;
}

function pctChange(start, end) {
  const s = toNumber(start);
  const e = toNumber(end);
  if (s <= 0) return e > 0 ? 1 : 0;
  return (e - s) / s;
}

async function settleLive(row) {
  if (!row || row.state !== "live") return mapBattle(row);
  const ends = row.ends_at ? Date.parse(row.ends_at) : 0;
  if (ends && ends > Date.now()) return mapBattle(row);

  const chainId = Number(row.chain_id);
  const leftToken = row.challenger_token;
  const rightToken = row.defender_token;
  const leftNow = await currentMcap(chainId, leftToken);
  const rightNow = await currentMcap(chainId, rightToken);
  const leftPct = pctChange(row.challenger_start_mcap_usd, leftNow);
  const rightPct = pctChange(row.defender_start_mcap_usd, rightNow);
  let winner = null;
  if (leftPct > rightPct) winner = leftToken;
  else if (rightPct > leftPct) winner = rightToken;

  const participants = Array.isArray(row.participants) ? row.participants.map((part, index) => ({
    ...part,
    priceChangePct: index === 0 ? leftPct * 100 : rightPct * 100,
    isLeading: winner ? ident(part.tokenId || part.tokenAddress, chainId) === ident(winner, chainId) : false,
  })) : [];

  try {
    await recordFinishedBattle({ ...row, winner_token: winner, participants, state: "live" });
  } catch (error) {
    console.warn("[api/arenaBattles] league score failed", error?.message || error);
  }
  try {
    if (row.tournament_id && winner) {
      await advanceTournamentFromBattle({ ...row, winner_token: winner, id: row.id });
    }
  } catch (error) {
    console.warn("[api/arenaBattles] tournament advance failed", error?.message || error);
  }

  return updateBattle(row.id, {
    state: "finished",
    winner_token: winner,
    finished_at: nowIso(),
    participants,
  });
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

async function handleOpen(req, res) {
  const body = await readJson(req);
  const chainId = Number(body?.chainId) || 56;
  const identity = String(body?.tokenId || body?.campaignAddress || body?.identity || "");
  const stakeNative = parseStake(body?.stakeNative ?? body?.initialPotBnb);
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
    extraLines: [`Token: ${ident(coin.token_address || coin.campaign_address, chainId)}`, `Stake: ${stakeNative}`],
  });
  if (!verified) return;

  const opener = participant(coin);
  const opened = await insertBattle({
    chainId,
    state: "waiting",
    source: "queue",
    stakeNative,
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
    extraLines: [`Challenger: ${challengerStatus.tokenId}`, `Defender: ${defenderStatus.tokenId}`, `Stake: ${stakeNative}`],
  });
  if (!verified) return;

  const battle = await insertBattle({
    chainId,
    state: "challenged",
    source: "challenge",
    stakeNative,
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

async function handleAccept(req, res, battleId) {
  const body = await readJson(req);
  const row = await findBattle(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  const mapped = await hydrateLifecycle(row);
  if (!mapped || mapped.state !== "challenged") {
    return json(res, 409, { ok: false, error: "Battle is not an open challenge", currentState: mapped?.state || row.state });
  }
  const defender = await coinByIdentity(row.chain_id, row.defender_token);
  if (!defender) return json(res, 404, { ok: false, error: "Defender coin not found" });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: ident(defender.creator_address, row.chain_id) || defender.creator_address,
    chainId: Number(row.chain_id),
    action: "arena_accept_battle",
    routeLabel: "arena/battles/accept",
    extraLines: [`Battle: ${battleId}`],
  });
  if (!verified) return;

  const challengerCoin = await coinByIdentity(row.chain_id, row.challenger_token);
  const live = await updateBattle(battleId, {
    state: "live",
    started_at: nowIso(),
    ends_at: plusHours(LIVE_HOURS),
    challenger_start_mcap_usd: row.challenger_start_mcap_usd ?? (challengerCoin ? coinMcap(challengerCoin) : 0),
    defender_start_mcap_usd: coinMcap(defender),
  });
  return json(res, 200, { ok: true, battle: live });
}

async function handleDecline(req, res, battleId) {
  const body = await readJson(req);
  const row = await findBattle(battleId);
  if (!row) return json(res, 404, { ok: false, error: "Battle not found" });
  if (row.state !== "challenged") return json(res, 409, { ok: false, error: "Battle is not an open challenge", currentState: row.state });
  const defender = await coinByIdentity(row.chain_id, row.defender_token);
  if (!defender) return json(res, 404, { ok: false, error: "Defender coin not found" });
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: ident(defender.creator_address, row.chain_id) || defender.creator_address,
    chainId: Number(row.chain_id),
    action: "arena_decline_battle",
    routeLabel: "arena/battles/decline",
    extraLines: [`Battle: ${battleId}`],
  });
  if (!verified) return;
  const expired = await updateBattle(battleId, { state: "expired", finished_at: nowIso() });
  return json(res, 200, { ok: true, battle: expired });
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
    patch.started_at = nowIso();
    patch.ends_at = plusHours(LIVE_HOURS);
  }
  if (nextState === "finished" || nextState === "expired") patch.finished_at = nowIso();
  if (nextState === "finished") {
    const settled = await settleLive({ ...row, ends_at: nowIso() });
    return json(res, 200, { ok: true, battle: settled });
  }
  return json(res, 200, { ok: true, battle: await updateBattle(battleId, patch) });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);

  try {
    if (method === "GET" && path === "/arena/battles") return handleList(req, res);
    if (method === "GET" && path === "/arena/battles/creator-status") return handleCreatorStatus(req, res);
    if (method === "POST" && path === "/arena/battles/open") return handleOpen(req, res);
    if (method === "POST" && path === "/arena/battles/challenge") return handleChallenge(req, res);

    const accept = path.match(/^\/arena\/battles\/([^/]+)\/accept$/);
    if (accept) return method === "POST" ? handleAccept(req, res, decodeURIComponent(accept[1])) : badMethod(res);
    const decline = path.match(/^\/arena\/battles\/([^/]+)\/decline$/);
    if (decline) return method === "POST" ? handleDecline(req, res, decodeURIComponent(decline[1])) : badMethod(res);
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
