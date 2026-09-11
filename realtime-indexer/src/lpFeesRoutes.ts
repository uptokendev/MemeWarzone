import type express from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ethers } from "ethers";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { createStaticJsonRpcProvider, parseRpcList } from "./rpcProvider.js";
import { harvestSolanaLpFees, listSolanaLpFees, solanaHarvestStatus } from "./solanaLpFees.js";

const LOCKER_ABI = [
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

const POOL_ABI = [
  "function claimable0(address account) view returns (uint256)",
  "function claimable1(address account) view returns (uint256)",
  "function claimFees() returns (uint256 amount0, uint256 amount1)",
  "function index0() view returns (uint256)",
  "function index1() view returns (uint256)",
  "function supplyIndex0(address account) view returns (uint256)",
  "function supplyIndex1(address account) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function isAddress(value: unknown): boolean {
  return ethers.isAddress(String(value ?? "").trim());
}

function toAddr(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  return isAddress(raw) ? raw : null;
}

type SolanaRouteAuthority = {
  chainId: 101;
  environment: "staging" | "production";
  cluster: "devnet" | "mainnet-beta";
};

function normalizeSolanaEnvironment(value: unknown): "staging" | "production" | "" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "staging") return "staging";
  if (normalized === "production" || normalized === "prod") return "production";
  return "";
}

function normalizeSolanaCluster(value: unknown): "devnet" | "mainnet-beta" | "" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "devnet" || normalized === "solana-devnet") return "devnet";
  if (["mainnet", "mainnet-beta", "solana-mainnet", "solana-mainnet-beta"].includes(normalized)) return "mainnet-beta";
  return "";
}

function currentIndexerSolanaAuthority(): SolanaRouteAuthority | null {
  const environment = normalizeSolanaEnvironment(
    process.env.RUNTIME_ENVIRONMENT || process.env.VITE_RUNTIME_ENVIRONMENT,
  );
  const cluster = normalizeSolanaCluster(
    process.env.SOLANA_CLUSTER || process.env.VITE_SOLANA_CLUSTER,
  );
  if (environment === "staging" && cluster === "devnet") return { chainId: 101, environment, cluster };
  if (environment === "production" && cluster === "mainnet-beta") return { chainId: 101, environment, cluster };
  return null;
}

function requestedSolanaAuthority(source: Record<string, unknown>): SolanaRouteAuthority | null {
  const chainId = Number(source.chainId ?? 0);
  if (chainId !== 101) return null;
  const environment = normalizeSolanaEnvironment(source.environment);
  const cluster = normalizeSolanaCluster(source.solanaCluster ?? source.cluster);
  if (environment === "staging" && cluster === "devnet") return { chainId: 101, environment, cluster };
  if (environment === "production" && cluster === "mainnet-beta") return { chainId: 101, environment, cluster };
  return null;
}

function requireCurrentSolanaAuthority(source: Record<string, unknown>):
  | { ok: true; authority: SolanaRouteAuthority }
  | { ok: false; status: number; error: string } {
  if (Number(source.chainId ?? 0) === 102) {
    return { ok: false, status: 400, error: "Legacy Solana chain 102 is not a current LP fee authority." };
  }
  const requested = requestedSolanaAuthority(source);
  if (!requested) {
    return {
      ok: false,
      status: 400,
      error: "Solana LP fee authority requires chain 101 plus explicit staging/devnet or production/mainnet-beta identity.",
    };
  }
  const configured = currentIndexerSolanaAuthority();
  if (!configured) {
    return {
      ok: false,
      status: 503,
      error: "Indexer Solana runtime identity is not explicitly configured.",
    };
  }
  if (configured.environment !== requested.environment || configured.cluster !== requested.cluster) {
    return {
      ok: false,
      status: 409,
      error: `Requested Solana ${requested.environment}/${requested.cluster} does not match this indexer runtime.`,
    };
  }
  return { ok: true, authority: requested };
}

function weiToDecimal(value: bigint | string | number): number {
  try {
    return Number(ethers.formatEther(BigInt(String(value ?? "0"))));
  } catch {
    return 0;
  }
}

