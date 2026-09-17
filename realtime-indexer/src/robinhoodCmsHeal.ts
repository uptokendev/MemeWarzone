import { ethers } from "ethers";
import { LAUNCH_CAMPAIGN_ABI } from "./abis.js";
import { pool } from "./db.js";

const ZERO = ethers.ZeroAddress.toLowerCase();

function asPair(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Why a heal attempt did or did not write CMS. Surfaced by /health diagnostics. */
export type RobinhoodCmsHealResult = { healed: boolean; reason: string; pair?: string };

/**
 * campaign_market_state_graduation_order rejects a graduated row whose
 * graduation_block/tx are null, so the pair alone is not writable. Recover the
 * real CampaignFinalized anchor rather than fabricating one: the DB copy first,
 * then a log lookup scoped to the single campaign address.
 */
async function findGraduationAnchor(
  provider: ethers.Provider,
  chainId: number,
  camp: string,
): Promise<{ block: number; txHash: string; time: Date } | null> {
  try {
    const row = await pool.query(
      `select graduated_block, graduated_at_chain, meta->>'graduatedTx' as graduated_tx, created_block
         from public.campaigns
        where chain_id=$1 and lower(campaign_address)=$2
        limit 1`,
      [chainId, camp],
    );
    const known = row.rows[0];
    const knownBlock = Number(known?.graduated_block || 0);
    const knownTx = String(known?.graduated_tx || "").toLowerCase();
    if (knownBlock > 0 && /^0x[a-f0-9]{64}$/.test(knownTx)) {
      const when = known?.graduated_at_chain ? new Date(known.graduated_at_chain) : new Date();
      return { block: knownBlock, txHash: knownTx, time: when };
    }

    const iface = new ethers.Interface(LAUNCH_CAMPAIGN_ABI);
    const topic = iface.getEvent("CampaignFinalized")?.topicHash;
    if (!topic) return null;
    const logs = await provider.getLogs({
      address: camp,
      topics: [topic],
      fromBlock: Number(known?.created_block || 0),
      toBlock: "latest",
    });
    const finalized = logs[logs.length - 1];
    if (!finalized) return null;
    const block = await provider.getBlock(finalized.blockNumber);
    return {
      block: finalized.blockNumber,
      txHash: String(finalized.transactionHash).toLowerCase(),
      time: new Date(Number(block?.timestamp || 0) * 1000),
    };
  } catch (error) {
    console.warn("[indexer] RH CMS heal graduation anchor lookup failed", {
      chainId,
      campaign: camp,
      error: String((error as any)?.message || error),
    });
    return null;
  }
}

/**
 * The V3 pool indexer refuses a wrapped-native market whose CMS row has no
 * canonical wrapped native, and describeRobinhoodQuoteAsset can only classify
 * WRAPPED_NATIVE when that column is set. Read it from the campaign's own
 * graduation router, which is the adapter that actually provided the liquidity,
 * so this can never resolve to a different (staged) V3 surface.
 */
async function readGraduationVenue(
  provider: ethers.Provider,
  campaign: string,
): Promise<{ wrappedNative: string; v3Factory: string }> {
  const empty = { wrappedNative: "", v3Factory: "" };
  try {
    const router = String(
      await new ethers.Contract(campaign, ["function router() view returns (address)"], provider).router(),
    ).toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(router) || router === ZERO) return empty;
    const adapter = new ethers.Contract(
      router,
      ["function WETH() view returns (address)", "function v3Factory() view returns (address)"],
      provider,
    ) as any;
    const [weth, factory] = await Promise.all([
      adapter.WETH().then((v: string) => String(v).toLowerCase()).catch(() => ""),
      adapter.v3Factory().then((v: string) => String(v).toLowerCase()).catch(() => ""),
    ]);
    return {
      wrappedNative: /^0x[a-f0-9]{40}$/.test(weth) && weth !== ZERO ? weth : "",
      v3Factory: /^0x[a-f0-9]{40}$/.test(factory) && factory !== ZERO ? factory : "",
    };
  } catch {
    return empty;
  }
}

