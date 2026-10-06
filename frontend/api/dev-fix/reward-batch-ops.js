import { AbiCoder, concat, getAddress, keccak256, toUtf8Bytes } from "ethers";

import { pool } from "../../server/db.js";
import { readJson } from "../../server/http.js";
import { rewardLedgerHolds } from "../../shared/moderationHolds.mjs";

const REWARD_TYPES = new Set(["airdrop", "league", "recruiter", "squad", "battle", "tournament", "campaign", "manual", "future"]);
const BATCH_STATUSES = new Set(["draft", "calculating", "funding_check", "ready", "published", "claim_open", "paused", "failed", "closed", "archived"]);
const LEDGER_STATUSES = new Set(["pending", "approved", "claimable", "claim_pending", "claimed", "failed", "expired", "cancelled"]);
const ABI_CODER = AbiCoder.defaultAbiCoder();
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SAFE_RELATION_RE = /^public\.[a-z_][a-z0-9_]*$/;

function methodAllowed(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader("Allow", methods.join(", "));
  res.status(405).json({ error: "Method not allowed" });
  return false;
}

function json(res, status, payload) {
  return res.status(status).json({ ok: status < 400, ...payload });
}

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function normalizeRewardType(value, fallback = "manual") {
  const raw = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return REWARD_TYPES.has(raw) ? raw : fallback;
}

function normalizeStatus(value, allowed, fallback) {
  const raw = String(value || fallback).trim().toLowerCase();
  return allowed.has(raw) ? raw : fallback;
}

function normalizeWallet(value, chain) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (Number(chain) === 101 || Number(chain) === 102 || String(chain).toLowerCase() === "solana") return raw;
  return raw.toLowerCase();
}

