import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../robinhoodCmsHeal.ts"), "utf8");
const skipSql = source.slice(source.indexOf("export const CMS_ALREADY_HEALED_SQL"), source.indexOf("async function cmsAlreadyHealed"));

test("a gen-8 campaign returns before any chain read", () => {
  const body = source.slice(source.indexOf("export async function healRobinhoodGraduatedCms"));
  const gate = body.indexOf("isGen8Campaign(");
  const already = body.indexOf("cmsAlreadyHealed(");
  const firstRead = body.indexOf("new ethers.Contract(");
  assert.ok(gate > 0 && already > gate && firstRead > gate);
  assert.match(body.slice(gate, already), /return \{ healed: false, reason: "gen8" \}/);
});

test("the already-healed check runs before any chain read", () => {
  const body = source.slice(source.indexOf("export async function healRobinhoodGraduatedCms"));
  const skip = body.indexOf("cmsAlreadyHealed(");
  const firstRead = body.indexOf("new ethers.Contract(");
  assert.ok(skip > 0 && firstRead > 0 && skip < firstRead);
  assert.match(body.slice(skip, firstRead), /return \{ healed: true, reason: "already_healed", anchor: healedAnchor \}/);
});

test("every column the heal writes is required by the skip condition", () => {
  const insert = source.slice(source.indexOf("insert into public.campaign_market_state("));
  const columns = insert
    .slice(insert.indexOf("(") + 1, insert.indexOf(")"))
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  // Keys, a write-once insert default, and the timestamp the heal bumps.
  const notState = new Set(["chain_id", "campaign_address", "pool_verified", "updated_at"]);
  for (const column of columns.filter((c) => !notState.has(c))) {
    assert.ok(skipSql.includes(`cms.${column}`), `skip condition misses cms.${column}`);
  }
  for (const venueColumn of ["wrapped_native_address", "dex_factory_address"]) {
    assert.ok(skipSql.includes(`cms.${venueColumn} is not null`), venueColumn);
  }
  for (const campaignsColumn of ["is_active = false", "bonding_active = false", "graduated_at_chain is not null"]) {
    assert.ok(skipSql.includes(`c.${campaignsColumn}`), campaignsColumn);
  }
  assert.ok(skipSql.includes("cms.indexing_enabled = true"));
  assert.ok(skipSql.includes("cms.last_error is null"));
});

test("a BONDING stage row is never skipped (the heal would move it to GRADUATING)", () => {
  assert.match(skipSql, /in \('GRADUATING', 'DEX_PENDING', 'DEX_ACTIVE', 'DEX_DEGRADED'\)/);
  assert.ok(!/'BONDING'/.test(skipSql));
});

test("a failed lookup falls through to the full heal", () => {
  const helper = source.slice(source.indexOf("async function cmsAlreadyHealed"), source.indexOf("export async function healRobinhoodGraduatedCms"));
  assert.match(helper, /catch \{[\s\S]*return null;/);
});

test("idle bonding coins: launched() at most once per interval, new logs force a re-check", async () => {
  const { skipBondingRecheck } = await import("../robinhoodCmsHealThrottle.js");
  const t0 = 1_000_000;
  assert.equal(skipBondingRecheck(undefined, t0, false, 600_000), false, "never checked: check");
  assert.equal(skipBondingRecheck(t0, t0 + 599_999, false, 600_000), true, "inside the interval: skip");
  assert.equal(skipBondingRecheck(t0, t0 + 600_000, false, 600_000), false, "interval over: check");
  assert.equal(skipBondingRecheck(t0, t0 + 1, true, 600_000), false, "new campaign logs: check now");
  assert.equal(skipBondingRecheck(t0, t0 + 1, false, 0), false, "interval 0 = old behaviour");
});

test("throttle sits after the already-healed check and before the first chain read; launched() result drives it", () => {
  const body = source.slice(source.indexOf("export async function healRobinhoodGraduatedCms"));
  const skip = body.indexOf("cmsAlreadyHealed(");
  const throttle = body.indexOf("skipBondingRecheck(");
  const firstRead = body.indexOf("new ethers.Contract(");
  assert.ok(skip < throttle && throttle < firstRead);
  assert.match(body, /if \(!launched\) \{\s*notLaunchedCheckedAt\.set\(throttleKey, Date\.now\(\)\);/);
  assert.match(body, /notLaunchedCheckedAt\.delete\(throttleKey\);/);
});

test("graduated coins keep their real graduation: the pass writes the heal's anchor, never head/now/zero hash", () => {
  const indexer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../indexer.ts"), "utf8");
  assert.ok(!indexer.includes("setCampaignGraduated(chain.chainId, camp, target, new Date(), ethers.ZeroHash)"));
  assert.match(indexer, /setCampaignGraduated\(chain\.chainId, camp, healed\.anchor\.block, healed\.anchor\.time, healed\.anchor\.txHash\)/);
  assert.match(source, /return \{ healed: true, reason: "seeded_graduating", pair, anchor \};/);
  assert.match(source, /return \{ healed: true, reason: "already_healed", anchor: healedAnchor \};/);
  // The scan forces the heal when it saw campaign logs.
  assert.match(indexer, /healRobinhoodGraduatedCms\(provider, chainId, campaign, tokenAddr, \{ force: sawCampaignLogs \}\)/);
});
