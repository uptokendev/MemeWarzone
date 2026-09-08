import { pool } from "../../server/db.js";
import { readJson } from "../../server/http.js";
import { requireWalletActionAuth } from "../lib/walletActionAuth.js";
import {
  RewardClaimVerificationError,
  verifyEvmRewardClaim,
} from "../lib/rewardClaimVerification.js";
import {
  buildSolanaRewardCall,
  isSolanaSignature,
  verifySolanaRewardClaim,
} from "../lib/solanaRewardClaim.js";

const EVM_CHAINS = new Set([56, 97, 4663, 46630]);
const ROBINHOOD_CHAINS = new Set([4663, 46630]);
const SOLANA_CHAINS = new Set([101, 102]);
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;

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

function normalizeWallet(value, chainId) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (SOLANA_CHAINS.has(Number(chainId))) return raw;
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

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function cleanAddress(value) {
  const address = String(value || "").trim();
  return ADDRESS_RE.test(address) ? address : "";
}

function rowChainId(row) {
  const metadata = readMeta(row);
  const rawChain = String(row?.chain ?? "").trim().toLowerCase();
  if (rawChain === "solana" || rawChain === "sol") return Number(metadata.chainId) || 101;
  if (rawChain === "robinhood" || rawChain === "rh") return Number(metadata.chainId) || 46630;
  const numeric = Number(row?.chain);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const metadataChain = Number(metadata.chainId);
  return Number.isFinite(metadataChain) && metadataChain > 0 ? metadataChain : 56;
}

function envDistributorAddress(chainId) {
  const chain = Number(chainId);
  const candidates = [
    process.env[`REWARD_DISTRIBUTOR_ADDRESS_${chain}`],
    process.env[`VITE_REWARD_DISTRIBUTOR_ADDRESS_${chain}`],
    chain === 97 ? process.env.BNB_TESTNET_REWARD_DISTRIBUTOR_ADDRESS : null,
    chain === 56 ? process.env.BNB_REWARD_DISTRIBUTOR_ADDRESS : null,
    chain === 56 ? process.env.REWARD_DISTRIBUTOR_ADDRESS_BNB : null,
    process.env.REWARD_DISTRIBUTOR_ADDRESS,
    process.env.VITE_REWARD_DISTRIBUTOR_ADDRESS,
  ];
  return cleanAddress(candidates.find(Boolean));
}

function chainClaimConfig(chainId) {
  const chain = Number(chainId) || 56;
  if (SOLANA_CHAINS.has(chain)) {
    return {
      chainId: chain,
      tokenSymbol: "SOL",
      enabled: true,
      mode: "solana_treasury",
      reason: null,
      distributorAddress: "",
      supportedRewardTypes: ["airdrop"],
    };
  }

  const distributorAddress = EVM_CHAINS.has(chain) ? envDistributorAddress(chain) : "";
  return {
    chainId: chain,
    tokenSymbol: ROBINHOOD_CHAINS.has(chain) ? "ETH" : "BNB",
    enabled: Boolean(distributorAddress),
    mode: distributorAddress ? "reward_distributor_merkle" : "disabled",
    reason: distributorAddress ? null : "MISSING_DISTRIBUTOR_ADDRESS",
    distributorAddress,
    supportedRewardTypes: ["league", "airdrop", "recruiter", "squad", "manual", "future"],
  };
}

function explorerTxBase(chainId) {
  const chain = Number(chainId);
  if (chain === 97) return "https://testnet.bscscan.com/tx/";
  if (chain === 56) return "https://bscscan.com/tx/";
  if (chain === 46630) return "https://explorer.testnet.chain.robinhood.com/tx/";
  if (chain === 4663) return "https://robinhoodchain.blockscout.com/tx/";
  return "";
}

function readProof(metadata) {
  const candidate = Array.isArray(metadata.merkleProof)
    ? metadata.merkleProof
    : Array.isArray(metadata.proof)
      ? metadata.proof
      : Array.isArray(metadata.claimProof)
        ? metadata.claimProof
        : null;

  if (!candidate) return { proof: [], hasProofMetadata: false, valid: false };
  const proof = candidate.map((value) => String(value || "").trim()).filter(Boolean);
  return { proof, hasProofMetadata: true, valid: proof.every((value) => BYTES32_RE.test(value)) };
}

