// Barkswap (Algebra Integral 1.2.1) on DogeOS Chikyu 6281971: addresses and fork helpers for the Bark fork tests.
// Addresses: docs/dogeos/barkswap-facts.md §1 (bytecode-matched against upstream v1.2.1-integral). Every helper
// acts on the in-process hardhat fork only (hardhat.dogeos-bark-fork.config.ts); nothing reaches Chikyu.
//
// Part 2 (t8, below the t2 helpers): the full Bark stack (deployBarkStack / barkStackFixture), signed create and the
// coin's CREATE2 salt, launches, router / quoter helpers, event parsing, TickMath and the recorded event fixture.
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import hre, { ethers, network } from "hardhat";
import {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} from "hardhat/builtin-tasks/task-names";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { Contract, ContractRunner, ContractTransactionReceipt, ContractTransactionResponse, LogDescription, Signer } from "ethers";

export const DOGEOS_CHIKYU_CHAIN_ID = 6281971n;
export const DOGEOS_CHIKYU_BLOCK_GAS_LIMIT = 10_000_000n;

/** The deployed Barkswap contracts (all created by `admin`, blocks 5,032,996 - 5,033,042), EIP-55 checksummed
 *  (the facts doc spells the router and QuoterV2 with a wrong checksum case). */
export const BARKSWAP = {
  factory: "0xF3961157f56C983316657f0267B4C04460beE43f",
  poolDeployer: "0x4151224471B0EeA41eE4295c632cc61779d339C2",
  customPoolEntryPoint: "0x19B1A502Ea56843343E60e44a4a95B3cf4C914f5",
  defaultPluginFactory: "0xa3411873111B2A6d2C107Ba146764C6E636d4b29",
  vaultFactory: "0x1dB26728A2f5E56A3652aE766301dBa038346b56",
  communityVault: "0xA305F8BDf7EaA3233b3918A39d1e0867c6116c83",
  swapRouter: "0x911E5A1630fD1768E5A1710DAAFaBb865cB79531",
  quoterV2: "0x187b41968063Cb8A04A5f4d2113844EF2Ba21493",
  nonfungiblePositionManager: "0xf596329a6c7E03F0708199cB5435f86783DB4302",
  wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
  /** factory owner and sole DEFAULT_ADMIN (an EOA) */
  admin: "0xFB1525e16FDA109a5180a3Ec23A7146b870E045b",
} as const;

export const CUSTOM_POOL_DEPLOYER_ROLE = ethers.id("CUSTOM_POOL_DEPLOYER");
export const POOLS_ADMINISTRATOR_ROLE = ethers.id("POOLS_ADMINISTRATOR");

/** Hardhat refuses calls at the forked block itself ("No known hardfork for historical block"), so every fork
 *  test first mines one local block on top of it (the research proof's workaround). Also asserts the chain. */
export async function readyFork(): Promise<{ forkBlock: number; block: number }> {
  const forking = (network.config as { forking?: { blockNumber?: number } }).forking;
  if (!forking?.blockNumber) throw new Error("not a forked network: run with --config hardhat.dogeos-bark-fork.config.ts");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== DOGEOS_CHIKYU_CHAIN_ID) throw new Error(`expected chain ${DOGEOS_CHIKYU_CHAIN_ID}, got ${chainId}`);
  let block = await ethers.provider.getBlockNumber();
  if (block <= forking.blockNumber) {
    await network.provider.send("evm_mine", []);
    block = await ethers.provider.getBlockNumber();
  }
  return { forkBlock: forking.blockNumber, block };
}

/** Typed handles on the deployed Barkswap contracts (interfaces from contracts/dogeos/barkswap/interfaces). */
export async function barkswapContracts() {
  return {
    factory: await ethers.getContractAt("IAlgebraFactory", BARKSWAP.factory),
    customPoolEntryPoint: await ethers.getContractAt("IAlgebraCustomPoolEntryPoint", BARKSWAP.customPoolEntryPoint),
    swapRouter: await ethers.getContractAt("ISwapRouter", BARKSWAP.swapRouter),
    swapRouterState: await ethers.getContractAt("IPeripheryImmutableState", BARKSWAP.swapRouter),
    swapRouterMulticall: await ethers.getContractAt("IMulticall", BARKSWAP.swapRouter),
    swapRouterPayments: await ethers.getContractAt("IPeripheryPayments", BARKSWAP.swapRouter),
    quoterV2: await ethers.getContractAt("IQuoterV2", BARKSWAP.quoterV2),
    nonfungiblePositionManager: await ethers.getContractAt("INonfungiblePositionManager", BARKSWAP.nonfungiblePositionManager),
    wdoge: await ethers.getContractAt("IWNativeToken", BARKSWAP.wdoge),
    wdogeMetadata: await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata", BARKSWAP.wdoge),
  };
}

/** The pool at `address` through the 1.2.1 IAlgebraPool interface. */
export async function algebraPool(address: string) {
  return ethers.getContractAt("IAlgebraPool", address);
}

/** The factory's AccessControlEnumerable surface (not part of IAlgebraFactory). */
export function factoryAccessControl() {
  return new ethers.Contract(
    BARKSWAP.factory,
    [
      "function hasRole(bytes32 role, address account) view returns (bool)",
      "function getRoleMemberCount(bytes32 role) view returns (uint256)",
      "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
    ],
    ethers.provider,
  );
}

/** Sets the fork balance of `address` to exactly `wei` native DOGE. */
export async function setNativeBalance(address: string, wei: bigint): Promise<void> {
  await network.provider.send("hardhat_setBalance", [address, ethers.toBeHex(wei)]);
}

/** Impersonates `address` on the fork (gas money included) and returns its signer. Undo with stopImpersonating. */
export async function impersonate(address: string, gasMoney: bigint = ethers.parseEther("10")): Promise<Signer> {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  if ((await ethers.provider.getBalance(address)) < gasMoney) await setNativeBalance(address, gasMoney);
  return ethers.getSigner(address);
}

export async function stopImpersonating(address: string): Promise<void> {
  await network.provider.send("hardhat_stopImpersonatingAccount", [address]);
}

/** Wraps `wei` of `signer`'s native DOGE into WDOGE (WDOGE.deposit on the fork). */
export async function fundWdoge(signer: Signer, wei: bigint): Promise<void> {
  const wdoge = await ethers.getContractAt("IWNativeToken", BARKSWAP.wdoge, signer);
  await (await wdoge.deposit({ value: wei })).wait();
}

// =====================================================================================================================
// Part 2 (t8): the full Bark stack on the fork, imported by t8, t9, t10. It deploys and drives the audited contracts in
// contracts/dogeos/barkswap (Gate 0 PASS) against Barkswap's real pools; it edits no contract. Accounts are hardhat's
// local test accounts (well-known keys, fork only).
// =====================================================================================================================

/** Loose contract handle: the Bark tests call methods by ABI name (no typechain for the Bark build); `connect` keeps it. */
export type C = { connect(runner: ContractRunner | null): C } & Contract & Record<string, any>;

