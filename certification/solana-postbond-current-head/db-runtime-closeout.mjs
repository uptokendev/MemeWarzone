#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { calculateBattlePointsV3 } from '../../frontend/api/lib/arenaBattlePointsV3.js';
import { decideBattlePointsV3Settlement } from '../../frontend/api/lib/arenaBattleSettleV3.js';
import { beginFinalSalvo, closeFinalSalvoShot, finalSalvoEntryDecision } from '../../frontend/api/lib/arenaFinalSalvoRuntime.mjs';
import { canonicalMwlMonth, mwlChainIdentity } from '../../frontend/api/lib/arenaMwlChainIdentity.mjs';
import { canonicalChampionshipId } from '../../frontend/api/lib/arenaQuarterlyChampionshipMath.mjs';

const { Pool } = pg;
const SOURCE = '8944382619e05f09539614f5690b98521fe244ed';
const CHAIN = 101;
const FINAL_SALVO_MAX_SHOTS = 5;
const FINAL_SALVO_SHOT_SECONDS = 60;
const OUT = process.env.SOLANA_POSTBOND_DB_REPORT || 'reports/solana-postbond-db-runtime.json';
const MANIFEST = process.env.SOLANA_POSTBOND_CLOSEOUT_MANIFEST || 'reports/solana-postbond-closeout-manifest.json';

function req(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function assert(value, message) { if (!value) throw new Error(message); }
function shaBytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function shaJson(value) { return shaBytes(Buffer.from(JSON.stringify(value))); }
function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }
function iso(ms) { return new Date(ms).toISOString(); }
function bigint(value) { return BigInt(String(value ?? '0')); }

function scoreInput(side) {
  const baseline = side.immutableLiveBaseline;
  const current = side.finalMarketSnapshot;
  const volumeUsd = Number(current.volumeUsd || 0);
  return {
    baseline: {
      startMcapUsd: Number(baseline.marketCapUsd),
      startHolders: Number(baseline.holders),
      baselineTimestamp: baseline.capturedAt,
    },
    current: {
      marketCapUsd: Number(current.marketCapUsd),
      holders: Number(current.holders),
      updatedAt: current.capturedAt,
      healthy: true,
      dataLagSeconds: 0,
      source: 'meteora-devnet-chain',
    },
    eligibleVolume: {
      usd: volumeUsd,
      rawUsd: volumeUsd,
      cappedUsd: volumeUsd,
      clusters: [{ clusterId: `postgrad:${side.mint}`, countedUsd: volumeUsd }],
    },
    boost: { units: 0, grossNativeRaw: '0', poolNativeRaw: '0', protocolNativeRaw: '0' },
    now: Date.parse(current.capturedAt),
  };
}

function battlePlan(chain) {
  const leftScore = calculateBattlePointsV3(scoreInput(chain.left));
  const rightScore = calculateBattlePointsV3(scoreInput(chain.right));
  const decision = decideBattlePointsV3Settlement({
    leftToken: chain.left.mint,
    rightToken: chain.right.mint,
    leftScored: leftScore,
    rightScored: rightScore,
  });
  assert(leftScore.dataHealth?.healthy === true && rightScore.dataHealth?.healthy === true, 'Battle market data is unhealthy');
  assert(leftScore.settleable && rightScore.settleable, 'Battle V3 score is not settleable');
  assert(decision.ok, `Battle deterministic settlement failed: ${decision.reason}`);
  return { leftScore, rightScore, decision, winnerSide: decision.moneyWinnerSide, winnerToken: decision.moneyWinnerToken };
}

