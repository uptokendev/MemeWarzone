/**
 * Major War League payout vaults on BNB / Robinhood (founder decisions 2026-10-02).
 *
 * The MWL league share of every battle sits in PostGradLeagueTreasuryV2, split 60% month / 40%
 * quarter per epoch. Its receivers are the Safe today, so nothing can pay winners. This deploys two
 * TreasuryVaultV2 per chain (existing, audited bytecode; the pre-grad weekly vault on Robinhood runs
 * the same contract): one for MWL months, one for Quarterly Championships. Separate from every
 * pre-grad league vault.
 *
 *   TreasuryVaultV2(multisig = Safe, operator = 0, rootPoster = payout operator)
 *     - only the Safe can withdraw or change anything; the operator payout lane stays off (no operator)
 *     - the root poster can only post a winner list for an epoch the Safe authorized, up to its max
 *
 * Safe batch MWL1 (one per chain, written by this script):
 *   PostGradLeagueTreasuryV2.setReceivers(monthlyVault, quarterlyVault)
 *   each vault: setClaimCaps(max, max), setClaimsPaused(false)
 *   monthly vault: authorizeEpoch x MONTHS (24), quarterly vault: authorizeEpoch x QUARTERS (8)
 * Epoch id = keccak(abi.encode(uint32 chain, uint8 code, uint64 epochStart)), code 3 month / 4
 * quarter, exactly as api/leagueRoot.js and api/league.js compute it. Each epoch may be published
 * from its end until two years later, so a slow month never needs a second Safe signature.
 *
 *   npx hardhat run scripts/deploy-mwl-payout-vaults.ts --network bscMainnet          # reads, plans
 *   MWZ_DEPLOY_SEND=1 npx hardhat run scripts/deploy-mwl-payout-vaults.ts --network bscMainnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { buildBatch } from "./make-safe-batch";

export const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
export const PAYOUT_OPERATOR = "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50";
export const MWL_CODES = { monthly: 3, quarterly: 4 } as const;
const DAY = 86_400;
const PUBLISH_WINDOW_SECONDS = 730 * DAY;

type ChainSetup = { dir: string; native: string; leagueTreasury: string; monthlyMax: string; quarterlyMax: string };

// Per-epoch maximums bound what a stolen root-poster key could ever misdirect (one epoch's max).
// Mirrors the pre-grad caps (weekly 5/10 BNB, 1.5/3 ETH); a rolled-over pot fits under them.
export const CHAINS: Record<number, ChainSetup> = {
  56: { dir: "bnb", native: "BNB", leagueTreasury: "0xD9E381408A4e361C66D8b1e657583bdE6c52402d", monthlyMax: "10", quarterlyMax: "20" },
  4663: { dir: "robinhood", native: "ETH", leagueTreasury: "0x5D5CC19B5BE86BA28b8164f85883F17843B69810", monthlyMax: "3", quarterlyMax: "6" },
};

export function mwlEpochId(chainId: number, code: number, epochStartSec: number): bigint {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint32", "uint8", "uint64"], [chainId, code, BigInt(epochStartSec)]);
  return BigInt(ethers.keccak256(encoded));
}

/** The next `count` month (or quarter) starts from the one containing `from`, as [start, end] in seconds. */
export function periodWindows(kind: "monthly" | "quarterly", from: Date, count: number): Array<{ start: number; end: number; label: string }> {
  const out = [];
  let year = from.getUTCFullYear();
  let month = kind === "monthly" ? from.getUTCMonth() : Math.floor(from.getUTCMonth() / 3) * 3;
  const step = kind === "monthly" ? 1 : 3;
  for (let i = 0; i < count; i += 1) {
    const start = Date.UTC(year, month, 1) / 1000;
    const next = month + step;
    const end = Date.UTC(year + Math.floor(next / 12), next % 12, 1) / 1000;
    out.push({ start, end, label: kind === "monthly" ? `${year}-${String(month + 1).padStart(2, "0")}` : `${year}-Q${month / 3 + 1}` });
    year += Math.floor(next / 12);
    month = next % 12;
  }
  return out;
}

