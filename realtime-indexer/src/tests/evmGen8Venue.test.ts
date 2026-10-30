// Gen-8 venue seam in the indexer (barkswap plan t17; spec section 4 Principle / Indexer, section 3 per-swap event
// fields, B7). DogeOS (6281971) is a gen-8 chain on the `barkswap` venue: launcher + plugin config, WDOGE quote,
// Barkswap's SwapRouter as a link router, rollup head tags. The V4 loops never pick it up.
import assert from "node:assert/strict";
import test from "node:test";
import {
  GEN8_CHAIN_VENUE,
  GEN8_EVM_CHAIN_IDS,
  GEN8_LINK_ROUTERS,
  configuredGen8BarkChains,
  configuredGen8Chains,
  evmGen8BarkConfig,
  evmGen8Config,
  gen8DisplayHead,
  gen8DisplayHeadTag,
  gen8LeagueExcluded,
  gen8LinkPolicy,
  gen8MoneyDepth,
  gen8MoneyHead,
  gen8MoneyHeadTag,
  gen8Venue,
  gen8WrappedNative,
} from "../evm/evmGen8Config.js";

const DOGE = 6281971;
const L = "0x1111111111111111111111111111111111111111";
const H = "0x2222222222222222222222222222222222222222";
const P = "0x3333333333333333333333333333333333333333";
const PM = "0x4444444444444444444444444444444444444444";
const ESCROW = "0x5555555555555555555555555555555555555555";
const VAULT = "0x6666666666666666666666666666666666666666";
/** Barkswap SwapRouter and WDOGE on Chikyu (docs/dogeos/barkswap-facts.md). */
const BARK_SWAP_ROUTER = "0x911e5a1630fd1768e5a1710daafabb865cb79531";
const WDOGE = "0xf6bdb158a5ddf77f1b83bc9074f6a472c58d78ae";
const BARK_ENV = {
  EVM_GEN8_LAUNCHER_6281971: `${L}@8600010`,
  EVM_GEN8_PLUGIN_6281971: `${P}@8600000`,
  EVM_GEN8_SPLITTER_6281971: `${VAULT}@8600020`,
  EVM_GEN8_ESCROW_6281971: ESCROW,
  EVM_GEN8_CHOICE_VAULT_6281971: VAULT,
} as NodeJS.ProcessEnv;

test("venue map: V4 on BNB and Robinhood, Barkswap on DogeOS; DogeOS is a gen-8 indexer chain", () => {
  for (const id of [56, 97, 4663, 46630]) assert.equal(gen8Venue(id), "v4", String(id));
  assert.equal(gen8Venue(DOGE), "barkswap");
  for (const id of [1, 101, 31337, Number.NaN]) assert.equal(gen8Venue(id), null, String(id));
  assert.deepEqual([...GEN8_EVM_CHAIN_IDS].sort((a, b) => a - b), Object.keys(GEN8_CHAIN_VENUE).map(Number).sort((a, b) => a - b));
});

test("Barkswap config: inert until launcher and plugin are both set; start block is the earlier one", () => {
  assert.equal(evmGen8BarkConfig(DOGE, {}).reason, "unset");
  assert.equal(evmGen8BarkConfig(DOGE, { EVM_GEN8_LAUNCHER_6281971: L }).reason, "launcher and plugin must both be set");
  const cfg = evmGen8BarkConfig(DOGE, BARK_ENV).config!;
  assert.deepEqual(cfg, {
    chainId: DOGE,
    venue: "barkswap",
    launcher: { address: L, startBlock: 8600010 },
    plugin: { address: P, startBlock: 8600000 },
    splitter: { address: VAULT, startBlock: 8600020 },
    choiceVault: VAULT,
    reserveLock: null,
    escrow: ESCROW,
    startBlock: 8600000,
  });
  assert.deepEqual(configuredGen8BarkChains(BARK_ENV), [cfg]);
  assert.deepEqual(configuredGen8BarkChains({}), []);
});

test("Barkswap config: a V4 setting alone on DogeOS gets the named refusal, not 'unset'", () => {
  assert.match(String(evmGen8BarkConfig(DOGE, { EVM_GEN8_HOOK_6281971: H }).reason), /EVM_GEN8_HOOK_6281971.*barkswap/);
  assert.match(String(evmGen8BarkConfig(DOGE, { EVM_GEN8_POOL_MANAGER_6281971: PM }).reason), /EVM_GEN8_POOL_MANAGER_6281971.*barkswap/);
});