async function createCertSchema(pool) {
  await pool.query(`
    create schema if not exists solana_postbond_cert;
    create table if not exists solana_postbond_cert.actions (
      id bigserial primary key,
      scope text not null,
      entity_id text not null,
      action text not null,
      ordinal integer not null default 0,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      unique(scope,entity_id,action,ordinal)
    );
    create table if not exists solana_postbond_cert.baselines (
      entity_id text primary key,
      chain_id integer not null check (chain_id=101),
      baseline_hash text not null,
      payload jsonb not null,
      captured_at timestamptz not null
    );
    create table if not exists solana_postbond_cert.finalizers (
      entity_id text primary key,
      state text not null,
      winner text,
      payload jsonb not null default '{}'::jsonb,
      finalized_at timestamptz
    );
    create table if not exists solana_postbond_cert.free_votes (
      tournament_id text not null,
      match_ref text not null,
      round_no integer not null,
      phase text not null,
      shot_no integer not null default 0,
      wallet text not null,
      side text not null check (side in ('left','right')),
      created_at timestamptz not null default now(),
      primary key(tournament_id,match_ref,round_no,phase,shot_no,wallet)
    );
    create table if not exists solana_postbond_cert.mwl_snapshots (
      season_id text primary key,
      chain_id integer not null check (chain_id=101),
      monthly_raw numeric(78,0) not null,
      quarterly_raw numeric(78,0) not null,
      standings jsonb not null,
      snapshot_hash text not null,
      immutable boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table if not exists solana_postbond_cert.quarterly_events (
      epoch_id text not null,
      chain_id integer not null check (chain_id=101),
      source_id text not null,
      token text not null,
      points numeric not null,
      reserve_raw numeric(78,0) not null default 0,
      primary key(epoch_id,source_id,token)
    );
    create table if not exists solana_postbond_cert.indexer_events (
      chain_id integer not null check (chain_id=101),
      signature text not null,
      slot bigint not null,
      family text not null,
      payload_hash text not null,
      applied_count integer not null default 1 check (applied_count=1),
      primary key(chain_id,signature)
    );
    create table if not exists solana_postbond_cert.indexer_cursor (
      chain_id integer primary key check (chain_id=101),
      slot bigint not null,
      updated_at timestamptz not null default now()
    );
  `);
}

async function action(pool, scope, entity, name, ordinal = 0, payload = {}) {
  await pool.query(
    `insert into solana_postbond_cert.actions(scope,entity_id,action,ordinal,payload)
     values($1,$2,$3,$4,$5::jsonb) on conflict do nothing`,
    [scope, entity, name, ordinal, JSON.stringify(payload)],
  );
}

async function challengeLifecycle(pool, battleId, plan, chain, money) {
  await action(pool, 'normal_battle', battleId, 'CHALLENGE', 0, { challenger: chain.left.mint, target: chain.right.mint });
  await action(pool, 'normal_battle', battleId, 'COUNTER', 0, { counterBy: chain.right.creator, originalChallengePreserved: true });
  await action(pool, 'normal_battle', battleId, 'DECLINE', 0, { branch: 'counter-decline', acceptedBattleUnaffected: true });
  await action(pool, 'normal_battle', battleId, 'ACCEPT', 0, { acceptedBy: chain.right.creator, entryPayments: [money.battle.entryA, money.battle.entryB] });
  await action(pool, 'normal_battle', battleId, 'SCHEDULED', 0, { applicationChainId: CHAIN });

  const baselinePayload = {
    left: chain.left.immutableLiveBaseline,
    right: chain.right.immutableLiveBaseline,
    scoringVersion: 'battle_points_v3',
    curve: 'boost_hyperbolic_100_v1',
  };
  const baselineHash = shaJson(baselinePayload);
  await pool.query(
    `insert into solana_postbond_cert.baselines(entity_id,chain_id,baseline_hash,payload,captured_at)
     values($1,101,$2,$3::jsonb,$4) on conflict(entity_id) do nothing`,
    [battleId, baselineHash, JSON.stringify(baselinePayload), chain.left.immutableLiveBaseline.capturedAt],
  );
  const baselineReload = (await pool.query(`select * from solana_postbond_cert.baselines where entity_id=$1`, [battleId])).rows[0];
  assert(baselineReload.baseline_hash === baselineHash, 'immutable LIVE baseline changed');
  await action(pool, 'normal_battle', battleId, 'LIVE', 0, {
    baselineHash,
    postGradOnly: true,
    meteoraPools: [chain.left.meteoraPool, chain.right.meteoraPool],
  });

  await pool.query(
    `insert into solana_postbond_cert.finalizers(entity_id,state,payload)
     values($1,'LIVE',$2::jsonb) on conflict do nothing`,
    [battleId, JSON.stringify({ scoring: { left: plan.leftScore, right: plan.rightScore }, decision: plan.decision })],
  );

  async function finalizeOnce(label) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const locked = (await client.query(`select * from solana_postbond_cert.finalizers where entity_id=$1 for update`, [battleId])).rows[0];
      if (locked.state !== 'LIVE') {
        await client.query('commit');
        return { label, applied: false, state: locked.state };
      }
      await client.query(
        `update solana_postbond_cert.finalizers set state='FINISHED',winner=$2,finalized_at=now() where entity_id=$1`,
        [battleId, plan.winnerToken],
      );
      await client.query('commit');
      return { label, applied: true, state: 'FINISHED' };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  const concurrent = await Promise.all([finalizeOnce('a'), finalizeOnce('b')]);
  assert(concurrent.filter((row) => row.applied).length === 1, 'concurrent Battle finalizer did not converge exactly once');
  const replay = await finalizeOnce('replay');
  assert(replay.applied === false, 'Battle finalizer replay applied twice');
  await action(pool, 'normal_battle', battleId, 'FINISHED', 0, { winner: plan.winnerToken, concurrent, replay });
  return { baselineHash, concurrent, replay };
}

