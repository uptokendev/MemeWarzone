// Reward-program API backed by the launch-safe central reward ledger.

import { pool } from "../../server/db.js";
import { readJson } from "../../server/http.js";

const CLAIMABLE_STATUSES = new Set(["claimable"]);
const HISTORY_STATUSES = new Set(["claimable", "claim_pending", "claimed", "failed", "expired"]);
const EMPTY_OPS_STATE = {
  publications: [],
  draws: [],
  alerts: [],
  actions: [],
  routing: null,
  claimVault: null,
};

function methodAllowed(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader("Allow", methods.join(", "));
  res.status(405).json({ error: "Method not allowed" });
  return false;
}

function getQuery(req) {
  return req.query || {};
}

function parseLimit(value, fallback = 20, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function json(res, status, payload) {
  return res.status(status).json({ ok: status < 400, ...payload });
}

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function normalizeWallet(value, chainId) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (Number(chainId) === 101 || Number(chainId) === 102) return raw;
  return raw.toLowerCase();
}

function normalizeRewardType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.replace(/[^a-z0-9_]/g, "_");
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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

function chainSymbol(chain, tokenSymbol) {
  if (tokenSymbol) return String(tokenSymbol);
  return Number(chain) === 101 || String(chain).toLowerCase() === "solana" ? "SOL" : "BNB";
}

function ledgerItem(row) {
  const metadata = readMeta(row);
  return {
    id: String(row.id),
    rewardType: row.reward_type,
    sourceId: row.source_id || null,
    sourceLabel: row.source_label || null,
    walletAddress: row.wallet_address,
    userId: row.user_id || null,
    chain: row.chain,
    chainId: Number(row.chain) || null,
    tokenSymbol: chainSymbol(row.chain, row.token_symbol),
    amount: String(row.amount ?? "0"),
    amountUsd: row.amount_usd == null ? null : String(row.amount_usd),
    status: row.status,
    claimBatchId: row.claim_batch_id || null,
    claimTxHash: row.claim_tx_hash || null,
    claimError: row.claim_error || null,
    metadata,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    claimableAt: toIso(row.claimable_at),
    claimedAt: toIso(row.claimed_at),
    expiresAt: toIso(row.expires_at),
  };
}