/** Human string with fixed decimals (no scientific notation). */
function formatTokenAmount(value: bigint | string | number, decimals = 18, maxFrac = 8): string {
  try {
    const raw = BigInt(String(value ?? "0"));
    const neg = raw < 0n;
    const abs = neg ? -raw : raw;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = abs % base;
    if (frac === 0n) return `${neg ? "-" : ""}${whole.toString()}`;
    let fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (fracStr.length > maxFrac) {
      // Round by truncation for display only; keep enough for dust fees.
      fracStr = fracStr.slice(0, maxFrac).replace(/0+$/, "");
    }
    if (!fracStr) return `${neg ? "-" : ""}${whole.toString()}`;
    return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
  } catch {
    return "0";
  }
}

const ERC20_META_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
];

async function readErc20Meta(provider: ethers.Provider, token: string) {
  const c = new ethers.Contract(token, ERC20_META_ABI, provider);
  const [symbol, decimals, name] = await Promise.all([
    c.symbol().catch(() => "???"),
    c.decimals().catch(() => 18),
    c.name().catch(() => ""),
  ]);
  return {
    address: token.toLowerCase(),
    symbol: String(symbol || "???"),
    decimals: Number(decimals ?? 18),
    name: String(name || ""),
  };
}

function resolveLockerAddress(chainId: number): string | null {
  const per = String(
    process.env[`LP_LOCKER_ADDRESS_${chainId}`] ||
      process.env[`VITE_LP_LOCKER_ADDRESS_${chainId}`] ||
      process.env[`PERMANENT_LP_LOCKER_ADDRESS_${chainId}`] ||
      process.env[`VITE_PERMANENT_LP_LOCKER_ADDRESS_${chainId}`] ||
      "",
  ).trim();
  if (isAddress(per)) return ethers.getAddress(per);
  const generic = String(
    process.env.LP_LOCKER_ADDRESS ||
      process.env.VITE_LP_LOCKER_ADDRESS ||
      process.env.PERMANENT_LP_LOCKER_ADDRESS ||
      process.env.VITE_PERMANENT_LP_LOCKER_ADDRESS ||
      "",
  ).trim();
  if (isAddress(generic)) return ethers.getAddress(generic);
  // Clean-slate BSC testnet locker (post dual-factory reset)
  if (chainId === 97) return "0xb083929D2bbabdE7fc580090D5B18bbD918Fda9a";
  return null;
}

function resolveRpcUrl(chainId: number): string {
  if (chainId === 56) {
    return parseRpcList(ENV.BSC_RPC_HTTP_56)[0] || parseRpcList(process.env.BSC_RPC_HTTP || "")[0] || "";
  }
  return parseRpcList(ENV.BSC_RPC_HTTP_97)[0] || parseRpcList(process.env.BSC_RPC_HTTP || "")[0] || "";
}

