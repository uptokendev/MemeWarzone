/**
 * DogeOS Chikyū (6281971) Bark fork rehearsal and DOGE budget: Gate 3 (barkswap plan t27; spec
 * docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md section 5 "Gates", "Roles and keys (B9)").
 *
 *   npx hardhat compile && npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile      (both builds current)
 *   npx hardhat --config hardhat.dogeos-bark-fork.config.ts run scripts/rehearse-dogeos-bark-fork.ts
 *
 * One in-process hardhat fork of Chikyū (fork block DOGEOS_FORK_BLOCK, default 8,578,734) runs:
 *   deploy   the real t15 entrypoints, scripts/deploy-dogeos-testnet.ts then scripts/activate-dogeos-testnet.ts (fork
 *            mode: outputs to a fresh os.tmpdir() directory, never into the repo)
 *   coin A   (keep) oracle push, launch with a creator first buy, 5 buyer wallets inside the 60 s launch window, approve +
 *            sell, collect, convert, the graduating buy (inline 2% fee), a post-graduation buy, collect, creator claim,
 *            claimRouter + route (operator), reserve release after its 1 h delay, a restore no-op check, escrow buy and
 *            (30 days later) escrow claim
 *   coin B   (buyback) oracle push, launch with a first buy, volume, collect, pull, buyback (operator)
 *   coin C   (incident lane) a simulated Barkswap admin change (setPluginConfig 133) lets a buy pass graduation without
 *            the latch; restore, the latching conversion (inline fee deferred) and the graduation-fee fallback (keeper)
 * Gas per step (every one asserted <= the 10M block; launches <= 7M), and for each step the DOGE cost: L2 gas x the
 * live L2 gas price plus L1GasPriceOracle.getL1Fee(raw-tx bytes + margin), read at the live oracle ("latest", the
 * budget) and at the fork block (on the fork). Then per-role totals, recommended funding, the keeper / operator /
 * oracle-updater cost per day at an assumed testnet activity, and the app's gas-floor and DOGE-reserve verdicts.
 * Writes reports/dogeos/bark-fork-rehearsal.json (role names only; no address, hash or key).
 *
 * Keys and the live chain: hardhat's local test accounts sign (#0 deployer/admin, #1 route authority, #2 operator, #3
 * keeper, #4 creator, #5-#9 buyers); the oracle updater fixed by the deploy and Barkswap's admin are impersonated on the
 * fork. No key is loaded, no config/*.local or .env file is read. The live RPC is used only for eth_call (getL1Fee and
 * the oracle's fee parameters), eth_gasPrice and eth_getBlockByNumber, through a read-only wrapper with no signer.
 * The deploy entrypoint's broadcast token is set in this process only after the network is checked to be the
 * in-process hardhat fork of 6281971, where the guards (scripts/lib/dogeosTestnetDeployGuards.mjs) run it in fork mode.
 * Pure parts: scripts/lib/dogeosBarkBudget.mjs (tests: scripts/rehearse-dogeos-bark-fork.test.mjs).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { JsonRpcProvider, type Block, type ContractTransactionReceipt, type TransactionReceipt } from "ethers";
import {
  BARKSWAP,
  barkswapContracts,
  barkSwapOf,
  eventsOf,
  impersonate,
  latestTimestamp,
  launchCoin,
  mineAt,
  poolState,
  quoteBuy,
  raiseOfA,
  readyFork,
  routerBuy,
  routerSell,
  WAD,
  type BarkStack,
  type C,
} from "../test/dogeos/barkswap/fixtures/barkswap";
import { hardhatForkUrl, runDogeosTestnetDeploy } from "./deploy-dogeos-testnet";
import { runDogeosTestnetActivate } from "./activate-dogeos-testnet";
import { loadDogeosDeployGuards } from "./lib/dogeosBarkStack";
import { DOGEOS_TESTNET_CHAIN_ID, DOGEOS_TESTNET_DEFAULT_RPC_URL } from "./lib/dogeosNetwork";

const ROOT = path.resolve(__dirname, "..");
const REPORT_PATH = path.join(ROOT, "reports", "dogeos", "bark-fork-rehearsal.json");
const L1_ORACLE = "0x5300000000000000000000000000000000000002";
const L1_ORACLE_ABI = [
  "function getL1Fee(bytes) view returns (uint256)",
  "function l1BaseFee() view returns (uint256)",
  "function l1BlobBaseFee() view returns (uint256)",
  "function commitScalar() view returns (uint256)",
  "function blobScalar() view returns (uint256)",
  "function penaltyThreshold() view returns (uint256)",
  "function penaltyFactor() view returns (uint256)",
];
const ORACLE_PARAMS = ["l1BaseFee", "l1BlobBaseFee", "commitScalar", "blobScalar", "penaltyThreshold", "penaltyFactor"] as const;
const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
/** The app's gas floors (frontend/src/lib/evmGen8Client.mjs BARK_LAUNCH_GAS_FLOOR / BARK_TRADE_GAS_FLOOR). */
const APP_LAUNCH_GAS_FLOOR = 7_000_000n;
const APP_TRADE_GAS_FLOOR = 1_000_000n;
/**
 * The app's DOGE reserves come from the budget module, which re-exports frontend/shared/dogeosGasReserve.mjs (plan t34):
 * the floors (DOGE_BUY_RESERVE_FLOOR_WEI / DOGE_LAUNCH_RESERVE_FLOOR_WEI) and the live estimate the app keeps back,
 * max(floor, (L1 fee + gas limit x price) x 1.5). No copy of the numbers here.
 */
