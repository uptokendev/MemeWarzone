// Safe pre-authorization runway alerts per pot, and the one Safe batch that renews both pots.
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  AUTH_RUNWAY_ALERT_KIND, RECOVERY_DUE_ALERT_KIND, alertWeeks, authorizationCovers, authorizationRunway,
  checkAirdropRunway, runwayVerdict, syncRecoveryDueAlert, syncRunwayAlert,
} from "./authorizationHorizon.mjs";
import { weeklyContractBatchId } from "./materialize.mjs";
import { epochWindow } from "./config.mjs";
import { airdropSetupCalls, firstWeekEnd, parseSetupArgs } from "../../../scripts/make-airdrop-setup-calls.mjs";

const WEEK = 7 * 86_400_000;
const NOW = new Date("2026-10-12T00:15:00Z"); // a Monday run
const CURRENT_END = new Date("2026-10-12T00:00:00Z"); // epoch 2026-10-05
const quiet = { log() {}, error() {} };

/** Authorizations for `weeks` weeks from CURRENT_END on a pot; week 0 optionally consumed. */
function authBook({ chainId = 56, pot = "main", weeks, consumedFirst = false, deadlineOffsetSec = 6 * 86_400 }) {
  const book = new Map();
  for (let w = 0; w < weeks; w += 1) {
    const end = new Date(CURRENT_END.getTime() + w * WEEK);
    const epochId = new Date(end.getTime() - WEEK).toISOString().slice(0, 10);
    for (const program of ["airdrop_trader", "airdrop_creator"]) {
      book.set(weeklyContractBatchId(chainId, epochId, program, pot), {
        authorized: true,
        consumed: consumedFirst && w === 0,
        publishDeadline: end.getTime() / 1000 + deadlineOffsetSec,
      });
    }
  }
  return (id) => book.get(id) || { authorized: false, consumed: false, publishDeadline: 0 };
}

test("authorizationCovers: consumed or authorized-and-not-past-deadline", () => {
  assert.equal(authorizationCovers(null, 10), false);
  assert.equal(authorizationCovers({ consumed: true }, 10), true);
  assert.equal(authorizationCovers({ authorized: true, publishDeadline: 10 }, 10), true);
  assert.equal(authorizationCovers({ authorized: true, publishDeadline: 9 }, 10), false);
  assert.equal(authorizationCovers({ authorized: false, publishDeadline: 99 }, 10), false);
});

test("runway counts consecutive covered weeks per pot; the other pot's ids do not count", async () => {
  const twelve = await authorizationRunway({ chainId: 56, currentEnd: CURRENT_END, now: NOW, readAuth: authBook({ weeks: 12, consumedFirst: true }) });
  assert.equal(twelve.coveredWeeks, 12);
  assert.equal(twelve.weeksAhead, 11);
  assert.equal(twelve.currentEpochId, "2026-10-05");
  assert.equal(twelve.lastCoveredEpochId, "2026-12-21");
  assert.equal(twelve.firstMissing.epochId, "2026-12-28");

  // Main-pot authorizations do not cover the gen-7 pot.
  const gen7 = await authorizationRunway({ chainId: 56, pot: "gen7", currentEnd: CURRENT_END, now: NOW, readAuth: authBook({ weeks: 12 }) });
  assert.equal(gen7.coveredWeeks, 0);
  assert.equal(gen7.firstMissing.missing.length, 2);
  const gen7Own = await authorizationRunway({ chainId: 56, pot: "gen7", currentEnd: CURRENT_END, now: NOW, readAuth: authBook({ pot: "gen7", weeks: 5 }) });
  assert.equal(gen7Own.coveredWeeks, 5);

  // A program missing in a week ends the runway there.
  const read = authBook({ weeks: 6 });
  const holey = await authorizationRunway({
    chainId: 56, currentEnd: CURRENT_END, now: NOW,
    readAuth: (id) => (id === weeklyContractBatchId(56, "2026-10-19", "airdrop_creator") ? null : read(id)),
  });
  assert.equal(holey.coveredWeeks, 2);
  assert.deepEqual(holey.firstMissing.missing.map((m) => m.program), ["airdrop_creator"]);
});

test("verdict thresholds: this week missing = critical; fewer than N weeks after it = warning; else ok", async () => {
  const at = async (weeks, pot = "main") => runwayVerdict(await authorizationRunway({ chainId: 4663, pot, currentEnd: CURRENT_END, now: NOW, readAuth: authBook({ chainId: 4663, pot, weeks }) }), 3);
  const none = await at(0, "gen7");
  assert.equal(none.level, "critical");
  assert.match(none.title, /gen-7 pot on chain 4663: this week \(2026-10-05\) is NOT pre-authorized/);
  assert.equal((await at(1)).level, "warning");
  assert.equal((await at(3)).level, "warning", "2 weeks after this one < 3");
  const four = await at(4);
  assert.equal(four.level, "ok", "3 weeks after this one = threshold");
  assert.equal((await at(4)).title, null);
  const warn = await at(3);
  assert.match(warn.title, /main pot on chain 4663: pre-authorization runs out after 2026-10-19/);
  assert.match(warn.message, /make-airdrop-setup-calls\.mjs --chain 4663/);
});

