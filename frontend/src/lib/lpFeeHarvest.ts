import { Contract, type Signer } from "ethers";
import PermanentLpLockerArtifact from "@/abi/PermanentLpLocker.json";
import { getBnbContractAddresses } from "@/lib/bnbContracts";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  type SupportedChainId,
  isEvmChainId,
} from "@/lib/chainConfig";

const BNB_LOCKER_ABI = PermanentLpLockerArtifact.abi as any;
const V3_LOCKER_ABI = [
  "function harvest(address pool) returns (uint256 collected0,uint256 collected1)",
  "function poolInfo(address pool) view returns (address campaign,address creator,address creatorFeeRecipient,address poolAddress,address token0,address token1,uint256 tokenId,uint128 lockedLiquidity,uint24 feeTier,uint16 creatorFeeBps,uint16 protocolFeeBps,bool registered)",
] as const;

function isRobinhoodChainId(chainId: number): boolean {
  return chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
}

export type LpFeePoolRow = {
  chainId: number;
  campaignAddress: string;
  tokenAddress?: string | null;
  creatorAddress?: string | null;
  name?: string | null;
  symbol?: string | null;
  pairAddress?: string | null;
  marketStage?: string | null;
  fees?: {
    registered?: boolean;
    kind?: "topaz_v2" | "robinhood_v3" | string;
    tokenId?: string | null;
    lockedLiquidity?: string;
    pairLabel?: string;
    token0Meta?: { symbol?: string };
    token1Meta?: { symbol?: string };
    unharvested?: {
      token0?: number;
      token1?: number;
      token0Display?: string;
      token1Display?: string;
      token0Symbol?: string;
      token1Symbol?: string;
      creatorShareToken0Display?: string;
      creatorShareToken1Display?: string;
      protocolShareToken0Display?: string;
      protocolShareToken1Display?: string;
    };
  } | null;
};