function batchIdFromMetadata(metadata) {
  const raw = firstString(metadata, [
    "contractBatchId",
    "merkleBatchId",
    "batchIdBytes32",
    "rewardBatchBytes32",
    "claimBatchBytes32",
  ]);
  return BYTES32_RE.test(raw) ? raw : "";
}

function distributorFromMetadata(metadata, chainId) {
  const raw = firstString(metadata, [
    "distributorAddress",
    "rewardDistributorAddress",
    "claimContractAddress",
    "contractAddress",
  ]);
  return cleanAddress(raw) || envDistributorAddress(chainId);
}

function claimCallForRow(row) {
  const chainId = rowChainId(row);
  if (SOLANA_CHAINS.has(chainId)) return buildSolanaRewardCall(row);

  const metadata = readMeta(row);
  const amount = String(row.amount ?? "0");
  const base = chainClaimConfig(chainId);
  const distributorAddress = distributorFromMetadata(metadata, chainId);
  const contractBatchId = batchIdFromMetadata(metadata);
  const { proof, hasProofMetadata, valid } = readProof(metadata);
  const amountOk = /^\d+$/.test(amount) && BigInt(amount) > 0n;

  let reason = null;
  if (!distributorAddress) reason = "MISSING_DISTRIBUTOR_ADDRESS";
  else if (!contractBatchId) reason = "MISSING_CONTRACT_BATCH_ID";
  else if (!hasProofMetadata) reason = "MISSING_MERKLE_PROOF";
  else if (!valid) reason = "INVALID_MERKLE_PROOF";
  else if (!amountOk) reason = "AMOUNT_ZERO";

  return {
    rewardLedgerId: String(row.id),
    chainId,
    tokenSymbol: row.token_symbol || base.tokenSymbol,
    mode: "reward_distributor_merkle",
    enabled: !reason,
    reason,
    distributorAddress,
    contractAddress: distributorAddress,
    contractName: "RewardDistributor",
    functionName: "claim",
    functionSignature: "claim(bytes32,uint256,bytes32[])",
    contractBatchId,
    batchId: contractBatchId,
    amount,
    proof,
    args: contractBatchId ? [contractBatchId, amount, proof] : [],
    explorerTxBase: explorerTxBase(chainId),
  };
}