test("AIRDROP_AUTH_ALERT_WEEKS: default 3, clamped 1..26", () => {
  assert.equal(alertWeeks({}), 3);
  assert.equal(alertWeeks({ AIRDROP_AUTH_ALERT_WEEKS: "5" }), 5);
  assert.equal(alertWeeks({ AIRDROP_AUTH_ALERT_WEEKS: "0" }), 1);
  assert.equal(alertWeeks({ AIRDROP_AUTH_ALERT_WEEKS: "99" }), 26);
  assert.equal(alertWeeks({ AIRDROP_AUTH_ALERT_WEEKS: "x" }), 3);
});

function fakeClient() {
  const seen = [];
  return { seen, async query(sql, params) { seen.push({ sql, params }); return { rows: [] }; } };
}

test("syncRunwayAlert: resolves the pot's open runway alert, then writes a new one only when low; dry run writes nothing", async () => {
  const runway = await authorizationRunway({ chainId: 56, pot: "gen7", currentEnd: CURRENT_END, now: NOW, readAuth: authBook({ pot: "gen7", weeks: 2 }) });
  const client = fakeClient();
  const alerts = [];
  const writeAlert = async (_c, alert) => alerts.push(alert);
  const verdict = await syncRunwayAlert(client, { runway, threshold: 3, writeAlert, env: {}, log: quiet });
  assert.equal(verdict.level, "warning");
  assert.equal(client.seen.length, 1);
  assert.match(client.seen[0].sql, /set status='resolved'/);
  assert.deepEqual(client.seen[0].params, [AUTH_RUNWAY_ALERT_KIND, "56", "gen7"]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "warning");
  assert.equal(alerts[0].metadata.pot, "gen7");
  assert.equal(alerts[0].metadata.kind, AUTH_RUNWAY_ALERT_KIND);

  const ok = await authorizationRunway({ chainId: 56, currentEnd: CURRENT_END, now: NOW, readAuth: authBook({ weeks: 12 }) });
  const okClient = fakeClient();
  const okAlerts = [];
  await syncRunwayAlert(okClient, { runway: ok, threshold: 3, writeAlert: async (_c, a) => okAlerts.push(a), env: {}, log: quiet });
  assert.equal(okClient.seen.length, 1, "resolve only");
  assert.equal(okAlerts.length, 0);

  const dry = fakeClient();
  const dryAlerts = [];
  await syncRunwayAlert(dry, { runway, threshold: 3, writeAlert: async (_c, a) => dryAlerts.push(a), dryRun: true, env: {}, log: quiet });
  assert.equal(dry.seen.length, 0);
  assert.equal(dryAlerts.length, 0);
});

test("syncRecoveryDueAlert: expired money left in a pot's distributor raises a recovery alert naming the pot", async () => {
  const client = fakeClient();
  const alerts = [];
  await syncRecoveryDueAlert(client, { chainId: 4663, pot: "gen7", expired: [{ batchId: "0x1", label: "2026-08-03 airdrop_trader", unclaimed: 5n }], writeAlert: async (_c, a) => alerts.push(a), env: {}, log: quiet });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /gen-7 pot on chain 4663: 1 expired batch/);
  assert.match(alerts[0].message, /make-airdrop-recovery-batch\.ts/);
  assert.equal(alerts[0].metadata.kind, RECOVERY_DUE_ALERT_KIND);
  assert.equal(alerts[0].metadata.totalWei, "5");

  const none = fakeClient();
  const noAlerts = [];
  await syncRecoveryDueAlert(none, { chainId: 4663, pot: "gen7", expired: [], writeAlert: async (_c, a) => noAlerts.push(a), env: {}, log: quiet });
  assert.equal(noAlerts.length, 0);
  assert.deepEqual(none.seen[0].params, [RECOVERY_DUE_ALERT_KIND, "4663", "gen7"]);
});

test("checkAirdropRunway never throws: a pot whose read fails becomes a warning alert, the other pot is still checked", async () => {
  const client = fakeClient();
  const alerts = [];
  const results = await checkAirdropRunway(client, {
    chainId: 56,
    pots: [{ pot: "main", distributorAddress: null }, { pot: "gen7", distributorAddress: "0x2000000000000000000000000000000000000007" }],
    currentEnd: CURRENT_END,
    now: NOW,
    writeAlert: async (_c, a) => alerts.push(a),
    providerFor: () => { throw new Error("BSC_RPC_HTTP_56 is required"); },
    env: {},
    log: quiet,
  });
  assert.equal(results.length, 2);
  assert.match(results[0].error, /no distributor configured/);
  assert.match(results[1].error, /BSC_RPC_HTTP_56/);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every((a) => a.severity === "warning" && /pre-authorization check failed/.test(a.title)));
});