/** Every Safe call of batch MWL1, in order. Used by the rehearsal spec, so it tests exactly this. */
export function mwlVaultSafeCalls(input: {
  chainId: number;
  leagueTreasury: string;
  monthlyVault: string;
  quarterlyVault: string;
  monthlyMaxWei: bigint;
  quarterlyMaxWei: bigint;
  from: Date;
  months?: number;
  quarters?: number;
}) {
  const calls: Array<{ contract: string; to: string; fn: string; args: unknown[] }> = [
    { contract: "PostGradLeagueTreasuryV2", to: input.leagueTreasury, fn: "setReceivers", args: [input.monthlyVault, input.quarterlyVault] },
  ];
  for (const [vault, max] of [[input.monthlyVault, input.monthlyMaxWei], [input.quarterlyVault, input.quarterlyMaxWei]] as const) {
    calls.push({ contract: "TreasuryVaultV2", to: vault, fn: "setClaimCaps", args: [max.toString(), max.toString()] });
    calls.push({ contract: "TreasuryVaultV2", to: vault, fn: "setClaimsPaused", args: [false] });
  }
  for (const w of periodWindows("monthly", input.from, input.months ?? 24)) {
    calls.push({ contract: "TreasuryVaultV2", to: input.monthlyVault, fn: "authorizeEpoch",
      args: [mwlEpochId(input.chainId, MWL_CODES.monthly, w.start).toString(), input.monthlyMaxWei.toString(), w.end, w.end + PUBLISH_WINDOW_SECONDS] });
  }
  for (const w of periodWindows("quarterly", input.from, input.quarters ?? 8)) {
    calls.push({ contract: "TreasuryVaultV2", to: input.quarterlyVault, fn: "authorizeEpoch",
      args: [mwlEpochId(input.chainId, MWL_CODES.quarterly, w.start).toString(), input.quarterlyMaxWei.toString(), w.end, w.end + PUBLISH_WINDOW_SECONDS] });
  }
  return calls;
}

async function main() {
  const hre = await import("hardhat");
  const { ethers: hh } = hre;
  const chainId = Number((await hh.provider.getNetwork()).chainId);
  const setup = CHAINS[chainId];
  if (!setup) throw new Error(`chain ${chainId} is not an MWL vault chain (56, 4663)`);
  const send = process.env.MWZ_DEPLOY_SEND === "1";
  const league = new hh.Contract(setup.leagueTreasury, [
    "function owner() view returns (address)",
    "function monthlyReceiver() view returns (address)",
    "function quarterlyReceiver() view returns (address)",
  ], hh.provider);
  const [owner, monthlyReceiver, quarterlyReceiver] = await Promise.all([league.owner(), league.monthlyReceiver(), league.quarterlyReceiver()]);
  console.log({ chainId, leagueTreasury: setup.leagueTreasury, owner, monthlyReceiver, quarterlyReceiver });
  if (owner.toLowerCase() !== SAFE.toLowerCase()) throw new Error(`league treasury owner is ${owner}, expected the Safe ${SAFE}`);
  if (!send) {
    console.log(`plan only. MWZ_DEPLOY_SEND=1 deploys 2 x TreasuryVaultV2(${SAFE}, 0x0, ${PAYOUT_OPERATOR}) and writes batch MWL1.`);
    return;
  }
  const Factory = await hh.getContractFactory("TreasuryVaultV2");
  const vaults: Record<string, string> = {};
  for (const kind of ["monthly", "quarterly"]) {
    const vault = await Factory.deploy(SAFE, ethers.ZeroAddress, PAYOUT_OPERATOR);
    await vault.waitForDeployment();
    const address = await vault.getAddress();
    const [multisig, rootPoster, operator] = await Promise.all([vault.multisig(), vault.rootPoster(), vault.operator()]);
    if (multisig.toLowerCase() !== SAFE.toLowerCase() || rootPoster.toLowerCase() !== PAYOUT_OPERATOR.toLowerCase() || operator !== ethers.ZeroAddress) {
      throw new Error(`${kind} vault ${address} read back wrong roles`);
    }
    vaults[kind] = address;
    console.log(`MWL ${kind} vault ${address}`);
  }
  const calls = mwlVaultSafeCalls({
    chainId,
    leagueTreasury: setup.leagueTreasury,
    monthlyVault: vaults.monthly,
    quarterlyVault: vaults.quarterly,
    monthlyMaxWei: ethers.parseEther(setup.monthlyMax),
    quarterlyMaxWei: ethers.parseEther(setup.quarterlyMax),
    from: new Date(),
  });
  const dir = path.join(__dirname, "..", "deployments", setup.dir);
  fs.mkdirSync(dir, { recursive: true });
  const batch = buildBatch(chainId, `MWL1 Major War League vaults (${setup.native})`,
    `Point PostGradLeagueTreasuryV2 at the MWL vaults, open claims with caps ${setup.monthlyMax}/${setup.quarterlyMax} ${setup.native}, authorize 24 months + 8 quarters.`, calls);
  fs.writeFileSync(path.join(dir, "mainnet.MWL1-mwl-vaults.safe-batch.json"), JSON.stringify(batch, null, 2));
  fs.writeFileSync(path.join(dir, "mainnet.mwl-vaults.json"), JSON.stringify({ chainId, ...vaults, leagueTreasury: setup.leagueTreasury, deployedAt: new Date().toISOString() }, null, 2));
  console.log(`wrote deployments/${setup.dir}/mainnet.MWL1-mwl-vaults.safe-batch.json (${calls.length} calls)`);
  console.log(`API env: MWL_MONTHLY_VAULT_ADDRESS_${chainId}=${vaults.monthly}  MWL_QUARTERLY_VAULT_ADDRESS_${chainId}=${vaults.quarterly}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
