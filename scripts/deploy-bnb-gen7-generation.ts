/**
 * EVM launch generation 7 on BNB (docs/evm-launch/EVM_GEN7_V2_PLAN.md): deploys the gen-7 generation, lands it
 * create-paused and not live, writes the record, and writes the two Safe batches that bind (B) and open (H) it.
 *
 * WHY A GEN-7 FEES STACK (router + creator vault + holder distributor + community vault), not the live gen-6 one
 * (plan C10 said "reuse"; the contracts do not allow it, read on BNB 56, 2026-10-08):
 *   - LaunchFactoryGen7._createCampaign calls `creatorRewardsVault().setCampaignChoice(...)` on the vault its fee
 *     router names (contracts/gen7/LaunchFactoryGen7.sol:552, :1001), and CreatorRewardsVaultV2.setCampaignChoice
 *     reverts OnlyFactory unless msg.sender is the ONE factory pinned by setFactoryOnce (CreatorRewardsVaultV2.sol:237-245,
 *     :301-302). The live vault 0x6Cb44e3d is pinned to the gen-6 factory 0x1948411B. Every gen-7 create on the live
 *     router would revert.
 *   - TreasuryRouterV4.setCreatorRewardsVault is set-once ("already set", TreasuryRouterV4.sol:312-313; the comment at
 *     :72-74 says "A new vault means a new router and a new factory generation").
 *   - The vault also pins ONE locker (setFactoryOnce reads factory.permanentLpLocker(), :240-243) for syncLpFees, and
 *     gen-7 has its own locker (C9).
 *   - CommunityRewardsVault serves ONE router (onlyRouter deposits, CommunityRewardsVault.sol:42/62-64/78-84) and every
 *     StandardUnlinked trade sends it 15% (TreasuryRouterV4.sol:196-197, :420-427 `require(ok, "airdrop route failed")`).
 *     Re-pointing the live one 0xB6ccAc81 to the gen-7 router would revert every gen-6 trade, so gen-7 gets a fresh one
 *     (the BSC testnet gen-6 run did the same for the same reason, deployments/bscTestnet/testnet.gen6.json).
 * Reused unchanged: weekly league vault, monthly league treasury, recruiter vault (read from the live gen-6 router),
 * protocol revenue: the ProtocolRevenueForwarder 0x2ABd8970 (deployments/bnb/mainnet.protocol-revenue-forwarder.json;
 * not router-bound, forwards to the same ProtocolRevenueVault 0xc2d4E6f8), GraduationOracle, CreatorRegistry,
 * RiskRegistry, route authority, Topaz. Caps and the vault operator default to the live gen-6 vault's values.
 *
 * Per factory (bound once, so new instances): PermanentLpLocker (admin = factory, C9), BnbNativeGraduationAdapter
 * (immutable locker + setCampaignFactoryOnce, BnbNativeGraduationAdapter.sol:55/96/112-116/184),
 * BnbQuoteGraduationAdapter (same, BnbQuoteGraduationAdapter.sol:116/194/229-233/460). LaunchTokenDeployer is
 * stateless (contracts/token/LaunchTokenDeployer.sol:11-12) but deployed fresh by the shared create wiring, as gen-6.
 *
 * Sequence on 56 (each line its own founder go):
 *   1. this script (deployer): fees stack + generation, everything Safe-administered, factory create-paused, not live
 *   2. EVMGEN7_BATCHES_ONLY=1 this script: writes batch B (bind) and batch H (open), simulated as the Safe
 *   3. Safe executes batch B
 *   4. transfer-evm-ownership-to-safe.ts (deployer): OWNABLE_CONTRACTS=<gen-7 factory>
 *   5. Safe executes batch H: gen-7 enableLive + setCreatePaused(false), gen-6 factory setCreatePaused(true) (C11)
 *
 *   CONFIRM_BNB_GEN7_GENERATION=I_UNDERSTAND_MAINNET npx hardhat run scripts/deploy-bnb-gen7-generation.ts --network bscMainnet
 *   EVMGEN7_BATCHES_ONLY=1 npx hardhat run scripts/deploy-bnb-gen7-generation.ts --network bscMainnet
 *
 * BSC testnet (97): the gen-6 testnet record (deployments/bscTestnet/testnet.gen6.json) supplies the reused vaults,
 * the authoritative 30 bps Topaz, oracle, feed, registries and route authority; the deployer is admin of everything
 * (testnet), so batch B is SENT by the deployer in the same run; batch H is left to the lifecycle script
 * (GEN7_ENABLE_LIVE=true), as on gen-6.
 *   CONFIRM_BNB_GEN7_GENERATION=I_UNDERSTAND_TESTNET \
 *     npx hardhat --config hardhat.bsc-testnet.config.ts run scripts/deploy-bnb-gen7-generation.ts --network bscTestnet
 *
 * Forks: `bscForkRehearsal` (56, scripts/lib/forkRehearsal.ts) and `bscTestnetForkRehearsal` (97,
 * hardhat.bnb-gen7-fork.config.ts) are accepted only after anvil_nodeInfo proves a local fork; their records land
 * under deployments/fork-rehearsal/<network>/ (gitignored). Any other chain id is refused.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

import { assertLocalFork, profileNetworkName } from "./lib/forkRehearsal";
import { deployFactoryWithLocker } from "./lib/deployFactoryWithLocker";
import { assertCreatorVaultServesGeneration, VAULT_DEX_TOPAZ_V2, wireGenerationCreatePath } from "./lib/evmGenerationCreateWiring";
import { simulateAsAdmin, writeSafeBatch, encodePlannedCall, type PlannedCall } from "./lib/safeCallPlan";
import { deployFeesStack, UPGRADE_DELAY_SECONDS, HOLDER_BATCH_DELAY_SECONDS, type Caps } from "./deploy-evm-treasury-router-v4";
import { assertTopazRoutersFit } from "./deploy-bnb-quote-generation";

const ROOT = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.join(ROOT, "deployments");
const MAX_QUOTE_ORACLE_AGE_SECONDS = 3600; // as gen-6 (deploy-bnb-quote-generation.ts MAX_ORACLE_AGE_SECONDS)
const PROTOCOL_FEE_BPS = 200n;

/** Network names that are verified local anvil forks standing for a real profile. */
export const GEN7_FORK_NETWORKS: Record<string, { profile: "bscMainnet" | "bscTestnet"; chainId: number }> = {
  bscForkRehearsal: { profile: "bscMainnet", chainId: 56 },
  bscTestnetForkRehearsal: { profile: "bscTestnet", chainId: 97 },
};

