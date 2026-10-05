import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import {
  CREATOR_REWARDS_VAULT_V2_EVENTS,
  GEN5_CAMPAIGN_EVENTS,
  GEN6_FACTORY_ABI,
  LP_LOCKER_EVENTS,
  TREASURY_ROUTER_V4_EVENTS,
  V3_LOCKER_EVENTS,
} from "../evm/evmGen5Abi.js";
import {
  annotateGen5Trade,
  creatorEscrowNextRelease,
  creatorEscrowVested,
  gen5TradeFeeBps,
  invertBuyTotal,
  invertSellPayout,
} from "../evm/evmGen5Trade.js";
import {
  GEN5_ALL_TOPICS,
  GEN5_CAMPAIGN_IFACE,
  GEN5_TIP_TOPICS,
  GEN5_TOPICS,
  annotationForTrade,
  firstBuysByTx,
  recordGen5CampaignLog,
} from "../evm/evmGen5CampaignLogs.js";
import { REFRESH_GEN5_STATE_SQL, forcedGen5Factories, isGen5Generation } from "../evm/evmGen5Store.js";
import { configuredGen5AuxContracts, recordGen5AuxLog, CREATOR_VAULT_V2_IFACE } from "../evm/evmGen5Aux.js";
import { leagueExcludedFilter, resetCurveTradeGen5ColumnsCache } from "../evm/curveTradeGen5Columns.js";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(here, "../../../artifacts/contracts");

function artifactTopics(path: string): Map<string, string> | null {
  const file = join(ARTIFACTS, path);
  if (!existsSync(file)) return null;
  const iface = new ethers.Interface(JSON.parse(readFileSync(file, "utf8")).abi);
  const out = new Map<string, string>();
  iface.forEachEvent((e) => {
    out.set(e.format("full"), e.topicHash);
  });
  return out;
}

function assertFragmentsInArtifact(fragments: readonly string[], path: string) {
  const topics = artifactTopics(path);
  if (!topics) return; // artifacts not compiled in this checkout
  for (const fragment of fragments) {
    if (!fragment.startsWith("event ")) continue;
    const ev = ethers.EventFragment.from(fragment);
    assert.ok(topics.has(ev.format("full")), `${path} lacks ${ev.format("full")}`);
  }
}

test("gen-5 ABI fragments equal the compiled contracts (indexed flags included)", () => {
  assertFragmentsInArtifact(GEN5_CAMPAIGN_EVENTS, "LaunchCampaign.sol/LaunchCampaign.json");
  assertFragmentsInArtifact(GEN6_FACTORY_ABI, "LaunchFactory.sol/LaunchFactory.json");
  assertFragmentsInArtifact(TREASURY_ROUTER_V4_EVENTS, "TreasuryRouterV4.sol/TreasuryRouterV4.json");
  assertFragmentsInArtifact(CREATOR_REWARDS_VAULT_V2_EVENTS, "CreatorRewardsVaultV2.sol/CreatorRewardsVaultV2.json");
  assertFragmentsInArtifact(LP_LOCKER_EVENTS, "PermanentLpLocker.sol/PermanentLpLocker.json");
  assertFragmentsInArtifact(V3_LOCKER_EVENTS, "PermanentV3PositionLocker.sol/PermanentV3PositionLocker.json");
});

test("router V4 RouteExecuted has the V3 topic, so the existing router scan decodes it", () => {
  const v3 = new ethers.Interface([
    "event RouteExecuted(uint8 indexed kind,uint8 indexed profile,address indexed campaign,uint256 amountIn,uint256 leagueAmount,uint256 creatorAmount,uint256 recruiterAmount,uint256 airdropAmount,uint256 squadAmount,uint256 protocolAmount)",
  ]);
  const v4 = new ethers.Interface([TREASURY_ROUTER_V4_EVENTS[0]]);
  assert.equal(v4.getEvent("RouteExecuted")!.topicHash, v3.getEvent("RouteExecuted")!.topicHash);
});