function sameTxHash(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function minConfirmationsForChain(chainId) {
  const chain = Number(chainId);
  const value = Number(
    process.env[`REWARD_CLAIM_MIN_CONFIRMATIONS_${chain}`] ||
      process.env.REWARD_CLAIM_MIN_CONFIRMATIONS ||
      1,
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

async function requireStrictClaimAuth({ res, auth, wallet, chainId, action, routeLabel }) {
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth,
    expectedWallet: wallet,
    chainId,
    action,
    routeLabel,
  });
  if (!verified) return null;
  if (verified.legacy) {
    json(res, 401, {
      error: "Wallet signature required for reward claims.",
      code: "WALLET_SIGNATURE_REQUIRED",
    });
    return null;
  }
  return verified;
}

function validateRequestedChain(rows, requestedChainId) {
  const expected = Number(requestedChainId);
  for (const row of rows) {
    if (rowChainId(row) !== expected) return false;
  }
  return true;
}

async function writeAudit(client, { batchId = null, rewardLedgerId = null, action, oldValue = null, newValue = null, reason = null, req = null, txHash = null, metadata = {} }) {
  const actorId = String(req?.headers?.["x-admin-email"] || req?.headers?.["x-user-email"] || "api");
  await client.query(
    `insert into public.reward_audit_logs (batch_id, reward_ledger_id, actor_type, actor_id, action, old_value, new_value, reason, tx_hash, metadata)
     values ($1, $2, 'api', $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [batchId, rewardLedgerId, actorId, action, oldValue, newValue, reason, txHash, JSON.stringify(metadata || {})],
  );
}

async function refreshBatchCounts(client, rewardLedgerIds) {
  const { rows } = await client.query(
    `select distinct batch_id
       from public.reward_batch_items
      where reward_ledger_id = any($1::uuid[])
        and batch_id is not null`,
    [rewardLedgerIds],
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

function ledgerItem(row) {
  return {
    id: String(row.id),
    rewardType: row.reward_type,
    walletAddress: row.wallet_address,
    chain: row.chain,
    chainId: rowChainId(row),
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

async function verifyClaimRow(row, txHash, wallet) {
  const chainId = rowChainId(row);
  if (SOLANA_CHAINS.has(chainId)) return verifySolanaRewardClaim({ row, txHash, walletAddress: wallet });

  const claim = claimCallForRow(row);
  if (!claim.enabled) {
    throw new RewardClaimVerificationError(
      claim.reason || "CLAIM_NOT_READY",
      "Reward is not ready for on-chain verification.",
      409,
    );
  }
  return verifyEvmRewardClaim({
    chainId: claim.chainId,
    txHash,
    walletAddress: wallet,
    distributorAddress: claim.distributorAddress,
    batchId: claim.contractBatchId,
    amount: claim.amount,
    minConfirmations: minConfirmationsForChain(claim.chainId),
  });
}

function verificationHttp(error) {
  if (error instanceof RewardClaimVerificationError) {
    return { status: error.status || 409, body: { error: error.message, code: error.code } };
  }
  if (error?.code && Number(error?.status)) {
    return { status: Number(error.status), body: { error: error.message || "Claim verification failed", code: error.code } };
  }
  return null;
}

export async function rewardClaimConfig(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  const chainId = Number(req.query?.chainId || req.query?.chain || 56);
  const config = chainClaimConfig(chainId);
  return json(res, 200, {
    config,
    supportedChains: [56, 97, 4663, 46630, 101, 102],
    disabledChains: [],
    contract: SOLANA_CHAINS.has(chainId)
      ? {
          name: "mwz_rewards_treasury",
          claimFunction: "claim_airdrop(i64,u8,u64,Vec<[u8;32]>)",
          nativeTokenOnly: true,
          supportedRewardTypes: config.supportedRewardTypes,
        }
      : {
          name: "RewardDistributor",
          claimFunction: "claim(bytes32,uint256,bytes32[])",
          nativeTokenOnly: true,
        },
    materializedAt: new Date().toISOString(),
  });
}

export async function rewardClaimIntent(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const ids = Array.isArray(body.rewardLedgerIds) ? body.rewardLedgerIds : [body.rewardLedgerId || body.id].filter(Boolean);
  const chainId = Number(body.chainId || 56);
  const address = String(body.address || body.walletAddress || "").trim();
  const wallet = normalizeWallet(address, chainId);

  if (!ids.length || !wallet) return json(res, 400, { error: "Missing rewardLedgerIds or walletAddress" });
  if (!EVM_CHAINS.has(chainId) && !SOLANA_CHAINS.has(chainId)) {
    return json(res, 400, { error: "Unsupported reward claim chain.", code: "UNSUPPORTED_CLAIM_CHAIN" });
  }

  const verified = await requireStrictClaimAuth({
    res,
    auth: body.auth || body,
    wallet,
    chainId,
    action: "claim_intent",
    routeLabel: "rewards/claim_intent",
  });
  if (!verified) return;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: existing } = await client.query(
      `select *
         from public.reward_ledger
        where id = any($1::uuid[])
          and wallet_address = $2
          and status in ('claimable', 'claim_pending', 'failed')
        order by created_at asc
        for update`,
      [ids, wallet],
    );

    if (existing.length !== ids.length) {
      await client.query("rollback");
      return json(res, 404, { error: "One or more rewards are not claimable for this wallet." });
    }
    if (!validateRequestedChain(existing, chainId)) {
      await client.query("rollback");
      return json(res, 409, { error: "Reward entitlement belongs to a different chain.", code: "REWARD_CHAIN_MISMATCH" });
    }

    const calls = existing.map(claimCallForRow);
    const invalid = calls.find((call) => !call.enabled);
    if (invalid) {
      await client.query("rollback");
      return json(res, 409, {
        error: "Reward is not ready for on-chain claiming.",
        code: invalid.reason || "CLAIM_NOT_READY",
        claim: invalid,
      });
    }
    if (SOLANA_CHAINS.has(chainId) && calls.some((call) => call.mode !== "solana_airdrop")) {
      await client.query("rollback");
      return json(res, 409, { error: "This Solana reward type does not have a native settlement lane yet.", code: "SOLANA_REWARD_LANE_NOT_READY" });
    }

    const intentId = `claim-${Date.now()}`;
    const { rows } = await client.query(
      `update public.reward_ledger
          set status = 'claim_pending',
              claim_batch_id = coalesce(claim_batch_id, $3),
              claim_error = null,
              updated_at = now()
        where id = any($1::uuid[])
          and wallet_address = $2
          and status in ('claimable', 'claim_pending', 'failed')
        returning *`,
      [ids, wallet, intentId],
    );

    await client.query(`update public.reward_batch_items set status = 'claim_pending' where reward_ledger_id = any($1::uuid[])`, [ids]);
    await refreshBatchCounts(client, ids);

    for (const row of rows) {
      await writeAudit(client, {
        rewardLedgerId: row.id,
        action: "claim_intent_created",
        oldValue: "claimable_or_pending",
        newValue: "claim_pending",
        reason: body.reason || "User claim intent created",
        req,
        metadata: { intentId: row.claim_batch_id || intentId, callCount: calls.length, chainId },
      });
    }

    await client.query("commit");
    return json(res, 202, {
      claimIntent: {
        id: rows[0]?.claim_batch_id || intentId,
        walletAddress: wallet,
        chainId,
        mode: SOLANA_CHAINS.has(chainId) ? "solana_treasury" : "reward_distributor_merkle",
        requiresWalletTransaction: true,
        calls,
      },
      items: rows.map(ledgerItem),
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error("[rewards/claim-intent]", error);
    return json(res, 500, { error: "Server error" });
  } finally {
    client.release();
  }
}

export async function rewardClaimRecord(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  const body = await readJson(req);
  const ids = Array.isArray(body.rewardLedgerIds) ? body.rewardLedgerIds : [body.rewardLedgerId || body.id].filter(Boolean);
  const chainId = Number(body.chainId || 56);
  const wallet = normalizeWallet(body.address || body.walletAddress, chainId);
  const txHash = String(body.txHash || body.claimTxHash || "").trim();
  const failed = String(body.status || "claimed").toLowerCase() === "failed";
  const claimError = String(body.claimError || body.error || "").trim();

  if (!ids.length || !wallet) return json(res, 400, { error: "Missing rewardLedgerIds or walletAddress" });
  if (!EVM_CHAINS.has(chainId) && !SOLANA_CHAINS.has(chainId)) {
    return json(res, 400, { error: "Unsupported reward claim chain.", code: "UNSUPPORTED_CLAIM_CHAIN" });
  }
  if (!failed && ids.length !== 1) {
    return json(res, 400, {
      error: "Each on-chain claim transaction must map to exactly one reward entitlement.",
      code: "CLAIM_TX_REWARD_COUNT_INVALID",
    });
  }

  const verifiedAuth = await requireStrictClaimAuth({
    res,
    auth: body.auth || body,
    wallet,
    chainId,
    action: "claim_record",
    routeLabel: "rewards/claim_record",
  });
  if (!verifiedAuth) return;
  if (!failed) {
    const validTx = SOLANA_CHAINS.has(chainId) ? isSolanaSignature(txHash) : EVM_TX_RE.test(txHash);
    if (!validTx) return json(res, 400, { error: "Missing or invalid txHash" });
  }
  if (failed && !claimError) return json(res, 400, { error: "Missing claimError for failed claim" });

  let verification = null;
  if (!failed) {
    try {
      const { rows: candidates } = await pool.query(
        `select *
           from public.reward_ledger
          where id = $1::uuid
            and wallet_address = $2
          limit 1`,
        [ids[0], wallet],
      );
      const candidate = candidates[0];
      if (!candidate) return json(res, 404, { error: "Reward entitlement was not found for this wallet." });
      if (rowChainId(candidate) !== chainId) {
        return json(res, 409, { error: "Reward entitlement belongs to a different chain.", code: "REWARD_CHAIN_MISMATCH" });
      }
      if (candidate.status === "claimed" && candidate.claim_tx_hash && !sameTxHash(candidate.claim_tx_hash, txHash)) {
        return json(res, 409, { error: "Reward has already been finalized with a different transaction.", code: "CLAIM_ALREADY_RECORDED" });
      }
      verification = await verifyClaimRow(candidate, txHash, wallet);
    } catch (error) {
      const known = verificationHttp(error);
      if (known) return json(res, known.status, known.body);
      if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
      console.error("[rewards/claim-record verify]", error);
      return json(res, 503, { error: "Could not verify claim transaction on-chain.", code: "CLAIM_VERIFY_UNAVAILABLE" });
    }
  }

  const targetStatus = failed ? "failed" : "claimed";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: beforeRows } = await client.query(
      `select *
         from public.reward_ledger
        where id = any($1::uuid[])
          and wallet_address = $2
        for update`,
      [ids, wallet],
    );

    if (beforeRows.length !== ids.length) {
      await client.query("rollback");
      return json(res, 404, { error: "One or more rewards could not be recorded for this wallet." });
    }
    if (!validateRequestedChain(beforeRows, chainId)) {
      await client.query("rollback");
      return json(res, 409, { error: "Reward entitlement belongs to a different chain.", code: "REWARD_CHAIN_MISMATCH" });
    }

    if (failed) {
      const alreadyClaimed = beforeRows.find((row) => row.status === "claimed");
      if (alreadyClaimed) {
        await client.query("rollback");
        return json(res, 409, { error: "A confirmed reward claim cannot be changed to failed.", code: "CLAIM_ALREADY_RECORDED" });
      }
    } else {
      const row = beforeRows[0];
      if (row.status === "claimed") {
        if (!sameTxHash(row.claim_tx_hash, txHash)) {
          await client.query("rollback");
          return json(res, 409, { error: "Reward has already been finalized with a different transaction.", code: "CLAIM_ALREADY_RECORDED" });
        }
        await client.query("commit");
        return json(res, 200, {
          items: beforeRows.map(ledgerItem),
          idempotent: true,
          verification,
          materializedAt: new Date().toISOString(),
        });
      }
      if (!["claim_pending", "claimable", "failed"].includes(String(row.status))) {
        await client.query("rollback");
        return json(res, 409, { error: "Reward is not in a state that can be finalized.", code: "CLAIM_STATE_INVALID" });
      }

      const { rows: txConflicts } = SOLANA_CHAINS.has(chainId)
        ? await client.query(
            `select id from public.reward_ledger where coalesce(claim_tx_hash, '') = $1 and id <> $2::uuid limit 1`,
            [txHash, row.id],
          )
        : await client.query(
            `select id from public.reward_ledger where lower(coalesce(claim_tx_hash, '')) = lower($1) and id <> $2::uuid limit 1`,
            [txHash, row.id],
          );
      if (txConflicts.length) {
        await client.query("rollback");
        return json(res, 409, { error: "This transaction has already been attached to another reward entitlement.", code: "CLAIM_TX_ALREADY_USED" });
      }
    }

    const verificationMetadata = verification
      ? { ...verification, verifiedAt: new Date().toISOString() }
      : null;

    const { rows } = await client.query(
      `update public.reward_ledger
          set status = $3,
              claim_tx_hash = case when $3 = 'claimed' then $4 else claim_tx_hash end,
              claim_error = case when $3 = 'failed' then $5 else null end,
              claimed_at = case when $3 = 'claimed' then coalesce(claimed_at, now()) else claimed_at end,
              metadata = case
                when $3 = 'claimed' then coalesce(metadata, '{}'::jsonb) || jsonb_build_object('claimVerification', $6::jsonb)
                else metadata
              end,
              updated_at = now()
        where id = any($1::uuid[])
          and wallet_address = $2
        returning *`,
      [ids, wallet, targetStatus, txHash || null, claimError || null, JSON.stringify(verificationMetadata)],
    );

    await client.query(`update public.reward_batch_items set status = $2 where reward_ledger_id = any($1::uuid[])`, [ids, targetStatus]);
    await refreshBatchCounts(client, ids);

    for (const row of rows) {
      await writeAudit(client, {
        rewardLedgerId: row.id,
        action: targetStatus === "claimed" ? "claim_recorded_verified" : "claim_failed",
        oldValue: beforeRows.find((before) => String(before.id) === String(row.id))?.status || "claim_pending",
        newValue: targetStatus,
        reason: body.reason || (targetStatus === "claimed" ? "On-chain reward claim verified and finalized" : "Wallet claim transaction failed"),
        txHash: txHash || null,
        req,
        metadata: {
          claimError: claimError || null,
          claimIntentId: body.claimIntentId || null,
          claimVerification: verificationMetadata,
        },
      });
    }

    await client.query("commit");
    return json(res, 200, {
      items: rows.map(ledgerItem),
      verification,
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    const known = verificationHttp(error);
    if (known) return json(res, known.status, known.body);
    if (schemaMissing(error)) return json(res, 503, { error: "Reward ledger schema is not installed.", code: "REWARD_SCHEMA_MISSING" });
    console.error("[rewards/claim-record]", error);
    return json(res, 500, { error: "Server error" });
  } finally {
    client.release();
  }
}