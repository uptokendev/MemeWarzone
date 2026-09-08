import { pool } from "../../server/db.js";
import { readJson } from "../../server/http.js";
import { requireWalletActionAuth } from "../lib/walletActionAuth.js";
import {
  RewardClaimVerificationError,
} from "../lib/rewardClaimVerification.js";
import {
  bnbNormalBattleEntitlementIdentity,
  isBnbNormalBattleReward,
  recoverBnbNormalBattleClaim,
} from "../lib/bnbBattleClaimRecovery.js";
import {
  rewardClaimConfig,
  rewardClaimIntent as genericRewardClaimIntent,
  rewardClaimRecord,
} from "./reward-claim-intent-generic.js";

export { rewardClaimConfig, rewardClaimRecord };

const BNB_CHAINS = new Set([56, 97]);
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;

function json(res, status, payload) {
  return res.status(status).json({ ok: status < 400, ...payload });
}

function normalizeWallet(value) {
  return String(value || "").trim().toLowerCase();
}

function readMeta(row) {
  const value = row?.metadata;
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)) || {}; } catch { return {}; }
}

function proofFor(row) {
  const meta = readMeta(row);
  const proof = Array.isArray(meta.merkleProof)
    ? meta.merkleProof
    : Array.isArray(meta.proof)
      ? meta.proof
      : Array.isArray(meta.claimProof)
        ? meta.claimProof
        : null;
  if (!proof) throw new RewardClaimVerificationError("MISSING_MERKLE_PROOF", "Normal Battle reward is missing its Merkle proof.");
  const normalized = proof.map((item) => String(item || "").trim());
  if (!normalized.every((item) => BYTES32_RE.test(item))) {
    throw new RewardClaimVerificationError("INVALID_MERKLE_PROOF", "Normal Battle reward Merkle proof is invalid.");
  }
  return normalized;
}

