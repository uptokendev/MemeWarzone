import assert from "node:assert/strict";
import test from "node:test";
import { createEvmMilestoneProgress, type EvmMilestoneView } from "../evm/evmMilestoneProgress.js";
import { checkMilestones } from "../milestones.js";

const WAD = 10n ** 18n;
const CAMPAIGN = "0xAbCdEf0000000000000000000000000000000001";

/** Answers the progress query with one row; records every query. */
function progressDb(row: { campaign_generation: number | null; net_raised_raw: string; sold_raw: string }) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    db: {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        return { rows: [row] };
      },
    },
  };
}

function reader(values: Partial<Record<EvmMilestoneView, bigint | Error>>) {
  const calls: Array<[number, string, EvmMilestoneView]> = [];
  return {
    calls,
    read: async (chainId: number, campaign: string, view: EvmMilestoneView) => {
      calls.push([chainId, campaign, view]);
      const v = values[view];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`unexpected view ${view}`);
      return v;
    },
  };
}

test("gen-6 (campaign generation 5): net raise from gross_raw / graduationNativeTarget(), target cached 60 s", async () => {
  const { db, queries } = progressDb({ campaign_generation: 5, net_raised_raw: (30n * WAD).toString(), sold_raw: "0" });
  const r = reader({ graduationNativeTarget: 40n * WAD });
  let now = 1_000_000;
  const progressFor = createEvmMilestoneProgress({ db, read: r.read, now: () => now });
  assert.deepEqual(await progressFor(56, CAMPAIGN), { progressPct: 75 });
  assert.match(queries[0].sql, /coalesce\(gross_raw, bnb_amount_raw::numeric\)/, "same basis as the keeper due filter");
  assert.deepEqual(queries[0].params, [56, CAMPAIGN.toLowerCase()]);
  now += 59_000;
  await progressFor(56, CAMPAIGN);
  assert.equal(r.calls.length, 1, "one eth_call per TTL");
  now += 2_000;
  await progressFor(56, CAMPAIGN);
  assert.equal(r.calls.length, 2, "re-read after the TTL (the oracle moves the target)");
  assert.deepEqual(r.calls[0], [56, CAMPAIGN.toLowerCase(), "graduationNativeTarget"]);
});

test("gen-7 (campaign generation 6): sold / curveSupply(), curveSupply cached forever", async () => {
  const curveSupply = 850_000_000n * WAD;
  const { db } = progressDb({ campaign_generation: 6, net_raised_raw: (999n * WAD).toString(), sold_raw: ((curveSupply * 95n) / 100n).toString() });
  const r = reader({ curveSupply });
  let now = 0;
  const progressFor = createEvmMilestoneProgress({ db, read: r.read, now: () => now });
  assert.deepEqual(await progressFor(46630, CAMPAIGN), { progressPct: 95 });
  now += 10 * 24 * 3600_000;
  await progressFor(46630, CAMPAIGN);
  assert.deepEqual(r.calls.map((c) => c[2]), ["curveSupply"], "read once, never graduationNativeTarget");
});

test("older campaigns (generation null or below 5): graduationNativeTarget(), never graduationTarget()", async () => {
  for (const generation of [null, 3]) {
    const { db } = progressDb({ campaign_generation: generation, net_raised_raw: (10n * WAD).toString(), sold_raw: "0" });
    const r = reader({ graduationNativeTarget: 100n * WAD });
    const progressFor = createEvmMilestoneProgress({ db, read: r.read });
    assert.deepEqual(await progressFor(97, CAMPAIGN), { progressPct: 10 });
    assert.deepEqual(r.calls.map((c) => c[2]), ["graduationNativeTarget"]);
  }
});

test("a failed or zero read gives null and is not retried within the TTL", async () => {
  const { db } = progressDb({ campaign_generation: 5, net_raised_raw: (30n * WAD).toString(), sold_raw: "0" });
  const r = reader({ graduationNativeTarget: new Error("oracle stale") });
  let now = 0;
  const progressFor = createEvmMilestoneProgress({ db, read: r.read, now: () => now });
  assert.equal(await progressFor(56, CAMPAIGN), null);
  assert.equal(await progressFor(56, CAMPAIGN), null);
  assert.equal(r.calls.length, 1);
  now += 60_000;
  await progressFor(56, CAMPAIGN);
  assert.equal(r.calls.length, 2);

  const zero = createEvmMilestoneProgress({ db, read: reader({ graduationNativeTarget: 0n }).read });
  assert.equal(await zero(56, CAMPAIGN), null);
  const gen7 = progressDb({ campaign_generation: 6, net_raised_raw: "0", sold_raw: "1" });
  assert.equal(await createEvmMilestoneProgress({ db: gen7.db, read: reader({ curveSupply: new Error("revert") }).read })(4663, CAMPAIGN), null);
});

/** A db for checkMilestones: the raised sum, then notification marker/outbox inserts. */
function milestoneDb(raised: number) {
  const thresholds: number[] = [];
  return {
    thresholds,
    db: {
      async query(sql: string, params: unknown[] = []) {
        if (/sum\(case when side = 'buy' then bnb_amount else -bnb_amount end\)/.test(sql)) return { rows: [{ raised }], rowCount: 1 };
        if (/notification_markers/.test(sql)) return { rows: [], rowCount: 1 };
        if (/notification_outbox/.test(sql)) {
          const envelope = JSON.parse(String(params[3]));
          thresholds.push(Number(envelope.payload?.threshold ?? envelope.threshold));
          return { rows: [{ id: 1 }], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    } as any,
  };
}

test("checkMilestones: EVM uses progressFor; null or missing progressFor sends nothing (no 50-native fallback)", async () => {
  const evm = milestoneDb(49);
  await checkMilestones(evm.db, 56, CAMPAIGN, async () => ({ progressPct: 86 }));
  assert.deepEqual(evm.thresholds, [75, 85]);

  const failed = milestoneDb(49);
  await checkMilestones(failed.db, 56, CAMPAIGN, async () => null);
  assert.deepEqual(failed.thresholds, [], "a failed read sends no alert");

  const none = milestoneDb(49);
  await checkMilestones(none.db, 4663, CAMPAIGN);
  assert.deepEqual(none.thresholds, [], "no progressFor, no EVM alert (the old rule would have sent 75/85/95 at 49 of 50)");
});

test("checkMilestones: Solana unchanged, raised / 85 and progressFor never called", async () => {
  const sol = milestoneDb(81);
  let called = false;
  await checkMilestones(sol.db, 101, "SoLCampaign111", async () => {
    called = true;
    return { progressPct: 0 };
  });
  assert.equal(called, false);
  assert.deepEqual(sol.thresholds, [75, 85, 95], "81 / 85 = 95.3%");
});
