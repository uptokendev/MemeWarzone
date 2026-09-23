/**
 * Deploy what deploy-robinhood-quote-generation.ts takes as inputs.
 *
 * Robinhood mainnet has nothing of ours on it. The generation script accepts
 * the oracle, the league vaults and the V3 graduation adapter as addresses and
 * refuses to invent them, so this is the step before it, and before
 * deploy-evm-treasury-router-v3.ts, which needs the weekly and monthly vaults.
 *
 * Order, and why:
 *   1. GraduationOracle            the monthly treasury's cap oracle needs it
 *   2. TreasuryVaultV2 (weekly)    a router constructor input
 *   3. CharityTreasury             the monthly treasury's overflow target
 *   4. MonthlyLeagueTreasury       a router constructor input
 *   5. RecruiterRewardsVault       router setter targets (Safe transactions)
 *   6. ProtocolRevenueVault
 *   7. RobinhoodUniswapV3GraduationAdapter   LaunchFactory's "router"
 *
 * Every admin/multisig slot is the Safe. Operators and root posters are left
 * unset, exactly as BNB mainnet runs today, for the Safe to fill in later.
 *
 * Two things are checked before anything immutable is written: the price feed
 * is within the max age about to be burned into the oracle (Chainlink's ETH /
 * USD on Robinhood has an 86,400 s heartbeat and was two hours old when
 * looked at), and the Uniswap pieces point at each other.
 *
 *   CONFIRM_ROBINHOOD_PREREQS=I_UNDERSTAND_MAINNET \
 *     npx hardhat run scripts/deploy-robinhood-prerequisites.ts --network robinhoodMainnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

import { assertFeedWithinMaxAge, maxOracleAgeFor } from "./deploy-robinhood-quote-generation";

type Profile = {
  chainId: bigint;
  confirm: string;
  safe: string;
  nativeUsdFeed: string;
  v3Factory: string;
  positionManager: string;
  weth: string;
  file: string;
};

const PROFILES: Record<string, Profile> = {
  robinhoodMainnet: {
    chainId: 4663n,
    confirm: "I_UNDERSTAND_MAINNET",
    safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7",
    // Chainlink ETH / USD proxy, 8 decimals, heartbeat 86,400 s. Verified on
    // chain against Chainlink's reference directory (aggregator 0x6091E64e…).
    nativeUsdFeed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
    // developers.uniswap.org, Robinhood Chain deployments; verified on chain:
    // position manager and router both report this factory, and both report
    // this WETH9. Fee tier 3000 has tick spacing 60.
    v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    file: "robinhood/mainnet.prerequisites.json",
  },
  robinhoodTestnet: {
    chainId: 46630n,
    confirm: "I_UNDERSTAND_TESTNET",
    safe: "",
    nativeUsdFeed: "",
    v3Factory: "",
    positionManager: "",
    weth: "",
    file: "robinhood/testnet.prerequisites.json",
  },
};

export const MEME_POOL_FEE_TIER = 3000;
/** BNB mainnet's MonthlyLeagueTreasury reports 30000; Robinhood mirrors it. */
export const DEFAULT_MONTHLY_CAP_USD = 30_000n;

function pick(envName: string, fallback: string): string {
  const raw = String(process.env[envName] || "").trim() || fallback;
  if (!raw) throw new Error(`${envName} is required on this network`);
  return ethers.getAddress(raw);
}

