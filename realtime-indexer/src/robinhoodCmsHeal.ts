import { ethers } from "ethers";
import { LAUNCH_CAMPAIGN_ABI } from "./abis.js";
import { pool } from "./db.js";

const ZERO = ethers.ZeroAddress.toLowerCase();

function asPair(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export async function healRobinhoodGraduatedCms(
  provider: ethers.Provider,
  chainId: number,
  campaign: string,
  tokenAddress: string | null,
): Promise<boolean> {
  if (chainId !== 46630 && chainId !== 4663) return false;
  const camp = campaign.toLowerCase();
  if (!ethers.isAddress(camp)) return false;

  const c = new ethers.Contract(camp, LAUNCH_CAMPAIGN_ABI, provider) as any;
  let launched = false;
  let pair = "";
  let token = tokenAddress ? tokenAddress.toLowerCase() : "";
  let liquidityTokens: string | null = null;
  let liquidityBnb: string | null = null;
  let liquidityLp: string | null = null;
  let burnedUnsold: string | null = null;
  let burnedLp: string | null = null;
  let postBurnSupply: string | null = null;
  let finalCurvePrice: string | null = null;
  let initialDexPrice: string | null = null;
  try {
    launched = Boolean(await c.launched());
    if (!launched) return false;
    const state = await c.getGraduationState();
    pair = asPair(state?.dexPair ?? state?.[0]);
    if (!token) token = String(await c.token()).toLowerCase();
    liquidityTokens = state?.graduatedLiquidityTokens != null ? String(state.graduatedLiquidityTokens) : state?.[3] != null ? String(state[3]) : null;
    liquidityBnb = state?.graduatedLiquidityBnb != null ? String(state.graduatedLiquidityBnb) : state?.[4] != null ? String(state[4]) : null;
    liquidityLp = state?.graduatedLiquidityLp != null ? String(state.graduatedLiquidityLp) : state?.[5] != null ? String(state[5]) : null;
    burnedUnsold = state?.burnedUnsoldTokens != null ? String(state.burnedUnsoldTokens) : state?.[6] != null ? String(state[6]) : null;
    burnedLp = state?.burnedUnusedLpTokens != null ? String(state.burnedUnusedLpTokens) : state?.[7] != null ? String(state[7]) : null;
    postBurnSupply = state?.postBurnTotalSupply != null ? String(state.postBurnTotalSupply) : state?.[8] != null ? String(state[8]) : null;
    finalCurvePrice = state?.finalCurvePrice != null ? String(state.finalCurvePrice) : state?.[1] != null ? String(state[1]) : null;
    initialDexPrice = state?.initialDexPrice != null ? String(state.initialDexPrice) : state?.[2] != null ? String(state[2]) : null;
  } catch (error) {
    console.warn("[indexer] RH CMS heal read failed", {
      chainId,
      campaign: camp,
      error: String((error as any)?.message || error),
    });
    return false;
  }

  if (!launched) return false;
  if (!/^0x[a-f0-9]{40}$/.test(pair) || pair === ZERO) return false;
  if (!/^0x[a-f0-9]{40}$/.test(token)) return false;

  const now = new Date();
  await pool.query(
    `insert into public.campaign_market_state(
       chain_id,campaign_address,token_address,market_stage,
       graduation_time,dex_pair_address,
       graduated_liquidity_token_raw,graduated_liquidity_bnb_raw,graduated_lp_raw,
       burned_unsold_token_raw,burned_unused_lp_token_raw,post_burn_total_supply_raw,
       final_curve_price_bnb,initial_dex_price_bnb,
       pool_verified,indexing_enabled,updated_at
     ) values(
       $1,$2,$3,'GRADUATING',$4,$5,$6,$7,$8,$9,$10,$11,
       case when $12::text is null then null else ($12::numeric / 1e18) end,
       case when $13::text is null then null else ($13::numeric / 1e18) end,
       false,true,now()
     )
     on conflict(chain_id,campaign_address) do update set
       token_address=excluded.token_address,
       market_stage=case
         when public.campaign_market_state.market_stage in ('DEX_ACTIVE','DEX_PENDING','DEX_DEGRADED')
           then public.campaign_market_state.market_stage
         else excluded.market_stage
       end,
       graduation_time=coalesce(public.campaign_market_state.graduation_time, excluded.graduation_time),
       dex_pair_address=case
         when public.campaign_market_state.dex_pair_address is null
           or length(btrim(coalesce(public.campaign_market_state.dex_pair_address,''))) < 42
           or lower(public.campaign_market_state.dex_pair_address) = '${ZERO}'
           or upper(public.campaign_market_state.market_stage) = 'BONDING'
         then excluded.dex_pair_address
         else public.campaign_market_state.dex_pair_address
       end,
       graduated_liquidity_token_raw=coalesce(public.campaign_market_state.graduated_liquidity_token_raw, excluded.graduated_liquidity_token_raw),
       graduated_liquidity_bnb_raw=coalesce(public.campaign_market_state.graduated_liquidity_bnb_raw, excluded.graduated_liquidity_bnb_raw),
       graduated_lp_raw=coalesce(public.campaign_market_state.graduated_lp_raw, excluded.graduated_lp_raw),
       burned_unsold_token_raw=coalesce(public.campaign_market_state.burned_unsold_token_raw, excluded.burned_unsold_token_raw),
       burned_unused_lp_token_raw=coalesce(public.campaign_market_state.burned_unused_lp_token_raw, excluded.burned_unused_lp_token_raw),
       post_burn_total_supply_raw=coalesce(public.campaign_market_state.post_burn_total_supply_raw, excluded.post_burn_total_supply_raw),
       final_curve_price_bnb=coalesce(public.campaign_market_state.final_curve_price_bnb, excluded.final_curve_price_bnb),
       initial_dex_price_bnb=coalesce(public.campaign_market_state.initial_dex_price_bnb, excluded.initial_dex_price_bnb),
       indexing_enabled=true,
       updated_at=now()`,
    [
      chainId,
      camp,
      token,
      now,
      pair,
      liquidityTokens,
      liquidityBnb,
      liquidityLp,
      burnedUnsold,
      burnedLp,
      postBurnSupply,
      finalCurvePrice,
      initialDexPrice,
    ],
  );

  try {
    await pool.query(
      `update public.campaigns
          set is_active=false,
              bonding_active=false,
              graduated_at_chain=coalesce(graduated_at_chain, $3),
              updated_at=now()
        where chain_id=$1 and campaign_address=$2`,
      [chainId, camp, now],
    );
  } catch (error) {
    console.warn("[indexer] RH CMS heal campaigns row update failed", {
      chainId,
      campaign: camp,
      error: String((error as any)?.message || error),
    });
  }

  console.log("[indexer] RH CMS heal seeded GRADUATING", { chainId, campaign: camp, pair });
  return true;
}
