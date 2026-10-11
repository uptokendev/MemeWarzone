// Gen-8 timed launch from a draft (draftGen8Schedule.js): the time is stored on the draft, nothing on chain; refusals
// for chains without gen-8, live drafts, unpublished drafts, the 5 min / 30 day window and non-gen-8 targets.
import assert from "node:assert/strict";
import test from "node:test";
import { Gen8ScheduleError, scheduleGen8Draft } from "./draftGen8Schedule.js";

const ENV = { EVM_GEN8_LAUNCHER_56: "0x00000000000000000000000000000000000000c8", EVM_GEN8_HOOK_56: "0x0000000000000000000000000000000000002aec" };
const NOW = 1_900_000_000;
const row = (over = {}) => ({ id: "d1", chain_id: 56, status: "promotion_published", campaign_address: null, ticker: "GEIGHT", ...over });
function fakeDb(returning = true) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: returning ? [{ id: "d1", chain_id: 56, status: "scheduled", scheduled_launch_at: params[1], graduation_target_wei: params[2] }] : [] }; } };
}

test("stores the launch time and the gen-8 target; nothing else changes", async () => {
  const db = fakeDb();
  let notified = null;
  const out = await scheduleGen8Draft({ body: { scheduledLaunchAt: NOW + 3600, graduationTargetWei: (30_000n * 10n ** 18n).toString() }, row: row(), db, env: ENV, nowSec: NOW, notify: async (r, at) => { notified = at; } });
  assert.equal(out.scheduledLaunchAt, new Date((NOW + 3600) * 1000).toISOString());
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /set status = 'scheduled'/);
  assert.match(db.calls[0].sql, /campaign_address is null/);
  assert.deepEqual(db.calls[0].params, ["d1", out.scheduledLaunchAt, (30_000n * 10n ** 18n).toString()]);
  assert.equal(notified, out.scheduledLaunchAt);
  const keep = fakeDb();
  await scheduleGen8Draft({ body: { scheduledLaunchAt: NOW + 600 }, row: row({ status: "scheduled" }), db: keep, env: ENV, nowSec: NOW });
  assert.equal(keep.calls[0].params[2], null, "no target sent: the draft's own target stays");
});

test("refusals", async () => {
  const code = async (args, expected) => assert.rejects(scheduleGen8Draft({ db: fakeDb(), env: ENV, nowSec: NOW, row: row(), body: { scheduledLaunchAt: NOW + 3600 }, ...args }), (e) => e instanceof Gen8ScheduleError && e.code === expected, expected);
  await code({ env: {} }, "GEN8_NOT_CONFIGURED");
  await code({ row: row({ chain_id: 97 }) }, "GEN8_NOT_CONFIGURED");
  await code({ row: row({ campaign_address: "0xabc" }) }, "DRAFT_ALREADY_DEPLOYED");
  await code({ row: row({ status: "draft" }) }, "DRAFT_NOT_READY");
  await code({ body: { scheduledLaunchAt: NOW + 60 } }, "SCHEDULE_TOO_SOON");
  await code({ body: { scheduledLaunchAt: NOW + 31 * 24 * 3600 } }, "SCHEDULE_TOO_FAR");
  await code({ body: { scheduledLaunchAt: NOW + 3600, graduationTargetWei: (15_000n * 10n ** 18n).toString() } }, "GEN8_TARGET_UNSUPPORTED");
  await code({ db: fakeDb(false) }, "DRAFT_ALREADY_DEPLOYED");
});

test("audit B-02 / F7: the gen-8 schedule refuses loose wallet forms and non-canary creators", async () => {
  const { refuseGen8ScheduleForCanary } = await import("./draftGen8Schedule.js");
  const CANARY = "0x9999999999999999999999999999999999999999";
  const OUTSIDER = "0x1234567890123456789012345678901234567890";
  const env = { CREATE_CANARY_WALLETS: CANARY };
  const res = () => ({ statusCode: 0, body: null, setHeader() {}, end(s) { this.body = JSON.parse(s); } });
  for (const loose of [OUTSIDER.slice(2), ` ${OUTSIDER}`, "XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS", "", null]) {
    const r = res();
    assert.equal(refuseGen8ScheduleForCanary(r, loose, env), true, String(loose));
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.code, "GEN8_WALLET_INVALID");
  }
  const outsider = res();
  assert.equal(refuseGen8ScheduleForCanary(outsider, OUTSIDER, env), true);
  assert.equal(outsider.statusCode, 403);
  assert.equal(outsider.body.code, "CREATE_CANARY_ONLY");
  assert.equal(refuseGen8ScheduleForCanary(res(), CANARY, env), false, "the canary wallet may schedule");
  assert.equal(refuseGen8ScheduleForCanary(res(), OUTSIDER, {}), false, "canary off: everyone may schedule");
});
