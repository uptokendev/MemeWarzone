import { pool } from "../../server/db.js";
import { readJson } from "../../server/http.js";
import { requireWalletActionAuth } from "../lib/walletActionAuth.js";
import { RewardClaimVerificationError } from "../lib/rewardClaimVerification.js";
import {
  buildNormalTournamentClaimCall,
  isNormalTournamentReward,
  normalTournamentEntitlementIdentity,
  recoverNormalTournamentClaim,
  verifyNormalTournamentClaim,
} from "../lib/normalTournamentClaimRecovery.js";
import {
  rewardClaimConfig,
  rewardClaimIntent as existingRewardClaimIntent,
  rewardClaimRecord as existingRewardClaimRecord,
} from "./reward-claim-battle-router.js";

export { rewardClaimConfig };

const SOLANA_CHAINS = new Set([101, 102]);
const TOURNAMENT_CHAINS = new Set([56, 97, 101, 102, 4663, 46630]);
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;

function json(res, status, payload) {
  return res.status(status).json({ ok: status < 400, ...payload });
}

function normalizeWallet(value, chainId) {
  const raw = String(value || "").trim();
  return SOLANA_CHAINS.has(Number(chainId)) ? raw : raw.toLowerCase();
}

function sameTx(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function knownError(error) {
  if (error instanceof RewardClaimVerificationError) return { status: error.status || 409, code: error.code, message: error.message };
  if (error?.code && Number(error?.status)) return { status: Number(error.status), code: error.code, message: error.message || "Tournament claim verification failed" };
  return null;
}

function ledgerItem(row) {
  return {
    id: String(row.id), rewardType: row.reward_type, walletAddress: row.wallet_address,
    chain: row.chain, chainId: Number(row.chain), tokenSymbol: row.token_symbol,
    amount: String(row.amount || "0"), status: row.status,
    claimBatchId: row.claim_batch_id || null, claimTxHash: row.claim_tx_hash || null,
    claimError: row.claim_error || null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function strictAuth({ res, body, wallet, chainId, action }) {
  const verified = await requireWalletActionAuth({
    res, pool, auth: body.auth || body, expectedWallet: wallet, chainId,
    action, routeLabel: action === "claim_record" ? "rewards/claim_record" : "rewards/claim_intent",
  });
  if (!verified) return null;
  if (verified.legacy) {
    json(res, 401, { error: "Wallet signature required for Tournament claims.", code: "WALLET_SIGNATURE_REQUIRED" });
    return null;
  }
  return verified;
}

async function refreshBatches(client, ids) {
  const { rows } = await client.query(
    `select distinct batch_id from public.reward_batch_items where reward_ledger_id=any($1::uuid[]) and batch_id is not null`,
    [ids],
  );
  for (const { batch_id: batchId } of rows) {
    await client.query(
      `update public.reward_batches rb set
         recipient_count=s.recipient_count, claimable_count=s.claimable_count,
         claimed_count=s.claimed_count, failed_count=s.failed_count,
         metadata=coalesce(rb.metadata,'{}'::jsonb)||jsonb_build_object(
           'claimPendingCount',s.claim_pending_count,'claimPendingAmount',s.claim_pending_amount,'lastClaimStatusRefreshAt',now()),
         updated_at=now()
       from (
         select count(*)::int recipient_count,
                count(*) filter(where coalesce(rl.status,rbi.status)='claimable')::int claimable_count,
                count(*) filter(where coalesce(rl.status,rbi.status)='claim_pending')::int claim_pending_count,
                count(*) filter(where coalesce(rl.status,rbi.status)='claimed')::int claimed_count,
                count(*) filter(where coalesce(rl.status,rbi.status)='failed')::int failed_count,
                coalesce(sum(coalesce(rl.amount,rbi.amount)) filter(where coalesce(rl.status,rbi.status)='claim_pending'),0)::text claim_pending_amount
           from public.reward_batch_items rbi left join public.reward_ledger rl on rl.id=rbi.reward_ledger_id
          where rbi.batch_id=$1::uuid) s where rb.id=$1::uuid`,
      [batchId],
    );
  }
}

async function persistClaimed(client, row, identity, evidence, req, action = "tournament_claim_reconciled_onchain") {
  const txHash = String(evidence?.txHash || "").trim();
  const validTx = SOLANA_CHAINS.has(identity.chainId) ? SOLANA_SIGNATURE_RE.test(txHash) : EVM_TX_RE.test(txHash);
  if (!validTx) throw new RewardClaimVerificationError("CLAIM_RECOVERY_TX_MISSING", "Tournament claim has no authoritative transaction identity.", 503);
  if (row.claim_tx_hash && !sameTx(row.claim_tx_hash, txHash)) throw new RewardClaimVerificationError("CLAIM_ALREADY_RECORDED", "Existing Tournament claim transaction is immutable.", 409);
  const { rows: conflicts } = await client.query(
    `select id from public.reward_ledger where lower(coalesce(claim_tx_hash,''))=lower($1) and id<>$2::uuid limit 1`,
    [txHash, row.id],
  );
  if (conflicts.length) throw new RewardClaimVerificationError("CLAIM_TX_ALREADY_USED", "Tournament payout transaction belongs to another entitlement.", 409);

  const recovery = { entitlement: identity, evidence: { ...evidence, reconciledAt: new Date().toISOString() } };
  const { rows } = await client.query(
    `update public.reward_ledger set status='claimed',claim_tx_hash=coalesce(claim_tx_hash,$2),claim_error=null,
       claimed_at=coalesce(claimed_at,now()),metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('tournamentClaimRecovery',$3::jsonb),updated_at=now()
     where id=$1::uuid and (claim_tx_hash is null or lower(claim_tx_hash)=lower($2)) returning *`,
    [row.id, txHash, JSON.stringify(recovery)],
  );
  if (!rows[0]) throw new RewardClaimVerificationError("CLAIM_ALREADY_RECORDED", "Existing Tournament claim transaction is immutable.", 409);
  await client.query(`update public.reward_batch_items set status='claimed' where reward_ledger_id=$1::uuid`, [row.id]);
  const auditExisting = await client.query(
    `select 1 from public.reward_audit_logs where reward_ledger_id=$1::uuid and action=$2 and lower(coalesce(tx_hash,''))=lower($3) limit 1`,
    [row.id, action, txHash],
  );
  if (!auditExisting.rows.length) {
    await client.query(
      `insert into public.reward_audit_logs
        (reward_ledger_id,actor_type,actor_id,action,old_value,new_value,reason,tx_hash,metadata)
       values ($1,'api',$2,$3,$4,'claimed','Normal Tournament payout verified against chain-native authority',$5,$6::jsonb)`,
      [row.id, String(req?.headers?.["x-user-email"] || "api"), action, row.status, txHash, JSON.stringify(recovery)],
    );
  }
  return rows[0];
}

async function tournamentProbe(ids, wallet) {
  try {
    const { rows } = await pool.query(
      `select id,reward_type,chain,metadata from public.reward_ledger where id=any($1::uuid[]) and wallet_address=$2`,
      [ids, wallet],
    );
    return rows.length === ids.length && rows.every(isNormalTournamentReward);
  } catch { return false; }
}

export async function rewardClaimIntent(req, res) {
  const body = await readJson(req);
  req.body = body;
  const ids = Array.isArray(body.rewardLedgerIds) ? body.rewardLedgerIds.map(String) : [body.rewardLedgerId || body.id].filter(Boolean).map(String);
  const chainId = Number(body.chainId || 56);
  const wallet = normalizeWallet(body.address || body.walletAddress, chainId);
  if (!ids.length || !wallet || !TOURNAMENT_CHAINS.has(chainId) || !(await tournamentProbe(ids, wallet))) {
    return existingRewardClaimIntent(req, res);
  }
  if (!(await strictAuth({ res, body, wallet, chainId, action: "claim_intent" }))) return;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `select * from public.reward_ledger where id=any($1::uuid[]) and wallet_address=$2 order by created_at asc for update`,
      [ids, wallet],
    );
    if (rows.length !== ids.length || !rows.every(isNormalTournamentReward)) throw new RewardClaimVerificationError("TOURNAMENT_CLAIM_IDENTITY_MISMATCH", "Tournament claim identity changed during recovery.", 409);

    const output = [];
    const calls = [];
    const pending = [];
    let recoveredCount = 0;
    for (const row of rows) {
      const identity = normalTournamentEntitlementIdentity(row, { requestedChainId: chainId, requestedWallet: wallet });
      if (row.status === "claimed" && row.claim_tx_hash) { output.push(row); continue; }
      if (!["claimable", "claim_pending", "failed", "claimed"].includes(String(row.status))) throw new RewardClaimVerificationError("CLAIM_STATE_INVALID", "Tournament reward is not claimable or recoverable.", 409);
      const recovered = await recoverNormalTournamentClaim({ row, requestedChainId: chainId, requestedWallet: wallet });
      if (recovered.claimed) {
        output.push(await persistClaimed(client, row, recovered.identity, recovered.evidence, req));
        recoveredCount += 1;
        continue;
      }
      if (row.status === "claimed") throw new RewardClaimVerificationError("CLAIM_DB_CHAIN_STATE_MISMATCH", "Database marks Tournament prize claimed but chain authority does not. Refusing another payout request.", 503);
      calls.push(buildNormalTournamentClaimCall(row));
      pending.push(row.id);
      output.push(row);
    }

    const intentId = output.find((row) => row.claim_batch_id)?.claim_batch_id || `tournament-claim-${Date.now()}`;
    if (pending.length) {
      const changed = await client.query(
        `update public.reward_ledger set status='claim_pending',claim_batch_id=coalesce(claim_batch_id,$3),claim_error=null,updated_at=now()
         where id=any($1::uuid[]) and wallet_address=$2 and status in ('claimable','claim_pending','failed') returning *`,
        [pending, wallet, intentId],
      );
      if (changed.rows.length !== pending.length) throw new RewardClaimVerificationError("CLAIM_STATE_INVALID", "Tournament claim state changed while preparing retry.", 409);
      await client.query(`update public.reward_batch_items set status='claim_pending' where reward_ledger_id=any($1::uuid[])`, [pending]);
      for (const changedRow of changed.rows) {
        const index = output.findIndex((item) => String(item.id) === String(changedRow.id));
        if (index >= 0) output[index] = changedRow;
      }
    }
    await refreshBatches(client, ids);
    await client.query("commit");
    const requiresWalletTransaction = calls.length > 0;
    return json(res, requiresWalletTransaction ? 202 : 200, {
      claimIntent: {
        id: intentId, walletAddress: wallet, chainId, mode: "normal_tournament_native",
        requiresWalletTransaction, calls, recovered: recoveredCount > 0, reconciledCount: recoveredCount,
      },
      items: output.map(ledgerItem), recovered: recoveredCount > 0,
      idempotent: !requiresWalletTransaction && recoveredCount === 0,
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    const known = knownError(error);
    if (known) return json(res, known.status, { error: known.message, code: known.code });
    console.error("[rewards/normal-tournament-claim-recovery]", error);
    return json(res, 500, { error: "Server error" });
  } finally { client.release(); }
}

export async function rewardClaimRecord(req, res) {
  const body = await readJson(req);
  req.body = body;
  const ids = Array.isArray(body.rewardLedgerIds) ? body.rewardLedgerIds.map(String) : [body.rewardLedgerId || body.id].filter(Boolean).map(String);
  const chainId = Number(body.chainId || 56);
  const wallet = normalizeWallet(body.address || body.walletAddress, chainId);
  const failed = String(body.status || "claimed").toLowerCase() === "failed";
  if (!ids.length || !wallet || ids.length !== 1 || !TOURNAMENT_CHAINS.has(chainId) || !(await tournamentProbe(ids, wallet)) || failed) {
    return existingRewardClaimRecord(req, res);
  }
  if (!(await strictAuth({ res, body, wallet, chainId, action: "claim_record" }))) return;
  const txHash = String(body.txHash || body.claimTxHash || "").trim();
  const validTx = SOLANA_CHAINS.has(chainId) ? SOLANA_SIGNATURE_RE.test(txHash) : EVM_TX_RE.test(txHash);
  if (!validTx) return json(res, 400, { error: "Missing or invalid txHash" });

  let candidate;
  try {
    const result = await pool.query(`select * from public.reward_ledger where id=$1::uuid and wallet_address=$2 limit 1`, [ids[0], wallet]);
    candidate = result.rows[0];
    if (!candidate) return json(res, 404, { error: "Tournament entitlement was not found for this wallet." });
    if (candidate.status === "claimed" && candidate.claim_tx_hash) {
      if (!sameTx(candidate.claim_tx_hash, txHash)) return json(res, 409, { error: "Tournament reward already finalized with a different transaction.", code: "CLAIM_ALREADY_RECORDED" });
      return json(res, 200, { items: [ledgerItem(candidate)], idempotent: true, materializedAt: new Date().toISOString() });
    }
    await verifyNormalTournamentClaim({ row: candidate, txHash, requestedChainId: chainId, requestedWallet: wallet });
  } catch (error) {
    const known = knownError(error);
    if (known) return json(res, known.status, { error: known.message, code: known.code });
    console.error("[rewards/normal-tournament-record verify]", error);
    return json(res, 503, { error: "Could not verify Tournament claim transaction on-chain.", code: "CLAIM_VERIFY_UNAVAILABLE" });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(`select * from public.reward_ledger where id=$1::uuid and wallet_address=$2 for update`, [ids[0], wallet]);
    const row = rows[0];
    if (!row || !isNormalTournamentReward(row)) throw new RewardClaimVerificationError("TOURNAMENT_CLAIM_IDENTITY_MISMATCH", "Tournament claim identity changed while recording.", 409);
    normalTournamentEntitlementIdentity(row, { requestedChainId: chainId, requestedWallet: wallet });
    if (row.status === "claimed" && row.claim_tx_hash) {
      if (!sameTx(row.claim_tx_hash, txHash)) throw new RewardClaimVerificationError("CLAIM_ALREADY_RECORDED", "Existing Tournament transaction is immutable.", 409);
      await client.query("commit");
      return json(res, 200, { items: [ledgerItem(row)], idempotent: true, materializedAt: new Date().toISOString() });
    }
    const verified = await verifyNormalTournamentClaim({ row, txHash, requestedChainId: chainId, requestedWallet: wallet });
    const claimed = await persistClaimed(client, row, normalTournamentEntitlementIdentity(row, { requestedChainId: chainId, requestedWallet: wallet }), verified, req, "tournament_claim_recorded_onchain");
    await refreshBatches(client, ids);
    await client.query("commit");
    return json(res, 200, { items: [ledgerItem(claimed)], verification: verified, materializedAt: new Date().toISOString() });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    const known = knownError(error);
    if (known) return json(res, known.status, { error: known.message, code: known.code });
    console.error("[rewards/normal-tournament-record]", error);
    return json(res, 500, { error: "Server error" });
  } finally { client.release(); }
}
