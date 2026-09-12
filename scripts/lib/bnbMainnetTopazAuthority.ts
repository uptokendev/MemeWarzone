import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

export const BNB_MAINNET_CHAIN_ID = 56;
export const REQUIRED_VOLATILE_FEE_BPS = 30n;
export const REQUIRED_FACTORY_GENERATION = 4n;
export const REQUIRED_CAMPAIGN_GENERATION = 3n;
export const TEST_GRADUATION_TARGET = ethers.parseEther("6");
export const PRODUCTION_SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";

export type RuntimeIdentity = {
  address: string;
  codeHash: string;
  codeBytes: number;
};

export type Bnb56TopazEvidence = {
  chainId: number;
  blockNumber: number;
  activeFactory: string;
  activeFactoryOwner: string;
  activeFactoryRouteAuthority: string;
  activeFactoryImplementation: string;
  activeFactoryOracle: string;
  activeFactoryTreasury: string;
  activeFactoryCreatorRegistry: string;
  activeFactoryRiskRegistry: string;
  activeFactoryRouterAdapter: string;
  treasuryAdmin: string;
  router: RuntimeIdentity;
  poolFactory: RuntimeIdentity;
  factoryRegistry: RuntimeIdentity;
  wbnb: RuntimeIdentity;
  poolImplementation: RuntimeIdentity;
  volatileFeeBps: string;
};

function sameAddress(a: string, b: string): boolean {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function requireAddress(address: string, label: string): string {
  if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error(`${label} is zero/invalid: ${address}`);
  return ethers.getAddress(address);
}

function manifestPath(): string {
  return path.resolve(process.env.BNB56_CURRENT_PRODUCTION_MANIFEST || "deployments/bscMainnet.factory-30bps-80-20.json");
}

function loadActiveFactory(): string {
  const file = manifestPath();
  if (!fs.existsSync(file)) throw new Error(`current production manifest missing: ${file}`);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Number(manifest?.chainId) !== BNB_MAINNET_CHAIN_ID) throw new Error(`current production manifest must target chain 56, got ${manifest?.chainId}`);
  const configured = String(process.env.BNB56_ACTIVE_FACTORY || manifest?.activeFactory || "").trim();
  return requireAddress(configured, "active chain-56 factory");
}

async function identity(address: string, label: string): Promise<RuntimeIdentity> {
  const normalized = requireAddress(address, label);
  const code = await ethers.provider.getCode(normalized);
  if (!code || code === "0x") throw new Error(`${label} has no runtime bytecode at ${normalized}`);
  return {
    address: normalized,
    codeHash: ethers.keccak256(code),
    codeBytes: (code.length - 2) / 2,
  };
}