// ---------------------------------------------------------------------------- setup calls (one batch, both pots)

const MAIN_VAULT = "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e";
const MAIN_DIST = "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75";
const GEN7_VAULT = "0x1000000000000000000000000000000000000007";
const GEN7_DIST = "0x2000000000000000000000000000000000000007";
const OPERATOR = "0x1111111111111111111111111111111111111111";
const SETUP_NOW = new Date("2026-10-08T12:00:00Z"); // a Thursday

/** The script as it was before two pots (HEAD a20505de), for the byte-identity check. */
function legacyCalls({ chainId, vault, distributor, operator, cap, weeks, skipWiring, now }) {
  const DAY = 86_400;
  const calls = [];
  if (!skipWiring) {
    calls.push({ contract: "CommunityRewardsVault", to: vault, fn: "setRewardDistributor", args: [distributor] });
    calls.push({ contract: "CommunityRewardsVault", to: vault, fn: "setAirdropOperator", args: [operator] });
    calls.push({ contract: "RewardDistributor", to: distributor, fn: "setBatchOperator", args: [vault] });
  }
  const { end: lastEnded } = epochWindow(now);
  const firstEnd = lastEnded.getTime() / 1000 <= now.getTime() / 1000 ? lastEnded.getTime() / 1000 + 7 * DAY : lastEnded.getTime() / 1000;
  for (let week = 0; week < weeks; week += 1) {
    const end = firstEnd + week * 7 * DAY;
    const epochId = new Date((end - 7 * DAY) * 1000).toISOString().slice(0, 10);
    for (const program of ["airdrop_trader", "airdrop_creator"]) {
      calls.push({
        contract: "RewardDistributor", to: distributor, fn: "authorizeBatch",
        args: [keccak256(toUtf8Bytes(`mwz-weekly-airdrop:${chainId}:${epochId}:${program}`)), cap.toString(), String(end), String(end + 6 * DAY)],
        note: `${epochId} ${program}`,
      });
    }
  }
  return calls;
}

test("setup calls without gen-7 flags: byte-identical to the single-pot script (wired and --skip-wiring)", () => {
  for (const skipWiring of [false, true]) {
    const argv = ["--chain", "56", "--vault", MAIN_VAULT, "--distributor", MAIN_DIST, "--cap", "0.5", "--weeks", "12", ...(skipWiring ? ["--skip-wiring"] : ["--operator", OPERATOR])];
    const ours = airdropSetupCalls({ ...parseSetupArgs(argv), now: SETUP_NOW });
    const legacy = legacyCalls({ chainId: 56, vault: getAddress(MAIN_VAULT), distributor: getAddress(MAIN_DIST), operator: getAddress(OPERATOR), cap: 5n * 10n ** 17n, weeks: 12, skipWiring, now: SETUP_NOW });
    assert.equal(JSON.stringify(ours, null, 2), JSON.stringify(legacy, null, 2));
  }
});

test("setup calls with gen-7: one batch, main wiring, gen-7 wiring, main weeks, gen-7 weeks; ids per pot", () => {
  const argv = ["--chain", "4663", "--vault", MAIN_VAULT, "--distributor", MAIN_DIST, "--operator", OPERATOR, "--cap", "1.5", "--weeks", "12",
    "--gen7-vault", GEN7_VAULT, "--gen7-distributor", GEN7_DIST, "--gen7-cap", "0.5"];
  const calls = airdropSetupCalls({ ...parseSetupArgs(argv), now: SETUP_NOW });
  assert.equal(calls.length, 6 + 2 * 12 * 2);
  assert.deepEqual(calls.slice(0, 6).map((c) => [c.to, c.fn, c.args]), [
    [MAIN_VAULT, "setRewardDistributor", [MAIN_DIST]],
    [MAIN_VAULT, "setAirdropOperator", [OPERATOR]],
    [MAIN_DIST, "setBatchOperator", [MAIN_VAULT]],
    [GEN7_VAULT, "setRewardDistributor", [GEN7_DIST]],
    [GEN7_VAULT, "setAirdropOperator", [OPERATOR]],
    [GEN7_DIST, "setBatchOperator", [GEN7_VAULT]],
  ]);
  const main = calls.slice(6, 30);
  const gen7 = calls.slice(30);
  assert.ok(main.every((c) => c.to === MAIN_DIST && c.fn === "authorizeBatch" && c.args[1] === "1500000000000000000"));
  assert.ok(gen7.every((c) => c.to === GEN7_DIST && c.fn === "authorizeBatch" && c.args[1] === "500000000000000000"));
  assert.equal(main[0].args[0], weeklyContractBatchId(4663, "2026-10-05", "airdrop_trader"));
  assert.equal(gen7[0].args[0], weeklyContractBatchId(4663, "2026-10-05", "airdrop_trader", "gen7"));
  assert.equal(gen7[0].note, "2026-10-05 airdrop_trader (gen7 pot)");
  assert.deepEqual(main.map((c) => c.args.slice(2)), gen7.map((c) => c.args.slice(2)), "same publish windows");
  assert.equal(new Set(calls.filter((c) => c.fn === "authorizeBatch").map((c) => c.args[0])).size, 48, "no id twice");
  // The runway check reads exactly these ids: 12 authorized weeks = 11 ahead on the first draw, no alert.
  const book = new Map(gen7.map((c) => [c.args[0], { authorized: true, consumed: false, publishDeadline: Number(c.args[3]) }]));
  return authorizationRunway({ chainId: 4663, pot: "gen7", currentEnd: new Date(Number(gen7[0].args[2]) * 1000), now: new Date(Number(gen7[0].args[2]) * 1000 + 900_000), readAuth: (id) => book.get(id) }).then((r) => {
    assert.equal(r.coveredWeeks, 12);
    assert.equal(runwayVerdict(r, 3).level, "ok");
  });
});

