import { pool } from "../../server/db.js";
import { readJson } from "../../server/http.js";
import rewardsHandler from "../rewards.js";
import {
  rewardClaimConfig as routedRewardClaimConfig,
  rewardClaimIntent as routedRewardClaimIntent,
  rewardClaimRecord as routedRewardClaimRecord,
} from "./reward-claim-battle-router.js";
import { canonicalSolanaClaimIdentity } from "../lib/solanaClaimEnvironment.js";

const EVM_CHAINS = new Set([56, 97, 4663, 46630]);
const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;

function send(res, status, payload) {
  if (typeof res.status === "function" && typeof res.json === "function") return res.status(status).json(payload);
  res.statusCode = status;
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  return res.end?.(JSON.stringify(payload));
}

function captureResponse() {
  const state = { status: 200, body: null, headers: {} };
  const response = {
    statusCode: 200,
    status(code) {
      state.status = Number(code);
      this.statusCode = state.status;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value;
    },
    end(raw) {
      if (raw == null || raw === "") state.body = null;
      else if (typeof raw === "string") {
        try { state.body = JSON.parse(raw); } catch { state.body = raw; }
      } else state.body = raw;
      state.status = Number(this.statusCode || state.status || 200);
      return this;
    },
  };
  return { response, state };
}

function normalizedWallet(body, chainId) {
  const raw = String(body?.address || body?.walletAddress || "").trim();
  return chainId === 101 ? raw : raw.toLowerCase();
}

function rewardIds(body) {
  return (Array.isArray(body?.rewardLedgerIds)
    ? body.rewardLedgerIds
    : [body?.rewardLedgerId || body?.id].filter(Boolean))
    .map((id) => String(id));
}

function canonicalizeSolanaBody(body) {
  const chainId = Number(body?.chainId || 56);
  if (chainId === 102) {
    const error = new Error("Solana claim chain 102 is retired. Use chain 101 with explicit staging/devnet or production/mainnet-beta identity.");
    error.code = "LEGACY_SOLANA_CLAIM_CHAIN_RETIRED";
    error.status = 400;
    throw error;
  }
  if (chainId !== 101) return body;
  const identity = canonicalSolanaClaimIdentity({
    chainId,
    environment: body?.environment,
    solanaCluster: body?.solanaCluster,
  });
  return {
    ...body,
    chainId: 101,
    environment: identity.environment,
    solanaCluster: identity.solanaCluster,
  };
}

function solanaProgramConfigured() {
  return Boolean(String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "").trim());
}

async function claimedRows(body) {
  const ids = rewardIds(body);
  const chainId = Number(body?.chainId || 56);
  const wallet = normalizedWallet(body, chainId);
  if (!ids.length || !wallet || !pool) return [];
  try {
    const { rows } = await pool.query(
      `select *
         from public.reward_ledger
        where id = any($1::uuid[])
          and ${chainId === 101 ? "wallet_address = $2" : "lower(wallet_address) = lower($2)"}
          and chain::text = $3::text
        order by created_at asc`,
      [ids, wallet, String(chainId)],
    );
    return rows;
  } catch {
    return [];
  }
}

