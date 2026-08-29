import { ethers } from "ethers";
import { getServerReadProvider } from "./getServerReadProvider.js";
import { WAR_POOL_ABI, battlePoolId, tournamentPoolId, warPoolTreasuryAddress } from "./arenaWarPoolEscrow.js";

export function escrowRequired(chainId) {
  return Boolean(warPoolTreasuryAddress(chainId));
}

export function stakeToWei(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return ethers.parseEther(n.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""));
}

export async function readOnchainPool(chainId, subjectId, kind = "battle") {
  const treasury = warPoolTreasuryAddress(chainId);
  const poolId = kind === "tournament" ? tournamentPoolId(subjectId) : battlePoolId(subjectId);
  if (!treasury) {
    return { configured: false, treasury: "", poolId, opened: false, bothPaid: false };
  }
  try {
    const provider = await getServerReadProvider(chainId);
    const contract = new ethers.Contract(treasury, WAR_POOL_ABI, provider);
    const onchain = await contract.pools(poolId);
    const ownerA = String(onchain.ownerA || "");
    const opened = Boolean(ownerA && ownerA !== ethers.ZeroAddress);
    const stakeAmount = BigInt(onchain.stakeAmount || 0);
    const stakeA = BigInt(onchain.stakeA || 0);
    const stakeB = BigInt(onchain.stakeB || 0);
    const paidA = opened && stakeAmount > 0n && stakeA === stakeAmount;
    const paidB = opened && stakeAmount > 0n && stakeB === stakeAmount;
    return {
      configured: true,
      treasury,
      poolId,
      abi: WAR_POOL_ABI,
      opened,
      ownerA: opened ? ownerA : "",
      ownerB: opened ? String(onchain.ownerB || "") : "",
      stakeAmount: stakeAmount.toString(),
      stakeA: stakeA.toString(),
      stakeB: stakeB.toString(),
      paidA,
      paidB,
      bothPaid: paidA && paidB,
      depositDeadline: Number(onchain.depositDeadline || 0),
      resolveDeadline: Number(onchain.resolveDeadline || 0),
      onchainState: Number(onchain.state || 0),
      refundedA: Boolean(onchain.refundedA),
      refundedB: Boolean(onchain.refundedB),
    };
  } catch (error) {
    return {
      configured: true,
      treasury,
      poolId,
      abi: WAR_POOL_ABI,
      opened: false,
      bothPaid: false,
      paidA: false,
      paidB: false,
      error: String(error?.message || error),
    };
  }
}
