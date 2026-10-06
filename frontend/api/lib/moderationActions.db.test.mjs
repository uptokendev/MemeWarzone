// Moderation hold / release / void (B7) against a throwaway Postgres: the migration, every state
// transition, idempotency, audit rows, published-item refusal, the publish guard, permissions, and
// the claim guards in the real handlers (league claim, reward claim intent, reward batch publish).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

process.env.DBC_THROWAY_PG_PORT ||= "55497";
const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
process.env.PG_DISABLE_SSL = "1";
process.env.TREASURY_VAULT_V2_ADDRESS_56 = "0xC9286EE3390A4dC642340bd703396E6B7b2521d5";
const db = pg.pool;

test.after(async () => {
  const { pool } = await import("../../server/db.js");
  await pool?.end?.().catch(() => {});
  await pg.stop();
});

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
await db.query(read("../../shared/moderationHolds.test-schema.sql"));
const MIGRATION = read("../../../db/migrations/20261006_000020_moderation_holds.sql");
await db.query(MIGRATION);

const holds = await import("../../shared/moderationHolds.mjs");
const { applyModerationAction, parseModerationAction, ModerationActionError, decorateModerationRows, loadModerationState, listModerationLog } = await import("./moderationActions.js");
const { createModerationHandler } = await import("../admin/moderation.js");

const OWNER = { email: "founder@example.test", memberId: null };
const E1 = "2026-09-21T00:00:00.000Z";
const E2 = "2026-09-14T00:00:00.000Z";
const E3 = "2026-09-07T00:00:00.000Z";
const signer = ethers.Wallet.createRandom();
const W1 = signer.address.toLowerCase();
const W2 = "0x00000000000000000000000000000000000000b2";
const W3 = "0x00000000000000000000000000000000000000b3";
const W4 = "0x00000000000000000000000000000000000000b4";

async function winner(epoch, category, rank, recipient, amount, payload = {}) {
  await db.query(
    `insert into public.league_epoch_winners (chain_id, period, epoch_start, epoch_end, category, rank, recipient_address, amount_raw, payload, expires_at)
     values (56, 'weekly', $1::timestamptz, $1::timestamptz + interval '7 days', $2, $3, $4, $5, $6::jsonb, now() + interval '90 days')`,
    [epoch, category, rank, recipient, amount, JSON.stringify({ wallet: recipient, ...payload })],
  );
}
await winner(E1, "top_earner", 1, W1, "300");
await winner(E1, "top_earner", 2, W2, "200");
await winner(E1, "top_earner", 3, W3, "100");
await winner(E1, "recruiter_league", 1, W4, "50", { recruiterId: 7 });
await winner(E2, "top_earner", 1, W4, "400");
await db.query(`insert into public.league_epoch_roots (chain_id, period, epoch_start, root, total_lamports, winners, epoch_address) values (56, 'weekly', $1, '0xroot', 400, 1, '0xvault')`, [E2]);
await winner(E3, "top_earner", 1, W2, "500");
await db.query(`insert into public.league_epoch_claims (chain_id, period, epoch_start, category, rank, recipient_address) values (56, 'weekly', $1, 'top_earner', 1, $2)`, [E3, W2]);

const key = (epoch, category, rank) => holds.leagueSubjectKey({ chainId: 56, period: "weekly", epochStart: epoch, category, rank });

async function act(body, principal = OWNER) {
  const input = parseModerationAction(body);
  if (input.error) throw new Error(input.error);
  try {
    return await applyModerationAction(db, { input, principal });
  } catch (error) {
    if (error instanceof ModerationActionError) return { refused: true, status: error.status, code: error.code, message: error.message };
    throw error;
  }
}

async function auditCount(subjectKey) {
  const { rows } = await db.query(`select count(*)::int as n from public.moderation_audit_log where subject_key = $1`, [subjectKey]);
  return rows[0].n;
}

test("the migration is idempotent and leaves RLS on", async () => {
  await db.query(MIGRATION);
  const { rows } = await db.query(`select relname, relrowsecurity from pg_class where relname in ('moderation_holds', 'moderation_audit_log', 'moderation_publish_markers', 'league_epoch_winners_moderation_voided') order by relname`);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.relrowsecurity));
});

