// Moderation holds (B7) in the indexer jobs, against a throwaway Postgres: the SQL is the API's
// (frontend/shared/moderationHolds.mjs, byte for byte), a voided prize's category is never settled
// again, an epoch with a held prize is held back from its root, held / voided / blanket-held recruiter
// credit stays out of the weekly batch, a prepared batch with held credit is not posted, and the
// publish guard leaves a marker. Plus source-order checks that each job asks before it sends.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DBC_THROWAY_PG_PORT ||= "55498";
process.env.ABLY_API_KEY ||= "test:test";
process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID ||= "Stake11111111111111111111111111111111111111";
// @ts-ignore -- plain JS helper
const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
process.env.PG_DISABLE_SSL = "1";
const db = pg.pool as any;

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
await db.query(read("../../../frontend/shared/moderationHolds.test-schema.sql"));
await db.query(read("../../../db/migrations/20261006_000020_moderation_holds.sql"));

const holds = await import("../rewards/moderationHolds.js");
// @ts-ignore -- the API's canonical copy, plain JS
const api = await import("../../../frontend/shared/moderationHolds.mjs");
const { loadPortalPayouts } = await import("../rewards/publishRecruiterSettlementV2.js");

test.after(async () => {
  const { pool } = await import("../db.js");
  await (pool as any)?.end?.().catch(() => {});
  await pg.stop();
});

test("the indexer SQL and lock keys are the API's, byte for byte", () => {
  assert.equal(holds.leagueHoldMatchSql("h", "w"), api.leagueHoldMatchSql("h", "w"));
  assert.equal(holds.recruiterLedgerHoldMatchSql("h", "l"), api.recruiterLedgerHoldMatchSql("h", "l"));
  assert.equal(holds.walletHoldMatchSql("h", "c.wallet_address"), api.walletHoldMatchSql("h", "c.wallet_address"));
  assert.equal(holds.MODERATION_GLOBAL_LOCK, api.MODERATION_GLOBAL_LOCK);
  assert.equal(holds.leagueEpochLockKey(101, "weekly", "2026-09-21T00:00:00Z"), api.leagueEpochLockKey(101, "weekly", "2026-09-21T00:00:00Z"));
  assert.equal(holds.recruiterBatchLockKey(101, 12), api.recruiterBatchLockKey(101, 12));
});

const E = "2026-09-21T00:00:00.000Z";
const SOL_A = "CVqCRi5cRVKBriiEuwcWtbx8EJ7inFHhxagagJZjS5Cf";
const SOL_B = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

async function hold(kind: string, key: string, state: string, extra: Record<string, unknown> = {}) {
  await db.query(
    `insert into public.moderation_holds (subject_kind, subject_key, subject, chain_id, wallet_key, recruiter_id, account_id, state, reason, created_by, updated_by)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, 'test reason', 'test', 'test')
     on conflict (subject_kind, subject_key) do update set state = excluded.state`,
    [kind, key, JSON.stringify(extra.subject || {}), extra.chainId ?? null, extra.walletKey ?? null, extra.recruiterId ?? null, extra.accountId ?? null, state],
  );
}