function readMeta(row) {
  const meta = row?.metadata;
  if (!meta) return {};
  if (typeof meta === "object") return meta;
  try {
    const parsed = JSON.parse(String(meta));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function batchItem(row) {
  const metadata = readMeta(row);
  return {
    id: String(row.id),
    rewardType: row.reward_type,
    chain: row.chain,
    chainId: Number(row.chain) || null,
    tokenSymbol: row.token_symbol,
    status: row.status,
    totalAmount: String(row.total_amount ?? "0"),
    recipientCount: Number(row.recipient_count || 0),
    claimableCount: Number(row.claimable_count || 0),
    claimPendingCount: Number(metadata.claimPendingCount || 0),
    claimPendingAmount: String(metadata.claimPendingAmount ?? "0"),
    claimedCount: Number(row.claimed_count || 0),
    failedCount: Number(row.failed_count || 0),
    source: row.source || null,
    metadata,
    createdAt: toIso(row.created_at),
    publishedAt: toIso(row.published_at),
    closedAt: toIso(row.closed_at),
  };
}

function ledgerItem(row) {
  return {
    id: String(row.id),
    rewardType: row.reward_type,
    sourceId: row.source_id || null,
    sourceLabel: row.source_label || null,
    walletAddress: row.wallet_address,
    userId: row.user_id || null,
    chain: row.chain,
    chainId: Number(row.chain) || null,
    tokenSymbol: row.token_symbol,
    amount: String(row.amount ?? "0"),
    amountUsd: row.amount_usd == null ? null : String(row.amount_usd),
    status: row.status,
    claimBatchId: row.claim_batch_id || null,
    claimTxHash: row.claim_tx_hash || null,
    claimError: row.claim_error || null,
    metadata: readMeta(row),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    claimableAt: toIso(row.claimable_at),
    claimedAt: toIso(row.claimed_at),
    expiresAt: toIso(row.expires_at),
  };
}

function actorId(req) {
  return String(req?.headers?.["x-admin-email"] || req?.headers?.["x-user-email"] || "api");
}

async function writeAudit(client, { batchId = null, rewardLedgerId = null, action, oldValue = null, newValue = null, reason = null, req = null, txHash = null, metadata = {} }) {
  await client.query(
    `insert into public.reward_audit_logs (batch_id, reward_ledger_id, actor_type, actor_id, action, old_value, new_value, reason, tx_hash, metadata)
     values ($1, $2, 'api', $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [batchId, rewardLedgerId, actorId(req), action, oldValue, newValue, reason, txHash, JSON.stringify(metadata || {})],
  );
}

function preparedRecipients(body) {
  const raw = Array.isArray(body.recipients) ? body.recipients : Array.isArray(body.items) ? body.items : [];
  return raw
    .map((item) => ({
      walletAddress: String(item.walletAddress || item.wallet_address || item.address || "").trim(),
      amount: String(item.amount ?? item.payoutAmount ?? item.payout_amount ?? "0"),
      amountUsd: item.amountUsd ?? item.amount_usd ?? null,
      status: normalizeStatus(item.status || body.ledgerStatus || body.entryStatus, LEDGER_STATUSES, body.publish ? "claimable" : "approved"),
      sourceId: item.sourceId || item.source_id || body.sourceId || null,
      sourceLabel: item.sourceLabel || item.source_label || body.sourceLabel || null,
      userId: item.userId || item.user_id || null,
      metadata: item.metadata || item.metadataJson || {},
    }))
    .filter((item) => item.walletAddress && Number.isFinite(Number(item.amount)) && Number(item.amount) >= 0);
}

function hasPreparedRecipients(body) {
  return preparedRecipients(body).length > 0;
}

function wantsAutomaticCalculation(body) {
  const mode = String(body.calculationMode || body.mode || "").trim().toLowerCase();
  return Boolean(body.auto || body.automatic || mode === "auto" || mode === "automatic");
}

function safeSourceRelation(body) {
  const relation = String(body.sourceView || body.sourceTable || body.inputView || "public.reward_calculation_inputs").trim();
  return SAFE_RELATION_RE.test(relation) ? relation : "public.reward_calculation_inputs";
}

async function relationExists(client, relation) {
  const { rows } = await client.query(`select to_regclass($1) as relation_name`, [relation]);
  return Boolean(rows[0]?.relation_name);
}

function normalizeAutoRow(row, body, index) {
  const chain = String(row.chain ?? row.chain_id ?? body.chain ?? body.chainId ?? 56);
  const status = normalizeStatus(row.status || body.ledgerStatus || body.entryStatus, LEDGER_STATUSES, body.publish ? "claimable" : "approved");
  return {
    walletAddress: String(row.wallet_address || row.walletAddress || row.address || "").trim(),
    amount: String(row.amount ?? row.payout_amount ?? row.payoutAmount ?? "0"),
    amountUsd: row.amount_usd ?? row.amountUsd ?? null,
    status,
    sourceId: row.source_id || row.sourceId || row.id || `${body.program || "airdrop"}-${index + 1}`,
    sourceLabel: row.source_label || row.sourceLabel || body.program || "automatic_reward_candidate",
    userId: row.user_id || row.userId || null,
    metadata: {
      ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
      autoCalculated: true,
      sourceRelation: safeSourceRelation(body),
      sourceScore: row.score ?? row.weight ?? row.activity_score ?? null,
      chain,
    },
  };
}

async function buildAutomaticRecipients(client, body, rewardType) {
  const manual = preparedRecipients(body);
  if (manual.length || !wantsAutomaticCalculation(body)) return { recipients: manual, metadata: { autoCalculation: false } };

  const relation = safeSourceRelation(body);
  const exists = await relationExists(client, relation);
  const chain = String(body.chain || body.chainId || 56);
  const program = String(body.program || body.rewardProgram || rewardType || "airdrop");
  const epochId = body.epochId || body.epoch_id || null;
  const limit = Math.min(Math.max(Number(body.limit || 100) || 100, 1), 1000);

  if (!exists) {
    return {
      recipients: [],
      metadata: {
        autoCalculation: true,
        autoCalculationReady: false,
        sourceRelation: relation,
        missingSourceRelation: true,
        calculationWarning: `${relation} does not exist yet`,
      },
    };
  }

  const { rows } = await client.query(
    `select *
       from ${relation}
      where ($1::text is null or reward_type::text = $1::text or program::text = $1::text)
        and ($2::text is null or chain::text = $2::text or chain_id::text = $2::text)
        and ($3::text is null or epoch_id::text = $3::text)
      order by coalesce(score, weight, activity_score, amount, payout_amount, 0) desc, wallet_address asc
      limit $4`,
    [program || null, chain || null, epochId == null ? null : String(epochId), limit],
  );

  const recipients = rows.map((row, index) => normalizeAutoRow(row, body, index)).filter((item) => item.walletAddress && Number(item.amount) > 0);
  return {
    recipients,
    metadata: {
      autoCalculation: true,
      autoCalculationReady: recipients.length > 0,
      sourceRelation: relation,
      candidateRows: rows.length,
      recipientRows: recipients.length,
      calculationLimit: limit,
    },
  };
}

function isBnbClaimChain(chain) {
  const id = Number(chain);
  return id === 56 || id === 97;
}

function integerAmount(value) {
  const raw = String(value ?? "0").trim();
  if (/^\d+$/.test(raw)) return raw.replace(/^0+(?=\d)/, "") || "0";
  if (/^\d+\.0+$/.test(raw)) return raw.split(".")[0].replace(/^0+(?=\d)/, "") || "0";
  return "";
}

function cleanBytes32(value) {
  const raw = String(value || "").trim();
  return BYTES32_RE.test(raw) ? raw : "";
}

function cleanAddress(value) {
  const raw = String(value || "").trim();
  if (!ADDRESS_RE.test(raw)) return "";
  try {
    return getAddress(raw);
  } catch {
    return "";
  }
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function contractBatchIdFor(batch, body, metadata) {
  const supplied = cleanBytes32(firstString(body, ["contractBatchId", "merkleBatchId", "batchIdBytes32", "rewardBatchBytes32", "claimBatchBytes32"]))
    || cleanBytes32(firstString(metadata, ["contractBatchId", "merkleBatchId", "batchIdBytes32", "rewardBatchBytes32", "claimBatchBytes32"]));
  return supplied || keccak256(toUtf8Bytes(`mwz-reward-batch:${batch.id}`));
}

function distributorAddressFor(body, metadata) {
  return cleanAddress(firstString(body, ["distributorAddress", "rewardDistributorAddress", "claimContractAddress", "contractAddress"]))
    || cleanAddress(firstString(metadata, ["distributorAddress", "rewardDistributorAddress", "claimContractAddress", "contractAddress"]));
}

function claimDeadlineFor(body, metadata) {
  const raw = firstString(body, ["claimDeadline", "claim_deadline", "claimDeadlineTs", "claim_deadline_ts"])
    || firstString(metadata, ["claimDeadline", "claim_deadline", "claimDeadlineTs", "claim_deadline_ts"]);
  const value = Number(raw || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function rewardLeaf(walletAddress, amount) {
  const account = getAddress(walletAddress);
  const inner = keccak256(ABI_CODER.encode(["address", "uint256"], [account, BigInt(amount)]));
  return keccak256(inner);
}

function hashPair(a, b) {
  const leftFirst = a.toLowerCase() <= b.toLowerCase();
  return keccak256(concat(leftFirst ? [a, b] : [b, a]));
}

function buildMerkleTree(leaves) {
  if (!leaves.length) return { root: "", proofs: [] };
  const levels = [leaves.map((leaf) => leaf.leaf)];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? hashPair(current[i], current[i + 1]) : current[i]);
    }
    levels.push(next);
  }

  const proofs = leaves.map((_leaf, leafIndex) => {
    const proof = [];
    let index = leafIndex;
    for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
      const level = levels[levelIndex];
      const pairIndex = index % 2 === 0 ? index + 1 : index - 1;
      if (pairIndex < level.length) proof.push(level[pairIndex]);
      index = Math.floor(index / 2);
    }
    return proof;
  });

  return { root: levels[levels.length - 1][0], proofs };
}

function buildClaimMetadataPlan({ batch, recipients, chain, body, metadata }) {
  if (!isBnbClaimChain(chain)) return { batchClaimMetadata: {}, recipientClaimMetadata: new Map() };

  const leaves = [];
  for (const [index, recipient] of recipients.entries()) {
    if (recipient.status !== "claimable") continue;
    const amount = integerAmount(recipient.amount);
    if (!amount || amount === "0") continue;
    try {
      const wallet = getAddress(normalizeWallet(recipient.walletAddress, chain));
      leaves.push({ index, wallet, amount, leaf: rewardLeaf(wallet, amount) });
    } catch {}
  }

  if (!leaves.length) return { batchClaimMetadata: {}, recipientClaimMetadata: new Map() };

  const contractBatchId = contractBatchIdFor(batch, body, metadata);
  const distributorAddress = distributorAddressFor(body, metadata);
  const claimDeadline = claimDeadlineFor(body, metadata);
  const { root, proofs } = buildMerkleTree(leaves);
  const totalClaimableAmount = leaves.reduce((sum, leaf) => sum + BigInt(leaf.amount), 0n).toString();
  const batchClaimMetadata = {
    claimMode: "reward_distributor_merkle",
    claimContract: "RewardDistributor",
    contractBatchId,
    merkleBatchId: contractBatchId,
    merkleRoot: root,
    merkleRecipientCount: leaves.length,
    merkleTotalAmount: totalClaimableAmount,
    merkleLeafEncoding: "keccak256(bytes.concat(keccak256(abi.encode(account, amount))))",
    merklePairSorting: "openzeppelins_commutative_hash",
    claimDeadline,
    ...(distributorAddress ? { distributorAddress, rewardDistributorAddress: distributorAddress } : {}),
  };

  const recipientClaimMetadata = new Map();
  leaves.forEach((leaf, proofIndex) => {
    recipientClaimMetadata.set(leaf.index, {
      claimMode: "reward_distributor_merkle",
      claimContract: "RewardDistributor",
      contractBatchId,
      merkleBatchId: contractBatchId,
      merkleRoot: root,
      merkleProof: proofs[proofIndex],
      merkleLeaf: leaf.leaf,
      claimAmount: leaf.amount,
      claimDeadline,
      ...(distributorAddress ? { distributorAddress, rewardDistributorAddress: distributorAddress } : {}),
    });
  });

  return { batchClaimMetadata, recipientClaimMetadata };
}

async function insertBatchWithRecipients(client, req, body, overrides = {}) {
  const rewardType = normalizeRewardType(overrides.rewardType || body.rewardType || body.reward_type, "manual");
  const chain = String(overrides.chain || body.chain || body.chainId || body.chain_id || 56);
  const tokenSymbol = String(overrides.tokenSymbol || body.tokenSymbol || body.token_symbol || (Number(chain) === 101 ? "SOL" : "BNB"));
  const recipients = preparedRecipients({ ...body, ...overrides });
  const fallbackStatus = overrides.status || body.status || (body.publish ? "published" : recipients.length ? "ready" : "draft");
  const status = normalizeStatus(fallbackStatus, BATCH_STATUSES, "draft");
  const totalAmount = recipients.reduce((sum, item) => sum + BigInt(integerAmount(item.amount) || "0"), 0n).toString();
  const claimableCount = recipients.filter((item) => item.status === "claimable").length;
  const claimedCount = recipients.filter((item) => item.status === "claimed").length;
  const failedCount = recipients.filter((item) => item.status === "failed").length;
  const source = String(overrides.source || body.source || "manual_reward_ops");
  const metadata = {
    ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
    ...(overrides.metadata && typeof overrides.metadata === "object" ? overrides.metadata : {}),
  };

  const { rows } = await client.query(
    `insert into public.reward_batches (reward_type, chain, token_symbol, status, total_amount, recipient_count, claimable_count, claimed_count, failed_count, source, metadata, published_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, case when $12 then now() else null end)
     returning *`,
    [rewardType, chain, tokenSymbol, status, totalAmount, recipients.length, claimableCount, claimedCount, failedCount, source, JSON.stringify(metadata), status === "published" || status === "claim_open"],
  );
  let batch = rows[0];
  const { batchClaimMetadata, recipientClaimMetadata } = buildClaimMetadataPlan({ batch, recipients, chain, body, metadata });

  if (Object.keys(batchClaimMetadata).length) {
    const { rows: updatedRows } = await client.query(
      `update public.reward_batches
          set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
              updated_at = now()
        where id = $1::uuid
        returning *`,
      [batch.id, JSON.stringify(batchClaimMetadata)],
    );
    batch = updatedRows[0] || batch;
  }

  const ledgerItems = [];
  for (const [index, recipient] of recipients.entries()) {
    const wallet = normalizeWallet(recipient.walletAddress, chain);
    const claimMetadata = recipientClaimMetadata.get(index) || {};
    const recipientMetadata = { ...recipient.metadata, batchId: batch.id, batchIndex: index, ...claimMetadata };
    const { rows: ledgerRows } = await client.query(
      `insert into public.reward_ledger (reward_type, source_id, source_label, wallet_address, user_id, chain, token_symbol, amount, amount_usd, status, metadata, claimable_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10, $11::jsonb, case when $10 = 'claimable' then now() else null end)
       returning *`,
      [rewardType, recipient.sourceId, recipient.sourceLabel, wallet, recipient.userId, chain, tokenSymbol, recipient.amount, recipient.amountUsd, recipient.status, JSON.stringify(recipientMetadata)],
    );
    const ledgerRow = ledgerRows[0];
    await client.query(
      `insert into public.reward_batch_items (batch_id, reward_ledger_id, wallet_address, amount, status, metadata)
       values ($1, $2, $3, $4::numeric, $5, $6::jsonb)`,
      [batch.id, ledgerRow.id, wallet, recipient.amount, recipient.status, JSON.stringify(recipientMetadata)],
    );
    ledgerItems.push(ledgerItem(ledgerRow));
  }

  await writeAudit(client, {
    batchId: batch.id,
    action: recipients.length ? "reward_batch_created_with_ledger" : "reward_batch_created",
    newValue: JSON.stringify({ rewardType, status, recipientCount: recipients.length, totalAmount }),
    reason: body.reason || overrides.reason || "Reward batch created",
    req,
    metadata: { source, rewardType, claimMode: batchClaimMetadata.claimMode || null, merkleRoot: batchClaimMetadata.merkleRoot || null },
  });

  return { batch: batchItem(batch), items: ledgerItems };
}

async function updateBatchStatus(req, res, targetStatus, action, bodyOverride = null) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = bodyOverride || await readJson(req);
  const id = String(req.params?.id || body.batchId || body.id || "").trim();
  if (!id) return json(res, 400, { error: "Missing batch id" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: beforeRows } = await client.query(`select * from public.reward_batches where id = $1::uuid for update`, [id]);
    const before = beforeRows[0];
    if (!before) {
      await client.query("rollback");
      return json(res, 404, { error: "Reward batch not found" });
    }

    // Moderation hold (B7): a batch with a held or voided item (or an item of a held wallet) is not
    // published; nothing changes and the batch keeps its status.
    if (targetStatus === "published" || targetStatus === "claim_open") {
      const { rows: itemRows } = await client.query(`select reward_ledger_id::text as id from public.reward_batch_items where batch_id = $1::uuid and reward_ledger_id is not null`, [id]);
      const held = await rewardLedgerHolds(client, itemRows.map((row) => row.id));
      if (held.length) {
        await client.query("rollback");
        return json(res, 409, { error: "This batch has rewards on moderation hold. Release or void them first.", code: "MODERATION_HOLD", rewardLedgerIds: [...new Set(held.map((row) => row.id))] });
      }
    }

    const { rows } = await client.query(
      `update public.reward_batches
          set status = $2,
              published_at = case when $2 in ('published', 'claim_open') then coalesce(published_at, now()) else published_at end,
              closed_at = case when $2 in ('closed', 'archived') then coalesce(closed_at, now()) else closed_at end,
              updated_at = now()
        where id = $1::uuid
        returning *`,
      [id, targetStatus],
    );
    await writeAudit(client, { batchId: id, action, oldValue: before.status, newValue: targetStatus, reason: body.reason || action, req });
    await client.query("commit");
    return json(res, 200, { batch: batchItem(rows[0]), materializedAt: new Date().toISOString() });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error(`[${action}]`, error);
    return json(res, 500, { error: "Server error" });
  } finally {
    client.release();
  }
}

async function refreshBatchCounts(client, rewardLedgerId) {
  const { rows } = await client.query(`select batch_id from public.reward_batch_items where reward_ledger_id = $1::uuid limit 1`, [rewardLedgerId]);
  const batchId = rows[0]?.batch_id;
  if (!batchId) return null;

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
    [batchId],
  );
  return batchId;
}

async function updateClaimStatus(req, res, body, targetStatus) {
  const id = String(body.rewardLedgerId || body.rewardLedgerID || body.ledgerId || body.id || "").trim();
  if (!id) return json(res, 400, { error: "Missing reward ledger id" });

  const txHash = String(body.txHash || body.claimTxHash || "").trim() || null;
  const claimError = String(body.claimError || body.error || "").trim() || null;
  if (targetStatus === "claimed" && !txHash) return json(res, 400, { error: "Missing txHash for claimed reward" });
  if (targetStatus === "failed" && !claimError) return json(res, 400, { error: "Missing claimError for failed reward" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: beforeRows } = await client.query(`select * from public.reward_ledger where id = $1::uuid for update`, [id]);
    const before = beforeRows[0];
    if (!before) {
      await client.query("rollback");
      return json(res, 404, { error: "Reward ledger entry not found" });
    }

    if (Number(before.chain) === 101 || String(before.chain).toLowerCase() === "solana") {
      await client.query("rollback");
      return json(res, 409, { error: "Solana reward claiming is not enabled yet." });
    }

    const { rows } = await client.query(
      `update public.reward_ledger
          set status = $2,
              claim_tx_hash = case when $2 = 'claimed' then $3 else claim_tx_hash end,
              claim_error = case when $2 = 'failed' then $4 else null end,
              claimed_at = case when $2 = 'claimed' then coalesce(claimed_at, now()) else claimed_at end,
              updated_at = now()
        where id = $1::uuid
          and status in ('claimable', 'claim_pending', 'failed')
        returning *`,
      [id, targetStatus, txHash, claimError],
    );

    if (!rows[0]) {
      await client.query("rollback");
      return json(res, 409, { error: `Reward cannot move from ${before.status} to ${targetStatus}` });
    }

    await client.query(`update public.reward_batch_items set status = $2 where reward_ledger_id = $1::uuid`, [id, targetStatus]);
    const batchId = await refreshBatchCounts(client, id);
    await writeAudit(client, {
      batchId,
      rewardLedgerId: id,
      action: targetStatus === "claimed" ? "claim_completed" : "claim_failed",
      oldValue: before.status,
      newValue: targetStatus,
      reason: body.reason || (targetStatus === "claimed" ? "Claim transaction confirmed" : "Claim transaction failed"),
      txHash,
      req,
      metadata: { claimError },
    });
    await client.query("commit");
    return json(res, 200, { item: ledgerItem(rows[0]), materializedAt: new Date().toISOString() });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error(`[internal/reward-claim-${targetStatus}]`, error);
    return json(res, 500, { error: "Server error" });
  } finally {
    client.release();
  }
}

export async function internalRewardBatches(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const action = String(body.action || body.type || "").trim().toLowerCase();
  if (["claim_completed", "claim_complete", "complete_claim", "claimed"].includes(action)) {
    return updateClaimStatus(req, res, body, "claimed");
  }
  if (["claim_failed", "claim_fail", "fail_claim", "failed"].includes(action)) {
    return updateClaimStatus(req, res, body, "failed");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await insertBatchWithRecipients(client, req, body);
    await client.query("commit");
    return json(res, 201, { ...result, materializedAt: new Date().toISOString() });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error("[internal/reward-batches]", error);
    return json(res, 500, { error: "Server error" });
  } finally {
    client.release();
  }
}

export async function internalRewardBatchPublish(req, res) {
  return updateBatchStatus(req, res, "published", "reward_batch_published");
}

export async function internalRewardBatchPause(req, res) {
  return updateBatchStatus(req, res, "paused", "reward_batch_paused");
}

export async function internalRewardBatchClose(req, res) {
  return updateBatchStatus(req, res, "closed", "reward_batch_closed");
}

export async function internalAirdropsCalculate(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const epochId = Number(body.epochId || body.epoch_id || 0) || null;
  const program = String(body.program || "airdrop_trader");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const automatic = await buildAutomaticRecipients(client, body, "airdrop");
    const recipients = hasPreparedRecipients(body) ? preparedRecipients(body) : automatic.recipients;
    const calculationMetadata = {
      epochId,
      program,
      calculatedAt: new Date().toISOString(),
      ...automatic.metadata,
    };
    const result = await insertBatchWithRecipients(client, req, { ...body, recipients }, {
      rewardType: "airdrop",
      status: body.status || (recipients.length ? "ready" : "calculating"),
      source: body.source || (automatic.metadata.autoCalculation ? "airdrop_auto_calculate" : "airdrop_calculate"),
      metadata: calculationMetadata,
      reason: body.reason || (automatic.metadata.autoCalculation ? "Automatic airdrop calculation recorded" : "Airdrop calculation recorded"),
    });
    await writeAudit(client, {
      batchId: result.batch.id,
      action: automatic.metadata.autoCalculation ? "airdrop_auto_calculated" : "airdrop_calculated",
      reason: body.reason || "Airdrop calculation recorded",
      req,
      metadata: { epochId, program, recipientCount: recipients.length, ...automatic.metadata },
    });
    await client.query("commit");
    return json(res, 202, { status: recipients.length ? "recorded" : "calculating", ...result, materializedAt: new Date().toISOString() });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error("[internal/airdrops/calculate]", error);
    return json(res, 500, { error: "Server error" });
  } finally {
    client.release();
  }
}

export async function internalAirdropsPublish(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  if (body.batchId || body.id || req.params?.id) {
    return updateBatchStatus(req, res, "published", "airdrop_published", body);
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const automatic = await buildAutomaticRecipients(client, { ...body, publish: true }, "airdrop");
    const recipients = hasPreparedRecipients(body) ? preparedRecipients({ ...body, publish: true }) : automatic.recipients;
    if (wantsAutomaticCalculation(body) && !recipients.length) {
      await client.query("rollback");
      return json(res, 409, {
        error: "Automatic airdrop publish has no claimable recipients.",
        code: "AUTO_AIRDROP_EMPTY",
        metadata: automatic.metadata,
      });
    }
    const result = await insertBatchWithRecipients(client, req, { ...body, recipients, publish: true, status: "published" }, {
      rewardType: "airdrop",
      source: body.source || (automatic.metadata.autoCalculation ? "airdrop_auto_publish" : "airdrop_publish"),
      metadata: { epochId: body.epochId || body.epoch_id || null, program: body.program || "airdrop_trader", publishedVia: "internal_api", ...automatic.metadata },
      reason: body.reason || "Airdrop published",
    });
    await writeAudit(client, { batchId: result.batch.id, action: automatic.metadata.autoCalculation ? "airdrop_auto_published" : "airdrop_published", reason: body.reason || "Airdrop published", req, metadata: automatic.metadata });
    await client.query("commit");
    return json(res, 202, { status: "published", ...result, materializedAt: new Date().toISOString() });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error("[internal/airdrops/publish]", error);
    return json(res, 500, { error: "Server error" });
  } finally {
    client.release();
  }
}
