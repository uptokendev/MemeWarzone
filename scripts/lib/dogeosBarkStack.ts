/**
 * DogeOS Chikyū testnet (6281971): the Bark stack (gen-8 on Barkswap custom pools), deployed and wired in one ordered
 * run (barkswap plan t15; spec docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md section 3 "Contracts",
 * "Reused unchanged", "Roles and keys (B9)", section 5 "Deployment 1"; hand-offs in docs/dogeos/barkswap-audit.md).
 * Replaces the gen-7 stack library (dogeosGen7Stack.ts): no gen-7 factory, campaign, MuchFi variant, TreasuryRouterV4
 * or capped main vault (B8). The fee splitter is the only depositor into the vaults, as on gen-8.
 *
 * Two builds, no bytecode drift (plan global constraints):
 *   root  artifacts/        solc 0.8.24, the reused contracts with the bytecode BNB and Robinhood run
 *                           (`npx hardhat compile`)
 *   bark  artifacts-bark/   solc 0.8.26 (gen-8 settings), the Bark contracts and their two libraries
 *                           (`npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile`)
 * Both are read from disk, so the same run works under any hardhat config; an artifact whose sources differ from the
 * working tree is refused (recompile first).
 *
 * Order (every transaction from the admin A = the deployer, W = WDOGE, EP = Barkswap's custom-pool entry point):
 *   reused   O1 DogeosTestnetDogeUsdOracle(updater, initialAnswer, false)   O2 GraduationOracle(O1, 3600)
 *            V1 TreasuryVaultV2(A, 0, A)  V2 CharityTreasury(A)  V3 MonthlyLeagueTreasury(A, A, O2, V2, monthlyCapUsd)
 *            V4 RecruiterRewardsVault(A)  V5 ProtocolRevenueVault(A)  HD RewardDistributor(A) holders
 *            AD RewardDistributor(A) airdrop
 *   Bark, at addresses planned from the deployer's nonce before the first of them is sent (each periphery contract
 *   takes the launcher's predicted address; the launcher's constructor checks plugin, reserve lock and choice vault
 *   point back at it; nothing calls the launcher at construction):
 *            +0 MwzBarkLaunchLib  +1 MwzBarkFeeBooks  +2 CommunityRewardsVault(A, splitter) (gen-8: router = splitter)
 *            +3 MwzBarkCreatorEscrow(L)  +4 MwzBarkFeeSplitter(L, A, V1, V3, V4, CRV, V5, operator)
 *            +5 MwzBarkCreatorChoiceVault(A, L, 24 h)  +6 MwzBarkReserveLock(L)  +7 MwzBarkPlugin(L, W, escrow, vault)
 *            +8 MwzBarkLauncher(EP, W, plugin, O2, lock, vault, A, routeAuthority, splitter, $0.01, $10, 3600) linked
 *               to +0 / +1   +9 MwzBarkLaunchLens(L)
 *   wiring   choice vault: setHolderDistributorOnce(HD), setOperator(operator, false), setCaps(caps);
 *            HD.setBatchOperator(choice vault); the airdrop pot as scripts/make-airdrop-setup-calls.mjs wires it
 *            (CRV.setRewardDistributor(AD), CRV.setAirdropOperator, AD.setBatchOperator(CRV)). No batch is authorized
 *            here: the DogeOS airdrop weeks are authorized later with make-airdrop-setup-calls.mjs --chain 6281971.
 * Roles (B9): owner/admin of everything = A; createSigner = the route authority; splitter operator (route, and the
 * launcher's claimRouter operator through F4) and choice-vault operator (buyback, executeHolderBatch) = the DogeOS
 * operator; the keeper holds no role. The launcher lands createPaused; opening it is activate-dogeos-testnet.ts only.
 * Runs only on chain 6281971 (Chikyū or a fork of it), and only when ethers' first signer is params.admin.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "hardhat";
import type { Provider } from "ethers";

export const DOGEOS_BARK_CHAIN_ID = 6281971n;
export const DOGEOS_BARK_MANIFEST_KIND = "dogeos-testnet-bark";
/** MonthlyLeagueTreasury cap, as scripts/deploy-robinhood-current-stage.ts constructs it (lifted from the gen-7 stack). */
export const DOGEOS_DEFAULT_MONTHLY_CAP_USD = 1_500_000n * 10n ** 18n;
/** MwzBarkCreatorChoiceVault holderBatchDelay: the veto window (its MIN_HOLDER_BATCH_DELAY, gen-8 testnet). */
export const DOGEOS_HOLDER_BATCH_DELAY_SECONDS = 24n * 3600n;

const ROOT = path.resolve(__dirname, "..", "..");

export function loadDogeosDeployGuards(): Promise<any> {
  return Function("s", "return import(s)")(pathToFileURL(path.join(__dirname, "dogeosTestnetDeployGuards.mjs")).href);
}

function loadAirdropPlanner(): Promise<any> {
  return Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, "scripts", "make-airdrop-setup-calls.mjs")).href);
}

// ---------------------------------------------------------------------------------------------------- artifacts

export type StackBuild = "root" | "bark";
/**
 * Per build: directory, compiler and the settings the build-info input must carry (root: hardhat.config.ts, evmVersion
 * hardhat's 0.8.24 default; bark: gen-8's GEN8_SOLC in hardhat.gen8.config.ts).
 */
const BUILD = {
  root: {
    dir: "artifacts",
    solc: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: "paris", bytecodeHash: "none" },
    compile: "npx hardhat compile",
  },
  bark: {
    dir: "artifacts-bark",
    solc: "0.8.26",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun", bytecodeHash: "none" },
    compile: "npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile",
  },
} as const;