test("league: a voided prize keeps its category settled; a held prize or wallet holds the epoch back", async () => {
  for (const [rank, wallet] of [[1, SOL_A], [2, SOL_B]] as const) {
    await db.query(
      `insert into public.league_epoch_winners (chain_id, period, epoch_start, epoch_end, category, rank, recipient_address, amount_raw, payload)
       values (101, 'weekly', $1, $1::timestamptz + interval '7 days', 'top_earner', $2, $3, 1000, $4::jsonb)`,
      [E, rank, wallet, JSON.stringify({ wallet })],
    );
  }
  const ref = { chainId: 101, period: "weekly", epochStart: E, category: "top_earner" };
  assert.equal(await holds.voidedLeagueCategory(db, ref), false);
  assert.deepEqual(await holds.heldLeagueWinners(db, ref), []);

  await hold("league_winner", "league:101:weekly:2026-09-21T00:00:00.000Z:top_earner:2", "held", { chainId: 101, subject: { period: "weekly", epochStart: E, category: "top_earner", rank: 2 } });
  assert.deepEqual((await holds.heldLeagueWinners(db, ref)).map((h) => Number(h.rank)), [2]);
  assert.equal(await holds.voidedLeagueCategory(db, ref), false, "held is not voided");

  await hold("league_winner", "league:101:weekly:2026-09-21T00:00:00.000Z:top_earner:2", "voided");
  await db.query(`delete from public.league_epoch_winners where chain_id = 101 and rank = 2`);
  assert.equal(await holds.voidedLeagueCategory(db, ref), true, "settlement skips this category from now on");
  assert.equal(await holds.voidedLeagueCategory(db, { ...ref, category: "biggest_hit" }), false);
  assert.deepEqual(await holds.heldLeagueWinners(db, ref), [], "the voided row is gone, so the epoch can publish");

  await hold("wallet", `wallet:${SOL_A.toLowerCase()}`, "held", { walletKey: SOL_A.toLowerCase() });
  assert.deepEqual((await holds.heldLeagueWinners(db, ref)).map((h) => h.subject_kind), ["wallet"]);
  await hold("wallet", `wallet:${SOL_A.toLowerCase()}`, "released");
  assert.deepEqual(await holds.heldLeagueWinners(db, ref), []);
});

test("publish guard: problems block without a marker; a clean list writes one; end clears it", async () => {
  const key = holds.leagueEpochLockKey(101, "weekly", E);
  const blocked = await holds.beginGuardedPublish(db, key, async () => [{ reason: "x" }]);
  assert.equal(blocked.ok, false);
  assert.equal((await db.query(`select count(*)::int as n from public.moderation_publish_markers`)).rows[0].n, 0);
  assert.deepEqual(await holds.beginGuardedPublish(db, key, async () => []), { ok: true, guarded: true });
  assert.equal((await db.query(`select lock_key from public.moderation_publish_markers`)).rows[0].lock_key, key);
  await holds.endGuardedPublish(db, key);
  assert.equal((await db.query(`select count(*)::int as n from public.moderation_publish_markers`)).rows[0].n, 0);
});

