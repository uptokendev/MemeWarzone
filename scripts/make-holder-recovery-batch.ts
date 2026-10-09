/**
 * E19 (founder, 2026-09-30): unclaimed holder payouts go back to the same coin's holders.
 *
 * A CreatorRewardsVaultV2 holder batch lives on the holder RewardDistributor with a claim deadline. After it,
 * RewardDistributor.recoverUnclaimed(id, recipient) is the only exit and it is owner-only (the Safe). The money
 * is not the Safe's: each unclaimed leaf's `parts` (published leaf file, E19) say which coin it came from. So one
 * Safe transaction, all-or-nothing:
 *
 *   1. RewardDistributor.recoverUnclaimed(batchId, Safe)
 *   2. CreatorRewardsVaultV2.creditUnclaimedHolders{value: total}(campaigns, amounts)
 *
 * Attribution: every leaf the distributor reports hasClaimed for is excluded; the parts of the remaining leaves
 * are summed per campaign. Refuses before the deadline, when already recovered, when the file is not the batch
 * on chain (root, total, deadline, distributor, vault), when the claimed leaves do not add up to the
 * distributor's totalClaimed, when the attribution does not sum exactly to the unclaimed amount, or when a
 * campaign is not a holders or split coin in the vault.
 *
 * Audit notes. Atomic: the Safe executes both calls as one MultiSendCallOnly transaction, so the Safe holds the
 * money only inside it; if the credit reverts, the recovery reverts too. The amount is fixed: after the deadline
 * nobody can claim, so totalFunded - totalClaimed cannot move between writing and signing. Replay: the same
 * batch run twice reverts in step 1 (AmountZero). The vault's own check (msg.value == sum, holder coins only)
 * holds even if this script were wrong.
 *
 *   HOLDER_RECOVERY_FILE=<leaf file .json | https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=...> \
 *     npx hardhat run scripts/make-holder-recovery-batch.ts --network bscMainnet
 *
 * Read-only; writes the Safe batch JSON under deployments/<chain>/ when there is something to recover.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { buildBatch } from "./make-safe-batch";
// Same leaf-file checks the Safe signers run for the weekly holder batch (tree, totals, batch id, E19 parts).
import { checkLeafFile, checkLeafParts, vaultEnvName } from "./evm-holder-batch-verify.mjs";

const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const HOLDERS = 2;
const SPLIT = 3;
const MAX_BATCH_CAMPAIGNS = 200;

const CHAINS: Record<number, { dir: string; native: string; mainnet: boolean }> = {
  56: { dir: "bnb", native: "BNB", mainnet: true },
  4663: { dir: "robinhood", native: "ETH", mainnet: true },
  97: { dir: "bscTestnet", native: "tBNB", mainnet: false },
  46630: { dir: "robinhood", native: "ETH", mainnet: false },
};

type Leaf = { account: string; amount: string; parts?: Array<{ campaign: string; amount: string }> };
export type HolderLeafFile = {
  kind: "mwz-evm-holder-batch";
  version: 1;
  chainId: number;
  vault: string;
  holderDistributor: string;
  weekId: string;
  batchId: string;
  /** "airdrop_holders_gen7" for gen-7's own vault; absent on gen-6 files. */
  program?: string;
  claimDeadline: number;
  root: string;
  total: string;
  campaigns: Array<{ campaign: string; amount: string }>;
  leaves: Leaf[];
};
export type OnChainBatch = { merkleRoot: string; totalFunded: bigint; totalClaimed: bigint; claimDeadline: bigint; exists: boolean };

/**
 * Pure. Attributes a holder batch's unclaimed native per campaign. `claimed(account)` is the distributor's
 * hasClaimed. Throws on anything that does not match exactly.
 */
