/**
 * DogeOS keepers (barkswap plan t20; spec section 4 Keepers, B9). No RPC, no Postgres, no key of ours: every wallet is
 * ethers.Wallet.createRandom(), every chain read is a fake reader, every send goes through a recording exec. Proves:
 *   - every lane is off by default, only its own flag turns it on, and nothing runs off 6281971;
 *   - the keeper key comes only from DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971 and is refused when it is the DogeOS
 *     operator (forbiddenKeeperAddresses) or a deployer; the operator key comes only from EVM_GEN8_OPERATOR_KEY_6281971
 *     and must be DOGEOS_OPERATOR_ADDRESS's key;
 *   - the keeper key never sends a role function: every state-changing function of the t7 ABI export other than the
 *     permissionless keeper steps is refused for it, and the operator key sends only operator-role steps;
 *   - each lane picks the right step with the right key (collect / convert / pull, graduation-fee fallback, reserve
 *     release, admin-change watch + restore: keeper; route worker and choice-vault buyback: operator), dry run by
 *     default;
 *   - the side-pool watch uses the four topic filters proven in BarkAdmin.fork.spec.ts sidePoolsOf (Barkswap factory
 *     Pool / CustomPool with our coin as token0 or token1), skips our own custom pools, adds MuchFi's factory, and
 *     accepts + alerts (no token guard).
 */
import "./gen8/gen8TestEnv.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import type { Gen8BarkChainConfig } from "../evm/evmGen8Config.js";

const {
  BARK_KEEPER_CALLS,
  BARK_LANES,
  BARK_LANE_FLAG,
  BARK_LANE_KEY,
  BARK_OPERATOR_CALLS,
  BARK_FRAGMENTS,
  BARK_PLUGIN_CONFIG,
  assertBarkCallKey,
  barkKeeperWallet,
  barkOperatorWallet,
  barkRouteLane,
  createBarkSender,
  dogeosBarkKeeperConfig,
  runBarkAdminWatchPass,
  runBarkBuybackPass,
  runBarkCollectPass,
  runBarkGradFeePass,
  runBarkReservePass,
  startDogeosBarkKeepers,
} = await import("../evm/dogeosBarkKeepers.js");
const { BARK_SIDE_ALGEBRA_TOPICS, DOGEOS_SIDE_FACTORIES, barkSidePoolCreationFilters, findBarkSidePools, runBarkSidePoolWatcherOnce } = await import("../evm/evmGen8SidePools.js");
const { choiceConfig, enabledChoiceChains } = await import("../evm/evmCreatorChoiceConfig.js");
const { dueMomentKey } = await import("../evm/evmCreatorChoice.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ABI_DIR = path.join(ROOT, "contracts/dogeos/barkswap/abi");
const abiOf = (name: string) => new ethers.Interface(JSON.parse(fs.readFileSync(path.join(ABI_DIR, `${name}.abi.json`), "utf8")));

const DOGE = 6281971;
const lc = (s: string) => s.toLowerCase();
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const BARKSWAP_FACTORY = "0xf3961157f56c983316657f0267b4c04460bee43f";
const MUCHFI_FACTORY = "0x7d175e06570cafa1cfdf060850b84e0ca23eff0b";

const CFG: Gen8BarkChainConfig = {
  chainId: DOGE,
  venue: "barkswap",
  launcher: { address: A(0xc8), startBlock: 100 },
  plugin: { address: A(0xc7), startBlock: 100 },
  splitter: { address: A(0xc4), startBlock: 100 },
  choiceVault: A(0xc5),
  reserveLock: A(0xc6),
  escrow: A(0xc3),
  startBlock: 100,
};
const LENS = A(0xc9);

function keys() {
  const keeper = ethers.Wallet.createRandom();
  const operator = ethers.Wallet.createRandom();
  const env: NodeJS.ProcessEnv = {
    DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971: keeper.privateKey,
    EVM_GEN8_OPERATOR_KEY_6281971: operator.privateKey,
    DOGEOS_OPERATOR_ADDRESS: operator.address,
    EVM_GEN8_LENS_6281971: LENS,
  };
  return { keeper, operator, env };
}

function allOn(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const lane of BARK_LANES) out[BARK_LANE_FLAG[lane]] = "true";
  return out;
}

// ------------------------------------------------------------------------------------------------ recording exec

type Exec = { who: string; signer: string; contract: string; fn: string; args: unknown[]; mode: string };

function recorder(opts: { fail?: (c: { contract: string; fn: string }) => string | null } = {}) {
  const calls: Exec[] = [];
  let n = 0;
  const exec = async (input: { who: "keeper" | "operator"; signer: ethers.Wallet; call: { contract: string; fn: string; args: unknown[] }; mode: "simulate" | "send" }) => {
    calls.push({ who: input.who, signer: input.signer.address, contract: input.call.contract, fn: input.call.fn, args: input.call.args.map(String), mode: input.mode });
    const why = opts.fail?.(input.call) ?? null;
    if (why) return { ok: false as const, error: why };
    return input.mode === "send" ? { ok: true as const, hash: `0x${(++n).toString(16).padStart(64, "0")}` } : { ok: true as const };
  };
  return { calls, exec, sent: () => calls.filter((c) => c.mode === "send") };
}

function sender(input: { keeper?: ethers.Wallet | null; operator?: ethers.Wallet | null; send?: boolean; fail?: (c: { contract: string; fn: string }) => string | null }) {
  const rec = recorder({ fail: input.fail });
  const s = createBarkSender({ keeper: input.keeper ?? null, operator: input.operator ?? null, exec: rec.exec, send: input.send ?? true });
  return { rec, s };
}

// ------------------------------------------------------------------------------------------------ fake reader

const ZERO4 = [0n, 0n, 0n, 0n];
type Owed = { feeCreator: string; creatorOwed: bigint; coinBooks: bigint[]; uncollectedNative: bigint[]; uncollectedCoin: bigint[]; nextConvertAt: number; gradFeeTaken: boolean };
type Settings = { plugin: string; lastFee: number; pluginConfig: number; communityFee: number; tickSpacing: number; unlocked: boolean };

