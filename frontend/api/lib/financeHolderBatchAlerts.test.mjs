// Holder batch alerts for both creator vaults (gen-6 and gen-7's own): a weekly Safe approval left waiting, a batch
// out of retries or stuck, and the holder distributor's pre-authorizations running out N weeks ahead.
import assert from "node:assert/strict";
import test from "node:test";
import { id as keccakId } from "ethers";
import {
  readPayoutWatchdog,
  batchAuthorizationCallData,
  decodeBatchAuthorization,
  holderBatchAlerts,
  holderBatchIdFor,
  holderWeekOf,
  readPreauthorizedWeeks,
} from "./financeHolderBatchAlerts.js";

const NOW = Date.parse("2026-10-08T12:00:00Z"); // Thursday; week 2026-10-05
const V6 = "0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66";
const D6 = "0xD106198Ca83c26f4B43c9DF7368F134f0Cd46cc1";
const V7 = "0x2222222222222222222222222222222222222222";
const D7 = "0x3333333333333333333333333333333333333333";
const LANES = [
  { label: "gen-6", vault: V6, distributor: D6, program: "airdrop_holders" },
  { label: "gen-7", vault: V7, distributor: D7, program: "airdrop_holders_gen7" },
];

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
function authHex({ max = 10n ** 18n, after = 0, deadline = 0, authorized = false, consumed = false } = {}) {
  return `0x${word(max)}${word(after)}${word(deadline)}${word(authorized ? 1 : 0)}${word(consumed ? 1 : 0)}`;
}

/** Distributor reader: `covered` = { [distributor]: number of authorized weeks from the current one }. */
function reader(covered, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async readEvmCall({ to, data }) {
      calls.push({ to, data });
      if (fail) throw new Error("rpc down");
      const lane = LANES.find((l) => l.distributor.toLowerCase() === String(to).toLowerCase());
      for (let i = 0; i < 12; i += 1) {
        const week = holderWeekOf(NOW + i * 7 * 86_400_000);
        if (batchAuthorizationCallData(holderBatchIdFor(56, week.weekId, lane.program)) === data) {
          const end = week.endMs / 1000;
          return { hex: i < (covered[lane.distributor] ?? 0) ? authHex({ after: end, deadline: end + 6 * 86_400, authorized: true }) : authHex(), rpc: "fake" };
        }
      }
      throw new Error("unexpected call");
    },
  };
}

function db({ batches = [], holderCoins = {}, watchdog = null, watchdogAlerts = [] } = {}) {
  return {
    async query(sql, params) {
      assert.match(sql.trim(), /^select/i);
      if (/from public\.payout_watchdog_state/.test(sql)) return { rows: watchdog ? [watchdog] : [] };
      if (/reward_type = 'payout_watchdog'/.test(sql)) return { rows: watchdogAlerts };
      if (/from public\.evm_holder_batches/.test(sql)) return { rows: batches.filter((b) => b.vault_address === params[1]) };
      if (/from public\.evm_campaign_gen5_state/.test(sql)) return { rows: [{ n: holderCoins[params[1]] ?? 0 }] };
      return { rows: [] };
    },
  };
}

const registry = { holderLanes: LANES };
const ctxOf = (r) => ({ urls: ["fake"], readers: { readEvmCall: r.readEvmCall }, fetchImpl: null });

test("batch ids and the authorization call match the worker and the contract", () => {
  assert.equal(holderBatchIdFor(56, "2026-10-05"), keccakId("mwz-weekly-airdrop:56:2026-10-05:airdrop_holders"));
  assert.equal(holderBatchIdFor(56, "2026-10-05", "airdrop_holders_gen7"), keccakId("mwz-weekly-airdrop:56:2026-10-05:airdrop_holders_gen7"));
  assert.equal(batchAuthorizationCallData(`0x${"ab".repeat(32)}`).slice(0, 10), keccakId("batchAuthorization(bytes32)").slice(0, 10));
  assert.deepEqual(decodeBatchAuthorization(authHex({ max: 5n, after: 1, deadline: 2, authorized: true })), { maxAmount: 5n, publishAfter: 1, publishDeadline: 2, authorized: true, consumed: false });
  assert.throws(() => decodeBatchAuthorization("0x1234"), /malformed/);
  assert.equal(holderWeekOf(NOW).weekId, "2026-10-05");
});

test("pre-authorization coverage counts consecutive live weeks from the current one", async () => {
  const r = reader({ [D7]: 5 });
  const cov = await readPreauthorizedWeeks({ readEvmCall: r.readEvmCall, urls: [], chainId: 56, distributor: D7, program: "airdrop_holders_gen7", nowMs: NOW });
  assert.deepEqual(cov, { covered: 5, lastWeek: "2026-11-02", firstWeek: "2026-10-05", anyAuthorized: true });
  assert.equal(r.calls.length, 6, "stops at the first gap");
});