function batchItem(row) {
  const metadata = readMeta(row);
  return {
    id: String(row.id),
    rewardType: row.reward_type,
    chain: row.chain,
    chainId: Number(row.chain) || null,
    tokenSymbol: chainSymbol(row.chain, row.token_symbol),
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

function auditItem(row) {
  return {
    id: String(row.id),
    batchId: row.batch_id || null,
    rewardLedgerId: row.reward_ledger_id || null,
    actorType: row.actor_type || "system",
    actorId: row.actor_id || null,
    action: row.action,
    oldValue: row.old_value || null,
    newValue: row.new_value || null,
    reason: row.reason || null,
    txHash: row.tx_hash || null,
    metadata: readMeta(row),
    createdAt: toIso(row.created_at),
  };
}

function alertItem(row) {
  return {
    id: String(row.id),
    severity: row.severity || "info",
    rewardType: row.reward_type || null,
    batchId: row.batch_id || null,
    title: row.title || "Reward alert",
    message: row.message || "",
    status: row.status || "open",
    metadata: readMeta(row),
    createdAt: toIso(row.created_at),
    resolvedAt: toIso(row.resolved_at),
    resolvedBy: row.resolved_by || null,
  };
}

function totalsFor(items) {
  const totals = { claimableAmount: 0n, claimPendingAmount: 0n, claimedAmount: 0n, expiredAmount: 0n };
  for (const item of items) {
    let amount = 0n;
    try { amount = BigInt(item.amount || "0"); } catch {}
    if (item.status === "claimable") totals.claimableAmount += amount;
    if (item.status === "claim_pending") totals.claimPendingAmount += amount;
    if (item.status === "claimed") totals.claimedAmount += amount;
    if (item.status === "expired") totals.expiredAmount += amount;
  }
  return {
    claimableAmount: String(totals.claimableAmount),
    claimPendingAmount: String(totals.claimPendingAmount),
    claimedAmount: String(totals.claimedAmount),
    expiredAmount: String(totals.expiredAmount),
  };
}

async function readLedger({ address, chainId, statuses, rewardType, limit = 100 }) {
  const wallet = normalizeWallet(address, chainId);
  if (!wallet) return [];
  const statusList = Array.from(statuses || HISTORY_STATUSES);
  const type = normalizeRewardType(rewardType);
  const { rows } = await pool.query(
    `select *
       from public.reward_ledger
      where wallet_address = $1
        and ($2::text is null or chain::text = $2::text)
        and status = any($3::text[])
        and ($4::text = '' or reward_type = $4::text)
      order by coalesce(claimable_at, created_at) desc, created_at desc
      limit $5`,
    [wallet, chainId ? String(chainId) : null, statusList, type, limit],
  );
  return rows.map(ledgerItem);
}

async function writeAudit({ batchId = null, rewardLedgerId = null, action, oldValue = null, newValue = null, reason = null, req = null }) {
  const actorId = String(req?.dashboardPrincipal?.email || req?.headers?.["x-admin-email"] || req?.headers?.["x-user-email"] || "api");
  await pool.query(
    `insert into public.reward_audit_logs (batch_id, reward_ledger_id, actor_type, actor_id, action, old_value, new_value, reason, metadata)
     values ($1, $2, 'api', $3, $4, $5, $6, $7, '{}'::jsonb)`,
    [batchId, rewardLedgerId, actorId, action, oldValue, newValue, reason],
  );
}

async function refreshBatchCountsForLedgerIds(rewardLedgerIds) {
  if (!Array.isArray(rewardLedgerIds) || !rewardLedgerIds.length) return;
  const { rows } = await pool.query(
    `select distinct batch_id
       from public.reward_batch_items
      where reward_ledger_id = any($1::uuid[])
        and batch_id is not null`,
    [rewardLedgerIds],
  );

  for (const row of rows) {
    await pool.query(
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

export async function rewardsMe(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  const address = String(q.address || q.walletAddress || "").trim();
  const chainId = q.chainId ? Number(q.chainId) : null;
  try {
    const items = await readLedger({ address, chainId, statuses: HISTORY_STATUSES, rewardType: q.rewardType, limit: parseLimit(q.limit, 100, 250) });
    return json(res, 200, {
      address,
      chainId,
      claimable: items.filter((item) => CLAIMABLE_STATUSES.has(item.status)),
      items,
      totals: totalsFor(items),
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[rewards/me]", error);
    return json(res, 200, { address, chainId, claimable: [], items: [], totals: totalsFor([]), materializedAt: null, schemaReady: false });
  }
}

export async function rewardsHistory(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  const address = String(q.address || q.walletAddress || "").trim();
  const chainId = q.chainId ? Number(q.chainId) : null;
  const limit = parseLimit(q.limit, 20, 100);
  try {
    const items = await readLedger({ address, chainId, statuses: HISTORY_STATUSES, rewardType: q.rewardType, limit });
    return json(res, 200, { items, address, chainId, limit, cursor: q.cursor || null, nextCursor: null, materializedAt: new Date().toISOString() });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[rewards/history]", error);
    return json(res, 200, { items: [], address, chainId, limit, cursor: q.cursor || null, nextCursor: null, materializedAt: null, schemaReady: false });
  }
}

export async function rewardsClaims(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  const q = getQuery(req);
  const chainId = q.chainId ? Number(q.chainId) : null;

  if (req.method === "GET") {
    const address = String(q.address || q.walletAddress || "").trim();
    try {
      const items = await readLedger({ address, chainId, statuses: new Set(["claimable", "claim_pending", "failed"]), rewardType: q.rewardType, limit: parseLimit(q.limit, 20, 100) });
      return json(res, 200, { items, address, chainId, materializedAt: new Date().toISOString() });
    } catch (error) {
      if (!schemaMissing(error)) console.error("[rewards/claims:get]", error);
      return json(res, 200, { items: [], address, chainId, materializedAt: null, schemaReady: false });
    }
  }

  const body = await readJson(req);
  const ids = Array.isArray(body.rewardLedgerIds) ? body.rewardLedgerIds : [body.rewardLedgerId || body.id].filter(Boolean);
  const address = String(body.address || body.walletAddress || q.address || q.walletAddress || "").trim();
  const wallet = normalizeWallet(address, body.chainId || chainId);
  if (!ids.length || !wallet) return json(res, 400, { error: "Missing rewardLedgerIds or walletAddress" });

  try {
    const { rows: existing } = await pool.query(
      `select id, chain, status
         from public.reward_ledger
        where id = any($1::uuid[])
          and wallet_address = $2`,
      [ids, wallet],
    );

    const solana = existing.find((row) => Number(row.chain) === 101 || String(row.chain).toLowerCase() === "solana");
    if (solana) return json(res, 409, { error: "Solana reward claiming is not enabled yet." });

    const batchId = `claim-${Date.now()}`;
    const { rows } = await pool.query(
      `update public.reward_ledger
          set status = 'claim_pending',
              claim_batch_id = $3,
              claim_error = null,
              updated_at = now()
        where id = any($1::uuid[])
          and wallet_address = $2
          and status in ('claimable', 'failed')
        returning *`,
      [ids, wallet, batchId],
    );

    const updatedIds = rows.map((row) => row.id);
    if (updatedIds.length) {
      await pool.query(`update public.reward_batch_items set status = 'claim_pending' where reward_ledger_id = any($1::uuid[])`, [updatedIds]);
      await refreshBatchCountsForLedgerIds(updatedIds);
    }

    for (const row of rows) {
      await writeAudit({ rewardLedgerId: row.id, action: "claim_requested", oldValue: "claimable", newValue: "claim_pending", reason: body.reason || "User claim requested", req });
    }

    return json(res, 202, { items: rows.map(ledgerItem), claimBatchId: batchId, materializedAt: new Date().toISOString() });
  } catch (error) {
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error("[rewards/claims:post]", error);
    return json(res, 500, { error: "Server error" });
  }
}

export async function rewardsEligibility(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  const address = String(q.address || q.walletAddress || "").trim();
  const chainId = q.chainId ? Number(q.chainId) : null;
  try {
    const items = await readLedger({ address, chainId, statuses: HISTORY_STATUSES, rewardType: q.program || q.rewardType, limit: parseLimit(q.limit, 20, 100) });
    return json(res, 200, {
      address,
      chainId,
      items: items.map((item) => ({
        id: item.id,
        epochId: Number(item.metadata?.epochId || 0),
        chainId: item.chainId,
        epochType: item.metadata?.epochType || "reward",
        startAt: item.metadata?.startAt || item.createdAt,
        endAt: item.metadata?.endAt || item.expiresAt,
        program: item.rewardType,
        isEligible: item.status !== "expired" && item.status !== "cancelled",
        reasonCodes: Array.isArray(item.metadata?.reasonCodes) ? item.metadata.reasonCodes : [],
        computedAt: item.createdAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      limit: parseLimit(q.limit, 20, 100),
      program: q.program || null,
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[rewards/eligibility]", error);
    return json(res, 200, { address, chainId, items: [], limit: parseLimit(q.limit, 20, 100), program: q.program || null, materializedAt: null, schemaReady: false });
  }
}

export async function airdropWinners(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  const limit = parseLimit(q.limit, 20, 100);
  try {
    const { rows } = await pool.query(
      `select *
         from public.reward_ledger
        where reward_type = 'airdrop'
          and ($1::text is null or chain::text = $1::text)
          and ($2::text = '' or wallet_address = $2::text)
          and status in ('claimable', 'claim_pending', 'claimed')
        order by coalesce(claimable_at, created_at) desc, created_at desc
        limit $3`,
      [q.chainId ? String(q.chainId) : null, normalizeWallet(q.walletAddress, q.chainId), limit],
    );
    const items = rows.map((row, index) => {
      const item = ledgerItem(row);
      const program = item.metadata?.program || (item.metadata?.role === "Creator" ? "airdrop_creator" : "airdrop_trader");
      return {
        id: Number(item.metadata?.winnerId || index + 1),
        drawId: Number(item.metadata?.drawId || item.metadata?.batchId || 0),
        epochId: Number(item.metadata?.epochId || 0),
        chainId: item.chainId || Number(q.chainId) || 56,
        program,
        walletAddress: item.walletAddress,
        winnerRank: Number(item.metadata?.winnerRank || index + 1),
        weightTier: Number(item.metadata?.weightTier || 0),
        weightValue: Number(item.metadata?.weightValue || 0),
        activityScore: String(item.metadata?.activityScore || "0"),
        payoutAmount: item.amount,
        metadataJson: item.metadata,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });
    return json(res, 200, { items, epochId: q.epochId ? Number(q.epochId) : null, chainId: q.chainId ? Number(q.chainId) : null, program: q.program || null, walletAddress: q.walletAddress || null, limit, isPublished: items.length > 0, materializedAt: new Date().toISOString() });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[airdrops/winners]", error);
    return json(res, 200, { items: [], epochId: q.epochId ? Number(q.epochId) : null, chainId: q.chainId ? Number(q.chainId) : null, program: q.program || null, walletAddress: q.walletAddress || null, limit, isPublished: false, materializedAt: null, schemaReady: false });
  }
}

export async function airdropCurrent(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  return internalRewardEpochStatus(req, res);
}

export async function airdropPreviousWinners(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  return airdropWinners(req, res);
}

export async function squadsLeaderboard(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  return json(res, 200, { items: [], currentEpochId: q.epochId ? Number(q.epochId) : null, materializedAt: null });
}
export async function squadSummary(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  const code = String(req.params?.code || q.code || q.recruiterCode || "").trim();

  return json(res, 200, {
    squad: null,
    summary: {
      recruiterCode: code || null,
      activeMemberCount: 0,
      eligibleMemberCount: 0,
      estimatedAllocationAmount: "0",
      currentEpochId: q.epochId ? Number(q.epochId) : null,
    },
    materializedAt: null,
  });
}
export async function squadMembers(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  return json(res, 200, { items: [], recruiterCode: q.recruiterCode || null, walletAddress: q.walletAddress || null, currentEpochId: q.epochId ? Number(q.epochId) : null, materializedAt: null });
}

export async function recruiterReplacements(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  return json(res, 200, { items: [], replacementQueue: [], materializedAt: null });
}

async function readLatestAirdropBatch(chainId) {
  const { rows } = await pool.query(
    `select *
       from public.reward_batches
      where reward_type = 'airdrop'
        and ($1::text is null or chain::text = $1::text)
      order by coalesce(published_at, created_at) desc, created_at desc
      limit 1`,
    [chainId ? String(chainId) : null],
  );
  return rows[0] ? batchItem(rows[0]) : null;
}

export async function internalAirdropDraws(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const { rows } = await pool.query(
      `select * from public.reward_batches where reward_type = 'airdrop' order by created_at desc limit 50`,
    );
    return json(res, 200, { items: rows.map(batchItem), status: "ready", materializedAt: new Date().toISOString() });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[internal/airdrop-draws]", error);
    return json(res, 200, { items: [], status: "schema_missing", materializedAt: null });
  }
}

export async function internalAirdropDrawRun(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const epochId = Number(req.params?.epochId || body.epochId || 0);
  const program = normalizeRewardType(body.program || "airdrop");
  try {
    const { rows } = await pool.query(
      `insert into public.reward_batches (reward_type, chain, token_symbol, status, total_amount, recipient_count, source, metadata, published_at)
       values ('airdrop', $1, $2, $3, 0, 0, 'manual_reward_ops', $4::jsonb, case when $5 then now() else null end)
       returning *`,
      [body.chain || body.chainId || 56, body.tokenSymbol || "BNB", body.publish ? "published" : "draft", JSON.stringify({ epochId, program, reason: body.reason || null }), Boolean(body.publish)],
    );
    await writeAudit({ batchId: rows[0].id, action: body.publish ? "airdrop_draw_published" : "airdrop_draw_created", newValue: JSON.stringify(body), reason: body.reason || "Manual airdrop draw action", req });
    return json(res, 202, { status: "queued", drawId: rows[0].id, batch: batchItem(rows[0]), materializedAt: new Date().toISOString() });
  } catch (error) {
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error("[internal/airdrop-draw-run]", error);
    return json(res, 500, { error: "Server error" });
  }
}

export async function internalRewardEpochStatus(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  const q = getQuery(req);
  try {
    const batch = await readLatestAirdropBatch(q.chainId || q.chain);
    return json(res, 200, {
      status: batch?.status || "empty",
      currentEpochId: Number(batch?.metadata?.epochId || 0) || null,
      current: batch,
      prizePool: batch ? { chain: batch.chain, tokenSymbol: batch.tokenSymbol, amount: batch.totalAmount, status: batch.status } : null,
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[internal/reward-epoch-status]", error);
    return json(res, 200, { status: "schema_missing", currentEpochId: null, current: null, prizePool: null, materializedAt: null });
  }
}

export async function internalRewardClaimVault(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  try {
    const { rows } = await pool.query(
      `select chain,
              token_symbol,
              coalesce(sum(amount) filter (where status = 'claimable'), 0)::text as claimable_amount,
              coalesce(sum(amount) filter (where status = 'claim_pending'), 0)::text as pending_amount,
              coalesce(count(*) filter (where status = 'failed'), 0)::int as failed_count
         from public.reward_ledger
        group by chain, token_symbol
        order by chain, token_symbol`,
    );
    return json(res, 200, { claimVault: { balances: rows }, status: "ready", materializedAt: new Date().toISOString() });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[internal/reward-claim-vault]", error);
    return json(res, 200, { claimVault: null, status: "schema_missing", materializedAt: null });
  }
}

// reward_ledger.amount is in each chain's smallest unit (wei on EVM, lamports
// on Solana), so amounts are only summed inside one chain + token. The old
// single recruiterRouteAmount / airdropPoolAmount added wei and lamports
// together; they stay in the payload as null and the totals live in byChain.
export async function internalRewardRouting(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  try {
    const [walletResult, chainResult] = await Promise.all([
      pool.query(
        `select coalesce(count(distinct wallet_address), 0)::int as active_linked_wallet_count
           from public.reward_ledger
          where status in ('approved', 'claimable', 'claim_pending', 'claimed')`,
      ),
      pool.query(
        `select chain::text as chain,
                coalesce(nullif(token_symbol, ''), '') as token_symbol,
                count(distinct wallet_address)::int as wallet_count,
                coalesce(sum(amount) filter (where reward_type = 'airdrop'), 0)::text as airdrop_pool_amount,
                coalesce(sum(amount) filter (where reward_type = 'recruiter'), 0)::text as recruiter_route_amount
           from public.reward_ledger
          where status in ('approved', 'claimable', 'claim_pending', 'claimed')
          group by chain::text, coalesce(nullif(token_symbol, ''), '')
          order by chain::text, coalesce(nullif(token_symbol, ''), '')`,
      ),
    ]);
    const row = walletResult.rows[0] || {};
    return json(res, 200, {
      routes: [],
      activeLinkedWalletCount: Number(row.active_linked_wallet_count || 0),
      lockedWalletCount: 0,
      recruiterRouteAmount: null,
      airdropPoolAmount: null,
      byChain: chainResult.rows.map((item) => ({
        chain: item.chain,
        chainId: Number(item.chain) || null,
        tokenSymbol: chainSymbol(item.chain, item.token_symbol),
        walletCount: Number(item.wallet_count || 0),
        recruiterRouteAmount: String(item.recruiter_route_amount || "0"),
        airdropPoolAmount: String(item.airdrop_pool_amount || "0"),
      })),
      status: "ready",
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[internal/reward-routing]", error);
    return json(res, 200, { routes: [], byChain: [], status: "schema_missing", materializedAt: null });
  }
}

export async function internalRewardPublications(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  try {
    if (req.method === "POST") {
      const body = await readJson(req);
      const id = String(body.resourceKey || body.batchId || "").trim();
      if (id) {
        const nextStatus = body.isPublished ? "published" : "draft";
        await pool.query(
          `update public.reward_batches set status = $2, published_at = case when $3 then coalesce(published_at, now()) else published_at end, updated_at = now() where id = $1::uuid`,
          [id, nextStatus, Boolean(body.isPublished)],
        );
        await writeAudit({ batchId: id, action: body.isPublished ? "batch_published" : "batch_hidden", newValue: nextStatus, reason: body.reason || "Reward Ops publication toggle", req });
      }
    }
    const { rows } = await pool.query(
      `select id, reward_type, status, metadata
         from public.reward_batches
        order by created_at desc
        limit 100`,
    );
    return json(res, 200, {
      publications: rows.map((row) => ({
        resourceType: row.reward_type,
        resourceKey: String(row.id),
        isPublished: row.status === "published" || row.status === "claim_open",
        reason: readMeta(row).reason || null,
      })),
      status: "ready",
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (schemaMissing(error)) return json(res, 200, { publications: [], status: "schema_missing", materializedAt: null });
    console.error("[internal/reward-publications]", error);
    return json(res, 500, { error: "Server error" });
  }
}

export async function internalRewardAlerts(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  try {
    const { rows } = await pool.query(`select * from public.reward_alerts order by created_at desc limit 100`);
    return json(res, 200, { alerts: rows.map(alertItem), status: "ready", materializedAt: new Date().toISOString() });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[internal/reward-alerts]", error);
    return json(res, 200, { alerts: [], status: "schema_missing", materializedAt: null });
  }
}

export async function internalRewardAdminActions(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  try {
    const { rows } = await pool.query(`select * from public.reward_audit_logs order by created_at desc limit 100`);
    return json(res, 200, { actions: rows.map(auditItem), status: "ready", materializedAt: new Date().toISOString() });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[internal/reward-admin-actions]", error);
    return json(res, 200, { actions: [], status: "schema_missing", materializedAt: null });
  }
}

export async function adminRewardOverview(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const [totalsResult, typeResult, chainResult] = await Promise.all([
      pool.query(
        // Counts only: amounts across chains would add wei to lamports. The
        // per-chain amounts are in rewardsByChain.
        `select count(*)::int as total_rewards,
                null::text as total_claimable,
                null::text as total_claim_pending,
                count(*) filter (where status = 'claim_pending')::int as total_claim_pending_count,
                null::text as total_claimed,
                count(*) filter (where status = 'failed')::int as total_failed,
                count(*) filter (where status = 'expired')::int as total_expired
           from public.reward_ledger`,
      ),
      pool.query(
        `select reward_type,
                chain,
                token_symbol,
                count(*)::int as count,
                coalesce(sum(amount), 0)::text as amount,
                count(*) filter (where status = 'claimable')::int as claimable_count,
                count(*) filter (where status = 'claim_pending')::int as claim_pending_count,
                count(*) filter (where status = 'claimed')::int as claimed_count,
                count(*) filter (where status = 'failed')::int as failed_count
           from public.reward_ledger
          group by reward_type, chain, token_symbol
          order by reward_type, chain, token_symbol`,
      ),
      pool.query(
        `select chain,
                token_symbol,
                count(*)::int as count,
                coalesce(sum(amount), 0)::text as amount,
                coalesce(sum(amount) filter (where status = 'claimable'), 0)::text as claimable_amount,
                coalesce(sum(amount) filter (where status = 'claim_pending'), 0)::text as claim_pending_amount,
                coalesce(sum(amount) filter (where status = 'claimed'), 0)::text as claimed_amount,
                count(*) filter (where status = 'claimable')::int as claimable_count,
                count(*) filter (where status = 'claim_pending')::int as claim_pending_count,
                count(*) filter (where status = 'claimed')::int as claimed_count,
                count(*) filter (where status = 'failed')::int as failed_count
           from public.reward_ledger
          group by chain, token_symbol
          order by chain, token_symbol`,
      ),
    ]);
    return json(res, 200, {
      overview: totalsResult.rows[0] || {},
      rewardsByType: typeResult.rows,
      rewardsByChain: chainResult.rows,
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[admin/rewards/overview]", error);
    return json(res, 200, { overview: {}, rewardsByType: [], rewardsByChain: [], materializedAt: null, schemaReady: false });
  }
}

export async function adminRewardBatches(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  try {
    const { rows } = await pool.query(
      `select *
         from public.reward_batches
        where ($1::text = '' or reward_type = $1::text)
          and ($2::text = '' or status = $2::text)
          and ($3::text = '' or chain::text = $3::text)
        order by created_at desc
        limit $4`,
      [normalizeRewardType(q.rewardType), String(q.status || ""), q.chain ? String(q.chain) : "", parseLimit(q.limit, 100, 250)],
    );
    return json(res, 200, { items: rows.map(batchItem), materializedAt: new Date().toISOString() });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[admin/rewards/batches]", error);
    return json(res, 200, { items: [], materializedAt: null, schemaReady: false });
  }
}

export async function adminRewardBatchById(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const id = String(req.params?.id || "").trim();
  try {
    const [batchResult, itemResult] = await Promise.all([
      pool.query(`select * from public.reward_batches where id = $1::uuid limit 1`, [id]),
      pool.query(
        `select bi.*, rl.status as ledger_status, rl.claim_tx_hash, rl.claim_error
           from public.reward_batch_items bi
           left join public.reward_ledger rl on rl.id = bi.reward_ledger_id
          where bi.batch_id = $1::uuid
          order by bi.created_at desc
          limit 500`,
        [id],
      ),
    ]);
    return json(res, 200, {
      batch: batchResult.rows[0] ? batchItem(batchResult.rows[0]) : null,
      items: itemResult.rows,
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[admin/rewards/batch]", error);
    return json(res, 200, { batch: null, items: [], materializedAt: null, schemaReady: false });
  }
}

export async function adminRewardLedger(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const q = getQuery(req);
  try {
    const { rows } = await pool.query(
      `select *
         from public.reward_ledger
        where ($1::text = '' or wallet_address = $1::text)
          and ($2::text = '' or reward_type = $2::text)
          and ($3::text = '' or status = $3::text)
          and ($4::text = '' or chain::text = $4::text)
        order by created_at desc
        limit $5`,
      [normalizeWallet(q.walletAddress || q.address, q.chain), normalizeRewardType(q.rewardType), String(q.status || ""), q.chain ? String(q.chain) : "", parseLimit(q.limit, 100, 500)],
    );
    return json(res, 200, { items: rows.map(ledgerItem), materializedAt: new Date().toISOString() });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[admin/rewards/ledger]", error);
    return json(res, 200, { items: [], materializedAt: null, schemaReady: false });
  }
}

export async function adminRewardAlerts(req, res) {
  return internalRewardAlerts(req, res);
}

export async function adminRewardAuditLog(req, res) {
  return internalRewardAdminActions(req, res);
}

export async function internalRewardOps(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const [publications, draws, alerts, actions, routing, claimVault] = await Promise.all([
      new Promise((resolve) => internalRewardPublications({ ...req, method: "GET" }, { status: () => ({ json: resolve }) })),
      new Promise((resolve) => internalAirdropDraws({ ...req, method: "GET" }, { status: () => ({ json: resolve }) })),
      new Promise((resolve) => internalRewardAlerts({ ...req, method: "GET" }, { status: () => ({ json: resolve }) })),
      new Promise((resolve) => internalRewardAdminActions({ ...req, method: "GET" }, { status: () => ({ json: resolve }) })),
      new Promise((resolve) => internalRewardRouting({ ...req, method: "GET" }, { status: () => ({ json: resolve }) })),
      new Promise((resolve) => internalRewardClaimVault({ ...req, method: "GET" }, { status: () => ({ json: resolve }) })),
    ]);
    return json(res, 200, {
      ...EMPTY_OPS_STATE,
      publications: publications.publications || [],
      draws: draws.items || [],
      alerts: alerts.alerts || [],
      actions: actions.actions || [],
      routing,
      claimVault: claimVault.claimVault || null,
    });
  } catch (error) {
    if (!schemaMissing(error)) console.error("[internal/reward-ops]", error);
    return json(res, 200, { ...EMPTY_OPS_STATE, schemaReady: false });
  }
}
