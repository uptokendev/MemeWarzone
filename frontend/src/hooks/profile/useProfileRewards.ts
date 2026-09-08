import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { requestNonce } from "@/lib/profileApi";
import {
  buildLeagueClaimMessage,
  fetchClaimableRewards,
  fetchMonthlyClaim,
  monthIdFromEpochStart,
  recordLeagueClaimTx,
  submitLeagueClaim,
  type RewardItem,
} from "@/lib/rewardsApi";
import {
  emitRewardRecorded,
  emitRewardUnlocking,
  LEAGUE_CLAIM_RECORDED_EVENT,
  LEAGUE_CLAIM_UNLOCKING_EVENT,
  waitForRewardUnlockFlight,
  type RewardUnlockDetail,
} from "@/lib/rewardUnlockEvents";

interface UseProfileRewardsArgs {
  activeTab: string;
  chainId?: number;
  account: string | null;
  isOwnProfile: boolean;
  wallet: any;
}

export type LeagueClaimRecordedDetail = RewardUnlockDetail;

function rewardKey(reward: RewardItem) {
  return `${reward.period}:${reward.epochStart}:${reward.category}:${reward.rank}`;
}

function isSolanaLeagueChain(chainId?: number | null) {
  const id = Number(chainId || 0);
  return id === 101 || id === 102;
}

function rewardCurrency(chainId?: number | null) {
  const id = Number(chainId || 0);
  if (isSolanaLeagueChain(id)) return "SOL";
  if (id === 4663 || id === 46630) return "ETH";
  return "BNB";
}