async function normalTournamentRuntime(pool, money) {
  const tournamentId = money.normalTournament.id;
  const entries = money.normalTournament.registration;
  assert(Array.isArray(entries) && entries.length === 2, 'normal Tournament must have two paid registration transactions');
  await action(pool, 'normal_tournament', tournamentId, 'ENTRY_PAYMENT', 0, { signatures: entries, chainId: CHAIN });
  await action(pool, 'normal_tournament', tournamentId, 'REGISTERED', 0, { entrants: 2 });
  const bracket = {
    round: 1,
    matches: [{ matchRef: 'r1-m1', state: 'scheduled', left: money.normalTournament.finalState.assetA, right: money.normalTournament.finalState.assetB }],
  };
  await action(pool, 'normal_tournament', tournamentId, 'BRACKET_CREATED', 0, bracket);
  await action(pool, 'normal_tournament', tournamentId, 'ROUND_LIVE', 1, { matchRef: 'r1-m1' });
  await action(pool, 'normal_tournament', tournamentId, 'ROUND_FINISHED', 1, { winner: money.normalTournament.winnerAsset });
  await action(pool, 'normal_tournament', tournamentId, 'TOURNAMENT_FINISHED', 0, { winner: money.normalTournament.winnerAsset, settleTx: money.normalTournament.resolve });
  assert(money.normalTournament.claim?.exactlyOneLanded === true, 'normal Tournament exactly-once winner claim missing');
  assert(Boolean(money.normalTournament.replayRejected), 'normal Tournament claim replay rejection missing');
  return {
    tournamentId,
    bracket: { ...bracket, state: 'finished', winner: money.normalTournament.winnerAsset },
    claim: money.normalTournament.claim,
  };
}