export function attributeUnclaimed(file: HolderLeafFile, batch: OnChainBatch, claimed: (account: string) => boolean, nowSec: number) {
  checkLeafFile(file);
  if (!checkLeafParts(file)) throw new Error("the leaf file has no per-campaign parts: the unclaimed amount cannot be attributed to coins");
  if (!batch.exists) throw new Error(`batch ${file.batchId} does not exist on the distributor`);
  if (batch.merkleRoot.toLowerCase() !== file.root.toLowerCase()) throw new Error(`distributor root ${batch.merkleRoot} is not the file's ${file.root}`);
  if (batch.claimDeadline === 0n || BigInt(file.claimDeadline) !== batch.claimDeadline) {
    throw new Error(`distributor claim deadline ${batch.claimDeadline} is not the file's ${file.claimDeadline}`);
  }
  if (BigInt(nowSec) <= batch.claimDeadline) throw new Error(`claim window open until ${new Date(Number(batch.claimDeadline) * 1000).toISOString()}`);
  const unclaimed = batch.totalFunded - batch.totalClaimed;
  if (unclaimed === 0n) throw new Error("nothing unclaimed: fully claimed or already recovered");
  if (batch.totalFunded !== BigInt(file.total)) throw new Error(`distributor funded ${batch.totalFunded}, the file's total is ${file.total}`);

  let claimedSum = 0n;
  const perCampaign = new Map<string, bigint>();
  for (const leaf of file.leaves) {
    if (claimed(leaf.account)) {
      claimedSum += BigInt(leaf.amount);
      continue;
    }
    for (const p of leaf.parts!) {
      const c = ethers.getAddress(p.campaign);
      perCampaign.set(c, (perCampaign.get(c) || 0n) + BigInt(p.amount));
    }
  }
  if (claimedSum !== batch.totalClaimed) throw new Error(`claimed leaves add up to ${claimedSum}, the distributor says ${batch.totalClaimed}`);
  const legs = [...perCampaign.entries()]
    .filter(([, a]) => a > 0n)
    .sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1));
  const total = legs.reduce((s, [, a]) => s + a, 0n);
  if (total !== unclaimed) throw new Error(`attribution adds up to ${total}, the distributor holds ${unclaimed} unclaimed`);
  if (!legs.length || legs.length > MAX_BATCH_CAMPAIGNS) throw new Error(`${legs.length} campaigns: outside 1..${MAX_BATCH_CAMPAIGNS}`);
  return { campaigns: legs.map(([c]) => c), amounts: legs.map(([, a]) => a), total };
}

export function holderRecoveryCalls(input: { safe: string; distributor: string; vault: string; batchId: string; campaigns: string[]; amounts: bigint[] }) {
  const total = input.amounts.reduce((s, a) => s + a, 0n);
  if (!input.campaigns.length || input.campaigns.length !== input.amounts.length || total === 0n) throw new Error("nothing to recover");
  return [
    { contract: "RewardDistributor", to: input.distributor, fn: "recoverUnclaimed", args: [input.batchId, input.safe] },
    {
      contract: "CreatorRewardsVaultV2",
      to: input.vault,
      fn: "creditUnclaimedHolders",
      args: [input.campaigns, input.amounts.map(String)],
      value: total,
    },
  ];
}

async function readLeafFile(source: string): Promise<HolderLeafFile> {
  let body: any;
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`fetching the leaf file failed: HTTP ${r.status}`);
    body = await r.json();
  } else {
    body = JSON.parse(fs.readFileSync(source, "utf8"));
  }
  return body?.leafFile ?? body;
}

