import {
  beginFinalSalvo,
  closeFinalSalvoShot,
  finalSalvoEntryDecision,
  finalSalvoIdentityMatches,
  finalSalvoShotIdentity,
  requiredFinalSalvoChainId,
} from "./arenaFinalSalvoRuntime.mjs";
import { findTournamentVoteMatch } from "./arenaTournamentVoteRuntime.mjs";

function ident(value) {
  return String(value ?? "").trim();
}

function dbTiebreakToRuntime(row) {
  return {
    state: row.state,
    chainId: Number(row.chain_id),
    tournamentId: row.tournament_id,
    battleId: row.battle_id,
    matchId: row.match_id,
    roundNumber: Number(row.round_number),
    currentSalvoIndex: Number(row.current_salvo_index || 0),
    leftSalvoPoints: Number(row.left_salvo_points || 0),
    rightSalvoPoints: Number(row.right_salvo_points || 0),
    suddenDeathRound: Number(row.sudden_death_round || 0),
    shotStartedAt: row.shot_started_at,
    shotEndsAt: row.shot_ends_at,
    shotHistory: Array.isArray(row.shot_history) ? row.shot_history : [],
    winnerSide: row.winner_side || null,
    resolvedAt: row.resolved_at || null,
  };
}

async function dbNow(client) {
  const result = await client.query("select now() as now");
  return result.rows[0].now;
}

async function regulationPoints(client, identity) {
  const result = await client.query(
    `select
       coalesce(sum(points) filter (where side='left'),0)::int as left_points,
       coalesce(sum(points) filter (where side='right'),0)::int as right_points
       from public.arena_contest_actions
      where chain_id=$1 and tournament_id=$2 and battle_id=$3 and round_number=$4
        and coalesce(match_id,battle_id)=$5
        and phase='regulation' and confirmed_at is not null`,
    [identity.chainId, identity.tournamentId, identity.battleId, identity.roundNumber, identity.matchId],
  );
  return {
    leftPoints: Number(result.rows[0]?.left_points || 0),
    rightPoints: Number(result.rows[0]?.right_points || 0),
  };
}

async function shotVotes(client, identity, phase, shotIndex) {
  const result = await client.query(
    `select
       count(distinct wallet) filter (where side='left')::int as left_votes,
       count(distinct wallet) filter (where side='right')::int as right_votes
       from public.arena_contest_actions
      where chain_id=$1 and tournament_id=$2 and battle_id=$3 and round_number=$4
        and coalesce(match_id,battle_id)=$5
        and phase=$6 and salvo_index=$7
        and action_type='free_vote' and confirmed_at is not null`,
    [identity.chainId, identity.tournamentId, identity.battleId, identity.roundNumber, identity.matchId, phase, shotIndex],
  );
  return {
    leftVotes: Number(result.rows[0]?.left_votes || 0),
    rightVotes: Number(result.rows[0]?.right_votes || 0),
  };
}

async function loadAuthority(client, identity) {
  const tournament = (await client.query(
    `select id,chain_id,status,bracket,battle_mode,round_duration_hours
       from public.arena_tournaments where id=$1 and chain_id=$2 limit 1 for update`,
    [identity.tournamentId, identity.chainId],
  )).rows[0] || null;
  if (!tournament || tournament.battle_mode !== "vote" || Number(tournament.round_duration_hours) !== 24) {
    return { ok: false, code: "FINAL_SALVO_TOURNAMENT_IDENTITY_MISMATCH" };
  }

  const matchup = findTournamentVoteMatch({ tournament, matchRef: identity.matchId });
  if (!matchup.ok || matchup.battleId !== identity.battleId || Number(matchup.roundNumber) !== Number(identity.roundNumber)) {
    return { ok: false, code: "FINAL_SALVO_MATCH_IDENTITY_MISMATCH" };
  }

  const battle = (await client.query(
    `select id,chain_id,tournament_id,source,battle_mode,ends_at
       from public.arena_battles
      where id=$1 and chain_id=$2 and tournament_id=$3 and source='tournament' and battle_mode='vote'
      limit 1 for update`,
    [identity.battleId, identity.chainId, identity.tournamentId],
  )).rows[0] || null;
  if (!battle) return { ok: false, code: "FINAL_SALVO_BATTLE_IDENTITY_MISMATCH" };

  return { ok: true, tournament, matchup, battle };
}