export type StackArtifact = { contractName: string; sourceName: string; abi: any[]; bytecode: string; linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>> };

const buildInfoCache = new Map<string, any>();

/**
 * The artifact of `fqn` ("contracts/<file>.sol:<Name>") from the given build directory, refused when the build used
 * another compiler or when any `contracts/` source it was compiled from differs from the working tree.
 */
export function loadStackArtifact(build: StackBuild, fqn: string): StackArtifact {
  const b = BUILD[build];
  if (!b) throw new Error(`unknown build ${build}`);
  const [sourceName, name] = fqn.split(":");
  if (!sourceName || !name) throw new Error(`${fqn} is not a fully qualified contract name`);
  const file = path.join(ROOT, b.dir, ...sourceName.split("/"), `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`${fqn}: no ${b.dir} artifact; run \`${b.compile}\` first`);
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const dbg = JSON.parse(fs.readFileSync(file.replace(/\.json$/, ".dbg.json"), "utf8"));
  const buildInfoFile = path.resolve(path.dirname(file), ...String(dbg.buildInfo).split(/[\\/]/));
  let info = buildInfoCache.get(buildInfoFile);
  if (!info) {
    info = JSON.parse(fs.readFileSync(buildInfoFile, "utf8"));
    for (const [source, { content }] of Object.entries<any>(info.input.sources)) {
      if (!source.startsWith("contracts/")) continue;
      const onDisk = path.join(ROOT, ...source.split("/"));
      if (fs.existsSync(onDisk) && fs.readFileSync(onDisk, "utf8") !== content) {
        throw new Error(`${b.dir} is stale: ${source} changed since it was compiled; run \`${b.compile}\` first`);
      }
    }
    buildInfoCache.set(buildInfoFile, info);
  }
  if (info.solcVersion !== b.solc) throw new Error(`${fqn}: ${b.dir} was built with solc ${info.solcVersion}, expected ${b.solc}`);
  const st = info.input.settings ?? {};
  const got = {
    optimizer: { enabled: st.optimizer?.enabled, runs: st.optimizer?.runs },
    viaIR: st.viaIR,
    evmVersion: st.evmVersion,
    bytecodeHash: st.metadata?.bytecodeHash,
  };
  if (JSON.stringify(got) !== JSON.stringify(b.settings)) {
    throw new Error(`${fqn}: ${b.dir} was built with settings ${JSON.stringify(got)}, expected ${JSON.stringify(b.settings)}; run \`${b.compile}\``);
  }
  if (!info.input.sources[sourceName]) throw new Error(`${fqn}: not part of its build-info input`);
  return artifact;
}

/** Fills the artifact's library placeholders. Every reference must be given and every given library must be used. */
export function linkBytecode(artifact: StackArtifact, libraries: Record<string, string>): string {
  let code = artifact.bytecode;
  const used = new Set<string>();
  for (const [source, libs] of Object.entries(artifact.linkReferences ?? {})) {
    for (const [lib, refs] of Object.entries(libs)) {
      const key = `${source}:${lib}`;
      const address = libraries[key];
      if (!address) throw new Error(`${artifact.contractName}: library ${key} not given`);
      const hex = ethers.getAddress(address).slice(2).toLowerCase();
      for (const { start, length } of refs) {
        if (length !== 20) throw new Error(`${artifact.contractName}: unexpected link reference length ${length}`);
        code = code.slice(0, 2 + start * 2) + hex + code.slice(2 + (start + length) * 2);
      }
      used.add(key);
    }
  }
  for (const key of Object.keys(libraries)) if (!used.has(key)) throw new Error(`${artifact.contractName}: library ${key} is not referenced`);
  if (code.includes("__$")) throw new Error(`${artifact.contractName}: unlinked library placeholder left`);
  return code;
}

// ---------------------------------------------------------------------------------------------------- plan

const sol = (file: string, name: string) => `contracts/${file}.sol:${name}`;
const FQN = {
  DogeosTestnetDogeUsdOracle: sol("dogeos/testnet/DogeosTestnetDogeUsdOracle", "DogeosTestnetDogeUsdOracle"),
  GraduationOracle: sol("GraduationOracle", "GraduationOracle"),
  TreasuryVaultV2: sol("TreasuryVaultV2", "TreasuryVaultV2"),
  CharityTreasury: sol("CharityTreasury", "CharityTreasury"),
  MonthlyLeagueTreasury: sol("MonthlyLeagueTreasury", "MonthlyLeagueTreasury"),
  RecruiterRewardsVault: sol("RecruiterRewardsVault", "RecruiterRewardsVault"),
  ProtocolRevenueVault: sol("ProtocolRevenueVault", "ProtocolRevenueVault"),
  RewardDistributor: sol("RewardDistributor", "RewardDistributor"),
  CommunityRewardsVault: sol("CommunityRewardsVault", "CommunityRewardsVault"),
  MwzBarkLaunchLib: sol("dogeos/barkswap/libraries/MwzBarkLaunchLib", "MwzBarkLaunchLib"),
  MwzBarkFeeBooks: sol("dogeos/barkswap/libraries/MwzBarkFeeBooks", "MwzBarkFeeBooks"),
  MwzBarkCreatorEscrow: sol("dogeos/barkswap/MwzBarkCreatorEscrow", "MwzBarkCreatorEscrow"),
  MwzBarkFeeSplitter: sol("dogeos/barkswap/MwzBarkFeeSplitter", "MwzBarkFeeSplitter"),
  MwzBarkCreatorChoiceVault: sol("dogeos/barkswap/MwzBarkCreatorChoiceVault", "MwzBarkCreatorChoiceVault"),
  MwzBarkReserveLock: sol("dogeos/barkswap/MwzBarkReserveLock", "MwzBarkReserveLock"),
  MwzBarkPlugin: sol("dogeos/barkswap/MwzBarkPlugin", "MwzBarkPlugin"),
  MwzBarkLauncher: sol("dogeos/barkswap/MwzBarkLauncher", "MwzBarkLauncher"),
  MwzBarkLaunchLens: sol("dogeos/barkswap/MwzBarkLaunchLens", "MwzBarkLaunchLens"),
} as const;

