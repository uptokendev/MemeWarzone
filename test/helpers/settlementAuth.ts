import { ethers } from "hardhat";

export async function latestTs(): Promise<number> {
  return Number((await ethers.provider.getBlock("latest"))!.timestamp);
}

export async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

export async function authorizeEpoch(vault: any, multisig: any, epochId: bigint | number, maxAmount: bigint) {
  const now = await latestTs();
  await vault.connect(multisig).authorizeEpoch(epochId, maxAmount, now, now + 30 * 24 * 3600);
}

export async function authorizeMonth(
  monthly: any,
  multisig: any,
  monthId: bigint | number,
  maxWinnerPool: bigint,
  exceptional = false
) {
  const now = await latestTs();
  await monthly.connect(multisig).authorizeMonth(monthId, maxWinnerPool, now, now + 30 * 24 * 3600, exceptional);
}

export async function authorizeBatch(distributor: any, owner: any, batchId: string, maxAmount: bigint) {
  const now = await latestTs();
  await distributor.connect(owner).authorizeBatch(batchId, maxAmount, now, now + 30 * 24 * 3600);
}

export async function createAuthorizedBatch(
  distributor: any,
  owner: any,
  batchId: string,
  merkleRoot: string,
  claimDeadline: number,
  value: bigint,
  operator?: any
) {
  await authorizeBatch(distributor, owner, batchId, value);
  return distributor.connect(operator ?? owner).createBatch(batchId, merkleRoot, claimDeadline, { value });
}