export const WAD = 10n ** 18n;
export const Q96 = 1n << 96n;
export const SUPPLY = 1_000_000_000n * WAD;
export const COINS_A = 850_000_000n * WAD;
export const COINS_B = 130_000_000n * WAD;
export const CREATOR_RESERVE = 20_000_000n * WAD;
export const FIRST_BUY_MAX = 700_000_000n * WAD;
/** The testnet graduation target (spec B2): $150 market cap. */
export const TEST_TARGET_USD = 150n * WAD;
export const DEAD = "0x000000000000000000000000000000000000dEaD";
/** gen-8 authorization type (MwzBarkLauncher.CREATE_AUTH_TYPE). */
export const CREATE_AUTH_TYPE = ethers.id("MWZ_GEN8_CREATE_AUTH");
/** DogeOS deploy inputs (t32 review, spec §2 F6): band $0.01-$10 (USD per DOGE, 18 decimals), oracle age 3600 s. */
export const DOGEOS_MIN_NATIVE_USD = 10n ** 16n;
export const DOGEOS_MAX_NATIVE_USD = 10n * WAD;
export const DOGEOS_MAX_PRICE_AGE = 3600n;
/** The foundation feed's answer has 8 decimals: $0.10 per DOGE. */
export const DEFAULT_DOGE_USD_ANSWER = 10_000_000n;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const ABI_DIR = path.join(REPO_ROOT, "contracts", "dogeos", "barkswap", "abi");
export const EVENT_FIXTURE_PATH = path.join(REPO_ROOT, "test", "fixtures", "dogeos", "barkSwapEvent.json");

/** An ABI exported by t7 (contracts/dogeos/barkswap/abi/<name>.abi.json), the files t15, t18, t21 and t22 consume. */
export function exportedAbi(name: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(ABI_DIR, `${name}.abi.json`), "utf8"));
}

// ------------------------------------------------------------------------------------------------- gas table

const GAS_ROWS: Array<{ label: string; gas: bigint }> = [];

/** Records one measured transaction for the gas table printed after each spec. */
export function recordGas(label: string, gas: bigint): void {
  GAS_ROWS.push({ label, gas });
}

export function gasRows(): ReadonlyArray<{ label: string; gas: bigint }> {
  return GAS_ROWS;
}

/** Prints and clears the recorded gas rows. */
export function printGasTable(title: string): void {
  if (GAS_ROWS.length === 0) return;
  const lines = GAS_ROWS.map(
    (r) => `    ${r.gas.toLocaleString("en-US").padStart(11)}  ${((Number(r.gas) / 1e7) * 100).toFixed(1).padStart(5)}% of 10M  ${r.label}`,
  );
  console.log(`\n    Gas (${title}; Chikyu fork, block gas limit 10,000,000)\n${lines.join("\n")}\n`);
  GAS_ROWS.length = 0;
}

// ------------------------------------------------------------------------------------------------- TickMath (V3 port)

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const MAX_UINT256 = (1n << 256n) - 1n;
const TICK_CONSTANTS: Array<[number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** Exact BigInt port of Uniswap V3 TickMath.getSqrtRatioAtTick (v4-core getSqrtPriceAtTick computes the same). */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, c] of TICK_CONSTANTS) if ((absTick & bit) !== 0) ratio = (ratio * c) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Token0 (coin) amount of `liq` between two sqrt prices (Algebra TokenDeltaMath.getToken0Delta). */
export function amount0Delta(sA: bigint, sB: bigint, liq: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sA < sB ? [sA, sB] : [sB, sA];
  const num = (hi - lo) * (liq << 96n);
  return roundUp ? ceilDiv(ceilDiv(num, hi), lo) : num / hi / lo;
}

/** Token1 (WDOGE) amount of `liq` between two sqrt prices (Algebra TokenDeltaMath.getToken1Delta). */
export function amount1Delta(sA: bigint, sB: bigint, liq: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sA < sB ? [sA, sB] : [sB, sA];
  return roundUp ? ceilDiv((hi - lo) * liq, Q96) : ((hi - lo) * liq) / Q96;
}

// ------------------------------------------------------------------------------------------------- fee math (gen-8)

/** gen-8 MwzFeeMath.rate for a non-launcher swap: post 100; bonding 9000 bps at openAt, linear to 200 at openAt + 60. */
export function expectedRateBps(openAt: bigint, ts: bigint, post = false): bigint {
  if (post) return 100n;
  const end = openAt + 60n;
  if (ts >= end) return 200n;
  let left = end - ts;
  if (left > 60n) left = 60n;
  return 200n + ((9000n - 200n) * left) / 60n;
}

/** MwzBarkPlugin.algebraFee: Algebra fee units (1e6) for a gen-7 rate: r on a sell, r/(1+r) on a buy, floored. */
export function algebraFeeUnits(rateBps: number, buy: boolean): number {
  const units = BigInt(rateBps) * 100n;
  return Number(buy ? (units * 1_000_000n) / (1_000_000n + units) : units);
}

// ------------------------------------------------------------------------------------------------- foundation oracle

let ORACLE_ARTIFACT: { abi: any[]; bytecode: string } | undefined;

/** The foundation's DOGE/USD testnet feed (contracts/dogeos/testnet/DogeosTestnetDogeUsdOracle.sol), compiled from
 *  source with the root build's settings (solc 0.8.24, viaIR, runs 1, bytecodeHash none), i.e. the bytecode the DogeOS
 *  deploy uses. It sits outside the Bark build roots, so it is compiled here instead of read from artifacts-bark. */