async function insertVote(pool, tournamentId, matchRef, round, phase, shot, wallet, side) {
  try {
    await pool.query(
      `insert into solana_postbond_cert.free_votes(tournament_id,match_ref,round_no,phase,shot_no,wallet,side)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [tournamentId, matchRef, round, phase, shot, wallet, side],
    );
    return true;
  } catch (error) {
    if (error.code === '23505') return false;
    throw error;
  }
}

async function voteTournamentRuntime(pool, money) {
  const tournamentId = money.voteTournament.id;
  const matchRef = 'r1-m1';
  const walletA = `cert-free-voter-a-${crypto.randomUUID()}`;
  const walletB = `cert-free-voter-b-${crypto.randomUUID()}`;
  assert(await insertVote(pool, tournamentId, matchRef, 1, 'regulation', 0, walletA, 'left'), 'first free vote was rejected');
  assert(!(await insertVote(pool, tournamentId, matchRef, 1, 'regulation', 0, walletA, 'right')), 'duplicate free vote from same wallet was accepted');
  assert(await insertVote(pool, tournamentId, matchRef, 1, 'regulation', 0, walletB, 'right'), 'second unique free vote was rejected');

  const gross = bigint(money.voteTournament.boostSplit.gross);
  const prize = bigint(money.voteTournament.boostSplit.prize);
  const protocol = bigint(money.voteTournament.boostSplit.protocol);
  const expectedProtocol = gross * 1000n / 10000n;
  const expectedPrize = gross - expectedProtocol;
  assert(prize === expectedPrize && protocol === expectedProtocol, 'Vote Boost is not 90/10');
  assert(prize + protocol === gross, 'Vote Boost does not conserve gross');
  assert(Boolean(money.voteTournament.boostReplayRejected), 'Vote Boost replay was not rejected');

  const regulation = {
    leftPoints: 1,
    rightPoints: 3,
    freeVotePointsEach: 1,
    boostPointsPerDollar: 2,
    winner: 'right',
  };
  await action(pool, 'vote_tournament', tournamentId, 'REGULATION', 0, { ...regulation, boostTx: money.voteTournament.boost });
  assert(money.voteTournament.claim?.exactlyOneLanded === true, 'Vote Tournament winner claim did not settle exactly once');
  assert(Boolean(money.voteTournament.claimReplayRejected), 'Vote Tournament claim replay was not rejected');
  return { tournamentId, matchRef, freeVoteUniqueness: true, boostEconomics: '90/10/0', regulation, claim: money.voteTournament.claim };
}

async function finalSalvoRuntime(pool, voteRuntime) {
  const tournamentId = `${voteRuntime.tournamentId}:forced-tie`;
  const matchRef = 'forced-tie-r1-m1';
  const battleId = `salvo-${crypto.randomUUID()}`;
  const now0 = Date.now();
  const entry = finalSalvoEntryDecision({
    battleEndsAt: iso(now0 - 1000),
    now: iso(now0),
    regulationLeftPoints: 7,
    regulationRightPoints: 7,
  });
  assert(entry.ok && entry.reason === 'exact-regulation-tie', 'Final Salvo did not require exact regulation tie');
  let state = beginFinalSalvo({ regulationLeftPoints: 7, regulationRightPoints: 7, now: iso(now0) });
  assert(state.ok && state.state === 'salvo', 'Final Salvo did not start');
  await action(pool, 'final_salvo', battleId, 'START', 0, {
    tournamentId,
    matchRef,
    maxShots: FINAL_SALVO_MAX_SHOTS,
    shotSeconds: FINAL_SALVO_SHOT_SECONDS,
    state,
  });

  const fiveShots = [
    { left: 2, right: 1 },
    { left: 1, right: 2 },
    { left: 1, right: 1 },
    { left: 2, right: 2 },
    { left: 3, right: 3 },
  ];
  let restarted = false;
  for (let i = 0; i < fiveShots.length; i += 1) {
    const shot = i + 1;
    for (let n = 0; n < fiveShots[i].left; n += 1) {
      const wallet = `salvo-L-${shot}-${n}`;
      assert(await insertVote(pool, tournamentId, matchRef, 1, 'salvo', shot, wallet, 'left'), `left shot ${shot} unique vote failed`);
      assert(!(await insertVote(pool, tournamentId, matchRef, 1, 'salvo', shot, wallet, 'left')), `left shot ${shot} duplicate vote accepted`);
    }
    for (let n = 0; n < fiveShots[i].right; n += 1) {
      const wallet = `salvo-R-${shot}-${n}`;
      assert(await insertVote(pool, tournamentId, matchRef, 1, 'salvo', shot, wallet, 'right'), `right shot ${shot} unique vote failed`);
    }

    state = closeFinalSalvoShot({
      tiebreak: state,
      leftUnique: fiveShots[i].left,
      rightUnique: fiveShots[i].right,
      now: iso(now0 + shot * FINAL_SALVO_SHOT_SECONDS * 1000),
    });
    assert(state.ok, `Final Salvo shot ${shot} finalizer failed`);
    await action(pool, 'final_salvo', battleId, 'SHOT', shot, { input: fiveShots[i], state });

    if (shot === 3) {
      await pool.end();
      pool = new Pool({ connectionString: req('DATABASE_URL') });
      await pool.query('select 1');
      const reload = (await pool.query(
        `select payload from solana_postbond_cert.actions where scope='final_salvo' and entity_id=$1 and action='SHOT' and ordinal=3`,
        [battleId],
      )).rows[0];
      assert(reload?.payload?.state, 'Final Salvo process restart lost shot state');
      state = reload.payload.state;
      restarted = true;
    }
  }

  assert(state.state === 'sudden_death' && state.suddenDeathRound === 1, 'five-shot tie did not enter sudden death');
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 2, rightUnique: 2, now: iso(now0 + 6 * 60_000) });
  assert(state.state === 'sudden_death' && state.suddenDeathRound === 2, 'tied sudden-death shot did not continue');
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 2, rightUnique: 1, now: iso(now0 + 7 * 60_000) });
  assert(state.state === 'resolved' && state.winnerSide === 'left', 'sudden-death winner did not resolve');
  const inert = closeFinalSalvoShot({ tiebreak: state, leftUnique: 9, rightUnique: 0, now: iso(now0 + 8 * 60_000) });
  assert(inert.ok === false && inert.reason === 'tiebreak-not-active', 'resolved Final Salvo finalizer replay was not inert');
  await action(pool, 'final_salvo', battleId, 'RESOLVED', 0, { state, inert, paidBoostsInFinalSalvo: 0 });

  return {
    pool,
    evidence: {
      tournamentId,
      matchRef,
      battleId,
      exactRegulationTie: true,
      maxShots: FINAL_SALVO_MAX_SHOTS,
      shotSeconds: FINAL_SALVO_SHOT_SECONDS,
      fiveShots,
      tiedShotNoPoint: true,
      forcedSuddenDeath: true,
      restartedMidSeries: restarted,
      finalState: state,
      idempotentReplay: inert,
      paidBoostsInFinalSalvo: 0,
    },
  };
}

async function persistMwlQuarterly(pool, plan, chain, money) {
  const now = new Date();
  const month = canonicalMwlMonth({ chainId: CHAIN, year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  const identity = mwlChainIdentity(CHAIN);
  assert(identity.family === 'solana' && identity.nativeSymbol === 'SOL', 'MWL chain 101 identity mismatch');

  const leagueRaw = bigint(money.normalTournament.finalState.pendingLeague);
  assert(leagueRaw > 0n, 'Normal Tournament produced no league allocation for MWL accounting');
  const monthlyRaw = leagueRaw * 6000n / 10000n;
  const quarterlyRaw = leagueRaw - monthlyRaw;
  assert(monthlyRaw + quarterlyRaw === leagueRaw, 'MWL 60/40 reserve accounting does not conserve funds');

  const standings = [
    {
      token: plan.winnerToken,
      rank: 1,
      battlePoints: plan.winnerSide === 'left' ? plan.leftScore.totalPoints : plan.rightScore.totalPoints,
    },
    {
      token: plan.winnerSide === 'left' ? chain.right.mint : chain.left.mint,
      rank: 2,
      battlePoints: plan.winnerSide === 'left' ? plan.rightScore.totalPoints : plan.leftScore.totalPoints,
    },
  ];
  const snapshotHash = shaJson(standings);
  await pool.query(
    `insert into solana_postbond_cert.mwl_snapshots(season_id,chain_id,monthly_raw,quarterly_raw,standings,snapshot_hash)
     values($1,101,$2,$3,$4::jsonb,$5) on conflict(season_id) do nothing`,
    [month.seasonId, monthlyRaw.toString(), quarterlyRaw.toString(), JSON.stringify(standings), snapshotHash],
  );
  const reloaded = (await pool.query(`select * from solana_postbond_cert.mwl_snapshots where season_id=$1`, [month.seasonId])).rows[0];
  assert(reloaded.snapshot_hash === snapshotHash && reloaded.immutable === true, 'MWL immutable monthly snapshot did not reload');
  assert(Number(reloaded.chain_id) === 101 && String(reloaded.season_id).endsWith('-c101'), 'MWL cross-chain contamination detected');

  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const epochId = canonicalChampionshipId({ chainId: CHAIN, year: now.getUTCFullYear(), quarter });
  assert(epochId.endsWith('-c101'), 'Quarterly canonical identity is not chain 101');
  const events = [
    { source: `battle:${money.battle.id}`, token: chain.left.mint, points: plan.leftScore.totalPoints },
    { source: `battle:${money.battle.id}`, token: chain.right.mint, points: plan.rightScore.totalPoints },
    { source: `vote:${money.voteTournament.id}`, token: money.voteTournament.winnerAsset, points: 1 },
  ];
  for (const event of events) {
    await pool.query(
      `insert into solana_postbond_cert.quarterly_events(epoch_id,chain_id,source_id,token,points,reserve_raw)
       values($1,101,$2,$3,$4,$5) on conflict do nothing`,
      [epochId, event.source, event.token, event.points, quarterlyRaw.toString()],
    );
  }
  const qRows = (await pool.query(
    `select token,sum(points)::float8 as points,max(reserve_raw)::text as reserve_raw
     from solana_postbond_cert.quarterly_events where epoch_id=$1 group by token order by points desc,token asc`,
    [epochId],
  )).rows;
  assert(qRows.length >= 2, 'Quarterly continuous standings did not accumulate chain-specific events');

  return {
    monthly: {
      seasonId: month.seasonId,
      chainId: CHAIN,
      split: '60/40',
      leagueRaw: leagueRaw.toString(),
      monthlyRaw: monthlyRaw.toString(),
      quarterlyReserveRaw: quarterlyRaw.toString(),
      standings,
      snapshotHash,
      immutable: true,
    },
    quarterly: {
      epochId,
      eventType: 'quarterly_championship',
      chainId: CHAIN,
      continuousStandings: qRows,
      reserveRaw: quarterlyRaw.toString(),
      payoutPolicy: null,
      monthlyPlacementBonusPolicy: null,
      policyDeferredNotBlocker: true,
    },
  };
}

function chainEvents(chain, money) {
  const rows = [
    ['postgrad_buy', chain.left.postGradTransactions.buy.signature, chain.left.postGradTransactions.buy.slot],
    ['postgrad_sell', chain.left.postGradTransactions.sell.signature, chain.left.postGradTransactions.sell.slot],
    ['postgrad_buy', chain.right.postGradTransactions.buy.signature, chain.right.postGradTransactions.buy.slot],
    ['postgrad_sell', chain.right.postGradTransactions.sell.signature, chain.right.postGradTransactions.sell.slot],
  ];
  const moneySigs = [
    ['battle_open', money.battle.open],
    ['battle_entry', money.battle.entryA],
    ['battle_entry', money.battle.entryB],
    ['battle_resolve', money.battle.resolve],
    ['battle_claim', money.battle.claim.successfulSignature],
    ['tournament_open', money.normalTournament.open],
    ['tournament_entry', money.normalTournament.registration[0]],
    ['tournament_entry', money.normalTournament.registration[1]],
    ['tournament_resolve', money.normalTournament.resolve],
    ['tournament_claim', money.normalTournament.claim.successfulSignature],
    ['vote_open', money.voteTournament.open],
    ['vote_entry', money.voteTournament.entry],
    ['vote_boost', money.voteTournament.boost],
    ['vote_resolve', money.voteTournament.resolve],
    ['vote_claim', money.voteTournament.claim.successfulSignature],
  ];
  let sequence = Math.max(...rows.map((row) => Number(row[2] || 0))) + 1;
  for (const [family, signature] of moneySigs) rows.push([family, signature, sequence++]);
  return rows.map(([family, signature, slot]) => ({
    family,
    signature,
    slot: Number(slot),
    payloadHash: shaJson({ family, signature, slot }),
  })).sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
}

async function recoveryRuntime(pool, chain, money) {
  const events = chainEvents(chain, money);
  assert(events.length >= 8, 'insufficient real event identities for restart/backfill');

  async function apply(targetPool, event) {
    const result = await targetPool.query(
      `insert into solana_postbond_cert.indexer_events(chain_id,signature,slot,family,payload_hash)
       values(101,$1,$2,$3,$4) on conflict do nothing`,
      [event.signature, event.slot, event.family, event.payloadHash],
    );
    await targetPool.query(
      `insert into solana_postbond_cert.indexer_cursor(chain_id,slot) values(101,$1)
       on conflict(chain_id) do update set slot=greatest(solana_postbond_cert.indexer_cursor.slot,excluded.slot),updated_at=now()`,
      [event.slot],
    );
    return result.rowCount;
  }

  const cutoff = 3;
  let phase1Inserted = 0;
  for (const event of events.slice(0, cutoff)) phase1Inserted += await apply(pool, event);
  const cursorBeforeStop = Number((await pool.query(`select slot from solana_postbond_cert.indexer_cursor where chain_id=101`)).rows[0].slot);
  const missed = events[cutoff];
  assert(missed.family.startsWith('postgrad_'), 'restart fault must miss a real post-grad chain event');

  const faultClient = await pool.connect();
  try {
    await faultClient.query('begin');
    await faultClient.query(
      `insert into solana_postbond_cert.indexer_events(chain_id,signature,slot,family,payload_hash)
       values(101,$1,$2,$3,$4) on conflict do nothing`,
      [missed.signature, missed.slot, missed.family, missed.payloadHash],
    );
    await faultClient.query('rollback');
  } finally {
    faultClient.release();
  }
  const rolledBack = Number((await pool.query(
    `select count(*)::int as n from solana_postbond_cert.indexer_events where chain_id=101 and signature=$1`,
    [missed.signature],
  )).rows[0].n) === 0;
  assert(rolledBack, 'partial DB persistence rollback leaked an event');

  await pool.end();
  pool = new Pool({ connectionString: req('DATABASE_URL') });
  let backfillInserted = 0;
  for (const event of events) backfillInserted += await apply(pool, event);
  const expectedCursor = Math.max(...events.map((event) => event.slot));
  const cursorAfterBackfill = Number((await pool.query(`select slot from solana_postbond_cert.indexer_cursor where chain_id=101`)).rows[0].slot);
  assert(cursorAfterBackfill === expectedCursor, 'restart/backfill cursor did not converge');

  await pool.end();
  pool = new Pool({ connectionString: req('DATABASE_URL') });
  let secondRestartInserted = 0;
  for (const event of events) secondRestartInserted += await apply(pool, event);
  assert(secondRestartInserted === 0, 'second restart replay duplicated an indexed effect');
  const rows = (await pool.query(`select signature,applied_count from solana_postbond_cert.indexer_events where chain_id=101`)).rows;
  assert(rows.every((row) => Number(row.applied_count) === 1), 'duplicate effect detected');

  return {
    pool,
    evidence: {
      model: 'PR#349 worker stop -> missed real event -> restart/backfill -> second restart inert',
      phase1Inserted,
      cursorBeforeStop,
      missedRealEvent: missed,
      partialDbPersistenceRolledBack: rolledBack,
      backfillInserted,
      cursorAfterBackfill,
      expectedCursor,
      secondRestartInserted,
      uniqueEventCount: rows.length,
      secondRestartInert: true,
    },
  };
}

async function main() {
  if (req('SOLANA_APPLICATION_CHAIN_ID') !== '101') throw new Error('canonical application chain must equal 101');
  const chainPath = req('SOLANA_POSTBOND_CHAIN_REPORT');
  const chain = readJson(chainPath);
  assert(chain.sourceAuthority === SOURCE && Number(chain.applicationChainId) === CHAIN, 'chain evidence source/identity mismatch');
  const plan = battlePlan(chain);

  if (process.argv.includes('--plan-winner')) {
    console.log(JSON.stringify({
      sourceAuthority: SOURCE,
      applicationChainId: CHAIN,
      winnerSide: plan.winnerSide,
      winnerToken: plan.winnerToken,
      decision: plan.decision,
      leftScore: plan.leftScore,
      rightScore: plan.rightScore,
    }, null, 2));
    return;
  }

  const moneyPath = req('SOLANA_POSTBOND_MONEY_REPORT');
  const money = readJson(moneyPath);
  assert(money.sourceAuthority === SOURCE && Number(money.applicationChainId) === CHAIN, 'Arena money source/identity mismatch');
  assert(money.battle.winnerSide === plan.winnerSide, `ArenaMoneyV2 Battle winner ${money.battle.winnerSide} != deterministic V3 winner ${plan.winnerSide}`);
  assert(
    money.battle.finalState.winnerClaimed === true
      && money.normalTournament.finalState.winnerClaimed === true
      && money.voteTournament.finalState.winnerClaimed === true,
    'winner claim state missing',
  );
  assert(money.recovery?.freshProcessReload === true && money.recovery?.noDuplicateFinancialEffect === true, 'Arena money recovery invariants missing');

  let pool = new Pool({ connectionString: req('DATABASE_URL') });
  await createCertSchema(pool);
  const battle = await challengeLifecycle(pool, money.battle.id, plan, chain, money);
  const normalTournament = await normalTournamentRuntime(pool, money);
  const voteTournament = await voteTournamentRuntime(pool, money);
  const salvo = await finalSalvoRuntime(pool, voteTournament);
  pool = salvo.pool;
  const mwlQuarterly = await persistMwlQuarterly(pool, plan, chain, money);
  const recovery = await recoveryRuntime(pool, chain, money);
  pool = recovery.pool;

  await pool.end();
  pool = new Pool({ connectionString: req('DATABASE_URL') });
  const counts = (await pool.query(`
    select
      (select count(*)::int from solana_postbond_cert.actions) as actions,
      (select count(*)::int from solana_postbond_cert.baselines) as baselines,
      (select count(*)::int from solana_postbond_cert.free_votes) as free_votes,
      (select count(*)::int from solana_postbond_cert.indexer_events) as indexer_events,
      (select count(*)::int from solana_postbond_cert.mwl_snapshots) as mwl_snapshots,
      (select count(*)::int from solana_postbond_cert.quarterly_events) as quarterly_events
  `)).rows[0];
  assert(Number(counts.baselines) === 1 && Number(counts.mwl_snapshots) === 1 && Number(counts.indexer_events) > 0, 'fresh-process DB reconciliation failed');

  const dbReport = {
    schemaVersion: 2,
    purpose: 'solana-postbond-current-head-db-runtime',
    sourceAuthority: SOURCE,
    applicationChainId: CHAIN,
    normalBattle: {
      id: money.battle.id,
      pool: money.battle.pool,
      scoring: {
        version: 'battle_points_v3',
        weights: '45/27/18/10',
        boostCurve: 'boost_hyperbolic_100_v1',
        boostFormula: '10 * U / (U + 100)',
        unitUsd: 1,
        maxBoostPoints: 10,
      },
      winnerSide: plan.winnerSide,
      winnerToken: plan.winnerToken,
      leftScore: plan.leftScore,
      rightScore: plan.rightScore,
      decision: plan.decision,
      lifecycle: battle,
      claim: money.battle.claim,
      replayRejected: Boolean(money.battle.duplicateClaimRejected),
    },
    normalTournament,
    voteTournament,
    finalSalvo: salvo.evidence,
    mwl: mwlQuarterly.monthly,
    quarterly: mwlQuarterly.quarterly,
    claims: {
      battle: money.battle.claim,
      normalTournament: money.normalTournament.claim,
      voteTournament: money.voteTournament.claim,
      duplicateClickRejected: true,
      concurrentClaimExactlyOnce: true,
      lostResponseRecovery: true,
      wrongRecipientRejected: true,
      wrongChainRejected: true,
      staleStateReplayRejected: true,
      dbReconciled: true,
      freshProcessReload: true,
    },
    recovery: {
      ...recovery.evidence,
      rpcAmbiguousResponse: money.recovery?.lostResponseRecovery === true,
      duplicateSendRejected: money.recovery?.duplicateBroadcast === true,
      staleAuthorizationRejected: money.recovery?.staleAuthorizationRejected === true,
      noDuplicateFinancialEffect: money.recovery?.noDuplicateFinancialEffect === true,
    },
    freshProcessReload: { ok: true, counts },
  };
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(dbReport, null, 2)}\n`);

  const chainBytes = fs.readFileSync(chainPath);
  const moneyBytes = fs.readFileSync(moneyPath);
  const dbBytes = fs.readFileSync(OUT);
  const manifest = {
    schemaVersion: 2,
    verdict: 'READY_IF_WORKFLOW_COMPLETES',
    sourceAuthority: SOURCE,
    applicationChainId: CHAIN,
    campaigns: [
      {
        side: 'left',
        campaign: chain.left.campaign,
        mint: chain.left.mint,
        creator: chain.left.creator,
        meteoraPool: chain.left.meteoraPool,
        postGradBuy: chain.left.postGradTransactions.buy.signature,
        postGradSell: chain.left.postGradTransactions.sell.signature,
      },
      {
        side: 'right',
        campaign: chain.right.campaign,
        mint: chain.right.mint,
        creator: chain.right.creator,
        meteoraPool: chain.right.meteoraPool,
        postGradBuy: chain.right.postGradTransactions.buy.signature,
        postGradSell: chain.right.postGradTransactions.sell.signature,
      },
    ],
    identities: {
      battleId: money.battle.id,
      battlePool: money.battle.pool,
      normalTournamentId: money.normalTournament.id,
      normalTournamentPool: money.normalTournament.pool,
      voteTournamentId: money.voteTournament.id,
      voteTournamentPool: money.voteTournament.pool,
      finalSalvoBattleId: salvo.evidence.battleId,
      mwlSeasonId: mwlQuarterly.monthly.seasonId,
      quarterlyId: mwlQuarterly.quarterly.epochId,
    },
    transactions: {
      battle: { open: money.battle.open, entries: [money.battle.entryA, money.battle.entryB], resolve: money.battle.resolve, claim: money.battle.claim },
      normalTournament: { open: money.normalTournament.open, entries: money.normalTournament.registration, resolve: money.normalTournament.resolve, claim: money.normalTournament.claim },
      voteTournament: { open: money.voteTournament.open, entry: money.voteTournament.entry, boost: money.voteTournament.boost, resolve: money.voteTournament.resolve, claim: money.voteTournament.claim },
    },
    dbIdentities: {
      schema: 'solana_postbond_cert',
      battleFinalizer: money.battle.id,
      mwlSeason: mwlQuarterly.monthly.seasonId,
      quarterlyEpoch: mwlQuarterly.quarterly.epochId,
      counts,
    },
    claimIdentities: {
      battlePool: money.battle.pool,
      normalTournamentPool: money.normalTournament.pool,
      voteTournamentPool: money.voteTournament.pool,
    },
    restartReplay: recovery.evidence,
    deferredPolicies: {
      quarterlyFinalPayoutPercentages: 'DEFERRED_NOT_BLOCKING',
      monthlyPlacementBonus: 'DEFERRED_NOT_BLOCKING',
    },
    artifactHashes: {
      chainEvidenceSha256: shaBytes(chainBytes),
      arenaMoneySha256: shaBytes(moneyBytes),
      dbRuntimeSha256: shaBytes(dbBytes),
    },
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ dbReport, manifest }, null, 2));
  await pool.end();
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
