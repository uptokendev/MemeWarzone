import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const executor = fs.readFileSync(
  new URL("./solana/upgrade-mainnet-rewards-treasury.cjs", import.meta.url),
  "utf8",
);
const preflight = fs.readFileSync(
  new URL("./solana/preflight-rewards-treasury-upgrade.sh", import.meta.url),
  "utf8",
);
const envTemplate = fs.readFileSync(
  new URL("../config/solana-rewards-upgrade.env.example", import.meta.url),
  "utf8",
);

test("executor pins the existing rewards program and mainnet identity", () => {
  assert.match(executor, /2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX/);
  assert.match(executor, /5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d/);
  assert.match(executor, /BPFLoaderUpgradeab1e11111111111111111111111/);
  assert.match(executor, /SOLANA_REWARDS_TREASURY_PROGRAM_ID/);
  assert.match(executor, /Rewards program id mismatch/);
});

test("executor is dry-run by default and requires a pinned candidate", () => {
  assert.match(executor, /process\.argv\.includes\("--execute"\)/);
  assert.match(executor, /SOLANA_REWARDS_RELEASE_CANDIDATE_SHA256/);
  assert.match(executor, /candidatePinned: true/);
  assert.match(executor, /byteIdenticalBefore: alreadyDeployed/);
  assert.match(executor, /Dry-run only/);
  assert.match(executor, /program", "dump"/);
});

test("execute path requires exact confirmation and live authority key", () => {
  assert.match(executor, /UPGRADE_MWZ_REWARDS_MAINNET/);
  assert.match(executor, /SOLANA_REWARDS_UPGRADE_CONFIRM/);
  assert.match(executor, /SOLANA_REWARDS_UPGRADE_AUTHORITY_KEYPAIR/);
  assert.match(executor, /authority\.publicKey\.toBase58\(\) !== before\.authority/);
  assert.match(executor, /already deployed; refusing unnecessary upgrade transaction/);
});

test("execute path preserves ProgramData and authority then byte-verifies deployment", () => {
  assert.match(executor, /after\.programdataAddress !== before\.programdataAddress/);
  assert.match(executor, /after\.authority !== before\.authority/);
  assert.match(executor, /candidate\.equals\(afterBytes\)/);
  assert.match(executor, /deployedSha256 !== candidateSha256/);
  assert.match(executor, /REWARDS UPGRADE VERIFICATION FAILED/);
});

test("successful execute writes immutable evidence with before and after hashes", () => {
  assert.match(executor, /memewarzone\.solana-rewards-upgrade\.v1/);
  assert.match(executor, /rewards-upgrade-" \+ candidateSha256 \+ "\.json"/);
  assert.match(executor, /flag: "wx"/);
  assert.match(executor, /programdataAddress: after\.programdataAddress/);
  assert.match(executor, /upgradeAuthority: after\.authority/);
  assert.match(executor, /before: \{/);
  assert.match(executor, /after: \{/);
  assert.match(executor, /byteIdenticalToCandidate: true/);
});

test("existing preflight and executor use the same candidate/program boundary", () => {
  assert.match(preflight, /2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX/);
  assert.match(preflight, /target\/deploy\/mwz_rewards_treasury\.so/);
  assert.match(executor, /target\/deploy\/mwz_rewards_treasury\.so/);
  assert.match(preflight, /set_recruiter_batch_root/);
  assert.match(preflight, /claim_recruiter/);
  assert.match(preflight, /set_squad_batch_root/);
  assert.match(preflight, /claim_squad/);
});

test("operator template keeps claims dark and exposes no usable secret", () => {
  assert.match(envTemplate, /^SOLANA_REWARDS_TREASURY_PROGRAM_ID=2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX$/m);
  assert.match(envTemplate, /^REWARD_CLAIMS_ENABLED=false$/m);
  assert.match(envTemplate, /^REWARD_CLAIM_VERIFY_ENABLED=false$/m);
  assert.match(envTemplate, /^REWARD_FUNDING_EXECUTOR_ENABLED=false$/m);
  assert.match(envTemplate, /^SOLANA_REWARDS_UPGRADE_CONFIRM=$/m);
  assert.doesNotMatch(envTemplate, /\[[0-9]+(?:,[0-9]+){31,}\]/);
});