export async function foundationDogeUsdOracleArtifact(): Promise<{ abi: any[]; bytecode: string }> {
  if (ORACLE_ARTIFACT) return ORACLE_ARTIFACT;
  const source = "contracts/dogeos/testnet/DogeosTestnetDogeUsdOracle.sol";
  const solcVersion = "0.8.24";
  const input = {
    language: "Solidity",
    sources: { [source]: { content: fs.readFileSync(path.join(REPO_ROOT, source), "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      metadata: { bytecodeHash: "none" },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const build = await hre.run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion });
  const output = build.isSolcJs
    ? await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, { input, solcJsPath: build.compilerPath })
    : await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, { input, solcPath: build.compilerPath, solcVersion });
  const errors = (output.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length > 0) throw new Error(`DogeosTestnetDogeUsdOracle: ${errors.map((e: any) => e.formattedMessage).join("\n")}`);
  const out = output.contracts[source].DogeosTestnetDogeUsdOracle;
  ORACLE_ARTIFACT = { abi: out.abi, bytecode: `0x${out.evm.bytecode.object}` };
  return ORACLE_ARTIFACT;
}

// ------------------------------------------------------------------------------------------------- stack deployment

export interface BarkSigners {
  /** DogeOS deployer key: owner / admin of every contract (spec B9). */
  deployer: HardhatEthersSigner;
  /** DogeOS route-authority key: the create signer (D3). */
  createSigner: HardhatEthersSigner;
  creator: HardhatEthersSigner;
  trader: HardhatEthersSigner;
  trader2: HardhatEthersSigner;
  outsider: HardhatEthersSigner;
  /** DogeOS operator key (splitter, router-claim and choice-vault operator). */
  operator: HardhatEthersSigner;
  oracleUpdater: HardhatEthersSigner;
  /** DogeOS keeper key: permissionless steps only. */
  keeper: HardhatEthersSigner;
  spare: HardhatEthersSigner;
}

export interface BarkVaults {
  weeklyLeagueVault: string;
  monthlyLeagueTreasury: string;
  recruiterRewardsVault: string;
  communityRewardsVault: string;
  protocolRevenueVault: string;
}

export interface DeployBarkStackOptions {
  /** feed answer, 8 decimals (default $0.10) */
  dogeUsdAnswer?: bigint;
  /** GraduationOracle.maxPriceAge (default 3600) */
  maxPriceAge?: bigint;
  minNativeUsd?: bigint;
  maxNativeUsd?: bigint;
  maxOracleAge?: bigint;
  holderBatchDelay?: bigint;
  /** the splitter's destinations; default fixed placeholder addresses (t10 passes real vaults) */
  vaults?: Partial<BarkVaults>;
  /** open launches after deployment (owner setCreatePaused(false)); default true */
  unpause?: boolean;
}

export interface BarkStack {
  signers: BarkSigners;
  feed: C;
  graduationOracle: C;
  launchLib: C;
  feeBooks: C;
  plugin: C;
  launcher: C;
  reserveLock: C;
  choiceVault: C;
  escrow: C;
  splitter: C;
  lens: C;
  barkswap: Awaited<ReturnType<typeof barkswapContracts>>;
  vaults: BarkVaults;
  deployGas: Record<string, bigint>;
  /** the seven per-chain Bark contracts by name */
  contracts(): Record<string, C>;
}

const placeholder = (label: string) => ethers.getAddress(ethers.dataSlice(ethers.id(`mwz.dogeos.bark.test.${label}`), 12));

/** Deploys the Bark stack in the order the launcher's constructor requires (t15 does the same on Chikyu): the
 *  foundation oracle (feed + GraduationOracle 3600 s), the two linked libraries, then reserve lock, choice vault,
 *  escrow, plugin and splitter against the launcher's predicted address, the launcher (its constructor checks the
 *  wiring), the lens, and finally opens launches. */
export async function deployBarkStack(opts: DeployBarkStackOptions = {}): Promise<BarkStack> {
  await readyFork();
  const [deployer, createSigner, creator, trader, trader2, outsider, operator, oracleUpdater, keeper, spare] = await ethers.getSigners();
  const signers: BarkSigners = { deployer, createSigner, creator, trader, trader2, outsider, operator, oracleUpdater, keeper, spare };
  const deployGas: Record<string, bigint> = {};
  const deploy = async (label: string, factory: any, args: unknown[]): Promise<C> => {
    const c = await factory.connect(deployer).deploy(...args);
    const rc = await c.deploymentTransaction()!.wait();
    deployGas[label] = rc!.gasUsed;
    return c as C;
  };

  const oracleArt = await foundationDogeUsdOracleArtifact();
  const feed = await deploy("DogeosTestnetDogeUsdOracle", new ethers.ContractFactory(oracleArt.abi, oracleArt.bytecode), [
    oracleUpdater.address,
    opts.dogeUsdAnswer ?? DEFAULT_DOGE_USD_ANSWER,
    false,
  ]);
  const graduationOracle = await deploy("GraduationOracle", await ethers.getContractFactory("contracts/GraduationOracle.sol:GraduationOracle"), [
    await feed.getAddress(),
    opts.maxPriceAge ?? DOGEOS_MAX_PRICE_AGE,
  ]);
  // A library's ABI types contract parameters by name (planLaunch(IMwzBarkOracle, ...)), which ethers cannot parse;
  // those entries are dropped from the handle (the launcher's `plan` view calls it), the bytecode is the artifact's.
  const libArt = await hre.artifacts.readArtifact("MwzBarkLaunchLib");
  const isAbiType = (t: string): boolean => /^(address|bool|string|bytes\d*|u?int\d*|tuple)(\[\d*\])*$/.test(t);
  const libAbi = libArt.abi.filter((f: any) => (f.inputs ?? []).every((i: any) => isAbiType(i.type)));
  const launchLib = await deploy("MwzBarkLaunchLib", new ethers.ContractFactory(libAbi, libArt.bytecode), []);
  const feeBooks = await deploy("MwzBarkFeeBooks", await ethers.getContractFactory("MwzBarkFeeBooks"), []);

  const nonce = await deployer.getNonce();
  const launcherAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 5 });
  const vaults: BarkVaults = {
    weeklyLeagueVault: opts.vaults?.weeklyLeagueVault ?? placeholder("weeklyLeagueVault"),
    monthlyLeagueTreasury: opts.vaults?.monthlyLeagueTreasury ?? placeholder("monthlyLeagueTreasury"),
    recruiterRewardsVault: opts.vaults?.recruiterRewardsVault ?? placeholder("recruiterRewardsVault"),
    communityRewardsVault: opts.vaults?.communityRewardsVault ?? placeholder("communityRewardsVault"),
    protocolRevenueVault: opts.vaults?.protocolRevenueVault ?? placeholder("protocolRevenueVault"),
  };
  const reserveLock = await deploy("MwzBarkReserveLock", await ethers.getContractFactory("MwzBarkReserveLock"), [launcherAddr]);
  const choiceVault = await deploy("MwzBarkCreatorChoiceVault", await ethers.getContractFactory("MwzBarkCreatorChoiceVault"), [
    deployer.address,
    launcherAddr,
    opts.holderBatchDelay ?? 24n * 3600n,
  ]);
  const escrow = await deploy("MwzBarkCreatorEscrow", await ethers.getContractFactory("MwzBarkCreatorEscrow"), [launcherAddr]);
  const plugin = await deploy("MwzBarkPlugin", await ethers.getContractFactory("MwzBarkPlugin"), [
    launcherAddr,
    BARKSWAP.wdoge,
    await escrow.getAddress(),
    await choiceVault.getAddress(),
  ]);
  const splitter = await deploy("MwzBarkFeeSplitter", await ethers.getContractFactory("MwzBarkFeeSplitter"), [
    launcherAddr,
    deployer.address,
    vaults.weeklyLeagueVault,
    vaults.monthlyLeagueTreasury,
    vaults.recruiterRewardsVault,
    vaults.communityRewardsVault,
    vaults.protocolRevenueVault,
    operator.address,
  ]);
  const launcherFactory = await ethers.getContractFactory("MwzBarkLauncher", {
    libraries: { MwzBarkLaunchLib: await launchLib.getAddress(), MwzBarkFeeBooks: await feeBooks.getAddress() },
  });
  const launcher = await deploy("MwzBarkLauncher", launcherFactory, [
    BARKSWAP.customPoolEntryPoint,
    BARKSWAP.wdoge,
    await plugin.getAddress(),
    await graduationOracle.getAddress(),
    await reserveLock.getAddress(),
    await choiceVault.getAddress(),
    deployer.address,
    createSigner.address,
    await splitter.getAddress(),
    opts.minNativeUsd ?? DOGEOS_MIN_NATIVE_USD,
    opts.maxNativeUsd ?? DOGEOS_MAX_NATIVE_USD,
    opts.maxOracleAge ?? DOGEOS_MAX_PRICE_AGE,
  ]);
  if ((await launcher.getAddress()) !== launcherAddr) throw new Error("launcher address prediction failed");
  const lens = await deploy("MwzBarkLaunchLens", await ethers.getContractFactory("MwzBarkLaunchLens"), [launcherAddr]);
  if (opts.unpause ?? true) await (await launcher.connect(deployer).setCreatePaused(false)).wait();

  return {
    signers,
    feed,
    graduationOracle,
    launchLib,
    feeBooks,
    plugin,
    launcher,
    reserveLock,
    choiceVault,
    escrow,
    splitter,
    lens,
    barkswap: await barkswapContracts(),
    vaults,
    deployGas,
    contracts: () => ({
      MwzBarkLauncher: launcher,
      MwzBarkPlugin: plugin,
      MwzBarkFeeSplitter: splitter,
      MwzBarkCreatorChoiceVault: choiceVault,
      MwzBarkCreatorEscrow: escrow,
      MwzBarkReserveLock: reserveLock,
      MwzBarkLaunchLens: lens,
    }),
  };
}