test("plenty authorized and nothing waiting: no alert, for either vault", async () => {
  const r = reader({ [D6]: 12, [D7]: 12 });
  const out = await holderBatchAlerts({ db: db(), ctx: ctxOf(r), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(out, []);
});

test("authorizations run out: a warning N weeks ahead (default 3, FINANCE_HOLDER_PREAUTH_WARN_WEEKS), naming the vault and the last week", async () => {
  const r = reader({ [D6]: 12, [D7]: 2 });
  const out = await holderBatchAlerts({ db: db(), ctx: ctxOf(r), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].level, "warning");
  assert.match(out[0].message, /gen-7 holder distributor 0x3333…3333 run out after week 2026-10-12 \(2 weeks left, alert at 3\)/);
  assert.doesNotMatch(out[0].message, /—/, "no em dashes");
  const quiet = await holderBatchAlerts({ db: db(), ctx: ctxOf(reader({ [D6]: 12, [D7]: 2 })), registry, chainId: 56, env: { FINANCE_HOLDER_PREAUTH_WARN_WEEKS: "2" }, nowMs: NOW });
  assert.deepEqual(quiet, []);
});

test("nothing pre-authorized: a warning when the vault has holders or split coins, info when it has none", async () => {
  const out = await holderBatchAlerts({ db: db({ holderCoins: { [V7.toLowerCase()]: 3 } }), ctx: ctxOf(reader({ [D6]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].level, "warning");
  assert.match(out[0].message, /No holder batch is pre-authorized on the gen-7 holder distributor .* from week 2026-10-05\. 3 holders or split coins use this vault/);
  const none = await holderBatchAlerts({ db: db(), ctx: ctxOf(reader({ [D6]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(none[0].level, "info");
});

test("a proposed batch waiting for the Safe: warning after 24 h, critical after 4 days; with the verify command for that vault", async () => {
  const b = (vault, created, reason) => ({ vault_address: vault.toLowerCase(), week_id: "2026-09-28", batch_id: "0xb", status: "proposed", attempt: 0, last_reason: reason, created_at: created, updated_at: created });
  const fresh = await holderBatchAlerts({ db: db({ batches: [b(V7, "2026-10-08T00:05:00Z", "waiting for the Safe to approve this root and total")] }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(fresh, [], "under 24 h");
  const late = await holderBatchAlerts({ db: db({ batches: [b(V7, "2026-10-06T00:05:00Z", "waiting for the Safe to approve this root and total")] }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(late.length, 1);
  assert.equal(late[0].level, "warning");
  assert.match(late[0].message, /Holder batch 2026-09-28 of the gen-7 creator vault 0x2222…2222 has waited 59 h: waiting for the Safe to approve/);
  assert.match(late[0].message, /--file "https:\/\/api\.memewar\.zone\/api\/evm\/holder-batch\?chainId=56&weekId=2026-09-28&vault=0x2222222222222222222222222222222222222222"/);
  const old = await holderBatchAlerts({ db: db({ batches: [b(V6, "2026-10-03T00:05:00Z", "waiting for the Safe to authorize the batch on the holder distributor")] }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(old[0].level, "critical");
  assert.match(old[0].message, /gen-6 creator vault/);
  // The veto window is not the Safe's to act on: no alert.
  const window = await holderBatchAlerts({ db: db({ batches: [b(V6, "2026-10-03T00:05:00Z", "approved; waiting for the 24 h veto window")] }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(window, []);
});

test("out of retries: critical; a batch the worker has not moved for 6 h: warning", async () => {
  const rows = [
    { vault_address: V6.toLowerCase(), week_id: "2026-09-21", batch_id: "0xa", status: "failed", attempt: 1000, last_reason: "the proposal on chain does not match the published leaf file: veto it", created_at: "2026-09-28T00:05:00Z", updated_at: "2026-09-28T00:06:00Z" },
    { vault_address: V7.toLowerCase(), week_id: "2026-09-28", batch_id: "0xb", status: "proposing", attempt: 0, last_reason: null, created_at: "2026-10-08T00:05:00Z", updated_at: "2026-10-08T01:00:00Z" },
  ];
  const out = await holderBatchAlerts({ db: db({ batches: rows }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(out.map((a) => a.level), ["critical", "warning"]);
  assert.match(out[0].message, /out of retries/);
  assert.match(out[1].message, /'proposing' for 11 h/);
  // A failed batch with retries left is the worker's job: no alert.
  rows[0].attempt = 1;
  const retry = await holderBatchAlerts({ db: db({ batches: rows.slice(0, 1) }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(retry, []);
});

test("unreadable chain or database: a warning, never silence and never a throw; a missing table is nothing", async () => {
  const out = await holderBatchAlerts({ db: db(), ctx: ctxOf(reader({}, { fail: true })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(out.length, 2);
  assert.ok(out.every((a) => a.level === "warning" && /could not be read/.test(a.message)));
  const missing = { async query(sql) { if (/evm_holder_batches/.test(sql)) throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); return { rows: [{ n: 0 }] }; } };
  const quiet = await holderBatchAlerts({ db: missing, ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(quiet, []);
  assert.deepEqual(await holderBatchAlerts({ db: db(), ctx: ctxOf(reader({})), registry: { holderLanes: [] }, chainId: 56, env: {}, nowMs: NOW }), []);
});

// ------------------------------------------------------------------------------------ payout watchdog (Safe module)

const WATCH = (over = {}) => ({ watchdog_address: "0xw", roles_address: "0xr", send: true, module_enabled: true, role_ok: true, last_tick_at: new Date(NOW - 2 * 60_000).toISOString(), last_ok_at: null, last_error: null, status: { weeks: 12 }, ...over });
const bWait = (vault, created) => ({ vault_address: vault.toLowerCase(), week_id: "2026-10-05", batch_id: "0xb", status: "proposed", attempt: 0, last_reason: "waiting for the Safe to approve this root and total", created_at: created, updated_at: created });

test("watchdog active: a proposed batch is its job; alert (critical) only when it has not approved within the grace", async () => {
  const r = reader({ [D6]: 12, [D7]: 12 });
  const quiet = await holderBatchAlerts({ db: db({ watchdog: WATCH(), batches: [bWait(V6, "2026-10-08T11:00:00Z")] }), ctx: ctxOf(r), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(quiet, [], "1 h: the watchdog has time");
  const late = await holderBatchAlerts({ db: db({ watchdog: WATCH(), batches: [bWait(V6, "2026-10-08T09:00:00Z")] }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(late.length, 1);
  assert.equal(late[0].level, "critical");
  assert.match(late[0].message, /payout watchdog has not approved it/);
  assert.match(late[0].message, /evm-holder-batch-verify\.mjs --chain 56/);
  assert.doesNotMatch(late[0].message, /—/);
  const env = await holderBatchAlerts({ db: db({ watchdog: WATCH(), batches: [bWait(V6, "2026-10-08T09:00:00Z")] }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: { PAYOUT_WATCHDOG_APPROVE_GRACE_HOURS: "6" }, nowMs: NOW });
  assert.deepEqual(env, []);
});

test("watchdog active: the runway alert fires only when it falls 2 weeks behind its horizon (critical under the warn weeks)", async () => {
  assert.deepEqual(await holderBatchAlerts({ db: db({ watchdog: WATCH() }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 10 })), registry, chainId: 56, env: {}, nowMs: NOW }), []);
  const behind = await holderBatchAlerts({ db: db({ watchdog: WATCH() }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 9 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(behind.length, 1);
  assert.equal(behind[0].level, "warning");
  assert.match(behind[0].message, /although the payout watchdog keeps 12: it is not authorizing/);
  const gone = await holderBatchAlerts({ db: db({ watchdog: WATCH() }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 2 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(gone[0].level, "critical");
});

test("watchdog heartbeat: stale = down (critical) and the Safe-by-hand rules apply again; dry run = info; its own alerts listed", async () => {
  const stale = WATCH({ last_tick_at: new Date(NOW - 60 * 60_000).toISOString() });
  const down = await holderBatchAlerts({ db: db({ watchdog: stale, batches: [bWait(V6, "2026-10-08T09:00:00Z")] }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 2 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.equal(down[0].level, "critical");
  assert.match(down[0].message, /payout watchdog on chain 56 is down: last heartbeat 60 min ago/);
  // 3 h waiting is under the Safe's own 24 h rule; the gen-7 runway warning is the old one.
  assert.equal(down.length, 2);
  assert.match(down[1].message, /run out after week 2026-10-12 \(2 weeks left, alert at 3\)/);
  const dry = await holderBatchAlerts({ db: db({ watchdog: WATCH({ send: false }) }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(dry.map((a) => a.level), ["info"]);
  const disabled = await holderBatchAlerts({ db: db({ watchdog: WATCH({ module_enabled: false }) }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.match(disabled[0].message, /Roles module is not enabled on the Safe/);
  const own = await holderBatchAlerts({ db: db({ watchdog: WATCH(), watchdogAlerts: [{ severity: "critical", title: "Payout watchdog on chain 56: holder batch 0xab… does NOT match", message: "root differs" }] }), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: {}, nowMs: NOW });
  assert.deepEqual(own.map((a) => a.level), ["critical"]);
  assert.match(own[0].message, /does NOT match\. root differs/);
  const expected = await holderBatchAlerts({ db: db(), ctx: ctxOf(reader({ [D6]: 12, [D7]: 12 })), registry, chainId: 56, env: { PAYOUT_WATCHDOG_EXPECTED_56: "true" }, nowMs: NOW });
  assert.match(expected[0].message, /never reported on chain 56/);
  const state = await readPayoutWatchdog(db({ watchdog: WATCH() }), 56, { env: {}, nowMs: NOW });
  assert.equal(state.active, true);
  assert.equal(state.weeks, 12);
});