/** The contracts deployed at planned nonces, in order from the first planned nonce. */
export const BARK_PREDICTED_ORDER = [
  "MwzBarkLaunchLib",
  "MwzBarkFeeBooks",
  "CommunityRewardsVault",
  "MwzBarkCreatorEscrow",
  "MwzBarkFeeSplitter",
  "MwzBarkCreatorChoiceVault",
  "MwzBarkReserveLock",
  "MwzBarkPlugin",
  "MwzBarkLauncher",
  "MwzBarkLaunchLens",
] as const;
export type BarkPredicted = (typeof BARK_PREDICTED_ORDER)[number];

export function planBarkAddresses(deployer: string, nonce0: number): Record<BarkPredicted, string> {
  const from = ethers.getAddress(deployer);
  return Object.fromEntries(BARK_PREDICTED_ORDER.map((name, i) => [name, ethers.getCreateAddress({ from, nonce: nonce0 + i })])) as Record<BarkPredicted, string>;
}

export type ChoiceVaultCaps = {
  maxBuyPerTx: bigint;
  maxBuybackPerCoinWeek: bigint;
  minBuyInterval: bigint;
  maxImpactBps: bigint;
  maxHolderBatchPerWeek: bigint;
};

// ---------------------------------------------------------------------------------------------------- deploy

export type DogeosBarkStackParams = {
  /** Owner/admin of everything; must be the deploying signer (ethers' first signer). */
  admin: string;
  /** The launcher's createSigner: the DogeOS route-authority key's public address (a deploy parameter). */
  routeAuthority: string;
  /** The DogeOS operator (B9): splitter operator, router-claim operator, choice-vault operator. */
  operator: string;
  /** The DOGE/USD oracle's single immutable updater. */
  oracleUpdater: string;
  /** Initial DOGE/USD answer, 8 decimals, > 0. */
  initialDogeUsdAnswer: bigint;
  /** Choice-vault caps in DOGE. */
  choiceVaultCaps: ChoiceVaultCaps;
  /** CommunityRewardsVault.airdropOperator; default the admin (as the gen-8 testnet pot). */
  airdropOperator?: string;
  /** MonthlyLeagueTreasury monthlyCapUsd (18 decimals); default 1,500,000 USD. */
  monthlyCapUsd?: bigint;
  log?: (line: string) => void;
  /** Called with a fresh snapshot after every send and every receipt (the deploy script persists it). */
  onProgress?: (progress: DogeosBarkProgress) => void;
};

/** status: "sent" until its receipt is in, then "mined" (or "failed" if it reverted). */
export type DogeosBarkTx = { label: string; hash: string; nonce: number; gasUsed: string; status: "sent" | "mined" | "failed"; address?: string };

/**
 * What a run has sent so far, handed to onProgress after every transaction is sent and again once it is mined. The
 * deploy script writes it to `<manifest>.partial.json`, so a run that stops half-way leaves a record of what it
 * deployed; the deploy refuses while that file exists (no resume).
 */
export type DogeosBarkProgress = {
  status: "partial";
  chainId: number;
  deployer: string;
  routeAuthority: string;
  operator: string;
  /** Contracts mined so far, by label. */
  deployed: Record<string, string>;
  /** The Bark addresses planned from the deployer's nonce (null until the reused contracts are deployed). */
  planned: Record<string, string> | null;
  barkNonce0: number | null;
  wiringSent: string[];
  txs: DogeosBarkTx[];
};

export type DogeosBarkStack = {
  chainId: number;
  deployer: string;
  admin: string;
  routeAuthority: string;
  operator: string;
  airdropOperator: string;
  startBlock: number;
  barkNonce0: number;
  /** The Barkswap addresses (keys of BARKSWAP_EXTERNAL_ADDRESSES) plus `codeHashes`, as checked before the first send. */
  barkswap: Record<string, any>;
  oracle: { dogeUsd: string; graduationOracle: string; maxPriceAge: string; updater: string; initialAnswer: string };
  launcherConfig: { minNativeUsd: string; maxNativeUsd: string; maxOracleAge: string };
  vaults: {
    weekly: string;
    charity: string;
    monthly: string;
    recruiter: string;
    protocol: string;
    community: string;
    holderDistributor: string;
    airdropDistributor: string;
    monthlyCapUsd: string;
  };
  choiceVault: { holderBatchDelay: string; caps: Record<keyof ChoiceVaultCaps, string> };
  deployed: Record<Exclude<BarkPredicted, "CommunityRewardsVault">, string>;
  wiringSent: string[];
  txs: DogeosBarkTx[];
};

function requireAddress(label: string, value: string | undefined): string {
  if (!value) throw new Error(`${label} is required`);
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) throw new Error(`${label} is the zero address`);
  return address;
}

