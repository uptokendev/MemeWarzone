import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { getServerReadProvider } from "./getServerReadProvider.js";
import { notPublicHiddenCampaignSql } from "./publicHiddenSql.js";
import { evmMainnetVoteAddresses } from "./financeFeeRoutingEvm.js";

const VOTE_TREASURY_ABI = ["function feeReceiver() view returns (address)"];

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function configuredAddress(chainId, name) {
  const id = Number(chainId);
  return firstEnv(
    `${name}_${id}`,
    `VITE_${name}_${id}`,
    ...(id === 56 ? [name, `VITE_${name}`] : []),
  );
}

// Env first (VOTE_TREASURY_ADDRESS_<id> / PROTOCOL_REVENUE_VAULT_ADDRESS_<id>),
// then the mainnet deployment record the fee-routing map uses, so the live API
// needs no extra env for BNB 56 / Robinhood 4663.
export function upvoteRevenueAddresses(network, { readEnv = configuredAddress } = {}) {
  const record = evmMainnetVoteAddresses(network.chainId);
  return {
    voteTreasury: readEnv(network.chainId, "VOTE_TREASURY_ADDRESS") || record?.voteTreasury || "",
    protocolRevenueVault: readEnv(network.chainId, "PROTOCOL_REVENUE_VAULT_ADDRESS") || record?.protocolRevenueVault || "",
  };
}

export async function readNativeUpvoteRevenue(network, { readFeeReceiver } = {}) {
  const approval = await readUpvoteFeeReceiverApproval(network, { readFeeReceiver });
  if (!approval.approved) return approval;
  const aggregate = await hourlyNativeVotes(network.chainId, ethers.ZeroAddress);
  if (!aggregate) return { approved: true, aggregate: null, reason: null };
  return { approved: true, reason: null, aggregate };
}

/**
 * The fee-receiver check of readNativeUpvoteRevenue alone (one view call, no
 * vote query): { approved, aggregate: null, reason, message? }. The revenue
 * lanes only need this answer; they read the votes themselves.
 */
export async function readUpvoteFeeReceiverApproval(network, { readFeeReceiver } = {}) {
  if (network.chain !== "bnb" && network.chain !== "robinhood") return { approved: false, aggregate: null, reason: "CHAIN_NOT_SUPPORTED" };

  const { voteTreasury, protocolRevenueVault } = upvoteRevenueAddresses(network);
  if (!ethers.isAddress(voteTreasury) || !ethers.isAddress(protocolRevenueVault)) {
    return {
      approved: false,
      aggregate: null,
      reason: "REVENUE_DESTINATION_NOT_CONFIGURED",
      message: `the UP vote treasury or protocol revenue vault address for chain ${network.chainId} is not known (set VOTE_TREASURY_ADDRESS_${network.chainId} and PROTOCOL_REVENUE_VAULT_ADDRESS_${network.chainId} on the API)`,
    };
  }

  const receiver = String(await (readFeeReceiver
    ? readFeeReceiver(network, voteTreasury)
    : new ethers.Contract(voteTreasury, VOTE_TREASURY_ABI, await getServerReadProvider(network.chainId)).feeReceiver())).toLowerCase();
  if (receiver !== protocolRevenueVault.toLowerCase()) {
    return {
      approved: false,
      aggregate: null,
      reason: "FEE_RECEIVER_NOT_PROTOCOL_REVENUE_VAULT",
      message: `the UP vote treasury ${voteTreasury} pays ${receiver}, not the protocol revenue vault ${protocolRevenueVault}`,
    };
  }
  return { approved: true, aggregate: null, reason: null };
}

// Solana paid UP votes: a plain System transfer to the vote treasury with memo
// mwz-upvote:<campaign> (api/dev-fix/solana-vote-ingest.js). There is no fee
// receiver to check: the whole payment is protocol revenue (fee routing marks
// vote_treasury "ours"). Native SOL is stored with the System Program id as
// asset_address. Founder decision 2026-10-04: counted as revenue like BNB /
// Robinhood votes.
export const SOLANA_NATIVE_VOTE_ASSET = "11111111111111111111111111111111";

export async function readSolanaUpvoteRevenue(network) {
  if (network.chain !== "solana") return { approved: false, aggregate: null, reason: "CHAIN_NOT_SUPPORTED" };
  const aggregate = await hourlyNativeVotes(network.chainId, SOLANA_NATIVE_VOTE_ASSET);
  return { approved: true, reason: null, aggregate };
}

// Grouped by hour so the finance view can value each vote at the price of its
// hour. Votes on hidden test coins are left out; a vote without a campaign
// passes. EVM addresses compare case-insensitively; the Solana System Program
// id is all digits, so lower() leaves it unchanged.
async function hourlyNativeVotes(chainId, assetAddress) {
  const { rows } = await pool.query(
    `select date_trunc('hour', v.block_timestamp) as hour,
            min(v.block_timestamp) as period_start,
            max(v.block_timestamp) as period_end,
            count(*)::int as evidence_count,
            coalesce(sum(v.amount_raw), 0)::text as amount_raw
       from public.votes v
      where v.chain_id = $1
        and v.status = 'confirmed'
        and lower(v.asset_address) = lower($2)
        and ${notPublicHiddenCampaignSql("v")}
      group by 1`,
    [chainId, assetAddress],
  );
  let total = 0n;
  let evidenceCount = 0;
  let periodStart = null;
  let periodEnd = null;
  const buckets = [];
  for (const row of rows) {
    const raw = String(row.amount_raw || "0").split(".")[0];
    if (!/^\d+$/.test(raw)) continue;
    total += BigInt(raw);
    evidenceCount += Number(row.evidence_count || 0);
    if (row.period_start && (!periodStart || new Date(row.period_start) < new Date(periodStart))) periodStart = row.period_start;
    if (row.period_end && (!periodEnd || new Date(row.period_end) > new Date(periodEnd))) periodEnd = row.period_end;
    buckets.push({ hour: row.hour, raw });
  }
  if (total === 0n || !periodStart || !periodEnd) return null;
  return {
    amountRaw: total.toString(),
    periodStart,
    periodEnd,
    evidenceCount,
    buckets,
  };
}