function fakeReader(input: {
  now?: number;
  owed?: Record<string, Partial<Owed>>;
  progress?: Record<string, { graduated: boolean; graduatedAt: number }>;
  reserve?: Record<string, bigint>;
  delay?: number;
  settings?: Record<string, Partial<Settings>>;
  choice?: Record<string, Partial<Record<string, unknown>>>;
}) {
  const reads: string[] = [];
  return {
    reads,
    async blockTime() {
      return input.now ?? 1_800_000_000;
    },
    async owed(coin: string): Promise<Owed> {
      reads.push(`owed:${coin}`);
      return { feeCreator: A(0xee), creatorOwed: 0n, coinBooks: ZERO4, uncollectedNative: ZERO4, uncollectedCoin: ZERO4, nextConvertAt: 0, gradFeeTaken: false, ...(input.owed?.[coin] || {}) };
    },
    async progress(coin: string) {
      reads.push(`progress:${coin}`);
      return input.progress?.[coin] ?? { graduated: false, graduatedAt: 0 };
    },
    async reserveAmount(coin: string) {
      reads.push(`reserve:${coin}`);
      return input.reserve?.[coin] ?? 0n;
    },
    async reserveReleaseDelay() {
      return input.delay ?? 3600;
    },
    async poolSettings(pool: string): Promise<Settings> {
      reads.push(`pool:${pool}`);
      return { plugin: CFG.plugin.address, lastFee: 0, pluginConfig: BARK_PLUGIN_CONFIG, communityFee: 30, tickSpacing: 10, unlocked: true, ...(input.settings?.[pool] || {}) };
    },
    async choiceOf(coin: string) {
      reads.push(`choiceOf:${coin}`);
      return Number(input.choice?.[coin]?.choice ?? 4);
    },
    async choiceState(coin: string) {
      reads.push(`choice:${coin}`);
      return {
        buybackBalance: 0n, spentInWeek: 0n, lastBuybackAt: 0, maxBuyPerTx: 10n ** 21n, maxBuybackPerCoinWeek: 10n ** 22n, minBuyInterval: 3600,
        operator: A(0), operatorPaused: false, ...(input.choice?.[coin] || {}),
      } as any;
    },
  };
}

const COIN1 = A(0x1001);
const POOL1 = A(0x2001);
const COIN2 = A(0x1002);
const POOL2 = A(0x2002);

// ================================================================================================ flags and keys

test("every DogeOS lane is off by default; dry run by default; no key is loaded while every lane is off", () => {
  const { env } = keys();
  const c = dogeosBarkKeeperConfig(CFG, env);
  for (const lane of BARK_LANES) assert.equal(c.lanes[lane], false, lane);
  assert.equal(c.send, false);
  assert.equal(c.keeper, null);
  assert.equal(c.operator, null);
});

test("each lane has its own flag and turns on only itself; the buyback flag is the creator-choice chain list", () => {
  const env = { ...keys().env, EVM_BUYBACK_SEED_SECRET: "s" };
  assert.equal(BARK_LANE_FLAG.buyback, "EVM_CREATOR_CHOICE_ENABLED_6281971");
  assert.equal(new Set(Object.values(BARK_LANE_FLAG)).size, BARK_LANES.length, "one flag per lane");
  for (const lane of BARK_LANES) {
    const c = dogeosBarkKeeperConfig(CFG, { ...env, [BARK_LANE_FLAG[lane]]: "true" });
    for (const other of BARK_LANES) assert.equal(c.lanes[other], other === lane, `${lane} -> ${other}`);
  }
  assert.equal(dogeosBarkKeeperConfig(CFG, { ...env, DOGEOS_BARK_SEND_6281971: "true" }).send, true);
  // the V4 routing switches never turn a DogeOS lane on
  const v4 = dogeosBarkKeeperConfig(CFG, { ...env, EVM_GEN8_FEE_ROUTING_ENABLED: "true", EVM_GEN8_FEE_ROUTING_SEND: "true", EVM_GEN8_SIDE_POOLS: "1" });
  assert.ok(BARK_LANES.every((lane) => !v4.lanes[lane]));
  assert.equal(v4.send, false);
});

test("the keepers act only on 6281971", () => {
  const { env } = keys();
  assert.throws(() => dogeosBarkKeeperConfig({ ...CFG, chainId: 46630 }, allOn(env)), /6281971/);
  const started = startDogeosBarkKeepers({ db: {} as any, cfgs: [{ ...CFG, chainId: 97 }], providerFor: () => ({}) as any, env: allOn(env), schedule: () => undefined });
  assert.deepEqual(started, []);
});

test("lanes and keys follow B9: keeper for permissionless steps, operator for role steps, none for the watch", () => {
  assert.deepEqual(BARK_LANE_KEY, { collect: "keeper", gradFee: "keeper", reserve: "keeper", adminWatch: "keeper", sidePools: null, route: "operator", buyback: "operator" });
});

test("keeper key: only DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971, never the gen-7 keeper or a generic key", () => {
  const k = ethers.Wallet.createRandom();
  assert.equal(barkKeeperWallet({ DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971: k.privateKey })?.address, k.address);
  assert.equal(barkKeeperWallet({ DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971: k.privateKey.slice(2) })?.address, k.address);
  for (const name of ["EVM_GRADUATION_KEEPER_PRIVATE_KEY_6281971", "EVM_GRADUATION_KEEPER_PRIVATE_KEY", "DOGEOS_BARK_KEEPER_PRIVATE_KEY", "PROTOCOL_FORWARDER_KEEPER_PK", "EVM_GEN8_OPERATOR_KEY_6281971"]) {
    assert.equal(barkKeeperWallet({ [name]: k.privateKey }), null, name);
  }
});

test("keeper key: refused when it is the DogeOS operator, a forbidden (deployer) address, or the guard is unreadable", () => {
  const k = ethers.Wallet.createRandom();
  const env = { DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971: k.privateKey };
  assert.throws(() => barkKeeperWallet({ ...env, DOGEOS_OPERATOR_ADDRESS: k.address }), /refuses key/);
  assert.throws(() => barkKeeperWallet({ ...env, EVM_KEEPER_FORBIDDEN_ADDRESSES: k.address }), /refuses key/);
  assert.throws(() => barkKeeperWallet({ ...env, DOGEOS_OPERATOR_ADDRESS: "0x1234" }), /DOGEOS_OPERATOR_ADDRESS/);
  // the config fails closed: a refused keeper key runs no keeper lane, and says why
  const c = dogeosBarkKeeperConfig(CFG, { ...allOn(env), DOGEOS_OPERATOR_ADDRESS: k.address, EVM_GEN8_LENS_6281971: LENS });
  assert.equal(c.keeper, null);
  for (const lane of BARK_LANES) if (BARK_LANE_KEY[lane] === "keeper") assert.equal(c.lanes[lane], false, lane);
  assert.ok(c.errors.some((e: string) => /refuses key/.test(e)));
});

