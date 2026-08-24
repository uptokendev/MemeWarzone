/**
 * Confirm an UP Vote from an on-chain tx receipt and write votes + vote_aggregates.
 *
 * Why: the indexer can miss VoteCast when flaky RPCs return empty eth_getLogs while
 * the votes cursor still advances. Featured ranks only from vote_aggregates, so a
 * successful wallet upvote would never appear until a tip re-scan (or this ingest).
 *
 * POST /api/votes/ingest  { chainId, txHash }
 * GET  /api/votes/ingest?chainId=&txHash=   (same, convenient for ops)
 */
import { ethers } from "ethers";
import { pool } from "../server/db.js";
import { badMethod, getQuery, isAddress, json, readJson } from "../server/http.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";

const VOTE_CAST_ABI = [
  "event VoteCast(address indexed campaign,address indexed voter,address indexed asset,uint256 amountPaid,bytes32 meta)",
];
const VOTE_IFACE = new ethers.Interface(VOTE_CAST_ABI);
const VOTE_TOPIC0 = VOTE_IFACE.getEvent("VoteCast").topicHash;

function normalizeHex(value) {
  const s = String(value || "").trim().toLowerCase();
  return s.startsWith("0x") ? s : s ? `0x${s}` : "";
}

function voteTreasuryForChain(chainId) {
  const id = Number(chainId);
  const per = String(
    process.env[`VOTE_TREASURY_ADDRESS_${id}`] ||
      process.env[`VITE_VOTE_TREASURY_ADDRESS_${id}`] ||
      "",
  )
    .trim()
    .toLowerCase();
  if (per && isAddress(per)) return per;
  const fallback = String(
    process.env.VOTE_TREASURY_ADDRESS || process.env.VITE_VOTE_TREASURY_ADDRESS || "",
  )
    .trim()
    .toLowerCase();
  return fallback && isAddress(fallback) ? fallback : "";
  // Known testnet deploy (chapel) — last resort so ingest works if env labels lag.
}

const KNOWN_TREASURIES = new Set(
  [
    "0xBa593e2aC9A728474bcbAe82Bc6c57B8034008b1", // bsc testnet
    String(process.env.VOTE_TREASURY_ADDRESS_97 || "").trim(),
    String(process.env.VITE_VOTE_TREASURY_ADDRESS_97 || "").trim(),
    String(process.env.VOTE_TREASURY_ADDRESS_56 || "").trim(),
    String(process.env.VITE_VOTE_TREASURY_ADDRESS_56 || "").trim(),
    String(process.env.VOTE_TREASURY_ADDRESS || "").trim(),
    String(process.env.VITE_VOTE_TREASURY_ADDRESS || "").trim(),
  ]
    .filter(Boolean)
    .map((a) => a.toLowerCase()),
);

async function patchVoteAggregates(chainId, campaign) {
  const r = await pool.query(
    `with v as (
       select
         count(*) filter (where block_timestamp >= now() - interval '1 hour') as votes_1h,
         count(*) filter (where block_timestamp >= now() - interval '24 hours') as votes_24h,
         count(*) filter (where block_timestamp >= now() - interval '7 days') as votes_7d,
         count(*) as votes_all_time,
         count(*) filter (where block_timestamp >= now() - interval '24 hours') as b0,
         count(*) filter (
           where block_timestamp < now() - interval '24 hours'
             and block_timestamp >= now() - interval '48 hours'
         ) as b1,
         count(*) filter (
           where block_timestamp < now() - interval '48 hours'
             and block_timestamp >= now() - interval '72 hours'
         ) as b2,
         max(block_timestamp) as last_vote_at
       from public.votes
       where chain_id=$1 and campaign_address=$2 and status='confirmed'
     )
     select
       coalesce(votes_1h,0)::int as votes_1h,
       coalesce(votes_24h,0)::int as votes_24h,
       coalesce(votes_7d,0)::int as votes_7d,
       coalesce(votes_all_time,0)::int as votes_all_time,
       (coalesce(b0,0) * 1.0 + coalesce(b1,0) * 0.5 + coalesce(b2,0) * 0.25) as trending_score,
       last_vote_at
     from v`,
    [chainId, campaign.toLowerCase()],
  );
  const x = r.rows[0] || {
    votes_1h: 0,
    votes_24h: 0,
    votes_7d: 0,
    votes_all_time: 0,
    trending_score: 0,
    last_vote_at: null,
  };
  await pool.query(
    `insert into public.vote_aggregates(
        chain_id,campaign_address,
        votes_1h,votes_24h,votes_7d,votes_all_time,trending_score,
        last_vote_at,updated_at
     ) values($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (chain_id,campaign_address) do update set
       votes_1h=excluded.votes_1h,
       votes_24h=excluded.votes_24h,
       votes_7d=excluded.votes_7d,
       votes_all_time=excluded.votes_all_time,
       trending_score=excluded.trending_score,
       last_vote_at=excluded.last_vote_at,
       updated_at=now()`,
    [
      chainId,
      campaign.toLowerCase(),
      Number(x.votes_1h || 0),
      Number(x.votes_24h || 0),
      Number(x.votes_7d || 0),
      Number(x.votes_all_time || 0),
      Number(x.trending_score || 0),
      x.last_vote_at,
    ],
  );
  return {
    votes1h: Number(x.votes_1h || 0),
    votes24h: Number(x.votes_24h || 0),
    votes7d: Number(x.votes_7d || 0),
    votesAllTime: Number(x.votes_all_time || 0),
    lastVoteAt: x.last_vote_at,
  };
}

