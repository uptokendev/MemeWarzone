/**
 * Gen-8 indexer fixes from the 2026-10-12 AI audit (docs/build_plans/GEN8_AI_AUDIT_FINDINGS.md), no RPC, no DB:
 *   F9  (C-M4) link eligibility: allowed router, tx.to = router, denylist, many swap senders
 *   F10 (C-M5) head tag per chain (finalized on BNB, safe on Robinhood), fail closed
 *   F11 (C-L3, C-L5) Routed vs plan, control-event decoding, foreign claims, PaidMismatch streak, dropped route tx,
 *       and the C-M2 dust deadlock (off-chain part of F4)
 *   F12 (D-L2) league exclusion by hook creator and swap sender, not tx.from alone
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { GEN8_CHOICE_VAULT_IFACE, GEN8_HOOK_IFACE, GEN8_LAUNCHER_IFACE, GEN8_SPLITTER_IFACE, GEN8_TOPICS } from "../evm/evmGen8Abi.js";
import { decodeGen8Log } from "../evm/evmGen8Decode.js";
import { gen8HeadTag, gen8LinkCheck, gen8LinkPolicy, gen8SafeHead, GEN8_LINK_ROUTERS, type Gen8ChainConfig } from "../evm/evmGen8Config.js";
import { gen8LeagueExcluded } from "../evm/evmGen8Config.js";
import { recordRoutedRun, routedPlanDifferences, runGen8RoutePass } from "../evm/evmGen8FeeRouting.js";
import { splitterBands } from "../evm/evmGen8Fees.js";

const HOOK = "0x00000000000000000000000000000000000028ec";
const SPLITTER = "0x000000000000000000000000000000000000beef";
const LAUNCHER = "0x0000000000000000000000000000000000000001";
const ESCROW = "0x00000000000000000000000000000000000e5c20";
const VAULT = "0x00000000000000000000000000000000000ba017";
const OPERATOR = "0x0000000000000000000000000000000000000abc";
const cfg = (chainId = 97): Gen8ChainConfig => ({
  chainId, launcher: { address: LAUNCHER, startBlock: 1 }, hook: { address: HOOK, startBlock: 1 }, poolManager: "0x0000000000000000000000000000000000000002",
  splitter: { address: SPLITTER, startBlock: 1 }, choiceVault: VAULT, reserveLock: null, escrow: ESCROW, startBlock: 1,
});

// ------------------------------------------------------------------ F10

test("F10 head tag: finalized on BNB, safe on Robinhood, env override, latest = old confirmations rule", async () => {
  assert.equal(gen8HeadTag(56, {}), "finalized");
  assert.equal(gen8HeadTag(97, {}), "finalized");
  assert.equal(gen8HeadTag(4663, {}), "safe");
  assert.equal(gen8HeadTag(46630, {}), "safe");
  assert.equal(gen8HeadTag(56, { EVM_GEN8_HEAD_TAG_56: "safe" }), "safe");
  assert.equal(gen8HeadTag(4663, { EVM_GEN8_HEAD_TAG: "finalized" }), "finalized");
  assert.equal(gen8HeadTag(4663, { EVM_GEN8_HEAD_TAG: "nonsense" }), "safe");
  const asked: unknown[] = [];
  const p = { getBlockNumber: async () => 1_000, getBlock: async (t: any) => (asked.push(t), t === "finalized" ? { number: 990 } : t === "safe" ? { number: 940 } : null) };
  assert.equal(await gen8SafeHead(p, 56, {}), 990);
  assert.equal(await gen8SafeHead(p, 4663, {}), 940);
  assert.equal(await gen8SafeHead(p, 56, { EVM_GEN8_HEAD_TAG_56: "latest", EVM_GEN8_CONFIRMATIONS: "3" }), 997);
  assert.deepEqual(asked, ["finalized", "safe"]);
  await assert.rejects(gen8SafeHead({ getBlockNumber: async () => 5, getBlock: async () => null }, 56, {}), /did not return the 'finalized' block/, "fails closed, never falls back to the unsafe head");
});

// ------------------------------------------------------------------ F9

test("F9 link policy: defaults per chain, the API's router env, launcher, escrow, env lists", () => {
  const p56 = gen8LinkPolicy(cfg(56), {});
  for (const r of GEN8_LINK_ROUTERS[56]!) assert.ok(p56.routers.has(r));
  assert.ok(p56.routers.has(LAUNCHER) && p56.routers.has(ESCROW));
  assert.ok(!p56.routers.has(VAULT), "buybacks are never linked");
  assert.equal(p56.maxSwapSenders, 4);
  const extra = "0x1111111111111111111111111111111111111111";
  const bot = "0x2222222222222222222222222222222222222222";
  const p97 = gen8LinkPolicy(cfg(97), { EVM_GEN8_UNIVERSAL_ROUTER_97: extra.toUpperCase().replace("0X", "0x"), EVM_GEN8_LINK_DENY: bot, EVM_GEN8_LINK_MAX_SWAP_SENDERS: "3" });
  assert.ok(p97.routers.has(extra));
  assert.ok(!p97.routers.has(GEN8_LINK_ROUTERS[56]![0]!), "testnets: no mainnet defaults");
  assert.ok(p97.deny.has(bot));
  assert.equal(p97.maxSwapSenders, 3);
});

test("F9 link check: only a trade the wallet sent itself through an allowed router keeps its link", () => {
  const UR = GEN8_LINK_ROUTERS[56]![0]!;
  const user = "0x3333333333333333333333333333333333333333";
  const relayer = "0x4444444444444444444444444444444444444444";
  const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032";
  const smartAccount = "0x5555555555555555555555555555555555555555";
  const policy = gen8LinkPolicy(cfg(56), { EVM_GEN8_LINK_DENY_56: relayer });
  const ok = (t: Partial<Parameters<typeof gen8LinkCheck>[1]>) => gen8LinkCheck(policy, { txFrom: user, txTo: UR, swapSender: UR, distinctSwapSenders: 1, ...t });
  assert.deepEqual(ok({}), { linkable: true, reason: null }, "user -> app UniversalRouter");
  assert.equal(ok({ txTo: LAUNCHER, swapSender: LAUNCHER }).linkable, true, "creator first buy through the launcher");
  assert.equal(ok({ swapSender: smartAccount, txTo: entryPoint }).reason, "swap_sender_not_allowed", "4337: the swap sender is the smart account");
  assert.equal(ok({ txTo: entryPoint }).reason, "tx_to_is_not_the_router", "4337 bundle calling the router through the EntryPoint");
  assert.equal(ok({ txTo: "0x6666666666666666666666666666666666666666" }).reason, "tx_to_is_not_the_router", "forwarder / multicall / 7702 self-call");
  assert.equal(ok({ txTo: null }).reason, "tx_to_is_not_the_router");
  assert.equal(ok({ txFrom: relayer }).reason, "tx_from_denylisted");
  assert.equal(ok({ distinctSwapSenders: 4 }).reason, "tx_from_uses_many_swap_senders");
  assert.equal(ok({ distinctSwapSenders: 3 }).linkable, true);
});

// ------------------------------------------------------------------ F12

test("F12 league exclusion: hook creator and swap sender count, not tx.from alone", () => {
  const creator = "0x7777777777777777777777777777777777777777";
  const creatorContract = "0x8888888888888888888888888888888888888888";
  const trader = "0x9999999999999999999999999999999999999999";
  const UR = "0xdc264714f68d84cf29bc605589405e78bdbe7c9f";
  const c = cfg(56);
  const keep = { creator, hookCreator: creator };
  const choice = { creator, hookCreator: VAULT };
  assert.equal(gen8LeagueExcluded(c, keep, trader, UR), false, "a normal trade counts");
  assert.equal(gen8LeagueExcluded(c, keep, creator, UR), true, "creator by tx.from (as before)");
  assert.equal(gen8LeagueExcluded(c, { creator: creatorContract, hookCreator: creatorContract }, trader, creatorContract), true, "creator contract wallet as swap sender");
  assert.equal(gen8LeagueExcluded(c, { creator: "0x0000000000000000000000000000000000000fff", hookCreator: creator }, creator, UR), true, "hook creator by tx.from");
  assert.equal(gen8LeagueExcluded(c, choice, trader, VAULT), true, "choice vault buyback");
  assert.equal(gen8LeagueExcluded(c, keep, trader, ESCROW), true, "escrow buy");
  assert.equal(gen8LeagueExcluded(c, keep, trader, LAUNCHER), true, "launcher first buy");
});

// ------------------------------------------------------------------ F11: decoding of the control events

test("F11 control events decode: hook / launcher ownership, splitter and choice-vault operator", () => {
  const A = { launcher: LAUNCHER, hook: HOOK, poolManager: "0x0000000000000000000000000000000000000002", splitter: SPLITTER, choiceVault: VAULT };
  const a1 = "0x00000000000000000000000000000000000000a1";
  const a2 = "0x00000000000000000000000000000000000000a2";
  const log = (address: string, iface: ethers.Interface, name: string, args: unknown[]) => {
    const { topics, data } = iface.encodeEventLog(iface.getEvent(name)!, args);
    return { address, topics, data, blockNumber: 5, transactionHash: "0x" + "11".repeat(32), index: 3 };
  };
  const e1 = decodeGen8Log(log(HOOK, GEN8_HOOK_IFACE, "OwnershipTransferStarted", [a1, a2]), A) as any;
  assert.deepEqual([e1.kind, e1.previous, e1.next, e1.source], ["OwnershipTransferStarted", a1, a2, "hook"]);
  const e2 = decodeGen8Log(log(LAUNCHER, GEN8_LAUNCHER_IFACE, "OwnershipTransferred", [a1, a2]), A) as any;
  assert.deepEqual([e2.kind, e2.source], ["OwnershipTransferred", "launcher"]);
  const e3 = decodeGen8Log(log(SPLITTER, GEN8_SPLITTER_IFACE, "OperatorUpdated", [a1, a2]), A) as any;
  assert.deepEqual([e3.kind, e3.previous, e3.next, e3.source], ["OperatorUpdated", a1, a2, "splitter"]);
  const e4 = decodeGen8Log(log(VAULT, GEN8_CHOICE_VAULT_IFACE, "OperatorUpdated", [a2, true]), A) as any;
  assert.deepEqual([e4.kind, e4.next, e4.paused, e4.source], ["OperatorUpdated", a2, true, "choice_vault"]);
  // topic0 pinned against contracts/gen8/abi on build/evm-gen8 (aac801d5)
  assert.equal(GEN8_TOPICS.SplitterOperatorUpdated, "0xfbe5b6cbafb274f445d7fed869dc77a838d8243a22c460de156560e8857cad03");
  assert.equal(GEN8_TOPICS.VaultOperatorUpdated, "0x966c160e1c4dbc7df8d69af4ace01e9297c3cf016397b7914971f2fbfa32672d");
  assert.equal(GEN8_TOPICS.OwnershipTransferStarted, "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700");
  assert.equal(GEN8_TOPICS.OwnershipTransferred, "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0");
});

// ------------------------------------------------------------------ F11: Routed vs plan

const T = 10n ** 16n;
const B = 10_600_000_000_000n;
const run = (o: Partial<Record<string, bigint>> = {}) => ({ total: T, bondingFees: B, gradFees: 0n, weeklyLeague: 1n, monthlyLeague: 2n, recruiter: 3n, squad: 4n, airdrop: 5n, protocol: T - 15n, ...o });
const plannedRow = (o: Record<string, unknown> = {}) => ({
  status: "sent", total: String(T), bonding_fees: String(B), grad_fees: "0", weekly_league: "1", monthly_league: "2", recruiter: "3", squad: "4", airdrop: "5", protocol: String(T - 15n),
  accrual_root: "0x" + "aa".repeat(32), caller: OPERATOR, ...o,
});

test("F11 routedPlanDifferences: equal run -> nothing; every field, root and caller are checked; no plan is a difference", () => {
  const ok = { run: run(), accrualRoot: "0x" + "aa".repeat(32), caller: OPERATOR };
  assert.deepEqual(routedPlanDifferences(plannedRow(), ok, new Set()), []);
  assert.deepEqual(routedPlanDifferences(plannedRow({ status: "confirmed" }), { ...ok, caller: "0xdead" }, new Set()), [], "a re-scan of a confirmed run");
  assert.match(routedPlanDifferences(plannedRow(), { ...ok, run: run({ recruiter: 99n }) }, new Set()).join(), /recruiter planned 3 routed 99/);
  assert.match(routedPlanDifferences(plannedRow(), { ...ok, accrualRoot: "0x" + "bb".repeat(32) }, new Set()).join(), /accrualRoot/);
  assert.match(routedPlanDifferences(plannedRow(), { ...ok, caller: "0x000000000000000000000000000000000000dead" }, new Set()).join(), /caller/);
  assert.deepEqual(routedPlanDifferences(plannedRow({ caller: null }), ok, new Set([OPERATOR])), [], "dry-run plan: the indexed operator is expected");
  assert.match(routedPlanDifferences(plannedRow({ caller: null }), ok, new Set()).join(), /caller .* is not a known operator/);
  assert.deepEqual(routedPlanDifferences(undefined, ok, new Set([OPERATOR])), ["no plan for this run"]);
});

/** A minimal in-memory DB for recordRoutedRun / runGen8RoutePass (the shape audit C's PoC uses). */
function fakeDb(state: { runs: Map<number, any>; claims: Array<{ block: number; log: number; amount: bigint; B: bigint; G: bigint }>; rows: any[]; sent?: any; cursor?: number }) {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string, params: any[] = []) {
      sql.push(text);
      if (text.includes("from public.indexer_state")) return { rows: [{ last_indexed_block: state.cursor ?? 1001 }] };
      if (text.includes("status = 'sent'") && text.includes("limit 1")) return { rows: state.sent ? [state.sent] : [] };
      if (text.includes("coalesce(max(run_id)")) return { rows: [{ last: [...state.runs.values()].filter((r) => r.status === "confirmed").length }] };
      if (text.includes("event_name = 'RouterClaimed'")) return { rows: state.claims.map((c, i) => ({ block_number: c.block, log_index: c.log, tx_hash: `0xc${i}`, args: { amount: String(c.amount), bondingFees: String(c.B), gradFees: String(c.G) } })) };
      if (text.includes("event_name = 'OperatorUpdated'")) return { rows: [{ next: OPERATOR }] };
      if (text.includes("from public.evm_gen8_fee_accruals") && text.includes("run_id is null") && text.includes("block_number <")) {
        const [, , b, l] = params;
        return { rows: state.rows.filter((r) => r.run_id === null && (r.block < b || (r.block === b && r.log < l))).map((r) => ({ id: r.id, tx_hash: r.tx, log_index: r.log, block_number: r.block, kind: "trade", phase: "bonding", trader: "0x0000000000000000000000000000000000000abc", profile: "standard_unlinked", fee: String(r.fee), router_amount: String(r.router), league_weekly: "0", league_monthly: "0", recruiter: "0", squad: "0", airdrop: "0", protocol: "0" })) };
      }
      if (text.includes("select status, leaves, accrual_root")) return { rows: state.runs.has(Number(params[2])) ? [state.runs.get(Number(params[2]))] : [] };
      if (text.includes("coalesce(sum(total), 0)")) {
        let t = 0n;
        for (const [id, r] of state.runs) if (r.status === "confirmed" && id <= Number(params[2])) t += BigInt(r.total);
        return { rows: [{ t: t.toString() }] };
      }
      if (text.includes("insert into public.evm_gen8_route_runs")) {
        const id = Number(params[2]);
        if (text.includes("'confirmed'")) state.runs.set(id, { ...(state.runs.get(id) || {}), status: "confirmed", total: params[3] });
        else state.runs.set(id, { status: params[3], total: params[5], caller: params[20] });
        return { rows: [] };
      }
      if (text.includes("set status = 'failed'")) {
        if (state.sent) state.sent = { ...state.sent, failed: params[3] };
        state.sent = undefined;
        return { rows: [] };
      }
      if (text.includes("update public.evm_gen8_fee_accruals set run_id")) {
        const r = state.rows.find((x) => x.id === params[0]);
        if (r && r.run_id === null) r.run_id = params[1];
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test("F11 / audit C-L3 replay: a run routed with other amounts, root and caller than the plan raises a critical alert", async () => {
  const state = {
    claims: [{ block: 10, log: 5, amount: T, B, G: 0n }],
    rows: [{ id: 1, block: 9, log: 1, fee: B, router: T, run_id: null, tx: "0xd1" }],
    runs: new Map<number, any>([[1, { status: "sent", total: String(T), accrual_root: "0x" + "aa".repeat(32), leaves: [{ txHash: "0xd1", logIndex: 1, kind: 0 }] }]]),
  };
  const alerts: any[] = [];
  const rsaMax = (B * 1750n) / 10000n;
  const e: any = { kind: "Routed", runId: 1n, accrualRoot: "0x" + "bb".repeat(32), caller: "0x000000000000000000000000000000000000dead", txHash: "0xr1", blockNumber: 11, logIndex: 0, address: SPLITTER, run: { total: T, bondingFees: B, gradFees: 0n, weeklyLeague: 0n, monthlyLeague: 0n, recruiter: rsaMax, squad: 0n, airdrop: 0n, protocol: 0n } };
  await recordRoutedRun(fakeDb(state) as any, cfg(), e, new Date(), async (a: any) => void alerts.push(a), {});
  const a = alerts.find((x) => x.kind === "gen8_routed_differs_from_plan");
  assert.ok(a, JSON.stringify(alerts));
  assert.equal(a.severity, "critical");
  assert.match(a.message, /recruiter planned none routed/);
  assert.match(a.message, /accrualRoot/);
  assert.match(a.message, /caller 0x000000000000000000000000000000000000dead/);
  // a run nobody planned
  const alerts2: any[] = [];
  await recordRoutedRun(fakeDb({ ...state, runs: new Map(), rows: [{ id: 1, block: 9, log: 1, fee: B, router: T, run_id: null, tx: "0xd1" }] }) as any, cfg(), { ...e, caller: OPERATOR }, new Date(), async (x: any) => void alerts2.push(x), {});
  assert.ok(alerts2.some((x) => x.kind === "gen8_routed_differs_from_plan" && /no plan for this run/.test(x.message)));
});

// ------------------------------------------------------------------ F11: route worker (PaidMismatch streak, dropped tx) and C-M2

function chainState(o: Partial<Record<string, any>> = {}) {
  return {
    runs: 0n, paid: T, pendingTotal: T, pendingBonding: B, pendingGrad: 0n, routerOwed: 0n, treasuryRouter: SPLITTER, operator: OPERATOR,
    bands: async (b: bigint, g: bigint) => splitterBands(b, g),
    ...o,
  };
}

test("F11 repeated PaidMismatch: an alert after N in a row, the streak resets after a sent run", async () => {
  const state = { claims: [{ block: 10, log: 5, amount: T, B, G: 0n }], rows: [{ id: 1, block: 9, log: 1, fee: B, router: T, run_id: null, tx: "0x" + "d1".repeat(32) }], runs: new Map<number, any>() };
  const db = fakeDb(state);
  let fail = true;
  const chain = {
    readState: async () => chainState(),
    sendClaim: async () => ({ hash: "0xclaim", blockNumber: 30 }),
    sendRoute: async () => {
      if (fail) throw Object.assign(new Error("execution reverted"), { data: "0x3897fc19" + "00".repeat(64) });
      return "0xroute";
    },
    waitReceipt: async () => null,
    headBlock: async () => 1000,
  };
  const alerts: any[] = [];
  const streak = new Map<string, number>();
  const pass = () => runGen8RoutePass({ db: db as any, cfg: cfg(), chain, send: true, operatorAddress: OPERATOR, minWei: 0n, alert: async (a: any) => void alerts.push(a), paidMismatchStreak: streak, paidMismatchAlertAfter: 3 });
  for (let i = 0; i < 2; i++) assert.equal(((await pass()) as any).reason, "paid-mismatch-replan");
  assert.equal(alerts.filter((a) => a.kind === "gen8_paid_mismatch_repeated").length, 0, "two in a row: no alert yet");
  await pass();
  assert.equal(alerts.filter((a) => a.kind === "gen8_paid_mismatch_repeated").length, 1, "third in a row: alert");
  fail = false;
  assert.equal((await pass()).status, "sent");
  assert.equal(streak.size, 0, "streak reset");
  assert.equal(state.runs.get(1)?.caller, OPERATOR, "the plan records who is expected to send route()");
});

test("F11 dropped route(): no receipt after the timeout and unknown to the node -> failed, alerted, re-planned and re-sent; pending -> stuck alert", async () => {
  const mk = (known: boolean) => {
    const state: any = {
      claims: [{ block: 10, log: 5, amount: T, B, G: 0n }], rows: [{ id: 1, block: 9, log: 1, fee: B, router: T, run_id: null, tx: "0x" + "d1".repeat(32) }], runs: new Map<number, any>(),
      sent: { run_id: 1, tx_hash: "0xold", updated_at: new Date(Date.now() - 20 * 60_000).toISOString() },
    };
    let routes = 0;
    const chain = {
      readState: async () => chainState(),
      sendClaim: async () => ({ hash: "0xclaim", blockNumber: 30 }),
      sendRoute: async () => (routes++, "0xnew"),
      waitReceipt: async () => null,
      headBlock: async () => 1000,
      txKnown: async () => known,
    };
    return { state, chain, routes: () => routes };
  };
  const dropped = mk(false);
  const alerts: any[] = [];
  const r = await runGen8RoutePass({ db: fakeDb(dropped.state) as any, cfg: cfg(), chain: dropped.chain, send: true, operatorAddress: OPERATOR, minWei: 0n, alert: async (a: any) => void alerts.push(a), dropAfterMs: 15 * 60_000 });
  assert.equal(r.status, "sent", JSON.stringify(r));
  assert.equal(dropped.routes(), 1, "re-sent in the same pass");
  assert.ok(alerts.some((a) => a.kind === "gen8_route_dropped"));
  const stuck = mk(true);
  const alerts2: any[] = [];
  const r2 = await runGen8RoutePass({ db: fakeDb(stuck.state) as any, cfg: cfg(), chain: stuck.chain, send: true, operatorAddress: OPERATOR, minWei: 0n, alert: async (a: any) => void alerts2.push(a), dropAfterMs: 15 * 60_000 });
  assert.equal((r2 as any).reason, "run-sent-awaiting-routed");
  assert.equal(stuck.routes(), 0);
  assert.ok(alerts2.some((a) => a.kind === "gen8_route_stuck"));
  const young = mk(false);
  young.state.sent.updated_at = new Date().toISOString();
  const r3 = await runGen8RoutePass({ db: fakeDb(young.state) as any, cfg: cfg(), chain: young.chain, send: true, operatorAddress: OPERATOR, minWei: 0n, dropAfterMs: 15 * 60_000 });
  assert.equal((r3 as any).reason, "run-sent-awaiting-routed", "before the timeout nothing changes");
});

test("audit C-M2 (off-chain part of F4): a foreign dust claim no longer parks the worker; it claims the hook's bucket on top", async () => {
  const RUN1 = 5n * 10n ** 16n;
  const DUST = 1_000n;
  const state = {
    claims: [{ block: 10, log: 5, amount: RUN1, B: RUN1, G: 0n }, { block: 20, log: 3, amount: DUST, B: 1_060n, G: 0n }],
    rows: [{ id: 1, block: 19, log: 1, fee: 1_060n, router: DUST, run_id: null, tx: "0xd1" }],
    runs: new Map<number, any>([[1, { status: "confirmed", total: String(RUN1) }]]),
  };
  let claims = 0;
  const chain = {
    readState: async () => chainState({ runs: 1n, paid: RUN1 + DUST, pendingTotal: DUST, pendingBonding: 1_060n, routerOwed: 10n ** 18n }),
    sendClaim: async () => (claims++, { hash: "0xclaim", blockNumber: 30 }),
    sendRoute: async () => "0xroute",
    waitReceipt: async () => null,
    headBlock: async () => 1000,
  };
  const r = await runGen8RoutePass({ db: fakeDb(state) as any, cfg: cfg(), chain, send: true, operatorAddress: OPERATOR, minWei: 10n ** 15n });
  assert.equal(r.status, "claimed");
  assert.equal(claims, 1);
  const dry = await runGen8RoutePass({ db: fakeDb(state) as any, cfg: cfg(), chain, send: false, minWei: 10n ** 15n });
  assert.equal((dry as any).reason, "below-minimum", "dry run never claims");
});