test("Barkswap config: V4 settings or malformed env disable DogeOS; V4 chains have no Barkswap config", () => {
  assert.match(String(evmGen8BarkConfig(DOGE, { ...BARK_ENV, EVM_GEN8_HOOK_6281971: H }).reason), /EVM_GEN8_HOOK_6281971.*barkswap/);
  assert.match(String(evmGen8BarkConfig(DOGE, { ...BARK_ENV, EVM_GEN8_POOL_MANAGER_6281971: PM }).reason), /EVM_GEN8_POOL_MANAGER_6281971.*barkswap/);
  const bad = evmGen8BarkConfig(DOGE, { ...BARK_ENV, EVM_GEN8_PLUGIN_6281971: "0x12@1" });
  assert.equal(bad.config, null);
  assert.equal(bad.reason, "invalid gen-8 env");
  assert.deepEqual(bad.invalid, ["EVM_GEN8_PLUGIN_6281971: 0x12@1"]);
  assert.equal(evmGen8BarkConfig(56, { EVM_GEN8_LAUNCHER_56: L, EVM_GEN8_PLUGIN_56: P }).config, null);
  assert.match(String(evmGen8BarkConfig(56, { EVM_GEN8_LAUNCHER_56: L, EVM_GEN8_PLUGIN_56: P }).reason), /not on the barkswap venue/);
});

test("the V4 loops never take DogeOS, even with V4-shaped env; V4 configs carry venue v4", () => {
  const v4Shaped = { EVM_GEN8_LAUNCHER_6281971: `${L}@1`, EVM_GEN8_HOOK_6281971: `${H}@1`, EVM_GEN8_POOL_MANAGER_6281971: PM } as NodeJS.ProcessEnv;
  assert.equal(evmGen8Config(DOGE, v4Shaped).config, null);
  assert.match(String(evmGen8Config(DOGE, v4Shaped).reason), /barkswap/);
  assert.equal(evmGen8Config(DOGE, BARK_ENV).config, null);
  assert.deepEqual(configuredGen8Chains({ ...v4Shaped, ...BARK_ENV }), []);
  const v4 = configuredGen8Chains({ ...BARK_ENV, EVM_GEN8_LAUNCHER_56: `${L}@5`, EVM_GEN8_HOOK_56: `${H}@5` });
  assert.deepEqual(v4.map((c) => [c.chainId, c.venue]), [[56, "v4"]]);
  assert.equal(evmGen8Config(56, { EVM_GEN8_LAUNCHER_56: `${L}@5`, EVM_GEN8_HOOK_56: `${H}@5` }).config!.venue, "v4");
});