test("operator key: only EVM_GEN8_OPERATOR_KEY_6281971, and only as DOGEOS_OPERATOR_ADDRESS's key", () => {
  const o = ethers.Wallet.createRandom();
  const ok = { EVM_GEN8_OPERATOR_KEY_6281971: o.privateKey, DOGEOS_OPERATOR_ADDRESS: o.address };
  assert.equal(barkOperatorWallet(ok)?.address, o.address);
  assert.equal(barkOperatorWallet({ ...ok, DOGEOS_OPERATOR_ADDRESS: ` ${o.address.toLowerCase()} ` })?.address, o.address);
  // the V4 generic name and the gen-6/7 creator-choice key are never read for DogeOS
  assert.equal(barkOperatorWallet({ EVM_GEN8_OPERATOR_KEY: o.privateKey, DOGEOS_OPERATOR_ADDRESS: o.address }), null);
  assert.equal(barkOperatorWallet({ EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY_6281971: o.privateKey, DOGEOS_OPERATOR_ADDRESS: o.address }), null);
  assert.throws(() => barkOperatorWallet({ EVM_GEN8_OPERATOR_KEY_6281971: o.privateKey }), /DOGEOS_OPERATOR_ADDRESS/);
  assert.throws(() => barkOperatorWallet({ ...ok, DOGEOS_OPERATOR_ADDRESS: ethers.Wallet.createRandom().address }), /not the DogeOS operator/);
  assert.throws(() => barkOperatorWallet({ ...ok, EVM_CREATOR_CHOICE_FORBIDDEN_ADDRESSES: o.address }), /refuses key/);
});

test("keeper and operator can never be the same key", () => {
  const o = ethers.Wallet.createRandom();
  const env = { ...allOn({}), DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971: o.privateKey, EVM_GEN8_OPERATOR_KEY_6281971: o.privateKey, DOGEOS_OPERATOR_ADDRESS: o.address, EVM_GEN8_LENS_6281971: LENS };
  const c = dogeosBarkKeeperConfig(CFG, env);
  assert.equal(c.keeper, null, "the keeper guard refuses the operator's key");
  assert.equal(c.operator?.address, o.address);
});

test("with both keys and every flag on, every lane runs with its own key", () => {
  const { keeper, operator, env } = keys();
  const c = dogeosBarkKeeperConfig(CFG, { ...allOn(env), EVM_BUYBACK_SEED_SECRET: "s" });
  assert.equal(c.keeper?.address, keeper.address);
  assert.equal(c.operator?.address, operator.address);
  for (const lane of BARK_LANES) assert.equal(c.lanes[lane], true, lane);
  assert.deepEqual(c.errors, []);
});

test("lanes that read the lens stay off without EVM_GEN8_LENS_6281971; the buyback lane needs EVM_BUYBACK_SEED_SECRET", () => {
  const { env } = keys();
  const { EVM_GEN8_LENS_6281971: _lens, ...noLens } = env;
  const c = dogeosBarkKeeperConfig(CFG, allOn(noLens));
  assert.equal(c.lanes.collect, false);
  assert.equal(c.lanes.gradFee, false);
  assert.equal(c.lanes.reserve, false);
  assert.equal(c.lanes.adminWatch, true, "the admin watch reads the pools, not the lens");
  assert.equal(c.lanes.buyback, false, "no EVM_BUYBACK_SEED_SECRET");
  assert.ok(c.errors.some((e: string) => /EVM_GEN8_LENS_6281971/.test(e)));
  assert.ok(c.errors.some((e: string) => /EVM_BUYBACK_SEED_SECRET/.test(e)));
});

test("creator-choice config: 6281971 is in the chain list (off unless flagged) and has DOGE defaults", () => {
  assert.deepEqual(enabledChoiceChains({}), []);
  assert.deepEqual(enabledChoiceChains({ EVM_CREATOR_CHOICE_ENABLED_6281971: "true" }), [DOGE]);
  const c = choiceConfig(DOGE, {});
  assert.equal(c.minSpendWei, 10n ** 18n, "1 DOGE");
  assert.equal(c.minPayoutWei, 5n * 10n ** 17n, "0.5 DOGE");
  // the other chains keep their values
  assert.equal(choiceConfig(56, {}).minSpendWei, 3_000_000_000_000_000n);
  assert.equal(choiceConfig(46630, {}).minPayoutWei, 370_000_000_000_000n);
});

test("the gen-6/7 creator-choice worker leaves 6281971 to the DogeOS keepers", () => {
  const src = fs.readFileSync(path.join(HERE, "../evm/evmCreatorChoiceWorker.ts"), "utf8");
  assert.match(src, /gen8Venue\(chainId\) === "barkswap"/);
});

// ================================================================================================ never a role function with the keeper key

const CONTRACT_ABI: Record<string, string> = { launcher: "MwzBarkLauncher", reserveLock: "MwzBarkReserveLock", choiceVault: "MwzBarkCreatorChoiceVault", splitter: "MwzBarkFeeSplitter", plugin: "MwzBarkPlugin" };

function stateChanging(contract: string): string[] {
  const out: string[] = [];
  abiOf(CONTRACT_ABI[contract]).forEachFunction((f) => {
    if (f.stateMutability !== "view" && f.stateMutability !== "pure") out.push(f.name);
  });
  return out;
}

test("the keeper key is refused for every state-changing function of the t7 ABI export except the permissionless steps", () => {
  const permissionless: Record<string, string[]> = { launcher: ["collect", "convert", "restore", "takeGraduationFee"], reserveLock: ["release"], choiceVault: ["pull"] };
  assert.deepEqual(Object.fromEntries(Object.entries(BARK_KEEPER_CALLS).map(([k, v]) => [k, [...(v as readonly string[])].sort()])), Object.fromEntries(Object.entries(permissionless).map(([k, v]) => [k, [...v].sort()])));
  let refused = 0;
  for (const contract of Object.keys(CONTRACT_ABI)) {
    for (const fn of stateChanging(contract)) {
      const call = { contract, fn, args: [], coin: COIN1 };
      if (permissionless[contract]?.includes(fn)) {
        assert.doesNotThrow(() => assertBarkCallKey("keeper", call as any), `${contract}.${fn}`);
      } else {
        assert.throws(() => assertBarkCallKey("keeper", call as any), /keeper key/, `${contract}.${fn}`);
        refused += 1;
      }
    }
  }
  // the operator-role functions (B9) are among the refused ones
  for (const [contract, fn] of [["launcher", "claimRouter"], ["splitter", "route"], ["choiceVault", "buyback"], ["choiceVault", "executeHolderBatch"], ["choiceVault", "proposeHolderBatch"]]) {
    assert.throws(() => assertBarkCallKey("keeper", { contract, fn, args: [], coin: COIN1 } as any), /keeper key/, `${contract}.${fn}`);
  }
  assert.ok(refused > 30);
});

test("the operator key sends only operator-role steps (and the parked-bucket payout the route worker sends)", () => {
  assert.deepEqual(BARK_OPERATOR_CALLS, { launcher: ["claimRouter", "payParkedRouter"], splitter: ["route"], choiceVault: ["buyback", "executeHolderBatch", "proposeHolderBatch"] });
  for (const [contract, fns] of Object.entries(BARK_OPERATOR_CALLS)) {
    for (const fn of fns as readonly string[]) {
      assert.ok(stateChanging(contract).includes(fn), `${contract}.${fn} is in the ABI export`);
      assert.doesNotThrow(() => assertBarkCallKey("operator", { contract, fn, args: [], coin: COIN1 } as any));
    }
  }
  for (const [contract, fns] of Object.entries(BARK_KEEPER_CALLS)) {
    for (const fn of fns as readonly string[]) assert.throws(() => assertBarkCallKey("operator", { contract, fn, args: [], coin: COIN1 } as any), /operator key/, `${contract}.${fn}`);
  }
});