test("input: a reason is required and capped, a wallet cannot be voided, ids are validated", () => {
  assert.match(parseModerationAction({ subjectKind: "airdrop_item", subjectId: "airdrop:6f1c1a52-4c2e-4c0c-9f7b-1d2a3b4c5d6e", action: "hold", reason: " " }).error, /reason/);
  assert.match(parseModerationAction({ subjectKind: "airdrop_item", subjectId: "airdrop:6f1c1a52-4c2e-4c0c-9f7b-1d2a3b4c5d6e", action: "hold", reason: "x".repeat(501) }).error, /500/);
  assert.match(parseModerationAction({ subjectKind: "wallet", subjectId: W1, action: "void", reason: "abuse" }).error, /cannot be voided/);
  assert.match(parseModerationAction({ subjectKind: "league_winner", subjectId: "league:56:weekly:nope:top_earner:1", action: "hold", reason: "abuse" }).error, /league row id/);
  assert.match(parseModerationAction({ subjectKind: "airdrop_item", subjectId: "airdrop:1; drop table", action: "hold", reason: "abuse" }).error, /airdrop row id/);
  assert.equal(parseModerationAction({ subjectKind: "league_winner", subjectId: key(E1, "top_earner", 1), action: "hold", reason: "sybil" }).subjectKey, key(E1, "top_earner", 1));
});

test("league hold before publication: the epoch is held, idempotent, audited; release clears it", async () => {
  const id = key(E1, "top_earner", 1);
  const first = await act({ subjectKind: "league_winner", subjectId: id, action: "hold", reason: "wash trading review" });
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.hold.state, "held");
  assert.equal(first.published, false);
  assert.equal(await auditCount(id), 1);
  const held = await holds.heldLeagueWinners(db, { chainId: 56, period: "weekly", epochStart: E1 });
  assert.deepEqual(held.map((h) => [h.category, h.rank, h.subject_kind]), [["top_earner", 1, "league_winner"]]);
  assert.ok(await holds.leagueWinnerHold(db, { chainId: 56, period: "weekly", epochStart: E1, category: "top_earner", rank: 1 }));
  assert.equal(await holds.leagueWinnerHold(db, { chainId: 56, period: "weekly", epochStart: E1, category: "top_earner", rank: 2 }), null);

  const again = await act({ subjectKind: "league_winner", subjectId: id, action: "hold", reason: "again" });
  assert.equal(again.idempotent, true);
  assert.equal(await auditCount(id), 1, "a repeated action writes no audit row");

  const released = await act({ subjectKind: "league_winner", subjectId: id, action: "release", reason: "cleared after review" });
  assert.equal(released.hold.state, "released");
  assert.equal(released.hold.version, 2);
  assert.equal(await auditCount(id), 2);
  assert.deepEqual(await holds.heldLeagueWinners(db, { chainId: 56, period: "weekly", epochStart: E1 }), []);
  const releaseAgain = await act({ subjectKind: "league_winner", subjectId: id, action: "release", reason: "again" });
  assert.equal(releaseAgain.idempotent, true);
  const { entries } = await listModerationLog(db, { subjectKey: id });
  assert.deepEqual(entries.map((e) => [e.action, e.from_state, e.to_state, e.actor_email]), [["release", "held", "released", OWNER.email], ["hold", null, "held", OWNER.email]]);
});

test("league void before publication: row backed up and removed, other places unchanged, final", async () => {
  const id = key(E1, "top_earner", 2);
  const res = await act({ subjectKind: "league_winner", subjectId: id, action: "void", reason: "self-dealing confirmed" });
  assert.equal(res.hold.state, "voided");
  assert.equal(res.effects.placesRenumbered, false);
  const { rows } = await db.query(`select category, rank, recipient_address from public.league_epoch_winners where epoch_start = $1 order by category, rank`, [E1]);
  assert.deepEqual(rows.map((r) => [r.category, r.rank]), [["recruiter_league", 1], ["top_earner", 1], ["top_earner", 3]]);
  const backup = await db.query(`select rank, recipient_address, moderation_hold_id from public.league_epoch_winners_moderation_voided`);
  assert.equal(backup.rows.length, 1);
  assert.equal(backup.rows[0].recipient_address, W2);
  assert.equal(backup.rows[0].moderation_hold_id, res.hold.id);
  assert.equal((await act({ subjectKind: "league_winner", subjectId: id, action: "void", reason: "again" })).idempotent, true);
  assert.equal((await act({ subjectKind: "league_winner", subjectId: id, action: "release", reason: "undo" })).code, "ALREADY_VOIDED");
  assert.equal((await act({ subjectKind: "league_winner", subjectId: id, action: "hold", reason: "undo" })).code, "ALREADY_VOIDED");
  assert.equal(await auditCount(id), 1);
});