async function requireCode(label: string, address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

export type PrerequisiteInputs = {
  chainId: bigint;
  safe: string;
  nativeUsdFeed: string;
  v3Factory: string;
  positionManager: string;
  weth: string;
  maxOracleAgeSeconds: number;
  monthlyCapUsd: bigint;
  log?: (message: string) => void;
};

/** Refuse Uniswap pieces that do not belong to one deployment. */
export async function assertV3PiecesAgree(v3Factory: string, positionManager: string, weth: string) {
  const npm = await ethers.getContractAt(["function factory() view returns (address)", "function WETH9() view returns (address)"], positionManager);
  const factory = await ethers.getContractAt(["function feeAmountTickSpacing(uint24) view returns (int24)"], v3Factory);
  const reportedFactory = ethers.getAddress(await (npm as any).factory());
  if (reportedFactory.toLowerCase() !== v3Factory.toLowerCase()) {
    throw new Error(`position manager ${positionManager} reports factory ${reportedFactory}, not ${v3Factory}`);
  }
  const reportedWeth = ethers.getAddress(await (npm as any).WETH9());
  if (reportedWeth.toLowerCase() !== weth.toLowerCase()) {
    throw new Error(`position manager ${positionManager} reports WETH9 ${reportedWeth}, not ${weth}`);
  }
  const spacing = await (factory as any).feeAmountTickSpacing(MEME_POOL_FEE_TIER);
  if (spacing === 0n) throw new Error(`fee tier ${MEME_POOL_FEE_TIER} is not enabled on factory ${v3Factory}`);
}

export async function deployPrerequisites(inputs: PrerequisiteInputs) {
  const log = inputs.log ?? ((m: string) => console.log(m));
  for (const [label, address] of [["nativeUsdFeed", inputs.nativeUsdFeed], ["v3Factory", inputs.v3Factory], ["positionManager", inputs.positionManager], ["weth", inputs.weth]] as const) {
    await requireCode(label, address);
  }
  await assertV3PiecesAgree(inputs.v3Factory, inputs.positionManager, inputs.weth);
  await assertFeedWithinMaxAge(inputs.nativeUsdFeed, inputs.maxOracleAgeSeconds, "graduation oracle max age");

  const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(inputs.nativeUsdFeed, inputs.maxOracleAgeSeconds);
  await oracle.waitForDeployment();
  const oracleAddress = ethers.getAddress(await oracle.getAddress());
  log(`  GraduationOracle                      ${oracleAddress}  (maxPriceAge ${inputs.maxOracleAgeSeconds}s)`);

  const weekly = await (await ethers.getContractFactory("TreasuryVaultV2")).deploy(inputs.safe, ethers.ZeroAddress, inputs.safe);
  await weekly.waitForDeployment();
  const weeklyAddress = ethers.getAddress(await weekly.getAddress());
  log(`  TreasuryVaultV2 (weekly league)       ${weeklyAddress}`);

  const charity = await (await ethers.getContractFactory("CharityTreasury")).deploy(inputs.safe);
  await charity.waitForDeployment();
  const charityAddress = ethers.getAddress(await charity.getAddress());
  log(`  CharityTreasury                       ${charityAddress}`);

  const monthly = await (await ethers.getContractFactory("MonthlyLeagueTreasury")).deploy(inputs.safe, ethers.ZeroAddress, oracleAddress, charityAddress, inputs.monthlyCapUsd);
  await monthly.waitForDeployment();
  const monthlyAddress = ethers.getAddress(await monthly.getAddress());
  log(`  MonthlyLeagueTreasury                 ${monthlyAddress}  (cap ${inputs.monthlyCapUsd} USD)`);

  const recruiter = await (await ethers.getContractFactory("RecruiterRewardsVault")).deploy(inputs.safe);
  await recruiter.waitForDeployment();
  const recruiterAddress = ethers.getAddress(await recruiter.getAddress());
  log(`  RecruiterRewardsVault                 ${recruiterAddress}`);

  const protocol = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(inputs.safe);
  await protocol.waitForDeployment();
  const protocolAddress = ethers.getAddress(await protocol.getAddress());
  log(`  ProtocolRevenueVault                  ${protocolAddress}`);

  const adapter = await (await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter")).deploy(inputs.v3Factory, inputs.positionManager, inputs.weth, MEME_POOL_FEE_TIER);
  await adapter.waitForDeployment();
  const adapterAddress = ethers.getAddress(await adapter.getAddress());
  log(`  RobinhoodUniswapV3GraduationAdapter   ${adapterAddress}`);

  // Read back what the next scripts will rely on.
  const kind = await (await ethers.getContractAt(["function liquidityKind() view returns (uint256)"], adapterAddress) as any).liquidityKind();
  if (kind !== 2n) throw new Error(`adapter reports liquidityKind ${kind}; LaunchFactory needs 2 (V3 NFT)`);
  const m = await ethers.getContractAt(["function oracle() view returns (address)", "function charityTreasury() view returns (address)", "function multisig() view returns (address)"], monthlyAddress);
  if ((await (m as any).oracle()).toLowerCase() !== oracleAddress.toLowerCase()) throw new Error("monthly treasury is not bound to the oracle just deployed");
  if ((await (m as any).charityTreasury()).toLowerCase() !== charityAddress.toLowerCase()) throw new Error("monthly treasury is not bound to the charity just deployed");
  if ((await (m as any).multisig()).toLowerCase() !== inputs.safe.toLowerCase()) throw new Error("monthly treasury multisig is not the Safe");

  return {
    GraduationOracle: oracleAddress,
    WeeklyLeagueVault: weeklyAddress,
    CharityTreasury: charityAddress,
    MonthlyLeagueTreasury: monthlyAddress,
    RecruiterRewardsVault: recruiterAddress,
    ProtocolRevenueVault: protocolAddress,
    RobinhoodUniswapV3GraduationAdapter: adapterAddress,
  };
}

async function main() {
  const profile = PROFILES[network.name];
  if (!profile) throw new Error(`Unsupported network ${network.name}; expected robinhoodTestnet or robinhoodMainnet`);
  if (String(process.env.CONFIRM_ROBINHOOD_PREREQS || "").trim() !== profile.confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_ROBINHOOD_PREREQS=${profile.confirm}.`);
  }
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== profile.chainId) throw new Error(`${network.name} expects chain ${profile.chainId}; got ${net.chainId}`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer for this network.");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const isMainnet = profile.confirm === "I_UNDERSTAND_MAINNET";
  const safe = pick("RH_OWNER_SAFE", profile.safe || (isMainnet ? "" : deployerAddress));
  if (isMainnet && safe.toLowerCase() === deployerAddress.toLowerCase()) throw new Error("the Safe resolved to the deployer; refuse on mainnet");

  const inputs: PrerequisiteInputs = {
    chainId: net.chainId,
    safe,
    nativeUsdFeed: pick("RH_NATIVE_USD_FEED", profile.nativeUsdFeed),
    v3Factory: pick("RH_V3_FACTORY", profile.v3Factory),
    positionManager: pick("RH_POSITION_MANAGER", profile.positionManager),
    weth: pick("RH_WETH", profile.weth),
    maxOracleAgeSeconds: maxOracleAgeFor(net.chainId),
    monthlyCapUsd: BigInt(String(process.env.RH_MONTHLY_CAP_USD || "").trim() || DEFAULT_MONTHLY_CAP_USD.toString()),
  };

  console.log(`[rh-prereq] network=${network.name} chainId=${net.chainId}`);
  console.log(`[rh-prereq] deployer=${deployerAddress} balance=${ethers.formatEther(await ethers.provider.getBalance(deployerAddress))}`);
  console.log(`[rh-prereq] safe=${safe} feed=${inputs.nativeUsdFeed} maxOracleAge=${inputs.maxOracleAgeSeconds}s monthlyCap=${inputs.monthlyCapUsd}`);
  console.log("[rh-prereq] deploying:");
  const contracts = await deployPrerequisites(inputs);

  const artifact = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    safe,
    inputs: { ...inputs, chainId: Number(inputs.chainId), monthlyCapUsd: inputs.monthlyCapUsd.toString() },
    contracts,
    unset: "weekly operator, weekly/monthly rootPoster: left zero like BNB mainnet, for the Safe to set",
  };
  const out = path.join(__dirname, "..", "deployments", profile.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[rh-prereq] wrote ${out}`);
  console.log("\n[rh-prereq] next, the router (its env names are BNB_-prefixed on every chain):");
  console.log(`  CONFIRM_ROUTER_DEPLOY=${profile.confirm} BNB_ROUTER_ADMIN=${safe} \\`);
  console.log(`  BNB_WEEKLY_LEAGUE_VAULT=${contracts.WeeklyLeagueVault} BNB_MONTHLY_LEAGUE_TREASURY=${contracts.MonthlyLeagueTreasury} \\`);
  console.log(`  BNB_RECRUITER_VAULT=${contracts.RecruiterRewardsVault} BNB_PROTOCOL_VAULT=${contracts.ProtocolRevenueVault} \\`);
  console.log(`    npx hardhat run scripts/deploy-evm-treasury-router-v3.ts --network ${network.name}`);
  console.log("[rh-prereq] then the generation, with:");
  console.log(`  RH_GRADUATION_ORACLE=${contracts.GraduationOracle} RH_V3_GRADUATION_ROUTER=${contracts.RobinhoodUniswapV3GraduationAdapter} \\`);
  console.log(`  RH_V3_FACTORY=${inputs.v3Factory} RH_POSITION_MANAGER=${inputs.positionManager} RH_WETH=${inputs.weth} RH_NATIVE_USD_FEED=${inputs.nativeUsdFeed} \\`);
  console.log(`  RH_TREASURY_ROUTER=<from the router step> RH_OWNER=${safe} RH_SWAP_ROUTER=<SwapRouter02>`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