export function isGen7ForkNetwork(name = network.name) {
  return Object.prototype.hasOwnProperty.call(GEN7_FORK_NETWORKS, name);
}

/** bscMainnet / bscTestnet, or the profile a verified local fork stands for. Anything else is refused. */
export async function gen7ProfileName(): Promise<"bscMainnet" | "bscTestnet"> {
  const alias = GEN7_FORK_NETWORKS[network.name];
  if (alias) {
    await assertLocalFork(alias.chainId);
    return alias.profile;
  }
  const name = await profileNetworkName();
  if (name !== "bscMainnet" && name !== "bscTestnet") {
    throw new Error(`network ${network.name}: gen-7 BNB runs only on bscMainnet (56), bscTestnet (97) or their local forks`);
  }
  return name;
}

/** Where a record or batch goes: the real path, or under the fork's rehearsal directory. */
export function gen7Path(file: string): string {
  if (!isGen7ForkNetwork()) return file;
  const outDir = String(process.env.REHEARSAL_OUT_DIR || "").trim() || path.join(DEPLOYMENTS, "fork-rehearsal", network.name);
  const rel = path.relative(DEPLOYMENTS, path.resolve(file));
  return path.join(outDir, rel.startsWith("..") || path.isAbsolute(rel) ? path.basename(file) : rel);
}