/** loadFixture entry point: the default stack, deployed once per spec file and snapshotted. */
export async function barkStackFixture(): Promise<BarkStack> {
  return deployBarkStack();
}

/** Publishes a DOGE/USD answer (8 decimals) from the oracle-updater key; returns the round's updatedAt. */
export async function setDogeUsd(s: BarkStack, answer: bigint): Promise<bigint> {
  const rc = await (await s.feed.connect(s.signers.oracleUpdater).updateAnswer(answer)).wait();
  return BigInt((await ethers.provider.getBlock(rc!.blockNumber))!.timestamp);
}

export async function latestTimestamp(): Promise<bigint> {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

/** Moves fork time so the next block is mined at `ts` (and mines it). */
export async function mineAt(ts: bigint): Promise<void> {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
  await network.provider.send("evm_mine", []);
}

// ------------------------------------------------------------------------------------------------- signed create (D3)

export interface LaunchRequest {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  metadataHash: string;
  targetUsd: bigint;
  feeChoice: number;
  feeCreatorPct: number;
  firstBuyValue: bigint;
  minFirstBuyOut: bigint;
  salt: bigint;
  openAt: bigint;
}

export interface CreateAuthorization {
  deadline: bigint;
  signature: string;
}

export function launchRequest(over: Partial<LaunchRequest> = {}): LaunchRequest {
  const name = over.name ?? "Bark Test Coin";
  return {
    name,
    symbol: "BARK",
    logoURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    xAccount: "",
    website: "",
    extraLink: "",
    metadataHash: ethers.id(`metadata:${name}`),
    targetUsd: TEST_TARGET_USD,
    feeChoice: 1,
    feeCreatorPct: 0,
    firstBuyValue: 0n,
    minFirstBuyOut: 0n,
    salt: 0n,
    openAt: 0n,
    ...over,
  };
}

/** MwzBarkLauncher.hashRequest, off chain (the API computes the same). */
export function hashLaunchRequest(req: LaunchRequest): string {
  const h = (v: string) => ethers.keccak256(ethers.toUtf8Bytes(v));
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint8", "uint8", "uint256", "uint256", "uint256", "uint64"],
      [
        h(req.name),
        h(req.symbol),
        h(req.logoURI),
        h(req.xAccount),
        h(req.website),
        h(req.extraLink),
        req.metadataHash,
        req.targetUsd,
        req.feeChoice,
        req.feeCreatorPct,
        req.firstBuyValue,
        req.minFirstBuyOut,
        req.salt,
        req.openAt,
      ],
    ),
  );
}

/** The hash the create signer personal_signs: keccak256(abi.encode(CREATE_AUTH_TYPE, chainId, launcher, creator,
 *  hashRequest(req), deadline)); MwzBarkLauncher.authorizationDigest is its EIP-191 hash. */
export function createAuthInnerHash(chainId: bigint, launcher: string, creator: string, requestHash: string, deadline: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "address", "bytes32", "uint64"],
      [CREATE_AUTH_TYPE, chainId, launcher, creator, requestHash, deadline],
    ),
  );
}

export interface SignedCreate extends CreateAuthorization {
  requestHash: string;
  innerHash: string;
  /** the EIP-191 digest the launcher recovers the signer from (authorizationDigest) */
  digest: string;
  signer: string;
}

/** Signs `req` for `creator` the way the API's create signer does (personal_sign of the inner hash). */
export async function signCreate(
  s: BarkStack,
  creator: string,
  req: LaunchRequest,
  deadline: bigint,
  signer: HardhatEthersSigner = s.signers.createSigner,
): Promise<SignedCreate> {
  const requestHash = hashLaunchRequest(req);
  const innerHash = createAuthInnerHash(DOGEOS_CHIKYU_CHAIN_ID, await s.launcher.getAddress(), creator, requestHash, deadline);
  const signature = await signer.signMessage(ethers.getBytes(innerHash));
  return { deadline, signature, requestHash, innerHash, digest: ethers.hashMessage(ethers.getBytes(innerHash)), signer: signer.address };
}

let TOKEN_CREATION_CODE: string | undefined;

/** MwzV4Token's creation code, as MwzBarkLaunchLib.deployCoin embeds it (same Bark build). */
export async function tokenCreationCode(): Promise<string> {
  TOKEN_CREATION_CODE ??= (await hre.artifacts.readArtifact("contracts/gen8/MwzV4Token.sol:MwzV4Token")).bytecode;
  return TOKEN_CREATION_CODE;
}

/** The coin address `launch` deploys (audit, launcher open question 2): CREATE2 from the launcher, salt
 *  keccak256(abi.encode(creator, salt)), init code MwzV4Token(name, symbol, 1e27, launcher). */
export function predictCoin(creationCode: string, launcher: string, creator: string, salt: bigint, name: string, symbol: string) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const initCode = ethers.concat([creationCode, coder.encode(["string", "string", "uint256", "address"], [name, symbol, SUPPLY, launcher])]);
  const saltHash = ethers.keccak256(coder.encode(["address", "uint256"], [creator, salt]));
  const initCodeHash = ethers.keccak256(initCode);
  return { coin: ethers.getCreate2Address(launcher, saltHash, initCodeHash), saltHash, initCodeHash };
}