async function loadGraduatedRows(chainId: number, limit: number) {
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
            or cms.dex_pair_address is not null
          )
        order by c.graduated_at_chain desc nulls last, c.created_at_chain desc nulls last
        limit $2`,
      [chainId, limit],
    );
    return rows;
  } catch (error: any) {
    if (error?.code === "42P01" || error?.code === "42703") {
      const { rows } = await pool.query(
        `select chain_id, campaign_address, token_address, creator_address, name, symbol,
                graduated_at_chain, factory_address,
                null::text as dex_pair_address, null::text as market_stage, null::text as dex_router_address
           from public.campaigns
          where chain_id = $1 and graduated_at_chain is not null
          order by graduated_at_chain desc nulls last
          limit $2`,
        [chainId, limit],
      );
      return rows;
    }
    throw error;
  }
}

/**
 * Minimal Topaz pool fee accrual often leaves claimable0/1 at 0 while claimFees()
 * still returns the pending LP fee amounts when called by the LP holder (locker).
 */
async function readUnharvestedPoolFees(
  poolContract: ethers.Contract,
  lockerAddress: string,
  provider: ethers.Provider,
): Promise<{ token0Raw: bigint; token1Raw: bigint; source: string }> {
  // 1) Authoritative for harvest path: staticcall claimFees() from locker.
  try {
    const data = poolContract.interface.encodeFunctionData("claimFees");
    const ret = await provider.call({ to: await poolContract.getAddress(), from: lockerAddress, data });
    const decoded = poolContract.interface.decodeFunctionResult("claimFees", ret);
    const a0 = BigInt(decoded[0] ?? decoded.amount0 ?? 0);
    const a1 = BigInt(decoded[1] ?? decoded.amount1 ?? 0);
    if (a0 > 0n || a1 > 0n) {
      return { token0Raw: a0, token1Raw: a1, source: "claimFees_staticcall" };
    }
    // Zero can be real — still prefer this source when call succeeds.
    const view0 = await poolContract.claimable0(lockerAddress).catch(() => 0n);
    const view1 = await poolContract.claimable1(lockerAddress).catch(() => 0n);
    if (BigInt(view0) > 0n || BigInt(view1) > 0n) {
      return { token0Raw: BigInt(view0), token1Raw: BigInt(view1), source: "claimable_view" };
    }
    return { token0Raw: a0, token1Raw: a1, source: "claimFees_staticcall" };
  } catch {
    // fall through
  }

  // 2) Solidly index math: (index - supplyIndex) * balance / 1e18
  try {
    const [index0, index1, supply0, supply1, balance] = await Promise.all([
      poolContract.index0(),
      poolContract.index1(),
      poolContract.supplyIndex0(lockerAddress),
      poolContract.supplyIndex1(lockerAddress),
      poolContract.balanceOf(lockerAddress),
    ]);
    const bal = BigInt(balance);
    const a0 = ((BigInt(index0) - BigInt(supply0)) * bal) / 10n ** 18n;
    const a1 = ((BigInt(index1) - BigInt(supply1)) * bal) / 10n ** 18n;
    if (a0 > 0n || a1 > 0n) {
      return { token0Raw: a0 < 0n ? 0n : a0, token1Raw: a1 < 0n ? 0n : a1, source: "index_math" };
    }
  } catch {
    // fall through
  }

  // 3) claimable views (works on mocks / some deployments)
  try {
    const [view0, view1] = await Promise.all([
      poolContract.claimable0(lockerAddress),
      poolContract.claimable1(lockerAddress),
    ]);
    return { token0Raw: BigInt(view0), token1Raw: BigInt(view1), source: "claimable_view" };
  } catch {
    return { token0Raw: 0n, token1Raw: 0n, source: "unavailable" };
  }
}

async function readPoolFees(input: {
  provider: ethers.Provider;
  lockerAddress: string;
  pairAddress: string;
  creatorAddress: string | null;
}) {
  const locker = new ethers.Contract(input.lockerAddress, LOCKER_ABI, input.provider);
  const poolContract = new ethers.Contract(input.pairAddress, POOL_ABI, input.provider);

  const info = await locker.poolInfo(input.pairAddress);
  const registered = Boolean(info?.registered ?? info?.[9]);
  if (!registered) {
    return {
      registered: false,
      note: "Pool not registered on PermanentLpLocker yet (graduation handoff / pool registration incomplete).",
    };
  }

  const token0 = String(info.token0 || info[4] || "").toLowerCase();
  const token1 = String(info.token1 || info[5] || "").toLowerCase();
  const creator = toAddr(input.creatorAddress) || toAddr(info.creator || info[1]);
  const creatorRecipient =
    toAddr(await locker.creatorPayoutRecipient(creator).catch(() => null)) ||
    toAddr(info.creatorFeeRecipient || info[2]) ||
    creator;

  const [token0Meta, token1Meta, unharvested] = await Promise.all([
    readErc20Meta(input.provider, token0),
    readErc20Meta(input.provider, token1),
    // Minimal Topaz: claimable0/1 often 0; prefer claimFees() staticcall as locker.
    readUnharvestedPoolFees(poolContract, input.lockerAddress, input.provider),
  ]);

  const [
    creatorPaid0,
    creatorPaid1,
    protocolRouted0,
    protocolRouted1,
    pendingCreator0,
    pendingCreator1,
    pendingCreatorNative,
    pendingProtocol0,
    pendingProtocol1,
    pendingProtocolNative,
  ] = await Promise.all([
    locker.cumulativeCreatorPaid(input.pairAddress, token0).catch(() => 0n),
    locker.cumulativeCreatorPaid(input.pairAddress, token1).catch(() => 0n),
    locker.cumulativeProtocolRouted(input.pairAddress, token0).catch(() => 0n),
    locker.cumulativeProtocolRouted(input.pairAddress, token1).catch(() => 0n),
    locker.pendingToken(creatorRecipient, token0).catch(() => 0n),
    locker.pendingToken(creatorRecipient, token1).catch(() => 0n),
    locker.pendingNative(creatorRecipient).catch(() => 0n),
    locker.pendingProtocolToken(token0).catch(() => 0n),
    locker.pendingProtocolToken(token1).catch(() => 0n),
    locker.pendingProtocolNative().catch(() => 0n),
  ]);

  const creatorFeeBps = Number(info.creatorFeeBps ?? info[7] ?? 8000);
  const protocolFeeBps = Number(info.protocolFeeBps ?? info[8] ?? 2000);
  const c0 = unharvested.token0Raw;
  const c1 = unharvested.token1Raw;
  const d0 = token0Meta.decimals;
  const d1 = token1Meta.decimals;
  const creator0 = (c0 * BigInt(creatorFeeBps)) / 10000n;
  const creator1 = (c1 * BigInt(creatorFeeBps)) / 10000n;
  const protocol0 = c0 - creator0;
  const protocol1 = c1 - creator1;

  return {
    registered: true,
    lockerAddress: input.lockerAddress.toLowerCase(),
    pairAddress: input.pairAddress.toLowerCase(),
    pairLabel: `vAMM-${token0Meta.symbol}/${token1Meta.symbol}`,
    token0,
    token1,
    token0Meta,
    token1Meta,
    creator,
    creatorRecipient,
    creatorFeeBps,
    protocolFeeBps,
    lockedLpAmount: String(info.lockedLpAmount ?? info[6] ?? "0"),
    unharvested: {
      token0Raw: c0.toString(),
      token1Raw: c1.toString(),
      token0: weiToDecimal(c0),
      token1: weiToDecimal(c1),
      token0Display: formatTokenAmount(c0, d0),
      token1Display: formatTokenAmount(c1, d1),
      token0Symbol: token0Meta.symbol,
      token1Symbol: token1Meta.symbol,
      source: unharvested.source,
      creatorShareToken0: weiToDecimal(creator0),
      creatorShareToken1: weiToDecimal(creator1),
      protocolShareToken0: weiToDecimal(protocol0),
      protocolShareToken1: weiToDecimal(protocol1),
      creatorShareToken0Display: formatTokenAmount(creator0, d0),
      creatorShareToken1Display: formatTokenAmount(creator1, d1),
      protocolShareToken0Display: formatTokenAmount(protocol0, d0),
      protocolShareToken1Display: formatTokenAmount(protocol1, d1),
      note:
        unharvested.source === "claimFees_staticcall"
          ? "Unharvested from eth_call claimFees() as locker (claimable0/1 views are unreliable on Minimal Topaz)."
          : unharvested.source === "index_math"
            ? "Unharvested estimated from (index - supplyIndex) * lpBalance / 1e18."
            : "Unharvested from claimable0/1 views.",
    },
    harvestedLifetime: {
      creatorToken0: weiToDecimal(creatorPaid0),
      creatorToken1: weiToDecimal(creatorPaid1),
      protocolToken0: weiToDecimal(protocolRouted0),
      protocolToken1: weiToDecimal(protocolRouted1),
      creatorToken0Display: formatTokenAmount(creatorPaid0, d0),
      creatorToken1Display: formatTokenAmount(creatorPaid1, d1),
      protocolToken0Display: formatTokenAmount(protocolRouted0, d0),
      protocolToken1Display: formatTokenAmount(protocolRouted1, d1),
      creatorToken0Raw: BigInt(creatorPaid0).toString(),
      creatorToken1Raw: BigInt(creatorPaid1).toString(),
      protocolToken0Raw: BigInt(protocolRouted0).toString(),
      protocolToken1Raw: BigInt(protocolRouted1).toString(),
    },
    pending: {
      creatorToken0: weiToDecimal(pendingCreator0),
      creatorToken1: weiToDecimal(pendingCreator1),
      creatorNative: weiToDecimal(pendingCreatorNative),
      protocolToken0: weiToDecimal(pendingProtocol0),
      protocolToken1: weiToDecimal(pendingProtocol1),
      protocolNative: weiToDecimal(pendingProtocolNative),
      creatorToken0Display: formatTokenAmount(pendingCreator0, d0),
      creatorToken1Display: formatTokenAmount(pendingCreator1, d1),
      protocolToken0Display: formatTokenAmount(pendingProtocol0, d0),
      protocolToken1Display: formatTokenAmount(pendingProtocol1, d1),
    },
  };
}

function authorizeOpsWrite(req: Request): { ok: true } | { ok: false; error: string; status: number } {
  const opsKey = String(process.env.DASHBOARD_OPS_KEY || process.env.OPS_READ_KEY || "").trim();
  const provided = String(req.headers["x-ops-key"] || req.body?.opsKey || req.query.opsKey || "").trim();
  // Testnet convenience: allow harvest without ops key when HARVEST_OPS_PRIVATE_KEY is set
  // and chain is 97, still prefer ops key when configured.
  if (opsKey) {
    if (provided !== opsKey) return { ok: false, status: 401, error: "Invalid or missing ops key." };
    return { ok: true };
  }
  const chainId = Number(req.body?.chainId ?? req.query.chainId ?? 97);
  // Never allow server-key harvest without ops key. Open only on testnet when no harvest signer is configured.
  const harvestKey = String(
    process.env.HARVEST_OPS_PRIVATE_KEY || process.env.LP_FEE_HARVEST_PRIVATE_KEY || process.env.DEPLOYER_PK || "",
  ).trim();
  if (harvestKey) {
    return { ok: false, status: 401, error: "Ops key required when harvest signer key is configured." };
  }
  if (chainId === 97) return { ok: true };
  return { ok: false, status: 401, error: "Ops key required for harvest on this chain." };
}

function resolveHarvestSignerKey(): string {
  return String(
    process.env.HARVEST_OPS_PRIVATE_KEY ||
      process.env.LP_FEE_HARVEST_PRIVATE_KEY ||
      process.env.DEPLOYER_PK ||
      "",
  ).trim();
}

export function registerLpFeesRoutes(app: express.Application) {
  // Dashboard / security API base points at the indexer for token/market ops.
  app.get(
    "/api/dashboard/lp-fees",
    wrap(async (req, res) => {
      const chainId = Number(req.query.chainId ?? 97);
      const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20)));
      const pairFilter = toAddr(req.query.pair || req.query.pool);
      const campaignFilter = toAddr(req.query.campaign);
      const creatorFilter = toAddr(req.query.creator);

      if (!Number.isFinite(chainId) || chainId <= 0) {
        res.status(400).json({ ok: false, error: "Invalid chainId" });
        return;
      }

      if (chainId === 102) {
        res.status(400).json({ ok: false, error: "Legacy Solana chain 102 is not a current LP fee authority." });
        return;
      }
      if (chainId === 101) {
        const authority = requireCurrentSolanaAuthority(req.query as Record<string, unknown>);
        if (!authority.ok) {
          res.status(authority.status).json({ ok: false, error: authority.error });
          return;
        }
        const payload = await listSolanaLpFees({
          pool,
          creator: String(creatorFilter || req.query.creator || "").trim() || null,
          campaign: String(campaignFilter || req.query.campaign || "").trim() || null,
          limit,
        });
        res.status(200).json({
          ...payload,
          chainId: 101,
          environment: authority.authority.environment,
          cluster: authority.authority.cluster,
        });
        return;
      }

      // Auth:
      // - chain 97: open read (testnet monitoring)
      // - any chain + ?creator=0x…: creator self-read (filtered below; no secrets)
      // - otherwise: ops key required on non-testnet
      const opsKey = String(process.env.DASHBOARD_OPS_KEY || process.env.OPS_READ_KEY || "").trim();
      const provided = String(req.headers["x-ops-key"] || req.query.opsKey || "").trim();
      const hasOps = Boolean(opsKey && provided && provided === opsKey);
      const isCreatorSelfRead = Boolean(creatorFilter);
      if (chainId !== 97 && !hasOps && !isCreatorSelfRead) {
        res.status(401).json({ ok: false, error: "Ops key required for non-testnet fee reads." });
        return;
      }

      const lockerAddress = resolveLockerAddress(chainId);
      if (!lockerAddress) {
        res.status(400).json({ ok: false, error: "LP locker address not configured for this chain." });
        return;
      }

      const rpcUrl = resolveRpcUrl(chainId);
      if (!rpcUrl) {
        res.status(503).json({ ok: false, error: `Missing RPC for chain ${chainId}` });
        return;
      }

      const provider = createStaticJsonRpcProvider(rpcUrl, chainId, { timeoutMs: 20_000 });
      try {
        const locker = new ethers.Contract(lockerAddress, LOCKER_ABI, provider);
        const [topazFactory, treasuryRouter] = await Promise.all([
          locker.topazFactory().catch(() => null),
          locker.treasuryRouter().catch(() => null),
        ]);

        let rows = await loadGraduatedRows(chainId, limit);
        if (campaignFilter) {
          rows = rows.filter((r: any) => String(r.campaign_address || "").toLowerCase() === campaignFilter);
        }
        if (pairFilter) {
          rows = rows.filter((r: any) => String(r.dex_pair_address || "").toLowerCase() === pairFilter);
        }
        if (creatorFilter) {
          rows = rows.filter((r: any) => String(r.creator_address || "").toLowerCase() === creatorFilter);
        }

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
            items.push({
              ...base,
              fees: {
                registered: false,
                note: "No dex_pair_address in campaign_market_state — enable graduation reconciler / Topaz pool indexer.",
              },
            });
            continue;
          }

          try {
            const fees = await readPoolFees({
              provider,
              lockerAddress,
              pairAddress: pair,
              creatorAddress: base.creatorAddress,
            });
            items.push({ ...base, fees });
          } catch (error: any) {
            items.push({
              ...base,
              fees: {
                registered: false,
                error: String(error?.message || error),
              },
            });
          }
        }

        res.json({
          ok: true,
          chainId,
          service: "realtime-indexer",
          lockerAddress: lockerAddress.toLowerCase(),
          topazFactory: topazFactory ? String(topazFactory).toLowerCase() : null,
          treasuryRouter: treasuryRouter ? String(treasuryRouter).toLowerCase() : null,
          split: { creatorBps: 8000, protocolBps: 2000 },
          notes: [
            "Served by Railway indexer (token/market authority), not the frontend API.",
            "Unharvested fees use eth_call claimFees() as the locker (Minimal Topaz claimable0/1 views often stay 0).",
            "harvest(pool) on PermanentLpLocker calls claimFees then splits 80% creator / 20% protocol.",
            "Harvested lifetime = cumulativeCreatorPaid / cumulativeProtocolRouted after successful harvests.",
            "Tiny testnet volume may show only ~1e-4 WBNB fee (1% of a small swap) until more DEX volume accrues.",
          ],
          items,
          updatedAt: new Date().toISOString(),
        });
      } finally {
        try {
          provider.destroy();
        } catch {
          // ignore
        }
      }
    }),
  );

  app.get(
    "/api/dashboard/lp-fees/status",
    wrap(async (req, res) => {
      const chainId = Number(req.query.chainId ?? 101);
      if (chainId === 102) {
        res.status(400).json({ ok: false, error: "Legacy Solana chain 102 is not a current LP fee authority." });
        return;
      }
      if (chainId === 101) {
        const authority = requireCurrentSolanaAuthority(req.query as Record<string, unknown>);
        if (!authority.ok) {
          res.status(authority.status).json({ ok: false, error: authority.error });
          return;
        }
        res.status(200).json({
          ...solanaHarvestStatus(),
          chainId: 101,
          environment: authority.authority.environment,
          cluster: authority.authority.cluster,
        });
        return;
      }
      res.status(200).json({
        ok: true,
        chainId,
        operatorConfigured: Boolean(resolveHarvestSignerKey()),
        note: "BNB harvest uses HARVEST_OPS_PRIVATE_KEY / DEPLOYER_PK plus DASHBOARD_OPS_KEY.",
      });
    }),
  );

  /**
   * Ops collect: server wallet claims locked LP fees.
   * Path is /collect because POST .../harvest is blocked by the Railway edge (502 fallback).
   * Creator still receives 80%; protocol 20%.
   */
  const collectHandler = wrap(async (req, res) => {
      const chainId = Number(req.body?.chainId ?? 97);
      // Solana collect is permissionless like BNB locker.harvest(): anyone may
      // trigger it. The operator key only signs the Meteora claim; 80% still
      // belongs to the campaign creator once the split ix is live.
      if (chainId === 102) {
        res.status(400).json({ ok: false, error: "Legacy Solana chain 102 is not a current LP fee authority." });
        return;
      }
      if (chainId === 101) {
        const authority = requireCurrentSolanaAuthority(req.body as Record<string, unknown>);
        if (!authority.ok) {
          res.status(authority.status).json({ ok: false, error: authority.error });
          return;
        }
        try {
          const result = await harvestSolanaLpFees({
            pool,
            campaign: String(req.body?.campaign || req.body?.campaignAddress || "").trim() || null,
            pair: String(req.body?.pair || req.body?.pool || req.body?.pairAddress || "").trim() || null,
          });
          res.status(200).json({
            ...result,
            chainId: 101,
            environment: authority.authority.environment,
            cluster: authority.authority.cluster,
          });
        } catch (error: any) {
          res.status(Number(error?.status || 500)).json({
            ok: false,
            error: String(error?.message || "Solana LP harvest failed"),
          });
        }
        return;
      }

      const auth = authorizeOpsWrite(req);
      if (!auth.ok) {
        res.status(auth.status).json({ ok: false, error: auth.error });
        return;
      }
      const pairAddress = toAddr(req.body?.pair || req.body?.pool || req.body?.pairAddress);
      if (!pairAddress) {
        res.status(400).json({ ok: false, error: "pair (Topaz pool) address is required." });
        return;
      }

      const lockerAddress = resolveLockerAddress(chainId);
      if (!lockerAddress) {
        res.status(400).json({ ok: false, error: "LP locker address not configured." });
        return;
      }

      const pk = resolveHarvestSignerKey();
      if (!pk) {
        res.status(503).json({
          ok: false,
          error:
            "Harvest signer not configured. Set HARVEST_OPS_PRIVATE_KEY (or DEPLOYER_PK) on the indexer service.",
        });
        return;
      }

      const rpcUrl = resolveRpcUrl(chainId);
      if (!rpcUrl) {
        res.status(503).json({ ok: false, error: `Missing RPC for chain ${chainId}` });
        return;
      }

      const provider = createStaticJsonRpcProvider(rpcUrl, chainId, { timeoutMs: 30_000 });
      try {
        const wallet = new ethers.Wallet(pk, provider);
        const locker = new ethers.Contract(
          lockerAddress,
          [
            "function harvest(address pool) returns (uint256 collected0, uint256 collected1)",
            "function poolInfo(address) view returns (address campaign,address creator,address creatorFeeRecipient,address pool,address token0,address token1,uint256 lockedLpAmount,uint16 creatorFeeBps,uint16 protocolFeeBps,bool registered)",
          ],
          wallet,
        );

        const info = await locker.poolInfo(pairAddress);
        const registered = Boolean(info?.registered ?? info?.[9]);
        if (!registered) {
          res.status(400).json({
            ok: false,
            error: "Pool is not registered on PermanentLpLocker; cannot harvest.",
          });
          return;
        }

        const tx = await locker.harvest(pairAddress);
        const receipt = await tx.wait();
        res.json({
          ok: true,
          chainId,
          pairAddress,
          lockerAddress: lockerAddress.toLowerCase(),
          harvester: wallet.address.toLowerCase(),
          creator: String(info.creator || info[1] || "").toLowerCase(),
          creatorFeeRecipient: String(info.creatorFeeRecipient || info[2] || "").toLowerCase(),
          txHash: String(receipt?.hash || tx.hash),
          note: "Creator 80% is transferred to creatorFeeRecipient on success; protocol 20% routes via TreasuryRouter.",
        });
      } catch (error: any) {
        res.status(500).json({
          ok: false,
          error: String(error?.shortMessage || error?.reason || error?.message || error),
        });
      } finally {
        try {
          provider.destroy();
        } catch {
          // ignore
        }
      }
    });

  app.post("/api/dashboard/lp-fees/collect", collectHandler);
  // Alias kept for older clients. Railway currently 502s POST .../harvest at the edge.
  app.post("/api/dashboard/lp-fees/harvest", collectHandler);
}