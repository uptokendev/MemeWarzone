import { pool } from "../server/db.js";
import { isAddress, json } from "../server/http.js";
import league from "./league.js";
import leagueRecruiter from "./leagueRecruiter.js";
import monthlyLeagueTreasury from "./monthlyLeagueTreasury.js";
import {
  discoverEvmLeagueClaimTransaction,
  verifyEvmLeagueClaimTransaction,
} from "./lib/evmLeagueClaimVerification.js";
import { verifySolanaLeagueClaimTransaction } from "./lib/solanaLeagueClaimVerification.js";
import { canonicalSolanaClaimIdentity } from "./lib/solanaClaimEnvironment.js";

const EVM_LEAGUE_CHAINS = new Set([56, 97, 4663, 46630]);

function readRequest(req) {
  try {
    const base = `${req.protocol || "http"}://${req.headers?.host || "localhost"}`;
    const url = new URL(req.originalUrl || req.url || "", base);
    return {
      category: String(url.searchParams.get("category") || "").toLowerCase().trim(),
      monthId: String(url.searchParams.get("monthId") || "").trim(),
      wallet: String(url.searchParams.get("wallet") || "").trim(),
      search: url.search,
    };
  } catch {
    return { category: "", monthId: "", wallet: "", search: "" };
  }
}

