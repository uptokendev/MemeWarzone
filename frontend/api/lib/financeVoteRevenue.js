import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { getServerReadProvider } from "./getServerReadProvider.js";
import { notPublicHiddenCampaignSql } from "./publicHiddenSql.js";

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

export async function readNativeUpvoteRevenue(network) {
  if (network.chain !== "bnb" && network.chain !== "robinhood") return { approved: false, aggregate: null, reason: "CHAIN_NOT_SUPPORTED" };

  const voteTreasury = configuredAddress(network.chainId, "VOTE_TREASURY_ADDRESS");
  const protocolRevenueVault = configuredAddress(network.chainId, "PROTOCOL_REVENUE_VAULT_ADDRESS");
  if (!ethers.isAddress(voteTreasury) || !ethers.isAddress(protocolRevenueVault)) {
    return { approved: false, aggregate: null, reason: "REVENUE_DESTINATION_NOT_CONFIGURED" };
  }

  const provider = await getServerReadProvider(network.chainId);
  const treasury = new ethers.Contract(voteTreasury, VOTE_TREASURY_ABI, provider);
  const receiver = String(await treasury.feeReceiver()).toLowerCase();
  if (receiver !== protocolRevenueVault.toLowerCase()) {
    return { approved: false, aggregate: null, reason: "FEE_RECEIVER_NOT_PROTOCOL_REVENUE_VAULT" };
  }

  // Grouped by hour so the finance view can value each vote at the price of
  // its hour. Votes on hidden test coins are left out.
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
    [network.chainId, ethers.ZeroAddress],
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
  if (total === 0n || !periodStart || !periodEnd) {
    return { approved: true, aggregate: null, reason: null };
  }

  return {
    approved: true,
    reason: null,
    aggregate: {
      amountRaw: total.toString(),
      periodStart,
      periodEnd,
      evidenceCount,
      buckets,
    },
  };
}
