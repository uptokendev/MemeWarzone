/**
 * BNB / Robinhood payouts, switched on (2026-09-26). On both chains every payout rail was deployed but
 * off: recruiter vaults paused with no operator and zero caps, weekly league vaults with claims paused
 * and no root poster, monthly league vaults with no root poster, no RewardDistributor for the airdrop.
 *
 * This script (one chain per run):
 *   1. reads every contract it will touch and refuses if one is not the Safe's or has no code;
 *   2. deploys RewardDistributor(owner = Safe) -- only with MWZ_DEPLOY_SEND=1, recorded once;
 *   3. writes ONE Safe batch with every call, decoded by the Safe UI:
 *      - RecruiterRewardsVault: setOperator, setPayoutCaps, setPayoutsPaused(false)
 *      - TreasuryVaultV2 (weekly league): setRootPoster, setClaimCaps, setClaimsPaused(false)
 *        + authorizeEpoch for the next weeks where the deployed vault supports it (Robinhood)
 *      - MonthlyLeagueTreasury: setRootPoster
 *        + authorizeMonth for the next months where supported (Robinhood; exceptional, so a month
 *          without winners cannot block the next one)
 *      - airdrop: CommunityRewardsVault.setRewardDistributor / setAirdropOperator,
 *        RewardDistributor.setBatchOperator + authorizeBatch x weeks (scripts/make-airdrop-setup-calls.mjs)
 *
 * One operator key (PAYOUT_OPERATOR_ADDRESS) holds the narrow roles; each is bounded on chain by the
 * caps below. BNB's league vaults are the first-generation contracts without per-epoch
 * authorization, so there the claim caps are the bound -- keep them tight and raise them via the Safe.
 *
 *   PAYOUT_OPERATOR_ADDRESS=0x.. npx hardhat run scripts/setup-evm-payouts.ts --network bscMainnet        # reads + writes the batch plan
 *   MWZ_DEPLOY_SEND=1 PAYOUT_OPERATOR_ADDRESS=0x.. npx hardhat run scripts/setup-evm-payouts.ts --network bscMainnet   # also deploys the distributor
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ethers } from "hardhat";
import { buildBatch } from "./make-safe-batch";

const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const DAY = 86_400;

type ChainSetup = {
  dir: string;
  native: string;
  recruiter: string;
  community: string;
  weekly: string;
  monthly: string;
  caps: { recruiterPerTx: string; recruiterDaily: string; claimPerTx: string; epochTotal: string; weeklyAuth: string; monthlyAuth: string; airdropBatch: string };
};

const CHAINS: Record<number, ChainSetup> = {
  56: {
    dir: "bnb",
    native: "BNB",
    recruiter: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78",
    community: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    weekly: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5",
    monthly: "0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8",
    caps: { recruiterPerTx: "2", recruiterDaily: "10", claimPerTx: "5", epochTotal: "10", weeklyAuth: "10", monthlyAuth: "40", airdropBatch: "5" },
  },
  4663: {
    dir: "robinhood",
    native: "ETH",
    recruiter: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7",
    community: "0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a",
    weekly: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    monthly: "0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238",
    caps: { recruiterPerTx: "0.5", recruiterDaily: "3", claimPerTx: "1.5", epochTotal: "3", weeklyAuth: "3", monthlyAuth: "12", airdropBatch: "1.5" },
  },
};

const cap = (name: keyof ChainSetup["caps"], chain: ChainSetup) =>
  ethers.parseEther(String(process.env[`PAYOUT_CAP_${name.toUpperCase()}`] || chain.caps[name]));

function hasSelector(code: string, signature: string) {
  return code.toLowerCase().includes(`63${ethers.id(signature).slice(2, 10)}`);
}

/** TreasuryVaultV2 weekly epoch id -- the same keccak(abi.encode(uint32 chainId, uint8 1, uint64 start)) the API claims with. */
function weeklyEpochId(chainId: number, startSec: number) {
  return BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint32", "uint8", "uint64"], [chainId, 1, BigInt(startSec)])));
}