function publicLedgerRow(row) {
  return {
    id: String(row.id),
    rewardType: row.reward_type,
    walletAddress: row.wallet_address,
    chain: row.chain,
    chainId: Number(row.chain),
    tokenSymbol: row.token_symbol,
    amount: String(row.amount || "0"),
    status: row.status,
    claimBatchId: row.claim_batch_id || null,
    claimTxHash: row.claim_tx_hash || null,
    claimError: row.claim_error || null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function reconcileCapturedEvmIntent(req, body, captured) {
  if (captured.state.status !== 202 || !captured.state.body?.claimIntent) return captured.state;
  if (!EVM_CHAINS.has(Number(body.chainId))) return captured.state;
  if (String(captured.state.body.claimIntent.id || "").startsWith("battle-claim-")) return captured.state;

  const calls = Array.isArray(captured.state.body.claimIntent.calls) ? captured.state.body.claimIntent.calls : [];
  const ids = rewardIds(body);
  if (!calls.length || !ids.length) return captured.state;

  const reconcileCapture = captureResponse();
  const reconcileReq = {
    ...req,
    method: "POST",
    body: {
      action: "reconcile-evm-claims",
      chainId: Number(body.chainId),
      walletAddress: normalizedWallet(body, Number(body.chainId)),
      rewardLedgerIds: ids,
    },
  };
  await rewardsHandler(reconcileReq, reconcileCapture.response);
  const reconcileBody = reconcileCapture.state.body || {};
  const recoveredIds = new Set(
    (Array.isArray(reconcileBody.items) ? reconcileBody.items : [])
      .filter((item) => item?.status === "reconciled" || item?.status === "already_claimed")
      .map((item) => String(item.rewardLedgerId)),
  );
  if (!recoveredIds.size) return captured.state;

  const rows = await claimedRows(body);
  const remainingCalls = calls.filter((call) => !recoveredIds.has(String(call.rewardLedgerId)));
  const responseBody = {
    ...captured.state.body,
    claimIntent: {
      ...captured.state.body.claimIntent,
      requiresWalletTransaction: remainingCalls.length > 0,
      calls: remainingCalls,
      recovered: true,
      reconciledCount: recoveredIds.size,
    },
    items: rows.length ? rows.map(publicLedgerRow) : captured.state.body.items,
    recovered: true,
    reconciledCount: recoveredIds.size,
    reconciliation: reconcileBody,
    idempotent: remainingCalls.length === 0,
    materializedAt: new Date().toISOString(),
  };
  return { status: remainingCalls.length ? 202 : 200, body: responseBody };
}

export async function rewardClaimConfig(req, res) {
  const chainId = Number(req.query?.chainId || req.query?.chain || 56);
  if (chainId === 102) {
    return send(res, 400, {
      ok: false,
      error: "Solana claim chain 102 is retired.",
      code: "LEGACY_SOLANA_CLAIM_CHAIN_RETIRED",
      supportedChains: [56, 97, 4663, 46630, 101],
    });
  }

  const captured = captureResponse();
  await routedRewardClaimConfig(req, captured.response);
  if (chainId !== 101 || captured.state.status >= 400) return send(res, captured.state.status, captured.state.body);

  let identity;
  try {
    identity = canonicalSolanaClaimIdentity({
      chainId: 101,
      environment: req.query?.environment,
      solanaCluster: req.query?.solanaCluster,
    });
  } catch (error) {
    return send(res, Number(error?.status) || 409, { ok: false, error: error?.message, code: error?.code || "INVALID_ENVIRONMENT" });
  }

  const programId = String(process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID || "").trim();
  const enabled = Boolean(programId);
  return send(res, 200, {
    ...captured.state.body,
    supportedChains: [56, 97, 4663, 46630, 101],
    disabledChains: enabled ? [] : [101],
    config: {
      ...(captured.state.body?.config || {}),
      chainId: 101,
      enabled,
      mode: enabled ? "solana_treasury" : "disabled",
      reason: enabled ? null : "MISSING_SOLANA_REWARDS_PROGRAM_ID",
      programId: enabled ? programId : "",
      environment: identity.environment,
      solanaCluster: identity.solanaCluster,
      supportedRewardTypes: ["airdrop", "squad"],
    },
  });
}

export async function rewardClaimIntent(req, res) {
  const rawBody = await readJson(req);
  let body;
  try {
    body = canonicalizeSolanaBody(rawBody);
  } catch (error) {
    return send(res, Number(error?.status) || 409, { ok: false, error: error?.message, code: error?.code || "INVALID_ENVIRONMENT" });
  }
  if (Number(body.chainId) === 101 && !solanaProgramConfigured()) {
    return send(res, 409, { ok: false, error: "Solana reward program is not configured.", code: "MISSING_SOLANA_REWARDS_PROGRAM_ID" });
  }
  req.body = body;

  const captured = captureResponse();
  await routedRewardClaimIntent(req, captured.response);

  if (EVM_CHAINS.has(Number(body.chainId))) {
    if (captured.state.status === 202) {
      const reconciled = await reconcileCapturedEvmIntent(req, body, captured);
      return send(res, reconciled.status, reconciled.body);
    }
    if (captured.state.status === 404) {
      const rows = await claimedRows(body);
      const ids = rewardIds(body);
      if (rows.length === ids.length && rows.every((row) => row.status === "claimed" && EVM_TX_RE.test(String(row.claim_tx_hash || "")))) {
        return send(res, 200, {
          ok: true,
          claimIntent: {
            id: rows[0]?.claim_batch_id || null,
            walletAddress: normalizedWallet(body, Number(body.chainId)),
            chainId: Number(body.chainId),
            mode: "reward_distributor_merkle",
            requiresWalletTransaction: false,
            calls: [],
          },
          items: rows.map(publicLedgerRow),
          recovered: false,
          idempotent: true,
          materializedAt: new Date().toISOString(),
        });
      }
    }
  }

  return send(res, captured.state.status, captured.state.body);
}

export async function rewardClaimRecord(req, res) {
  const rawBody = await readJson(req);
  let body;
  try {
    body = canonicalizeSolanaBody(rawBody);
  } catch (error) {
    return send(res, Number(error?.status) || 409, { ok: false, error: error?.message, code: error?.code || "INVALID_ENVIRONMENT" });
  }
  if (Number(body.chainId) === 101 && !solanaProgramConfigured()) {
    return send(res, 409, { ok: false, error: "Solana reward program is not configured.", code: "MISSING_SOLANA_REWARDS_PROGRAM_ID" });
  }
  req.body = body;
  return routedRewardClaimRecord(req, res);
}
