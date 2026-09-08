import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { badMethod, getQuery, json } from "../../server/http.js";
import { getServerReadProvider } from "../lib/getServerReadProvider.js";
import { requireDashboardAdmin } from "./_auth.js";

const BNB_LOCKER_ABI = [
  "function poolInfo(address) view returns (address campaign,address creator,address creatorFeeRecipient,address pool,address token0,address token1,uint256 lockedLpAmount,uint16 creatorFeeBps,uint16 protocolFeeBps,bool registered)",
  "function cumulativeCreatorPaid(address pool,address token) view returns (uint256)",
  "function cumulativeProtocolRouted(address pool,address token) view returns (uint256)",
  "function pendingToken(address recipient,address token) view returns (uint256)",
  "function pendingNative(address recipient) view returns (uint256)",
  "function pendingProtocolToken(address token) view returns (uint256)",
  "function pendingProtocolNative() view returns (uint256)",
  "function creatorPayoutRecipient(address creator) view returns (address)",
  "function topazFactory() view returns (address)",
  "function treasuryRouter() view returns (address)",
];

const V3_LOCKER_ABI = [
  "function poolInfo(address) view returns (address campaign,address creator,address creatorFeeRecipient,address pool,address token0,address token1,uint256 tokenId,uint128 lockedLiquidity,uint24 feeTier,uint16 creatorFeeBps,uint16 protocolFeeBps,bool registered)",
  "function cumulativeCreatorPaid(address pool,address token) view returns (uint256)",
  "function cumulativeProtocolRouted(address pool,address token) view returns (uint256)",
  "function pendingToken(address recipient,address token) view returns (uint256)",
  "function pendingProtocolToken(address token) view returns (uint256)",
  "function creatorPayoutRecipient(address creator) view returns (address)",
  "function treasuryRouter() view returns (address)",
  "function v3Factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function wrappedNative() view returns (address)",
];

const TOPAZ_POOL_ABI = [
  "function claimable0(address account) view returns (uint256)",
  "function claimable1(address account) view returns (uint256)",
];

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
];

function isRobinhoodChain(chainId) {
  return Number(chainId) === 4663 || Number(chainId) === 46630;
}

function isAddress(value) {
  return ethers.isAddress(String(value || "").trim());
}

function toAddr(value) {
  const raw = String(value || "").trim().toLowerCase();
  return isAddress(raw) ? raw : null;
}

function weiToDecimal(value) {
  try {
    return Number(ethers.formatEther(BigInt(String(value ?? "0"))));
  } catch {
    return 0;
  }
}