test("C2 anti-sniper fee: 5000 at launch, 5000 - 80/s, 200 from launch + 60 s (scheduled launch too)", () => {
  const launch = 1_000n;
  assert.equal(gen5TradeFeeBps(200n, launch, launch), 5000n);
  assert.equal(gen5TradeFeeBps(200n, launch, launch + 1n), 4920n);
  assert.equal(gen5TradeFeeBps(200n, launch, launch + 30n), 2600n);
  assert.equal(gen5TradeFeeBps(200n, launch, launch + 59n), 280n);
  assert.equal(gen5TradeFeeBps(200n, launch, launch + 60n), 200n);
  assert.equal(gen5TradeFeeBps(200n, launch, launch + 10_000n), 200n);
  // Before launchAt (views only) it reports the start value.
  assert.equal(gen5TradeFeeBps(200n, launch, launch - 500n), 5000n);
});

function prng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return BigInt(x >>> 0);
  };
}

test("fee inversion recovers the contract's fee exactly on buys and within 1 wei on sells", () => {
  const next = prng(7);
  for (let i = 0; i < 4000; i += 1) {
    const bps = [200n, 280n, 2600n, 4920n, 5000n][i % 5];
    const cost = next() * next() * 1_000_003n + next();
    const fee = (cost * bps) / 10_000n;
    const inv = invertBuyTotal(cost + fee, bps);
    assert.ok(inv, `buy ${cost} @ ${bps}`);
    assert.equal(inv!.costNoFee, cost);
    assert.equal(inv!.fee, fee);

    const gross = next() * next() * 999_983n + next();
    const sfee = (gross * bps) / 10_000n;
    const sinv = invertSellPayout(gross - sfee, bps);
    assert.ok(sinv, `sell ${gross} @ ${bps}`);
    assert.ok(sinv!.gross === gross || sinv!.gross === gross - 1n, `sell ${gross} -> ${sinv!.gross}`);
    assert.equal(sinv!.gross - sinv!.fee, gross - sfee);
  }
});

const CREATOR = "0x00000000000000000000000000000000000000c1";
const TRADER = "0x00000000000000000000000000000000000000d2";

test("D13 / C4: every creator buy is flagged and excluded from leagues; other wallets and creator sells are not", () => {
  const base = { blockTimeSec: 10_000n, launchAt: 1_000n, baseFeeBps: 200n, creator: CREATOR };
  const cost = 1_000_000n;
  const escrow = annotateGen5Trade({ ...base, side: "buy", amountRaw: cost + cost / 50n, wallet: CREATOR.toUpperCase().replace("0X", "0x") });
  assert.equal(escrow.creatorBuyKind, "escrow");
  assert.equal(escrow.leagueExcluded, true);
  assert.equal(escrow.feeRaw, cost / 50n);
  assert.equal(escrow.feeBps, 200);

  const trader = annotateGen5Trade({ ...base, side: "buy", amountRaw: cost + cost / 50n, wallet: TRADER });
  assert.equal(trader.creatorBuyKind, null);
  assert.equal(trader.leagueExcluded, false);

  const creatorSell = annotateGen5Trade({ ...base, side: "sell", amountRaw: 980n, wallet: CREATOR });
  assert.equal(creatorSell.leagueExcluded, false);
  assert.equal(creatorSell.creatorBuyKind, null);
});

test("C3 first buy keeps the flat fee even inside the anti-sniper window", () => {
  const a = annotateGen5Trade({
    side: "buy",
    amountRaw: 1_020n,
    blockTimeSec: 1_000n,
    launchAt: 1_000n,
    baseFeeBps: 200n,
    wallet: CREATOR,
    creator: CREATOR,
    firstBuy: { costNoFee: 1_000n, fee: 20n },
  });
  assert.equal(a.creatorBuyKind, "first_buy");
  assert.equal(a.feeRaw, 20n);
  assert.equal(a.feeBps, 200);
  assert.equal(a.grossRaw, 1_000n);
  assert.equal(a.leagueExcluded, true);
});

function encode(name: string, values: unknown[], tx = `0x${"ab".repeat(32)}`, index = 0) {
  const event = GEN5_CAMPAIGN_IFACE.getEvent(name)!;
  const encoded = GEN5_CAMPAIGN_IFACE.encodeEventLog(event, values);
  return { topics: encoded.topics, data: encoded.data, transactionHash: tx, index, blockNumber: 77 };
}

