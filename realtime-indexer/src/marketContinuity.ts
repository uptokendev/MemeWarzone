import { ethers } from "ethers";
import { pool as db } from "./db.js";
import {
  LAUNCH_CAMPAIGN_ABI,
  TOPAZ_FACTORY_ABI,
  TOPAZ_POOL_ABI,
  TOPAZ_PRODUCTION_ROUTER_ABI,
  TOPAZ_ROUTER_ADAPTER_ABI,
} from "./abis.js";
import { GEN5_CAMPAIGN_ABI } from "./evm/evmGen5Abi.js";
import {
  GEN5_ADAPTER_VIEW_ABI,
  classifyGen5TopazPool,
  expectedGen5PoolQuote,
  gen5GraduatedSnapshot,
  splitReserves,
} from "./evm/evmGen5Handoff.js";

export type GraduationEventSnapshot = {
  caller: string;
  pair: string;
  graduationBalanceRaw: string;
  graduationOvershootRaw: string;
  liquidityTokenRaw: string;
  liquidityBnbRaw: string;
  liquidityLpRaw: string;
  protocolFeeRaw: string;
  creatorPayoutRaw: string;
  burnedUnsoldTokenRaw: string;
  burnedUnusedLpTokenRaw: string;
  finalCurvePriceRaw: string;
  initialDexPriceRaw: string;
  postBurnTotalSupplyRaw: string;
};

export type MarketVerification = {
  routeVerified: boolean;
  marketStage: "TOPAZ_PENDING" | "TOPAZ_ACTIVE" | "TOPAZ_DEGRADED";
  reason: string | null;
};

type GraduationHandoffInput = {
  provider: ethers.Provider;
  chainId: number;
  campaignAddress: string;
  txHash: string;
  blockNumber: number;
  blockTime: Date;
  args: any;
};

const ZERO = ethers.ZeroAddress.toLowerCase();

function raw(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value == null) return "0";
  return String(value);
}

function address(value: unknown): string {
  const candidate = String(value ?? "").trim();
  if (!ethers.isAddress(candidate)) return ZERO;
  return ethers.getAddress(candidate).toLowerCase();
}

function valueAt(args: any, name: string, index: number): unknown {
  return args?.[name] ?? args?.[index];
}

export function graduationEventSnapshot(args: any): GraduationEventSnapshot {
  return {
    caller: address(valueAt(args, "caller", 0)),
    pair: address(valueAt(args, "pair", 1)),
    graduationBalanceRaw: raw(valueAt(args, "graduationBalance", 2)),
    graduationOvershootRaw: raw(valueAt(args, "graduationOvershoot", 3)),
    liquidityTokenRaw: raw(valueAt(args, "liquidityTokens", 4)),
    liquidityBnbRaw: raw(valueAt(args, "liquidityBnb", 5)),
    liquidityLpRaw: raw(valueAt(args, "liquidityLp", 6)),
    protocolFeeRaw: raw(valueAt(args, "protocolFee", 7)),
    creatorPayoutRaw: raw(valueAt(args, "creatorPayout", 8)),
    burnedUnsoldTokenRaw: raw(valueAt(args, "burnedUnsoldTokens", 9)),
    burnedUnusedLpTokenRaw: raw(valueAt(args, "burnedUnusedLpTokens", 10)),
    finalCurvePriceRaw: raw(valueAt(args, "finalCurvePrice", 11)),
    initialDexPriceRaw: raw(valueAt(args, "initialDexPrice", 12)),
    postBurnTotalSupplyRaw: raw(valueAt(args, "postBurnTotalSupply", 13)),
  };
}

