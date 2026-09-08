import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) { return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); }

const intent = read("api/dev-fix/reward-claim-intent.js");
assert.match(intent, /chain === 56 \|\| chain === 97 \? process\.env\.REWARD_DISTRIBUTOR_ADDRESS : null/);
assert.doesNotMatch(intent, /\n\s*process\.env\.REWARD_DISTRIBUTOR_ADDRESS,\n\s*process\.env\.VITE_REWARD_DISTRIBUTOR_ADDRESS,/);
assert.match(intent, /for update/);
assert.match(intent, /CLAIM_TX_ALREADY_USED/);
assert.match(intent, /CLAIM_ALREADY_RECORDED/);

const rewardVerify = read("api/lib/rewardClaimVerification.js");
assert.match(rewardVerify, /hasClaimed/);
assert.match(rewardVerify, /RewardClaimed/);
assert.match(rewardVerify, /discoverEvmRewardClaim/);

const rewardSol = read("api/lib/solanaRewardClaim.js");
assert.match(rewardSol, /maxSupportedTransactionVersion:\s*0/);
assert.match(rewardSol, /commitment:\s*"finalized"/);
assert.match(rewardSol, /if \(rewardType === "squad"\)/);
assert.match(rewardSol, /if \(rewardType !== "airdrop"\) return unavailableCall/);
assert.match(rewardSol, /MISSING_SOLANA_REWARDS_PROGRAM_ID/);
assert.doesNotMatch(rewardSol, /SOLANA_REWARDS_TREASURY_PROGRAM_ID is required/);
assert.match(intent, /disabledChains: config\.enabled \? \[\] : \[chainId\]/);

const leagueSol = read("api/lib/solanaLeagueClaimVerification.js");
assert.match(leagueSol, /maxSupportedTransactionVersion:\s*0/);
assert.match(leagueSol, /commitment:\s*"finalized"/);
assert.match(leagueSol, /claimReceipt/);

const router = read("api/leagueRouter.js");
assert.match(router, /verifySolanaLeagueClaimTransaction/);
assert.match(router, /verifyEvmLeagueClaimTransaction/);
assert.match(router, /discoverEvmLeagueClaimTransaction/);
assert.match(router, /pg_advisory_xact_lock/);
assert.match(router, /where public\.league_epoch_payouts\.tx_hash is null/);
assert.match(router, /LEAGUE_PAYOUT_ALREADY_RECORDED/);

const leaguePayouts = read("api/leaguePayouts.js");
assert.match(leaguePayouts, /Invalid txHash/);
assert.match(leaguePayouts, /where public\.league_epoch_payouts\.tx_hash is null/);
assert.match(leaguePayouts, /excluded\.tx_hash is not null/);

const rewards = read("api/rewards.js");
assert.match(rewards, /reconcile-evm-claims/);
assert.match(rewards, /reconcile-solana-claims/);
assert.match(rewards, /discoverEvmRewardClaim/);
assert.match(rewards, /discoverSolanaRewardClaim/);
assert.match(rewards, /for update/);

const client = read("src/lib/rewardProgramsApi.ts");
assert.match(client, /reconcileEvmRewardClaims/);
assert.match(client, /reconcileSolanaRewardClaims/);
assert.match(client, /claim_pending/);

const profileRewards = read("src/hooks/profile/useProfileRewards.ts");
assert.match(profileRewards, /reward\.period === "monthly" && !solana/);
assert.match(profileRewards, /const recordNonce = await requestNonce\(chainId, account\)/);
assert.match(profileRewards, /nonce: recordNonce/);
assert.match(profileRewards, /signature: recordSignature/);
assert.doesNotMatch(profileRewards, /if \(reward\.period === "monthly"\) \{/);

const commandCenterClaims = read("src/pages/command-center/CommandCenterClaims.tsx");
assert.match(commandCenterClaims, /const recordNonce = await requestNonce\(claimChainId, walletAddress\)/);
assert.match(commandCenterClaims, /nonce: recordNonce/);
assert.match(commandCenterClaims, /signature: recordSignature/);

const lp = read("src/lib/lpFeeHarvest.ts");
assert.match(lp, /Wrong wallet network/);
assert.match(lp, /registered/);
assert.match(lp, /lockedLiquidity/);
assert.match(lp, /await tx\.wait\(\)/);

const recruiter = read("src/components/command-center/RecruiterNativePayoutsPanel.tsx");
assert.match(recruiter, /type NativeChain = "bnb" \| "solana"/);
assert.doesNotMatch(recruiter, /type NativeChain = .*robinhood/);

console.log("Agent 6 three-chain claim safety source matrix: PASS");