test("a first buy is recognised from CreatorFirstBuy in the same transaction; a sniper in the create block pays the anti-sniper fee", () => {
  const tx = `0x${"11".repeat(32)}`;
  const logs = [
    encode("TokensPurchased", [CREATOR, 5_000n, 1_020n], tx, 3),
    encode("CreatorFirstBuy", [CREATOR, 5_000n, 1_000n, 20n], tx, 4),
  ];
  const firstBuys = firstBuysByTx(logs);
  assert.equal(firstBuys.size, 1);
  const ctx = {
    info: { campaign: "0x01", factory: null, factoryGeneration: 6, campaignGeneration: 5, gen5: true, creator: CREATOR, launchAt: 500n, baseFeeBps: 200n },
    firstBuys,
  };
  const first = annotationForTrade(ctx, { side: "buy", wallet: CREATOR, amountRaw: 1_020n, tokenRaw: 5_000n, txHash: tx, blockTimeSec: 500 });
  assert.equal(first.creatorBuyKind, "first_buy");
  assert.equal(first.feeRaw, 20n);

  // Same block, another wallet, another tx: 5000 bps.
  const sniper = annotationForTrade(ctx, { side: "buy", wallet: TRADER, amountRaw: 1_500n, tokenRaw: 1n, txHash: `0x${"22".repeat(32)}`, blockTimeSec: 500 });
  assert.equal(sniper.feeBps, 5000);
  assert.equal(sniper.feeRaw, 500n);
  assert.equal(sniper.grossRaw, 1_000n);
  assert.equal(sniper.leagueExcluded, false);
});

test("topic sets: history scans every gen-5 event, tip scans trades plus the first-buy marker", () => {
  assert.equal(GEN5_ALL_TOPICS.length, GEN5_CAMPAIGN_EVENTS.length);
  assert.deepEqual(GEN5_TIP_TOPICS, [GEN5_TOPICS.buy, GEN5_TOPICS.sell, GEN5_TOPICS.firstBuy]);
  // Trades keep the old signature: the old generation's topics are the same.
  const old = new ethers.Interface(["event TokensPurchased(address indexed buyer,uint256 amountOut,uint256 cost)"]);
  assert.equal(old.getEvent("TokensPurchased")!.topicHash, GEN5_TOPICS.buy);
});

test("C4 escrow vesting mirrors creatorEscrowVested: 20% at 30 days, then 20% every 7 days, all at 58 days", () => {
  const DAY = 86_400n;
  const s = 1_000_000n;
  const entries = [{ amount: 100n, timestamp: s }];
  assert.equal(creatorEscrowVested(entries, s + 30n * DAY - 1n), 0n);
  assert.equal(creatorEscrowVested(entries, s + 30n * DAY), 20n);
  assert.equal(creatorEscrowVested(entries, s + 37n * DAY), 40n);
  assert.equal(creatorEscrowVested(entries, s + 58n * DAY - 1n), 80n);
  assert.equal(creatorEscrowVested(entries, s + 58n * DAY), 100n);
  assert.equal(creatorEscrowNextRelease(entries, s), s + 30n * DAY);
  assert.equal(creatorEscrowNextRelease(entries, s + 58n * DAY), null);
  // Two buys: the floor is taken once over the sum, like the contract's checkpoint maths.
  const two = [{ amount: 3n, timestamp: s }, { amount: 3n, timestamp: s }];
  assert.equal(creatorEscrowVested(two, s + 30n * DAY), 1n); // (3+3)/5, not 3/5 + 3/5 = 0
});

type Call = { sql: string; params: unknown[] };
function fakeDb(responder: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number } = () => ({ rows: [], rowCount: 0 })) {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return responder(sql, params);
    },
  };
}

test("non-trade gen-5 events are recorded once with named args; Graduated returns the pool", async () => {
  const db = fakeDb((sql) => (/insert into public.evm_campaign_events/.test(sql) ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [] }));
  const pool = "0x00000000000000000000000000000000000000aa";
  const log = encode("Graduated", [pool, 1000n, 22n, 198n, 780n, 5n, 6n, 7n, 8n, true]);
  const res = await recordGen5CampaignLog(db, 56, "0x00000000000000000000000000000000000000Cc", log, new Date(0));
  assert.equal(res?.eventName, "Graduated");
  assert.equal(res?.graduatedPool, pool);
  assert.equal(res?.inserted, true);
  const args = JSON.parse(String(db.calls[0].params[9]));
  assert.equal(args.pool, pool);
  assert.equal(args.protocolShare, "22");
  assert.equal(args.repaired, true);
  assert.equal(db.calls[0].params[3], "0x00000000000000000000000000000000000000cc");

  // A trade log is not recorded here (indexer.ts writes curve_trades).
  const trade = encode("TokensSold", [TRADER, 1n, 2n]);
  assert.equal(await recordGen5CampaignLog(db, 56, "0xcc", trade, null), null);
});

