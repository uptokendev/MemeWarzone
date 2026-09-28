import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";
process.env.SOLANA_RPC_HTTP ||= "http://127.0.0.1:8899";

const {
  creatorFeeModeFromChoice,
  profileFromLink,
  slicesConserve,
  splitDbcCollectorFee,
  routedLamports,
} = await import("../dbc/dbcFeeSplit.js");
const { rewardEventRow, resolveTraderProfile } = await import("../dbc/dbcFeeAccruals.js");
const { CLAIM_RECONCILE_TOLERANCE_LAMPORTS, quoteVaultOutflow } = await import("../dbc/dbcFeeClaimer.js");
const {
  CollectorShortError,
  buildRouteTransfers,
  rewardVaults,
  routeClaimedAccruals,
  sumClaimedSlices,
} = await import("../dbc/dbcFeeRouter.js");
const { referralSweepKeepsAccount } = await import("../dbc/dbcReferralSweep.js");

const F = {
  tradingFee: 320_000n,
  protocolFee: 80_000n,
  referralFee: 0n,
};

test("linked / OG / unlinked slices of a 2% fee, creator mode", () => {
  const linked = splitDbcCollectorFee({ ...F, mode: "creator", profile: "standard_linked" });
  const og = splitDbcCollectorFee({ ...F, mode: "creator", profile: "og_linked" });
  const unlinked = splitDbcCollectorFee({ ...F, mode: "creator", profile: "standard_unlinked" });
  assert.equal(linked.feeTotal, 400_000n);
  assert.equal(linked.collectorAmount, 297_600n); // 320000 - 7%
  assert.equal(linked.leagueWeekly + linked.leagueMonthly, 150_000n);
  assert.equal(linked.recruiter, 50_000n);
  assert.equal(linked.squad, 10_000n);
  assert.equal(linked.airdrop, 0n);
  assert.equal(og.recruiter, 60_000n);
  assert.equal(og.squad, 10_000n);
  assert.equal(unlinked.recruiter, 0n);
  assert.equal(unlinked.squad, 0n);
  assert.equal(unlinked.airdrop, 60_000n);
  for (const row of [linked, og, unlinked]) {
    assert.equal(slicesConserve(row), true);
    assert.ok(row.protocol >= 0n);
  }
});

test("platform mode sets aside 7% as creator pool; collector gets the whole trading fee", () => {
  const platform = splitDbcCollectorFee({ ...F, mode: "platform", profile: "standard_linked" });
  assert.equal(platform.collectorAmount, 320_000n);
  assert.equal(platform.creatorPool, 22_400n);
  assert.equal(slicesConserve(platform), true);
  assert.equal(routedLamports(platform) + platform.creatorPool, platform.collectorAmount);
});

test("sniper fee (50%) splits the same way", () => {
  const sniper = splitDbcCollectorFee({
    tradingFee: 8_000_000n,
    protocolFee: 2_000_000n,
    referralFee: 0n,
    mode: "creator",
    profile: "standard_linked",
  });
  assert.equal(sniper.feeTotal, 10_000_000n);
  assert.equal(sniper.leagueWeekly + sniper.leagueMonthly, 3_750_000n);
  assert.equal(sniper.recruiter, 1_250_000n);
  assert.equal(slicesConserve(sniper), true);
});

test("rounding: slices + protocol + creator pool == collector amount exactly", () => {
  for (const fee of [1n, 7n, 13n, 400_001n, 333n]) {
    for (const profile of ["standard_linked", "og_linked", "standard_unlinked"] as const) {
      for (const mode of ["creator", "platform"] as const) {
        const slices = splitDbcCollectorFee({
          tradingFee: fee * 80n / 100n,
          protocolFee: fee - fee * 80n / 100n,
          referralFee: 0n,
          mode,
          profile,
        });
        assert.equal(slicesConserve(slices), true, `${fee} ${profile} ${mode}`);
      }
    }
  }
});

