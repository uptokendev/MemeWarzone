import assert from "node:assert/strict";
import test from "node:test";
import { computeEligibleBattleVolume, VOLUME_EXCLUDE, battleVolumeWindow } from "./arenaBattleVolume.js";

const LIVE = "2026-09-01T12:00:00.000Z";
const FINISH = "2026-09-02T12:00:00.000Z";

function trade(partial) {
  return {
    wallet: "0x1111111111111111111111111111111111111111",
    side: "buy",
    usdAmount: 100,
    valuationHealthy: true,
    blockTime: "2026-09-01T18:00:00.000Z",
    status: "confirmed",
    txHash: `0x${Math.random().toString(16).slice(2)}`,
    logIndex: 0,
    ...partial,
  };
}

function run(trades, extra = {}) {
  return computeEligibleBattleVolume({
    trades,
    liveAt: LIVE,
    finishAt: FINISH,
    clusterByWallet: extra.clusterByWallet || new Map(),
    creatorWallets: extra.creatorWallets || new Set(),
    creatorClusterIds: extra.creatorClusterIds || new Set(),
    fundedWallets: extra.fundedWallets || new Set(),
    restrictedWallets: extra.restrictedWallets || new Set(),
    restrictedClusters: extra.restrictedClusters || new Set(),
    washWallets: extra.washWallets || new Set(),
    washClusters: extra.washClusters || new Set(),
  });
}

test("only trades inside the live window count; pre and post battle are excluded", () => {
  const result = run([
    trade({ usdAmount: 50, blockTime: "2026-09-01T11:59:59.000Z", txHash: "0xpre" }),
    trade({ usdAmount: 80, blockTime: "2026-09-01T12:00:00.000Z", txHash: "0xin" }),
    trade({ usdAmount: 90, blockTime: "2026-09-02T12:00:00.000Z", txHash: "0xpost" }),
  ]);
  assert.equal(result.eligibleUsd, 80);
  assert.equal(result.legs.find((leg) => leg.txHash === "0xpre").excludeReason, VOLUME_EXCLUDE.OUTSIDE_WINDOW);
  assert.equal(result.legs.find((leg) => leg.txHash === "0xpost").excludeReason, VOLUME_EXCLUDE.OUTSIDE_WINDOW);
});

test("creator wallet volume is excluded", () => {
  const creator = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const result = run(
    [trade({ wallet: creator, usdAmount: 400, txHash: "0xself" })],
    { creatorWallets: new Set([creator]) },
  );
  assert.equal(result.eligibleUsd, 0);
  assert.equal(result.legs[0].excludeReason, VOLUME_EXCLUDE.SELF_TRADE);
});

test("bonding/router recipient equal to initiating wallet is legitimate volume", () => {
  const wallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const result = run([trade({ wallet, recipient: wallet, usdAmount: 250, txHash: "0xnormal" })]);
  assert.equal(result.eligibleUsd, 250);
  assert.equal(result.legs[0].excludeReason, null);
  assert.equal(result.legs[0].included, true);
});

test("explicit self-trade evidence is excluded", () => {
  const result = run([trade({ selfTrade: true, usdAmount: 250, txHash: "0xself" })]);
  assert.equal(result.eligibleUsd, 0);
  assert.equal(result.legs[0].excludeReason, VOLUME_EXCLUDE.SELF_TRADE);
});

test("common-control cluster of the creator is excluded", () => {
  const wallet = "0xcccccccccccccccccccccccccccccccccccccccc";
  const result = run(
    [trade({ wallet, usdAmount: 300, txHash: "0xcc" })],
    {
      clusterByWallet: new Map([[wallet, "cluster-creator"]]),
      creatorClusterIds: new Set(["cluster-creator"]),
    },
  );
  assert.equal(result.eligibleUsd, 0);
  assert.equal(result.legs[0].excludeReason, VOLUME_EXCLUDE.COMMON_CONTROL_CLUSTER);
});

test("ordinary buy and sell by the same cluster are not automatically wash volume", () => {
  const a = "0xdddddddddddddddddddddddddddddddddddddddd";
  const b = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const clusters = new Map([[a, "active-traders"], [b, "active-traders"]]);
  const result = run(
    [
      trade({ wallet: a, side: "buy", usdAmount: 100, txHash: "0xbuy" }),
      trade({ wallet: b, side: "sell", usdAmount: 90, txHash: "0xsell" }),
    ],
    { clusterByWallet: clusters },
  );
  assert.equal(result.eligibleUsd, 190);
  assert.equal(result.legs[0].excludeReason, null);
  assert.equal(result.legs[1].excludeReason, null);
});