export async function deployDogeosBarkStack(params: DogeosBarkStackParams): Promise<DogeosBarkStack> {
  const log = params.log ?? ((line: string) => console.log(`[dogeos-bark] ${line}`));
  const guards = await loadDogeosDeployGuards();

  // ---------------------------------------------------------------- guards (nothing is sent before these pass)
  const provider = ethers.provider;
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== DOGEOS_BARK_CHAIN_ID) throw new Error(`the DogeOS Bark stack deploys only on chain 6281971 (Chikyū or a fork of it); this chain is ${chainId}`);
  const admin = requireAddress("params.admin", params.admin);
  const [signer] = await ethers.getSigners();
  const deployer = ethers.getAddress(await signer.getAddress());
  if (deployer !== admin) throw new Error(`deployer ${deployer} is not params.admin ${admin}`);
  const routeAuthority = requireAddress("params.routeAuthority", params.routeAuthority);
  const operator = requireAddress("params.operator", params.operator);
  const oracleUpdater = requireAddress("params.oracleUpdater", params.oracleUpdater);
  const keeper = ethers.getAddress(guards.DOGEOS_TESTNET_ROLES.graduationKeeper);
  if (routeAuthority === admin) throw new Error(`params.routeAuthority ${routeAuthority} is the admin; it must be its own key`);
  for (const [other, label] of [[admin, "the admin"], [routeAuthority, "the route authority"], [oracleUpdater, "the oracle updater"], [keeper, "the keeper"]]) {
    if (operator === other) throw new Error(`params.operator ${operator} is ${label}; the DogeOS operator must be its own key (spec B9)`);
  }
  if (params.initialDogeUsdAnswer <= 0n) throw new Error("params.initialDogeUsdAnswer must be positive (8 decimals)");
  const airdropOperator = params.airdropOperator ? requireAddress("params.airdropOperator", params.airdropOperator) : admin;
  if (airdropOperator === keeper) throw new Error("params.airdropOperator is the keeper; the keeper holds no contract role");
  const monthlyCapUsd = params.monthlyCapUsd ?? DOGEOS_DEFAULT_MONTHLY_CAP_USD;
  const caps = params.choiceVaultCaps;
  if (caps.maxImpactBps > 50n) throw new Error(`choice-vault maxImpactBps ${caps.maxImpactBps} is above its MAX_IMPACT_BPS_LIMIT 50`);

  const X = guards.BARKSWAP_EXTERNAL_ADDRESSES as Record<string, string>;
  const codeHashes: Record<string, string> = {};
  for (const [key, address] of Object.entries(X)) codeHashes[key] = ethers.keccak256(await provider.getCode(address));
  guards.assertBarkswapCode(codeHashes);
  const EP = ethers.getAddress(X.customPoolEntryPoint);
  const W = ethers.getAddress(X.wdoge);
  const epFactory = await new ethers.Contract(EP, ["function factory() view returns (address)"], provider).factory();
  if (ethers.getAddress(epFactory) !== ethers.getAddress(X.factory)) throw new Error(`entry point factory() ${epFactory} is not the Barkswap factory ${X.factory}`);
  const band = guards.DOGEOS_BARK_LAUNCHER_BAND as { minNativeUsd: bigint; maxNativeUsd: bigint; maxOracleAge: bigint };
  const maxPriceAge = guards.DOGEOS_ORACLE_MAX_PRICE_AGE_SECONDS as bigint;

  // Every artifact is loaded (and checked current) before the first transaction.
  const artifacts = Object.fromEntries(
    Object.entries(FQN).map(([name, fqn]) => [name, loadStackArtifact(fqn.startsWith("contracts/dogeos/barkswap/") ? "bark" : "root", fqn)]),
  ) as Record<keyof typeof FQN, StackArtifact>;

  const txs: DogeosBarkTx[] = [];
  const deployedSoFar: Record<string, string> = {};
  const wiringSent: string[] = [];
  let planned: Record<string, string> | null = null;
  let plannedNonce0: number | null = null;
  const progress = () =>
    params.onProgress?.({
      status: "partial",
      chainId: Number(chainId),
      deployer,
      routeAuthority,
      operator,
      deployed: { ...deployedSoFar },
      planned: planned ? { ...planned } : null,
      barkNonce0: plannedNonce0,
      wiringSent: [...wiringSent],
      txs: txs.map((t) => ({ ...t })),
    });
  /** Records the sent transaction before waiting for it, so a run that stops on the receipt still lists it. */
  async function confirm(entry: DogeosBarkTx, tx: any, label: string) {
    txs.push(entry);
    progress();
    let receipt: any;
    try {
      receipt = await tx.wait(1);
    } catch (error) {
      entry.status = "failed";
      progress();
      throw error;
    }
    if (!receipt || receipt.status !== 1) {
      entry.status = "failed";
      progress();
      throw new Error(`${label} failed (${tx.hash})`);
    }
    entry.status = "mined";
    entry.gasUsed = receipt.gasUsed.toString();
    return receipt;
  }
  async function deploy(label: string, name: keyof typeof FQN, args: unknown[], opts: { expected?: string; libraries?: Record<string, string> } = {}) {
    const nonce = await provider.getTransactionCount(deployer, "pending");
    const predicted = ethers.getCreateAddress({ from: deployer, nonce });
    if (opts.expected && predicted !== opts.expected) {
      throw new Error(`${label}: the deployer's nonce ${nonce} would create ${predicted}, not the planned ${opts.expected} (nonce drifted)`);
    }
    const artifact = artifacts[name];
    // Only the constructor fragment: a library ABI names library-internal types ethers cannot parse.
    const ctor = artifact.abi.filter((f) => f.type === "constructor");
    const factory = new ethers.ContractFactory(ctor, linkBytecode(artifact, opts.libraries ?? {}), signer);
    const contract: any = await factory.deploy(...args, { nonce });
    const tx = contract.deploymentTransaction();
    if (!tx) throw new Error(`${label}: no deployment transaction`);
    await confirm({ label, hash: tx.hash, nonce, gasUsed: "", status: "sent", address: predicted }, tx, `${label} deploy`);
    const address = ethers.getAddress(await contract.getAddress());
    if (address !== predicted) throw new Error(`${label} landed at ${address}, not ${predicted}`);
    if ((await provider.getCode(address)) === "0x") throw new Error(`${label} ${address} has no code`);
    deployedSoFar[label] = address;
    progress();
    log(`${label} ${address}`);
    return address;
  }
  async function send(label: string, address: string, name: keyof typeof FQN, fn: string, args: unknown[]) {
    const contract: any = new ethers.Contract(address, artifacts[name].abi, signer);
    const nonce = await provider.getTransactionCount(deployer, "pending");
    const tx = await contract[fn](...args, { nonce });
    await confirm({ label: `${label}.${fn}`, hash: tx.hash, nonce, gasUsed: "", status: "sent" }, tx, `${label}.${fn}`);
    wiringSent.push(`${label}.${fn}`);
    progress();
    log(`${label}.${fn}: ${tx.hash}`);
  }

  // ---------------------------------------------------------------- reused unchanged (root 0.8.24 build)
  const O1 = await deploy("DogeosTestnetDogeUsdOracle", "DogeosTestnetDogeUsdOracle", [oracleUpdater, params.initialDogeUsdAnswer, false]);
  const O2 = await deploy("GraduationOracle", "GraduationOracle", [O1, maxPriceAge]);
  const V1 = await deploy("TreasuryVaultV2 (weekly)", "TreasuryVaultV2", [admin, ethers.ZeroAddress, admin]);
  const V2 = await deploy("CharityTreasury", "CharityTreasury", [admin]);
  const V3 = await deploy("MonthlyLeagueTreasury", "MonthlyLeagueTreasury", [admin, admin, O2, V2, monthlyCapUsd]);
  const V4 = await deploy("RecruiterRewardsVault", "RecruiterRewardsVault", [admin]);
  const V5 = await deploy("ProtocolRevenueVault", "ProtocolRevenueVault", [admin]);
  const HD = await deploy("RewardDistributor (holders)", "RewardDistributor", [admin]);
  const AD = await deploy("RewardDistributor (airdrop)", "RewardDistributor", [admin]);

  // ---------------------------------------------------------------- Bark stack at planned addresses
  const barkNonce0 = await provider.getTransactionCount(deployer, "pending");
  const P = planBarkAddresses(deployer, barkNonce0);
  planned = { ...P };
  plannedNonce0 = barkNonce0;
  log(`planned from nonce ${barkNonce0}: launcher ${P.MwzBarkLauncher}, splitter ${P.MwzBarkFeeSplitter}, plugin ${P.MwzBarkPlugin}`);
  const L = P.MwzBarkLauncher;
  const libs = await (async () => {
    const lib = await deploy("MwzBarkLaunchLib", "MwzBarkLaunchLib", [], { expected: P.MwzBarkLaunchLib });
    const books = await deploy("MwzBarkFeeBooks", "MwzBarkFeeBooks", [], { expected: P.MwzBarkFeeBooks });
    return { [FQN.MwzBarkLaunchLib]: lib, [FQN.MwzBarkFeeBooks]: books };
  })();
  const CRV = await deploy("CommunityRewardsVault", "CommunityRewardsVault", [admin, P.MwzBarkFeeSplitter], { expected: P.CommunityRewardsVault });
  const E = await deploy("MwzBarkCreatorEscrow", "MwzBarkCreatorEscrow", [L], { expected: P.MwzBarkCreatorEscrow });
  const S = await deploy("MwzBarkFeeSplitter", "MwzBarkFeeSplitter", [L, admin, V1, V3, V4, CRV, V5, operator], { expected: P.MwzBarkFeeSplitter });
  const V = await deploy("MwzBarkCreatorChoiceVault", "MwzBarkCreatorChoiceVault", [admin, L, DOGEOS_HOLDER_BATCH_DELAY_SECONDS], {
    expected: P.MwzBarkCreatorChoiceVault,
  });
  const R = await deploy("MwzBarkReserveLock", "MwzBarkReserveLock", [L], { expected: P.MwzBarkReserveLock });
  const PL = await deploy("MwzBarkPlugin", "MwzBarkPlugin", [L, W, E, V], { expected: P.MwzBarkPlugin });
  await deploy(
    "MwzBarkLauncher",
    "MwzBarkLauncher",
    [EP, W, PL, O2, R, V, admin, routeAuthority, S, band.minNativeUsd, band.maxNativeUsd, band.maxOracleAge],
    { expected: L, libraries: libs },
  );
  const LENS = await deploy("MwzBarkLaunchLens", "MwzBarkLaunchLens", [L], { expected: P.MwzBarkLaunchLens });

  // ---------------------------------------------------------------- wiring (admin)
  await send("MwzBarkCreatorChoiceVault", V, "MwzBarkCreatorChoiceVault", "setHolderDistributorOnce", [HD]);
  await send("MwzBarkCreatorChoiceVault", V, "MwzBarkCreatorChoiceVault", "setOperator", [operator, false]);
  await send("MwzBarkCreatorChoiceVault", V, "MwzBarkCreatorChoiceVault", "setCaps", [
    caps.maxBuyPerTx,
    caps.maxBuybackPerCoinWeek,
    caps.minBuyInterval,
    caps.maxImpactBps,
    caps.maxHolderBatchPerWeek,
  ]);
  await send("RewardDistributor (holders)", HD, "RewardDistributor", "setBatchOperator", [V]);
  const { airdropWiringCalls } = await loadAirdropPlanner();
  for (const c of airdropWiringCalls({ vault: CRV, distributor: AD, operator: airdropOperator })) {
    const label = c.contract === "RewardDistributor" ? "RewardDistributor (airdrop)" : c.contract;
    await send(label, c.to, c.contract, c.fn, c.args);
  }

  const first = txs[0];
  const startBlock = Number((await provider.getTransactionReceipt(first.hash))?.blockNumber);
  const stack: DogeosBarkStack = {
    chainId: Number(chainId),
    deployer,
    admin,
    routeAuthority,
    operator,
    airdropOperator,
    startBlock,
    barkNonce0,
    barkswap: { ...Object.fromEntries(Object.entries(X).map(([k, a]) => [k, ethers.getAddress(a)])), codeHashes },
    oracle: { dogeUsd: O1, graduationOracle: O2, maxPriceAge: maxPriceAge.toString(), updater: oracleUpdater, initialAnswer: params.initialDogeUsdAnswer.toString() },
    launcherConfig: { minNativeUsd: band.minNativeUsd.toString(), maxNativeUsd: band.maxNativeUsd.toString(), maxOracleAge: band.maxOracleAge.toString() },
    vaults: { weekly: V1, charity: V2, monthly: V3, recruiter: V4, protocol: V5, community: CRV, holderDistributor: HD, airdropDistributor: AD, monthlyCapUsd: monthlyCapUsd.toString() },
    choiceVault: {
      holderBatchDelay: DOGEOS_HOLDER_BATCH_DELAY_SECONDS.toString(),
      caps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, String(v)])) as Record<keyof ChoiceVaultCaps, string>,
    },
    deployed: {
      MwzBarkLaunchLib: libs[FQN.MwzBarkLaunchLib],
      MwzBarkFeeBooks: libs[FQN.MwzBarkFeeBooks],
      MwzBarkCreatorEscrow: E,
      MwzBarkFeeSplitter: S,
      MwzBarkCreatorChoiceVault: V,
      MwzBarkReserveLock: R,
      MwzBarkPlugin: PL,
      MwzBarkLauncher: L,
      MwzBarkLaunchLens: LENS,
    },
    wiringSent,
    txs,
  };
  const checks = await readBackDogeosBarkStack({ ...stack, kind: DOGEOS_BARK_MANIFEST_KIND }, { provider, expectCreatePaused: true });
  log(`read-back: ${checks} checks passed. STOP. The launcher is createPaused.`);
  return stack;
}