test("the sender signs keeper steps with the keeper wallet and operator steps with the operator wallet; a wrong pairing never reaches exec", async () => {
  const { keeper, operator } = keys();
  const { rec, s } = sender({ keeper, operator });
  await s.call("keeper", { contract: "launcher", fn: "collect", args: [COIN1], coin: COIN1 });
  await s.call("operator", { contract: "choiceVault", fn: "buyback", args: [COIN1, 5n], coin: COIN1 });
  await assert.rejects(s.call("keeper", { contract: "launcher", fn: "claimRouter", args: [], coin: COIN1 }), /keeper key/);
  await assert.rejects(s.call("keeper", { contract: "choiceVault", fn: "buyback", args: [COIN1, 5n], coin: COIN1 }), /keeper key/);
  await assert.rejects(s.call("operator", { contract: "launcher", fn: "collect", args: [COIN1], coin: COIN1 }), /operator key/);
  assert.deepEqual(rec.calls.map((c) => `${c.mode}:${c.contract}.${c.fn}:${c.who}:${c.signer === keeper.address ? "K" : c.signer === operator.address ? "O" : "?"}`), [
    "simulate:launcher.collect:keeper:K",
    "send:launcher.collect:keeper:K",
    "simulate:choiceVault.buyback:operator:O",
    "send:choiceVault.buyback:operator:O",
  ]);
});

test("the sender: dry run simulates only; a failed simulation is a skip; a missing key never calls exec", async () => {
  const { keeper } = keys();
  const dry = sender({ keeper, send: false });
  const r1 = await dry.s.call("keeper", { contract: "launcher", fn: "collect", args: [COIN1], coin: COIN1 });
  assert.equal(r1.decision, "dry-run");
  assert.deepEqual(dry.rec.calls.map((c) => c.mode), ["simulate"]);
  const failing = sender({ keeper, fail: () => "NothingToConvert()" });
  const r2 = await failing.s.call("keeper", { contract: "launcher", fn: "convert", args: [COIN1], coin: COIN1 });
  assert.equal(r2.decision, "skip");
  assert.match(String(r2.reason), /NothingToConvert/);
  assert.equal(failing.rec.sent().length, 0);
  const none = sender({ keeper: null });
  const r3 = await none.s.call("keeper", { contract: "launcher", fn: "collect", args: [COIN1], coin: COIN1 });
  assert.equal(r3.decision, "skip");
  assert.match(String(r3.reason), /no keeper key/);
  assert.equal(none.rec.calls.length, 0);
});

test("the sender sends one transaction per key at a time", async () => {
  const { keeper } = keys();
  let open = 0;
  let maxOpen = 0;
  const exec = async (input: any) => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 5));
    open -= 1;
    return input.mode === "send" ? { ok: true as const, hash: "0x01" } : { ok: true as const };
  };
  const s = createBarkSender({ keeper, operator: null, exec, send: true });
  await Promise.all([COIN1, COIN2, A(0x1003)].map((c) => s.call("keeper", { contract: "launcher", fn: "collect", args: [c], coin: c })));
  assert.equal(maxOpen, 1);
});

// ================================================================================================ fragments pinned to the t7 export

test("every launcher / reserve-lock / choice-vault / lens fragment the keepers use matches the t7 ABI export", () => {
  const pairs: Array<[string, string]> = [["launcher", "MwzBarkLauncher"], ["reserveLock", "MwzBarkReserveLock"], ["choiceVault", "MwzBarkCreatorChoiceVault"], ["lens", "MwzBarkLaunchLens"]];
  for (const [key, abiName] of pairs) {
    const mine = new ethers.Interface((BARK_FRAGMENTS as any)[key]);
    const exported = abiOf(abiName);
    let n = 0;
    mine.forEachFunction((f) => {
      const e = exported.getFunction(f.format("sighash"));
      assert.ok(e, `${abiName}.${f.format("sighash")} is not in the export`);
      assert.equal(f.stateMutability, e!.stateMutability, f.name);
      assert.deepEqual(f.outputs.map((o) => o.format("sighash")), e!.outputs.map((o) => o.format("sighash")), `${f.name} outputs`);
      n += 1;
    });
    mine.forEachError((err) => {
      assert.ok(exported.getError(err.format("sighash")), `${abiName} error ${err.format("sighash")}`);
    });
    assert.ok(n > 0, key);
  }
  for (const fn of Object.values(BARK_KEEPER_CALLS).flat()) {
    assert.ok(Object.values(BARK_FRAGMENTS).flat().some((f: string) => f.startsWith(`function ${fn}(`)), `${fn} has a fragment`);
  }
});

test("the pool fragments are the vendored Algebra Integral 1.2.1 ones", () => {
  const sol = fs.readFileSync(path.join(ROOT, "contracts/dogeos/barkswap/interfaces/core/pool/IAlgebraPoolState.sol"), "utf8").replace(/\s+/g, " ");
  assert.ok(sol.includes("function globalState() external view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked);"));
  assert.ok(sol.includes("function plugin() external view returns (address pluginAddress);"));
  assert.ok(sol.includes("function tickSpacing() external view returns (int24);"));
  const pool = new ethers.Interface(BARK_FRAGMENTS.pool);
  assert.equal(pool.getFunction("globalState")!.outputs.map((o) => o.type).join(","), "uint160,int24,uint16,uint8,uint16,bool");
  assert.equal(pool.getFunction("plugin")!.selector, ethers.id("plugin()").slice(0, 10));
  assert.equal(pool.getFunction("tickSpacing")!.selector, ethers.id("tickSpacing()").slice(0, 10));
});

// ================================================================================================ lanes

test("collect lane (keeper): collect when native fees are due or coins can convert, convert when due, pull for choice coins", async () => {
  const { keeper, operator } = keys();
  const now = 1_800_000_000;
  const reader = fakeReader({
    now,
    owed: {
      [COIN1]: { uncollectedNative: [10n ** 17n, 0n, 0n, 0n], uncollectedCoin: [0n, 5n, 0n, 0n], nextConvertAt: now - 1, feeCreator: CFG.choiceVault!, creatorOwed: 7n },
      [COIN2]: { uncollectedNative: [1n, 0n, 0n, 0n], coinBooks: [0n, 3n, 0n, 0n], nextConvertAt: now + 600 },
    },
  });
  const { rec, s } = sender({ keeper, operator });
  const r = await runBarkCollectPass({ cfg: CFG, coins: [{ coin: COIN1, pool: POOL1, graduated: false }, { coin: COIN2, pool: POOL2, graduated: false }], reader, sender: s, minCollectWei: 10n ** 17n, minPullWei: 1n });
  assert.deepEqual(rec.sent().map((c) => `${c.contract}.${c.fn}(${c.args.join(",")})`), [`launcher.collect(${COIN1})`, `launcher.convert(${COIN1})`, `choiceVault.pull(${COIN1})`]);
  assert.ok(rec.calls.every((c) => c.who === "keeper" && c.signer === keeper.address));
  assert.equal(r.filter((x: any) => x.decision === "sent").length, 3);
});