let SALT_CURSOR = 1n;

/** Mines a salt as the API does (t21): the first salt from a cursor whose coin sorts below WDOGE (token0) and has no
 *  code. `aboveWNative` finds one that sorts above instead (the negative case). */
export async function mineCoinSalt(
  s: BarkStack,
  creator: string,
  name: string,
  symbol: string,
  opts: { aboveWNative?: boolean; start?: bigint } = {},
): Promise<{ salt: bigint; coin: string }> {
  const code = await tokenCreationCode();
  const launcher = await s.launcher.getAddress();
  const wdoge = BigInt(BARKSWAP.wdoge);
  for (let salt = opts.start ?? SALT_CURSOR; ; salt++) {
    const { coin } = predictCoin(code, launcher, creator, salt, name, symbol);
    if (BigInt(coin) < wdoge !== !!opts.aboveWNative && (await ethers.provider.getCode(coin)) === "0x") {
      if (opts.start === undefined) SALT_CURSOR = salt + 1n;
      return { salt, coin };
    }
  }
}

// ------------------------------------------------------------------------------------------------- launch

export interface LaunchOptions {
  creator?: HardhatEthersSigner;
  /** the transaction sender (default: the creator) */
  sender?: HardhatEthersSigner;
  /** the authorization signer (default: the create signer) */
  signer?: HardhatEthersSigner;
  name?: string;
  symbol?: string;
  salt?: bigint;
  firstBuy?: bigint;
  /** msg.value (default: the request's firstBuyValue) */
  value?: bigint;
  openAt?: bigint;
  feeChoice?: number;
  feeCreatorPct?: number;
  minFirstBuyOut?: bigint;
  targetUsd?: bigint;
  deadline?: bigint;
  requestOverrides?: Record<string, unknown>;
  /** a complete request (and optionally its authorization) instead of building one */
  req?: LaunchRequest;
  auth?: CreateAuthorization;
  /** mine the launch at exactly this block timestamp */
  atTimestamp?: bigint;
  gasLimit?: bigint;
}

let NAME_COUNTER = 0;

/** Builds, signs and sends a launch; returns the pending transaction (for revert assertions) and the request. */
export async function sendLaunch(
  s: BarkStack,
  o: LaunchOptions = {},
): Promise<{ tx: Promise<ContractTransactionResponse>; req: LaunchRequest; auth: CreateAuthorization }> {
  const creator = o.creator ?? s.signers.creator;
  let req = o.req;
  if (!req) {
    NAME_COUNTER++;
    const name = o.name ?? `Bark Coin ${NAME_COUNTER}`;
    const symbol = o.symbol ?? `BRK${NAME_COUNTER}`;
    const salt = o.salt ?? (await mineCoinSalt(s, creator.address, name, symbol)).salt;
    req = launchRequest({
      name,
      symbol,
      salt,
      firstBuyValue: o.firstBuy ?? 0n,
      openAt: o.openAt ?? 0n,
      feeChoice: o.feeChoice ?? 1,
      feeCreatorPct: o.feeCreatorPct ?? 0,
      minFirstBuyOut: o.minFirstBuyOut ?? 0n,
      targetUsd: o.targetUsd ?? TEST_TARGET_USD,
      ...(o.requestOverrides as Partial<LaunchRequest>),
    });
  }
  let auth = o.auth;
  if (!auth) {
    const deadline = o.deadline ?? (o.atTimestamp ?? (await latestTimestamp())) + 3600n;
    const signed = await signCreate(s, creator.address, req, deadline, o.signer ?? s.signers.createSigner);
    auth = { deadline: signed.deadline, signature: signed.signature };
  }
  if (o.atTimestamp !== undefined) await network.provider.send("evm_setNextBlockTimestamp", [Number(o.atTimestamp)]);
  const tx = (s.launcher.connect(o.sender ?? creator) as C).launch(req, auth, {
    value: o.value ?? req.firstBuyValue,
    gasLimit: o.gasLimit ?? 9_500_000n,
  }) as Promise<ContractTransactionResponse>;
  tx.catch(() => undefined); // the caller asserts on it
  return { tx, req, auth };
}

export interface LaunchResult {
  coin: string;
  pool: string;
  coinContract: C;
  poolContract: C;
  receipt: ContractTransactionReceipt;
  gasUsed: bigint;
  /** the Launched event's args */
  launched: Record<string, any>;
  req: LaunchRequest;
  auth: CreateAuthorization;
  openAt: bigint;
  tickStart: number;
  tickGrad: number;
  liqA: bigint;
  liqB: bigint;
  sqrtStart: bigint;
  sqrtGrad: bigint;
}

/** Launches a coin (signed create) and returns the coin, its pool and the launch plan as stored on chain. */
export async function launchCoin(s: BarkStack, o: LaunchOptions = {}): Promise<LaunchResult> {
  const { tx, req, auth } = await sendLaunch(s, o);
  const receipt = (await (await tx).wait())!;
  const ev = eventsOf(receipt, s.launcher, "Launched");
  if (ev.length !== 1) throw new Error("no Launched event");
  const launched = ev[0].args.toObject();
  const p = await s.plugin.pools(launched.pool);
  return {
    coin: launched.coin,
    pool: launched.pool,
    coinContract: (await ethers.getContractAt("contracts/gen8/MwzV4Token.sol:MwzV4Token", launched.coin)) as unknown as C,
    poolContract: (await algebraPool(launched.pool)) as unknown as C,
    receipt,
    gasUsed: receipt.gasUsed,
    launched,
    req,
    auth,
    openAt: BigInt(launched.openAt),
    tickStart: Number(launched.tickStart),
    tickGrad: Number(launched.tickGrad),
    liqA: BigInt(launched.liqA),
    liqB: BigInt(launched.liqB),
    sqrtStart: BigInt(p.sqrtStart),
    sqrtGrad: BigInt(p.sqrtGrad),
  };
}

/** WDOGE that buys all of A from the start price, before fees (rounded up). */
export function raiseOfA(L: Pick<LaunchResult, "sqrtStart" | "sqrtGrad" | "liqA">): bigint {
  return amount1Delta(L.sqrtStart, L.sqrtGrad, L.liqA, true);
}

// ------------------------------------------------------------------------------------------------- router and quoter

const ROUTER_DEADLINE = 2n ** 40n;

/** Barkswap's SwapRouter through the ABI exported by t7 (what the app uses). */
export function swapRouterAt(signer?: Signer): C {
  return new ethers.Contract(BARKSWAP.swapRouter, exportedAbi("AlgebraSwapRouter"), signer ?? ethers.provider) as C;
}

/** Barkswap's QuoterV2 through the ABI exported by t7. */
export function quoterV2At(): C {
  return new ethers.Contract(BARKSWAP.quoterV2, exportedAbi("AlgebraQuoterV2"), ethers.provider) as C;
}