test("setup calls: --wiring gen7 wires only the new pot (gen-7 deploy), --skip-wiring renews both, --from, guards", () => {
  const base = ["--chain", "56", "--vault", MAIN_VAULT, "--distributor", MAIN_DIST, "--operator", OPERATOR, "--cap", "0.5", "--weeks", "2", "--gen7-vault", GEN7_VAULT, "--gen7-distributor", GEN7_DIST];
  const deploy = airdropSetupCalls({ ...parseSetupArgs([...base, "--wiring", "gen7"]), now: SETUP_NOW });
  assert.deepEqual(deploy.filter((c) => c.fn !== "authorizeBatch").map((c) => c.to), [GEN7_VAULT, GEN7_VAULT, GEN7_DIST]);
  assert.equal(deploy.filter((c) => c.fn === "authorizeBatch").length, 8);
  const only = airdropSetupCalls({ ...parseSetupArgs([...base, "--wiring", "gen7", "--only", "gen7"]), now: SETUP_NOW });
  assert.equal(only.length, 3 + 4);
  assert.ok(only.every((c) => c.to === GEN7_VAULT || c.to === GEN7_DIST));
  assert.throws(() => parseSetupArgs(["--chain", "56", "--vault", MAIN_VAULT, "--distributor", MAIN_DIST, "--cap", "1", "--only", "gen7"]), /no such pot/);
  const renew = airdropSetupCalls({ ...parseSetupArgs([...base, "--skip-wiring"]), now: SETUP_NOW });
  assert.equal(renew.length, 8);
  assert.ok(renew.every((c) => c.fn === "authorizeBatch"));
  const from = airdropSetupCalls({ ...parseSetupArgs([...base, "--skip-wiring", "--from", "2026-12-28"]), now: SETUP_NOW });
  assert.equal(from[0].note, "2026-12-28 airdrop_trader");
  assert.equal(firstWeekEnd({ from: "2026-12-28" }), Date.parse("2027-01-04T00:00:00Z") / 1000);
  assert.throws(() => firstWeekEnd({ from: "2026-12-29" }), /Monday/);
  assert.throws(() => parseSetupArgs([...base.slice(0, -2)]), /go together/);
  assert.throws(() => parseSetupArgs(["--chain", "56", "--vault", MAIN_VAULT, "--distributor", MAIN_DIST, "--cap", "1", "--wiring", "gen7"]), /needs --gen7-vault/);
  assert.throws(() => airdropSetupCalls({ ...parseSetupArgs([...base.slice(0, -4), "--gen7-vault", MAIN_VAULT, "--gen7-distributor", GEN7_DIST]), now: SETUP_NOW }), /used twice/);
  assert.throws(() => airdropSetupCalls({ ...parseSetupArgs(["--chain", "56", "--vault", MAIN_VAULT, "--distributor", MAIN_DIST, "--cap", "1", "--gen7-vault", GEN7_VAULT, "--gen7-distributor", GEN7_DIST]), now: SETUP_NOW }), /--operator/);
  assert.equal(airdropSetupCalls({ ...parseSetupArgs([...base.filter((_, i) => i !== base.indexOf("--weeks") && i !== base.indexOf("--weeks") + 1), "--skip-wiring", "--weeks", "40"]), now: SETUP_NOW }).length, 2 * 26 * 2, "max 26 weeks");
});
