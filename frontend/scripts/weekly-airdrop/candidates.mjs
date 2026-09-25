import { asBigInt, envInt } from "./config.mjs";
import { scoreUnits } from "./usdRules.mjs";

function isSolanaAirdropChain(chainId) {
  return Number(chainId) === 101 || Number(chainId) === 102;
}

function walletExpr(column, chainId) {
  return isSolanaAirdropChain(chainId) ? column : `lower(${column})`;
}

function walletsDiffer(left, right, chainId) {
  return isSolanaAirdropChain(chainId)
    ? `(${left} is distinct from ${right})`
    : `(lower(${left}) <> lower(${right}))`;
}

const REQUIRED_RELATIONS = [
  "public.curve_trades", "public.campaigns", "public.reward_calculation_inputs",
  "public.reward_batches", "public.reward_ledger", "public.reward_batch_items",
  "public.reward_audit_logs", "public.reward_alerts", "public.wallet_risk_profiles",
  "public.wallet_clusters", "public.creator_profiles", "public.campaign_security_states",
  "public.recruiters", "public.league_epoch_payouts",
];

export async function assertAirdropSchema(client) {
  const missing = [];
  for (const relation of REQUIRED_RELATIONS) {
    const { rows } = await client.query("select to_regclass($1) as name", [relation]);
    if (!rows[0]?.name) missing.push(relation);
  }
  if (missing.length) throw new Error(`Missing airdrop relations: ${missing.join(", ")}`);
}

export async function writeRewardAlert(client, { severity = "error", title, message, metadata = {}, batchId = null }) {
  try {
    await client.query(
      `insert into public.reward_alerts (severity,reward_type,batch_id,title,message,status,metadata)
       values ($1,'airdrop',$2,$3,$4,'open',$5::jsonb)`,
      [severity, batchId, title, message, JSON.stringify(metadata)],
    );
  } catch (error) {
    console.error("[weekly-airdrop] alert insert failed", error?.message || error);
  }
}

export async function findEpochBatch(client, { chainId, epochId, program }) {
  const { rows } = await client.query(
    `select id,status,total_amount,metadata,published_at
       from public.reward_batches
      where reward_type='airdrop' and chain::text=$1 and metadata->>'epochId'=$2
        and metadata->>'program'=$3 and status<>'archived'
      order by created_at desc limit 1`,
    [String(chainId), epochId, program],
  );
  return rows[0] || null;
}

export function batchComplete(batch) {
  return Boolean(batch && ["claim_open", "closed"].includes(String(batch.status)));
}


function addWalletKeys(set, value, solana) {
  const raw = String(value || "").trim();
  if (!raw) return;
  set.add(raw);
  set.add(raw.toLowerCase());
  if (!solana) set.add(raw.toLowerCase());
}

export function isWalletExcluded(exclusions, wallet) {
  const raw = String(wallet || "").trim();
  if (!raw) return true;
  return Boolean(exclusions?.all?.has(raw) || exclusions?.all?.has(raw.toLowerCase()));
}

export async function exclusionSets(client, { chainId, start, end }) {
  const solana = isSolanaAirdropChain(chainId);
  const [risk, creators, recruiters, league, cooldown] = await Promise.all([
    client.query(
      solana
        ? `select w.wallet_address wallet
             from public.wallet_risk_profiles w left join public.wallet_clusters c on c.cluster_id=w.cluster_id
            where w.restricted or lower(coalesce(w.risk_level,'low')) in ('high','critical')
               or coalesce(c.restricted,false) or lower(coalesce(c.risk_level,'low')) in ('high','critical')`
        : `select lower(w.wallet_address) wallet
             from public.wallet_risk_profiles w left join public.wallet_clusters c on c.cluster_id=w.cluster_id
            where w.restricted or lower(coalesce(w.risk_level,'low')) in ('high','critical')
               or coalesce(c.restricted,false) or lower(coalesce(c.risk_level,'low')) in ('high','critical')`,
    ),
    client.query(
      solana
        ? `select creator_wallet wallet from public.creator_profiles where restricted or manual_review_required`
        : `select lower(creator_wallet) wallet from public.creator_profiles where restricted or manual_review_required`,
    ),
    client.query(
      solana
        ? `select wallet_address wallet from public.recruiters where wallet_address is not null`
        : `select lower(wallet_address) wallet from public.recruiters where wallet_address is not null`,
    ),
    client.query(
      `select ${walletExpr("recipient_address", chainId)} wallet from public.league_epoch_payouts
        where chain_id=$1 and epoch_start >= $2 and epoch_start < $3`,
      [chainId, start, end],
    ),
    client.query(
      `select distinct ${walletExpr("wallet_address", chainId)} wallet from public.reward_ledger
        where reward_type='airdrop' and chain::text=$1
          and created_at >= $2::timestamptz - interval '14 days' and created_at < $2
          and status not in ('cancelled','expired')`,
      [String(chainId), start],
    ),
  ]);
  const all = new Set();
  const groups = [risk, creators, recruiters, league, cooldown];
  for (const result of groups) {
    for (const row of result.rows) addWalletKeys(all, row.wallet, solana);
  }
  return { all, securityCount: risk.rows.length, totalCount: all.size };
}