function normalizeApiBase(raw: string): string {
  let base = String(raw || "").trim().replace(/^['"]|['"]$/g, "").trim();
  if (!base) return "";
  if (base.startsWith("//")) base = `https:${base}`;
  if (!/^https?:\/\//i.test(base)) base = `https://${base.replace(/^\/+/, "")}`;
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}`;
  } catch {
    return base.replace(/\/+$/, "").replace(/\/api$/i, "");
  }
}

/** Indexer base for market/fee APIs. */
export function getTokenIndexerBase(): string {
  return normalizeApiBase(
    String(
      import.meta.env.VITE_TOKEN_API_BASE ||
        import.meta.env.VITE_REALTIME_API_BASE ||
        import.meta.env.VITE_SECURITY_API_BASE ||
        import.meta.env.VITE_RAILWAY_TOKEN_API_BASE ||
        "",
    ),
  );
}

export function resolvePermanentLpLockerAddress(chainId: number): string {
  if (!isEvmChainId(chainId)) return "";
  const fromEnv = getBnbContractAddresses(chainId as SupportedChainId).permanentLpLocker;
  if (fromEnv) return fromEnv;
  // Clean-slate BSC testnet locker. Never apply this fallback to Robinhood.
  if (Number(chainId) === 97) return "0xb083929D2bbabdE7fc580090D5B18bbD918Fda9a";
  return "";
}

export async function fetchLpFeePools(input: {
  chainId: number;
  creatorAddress?: string | null;
  campaignAddress?: string | null;
  limit?: number;
}): Promise<{ lockerAddress: string | null; items: LpFeePoolRow[] }> {
  const chainId = Number(input.chainId || 97);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return { lockerAddress: null, items: [] };
  }
  const creator = String(input.creatorAddress || "").trim();
  const solana = chainId === 101 || chainId === 102;
  if (!solana && creator && !/^0x[a-fA-F0-9]{40}$/.test(creator)) {
    return { lockerAddress: null, items: [] };
  }

  const base = getTokenIndexerBase();
  if (!base) throw new Error("Token indexer URL is not configured (VITE_TOKEN_API_BASE / VITE_REALTIME_API_BASE).");

  const qs = new URLSearchParams({
    chainId: String(chainId),
    limit: String(input.limit ?? 50),
  });
  if (input.campaignAddress) {
    qs.set("campaign", solana ? String(input.campaignAddress) : String(input.campaignAddress).toLowerCase());
  }
  if (creator) qs.set("creator", solana ? creator : creator.toLowerCase());

  const res = await fetch(`${base}/api/dashboard/lp-fees?${qs.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(String(json?.error || `LP fee fetch failed (${res.status})`));

  let items = Array.isArray(json?.items) ? (json.items as LpFeePoolRow[]) : [];
  if (creator) {
    items = items.filter((it) =>
      solana
        ? String(it.creatorAddress || "") === creator
        : String(it.creatorAddress || "").toLowerCase() === creator.toLowerCase(),
    );
  }
  return {
    lockerAddress: json?.lockerAddress ? String(json.lockerAddress).toLowerCase() : null,
    items,
  };
}

export function hasUnharvestedFees(row: LpFeePoolRow): boolean {
  const u = row.fees?.unharvested;
  if (!u) return false;
  return Number(u.token0 || 0) > 0 || Number(u.token1 || 0) > 0;
}

export async function harvestSolanaLpFees(input: {
  chainId: number;
  campaignAddress?: string | null;
  pairAddress?: string | null;
}): Promise<{ txHash: string; pairAddress: string; note?: string }> {
  const chainId = Number(input.chainId || 101);
  const base = getTokenIndexerBase();
  if (!base) throw new Error("Token indexer URL is not configured.");
  const res = await fetch(`${base}/api/dashboard/lp-fees/collect`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      chainId,
      campaign: input.campaignAddress || null,
      campaignAddress: input.campaignAddress || null,
      pair: input.pairAddress || null,
      pairAddress: input.pairAddress || null,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(String(json?.error || `Solana LP harvest failed (${res.status})`));
  return {
    txHash: String(json?.txHash || json?.claimTx || ""),
    pairAddress: String(json?.pairAddress || input.pairAddress || ""),
    note: json?.note ? String(json.note) : undefined,
  };
}

/**
 * Creator/user EVM harvest path. Anyone may call harvest; only the registered
 * creator recipient receives the creator share. BNB uses PermanentLpLocker,
 * Robinhood uses PermanentV3PositionLocker, both with the same harvest(pool) seam.
 */
export async function harvestLpFeesWithWallet(input: {
  chainId: number;
  pairAddress: string;
  signer: Signer;
  lockerAddress?: string | null;
}): Promise<{ txHash: string; lockerAddress: string; pairAddress: string }> {
  const chainId = Number(input.chainId);
  if (!isEvmChainId(chainId)) throw new Error("EVM LP fee harvest requires an EVM chain.");

  const pool = String(input.pairAddress || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(pool)) {
    throw new Error(isRobinhoodChainId(chainId) ? "Invalid Robinhood V3 pool address." : "Invalid Topaz pair address.");
  }

  const lockerAddress = String(input.lockerAddress || "").trim() || resolvePermanentLpLockerAddress(chainId);
  if (!/^0x[a-fA-F0-9]{40}$/.test(lockerAddress)) {
    throw new Error(isRobinhoodChainId(chainId)
      ? "Permanent V3 position locker address is not configured for Robinhood."
      : "Permanent LP locker address is not configured for this chain.");
  }

  const network = await input.signer.provider?.getNetwork();
  if (!network || Number(network.chainId) !== chainId) {
    throw new Error(`Wrong wallet network. Connect chain ${chainId} before harvesting fees.`);
  }

  const abi = isRobinhoodChainId(chainId) ? V3_LOCKER_ABI : BNB_LOCKER_ABI;
  const locker = new Contract(lockerAddress, abi, input.signer) as any;

  // Robinhood gets an extra registration/principal read before allowing the tx.
  if (isRobinhoodChainId(chainId)) {
    const info = await locker.poolInfo(pool);
    const registered = Boolean(info?.registered ?? info?.[11]);
    const lockedLiquidity = BigInt(info?.lockedLiquidity ?? info?.[7] ?? 0);
    if (!registered || lockedLiquidity <= 0n) {
      throw new Error("Robinhood V3 position is not registered with locked liquidity.");
    }
  }

  const tx = await locker.harvest(pool);
  const receipt = await tx.wait();
  return {
    txHash: String(receipt?.hash || tx.hash),
    lockerAddress: lockerAddress.toLowerCase(),
    pairAddress: pool,
  };
}
