#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SOURCE = '8944382619e05f09539614f5690b98521fe244ed';
const allowed = new Set([
  '.github/workflows/solana-postbond-current-head-closeout.yml',
  'certification/solana-postbond-current-head/source-gate.mjs',
  'certification/solana-postbond-current-head/chain-evidence.mjs',
  'certification/solana-postbond-current-head/arena-money-closeout.mjs',
  'certification/solana-postbond-current-head/db-runtime-closeout.mjs',
]);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error(`SOURCE_GATE_FAIL: ${message}`);
  process.exit(1);
}

const expected = String(process.env.EXPECTED_SOURCE_SHA || SOURCE).trim();
if (expected !== SOURCE) fail(`expected source must be ${SOURCE}`);
try {
  execFileSync('git', ['merge-base', '--is-ancestor', SOURCE, 'HEAD'], { stdio: 'inherit' });
} catch {
  fail(`HEAD is not descended from exact source ${SOURCE}`);
}
const mergeBase = git(['merge-base', SOURCE, 'HEAD']);
if (mergeBase !== SOURCE) fail(`merge base ${mergeBase} is not exact source ${SOURCE}`);

const changed = git(['diff', '--name-only', `${SOURCE}...HEAD`]).split('\n').filter(Boolean);
for (const path of changed) if (!allowed.has(path)) fail(`non-certification path changed: ${path}`);

const forbiddenPrefixes = [
  'programs/memewarzone_solana/',
  'programs/mwz_rewards_treasury/src/arena_money_v2/',
  'frontend/api/arenaBattles.js',
  'frontend/api/arenaTournaments.js',
  'frontend/api/arenaTournamentVotes.js',
  'frontend/api/arenaFinalSalvo.js',
  'frontend/api/lib/arenaBattleSettlementV3Service.js',
  'frontend/api/lib/arenaFinalSalvoFinalizer.js',
  'frontend/api/lib/arenaFinalSalvoRuntime.mjs',
  'frontend/api/lib/arenaMwlChainIdentity.mjs',
  'frontend/api/lib/arenaQuarterlyChampionship.js',
];
for (const path of changed) {
  if (forbiddenPrefixes.some((prefix) => path === prefix || path.startsWith(prefix))) {
    fail(`protected authority changed: ${path}`);
  }
}

const launchProgram = fs.readFileSync('programs/memewarzone_solana/src/lib.rs', 'utf8');
if (!launchProgram.includes('declare_id!("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt")')) {
  fail('accepted Solana launch program id changed');
}
const competition = fs.readFileSync('programs/mwz_rewards_treasury/src/arena_money_v2/competition.rs', 'utf8');
for (const needle of [
  'pub const COMPETITION_PRIZE_BPS: u64 = 7_500;',
  'pub const COMPETITION_LEAGUE_BPS: u64 = 2_000;',
  'pub const COMPETITION_PROTOCOL_BPS: u64 = 500;',
  'pub fn claim_competition_winner_v2_handler',
]) if (!competition.includes(needle)) fail(`ArenaMoneyV2 invariant missing: ${needle}`);
const boost = fs.readFileSync('programs/mwz_rewards_treasury/src/arena_money_v2/boost.rs', 'utf8');
for (const needle of ['BOOST_PRIZE_BPS', 'BOOST_PROTOCOL_BPS']) if (!boost.includes(needle)) fail(`Boost authority missing ${needle}`);

const scoring = fs.readFileSync('frontend/api/lib/arenaBattlePointsV3.js', 'utf8');
for (const needle of ['45', '27', '18', '10', 'boost_hyperbolic_100_v1']) if (!scoring.includes(needle)) fail(`Battle V3 source missing ${needle}`);

const finalSalvo = fs.readFileSync('frontend/api/lib/arenaFinalSalvoRuntime.mjs', 'utf8');
for (const needle of ['FINAL_SALVO_MAX_SHOTS', 'FINAL_SALVO_SHOT_SECONDS']) if (!finalSalvo.includes(needle)) fail(`Final Salvo authority missing ${needle}`);

console.log(JSON.stringify({
  ok: true,
  sourceAuthority: SOURCE,
  head: git(['rev-parse', 'HEAD']),
  changedFiles: changed,
  protections: {
    launchProgramUnchanged: true,
    arenaMoneyV2Unchanged: true,
    scoringAuthorityUnchanged: true,
    finalSalvoAuthorityUnchanged: true,
    productionFilesChanged: false,
  },
}, null, 2));
