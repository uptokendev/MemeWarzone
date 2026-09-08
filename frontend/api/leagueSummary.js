import { badMethod, getQuery, json } from '../server/http.js';
import league from './league.js';
import leagueRecruiter from './leagueRecruiter.js';
import { calculatePayoutCurve, getPayoutPolicy, getCapMeta } from './leaguePayoutPolicy.js';
import { resolveBnbUsdPrice } from './lib/bnbUsdPrice.js';
import { resolveSolUsdPrice } from './lib/solUsdPrice.js';

const LEAGUES = [
  { key: 'perfect_run', title: 'Perfect Run' },
  { key: 'fastest_finish', title: 'Fastest Finish' },
  { key: 'biggest_hit', title: 'Biggest Hit' },
  { key: 'top_earner', title: 'Top Earner' },
  { key: 'crowd_favorite', title: 'Crowd Favorite' },
  { key: 'recruiter_league', title: 'Recruiter League' },
];

const HISTORY_WEEKLY_OFFSETS = [1, 2];
const HISTORY_MONTHLY_OFFSETS = [1];
const FINALIZED_WINNER_SOURCE = 'legacy_rankings_inferred';
const FROZEN_WINNER_SOURCE = 'league_epoch_winners';

function normChain(value) {
  const chain = String(value || 'bnb').toLowerCase().trim();
  if (chain === 'solana') return 'solana';
  if (chain === 'robinhood') return 'robinhood';
  return 'bnb';
}

function normPeriod(value) {
  return String(value || 'weekly').toLowerCase() === 'monthly' ? 'monthly' : 'weekly';
}