export function useProfileRewards({
  activeTab,
  chainId,
  account,
  isOwnProfile,
  wallet,
}: UseProfileRewardsArgs) {
  const [rewards, setRewards] = useState<RewardItem[]>([]);
  const [loadingRewards, setLoadingRewards] = useState(false);
  const [rewardsError, setRewardsError] = useState<string | null>(null);
  const [claimingKey, setClaimingKey] = useState<string | null>(null);

  const loadRewards = useCallback(async () => {
    if (activeTab !== "rewards" || !chainId || !account || !isOwnProfile) {
      if (!isOwnProfile) setRewards([]);
      return;
    }

    setLoadingRewards(true);
    setRewardsError(null);
    try {
      const raw = await fetchClaimableRewards(chainId, account);
      const filtered: RewardItem[] = [];
      const solana = isSolanaLeagueChain(chainId);

      for (const reward of raw) {
        if (reward.period !== "monthly" || solana) {
          filtered.push(reward);
          continue;
        }

        try {
          const month = await fetchMonthlyClaim(
            chainId,
            monthIdFromEpochStart(reward.epochStart),
            account
          );
          const match = month.rewards.find(
            (item) =>
              item.category === reward.category && Number(item.rank) === Number(reward.rank)
          );

          if (!match?.claimed) {
            filtered.push({
              ...reward,
              payload: {
                ...(reward.payload ?? {}),
                monthlyTreasury: {
                  status: month.status,
                  isSealed: month.isSealed,
                  readyForClaims: month.reconciliation?.readyForClaims === true,
                  claimable: match?.claimable === true,
                },
              },
            });
          }
        } catch {
          filtered.push(reward);
        }
      }

      setRewards(filtered);
    } catch (error: any) {
      setRewards([]);
      setRewardsError(error?.message || "Failed to load rewards.");
    } finally {
      setLoadingRewards(false);
    }
  }, [activeTab, chainId, account, isOwnProfile]);

  useEffect(() => {
    void loadRewards();
  }, [loadRewards]);

  const handleClaimPrize = useCallback(
    async (reward: RewardItem) => {
      if (!chainId || !account || !isOwnProfile) {
        toast.error("Connect the winning wallet to claim this prize.");
        return null;
      }
      const solana = isSolanaLeagueChain(chainId);
      if (!solana && !wallet?.signer) {
        toast.error("Wallet signer is unavailable. Reconnect and try again.");
        return null;
      }

      const key = rewardKey(reward);
      setClaimingKey(key);

      try {
        let txHash: string | null = null;

        if (reward.period === "monthly" && !solana) {
          const monthId = monthIdFromEpochStart(reward.epochStart);
          const monthly = await fetchMonthlyClaim(chainId, monthId, account);
          const claim = monthly.rewards.find(
            (item) =>
              item.category === reward.category && Number(item.rank) === Number(reward.rank)
          );

          if (claim?.claimed) {
            setRewards((current) => current.filter((item) => rewardKey(item) !== key));
            toast.success("This monthly prize was already claimed.");
            return null;
          }
          if (!monthly.isSealed || !monthly.reconciliation?.readyForClaims) {
            throw new Error("This monthly league is not finalized for claims yet.");
          }
          if (!claim?.claimable) throw new Error("This monthly prize is not claimable.");

          const tx = await wallet.signer.sendTransaction({
            to: claim.transaction.to,
            data: claim.transaction.data,
            value: BigInt(claim.transaction.value || "0"),
          });
          await tx.wait();
          txHash = tx.hash;
        } else {
          const nonce = await requestNonce(chainId, account);
          const message = buildLeagueClaimMessage({
            chainId,
            recipient: account,
            period: reward.period,
            epochStart: reward.epochStart,
            category: reward.category,
            rank: reward.rank,
            nonce,
          });
          let signature = "";
          if (solana) {
            const { signSolanaMessage } = await import("@/lib/solanaWallet");
            signature = (await signSolanaMessage(message, account)).signature;
          } else {
            signature = await wallet.signer.signMessage(message);
          }
          const prepared = await submitLeagueClaim({
            chainId,
            period: reward.period,
            epochStart: reward.epochStart,
            category: reward.category,
            rank: reward.rank,
            recipient: account,
            nonce,
            signature,
          });

          if ("mode" in prepared && prepared.mode === "solana_treasury") {
            const { submitSolanaLeagueClaim } = await import("@/lib/solanaLeagueClaim");
            txHash = await submitSolanaLeagueClaim(prepared);
          } else if ("mode" in prepared && prepared.mode === "merkle") {
            const treasury = new (await import("ethers")).ethers.Contract(
              prepared.vaultAddress,
              [
                "function claim(uint256 epochId, bytes32 categoryHash, uint8 rank, address recipient, uint256 amount, bytes32[] proof)",
              ],
              wallet.signer
            );
            const tx = await treasury.claim(
              prepared.epochId,
              prepared.categoryHash,
              prepared.rank,
              prepared.recipient,
              prepared.amountRaw,
              prepared.proof
            );
            await tx.wait();
            txHash = tx.hash;
          } else {
            txHash = prepared.txHash || null;
          }

          if (txHash && "mode" in prepared && (prepared.mode === "solana_treasury" || prepared.mode === "merkle")) {
            const recordNonce = await requestNonce(chainId, account);
            const recordMessage = buildLeagueClaimMessage({
              chainId,
              recipient: account,
              period: reward.period,
              epochStart: reward.epochStart,
              category: reward.category,
              rank: reward.rank,
              nonce: recordNonce,
            });
            let recordSignature = "";
            if (solana) {
              const { signSolanaMessage } = await import("@/lib/solanaWallet");
              recordSignature = (await signSolanaMessage(recordMessage, account)).signature;
            } else {
              recordSignature = await wallet.signer.signMessage(recordMessage);
            }
            await recordLeagueClaimTx({
              chainId,
              period: reward.period,
              epochStart: reward.epochStart,
              category: reward.category,
              rank: reward.rank,
              recipient: account,
              nonce: recordNonce,
              signature: recordSignature,
              txHash,
            });
          }
        }

        const detail: RewardUnlockDetail = {
          source: "league",
          reward,
          chainId,
          recipient: account,
          txHash,
          claimedAt: new Date().toISOString(),
          presentation: {
            eyebrow: "Reward secured",
            title: "Victory Unlocked",
            subtitle: "Your reward is secured and your trophy is entering the League Cabinet.",
            currency: rewardCurrency(chainId),
            destinationLabel: "View Cabinet",
            destinationPath: `/profile/${account}`,
            destinationHash: "league-cabinet",
            destinationFocusEvent: "memewarzone:focus-league-cabinet",
          },
        };

        emitRewardUnlocking(detail, LEAGUE_CLAIM_UNLOCKING_EVENT);
        await waitForRewardUnlockFlight();
        setRewards((current) => current.filter((item) => rewardKey(item) !== key));
        emitRewardRecorded(detail, LEAGUE_CLAIM_RECORDED_EVENT);
        toast.success(
          reward.period === "monthly" ? "Monthly league prize claimed." : "League prize claimed."
        );
        return detail;
      } catch (error: any) {
        toast.error(error?.shortMessage || error?.message || "Claim failed.");
        return null;
      } finally {
        setClaimingKey(null);
      }
    },
    [chainId, account, isOwnProfile, wallet]
  );

  return {
    rewards,
    loadingRewards,
    rewardsError,
    claimingKey,
    handleClaimPrize,
    reloadRewards: loadRewards,
  };
}