function minConfirmationsForChain(chainId) {
  const chain = Number(chainId);
  const value = Number(
    process.env[`LEAGUE_CLAIM_MIN_CONFIRMATIONS_${chain}`] ||
      process.env.LEAGUE_CLAIM_MIN_CONFIRMATIONS ||
      1,
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function recordBody(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  return {
    body,
    action: String(body.action || "").toLowerCase().trim(),
    chainId: Number(body.chainId),
    period: String(body.period || "").toLowerCase().trim(),
    epochStart: String(body.epochStart || "").trim(),
    category: String(body.category || "").toLowerCase().trim(),
    rank: Number(body.rank),
    recipient: String(body.recipient || body.address || "").trim(),
    txHash: String(body.txHash || "").trim(),
  };
}

function canonicalizeSolanaLeagueRequest(req, res) {
  if (req.method !== "POST") return true;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const chainId = Number(body.chainId);
  if (chainId !== 101 && chainId !== 102) return true;
  try {
    const identity = canonicalSolanaClaimIdentity({
      chainId,
      environment: body.environment,
      solanaCluster: body.solanaCluster,
    });
    req.body = {
      ...body,
      chainId: 101,
      environment: identity.environment,
      solanaCluster: identity.solanaCluster,
    };
    return true;
  } catch (error) {
    json(res, Number(error?.status) || 409, {
      ok: false,
      error: String(error?.message || "Invalid Solana League environment identity"),
      code: String(error?.code || "INVALID_ENVIRONMENT"),
    });
    return false;
  }
}

function isSolanaLeagueRecord(req) {
  if (req.method !== "POST") return false;
  const { action, chainId } = recordBody(req);
  return action === "record" && chainId === 101;
}

function isEvmLeagueRecord(req) {
  if (req.method !== "POST") return false;
  const { action, chainId } = recordBody(req);
  return action === "record" && EVM_LEAGUE_CHAINS.has(chainId);
}

async function winnerFor({ chainId, period, epochStart, category, rank }) {
  const { rows } = await pool.query(
    `select recipient_address as "recipientAddress", amount_raw as "amountRaw"
       from public.league_epoch_winners
      where chain_id=$1
        and period=$2
        and epoch_start=$3::timestamptz
        and category=$4
        and rank=$5
      limit 1`,
    [chainId, period, epochStart, category, rank],
  );
  return rows[0] || null;
}

async function verifySolanaRecord(req, res) {
  const { chainId, period, epochStart, category, rank, recipient, txHash, body } = recordBody(req);
  const winner = await winnerFor({ chainId, period, epochStart, category, rank });
  if (!winner) {
    json(res, 404, { error: "Winner not found" });
    return false;
  }
  if (String(winner.recipientAddress || "").trim() !== recipient) {
    json(res, 403, { error: "Not the winner" });
    return false;
  }

  try {
    await verifySolanaLeagueClaimTransaction({
      chainId,
      environment: body.environment,
      solanaCluster: body.solanaCluster,
      period,
      epochStart,
      category,
      rank,
      recipient,
      amountRaw: String(winner.amountRaw),
      txHash,
    });
    return true;
  } catch (error) {
    console.error("[leagueRouter] Solana League record verification failed", {
      chainId,
      period,
      epochStart,
      category,
      rank,
      recipient,
      txHash,
      code: error?.code,
      message: error?.message,
    });
    json(res, Number(error?.status) || 409, {
      error: String(error?.message || "Solana League transaction verification failed"),
      code: String(error?.code || "SOLANA_LEAGUE_VERIFICATION_FAILED"),
    });
    return false;
  }
}

async function verifyEvmRecord(req, res) {
  const { chainId, period, epochStart, category, rank, recipient, txHash } = recordBody(req);
  const winner = await winnerFor({ chainId, period, epochStart, category, rank });
  if (!winner) {
    json(res, 404, { error: "Winner not found" });
    return false;
  }
  if (String(winner.recipientAddress || "").trim().toLowerCase() !== recipient.toLowerCase()) {
    json(res, 403, { error: "Not the winner" });
    return false;
  }

  try {
    await verifyEvmLeagueClaimTransaction({
      chainId,
      period,
      epochStart,
      category,
      rank,
      recipient,
      amountRaw: String(winner.amountRaw),
      txHash,
      minConfirmations: minConfirmationsForChain(chainId),
    });
    return true;
  } catch (error) {
    console.error("[leagueRouter] EVM League record verification failed", {
      chainId,
      period,
      epochStart,
      category,
      rank,
      recipient,
      txHash,
      code: error?.code,
      message: error?.message,
    });
    json(res, Number(error?.status) || 409, {
      error: String(error?.message || "EVM League transaction verification failed"),
      code: String(error?.code || "EVM_LEAGUE_VERIFICATION_FAILED"),
    });
    return false;
  }
}

async function persistRecoveredEvmLeagueClaim(row, verification) {
  const client = await pool.connect();
  const lockKey = `${row.chainId}:${row.period}:${row.epochStart}:${row.category}:${row.rank}`;
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);

    const { rows: existingRows } = await client.query(
      `select tx_hash as "txHash"
         from public.league_epoch_payouts
        where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz and category=$4 and rank=$5
        limit 1`,
      [row.chainId, row.period, row.epochStart, row.category, row.rank],
    );
    if (existingRows[0]?.txHash) {
      if (String(existingRows[0].txHash).toLowerCase() !== String(verification.txHash).toLowerCase()) {
        const error = new Error("League payout slot already has a different immutable transaction");
        error.code = "LEAGUE_PAYOUT_ALREADY_RECORDED";
        throw error;
      }
      await client.query("commit");
      return { status: "already_recorded", txHash: existingRows[0].txHash };
    }

    const { rows: reusedRows } = await client.query(
      `select chain_id, period, epoch_start, category, rank
         from public.league_epoch_payouts
        where lower(coalesce(tx_hash, '')) = lower($1)
        limit 1`,
      [verification.txHash],
    );
    if (reusedRows.length) {
      const error = new Error("Verified League transaction is already attached to another payout slot");
      error.code = "LEAGUE_TX_ALREADY_USED";
      throw error;
    }

    await client.query(
      `insert into public.league_epoch_claims
        (chain_id, period, epoch_start, category, rank, recipient_address, signature)
       values ($1,$2,$3::timestamptz,$4,$5,$6,null)
       on conflict (chain_id, period, epoch_start, category, rank) do nothing`,
      [row.chainId, row.period, row.epochStart, row.category, row.rank, row.recipientAddress],
    );
    const { rows: payoutRows } = await client.query(
      `insert into public.league_epoch_payouts
        (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
       values ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8)
       on conflict (chain_id, period, epoch_start, category, rank)
       do update set
         recipient_address = excluded.recipient_address,
         amount_raw = excluded.amount_raw,
         tx_hash = excluded.tx_hash,
         paid_at = now()
       where public.league_epoch_payouts.tx_hash is null
       returning tx_hash as "txHash"`,
      [
        row.chainId,
        row.period,
        row.epochStart,
        row.category,
        row.rank,
        row.recipientAddress,
        row.amountRaw,
        verification.txHash,
      ],
    );
    if (!payoutRows[0]?.txHash) {
      const error = new Error("League payout slot was recorded concurrently and cannot be overwritten");
      error.code = "LEAGUE_PAYOUT_ALREADY_RECORDED";
      throw error;
    }
    await client.query("commit");
    return { status: "reconciled", txHash: verification.txHash, blockNumber: verification.blockNumber };
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileEvmClaims(req, res) {
  const { body, action, chainId } = recordBody(req);
  if (action !== "reconcile-evm-claims") return false;
  if (!EVM_LEAGUE_CHAINS.has(chainId)) {
    json(res, 400, { error: "EVM League reconciliation is only available on BNB/Robinhood EVM chains" });
    return true;
  }
  const recipient = String(body.recipient || body.address || "").trim().toLowerCase();
  if (!isAddress(recipient)) {
    json(res, 400, { error: "Invalid EVM League recipient" });
    return true;
  }

  try {
    const { rows } = await pool.query(
      `select
         w.chain_id as "chainId",
         w.period,
         w.epoch_start as "epochStart",
         w.category,
         w.rank,
         w.recipient_address as "recipientAddress",
         w.amount_raw as "amountRaw"
       from public.league_epoch_winners w
       left join public.league_epoch_payouts p
         on p.chain_id=w.chain_id
        and p.period=w.period
        and p.epoch_start=w.epoch_start
        and p.category=w.category
        and p.rank=w.rank
       where w.chain_id=$1
         and lower(w.recipient_address)=lower($2)
         and p.tx_hash is null
         and (w.epoch_end is null or w.epoch_end <= now())
         and (w.expires_at is null or w.expires_at > now())
       order by w.epoch_start desc, w.period desc, w.category asc, w.rank asc
       limit 20`,
      [chainId, recipient],
    );

    const items = [];
    const unresolved = [];
    for (const row of rows) {
      try {
        const verification = await discoverEvmLeagueClaimTransaction({
          chainId: row.chainId,
          period: row.period,
          epochStart: row.epochStart,
          category: row.category,
          rank: row.rank,
          recipient: row.recipientAddress,
          amountRaw: String(row.amountRaw),
          minConfirmations: minConfirmationsForChain(row.chainId),
        });
        if (!verification) {
          unresolved.push({
            period: row.period,
            epochStart: row.epochStart,
            category: row.category,
            rank: row.rank,
            code: "EVM_LEAGUE_NOT_CLAIMED_ONCHAIN",
          });
          continue;
        }
        items.push({
          period: row.period,
          epochStart: row.epochStart,
          category: row.category,
          rank: row.rank,
          ...(await persistRecoveredEvmLeagueClaim(row, verification)),
        });
      } catch (error) {
        console.warn("[leagueRouter] EVM League reconciliation deferred", {
          chainId: row.chainId,
          period: row.period,
          epochStart: row.epochStart,
          category: row.category,
          rank: row.rank,
          code: error?.code,
          message: error?.message,
        });
        unresolved.push({
          period: row.period,
          epochStart: row.epochStart,
          category: row.category,
          rank: row.rank,
          code: String(error?.code || "EVM_LEAGUE_RECONCILE_PENDING"),
        });
      }
    }

    json(res, 200, {
      ok: true,
      chainId,
      recipient,
      checkedCount: rows.length,
      reconciledCount: items.filter((item) => item.status === "reconciled").length,
      items,
      unresolved,
      reconciledAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.error("[leagueRouter] EVM League reconciliation failed", error);
    json(res, 500, { error: "League reconciliation failed", code: String(error?.code || "EVM_LEAGUE_RECONCILE_FAILED") });
    return true;
  }
}

export default async function handler(req, res) {
  const request = readRequest(req);

  if (request.monthId) {
    const suffix = request.wallet ? `/claimable/${request.wallet}` : "";
    const path = `/league/month/${request.monthId}${suffix}`;
    const proxyReq = {
      ...req,
      path,
      url: `${path}${request.search}`,
      originalUrl: `/api${path}${request.search}`,
    };
    return monthlyLeagueTreasury(proxyReq, res);
  }

  if (request.category === "recruiter_league") {
    return leagueRecruiter(req, res);
  }

  if (!canonicalizeSolanaLeagueRequest(req, res)) return;

  if (req.method === "POST") {
    const reconciled = await reconcileEvmClaims(req, res);
    if (reconciled) return;
  }

  if (isSolanaLeagueRecord(req)) {
    const verified = await verifySolanaRecord(req, res);
    if (!verified) return;
  }
  if (isEvmLeagueRecord(req)) {
    const verified = await verifyEvmRecord(req, res);
    if (!verified) return;
  }

  return league(req, res);
}