test("published league prize: hold is a claim guard only, void is refused; a claimed prize cannot be held", async () => {
  const id = key(E2, "top_earner", 1);
  const voidTry = await act({ subjectKind: "league_winner", subjectId: id, action: "void", reason: "too late" });
  assert.equal(voidTry.code, "ALREADY_PUBLISHED");
  const hold = await act({ subjectKind: "league_winner", subjectId: id, action: "hold", reason: "claim guard" });
  assert.equal(hold.published, true);
  assert.equal(hold.warnings[0].code, "CLAIM_GUARD_ONLY");
  assert.ok(await holds.leagueWinnerHold(db, { chainId: 56, period: "weekly", epochStart: E2, category: "top_earner", rank: 1 }));
  const { rows } = await db.query(`select count(*)::int as n from public.league_epoch_winners where epoch_start = $1`, [E2]);
  assert.equal(rows[0].n, 1, "a published row is never touched");
  const paid = await act({ subjectKind: "league_winner", subjectId: key(E3, "top_earner", 1), action: "hold", reason: "too late" });
  assert.equal(paid.code, "ALREADY_PAID");
  await act({ subjectKind: "league_winner", subjectId: id, action: "release", reason: "done" });
});

test("publish guard: a held prize blocks, a clean list leaves a marker that blocks moderation until cleared", async () => {
  const epochKey = holds.leagueEpochLockKey(56, "weekly", E1);
  await act({ subjectKind: "league_winner", subjectId: key(E1, "top_earner", 3), action: "hold", reason: "review" });
  const check = (client) => holds.heldLeagueWinners(client, { chainId: 56, period: "weekly", epochStart: E1 });
  const blocked = await holds.beginGuardedPublish(db, epochKey, check);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.problems.length, 1);
  assert.equal((await db.query(`select count(*)::int as n from public.moderation_publish_markers`)).rows[0].n, 0, "no marker when blocked");

  await act({ subjectKind: "league_winner", subjectId: key(E1, "top_earner", 3), action: "release", reason: "cleared ok" });
  const go = await holds.beginGuardedPublish(db, epochKey, check);
  assert.deepEqual(go, { ok: true, guarded: true });
  const during = await act({ subjectKind: "league_winner", subjectId: key(E1, "top_earner", 3), action: "void", reason: "late" });
  assert.equal(during.code, "PUBLISH_IN_PROGRESS");
  await holds.endGuardedPublish(db, epochKey);
  assert.equal((await db.query(`select count(*)::int as n from public.moderation_publish_markers`)).rows[0].n, 0);
});

test("blanket holds: a wallet holds its league prizes and rewards; a recruiter holds its Recruiter League prize", async () => {
  const w = await act({ subjectKind: "wallet", subjectId: W3, action: "hold", reason: "cluster review" });
  assert.equal(w.hold.wallet_key, W3);
  const held = await holds.heldLeagueWinners(db, { chainId: 56, period: "weekly", epochStart: E1 });
  assert.deepEqual(held.map((h) => [h.rank, h.subject_kind]), [[3, "wallet"]]);
  assert.ok((await holds.heldWalletKeys(db)).has(W3));
  await act({ subjectKind: "wallet", subjectId: W3, action: "release", reason: "cleared" });
  assert.equal((await holds.heldWalletKeys(db)).size, 0);

  await db.query(`insert into public.recruiters (id, wallet_address, code, display_name, status) overriding system value values (7, $1, 'r7', 'R7', 'active') on conflict do nothing`, [W4]);
  const r = await act({ subjectKind: "recruiter", subjectId: "recruiter:7", action: "hold", reason: "self-referral" });
  assert.equal(r.hold.recruiter_id, "7");
  const heldR = await holds.heldLeagueWinners(db, { chainId: 56, period: "weekly", epochStart: E1 });
  assert.deepEqual(heldR.map((h) => [h.category, h.subject_kind]), [["recruiter_league", "recruiter"]]);
  await act({ subjectKind: "recruiter", subjectId: "recruiter:7", action: "release", reason: "cleared ok" });
});