function callFor(row, identity) {
  const proof = proofFor(row);
  return {
    rewardLedgerId: String(row.id),
    chainId: identity.chainId,
    tokenSymbol: "BNB",
    mode: "reward_distributor_merkle",
    enabled: true,
    reason: null,
    distributorAddress: identity.distributorAddress,
    contractAddress: identity.distributorAddress,
    contractName: "RewardDistributor",
    functionName: "claim",
    functionSignature: "claim(bytes32,uint256,bytes32[])",
    contractBatchId: identity.contractBatchId,
    batchId: identity.contractBatchId,
    amount: identity.amount,
    proof,
    args: [identity.contractBatchId, identity.amount, proof],
    explorerTxBase: identity.chainId === 97 ? "https://testnet.bscscan.com/tx/" : "https://bscscan.com/tx/",
  };
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

async function authBattle(req, res, body, wallet, chainId) {
  const verified = await requireWalletActionAuth({
    res, pool, auth: body.auth || body, expectedWallet: wallet, chainId,
    action: "claim_intent", routeLabel: "rewards/claim_intent",
  });
  if (!verified) return null;
  if (verified.legacy) {
    json(res, 401, { error: "Wallet signature required for reward claims.", code: "WALLET_SIGNATURE_REQUIRED" });
    return null;
  }
  return verified;
}

async function refreshBatches(client, ids) {
  const { rows } = await client.query(
    `select distinct batch_id from public.reward_batch_items where reward_ledger_id = any($1::uuid[]) and batch_id is not null`,
    [ids],
  );
  for (const { batch_id: batchId } of rows) {
    await client.query(
      `update public.reward_batches rb set
         recipient_count = s.recipient_count,
         claimable_count = s.claimable_count,
         claimed_count = s.claimed_count,
         failed_count = s.failed_count,
         metadata = coalesce(rb.metadata,'{}'::jsonb) || jsonb_build_object(
           'claimPendingCount',s.claim_pending_count,'claimPendingAmount',s.claim_pending_amount,'lastClaimStatusRefreshAt',now()),
         updated_at = now()
       from (
         select count(*)::int recipient_count,
                count(*) filter (where coalesce(rl.status,rbi.status)='claimable')::int claimable_count,
                count(*) filter (where coalesce(rl.status,rbi.status)='claim_pending')::int claim_pending_count,
                count(*) filter (where coalesce(rl.status,rbi.status)='claimed')::int claimed_count,
                count(*) filter (where coalesce(rl.status,rbi.status)='failed')::int failed_count,
                coalesce(sum(coalesce(rl.amount,rbi.amount)) filter (where coalesce(rl.status,rbi.status)='claim_pending'),0)::text claim_pending_amount
           from public.reward_batch_items rbi left join public.reward_ledger rl on rl.id=rbi.reward_ledger_id
          where rbi.batch_id=$1::uuid) s
       where rb.id=$1::uuid`,
      [batchId],
    );
  }
}

async function persistRecovered(client, row, identity, evidence, req) {
  const txHash = String(evidence?.txHash || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new RewardClaimVerificationError("CLAIM_RECOVERY_TX_MISSING", "Recovered claim has no authoritative transaction hash.", 503);
  }
  if (row.claim_tx_hash && String(row.claim_tx_hash).toLowerCase() !== txHash.toLowerCase()) {
    throw new RewardClaimVerificationError("CLAIM_ALREADY_RECORDED", "Existing recorded transaction is immutable.");
  }
  const { rows: conflicts } = await client.query(
    `select id from public.reward_ledger where lower(coalesce(claim_tx_hash,''))=lower($1) and id<>$2::uuid limit 1`,
    [txHash, row.id],
  );
  if (conflicts.length) throw new RewardClaimVerificationError("CLAIM_TX_ALREADY_USED", "Recovered transaction belongs to another entitlement.");

  const recovery = { entitlement: identity, evidence: { ...evidence, reconciledAt: new Date().toISOString() } };
  const { rows } = await client.query(
    `update public.reward_ledger set
       status='claimed', claim_tx_hash=coalesce(claim_tx_hash,$2), claim_error=null,
       claimed_at=coalesce(claimed_at,now()),
       metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('claimRecovery',$3::jsonb), updated_at=now()
     where id=$1::uuid and (claim_tx_hash is null or lower(claim_tx_hash)=lower($2)) returning *`,
    [row.id, txHash, JSON.stringify(recovery)],
  );
  if (!rows[0]) throw new RewardClaimVerificationError("CLAIM_ALREADY_RECORDED", "Existing recorded transaction is immutable.");
  await client.query(`update public.reward_batch_items set status='claimed' where reward_ledger_id=$1::uuid`, [row.id]);
  await client.query(
    `insert into public.reward_audit_logs
       (reward_ledger_id,actor_type,actor_id,action,old_value,new_value,reason,tx_hash,metadata)
     values ($1,'api',$2,'battle_claim_reconciled_onchain',$3,'claimed',
       'Recovered BNB Normal Battle claim from authoritative RewardDistributor evidence',$4,$5::jsonb)`,
    [row.id, String(req?.headers?.["x-user-email"] || "api"), row.status, txHash, JSON.stringify(recovery)],
  );
  return rows[0];
}

function knownError(error) {
  if (error instanceof RewardClaimVerificationError) return { status: error.status || 409, code: error.code, message: error.message };
  return null;
}

export async function rewardClaimIntent(req, res) {
  const body = await readJson(req);
  req.body = body;
  const ids = Array.isArray(body.rewardLedgerIds) ? body.rewardLedgerIds.map(String) : [body.rewardLedgerId || body.id].filter(Boolean).map(String);
  const chainId = Number(body.chainId || 56);
  const wallet = normalizeWallet(body.address || body.walletAddress);
  if (!ids.length || !wallet || !BNB_CHAINS.has(chainId)) return genericRewardClaimIntent(req, res);

  let probe;
  try {
    probe = await pool.query(`select id,reward_type,chain from public.reward_ledger where id=any($1::uuid[]) and wallet_address=$2`, [ids, wallet]);
  } catch {
    return genericRewardClaimIntent(req, res);
  }
  if (probe.rows.length !== ids.length || !probe.rows.every(isBnbNormalBattleReward)) return genericRewardClaimIntent(req, res);

  if (!(await authBattle(req, res, body, wallet, chainId))) return;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `select * from public.reward_ledger where id=any($1::uuid[]) and wallet_address=$2 order by created_at asc for update`,
      [ids, wallet],
    );
    if (rows.length !== ids.length || !rows.every(isBnbNormalBattleReward)) {
      throw new RewardClaimVerificationError("BATTLE_CLAIM_IDENTITY_MISMATCH", "Normal Battle claim identity changed during recovery.");
    }

    const output = [];
    const calls = [];
    const pending = [];
    let recoveredCount = 0;
    for (const row of rows) {
      const identity = bnbNormalBattleEntitlementIdentity(row, { requestedChainId: chainId, requestedWallet: wallet });
      if (row.status === "claimed" && row.claim_tx_hash) {
        output.push(row);
        continue;
      }
      if (!["claimable","claim_pending","failed","claimed"].includes(String(row.status))) {
        throw new RewardClaimVerificationError("CLAIM_STATE_INVALID", "Normal Battle reward is not claimable or recoverable.");
      }
      const recovered = await recoverBnbNormalBattleClaim({ row, requestedChainId: chainId, requestedWallet: wallet });
      if (recovered.claimed) {
        output.push(await persistRecovered(client, row, recovered.identity, recovered.evidence, req));
        recoveredCount += 1;
        continue;
      }
      if (row.status === "claimed") {
        throw new RewardClaimVerificationError(
          "CLAIM_DB_CHAIN_STATE_MISMATCH",
          "Database marks this Battle prize claimed but RewardDistributor does not. Refusing another payout request.",
          503,
        );
      }
      calls.push(callFor(row, identity));
      pending.push(row.id);
      output.push(row);
    }

    let intentId = output.find((row) => row.claim_batch_id)?.claim_batch_id || `battle-claim-${Date.now()}`;
    if (pending.length) {
      const changed = await client.query(
        `update public.reward_ledger set status='claim_pending',claim_batch_id=coalesce(claim_batch_id,$3),claim_error=null,updated_at=now()
         where id=any($1::uuid[]) and wallet_address=$2 and status in ('claimable','claim_pending','failed') returning *`,
        [pending, wallet, intentId],
      );
      if (changed.rows.length !== pending.length) throw new RewardClaimVerificationError("CLAIM_STATE_INVALID", "Battle claim state changed while preparing retry.");
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
        id: intentId, walletAddress: wallet, chainId, mode: "reward_distributor_merkle",
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
    console.error("[rewards/bnb-battle-claim-recovery]", error);
    return json(res, 500, { error: "Server error" });
  } finally {
    client.release();
  }
}