export async function resolveBnb56TopazAuthority(): Promise<Bnb56TopazEvidence> {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== BNB_MAINNET_CHAIN_ID) throw new Error(`BNB56 resolver refuses chain ${chainId}`);

  const activeFactory = loadActiveFactory();
  await identity(activeFactory, "current production LaunchFactory");

  const factory = await ethers.getContractAt([
    "function owner() view returns (address)",
    "function routeAuthority() view returns (address)",
    "function campaignImplementation() view returns (address)",
    "function graduationOracle() view returns (address)",
    "function feeRecipient() view returns (address)",
    "function creatorRegistry() view returns (address)",
    "function riskRegistry() view returns (address)",
    "function router() view returns (address)",
  ], activeFactory);

  const [owner, routeAuthority, implementation, oracle, treasury, creatorRegistry, riskRegistry, routerAdapter] = await Promise.all([
    factory.owner(),
    factory.routeAuthority(),
    factory.campaignImplementation(),
    factory.graduationOracle(),
    factory.feeRecipient(),
    factory.creatorRegistry(),
    factory.riskRegistry(),
    factory.router(),
  ]);

  if (!sameAddress(owner, PRODUCTION_SAFE)) throw new Error(`current production owner mismatch: expected ${PRODUCTION_SAFE}, got ${owner}`);
  const normalizedRouteAuthority = requireAddress(routeAuthority, "current production routeAuthority");
  for (const [label, address] of [
    ["campaignImplementation", implementation],
    ["graduationOracle", oracle],
    ["treasury", treasury],
    ["creatorRegistry", creatorRegistry],
    ["riskRegistry", riskRegistry],
    ["routerAdapter", routerAdapter],
  ] as const) await identity(address, `current production ${label}`);

  const treasuryProbe = await ethers.getContractAt(["function admin() view returns (address)"], treasury);
  const treasuryAdmin = await treasuryProbe.admin();
  if (!sameAddress(treasuryAdmin, owner)) throw new Error(`Treasury admin ${treasuryAdmin} does not match production owner ${owner}`);

  const adapter = await ethers.getContractAt([
    "function topazRouter() view returns (address)",
    "function poolFactory() view returns (address)",
    "function WETH() view returns (address)",
  ], routerAdapter);
  const [routerAddress, adapterFactory, adapterWbnb] = await Promise.all([
    adapter.topazRouter(),
    adapter.poolFactory(),
    adapter.WETH(),
  ]);

  const routerProbe = await ethers.getContractAt([
    "function defaultFactory() view returns (address)",
    "function factoryRegistry() view returns (address)",
    "function weth() view returns (address)",
  ], routerAddress);
  const [routerFactory, factoryRegistryAddress, routerWbnb] = await Promise.all([
    routerProbe.defaultFactory(),
    routerProbe.factoryRegistry(),
    routerProbe.weth(),
  ]);

  if (!sameAddress(routerFactory, adapterFactory)) throw new Error(`Topaz Router.defaultFactory ${routerFactory} != adapter.poolFactory ${adapterFactory}`);
  if (!sameAddress(routerWbnb, adapterWbnb)) throw new Error(`Topaz Router.weth ${routerWbnb} != adapter.WETH ${adapterWbnb}`);

  const poolFactoryProbe = await ethers.getContractAt([
    "function implementation() view returns (address)",
    "function getFee(address,bool) view returns (uint256)",
  ], routerFactory);
  const [poolImplementationAddress, volatileFeeBps] = await Promise.all([
    poolFactoryProbe.implementation(),
    poolFactoryProbe.getFee(ethers.ZeroAddress, false),
  ]);
  if (BigInt(volatileFeeBps) !== REQUIRED_VOLATILE_FEE_BPS) {
    throw new Error(`Topaz volatile pool fee must be 30 bps, got ${volatileFeeBps}`);
  }

  const [router, poolFactory, factoryRegistry, wbnb, poolImplementation] = await Promise.all([
    identity(routerAddress, "Topaz Router"),
    identity(routerFactory, "Topaz PoolFactory"),
    identity(factoryRegistryAddress, "Topaz FactoryRegistry"),
    identity(routerWbnb, "WBNB"),
    identity(poolImplementationAddress, "Topaz PoolImplementation"),
  ]);

  return {
    chainId,
    blockNumber: await ethers.provider.getBlockNumber(),
    activeFactory,
    activeFactoryOwner: ethers.getAddress(owner),
    activeFactoryRouteAuthority: normalizedRouteAuthority,
    activeFactoryImplementation: ethers.getAddress(implementation),
    activeFactoryOracle: ethers.getAddress(oracle),
    activeFactoryTreasury: ethers.getAddress(treasury),
    activeFactoryCreatorRegistry: ethers.getAddress(creatorRegistry),
    activeFactoryRiskRegistry: ethers.getAddress(riskRegistry),
    activeFactoryRouterAdapter: ethers.getAddress(routerAdapter),
    treasuryAdmin: ethers.getAddress(treasuryAdmin),
    router,
    poolFactory,
    factoryRegistry,
    wbnb,
    poolImplementation,
    volatileFeeBps: BigInt(volatileFeeBps).toString(),
  };
}

export function assertProductionGraduationTarget(target: bigint): void {
  if (target === TEST_GRADUATION_TARGET) throw new Error("$6 graduation is forbidden on chain 56");
  const allowed = new Set([ethers.parseEther("15000"), ethers.parseEther("30000"), ethers.parseEther("50000")].map(String));
  if (!allowed.has(target.toString())) throw new Error(`unsupported production graduation target ${target}`);
}