/** Binance stand-in for the deploy's run-time prices (reproducible run; gas does not depend on them): DOGE $0.25, ETH $3000. */
const PRICES: Record<string, string> = { DOGEUSDT: "0.25000000", ETHUSDT: "3000.00000000" };
const DOGE_USD_ANSWER = 25_000_000n;
const HEADROOM = 3;
const FUNDING_DAYS = 7;
/**
 * Assumed testnet activity per day (stated in the report): 5 active coins, the keeper collecting each 4x and converting
 * each 2x a day, 2 choice-vault pulls, 1 reserve release; hourly route runs (claimRouter + route); one buyback coin at the
 * vault's minimum interval (21,600 s: 4 a day); the oracle push's 1,800 s heartbeat (48) plus 24 deviation pushes.
 * Restore and the graduation-fee fallback only follow a Barkswap admin change: counted as 0 a day, funded by headroom.
 */
const ACTIVITY_PER_DAY = {
  keeper: { collect: 20, convert: 10, pull: 2, reserveRelease: 1, restore: 0, graduationFeeFallback: 0 },
  operator: { claimRouter: 24, route: 24, buyback: 4 },
  oracleUpdater: { oraclePush: 72 },
};
const MAX_SIG = { r: "0x" + "ff".repeat(32), s: "0x7f" + "ff".repeat(31), yParity: 1 as const };

type Budget = any;
const loadBudget = (): Promise<Budget> =>
  Function("s", "return import(s)")(pathToFileURL(path.join(__dirname, "lib", "dogeosBarkBudget.mjs")).href);

const log = (line: string) => console.log(`[rehearse-dogeos-bark] ${line}`);
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);

function need(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
}

// ------------------------------------------------------------------------------------------------ live RPC (read only)