const readJson = (file: string) => {
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export type Gen7Inputs = {
  profile: "bscMainnet" | "bscTestnet";
  chainId: number;
  mainnet: boolean;
  confirm: string;
  admin: string; // Safe on 56; the deployer on 97
  gen6: { factory: string; router: string; vault: string };
  topazAdapter: string; // answers poolFactory()/WETH() (factory constructor)
  topazRouter: string; // Topaz's own router (quote adapter)
  graduationOracle: string;
  nativeUsdFeed: string;
  creatorRegistry: string;
  riskRegistry: string;
  routeAuthority: string;
  weekly: string;
  monthly: string;
  recruiter: string;
  protocol: string;
  operator: string;
  caps: Caps;
  record: string;
  batchB: string;
  batchH: string;
};

function envAddr(name: string): string | null {
  const raw = String(process.env[name] || "").trim();
  return raw ? ethers.getAddress(raw) : null;
}

/**
 * Every input, from the repo's records first, then re-read and cross-checked on chain. Nothing is invented: a
 * record that disagrees with the chain stops the run before any send.
 */
export async function resolveInputs(profile: "bscMainnet" | "bscTestnet", deployer: string): Promise<Gen7Inputs> {
  const p = ethers.provider;
  const view = (to: string, sig: string, args: unknown[] = []) => new ethers.Contract(to, [`function ${sig}`], p)[sig.split("(")[0]](...args);
  if (profile === "bscMainnet") {
    const gen = readJson(path.join(DEPLOYMENTS, "bnb", "mainnet.quote-generation.json"));
    const fees = readJson(path.join(DEPLOYMENTS, "bnb", "mainnet.evmgen-fees.json"));
    const fwd = readJson(path.join(DEPLOYMENTS, "bnb", "mainnet.protocol-revenue-forwarder.json"));
    const safe = ethers.getAddress(gen.owner);
    const gen6 = { factory: ethers.getAddress(gen.contracts.BnbBasicLaunchFactory), router: ethers.getAddress(fees.contracts.router), vault: ethers.getAddress(fees.contracts.vault) };
    // Cross-check the records against the chain: the gen-6 factory pays the recorded router, which pays the recorded
    // vault, which is pinned to that factory (the reason this generation needs its own stack).
    if (!same(await view(gen6.factory, "feeRecipient() view returns (address)"), gen6.router)) throw new Error("gen-6 factory feeRecipient != recorded router V4");
    if (!same(await view(gen6.router, "creatorRewardsVault() view returns (address)"), gen6.vault)) throw new Error("gen-6 router creatorRewardsVault != recorded vault");
    if (!same(await view(gen6.router, "admin() view returns (address)"), safe)) throw new Error("gen-6 router admin is not the recorded Safe");
    const pinned = await view(gen6.vault, "factory() view returns (address)");
    console.log(`[bnb-gen7] live gen-6 vault ${gen6.vault} is pinned to factory ${pinned}: gen-7 needs its own router + vault`);
    const caps = await view(gen6.vault, "limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)");
    const forwarder = envAddr("BNB_GEN7_PROTOCOL_VAULT") ?? ethers.getAddress(fwd.address);
    if (!envAddr("BNB_GEN7_PROTOCOL_VAULT")) {
      const sink = await view(forwarder, "nativeSink() view returns (address)");
      if (!same(sink, fwd.constructorArgs.nativeSink)) throw new Error(`forwarder ${forwarder} sink ${sink} != record`);
      if (!same(await view(forwarder, "admin() view returns (address)"), safe)) throw new Error(`forwarder ${forwarder} admin is not the Safe`);
    }
    return {
      profile, chainId: 56, mainnet: true, confirm: "I_UNDERSTAND_MAINNET", admin: safe, gen6,
      topazAdapter: ethers.getAddress(gen.inputs.topazRouter),
      topazRouter: ethers.getAddress(gen.inputs.topazQuoteRouter),
      graduationOracle: ethers.getAddress(await view(gen6.factory, "graduationOracle() view returns (address)")),
      nativeUsdFeed: ethers.getAddress(gen.inputs.nativeUsdFeed),
      creatorRegistry: ethers.getAddress(await view(gen6.factory, "creatorRegistry() view returns (address)")),
      riskRegistry: ethers.getAddress(await view(gen6.factory, "riskRegistry() view returns (address)")),
      routeAuthority: envAddr("BNB_GEN7_ROUTE_AUTHORITY") ?? ethers.getAddress(gen.inputs.routeAuthority),
      weekly: ethers.getAddress(await view(gen6.router, "weeklyLeagueVault() view returns (address)")),
      monthly: ethers.getAddress(await view(gen6.router, "monthlyLeagueTreasury() view returns (address)")),
      recruiter: ethers.getAddress(await view(gen6.router, "recruiterRewardsVault() view returns (address)")),
      protocol: forwarder,
      operator: envAddr("BNB_GEN7_VAULT_OPERATOR") ?? ethers.getAddress(await view(gen6.vault, "operator() view returns (address)")),
      caps: {
        maxBuyPerTx: caps[1], maxBuybackPerCampaignWeek: caps[2], minBuyInterval: caps[3], maxImpactBps: caps[4], maxHolderBatchPerWeek: caps[5],
        holderBatchAuthorizationMax: BigInt(fees.caps.holderBatchAuthorizationMax),
      },
      record: path.join(DEPLOYMENTS, "bnb", "mainnet.gen7.json"),
      batchB: path.join(DEPLOYMENTS, "bnb", "mainnet.gen7.B.safe-batch.json"),
      batchH: path.join(DEPLOYMENTS, "bnb", "mainnet.gen7.H-open.safe-batch.json"),
    };
  }
  // BSC testnet: the gen-6 testnet record. Its router/vault serve the gen-6 testnet factory only (vault pinned), so
  // gen-7 gets its own stack there too; the reused vaults, Topaz, oracle and registries come from the record.
  const rec = readJson(path.join(DEPLOYMENTS, "bscTestnet", "testnet.gen6.json"));
  const gen6 = { factory: ethers.getAddress(rec.generation.contracts.BnbBasicLaunchFactory), router: ethers.getAddress(rec.fees.router), vault: ethers.getAddress(rec.fees.creatorRewardsVaultV2) };
  if (!same(await view(gen6.factory, "feeRecipient() view returns (address)"), gen6.router)) throw new Error("gen-6 testnet factory feeRecipient != recorded router");
  for (const [fn, want] of [["weeklyLeagueVault", rec.fees.reusedVaults.weekly], ["monthlyLeagueTreasury", rec.fees.reusedVaults.monthly], ["recruiterRewardsVault", rec.fees.reusedVaults.recruiter], ["protocolRevenueVault", rec.fees.reusedVaults.protocol]] as const) {
    if (!same(await view(gen6.router, `${fn}() view returns (address)`), want)) throw new Error(`gen-6 testnet router ${fn} != record`);
  }
  const c = rec.fees.caps;
  return {
    profile, chainId: 97, mainnet: false, confirm: "I_UNDERSTAND_TESTNET", admin: deployer, gen6,
    topazAdapter: ethers.getAddress(rec.topaz.routerAdapter),
    topazRouter: ethers.getAddress(rec.topaz.router),
    graduationOracle: ethers.getAddress(rec.graduationOracle),
    nativeUsdFeed: ethers.getAddress(rec.nativeUsdFeed),
    creatorRegistry: ethers.getAddress(rec.generation.inputs.creatorRegistry),
    riskRegistry: ethers.getAddress(rec.generation.inputs.riskRegistry),
    routeAuthority: envAddr("BNB_GEN7_ROUTE_AUTHORITY") ?? ethers.getAddress(rec.routeAuthority),
    weekly: ethers.getAddress(rec.fees.reusedVaults.weekly),
    monthly: ethers.getAddress(rec.fees.reusedVaults.monthly),
    recruiter: ethers.getAddress(rec.fees.reusedVaults.recruiter),
    protocol: ethers.getAddress(rec.fees.reusedVaults.protocol),
    operator: envAddr("BNB_GEN7_VAULT_OPERATOR") ?? ethers.getAddress(rec.fees.payoutOperator),
    caps: {
      maxBuyPerTx: BigInt(c.maxBuyPerTx), maxBuybackPerCampaignWeek: BigInt(c.maxBuybackPerCampaignWeek), minBuyInterval: BigInt(c.minBuyInterval),
      maxImpactBps: BigInt(c.maxImpactBps), maxHolderBatchPerWeek: BigInt(c.maxHolderBatchPerWeek), holderBatchAuthorizationMax: BigInt(c.holderBatchAuthorizationMax),
    },
    record: path.join(DEPLOYMENTS, "bscTestnet", "testnet.gen7.json"),
    batchB: path.join(DEPLOYMENTS, "bscTestnet", "testnet.gen7.B.safe-batch.json"),
    batchH: path.join(DEPLOYMENTS, "bscTestnet", "testnet.gen7.H-open.safe-batch.json"),
  };
}

async function assertChain(expected: number) {
  const id = Number((await ethers.provider.getNetwork()).chainId);
  if (id !== expected) throw new Error(`REFUSED: chain ${id}, expected ${expected}`);
}

async function requireCode(label: string, address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function readBack<T>(read: () => Promise<T>, expected: T, label: string, attempts = 8): Promise<T> {
  let value = await read();
  for (let i = 1; i < attempts && String(value).toLowerCase() !== String(expected).toLowerCase(); i++) {
    await new Promise((r) => setTimeout(r, 2000)); // public BSC nodes can answer a block behind
    value = await read();
  }
  if (String(value).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`${label}: actual=${value} expected=${expected}`);
  console.log(`[bnb-gen7] ok ${label}=${value}`);
  return value;
}

async function waitTx(txPromise: Promise<any>, label: string) {
  const tx = await txPromise;
  const rc = await tx.wait(1);
  if (!rc || rc.status !== 1) throw new Error(`${label} failed`);
  console.log(`[bnb-gen7] sent ${label}: ${tx.hash} gas ${rc.gasUsed}`);
  return rc;
}

function writeRecord(file: string, rec: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rec, big, 2)}\n`);
}

/** Stage 1: TreasuryRouterV4 + CreatorRewardsVaultV2 + holder RewardDistributor (shared deployer) + a fresh CommunityRewardsVault. */
async function deployGen7Fees(deployer: any, inp: Gen7Inputs, wbnb: string, topazPoolFactory: string) {
  await assertChain(inp.chainId);
  const d = await deployFeesStack(deployer, { safe: inp.admin, weekly: inp.weekly, monthly: inp.monthly, wrappedNative: wbnb, dexKind: 1, dexFactory: topazPoolFactory });
  await assertChain(inp.chainId);
  const community = await (await ethers.getContractFactory("CommunityRewardsVault", deployer)).deploy(inp.admin, d.router);
  await community.waitForDeployment();
  const fees = { ...d, community: await community.getAddress() };
  console.log(`[bnb-gen7] TreasuryRouterV4 ${fees.router}\n[bnb-gen7] CreatorRewardsVaultV2 ${fees.vault}\n[bnb-gen7] RewardDistributor ${fees.holderDistributor}\n[bnb-gen7] CommunityRewardsVault ${fees.community}`);
  const view = (to: string, sig: string) => new ethers.Contract(to, [`function ${sig}`], ethers.provider)[sig.split("(")[0]]();
  await readBack(() => view(fees.router, "admin() view returns (address)"), inp.admin, "router.admin");
  await readBack(() => view(fees.router, "upgradeDelay() view returns (uint64)"), BigInt(UPGRADE_DELAY_SECONDS), "router.upgradeDelay");
  await readBack(() => view(fees.vault, "admin() view returns (address)"), inp.admin, "vault.admin");
  await readBack(() => view(fees.vault, "router() view returns (address)"), fees.router, "vault.router");
  await readBack(() => view(fees.vault, "holderBatchDelay() view returns (uint256)"), BigInt(HOLDER_BATCH_DELAY_SECONDS), "vault.holderBatchDelay");
  await readBack(() => view(fees.holderDistributor, "owner() view returns (address)"), inp.admin, "distributor.owner");
  await readBack(() => view(fees.community, "admin() view returns (address)"), inp.admin, "community.admin");
  await readBack(() => view(fees.community, "router() view returns (address)"), fees.router, "community.router");
  return fees;
}

/** Stage 2: gen-7 implementations, locker + factory, adapters, registries, route authority, create path; create paused. */
async function deployGen7Generation(deployer: any, deployerAddress: string, inp: Gen7Inputs, fees: { router: string; vault: string }, topaz: { poolFactory: string; wrapped: string }) {
  await assertChain(inp.chainId);
  const impl = await (await ethers.getContractFactory("LaunchCampaignGen7", deployer)).deploy();
  await impl.waitForDeployment();
  const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaignGen7", deployer)).deploy();
  await quoteImpl.waitForDeployment();
  if (!(await (quoteImpl as any).isBnbQuoteCampaignImplementation())) throw new Error("quote implementation does not self-identify");
  console.log(`[bnb-gen7] LaunchCampaignGen7 impl ${await impl.getAddress()}\n[bnb-gen7] BnbQuoteLaunchCampaignGen7 impl ${await quoteImpl.getAddress()}`);

  await assertChain(inp.chainId);
  const { factory, factoryAddress, lockerAddress } = await deployFactoryWithLocker({
    factoryName: "BnbBasicLaunchFactoryGen7",
    args: [inp.topazAdapter, fees.router, await impl.getAddress(), inp.graduationOracle, await quoteImpl.getAddress()],
    signer: deployer,
    lockerKind: "v2",
    log: (l) => console.log(`[bnb-gen7] ${l}`),
  });
  await readBack(() => factory.FACTORY_GENERATION(), 7n, "factory.FACTORY_GENERATION");
  await readBack(() => factory.CAMPAIGN_GENERATION(), 6n, "factory.CAMPAIGN_GENERATION");
  await readBack(() => factory.feeRecipient(), fees.router, "factory.feeRecipient");
  await readBack(() => factory.leagueReceiver(), fees.router, "factory.leagueReceiver");
  const cfg = await factory.config();
  if (cfg.curveBps !== 8500n || cfg.liquidityTokenBps !== 1300n || cfg.totalSupply !== ethers.parseEther("1000000000")) throw new Error(`factory config is not 85/13 of 1B: ${cfg}`);
  if ((await factory.protocolFeeBps()) !== PROTOCOL_FEE_BPS) throw new Error("factory protocol fee is not 200 bps");

  await assertChain(inp.chainId);
  const nativeAdapter = await (await ethers.getContractFactory("BnbNativeGraduationAdapter", deployer)).deploy(topaz.poolFactory, topaz.wrapped, lockerAddress);
  await nativeAdapter.waitForDeployment();
  const quoteAdapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter", deployer)).deploy(inp.admin, inp.topazRouter, lockerAddress, inp.nativeUsdFeed, MAX_QUOTE_ORACLE_AGE_SECONDS);
  await quoteAdapter.waitForDeployment();
  const N = await nativeAdapter.getAddress();
  const Q = await quoteAdapter.getAddress();
  console.log(`[bnb-gen7] BnbNativeGraduationAdapter ${N}\n[bnb-gen7] BnbQuoteGraduationAdapter ${Q} (admin ${inp.admin})`);
  await waitTx((nativeAdapter as any).setCampaignFactoryOnce(factoryAddress), "nativeAdapter.setCampaignFactoryOnce(factory)");
  const quoteAdminIsDeployer = same(await (quoteAdapter as any).admin(), deployerAddress);
  if (quoteAdminIsDeployer) await waitTx((quoteAdapter as any).setCampaignFactoryOnce(factoryAddress), "quoteAdapter.setCampaignFactoryOnce(factory)");
  await waitTx(factory.setBnbQuoteGraduationAdapter(Q), "factory.setBnbQuoteGraduationAdapter");
  for (const [label, a] of [["native", nativeAdapter], ["quote", quoteAdapter]] as const) {
    await readBack(() => (a as any).topazFactory(), topaz.poolFactory, `${label}Adapter.topazFactory`);
    await readBack(() => (a as any).WBNB(), topaz.wrapped, `${label}Adapter.WBNB`);
    await readBack(() => (a as any).permanentLpLocker(), lockerAddress, `${label}Adapter.permanentLpLocker`);
  }
  await readBack(() => (nativeAdapter as any).campaignFactory(), factoryAddress, "nativeAdapter.campaignFactory");

  await assertChain(inp.chainId);
  await waitTx(factory.setRegistries(inp.creatorRegistry, inp.riskRegistry), "factory.setRegistries");
  await waitTx(factory.setRouteAuthority(inp.routeAuthority), "factory.setRouteAuthority");
  const createPath = await wireGenerationCreatePath({ factoryAddress, nativeGraduationAdapter: N, creatorVault: fees.vault, senderAddress: deployerAddress, log: (l) => console.log(`[bnb-gen7]${l}`) });
  await waitTx(factory.setCreatePaused(true), "factory.setCreatePaused(true)");
  await readBack(() => factory.createPaused(), true, "factory.createPaused");
  await readBack(() => factory.live(), false, "factory.live");
  await readBack(() => factory.campaignsCount(), 0n, "factory.campaignsCount");
  return {
    contracts: {
      BnbBasicLaunchFactoryGen7: factoryAddress,
      PermanentLpLocker: lockerAddress,
      LaunchCampaignGen7Implementation: await impl.getAddress(),
      BnbQuoteLaunchCampaignGen7: await quoteImpl.getAddress(),
      BnbNativeGraduationAdapter: N,
      BnbQuoteGraduationAdapter: Q,
      LaunchTokenDeployer: createPath.tokenDeployer,
    },
    pendingOwnerActions: createPath.ownerActions,
  };
}

/**
 * Batch B (bind), from the record and the chain: only calls not yet done. Order matters for two pairs
 * (setAuthorizedLpLocker before setPrimaryLpLocker; vault setters before the first trade).
 */
export async function planBatchB(rec: any): Promise<PlannedCall[]> {
  const p = ethers.provider;
  const view = (to: string, sig: string, args: unknown[] = []) => new ethers.Contract(to, [`function ${sig}`], p)[sig.split("(")[0]](...args);
  const R = rec.fees.router, V = rec.fees.vault, D = rec.fees.holderDistributor, C = rec.fees.community;
  const F = rec.contracts.BnbBasicLaunchFactoryGen7, L = rec.contracts.PermanentLpLocker, Q = rec.contracts.BnbQuoteGraduationAdapter;
  const inp = rec.inputs;
  const zero = (a: string) => a === ethers.ZeroAddress;
  const calls: PlannedCall[] = [];
  if (zero(await view(R, "recruiterRewardsVault() view returns (address)"))) calls.push({ contract: "TreasuryRouterV4", to: R, fn: "setRecruiterRewardsVault", args: [inp.recruiter], note: "reused gen-6 recruiter vault" });
  if (zero(await view(R, "communityRewardsVault() view returns (address)"))) calls.push({ contract: "TreasuryRouterV4", to: R, fn: "setCommunityRewardsVault", args: [C], note: "gen-7's own community vault (serves one router)" });
  if (zero(await view(R, "protocolRevenueVault() view returns (address)"))) calls.push({ contract: "TreasuryRouterV4", to: R, fn: "setProtocolRevenueVault", args: [inp.protocol] });
  if (zero(await view(R, "creatorRewardsVault() view returns (address)"))) calls.push({ contract: "TreasuryRouterV4", to: R, fn: "setCreatorRewardsVault", args: [V], note: "set once for life (audit F1)" });
  if (!same(await view(D, "batchOperator() view returns (address)"), V)) calls.push({ contract: "RewardDistributor", to: D, fn: "setBatchOperator", args: [V] });
  if (zero(await view(V, "holderDistributor() view returns (address)"))) calls.push({ contract: "CreatorRewardsVaultV2", to: V, fn: "setHolderDistributorOnce", args: [D] });
  if (!same(await view(V, "operator() view returns (address)"), inp.operator)) calls.push({ contract: "CreatorRewardsVaultV2", to: V, fn: "setOperator", args: [inp.operator, false], note: "the live gen-6 vault's operator unless BNB_GEN7_VAULT_OPERATOR" });
  const lim = await view(V, "limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)");
  const caps = inp.caps;
  const want = [caps.maxBuyPerTx, caps.maxBuybackPerCampaignWeek, caps.minBuyInterval, caps.maxImpactBps, caps.maxHolderBatchPerWeek].map((x: any) => BigInt(x));
  if (want.some((w, i) => lim[i + 1] !== w)) calls.push({ contract: "CreatorRewardsVaultV2", to: V, fn: "setCaps", args: want.map(String), note: "E15 caps, = the live gen-6 vault's" });
  if (!(await view(R, "authorizedLpLocker(address) view returns (bool)", [L]))) {
    if (await view(R, "anyLpLockerAuthorized() view returns (bool)")) throw new Error(`router ${R} already has another locker; the gen-7 one would need propose -> ${UPGRADE_DELAY_SECONDS}s -> accept`);
    calls.push({ contract: "TreasuryRouterV4", to: R, fn: "setAuthorizedLpLocker", args: [L, true], note: "first locker on the gen-7 router: direct" });
  }
  if (!same(await view(R, "permanentLpLocker() view returns (address)"), L)) calls.push({ contract: "TreasuryRouterV4", to: R, fn: "setPrimaryLpLocker", args: [L], note: "needs the call before it" });
  const pinned = await view(V, "factory() view returns (address)");
  if (zero(pinned)) calls.push({ contract: "CreatorRewardsVaultV2", to: V, fn: "setFactoryOnce", args: [F] });
  else if (!same(pinned, F)) throw new Error(`gen-7 vault ${V} is pinned to ${pinned}, not ${F}`);
  if (!(await view(inp.creatorRegistry, "launchRecorder(address) view returns (bool)", [F]))) calls.push({ contract: "CreatorRegistry", to: inp.creatorRegistry, fn: "setLaunchRecorder", args: [F, true] });
  if (!(await view(Q, "campaignFactoryLocked() view returns (bool)"))) calls.push({ contract: "BnbQuoteGraduationAdapter", to: Q, fn: "setCampaignFactoryOnce", args: [F] });
  else if (!same(await view(Q, "campaignFactory() view returns (address)"), F)) throw new Error(`quote adapter ${Q} is bound to another factory`);
  // Every owner action the deploy recorded must be in B byte for byte (or already done).
  const encoded = await Promise.all(calls.map(async (c) => ({ to: c.to.toLowerCase(), data: (await encodePlannedCall(c)).toLowerCase() })));
  for (const a of rec.pendingOwnerActions || []) {
    const covered = encoded.some((e) => e.to === String(a.to).toLowerCase() && e.data === String(a.data).toLowerCase());
    if (covered) continue;
    const doneOnChain = await p.call({ from: rec.admin, to: a.to, data: a.data }).then(() => false, () => true);
    if (!doneOnChain) throw new Error(`owner action ${a.to} ${String(a.data).slice(0, 10)} (${a.why}) is not in batch B`);
  }
  return calls;
}

/** Batch H (open): gen-7 live + create open, and C11: the gen-6 factory stops creating (its coins keep trading). */
export async function planBatchH(rec: any): Promise<PlannedCall[]> {
  const F = rec.contracts.BnbBasicLaunchFactoryGen7;
  const f = await ethers.getContractAt("BnbBasicLaunchFactoryGen7", F);
  const f6 = new ethers.Contract(rec.gen6.factory, ["function createPaused() view returns (bool)"], ethers.provider);
  const calls: PlannedCall[] = [];
  if (!(await f.live())) calls.push({ contract: "BnbBasicLaunchFactoryGen7", to: F, fn: "enableLive", args: [] });
  if (await f.createPaused()) calls.push({ contract: "BnbBasicLaunchFactoryGen7", to: F, fn: "setCreatePaused", args: [false] });
  if (!(await f6.createPaused())) calls.push({ contract: "BnbBasicLaunchFactory", to: rec.gen6.factory, fn: "setCreatePaused", args: [true], note: "C11: gen-6 stops creating; its coins keep trading and graduating" });
  return calls;
}

/** eth_call each call from the admin; a call marked as needing its predecessor is checked only when that one is done. */
async function simulate(admin: string, calls: PlannedCall[]) {
  const independent = calls.filter((c) => !(c.fn === "setPrimaryLpLocker" && calls.some((x) => x.fn === "setAuthorizedLpLocker")));
  await simulateAsAdmin(admin, independent, (l) => console.log(`[bnb-gen7]${l}`));
  if (independent.length !== calls.length) console.log("[bnb-gen7]   (setPrimaryLpLocker not simulated alone: it needs setAuthorizedLpLocker from the same batch)");
}

/** Write B and H for the recorded deployment (deploys nothing). H is simulated only once the admin owns the factory. */
export async function writeGen7Batches(rec: any) {
  const b = await planBatchB(rec);
  console.log(`[bnb-gen7] batch B: ${b.length} call(s)`);
  if (b.length) {
    await simulate(rec.admin, b);
    writeSafeBatch(gen7Path(rec.batchFiles.B), rec.chainId, "MWZ gen7 B: bind", `gen-7 BNB: router ${rec.fees.router} vaults + creator vault + locker, holder distributor, operator, caps, vault factory pin, launch recorder, quote adapter -> factory ${rec.contracts.BnbBasicLaunchFactoryGen7}`, b);
  }
  const h = await planBatchH(rec);
  const factoryOwner = await (await ethers.getContractAt("BnbBasicLaunchFactoryGen7", rec.contracts.BnbBasicLaunchFactoryGen7)).owner();
  if (same(factoryOwner, rec.admin)) await simulate(rec.admin, h);
  else console.log(`[bnb-gen7] batch H not simulated: the gen-7 factory is still owned by ${factoryOwner} (transfer ownership to ${rec.admin} first)`);
  if (h.length) writeSafeBatch(gen7Path(rec.batchFiles.H), rec.chainId, "MWZ gen7 H: open", `gen-7 BNB factory ${rec.contracts.BnbBasicLaunchFactoryGen7}: enableLive + setCreatePaused(false); C11 gen-6 factory ${rec.gen6.factory} setCreatePaused(true)`, h);
  for (const [n, calls] of [["B", b], ["H", h]] as const) for (const c of calls) console.log(`    ${n} ${c.contract}.${c.fn}(${c.args.map(String).join(", ")}) -> ${c.to}${c.note ? `  # ${c.note}` : ""}`);
  return { b, h, bFile: b.length ? gen7Path(rec.batchFiles.B) : null, hFile: h.length ? gen7Path(rec.batchFiles.H) : null };
}

/** Testnet only (the deployer is the admin): send batch B's calls from the deployer, in order. */
async function sendAsDeployer(deployer: any, chainId: number, calls: PlannedCall[]) {
  for (const c of calls) {
    await assertChain(chainId);
    const data = await encodePlannedCall(c);
    await waitTx(deployer.sendTransaction({ to: c.to, data }), `${c.contract}.${c.fn}(${c.args.map(String).join(",")})`);
  }
}

export async function main() {
  const profile = await gen7ProfileName();
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer signer (DEPLOYER_PK) for this network");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const inp = await resolveInputs(profile, deployerAddress);
  await assertChain(inp.chainId);
  const recordFile = gen7Path(inp.record);

  if (["1", "true"].includes(String(process.env.EVMGEN7_BATCHES_ONLY || "").trim())) {
    return { record: readJson(recordFile), ...(await writeGen7Batches(readJson(recordFile))) };
  }

  if (String(process.env.CONFIRM_BNB_GEN7_GENERATION || "").trim() !== inp.confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_BNB_GEN7_GENERATION=${inp.confirm}.`);
  }
  if (inp.mainnet && !isGen7ForkNetwork() && (process.env.CI || !process.stdin.isTTY)) {
    throw new Error("Refusing a mainnet send from a non-interactive shell: this runs only from the founder's terminal.");
  }
  if (inp.mainnet && same(deployerAddress, inp.admin)) throw new Error("deployer resolved to the Safe; deploy from the EOA");
  if (!inp.mainnet && !same(deployerAddress, "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714")) {
    throw new Error(`testnet deployer ${deployerAddress} is not the gen-6 testnet admin 0x77F96A7d (the registry owner and the reused vault operator)`);
  }

  // Read-only guards first: nothing is deployed against a wrong Topaz, oracle, registry or router.
  for (const [label, a] of Object.entries({ topazAdapter: inp.topazAdapter, topazRouter: inp.topazRouter, graduationOracle: inp.graduationOracle, nativeUsdFeed: inp.nativeUsdFeed, creatorRegistry: inp.creatorRegistry, riskRegistry: inp.riskRegistry, weekly: inp.weekly, monthly: inp.monthly, recruiter: inp.recruiter, protocol: inp.protocol, gen6Factory: inp.gen6.factory })) await requireCode(label, a);
  const topaz = await assertTopazRoutersFit(inp.topazAdapter, inp.topazRouter);
  const oracle = new ethers.Contract(inp.graduationOracle, ["function nativeTargetForUsd(uint256) view returns (uint256)", "function maxPriceAge() view returns (uint256)"], ethers.provider);
  const mc50 = await oracle.nativeTargetForUsd(ethers.parseEther("50000"));
  console.log(`[bnb-gen7] oracle ${inp.graduationOracle}: $50K = ${ethers.formatEther(mc50)} BNB (maxPriceAge ${await oracle.maxPriceAge()})`);
  const registryOwner = await new ethers.Contract(inp.creatorRegistry, ["function owner() view returns (address)"], ethers.provider).owner();
  if (!same(registryOwner, inp.admin)) throw new Error(`CreatorRegistry ${inp.creatorRegistry} is owned by ${registryOwner}, not ${inp.admin}`);
  if (inp.caps.maxImpactBps > 50n) throw new Error("vault refuses an impact cap above 50 bps");

  const rec: any = fs.existsSync(recordFile) ? readJson(recordFile) : {
    kind: "bnb-gen7", network: network.name, profile, chainId: inp.chainId, deployer: deployerAddress, admin: inp.admin,
    startedAt: new Date().toISOString(), balanceBefore: (await ethers.provider.getBalance(deployerAddress)).toString(),
    gen6: inp.gen6,
    inputs: { topazAdapter: inp.topazAdapter, topazRouter: inp.topazRouter, topazPoolFactory: topaz.poolFactory, wbnb: topaz.wrapped, graduationOracle: inp.graduationOracle, nativeUsdFeed: inp.nativeUsdFeed, creatorRegistry: inp.creatorRegistry, riskRegistry: inp.riskRegistry, routeAuthority: inp.routeAuthority, weekly: inp.weekly, monthly: inp.monthly, recruiter: inp.recruiter, protocol: inp.protocol, operator: inp.operator, caps: inp.caps },
    batchFiles: { B: inp.batchB, H: inp.batchH },
  };
  if (rec.contracts?.BnbBasicLaunchFactoryGen7) throw new Error(`${recordFile} already records a gen-7 generation; use EVMGEN7_BATCHES_ONLY=1`);

  if (!rec.fees?.router) {
    rec.fees = await deployGen7Fees(deployer, inp, topaz.wrapped, topaz.poolFactory);
    writeRecord(recordFile, rec); // resumable: a re-run skips the fees stage
  } else {
    console.log(`[bnb-gen7] fees stage already recorded: router ${rec.fees.router}`);
  }

  const gen = await deployGen7Generation(deployer, deployerAddress, inp, rec.fees, topaz);
  Object.assign(rec, gen, { factoryStartBlock: await ethers.provider.getBlockNumber(), status: "deployed-create-paused" });
  writeRecord(recordFile, rec);

  if (!inp.mainnet) {
    // Testnet: the deployer is the admin, so batch B is sent now (simulated first).
    const b = await planBatchB(rec);
    await simulate(deployerAddress, b);
    await sendAsDeployer(deployer, inp.chainId, b);
    rec.batchBSent = b.map((c) => `${c.contract}.${c.fn}(${c.args.map(String).join(",")})`);
    if ((await planBatchB(rec)).length) throw new Error("batch B still has calls after sending it");
    await assertCreatorVaultServesGeneration(rec.fees.router, { dexKind: VAULT_DEX_TOPAZ_V2, expectedFactory: rec.contracts.BnbBasicLaunchFactoryGen7 });
    rec.status = "deployed-bound-create-paused (enableLive by the lifecycle run, GEN7_ENABLE_LIVE=true)";
  }
  const out = await writeGen7Batches(rec);
  rec.balanceAfter = (await ethers.provider.getBalance(deployerAddress)).toString();
  rec.spent = ethers.formatEther(BigInt(rec.balanceBefore) - BigInt(rec.balanceAfter));
  rec.finishedAt = new Date().toISOString();
  writeRecord(recordFile, rec);
  console.log(`[bnb-gen7] wrote ${recordFile}; deployer spent ${rec.spent} BNB`);
  console.log(inp.mainnet
    ? "[bnb-gen7] STOP. The gen-7 factory is create-paused and not live. Next: Safe batch B, ownership to the Safe, Safe batch H."
    : "[bnb-gen7] STOP. Bound, create-paused, not live. Next: scripts/test-bnb-testnet-gen7-lifecycle.ts with GEN7_ENABLE_LIVE=true.");
  return { record: rec, ...out };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
