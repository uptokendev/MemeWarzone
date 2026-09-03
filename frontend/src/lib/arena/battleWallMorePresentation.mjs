import { tickerFor } from "./arenaMatchRowPresentation.mjs";
import { formatMatchQuality } from "./findMatchPresentation.mjs";
import {
  battleDomId,
  battleWallClassification,
  battleWallType,
  battleWallTypeLabel,
} from "./battleWallPresentation.mjs";

export const BATTLE_MORE_FUNDING_COPY = "The fight begins when required funding is complete.";

export function battleMorePanelId(battleId) {
  return `${battleDomId(battleId)}-more`;
}

export function battleMoreToggle(open) {
  const expanded = open === true;
  return {
    expanded,
    label: expanded ? "LESS ↑" : "MORE ↓",
  };
}

export function formatBattleWallMatchQuality(value) {
  if (value === null || value === undefined || value === "") return null;
  return formatMatchQuality(value);
}

export function compactWalletLabel(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.length <= 14) return text;
  return `${text.slice(0, 6)}…${text.slice(-5)}`;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function formatUsd(value) {
  const amount = finiteNumber(value);
  if (amount === null) return null;
  const safe = Math.max(0, amount);
  if (safe >= 1_000_000_000) return `$${(safe / 1_000_000_000).toFixed(2)}B`;
  if (safe >= 1_000_000) return `$${(safe / 1_000_000).toFixed(2)}M`;
  if (safe >= 1_000) return `$${(safe / 1_000).toFixed(1)}K`;
  return `$${safe.toFixed(0)}`;
}

function formatMoment(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function durationLabel(hours) {
  const total = Math.max(0, Math.trunc(Number(hours) || 0));
  if (total === 168) return "7 days";
  if (total === 72) return "3 days";
  if (total === 24) return "24 hours";
  if (!total) return null;
  if (total % 24 === 0) return `${total / 24} days`;
  return `${total} hours`;
}

function chainLabel(chainId) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "Solana";
  if (id === 4663 || id === 46630) return "Robinhood";
  return "BNB Chain";
}

function originLabel(participant) {
  const origin = String(participant?.origin || "").toLowerCase();
  if (origin === "native" || origin === "mwz") return "MWZ Native";
  if (origin === "imported" || origin === "import") return "Imported";
  if (participant?.campaignAddress) return "MWZ Native";
  return null;
}

function tokenIdentity(participant) {
  return String(participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "").trim();
}

function presentSide(battle, participant, metricsSide, index) {
  const identity = tokenIdentity(participant);
  const ownerWallet = String(participant?.ownerWallet || participant?.creatorWallet || "").trim() || null;
  const liquidityUsd = finiteNumber(metricsSide?.current?.liquidityUsd ?? participant?.liquidityUsd);
  const marketCapUsd = finiteNumber(metricsSide?.current?.marketCapUsd ?? participant?.marketCapUsd ?? participant?.marketCap);
  return {
    side: index === 0 ? "left" : "right",
    ticker: tickerFor(battle, index),
    name: String(participant?.tokenName || "").trim() || null,
    tokenId: identity || null,
    ownerWallet,
    ownerLabel: compactWalletLabel(ownerWallet),
    liquidityUsd,
    liquidityLabel: formatUsd(liquidityUsd),
    marketCapUsd,
    marketCapLabel: formatUsd(marketCapUsd),
    originLabel: originLabel(participant),
  };
}

function originKind(battle) {
  const type = battleWallType(battle);
  if (type === "tournament") return "tournament";
  if (type === "manual") return "challenge";
  return "queue";
}

function originCopy(kind) {
  if (kind === "tournament") return "Tournament";
  if (kind === "challenge") return "Challenge";
  return "Queue";
}

function scoringGeneration(metrics) {
  const persisted = String(metrics?.settlementScoringVersion || "").trim();
  if (persisted) return persisted;
  const live = String(metrics?.scoringVersion || "").trim();
  return live || null;
}

function healthLabel(metrics) {
  if (!metrics?.dataHealth) return null;
  return metrics.dataHealth.healthy === true ? "Battle data healthy" : "DATA DELAY";
}

function realtimeLabel(realtimeState) {
  if (realtimeState === "connected") return "Realtime linked";
  if (realtimeState === "unavailable") return "Realtime unavailable";
  if (realtimeState === "disconnected") return "Realtime reconnecting";
  if (realtimeState === "connecting") return "Realtime connecting";
  return null;
}

function dataSourceLabel(source) {
  if (source === "realtime") return "Realtime snapshot";
  if (source === "feed" || source === "retained") return "REST snapshot";
  return null;
}

export function presentBattleWallMore(battle, metrics, options = {}) {
  const chainId = Number(battle?.chainId ?? battle?.chain_id ?? 0);
  const left = presentSide(battle, battle?.participants?.[0], metrics?.sides?.left, 0);
  const right = presentSide(battle, battle?.participants?.[1], metrics?.sides?.right, 1);
  const type = battleWallType(battle);
  const kind = originKind(battle);
  const classification = battleWallClassification(battle);
  const matchQualityLabel = formatBattleWallMatchQuality(battle?.matchQuality);
  const tournamentId = String(battle?.tournamentId || battle?.tournament_id || "").trim() || null;
  const stakeNative = finiteNumber(battle?.stakeNative ?? battle?.stake_native);
  const nativeSymbol = String(battle?.nativeSymbol || battle?.native_symbol || "").trim() || null;
  const durationHours = finiteNumber(battle?.durationHours ?? battle?.duration_hours);
  const startedAt = battle?.startedAt || battle?.started_at || null;
  const endsAt = battle?.endsAt || battle?.ends_at || null;
  const combinedMcap =
    left.marketCapUsd !== null && right.marketCapUsd !== null ? left.marketCapUsd + right.marketCapUsd : null;

  return {
    battleId: String(battle?.id || "").trim(),
    panelId: battleMorePanelId(battle?.id),
    chainLabel: chainLabel(chainId),
    type,
    typeLabel: battleWallTypeLabel(type),
    originKind: kind,
    originLabel: originCopy(kind),
    classification,
    matchQualityLabel,
    scoringGeneration: scoringGeneration(metrics),
    healthLabel: healthLabel(metrics),
    realtimeLabel: realtimeLabel(options.realtimeState),
    dataSourceLabel: dataSourceLabel(options.dataSource),
    combinedMcapUsd: combinedMcap,
    combinedMcapLabel: formatUsd(combinedMcap),
    left,
    right,
    terms: {
      stakeNative,
      stakeLabel: stakeNative === null ? null : `${stakeNative.toFixed(2)} ${nativeSymbol || "BNB"}`.trim(),
      durationHours,
      durationLabel: durationLabel(durationHours),
      startedAt,
      startedLabel: formatMoment(startedAt) || "Unscheduled",
      endsAt,
      endsLabel: formatMoment(endsAt) || "Unscheduled",
      originLabel: originCopy(kind),
      classification,
      matchQualityLabel,
      fundingCopy: BATTLE_MORE_FUNDING_COPY,
      tournamentId,
      tournamentHref: tournamentId ? `/warzone/tournament/${encodeURIComponent(tournamentId)}` : null,
    },
  };
}
