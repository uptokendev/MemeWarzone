import { ethers } from "ethers";

import { pool } from "../server/db.js";
import { badMethod, getQuery, isSolanaAddress, isSolanaChain, json, readJson } from "../server/http.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import { resolveArenaVoteToken } from "./lib/arenaEligibility.js";
import {
  arenaVotingConfigured,
  assertArenaEvmTreasury,
  assertArenaSolanaTreasury,
} from "./lib/arenaVoteTreasury.js";
import {
  describeVoterTransfers,
  extractSolTransfer,
  fetchSolUsdMicros,
  fetchVoteTransaction,
} from "./dev-fix/solana-vote-ingest.js";

const UPVOTE_USD_TARGET = 3;
const VOTE_CAST_ABI = [
  "event VoteCast(address indexed campaign,address indexed voter,address indexed asset,uint256 amountPaid,bytes32 meta)",
];
const VOTE_IFACE = new ethers.Interface(VOTE_CAST_ABI);
const VOTE_TOPIC0 = VOTE_IFACE.getEvent("VoteCast").topicHash;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MEMO_PROGRAMS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

function ident(value) {
  return String(value || "").trim();
}

function normalizeHex(value) {
  const s = String(value || "").trim().toLowerCase();
  return s.startsWith("0x") ? s : s ? `0x${s}` : "";
}

async function namesFor(chainId, token) {
  const resolved = await resolveArenaVoteToken(pool, chainId, token);
  if (resolved) return { name: resolved.name, symbol: resolved.symbol, origin: resolved.origin };
  return { name: null, symbol: null, origin: null };
}

async function patchArenaAggregates(chainId, tokenAddress) {
  const result = await pool.query(
    `with v as (
       select
         count(*) filter (where coalesce(block_timestamp, created_at) >= now() - interval '24 hours') as votes_24h,
         count(*) as votes_all_time
       from public.arena_votes
      where chain_id = $1 and lower(token_address) = lower($2)
     )
     select coalesce(votes_24h,0)::int as votes_24h, coalesce(votes_all_time,0)::int as votes_all_time from v`,
    [chainId, tokenAddress],
  );
  const row = result.rows[0] || { votes_24h: 0, votes_all_time: 0 };
  await pool.query(
    `insert into public.arena_vote_aggregates (chain_id, token_address, votes_24h, votes_all_time, updated_at)
     values ($1,$2,$3,$4,now())
     on conflict (chain_id, token_address) do update set
       votes_24h = excluded.votes_24h,
       votes_all_time = excluded.votes_all_time,
       updated_at = now()`,
    [chainId, tokenAddress, Number(row.votes_24h || 0), Number(row.votes_all_time || 0)],
  );
  return { votes24h: Number(row.votes_24h || 0), votesAllTime: Number(row.votes_all_time || 0) };
}

async function insertArenaVote(row) {
  await pool.query(
    `insert into public.arena_votes (
        chain_id, token_address, voter_wallet, amount_native, tx_hash,
        block_timestamp, asset_address, amount_raw, log_index
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict do nothing`,
    [
      row.chainId,
      row.tokenAddress,
      row.voterWallet,
      row.amountNative,
      row.txHash,
      row.blockTimestamp,
      row.assetAddress || null,
      row.amountRaw || null,
      Number(row.logIndex || 0),
    ],
  );
}