test("state is recomputed from events (sums and latest rows), never incremented", () => {
  for (const needle of ["PoolRepairStep", "ProtocolGraduationFeeEscrowed", "ProtocolGraduationFeeFlushed", "CreatorBuyEscrowed", "CreatorEscrowClaimed", "NativeFallbackCommitted", "on conflict (chain_id, campaign_address) do update"]) {
    assert.ok(REFRESH_GEN5_STATE_SQL.includes(needle), needle);
  }
  assert.ok(!/\+=|= s\.[a-z_]+ \+/.test(REFRESH_GEN5_STATE_SQL));
});

test("generation selection: >= 5 is gen 5; forced factories come from env", () => {
  assert.equal(isGen5Generation(5), true);
  assert.equal(isGen5Generation(3), false);
  assert.equal(isGen5Generation(null), false);
  const forced = forcedGen5Factories(56, { EVM_GEN5_FACTORIES_56: "0x00000000000000000000000000000000000000AB, bad" } as any);
  assert.deepEqual([...forced], ["0x00000000000000000000000000000000000000ab"]);
});

test("creator vault V2 and generation lockers come from env; a fee choice event updates the state row", async () => {
  const contracts = configuredGen5AuxContracts(4663, {
    EVM_CREATOR_VAULT_V2_4663: "0x00000000000000000000000000000000000000A1@100",
    EVM_GEN5_LP_LOCKERS_4663: "0x00000000000000000000000000000000000000a2@200,0x00000000000000000000000000000000000000a1@1",
  } as any);
  assert.deepEqual(contracts.map((c) => [c.address.slice(-2), c.kind, c.startBlock]), [["a1", "creator_vault", 100], ["a2", "lp_locker", 200]]);

  const db = fakeDb((sql) => (/insert into public.evm_campaign_events/.test(sql) ? { rows: [{}], rowCount: 1 } : { rows: [] }));
  const campaign = "0x00000000000000000000000000000000000000c5";
  const ev = CREATOR_VAULT_V2_IFACE.encodeEventLog(CREATOR_VAULT_V2_IFACE.getEvent("CampaignChoiceSet")!, [campaign, CREATOR, 3, 40]);
  const name = await recordGen5AuxLog(db, 4663, contracts[0], { topics: ev.topics, data: ev.data, transactionHash: `0x${"33".repeat(32)}`, index: 1, blockNumber: 5 }, null);
  assert.equal(name, "CampaignChoiceSet");
  const choice = db.calls.find((c) => /evm_campaign_gen5_state/.test(c.sql));
  assert.ok(choice);
  assert.deepEqual(choice!.params.slice(1), [campaign, contracts[0].address, 3, 40]);
});

test("league filter reads league_excluded only once the migration added it", async () => {
  resetCurveTradeGen5ColumnsCache();
  const before = fakeDb(() => ({ rows: [] }));
  assert.equal(await leagueExcludedFilter(before, "t"), "");
  resetCurveTradeGen5ColumnsCache();
  const after = fakeDb(() => ({ rows: [{ column_name: "league_excluded" }, { column_name: "fee_raw" }] }));
  assert.equal(await leagueExcludedFilter(after, "t"), " AND NOT coalesce(t.league_excluded, false)");
  resetCurveTradeGen5ColumnsCache();
});

test("recruiter league referred volume excludes creator buys; the league pot prices gen-5 trades from fee_raw", () => {
  const league = readFileSync(join(here, "../rewards/recruiterLeague.ts"), "utf8");
  assert.match(league, /leagueExcludedFilter\(db, "t"\)/);
  assert.match(league, /\$\{creatorBuys\}/);
  const finalize = readFileSync(join(here, "../jobs/finalizeEpochWinners.ts"), "utf8");
  assert.match(finalize, /WHEN fee_raw IS NOT NULL THEN floor\(\(fee_raw \* \$5\) \/ NULLIF\(\$4, 0\)\)/);
  // The creator-wallet exclusions that already cover gen-5 creator buys stay in place (the standings
  // SQL moved to rewards/leagueLeaderboard.ts on 2026-10-05).
  const standings = readFileSync(join(here, "../rewards/leagueLeaderboard.ts"), "utf8");
  assert.match(standings, /t\.wallet IS DISTINCT FROM c\.creator_address/);
});
