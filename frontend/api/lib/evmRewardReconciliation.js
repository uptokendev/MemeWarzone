import { recoverEvmRewardClaim, RewardClaimVerificationError } from "./rewardClaimVerification.js";

export async function discoverEvmRewardClaim(options) {
  const chainId = Number(options?.chainId);
  if (chainId !== 56 && chainId !== 97) {
    throw new RewardClaimVerificationError(
      "CLAIM_RECOVERY_CHAIN_UNSUPPORTED",
      "Durable automatic generic reward recovery is not certified on this EVM chain.",
      400,
    );
  }

  const result = await recoverEvmRewardClaim(options);
  return result?.claimed === true ? result : null;
}
