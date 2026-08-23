/**
 * Confirm a Solana UP Vote (native SOL transfer to vote treasury) and write
 * votes + vote_aggregates — same product surface as BNB voteWithBNB + vote-ingest.
 *
 * POST /api/solana/vote-ingest
 * body: { chainId, signature, campaignAddress, voterAddress }
 */
import { pool } from "../../server/db.js";
import { badMethod, isSolanaAddress, isSolanaChain, json, readJson } from "../../server/http.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const UPVOTE_USD_TARGET = 3;
/** Minimum SOL accepted (anti-spam); true price checked loosely via env override. */
const DEFAULT_MIN_LAMPORTS = 1_000_000n; // 0.001 SOL floor

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function solanaVoteTreasuries() {
  const out = [];
  const seen = new Set();
  for (const c of [
    process.env.SOLANA_VOTE_TREASURY_ADDRESS,
    process.env.VITE_SOLANA_VOTE_TREASURY_ADDRESS,
    process.env.VITE_VOTE_TREASURY_ADDRESS_101,
    process.env.VOTE_TREASURY_ADDRESS_101,
  ]) {
    const v = String(c || "").trim();
    if (!v || !isSolanaAddress(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function solanaVoteTreasury() {
  return solanaVoteTreasuries()[0] || "";
}

function pubkeyOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value.pubkey === "string") return value.pubkey.trim();
  if (value.pubkey && typeof value.pubkey.toString === "function") return String(value.pubkey.toString()).trim();
  if (typeof value.toString === "function") {
    const text = String(value.toString());
    return text === "[object Object]" ? "" : text.trim();
  }
  return "";
}

function samePubkey(a, b) {
  return Boolean(a && b && String(a) === String(b));
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

function parseSystemTransferFromIx(ix, keys) {
  if (!ix) return null;
  const program =
    pubkeyOf(ix.programId) ||
    keys[Number(ix.programIdIndex ?? -1)] ||
    String(ix.program || "");
  const parsedType = String(ix?.parsed?.type || "");
  if (parsedType === "transfer" || parsedType === "transferWithSeed") {
    const info = ix.parsed.info || {};
    const lamports = BigInt(info.lamports ?? info.lamportsSent ?? 0);
    const from = String(info.source || info.from || "");
    const to = String(info.destination || info.to || "");
    if (lamports > 0n && from && to) return { from, to, lamports };
  }
  if (program !== SYSTEM_PROGRAM && program !== "system") return null;
  const dataRaw = ix.data;
  if (!dataRaw || typeof dataRaw !== "string") return null;
  let data;
  try {
    data = Buffer.from(dataRaw, "base64");
  } catch {
    return null;
  }
  if (data.length < 12) return null;
  const index = data.readUInt32LE(0);
  if (index !== 2) return null;
  const lamports = data.readBigUInt64LE(4);
  const accounts = ix.accounts || ix.accountKeyIndexes || [];
  const from = keys[Number(accounts[0])] || "";
  const to = keys[Number(accounts[1])] || "";
  if (lamports > 0n && from && to) return { from, to, lamports };
  return null;
}

function collectInstructions(tx) {
  const message = tx?.transaction?.message || {};
  const outer = message.instructions || [];
  const inner = [];
  for (const group of tx?.meta?.innerInstructions || []) {
    for (const ix of group.instructions || []) inner.push(ix);
  }
  return [...outer, ...inner];
}

const MEMO_PROGRAMS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

function decodeIxData(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch {
    // fall through
  }
  try {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const bytes = [0];
    for (const ch of text) {
      const idx = alphabet.indexOf(ch);
      if (idx < 0) return text;
      let carry = idx;
      for (let i = 0; i < bytes.length; i += 1) {
        const n = bytes[i] * 58 + carry;
        bytes[i] = n & 255;
        carry = n >> 8;
      }
      while (carry > 0) {
        bytes.push(carry & 255);
        carry >>= 8;
      }
    }
    return Buffer.from(bytes.reverse()).toString("utf8");
  } catch {
    return text;
  }
}

function extractUpvoteMemoCampaign(tx) {
  const keys = flattenAccountKeys(tx);
  for (const ix of collectInstructions(tx)) {
    const program =
      pubkeyOf(ix.programId) ||
      keys[Number(ix.programIdIndex ?? -1)] ||
      String(ix.program || "");
    const parsedMemo = typeof ix.parsed === "string" ? ix.parsed : "";
    const memo = parsedMemo || decodeIxData(ix.data);
    if (MEMO_PROGRAMS.has(program) || program === "spl-memo" || /mwz-upvote:/.test(memo)) {
      const match = String(memo).match(/mwz-upvote:([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (match?.[1]) return match[1];
    }
  }
  for (const line of tx?.meta?.logMessages || []) {
    const match = String(line).match(/mwz-upvote:([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (match?.[1]) return match[1];
  }
  return "";
}

async function fetchSolUsdMicros() {
  const override = String(process.env.SOLANA_GRADUATION_SOL_USD_MICROS || process.env.SOLANA_VOTE_SOL_USD_MICROS || "").trim();
  if (override && /^\d+$/.test(override) && BigInt(override) > 0n) return BigInt(override);
  const sources = [
    async () => {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
      const body = await response.json();
      return Number(body?.solana?.usd);
    },
    async () => {
      const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
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
      if (Number.isFinite(price) && price > 0) return BigInt(Math.round(price * 1_000_000));
    } catch {
      // next oracle
    }
  }
  return 0n;
}

function minVoteLamports() {
  const raw = String(process.env.SOLANA_VOTE_MIN_LAMPORTS || "").trim();
  if (/^\d+$/.test(raw)) return BigInt(raw);
  return DEFAULT_MIN_LAMPORTS;
}

async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.error) {
    throw new Error(payload.error.message || `RPC ${method} failed`);
  }
  return payload.result;
}

/**
 * Parse a confirmed transfer of lamports from voter → any known vote treasury.
 */
function extractSolTransfer(tx, voter, treasuries) {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;
  const treasurySet = new Set((treasuries || []).filter(Boolean));
  const keys = flattenAccountKeys(tx);
  const feePayer = keys[0] || "";

  for (const ix of collectInstructions(tx)) {
    const parsed = parseSystemTransferFromIx(ix, keys);
    if (!parsed) continue;
    const destOk = [...treasurySet].some((treasury) => samePubkey(parsed.to, treasury));
    const sourceOk = samePubkey(parsed.from, voter) || samePubkey(parsed.from, feePayer);
    if (destOk && sourceOk) {
      return {
        amountLamports: parsed.lamports,
        blockTime: tx.blockTime || null,
        slot: tx.slot || 0,
        treasury: parsed.to,
      };
    }
  }

  const pre = meta.preBalances || [];
  const post = meta.postBalances || [];
  const voterIdx = keys.findIndex((k) => samePubkey(k, voter) || samePubkey(k, feePayer));
  for (const treasury of treasurySet) {
    const treasuryIdx = keys.findIndex((k) => samePubkey(k, treasury));
    if (voterIdx < 0 || treasuryIdx < 0) continue;
    const voterDelta = BigInt(post[voterIdx] ?? 0) - BigInt(pre[voterIdx] ?? 0);
    const treasuryDelta = BigInt(post[treasuryIdx] ?? 0) - BigInt(pre[treasuryIdx] ?? 0);
    if (treasuryDelta > 0n && voterDelta < 0n) {
      return {
        amountLamports: treasuryDelta,
        blockTime: tx.blockTime || null,
        slot: tx.slot || 0,
        treasury,
      };
    }
  }
  return null;
}

function describeVoterTransfers(tx, voter) {
  const keys = flattenAccountKeys(tx);
  const feePayer = keys[0] || "";
  const found = [];
  for (const ix of collectInstructions(tx)) {
    const parsed = parseSystemTransferFromIx(ix, keys);
    if (!parsed) continue;
    if (samePubkey(parsed.from, voter) || samePubkey(parsed.from, feePayer)) {
      found.push({ from: parsed.from, to: parsed.to, lamports: parsed.lamports.toString() });
    }
  }
  return found;
}

function solanaRpcUrls() {
  const urls = [
    process.env.SOLANA_RPC_URL,
    process.env.SOLANA_RPC_HTTP,
    process.env.VITE_SOLANA_RPC,
    "https://api.mainnet-beta.solana.com",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(urls)];
}

async function fetchVoteTransaction(signature) {
  const configs = [
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ];
  let lastError = null;
  for (const rpcUrl of solanaRpcUrls()) {
    for (const config of configs) {
      try {
        const tx = await rpcCall(rpcUrl, "getTransaction", [signature, config]);
        if (tx) return tx;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function resolveSolanaVoteCampaign(chainId, address) {
  const raw = String(address || "").trim();
  if (!raw) return null;
  const { rows } = await pool.query(
    `select campaign_address, token_address, graduated_at_chain
       from public.campaigns
      where chain_id = $1
        and (
          campaign_address = $2
          or token_address = $2
          or lower(campaign_address) = lower($2)
          or (token_address is not null and lower(token_address) = lower($2))
        )
      order by
        case when campaign_address = $2 then 0
             when token_address = $2 then 1
             else 2
        end
      limit 1`,
    [chainId, raw],
  );
  return rows[0] || null;
}

function memoMatchesCampaign(memoCampaign, row, requested) {
  const memo = String(memoCampaign || "").trim();
  if (!memo) return false;
  const candidates = [
    requested,
    row?.campaign_address,
    row?.token_address,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates.some((value) => value === memo);
}

async function patchVoteAggregates(chainId, campaign) {
  // Case-preserving identity for Solana; do not force lower().
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
       where chain_id=$1
         and (campaign_address = $2 or lower(campaign_address) = lower($2))
         and status='confirmed'
     )
     select
       coalesce(votes_1h,0)::int as votes_1h,
       coalesce(votes_24h,0)::int as votes_24h,
       coalesce(votes_7d,0)::int as votes_7d,
       coalesce(votes_all_time,0)::int as votes_all_time,
       (coalesce(b0,0) * 1.0 + coalesce(b1,0) * 0.5 + coalesce(b2,0) * 0.25) as trending_score,
       last_vote_at
     from v`,
    [chainId, campaign],
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
       chain_id, campaign_address, votes_1h, votes_24h, votes_7d, votes_all_time,
       trending_score, last_vote_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (chain_id, campaign_address) do update set
       votes_1h = excluded.votes_1h,
       votes_24h = excluded.votes_24h,
       votes_7d = excluded.votes_7d,
       votes_all_time = excluded.votes_all_time,
       trending_score = excluded.trending_score,
       last_vote_at = excluded.last_vote_at,
       updated_at = now()`,
    [
      chainId,
      campaign,
      x.votes_1h,
      x.votes_24h,
      x.votes_7d,
      x.votes_all_time,
      x.trending_score,
      x.last_vote_at,
    ],
  );
  return x;
}

export async function solanaVoteIngest(req, res) {
  if (req.method !== "POST") return badMethod(res);

  try {
    const body = await readJson(req);
    const chainId = Number(body.chainId || 101);
    if (!isSolanaChain(chainId)) {
      return json(res, 400, { error: "chainId must be Solana (101).", code: "NOT_A_SOLANA_CHAIN" });
    }

    const signature = String(body.signature || body.txHash || "").trim();
    const campaignAddress = String(body.campaignAddress || "").trim();
    const voterAddress = String(body.voterAddress || body.walletAddress || "").trim();
    if (!signature) return json(res, 400, { error: "signature is required." });
    if (!isSolanaAddress(campaignAddress)) {
      return json(res, 400, { error: "campaignAddress must be a Solana public key." });
    }
    if (!isSolanaAddress(voterAddress)) {
      return json(res, 400, { error: "voterAddress must be a Solana public key." });
    }

    const treasuries = solanaVoteTreasuries();
    const treasury = treasuries[0] || "";
    if (!treasury) {
      return json(res, 503, {
        error: "Solana vote treasury is not configured (SOLANA_VOTE_TREASURY_ADDRESS).",
        code: "SOLANA_VOTE_TREASURY_MISSING",
      });
    }

    const resolved = await resolveSolanaVoteCampaign(chainId, campaignAddress);
    const canonicalCampaign = String(resolved?.campaign_address || campaignAddress).trim();

    const tx = await fetchVoteTransaction(signature);
    if (!tx) {
      return json(res, 404, { error: "Transaction not found (wait for confirmation and retry)." });
    }

    const transfer = extractSolTransfer(tx, voterAddress, treasuries);
    if (!transfer) {
      const paid = describeVoterTransfers(tx, voterAddress);
      return json(res, 400, {
        error: paid.length
          ? `Vote SOL went to ${paid.map((p) => p.to).join(", ")}, but ingest only accepts ${treasuries.join(", ")}. Set Railway SOLANA_VOTE_TREASURY_ADDRESS to the same wallet as VITE_SOLANA_VOTE_TREASURY_ADDRESS.`
          : "Transaction is not a confirmed SOL transfer from voter to vote treasury.",
        code: "SOLANA_VOTE_TRANSFER_INVALID",
        treasury,
        expectedTreasuries: treasuries,
        paidTransfers: paid,
        voterAddress,
      });
    }

    const memoCampaign = extractUpvoteMemoCampaign(tx);
    if (!memoMatchesCampaign(memoCampaign, resolved, campaignAddress)) {
      return json(res, 400, {
        error: "Vote transaction must include a memo binding this campaign (mwz-upvote:<campaign>).",
        code: "SOLANA_VOTE_CAMPAIGN_UNBOUND",
      });
    }

    const usdMicros = await fetchSolUsdMicros();
    if (usdMicros <= 0n) {
      return json(res, 503, {
        error: "SOL/USD oracle is unavailable; cannot confirm the $3 vote.",
        code: "SOLANA_VOTE_ORACLE_UNAVAILABLE",
      });
    }
    const targetLamports = (BigInt(UPVOTE_USD_TARGET) * 1_000_000n * 1_000_000_000n + usdMicros - 1n) / usdMicros;
    const minAccepted = (targetLamports * 90n) / 100n;
    const floor = minVoteLamports();
    const required = minAccepted > floor ? minAccepted : floor;
    if (transfer.amountLamports < required) {
      return json(res, 400, {
        error: `Vote must be about $${UPVOTE_USD_TARGET} in SOL (paid ${transfer.amountLamports} lamports, need >= ${required}).`,
        code: "SOLANA_VOTE_AMOUNT_TOO_SMALL",
      });
    }

    const blockTs = transfer.blockTime
      ? new Date(Number(transfer.blockTime) * 1000)
      : new Date();

    await pool.query(
      `insert into public.votes (
         chain_id, campaign_address, voter_address, asset_address, amount_raw,
         tx_hash, log_index, block_number, block_timestamp, meta, status
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed')
       on conflict do nothing`,
      [
        chainId,
        canonicalCampaign,
        voterAddress,
        SYSTEM_PROGRAM,
        transfer.amountLamports.toString(),
        signature,
        0,
        Number(transfer.slot || 0),
        blockTs.toISOString(),
        `solana_up_vote_usd_${UPVOTE_USD_TARGET}`,
      ],
    ).catch(async (err) => {
      // Unique index may be named votes_uq_event — retry with explicit conflict target if needed
      if (String(err?.code) === "42P10" || /no unique|ON CONFLICT/i.test(String(err?.message || ""))) {
        await pool.query(
          `insert into public.votes (
             chain_id, campaign_address, voter_address, asset_address, amount_raw,
             tx_hash, log_index, block_number, block_timestamp, meta, status
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed')
           on conflict (chain_id, tx_hash, log_index) do nothing`,
          [
            chainId,
            canonicalCampaign,
            voterAddress,
            SYSTEM_PROGRAM,
            transfer.amountLamports.toString(),
            signature,
            0,
            Number(transfer.slot || 0),
            blockTs.toISOString(),
            `solana_up_vote_usd_${UPVOTE_USD_TARGET}`,
          ],
        );
        return;
      }
      throw err;
    });

    const agg = await patchVoteAggregates(chainId, canonicalCampaign);

    try {
      const { publishLeagueCampaignPatch } = await import("../lib/leagueAblyPublish.js");
      await publishLeagueCampaignPatch(chainId, [
        {
          campaignAddress: canonicalCampaign,
          votes24h: Number(agg.votes_24h || 0),
          votesAllTime: Number(agg.votes_all_time || 0),
          lastActivityAt: Math.floor(Date.now() / 1000),
        },
      ]);
    } catch {
      // Ably must never fail a confirmed vote ingest.
    }

    return json(res, 200, {
      ok: true,
      items: [
        {
          chainId,
          campaignAddress: canonicalCampaign,
          voterAddress,
          txHash: signature,
          amountLamports: transfer.amountLamports.toString(),
          votes24h: agg.votes_24h,
          votesAllTime: agg.votes_all_time,
          treasury,
        },
      ],
    });
  } catch (error) {
    console.error("[solana-vote-ingest]", error);
    return json(res, 500, {
      error: String(error?.message || "Solana vote ingest failed"),
      code: "SOLANA_VOTE_INGEST_ERROR",
    });
  }
}

export default solanaVoteIngest;
