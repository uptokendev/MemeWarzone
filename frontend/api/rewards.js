import { pool } from "../server/db.js";
import {
  badMethod,
  getQuery,
  isAddress,
  isSolanaAddress,
  json,
  normalizeWalletFlexible,
  readJson,
} from "../server/http.js";
import { discoverEvmRewardClaim } from "./lib/evmRewardReconciliation.js";
import { discoverSolanaRewardClaim } from "./lib/solanaRewardReconciliation.js";
import { canonicalSolanaClaimIdentity, solanaClaimIdentityFromMetadata } from "./lib/solanaClaimEnvironment.js";

const SOLANA_CHAINS = new Set([101]);
const EVM_CHAINS = new Set([56, 97, 4663, 46630]);
const RECOVERABLE_REWARD_TYPES = new Set(["airdrop", "squad"]);
const RECOVERABLE_STATUSES = new Set(["claim_pending", "failed"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;

async function refreshBatchCounts(client, rewardLedgerId) {
  const { rows } = await client.query(
    `select distinct batch_id
       from public.reward_batch_items
      where reward_ledger_id = $1::uuid
        and batch_id is not null`,
    [rewardLedgerId],
  );

  for (const row of rows) {
    await client.query(
      `update public.reward_batches rb
          set recipient_count = stats.recipient_count,
              claimable_count = stats.claimable_count,
              claimed_count = stats.claimed_count,
              failed_count = stats.failed_count,
              metadata = coalesce(rb.metadata, '{}'::jsonb) || jsonb_build_object(
                'claimPendingCount', stats.claim_pending_count,
                'claimPendingAmount', stats.claim_pending_amount,
                'lastClaimStatusRefreshAt', now()
              ),
              updated_at = now()
         from (
           select count(*)::int as recipient_count,
                  count(*) filter (where coalesce(rl.status, rbi.status) = 'claimable')::int as claimable_count,
                  count(*) filter (where coalesce(rl.status, rbi.status) = 'claim_pending')::int as claim_pending_count,
                  count(*) filter (where coalesce(rl.status, rbi.status) = 'claimed')::int as claimed_count,
                  count(*) filter (where coalesce(rl.status, rbi.status) = 'failed')::int as failed_count,
                  coalesce(sum(coalesce(rl.amount, rbi.amount)) filter (where coalesce(rl.status, rbi.status) = 'claim_pending'), 0)::text as claim_pending_amount
             from public.reward_batch_items rbi
             left join public.reward_ledger rl on rl.id = rbi.reward_ledger_id
            where rbi.batch_id = $1::uuid
         ) stats
        where rb.id = $1::uuid`,
      [row.batch_id],
    );
  }
}

async function finalizeRecoveredClaim(row, verification) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `select *
         from public.reward_ledger
        where id = $1::uuid
        for update`,
      [row.id],
    );
    const current = rows[0];
    if (!current) {
      await client.query("rollback");
      return { rewardLedgerId: String(row.id), status: "missing" };
    }

    if (String(current.wallet_address || "") !== String(row.wallet_address || "") || Number(current.chain) !== Number(row.chain)) {
      const error = new Error("Reward entitlement changed during reconciliation");
      error.code = "REWARD_RECONCILE_ROW_CHANGED";
      throw error;
    }

    if (current.status === "claimed") {
      if (current.claim_tx_hash && String(current.claim_tx_hash).toLowerCase() !== String(verification.txHash || "").toLowerCase()) {
        const error = new Error("Recorded reward transaction is immutable");
        error.code = "CLAIM_ALREADY_RECORDED";
        throw error;
      }
      await client.query("commit");
      return {
        rewardLedgerId: String(current.id),
        status: "already_claimed",
        txHash: current.claim_tx_hash || verification.txHash,
      };
    }

    if (!RECOVERABLE_STATUSES.has(String(current.status || ""))) {
      await client.query("commit");
      return { rewardLedgerId: String(current.id), status: "not_recoverable" };
    }

    const reused = await client.query(
      `select id
         from public.reward_ledger
        where lower(coalesce(claim_tx_hash, '')) = lower($1)
          and id <> $2::uuid
        limit 1`,
      [verification.txHash, current.id],
    );
    if (reused.rows.length) {
      const error = new Error("Confirmed claim transaction is already attached to another reward entitlement");
      error.code = "CLAIM_TX_REUSED";
      throw error;
    }

    const isSolanaRecovery = Boolean(verification.claimReceiptAddress);
    const reconciledAt = new Date().toISOString();
    const claimVerification = {
      ...verification,
      reconciliationSource: isSolanaRecovery ? "deterministic_claim_receipt" : "reward_claimed_event",
      reconciledAt,
    };

    const update = await client.query(
      `update public.reward_ledger
          set status = 'claimed',
              claim_tx_hash = coalesce(claim_tx_hash, $2),
              claim_error = null,
              claimed_at = coalesce(claimed_at, now()),
              metadata = coalesce(metadata, '{}'::jsonb)
                || jsonb_build_object(
                  'claimVerification', $3::jsonb,
                  'claimReconciledAt', $4::text
                ),
              updated_at = now()
        where id = $1::uuid
          and (claim_tx_hash is null or lower(claim_tx_hash) = lower($2))`,
      [current.id, verification.txHash, JSON.stringify(claimVerification), reconciledAt],
    );
    if (!update.rowCount) {
      const error = new Error("Recorded reward transaction is immutable");
      error.code = "CLAIM_ALREADY_RECORDED";
      throw error;
    }

    await client.query(
      `update public.reward_batch_items
          set status = 'claimed'
        where reward_ledger_id = $1::uuid`,
      [current.id],
    );

    await client.query(
      `insert into public.reward_audit_logs
        (reward_ledger_id, actor_type, actor_id, action, old_value, new_value, reason, tx_hash, metadata)
       values
        ($1::uuid, 'system', $5, 'claim_reconciled_onchain', $2, 'claimed',
         $6, $3, $4::jsonb)`,
      [
        current.id,
        current.status,
        verification.txHash,
        JSON.stringify(claimVerification),
        isSolanaRecovery ? "solana-reconciler" : "evm-reconciler",
        isSolanaRecovery
          ? "Recovered confirmed Solana claim from deterministic receipt PDA"
          : "Recovered confirmed EVM RewardDistributor claim from exact on-chain event",
      ],
    );

    await refreshBatchCounts(client, current.id);
    await client.query("commit");
    return {
      rewardLedgerId: String(current.id),
      status: "reconciled",
      txHash: verification.txHash,
      claimReceiptAddress: verification.claimReceiptAddress || null,
      slot: verification.slot ?? null,
      blockNumber: verification.blockNumber ?? null,
    };
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function rewardMetadata(row) {
  const raw = row?.metadata;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function firstText(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function evmRewardDistributor(row, chainId) {
  const chain = Number(chainId);
  const meta = rewardMetadata(row);
  const fromMeta = firstText(meta, [
    "distributorAddress",
    "rewardDistributorAddress",
    "claimContractAddress",
    "contractAddress",
  ]);
  if (ADDRESS_RE.test(fromMeta)) return fromMeta;
  const chainSpecific = String(
    process.env[`REWARD_DISTRIBUTOR_ADDRESS_${chain}`] ||
    process.env[`VITE_REWARD_DISTRIBUTOR_ADDRESS_${chain}`] ||
    (chain === 97 ? process.env.BNB_TESTNET_REWARD_DISTRIBUTOR_ADDRESS : "") ||
    (chain === 56 ? process.env.BNB_REWARD_DISTRIBUTOR_ADDRESS : "") ||
    (chain === 56 ? process.env.REWARD_DISTRIBUTOR_ADDRESS_BNB : "") ||
    ((chain === 56 || chain === 97) ? process.env.REWARD_DISTRIBUTOR_ADDRESS : "") ||
    ((chain === 56 || chain === 97) ? process.env.VITE_REWARD_DISTRIBUTOR_ADDRESS : "") ||
    "",
  ).trim();
  return ADDRESS_RE.test(chainSpecific) ? chainSpecific : "";
}

function evmRewardBatchId(row) {
  const meta = rewardMetadata(row);
  const value = firstText(meta, [
    "contractBatchId",
    "merkleBatchId",
    "batchIdBytes32",
    "rewardBatchBytes32",
    "claimBatchBytes32",
  ]);
  return BYTES32_RE.test(value) ? value : "";
}

async function reconcileEvmClaims(res, body) {
  if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });
  const chainId = Number(body?.chainId);
  const walletAddress = normalizeWalletFlexible(body?.walletAddress || body?.address);
  const rawIds = Array.isArray(body?.rewardLedgerIds) ? body.rewardLedgerIds : [];
  const rewardLedgerIds = Array.from(new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean)));

  if (!EVM_CHAINS.has(chainId)) return json(res, 400, { error: "Reconciliation is only available for EVM reward chains" });
  if (!walletAddress || !isAddress(walletAddress)) return json(res, 400, { error: "Invalid EVM wallet address" });
  if (!rewardLedgerIds.length) return json(res, 200, { reconciledCount: 0, items: [], unresolved: [] });
  if (rewardLedgerIds.length > 10) return json(res, 400, { error: "At most 10 reward claims can be reconciled per request" });
  if (rewardLedgerIds.some((id) => !UUID_RE.test(id))) return json(res, 400, { error: "Invalid reward ledger id" });

  try {
    const { rows } = await pool.query(
      `select *
         from public.reward_ledger
        where id = any($1::uuid[])
          and lower(wallet_address) = lower($2)
          and chain::text = $3::text
          and status = any($4::text[])
        order by created_at asc`,
      [rewardLedgerIds, walletAddress, String(chainId), Array.from(RECOVERABLE_STATUSES)],
    );

    const items = [];
    const unresolved = [];
    for (const row of rows) {
      try {
        const distributorAddress = evmRewardDistributor(row, chainId);
        const batchId = evmRewardBatchId(row);
        if (!distributorAddress || !batchId) {
          unresolved.push({ rewardLedgerId: String(row.id), reason: "claim_metadata_missing", code: "EVM_CLAIM_METADATA_MISSING" });
          continue;
        }
        const verification = await discoverEvmRewardClaim({
          chainId,
          walletAddress,
          distributorAddress,
          batchId,
          amount: String(row.amount || "0"),
          expectedMerkleRoot: firstText(rewardMetadata(row), ["merkleRoot", "root"]),
          claimableAt: row.claimable_at,
          minConfirmations: Number(process.env[`REWARD_CLAIM_MIN_CONFIRMATIONS_${chainId}`] || process.env.REWARD_CLAIM_MIN_CONFIRMATIONS || 1),
        });
        if (!verification) {
          unresolved.push({ rewardLedgerId: String(row.id), reason: "not_claimed_onchain", code: "EVM_CLAIM_NOT_FOUND" });
          continue;
        }
        items.push(await finalizeRecoveredClaim(row, verification));
      } catch (error) {
        console.warn(`[api/rewards] EVM reconciliation deferred for ${row.id}:`, error?.code || error?.message || error);
        unresolved.push({
          rewardLedgerId: String(row.id),
          reason: "verification_pending",
          code: error?.code || "EVM_CLAIM_RECONCILE_PENDING",
        });
      }
    }

    return json(res, 200, {
      walletAddress,
      chainId,
      requestedCount: rewardLedgerIds.length,
      checkedCount: rows.length,
      reconciledCount: items.filter((item) => item.status === "reconciled").length,
      items,
      unresolved,
      reconciledAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/rewards:reconcile-evm]", error);
    if (error?.code === "42P01" || error?.code === "42703") {
      return json(res, 503, { error: "Reward reconciliation schema is not installed", code: "REWARD_SCHEMA_MISSING" });
    }
    return json(res, 500, { error: "Server error", code: error?.code || "REWARD_RECONCILE_FAILED" });
  }
}