test("collect lane: nothing due, nothing sent; a keep coin is never pulled", async () => {
  const { keeper } = keys();
  const reader = fakeReader({ owed: { [COIN1]: { uncollectedNative: [5n, 0n, 0n, 0n], creatorOwed: 10n ** 18n } } });
  const { rec, s } = sender({ keeper });
  await runBarkCollectPass({ cfg: CFG, coins: [{ coin: COIN1, pool: POOL1, graduated: false }], reader, sender: s, minCollectWei: 10n ** 17n, minPullWei: 1n });
  assert.equal(rec.calls.length, 0);
});

test("graduation-fee fallback (keeper): only graduated coins whose fee was not taken; the pool is the argument", async () => {
  const { keeper } = keys();
  const reader = fakeReader({ owed: { [COIN1]: { gradFeeTaken: false }, [COIN2]: { gradFeeTaken: true } }, progress: { [COIN1]: { graduated: true, graduatedAt: 1 }, [COIN2]: { graduated: true, graduatedAt: 1 } } });
  const { rec, s } = sender({ keeper });
  await runBarkGradFeePass({ coins: [{ coin: COIN1, pool: POOL1, graduated: true }, { coin: COIN2, pool: POOL2, graduated: true }, { coin: A(0x1003), pool: A(0x2003), graduated: false }], reader, sender: s });
  assert.deepEqual(rec.sent().map((c) => `${c.who}:${c.contract}.${c.fn}(${c.args.join(",")})`), [`keeper:launcher.takeGraduationFee(${POOL1})`]);
  assert.ok(!reader.reads.includes(`owed:${A(0x1003)}`), "a coin the indexer has not seen graduate is not read");
});

test("reserve release (keeper): after the release delay and only with a reserve left", async () => {
  const { keeper } = keys();
  const now = 1_800_000_000;
  const reader = fakeReader({
    now,
    delay: 3600,
    reserve: { [COIN1]: 20n * 10n ** 24n, [COIN2]: 20n * 10n ** 24n },
    progress: { [COIN1]: { graduated: true, graduatedAt: now - 3600 }, [COIN2]: { graduated: true, graduatedAt: now - 3599 } },
  });
  const { rec, s } = sender({ keeper });
  await runBarkReservePass({ coins: [{ coin: COIN1, pool: POOL1, graduated: true }, { coin: COIN2, pool: POOL2, graduated: true }], reader, sender: s });
  assert.deepEqual(rec.sent().map((c) => `${c.who}:${c.contract}.${c.fn}(${c.args.join(",")})`), [`keeper:reserveLock.release(${COIN1})`]);
  const empty = sender({ keeper });
  await runBarkReservePass({ coins: [{ coin: COIN1, pool: POOL1, graduated: true }], reader: fakeReader({ now, reserve: {}, progress: { [COIN1]: { graduated: true, graduatedAt: 1 } } }), sender: empty.s });
  assert.equal(empty.rec.calls.length, 0);
});

test("admin-change watch (keeper): launch values hold -> nothing; plugin / fee / config changed -> alert + restore; community fee or tick spacing -> alert only", async () => {
  const { keeper } = keys();
  const alerts: any[] = [];
  const alert = async (a: any) => alerts.push(a);
  const coins = [{ coin: COIN1, pool: POOL1, graduated: false }, { coin: COIN2, pool: POOL2, graduated: false }, { coin: A(0x1003), pool: A(0x2003), graduated: false }];
  const expected = { communityFee: 30, tickSpacing: 10 };

  const quiet = sender({ keeper });
  await runBarkAdminWatchPass({ cfg: CFG, coins, reader: fakeReader({}), sender: quiet.s, alert, expected });
  assert.equal(quiet.rec.calls.length, 0);
  assert.equal(alerts.length, 0);

  const reader = fakeReader({ settings: { [POOL1]: { plugin: A(0xbad) }, [POOL2]: { communityFee: 1000 }, [A(0x2003)]: { lastFee: 500, pluginConfig: 0, tickSpacing: 60 } } });
  const { rec, s } = sender({ keeper });
  await runBarkAdminWatchPass({ cfg: CFG, coins, reader, sender: s, alert, expected });
  assert.deepEqual(rec.sent().map((c) => `${c.who}:${c.contract}.${c.fn}(${c.args.join(",")})`), [`keeper:launcher.restore(${COIN1})`, `keeper:launcher.restore(${A(0x1003)})`]);
  assert.deepEqual(alerts.map((a) => [a.subject, a.kind, a.chainId]).sort(), [
    [POOL1, "dogeos_bark_admin_change", DOGE],
    [POOL2, "dogeos_bark_admin_change", DOGE],
    [A(0x2003), "dogeos_bark_admin_change", DOGE],
  ].sort());
  const byPool = Object.fromEntries(alerts.map((a) => [a.subject, a]));
  assert.deepEqual(byPool[POOL1].extra.changed, ["plugin"]);
  assert.deepEqual(byPool[POOL2].extra.changed, ["communityFee"]);
  assert.deepEqual(byPool[A(0x2003)].extra.changed, ["lastFee", "pluginConfig", "tickSpacing"]);
  assert.equal(byPool[POOL2].extra.restore, false);
});

test("admin-change watch: a pool whose launch values hold has its open alert resolved, so a later change alerts again", async () => {
  const { keeper } = keys();
  const coins = [{ coin: COIN1, pool: POOL1, graduated: false }, { coin: COIN2, pool: POOL2, graduated: false }];
  const resolved: string[] = [];
  const alerts: any[] = [];
  const { s } = sender({ keeper });
  await runBarkAdminWatchPass({
    cfg: CFG, coins, reader: fakeReader({ settings: { [POOL2]: { plugin: A(0xbad) } } }), sender: s, alert: async (a: any) => alerts.push(a),
    expected: { communityFee: 30, tickSpacing: 10 }, resolve: async (pool: string) => resolved.push(pool),
  });
  assert.deepEqual(resolved, [POOL1], "only the pool whose launch values hold");
  assert.deepEqual(alerts.map((a) => a.subject), [POOL2]);
  // production binds resolve to resolveAlerts with the alert's kind and reward type
  const src = fs.readFileSync(path.join(HERE, "../evm/dogeosBarkKeepers.ts"), "utf8");
  assert.match(src, /resolveAlerts\(opts\.db as any, BARK_ADMIN_ALERT_KIND, cfg\.chainId, pool, BARK_KEEPER_ALERT_TYPE\)/);
  assert.match(src, /kind: BARK_ADMIN_ALERT_KIND,/);
});