test("airdrop items: published -> claim guard only; unpublished -> void cancels; claimed -> refused", async () => {
  const batch = await db.query(`insert into public.reward_batches (reward_type, chain, token_symbol, status, metadata) values ('airdrop', '56', 'BNB', 'claim_open', '{"merkleRoot":"0xabc"}') returning id`);
  const a1 = (await db.query(`insert into public.reward_ledger (reward_type, wallet_address, chain, token_symbol, amount, status, metadata) values ('airdrop', $1, '56', 'BNB', 10, 'claimable', '{"merkleRoot":"0xabc"}') returning id`, [W1])).rows[0].id;
  await db.query(`insert into public.reward_batch_items (batch_id, reward_ledger_id, wallet_address, amount, status) values ($1, $2, $3, 10, 'claimable')`, [batch.rows[0].id, a1, W1]);
  const draft = await db.query(`insert into public.reward_batches (reward_type, chain, token_symbol, status) values ('squad', '56', 'BNB', 'ready') returning id`);
  const a2 = (await db.query(`insert into public.reward_ledger (reward_type, wallet_address, chain, token_symbol, amount, status) values ('squad', $1, '56', 'BNB', 20, 'approved') returning id`, [W2])).rows[0].id;
  await db.query(`insert into public.reward_batch_items (batch_id, reward_ledger_id, wallet_address, amount, status) values ($1, $2, $3, 20, 'approved')`, [draft.rows[0].id, a2, W2]);
  const a3 = (await db.query(`insert into public.reward_ledger (reward_type, wallet_address, chain, token_symbol, amount, status, claim_tx_hash) values ('airdrop', $1, '56', 'BNB', 30, 'claimed', '0x1') returning id`, [W3])).rows[0].id;

  assert.equal((await act({ subjectKind: "airdrop_item", subjectId: `airdrop:${a1}`, action: "void", reason: "late" })).code, "ALREADY_PUBLISHED");
  const h1 = await act({ subjectKind: "airdrop_item", subjectId: `airdrop:${a1}`, action: "hold", reason: "review" });
  assert.equal(h1.published, true);
  assert.deepEqual((await holds.rewardLedgerHolds(db, [a1, a2])).map((r) => r.id), [a1]);

  const v2 = await act({ subjectKind: "airdrop_item", subjectId: `airdrop:${a2}`, action: "void", reason: "duplicate account" });
  assert.equal(v2.effects.ledgerStatus, "cancelled");
  const row = (await db.query(`select status, metadata from public.reward_ledger where id = $1`, [a2])).rows[0];
  assert.equal(row.status, "cancelled");
  assert.equal(row.metadata.voidedReason, "duplicate account");
  assert.equal((await db.query(`select status from public.reward_batch_items where reward_ledger_id = $1`, [a2])).rows[0].status, "cancelled");

  assert.equal((await act({ subjectKind: "airdrop_item", subjectId: `airdrop:${a3}`, action: "hold", reason: "late" })).code, "ALREADY_PAID");

  // The batch publish path refuses a batch with a held or voided item.
  const { internalRewardBatchPublish } = await import("../dev-fix/reward-batch-ops.js");
  const res = fakeRes();
  await internalRewardBatchPublish({ method: "POST", params: { id: draft.rows[0].id }, body: { reason: "publish" }, headers: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "MODERATION_HOLD");
  assert.equal((await db.query(`select status from public.reward_batches where id = $1`, [draft.rows[0].id])).rows[0].status, "ready");

  // The claim intent refuses a held reward before anything else (no status change).
  const { rewardClaimIntent } = await import("../dev-fix/reward-claim-closeout-router.js");
  const claim = fakeRes();
  await rewardClaimIntent({ method: "POST", body: { rewardLedgerIds: [a1], chainId: 56, address: W1 }, headers: {} }, claim);
  assert.equal(claim.statusCode, 409);
  assert.equal(claim.body.code, "MODERATION_HOLD");
  assert.equal((await db.query(`select status from public.reward_ledger where id = $1`, [a1])).rows[0].status, "claimable");
  await act({ subjectKind: "airdrop_item", subjectId: `airdrop:${a1}`, action: "release", reason: "cleared ok" });
  const free = fakeRes();
  await rewardClaimIntent({ method: "POST", body: { rewardLedgerIds: [a1], chainId: 56, address: W1 }, headers: {} }, free);
  assert.notEqual(free.body?.code, "MODERATION_HOLD", "a released reward goes on to the normal claim checks");
});

test("recruiter credit: item hold leaves the payout sum, blanket hold stops the payout, void voids unpublished credit only", async () => {
  const acct = (await db.query(`insert into public.recruiter_accounts (signup_wallet, code, display_name) values ($1, 'r7', 'R7') returning recruiter_id`, [W4])).rows[0].recruiter_id;
  const ins = async (chain, status, amount, claimId = null) => (await db.query(
    `insert into public.recruiter_reward_ledger (recruiter_id, chain, token, amount_raw, status, chain_id, claim_id) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [acct, chain, chain === "solana" ? "SOL" : "BNB", amount, status, chain === "solana" ? 101 : 56, claimId],
  )).rows[0].id;
  const l1 = await ins("bnb", "claimable", 100);
  const l2 = await ins("bnb", "claimable", 200);
  const lPaid = await ins("bnb", "claimed", 50);
  const prepared = (await db.query(`insert into public.solana_reward_lane_batches (lane, chain_id, epoch_id, epoch_start, epoch_end, merkle_root, total_lamports, claim_deadline, program_id, vault_address, batch_address, status) values ('recruiter', 101, 11, now(), now(), '0x1', 5, 0, 'p', 'v', 'b', 'prepared') returning id`)).rows[0].id;
  const open = (await db.query(`insert into public.solana_reward_lane_batches (lane, chain_id, epoch_id, epoch_start, epoch_end, merkle_root, total_lamports, claim_deadline, program_id, vault_address, batch_address, status) values ('recruiter', 101, 10, now(), now(), '0x2', 6, 0, 'p', 'v', 'b', 'claim_open') returning id`)).rows[0].id;
  const c3 = (await db.query(`insert into public.recruiter_reward_claims (recruiter_id, chain, token, amount_raw, payout_wallet) values ($1, 'solana', 'SOL', 5, 'S1') returning id`, [acct])).rows[0].id;
  const c4 = (await db.query(`insert into public.recruiter_reward_claims (recruiter_id, chain, token, amount_raw, payout_wallet) values ($1, 'solana', 'SOL', 6, 'S2') returning id`, [acct])).rows[0].id;
  const l3 = await ins("solana", "claimable", 5, c3);
  const l4 = await ins("solana", "claimable", 6, c4);
  for (const [batch, claim, wallet] of [[prepared, c3, "S1"], [open, c4, "S2"]]) {
    await db.query(`insert into public.solana_reward_lane_claims (batch_id, lane, source_type, source_ref, wallet_address, amount_lamports, merkle_leaf, claim_receipt_address, status) values ($1, 'recruiter', 'recruiter_reward_claim', $2, $3, 1, 'x', 'r', $4)`, [batch, claim, wallet, batch === open ? "claimable" : "prepared"]);
  }

  // The same selection the EVM payout uses (recruiter-payouts.js lockedRows).
  const payable = async () => (await db.query(
    `select id from public.recruiter_reward_ledger l where recruiter_id = $1 and chain = 'bnb' and status = 'claimable' and claim_id is null and ${holds.recruiterLedgerNotHeldSql("l")} order by amount_raw`,
    [acct],
  )).rows.map((r) => r.id);
  assert.deepEqual(await payable(), [l1, l2]);
  const h = await act({ subjectKind: "recruiter_ledger", subjectId: `recruiter-ledger:${l1}`, action: "hold", reason: "review" });
  assert.equal(h.hold.account_id, acct);
  assert.deepEqual(await payable(), [l2], "a held row leaves the sum and stays claimable");
  assert.equal((await db.query(`select status from public.recruiter_reward_ledger where id = $1`, [l1])).rows[0].status, "claimable");
  assert.equal((await act({ subjectKind: "recruiter_ledger", subjectId: `recruiter-ledger:${lPaid}`, action: "hold", reason: "late" })).code, "ALREADY_PAID");
  assert.equal((await act({ subjectKind: "recruiter_ledger", subjectId: `recruiter-ledger:${l4}`, action: "void", reason: "late" })).code, "ALREADY_PUBLISHED");
  assert.ok(await holds.recruiterClaimHold(db, c3) === null);

  assert.equal(await holds.recruiterPayoutHold(db, { accountId: acct, payoutWallet: "0x00000000000000000000000000000000000000c1" }), null);
  await act({ subjectKind: "recruiter", subjectId: `recruiter-account:${acct}`, action: "hold", reason: "network review" });
  assert.ok(await holds.recruiterPayoutHold(db, { accountId: acct, payoutWallet: "0x00000000000000000000000000000000000000c1" }));
  assert.deepEqual(await payable(), [], "a held recruiter has nothing payable");
  assert.ok(await holds.recruiterClaimHold(db, c3), "the Solana claim of a held recruiter is refused");
  await act({ subjectKind: "recruiter", subjectId: `recruiter-account:${acct}`, action: "release", reason: "cleared ok" });

  const v = await act({ subjectKind: "recruiter", subjectId: `recruiter-account:${acct}`, action: "void", reason: "fraud confirmed" });
  assert.deepEqual(v.effects.voided.map((x) => x.id).sort(), [l1, l2, l3].sort(), "held, plain and prepared-batch credit is voided");
  assert.deepEqual(v.effects.skipped.map((x) => x.id), [l4], "credit in a published batch is not");
  const statuses = (await db.query(`select id, status from public.recruiter_reward_ledger where recruiter_id = $1`, [acct])).rows;
  for (const row of statuses) {
    const expect = row.id === lPaid ? "claimed" : row.id === l4 ? "claimable" : "failed";
    assert.equal(row.status, expect, row.id);
  }
  assert.ok(await holds.recruiterClaimHold(db, c3), "voided credit in a prepared batch blocks that claim");
  const again = await act({ subjectKind: "recruiter", subjectId: `recruiter-account:${acct}`, action: "void", reason: "again" });
  assert.equal(again.code, "NOTHING_TO_VOID");
});

test("league claim API: the proof of a held prize is refused, the nonce is not burnt; a free prize gets its proof", async () => {
  const { default: league } = await import("../league.js");
  const claim = async (rank) => {
    const nonce = `n-${Date.now()}-${rank}`;
    await db.query(`insert into public.auth_nonces (chain_id, address, nonce, expires_at) values (56, $1, $2, now() + interval '5 minutes') on conflict (chain_id, address) do update set nonce = excluded.nonce, used_at = null, expires_at = excluded.expires_at`, [W1, nonce]);
    const msg = ["MemeWarzone League", "Action: LEAGUE_CLAIM", "ChainId: 56", `Recipient: ${W1}`, "Period: weekly", `EpochStart: ${E1}`, "Category: top_earner", `Rank: ${rank}`, `Nonce: ${nonce}`].join("\n");
    const res = fakeRes();
    await league({ method: "POST", body: { action: "claim", chainId: 56, period: "weekly", epochStart: E1, category: "top_earner", rank, recipient: W1, nonce, signature: await signer.signMessage(msg) }, headers: {} }, res);
    return res;
  };
  await act({ subjectKind: "league_winner", subjectId: key(E1, "top_earner", 1), action: "hold", reason: "claim guard test" });
  const refused = await claim(1);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.code, "MODERATION_HOLD");
  assert.equal((await db.query(`select used_at from public.auth_nonces where address = $1`, [W1])).rows[0].used_at, null, "rolled back");
  await act({ subjectKind: "league_winner", subjectId: key(E1, "top_earner", 1), action: "release", reason: "cleared ok" });
  const ok = await claim(1);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.mode, "merkle");
  assert.ok(Array.isArray(ok.body.proof));
});

const principals = {
  view: { authUserId: "u1", email: "viewer@example.test", permissions: ["community.view"], isOwner: false },
  community: { authUserId: "u2", email: "mod@example.test", permissions: ["community.view", "community.manage"], isOwner: false },
  finance: { authUserId: "u3", email: "fin@example.test", permissions: ["finance.view", "finance.manage"], isOwner: false },
};

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(text) { this.text = text; return this; },
    end(text) {
      this.text = text;
      if (this.body == null && typeof text === "string") { try { this.body = JSON.parse(text); } catch { /* not JSON */ } }
    },
  };
}

function handler() {
  return createModerationHandler({
    getDb: async () => db,
    getPriceService: async () => ({ async hourly() { return new Map(); }, async valueEvents() { return { amountUsd: 0, priceBasis: null }; } }),
    resolvePrincipal: async (req, res) => {
      const p = principals[String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")];
      if (!p) { res.status(401).json({ ok: false }); return null; }
      return p;
    },
    can: (p, perm) => Boolean(p?.isOwner || p?.permissions.includes(perm)),
    env: {},
  });
}

async function call(h, path, { method = "GET", token, body } = {}) {
  const res = fakeRes();
  const url = new URL(path, "http://localhost");
  await h({ method, url: path, originalUrl: path, body, headers: token ? { authorization: `Bearer ${token}` } : {}, query: Object.fromEntries(url.searchParams.entries()) }, res);
  return res;
}

test("permissions: view sees states but cannot act; community.manage and finance.manage can", async () => {
  const h = handler();
  const body = { subjectKind: "wallet", subjectId: W2, action: "hold", reason: "permission test" };
  const denied = await call(h, "/api/admin/moderation/actions", { method: "POST", token: "view", body });
  assert.equal(denied.statusCode, 403);
  assert.equal((await db.query(`select count(*)::int as n from public.moderation_holds where subject_key = $1`, [holds.walletSubjectKey(W2)])).rows[0].n, 0);
  const viaGet = await call(h, "/api/admin/moderation/actions", { method: "GET", token: "community" });
  assert.equal(viaGet.statusCode, 405);
  const ok = await call(h, "/api/admin/moderation/actions", { method: "POST", token: "community", body });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.hold.created_by, "mod@example.test");
  const ok2 = await call(h, "/api/admin/moderation/actions", { method: "POST", token: "finance", body: { ...body, action: "release" } });
  assert.equal(ok2.statusCode, 200);
  const bad = await call(h, "/api/admin/moderation/actions", { method: "POST", token: "finance", body: { ...body, reason: "" } });
  assert.equal(bad.statusCode, 400);

  const list = await call(h, "/api/admin/moderation/leagues?includeTest=1", { token: "view" });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.canManage, false);
  assert.equal(list.body.moderationAvailable, true);
  // BNB 56 is a mainnet, so the fixtures are listed; the voided one comes from the backup.
  const voided = list.body.rows.find((r) => r.id === key(E1, "top_earner", 2));
  assert.equal(voided.status, "voided");
  assert.equal(voided.moderation.effective, "voided");
  assert.equal(voided.moderation.actions.hold, false);
  const published = list.body.rows.find((r) => r.id === key(E2, "top_earner", 1));
  assert.equal(published.moderation.actions.void, false);
  assert.match(published.moderation.note, /Already published/);
  const onlyVoided = await call(h, "/api/admin/moderation/leagues?includeTest=1&modState=voided", { token: "view" });
  assert.deepEqual(onlyVoided.body.rows.map((r) => r.id), [key(E1, "top_earner", 2)]);
  assert.equal((await call(h, "/api/admin/moderation/leagues?modState=bogus", { token: "view" })).statusCode, 400);

  const log = await call(h, "/api/admin/moderation/log?limit=5", { token: "view" });
  assert.equal(log.statusCode, 200);
  assert.equal(log.body.entries.length, 5);
  assert.ok(log.body.nextBefore);
});

test("decorate: blanket wallet hold shows on airdrop rows with release-wallet, state filter none", async () => {
  await act({ subjectKind: "wallet", subjectId: W2, action: "hold", reason: "decorate test" });
  const state = await loadModerationState(db);
  const rows = decorateModerationRows("airdrops", [{ id: "airdrop:x", wallet: W2.toUpperCase().replace("0X", "0x"), status: "claimable", published: true }, { id: "airdrop:y", wallet: W1, status: "pending", published: false }], state);
  assert.equal(rows[0].moderation.effective, "held");
  assert.equal(rows[0].moderation.actions.releaseWallet, true);
  assert.equal(rows[0].moderation.actions.void, false);
  assert.equal(rows[1].moderation.actions.void, true);
  await act({ subjectKind: "wallet", subjectId: W2, action: "release", reason: "done" });
});