function mondayUtc(date: Date) {
  const day0 = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
  return day0 - ((date.getUTCDay() + 6) % 7) * DAY;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not BNB (56) or Robinhood mainnet (4663)`);
  const operator = ethers.getAddress(String(process.env.PAYOUT_OPERATOR_ADDRESS || ""));
  if (operator === ethers.getAddress(SAFE)) throw new Error("the operator must not be the Safe");
  const [deployer] = await ethers.getSigners();
  if (deployer && operator === (await deployer.getAddress())) throw new Error("the operator must not be the deployer");

  // 1. Every contract this touches: code present and owned by the Safe.
  const owners: Array<[string, string, string]> = [
    ["RecruiterRewardsVault", chain.recruiter, "function admin() view returns (address)"],
    ["CommunityRewardsVault", chain.community, "function admin() view returns (address)"],
    ["TreasuryVaultV2", chain.weekly, "function multisig() view returns (address)"],
    ["MonthlyLeagueTreasury", chain.monthly, "function multisig() view returns (address)"],
  ];
  const code: Record<string, string> = {};
  for (const [name, address, getter] of owners) {
    code[name] = await ethers.provider.getCode(address);
    if (code[name] === "0x") throw new Error(`${name} ${address} has no code on chain ${chainId}`);
    const owner = await new ethers.Contract(address, [getter], ethers.provider)[getter.split(" ")[1].split("(")[0]]();
    if (ethers.getAddress(owner) !== ethers.getAddress(SAFE)) throw new Error(`${name} ${address} is controlled by ${owner}, not the Safe`);
    console.log(`  ok ${name} ${address} (Safe-owned)`);
  }

  // 2. RewardDistributor, owner = Safe, deployed once per chain.
  const recordPath = path.resolve(__dirname, "..", "deployments", chain.dir, "mainnet.reward-distributor.json");
  let distributor = fs.existsSync(recordPath) ? ethers.getAddress(JSON.parse(fs.readFileSync(recordPath, "utf8")).address) : "";
  const preview = !distributor && Boolean(process.env.PAYOUT_PREVIEW_DISTRIBUTOR);
  if (preview) {
    distributor = ethers.getAddress(String(process.env.PAYOUT_PREVIEW_DISTRIBUTOR));
    console.log(`  PREVIEW: placeholder distributor ${distributor}; the batch goes to a .preview file and must not be signed`);
  }
  if (!distributor) {
    if (process.env.MWZ_DEPLOY_SEND !== "1") {
      console.log("\nDRY RUN: RewardDistributor is not deployed yet. Re-run with MWZ_DEPLOY_SEND=1 to deploy it (owner = Safe) and write the batch.");
      return;
    }
    const factory = await ethers.getContractFactory("RewardDistributor");
    const contract = await factory.deploy(SAFE);
    await contract.waitForDeployment();
    distributor = await contract.getAddress();
    const owner = await (contract as any).owner();
    if (ethers.getAddress(owner) !== ethers.getAddress(SAFE)) throw new Error(`deployed RewardDistributor owner is ${owner}`);
    const deployed = await ethers.provider.getCode(distributor);
    const artifact = await ethers.getContractFactory("RewardDistributor");
    if (!deployed || deployed === "0x") throw new Error("RewardDistributor has no code after deploy");
    fs.writeFileSync(recordPath, `${JSON.stringify({ chainId, address: distributor, owner: SAFE, deployTx: contract.deploymentTransaction()?.hash || null, deployedAt: new Date().toISOString(), runtimeBytes: (deployed.length - 2) / 2, artifactBytecodeBytes: (artifact.bytecode.length - 2) / 2 }, null, 2)}\n`);
    console.log(`  deployed RewardDistributor ${distributor} (owner Safe), recorded ${path.relative(process.cwd(), recordPath)}`);
  } else {
    console.log(`  RewardDistributor ${distributor} (recorded)`);
  }

  // 3. The Safe batch.
  const calls: Array<{ contract: string; to: string; fn: string; args: unknown[] }> = [
    { contract: "RecruiterRewardsVault", to: chain.recruiter, fn: "setOperator", args: [operator] },
    { contract: "RecruiterRewardsVault", to: chain.recruiter, fn: "setPayoutCaps", args: [cap("recruiterPerTx", chain).toString(), cap("recruiterDaily", chain).toString()] },
    { contract: "RecruiterRewardsVault", to: chain.recruiter, fn: "setPayoutsPaused", args: [false] },
    { contract: "TreasuryVaultV2", to: chain.weekly, fn: "setRootPoster", args: [operator] },
    { contract: "TreasuryVaultV2", to: chain.weekly, fn: "setClaimCaps", args: [cap("claimPerTx", chain).toString(), cap("epochTotal", chain).toString()] },
    { contract: "TreasuryVaultV2", to: chain.weekly, fn: "setClaimsPaused", args: [false] },
    { contract: "MonthlyLeagueTreasury", to: chain.monthly, fn: "setRootPoster", args: [operator] },
  ];

  const weeks = Math.max(1, Math.min(26, Number(process.env.PAYOUT_AUTH_WEEKS || 12)));
  if (hasSelector(code.TreasuryVaultV2, "authorizeEpoch(uint256,uint256,uint64,uint64)")) {
    const firstStart = mondayUtc(new Date());
    for (let week = 0; week < weeks; week += 1) {
      const start = firstStart + week * 7 * DAY;
      const end = start + 7 * DAY;
      calls.push({ contract: "TreasuryVaultV2", to: chain.weekly, fn: "authorizeEpoch", args: [weeklyEpochId(chainId, start).toString(), cap("weeklyAuth", chain).toString(), String(end), String(end + 30 * DAY)] });
    }
  } else {
    console.log("  note: this weekly league vault predates authorizeEpoch -- the claim caps above are its bound");
  }
  if (hasSelector(code.MonthlyLeagueTreasury, "authorizeMonth(uint256,uint256,uint64,uint64,bool)")) {
    const now = new Date();
    for (let m = 0; m < weeks; m += 1) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
      const next = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) / 1000;
      const monthId = month.getUTCFullYear() * 100 + month.getUTCMonth() + 1;
      calls.push({ contract: "MonthlyLeagueTreasury", to: chain.monthly, fn: "authorizeMonth", args: [String(monthId), cap("monthlyAuth", chain).toString(), String(next), String(next + 30 * DAY), true] });
    }
  } else {
    console.log("  note: this monthly league vault predates authorizeMonth -- its monthly USD cap is its bound");
  }

  const airdrop = JSON.parse(execFileSync("node", [
    path.join(__dirname, "make-airdrop-setup-calls.mjs"),
    "--chain", String(chainId), "--vault", chain.community, "--distributor", distributor, "--operator", operator,
    "--cap", ethers.formatEther(cap("airdropBatch", chain)), "--weeks", String(weeks),
  ], { encoding: "utf8" }));
  calls.push(...airdrop.map((call: any) => ({ contract: call.contract, to: call.to, fn: call.fn, args: call.args })));

  const batchPath = path.resolve(__dirname, "..", "deployments", chain.dir, `mainnet.P1-payouts.safe-batch.json${preview ? ".preview" : ""}`);
  const batch = buildBatch(
    chainId,
    `P1 ${chain.native} payouts: recruiter, league, airdrop`,
    `Operator ${operator} gets the recruiter-vault operator, league rootPoster and airdrop-operator roles, each capped. Recruiter vault unpaused; weekly league claims unpaused; RewardDistributor ${distributor} wired; ${weeks} weeks pre-authorized.`,
    calls,
  );
  fs.writeFileSync(batchPath, `${JSON.stringify(batch, null, 2)}\n`);
  console.log(`\n  Safe batch: ${path.relative(process.cwd(), batchPath)} (${calls.length} calls)`);
  for (const call of calls) console.log(`    ${call.contract}.${call.fn}(${call.args.map(String).join(", ")})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