/** Approves Barkswap's SwapRouter for `signer`'s coins (a transaction of its own: do it before timing a swap). */
export async function approveRouter(signer: HardhatEthersSigner, coin: string): Promise<void> {
  const token = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", coin, signer);
  if ((await token.allowance(signer.address, BARKSWAP.swapRouter)) < 2n ** 200n) {
    await (await token.approve(BARKSWAP.swapRouter, ethers.MaxUint256)).wait();
  }
}

/** The app's buy (spec §4): exactInputSingle, DOGE in, deployer = our launcher; with a price limit a multicall ending
 *  in refundNativeToken (gen-8 F14). */
export async function routerBuy(
  s: BarkStack,
  signer: HardhatEthersSigner,
  coin: string,
  amountIn: bigint,
  o: { limit?: bigint; recipient?: string; minOut?: bigint; gasLimit?: bigint } = {},
): Promise<ContractTransactionReceipt> {
  const router = swapRouterAt(signer);
  const params = {
    tokenIn: BARKSWAP.wdoge,
    tokenOut: coin,
    deployer: await s.launcher.getAddress(),
    recipient: o.recipient ?? signer.address,
    deadline: ROUTER_DEADLINE,
    amountIn,
    amountOutMinimum: o.minOut ?? 0n,
    limitSqrtPrice: o.limit ?? 0n,
  };
  const overrides = { value: amountIn, gasLimit: o.gasLimit ?? 3_000_000n };
  const tx =
    o.limit === undefined
      ? await router.exactInputSingle(params, overrides)
      : await router.multicall(
          [router.interface.encodeFunctionData("exactInputSingle", [params]), router.interface.encodeFunctionData("refundNativeToken", [])],
          overrides,
        );
  return (await tx.wait())!;
}

/** The app's sell (spec §4): multicall(exactInputSingle to the router, unwrapWNativeToken to the seller). Call
 *  approveRouter first. */
export async function routerSell(
  s: BarkStack,
  signer: HardhatEthersSigner,
  coin: string,
  amountIn: bigint,
  o: { limit?: bigint; gasLimit?: bigint } = {},
): Promise<ContractTransactionReceipt> {
  const router = swapRouterAt(signer);
  const params = {
    tokenIn: coin,
    tokenOut: BARKSWAP.wdoge,
    deployer: await s.launcher.getAddress(),
    recipient: ethers.ZeroAddress, // Algebra's router reads 0 as itself
    deadline: ROUTER_DEADLINE,
    amountIn,
    amountOutMinimum: 0n,
    limitSqrtPrice: o.limit ?? 0n,
  };
  const tx = await router.multicall(
    [router.interface.encodeFunctionData("exactInputSingle", [params]), router.interface.encodeFunctionData("unwrapWNativeToken", [0n, signer.address])],
    { gasLimit: o.gasLimit ?? 3_000_000n },
  );
  return (await tx.wait())!;
}

export interface Quote {
  amountOut: bigint;
  amountIn: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: bigint;
  gasEstimate: bigint;
  fee: bigint;
}

async function quoteExactIn(s: BarkStack, tokenIn: string, tokenOut: string, amountIn: bigint, limit: bigint): Promise<Quote> {
  const q = await quoterV2At().quoteExactInputSingle.staticCall({
    tokenIn,
    tokenOut,
    deployer: await s.launcher.getAddress(),
    amountIn,
    limitSqrtPrice: limit,
  });
  return { amountOut: q[0], amountIn: q[1], sqrtPriceX96After: q[2], initializedTicksCrossed: q[3], gasEstimate: q[4], fee: q[5] };
}

/** QuoterV2 quote of a buy (WDOGE in) on our pool (deployer = launcher). */
export function quoteBuy(s: BarkStack, coin: string, amountIn: bigint, limit = 0n): Promise<Quote> {
  return quoteExactIn(s, BARKSWAP.wdoge, coin, amountIn, limit);
}

/** QuoterV2 quote of a sell (coin in) on our pool (deployer = launcher). */
export function quoteSell(s: BarkStack, coin: string, amountIn: bigint, limit = 0n): Promise<Quote> {
  return quoteExactIn(s, coin, BARKSWAP.wdoge, amountIn, limit);
}

// ------------------------------------------------------------------------------------------------- events and state

/** Parsed logs emitted by `contract` in `receipt` (optionally only `name`), in log order. */
export function eventsOf(receipt: ContractTransactionReceipt, contract: C, name?: string): LogDescription[] {
  const addr = String(contract.target).toLowerCase();
  const out: LogDescription[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== addr) continue;
    let parsed: LogDescription | null = null;
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      parsed = null;
    }
    if (parsed && (name === undefined || parsed.name === name)) out.push(parsed);
  }
  return out;
}

/** The one BarkSwap event of a swap transaction, as an object of its named fields. */
export function barkSwapOf(s: BarkStack, receipt: ContractTransactionReceipt): Record<string, any> {
  const ev = eventsOf(receipt, s.plugin, "BarkSwap");
  if (ev.length !== 1) throw new Error(`expected one BarkSwap, got ${ev.length}`);
  return ev[0].args.toObject();
}

export interface PoolState {
  price: bigint;
  tick: number;
  lastFee: number;
  config: number;
  communityFee: number;
  unlocked: boolean;
}

export async function poolState(pool: string): Promise<PoolState> {
  const g = await (await algebraPool(pool)).globalState();
  return { price: g[0], tick: Number(g[1]), lastFee: Number(g[2]), config: Number(g[3]), communityFee: Number(g[4]), unlocked: g[5] };
}

/** Algebra Integral position key: owner << 48 | bottomTick (24 bits) << 24 | topTick (24 bits). */
export function positionKey(owner: string, bottom: number, top: number): string {
  return ethers.toBeHex((BigInt(owner) << 48n) | (BigInt.asUintN(24, BigInt(bottom)) << 24n) | BigInt.asUintN(24, BigInt(top)), 32);
}

export async function positionLiquidity(pool: string, owner: string, bottom: number, top: number): Promise<bigint> {
  return (await (await algebraPool(pool)).positions(positionKey(owner, bottom, top)))[0];
}

/** Barkswap's community fee in `token` for `pool`: pending in the pool plus what already reached the vault (the
 *  vault serves every pool, so compare deltas within one test). */
export async function communityFeesOf(pool: string, token: string): Promise<bigint> {
  const p = await algebraPool(pool);
  const [p0, p1] = await p.getCommunityFeePending();
  const pending = token.toLowerCase() === (await p.token0()).toLowerCase() ? p0 : p1;
  const erc20 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", token);
  return pending + (await erc20.balanceOf(BARKSWAP.communityVault));
}

// ------------------------------------------------------------------------------------------------- recorded fixture

/** One recorded log of test/fixtures/dogeos/barkSwapEvent.json. */
export interface RecordedLog {
  step: string;
  contract: "MwzBarkLauncher" | "MwzBarkPlugin" | "MwzBarkCreatorEscrow";
  event: string;
  address: string;
  blockNumber: number;
  blockTimestamp: number;
  transactionHash: string;
  txFrom: string;
  txTo: string;
  logIndex: number;
  topics: string[];
  data: string;
  /** decoded with the exported ABI; integers as decimal strings */
  args: Record<string, any>;
}

