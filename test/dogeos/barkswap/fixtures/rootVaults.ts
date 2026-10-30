// The reused reward vaults from the ROOT build for the Bark periphery fork tests (t10), plus an inline test-only solc
// compile. Shared by BarkPeriphery.fork.spec.ts and BarkGen8Regressions.fork.spec.ts; t8's fixtures/barkswap.ts holds
// the Bark stack itself and is not touched here.
//
// Precondition: the root build is current (`npx hardhat compile`, solc 0.8.24). The vaults deploy from artifacts/ with
// the bytecode BNB and Robinhood run and with t15's constructor arguments (scripts/lib/dogeosBarkStack.ts), except that
// the CommunityRewardsVault router is set afterwards (wireRealVaults) and no airdrop distributor is deployed or wired.
// rootArtifact goes through t15's loadStackArtifact (compiler, settings and stale-source checks).
/* eslint-disable @typescript-eslint/no-explicit-any */
import hre, { ethers } from "hardhat";
import {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} from "hardhat/builtin-tasks/task-names";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { loadStackArtifact } from "../../../../scripts/lib/dogeosBarkStack";
import { DEFAULT_DOGE_USD_ANSWER, WAD, foundationDogeUsdOracleArtifact, type BarkStack, type BarkVaults, type C } from "./barkswap";

/** A contract of the root build (artifacts/contracts/<name>.sol/<name>.json), through t15's loader
 *  (scripts/lib/dogeosBarkStack.ts loadStackArtifact): refused unless built with solc 0.8.24 and the root settings
 *  (runs 1, viaIR, paris, bytecodeHash none), and refused if any contracts/ source it was compiled from differs from the
 *  working tree. */
export function rootArtifact(name: string): { abi: any[]; bytecode: string } {
  const a = loadStackArtifact("root", `contracts/${name}.sol:${name}`);
  return { abi: a.abi, bytecode: a.bytecode };
}

export interface RealVaults {
  weekly: C;
  charity: C;
  monthly: C;
  recruiter: C;
  protocol: C;
  community: C;
  holderDistributor: C;
  graduationOracle: C;
}

/** The splitter destinations for deployBarkStack({ vaults }). */
export async function barkVaultsOf(v: RealVaults): Promise<BarkVaults> {
  return {
    weeklyLeagueVault: await v.weekly.getAddress(),
    monthlyLeagueTreasury: await v.monthly.getAddress(),
    recruiterRewardsVault: await v.recruiter.getAddress(),
    communityRewardsVault: await v.community.getAddress(),
    protocolRevenueVault: await v.protocol.getAddress(),
  };
}

/** The reused vaults with t15's constructor arguments, admin = `deployer`: TreasuryVaultV2(A, 0, A), CharityTreasury(A), MonthlyLeagueTreasury(A, A,
 *  oracle, charity, $1.5M) on its own foundation feed + GraduationOracle (3600 s), RecruiterRewardsVault(A),
 *  ProtocolRevenueVault(A), CommunityRewardsVault(A, router 0: set to the splitter by wireRealVaults, since the
 *  splitter needs the vault's address first), RewardDistributor(A) as the holder distributor. */
export async function deployRealVaults(deployer: HardhatEthersSigner): Promise<RealVaults> {
  const deployRoot = async (name: string, args: unknown[]): Promise<C> => {
    const art = rootArtifact(name);
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c as unknown as C;
  };
  const oracleArt = await foundationDogeUsdOracleArtifact();
  const feed = await new ethers.ContractFactory(oracleArt.abi, oracleArt.bytecode, deployer).deploy(deployer.address, DEFAULT_DOGE_USD_ANSWER, false);
  await feed.waitForDeployment();
  const graduationOracle = await deployRoot("GraduationOracle", [await feed.getAddress(), 3600n]);
  const weekly = await deployRoot("TreasuryVaultV2", [deployer.address, ethers.ZeroAddress, deployer.address]);
  const charity = await deployRoot("CharityTreasury", [deployer.address]);
  const monthly = await deployRoot("MonthlyLeagueTreasury", [
    deployer.address,
    deployer.address,
    await graduationOracle.getAddress(),
    await charity.getAddress(),
    1_500_000n * WAD,
  ]);
  const recruiter = await deployRoot("RecruiterRewardsVault", [deployer.address]);
  const protocol = await deployRoot("ProtocolRevenueVault", [deployer.address]);
  const community = await deployRoot("CommunityRewardsVault", [deployer.address, ethers.ZeroAddress]);
  const holderDistributor = await deployRoot("RewardDistributor", [deployer.address]);
  return { weekly, charity, monthly, recruiter, protocol, community, holderDistributor, graduationOracle };
}

export const DEFAULT_CHOICE_VAULT_CAPS = {
  maxBuyPerTx: 1_000n * WAD,
  maxBuybackPerCoinWeek: 10_000n * WAD,
  minBuyInterval: 0n,
  maxImpactBps: 50n,
  maxHolderBatchPerWeek: 1_000n * WAD,
};

/** t15's wiring (admin = the stack's deployer): CommunityRewardsVault router = splitter; choice vault holder
 *  distributor, operator (the stack's operator, not paused) and caps; distributor batch operator = choice vault. */
export async function wireRealVaults(s: BarkStack, v: RealVaults, caps = DEFAULT_CHOICE_VAULT_CAPS): Promise<void> {
  const { deployer, operator } = s.signers;
  // the stack's deployer must be the vaults' admin (deployRealVaults(deployer) with the same signer)
  if ((await v.community.admin()) !== deployer.address || (await v.holderDistributor.owner()) !== deployer.address) {
    throw new Error("wireRealVaults: the stack's deployer is not the admin of the real vaults");
  }
  const vault = await s.choiceVault.getAddress();
  await (await v.community.connect(deployer).setRouter(await s.splitter.getAddress())).wait();
  await (await s.choiceVault.connect(deployer).setHolderDistributorOnce(await v.holderDistributor.getAddress())).wait();
  await (await v.holderDistributor.connect(deployer).setBatchOperator(vault)).wait();
  await (await s.choiceVault.connect(deployer).setOperator(operator.address, false)).wait();
  await (
    await s.choiceVault.connect(deployer).setCaps(caps.maxBuyPerTx, caps.maxBuybackPerCoinWeek, caps.minBuyInterval, caps.maxImpactBps, caps.maxHolderBatchPerWeek)
  ).wait();
}

const INLINE_CACHE = new Map<string, { abi: any[]; bytecode: string }>();

/** Compiles one TEST-ONLY contract `name` from `source` (file "<name>.sol") with hardhat's solc (default 0.8.26,
 *  cancun, 200 runs) and returns its ABI and creation code. Nothing is written to artifacts. */
export async function compileInline(name: string, source: string, solcVersion = "0.8.26"): Promise<{ abi: any[]; bytecode: string }> {
  const key = `${solcVersion}:${name}:${ethers.id(source)}`;
  const hit = INLINE_CACHE.get(key);
  if (hit) return hit;
  const file = `${name}.sol`;
  const input = {
    language: "Solidity",
    sources: { [file]: { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const build = await hre.run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion });
  const output = build.isSolcJs
    ? await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, { input, solcJsPath: build.compilerPath })
    : await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, { input, solcPath: build.compilerPath, solcVersion });
  const errors = (output.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length > 0) throw new Error(`${name}: ${errors.map((e: any) => e.formattedMessage).join("\n")}`);
  const out = output.contracts[file][name];
  const art = { abi: out.abi, bytecode: `0x${out.evm.bytecode.object}` };
  INLINE_CACHE.set(key, art);
  return art;
}