export function classifyTopazMarket(input: {
  pairPresent: boolean;
  pairMatchesFactory: boolean;
  tokenPairValid: boolean;
  volatile: boolean;
  reservesPresent: boolean;
  feeVerified: boolean;
}): MarketVerification {
  if (!input.pairPresent) {
    return { routeVerified: false, marketStage: "TOPAZ_PENDING", reason: "Graduation pair is not available yet." };
  }

  const failures: string[] = [];
  if (!input.pairMatchesFactory) failures.push("factory pair mismatch");
  if (!input.tokenPairValid) failures.push("token/WBNB pair mismatch");
  if (!input.volatile) failures.push("pool is not volatile");
  if (!input.reservesPresent) failures.push("pool reserves are not available");
  if (!input.feeVerified) failures.push("pool fee is not verified");

  if (failures.length > 0) {
    return { routeVerified: false, marketStage: "TOPAZ_DEGRADED", reason: failures.join(", ") };
  }

  return { routeVerified: true, marketStage: "TOPAZ_ACTIVE", reason: null };
}

async function tryCall<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

async function readPoolFeeBps(factory: any, pool: any, pairAddress: string): Promise<number | null> {
  const calls: Array<() => Promise<unknown>> = [
    () => factory["getFee(address,bool)"](pairAddress, false),
    () => factory["getFee(address)"](pairAddress),
    () => pool.fee(),
    () => pool.swapFee(),
  ];

  for (const call of calls) {
    const result = await tryCall(call);
    if (result == null) continue;
    const fee = Number(result);
    if (Number.isInteger(fee) && fee >= 0 && fee <= 10_000) return fee;
  }

  return null;
}

async function markHandoffFailure(input: GraduationHandoffInput, snapshot: GraduationEventSnapshot, message: string) {
  const campaign = address(input.campaignAddress);
  await db.query(
    `insert into public.campaign_market_state(
       chain_id,campaign_address,token_address,market_stage,
       graduation_tx_hash,graduation_block,graduation_time,dex_pair_address,
       final_curve_price_bnb,initial_dex_price_bnb,
       graduated_liquidity_token_raw,graduated_liquidity_bnb_raw,graduated_lp_raw,
       burned_unsold_token_raw,burned_unused_lp_token_raw,post_burn_total_supply_raw,
       pool_verified,indexing_enabled,last_error,created_at,updated_at
     )
     select
       $1,$2,coalesce(c.token_address,''),'TOPAZ_DEGRADED',
       $3,$4,$5,nullif($6,$7),
       ($8::numeric / 1e18),($9::numeric / 1e18),
       $10,$11,$12,$13,$14,$15,
       false,true,$16,now(),now()
     from public.campaigns c
     where c.chain_id=$1 and c.campaign_address=$2
     on conflict (chain_id,campaign_address) do update set
       market_stage='TOPAZ_DEGRADED',
       graduation_tx_hash=excluded.graduation_tx_hash,
       graduation_block=excluded.graduation_block,
       graduation_time=excluded.graduation_time,
       dex_pair_address=coalesce(excluded.dex_pair_address,public.campaign_market_state.dex_pair_address),
       final_curve_price_bnb=coalesce(excluded.final_curve_price_bnb,public.campaign_market_state.final_curve_price_bnb),
       initial_dex_price_bnb=coalesce(excluded.initial_dex_price_bnb,public.campaign_market_state.initial_dex_price_bnb),
       graduated_liquidity_token_raw=excluded.graduated_liquidity_token_raw,
       graduated_liquidity_bnb_raw=excluded.graduated_liquidity_bnb_raw,
       graduated_lp_raw=excluded.graduated_lp_raw,
       burned_unsold_token_raw=excluded.burned_unsold_token_raw,
       burned_unused_lp_token_raw=excluded.burned_unused_lp_token_raw,
       post_burn_total_supply_raw=excluded.post_burn_total_supply_raw,
       pool_verified=false,
       indexing_enabled=true,
       last_error=excluded.last_error,
       updated_at=now()`,
    [
      input.chainId,
      campaign,
      input.txHash.toLowerCase(),
      input.blockNumber,
      input.blockTime,
      snapshot.pair,
      ZERO,
      snapshot.finalCurvePriceRaw,
      snapshot.initialDexPriceRaw,
      snapshot.liquidityTokenRaw,
      snapshot.liquidityBnbRaw,
      snapshot.liquidityLpRaw,
      snapshot.burnedUnsoldTokenRaw,
      snapshot.burnedUnusedLpTokenRaw,
      snapshot.postBurnTotalSupplyRaw,
      message,
    ],
  );

  await db.query(
    `update public.campaigns
        set market_stage='TOPAZ_DEGRADED',
            bonding_active=false,
            support_enabled=true,
            indexing_enabled=true,
            updated_at=now()
      where chain_id=$1 and campaign_address=$2`,
    [input.chainId, campaign],
  );
}

