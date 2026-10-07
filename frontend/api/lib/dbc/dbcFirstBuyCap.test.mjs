import assert from "node:assert/strict";
import test from "node:test";
import { DBC_FIRST_BUY_MAX_BPS, DBC_FIRST_BUY_PARTNER_MAX_BPS } from "../../../shared/dbcEconomics.mjs";
import { EVM_FIRST_BUY_MAX_SUPPLY_BPS } from "../../../src/lib/evmGen6.mjs";
import { firstBuyCapSettings, loadCreatorFirstBuyCapBps } from "./dbcFirstBuyCap.js";

const W = "7MQwAJMMF2JvY7WZsphtxhxRc5uZo62z6JPHs4dc3pyX";
const dbWith = (rows, seen = []) => ({ async query(sql, params) { seen.push({ sql, params }); return { rows }; } });

test("founder 2026-10-07: 60% for every creator, 70% ceiling for listed ones; EVM stays at its contract's 10%", () => {
  assert.equal(DBC_FIRST_BUY_MAX_BPS, 6000);
  assert.equal(DBC_FIRST_BUY_PARTNER_MAX_BPS, 7000);
  assert.equal(EVM_FIRST_BUY_MAX_SUPPLY_BPS, 1000n, "LaunchCampaign.CREATOR_FIRST_BUY_MAX_SUPPLY_BPS is fixed on-chain");
});

test("an unlisted creator gets the default", async () => {
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([]), W), 6000);
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([]), ""), 6000);
});

test("a listed creator gets their cap, looked up by chain and exact base58 wallet", async () => {
  const seen = [];
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([{ max_bps: 7000 }], seen), W), 7000);
  assert.deepEqual(seen[0].params, [101, W]);
  assert.match(seen[0].sql, /from public\.creator_first_buy_caps where chain_id = \$1 and wallet = \$2/);
});

test("a row can never lower the default or lift past the ceiling", async () => {
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([{ max_bps: 500 }]), W), 6000);
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([{ max_bps: 9000 }]), W), 7000);
});

test("no table yet, or a failed read, falls back to the default and never to a higher cap", async () => {
  const missing = { async query() { throw Object.assign(new Error('relation "creator_first_buy_caps" does not exist'), { code: "42P01" }); } };
  assert.equal(await loadCreatorFirstBuyCapBps(missing, W), 6000);
  const broken = { async query() { throw new Error("connection reset"); } };
  assert.equal(await loadCreatorFirstBuyCapBps(broken, W), 6000);
});

test("each listed wallet gets its own share between the default and the ceiling", async () => {
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([{ max_bps: 6500 }]), W), 6500);
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([{ max_bps: 7000 }]), W), 7000);
});

test("default and ceiling can be changed on the API without a release", async () => {
  const env = { DBC_FIRST_BUY_DEFAULT_BPS: "1500", DBC_FIRST_BUY_PARTNER_MAX_BPS: "4000" };
  assert.deepEqual(firstBuyCapSettings(env), { defaultBps: 1500, ceilingBps: 4000 });
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([]), W, { env }), 1500);
  assert.equal(await loadCreatorFirstBuyCapBps(dbWith([{ max_bps: 5000 }]), W, { env }), 4000);
  // Unset, malformed or out of range settings fall back to 60% / 70%; the ceiling is never below the default.
  assert.deepEqual(firstBuyCapSettings({}), { defaultBps: 6000, ceilingBps: 7000 });
  assert.deepEqual(firstBuyCapSettings({ DBC_FIRST_BUY_DEFAULT_BPS: "abc", DBC_FIRST_BUY_PARTNER_MAX_BPS: "20000" }), { defaultBps: 6000, ceilingBps: 7000 });
  assert.deepEqual(firstBuyCapSettings({ DBC_FIRST_BUY_DEFAULT_BPS: "3000", DBC_FIRST_BUY_PARTNER_MAX_BPS: "2500" }), { defaultBps: 3000, ceilingBps: 3000 });
});
