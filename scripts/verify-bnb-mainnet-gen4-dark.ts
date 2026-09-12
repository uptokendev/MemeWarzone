import { ethers, network } from "hardhat";
import {
  PRODUCTION_SAFE,
  REQUIRED_CAMPAIGN_GENERATION,
  REQUIRED_FACTORY_GENERATION,
  REQUIRED_VOLATILE_FEE_BPS,
  resolveBnb56TopazAuthority,
} from "./lib/bnbMainnetTopazAuthority";

function requireAddress(name: string): string {
  const raw = String(process.env[name] || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address`);
  return ethers.getAddress(raw);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  console.log(`PASS ${label}=${actual}`);
}

async function main() {
  if (network.name !== "bscMainnet") throw new Error(`BNB56 verifier is bscMainnet-only, got ${network.name}`);
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 56) throw new Error(`BNB56 verifier refuses chain ${net.chainId}`);

  const candidate = requireAddress("BNB56_GEN4_FACTORY");
  const authority = await resolveBnb56TopazAuthority();
  if (candidate.toLowerCase() === authority.activeFactory.toLowerCase()) throw new Error("candidate Gen-4 factory must not be the historical current production factory");
  if (authority.volatileFeeBps !== REQUIRED_VOLATILE_FEE_BPS.toString()) throw new Error("live Topaz fee is not 30 bps");
  eq("current production owner", authority.activeFactoryOwner, PRODUCTION_SAFE);
  eq("Treasury admin", authority.treasuryAdmin, authority.activeFactoryOwner);

  const factory = await ethers.getContractAt([
    "function FACTORY_GENERATION() view returns (uint32)",
    "function CAMPAIGN_GENERATION() view returns (uint32)",
    "function liquidityKind() view returns (uint8)",
    "function owner() view returns (address)",
    "function live() view returns (bool)",
    "function globalPaused() view returns (bool)",
    "function createPaused() view returns (bool)",
    "function securityDefaultsLocked() view returns (bool)",
    "function requireRouteAuthorization() view returns (bool)",
    "function requireAuthorizedTrading() view returns (bool)",
    "function routeAuthority() view returns (address)",
    "function campaignImplementation() view returns (address)",
    "function permanentLpLocker() view returns (address)",
    "function router() view returns (address)",
    "function graduationOracle() view returns (address)",
    "function feeRecipient() view returns (address)",
    "function creatorRegistry() view returns (address)",
    "function riskRegistry() view returns (address)",
    "function campaignsCount() view returns (uint256)",
    "function config() view returns (uint256 totalSupply, uint256 curveBps, uint256 liquidityTokenBps, uint256 basePrice, uint256 priceSlope, uint256 graduationTarget, uint256 liquidityBps)",
    "function isGraduationTargetAllowedForChain(uint256 chainId, uint256 target) view returns (bool)",
  ], candidate);
  if ((await ethers.provider.getCode(candidate)) === "0x") throw new Error("candidate Gen-4 factory has no code");

  eq("FACTORY_GENERATION", await factory.FACTORY_GENERATION(), REQUIRED_FACTORY_GENERATION);
  eq("CAMPAIGN_GENERATION", await factory.CAMPAIGN_GENERATION(), REQUIRED_CAMPAIGN_GENERATION);
  eq("liquidityKind", await factory.liquidityKind(), 1n);
  eq("owner", await factory.owner(), authority.activeFactoryOwner);
  eq("live", await factory.live(), false);
  eq("createPaused", await factory.createPaused(), true);
  eq("securityDefaultsLocked", await factory.securityDefaultsLocked(), true);
  eq("requireRouteAuthorization", await factory.requireRouteAuthorization(), true);
  eq("requireAuthorizedTrading", await factory.requireAuthorizedTrading(), true);
  eq("routeAuthority", await factory.routeAuthority(), authority.activeFactoryRouteAuthority);
  eq("graduationOracle", await factory.graduationOracle(), authority.activeFactoryOracle);
  eq("feeRecipient", await factory.feeRecipient(), authority.activeFactoryTreasury);
  eq("creatorRegistry", await factory.creatorRegistry(), authority.activeFactoryCreatorRegistry);
  eq("riskRegistry", await factory.riskRegistry(), authority.activeFactoryRiskRegistry);
  eq("campaignsCount", await factory.campaignsCount(), 0n);
  eq("$6 forbidden", await factory.isGraduationTargetAllowedForChain(56, ethers.parseEther("6")), false);

  const cfg = await factory.config();
  if (![ethers.parseEther("15000"), ethers.parseEther("30000"), ethers.parseEther("50000")].map(String).includes(cfg.graduationTarget.toString())) {
    throw new Error(`candidate production graduation target is not an allowed production tier: ${cfg.graduationTarget}`);
  }

  const implementation = ethers.getAddress(await factory.campaignImplementation());
  if ((await ethers.provider.getCode(implementation)) === "0x") throw new Error(`candidate Campaign-3 implementation has no code at ${implementation}`);

  const adapterAddress = ethers.getAddress(await factory.router());
  const adapter = await ethers.getContractAt([
    "function topazRouter() view returns (address)",
    "function poolFactory() view returns (address)",
    "function WETH() view returns (address)",
  ], adapterAddress);
  eq("adapter.topazRouter", await adapter.topazRouter(), authority.router.address);
  eq("adapter.poolFactory", await adapter.poolFactory(), authority.poolFactory.address);
  eq("adapter.WETH", await adapter.WETH(), authority.wbnb.address);

  const lockerAddress = ethers.getAddress(await factory.permanentLpLocker());
  const locker = await ethers.getContractAt([
    "function REQUIRED_POOL_FEE_BPS() view returns (uint16)",
    "function CREATOR_FEE_BPS() view returns (uint16)",
    "function PROTOCOL_FEE_BPS() view returns (uint16)",
    "function admin() view returns (address)",
    "function topazFactory() view returns (address)",
  ], lockerAddress);
  eq("locker.REQUIRED_POOL_FEE_BPS", await locker.REQUIRED_POOL_FEE_BPS(), 30n);
  eq("locker.CREATOR_FEE_BPS", await locker.CREATOR_FEE_BPS(), 8000n);
  eq("locker.PROTOCOL_FEE_BPS", await locker.PROTOCOL_FEE_BPS(), 2000n);
  eq("locker.admin", await locker.admin(), candidate);
  eq("locker.topazFactory", await locker.topazFactory(), authority.poolFactory.address);

  const treasury = await ethers.getContractAt([
    "function admin() view returns (address)",
    "function authorizedLpLocker(address locker) view returns (bool)",
    "function permanentLpLocker() view returns (address)",
  ], authority.activeFactoryTreasury);
  eq("Treasury admin recheck", await treasury.admin(), authority.activeFactoryOwner);
  const authorized = await treasury.authorizedLpLocker(lockerAddress);
  const primaryLocker = ethers.getAddress(await treasury.permanentLpLocker());

  console.log(`PASS candidateFactory=${candidate}`);
  console.log(`PASS candidateImplementation=${implementation}`);
  console.log(`PASS candidateLocker=${lockerAddress}`);
  console.log(`INFO treasuryLockerAuthorized=${authorized}`);
  console.log(`INFO treasuryPrimaryLocker=${primaryLocker}`);
  console.log(`PASS currentHistoricalFactoryUntouched=${authority.activeFactory}`);
  console.log("PASS dark gate: live=false, createPaused=true; no frontend/indexer promotion implied");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