/**
 * The verified-handoff writes (campaign_market_state, dex_pools when verified, campaigns), in one
 * transaction. Shared by the old generation (CampaignFinalized) and generation 5 (Graduated); the SQL is
 * the old generation's, unchanged.
 */
async function persistVerifiedHandoff(p: {
  input: GraduationHandoffInput;
  campaign: string;
  tokenAddress: string;
  campaignFactoryAddress: string;
  verification: { routeVerified: boolean; marketStage: string; reason: string | null };
  pairAddress: string;
  routerAddress: string;
  dexFactoryAddress: string;
  wrappedNativeAddress: string;
  stable: boolean;
  feeBps: number | null;
  snapshot: GraduationEventSnapshot;
  token0Address: string;
  token1Address: string;
  reserveTokenRaw: string;
  reserveNativeRaw: string;
}) {
  const {
    input,
    campaign,
    tokenAddress,
    campaignFactoryAddress,
    verification,
    pairAddress,
    routerAddress: productionRouterAddress,
    dexFactoryAddress,
    wrappedNativeAddress,
    stable,
    feeBps,
    snapshot,
    token0Address,
    token1Address,
    reserveTokenRaw,
    reserveNativeRaw,
  } = p;

  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into public.campaign_market_state(
         chain_id,campaign_address,token_address,factory_address,market_stage,
         graduation_tx_hash,graduation_block,graduation_time,
         dex_pair_address,dex_router_address,dex_factory_address,wrapped_native_address,
         pool_stable,pool_fee_bps,final_curve_price_bnb,initial_dex_price_bnb,
         graduated_liquidity_token_raw,graduated_liquidity_bnb_raw,graduated_lp_raw,
         burned_unsold_token_raw,burned_unused_lp_token_raw,post_burn_total_supply_raw,
         pool_verified,indexing_enabled,last_verified_at,last_error,created_at,updated_at
       ) values(
         $1,$2,$3,nullif($4,$5),$6,$7,$8,$9,
         nullif($10,$5),$11,$12,$13,$14,$15,
         ($16::numeric / 1e18),($17::numeric / 1e18),
         $18,$19,$20,$21,$22,$23,
         $24,true,now(),$25,now(),now()
       )
       on conflict (chain_id,campaign_address) do update set
         token_address=excluded.token_address,
         factory_address=coalesce(excluded.factory_address,public.campaign_market_state.factory_address),
         market_stage=excluded.market_stage,
         graduation_tx_hash=excluded.graduation_tx_hash,
         graduation_block=excluded.graduation_block,
         graduation_time=excluded.graduation_time,
         dex_pair_address=excluded.dex_pair_address,
         dex_router_address=excluded.dex_router_address,
         dex_factory_address=excluded.dex_factory_address,
         wrapped_native_address=excluded.wrapped_native_address,
         pool_stable=excluded.pool_stable,
         pool_fee_bps=excluded.pool_fee_bps,
         final_curve_price_bnb=excluded.final_curve_price_bnb,
         initial_dex_price_bnb=excluded.initial_dex_price_bnb,
         graduated_liquidity_token_raw=excluded.graduated_liquidity_token_raw,
         graduated_liquidity_bnb_raw=excluded.graduated_liquidity_bnb_raw,
         graduated_lp_raw=excluded.graduated_lp_raw,
         burned_unsold_token_raw=excluded.burned_unsold_token_raw,
         burned_unused_lp_token_raw=excluded.burned_unused_lp_token_raw,
         post_burn_total_supply_raw=excluded.post_burn_total_supply_raw,
         pool_verified=excluded.pool_verified,
         indexing_enabled=true,
         last_verified_at=excluded.last_verified_at,
         last_error=excluded.last_error,
         updated_at=now()`,
      [
        input.chainId,
        campaign,
        tokenAddress,
        campaignFactoryAddress,
        ZERO,
        verification.marketStage,
        input.txHash.toLowerCase(),
        input.blockNumber,
        input.blockTime,
        pairAddress,
        productionRouterAddress,
        dexFactoryAddress,
        wrappedNativeAddress,
        stable,
        feeBps,
        snapshot.finalCurvePriceRaw,
        snapshot.initialDexPriceRaw,
        snapshot.liquidityTokenRaw,
        snapshot.liquidityBnbRaw,
        snapshot.liquidityLpRaw,
        snapshot.burnedUnsoldTokenRaw,
        snapshot.burnedUnusedLpTokenRaw,
        snapshot.postBurnTotalSupplyRaw,
        verification.routeVerified,
        verification.reason,
      ],
    );

    if (verification.routeVerified && feeBps != null) {
      await client.query(
        `insert into public.dex_pools(
           chain_id,pair_address,campaign_address,token_address,wrapped_native_address,
           router_address,factory_address,token0_address,token1_address,stable,fee_bps,
           graduation_block,support_enabled,indexing_enabled,last_sync_at,
           reserve_token_raw,reserve_native_raw,created_at,updated_at
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,true,true,now(),$12,$13,now(),now())
         on conflict (chain_id,pair_address) do update set
           campaign_address=excluded.campaign_address,
           token_address=excluded.token_address,
           wrapped_native_address=excluded.wrapped_native_address,
           router_address=excluded.router_address,
           factory_address=excluded.factory_address,
           token0_address=excluded.token0_address,
           token1_address=excluded.token1_address,
           stable=false,
           fee_bps=excluded.fee_bps,
           graduation_block=excluded.graduation_block,
           support_enabled=true,
           indexing_enabled=true,
           last_sync_at=now(),
           reserve_token_raw=excluded.reserve_token_raw,
           reserve_native_raw=excluded.reserve_native_raw,
           updated_at=now()`,
        [
          input.chainId,
          pairAddress,
          campaign,
          tokenAddress,
          wrappedNativeAddress,
          productionRouterAddress,
          dexFactoryAddress,
          token0Address,
          token1Address,
          feeBps,
          input.blockNumber,
          reserveTokenRaw,
          reserveNativeRaw,
        ],
      );
    }

    await client.query(
      `update public.campaigns
          set is_active=false,
              bonding_active=false,
              support_enabled=true,
              indexing_enabled=true,
              market_stage=$3,
              launched=true,
              graduated_block=$4,
              graduated_at_chain=$5,
              meta=coalesce(meta,'{}'::jsonb) || jsonb_build_object(
                'graduatedTx',$6,
                'topazPair',nullif($7,$8),
                'topazRouter',$9,
                'topazFactory',$10,
                'topazWbnb',$11
              ),
              updated_at=now()
        where chain_id=$1 and campaign_address=$2`,
      [
        input.chainId,
        campaign,
        verification.marketStage,
        input.blockNumber,
        input.blockTime,
        input.txHash.toLowerCase(),
        pairAddress,
        ZERO,
        productionRouterAddress,
        dexFactoryAddress,
        wrappedNativeAddress,
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileGraduationHandoff(input: GraduationHandoffInput) {
  const campaign = address(input.campaignAddress);
  const snapshot = graduationEventSnapshot(input.args);

  try {
    if (campaign === ZERO) throw new Error("Invalid campaign address");

    const campaignContract = new ethers.Contract(campaign, LAUNCH_CAMPAIGN_ABI, input.provider) as any;
    const [tokenResult, adapterResult, factoryResult, stateResult] = await Promise.all([
      tryCall(() => campaignContract.token()),
      tryCall(() => campaignContract.router()),
      tryCall(() => campaignContract.factory()),
      tryCall(() => campaignContract.getGraduationState()),
    ]);

    const tokenAddress = address(tokenResult);
    const adapterAddress = address(adapterResult);
    const campaignFactoryAddress = address(factoryResult);
    const statePair = address((stateResult as any)?.dexPair ?? (stateResult as any)?.[0]);
    const pairAddress = statePair !== ZERO ? statePair : snapshot.pair;

    if (tokenAddress === ZERO) throw new Error("Campaign token could not be resolved");
    if (adapterAddress === ZERO) throw new Error("Campaign Topaz router adapter could not be resolved");

    const adapter = new ethers.Contract(adapterAddress, TOPAZ_ROUTER_ADAPTER_ABI, input.provider) as any;
    const topazRouterFromAdapter = address(await tryCall(() => adapter.topazRouter()));
    const productionRouterAddress = topazRouterFromAdapter !== ZERO ? topazRouterFromAdapter : adapterAddress;
    const productionRouter = new ethers.Contract(
      productionRouterAddress,
      TOPAZ_PRODUCTION_ROUTER_ABI,
      input.provider,
    ) as any;

    const adapterFactory = address(await tryCall(() => adapter.poolFactory()));
    const adapterWrapped = address(await tryCall(() => adapter.WETH()));
    const productionFactory = address(await tryCall(() => productionRouter.defaultFactory()));
    const productionWrapped = address(await tryCall(() => productionRouter.weth()));
    const dexFactoryAddress = adapterFactory !== ZERO ? adapterFactory : productionFactory;
    const wrappedNativeAddress = adapterWrapped !== ZERO ? adapterWrapped : productionWrapped;

    if (dexFactoryAddress === ZERO) throw new Error("Topaz pool factory could not be resolved");
    if (wrappedNativeAddress === ZERO) throw new Error("Topaz wrapped native token could not be resolved");

    const factory = new ethers.Contract(dexFactoryAddress, TOPAZ_FACTORY_ABI, input.provider) as any;
    const factoryPairAddress = address(await tryCall(() => factory.getPool(tokenAddress, wrappedNativeAddress, false)));
    const pairMatchesFactory = pairAddress !== ZERO && factoryPairAddress === pairAddress;

    let token0Address = ZERO;
    let token1Address = ZERO;
    let stable = true;
    let reserve0 = 0n;
    let reserve1 = 0n;
    let feeBps: number | null = null;

    if (pairAddress !== ZERO) {
      const code = await input.provider.getCode(pairAddress);
      if (code && code !== "0x") {
        const dexPool = new ethers.Contract(pairAddress, TOPAZ_POOL_ABI, input.provider) as any;
        const [token0Result, token1Result, stableResult, reservesResult] = await Promise.all([
          tryCall(() => dexPool.token0()),
          tryCall(() => dexPool.token1()),
          tryCall(() => dexPool.stable()),
          tryCall(() => dexPool.getReserves()),
        ]);
        token0Address = address(token0Result);
        token1Address = address(token1Result);
        stable = stableResult == null ? true : Boolean(stableResult);
        reserve0 = BigInt((reservesResult as any)?.[0] ?? 0);
        reserve1 = BigInt((reservesResult as any)?.[1] ?? 0);
        feeBps = await readPoolFeeBps(factory, dexPool, pairAddress);
      }
    }

    const tokenPairValid =
      (token0Address === tokenAddress && token1Address === wrappedNativeAddress) ||
      (token1Address === tokenAddress && token0Address === wrappedNativeAddress);
    const reservesPresent = reserve0 > 0n && reserve1 > 0n;
    const verification = classifyTopazMarket({
      pairPresent: pairAddress !== ZERO,
      pairMatchesFactory,
      tokenPairValid,
      volatile: stable === false,
      reservesPresent,
      feeVerified: feeBps != null,
    });

    const reserveTokenRaw = token0Address === tokenAddress ? reserve0.toString() : reserve1.toString();
    const reserveNativeRaw = token0Address === wrappedNativeAddress ? reserve0.toString() : reserve1.toString();

    await persistVerifiedHandoff({
      input,
      campaign,
      tokenAddress,
      campaignFactoryAddress,
      verification,
      pairAddress,
      routerAddress: productionRouterAddress,
      dexFactoryAddress,
      wrappedNativeAddress,
      stable,
      feeBps,
      snapshot,
      token0Address,
      token1Address,
      reserveTokenRaw,
      reserveNativeRaw,
    });

    return {
      ...verification,
      campaignAddress: campaign,
      tokenAddress,
      pairAddress: pairAddress === ZERO ? null : pairAddress,
      routerAddress: productionRouterAddress,
      factoryAddress: dexFactoryAddress,
      wrappedNativeAddress,
      feeBps,
      reserveTokenRaw,
      reserveNativeRaw,
    };
  } catch (error: any) {
    const message = String(error?.shortMessage || error?.message || error);
    await markHandoffFailure(input, snapshot, message);
    return {
      routeVerified: false,
      marketStage: "TOPAZ_DEGRADED" as const,
      reason: message,
      campaignAddress: campaign,
      pairAddress: snapshot.pair === ZERO ? null : snapshot.pair,
    };
  }
}

/**
 * Generation-5 handoff (BNB Topaz). Driven by the campaign's `Graduated` event: pool from the event,
 * confirmed by getGraduationState().dexPair; the pool pairs the token with the bound quote (quote coin)
 * or WBNB (native coin, or a quote coin after the E12 native fallback). The DEX factory and WBNB come
 * from the campaign's graduation adapter (gen 5 has no router()); the Topaz router from the quote
 * adapter's topazRouter(), else EVM_TOPAZ_ROUTER_<chainId>, else the adapter. Same writes as the old
 * generation, so the Topaz pool indexer picks the pool up unchanged.
 */
export async function reconcileGen5GraduationHandoff(input: GraduationHandoffInput) {
  const campaign = address(input.campaignAddress);
  let snapshot = gen5GraduatedSnapshot(input.args, undefined, input.args?.caller ?? null);

  try {
    if (campaign === ZERO) throw new Error("Invalid campaign address");

    const campaignContract = new ethers.Contract(campaign, GEN5_CAMPAIGN_ABI, input.provider) as any;
    const [tokenResult, adapterResult, factoryResult, stateResult, quoteResult, fallbackResult] = await Promise.all([
      tryCall(() => campaignContract.token()),
      tryCall(() => campaignContract.graduationAdapter()),
      tryCall(() => campaignContract.factory()),
      tryCall(() => campaignContract.getGraduationState()),
      tryCall(() => campaignContract.graduationQuoteToken()),
      tryCall(() => campaignContract.nativeFallback()),
    ]);
    snapshot = gen5GraduatedSnapshot(input.args, stateResult ?? undefined, input.args?.caller ?? null);

    const tokenAddress = address(tokenResult);
    const adapterAddress = address(adapterResult);
    const campaignFactoryAddress = address(factoryResult);
    const pairAddress = snapshot.pair;

    if (tokenAddress === ZERO) throw new Error("Campaign token could not be resolved");
    if (adapterAddress === ZERO) throw new Error("Campaign graduation adapter could not be resolved");
    if (fallbackResult == null) throw new Error("Campaign native fallback flag could not be read");

    const adapter = new ethers.Contract(adapterAddress, GEN5_ADAPTER_VIEW_ABI, input.provider) as any;
    const [adapterFactory, adapterWbnb, adapterRouter] = await Promise.all([
      tryCall(() => adapter.topazFactory()),
      tryCall(() => adapter.WBNB()),
      tryCall(() => adapter.topazRouter()),
    ]);
    const dexFactoryAddress = address(adapterFactory);
    const wrappedNativeAddress = address(adapterWbnb);
    const envRouter = address(process.env[`EVM_TOPAZ_ROUTER_${input.chainId}`]);
    const routerAddress =
      address(adapterRouter) !== ZERO ? address(adapterRouter) : envRouter !== ZERO ? envRouter : adapterAddress;

    if (dexFactoryAddress === ZERO) throw new Error("Topaz pool factory could not be resolved from the graduation adapter");
    if (wrappedNativeAddress === ZERO) throw new Error("WBNB could not be resolved from the graduation adapter");

    const expectedQuote = expectedGen5PoolQuote({
      quoteToken: quoteResult == null ? null : String(quoteResult),
      nativeFallback: Boolean(fallbackResult),
      wrappedNative: wrappedNativeAddress,
    });

    const factory = new ethers.Contract(dexFactoryAddress, TOPAZ_FACTORY_ABI, input.provider) as any;
    const factoryPairAddress = address(await tryCall(() => factory.getPool(tokenAddress, expectedQuote, false)));
    const pairMatchesFactory = pairAddress !== ZERO && factoryPairAddress === pairAddress;

    let token0Address = ZERO;
    let token1Address = ZERO;
    let stable = true;
    let reserve0 = 0n;
    let reserve1 = 0n;
    let feeBps: number | null = null;

    if (pairAddress !== ZERO) {
      const code = await input.provider.getCode(pairAddress);
      if (code && code !== "0x") {
        const dexPool = new ethers.Contract(pairAddress, TOPAZ_POOL_ABI, input.provider) as any;
        const [token0Result, token1Result, stableResult, reservesResult] = await Promise.all([
          tryCall(() => dexPool.token0()),
          tryCall(() => dexPool.token1()),
          tryCall(() => dexPool.stable()),
          tryCall(() => dexPool.getReserves()),
        ]);
        token0Address = address(token0Result);
        token1Address = address(token1Result);
        stable = stableResult == null ? true : Boolean(stableResult);
        reserve0 = BigInt((reservesResult as any)?.[0] ?? 0);
        reserve1 = BigInt((reservesResult as any)?.[1] ?? 0);
        feeBps = await readPoolFeeBps(factory, dexPool, pairAddress);
      }
    }

    const verification = classifyGen5TopazPool({
      pairPresent: pairAddress !== ZERO,
      pairMatchesFactory,
      token: tokenAddress,
      expectedQuote,
      token0: token0Address,
      token1: token1Address,
      stable,
      reservesPresent: reserve0 > 0n && reserve1 > 0n,
      feeVerified: feeBps != null,
    });
    const reserves = splitReserves({ token: tokenAddress, token0: token0Address, reserve0, reserve1 });

    await persistVerifiedHandoff({
      input,
      campaign,
      tokenAddress,
      campaignFactoryAddress,
      verification,
      pairAddress,
      routerAddress,
      dexFactoryAddress,
      wrappedNativeAddress,
      stable,
      feeBps,
      snapshot,
      token0Address,
      token1Address,
      reserveTokenRaw: reserves.reserveTokenRaw,
      // dex_pools names the paired leg "native"; for a quote pool it is the quote reserve, and
      // dex_pools.quote_token_address (generated from token0/token1) names that quote.
      reserveNativeRaw: reserves.reserveQuoteRaw,
    });

    return {
      ...verification,
      generation: 5,
      campaignAddress: campaign,
      tokenAddress,
      pairAddress: pairAddress === ZERO ? null : pairAddress,
      quoteTokenAddress: expectedQuote,
      routerAddress,
      factoryAddress: dexFactoryAddress,
      wrappedNativeAddress,
      feeBps,
      reserveTokenRaw: reserves.reserveTokenRaw,
      reserveNativeRaw: reserves.reserveQuoteRaw,
    };
  } catch (error: any) {
    const message = String(error?.shortMessage || error?.message || error);
    await markHandoffFailure(input, snapshot, message);
    return {
      routeVerified: false,
      marketStage: "TOPAZ_DEGRADED" as const,
      reason: message,
      generation: 5,
      campaignAddress: campaign,
      pairAddress: snapshot.pair === ZERO ? null : snapshot.pair,
    };
  }
}