// Volume thresholds come from one USD rule set for every chain (usdRules.mjs), converted at this
// run's spot price -- no per-chain wei defaults.
export async function traderCandidates(client, { chainId, start, end, exclusions, thresholds }) {
  if (!thresholds) throw new Error("traderCandidates requires USD-derived thresholds");
  const minVolume = thresholds.traderMinRaw;
  const cap = thresholds.traderCapRaw;
  const capScore = thresholds.traderCapScore;
  const minTrades = envInt("AIRDROP_TRADER_MIN_TRADES", 3, { min: 1, max: 1000 });
  const minDays = envInt("AIRDROP_TRADER_MIN_ACTIVE_DAYS", 2, { min: 1, max: 7 });
  const { rows } = await client.query(
    `select ${walletExpr("t.wallet", chainId)} wallet_address,sum(t.bnb_amount_raw::numeric)::text total_volume_raw,
            count(*)::int trade_count,count(distinct (t.block_time at time zone 'utc')::date)::int active_days,
            count(distinct t.campaign_address)::int campaign_count
       from public.curve_trades t join public.campaigns c
         on c.chain_id=t.chain_id and c.campaign_address=t.campaign_address
       left join public.campaign_security_states s on s.campaign_address=t.campaign_address
       left join public.wallet_risk_profiles bw on ${walletExpr("bw.wallet_address", chainId)}=${walletExpr("t.wallet", chainId)}
       left join public.wallet_risk_profiles cw on ${walletExpr("cw.wallet_address", chainId)}=${walletExpr("c.creator_address", chainId)}
      where t.chain_id=$1 and t.block_time >= $2 and t.block_time < $3 and t.side in ('buy','sell')
        and ${walletsDiffer("t.wallet", "c.creator_address", chainId)} and not coalesce(s.paused,false)
        and not coalesce(bw.restricted,false)
        and not (bw.cluster_id is not null and cw.cluster_id is not null and bw.cluster_id=cw.cluster_id)
      group by ${walletExpr("t.wallet", chainId)}
     having sum(t.bnb_amount_raw::numeric) >= $4::numeric and count(*) >= $5
        and count(distinct (t.block_time at time zone 'utc')::date) >= $6`,
    [chainId, start, end, minVolume.toString(), minTrades, minDays],
  );
  return rows.filter((row) => !isWalletExcluded(exclusions, row.wallet_address)).map((row) => {
    const total = asBigInt(row.total_volume_raw);
    const counted = total > cap ? cap : total;
    const countedBnb = scoreUnits(counted, chainId, thresholds.nativeUsd);
    const rawBnb = scoreUnits(total, chainId, thresholds.nativeUsd);
    const activityScore = countedBnb + Math.min(Number(row.trade_count), 20) * 0.1 + Math.min(Number(row.active_days), 7) * 0.5;
    const smallWalletBonus = Math.max(0, 1 - countedBnb / capScore) * 0.5;
    const whalePenalty = Math.max(0, rawBnb - capScore) / capScore;
    return {
      walletAddress: row.wallet_address, totalVolumeRaw: total.toString(), countedVolumeRaw: counted.toString(),
      tradeCount: Number(row.trade_count), activeDays: Number(row.active_days), campaignCount: Number(row.campaign_count),
      activityScore, traderScore: activityScore, creatorScore: 0, smallWalletBonus, whalePenalty,
      securityScore: 1, finalWeight: Math.max(0.1, activityScore + smallWalletBonus - whalePenalty),
      reasonCodes: ["TRADER_MIN_VOLUME", "TRADER_MIN_TRADES", "TRADER_MULTI_DAY", "SECURITY_CLEAR", "COOLDOWN_CLEAR"],
    };
  });
}