test("reward_events row shape for a DBC collector trade", () => {
  const slices = splitDbcCollectorFee({ ...F, mode: "creator", profile: "og_linked" });
  const row = rewardEventRow({
    slices,
    wallet: "Trader1111111111111111111111111111111111111",
    campaign: "Pool111111111111111111111111111111111111111",
    signature: "5Sig",
    logIndex: 0,
    slot: 9,
    occurredAt: new Date("2026-09-28T00:00:00Z"),
  });
  assert.equal(row.routeKind, "trade");
  assert.equal(row.routeProfile, "og_linked");
  assert.equal(row.matchedActivitySource, "dbc_collector");
  assert.equal(row.sourceEvent, "EvtSwap2");
  assert.equal(row.rawAmount, "400000");
  assert.equal(row.leagueAmount, (slices.leagueWeekly + slices.leagueMonthly).toString());
  assert.equal(row.metadata.weeklyLeagueLamports, slices.leagueWeekly.toString());
  JSON.stringify(row.metadata);
});

test("quote vault outflow is pre minus post token amount", () => {
  const vault = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const tx = {
    transaction: { message: { accountKeys: [other, vault] } },
    meta: {
      preTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: "1000" } }],
      postTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: "250" } }],
    },
  };
  assert.equal(quoteVaultOutflow(tx, vault.toBase58()), 750n);
  const viaGetAccountKeys = {
    transaction: {
      message: {
        getAccountKeys() {
          return { staticAccountKeys: [other, vault] };
        },
      },
    },
    meta: {
      preTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: "1000" } }],
      postTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: "250" } }],
    },
  };
  assert.equal(quoteVaultOutflow(viaGetAccountKeys, vault.toBase58()), 750n);
  assert.equal(CLAIM_RECONCILE_TOLERANCE_LAMPORTS, 0n);
});

test("router refuses when the collector is short", async () => {
  const collector = Keypair.generate();
  const db = {
    async query(sql: string) {
      if (sql.includes("status = 'blocked'")) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          league_weekly: "100", league_monthly: "200", recruiter: "50", squad: "10",
          airdrop: "0", protocol: "40", creator_pool: "0",
        }],
      };
    },
  };
  const connection = {
    async getBalance() { return 10; },
    async getMinimumBalanceForRentExemption() { return 890880; },
  };
  await assert.rejects(
    () => routeClaimedAccruals({
      db: db as any,
      connection: connection as any,
      collector,
      send: true,
    }),
    (error: unknown) => error instanceof CollectorShortError,
  );
});

test("route transfers skip zero slices and never send creator pool", () => {
  const collector = Keypair.generate().publicKey;
  const totals = sumClaimedSlices([{
    league_weekly: "45", league_monthly: "105", recruiter: "0", squad: "0",
    airdrop: "60", protocol: "80", creator_pool: "22",
  }]);
  assert.equal(totals.creatorPool, 22n);
  assert.equal(totals.routed, 45n + 105n + 60n + 80n);
  const built = buildRouteTransfers({ collector, totals });
  assert.ok(built.destinations.every((item) => item.lamports > 0n));
  assert.ok(!built.destinations.some((item) => item.seed.includes("creator")));
  assert.ok(built.instructions.every((ix) => ix.programId.equals(SystemProgram.programId)));
  const vaults = rewardVaults();
  assert.ok(vaults.protocol.toBase58().length > 20);
});

test("referral sweep keeps the referral account", () => {
  assert.equal(referralSweepKeepsAccount(), true);
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbc/dbcReferralSweep.ts"), "utf8");
  assert.match(source, /referral ATA is never closed/);
  assert.match(source, /if \(!after\) throw new Error\("DBC referral token account was closed/);
});

test("fee choice keep is creator mode; holders/split/buyback are platform", () => {
  assert.equal(creatorFeeModeFromChoice("keep"), "creator");
  assert.equal(creatorFeeModeFromChoice("holders"), "platform");
  assert.equal(profileFromLink(null), "standard_unlinked");
  assert.equal(profileFromLink({ is_og: true }), "og_linked");
});

test("trader profile lookup prefers the link active at trade time", async () => {
  let seen: unknown[] = [];
  const db = {
    async query(sql: string, params: unknown[]) {
      seen = params;
      assert.match(sql, /linked_at <= \$2/);
      assert.match(sql, /is_active/);
      return { rows: [{ is_og: false }] };
    },
  };
  const profile = await resolveTraderProfile(db as any, "Trader111", new Date("2026-09-28T00:00:00Z"));
  assert.equal(profile, "standard_linked");
  assert.equal(seen[0], "Trader111");
});
