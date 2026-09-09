import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalMonthlyMwlId } from "./arenaQuarterlyChampionshipMath.mjs";
import {
  MWL_SUPPORTED_CHAIN_IDS,
  assertMwlSeasonIdentity,
  canonicalMwlMonth,
  mwlChainIdentity,
  mwlEntitlementIdentity,
  requiredMwlChainId,
  resolveMwlTreasuryAssociation,
} from "./arenaMwlChainIdentity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const apiSource = fs.readFileSync(path.join(repoRoot, "frontend", "api", "arenaLeague.js"), "utf8");
const scoreSource = fs.readFileSync(path.join(here, "arenaLeagueScore.js"), "utf8");
const migrationSource = fs.readFileSync(path.join(repoRoot, "db", "migrations", "20260909_000002_arena_mwl_three_chain_identity.sql"), "utf8");

const PROD = [56, 101, 4663];
const STAGING = [97, 46630];

test("BNB, Solana and Robinhood MWL identities include required staging authorities", () => {
  assert.deepEqual(MWL_SUPPORTED_CHAIN_IDS, [56, 97, 101, 4663, 46630]);
  assert.deepEqual(PROD.map((chainId) => requiredMwlChainId(chainId)), PROD);
  assert.deepEqual(STAGING.map((chainId) => requiredMwlChainId(chainId)), STAGING);
  assert.deepEqual(mwlChainIdentity(56), { chainId: 56, family: "bnb", environment: "production", nativeSymbol: "BNB" });
  assert.equal(mwlChainIdentity(97).family, "bnb");
  assert.equal(mwlChainIdentity(101).family, "solana");
  assert.equal(mwlChainIdentity(4663).family, "robinhood");
  assert.equal(mwlChainIdentity(46630).environment, "staging");
});

test("missing and wrong-chain MWL requests fail closed rather than defaulting to BNB", () => {
  for (const bad of [undefined, null, "", 0, -1, 1, 102, 46631]) {
    assert.throws(() => requiredMwlChainId(bad), /Major War League chainId|Unsupported Major War League chainId/);
  }
  assert.match(apiSource, /requiredMwlChainId\(url\.searchParams\.get\("chainId"\)\)/);
  assert.match(apiSource, /requiredMwlChainId\(body\.chainId\)/);
  assert.match(apiSource, /requiredMwlChainId\(query\.chainId\)/);
});

test("monthly period identity remains exactly compatible with the certified canonical MWL id", () => {
  for (const chainId of MWL_SUPPORTED_CHAIN_IDS) {
    const period = canonicalMwlMonth({ chainId, year: 2026, month: 9 });
    assert.equal(period.seasonId, canonicalMonthlyMwlId({ chainId, year: 2026, month: 9 }));
    assert.equal(period.monthId, "202609");
    assert.equal(period.seasonId, `mwl-2026-m09-c${chainId}`);
  }
});

test("season identity binds chain, year, month, id and epoch key", () => {
  const row = { id: "mwl-2026-m09-c56", chain_id: 56, year: 2026, month: 9, mwl_epoch_key: "mwl-2026-m09-c56" };
  assert.equal(assertMwlSeasonIdentity(row, { chainId: 56, year: 2026, month: 9 }), row);
  for (const bad of [
    { ...row, chain_id: 101 },
    { ...row, year: 2025 },
    { ...row, month: 8 },
    { ...row, id: "mwl-2026-m09-c101" },
    { ...row, mwl_epoch_key: "mwl-2026-m09-c97" },
  ]) {
    assert.throws(() => assertMwlSeasonIdentity(bad, { chainId: 56, year: 2026, month: 9 }), /season identity/);
  }
});

test("qualification/admission and campaign/token ownership stay chain-scoped", () => {
  assert.match(apiSource, /where chain_id = \$1[\s\S]*creator_address/);
  assert.match(apiSource, /arena_token_imports[\s\S]*where chain_id = \$1/);
  assert.match(apiSource, /tokenEligible\(pool, chainId, coin\.tokenAddress\)/);
  assert.match(apiSource, /seasonRowForChain\(seasonId, id\)/);
  assert.match(migrationSource, /enforce_arena_mwl_entry_season_identity/);
});