test("recruiter batch: held, voided, held-recruiter and held-wallet credit stay out; a release brings it back", async () => {
  const acct = async (code: string, wallet: string) => {
    const id = (await db.query(`insert into public.recruiter_accounts (signup_wallet, code) values ($1, $2) returning recruiter_id`, [wallet, code])).rows[0].recruiter_id;
    await db.query(`insert into public.recruiter_payout_wallets (recruiter_id, chain, wallet_address, verified_at) values ($1, 'solana', $2, now())`, [id, wallet]);
    return id;
  };
  const a = await acct("ra", SOL_A);
  const b = await acct("rb", SOL_B);
  const credit = async (account: string, amount: string) => (await db.query(
    `insert into public.recruiter_reward_ledger (recruiter_id, chain, token, amount_raw, status, chain_id) values ($1, 'solana', 'SOL', $2, 'claimable', 101) returning id`,
    [account, amount],
  )).rows[0].id;
  const a1 = await credit(a, "10000000");
  const a2 = await credit(a, "20000000");
  await credit(b, "30000000");
  const sums = async () => Object.fromEntries((await loadPortalPayouts(null, db)).payouts.map((p: any) => [p.payoutWallet, p.amountRaw]));

  assert.deepEqual(await sums(), { [SOL_A]: "30000000", [SOL_B]: "30000000" });
  await hold("recruiter_ledger", `recruiter-ledger:${a1}`, "held");
  assert.deepEqual(await sums(), { [SOL_A]: "20000000", [SOL_B]: "30000000" }, "a held row leaves the sum");
  await hold("recruiter_ledger", `recruiter-ledger:${a2}`, "voided");
  assert.deepEqual(await sums(), { [SOL_B]: "30000000" }, "a voided row too (the API also sets it failed)");
  await hold("recruiter", `recruiter-account:${b}`, "held", { accountId: b });
  assert.deepEqual(await sums(), {}, "a held recruiter has nothing in the batch");
  await hold("recruiter", `recruiter-account:${b}`, "released");
  await hold("wallet", `wallet:${SOL_B.toLowerCase()}`, "held", { walletKey: SOL_B.toLowerCase() });
  assert.deepEqual(await sums(), {}, "a held payout wallet too");
  await hold("wallet", `wallet:${SOL_B.toLowerCase()}`, "released");
  await hold("recruiter_ledger", `recruiter-ledger:${a1}`, "released");
  assert.deepEqual(await sums(), { [SOL_A]: "10000000", [SOL_B]: "30000000" }, "released credit is picked up by the next export");

  // A prepared batch that carries held credit is not posted.
  const batch = (await db.query(`insert into public.solana_reward_lane_batches (lane, chain_id, epoch_id, epoch_start, epoch_end, merkle_root, total_lamports, claim_deadline, program_id, vault_address, batch_address) values ('recruiter', 101, 5, now(), now(), '0x1', 1, 0, 'p', 'v', 'b') returning id`)).rows[0].id;
  const claim = (await db.query(`insert into public.recruiter_reward_claims (recruiter_id, chain, token, amount_raw, payout_wallet) values ($1, 'solana', 'SOL', 1, $2) returning id`, [a, SOL_A])).rows[0].id;
  await db.query(`update public.recruiter_reward_ledger set claim_id = $1 where id = $2`, [claim, a1]);
  await db.query(`insert into public.solana_reward_lane_claims (batch_id, lane, source_type, source_ref, wallet_address, amount_lamports, merkle_leaf, claim_receipt_address) values ($1, 'recruiter', 'recruiter_reward_claim', $2, $3, 1, 'x', 'r')`, [batch, claim, SOL_A]);
  assert.deepEqual(await holds.heldPreparedRecruiterClaims(db, batch), []);
  await hold("recruiter_ledger", `recruiter-ledger:${a1}`, "held");
  assert.deepEqual((await holds.heldPreparedRecruiterClaims(db, batch)).map((r) => r.wallet), [SOL_A]);
  assert.deepEqual([...(await holds.heldRecruiterLedgerIds(db, [a1, a2]))].sort(), [a1, a2].sort());
});

test("source order: each job asks before it settles or sends", () => {
  const src = (rel: string) => read(rel);
  const finalize = src("../jobs/finalizeEpochWinners.ts");
  const loop = finalize.slice(finalize.indexOf("for (let i = 0; i < categories.length; i++)"));
  assert.ok(loop.indexOf("voidedLeagueCategory(") > 0 && loop.indexOf("voidedLeagueCategory(") < loop.indexOf("leagueLeaderboard(pool"), "settlement: voided check before the field is read");

  const league = src("../jobs/publishLeagueEpochRoot.ts");
  assert.ok(league.indexOf("beginGuardedPublish(") > 0 && league.indexOf("beginGuardedPublish(") < league.indexOf("sendServerV0(connection, signer, instruction"), "league root: guard before send");
  assert.ok(league.lastIndexOf("endGuardedPublish(") > league.indexOf("await recordRoot({\n        chainId: MAINNET_CHAIN_ID, period, epochStart: epochStartIso, root, total, winners: winners.length,\n        epochAddress: epochAddress.toBase58(), txHash, "), "league root: marker cleared after the record");

  const recruiter = src("../jobs/publishRecruiterSettlementRoot.ts");
  assert.ok(recruiter.indexOf("beginGuardedPublish(") > 0 && recruiter.indexOf("beginGuardedPublish(") < recruiter.indexOf("txHash = await sendServerV0("), "recruiter root: guard before send");

  const exportJob = src("../jobs/exportLeaguePayoutBatch.ts");
  assert.match(exportJob, /NOT EXISTS \(SELECT 1 FROM public\.moderation_holds h WHERE \$\{leagueHoldMatchSql\("h", "w"\)\}\)/);
});
