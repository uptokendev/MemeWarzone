#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SOURCE = '8944382619e05f09539614f5690b98521fe244ed';
const allowed = new Set([
  '.github/workflows/solana-postbond-current-head-closeout.yml',
  '.github/workflows/solana-postbond-v0-alt-chain-evidence.yml',
  'certification/solana-postbond-current-head/source-gate.mjs',
  'certification/solana-postbond-current-head/chain-evidence.mjs',
  'certification/solana-postbond-current-head/chain-evidence.test.mjs',
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

function requireText(text, needles, label) {
  for (const needle of needles) {
    if (!text.includes(needle)) fail(`${label} invariant missing: ${needle}`);
  }
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
  'frontend/api/lib/arenaBattlePointsConfig.js',
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
requireText(launchProgram, ['declare_id!("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt")'], 'accepted Solana launch program');

const competition = fs.readFileSync('programs/mwz_rewards_treasury/src/arena_money_v2/competition.rs', 'utf8');
requireText(competition, [
  'pub const COMPETITION_PRIZE_BPS: u64 = 7_500;',
  'pub const COMPETITION_LEAGUE_BPS: u64 = 2_000;',
  'pub const COMPETITION_PROTOCOL_BPS: u64 = 500;',
  'pub fn claim_competition_winner_v2_handler',
], 'ArenaMoneyV2 Competition');

const boost = fs.readFileSync('programs/mwz_rewards_treasury/src/arena_money_v2/boost.rs', 'utf8');
requireText(boost, [
  'pub const BOOST_PRIZE_BPS: u64 = 9_000;',
  'pub const BOOST_PROTOCOL_BPS: u64 = 1_000;',
  'pub const BOOST_LEAGUE_BPS: u64 = 0;',
], 'ArenaMoneyV2 Boost');

const scoring = fs.readFileSync('frontend/api/lib/arenaBattlePointsConfig.js', 'utf8');
requireText(scoring, [
  'export const BATTLE_POINTS_V3_BOOST_CURVE = "boost_hyperbolic_100_v1";',
  'mcap: Object.freeze({ weight: 45 })',
  'holders: Object.freeze({ weight: 27 })',
  'volume: Object.freeze({ weight: 18 })',
  'weight: 10,',
  'maxPoints: 10,',
  'halfSaturationUnits: 100,',
  'unitUsdMicros: 1_000_000,',
], 'Battle Points V3');

const points = fs.readFileSync('frontend/api/lib/arenaBattlePointsV3.js', 'utf8');
requireText(points, ['calculateBattlePointsV3', 'confirmedBoostUnits'], 'Battle Points V3 runtime');

const finalSalvo = fs.readFileSync('frontend/api/lib/arenaFinalSalvoRuntime.mjs', 'utf8');
requireText(finalSalvo, [
  'const SHOT_SECONDS = 60;',
  'const MAX_SALVO_SHOTS = 5;',
  'reason: "exact-regulation-tie"',
  'if (left === right) return null;',
  'state: "sudden_death"',
], 'Final Salvo');

const mwl = fs.readFileSync('frontend/api/lib/arenaMwlChainIdentity.mjs', 'utf8');
requireText(mwl, ['mwl-', 'chainId', 'SOL'], 'MWL chain identity');

const quarterlyRuntime = fs.readFileSync('frontend/api/lib/arenaQuarterlyChampionship.js', 'utf8');
requireText(quarterlyRuntime, ['CHAMPIONSHIP_BONUS_POLICY_NOT_CONFIGURED', 'canonicalChampionshipId'], 'Quarterly runtime');
const quarterlyMath = fs.readFileSync('frontend/api/lib/arenaQuarterlyChampionshipMath.mjs', 'utf8');
requireText(quarterlyMath, [
  'export const CHAMPIONSHIP_EVENT_TYPE = "quarterly_championship";',
  'return `quarterly-championship-${y}-q${q}-c${chain}`;',
], 'Quarterly canonical identity');

const chainEvidence = fs.readFileSync('certification/solana-postbond-current-head/chain-evidence.mjs', 'utf8');
requireText(chainEvidence, [
  'maxSupportedTransactionVersion: 0',
  'meta?.loadedAddresses',
  'accountKeysFromLookups',
  'getAddressLookupTable',
  'balance/account-key alignment mismatch',
  'index === 0 ? BigInt(tx.meta.fee || 0) : 0n',
], 'V0/ALT chain evidence');

const certDb = fs.readFileSync('certification/solana-postbond-current-head/db-runtime-closeout.mjs', 'utf8');
requireText(certDb, [
  'const FINAL_SALVO_MAX_SHOTS = 5;',
  'const FINAL_SALVO_SHOT_SECONDS = 60;',
  "boostCurve: 'boost_hyperbolic_100_v1'",
  "split: '60/40'",
  "eventType: 'quarterly_championship'",
  "quarterlyFinalPayoutPercentages: 'DEFERRED_NOT_BLOCKING'",
  "monthlyPlacementBonus: 'DEFERRED_NOT_BLOCKING'",
], 'certification closeout transport');

console.log(JSON.stringify({
  ok: true,
  sourceAuthority: SOURCE,
  head: git(['rev-parse', 'HEAD']),
  changedFiles: changed,
  protections: {
    launchProgramUnchanged: true,
    arenaMoneyV2Unchanged: true,
    scoringAuthorityUnchanged: true,
    boostEconomicsUnchanged: true,
    tournamentEconomicsUnchanged: true,
    finalSalvoAuthorityUnchanged: true,
    productionFilesChanged: false,
  },
}, null, 2));
