import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../robinhoodCmsHeal.ts"), "utf8");
const skipSql = source.slice(source.indexOf("export const CMS_ALREADY_HEALED_SQL"), source.indexOf("async function cmsAlreadyHealed"));

test("the already-healed check runs before any chain read", () => {
  const body = source.slice(source.indexOf("export async function healRobinhoodGraduatedCms"));
  const skip = body.indexOf("cmsAlreadyHealed(");
  const firstRead = body.indexOf("new ethers.Contract(");
  assert.ok(skip > 0 && firstRead > 0 && skip < firstRead);
  assert.match(body.slice(skip, firstRead), /return \{ healed: true, reason: "already_healed" \}/);
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
  assert.match(helper, /catch \{[\s\S]*return false;/);
});