export interface EventFixture {
  description: string;
  recordedBy: string;
  chainId: string;
  forkBlock: number;
  abiSource: string;
  contracts: Record<string, string>;
  coin: string;
  pool: string;
  launch: Record<string, string | number>;
  signedCreate: {
    note: string;
    chainId: string;
    launcher: string;
    creator: string;
    signer: string;
    authType: string;
    authTypeHash: string;
    request: Record<string, string | number>;
    requestHash: string;
    deadline: string;
    innerHash: string;
    digest: string;
    signature: string;
    salt: string;
    coin: string;
    create2: { deployer: string; saltHash: string; initCodeHash: string; tokenArgs: { name: string; symbol: string; supply: string; initialHolder: string } };
  };
  logs: RecordedLog[];
}

const FIXTURE_CONTRACTS = ["MwzBarkLauncher", "MwzBarkPlugin", "MwzBarkCreatorEscrow"] as const;

function plainValue(v: any): any {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return Array.from(v, plainValue);
  return v;
}

/** Decoded event args by name, integers as decimal strings, arrays as arrays. */
export function plainArgs(ev: LogDescription): Record<string, any> {
  const out: Record<string, any> = {};
  ev.fragment.inputs.forEach((input, i) => {
    out[input.name] = plainValue(ev.args[i]);
  });
  return out;
}

function requestJson(req: LaunchRequest): Record<string, string | number> {
  return {
    name: req.name,
    symbol: req.symbol,
    logoURI: req.logoURI,
    xAccount: req.xAccount,
    website: req.website,
    extraLink: req.extraLink,
    metadataHash: req.metadataHash,
    targetUsd: req.targetUsd.toString(),
    feeChoice: req.feeChoice,
    feeCreatorPct: req.feeCreatorPct,
    firstBuyValue: req.firstBuyValue.toString(),
    minFirstBuyOut: req.minFirstBuyOut.toString(),
    salt: req.salt.toString(),
    openAt: req.openAt.toString(),
  };
}

function requestFromJson(r: Record<string, string | number>): LaunchRequest {
  return {
    name: String(r.name),
    symbol: String(r.symbol),
    logoURI: String(r.logoURI),
    xAccount: String(r.xAccount),
    website: String(r.website),
    extraLink: String(r.extraLink),
    metadataHash: String(r.metadataHash),
    targetUsd: BigInt(r.targetUsd),
    feeChoice: Number(r.feeChoice),
    feeCreatorPct: Number(r.feeCreatorPct),
    firstBuyValue: BigInt(r.firstBuyValue),
    minFirstBuyOut: BigInt(r.minFirstBuyOut),
    salt: BigInt(r.salt),
    openAt: BigInt(r.openAt),
  };
}

/** Runs one coin's lifecycle on the stack and records every launcher, plugin and escrow log plus the signed create:
 *  launch with a creator first buy (signed create, CREATE2 salt), a buy and a sell in the bonding phase, collect, the
 *  crossing buy (latch + inline graduation fee), a post-graduation buy and sell, collect, the coin-fee conversion and
 *  an escrow buy. */
