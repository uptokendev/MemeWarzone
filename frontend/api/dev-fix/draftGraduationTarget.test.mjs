// Draft save is the path that hit campaign_drafts_graduation_target_check. $150 is 150e18.
// Mainnet 56 and 4663 never accept it. Testnets 97 and 46630 do, and Solana devnet still does.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { normalizeDraftGraduationTarget } from "./drafts-base.js";

const TEST_TARGET = 150n * 10n ** 18n;

test("draft save accepts $150 on 97, 46630, 101 and 102, and refuses it on 56 and 4663", () => {
  for (const chainId of [97, 46630]) {
    assert.equal(normalizeDraftGraduationTarget(chainId, TEST_TARGET), TEST_TARGET.toString(), String(chainId));
  }
  assert.equal(normalizeDraftGraduationTarget(101, TEST_TARGET, "dbc"), TEST_TARGET.toString());
  assert.equal(normalizeDraftGraduationTarget(102, TEST_TARGET, "dbc"), TEST_TARGET.toString());
  for (const chainId of [56, 4663]) {
    assert.throws(
      () => normalizeDraftGraduationTarget(chainId, TEST_TARGET),
      (error) => error.code === "INVALID_GRADUATION_TARGET",
      String(chainId),
    );
    assert.throws(
      () => normalizeDraftGraduationTarget(chainId, TEST_TARGET, "dbc"),
      (error) => error.code === "INVALID_GRADUATION_TARGET",
      `${chainId} dbc`,
    );
  }
});

test("the draft check migration allows $150 on 97 and 46630 and not on mainnet, and the production paste matches", () => {
  const root = new URL("../../../", import.meta.url);
  const migration = fs.readFileSync(new URL("db/migrations/20261019_000001_campaign_drafts_gen8_test_target.sql", root), "utf8");
  const paste = fs.readFileSync(new URL("deployments/gen8/PROD_APPLY.sql", root), "utf8");
  const line = "graduation_target_wei <> 150000000000000000000::numeric or chain_id in (97, 46630, 101, 102)";
  assert.match(migration, /drop constraint if exists campaign_drafts_graduation_target_check/);
  assert.match(migration, /add constraint campaign_drafts_graduation_target_check/);
  assert.ok(migration.includes(line));
  assert.equal(migration.includes("chain_id in (56"), false);
  assert.equal(migration.includes("4663)"), false);
  assert.ok(paste.includes(line));
  assert.match(paste, /drop constraint if exists campaign_drafts_graduation_target_check/);
  assert.match(paste, /draft_150_excludes_mainnet/);
});