async function reconcileSolanaClaims(res, body) {
  if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

  const chainId = Number(body?.chainId);
  const walletAddress = normalizeWalletFlexible(body?.walletAddress || body?.address);
  const rawIds = Array.isArray(body?.rewardLedgerIds) ? body.rewardLedgerIds : [];
  const rewardLedgerIds = Array.from(new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean)));

  if (chainId === 102) return json(res, 400, { error: "Solana chain 102 claim authority is retired", code: "LEGACY_SOLANA_CLAIM_CHAIN_RETIRED" });
  if (!SOLANA_CHAINS.has(chainId)) return json(res, 400, { error: "Reconciliation is only available for canonical Solana chain 101" });
  if (!walletAddress || !isSolanaAddress(walletAddress)) return json(res, 400, { error: "Invalid Solana wallet address" });
  if (!rewardLedgerIds.length) return json(res, 200, { reconciledCount: 0, items: [], unresolved: [] });
  if (rewardLedgerIds.length > 10) return json(res, 400, { error: "At most 10 reward claims can be reconciled per request" });
  if (rewardLedgerIds.some((id) => !UUID_RE.test(id))) return json(res, 400, { error: "Invalid reward ledger id" });

  let requestIdentity;
  try {
    requestIdentity = canonicalSolanaClaimIdentity({
      chainId,
      environment: body?.environment,
      solanaCluster: body?.solanaCluster,
    });
  } catch (error) {
    return json(res, Number(error?.status) || 409, { error: error?.message || "Invalid Solana claim environment", code: error?.code || "INVALID_ENVIRONMENT" });
  }

  try {
    const { rows } = await pool.query(
      `select *
         from public.reward_ledger
        where id = any($1::uuid[])
          and wallet_address = $2
          and chain::text = $3::text
          and reward_type = any($4::text[])
          and status = any($5::text[])
        order by created_at asc`,
      [
        rewardLedgerIds,
        walletAddress,
        String(chainId),
        Array.from(RECOVERABLE_REWARD_TYPES),
        Array.from(RECOVERABLE_STATUSES),
      ],
    );

    const items = [];
    const unresolved = [];
    for (const row of rows) {
      try {
        const rowIdentity = solanaClaimIdentityFromMetadata(row, requestIdentity);
        if (rowIdentity.environment !== requestIdentity.environment || rowIdentity.solanaCluster !== requestIdentity.solanaCluster) {
          const error = new Error("Reward entitlement belongs to a different Solana environment");
          error.code = "SOLANA_ENTITLEMENT_ENVIRONMENT_MISMATCH";
          throw error;
        }
        const verification = await discoverSolanaRewardClaim({
          row,
          walletAddress,
          signatureLimit: 8,
        });
        if (!verification) {
          unresolved.push({
            rewardLedgerId: String(row.id),
            reason: "receipt_missing",
            code: "SOLANA_CLAIM_RECEIPT_MISSING",
          });
          continue;
        }
        items.push(await finalizeRecoveredClaim(row, {
          ...verification,
          environment: requestIdentity.environment,
          solanaCluster: requestIdentity.solanaCluster,
        }));
      } catch (error) {
        console.warn(`[api/rewards] Solana reconciliation deferred for ${row.id}:`, error?.code || error?.message || error);
        unresolved.push({
          rewardLedgerId: String(row.id),
          reason: "verification_pending",
          code: error?.code || "SOLANA_CLAIM_RECONCILE_PENDING",
        });
      }
    }

    return json(res, 200, {
      walletAddress,
      chainId,
      environment: requestIdentity.environment,
      solanaCluster: requestIdentity.solanaCluster,
      requestedCount: rewardLedgerIds.length,
      checkedCount: rows.length,
      reconciledCount: items.filter((item) => item.status === "reconciled").length,
      items,
      unresolved,
      reconciledAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/rewards:reconcile-solana]", error);
    if (error?.code === "42P01" || error?.code === "42703") {
      return json(res, 503, { error: "Reward reconciliation schema is not installed", code: "REWARD_SCHEMA_MISSING" });
    }
    return json(res, 500, { error: "Server error", code: error?.code || "REWARD_RECONCILE_FAILED" });
  }
}