export async function buildEventFixture(s: BarkStack): Promise<EventFixture> {
  const { creator, trader, keeper } = s.signers;
  const launcher = await s.launcher.getAddress();
  const named: Record<(typeof FIXTURE_CONTRACTS)[number], C> = {
    MwzBarkLauncher: s.launcher,
    MwzBarkPlugin: s.plugin,
    MwzBarkCreatorEscrow: s.escrow,
  };
  const logs: RecordedLog[] = [];
  const record = async (step: string, rc: ContractTransactionReceipt) => {
    const block = await ethers.provider.getBlock(rc.blockNumber);
    for (const [contract, c] of Object.entries(named) as Array<[(typeof FIXTURE_CONTRACTS)[number], C]>) {
      const addr = String(c.target).toLowerCase();
      for (const log of rc.logs) {
        if (log.address.toLowerCase() !== addr) continue;
        const ev = c.interface.parseLog(log);
        if (!ev) continue;
        logs.push({
          step,
          contract,
          event: ev.name,
          address: log.address,
          blockNumber: rc.blockNumber,
          blockTimestamp: block!.timestamp,
          transactionHash: rc.hash,
          txFrom: rc.from,
          txTo: rc.to ?? "",
          logIndex: log.index,
          topics: [...log.topics],
          data: log.data,
          args: plainArgs(ev),
        });
      }
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  };

  const name = "Bark Fixture Coin";
  const symbol = "BFIX";
  const { salt, coin } = await mineCoinSalt(s, creator.address, name, symbol, { start: 1n });
  const req = launchRequest({
    name,
    symbol,
    salt,
    firstBuyValue: 5n * WAD,
    xAccount: "@memewarzone",
    website: "https://memewar.zone",
    extraLink: "https://t.me/memewarzone",
    metadataHash: ethers.id("bark-fixture-metadata"),
  });
  const deadline = (await latestTimestamp()) + 3600n;
  const signed = await signCreate(s, creator.address, req, deadline);
  const L = await launchCoin(s, { creator, req, auth: { deadline, signature: signed.signature } });
  if (L.coin !== coin) throw new Error("coin address prediction failed");
  await record("launch with creator first buy", L.receipt);

  await mineAt(L.openAt + 61n);
  const buy = await routerBuy(s, trader, coin, 3n * WAD);
  await record("router buy (bonding)", buy);
  await approveRouter(trader, coin);
  const bought = BigInt(eventsOf(buy, s.plugin, "BarkSwap")[0].args.coinAmount);
  await record("router sell (bonding)", await routerSell(s, trader, coin, bought / 2n));
  await record("collect", (await (await s.launcher.connect(keeper).collect(coin, { gasLimit: 3_000_000n })).wait())!);
  await record("router buy crossing graduation", await routerBuy(s, trader, coin, (raiseOfA(L) * 13n) / 10n));
  await record("router buy (post-graduation)", await routerBuy(s, trader, coin, 2n * WAD));
  await record("router sell (post-graduation)", await routerSell(s, trader, coin, 1_000_000n * WAD));
  await record("collect", (await (await s.launcher.connect(keeper).collect(coin, { gasLimit: 3_000_000n })).wait())!);
  await mineAt((await latestTimestamp()) + 601n);
  await record("convert (coin fees to DOGE)", (await (await s.launcher.connect(keeper).convert(coin, { gasLimit: 3_000_000n })).wait())!);
  await record("escrow buy (creator)", (await (await s.escrow.connect(creator).buy(coin, 0n, { value: WAD, gasLimit: 3_000_000n })).wait())!);

  const code = await tokenCreationCode();
  const c2 = predictCoin(code, launcher, creator.address, salt, name, symbol);
  const forking = (network.config as { forking?: { blockNumber?: number } }).forking;
  return {
    description:
      "Recorded on a Chikyu fork by the t8 fork test: one coin's lifecycle on Barkswap (Algebra Integral 1.2.1) with the " +
      "audited MwzBark contracts. logs[] are every MwzBarkLauncher, MwzBarkPlugin and MwzBarkCreatorEscrow log in " +
      "order (raw topics/data plus args decoded with contracts/dogeos/barkswap/abi). BarkSwap.kind: 0 trade, 1 conversion, " +
      "2 escrow buy, 3 choice-vault buyback (not in this run). signedCreate is one D3 create request as the API must " +
      "produce it (t21). Accounts are hardhat's well-known local test accounts (fork only).",
    recordedBy: "test/dogeos/barkswap/BarkLaunch.fork.spec.ts (MWZ_RECORD_BARK_FIXTURES=1)",
    chainId: DOGEOS_CHIKYU_CHAIN_ID.toString(),
    forkBlock: forking?.blockNumber ?? 0,
    abiSource: "contracts/dogeos/barkswap/abi/{MwzBarkLauncher,MwzBarkPlugin,MwzBarkCreatorEscrow}.abi.json",
    contracts: {
      MwzBarkLauncher: launcher,
      MwzBarkPlugin: await s.plugin.getAddress(),
      MwzBarkCreatorEscrow: await s.escrow.getAddress(),
      MwzBarkCreatorChoiceVault: await s.choiceVault.getAddress(),
      MwzBarkReserveLock: await s.reserveLock.getAddress(),
      MwzBarkFeeSplitter: await s.splitter.getAddress(),
      MwzBarkLaunchLens: await s.lens.getAddress(),
      MwzBarkLaunchLib: await s.launchLib.getAddress(),
      MwzBarkFeeBooks: await s.feeBooks.getAddress(),
      GraduationOracle: await s.graduationOracle.getAddress(),
      DogeosTestnetDogeUsdOracle: await s.feed.getAddress(),
      WDOGE: BARKSWAP.wdoge,
      SwapRouter: BARKSWAP.swapRouter,
      QuoterV2: BARKSWAP.quoterV2,
      AlgebraFactory: BARKSWAP.factory,
      CustomPoolEntryPoint: BARKSWAP.customPoolEntryPoint,
    },
    coin,
    pool: L.pool,
    launch: {
      tickStart: L.tickStart,
      tickGrad: L.tickGrad,
      sqrtStart: L.sqrtStart.toString(),
      sqrtGrad: L.sqrtGrad.toString(),
      liqA: L.liqA.toString(),
      liqB: L.liqB.toString(),
      openAt: L.openAt.toString(),
    },
    signedCreate: {
      note:
        "digest = EIP-191 personal_sign hash of innerHash; innerHash = keccak256(abi.encode(authTypeHash, chainId, " +
        "launcher, creator, requestHash, deadline)); requestHash = MwzBarkLauncher.hashRequest(request). The coin is " +
        "CREATE2(launcher, keccak256(abi.encode(creator, salt)), keccak256(MwzV4Token creation code ++ abi.encode(name, " +
        "symbol, 1e27, launcher))) and must sort below WDOGE.",
      chainId: DOGEOS_CHIKYU_CHAIN_ID.toString(),
      launcher,
      creator: creator.address,
      signer: signed.signer,
      authType: "MWZ_GEN8_CREATE_AUTH",
      authTypeHash: CREATE_AUTH_TYPE,
      request: requestJson(req),
      requestHash: signed.requestHash,
      deadline: deadline.toString(),
      innerHash: signed.innerHash,
      digest: signed.digest,
      signature: signed.signature,
      salt: salt.toString(),
      coin,
      create2: {
        deployer: launcher,
        saltHash: c2.saltHash,
        initCodeHash: c2.initCodeHash,
        tokenArgs: { name, symbol, supply: SUPPLY.toString(), initialHolder: launcher },
      },
    },
    logs,
  };
}

export function writeEventFixture(f: EventFixture): void {
  fs.mkdirSync(path.dirname(EVENT_FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(EVENT_FIXTURE_PATH, `${JSON.stringify(f, null, 2)}\n`);
}

export function readEventFixture(): EventFixture {
  return JSON.parse(fs.readFileSync(EVENT_FIXTURE_PATH, "utf8"));
}

/** Checks a recorded fixture without a chain: the signature, digest and request hash; the CREATE2 coin below WDOGE;
 *  every log decodes with the exported ABI to its recorded args. Throws on the first mismatch. */
export async function verifyEventFixture(f: EventFixture): Promise<void> {
  const fail = (what: string) => {
    throw new Error(`barkSwapEvent.json: ${what}`);
  };
  const sc = f.signedCreate;
  const req = requestFromJson(sc.request);
  if (hashLaunchRequest(req) !== sc.requestHash) fail("requestHash");
  if (sc.authTypeHash !== CREATE_AUTH_TYPE || ethers.id(sc.authType) !== CREATE_AUTH_TYPE) fail("authType");
  const inner = createAuthInnerHash(BigInt(sc.chainId), sc.launcher, sc.creator, sc.requestHash, BigInt(sc.deadline));
  if (inner !== sc.innerHash) fail("innerHash");
  if (ethers.hashMessage(ethers.getBytes(inner)) !== sc.digest) fail("digest");
  if (ethers.recoverAddress(sc.digest, sc.signature) !== sc.signer) fail("signature does not recover to signer");
  if (sc.salt !== sc.request.salt) fail("salt");
  const c2 = predictCoin(await tokenCreationCode(), sc.launcher, sc.creator, BigInt(sc.salt), req.name, req.symbol);
  if (c2.coin !== sc.coin || c2.coin !== f.coin) fail("CREATE2 coin");
  if (c2.saltHash !== sc.create2.saltHash || c2.initCodeHash !== sc.create2.initCodeHash) fail("CREATE2 hashes");
  if (BigInt(sc.coin) >= BigInt(BARKSWAP.wdoge)) fail("coin does not sort below WDOGE");
  const ifaces = Object.fromEntries(FIXTURE_CONTRACTS.map((n) => [n, new ethers.Interface(exportedAbi(n))]));
  for (const log of f.logs) {
    if (log.address !== f.contracts[log.contract]) fail(`${log.step} ${log.event}: address`);
    const ev = ifaces[log.contract].parseLog({ topics: log.topics, data: log.data });
    if (!ev || ev.name !== log.event) fail(`${log.step}: ${log.event} does not decode`);
    if (JSON.stringify(plainArgs(ev!)) !== JSON.stringify(log.args)) fail(`${log.step} ${log.event}: args differ`);
  }
  const launched = f.logs.find((l) => l.event === "Launched");
  if (!launched || launched.args.coin !== f.coin || launched.args.pool !== f.pool || launched.args.creator !== sc.creator) fail("Launched");
}
