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

const leagueSol = read("api/lib/solanaLeagueClaimVerification.js");
assert.match(leagueSol, /maxSupportedTransactionVersion:\s*0/);
assert.match(leagueSol, /commitment:\s*"finalized"/);
assert.match(leagueSol, /claimReceipt/);

const router = read("api/leagueRouter.js");
assert.match(router, /verifySolanaLeagueClaimTransaction/);
assert.match(router, /verifyEvmLeagueClaimTransaction/);
assert.match(router, /discoverEvmLeagueClaimTransaction/);
assert.match(router, /pg_advisory_xact_lock/);

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

const lp = read("src/lib/lpFeeHarvest.ts");
assert.match(lp, /Wrong wallet network/);
assert.match(lp, /registered/);
assert.match(lp, /lockedLiquidity/);
assert.match(lp, /await tx\.wait\(\)/);

const recruiter = read("src/components/command-center/RecruiterNativePayoutsPanel.tsx");
assert.match(recruiter, /type NativeChain = "bnb" \| "solana"/);
assert.doesNotMatch(recruiter, /type NativeChain = .*robinhood/);

console.log("Agent 6 three-chain claim safety source matrix: PASS");