// ---------------------------------------------------------------------------------------------------- read-back

const A = (fn: string) => `function ${fn}() view returns (address)`;
const U = (fn: string) => `function ${fn}() view returns (uint256)`;
const B = (fn: string) => `function ${fn}() view returns (bool)`;

/**
 * Reads every address and role of a deployed Bark stack back from chain and compares it with the manifest record:
 * the launcher's constructor wiring and band, the cross-checks the launcher does not make (splitter, escrow), the
 * B9 roles, the reused vaults and oracles, the airdrop pot and the linked libraries. expectCreatePaused: true right
 * after deploy, false after activation, undefined = either. Returns the number of checks; throws listing every
 * mismatch. Uses inline ABI fragments, so it runs under any hardhat config.
 */
export async function readBackDogeosBarkStack(record: any, { provider, expectCreatePaused }: { provider: Provider; expectCreatePaused?: boolean }): Promise<number> {
  const guards = await loadDogeosDeployGuards();
  const failures: string[] = [];
  let checks = 0;
  const addr = (v: unknown) => {
    try {
      return ethers.getAddress(String(v));
    } catch {
      return `invalid(${String(v)})`;
    }
  };
  const eq = (label: string, got: unknown, want: unknown) => {
    checks += 1;
    if (String(got) !== String(want)) failures.push(`${label}: chain ${String(got)}, expected ${String(want)}`);
  };
  const c = (address: string, frags: string[]) => new ethers.Contract(address, frags, provider) as any;
  const readAddr = async (address: string, fn: string) => addr(await c(address, [A(fn)])[fn]());
  const readUint = async (address: string, fn: string) => BigInt(await c(address, [U(fn)])[fn]());
  const readBool = async (address: string, fn: string) => Boolean(await c(address, [B(fn)])[fn]());

  if (Number(record?.chainId) !== Number(DOGEOS_BARK_CHAIN_ID)) throw new Error(`record chainId ${record?.chainId} is not 6281971`);
  const net = (await provider.getNetwork()).chainId;
  if (net !== DOGEOS_BARK_CHAIN_ID) throw new Error(`read-back provider is on chain ${net}, not 6281971`);
  const d = record.deployed ?? {};
  const v = record.vaults ?? {};
  const o = record.oracle ?? {};
  const X = guards.BARKSWAP_EXTERNAL_ADDRESSES as Record<string, string>;
  const admin = addr(record.admin);
  const operator = addr(record.operator);
  const routeAuthority = addr(record.routeAuthority);
  const keeper = addr(guards.DOGEOS_TESTNET_ROLES.graduationKeeper);
  const band = guards.DOGEOS_BARK_LAUNCHER_BAND;

  const all: Array<[string, string]> = [
    ...Object.entries<string>(d).map(([k, a]): [string, string] => [`deployed.${k}`, a]),
    ["oracle.dogeUsd", o.dogeUsd],
    ["oracle.graduationOracle", o.graduationOracle],
    ...Object.entries<string>(v)
      .filter(([k]) => k !== "monthlyCapUsd")
      .map(([k, a]): [string, string] => [`vaults.${k}`, a]),
  ];
  for (const [label, a] of all) {
    checks += 1;
    if ((await provider.getCode(addr(a)).catch(() => "0x")) === "0x") failures.push(`${label} ${a}: no code`);
  }
  if (failures.length) throw new Error(`Bark stack read-back failed (${failures.length}):\n  ${failures.join("\n  ")}`);

  // launcher: constructor wiring, band, roles
  const L = addr(d.MwzBarkLauncher);
  eq("launcher.entryPoint", await readAddr(L, "entryPoint"), addr(X.customPoolEntryPoint));
  eq("launcher.algebraFactory", await readAddr(L, "algebraFactory"), addr(X.factory));
  eq("launcher.wNative", await readAddr(L, "wNative"), addr(X.wdoge));
  eq("launcher.plugin", await readAddr(L, "plugin"), addr(d.MwzBarkPlugin));
  eq("launcher.oracle", await readAddr(L, "oracle"), addr(o.graduationOracle));
  eq("launcher.reserveLock", await readAddr(L, "reserveLock"), addr(d.MwzBarkReserveLock));
  eq("launcher.choiceVault", await readAddr(L, "choiceVault"), addr(d.MwzBarkCreatorChoiceVault));
  eq("launcher.treasuryRouter (the splitter)", await readAddr(L, "treasuryRouter"), addr(d.MwzBarkFeeSplitter));
  eq("launcher.pendingRouter", await readAddr(L, "pendingRouter"), ethers.ZeroAddress);
  eq("launcher.minNativeUsd", await readUint(L, "minNativeUsd"), band.minNativeUsd);
  eq("launcher.maxNativeUsd", await readUint(L, "maxNativeUsd"), band.maxNativeUsd);
  eq("launcher.maxOracleAge", await readUint(L, "maxOracleAge"), band.maxOracleAge);
  eq("launcher.minNativeUsd (manifest)", record.launcherConfig?.minNativeUsd, band.minNativeUsd);
  eq("launcher.maxNativeUsd (manifest)", record.launcherConfig?.maxNativeUsd, band.maxNativeUsd);
  eq("launcher.maxOracleAge (manifest)", record.launcherConfig?.maxOracleAge, band.maxOracleAge);
  eq("launcher.owner", await readAddr(L, "owner"), admin);
  eq("launcher.pendingOwner", await readAddr(L, "pendingOwner"), ethers.ZeroAddress);
  eq("launcher.createSigner (route authority)", await readAddr(L, "createSigner"), routeAuthority);
  if (expectCreatePaused !== undefined) eq("launcher.createPaused", await readBool(L, "createPaused"), expectCreatePaused);
  const launcherCode = (await provider.getCode(L)).toLowerCase();
  for (const lib of ["MwzBarkLaunchLib", "MwzBarkFeeBooks"]) {
    checks += 1;
    if (!launcherCode.includes(addr(d[lib]).slice(2).toLowerCase())) failures.push(`launcher: ${lib} ${d[lib]} is not linked into its code`);
  }

  // plugin
  const P = addr(d.MwzBarkPlugin);
  eq("plugin.launcher", await readAddr(P, "launcher"), L);
  eq("plugin.wNative", await readAddr(P, "wNative"), addr(X.wdoge));
  eq("plugin.creatorEscrow", await readAddr(P, "creatorEscrow"), addr(d.MwzBarkCreatorEscrow));
  eq("plugin.choiceVault", await readAddr(P, "choiceVault"), addr(d.MwzBarkCreatorChoiceVault));
  const cfg = (a: string) => c(a, ["function PLUGIN_CONFIG() view returns (uint8)"]).PLUGIN_CONFIG();
  eq("plugin.PLUGIN_CONFIG == launcher.PLUGIN_CONFIG", await cfg(P), await cfg(L));

  // splitter (B9: admin = deployer, operator = DogeOS operator; the launcher's claimRouter operator via F4)
  const S = addr(d.MwzBarkFeeSplitter);
  eq("splitter.launcher", await readAddr(S, "launcher"), L);
  eq("splitter.admin", await readAddr(S, "admin"), admin);
  eq("splitter.operator", await readAddr(S, "operator"), operator);
  eq("splitter.weeklyLeagueVault", await readAddr(S, "weeklyLeagueVault"), addr(v.weekly));
  eq("splitter.monthlyLeagueTreasury", await readAddr(S, "monthlyLeagueTreasury"), addr(v.monthly));
  eq("splitter.recruiterRewardsVault", await readAddr(S, "recruiterRewardsVault"), addr(v.recruiter));
  eq("splitter.communityRewardsVault", await readAddr(S, "communityRewardsVault"), addr(v.community));
  eq("splitter.protocolRevenueVault", await readAddr(S, "protocolRevenueVault"), addr(v.protocol));

  // choice vault
  const V = addr(d.MwzBarkCreatorChoiceVault);
  eq("choiceVault.launcher", await readAddr(V, "launcher"), L);
  eq("choiceVault.admin", await readAddr(V, "admin"), admin);
  eq("choiceVault.operator", await readAddr(V, "operator"), operator);
  eq("choiceVault.operatorPaused", await readBool(V, "operatorPaused"), false);
  eq("choiceVault.holderDistributor", await readAddr(V, "holderDistributor"), addr(v.holderDistributor));
  eq("choiceVault.holderBatchDelay", await readUint(V, "holderBatchDelay"), record.choiceVault?.holderBatchDelay);
  for (const k of ["maxBuyPerTx", "maxBuybackPerCoinWeek", "minBuyInterval", "maxImpactBps", "maxHolderBatchPerWeek"]) {
    eq(`choiceVault.${k}`, await readUint(V, k), record.choiceVault?.caps?.[k]);
  }

  // escrow, reserve lock, lens
  eq("escrow.launcher", await readAddr(addr(d.MwzBarkCreatorEscrow), "launcher"), L);
  eq("reserveLock.launcher", await readAddr(addr(d.MwzBarkReserveLock), "launcher"), L);
  eq("lens.launcher", await readAddr(addr(d.MwzBarkLaunchLens), "launcher"), L);
  eq("lens.plugin", await readAddr(addr(d.MwzBarkLaunchLens), "plugin"), P);

  // oracles
  const O1 = addr(o.dogeUsd);
  const O2 = addr(o.graduationOracle);
  eq("dogeUsd.updater", await readAddr(O1, "updater"), addr(guards.DOGEOS_TESTNET_ROLES.oracleUpdater));
  eq("dogeUsd.updater (manifest)", addr(o.updater), addr(guards.DOGEOS_TESTNET_ROLES.oracleUpdater));
  eq("dogeUsd.certifiedChainId", await readUint(O1, "certifiedChainId"), DOGEOS_BARK_CHAIN_ID);
  eq("dogeUsd.localRehearsal", await readBool(O1, "localRehearsal"), false);
  eq("graduationOracle.priceFeed", await readAddr(O2, "priceFeed"), O1);
  eq("graduationOracle.maxPriceAge", await readUint(O2, "maxPriceAge"), guards.DOGEOS_ORACLE_MAX_PRICE_AGE_SECONDS);

  // reused vaults and distributors
  eq("weekly.multisig", await readAddr(addr(v.weekly), "multisig"), admin);
  eq("charity.multisig", await readAddr(addr(v.charity), "multisig"), admin);
  eq("monthly.multisig", await readAddr(addr(v.monthly), "multisig"), admin);
  eq("monthly.oracle", await readAddr(addr(v.monthly), "oracle"), O2);
  eq("monthly.charityTreasury", await readAddr(addr(v.monthly), "charityTreasury"), addr(v.charity));
  eq("monthly.monthlyCapUsd", await readUint(addr(v.monthly), "monthlyCapUsd"), v.monthlyCapUsd);
  eq("recruiter.admin", await readAddr(addr(v.recruiter), "admin"), admin);
  eq("protocol.admin", await readAddr(addr(v.protocol), "admin"), admin);
  eq("community.admin", await readAddr(addr(v.community), "admin"), admin);
  eq("community.router (the splitter)", await readAddr(addr(v.community), "router"), S);
  eq("community.rewardDistributor", await readAddr(addr(v.community), "rewardDistributor"), addr(v.airdropDistributor));
  eq("community.airdropOperator", await readAddr(addr(v.community), "airdropOperator"), addr(record.airdropOperator));
  eq("holderDistributor.owner", await readAddr(addr(v.holderDistributor), "owner"), admin);
  eq("holderDistributor.batchOperator", await readAddr(addr(v.holderDistributor), "batchOperator"), V);
  eq("airdropDistributor.owner", await readAddr(addr(v.airdropDistributor), "owner"), admin);
  eq("airdropDistributor.batchOperator", await readAddr(addr(v.airdropDistributor), "batchOperator"), addr(v.community));

  // B9: the operator is its own key, the keeper holds no role
  for (const [label, other] of [["admin", admin], ["route authority", routeAuthority], ["oracle updater", addr(guards.DOGEOS_TESTNET_ROLES.oracleUpdater)], ["keeper", keeper]]) {
    checks += 1;
    if (operator === other) failures.push(`operator ${operator} is the ${label}; it must be its own key (spec B9)`);
  }
  for (const [label, holder] of [["admin", admin], ["route authority", routeAuthority], ["airdrop operator", addr(record.airdropOperator)]]) {
    checks += 1;
    if (holder === keeper) failures.push(`the keeper ${keeper} is the ${label}; the keeper holds no contract role`);
  }

  if (failures.length) throw new Error(`Bark stack read-back failed (${failures.length}):\n  ${failures.join("\n  ")}`);
  return checks;
}