function normEpochOffset(value, period) {
  const max = period === 'monthly' ? 1 : 2;
  const n = Math.trunc(Number(value || 0));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function pendingEpoch(period, epochOffset) {
  return {
    period,
    epochOffset,
    epochStart: null,
    epochEnd: null,
    rangeEnd: null,
    status: 'pending',
  };
}

function buildSeasonMeta({ chain, chainId, period, epochOffset, epoch }) {
  const epochStart = epoch?.epochStart || epoch?.rangeStart || null;
  const epochEnd = epoch?.epochEnd || epoch?.rangeEnd || null;
  const rangeKey = epochStart && epochEnd ? `${epochStart}_${epochEnd}` : `offset_${epochOffset}`;
  const seasonId = `${chain}-${chainId}-${period}-${rangeKey}`;
  return {
    seasonId,
    epochId: seasonId,
    chain,
    chainId,
    period,
    epochOffset,
    status: epoch?.status || (epochOffset > 0 ? 'finalized' : 'live'),
  };
}

function pendingLeagues(chain) {
  const warning = chain === 'solana'
    ? 'Solana league feed pending. BNB standings and prize pools are not reused for Solana.'
    : chain === 'robinhood'
      ? 'Robinhood league feed pending. BNB and Solana standings are not reused for Robinhood.'
      : 'BNB summary aggregation is not enabled yet. Frontend should use legacy /api/league fallback.';

  return LEAGUES.map((leagueMeta) => ({
    key: leagueMeta.key,
    title: leagueMeta.title,
    status: 'pending',
    entrants: 0,
    rows: [],
    warning,
  }));
}

function emptyTrendMetrics() {
  return {
    basis: 'live_epoch',
    changeVsPreviousEpoch: { entrants: 0, playerPrizePoolUsd: 0 },
    entrantsGrowthPct: 0,
    prizePoolGrowthPct: 0,
  };
}

function emptyHallOfFame() {
  return {
    basis: 'summary_history_scaffold',
    allTimeWinners: [],
    biggestPrizePools: [],
    mostWins: [],
  };
}

function buildPendingSummary({ chain, chainId, period, epochOffset }) {
  const policy = getPayoutPolicy(period);
  const cap = getCapMeta(period, 0, policy);
  const epoch = pendingEpoch(period, epochOffset);
  const prize = {
    basis: chain === 'solana' ? 'solana_pending' : chain === 'robinhood' ? 'robinhood_pending' : 'bnb_summary_pending',
    capReached: cap.capReached,
    charityReserveUsd: cap.charityReserveUsd,
    monthlyPlayerPrizeCapUsd: cap.monthlyPlayerPrizeCapUsd,
    playerPrizePoolUsd: cap.playerPrizePoolUsd,
    generatedUsd: cap.generatedUsd,
    nativeSymbol: chain === 'solana' ? 'SOL' : chain === 'robinhood' ? 'ETH' : 'BNB',
    warning: chain === 'solana'
      ? 'Solana prize feed pending.'
      : chain === 'robinhood'
        ? 'Robinhood prize feed pending. ETH pots remain isolated from BNB.'
        : 'BNB summary endpoint scaffolded; legacy category feeds remain the source of truth.',
  };

  return {
    chain,
    chainId,
    period,
    epoch,
    season: buildSeasonMeta({ chain, chainId, period, epochOffset, epoch }),
    winnerSource: { source: 'pending', finalized: false },
    current: { epoch, winners: [], prize },
    payoutPolicy: policy,
    prize,
    leagues: pendingLeagues(chain),
    currentLeaders: [],
    history: { weekly: [], monthly: [] },
    historyMeta: { weeklyOffsets: HISTORY_WEEKLY_OFFSETS, monthlyOffsets: HISTORY_MONTHLY_OFFSETS },
    trendMetrics: emptyTrendMetrics(),
    hallOfFame: emptyHallOfFame(),
  };
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function isSolanaChainId(chainId) {
  return Number(chainId) === 101 || Number(chainId) === 102;
}

function isRobinhoodChainId(chainId) {
  return Number(chainId) === 4663 || Number(chainId) === 46630;
}

function nativeDecimals(chainId) {
  return isSolanaChainId(chainId) ? 9 : 18;
}

function rawToUsd(raw, nativeUsd, decimals = 18) {
  let whole = 0n;
  try {
    whole = BigInt(String(raw ?? '0'));
  } catch {
    return 0;
  }
  const scale = 10 ** Number(decimals || 18);
  const usd = Number(whole) / scale * nativeUsd;
  return Number.isFinite(usd) ? usd : 0;
}

function pctChange(current, previous) {
  const a = Number(current) || 0;
  const b = Number(previous) || 0;
  if (b <= 0) return null;
  return ((a - b) / b) * 100;
}

function sumEntrants(leagues) {
  return (Array.isArray(leagues) ? leagues : []).reduce((sum, leagueResult) => sum + (Number(leagueResult?.entrants) || 0), 0);
}

let lastNativeUsd = { price: 0, source: 'none', chainId: 0 };

async function ensureNativeUsd(chainId) {
  if (isRobinhoodChainId(chainId)) {
    // Fail closed on USD conversion until a dedicated ETH/USD resolver is wired.
    // Never use BNB/USD as a proxy for Robinhood ETH.
    lastNativeUsd = { price: 0, source: 'robinhood_eth_usd_unconfigured', chainId: Number(chainId) };
    return lastNativeUsd;
  }
  const resolved = isSolanaChainId(chainId) ? await resolveSolUsdPrice() : await resolveBnbUsdPrice();
  lastNativeUsd = { price: resolved.price || 0, source: resolved.source || 'none', chainId: Number(chainId) };
  return lastNativeUsd;
}

function readNativeUsd() {
  return lastNativeUsd.price > 0 ? lastNativeUsd.price : 0;
}

function captureJson() {
  const chunks = [];
  return {
    res: {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      },
    },
    body() {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
  };
}

async function callLegacyLeague(req, { category, chainId, period, epochOffset, limit }) {
  const params = new URLSearchParams({
    category,
    chainId: String(chainId),
    period,
    epochOffset: String(epochOffset),
    limit: String(limit),
  });
  const url = `/api/league?${params.toString()}`;
  const { res, body } = captureJson();
  const proxyReq = { ...req, method: 'GET', url, originalUrl: url, query: undefined };

  if (category === 'recruiter_league') await leagueRecruiter(proxyReq, res);
  else await league(proxyReq, res);

  return { statusCode: res.statusCode || 200, payload: body() || {} };
}

function rankRows(rows, prize, policy, chainId) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const generatedUsd = rawToUsd(
    firstDefined(prize?.availablePotRaw, prize?.potRaw),
    readNativeUsd(),
    nativeDecimals(chainId),
  );
  const curve = calculatePayoutCurve(safeRows.length, generatedUsd, policy);

  return safeRows.map((row, index) => ({
    ...row,
    rank: Number(row?.rank || index + 1),
    estimatedPayoutUsd: curve[index]?.payoutUsd || 0,
    payoutPercentage: curve[index]?.percentage || 0,
  }));
}

function normalizeLeagueResult(meta, result, policy, chainId) {
  const payload = result?.payload || {};
  const rows = rankRows(payload.items || payload.rows || [], payload.prize, policy, chainId);
  const warning = firstDefined(payload.warning, result?.statusCode >= 400 ? payload.error : undefined);

  return {
    key: meta.key,
    title: meta.title,
    status: result?.statusCode >= 400 ? 'error' : warning ? 'warning' : 'ready',
    entrants: rows.length,
    rows,
    prize: payload.prize || null,
    epoch: payload.epoch || null,
    stats: payload.stats || null,
    warning,
  };
}

function summarizePrize(leagues, period, policy, chainId) {
  const nativeUsd = readNativeUsd();
  const priceSource = lastNativeUsd.source || 'none';
  const decimals = nativeDecimals(chainId);
  const solana = isSolanaChainId(chainId);
  const robinhood = isRobinhoodChainId(chainId);
  const nativeSymbol = solana ? 'SOL' : robinhood ? 'ETH' : 'BNB';
  let generatedUsd = 0;
  let totalLeagueFeeRaw = '0';
  const byLeague = {};

  for (const leagueResult of leagues) {
    const prize = leagueResult.prize;
    if (!prize) continue;
    if (prize.totalLeagueFeeRaw && totalLeagueFeeRaw === '0') totalLeagueFeeRaw = String(prize.totalLeagueFeeRaw);
    const raw = firstDefined(prize.availablePotRaw, prize.potRaw, '0');
    const usd = rawToUsd(raw, nativeUsd, decimals);
    generatedUsd += usd;
    byLeague[leagueResult.key] = {
      potRaw: prize.potRaw,
      availablePotRaw: prize.availablePotRaw,
      paidRaw: prize.paidRaw,
      rolloverRaw: prize.rolloverRaw,
      estimatedUsd: usd,
      splitBps: prize.splitBps,
      basis: prize.basis,
    };
  }

  const cap = getCapMeta(period, generatedUsd, policy);
  const basis = solana
    ? 'solana_aggregated_legacy_categories'
    : robinhood
      ? 'robinhood_aggregated_legacy_categories'
      : 'bnb_aggregated_legacy_categories';
  return {
    basis,
    nativeSymbol,
    nativeDecimals: decimals,
    generatedUsd: cap.generatedUsd,
    playerPrizePoolUsd: cap.playerPrizePoolUsd,
    charityReserveUsd: cap.charityReserveUsd,
    monthlyPlayerPrizeCapUsd: cap.monthlyPlayerPrizeCapUsd,
    capApplies: cap.capApplies,
    capReached: cap.capReached,
    bnbUsdPrice: !solana && !robinhood ? nativeUsd || null : null,
    solUsdPrice: solana ? nativeUsd || null : null,
    bnbUsdPriceSource: !solana && !robinhood ? priceSource : undefined,
    nativeUsdPrice: nativeUsd || null,
    nativeUsdPriceSource: priceSource,
    totalLeagueFeeRaw,
    byLeague,
    warning: nativeUsd > 0
      ? undefined
      : solana
        ? 'SOL/USD price unavailable (set SOL_USD_PRICE or allow spot fetch). SOL prize pools still show from curve fees.'
        : robinhood
          ? 'ETH/USD price is not wired for Robinhood leagues yet. ETH prize pools still show from chain-isolated curve fees; BNB/USD is never reused.'
          : 'BNB/USD price unavailable (set BNB_USD_PRICE or allow spot fetch). BNB prize pools still show from curve fees.',
  };
}

function walletFromRow(row) {
  return firstDefined(row?.wallet, row?.walletAddress, row?.wallet_address, row?.buyer_address, row?.creator_address, row?.recipient_address, row?.address, null);
}

function winnerFromRow(row) {
  return {
    rank: Number(row?.rank || 1),
    wallet: walletFromRow(row),
    name: row?.name || row?.displayName || null,
    symbol: row?.symbol || null,
    campaignAddress: row?.campaign_address || row?.campaignAddress || null,
    estimatedPayoutUsd: row?.estimatedPayoutUsd || 0,
    payoutPercentage: row?.payoutPercentage || 0,
    row,
  };
}

function pickCurrentLeaders(leagues) {
  return leagues
    .map((leagueResult) => {
      const leader = Array.isArray(leagueResult.rows) ? leagueResult.rows[0] : null;
      return leader ? { league: leagueResult.key, title: leagueResult.title, ...winnerFromRow(leader) } : null;
    })
    .filter(Boolean);
}

function pickEpoch(leagues, period, epochOffset) {
  for (const leagueResult of leagues) {
    if (leagueResult?.epoch) return leagueResult.epoch;
  }
  return pendingEpoch(period, epochOffset);
}

function prizeSnapshot(prize) {
  return {
    basis: prize?.basis,
    generatedUsd: prize?.generatedUsd || 0,
    playerPrizePoolUsd: prize?.playerPrizePoolUsd || 0,
    charityReserveUsd: prize?.charityReserveUsd || 0,
    monthlyPlayerPrizeCapUsd: prize?.monthlyPlayerPrizeCapUsd || 0,
    capApplies: Boolean(prize?.capApplies),
    capReached: Boolean(prize?.capReached),
    bnbUsdPrice: prize?.bnbUsdPrice || null,
    solUsdPrice: prize?.solUsdPrice || null,
    nativeUsdPrice: prize?.nativeUsdPrice || null,
    nativeSymbol: prize?.nativeSymbol || null,
    totalLeagueFeeRaw: prize?.totalLeagueFeeRaw || '0',
    byLeague: prize?.byLeague || {},
    warning: prize?.warning,
  };
}

function leagueHistorySnapshot(leagueResult) {
  const rows = Array.isArray(leagueResult.rows) ? leagueResult.rows : [];
  return {
    key: leagueResult.key,
    title: leagueResult.title,
    status: leagueResult.status,
    entrants: leagueResult.entrants || rows.length,
    warning: leagueResult.warning,
    prize: leagueResult.prize || null,
    winners: rows.slice(0, Math.min(5, rows.length)).map(winnerFromRow),
  };
}

function buildHistoryEntry(period, epochOffset, summary) {
  const prize = prizeSnapshot(summary.prize);
  const season = buildSeasonMeta({
    chain: summary.chain || 'bnb',
    chainId: summary.chainId || 97,
    period,
    epochOffset,
    epoch: summary.epoch,
  });
  return {
    period,
    epochOffset,
    seasonId: season.seasonId,
    epochId: season.epochId,
    epoch: summary.epoch,
    prize,
    charity: {
      reserveUsd: prize.charityReserveUsd || 0,
      carriedForwardUsd: prize.charityReserveUsd || 0,
      source: prize.capReached ? 'monthly_cap_overflow' : 'none',
    },
    winners: summary.currentLeaders || [],
    leagues: (summary.leagues || []).map(leagueHistorySnapshot),
  };
}

async function buildHistory(req, { chain, chainId, limit }) {
  const historyLimit = Math.max(1, Math.min(5, Number(limit) || 5));
  const weekly = await Promise.all(
    HISTORY_WEEKLY_OFFSETS.map(async (epochOffset) => buildHistoryEntry(
      'weekly',
      epochOffset,
      await aggregateChainSummary(req, { chain, chainId, period: 'weekly', epochOffset, limit: historyLimit, includeHistory: false })
    ))
  );

  const monthly = await Promise.all(
    HISTORY_MONTHLY_OFFSETS.map(async (epochOffset) => buildHistoryEntry(
      'monthly',
      epochOffset,
      await aggregateChainSummary(req, { chain, chainId, period: 'monthly', epochOffset, limit: historyLimit, includeHistory: false })
    ))
  );

  return { weekly, monthly };
}

function calculateTrendMetrics(currentSummary, history, period) {
  const previous = Array.isArray(history?.[period]) ? history[period][0] : null;
  if (!previous) return emptyTrendMetrics();

  const currentEntrants = sumEntrants(currentSummary.leagues);
  const previousEntrants = sumEntrants(previous.leagues);
  const currentPrize = Number(currentSummary?.prize?.playerPrizePoolUsd || currentSummary?.prize?.generatedUsd || 0);
  const previousPrize = Number(previous?.prize?.playerPrizePoolUsd || previous?.prize?.generatedUsd || 0);

  return {
    basis: `${period}_previous_epoch`,
    changeVsPreviousEpoch: {
      entrants: currentEntrants - previousEntrants,
      playerPrizePoolUsd: currentPrize - previousPrize,
    },
    entrantsGrowthPct: pctChange(currentEntrants, previousEntrants),
    prizePoolGrowthPct: pctChange(currentPrize, previousPrize),
  };
}

function buildHallOfFame(history) {
  const allHistory = [
    ...(Array.isArray(history?.weekly) ? history.weekly : []),
    ...(Array.isArray(history?.monthly) ? history.monthly : []),
  ];
  const winnerCounts = new Map();
  const allTimeWinners = [];
  const biggestPrizePools = [];

  for (const entry of allHistory) {
    const poolUsd = Number(entry?.prize?.playerPrizePoolUsd || entry?.prize?.generatedUsd || 0);
    if (poolUsd > 0) {
      biggestPrizePools.push({
        period: entry.period,
        seasonId: entry.seasonId,
        epochId: entry.epochId,
        playerPrizePoolUsd: poolUsd,
        generatedUsd: Number(entry?.prize?.generatedUsd || 0),
        capReached: Boolean(entry?.prize?.capReached),
      });
    }

    for (const winner of Array.isArray(entry?.winners) ? entry.winners : []) {
      const key = firstDefined(winner.wallet, winner.campaignAddress, winner.symbol, winner.name, 'unknown');
      const previous = winnerCounts.get(key) || { key, wallet: winner.wallet || null, name: winner.name || null, symbol: winner.symbol || null, wins: 0, estimatedPayoutUsd: 0 };
      previous.wins += 1;
      previous.estimatedPayoutUsd += Number(winner.estimatedPayoutUsd || 0);
      winnerCounts.set(key, previous);
      allTimeWinners.push({
        period: entry.period,
        seasonId: entry.seasonId,
        epochId: entry.epochId,
        ...winner,
      });
    }
  }

  return {
    basis: 'summary_history_scaffold',
    allTimeWinners: allTimeWinners.slice(0, 25),
    biggestPrizePools: biggestPrizePools.sort((a, b) => b.playerPrizePoolUsd - a.playerPrizePoolUsd).slice(0, 10),
    mostWins: Array.from(winnerCounts.values()).sort((a, b) => b.wins - a.wins || b.estimatedPayoutUsd - a.estimatedPayoutUsd).slice(0, 10),
  };
}

async function aggregateChainSummary(req, { chain, chainId, period, epochOffset, limit, includeHistory = false }) {
  await ensureNativeUsd(chainId);
  const policy = getPayoutPolicy(period);
  const results = await Promise.all(
    LEAGUES.map(async (leagueMeta) => {
      try {
        const result = await callLegacyLeague(req, { category: leagueMeta.key, chainId, period, epochOffset, limit });
        return normalizeLeagueResult(leagueMeta, result, policy, chainId);
      } catch (error) {
        console.error(`[api/league/summary] ${leagueMeta.key} failed`, error);
        return { key: leagueMeta.key, title: leagueMeta.title, status: 'error', entrants: 0, rows: [], warning: 'League aggregation failed.' };
      }
    })
  );

  const epoch = pickEpoch(results, period, epochOffset);
  const season = buildSeasonMeta({ chain, chainId, period, epochOffset, epoch });
  const prize = summarizePrize(results, period, policy, chainId);
  const currentLeaders = pickCurrentLeaders(results);
  const history = includeHistory ? await buildHistory(req, { chain, chainId, limit }) : { weekly: [], monthly: [] };
  const baseSummary = { leagues: results, prize };

  return {
    chain,
    chainId,
    period,
    epoch,
    season,
    seasonId: season.seasonId,
    epochId: season.epochId,
    winnerSource: epochOffset > 0
      ? {
          source: FROZEN_WINNER_SOURCE,
          finalized: Boolean(results.some((league) => league?.rows?.some((row) => row?.finalized))),
          plannedSource: FROZEN_WINNER_SOURCE,
          note: 'Closed epochs persist into league_epoch_winners on first Previous-week load, then Claims reads that table.',
        }
      : {
          source: FINALIZED_WINNER_SOURCE,
          finalized: false,
          plannedSource: FROZEN_WINNER_SOURCE,
          note: 'Live epoch shows estimated standings. Claims stay closed until the epoch is finalized.',
        },
    current: { epoch, winners: currentLeaders, prize },
    payoutPolicy: policy,
    prize,
    leagues: results,
    currentLeaders,
    history,
    historyMeta: { weeklyOffsets: HISTORY_WEEKLY_OFFSETS, monthlyOffsets: HISTORY_MONTHLY_OFFSETS },
    trendMetrics: calculateTrendMetrics(baseSummary, history, period),
    hallOfFame: buildHallOfFame(history),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return badMethod(res);

  const q = getQuery(req);
  const chain = normChain(q.chain);
  const period = normPeriod(q.period);
  const epochOffset = normEpochOffset(q.epochOffset, period);
  const fallbackChainId = chain === 'solana' ? 101 : chain === 'robinhood' ? 46630 : 97;
  const chainId = clampInt(q.chainId ?? fallbackChainId, 1, 999999, fallbackChainId);
  const limit = clampInt(q.limit ?? 10, 1, 50, 10);
  const includeHistory =
    String(q.includeHistory ?? q.history ?? '0').trim() === '1' ||
    String(q.includeHistory ?? '').toLowerCase() === 'true';

  try {
    const payload = await aggregateChainSummary(req, { chain, chainId, period, epochOffset, limit, includeHistory });
    if (chain === 'solana' && payload) {
      payload.prize = {
        ...(payload.prize || {}),
        claimsOpen: false,
        warning:
          payload.prize?.warning ||
          'Solana prize estimate is live from bonding fees. Claims stay closed until the SOL league pot is funded.',
      };
    }
    return json(res, 200, payload);
  } catch (error) {
    console.error('[api/league/summary]', error);
    return json(res, 500, { error: 'Server error' });
  }
}
