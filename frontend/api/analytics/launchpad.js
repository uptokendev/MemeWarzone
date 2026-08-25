import { pool } from "../../server/db.js";

const TESTNET_CHAIN_IDS = new Set([97, 102]);
const CHAIN_META = new Map([
  [56, { label: "BNB", unit: "BNB" }],
  [101, { label: "Solana", unit: "SOL" }],
]);

function chainMeta(chainId) {
  return CHAIN_META.get(Number(chainId)) || {
    label: `Chain ${Number(chainId)}`,
    unit: "native",
  };
}

function requestedChain(value) {
  const raw = String(value ?? "all").trim().toLowerCase();
  if (!raw || raw === "all") return null;
  const chainId = Number(raw);
  if (!Number.isInteger(chainId) || chainId <= 0 || TESTNET_CHAIN_IDS.has(chainId)) return null;
  return chainId;
}

function n(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function availableMainnetChains() {
  const result = await pool.query(`
    select distinct chain_id
      from (
        select chain_id from public.campaign_drafts
        union all
        select chain_id from public.campaigns
        union all
        select chain_id from public.curve_trades
      ) x
     where chain_id is not null
       and chain_id <> all($1::int[])
     order by chain_id
  `, [Array.from(TESTNET_CHAIN_IDS)]);
  return result.rows.map((row) => Number(row.chain_id));
}

async function chainRows(from, to, selectedChain) {
  const params = [from, to, Array.from(TESTNET_CHAIN_IDS)];
  let selected = "";
  if (selectedChain != null) {
    params.push(selectedChain);
    selected = `and c.chain_id = $${params.length}`;
  }

  const result = await pool.query(`
    with chain_ids as (
      select distinct chain_id
        from (
          select chain_id from public.campaign_drafts
          union all
          select chain_id from public.campaigns
          union all
          select chain_id from public.curve_trades
        ) s
       where chain_id is not null
         and chain_id <> all($3::int[])
    ),
    drafts as (
      select chain_id,
             count(*) filter (
               where archived_at is null
                 and lower(coalesce(status, 'draft')) <> 'archived'
                 and deployed_at is null
             )::int as drafts_open,
             count(*) filter (where created_at >= $1 and created_at < $2)::int as drafts_created_in_range
        from public.campaign_drafts
       where chain_id <> all($3::int[])
       group by chain_id
    ),
    campaign_counts as (
      select chain_id,
             count(*) filter (
               where graduated_at_chain is null
                 and lower(coalesce(market_stage, 'bonding')) not in ('graduated', 'dex')
                 and coalesce(is_active, true) = true
             )::int as live,
             count(*) filter (
               where graduated_at_chain is null
                 and coalesce(is_active, true) = false
             )::int as ended,
             count(*) filter (
               where graduated_at_chain is not null
                  or lower(coalesce(market_stage, '')) in ('graduated', 'dex')
             )::int as graduated,
             count(*) filter (where coalesce(created_at_chain, created_at) >= $1 and coalesce(created_at_chain, created_at) < $2)::int as campaigns_created_in_range,
             count(*) filter (where graduated_at_chain >= $1 and graduated_at_chain < $2)::int as graduated_in_range
        from public.campaigns
       where chain_id <> all($3::int[])
       group by chain_id
    ),
    creators as (
      select chain_id, count(distinct creator)::int as unique_creators
        from (
          select chain_id, nullif(trim(creator_wallet), '') as creator
            from public.campaign_drafts
           where chain_id <> all($3::int[])
          union
          select chain_id, nullif(trim(creator_address), '') as creator
            from public.campaigns
           where chain_id <> all($3::int[])
        ) u
       where creator is not null
       group by chain_id
    ),
    trades as (
      select chain_id,
             count(*) filter (where block_time >= $1 and block_time < $2)::int as trades_in_range,
             count(*) filter (where block_time >= $1 and block_time < $2 and lower(side) = 'buy')::int as buys_in_range,
             count(*) filter (where block_time >= $1 and block_time < $2 and lower(side) = 'sell')::int as sells_in_range,
             count(distinct wallet) filter (where block_time >= $1 and block_time < $2)::int as unique_traders_in_range,
             count(distinct campaign_address) filter (where block_time >= $1 and block_time < $2)::int as active_campaigns_in_range,
             coalesce(sum(abs(bnb_amount)) filter (where block_time >= $1 and block_time < $2), 0)::numeric as volume_native_in_range,
             coalesce(sum(abs(bnb_amount)) filter (where block_time >= now() - interval '24 hours'), 0)::numeric as volume_native_24h,
             coalesce(sum(abs(bnb_amount)), 0)::numeric as volume_native_lifetime,
             greatest(coalesce(sum(case when lower(side) = 'buy' then bnb_amount when lower(side) = 'sell' then -bnb_amount else 0 end), 0), 0)::numeric as bonding_tvl_native
        from public.curve_trades
       where chain_id <> all($3::int[])
       group by chain_id
    )
    select c.chain_id,
           coalesce(d.drafts_open, 0)::int as drafts_open,
           coalesce(d.drafts_created_in_range, 0)::int as drafts_created_in_range,
           coalesce(cc.live, 0)::int as live,
           coalesce(cc.ended, 0)::int as ended,
           coalesce(cc.graduated, 0)::int as graduated,
           coalesce(cc.graduated_in_range, 0)::int as graduated_in_range,
           coalesce(cc.campaigns_created_in_range, 0)::int as campaigns_created_in_range,
           coalesce(cr.unique_creators, 0)::int as unique_creators,
           coalesce(t.trades_in_range, 0)::int as trades_in_range,
           coalesce(t.buys_in_range, 0)::int as buys_in_range,
           coalesce(t.sells_in_range, 0)::int as sells_in_range,
           coalesce(t.unique_traders_in_range, 0)::int as unique_traders_in_range,
           coalesce(t.active_campaigns_in_range, 0)::int as active_campaigns_in_range,
           coalesce(t.bonding_tvl_native, 0)::numeric as bonding_tvl_native,
           coalesce(t.volume_native_in_range, 0)::numeric as volume_native_in_range,
           coalesce(t.volume_native_24h, 0)::numeric as volume_native_24h,
           coalesce(t.volume_native_lifetime, 0)::numeric as volume_native_lifetime
      from chain_ids c
      left join drafts d using (chain_id)
      left join campaign_counts cc using (chain_id)
      left join creators cr using (chain_id)
      left join trades t using (chain_id)
     where true ${selected}
     order by c.chain_id
  `, params);

  return result.rows.map((row) => {
    const meta = chainMeta(row.chain_id);
    return {
      chainId: Number(row.chain_id),
      label: meta.label,
      unit: meta.unit,
      draftsOpen: n(row.drafts_open),
      draftsCreatedInRange: n(row.drafts_created_in_range),
      live: n(row.live),
      ended: n(row.ended),
      graduated: n(row.graduated),
      graduatedInRange: n(row.graduated_in_range),
      campaignsCreatedInRange: n(row.campaigns_created_in_range),
      uniqueCreators: n(row.unique_creators),
      tradesInRange: n(row.trades_in_range),
      buysInRange: n(row.buys_in_range),
      sellsInRange: n(row.sells_in_range),
      uniqueTradersInRange: n(row.unique_traders_in_range),
      activeCampaignsInRange: n(row.active_campaigns_in_range),
      bondingTvlNative: n(row.bonding_tvl_native),
      liveMcapNative: null,
      volumeNativeInRange: n(row.volume_native_in_range),
      volumeNative24h: n(row.volume_native_24h),
      volumeNativeLifetime: n(row.volume_native_lifetime),
    };
  });
}

async function topCampaigns(from, to, selectedChain) {
  const params = [from, to, Array.from(TESTNET_CHAIN_IDS)];
  let selected = "";
  if (selectedChain != null) {
    params.push(selectedChain);
    selected = `and t.chain_id = $${params.length}`;
  }
  const result = await pool.query(`
    select t.chain_id,
           t.campaign_address,
           coalesce(max(c.name), max(d.name), 'Unknown token') as name,
           coalesce(max(c.symbol), max(d.ticker)) as symbol,
           count(*)::int as trades,
           coalesce(sum(abs(t.bnb_amount)), 0)::numeric as volume_native
      from public.curve_trades t
      left join public.campaigns c
        on c.chain_id = t.chain_id
       and ((t.chain_id in (101,102) and c.campaign_address = t.campaign_address)
         or (t.chain_id not in (101,102) and lower(c.campaign_address) = lower(t.campaign_address)))
      left join public.campaign_drafts d
        on d.chain_id = t.chain_id
       and ((t.chain_id in (101,102) and d.campaign_address = t.campaign_address)
         or (t.chain_id not in (101,102) and lower(d.campaign_address) = lower(t.campaign_address)))
     where t.block_time >= $1 and t.block_time < $2
       and t.chain_id <> all($3::int[])
       ${selected}
     group by t.chain_id, t.campaign_address
     order by volume_native desc
     limit 20
  `, params);
  return result.rows.map((row) => {
    const meta = chainMeta(row.chain_id);
    return {
      chainId: Number(row.chain_id),
      campaignAddress: row.campaign_address,
      name: row.name,
      symbol: row.symbol || null,
      label: meta.label,
      unit: meta.unit,
      trades: n(row.trades),
      volumeNative: n(row.volume_native),
    };
  });
}

export async function launchpadKpis({ from, to, chainId = "all" }) {
  const selectedChain = requestedChain(chainId);
  const availableIds = await availableMainnetChains();
  const chains = await chainRows(from, to, selectedChain);
  const top = await topCampaigns(from, to, selectedChain);
  const totals = chains.reduce((acc, row) => {
    acc.draftsOpen += row.draftsOpen;
    acc.live += row.live;
    acc.ended += row.ended;
    acc.graduated += row.graduated;
    acc.graduatedInRange += row.graduatedInRange;
    acc.campaignsCreatedInRange += row.campaignsCreatedInRange;
    acc.draftsCreatedInRange += row.draftsCreatedInRange;
    acc.uniqueCreators += row.uniqueCreators;
    acc.tradesInRange += row.tradesInRange;
    acc.uniqueTradersInRange += row.uniqueTradersInRange;
    return acc;
  }, {
    draftsOpen: 0,
    draftsCreatedInRange: 0,
    live: 0,
    ended: 0,
    graduated: 0,
    graduatedInRange: 0,
    campaignsCreatedInRange: 0,
    uniqueCreators: 0,
    tradesInRange: 0,
    uniqueTradersInRange: 0,
  });

  return {
    from,
    to,
    chainId: selectedChain == null ? "all" : String(selectedChain),
    availableChains: availableIds.map((id) => ({ chainId: id, ...chainMeta(id) })),
    chains,
    totals,
    topCampaigns: top,
  };
}

export default launchpadKpis;