// ---------------------------------------------------------------------------------------------------- manifest

/**
 * The deployments/dogeos/testnet.bark.json record (spec section 5 "Deployment 1"): kind dogeos-testnet-bark, the
 * Barkswap pins it was deployed against, the reused oracle and vaults, the Bark contracts under `deployed`, the roles,
 * and every transaction (label, hash, nonce, gas, created address) for the read-backs and the verification check.
 */
export function dogeosBarkManifestRecord(stack: DogeosBarkStack, meta: { network: string; deployedAt: string }) {
  return {
    network: meta.network,
    chainId: stack.chainId,
    kind: DOGEOS_BARK_MANIFEST_KIND,
    status: "deployed-paused",
    deployedAt: meta.deployedAt,
    startBlock: stack.startBlock,
    deployer: stack.deployer,
    admin: stack.admin,
    owner: stack.admin,
    routeAuthority: stack.routeAuthority,
    operator: stack.operator,
    airdropOperator: stack.airdropOperator,
    barkswap: stack.barkswap,
    oracle: stack.oracle,
    launcherConfig: stack.launcherConfig,
    vaults: stack.vaults,
    choiceVault: stack.choiceVault,
    deployed: stack.deployed,
    barkNonce0: stack.barkNonce0,
    wiringSent: stack.wiringSent,
    txs: stack.txs,
    next: [
      "verify on L2Scan: npm run verify:dogeos-testnet (reused contracts) and npm run verify:dogeos-bark-testnet (Bark contracts)",
      "route authority key on the TEST API (the launcher's createSigner)",
      "authorize the airdrop weeks: node scripts/make-airdrop-setup-calls.mjs --chain 6281971 --skip-wiring ...",
      "setCreatePaused(false) only with the founder's go (scripts/activate-dogeos-testnet.ts)",
    ],
  };
}

export function writeDogeosManifest(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(file, `${json}\n`);
}