async function ingestTx({ chainId, txHash }) {
  if (!pool) {
    const err = new Error("DATABASE_URL not configured");
    err.status = 503;
    throw err;
  }
  if (!Number.isFinite(chainId) || (chainId !== 56 && chainId !== 97)) {
    const err = new Error("Invalid chainId (expected 56 or 97)");
    err.status = 400;
    throw err;
  }
  const hash = normalizeHex(txHash);
  if (!/^0x[a-f0-9]{64}$/.test(hash)) {
    const err = new Error("Invalid txHash");
    err.status = 400;
    throw err;
  }

  const configured = voteTreasuryForChain(chainId);
  const allowed = new Set(KNOWN_TREASURIES);
  if (configured) allowed.add(configured);

  const provider = await getServerReadProvider(chainId);
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) {
    const err = new Error("Transaction receipt not found yet");
    err.status = 404;
    throw err;
  }
  if (Number(receipt.status) === 0) {
    const err = new Error("Transaction failed on-chain");
    err.status = 400;
    throw err;
  }

  const block = await provider.getBlock(receipt.blockNumber);
  const blockTime = new Date(Number(block?.timestamp || 0) * 1000);
  const ingested = [];

  for (const log of receipt.logs || []) {
    const addr = String(log.address || "").toLowerCase();
    if (allowed.size && !allowed.has(addr)) continue;
    const topic0 = String(log.topics?.[0] || "").toLowerCase();
    if (topic0 !== VOTE_TOPIC0.toLowerCase()) continue;

    let parsed;
    try {
      parsed = VOTE_IFACE.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;

    const campaign = String(parsed.args.campaign || "").toLowerCase();
    const voter = String(parsed.args.voter || "").toLowerCase();
    const asset = String(parsed.args.asset || "").toLowerCase();
    const amountRaw = BigInt(parsed.args.amountPaid ?? 0);
    const meta = String(parsed.args.meta || "");
    if (!isAddress(campaign) || !isAddress(voter)) continue;

    await pool.query(
      `insert into public.votes(
          chain_id,campaign_address,voter_address,asset_address,amount_raw,
          tx_hash,log_index,block_number,block_timestamp,meta,status
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed')
       on conflict (chain_id,tx_hash,log_index) do nothing`,
      [
        chainId,
        campaign,
        voter,
        asset || ethers.ZeroAddress,
        amountRaw.toString(),
        hash,
        Number(log.index ?? log.logIndex ?? 0),
        Number(receipt.blockNumber),
        blockTime,
        meta.toLowerCase(),
      ],
    );

    try {
      await pool.query(
        `insert into public.campaign_activity (chain_id, campaign_address, last_activity_at, updated_at)
         values ($1, $2, $3, now())
         on conflict (chain_id, campaign_address) do update set
           last_activity_at = greatest(excluded.last_activity_at, coalesce(public.campaign_activity.last_activity_at, to_timestamp(0))),
           updated_at = now()`,
        [chainId, campaign, blockTime],
      );
    } catch {
      // optional table
    }

    const aggregates = await patchVoteAggregates(chainId, campaign);
    ingested.push({
      chainId,
      campaignAddress: campaign,
      voterAddress: voter,
      assetAddress: asset,
      amountRaw: amountRaw.toString(),
      txHash: hash,
      logIndex: Number(log.index ?? log.logIndex ?? 0),
      blockNumber: Number(receipt.blockNumber),
      ...aggregates,
    });
  }

  if (!ingested.length) {
    const err = new Error(
      "No VoteCast logs found in this transaction for a known UP Vote treasury",
    );
    err.status = 422;
    throw err;
  }

  try {
    const { publishLeagueCampaignPatch } = await import("./lib/leagueAblyPublish.js");
    await publishLeagueCampaignPatch(
      chainId,
      ingested.map((row) => ({
        campaignAddress: row.campaignAddress,
        votes24h: row.votes24h,
        votesAllTime: row.votesAllTime,
        lastActivityAt: Math.floor(Date.now() / 1000),
      })),
    );
  } catch {
    // Ably must never fail a confirmed vote ingest.
  }

  return { ok: true, items: ingested, updatedAt: new Date().toISOString() };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return badMethod(res);

  try {
    let chainId;
    let txHash;
    if (req.method === "POST") {
      const body = await readJson(req);
      chainId = Number(body?.chainId ?? body?.chain_id);
      txHash = body?.txHash ?? body?.tx_hash ?? body?.hash;
    } else {
      const q = getQuery(req);
      chainId = Number(q.chainId ?? q.chain_id);
      txHash = q.txHash ?? q.tx_hash ?? q.hash;
    }

    const result = await ingestTx({ chainId, txHash });
    return json(res, 200, result);
  } catch (e) {
    const status = Number(e?.status || 500);
    if (status >= 500) console.error("[api/votes/ingest]", e);
    return json(res, status, { error: e?.message || "Server error" });
  }
}