export async function creatorCandidates(client, { chainId, start, end, exclusions, thresholds }) {
  if (!thresholds) throw new Error("creatorCandidates requires USD-derived thresholds");
  const minVolume = thresholds.creatorMinRaw;
  const cap = thresholds.creatorCapRaw;
  const capScore = thresholds.creatorCapScore;
  const minBuyers = thresholds.creatorMinUniqueBuyers;
  const maxCampaigns = envInt("AIRDROP_CREATOR_MAX_CAMPAIGNS", 2, { min: 1, max: 20 });
  const { rows } = await client.query(
    `select ${walletExpr("c.creator_address", chainId)} wallet_address,t.campaign_address,
            sum(t.bnb_amount_raw::numeric)::text qualified_buy_volume_raw,count(distinct ${walletExpr("t.wallet", chainId)})::int unique_buyers
       from public.curve_trades t join public.campaigns c
         on c.chain_id=t.chain_id and c.campaign_address=t.campaign_address
       left join public.campaign_security_states s on s.campaign_address=t.campaign_address
       left join public.wallet_risk_profiles bw on ${walletExpr("bw.wallet_address", chainId)}=${walletExpr("t.wallet", chainId)}
       left join public.wallet_risk_profiles cw on ${walletExpr("cw.wallet_address", chainId)}=${walletExpr("c.creator_address", chainId)}
      where t.chain_id=$1 and t.block_time >= $2 and t.block_time < $3 and t.side='buy'
        and ${walletsDiffer("t.wallet", "c.creator_address", chainId)} and not coalesce(s.paused,false) and not coalesce(s.buy_paused,false)
        and not coalesce(bw.restricted,false)
        and not (bw.cluster_id is not null and cw.cluster_id is not null and bw.cluster_id=cw.cluster_id)
      group by ${walletExpr("c.creator_address", chainId)},t.campaign_address
     having sum(t.bnb_amount_raw::numeric) >= $4::numeric and count(distinct ${walletExpr("t.wallet", chainId)}) >= $5`,
    [chainId, start, end, minVolume.toString(), minBuyers],
  );
  const grouped = new Map();
  for (const row of rows) {
    if (isWalletExcluded(exclusions, row.wallet_address)) continue;
    if (!grouped.has(row.wallet_address)) grouped.set(row.wallet_address, []);
    grouped.get(row.wallet_address).push(row);
  }
  return [...grouped.entries()].map(([walletAddress, campaigns]) => {
    const top = campaigns.sort((a, b) => asBigInt(a.qualified_buy_volume_raw) > asBigInt(b.qualified_buy_volume_raw) ? -1 : 1).slice(0, maxCampaigns);
    const total = top.reduce((sum, row) => sum + asBigInt(row.qualified_buy_volume_raw), 0n);
    const counted = total > cap ? cap : total;
    const uniqueBuyers = top.reduce((sum, row) => sum + Number(row.unique_buyers), 0);
    const countedBnb = scoreUnits(counted, chainId, thresholds.nativeUsd);
    const rawBnb = scoreUnits(total, chainId, thresholds.nativeUsd);
    const activityScore = countedBnb + Math.min(uniqueBuyers, 50) * 0.1 + top.length;
    const smallWalletBonus = Math.max(0, 1 - countedBnb / capScore) * 0.5;
    const whalePenalty = Math.max(0, rawBnb - capScore) / capScore;
    return {
      walletAddress, totalVolumeRaw: total.toString(), countedVolumeRaw: counted.toString(), uniqueBuyers,
      eligibleCampaignCount: top.length,
      eligibleCampaigns: top.map((row) => ({ campaignAddress: row.campaign_address, qualifiedBuyVolumeRaw: row.qualified_buy_volume_raw, uniqueBuyers: Number(row.unique_buyers) })),
      activityScore, creatorScore: activityScore, traderScore: 0, smallWalletBonus, whalePenalty,
      securityScore: 1, finalWeight: Math.max(0.1, activityScore + smallWalletBonus - whalePenalty),
      reasonCodes: ["CREATOR_ACTIVE_CAMPAIGN", "CREATOR_MIN_BUY_VOLUME", "CREATOR_MIN_UNIQUE_BUYERS", "SECURITY_CLEAR", "COOLDOWN_CLEAR"],
    };
  });
}

export async function stageWinners(client, { chainId, epochId, program, winners, payouts, start, end, poolWei, seedCommitment, tokenSymbol = "BNB" }) {
  await client.query(`delete from public.reward_calculation_inputs where reward_type='airdrop' and program=$1 and epoch_id=$2 and chain=$3`, [program, epochId, String(chainId)]);
  for (let i = 0; i < winners.length; i += 1) {
    const winner = winners[i];
    const metadata = {
      role: program === "airdrop_creator" ? "Creator" : "Trader", program, epochId,
      epochStart: start.toISOString(), epochEnd: end.toISOString(), winnerRank: winner.winnerRank,
      activityScore: winner.activityScore, creatorScore: winner.creatorScore, traderScore: winner.traderScore,
      smallWalletBonus: winner.smallWalletBonus, whalePenalty: winner.whalePenalty, securityScore: winner.securityScore,
      finalWeight: winner.finalWeight, reasonCodes: winner.reasonCodes, totalVolumeRaw: winner.totalVolumeRaw,
      countedVolumeRaw: winner.countedVolumeRaw, tradeCount: winner.tradeCount ?? null, activeDays: winner.activeDays ?? null,
      uniqueBuyers: winner.uniqueBuyers ?? null, eligibleCampaignCount: winner.eligibleCampaignCount ?? null,
      eligibleCampaigns: winner.eligibleCampaigns ?? null, drawDigest: winner.drawDigest,
      drawSeedCommitment: seedCommitment, programPoolWei: poolWei.toString(), automated: true,
    };
    await client.query(
      `insert into public.reward_calculation_inputs
        (reward_type,program,epoch_id,chain,token_symbol,wallet_address,amount,score,activity_score,source_id,source_label,status,metadata)
       values ('airdrop',$1,$2,$3,$10,$4,$5::numeric,$6::numeric,$7::numeric,$8,'weekly_airdrop_scheduler','approved',$9::jsonb)`,
      [program, epochId, String(chainId), winner.walletAddress, payouts[i].toString(), String(winner.finalWeight), String(winner.activityScore), `${epochId}:${program}:${winner.winnerRank}`, JSON.stringify(metadata), tokenSymbol],
    );
  }
}