let liveRetries = 0;
async function retry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      liveRetries++;
      log(`${what}: attempt ${i + 1} failed (${(e as any)?.shortMessage ?? (e as Error)?.message}); retrying`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

interface LiveReader {
  call(to: string, data: string, blockTag?: string | number): Promise<string>;
  gasPrice(): Promise<bigint>;
  block(tag: string | number): Promise<Block | null>;
}

/** Only reads: no signer, no send of a transaction. */
function liveReader(url: string): LiveReader {
  const p = new JsonRpcProvider(url, DOGEOS_TESTNET_CHAIN_ID, { staticNetwork: true });
  return {
    call: (to, data, blockTag = "latest") => retry(`live eth_call ${data.slice(0, 10)}`, () => p.call({ to, data, blockTag })),
    gasPrice: () => retry("live eth_gasPrice", async () => BigInt(await p.send("eth_gasPrice", []))),
    block: (tag) => retry(`live block ${tag}`, () => p.getBlock(tag)),
  };
}

// ------------------------------------------------------------------------------------------------ step recording

type Lane = "deploy" | "lifecycle" | "incident";
interface Sent {
  name: string;
  role: string;
  lane: Lane;
  kind: string;
  hash: string;
  gas: bigint;
}

const sent: Sent[] = [];
const checks: string[] = [];

function rec(name: string, role: string, lane: Lane, kind: string, rc: TransactionReceipt | ContractTransactionReceipt | null): ContractTransactionReceipt {
  need(rc && rc.status === 1, `${name}: mined with status 1`);
  sent.push({ name, role, lane, kind, hash: rc!.hash, gas: rc!.gasUsed });
  log(`${name} [${role}] gas ${rc!.gasUsed}`);
  return rc as ContractTransactionReceipt;
}

/** The step's transaction as Chikyū would carry it: same nonce, gas limit, to, value and data, the chain's fee fields,
 *  a maximum-length signature. App users (creator, buyers) send legacy type 0 (the app's gen8GasOverrides); our keys
 *  type 2. */
async function rawEquivalent(hash: string, role: string, l2Price: bigint): Promise<string> {
  const tx = await ethers.provider.getTransaction(hash);
  need(tx, `transaction ${hash} on the fork`);
  const base = { chainId: BigInt(DOGEOS_TESTNET_CHAIN_ID), nonce: tx!.nonce, gasLimit: tx!.gasLimit, to: tx!.to, value: tx!.value, data: tx!.data };
  const legacy = role === "creator" || role === "buyer";
  const t = legacy
    ? ethers.Transaction.from({ ...base, type: 0, gasPrice: l2Price })
    : ethers.Transaction.from({ ...base, type: 2, maxFeePerGas: l2Price * 2n, maxPriorityFeePerGas: 100n, accessList: [] });
  t.signature = ethers.Signature.from(MAX_SIG);
  return t.serialized;
}

// ------------------------------------------------------------------------------------------------ main

async function main() {
  const budget = await loadBudget();
  const startedAt = new Date().toISOString();

  // ---------------------------------------------------------------- fork only
  const forkUrl = hardhatForkUrl();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (network.name !== "hardhat" || !forkUrl || chainId !== DOGEOS_TESTNET_CHAIN_ID) {
    throw new Error(`refusing: this rehearsal runs only on the in-process hardhat fork of ${DOGEOS_TESTNET_CHAIN_ID} (got ${network.name}, chain ${chainId}, fork ${forkUrl || "none"}); use --config hardhat.dogeos-bark-fork.config.ts`);
  }
  const { forkBlock } = await readyFork();
  const guards = await loadDogeosDeployGuards();
  const signers = await ethers.getSigners();
  need(signers.length >= 10, "10 hardhat accounts");
  const [deployer, routeAuthority, operator, keeper, creator, ...buyers] = signers as HardhatEthersSigner[];
  const routeAuthorityNonce0 = await ethers.provider.getTransactionCount(routeAuthority.address);
  log(`fork of ${forkUrl} at block ${forkBlock}, chain ${chainId}`);

  // ---------------------------------------------------------------- deploy + activate (the t15 entrypoints)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dogeos-bark-rehearsal-"));
  const manifestPath = path.join(tmp, "testnet.bark.json");
  const envKeys = ["DOGEOS_TESTNET_DEPLOY_BROADCAST", "DOGEOS_TESTNET_ACTIVATE_BROADCAST", "DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS", "DOGEOS_OPERATOR_ADDRESS", "DOGEOS_TESTNET_MANIFEST"];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    DOGEOS_TESTNET_DEPLOY_BROADCAST: "I_HAVE_FOUNDER_GO", // fork mode only (checked above; the guards refuse anything else)
    DOGEOS_TESTNET_ACTIVATE_BROADCAST: "I_HAVE_FOUNDER_GO",
    DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS: routeAuthority.address,
    DOGEOS_OPERATOR_ADDRESS: operator.address,
    DOGEOS_TESTNET_MANIFEST: manifestPath,
  });
  const fakeFetch = async (input: any) => {
    const symbol = new URL(String(input)).searchParams.get("symbol") ?? "";
    if (!PRICES[symbol]) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ symbol, price: PRICES[symbol] }), { status: 200 });
  };

  const failedSteps: Array<{ name: string; error: string }> = [];
  let current = "deploy";
  try {
    const deployed = await runDogeosTestnetDeploy({ fetchImpl: fakeFetch as any, log: (l) => log(`deploy: ${l}`) });
    need(deployed.mode === "chikyu-fork", "deploy ran in fork mode");
    need(path.relative(ROOT, deployed.manifestPath).startsWith(".."), "the fork manifest is outside the repo");
    const record = deployed.record;
    for (const t of record.txs as Array<{ label: string; hash: string }>) {
      rec(`deploy: ${t.label}`, "deployer", "deploy", "deploy", await ethers.provider.getTransactionReceipt(t.hash));
    }
    let activateHash = "";
    current = "activate";
    const act = await runDogeosTestnetActivate({
      log: (l) => {
        const m = /setCreatePaused\(false\): (0x[0-9a-fA-F]{64})/.exec(l);
        if (m) activateHash = m[1];
        log(`activate: ${l}`);
      },
    });
    need(act.calls.join() === "setCreatePaused(false)" && activateHash, "activation sent setCreatePaused(false)");
    rec("activate: setCreatePaused(false)", "deployer", "deploy", "deploy", await ethers.provider.getTransactionReceipt(activateHash));
    checks.push(`t15 deploy (${record.txs.length} transactions) and activation ran through scripts/deploy-dogeos-testnet.ts and scripts/activate-dogeos-testnet.ts in fork mode; manifest outside the repo`);

    // ---------------------------------------------------------------- the stack as the fork-test helpers take it
    const d = record.deployed;
    const at = async (name: string, address: string) => (await ethers.getContractAt(name, address)) as unknown as C;
    const updater = (await impersonate(guards.DOGEOS_TESTNET_ROLES.oracleUpdater)) as HardhatEthersSigner;
    const feed = new ethers.Contract(record.oracle.dogeUsd, ["function updateAnswer(int256) returns (uint80)"], updater) as unknown as C;
    const s = {
      signers: { deployer, createSigner: routeAuthority, creator, trader: buyers[0], trader2: buyers[1], outsider: keeper, operator, oracleUpdater: updater, keeper, spare: buyers[4] },
      feed,
      graduationOracle: await at("contracts/GraduationOracle.sol:GraduationOracle", record.oracle.graduationOracle),
      launchLib: null,
      feeBooks: null,
      plugin: await at("MwzBarkPlugin", d.MwzBarkPlugin),
      launcher: await at("MwzBarkLauncher", d.MwzBarkLauncher),
      reserveLock: await at("MwzBarkReserveLock", d.MwzBarkReserveLock),
      choiceVault: await at("MwzBarkCreatorChoiceVault", d.MwzBarkCreatorChoiceVault),
      escrow: await at("MwzBarkCreatorEscrow", d.MwzBarkCreatorEscrow),
      splitter: await at("MwzBarkFeeSplitter", d.MwzBarkFeeSplitter),
      lens: await at("MwzBarkLaunchLens", d.MwzBarkLaunchLens),
      barkswap: await barkswapContracts(),
      vaults: {},
      deployGas: {},
      contracts: () => ({}),
    } as unknown as BarkStack;
    const L = s.launcher;
    const keeperL = L.connect(keeper) as C;

    const push = async (name: string) => {
      current = name;
      rec(name, "oracleUpdater", "lifecycle", "oraclePush", await (await feed.updateAnswer(DOGE_USD_ANSWER)).wait());
    };
    const collect = async (name: string, coin: string, lane: Lane = "lifecycle") => {
      current = name;
      const rc = rec(name, "keeper", lane, "collect", await (await keeperL.collect(coin, { gasLimit: 3_000_000n })).wait());
      need(eventsOf(rc, L, "FeesCollected").length === 1, `${name}: FeesCollected`);
      return rc;
    };
    const approveAndSell = async (name: string, buyer: HardhatEthersSigner, coin: string, amount: bigint, lane: Lane = "lifecycle") => {
      current = `${name}: approve`;
      const token = await ethers.getContractAt(IERC20, coin, buyer);
      rec(`${name}: approve (the app's exact approval)`, "buyer", lane, "approve", await (await token.approve(BARKSWAP.swapRouter, amount)).wait());
      current = name;
      return rec(name, "buyer", lane, "sell", await routerSell(s, buyer, coin, amount));
    };
    const buy = async (name: string, buyer: HardhatEthersSigner, coin: string, value: bigint, lane: Lane = "lifecycle") => {
      current = name;
      return rec(name, "buyer", lane, "buy", await routerBuy(s, buyer, coin, value));
    };
    const launch = async (name: string, o: Parameters<typeof launchCoin>[1]) => {
      current = name;
      const r = await launchCoin(s, o);
      rec(name, "creator", "lifecycle", "launch", r.receipt);
      need(r.gasUsed <= budget.LAUNCH_GAS_GATE, `${name}: launch gas ${r.gasUsed} <= 7M (spec section 5)`);
      return r;
    };

    // ================================================================ coin A: keep, the full lifecycle
    await push("oracle push (before launch A)");
    const A = await launch("launch A (keep, creator first buy 5 DOGE)", { creator, firstBuy: 5n * WAD, feeChoice: 1, name: "Rehearsal Keep", symbol: "RKEEP" });
    const raiseA = raiseOfA(A);
    const windowBuy = raiseA / 40n;
    for (const [i, b] of buyers.slice(0, 5).entries()) {
      const rc = await buy(`A: launch-window buy, buyer ${i + 1}`, b, A.coin, windowBuy);
      const ts = BigInt((await ethers.provider.getBlock(rc.blockNumber))!.timestamp);
      need(ts < A.openAt + 60n, `buyer ${i + 1} bought inside the 60 s launch window (t=${ts - A.openAt}s)`);
      need(barkSwapOf(s, rc).rateBps > 200n, `buyer ${i + 1} paid the launch-window rate`);
    }
    checks.push("5 buyer wallets bought coin A inside the 60 s launch window, each at the decaying launch-window rate");
    await mineAt(A.openAt + 61n);
    const held1 = await (await ethers.getContractAt(IERC20, A.coin)).balanceOf(buyers[0].address);
    await approveAndSell("A: sell (bonding), buyer 1", buyers[0], A.coin, held1 / 2n);
    await collect("A: collect (bonding)", A.coin);
    await mineAt((await latestTimestamp()) + 601n);
    current = "A: convert";
    const convA = rec("A: convert (coin fees to DOGE)", "keeper", "lifecycle", "convert", await (await keeperL.convert(A.coin, { gasLimit: 3_000_000n })).wait());
    need(eventsOf(convA, L, "CoinFeesConverted").length === 1 && barkSwapOf(s, convA).kind === 1n, "A: conversion swap (kind 1)");
    const grad = await buy("A: graduating buy (inline 2% fee), buyer 2", buyers[1], A.coin, (raiseA * 13n) / 10n);
    need(eventsOf(grad, s.plugin, "Graduated").length === 1, "A: graduation latched");
    need(eventsOf(grad, s.plugin, "GraduationFeeInline").map((e) => e.args.ok).join() === "true", "A: inline graduation fee ok");
    need(eventsOf(grad, L, "GraduationFeeTaken").length === 1, "A: GraduationFeeTaken inline");
    checks.push("coin A graduated on a router buy; the 2% graduation fee was taken inline (no fallback needed)");
    await buy("A: post-graduation buy, buyer 3", buyers[2], A.coin, 5n * WAD);
    await collect("A: collect (post-graduation)", A.coin);

    current = "A: creator claim";
    const owedA = BigInt(await L.creatorOwed(A.coin));
    need(owedA > 0n, "A: creator fees owed");
    const claim = rec("A: creator claim (claimCreator, keep)", "creator", "lifecycle", "claimCreator", await (await (L.connect(creator) as C).claimCreator(A.coin, creator.address)).wait());
    need(BigInt(eventsOf(claim, L, "CreatorClaimed")[0].args.amount) === owedA, "A: creator claimed everything owed");

    current = "route: claimRouter";
    rec("route: claimRouter (operator, F4)", "operator", "lifecycle", "claimRouter", await (await (L.connect(operator) as C).claimRouter()).wait());
    const splitter = s.splitter.connect(operator) as C;
    const [total, B, G] = await s.splitter.pending();
    need(total > 0n && B > 0n && G > 0n, "splitter holds bonding and graduation fees");
    const bands = await s.splitter.bands(B, G);
    const rsa = bands.rsaMax as bigint;
    const squad = bands.squadMax as bigint;
    const airdrop = rsa / 3n;
    current = "route: route";
    const routed = rec(
      "route: route run 1 into the real vaults (operator)",
      "operator",
      "lifecycle",
      "route",
      await (await splitter.route(BigInt(await s.splitter.runs()) + 1n, total, rsa - squad - airdrop, squad, airdrop, ethers.id("rehearsal-run-1"))).wait(),
    );
    need(eventsOf(routed, s.splitter, "Routed").length === 1, "route: Routed");

    await mineAt((await latestTimestamp()) + 3_601n);
    current = "A: reserve release";
    const rel = rec("A: reserve release (1 h after the latch)", "keeper", "lifecycle", "reserveRelease", await (await (s.reserveLock.connect(keeper) as C).release(A.coin)).wait());
    need(eventsOf(rel, s.reserveLock, "ReserveReleased").length === 1 && same(eventsOf(rel, s.reserveLock, "ReserveReleased")[0].args.to, creator.address), "A: reserve paid to the creator");

    current = "A: restore no-op check";
    // NothingToRestore is MwzBarkLaunchLib's error (restorePool runs there), so it is matched by its selector
    let restoreRevert = "no revert";
    try {
      await keeperL.restore.staticCall(A.coin);
    } catch (e: any) {
      restoreRevert = String(e?.data ?? e?.error?.data ?? e?.info?.error?.data ?? e?.message ?? "");
    }
    need(restoreRevert.startsWith(ethers.id("NothingToRestore()").slice(0, 10)), `A: restore on an untouched pool is a no-op (reverts NothingToRestore; got "${restoreRevert.slice(0, 120)}")`);
    checks.push("restore(A) on an untouched pool reverts NothingToRestore: the keeper's admin watch sends nothing (read only, 0 DOGE)");

    current = "A: escrow buy";
    const ev = 2n * WAD;
    const q = await quoteBuy(s, A.coin, ev);
    const eb = rec("A: escrow buy (creator)", "creator", "lifecycle", "escrowBuy", await (await (s.escrow.connect(creator) as C).buy(A.coin, q.amountOut, { value: ev, gasLimit: 3_000_000n })).wait());
    need(barkSwapOf(s, eb).kind === 2n, "A: escrow buy is a kind-2 swap");
    const escrowed = BigInt(eventsOf(eb, s.escrow, "EscrowBuy")[0].args.coinsEscrowed);
    await mineAt((await latestTimestamp()) + 30n * 86_400n);
    current = "A: escrow claim";
    const ec = rec("A: escrow claim (creator, 30 days later)", "creator", "lifecycle", "escrowClaim", await (await (s.escrow.connect(creator) as C).claim(A.coin)).wait());
    need(BigInt(eventsOf(ec, s.escrow, "EscrowClaimed")[0].args.amount) === escrowed / 5n, "A: first escrow tranche (1/5) claimed");

    // ================================================================ coin B: buyback through the choice vault
    await push("oracle push (before launch B, after 30 days)");
    const Bc = await launch("launch B (buyback, creator first buy 10 DOGE)", { creator, firstBuy: 10n * WAD, feeChoice: 4, name: "Rehearsal Buyback", symbol: "RBUY" });
    await mineAt(Bc.openAt + 61n);
    await buy("B: buy (bonding), buyer 4", buyers[3], Bc.coin, raiseOfA(Bc) / 5n);
    await collect("B: collect", Bc.coin);
    current = "B: pull";
    const pulled = rec("B: pull (choice vault, keeper)", "keeper", "lifecycle", "pull", await (await (s.choiceVault.connect(keeper) as C).pull(Bc.coin)).wait());
    need(eventsOf(pulled, s.choiceVault, "Pulled").length === 1, "B: Pulled");
    const bbBal = BigInt(await s.choiceVault.buybackBalance(Bc.coin));
    const perTx = BigInt(await s.choiceVault.maxBuyPerTx());
    need(bbBal > 0n, "B: buyback balance");
    current = "B: buyback";
    const bb = rec(
      "B: buyback (operator)",
      "operator",
      "lifecycle",
      "buyback",
      await (await (s.choiceVault.connect(operator) as C).buyback(Bc.coin, bbBal < perTx ? bbBal : perTx, { gasLimit: 3_000_000n })).wait(),
    );
    need(barkSwapOf(s, bb).kind === 3n && eventsOf(bb, s.choiceVault, "Buyback").length === 1, "B: buyback is a kind-3 swap");
    checks.push("coin B (buyback choice): the keeper pulled the creator fees into the choice vault and the operator bought back (kind 3, to 0xdEaD)");

    // ================================================================ coin C: incident lane (restore, fallback fee)
    const Cc = await launch("launch C (keep, no first buy)", { creator, feeChoice: 1, name: "Rehearsal Incident", symbol: "RINC" });
    await mineAt(Cc.openAt + 61n);
    const raiseC = raiseOfA(Cc);
    const cb = await buy("C: buy (bonding), buyer 5", buyers[4], Cc.coin, raiseC / 10n, "incident");
    await approveAndSell("C: sell (bonding), buyer 5", buyers[4], Cc.coin, BigInt(barkSwapOf(s, cb).coinAmount) / 2n, "incident");
    await collect("C: collect", Cc.coin, "incident");
    current = "C: Barkswap admin setPluginConfig(133)";
    const admin = await impersonate(BARKSWAP.admin);
    rec(
      "C: Barkswap admin turns off the after-swap hook (setPluginConfig 133, simulated)",
      "barkswapAdmin",
      "incident",
      "external",
      await (await (Cc.poolContract.connect(admin) as C).setPluginConfig(133)).wait(),
    );
    await buy("C: buy past graduation without the latch, buyer 5", buyers[4], Cc.coin, (raiseC * 3n) / 2n, "incident");
    need((await s.plugin.pools(Cc.pool)).graduated === false && (await poolState(Cc.pool)).price > Cc.sqrtGrad, "C: price past graduation, no latch");
    current = "C: restore";
    const rs = rec("C: restore (keeper, after the admin change)", "keeper", "incident", "restore", await (await keeperL.restore(Cc.coin)).wait());
    need(eventsOf(rs, L, "Restored")[0].args.configReset === true, "C: restore reset the plugin config");
    await mineAt((await latestTimestamp()) + 601n);
    current = "C: convert (latching)";
    const cc = rec("C: convert (latches graduation; inline fee deferred)", "keeper", "incident", "convert", await (await keeperL.convert(Cc.coin, { gasLimit: 3_000_000n })).wait());
    need(eventsOf(cc, s.plugin, "GraduationFeeInline").map((e) => e.args.ok).join() === "false", "C: inline fee deferred inside the conversion");
    current = "C: graduation-fee fallback";
    const fb = rec("C: graduation-fee fallback (takeGraduationFee, keeper)", "keeper", "incident", "graduationFeeFallback", await (await keeperL.takeGraduationFee(Cc.pool, { gasLimit: 1_000_000n })).wait());
    need(eventsOf(fb, L, "GraduationFeeTaken")[0].args.inlineCall === false, "C: fallback fee taken (inlineCall false)");
    checks.push("incident lane (coin C): after a simulated Barkswap admin change the keeper restored the pool, the conversion latched graduation with the inline fee deferred, and the keeper took the graduation fee through the fallback");

    need((await ethers.provider.getTransactionCount(routeAuthority.address)) === routeAuthorityNonce0, "the route authority sent no transaction");
    checks.push("the route authority (create signer) only signed: its nonce is unchanged, 0 DOGE");
    current = "";
  } catch (e) {
    const error = (e as Error)?.message ?? String(e);
    failedSteps.push({ name: current || "rehearsal", error: error.slice(0, 500) });
    log(`FAILED at ${current}: ${error}`);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- DOGE cost per step (L2 + L1 at both oracle sources)
  const live = liveReader(DOGEOS_TESTNET_DEFAULT_RPC_URL);
  const oracleIface = new ethers.Interface(L1_ORACLE_ABI);
  const liveBlock = await live.block("latest");
  const l2Price = await live.gasPrice();
  const forkBlockInfo = await live.block(forkBlock);
  const params = async (read: (data: string) => Promise<string>) =>
    Object.fromEntries(await Promise.all(ORACLE_PARAMS.map(async (p) => [p, BigInt(await read(oracleIface.encodeFunctionData(p, []))).toString()])));
  const readFork = (data: string) => ethers.provider.call({ to: L1_ORACLE, data });
  const readLive = (data: string) => live.call(L1_ORACLE, data, liveBlock!.number);
  const forkParams = await params(readFork);
  const liveParams = await params(readLive);

  const steps: any[] = [];
  for (const t of sent) {
    const raw = await rawEquivalent(t.hash, t.role, l2Price);
    const padded = budget.paddedForL1(raw);
    const data = oracleIface.encodeFunctionData("getL1Fee", [padded]);
    const latest = BigInt(await readLive(data));
    const atFork = BigInt(await readFork(data));
    try {
      steps.push({ ...budget.buildStep({ name: t.name, role: t.role, lane: t.lane, gas: t.gas, rawTxBytes: ethers.dataLength(raw), l1Bytes: ethers.dataLength(padded), l2GasPriceWei: l2Price, l1FeeWei: { latest, forkBlock: atFork } }), kind: t.kind });
    } catch (e) {
      failedSteps.push({ name: t.name, error: (e as Error).message });
    }
  }

  // ---------------------------------------------------------------- budget
  const roles = budget.roleTotals(steps);
  const ours = budget.BUDGET_ROLES as string[];
  const sumRoles = (key: string) => ours.reduce((a, r) => a + BigInt(roles[r][key]), 0n);
  const maxBy = (kind: string, key: string) => steps.filter((x) => x.kind === kind).reduce((a, x) => (BigInt(x[key]) > a ? BigInt(x[key]) : a), 0n);
  const kinds = [...new Set(steps.map((x) => x.kind as string))];
  const costPerKind: Record<string, bigint> = Object.fromEntries(kinds.map((k) => [k, maxBy(k, "totalWei")]));
  const costPerKindAtFork: Record<string, bigint> = Object.fromEntries(kinds.map((k) => [k, maxBy(k, "totalWeiAtForkBlock")]));
  // a run that stopped early has not measured every kind the daily estimate needs: priced 0 here and reported as failed
  for (const k of Object.values(ACTIVITY_PER_DAY).flatMap((x) => Object.keys(x))) {
    if (k in costPerKind) continue;
    costPerKind[k] = 0n;
    costPerKindAtFork[k] = 0n;
    failedSteps.push({ name: `running cost: ${k}`, error: "no measured step of this kind" });
  }
  const daily = budget.dailyRunningCost(costPerKind, ACTIVITY_PER_DAY);
  const dailyAtFork = budget.dailyRunningCost(costPerKindAtFork, ACTIVITY_PER_DAY);
  const oneOff = Object.fromEntries(ours.map((r) => [r, BigInt(roles[r].totalWei)]));
  const oneOffAtFork = Object.fromEntries(ours.map((r) => [r, BigInt(roles[r].totalWeiAtForkBlock)]));
  const withDaily = (d: Record<string, bigint>) => Object.fromEntries(ours.map((r) => [r, d[r] ?? 0n]));
  const recommended = budget.recommendFunding(oneOff, withDaily(daily), { headroom: HEADROOM, days: FUNDING_DAYS });
  const recommendedAtFork = budget.recommendFunding(oneOffAtFork, withDaily(dailyAtFork), { headroom: HEADROOM, days: FUNDING_DAYS });
  const strDaily = (d: Record<string, bigint>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { wei: v.toString(), doge: budget.formatDoge(v) }]));

  // ---------------------------------------------------------------- app gas floors and reserves
  const of = (kind: string) => steps.filter((x) => x.kind === kind);
  const maxGas = (xs: any[]) => xs.reduce((a, x) => (BigInt(x.gas) > a ? BigInt(x.gas) : a), 0n);
  const worst = (xs: any[], key: string) => xs.reduce((a: any, x: any) => (!a || BigInt(x[key]) > BigInt(a[key]) ? x : a), null);
  const trades = [...of("buy"), ...of("sell"), ...of("escrowBuy")];
  const launches = of("launch");
  const verdicts: any = { gasFloors: [], reserves: [] };
  if (launches.length && of("buy").length) {
    verdicts.gasFloors = [
      budget.floorVerdict({ name: "launch (BARK_LAUNCH_GAS_FLOOR 7M)", floor: APP_LAUNCH_GAS_FLOOR, maxGasUsed: maxGas(launches) }),
      budget.floorVerdict({ name: "trade: buy / sell / escrow buy (BARK_TRADE_GAS_FLOOR 1M)", floor: APP_TRADE_GAS_FLOOR, maxGasUsed: maxGas(trades) }),
    ];
    const buysOnly = [...of("buy"), ...of("escrowBuy")];
    for (const [src, key] of [["latest", "l1FeeWei"], ["forkBlock", "l1FeeWeiAtForkBlock"]] as const) {
      const wb = worst(buysOnly, key);
      const wl = worst(launches, key);
      const buyFloor: bigint = budget.DOGE_BUY_RESERVE_FLOOR_WEI;
      const launchFloor: bigint = budget.DOGE_LAUNCH_RESERVE_FLOOR_WEI;
      // What the app keeps back at this oracle: its live estimate on the step's L1 fee (the app prices a payload of the
      // same size), never below the floor.
      const buyLive: bigint = budget.dogeosReserveFromFees({ kind: "buy", l1FeeWei: BigInt(wb[key]), gasLimit: budget.DOGEOS_BUY_GAS_LIMIT, gasPriceWei: l2Price });
      const launchLive: bigint = budget.dogeosReserveFromFees({ kind: "launch", l1FeeWei: BigInt(wl[key]), gasLimit: budget.DOGEOS_LAUNCH_GAS_LIMIT, gasPriceWei: l2Price });
      const buyIn = { gasUsed: maxGas(buysOnly), floor: APP_TRADE_GAS_FLOOR, l2GasPriceWei: l2Price, l1FeeWei: BigInt(wb[key]) };
      const launchIn = { gasUsed: maxGas(launches), floor: APP_LAUNCH_GAS_FLOOR, l2GasPriceWei: l2Price, l1FeeWei: BigInt(wl[key]) };
      verdicts.reserves.push(
        { ...budget.reserveVerdict({ name: `buy reserve floor ${budget.formatDoge(buyFloor)} DOGE vs the dearest buy (${wb.name})`, reserveWei: buyFloor, ...buyIn }), oracle: src },
        { ...budget.reserveVerdict({ name: `launch reserve floor ${budget.formatDoge(launchFloor)} DOGE vs the dearest launch (${wl.name})`, reserveWei: launchFloor, ...launchIn }), oracle: src },
        { ...budget.reserveVerdict({ name: `buy reserve live ${budget.formatDoge(buyLive)} DOGE vs the dearest buy (${wb.name})`, reserveWei: buyLive, ...buyIn }), oracle: src },
        { ...budget.reserveVerdict({ name: `launch reserve live ${budget.formatDoge(launchLive)} DOGE vs the dearest launch (${wl.name})`, reserveWei: launchLive, ...launchIn }), oracle: src },
      );
    }
  }

  const budgetWei = sumRoles("totalWei");
  const budgetWeiAtFork = sumRoles("totalWeiAtForkBlock");
  const usersWei = ["creator", "buyer"].reduce((a, r) => a + BigInt(roles[r]?.totalWei ?? 0), 0n);
  const safe = await live.block("safe").catch(() => null);
  const finalized = await live.block("finalized").catch(() => null);
  const report = {
    kind: "dogeos-bark-fork-rehearsal",
    version: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    chainId,
    forkBlock,
    forkRpc: forkUrl,
    evm:
      "Hardhat in-process fork, hardfork cancun, block gas limit 10M: gas is Hardhat's EVM, not Chikyū's node (reth). " +
      "One real Chikyū receipt is compared with its fork number at t29 (deploy) and t31 (canary).",
    accounts: "hardhat local test accounts (#0 deployer, #1 route authority, #2 operator, #3 keeper, #4 creator, #5-#9 buyers); oracle updater and Barkswap admin impersonated; no key loaded",
    deployInputs: { dogeUsd: "fixed stand-in $0.25 (Binance not called; gas does not depend on it)", ethUsd: "fixed stand-in $3000 (choice-vault caps re-pricing)" },
    oracle: {
      address: L1_ORACLE,
      method: "getL1Fee(bytes) on the step's raw transaction bytes plus the margin (l1Margin)",
      primary: "latest",
      why:
        "latest = the live oracle now (eth_call to the live RPC): what a transaction pays today, the budget basis. forkBlock = the same " +
        "call on the fork (the oracle's state at the fork block). Chikyū's L1 fee follows the L1 base and blob fees, so it moves a lot: " +
        "both are reported and the funding is given for both.",
      sources: {
        latest: { rpc: DOGEOS_TESTNET_DEFAULT_RPC_URL, blockNumber: liveBlock!.number, blockTimestamp: liveBlock!.timestamp, params: liveParams },
        forkBlock: { blockNumber: forkBlock, blockTimestamp: forkBlockInfo?.timestamp ?? null, params: forkParams },
      },
    },
    l2GasPrice: {
      usedWei: l2Price.toString(),
      source: "live eth_gasPrice (the app sends legacy transactions at this price; our keys type 2 at the same base fee + 100 wei tip)",
      liveBaseFeeWei: (liveBlock!.baseFeePerGas ?? 0n).toString(),
      forkBlockBaseFeeWei: (forkBlockInfo?.baseFeePerGas ?? 0n).toString(),
    },
    l1Margin: { ...budget.L1_MARGIN, filler: "deterministic non-zero pseudo-random bytes (the oracle charges size and compressibility)", signature: "maximum-length r/s" },
    steps,
    failedSteps,
    maxStepGas: maxGas(steps).toString(),
    maxLaunchGas: maxGas(launches).toString(),
    roles,
    totals: {
      budgetWei: budgetWei.toString(),
      budgetDoge: budget.formatDoge(budgetWei),
      budgetWeiAtForkBlock: budgetWeiAtFork.toString(),
      budgetDogeAtForkBlock: budget.formatDoge(budgetWeiAtFork),
      scope: `the roles we fund (${ours.join(", ")}) for this whole rehearsal; app users (creator, buyers) pay their own: ${budget.formatDoge(usersWei)} DOGE in this run`,
      deployerDoge: budget.formatDoge(BigInt(roles.deployer.totalWei)),
      deployerDogeAtForkBlock: budget.formatDoge(BigInt(roles.deployer.totalWeiAtForkBlock)),
    },
    recommendedFunding: {
      basis: `${HEADROOM} x (this rehearsal's cost of the role + ${FUNDING_DAYS} days x its running cost per day), rounded up to whole DOGE, at the live oracle`,
      latest: recommended,
      atForkBlockOracle: recommendedAtFork,
    },
    runningCostPerDay: {
      assumptions: ACTIVITY_PER_DAY,
      assumptionNote:
        "testnet activity: 5 active coins (keeper collects each 4x, converts each 2x a day), 2 pulls, 1 reserve release; hourly route runs; 1 buyback coin at its 21,600 s interval; oracle push heartbeat 1,800 s + 24 deviation pushes. Each send is priced at the dearest measured step of its kind.",
      costPerKindWei: Object.fromEntries(Object.entries(costPerKind).map(([k, v]) => [k, (v as bigint).toString()])),
      latest: strDaily(daily),
      atForkBlockOracle: strDaily(dailyAtFork),
    },
    verdicts,
    checks,
    chainFacts: {
      liveLatestBlock: liveBlock!.number,
      safeTag: safe ? { blockNumber: safe.number, lagBlocks: liveBlock!.number - safe.number } : "not supported",
      finalizedTag: finalized ? { blockNumber: finalized.number, lagBlocks: liveBlock!.number - finalized.number } : "not supported",
      liveRpcRetries: liveRetries,
    },
  };
  budget.assertNoSecrets(report);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`report -> ${path.relative(ROOT, REPORT_PATH)}`);
  console.table(steps.map((x) => ({ step: x.name, role: x.role, gas: x.gas, l1Bytes: x.l1Bytes, "L2 DOGE": budget.formatDoge(x.l2FeeWei), "L1 DOGE": budget.formatDoge(x.l1FeeWei), "total DOGE": budget.formatDoge(x.totalWei), "total @fork": budget.formatDoge(x.totalWeiAtForkBlock) })));
  console.table(Object.fromEntries(Object.entries(roles).map(([r, t]: [string, any]) => [r, { txs: t.txs, gas: t.gas, DOGE: budget.formatDoge(t.totalWei), "DOGE @fork": budget.formatDoge(t.totalWeiAtForkBlock), recommended: recommended[r]?.recommendedDoge ?? "-", "recommended @fork": recommendedAtFork[r]?.recommendedDoge ?? "-" }])));
  log(`total DOGE budget (our roles): ${report.totals.budgetDoge} at the live oracle, ${report.totals.budgetDogeAtForkBlock} at the fork block's oracle`);
  for (const v of [...verdicts.gasFloors, ...verdicts.reserves]) log(`verdict: ${v.name}${v.oracle ? ` [${v.oracle}]` : ""}: ${v.suffices ? "suffices" : "DOES NOT suffice"}`);
  budget.validateReport(report); // throws (exit 1) on any failed step
  log("REHEARSAL OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
