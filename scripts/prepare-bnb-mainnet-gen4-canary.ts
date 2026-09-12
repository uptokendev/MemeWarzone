import { ethers, network } from "hardhat";
import { resolveBnb56TopazAuthority } from "./lib/bnbMainnetTopazAuthority";

function requireAddress(name: string): string {
  const raw = String(process.env[name] || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address`);
  return ethers.getAddress(raw);
}

async function main() {
  if (network.name !== "bscMainnet") throw new Error(`BNB56 canary preparation requires bscMainnet, got ${network.name}`);
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 56) throw new Error(`BNB56 canary preparation refuses chain ${net.chainId}`);

  const candidate = requireAddress("BNB56_GEN4_FACTORY");
  const authority = await resolveBnb56TopazAuthority();
  if (candidate.toLowerCase() === authority.activeFactory.toLowerCase()) throw new Error("controlled canary must target the fresh Gen-4 factory, not historical production");

  const factory = await ethers.getContractAt([
    "function FACTORY_GENERATION() view returns (uint32)",
    "function CAMPAIGN_GENERATION() view returns (uint32)",
    "function live() view returns (bool)",
    "function createPaused() view returns (bool)",
    "function securityDefaultsLocked() view returns (bool)",
    "function permanentLpLocker() view returns (address)",
    "function graduationOracle() view returns (address)",
    "function config() view returns (uint256 totalSupply, uint256 curveBps, uint256 liquidityTokenBps, uint256 basePrice, uint256 priceSlope, uint256 graduationTarget, uint256 liquidityBps)",
  ], candidate);

  if (BigInt(await factory.FACTORY_GENERATION()) !== 4n || BigInt(await factory.CAMPAIGN_GENERATION()) !== 3n) throw new Error("candidate is not Factory-4/Campaign-3");
  if (await factory.live()) throw new Error("candidate must remain dark while preparing canary");
  if (!(await factory.createPaused())) throw new Error("candidate CREATE must remain paused while preparing canary");
  if (!(await factory.securityDefaultsLocked())) throw new Error("candidate security defaults are not locked");

  const locker = ethers.getAddress(await factory.permanentLpLocker());
  const treasury = await ethers.getContractAt([
    "function authorizedLpLocker(address locker) view returns (bool)",
    "function permanentLpLocker() view returns (address)",
  ], authority.activeFactoryTreasury);
  const lockerAuthorized = await treasury.authorizedLpLocker(locker);
  const primaryLocker = ethers.getAddress(await treasury.permanentLpLocker());

  const config = await factory.config();
  if (config.graduationTarget === ethers.parseEther("6")) throw new Error("$6 graduation is forbidden on BNB mainnet");
  const oracleAddress = ethers.getAddress(await factory.graduationOracle());
  if (oracleAddress.toLowerCase() !== authority.activeFactoryOracle.toLowerCase()) throw new Error("candidate is not using the live production oracle");
  const oracle = await ethers.getContractAt([
    "function nativeUsdPrice() view returns (uint256)",
    "function nativeTargetForUsd(uint256 usdAmount) view returns (uint256)",
  ], oracleAddress);
  const nativeUsdPrice = BigInt(await oracle.nativeUsdPrice());
  const nativeGraduationTarget = BigInt(await oracle.nativeTargetForUsd(config.graduationTarget));

  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.gasPrice ?? ethers.parseUnits("1", "gwei");
  const canaryGasBudget = BigInt(String(process.env.BNB56_CANARY_GAS_BUDGET || "8000000"));
  const gasFloor = canaryGasBudget * gasPrice;
  const tradeReserve = nativeGraduationTarget * 12n / 10n;
  const minimumCanaryFunding = gasFloor + tradeReserve;
  const recommendedCanaryFunding = minimumCanaryFunding * 3n / 2n;

  const blockers: string[] = [];
  if (!lockerAuthorized) blockers.push("fresh permanent locker is not yet authorized by TreasuryRouterV2");

  const plan = {
    evidenceType: "bnb56-gen4-controlled-canary-preparation",
    generatedAt: new Date().toISOString(),
    chainId: 56,
    candidateFactory: candidate,
    candidateLocker: locker,
    currentHistoricalFactory: authority.activeFactory,
    topaz: {
      router: authority.router,
      poolFactory: authority.poolFactory,
      factoryRegistry: authority.factoryRegistry,
      wbnb: authority.wbnb,
      poolImplementation: authority.poolImplementation,
      volatileFeeBps: authority.volatileFeeBps,
    },
    productionAuthority: {
      owner: authority.activeFactoryOwner,
      routeAuthority: authority.activeFactoryRouteAuthority,
      treasury: authority.activeFactoryTreasury,
      treasuryAdmin: authority.treasuryAdmin,
      oracle: oracleAddress,
    },
    funding: {
      gasPriceWei: gasPrice.toString(),
      canaryGasBudget: canaryGasBudget.toString(),
      gasFloorWei: gasFloor.toString(),
      graduationUsdWad: config.graduationTarget.toString(),
      nativeUsdPriceWad: nativeUsdPrice.toString(),
      nativeGraduationTargetWei: nativeGraduationTarget.toString(),
      tradeReserveWei: tradeReserve.toString(),
      minimumCanaryFundingWei: minimumCanaryFunding.toString(),
      recommendedCanaryFundingWei: recommendedCanaryFunding.toString(),
      methodology: "gas budget at current gas price + 120% of live-oracle native graduation target; recommended = 150% of that floor",
    },
    treasuryLocker: {
      authorized: lockerAuthorized,
      currentPrimary: primaryLocker,
      note: "Authorization is required before canary revenue routing. Primary-locker cutover remains post-canary and is not required for preparation.",
    },
    exactSequence: [
      "CREATE",
      "BUY",
      "SELL",
      "native graduation",
      "resolve and prove real Topaz MEME/WBNB volatile pool",
      "prove permanent LP lock",
      "post-grad BUY",
      "post-grad SELL",
      "accrue and harvest LP fees",
      "prove 80/20 creator/protocol split",
      "prove protocol share reaches Treasury",
    ],
    productionSafety: [
      "no stress/fault testing",
      "one controlled canary only",
      "no frontend/indexer promotion before canary gate",
      "stop on any identity/economics/runtime deviation",
    ],
    blockers,
    readyForCanaryAuthorization: blockers.length === 0,
  };

  console.log(JSON.stringify(plan, null, 2));
  console.log("[bnb56-canary] READ-ONLY PREPARATION ONLY. This tool never broadcasts a transaction.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