function appendImmutableIdentity(history, identity) {
  return (Array.isArray(history) ? history : []).map((entry) => ({
    ...entry,
    chainId: identity.chainId,
    tournamentId: identity.tournamentId,
    battleId: identity.battleId,
    matchId: identity.matchId,
    roundNumber: identity.roundNumber,
  }));
}

async function persistWinnerToBracket(client, tournament, matchup, winnerToken) {
  const bracket = typeof tournament.bracket === "string" ? JSON.parse(tournament.bracket) : structuredClone(tournament.bracket || {});
  const rounds = Array.isArray(bracket?.rounds) ? bracket.rounds : [];
  const round = rounds[matchup.roundIndex];
  const matches = Array.isArray(round?.matches) ? round.matches : [];
  const index = matches.findIndex((candidate) =>
    ident(candidate?.id) === ident(matchup.matchId) || ident(candidate?.battleId || candidate?.battle_id) === ident(matchup.battleId)
  );
  if (index < 0) throw Object.assign(new Error("Final Salvo bracket matchup disappeared"), { code: "FINAL_SALVO_MATCH_IDENTITY_MISMATCH" });
  const existingWinner = ident(matches[index]?.winner);
  if (existingWinner && existingWinner !== ident(winnerToken)) {
    throw Object.assign(new Error("Final Salvo result is immutable"), { code: "FINAL_SALVO_RESULT_IMMUTABLE" });
  }
  if (existingWinner === ident(winnerToken)) return;
  matches[index] = { ...matches[index], winner: winnerToken };
  round.matches = matches;
  rounds[matchup.roundIndex] = round;
  bracket.rounds = rounds;
  const updated = await client.query(
    `update public.arena_tournaments
        set bracket=$3::jsonb, updated_at=now()
      where id=$1 and chain_id=$2
      returning id`,
    [tournament.id, Number(tournament.chain_id), JSON.stringify(bracket)],
  );
  if (!updated.rows[0]) throw Object.assign(new Error("Final Salvo tournament changed during settlement"), { code: "FINAL_SALVO_TOURNAMENT_IDENTITY_MISMATCH" });
}