function resolveIndexerBaseUrl() {
  const raw = String(
    process.env.RAILWAY_INDEXER_URL ||
      process.env.RAILWAY_API_BASE_URL ||
      process.env.VITE_REALTIME_API_BASE ||
      "",
  ).trim();
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

async function proxySolanaLpFees(q, chainId, limit) {
  const base = resolveIndexerBaseUrl();
  if (!base) {
    const error = new Error("Realtime Indexer URL is not configured on the Frontend API.");
    error.status = 503;
    throw error;
  }

  const params = new URLSearchParams({ chainId: String(chainId), limit: String(limit) });
  const campaign = String(q.campaign || "").trim();
  const creator = String(q.creator || "").trim();
  if (campaign) params.set("campaign", campaign);
  if (creator) params.set("creator", creator);

  const upstream = await fetch(`${base}/api/dashboard/lp-fees?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const error = new Error(payload?.error || `Realtime Indexer LP read failed (${upstream.status}).`);
    error.status = upstream.status;
    throw error;
  }
  if (!payload || payload.ok !== true || Number(payload.chainId) !== chainId) {
    const error = new Error("Realtime Indexer returned an invalid Solana LP response.");
    error.status = 502;
    throw error;
  }
  return payload;
}

async function authorize(req, res) {
  const opsKey = String(process.env.DASHBOARD_OPS_KEY || process.env.OPS_READ_KEY || "").trim();
  const provided = String(req.headers["x-ops-key"] || getQuery(req).opsKey || "").trim();
  if (opsKey && provided && opsKey === provided) return { mode: "ops-key" };

  const q = getQuery(req);
  const chainId = Number(q.chainId ?? 97);
  if (chainId === 97 || chainId === 46630) return { mode: "testnet-open" };

  const creator = toAddr(q.creator);
  if (creator) return { mode: "creator-self", creator };

  const admin = await requireDashboardAdmin(req, res);
  if (!admin) return null;
  return { mode: "admin", admin };
}

async function loadGraduatedRows(chainId, limit) {
  try {
    const { rows } = await pool.query(
      `select c.chain_id,
              c.campaign_address,
              c.token_address,
              c.creator_address,
              c.name,
              c.symbol,
              c.graduated_at_chain,
              c.factory_address,
              cms.dex_pair_address,
              cms.market_stage,
              cms.dex_router_address
         from public.campaigns c
         left join public.campaign_market_state cms
           on cms.chain_id = c.chain_id
          and lower(cms.campaign_address) = lower(c.campaign_address)
        where c.chain_id = $1
          and (
            c.graduated_at_chain is not null
            or c.graduated_block is not null
            or cms.market_stage ilike '%TOPAZ%'
            or cms.market_stage ilike '%DEX%'
            or cms.dex_pair_address is not null
          )
        order by c.graduated_at_chain desc nulls last, c.created_at_chain desc nulls last
        limit $2`,
      [chainId, limit],
    );
    return rows;
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") {
      const { rows } = await pool.query(
        `select chain_id, campaign_address, token_address, creator_address, name, symbol,
                graduated_at_chain, factory_address,
                null::text as dex_pair_address, null::text as market_stage, null::text as dex_router_address
           from public.campaigns
          where chain_id = $1
            and (graduated_at_chain is not null or graduated_block is not null)
          order by graduated_at_chain desc nulls last
          limit $2`,
        [chainId, limit],
      );
      return rows;
    }
    throw error;
  }
}

function resolveLockerAddress(chainId) {
  const per = String(
    process.env[`LP_LOCKER_ADDRESS_${chainId}`] ||
      process.env[`VITE_LP_LOCKER_ADDRESS_${chainId}`] ||
      process.env[`PERMANENT_LP_LOCKER_ADDRESS_${chainId}`] ||
      process.env[`VITE_PERMANENT_LP_LOCKER_ADDRESS_${chainId}`] ||
      "",
  ).trim();
  if (isAddress(per)) return ethers.getAddress(per);

  // Unsuffixed legacy fallback is BNB-only. Robinhood must never borrow it.
  if (!isRobinhoodChain(chainId)) {
    const generic = String(process.env.LP_LOCKER_ADDRESS || process.env.VITE_LP_LOCKER_ADDRESS || "").trim();
    if (isAddress(generic)) return ethers.getAddress(generic);
  }
  if (Number(chainId) === 97) return "0xb083929D2bbabdE7fc580090D5B18bbD918Fda9a";
  return null;
}

async function commonFeeAccounting(locker, pairAddress, token0, token1, creatorRecipient) {
  const [
    creatorPaid0,
    creatorPaid1,
    protocolRouted0,
    protocolRouted1,
    pendingCreator0,
    pendingCreator1,
    pendingProtocol0,
    pendingProtocol1,
  ] = await Promise.all([
    locker.cumulativeCreatorPaid(pairAddress, token0).catch(() => 0n),
    locker.cumulativeCreatorPaid(pairAddress, token1).catch(() => 0n),
    locker.cumulativeProtocolRouted(pairAddress, token0).catch(() => 0n),
    locker.cumulativeProtocolRouted(pairAddress, token1).catch(() => 0n),
    locker.pendingToken(creatorRecipient, token0).catch(() => 0n),
    locker.pendingToken(creatorRecipient, token1).catch(() => 0n),
    locker.pendingProtocolToken(token0).catch(() => 0n),
    locker.pendingProtocolToken(token1).catch(() => 0n),
  ]);
  return { creatorPaid0, creatorPaid1, protocolRouted0, protocolRouted1, pendingCreator0, pendingCreator1, pendingProtocol0, pendingProtocol1 };
}

async function readTopazPoolFees({ provider, lockerAddress, pairAddress, creatorAddress }) {
  const locker = new ethers.Contract(lockerAddress, BNB_LOCKER_ABI, provider);
  const poolContract = new ethers.Contract(pairAddress, TOPAZ_POOL_ABI, provider);
  const info = await locker.poolInfo(pairAddress);
  const registered = Boolean(info?.registered ?? info?.[9]);
  if (!registered) return { registered: false, note: "Pool not registered on PermanentLpLocker yet." };

  const token0 = String(info.token0 || info[4] || "").toLowerCase();
  const token1 = String(info.token1 || info[5] || "").toLowerCase();
  const creator = toAddr(creatorAddress) || toAddr(info.creator || info[1]);
  const creatorRecipient = toAddr(await locker.creatorPayoutRecipient(creator).catch(() => null)) || toAddr(info.creatorFeeRecipient || info[2]) || creator;
  const [claimable0, claimable1, accounting, pendingCreatorNative, pendingProtocolNative] = await Promise.all([
    poolContract.claimable0(lockerAddress).catch(() => 0n),
    poolContract.claimable1(lockerAddress).catch(() => 0n),
    commonFeeAccounting(locker, pairAddress, token0, token1, creatorRecipient),
    locker.pendingNative(creatorRecipient).catch(() => 0n),
    locker.pendingProtocolNative().catch(() => 0n),
  ]);
  const creatorFeeBps = Number(info.creatorFeeBps ?? info[7] ?? 8000);
  const protocolFeeBps = Number(info.protocolFeeBps ?? info[8] ?? 2000);

  return formatFeeResponse({
    kind: "topaz_v2",
    lockerAddress,
    pairAddress,
    token0,
    token1,
    creator,
    creatorRecipient,
    creatorFeeBps,
    protocolFeeBps,
    lockedPrincipal: String(info.lockedLpAmount ?? info[6] ?? "0"),
    tokenId: null,
    claimable0,
    claimable1,
    accounting,
    pendingCreatorNative,
    pendingProtocolNative,
  });
}

async function readRobinhoodV3Fees({ provider, lockerAddress, pairAddress, creatorAddress }) {
  const locker = new ethers.Contract(lockerAddress, V3_LOCKER_ABI, provider);
  const info = await locker.poolInfo(pairAddress);
  const registered = Boolean(info?.registered ?? info?.[11]);
  if (!registered) return { registered: false, note: "Pool not registered on PermanentV3PositionLocker yet." };

  const token0 = String(info.token0 || info[4] || "").toLowerCase();
  const token1 = String(info.token1 || info[5] || "").toLowerCase();
  const tokenId = BigInt(info.tokenId ?? info[6] ?? 0);
  const creator = toAddr(creatorAddress) || toAddr(info.creator || info[1]);
  const creatorRecipient = toAddr(await locker.creatorPayoutRecipient(creator).catch(() => null)) || toAddr(info.creatorFeeRecipient || info[2]) || creator;
  const managerAddress = await locker.positionManager();
  if (!isAddress(managerAddress)) throw new Error("Robinhood V3 position manager is not configured.");
  const manager = new ethers.Contract(managerAddress, POSITION_MANAGER_ABI, provider);
  const [position, accounting] = await Promise.all([
    manager.positions(tokenId),
    commonFeeAccounting(locker, pairAddress, token0, token1, creatorRecipient),
  ]);

  const positionToken0 = String(position.token0 || position[2] || "").toLowerCase();
  const positionToken1 = String(position.token1 || position[3] || "").toLowerCase();
  if (positionToken0 !== token0 || positionToken1 !== token1) throw new Error("Robinhood V3 position token pair mismatch.");
  const lockedLiquidity = BigInt(info.lockedLiquidity ?? info[7] ?? 0);
  const currentLiquidity = BigInt(position.liquidity ?? position[7] ?? 0);
  if (lockedLiquidity <= 0n || currentLiquidity !== lockedLiquidity) throw new Error("Robinhood V3 locked principal invariant failed.");

  const claimable0 = BigInt(position.tokensOwed0 ?? position[10] ?? 0);
  const claimable1 = BigInt(position.tokensOwed1 ?? position[11] ?? 0);
  const creatorFeeBps = Number(info.creatorFeeBps ?? info[9] ?? 8000);
  const protocolFeeBps = Number(info.protocolFeeBps ?? info[10] ?? 2000);

  return formatFeeResponse({
    kind: "robinhood_v3",
    lockerAddress,
    pairAddress,
    token0,
    token1,
    creator,
    creatorRecipient,
    creatorFeeBps,
    protocolFeeBps,
    lockedPrincipal: lockedLiquidity.toString(),
    tokenId: tokenId.toString(),
    claimable0,
    claimable1,
    accounting,
    pendingCreatorNative: 0n,
    pendingProtocolNative: 0n,
  });
}

function formatFeeResponse(input) {
  const { accounting } = input;
  const creatorShare0 = (BigInt(input.claimable0) * BigInt(input.creatorFeeBps)) / 10000n;
  const creatorShare1 = (BigInt(input.claimable1) * BigInt(input.creatorFeeBps)) / 10000n;
  const protocolShare0 = BigInt(input.claimable0) - creatorShare0;
  const protocolShare1 = BigInt(input.claimable1) - creatorShare1;

  return {
    registered: true,
    kind: input.kind,
    lockerAddress: input.lockerAddress.toLowerCase(),
    pairAddress: input.pairAddress.toLowerCase(),
    token0: input.token0,
    token1: input.token1,
    tokenId: input.tokenId,
    creator: input.creator,
    creatorRecipient: input.creatorRecipient,
    creatorFeeBps: input.creatorFeeBps,
    protocolFeeBps: input.protocolFeeBps,
    lockedLpAmount: input.lockedPrincipal,
    lockedLiquidity: input.lockedPrincipal,
    unharvested: {
      token0Raw: BigInt(input.claimable0).toString(),
      token1Raw: BigInt(input.claimable1).toString(),
      token0: weiToDecimal(input.claimable0),
      token1: weiToDecimal(input.claimable1),
      creatorShareToken0: weiToDecimal(creatorShare0),
      creatorShareToken1: weiToDecimal(creatorShare1),
      protocolShareToken0: weiToDecimal(protocolShare0),
      protocolShareToken1: weiToDecimal(protocolShare1),
    },
    harvestedLifetime: {
      creatorToken0: weiToDecimal(accounting.creatorPaid0),
      creatorToken1: weiToDecimal(accounting.creatorPaid1),
      protocolToken0: weiToDecimal(accounting.protocolRouted0),
      protocolToken1: weiToDecimal(accounting.protocolRouted1),
      creatorToken0Raw: accounting.creatorPaid0.toString(),
      creatorToken1Raw: accounting.creatorPaid1.toString(),
      protocolToken0Raw: accounting.protocolRouted0.toString(),
      protocolToken1Raw: accounting.protocolRouted1.toString(),
    },
    pending: {
      creatorToken0: weiToDecimal(accounting.pendingCreator0),
      creatorToken1: weiToDecimal(accounting.pendingCreator1),
      creatorNative: weiToDecimal(input.pendingCreatorNative),
      protocolToken0: weiToDecimal(accounting.pendingProtocol0),
      protocolToken1: weiToDecimal(accounting.pendingProtocol1),
      protocolNative: weiToDecimal(input.pendingProtocolNative),
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const auth = await authorize(req, res);
    if (!auth) return;

    const q = getQuery(req);
    const chainId = Number(q.chainId ?? 97);
    const limit = Math.max(1, Math.min(50, Number(q.limit ?? 20)));

    if (chainId === 101 || chainId === 102) {
      const payload = await proxySolanaLpFees(q, chainId, limit);
      return json(res, 200, payload);
    }

    const pairFilter = toAddr(q.pair || q.pool);
    const campaignFilter = toAddr(q.campaign);
    const lockerAddress = resolveLockerAddress(chainId);
    if (!lockerAddress) return json(res, 400, { error: "LP locker address not configured for this chain." });

    const provider = await getServerReadProvider(chainId);
    const robinhood = isRobinhoodChain(chainId);
    const locker = new ethers.Contract(lockerAddress, robinhood ? V3_LOCKER_ABI : BNB_LOCKER_ABI, provider);
    const [dexFactory, treasuryRouter] = await Promise.all([
      robinhood ? locker.v3Factory().catch(() => null) : locker.topazFactory().catch(() => null),
      locker.treasuryRouter().catch(() => null),
    ]);

    let rows = await loadGraduatedRows(chainId, limit);
    if (auth?.mode === "creator-self" && auth.creator) {
      rows = rows.filter((r) => String(r.creator_address || "").toLowerCase() === auth.creator);
    }
    if (campaignFilter) rows = rows.filter((r) => String(r.campaign_address || "").toLowerCase() === campaignFilter);
    if (pairFilter) rows = rows.filter((r) => String(r.dex_pair_address || "").toLowerCase() === pairFilter);

    const items = [];
    for (const row of rows) {
      const pair = toAddr(row.dex_pair_address);
      const base = {
        chainId,
        campaignAddress: String(row.campaign_address || "").toLowerCase(),
        tokenAddress: row.token_address ? String(row.token_address).toLowerCase() : null,
        creatorAddress: row.creator_address ? String(row.creator_address).toLowerCase() : null,
        name: row.name || null,
        symbol: row.symbol || null,
        graduatedAt: row.graduated_at_chain || null,
        marketStage: row.market_stage || null,
        pairAddress: pair,
      };

      if (!pair) {
        items.push({ ...base, fees: { registered: false, note: robinhood ? "No V3 pool address in campaign_market_state yet." : "No Topaz pair address in campaign_market_state yet." } });
        continue;
      }

      try {
        const fees = robinhood
          ? await readRobinhoodV3Fees({ provider, lockerAddress, pairAddress: pair, creatorAddress: base.creatorAddress })
          : await readTopazPoolFees({ provider, lockerAddress, pairAddress: pair, creatorAddress: base.creatorAddress });
        items.push({ ...base, fees });
      } catch (error) {
        items.push({ ...base, fees: { registered: false, error: String(error?.message || error) } });
      }
    }

    return json(res, 200, {
      ok: true,
      chainId,
      dex: robinhood ? "robinhood_v3" : "topaz_v2",
      nativeSymbol: robinhood ? "ETH" : "BNB",
      lockerAddress: lockerAddress.toLowerCase(),
      topazFactory: robinhood ? null : dexFactory ? String(dexFactory).toLowerCase() : null,
      v3Factory: robinhood && dexFactory ? String(dexFactory).toLowerCase() : null,
      treasuryRouter: treasuryRouter ? String(treasuryRouter).toLowerCase() : null,
      split: { creatorBps: 8000, protocolBps: 2000 },
      notes: robinhood
        ? [
            "Robinhood graduation liquidity is a permanently locked V3 NFT position.",
            "Unharvested fees are position tokensOwed0/1; locked liquidity is verified unchanged.",
            "harvest(pool) on PermanentV3PositionLocker splits 80% creator / 20% protocol without decreasing liquidity.",
            "Creator/protocol accounting remains token-specific; wrapped ETH is not relabeled as BNB.",
          ]
        : [
            "DEX LP fees accrue on the Topaz pool as claimable0/1 for the locker.",
            "harvest(pool) on PermanentLpLocker splits 80% creator / 20% protocol.",
            "Unharvested = still on pool. Harvested lifetime = already paid/routed. Pending = failed transfer leftovers.",
          ],
      items,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/dashboard/lp-fees]", error);
    return json(res, Number(error?.status || 500), { error: String(error?.message || "Server error") });
  }
}