test("choice-vault buyback (operator): at a secret moment, within the vault's caps, never below the minimum, buyback coins only", async () => {
  const { keeper, operator } = keys();
  const secret = "test-master-secret";
  const choice = { ...choiceConfig(DOGE, { EVM_BUYBACK_SEED_SECRET: secret }), perDay: 24 };
  // the latest moment of COIN1 that has passed (24 per day: one is always within the last day)
  const now = new Date("2026-10-16T12:00:00Z");
  const due = dueMomentKey({ masterSecret: secret, chainId: DOGE, campaign: COIN1, now, perDay: 24, used: new Set() });
  assert.ok(due);
  const chainNow = Math.floor(now.getTime() / 1000);
  const reader = fakeReader({
    now: chainNow,
    choice: {
      [COIN1]: { buybackBalance: 50n * 10n ** 18n, maxBuyPerTx: 20n * 10n ** 18n, maxBuybackPerCoinWeek: 100n * 10n ** 18n, operator: operator.address },
      [COIN2]: { choice: 2, buybackBalance: 50n * 10n ** 18n, operator: operator.address }, // holders coin
      [A(0x1003)]: { buybackBalance: 10n ** 17n, operator: operator.address }, // below the 1 DOGE minimum
      [A(0x1004)]: { buybackBalance: 50n * 10n ** 18n, lastBuybackAt: chainNow - 60, minBuyInterval: 3600, operator: operator.address }, // vault interval
    },
  });
  const { rec, s } = sender({ keeper, operator });
  const used = new Map<string, Set<string>>();
  const coins = [COIN1, COIN2, A(0x1003), A(0x1004)].map((coin, i) => ({ coin, pool: A(0x2001 + i), graduated: false }));
  const startedAt = new Date(now.getTime() - 2 * 86_400_000);
  await runBarkBuybackPass({ cfg: CFG, coins, reader, sender: s, choice, now, used, startedAt });
  assert.deepEqual(rec.sent().map((c) => `${c.who}:${c.contract}.${c.fn}(${c.args.join(",")})`), [`operator:choiceVault.buyback(${COIN1},${20n * 10n ** 18n})`]);
  assert.ok(rec.calls.every((c) => c.who === "operator" && c.signer === operator.address));
  // the choice is read first: a holders coin costs one read, never the other vault reads
  assert.ok(reader.reads.includes(`choiceOf:${COIN2}`));
  assert.ok(!reader.reads.includes(`choice:${COIN2}`));
  // the same moment is never used twice
  const again = sender({ keeper, operator });
  await runBarkBuybackPass({ cfg: CFG, coins, reader, sender: again.s, choice, now, used, startedAt });
  assert.equal(again.rec.sent().length, 0);
});

test("choice-vault buyback: the week cap left and a vault whose operator is not ours", async () => {
  const { operator } = keys();
  const secret = "s2";
  const choice = { ...choiceConfig(DOGE, { EVM_BUYBACK_SEED_SECRET: secret }), perDay: 24 };
  const now = new Date("2026-10-16T12:00:00Z");
  const chainNow = Math.floor(now.getTime() / 1000);
  const week = Math.floor(chainNow / 604800);
  const reader = fakeReader({
    now: chainNow,
    choice: {
      [COIN1]: { buybackBalance: 50n * 10n ** 18n, maxBuybackPerCoinWeek: 30n * 10n ** 18n, spentInWeek: 25n * 10n ** 18n, lastBuybackAt: week * 604800 + 10, minBuyInterval: 0, operator: operator.address },
      [COIN2]: { buybackBalance: 50n * 10n ** 18n, operator: A(0x99) },
    },
  });
  const { rec, s } = sender({ operator });
  await runBarkBuybackPass({ cfg: CFG, coins: [{ coin: COIN1, pool: POOL1, graduated: false }, { coin: COIN2, pool: POOL2, graduated: false }], reader, sender: s, choice, now, used: new Map(), startedAt: new Date(now.getTime() - 2 * 86_400_000) });
  assert.deepEqual(rec.sent().map((c) => `${c.fn}(${c.args.join(",")})`), [`buyback(${COIN1},${5n * 10n ** 18n})`]);
});

test("choice-vault buyback is restart-safe: a lane started after a moment passed never fires that moment, only later ones", async () => {
  const { operator } = keys();
  const secret = "restart-secret";
  const choice = { ...choiceConfig(DOGE, { EVM_BUYBACK_SEED_SECRET: secret }), perDay: 24 };
  const now = new Date("2026-10-16T12:00:00Z");
  const due = dueMomentKey({ masterSecret: secret, chainId: DOGE, campaign: COIN1, now, perDay: 24, used: new Set() });
  assert.ok(due, "a moment of COIN1 has passed before the restart");
  const st = { buybackBalance: 50n * 10n ** 18n, maxBuyPerTx: 20n * 10n ** 18n, operator: operator.address };
  const coins = [{ coin: COIN1, pool: POOL1, graduated: false }];
  // a fresh lane (empty memory) started now: the moment that passed before the start is missed, not fired
  const used = new Map<string, Set<string>>();
  const fresh = sender({ operator });
  await runBarkBuybackPass({ cfg: CFG, coins, reader: fakeReader({ now: Math.floor(now.getTime() / 1000), choice: { [COIN1]: st } }), sender: fresh.s, choice, now, used, startedAt: now });
  assert.equal(fresh.rec.calls.length, 0);
  assert.ok(used.get(COIN1)!.has(due!), "the missed moment is recorded as used");
  // two days later a new moment has passed: that one fires
  const later = new Date(now.getTime() + 2 * 86_400_000);
  const next = sender({ operator });
  await runBarkBuybackPass({ cfg: CFG, coins, reader: fakeReader({ now: Math.floor(later.getTime() / 1000), choice: { [COIN1]: st } }), sender: next.s, choice, now: later, used, startedAt: now });
  assert.deepEqual(next.rec.sent().map((c) => `${c.fn}(${c.args.join(",")})`), [`buyback(${COIN1},${20n * 10n ** 18n})`]);
});