async function main() {
  const source = process.env.HOLDER_RECOVERY_FILE;
  if (!source) throw new Error("HOLDER_RECOVERY_FILE=<leaf file path or URL> is required");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not BNB (56/97) or Robinhood (4663/46630)`);
  const file = await readLeafFile(source);
  if (Number(file.chainId) !== chainId) throw new Error(`the file is for chain ${file.chainId}, the network is ${chainId}`);

  // gen-6 files: EVM_CREATOR_VAULT_V2_<id>; gen-7's own vault (program "airdrop_holders_gen7"): EVM_GEN7_CREATOR_VAULT_<id>.
  const envName = vaultEnvName(chainId, file.program ?? "airdrop_holders");
  const envVault = String(process.env[envName] || "").split(",")[0].split("@")[0].trim();
  if (envVault && ethers.getAddress(envVault) !== ethers.getAddress(file.vault)) throw new Error(`the file's vault ${file.vault} is not ${envName} ${envVault}`);
  const vault = new ethers.Contract(file.vault, [
    "function admin() view returns (address)",
    "function holderDistributor() view returns (address)",
    "function cfg(address) view returns (address creator, uint8 choice, uint8 creatorPct, address pool, address quote)",
  ], ethers.provider);
  const distributor = new ethers.Contract(file.holderDistributor, [
    "function owner() view returns (address)",
    "function batches(bytes32) view returns (bytes32 merkleRoot, uint256 totalFunded, uint256 totalClaimed, uint64 claimDeadline, bool paused, bool exists)",
    "function hasClaimed(bytes32, address) view returns (bool)",
  ], ethers.provider);

  const safe = ethers.getAddress(await vault.admin());
  if (chain.mainnet && safe !== ethers.getAddress(SAFE)) throw new Error(`vault admin ${safe} is not the Safe`);
  if (ethers.getAddress(await distributor.owner()) !== safe) throw new Error("the holder distributor's owner is not the vault admin");
  if (ethers.getAddress(await vault.holderDistributor()) !== ethers.getAddress(file.holderDistributor)) throw new Error("the vault's holder distributor is not the file's");

  const b = await distributor.batches(file.batchId);
  const batch: OnChainBatch = { merkleRoot: b.merkleRoot, totalFunded: BigInt(b.totalFunded), totalClaimed: BigInt(b.totalClaimed), claimDeadline: BigInt(b.claimDeadline), exists: b.exists };
  const claimed = new Set<string>();
  for (const leaf of file.leaves) if (await distributor.hasClaimed(file.batchId, leaf.account)) claimed.add(leaf.account.toLowerCase());
  const now = Number((await ethers.provider.getBlock("latest"))!.timestamp);
  const { campaigns, amounts, total } = attributeUnclaimed(file, batch, (a) => claimed.has(a.toLowerCase()), now);
  for (const c of campaigns) {
    const choice = Number((await vault.cfg(c)).choice);
    if (choice !== HOLDERS && choice !== SPLIT) throw new Error(`campaign ${c} has choice ${choice} in the vault, not holders or split`);
  }

  const calls = holderRecoveryCalls({ safe, distributor: file.holderDistributor, vault: file.vault, batchId: file.batchId, campaigns, amounts });
  const out = path.resolve(__dirname, "..", "deployments", chain.dir, `${chain.mainnet ? "mainnet" : `testnet-${chainId}`}.holder-recovery-${file.weekId}.safe-batch.json`);
  const safeBatch = buildBatch(chainId, `Holder recovery ${file.weekId}: ${ethers.formatEther(total)} ${chain.native} back to ${campaigns.length} coin(s)`,
    `Batch ${file.batchId}: ${file.leaves.length - claimed.size} unclaimed of ${file.leaves.length} leaves after the deadline -> Safe -> CreatorRewardsVaultV2.creditUnclaimedHolders (same coins' holder balances). One transaction, all or nothing.`, calls as any);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(safeBatch, null, 2)}\n`);
  console.log(`[holder-recovery] ${ethers.formatEther(total)} ${chain.native} -> ${path.relative(process.cwd(), out)}`);
  campaigns.forEach((c, i) => console.log(`    ${c}  ${ethers.formatEther(amounts[i])} ${chain.native}`));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[holder-recovery] REFUSED: ${error?.message || error}`);
    process.exit(1);
  });
}