test("explicit wash/circular evidence excludes the flagged trade or cluster", () => {
  const a = "0xdddddddddddddddddddddddddddddddddddddddd";
  const b = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const clusters = new Map([[a, "wash"], [b, "wash"]]);
  const result = run(
    [
      trade({ wallet: a, side: "buy", usdAmount: 100, txHash: "0xbuy" }),
      trade({ wallet: b, side: "sell", usdAmount: 90, txHash: "0xsell" }),
    ],
    { clusterByWallet: clusters, washClusters: new Set(["wash"]) },
  );
  assert.equal(result.eligibleUsd, 0);
  assert.equal(result.legs[0].excludeReason, VOLUME_EXCLUDE.CIRCULAR_TRADE);
  assert.equal(result.legs[1].excludeReason, VOLUME_EXCLUDE.CIRCULAR_TRADE);
});

test("wallet splitting stays grouped into one cluster for score concentration", () => {
  const a = "0x1111111111111111111111111111111111111111";
  const b = "0x2222222222222222222222222222222222222222";
  const other = "0x3333333333333333333333333333333333333333";
  const result = run(
    [
      trade({ wallet: a, usdAmount: 400, txHash: "0xa" }),
      trade({ wallet: b, usdAmount: 400, txHash: "0xb" }),
      trade({ wallet: other, usdAmount: 200, txHash: "0xc" }),
    ],
    { clusterByWallet: new Map([[a, "split"], [b, "split"]]) },
  );
  const split = result.clusters.find((row) => row.clusterId === "split");
  assert.equal(split.rawUsd, 800);
  assert.equal(split.countedUsd, 800);
  assert.equal(result.rawUsd, 1000);
  assert.equal(result.eligibleUsd, 1000);
});

test("creator-funded wallet is excluded", () => {
  const funded = "0x4444444444444444444444444444444444444444";
  const result = run(
    [trade({ wallet: funded, usdAmount: 700, txHash: "0xfund" })],
    { fundedWallets: new Set([funded]) },
  );
  assert.equal(result.eligibleUsd, 0);
  assert.equal(result.legs[0].excludeReason, VOLUME_EXCLUDE.CREATOR_FUNDED_FAKE_DEMAND);
});

test("unconfirmed trades are excluded", () => {
  const result = run([trade({ status: "pending", usdAmount: 120, txHash: "0xpend" })]);
  assert.equal(result.eligibleUsd, 0);
  assert.equal(result.legs[0].excludeReason, VOLUME_EXCLUDE.FAILED_TRADE);
});

test("unpriced Stock/quote volume fails closed instead of becoming zero native volume", () => {
  const result = run([trade({
    usdAmount: null,
    valuationHealthy: false,
    quoteAssetType: "STOCK_TOKEN",
    txHash: "0xstock",
  })]);
  assert.equal(result.eligibleUsd, 0);
  assert.equal(result.legs[0].excludeReason, VOLUME_EXCLUDE.UNPRICED_QUOTE);
});

test("many unrelated wallets keep all legitimate USD volume before score concentration", () => {
  const trades = [];
  for (let i = 0; i < 10; i += 1) {
    const n = (i + 1).toString(16).padStart(2, "0");
    trades.push(trade({
      wallet: `0x${n.repeat(20)}`,
      usdAmount: 100,
      txHash: `0x${n}`,
    }));
  }
  const result = run(trades);
  assert.equal(result.rawUsd, 1000);
  assert.equal(result.eligibleUsd, 1000);
  assert.equal(result.clusters.length, 10);
});

test("single whale volume remains auditable; influence cap belongs to points engine", () => {
  const whale = "0x5555555555555555555555555555555555555555";
  const result = run([trade({ wallet: whale, usdAmount: 1000, txHash: "0xwhale" })]);
  assert.equal(result.rawUsd, 1000);
  assert.equal(result.eligibleUsd, 1000);
  assert.equal(result.clusters[0].rawUsd, 1000);
  assert.equal(result.legs[0].included, true);
});

test("same trade set yields the same eligibleUsd", () => {
  const trades = [
    trade({ wallet: "0x6666666666666666666666666666666666666666", usdAmount: 40, txHash: "0x1" }),
    trade({ wallet: "0x7777777777777777777777777777777777777777", usdAmount: 60, txHash: "0x2" }),
  ];
  assert.deepEqual(run(trades).eligibleUsd, run(trades).eligibleUsd);
});

test("volume window uses the authoritative baseline timestamp while live", () => {
  const window = battleVolumeWindow(
    { state: "live", started_at: "2026-09-01T12:00:00.000Z", ends_at: "2026-09-02T12:00:00.000Z" },
    { baseline_timestamp: "2026-09-01T12:00:00.000Z" },
    new Date("2026-09-01T15:00:00.000Z"),
  );
  assert.equal(new Date(window.liveAt).toISOString(), "2026-09-01T12:00:00.000Z");
});