test("route worker lane (operator): scheduled only by its flag, signed only by the operator key, dry run unless DOGEOS_BARK_SEND_6281971", () => {
  const { keeper, operator, env } = keys();
  const made: Array<{ signer: string | null }> = [];
  const makeChain = (_cfg: any, _provider: any, signer: ethers.Signer | null) => {
    made.push({ signer: signer ? (signer as ethers.Wallet).address : null });
    return {} as any;
  };
  assert.equal(barkRouteLane(CFG, env, {} as any, makeChain), null, "off by default");
  const dry = barkRouteLane(CFG, { ...env, DOGEOS_BARK_ROUTE_ENABLED_6281971: "true" }, {} as any, makeChain)!;
  assert.equal(dry.send, false);
  const live = barkRouteLane(CFG, { ...env, DOGEOS_BARK_ROUTE_ENABLED_6281971: "true", DOGEOS_BARK_SEND_6281971: "true" }, {} as any, makeChain)!;
  assert.equal(live.send, true);
  assert.equal(live.operatorAddress, operator.address);
  assert.deepEqual(made, [{ signer: null }, { signer: operator.address }]);
  assert.ok(made.every((m) => m.signer !== keeper.address));
  // send mode without the operator key: dry run, and never the keeper key instead
  const { EVM_GEN8_OPERATOR_KEY_6281971: _o, ...noOperator } = env;
  const fallback = barkRouteLane(CFG, { ...noOperator, EVM_GEN8_OPERATOR_KEY: operator.privateKey, DOGEOS_BARK_ROUTE_ENABLED_6281971: "true", DOGEOS_BARK_SEND_6281971: "true" }, {} as any, makeChain)!;
  assert.equal(fallback.send, false);
  assert.equal(made[2]!.signer, null);
  // no splitter: nothing to route
  assert.equal(barkRouteLane({ ...CFG, splitter: null }, { ...env, DOGEOS_BARK_ROUTE_ENABLED_6281971: "true" }, {} as any, makeChain), null);
});

test("startDogeosBarkKeepers schedules only the lanes whose flag is on", () => {
  const { env } = keys();
  const scheduled: string[] = [];
  const schedule = (label: string) => {
    scheduled.push(label);
  };
  const provider = {} as any;
  assert.deepEqual(startDogeosBarkKeepers({ db: {} as any, cfgs: [CFG], providerFor: () => provider, env, schedule }), []);
  assert.deepEqual(scheduled, []);
  const lanes = startDogeosBarkKeepers({ db: {} as any, cfgs: [CFG], providerFor: () => provider, env: { ...env, DOGEOS_BARK_SIDE_POOLS_ENABLED_6281971: "true", DOGEOS_BARK_ADMIN_WATCH_ENABLED_6281971: "true" }, schedule });
  assert.deepEqual(lanes.sort(), ["adminWatch", "sidePools"]);
  assert.deepEqual(scheduled.sort(), [`dogeos ${DOGE} adminWatch`, `dogeos ${DOGE} sidePools`]);
});