test("DogeOS quote is WDOGE; the V4 chains keep theirs", () => {
  assert.equal(gen8WrappedNative(DOGE, {}), WDOGE);
  assert.equal(gen8WrappedNative(56, {}), "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
  assert.equal(gen8WrappedNative(46630, {}), "0x52a47a33930b8a90a2000b1ba3cb96e879569670");
  assert.throws(() => gen8WrappedNative(1, {}), /no wrapped native for chain 1/);
});

test("link policy on DogeOS: Barkswap's SwapRouter, the launcher and the escrow; never the choice vault or a UniversalRouter", () => {
  assert.deepEqual(GEN8_LINK_ROUTERS[DOGE], [BARK_SWAP_ROUTER]);
  const cfg = evmGen8BarkConfig(DOGE, BARK_ENV).config!;
  const p = gen8LinkPolicy(cfg, {});
  assert.deepEqual([...p.routers].sort(), [BARK_SWAP_ROUTER, L, ESCROW].sort());
  assert.ok(!p.routers.has(GEN8_LINK_ROUTERS[56]![0]!));
  assert.equal(gen8LeagueExcluded(cfg, { creator: H, hookCreator: null }, PM, L), true, "creator first buy through the launcher");
  assert.equal(gen8LeagueExcluded(cfg, { creator: H, hookCreator: null }, PM, BARK_SWAP_ROUTER), false);
});

test("head tags: DogeOS display at latest, money at latest minus 20 blocks (founder 2026-10-15); BNB and Robinhood unchanged", async () => {
  assert.equal(gen8DisplayHeadTag(DOGE, {}), "latest");
  assert.equal(gen8MoneyHeadTag(DOGE, {}), "latest");
  assert.equal(gen8MoneyDepth(DOGE, {}), 20);
  assert.deepEqual([56, 97, 4663, 46630].map((id) => gen8DisplayHeadTag(id, {})), ["finalized", "finalized", "latest", "latest"]);
  assert.deepEqual([56, 97, 4663, 46630].map((id) => gen8MoneyHeadTag(id, {})), ["finalized", "finalized", "safe", "safe"]);
  for (const id of [56, 97, 4663, 46630]) assert.equal(gen8MoneyDepth(id, {}), null, String(id));

  const asked: unknown[] = [];
  const p = { getBlockNumber: async () => 1_000, getBlock: async (t: any) => (asked.push(t), t === "finalized" ? { number: 990 } : t === "safe" ? { number: 940 } : null) };
  assert.equal(await gen8MoneyHead(p, DOGE, {}), 980, "latest - 20");
  assert.equal(await gen8MoneyHead(p, DOGE, { EVM_GEN8_CONFIRMATIONS: "3" }), 980, "the display confirmations do not change the money depth");
  assert.equal(await gen8DisplayHead(p, DOGE, {}), 999, "display: latest - EVM_GEN8_CONFIRMATIONS (1)");
  assert.deepEqual(asked, [], "DogeOS asks for no safe / finalized tag");
  assert.equal(await gen8MoneyHead(p, 4663, {}), 940, "Robinhood money stays at safe");
  assert.equal(await gen8MoneyHead(p, 46630, {}), 940);
  assert.equal(await gen8MoneyHead(p, 56, {}), 990, "BNB money stays at finalized");

  // Env overrides: the depth (never below the 17-block max reorg) and the tag itself.
  assert.equal(await gen8MoneyHead(p, DOGE, { EVM_GEN8_MONEY_DEPTH_6281971: "50" }), 950);
  assert.equal(gen8MoneyDepth(DOGE, { EVM_GEN8_MONEY_DEPTH_6281971: "5" }), 17);
  assert.equal(gen8MoneyDepth(DOGE, { EVM_GEN8_MONEY_DEPTH_6281971: "nope" }), 20);
  assert.equal(await gen8MoneyHead(p, DOGE, { EVM_GEN8_MONEY_HEAD_TAG_6281971: "finalized" }), 990);
});

// Gate 2 Minor 1: the (key, fee) multiset compare of a run's covered rows against its accrualRoot is Barkswap's (one sell
// converted twice is two credits with one key). A V4 run keeps release/evm-gen8's key-set compare (efba85c63): the same
// keys are equal whatever fee the planned leaf carries; a missing or extra key is still a critical alert.
test("recordRoutedRun on V4 compares the covered rows with its accrualRoot by key set, as on release/evm-gen8", async () => {
  const { recordRoutedRun } = await import("../evm/evmGen8FeeRouting.js");
  const SPLITTER = "0x000000000000000000000000000000000000beef";
  const v4: any = {
    chainId: 97, venue: "v4", launcher: { address: L, startBlock: 1 }, hook: { address: H, startBlock: 1 }, poolManager: PM,
    splitter: { address: SPLITTER, startBlock: 1 }, choiceVault: null, reserveLock: null, escrow: null, startBlock: 1,
  };
  const B = 10n ** 15n;
  const ROOT = "0x" + "aa".repeat(32);
  const TX = "0x" + "d1".repeat(32);
  const runWith = async (leaves: any[]) => {
    const rows = [{ id: 1, tx_hash: TX, log_index: 1, block_number: 9, kind: "trade", phase: "bonding", trader: L, profile: "standard_unlinked", fee: String(B), router_amount: String(B), league_weekly: "0", league_monthly: "0", recruiter: "0", squad: "0", airdrop: "0", protocol: "0" }];
    const db = {
      async query(text: string) {
        if (text.includes("select status, leaves, accrual_root")) return { rows: [{ status: "sent", leaves, accrual_root: ROOT, total: String(B) }] };
        if (text.includes("coalesce(sum(total), 0)")) return { rows: [{ t: String(B) }] };
        if (text.includes("event_name = 'RouterClaimed'")) return { rows: [{ block_number: 10, log_index: 5, tx_hash: "0xc0", args: { amount: String(B), bondingFees: String(B), gradFees: "0" } }] };
        if (text.includes("from public.evm_gen8_fee_accruals") && text.includes("run_id is null")) return { rows };
        return { rows: [] };
      },
    };
    const alerts: any[] = [];
    const run = { total: B, bondingFees: B, gradFees: 0n, weeklyLeague: 0n, monthlyLeague: 0n, recruiter: 0n, squad: 0n, airdrop: 0n, protocol: 0n };
    await recordRoutedRun(db as any, v4, { kind: "Routed", runId: 1n, accrualRoot: ROOT, caller: L, txHash: "0xr1", blockNumber: 11, logIndex: 0, address: SPLITTER, run } as any, new Date(), async (a: any) => void alerts.push(a), {});
    return alerts.filter((a) => a.subject === "1:root");
  };
  // the same key with another fee on the planned leaf (or none): equal on V4
  assert.deepEqual(await runWith([{ txHash: TX, logIndex: 1, kind: 0, fee: String(B + 1n) }]), []);
  assert.deepEqual(await runWith([{ txHash: TX, logIndex: 1, kind: 0 }]), []);
  // a planned row that was not covered, or a covered row nobody planned: alert
  assert.equal((await runWith([{ txHash: TX, logIndex: 2, kind: 0, fee: String(B) }])).length, 1);
  assert.equal((await runWith([{ txHash: TX, logIndex: 1, kind: 0, fee: String(B) }, { txHash: TX, logIndex: 2, kind: 0, fee: "1" }])).length, 1);
});
