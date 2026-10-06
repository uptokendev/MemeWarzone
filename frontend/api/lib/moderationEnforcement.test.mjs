// Moderation holds (B7): source-order checks for the enforcement points that send money or post a
// root and cannot run in a unit test without a chain (the database behaviour of each helper is in
// moderationActions.db.test.mjs and the indexer's moderationHolds.integration.test.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const src = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const before = (text, first, second, message) => {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  assert.ok(a >= 0, `${message}: missing ${first}`);
  assert.ok(b >= 0, `${message}: missing ${second}`);
  assert.ok(a < b, message);
};

test("EVM league roots: the moderation guard runs before every send and the record clears the marker", () => {
  const s = src("../../scripts/publish-evm-league-roots.mjs");
  const weekly = s.slice(s.indexOf("if (period === \"weekly\" || isMwlPayoutPeriod(period))"));
  before(weekly, "await guardModeration(chainId, period, at, built);", "const tx = await vault.setEpochRoot(", "weekly / MWL: guard before setEpochRoot");
  const monthly = s.slice(s.indexOf("const monthVault = await monthlyLeagueTreasuryForMonth"));
  before(monthly, "await guardModeration(chainId, period, at, built);", "const tx = await treasury.sealMonth(", "monthly: guard before sealMonth");
  const record = s.slice(s.indexOf("async function recordPostedRoot"), s.indexOf("async function mwlStillOwed"));
  assert.match(record, /endGuardedPublish\(pool, leagueEpochLockKey/);
});

test("admin league root: guarded before the wallet is even built", () => {
  const s = src("../leagueRoot.js");
  before(s, "const guard = await beginGuardedPublish(", "const wallet = new ethers.Wallet(pk, provider);", "guard before the signer");
});

test("league claim: the hold check runs before the proof is built", () => {
  const s = src("../league.js");
  const claim = s.slice(s.indexOf("if (action === \"claim\") {"));
  before(claim, "await leagueWinnerHold(client,", "buildMerkleProof(leaves, leafIndex)", "hold check before proof");
});

test("recruiter payout: lock, blanket hold check, then the held-row filter; Solana proof refused when held", () => {
  const s = src("../dev-fix/recruiter-payouts.js");
  const evm = s.slice(s.indexOf("const moderated = await moderationHoldsAvailable(client);"));
  before(evm, "pg_advisory_xact_lock(hashtext($1))", "const payoutHold = await recruiterPayoutHold(", "lock before the hold read");
  before(evm, "const payoutHold = await recruiterPayoutHold(", "const ledgerResult = await client.query(lockedRows", "hold read before the rows are locked");
  before(evm, "const ledgerResult = await client.query(lockedRows", "sendRecruiterPayout(chain, payoutWallet, amountRaw)", "rows before the send");
  assert.match(evm, /\$\{moderated \? `and \$\{recruiterLedgerNotHeldSql\("l"\)\}` : ""\}/);
  const sol = s.slice(s.indexOf("const prepared = await preparedSolanaClaim("));
  before(sol, "if (solanaHold) return json(res, 409", "proof: Array.isArray(prepared.merkle_proof)", "Solana: hold check before the proof");
});

test("reward claim intent and batch publish refuse held rewards first", () => {
  const intent = src("../dev-fix/reward-claim-closeout-router.js");
  const body = intent.slice(intent.indexOf("export async function rewardClaimIntent"));
  before(body, "await rewardLedgerHolds(pool, rewardIds(body))", "await routedRewardClaimIntent(req, captured.response)", "hold check before the claim intent");
  const ops = src("../dev-fix/reward-batch-ops.js");
  const update = ops.slice(ops.indexOf("async function updateBatchStatus"));
  before(update, "await rewardLedgerHolds(client,", "update public.reward_batches", "hold check before publish");
});