export async function healRobinhoodGraduatedCms(
  provider: ethers.Provider,
  chainId: number,
  campaign: string,
  tokenAddress: string | null,
): Promise<RobinhoodCmsHealResult> {
  if (chainId !== 46630 && chainId !== 4663) return { healed: false, reason: "not_robinhood_chain" };
  const camp = campaign.toLowerCase();
  if (!ethers.isAddress(camp)) return { healed: false, reason: "bad_campaign_address" };

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
    if (!launched) return { healed: false, reason: "not_launched_onchain" };
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
    return { healed: false, reason: `rpc_read_failed:${String((error as any)?.shortMessage || (error as any)?.message || error).slice(0, 120)}` };
  }

  if (!launched) return { healed: false, reason: "not_launched_onchain" };
  if (!/^0x[a-f0-9]{40}$/.test(pair) || pair === ZERO) return { healed: false, reason: "no_dex_pair_onchain" };
  if (!/^0x[a-f0-9]{40}$/.test(token)) return { healed: false, reason: "no_token_address" };

  const anchor = await findGraduationAnchor(provider, chainId, camp);
  if (!anchor) return { healed: false, reason: "no_graduation_anchor" };
  const now = anchor.time;

  // campaign_market_state_pair_uidx is unique on (chain_id, dex_pair_address).
  // A stale row holding this pair under a different campaign key makes the
  // upsert below throw, which the market-state route swallows, so the pair
  // never lands and nothing says why. Release the pair from any other row first.
  try {
    const released = await pool.query(
      `update public.campaign_market_state
          set dex_pair_address=null, updated_at=now()
        where chain_id=$1
          and lower(coalesce(dex_pair_address,''))=$2
          and lower(campaign_address)<>$3
        returning campaign_address`,
      [chainId, pair, camp],
    );
    if ((released.rowCount ?? 0) > 0) {
      console.warn("[indexer] RH CMS heal released pair from stale rows", {
        chainId,
        pair,
        releasedFrom: released.rows.map((r: any) => String(r.campaign_address)),
      });
    }
  } catch (error) {
    console.warn("[indexer] RH CMS heal pair release failed", {
      chainId,
      campaign: camp,
      error: String((error as any)?.message || error),
    });
  }

  try {
    await pool.query(
    `insert into public.campaign_market_state(
       chain_id,campaign_address,token_address,market_stage,
       graduation_time,graduation_block,graduation_tx_hash,dex_pair_address,
       graduated_liquidity_token_raw,graduated_liquidity_bnb_raw,graduated_lp_raw,
       burned_unsold_token_raw,burned_unused_lp_token_raw,post_burn_total_supply_raw,
       final_curve_price_bnb,initial_dex_price_bnb,
       pool_verified,indexing_enabled,updated_at
     ) values(
       $1,$2,$3,'GRADUATING',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       case when $14::text is null then null else ($14::numeric / 1e18) end,
       case when $15::text is null then null else ($15::numeric / 1e18) end,
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
       graduation_block=coalesce(public.campaign_market_state.graduation_block, excluded.graduation_block),
       graduation_tx_hash=coalesce(public.campaign_market_state.graduation_tx_hash, excluded.graduation_tx_hash),
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
       last_error=null,
       updated_at=now()`,
    [
      chainId,
      camp,
      token,
      now,
      anchor.block,
      anchor.txHash,
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
  } catch (error) {
    // Surfaced as lastError on /market-state so a failed heal is visible over
    // HTTP instead of only in container logs.
    // Report the predicate itself. This table carries staging-only constraints
    // that are not in db/migrations, so the message alone leaves us guessing.
    let predicate = "";
    const violated = String((error as any)?.constraint || "").trim();
    if (violated) {
      try {
        const def = await pool.query(
          `select pg_get_constraintdef(oid) as def from pg_constraint where conname=$1 limit 1`,
          [violated],
        );
        predicate = String(def.rows[0]?.def || "");
      } catch { /* diagnostics only */ }
    }
    const reason = `cms_write_failed:${String((error as any)?.message || error).slice(0, 200)}${
      predicate ? ` :: ${violated}=${predicate.slice(0, 300)}` : ""
    }`;
    console.error("[indexer] RH CMS heal write failed", { chainId, campaign: camp, pair, error: reason });
    try {
      await pool.query(
        `update public.campaign_market_state set last_error=$3, updated_at=now()
          where chain_id=$1 and lower(campaign_address)=$2`,
        [chainId, camp, reason],
      );
    } catch { /* diagnostics only */ }
    return { healed: false, reason };
  }

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

  const venue = await readGraduationVenue(provider, camp);
  if (venue.wrappedNative || venue.v3Factory) {
    try {
      await pool.query(
        `update public.campaign_market_state
            set wrapped_native_address=coalesce(nullif($3,''), wrapped_native_address),
                dex_factory_address=coalesce(nullif($4,''), dex_factory_address),
                updated_at=now()
          where chain_id=$1 and lower(campaign_address)=$2`,
        [chainId, camp, venue.wrappedNative, venue.v3Factory],
      );
    } catch (error) {
      console.warn("[indexer] RH CMS heal venue write failed", {
        chainId,
        campaign: camp,
        error: String((error as any)?.message || error),
      });
    }
  }

  console.log("[indexer] RH CMS heal seeded GRADUATING", { chainId, campaign: camp, pair, venue });
  return { healed: true, reason: "seeded_graduating", pair };
}