export async function ensureFinalSalvo(pool, requestedIdentity) {
  const identity = { ...requestedIdentity, chainId: requiredFinalSalvoChainId(requestedIdentity?.chainId) };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const authority = await loadAuthority(client, identity);
    if (!authority.ok) {
      await client.query("rollback");
      return authority;
    }

    const existing = (await client.query(
      `select * from public.arena_vote_tiebreaks where battle_id=$1 for update`,
      [identity.battleId],
    )).rows[0] || null;
    if (existing) {
      if (!finalSalvoIdentityMatches(existing, identity)) {
        await client.query("rollback");
        return { ok: false, code: "FINAL_SALVO_IDENTITY_MISMATCH" };
      }
      await client.query("commit");
      return { ok: true, created: false, tiebreak: existing, matchup: authority.matchup };
    }

    const now = await dbNow(client);
    const regulation = await regulationPoints(client, identity);
    const entry = finalSalvoEntryDecision({
      battleEndsAt: authority.battle.ends_at,
      now,
      regulationLeftPoints: regulation.leftPoints,
      regulationRightPoints: regulation.rightPoints,
    });
    if (!entry.ok) {
      await client.query("rollback");
      return { ok: false, code: entry.reason === "regulation-active" ? "FINAL_SALVO_REGULATION_ACTIVE" : "FINAL_SALVO_REGULATION_NOT_TIED" };
    }

    const initial = beginFinalSalvo({
      regulationLeftPoints: regulation.leftPoints,
      regulationRightPoints: regulation.rightPoints,
      now,
    });
    const inserted = await client.query(
      `insert into public.arena_vote_tiebreaks (
         battle_id,tournament_id,chain_id,match_id,round_number,state,
         regulation_left_points,regulation_right_points,current_salvo_index,
         left_salvo_points,right_salvo_points,shot_started_at,shot_ends_at,shot_history,
         sudden_death_round,winner_side,winner_token_address,resolved_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,null,null,null)
       on conflict (battle_id) do nothing
       returning *`,
      [
        identity.battleId, identity.tournamentId, identity.chainId, identity.matchId, identity.roundNumber,
        initial.state, initial.regulationLeftPoints, initial.regulationRightPoints, initial.currentSalvoIndex,
        initial.leftSalvoPoints, initial.rightSalvoPoints, initial.shotStartedAt, initial.shotEndsAt,
        JSON.stringify(initial.shotHistory), initial.suddenDeathRound,
      ],
    );
    const row = inserted.rows[0] || (await client.query(`select * from public.arena_vote_tiebreaks where battle_id=$1 for update`, [identity.battleId])).rows[0];
    if (!finalSalvoIdentityMatches(row, identity)) {
      await client.query("rollback");
      return { ok: false, code: "FINAL_SALVO_IDENTITY_MISMATCH" };
    }
    await client.query("commit");
    return { ok: true, created: Boolean(inserted.rows[0]), tiebreak: row, matchup: authority.matchup };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeExpiredFinalSalvoShot(pool, requestedIdentity) {
  const identity = { ...requestedIdentity, chainId: requiredFinalSalvoChainId(requestedIdentity?.chainId) };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const authority = await loadAuthority(client, identity);
    if (!authority.ok) {
      await client.query("rollback");
      return authority;
    }
    const current = (await client.query(`select * from public.arena_vote_tiebreaks where battle_id=$1 for update`, [identity.battleId])).rows[0] || null;
    if (!current) {
      await client.query("rollback");
      return { ok: false, code: "FINAL_SALVO_NOT_STARTED" };
    }
    if (!finalSalvoIdentityMatches(current, identity)) {
      await client.query("rollback");
      return { ok: false, code: "FINAL_SALVO_IDENTITY_MISMATCH" };
    }
    if (current.state === "resolved") {
      await client.query("commit");
      return { ok: true, advanced: false, resolved: true, tiebreak: current, matchup: authority.matchup };
    }

    const shot = finalSalvoShotIdentity(current);
    const now = await dbNow(client);
    if (!current.shot_ends_at || new Date(now).getTime() < new Date(current.shot_ends_at).getTime()) {
      await client.query("commit");
      return { ok: true, advanced: false, resolved: false, tiebreak: current, matchup: authority.matchup };
    }

    const votes = await shotVotes(client, identity, shot.phase, shot.index);
    const transition = closeFinalSalvoShot({
      tiebreak: dbTiebreakToRuntime(current),
      leftUnique: votes.leftVotes,
      rightUnique: votes.rightVotes,
      now,
    });
    if (!transition.ok) {
      await client.query("rollback");
      return { ok: false, code: "FINAL_SALVO_TRANSITION_REJECTED" };
    }
    const winnerToken = transition.winnerSide === "left"
      ? authority.matchup.tokenA
      : transition.winnerSide === "right"
        ? authority.matchup.tokenB
        : null;
    const history = appendImmutableIdentity(transition.shotHistory, identity);

    const updated = (await client.query(
      `update public.arena_vote_tiebreaks set
         state=$2,current_salvo_index=$3,left_salvo_points=$4,right_salvo_points=$5,
         sudden_death_round=$6,shot_started_at=$7,shot_ends_at=$8,shot_history=$9::jsonb,
         winner_side=$10,winner_token_address=$11,resolved_at=$12,
         left_current_unique_votes=0,right_current_unique_votes=0,updated_at=now()
       where battle_id=$1
       returning *`,
      [
        identity.battleId, transition.state, transition.currentSalvoIndex,
        transition.leftSalvoPoints, transition.rightSalvoPoints, transition.suddenDeathRound,
        transition.shotStartedAt, transition.shotEndsAt, JSON.stringify(history),
        transition.winnerSide, winnerToken, transition.resolvedAt,
      ],
    )).rows[0];

    if (transition.state === "resolved" && winnerToken) {
      await persistWinnerToBracket(client, authority.tournament, authority.matchup, winnerToken);
    }
    await client.query("commit");
    return { ok: true, advanced: true, resolved: transition.state === "resolved", tiebreak: updated, matchup: authority.matchup };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