async function fetchUsd(assetId, binanceSymbol) {
  const sources = [
    async () => {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${assetId}&vs_currencies=usd`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
      const body = await response.json();
      return Number(body?.[assetId]?.usd);
    },
    async () => {
      const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      const body = await response.json();
      return Number(body?.price);
    },
  ];
  for (const source of sources) {
    try {
      const price = await source();
      if (Number.isFinite(price) && price > 0) return price;
    } catch {
      // next
    }
  }
  return 0;
}

function minNativeWei(usdPrice, decimals) {
  const native = UPVOTE_USD_TARGET / usdPrice;
  const raw = ethers.parseUnits(native.toFixed(decimals), decimals);
  return (raw * 90n) / 100n;
}

function pubkeyOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value.pubkey === "string") return value.pubkey.trim();
  if (value.pubkey && typeof value.pubkey.toString === "function") return String(value.pubkey.toString()).trim();
  return "";
}

function flattenAccountKeys(tx) {
  const message = tx?.transaction?.message || {};
  const staticKeys = message.accountKeys || message.staticAccountKeys || [];
  const keys = (Array.isArray(staticKeys) ? staticKeys : []).map(pubkeyOf).filter(Boolean);
  const loaded = tx?.meta?.loadedAddresses || {};
  for (const list of [loaded.writable, loaded.readonly]) {
    for (const item of list || []) {
      const key = pubkeyOf(item);
      if (key) keys.push(key);
    }
  }
  return keys;
}

function collectInstructions(tx) {
  const message = tx?.transaction?.message || {};
  const outer = message.instructions || [];
  const inner = tx?.meta?.innerInstructions || [];
  const out = [...outer];
  for (const group of inner) {
    for (const ix of group.instructions || []) out.push(ix);
  }
  return out;
}

function decodeIxData(data) {
  if (!data) return "";
  if (typeof data === "string") {
    try {
      return Buffer.from(data, "base64").toString("utf8");
    } catch {
      return data;
    }
  }
  return "";
}

function extractArenaMemoToken(tx) {
  const keys = flattenAccountKeys(tx);
  for (const ix of collectInstructions(tx)) {
    const program = pubkeyOf(ix.programId) || keys[Number(ix.programIdIndex ?? -1)] || String(ix.program || "");
    const parsedMemo = typeof ix.parsed === "string" ? ix.parsed : "";
    const memo = parsedMemo || decodeIxData(ix.data);
    if (MEMO_PROGRAMS.has(program) || program === "spl-memo" || /mwz-arena-upvote:/.test(memo)) {
      const match = String(memo).match(/mwz-arena-upvote:([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (match?.[1]) return match[1];
    }
  }
  for (const line of tx?.meta?.logMessages || []) {
    const match = String(line).match(/mwz-arena-upvote:([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (match?.[1]) return match[1];
  }
  return "";
}

async function handleFeatured(req, res) {
  const query = getQuery(req);
  const chainId = Number(query.chainId || 0);
  const limit = Math.max(1, Math.min(20, Number(query.limit) || 20));
  const params = [];
  let where = "";
  if (Number.isFinite(chainId) && chainId > 0) {
    params.push(chainId);
    where = "where chain_id = $1";
  }
  params.push(Math.max(limit * 4, 40));
  const result = await pool.query(
    `select chain_id, token_address, votes_24h, votes_all_time, updated_at
       from public.arena_vote_aggregates
      ${where}
      order by votes_24h desc, votes_all_time desc, updated_at desc
      limit $${params.length}`,
    params,
  );
  const items = [];
  for (const row of result.rows) {
    const names = await namesFor(row.chain_id, row.token_address);
    if (!names.origin) continue;
    items.push({
      chainId: Number(row.chain_id),
      tokenAddress: ident(row.token_address),
      tokenName: String(names.name || names.symbol || "Unknown"),
      symbol: String(names.symbol || "---"),
      votes24h: Number(row.votes_24h || 0),
      votesAllTime: Number(row.votes_all_time || 0),
    });
    if (items.length >= limit) break;
  }
  const votingLive = arenaVotingConfigured();
  return json(res, 200, {
    items,
    updatedAt: new Date().toISOString(),
    votingLive,
    warning: votingLive
      ? null
      : "Paying Arena UpVotes waits on a dedicated Arena treasury address in this environment.",
  });
}

async function handleBnbIngest(req, res) {
  const body = req.method === "POST" ? await readJson(req) : getQuery(req);
  const chainId = Number(body?.chainId ?? body?.chain_id);
  const txHash = normalizeHex(body?.txHash ?? body?.tx_hash ?? body?.hash);
  if (chainId !== 56 && chainId !== 97) return json(res, 400, { ok: false, error: "Invalid chainId (expected 56 or 97)" });
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) return json(res, 400, { ok: false, error: "Invalid txHash" });

  const configured = assertArenaEvmTreasury(chainId);
  if (!configured.ok) return json(res, 503, configured);

  const usd = await fetchUsd("binancecoin", "BNBUSDT");
  if (!(usd > 0)) return json(res, 503, { ok: false, error: "BNB/USD oracle is unavailable; cannot confirm the $3 vote.", code: "ARENA_VOTE_ORACLE_UNAVAILABLE" });
  const minWei = minNativeWei(usd, 18);

  const provider = await getServerReadProvider(chainId);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return json(res, 404, { ok: false, error: "Transaction receipt not found yet" });
  if (Number(receipt.status) === 0) return json(res, 400, { ok: false, error: "Transaction failed on-chain" });
  const block = await provider.getBlock(receipt.blockNumber);
  const blockTime = new Date(Number(block?.timestamp || 0) * 1000);
  const ingested = [];

  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== configured.treasury) continue;
    if (String(log.topics?.[0] || "").toLowerCase() !== VOTE_TOPIC0.toLowerCase()) continue;
    let parsed;
    try {
      parsed = VOTE_IFACE.parseLog(log);
    } catch {
      continue;
    }
    const tokenIdentity = String(parsed.args.campaign || "");
    const voter = String(parsed.args.voter || "").toLowerCase();
    const amountRaw = BigInt(parsed.args.amountPaid ?? 0);
    if (amountRaw < minWei) {
      return json(res, 400, {
        ok: false,
        error: `Arena UpVote must be about $${UPVOTE_USD_TARGET} in BNB.`,
        code: "ARENA_VOTE_AMOUNT_TOO_SMALL",
      });
    }
    const resolved = await resolveArenaVoteToken(pool, chainId, tokenIdentity);
    if (!resolved) {
      return json(res, 409, {
        ok: false,
        error: "Token is not Arena-eligible. Graduate a MemeWarzone coin or pass an import first.",
        code: "ARENA_VOTE_TOKEN_INELIGIBLE",
      });
    }
    await insertArenaVote({
      chainId,
      tokenAddress: resolved.tokenAddress,
      voterWallet: voter,
      amountNative: Number(ethers.formatEther(amountRaw)),
      txHash,
      blockTimestamp: blockTime,
      assetAddress: String(parsed.args.asset || ethers.ZeroAddress).toLowerCase(),
      amountRaw: amountRaw.toString(),
      logIndex: Number(log.index ?? log.logIndex ?? 0),
    });
    const aggregates = await patchArenaAggregates(chainId, resolved.tokenAddress);
    ingested.push({
      chainId,
      tokenAddress: resolved.tokenAddress,
      voterAddress: voter,
      txHash,
      ...aggregates,
    });
  }

  if (!ingested.length) {
    return json(res, 422, { ok: false, error: "No VoteCast logs found for the Arena vote treasury" });
  }
  return json(res, 200, { ok: true, items: ingested, updatedAt: new Date().toISOString() });
}

async function handleSolanaIngest(req, res) {
  const body = await readJson(req);
  const chainId = Number(body.chainId || 101);
  if (!isSolanaChain(chainId)) return json(res, 400, { ok: false, error: "chainId must be Solana (101)." });
  const signature = String(body.signature || body.txHash || "").trim();
  const tokenAddress = String(body.tokenAddress || body.campaignAddress || "").trim();
  const voterAddress = String(body.voterAddress || body.walletAddress || "").trim();
  if (!signature) return json(res, 400, { ok: false, error: "signature is required." });
  if (!isSolanaAddress(tokenAddress) || !isSolanaAddress(voterAddress)) {
    return json(res, 400, { ok: false, error: "tokenAddress and voterAddress must be Solana public keys." });
  }
  const configured = assertArenaSolanaTreasury();
  if (!configured.ok) return json(res, 503, configured);

  const resolved = await resolveArenaVoteToken(pool, chainId, tokenAddress);
  if (!resolved) {
    return json(res, 409, {
      ok: false,
      error: "Token is not Arena-eligible. Graduate a MemeWarzone coin or pass an import first.",
      code: "ARENA_VOTE_TOKEN_INELIGIBLE",
    });
  }

  const tx = await fetchVoteTransaction(signature);
  if (!tx) return json(res, 404, { ok: false, error: "Transaction not found (wait for confirmation and retry)." });
  const transfer = extractSolTransfer(tx, voterAddress, configured.treasuries);
  if (!transfer) {
    const paid = describeVoterTransfers(tx, voterAddress);
    return json(res, 400, {
      ok: false,
      error: paid.length
        ? `Arena vote SOL went to ${paid.map((item) => item.to).join(", ")}, not the Arena treasury.`
        : "Transaction is not a confirmed SOL transfer from voter to Arena vote treasury.",
      code: "ARENA_VOTE_TRANSFER_INVALID",
    });
  }

  const memoToken = extractArenaMemoToken(tx);
  if (!memoToken || memoToken !== resolved.tokenAddress && memoToken !== tokenAddress) {
    return json(res, 400, {
      ok: false,
      error: "Vote transaction must include memo mwz-arena-upvote:<token>.",
      code: "ARENA_VOTE_TOKEN_UNBOUND",
    });
  }

  const usdMicros = await fetchSolUsdMicros();
  if (usdMicros <= 0n) {
    return json(res, 503, { ok: false, error: "SOL/USD oracle is unavailable; cannot confirm the $3 vote.", code: "ARENA_VOTE_ORACLE_UNAVAILABLE" });
  }
  const targetLamports = (BigInt(UPVOTE_USD_TARGET) * 1_000_000n * 1_000_000_000n + usdMicros - 1n) / usdMicros;
  const required = (targetLamports * 90n) / 100n;
  if (transfer.amountLamports < required) {
    return json(res, 400, {
      ok: false,
      error: `Arena UpVote must be about $${UPVOTE_USD_TARGET} in SOL.`,
      code: "ARENA_VOTE_AMOUNT_TOO_SMALL",
    });
  }

  const blockTs = transfer.blockTime ? new Date(Number(transfer.blockTime) * 1000) : new Date();
  await insertArenaVote({
    chainId,
    tokenAddress: resolved.tokenAddress,
    voterWallet: voterAddress,
    amountNative: Number(transfer.amountLamports) / 1e9,
    txHash: signature,
    blockTimestamp: blockTs,
    assetAddress: SYSTEM_PROGRAM,
    amountRaw: transfer.amountLamports.toString(),
    logIndex: 0,
  });
  const aggregates = await patchArenaAggregates(chainId, resolved.tokenAddress);
  return json(res, 200, {
    ok: true,
    items: [{ chainId, tokenAddress: resolved.tokenAddress, voterAddress, txHash: signature, ...aggregates }],
    updatedAt: new Date().toISOString(),
  });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && /\/arena\/votes\/featured$/.test(path)) return handleFeatured(req, res);
    if (/\/arena\/votes\/solana-ingest$/.test(path)) {
      return method === "POST" ? handleSolanaIngest(req, res) : badMethod(res);
    }
    if (/\/arena\/votes\/ingest$/.test(path)) {
      return method === "GET" || method === "POST" ? handleBnbIngest(req, res) : badMethod(res);
    }
    if (path.includes("/arena/votes")) return badMethod(res);
    return json(res, 404, { error: `Unknown arena votes route: ${path}` });
  } catch (error) {
    console.error("[api/arenaVotes]", error);
    if (method !== "GET") {
      return json(res, 503, { ok: false, error: "Arena vote ingest is unavailable", detail: String(error?.message || error) });
    }
    return json(res, 200, {
      items: [],
      updatedAt: new Date().toISOString(),
      votingLive: false,
      warning: "Arena vote data is unavailable.",
    });
  }
}
