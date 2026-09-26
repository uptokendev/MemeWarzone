/**
 * Unclaimed weekly airdrop money back into the airdrop pot (founder, 2026-09-27: 60-day claim window,
 * then it rolls into the next week -- nothing is kept back).
 *
 * After a batch's claimDeadline, RewardDistributor.recoverUnclaimed(id, recipient) is the only exit and
 * it is Safe-only. It cannot pay the CommunityRewardsVault directly: the vault's receive() reverts
 * ("direct disabled") and depositAirdrop is onlyRouter. So one Safe transaction, all-or-nothing:
 *
 *   1. RewardDistributor.recoverUnclaimed(id, Safe)       for every expired batch with money left
 *   2. CommunityRewardsVault.setRouter(Safe)
 *   3. CommunityRewardsVault.depositAirdrop{value: sum}    -> warzoneAirdropBalance, next week's pot
 *   4. CommunityRewardsVault.setRouter(<router read from chain>)
 *
 * Audit notes. Atomic: the Safe executes the batch as one MultiSendCallOnly transaction, so the vault
 * never has the Safe as router outside it and no fee routing can interleave; any failure reverts all
 * four. The amount is fixed: after claimDeadline nobody can claim, so totalFunded - totalClaimed cannot
 * move between writing and signing. Replay: a signed batch run twice reverts in step 1 (AmountZero),
 * so nothing is deposited twice. No new contract code and no new role.
 *
 * Batch ids are the runner's own deterministic ids (weeklyContractBatchId), read straight from the
 * distributor -- no log scan. Read-only unless there is something to recover; then it writes the file.
 *
 *   npx hardhat run scripts/make-airdrop-recovery-batch.ts --network bscMainnet
 *   npx hardhat run scripts/make-airdrop-recovery-batch.ts --network robinhoodMainnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { buildBatch } from "./make-safe-batch";

const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const DAY = 86_400;
/** Monday of the first pre-authorized airdrop week (P1, 2026-09-26). */
const FIRST_EPOCH = "2026-09-21";
const PROGRAMS = ["airdrop_trader", "airdrop_creator"];

export const CHAINS: Record<number, { dir: string; native: string; distributor: string; vault: string }> = {
  56: { dir: "bnb", native: "BNB", distributor: "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75", vault: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e" },
  4663: { dir: "robinhood", native: "ETH", distributor: "0x2ABd8970680d806e46DeD9AEdDAA6E12d866641D", vault: "0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a" },
};

/** Same id the weekly runner funds (frontend/scripts/weekly-airdrop/materialize.mjs). */
export function weeklyContractBatchId(chainId: number, epochId: string, program: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(`mwz-weekly-airdrop:${chainId}:${epochId}:${program}`));
}

export function epochIdsUntil(nowSec: number, first = FIRST_EPOCH): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${first}T00:00:00Z`) / 1000; t <= nowSec; t += 7 * DAY) out.push(new Date(t * 1000).toISOString().slice(0, 10));
  return out;
}

export type Expired = { batchId: string; label: string; unclaimed: bigint };

export function recoveryCalls(input: { safe: string; distributor: string; vault: string; router: string; expired: Expired[] }) {
  const total = input.expired.reduce((sum, item) => sum + item.unclaimed, 0n);
  if (!input.expired.length || total === 0n) return [];
  return [
    ...input.expired.map((item) => ({ contract: "RewardDistributor", to: input.distributor, fn: "recoverUnclaimed", args: [item.batchId, input.safe] })),
    { contract: "CommunityRewardsVault", to: input.vault, fn: "setRouter", args: [input.safe] },
    { contract: "CommunityRewardsVault", to: input.vault, fn: "depositAirdrop", args: [], value: total },
    { contract: "CommunityRewardsVault", to: input.vault, fn: "setRouter", args: [input.router] },
  ];
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not BNB (56) or Robinhood mainnet (4663)`);
  const distributor = new ethers.Contract(chain.distributor, [
    "function owner() view returns (address)",
    "function batches(bytes32) view returns (bytes32 merkleRoot, uint256 totalFunded, uint256 totalClaimed, uint64 claimDeadline, bool paused, bool exists)",
  ], ethers.provider);
  const vault = new ethers.Contract(chain.vault, ["function admin() view returns (address)", "function router() view returns (address)"], ethers.provider);
  if (ethers.getAddress(await distributor.owner()) !== ethers.getAddress(SAFE)) throw new Error("RewardDistributor owner is not the Safe");
  if (ethers.getAddress(await vault.admin()) !== ethers.getAddress(SAFE)) throw new Error("CommunityRewardsVault admin is not the Safe");
  const router = ethers.getAddress(await vault.router());
  if (router === ethers.getAddress(SAFE)) throw new Error("vault router is the Safe -- a previous recovery did not restore it; fix that first");
  if ((await ethers.provider.getCode(router)) === "0x") throw new Error(`vault router ${router} has no code`);

  const now = Number((await ethers.provider.getBlock("latest"))!.timestamp);
  const expired: Expired[] = [];
  for (const epochId of epochIdsUntil(now)) {
    for (const program of PROGRAMS) {
      const batchId = weeklyContractBatchId(chainId, epochId, program);
      const b = await distributor.batches(batchId);
      if (!b.exists) continue;
      const unclaimed = BigInt(b.totalFunded) - BigInt(b.totalClaimed);
      const deadline = Number(b.claimDeadline);
      const state = unclaimed === 0n ? "fully claimed / recovered" : deadline !== 0 && now > deadline ? "EXPIRED" : `open until ${new Date(deadline * 1000).toISOString()}`;
      console.log(`  ${epochId} ${program.padEnd(15)} unclaimed ${ethers.formatEther(unclaimed)} ${chain.native}  ${state}`);
      if (unclaimed > 0n && deadline !== 0 && now > deadline) expired.push({ batchId, label: `${epochId} ${program}`, unclaimed });
    }
  }

  const calls = recoveryCalls({ safe: SAFE, distributor: chain.distributor, vault: chain.vault, router, expired });
  if (!calls.length) {
    console.log(`\n[airdrop-recovery] chain ${chainId}: nothing expired with money left. No batch written.`);
    return;
  }
  const total = expired.reduce((sum, item) => sum + item.unclaimed, 0n);
  const file = path.resolve(__dirname, "..", "deployments", chain.dir, `mainnet.airdrop-recovery-${new Date(now * 1000).toISOString().slice(0, 10)}.safe-batch.json`);
  const batch = buildBatch(chainId, `Airdrop recovery: ${ethers.formatEther(total)} ${chain.native} back into the pot`,
    `${expired.length} expired batch(es) (${expired.map((e) => e.label).join("; ")}) -> Safe -> CommunityRewardsVault.depositAirdrop; router restored to ${router}. One transaction, all or nothing.`, calls);
  fs.writeFileSync(file, `${JSON.stringify(batch, null, 2)}\n`);
  console.log(`\n[airdrop-recovery] ${ethers.formatEther(total)} ${chain.native} from ${expired.length} batch(es) -> ${path.relative(process.cwd(), file)}`);
  for (const call of calls) console.log(`    ${call.fn}(${call.args.map(String).join(", ")})${"value" in call ? ` value ${ethers.formatEther((call as any).value)} ${chain.native}` : ""}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
