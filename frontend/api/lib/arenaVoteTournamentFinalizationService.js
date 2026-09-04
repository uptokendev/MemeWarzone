import { beginFinalSalvo, closeFinalSalvoShot } from "./arenaFinalSalvoRuntime.mjs";
import { advanceVoteTournamentBracket } from "./arenaVoteTournamentBracketService.js";
import { resolveTournamentVoteMatch } from "./arenaTournamentVoteRuntime.mjs";

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("invalid-final-salvo-time");
  return date.toISOString();
}

function tiebreakRuntimeShape(row) {
  return {
    state: row.state,
    regulationLeftPoints: asNumber(row.regulation_left_points),
    regulationRightPoints: asNumber(row.regulation_right_points),
    currentSalvoIndex: asNumber(row.current_salvo_index),
    leftSalvoPoints: asNumber(row.left_salvo_points),
    rightSalvoPoints: asNumber(row.right_salvo_points),
    shotStartedAt: row.shot_started_at,
    shotEndsAt: row.shot_ends_at,
    shotHistory: Array.isArray(row.shot_history) ? row.shot_history : [],
    suddenDeathRound: asNumber(row.sudden_death_round),
    winnerSide: row.winner_side || null,
    resolvedAt: row.resolved_at || null,
  };
}

async function acquireBattleLease(client, battleId) {
  const lease = await client.query(
    `select pg_try_advisory_xact_lock(hashtext($1)) as locked`,
    [`arena-vote-finalize:${battleId}`],
  );
  return lease.rows[0]?.locked === true;
}

async function loadLockedVoteBattle(client, battleId) {
  const result = await client.query(
    `select id, chain_id, state, source, tournament_id, battle_mode, ends_at,
            challenger_token, defender_token, participants, winner_token,
            contest_scoring_version, competition_generation
       from public.arena_battles
      where id = $1
      for update`,
    [battleId],
  );
  return result.rows[0] || null;
}

