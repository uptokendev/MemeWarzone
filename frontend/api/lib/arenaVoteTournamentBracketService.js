import { randomBytes } from "crypto";

import { captureLiveBaselines } from "./arenaBattleMetrics.js";
import { getArenaMarketSnapshot } from "./arenaMarketSnapshot.js";

function ident(value) {
  return String(value || "").trim();
}

function isEvm(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(ident(value));
}

export function voteTokensEqual(left, right) {
  const a = ident(left);
  const b = ident(right);
  if (!a || !b) return false;
  return isEvm(a) && isEvm(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseBracket(bracket) {
  let value = bracket;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.rounds)) return null;
  return JSON.parse(JSON.stringify(value));
}

function findMatch(rounds, battleId) {
  const id = ident(battleId);
  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const matches = Array.isArray(rounds[roundIndex]?.matches) ? rounds[roundIndex].matches : [];
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      if (ident(matches[matchIndex]?.battleId || matches[matchIndex]?.battle_id) === id) {
        return { roundIndex, matchIndex, match: matches[matchIndex] };
      }
    }
  }
  return null;
}

function validatedRoundWinners(matches) {
  const winners = [];
  for (const match of Array.isArray(matches) ? matches : []) {
    const winner = ident(match?.winner);
    if (!winner) return { complete: false, winners: [] };
    const a = ident(match?.tokenA || match?.token_a);
    const b = ident(match?.tokenB || match?.token_b);
    if (!voteTokensEqual(winner, a) && !(b && voteTokensEqual(winner, b))) {
      throw new Error("vote-tournament-round-winner-not-in-match");
    }
    winners.push(winner);
  }
  return { complete: winners.length > 0, winners };
}

async function loadTokenMetadata(client, chainId, tokenAddress) {
  const token = ident(tokenAddress);
  const native = await client.query(
    `select name, symbol, token_address, campaign_address, creator_address, created_at, graduated_at_chain
       from public.campaigns
      where chain_id = $1
        and (lower(coalesce(token_address::text, '')) = lower($2) or lower(coalesce(campaign_address::text, '')) = lower($2))
      limit 1`,
    [chainId, token],
  );
  if (native.rows[0]) return { ...native.rows[0], owner_wallet: native.rows[0].creator_address };

  const imported = await client.query(
    `select name, symbol, token_address, owner_wallet, created_at
       from public.arena_token_imports
      where chain_id = $1 and lower(token_address) = lower($2)
      limit 1`,
    [chainId, token],
  );
  return imported.rows[0] || { token_address: token, name: token.slice(0, 8), symbol: "TBD" };
}

async function voteParticipantSnapshot(client, chainId, tokenAddress) {
  const metadata = await loadTokenMetadata(client, chainId, tokenAddress);
  const market = await getArenaMarketSnapshot(chainId, tokenAddress, {
    query: (text, params) => client.query(text, params),
  });
  const token = ident(metadata.token_address || metadata.campaign_address || tokenAddress);
  return {
    tokenId: token,
    tokenAddress: token,
    campaignAddress: ident(metadata.campaign_address),
    tokenName: String(metadata.name || metadata.symbol || token.slice(0, 8) || "Unknown"),
    symbol: String(metadata.symbol || "TBD"),
    ownerWallet: ident(metadata.creator_address || metadata.owner_wallet),
    marketCapUsd: market?.marketCapUsd ?? null,
    holderCount: market?.holders ?? null,
    liquidityUsd: market?.liquidityUsd ?? null,
    volumeUsd: market?.volume24hUsd ?? null,
    marketDataUpdatedAt: market?.updatedAt || null,
    marketDataHealthy: market?.healthy === true,
    healthy: market?.healthy === true,
    updatedAt: market?.updatedAt || null,
    dataSource: market?.dataSource || "none",
    dataLagSeconds: market?.dataLagSeconds ?? null,
    reasons: market?.reasons || (market?.reason ? [market.reason] : []),
    launchedAt: metadata.graduated_at_chain || metadata.created_at || null,
  };
}