export default async function handler(req, res) {
  if (req.method === "POST") {
    const body = await readJson(req);
    req.body = body;
    const action = String(body?.action || "").trim().toLowerCase();
    if (action === "reconcile-evm-claims") return reconcileEvmClaims(res, body);
    if (action === "reconcile-solana-claims") return reconcileSolanaClaims(res, body);
    return json(res, 400, { error: "Unsupported rewards action" });
  }
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = Number(q.chainId);
    const address = normalizeWalletFlexible(q.address);
    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (!address || (!isAddress(address) && !isSolanaAddress(address))) {
      return json(res, 400, { error: "Invalid address" });
    }
    if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

    const recipientClause = isSolanaAddress(address)
      ? "(w.recipient_address = $2 OR lower(w.recipient_address) = lower($2))"
      : "lower(w.recipient_address) = $2";

    const { rows } = await pool.query(
      `SELECT
          w.period,
          w.epoch_start AS "epochStart",
          w.epoch_end AS "epochEnd",
          w.expires_at AS "expiresAt",
          w.category,
          w.rank,
          w.amount_raw AS "amountRaw",
          w.payload,
          w.computed_at AS "computedAt"
        FROM league_epoch_winners w
        LEFT JOIN league_epoch_claims c
          ON c.chain_id = w.chain_id
         AND c.period = w.period
         AND c.epoch_start = w.epoch_start
         AND c.category = w.category
         AND c.rank = w.rank
        WHERE w.chain_id = $1
          AND ${recipientClause}
          AND c.claimed_at IS NULL
          AND (w.expires_at IS NULL OR w.expires_at > NOW())
        ORDER BY w.epoch_start DESC, w.period DESC, w.category ASC, w.rank ASC`,
      [chainId, address],
    );

    return json(res, 200, {
      address,
      chainId,
      rewards: rows.map((r) => ({
        period: r.period,
        epochStart: r.epochStart,
        epochEnd: r.epochEnd,
        expiresAt: r.expiresAt,
        category: r.category,
        rank: r.rank,
        amountRaw: r.amountRaw,
        payload: r.payload,
        computedAt: r.computedAt,
      })),
    });
  } catch (e) {
    const code = e?.code;
    console.error("[api/rewards]", e);
    if (code === "42P01" || code === "42703") {
      return json(res, 200, { rewards: [], warning: "DB schema missing league epoch tables" });
    }
    return json(res, 500, { error: "Server error" });
  }
}