test("standings, leaderboard feed and detail authority are chain+monthly-season scoped", () => {
  assert.match(apiSource, /active = true and chain_id = \$1 and month is not null/);
  assert.match(apiSource, /where id = \$1 and chain_id = \$2 and month is not null/);
  assert.match(apiSource, /chainIdentity: mwlChainIdentity\(row\.chain_id\)/);
  assert.match(apiSource, /periodIdentity: period/);
  assert.match(apiSource, /entries: ranked/);
});

test("MWL scoring source derives season from the Battle chain and persistence revalidates the monthly season", () => {
  assert.match(scoreSource, /const chain = requireBattleChainId\(row\)/);
  assert.match(scoreSource, /ensureActiveSeason\(chain\.chainId, db\)/);
  assert.match(scoreSource, /writeEvent\([\s\S]*battleId: row\.id/);
  assert.match(migrationSource, /enforce_arena_mwl_point_event_season_identity/);
  assert.match(migrationSource, /season\.chain_id NOT IN \(56, 97, 101, 4663, 46630\)/);
});

test("Treasury association is exact-chain only with 60 percent Monthly MWL reserve authority", () => {
  const env = {
    MONTHLY_LEAGUE_TREASURY_ADDRESS_56: "bnb-treasury",
    MONTHLY_LEAGUE_TREASURY_ADDRESS_101: "sol-treasury",
    MONTHLY_LEAGUE_TREASURY_ADDRESS_4663: "rh-treasury",
    MONTHLY_LEAGUE_TREASURY_ADDRESS: "must-not-be-used",
  };
  assert.equal(resolveMwlTreasuryAssociation(56, env).treasuryId, "bnb-treasury");
  assert.equal(resolveMwlTreasuryAssociation(101, env).treasuryId, "sol-treasury");
  assert.equal(resolveMwlTreasuryAssociation(4663, env).treasuryId, "rh-treasury");
  assert.equal(resolveMwlTreasuryAssociation(97, env).configured, false);
  assert.equal(resolveMwlTreasuryAssociation(56, env).reserveShareBps, 6000);
  assert.match(apiSource, /MWL_TREASURY_NOT_CONFIGURED/);
  assert.match(migrationSource, /reserve_share_bps integer NOT NULL DEFAULT 6000 CHECK \(reserve_share_bps = 6000\)/);
});

test("result/finalization identity is immutable by season+chain+period+Treasury authority", () => {
  assert.match(apiSource, /arena_mwl_finalizations/);
  assert.match(apiSource, /Number\(result\.chainId\) !== chainId/);
  assert.match(apiSource, /MWL_FINALIZATION_CHAIN_MISMATCH/);
  assert.match(migrationSource, /FOREIGN KEY \(season_id, chain_id\)[\s\S]*arena_league_seasons\(id, chain_id\)/);
  assert.match(migrationSource, /arena_mwl_finalizations_period_unique UNIQUE \(chain_id, year, month\)/);
  assert.match(migrationSource, /MWL_FINALIZATION_IDENTITY_MISMATCH/);
});

test("settlement entitlement identity binds chain+season+month+recipient+amount+version and cannot cross Treasury", () => {
  const bnb = mwlEntitlementIdentity({ chainId: 56, seasonId: "mwl-2026-m09-c56", monthId: "202609", recipient: "wallet", amountRaw: "100", version: "v1" });
  const sol = mwlEntitlementIdentity({ chainId: 101, seasonId: "mwl-2026-m09-c101", monthId: "202609", recipient: "wallet", amountRaw: "100", version: "v1" });
  assert.notEqual(bnb, sol);
  assert.equal(bnb, "56:mwl-2026-m09-c56:202609:wallet:100:v1");
  assert.throws(() => mwlEntitlementIdentity({ chainId: 56, seasonId: "", monthId: "202609", recipient: "wallet", amountRaw: "100", version: "v1" }));
  assert.match(migrationSource, /arena_mwl_settlement_entitlements_identity_unique[\s\S]*chain_id, season_id, month_id, recipient, amount_raw, settlement_version/);
  assert.match(migrationSource, /authority\.chain_id <> NEW\.chain_id[\s\S]*authority\.treasury_id <> NEW\.treasury_id/);
  assert.match(migrationSource, /MWL_ENTITLEMENT_IDENTITY_MISMATCH/);
});

test("MWL hardening does not implement claims or alter market/import/dashboard/deployment surfaces", () => {
  for (const source of [apiSource, migrationSource]) {
    assert.doesNotMatch(source, /reward-claim|claim_intent|graduation market|web-dashboard|robinhood deployment|solana-program/i);
  }
});