async function insertVoteTournamentBattle(client, tournament, left, right) {
  const chainId = Number(tournament.chain_id);
  const id = `arena-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const leftSnap = await voteParticipantSnapshot(client, chainId, left);
  const rightSnap = await voteParticipantSnapshot(client, chainId, right);
  const clock = await client.query(`select now() as now`);
  const startedAt = clock.rows[0]?.now || new Date();
  const participants = [
    { ...leftSnap, score: 0, priceChangePct: 0, uniqueTraders: 0, holdersDelta: 0 },
    { ...rightSnap, score: 0, priceChangePct: 0, uniqueTraders: 0, holdersDelta: 0 },
  ];

  await client.query(
    `insert into public.arena_battles (
       id, chain_id, state, source, stake_native, native_symbol, challenger_token, defender_token, tournament_id,
       participants, challenger_start_mcap_usd, defender_start_mcap_usd, started_at, ends_at, creator_address
     ) values ($1,$2,'live','tournament',0,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::timestamptz,$10::timestamptz + interval '24 hours',$11)`,
    [
      id,
      chainId,
      String(tournament.native_symbol || ""),
      leftSnap.tokenAddress,
      rightSnap.tokenAddress,
      tournament.id,
      JSON.stringify(participants),
      leftSnap.marketCapUsd,
      rightSnap.marketCapUsd,
      startedAt,
      leftSnap.ownerWallet || null,
    ],
  );

  await captureLiveBaselines(
    {
      id,
      chain_id: chainId,
      state: "live",
      challenger_token: leftSnap.tokenAddress,
      defender_token: rightSnap.tokenAddress,
      started_at: startedAt,
    },
    {
      query: (text, params) => client.query(text, params),
      snapshots: { left: leftSnap, right: rightSnap },
    },
  );
  return id;
}

function assertVoteTournamentGeneration(tournament) {
  if (!tournament) throw new Error("vote-tournament-not-found");
  if (tournament.status !== "live") throw new Error("vote-tournament-not-live");
  if (tournament.battle_mode !== "vote") throw new Error("vote-tournament-mode-required");
  if (tournament.contest_scoring_version !== "vote_tournament_v1") throw new Error("vote-tournament-scoring-version-required");
  if (tournament.competition_generation !== "arena_competition_v2") throw new Error("vote-tournament-v2-generation-required");
  if (Number(tournament.round_duration_hours) !== 24) throw new Error("vote-tournament-24h-round-required");
}

export async function advanceVoteTournamentBracket({ client, tournamentId, battleId, winnerToken }) {
  if (!client || typeof client.query !== "function") throw new Error("vote-tournament-db-client-required");
  const tournamentIdent = ident(tournamentId);
  const battleIdent = ident(battleId);
  const winner = ident(winnerToken);
  if (!tournamentIdent || !battleIdent || !winner) throw new Error("vote-tournament-advance-input-required");

  const locked = await client.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours, contest_scoring_version,
            competition_generation, native_symbol, winner_token
       from public.arena_tournaments
      where id = $1
      for update`,
    [tournamentIdent],
  );
  const tournament = locked.rows[0];
  assertVoteTournamentGeneration(tournament);

  const bracket = parseBracket(tournament.bracket);
  if (!bracket) throw new Error("vote-tournament-invalid-bracket");
  const location = findMatch(bracket.rounds, battleIdent);
  if (!location) throw new Error("vote-tournament-battle-not-in-bracket");
  const tokenA = ident(location.match.tokenA || location.match.token_a);
  const tokenB = ident(location.match.tokenB || location.match.token_b);
  if (!voteTokensEqual(winner, tokenA) && !voteTokensEqual(winner, tokenB)) {
    throw new Error("vote-tournament-winner-not-in-match");
  }

  const recordedWinner = ident(location.match.winner);
  if (recordedWinner && !voteTokensEqual(recordedWinner, winner)) {
    throw new Error("vote-tournament-winner-mismatch");
  }
  if (!recordedWinner) location.match.winner = winner;

  if (location.roundIndex < bracket.rounds.length - 1) {
    return { advanced: true, idempotent: true, finished: false, winnerToken: winner, bracket };
  }

  const currentRound = bracket.rounds[location.roundIndex];
  const currentMatches = Array.isArray(currentRound?.matches) ? currentRound.matches : [];
  const round = validatedRoundWinners(currentMatches);
  if (!round.complete) {
    await client.query(
      `update public.arena_tournaments set bracket = $2::jsonb, updated_at = now() where id = $1`,
      [tournamentIdent, JSON.stringify(bracket)],
    );
    return { advanced: true, finished: false, roundComplete: false, winnerToken: winner, bracket };
  }

  if (currentMatches.length === 1) {
    await client.query(
      `update public.arena_tournaments
          set status = 'finished', ends_at = now(), winner_token = $3, bracket = $2::jsonb, updated_at = now()
        where id = $1`,
      [tournamentIdent, JSON.stringify(bracket), round.winners[0]],
    );
    return { advanced: true, finished: true, roundComplete: true, winnerToken: round.winners[0], bracket };
  }

  const nextRoundNumber = Number(currentRound?.round || location.roundIndex + 1) + 1;
  const nextMatches = [];
  for (let index = 0; index < round.winners.length; index += 2) {
    const left = round.winners[index];
    const right = round.winners[index + 1];
    const matchId = `r${nextRoundNumber}-m${nextMatches.length + 1}`;
    if (!right) {
      nextMatches.push({ id: matchId, tokenA: left, tokenB: null, battleId: null, winner: left, bye: true });
      continue;
    }
    const nextBattleId = await insertVoteTournamentBattle(client, tournament, left, right);
    nextMatches.push({ id: matchId, tokenA: left, tokenB: right, battleId: nextBattleId, winner: null, bye: false });
  }
  bracket.rounds.push({ round: nextRoundNumber, matches: nextMatches });

  if (nextMatches.length === 1 && ident(nextMatches[0].winner)) {
    await client.query(
      `update public.arena_tournaments
          set status = 'finished', ends_at = now(), winner_token = $3, bracket = $2::jsonb, updated_at = now()
        where id = $1`,
      [tournamentIdent, JSON.stringify(bracket), nextMatches[0].winner],
    );
    return { advanced: true, finished: true, roundComplete: true, winnerToken: nextMatches[0].winner, bracket };
  }

  await client.query(
    `update public.arena_tournaments set bracket = $2::jsonb, updated_at = now() where id = $1`,
    [tournamentIdent, JSON.stringify(bracket)],
  );
  return {
    advanced: true,
    finished: false,
    roundComplete: true,
    winnerToken: winner,
    nextRoundNumber,
    nextMatches,
    bracket,
  };
}