test("the gen-8 worker starts the DogeOS keepers for Barkswap chains only; the V4 routing worker keeps its V4 chain list", () => {
  const worker = fs.readFileSync(path.join(HERE, "../evm/evmGen8Worker.ts"), "utf8");
  assert.match(worker, /startDogeosBarkKeepers\(\{[^}]*cfgs: barkChains/);
  const routing = fs.readFileSync(path.join(HERE, "../evm/evmGen8FeeRouting.ts"), "utf8");
  assert.match(routing, /const chains = configuredGen8Chains\(env\)\.filter\(\(c\) => c\.splitter\);/);
});

// ================================================================================================ side pools

const FACTORY_IFACE = new ethers.Interface([
  "event Pool(address indexed token0, address indexed token1, address pool)",
  "event CustomPool(address indexed deployer, address indexed token0, address indexed token1, address pool)",
]);
const PANCAKE_V3 = new ethers.Interface(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"]);
const topic = (a: string) => ethers.zeroPadValue(a, 32).toLowerCase();

function logOf(iface: ethers.Interface, address: string, name: string, args: unknown[], blockNumber: number, tx: string) {
  const enc = iface.encodeEventLog(iface.getEvent(name)!, args);
  return { address, topics: enc.topics, data: enc.data, blockNumber, transactionHash: tx };
}

test("the Algebra factory events are the vendored IAlgebraFactory ones", () => {
  const sol = fs.readFileSync(path.join(ROOT, "contracts/dogeos/barkswap/interfaces/core/IAlgebraFactory.sol"), "utf8");
  assert.ok(sol.includes("event Pool(address indexed token0, address indexed token1, address pool);"));
  assert.ok(sol.includes("event CustomPool(address indexed deployer, address indexed token0, address indexed token1, address pool);"));
  assert.equal(BARK_SIDE_ALGEBRA_TOPICS.pool, FACTORY_IFACE.getEvent("Pool")!.topicHash);
  assert.equal(BARK_SIDE_ALGEBRA_TOPICS.customPool, FACTORY_IFACE.getEvent("CustomPool")!.topicHash);
  assert.equal(BARK_SIDE_ALGEBRA_TOPICS.swap, ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)"));
  assert.deepEqual(DOGEOS_SIDE_FACTORIES, { barkswap: BARKSWAP_FACTORY, others: [{ venue: "v3_pancake", address: MUCHFI_FACTORY }] });
});

test("side-pool creation filters are the four proven in BarkAdmin.fork.spec.ts sidePoolsOf, with our coins OR-ed", () => {
  const coins = [COIN1, COIN2];
  const filters = barkSidePoolCreationFilters(BARKSWAP_FACTORY, coins);
  const set = coins.map(topic);
  const P = BARK_SIDE_ALGEBRA_TOPICS.pool;
  const C = BARK_SIDE_ALGEBRA_TOPICS.customPool;
  assert.deepEqual(filters, [
    { address: BARKSWAP_FACTORY, topics: [P, set] },
    { address: BARKSWAP_FACTORY, topics: [P, null, set] },
    { address: BARKSWAP_FACTORY, topics: [C, null, set] },
    { address: BARKSWAP_FACTORY, topics: [C, null, null, set] },
  ]);
  // chunks of 50 coins at most
  const many = Array.from({ length: 120 }, (_, i) => A(0x5000 + i));
  const chunked = barkSidePoolCreationFilters(BARKSWAP_FACTORY, many);
  assert.equal(chunked.length, 12);
  assert.ok(chunked.every((f: any) => (f.topics.find((t: any) => Array.isArray(t)) as string[]).length <= 50));
});

test("findBarkSidePools: Barkswap Pool and foreign CustomPool are side pools (accept + alert); our own CustomPool is not; MuchFi PoolCreated is", () => {
  const launcher = CFG.launcher.address;
  const wdoge = "0xf6bdb158a5ddf77f1b83bc9074f6a472c58d78ae";
  const logs = [
    logOf(FACTORY_IFACE, BARKSWAP_FACTORY, "CustomPool", [launcher, COIN1, wdoge, POOL1], 10, "0x01"), // ours
    logOf(FACTORY_IFACE, BARKSWAP_FACTORY, "Pool", [COIN1, wdoge, A(0x3001)], 11, "0x02"),
    logOf(FACTORY_IFACE, BARKSWAP_FACTORY, "Pool", [COIN2, COIN1, A(0x3002)], 12, "0x03"),
    logOf(FACTORY_IFACE, BARKSWAP_FACTORY, "CustomPool", [A(0x777), COIN1, wdoge, A(0x3003)], 13, "0x04"),
    logOf(FACTORY_IFACE, BARKSWAP_FACTORY, "Pool", [A(0x8888), wdoge, A(0x3004)], 14, "0x05"), // not our coin
    logOf(PANCAKE_V3, MUCHFI_FACTORY, "PoolCreated", [COIN1, wdoge, 10000, 200, A(0x3005)], 15, "0x06"),
  ];
  const found = findBarkSidePools(logs, { tokens: new Set([COIN1, COIN2]), launcher, factory: BARKSWAP_FACTORY, others: DOGEOS_SIDE_FACTORIES.others });
  assert.deepEqual(found.map((p: any) => [p.poolKey, p.venue, p.token, p.other, p.factory, p.hooks]), [
    [A(0x3001), "algebra", COIN1, wdoge, BARKSWAP_FACTORY, null],
    [A(0x3002), "algebra", COIN2, COIN1, BARKSWAP_FACTORY, null],
    [A(0x3003), "algebra", COIN1, wdoge, BARKSWAP_FACTORY, A(0x777)],
    [A(0x3005), "v3_pancake", COIN1, wdoge, MUCHFI_FACTORY, null],
  ]);
});

class SideDb {
  log: Array<{ sql: string; params: unknown[] }> = [];
  cursor: number | null = null;
  tokens: string[];
  side = new Map<string, any>();
  exclusions: string[] = [];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }
  async query(sql: string, params: unknown[] = []) {
    const s = sql.replace(/\s+/g, " ").trim();
    this.log.push({ sql: s, params });
    if (s.startsWith("select last_indexed_block from public.indexer_state")) return { rows: this.cursor === null ? [] : [{ last_indexed_block: this.cursor }] };
    if (s.startsWith("select token_address from public.evm_gen8_pools")) return { rows: this.tokens.map((t) => ({ token_address: t })) };
    if (s.startsWith("insert into public.evm_gen8_side_pools")) {
      const key = String(params[1]);
      if (this.side.has(key)) return { rows: [] };
      this.side.set(key, { pool_key: key, token_address: params[2], venue: params[3], factory_address: params[4], other_token: params[5], hooks: params[7] });
      return { rows: [{ "?column?": 1 }] };
    }
    if (s.startsWith("insert into public.evm_gen8_holder_exclusions")) {
      this.exclusions.push(`${params[1]}:${params[2]}`);
      return { rows: [] };
    }
    if (s.startsWith("select pool_key, token_address, venue, other_token, factory_address from public.evm_gen8_side_pools")) return { rows: [...this.side.values()] };
    if (s.startsWith("insert into public.indexer_state")) {
      this.cursor = Number(params[2]);
      return { rows: [] };
    }
    return { rows: [] };
  }
}

test("runBarkSidePoolWatcherOnce: four filters on the Barkswap factory + MuchFi, rows written, holders excluded, one alert per new pool, cursor moves", async () => {
  const wdoge = "0xf6bdb158a5ddf77f1b83bc9074f6a472c58d78ae";
  const db = new SideDb([COIN1]);
  const creation = [
    logOf(FACTORY_IFACE, BARKSWAP_FACTORY, "CustomPool", [CFG.launcher.address, COIN1, wdoge, POOL1], 150, "0x01"),
    logOf(FACTORY_IFACE, BARKSWAP_FACTORY, "Pool", [COIN1, wdoge, A(0x3001)], 151, "0x02"),
    logOf(PANCAKE_V3, MUCHFI_FACTORY, "PoolCreated", [COIN1, wdoge, 10000, 200, A(0x3005)], 152, "0x03"),
  ];
  const filters: any[] = [];
  const provider = {
    async getBlockNumber() {
      return 1_000;
    },
    async getBlock() {
      return { timestamp: 1_800_000_000, number: 1_000 };
    },
    async getLogs(f: any) {
      filters.push(f);
      const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map(lc);
      const t0s = Array.isArray(f.topics?.[0]) ? f.topics[0] : [f.topics?.[0]];
      return creation.filter((l) => addrs.includes(lc(l.address)) && t0s.includes(l.topics[0]) && f.topics.every((t: any, i: number) => t === null || i === 0 || (Array.isArray(t) ? t.map(lc).includes(lc(l.topics[i] ?? "")) : lc(t) === lc(l.topics[i] ?? ""))));
    },
  };
  const alerts: any[] = [];
  const r = await runBarkSidePoolWatcherOnce({ db, cfg: CFG, provider: provider as any, env: { EVM_GEN8_DISPLAY_HEAD_TAG_6281971: "latest", EVM_GEN8_CONFIRMATIONS: "0" }, alert: async (a: any) => alerts.push(a) });
  assert.equal(r!.created, 2);
  assert.deepEqual([...db.side.keys()].sort(), [A(0x3001), A(0x3005)].sort());
  assert.deepEqual(db.side.get(A(0x3001)).venue, "algebra");
  assert.deepEqual(db.exclusions.sort(), [`${A(0x3001)}:side_pool_algebra`, `${A(0x3005)}:side_pool_v3_pancake`].sort());
  assert.deepEqual(alerts.map((a) => [a.kind, a.subject, a.chainId]).sort(), [["gen8_side_pool_created", A(0x3001), DOGE], ["gen8_side_pool_created", A(0x3005), DOGE]].sort());
  // the creation queries: the four Barkswap filters and one MuchFi PoolCreated query
  const creationFilters = filters.filter((f) => f.topics && (f.topics[0] === BARK_SIDE_ALGEBRA_TOPICS.pool || f.topics[0] === BARK_SIDE_ALGEBRA_TOPICS.customPool || (Array.isArray(f.topics[0]) && !f.topics[0].includes(BARK_SIDE_ALGEBRA_TOPICS.swap))));
  assert.equal(creationFilters.length, 5);
  assert.ok(filters.every((f) => f.toBlock - f.fromBlock < 10_000), "the DogeOS getLogs window");
  assert.equal(db.cursor, r!.to + 1);
  // the cursor is keyed by the plugin
  assert.ok(db.log.some((q) => q.sql.startsWith("insert into public.indexer_state") && q.params[1] === `gen8-side:${CFG.plugin.address}`));
});

test("the V4 side-pool watcher is unchanged: no DogeOS default factory list, no Algebra topic in its queries", () => {
  const src = fs.readFileSync(path.join(HERE, "../evm/evmGen8SidePools.ts"), "utf8");
  const v4 = src.slice(src.indexOf("export async function runGen8SidePoolWatcherOnce"), src.indexOf("export async function checkSideVolumeAlerts"));
  assert.ok(!/BARK_SIDE_ALGEBRA_TOPICS|algebra/i.test(v4));
});