async function loadTournament(client, tournamentId) {
  const result = await client.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours,
            contest_scoring_version, competition_generation, native_symbol
       from public.arena_tournaments
      where id = $1
      limit 1`,
    [tournamentId],
  );
  return result.rows[0] || null;
}

async function regulationPoints(client, battleId, roundNumber) {
  const result = await client.query(
    `select side, coalesce(sum(points), 0)::bigint as points
       from public.arena_contest_actions
      where battle_id = $1
        and round_number = $2
        and phase = 'regulation'
        and confirmed_at is not null
      group by side`,
    [battleId, roundNumber],
  );
  let left = 0;
  let right = 0;
  for (const row of result.rows || []) {
    if (row.side === "left") left = Number(row.points || 0);
    if (row.side === "right") right = Number(row.points || 0);
  }
  return { left, right };
}

async function shotUniqueVotes(client, battleId, roundNumber, phase, salvoIndex) {
  const result = await client.query(
    `select side, count(distinct wallet)::int as unique_votes
       from public.arena_contest_actions
      where battle_id = $1
        and round_number = $2
        and phase = $3
        and salvo_index = $4
        and action_type = 'free_vote'
        and confirmed_at is not null
      group by side`,
    [battleId, roundNumber, phase, salvoIndex],
  );
  let left = 0;
  let right = 0;
  for (const row of result.rows || []) {
    if (row.side === "left") left = Number(row.unique_votes || 0);
    if (row.side === "right") right = Number(row.unique_votes || 0);
  }
  return { left, right };
}

async function finishVoteBattle(client, battle, winnerToken, finishedAt) {
  const result = await client.query(
    `update public.arena_battles
        set state = 'finished',
            winner_token = $2,
            finished_at = coalesce(finished_at, $3::timestamptz),
            contest_scoring_version = 'vote_tournament_v1',
            competition_generation = 'arena_competition_v2'
      where id = $1
      returning *`,
    [battle.id, winnerToken, finishedAt],
  );
  return result.rows[0] || null;
}

async function persistTiebreakState(client, battleId, next, uniqueVotes = { left: 0, right: 0 }) {
  const result = await client.query(
    `update public.arena_vote_tiebreaks
        set state = $2,
            current_salvo_index = $3,
            left_salvo_points = $4,
            right_salvo_points = $5,
            shot_started_at = $6,
            shot_ends_at = $7,
            shot_history = $8::jsonb,
            left_current_unique_votes = $9,
            right_current_unique_votes = $10,
            sudden_death_round = $11,
            winner_side = $12,
            resolved_at = $13
      where battle_id = $1
      returning *`,
    [
      battleId,
      next.state,
      next.currentSalvoIndex,
      next.leftSalvoPoints,
      next.rightSalvoPoints,
      next.shotStartedAt,
      next.shotEndsAt,
      JSON.stringify(next.shotHistory || []),
      uniqueVotes.left,
      uniqueVotes.right,
      next.suddenDeathRound,
      next.winnerSide,
      next.resolvedAt,
    ],
  );
  return result.rows[0] || null;
}

function authoritativeVoteGeneration(row) {
  return (
    row?.battle_mode === "vote" &&
    row?.contest_scoring_version === "vote_tournament_v1" &&
    row?.competition_generation === "arena_competition_v2"
  );
}

export function voteTournamentRuntimeEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.ARENA_VOTE_TOURNAMENT_RUNTIME || ""));
}

export async function finalizeDueVoteTournamentBattle(pool, battleId, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (!(await acquireBattleLease(client, battleId))) {
      await client.query("rollback");
      return { settled: false, reason: "lease-busy" };
    }

    const battle = await loadLockedVoteBattle(client, battleId);
    if (!battle) {
      await client.query("rollback");
      return { settled: false, reason: "battle-not-found" };
    }
    if (battle.state === "finished") {
      await client.query("rollback");
      return { settled: true, idempotent: true, battle };
    }
    if (battle.state !== "live" || battle.source !== "tournament" || !authoritativeVoteGeneration(battle)) {
      await client.query("rollback");
      return { settled: false, reason: "not-live-v2-vote-tournament-battle" };
    }
    const nowIso = asIso(now);
    if (!battle.ends_at || new Date(battle.ends_at).getTime() > new Date(nowIso).getTime()) {
      await client.query("rollback");
      return { settled: false, reason: "regulation-still-live" };
    }

    const existing = await client.query(
      `select * from public.arena_vote_tiebreaks where battle_id = $1 limit 1`,
      [battleId],
    );
    if (existing.rows[0]) {
      await client.query("rollback");
      return { settled: false, reason: "final-salvo-active", tiebreak: existing.rows[0] };
    }

    const tournament = await loadTournament(client, battle.tournament_id);
    if (
      !tournament ||
      tournament.status !== "live" ||
      Number(tournament.round_duration_hours) !== 24 ||
      !authoritativeVoteGeneration(tournament)
    ) {
      await client.query("rollback");
      return { settled: false, reason: "tournament-not-authoritative" };
    }

    const matchup = resolveTournamentVoteMatch({ tournament, matchRef: battleId });
    if (!matchup.ok || matchup.battleId !== battleId) {
      await client.query("rollback");
      return { settled: false, reason: `matchup-${matchup.reason || "unresolved"}` };
    }

    const score = await regulationPoints(client, battleId, matchup.roundNumber);
    if (score.left !== score.right) {
      const winnerSide = score.left > score.right ? "left" : "right";
      const winnerToken = winnerSide === "left" ? matchup.tokenA : matchup.tokenB;
      const finished = await finishVoteBattle(client, battle, winnerToken, nowIso);
      const bracketAdvance = await advanceVoteTournamentBracket({
        client,
        tournamentId: battle.tournament_id,
        battleId,
        winnerToken,
      });
      await client.query("commit");
      return {
        settled: true,
        phase: "regulation",
        winnerSide,
        winnerToken,
        regulation: score,
        bracketAdvance,
        battle: finished,
      };
    }

    const initial = beginFinalSalvo({
      regulationLeftPoints: score.left,
      regulationRightPoints: score.right,
      now,
    });
    if (!initial.ok) throw new Error(`final-salvo-begin-failed:${initial.reason}`);

    const inserted = await client.query(
      `insert into public.arena_vote_tiebreaks (
         battle_id, tournament_id, round_number, state,
         regulation_left_points, regulation_right_points,
         current_salvo_index, left_salvo_points, right_salvo_points,
         shot_started_at, shot_ends_at, shot_history,
         left_current_unique_votes, right_current_unique_votes,
         sudden_death_round, winner_side, resolved_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,0,0,$13,$14,$15)
       on conflict (battle_id) do nothing
       returning *`,
      [
        battleId,
        battle.tournament_id,
        matchup.roundNumber,
        initial.state,
        initial.regulationLeftPoints,
        initial.regulationRightPoints,
        initial.currentSalvoIndex,
        initial.leftSalvoPoints,
        initial.rightSalvoPoints,
        initial.shotStartedAt,
        initial.shotEndsAt,
        JSON.stringify(initial.shotHistory),
        initial.suddenDeathRound,
        initial.winnerSide,
        initial.resolvedAt,
      ],
    );
    const tiebreak = inserted.rows[0] || (await client.query(
      `select * from public.arena_vote_tiebreaks where battle_id = $1 limit 1`,
      [battleId],
    )).rows[0];
    await client.query("commit");
    return {
      settled: false,
      phase: "final-salvo",
      reason: "regulation-tied",
      regulation: score,
      tiebreak,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function advanceDueFinalSalvo(pool, battleId, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (!(await acquireBattleLease(client, battleId))) {
      await client.query("rollback");
      return { advanced: false, reason: "lease-busy" };
    }

    const battle = await loadLockedVoteBattle(client, battleId);
    if (!battle) {
      await client.query("rollback");
      return { advanced: false, reason: "battle-not-found" };
    }
    if (!authoritativeVoteGeneration(battle)) {
      await client.query("rollback");
      return { advanced: false, reason: "not-v2-vote-tournament-battle" };
    }

    const tiebreakResult = await client.query(
      `select * from public.arena_vote_tiebreaks where battle_id = $1 for update`,
      [battleId],
    );
    const row = tiebreakResult.rows[0];
    if (!row) {
      await client.query("rollback");
      return { advanced: false, reason: "tiebreak-not-found" };
    }
    if (row.state === "resolved") {
      await client.query("rollback");
      return { advanced: true, idempotent: true, tiebreak: row, battle };
    }
    if (!["salvo", "sudden_death"].includes(row.state)) {
      await client.query("rollback");
      return { advanced: false, reason: `tiebreak-${row.state}` };
    }

    const nowIso = asIso(now);
    if (!row.shot_ends_at || new Date(row.shot_ends_at).getTime() > new Date(nowIso).getTime()) {
      await client.query("rollback");
      return { advanced: false, reason: "shot-still-live", tiebreak: row };
    }

    const phase = row.state;
    const salvoIndex = phase === "salvo" ? Number(row.current_salvo_index) : Number(row.sudden_death_round);
    const uniqueVotes = await shotUniqueVotes(client, battleId, Number(row.round_number), phase, salvoIndex);
    const next = closeFinalSalvoShot({
      tiebreak: tiebreakRuntimeShape(row),
      leftUnique: uniqueVotes.left,
      rightUnique: uniqueVotes.right,
      now,
    });
    if (!next.ok) throw new Error(`final-salvo-close-failed:${next.reason}`);

    const persisted = await persistTiebreakState(
      client,
      battleId,
      next,
      next.state === "resolved" ? uniqueVotes : { left: 0, right: 0 },
    );

    let finishedBattle = null;
    let winnerToken = null;
    let bracketAdvance = null;
    if (next.state === "resolved") {
      const tournament = await loadTournament(client, battle.tournament_id);
      if (!tournament || !authoritativeVoteGeneration(tournament)) {
        throw new Error("final-salvo-tournament-generation-unavailable-at-resolution");
      }
      const matchup = resolveTournamentVoteMatch({ tournament, matchRef: battleId });
      if (!matchup?.ok || matchup.battleId !== battleId) {
        throw new Error("final-salvo-matchup-unavailable-at-resolution");
      }
      winnerToken = next.winnerSide === "left" ? matchup.tokenA : matchup.tokenB;
      finishedBattle = await finishVoteBattle(client, battle, winnerToken, next.resolvedAt || nowIso);
      bracketAdvance = await advanceVoteTournamentBracket({
        client,
        tournamentId: battle.tournament_id,
        battleId,
        winnerToken,
      });
    }

    await client.query("commit");
    return {
      advanced: true,
      phase,
      shotIndex: salvoIndex,
      uniqueVotes,
      tiebreak: persisted,
      resolved: next.state === "resolved",
      winnerSide: next.winnerSide || null,
      winnerToken,
      bracketAdvance,
      battle: finishedBattle || battle,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
