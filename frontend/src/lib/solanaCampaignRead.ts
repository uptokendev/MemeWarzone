/**
 * Read V4 Campaign account fields for TokenDetails quotes/metrics.
 * Layout mirrors programs/memewarzone_solana Campaign (Anchor account).
 * Does not touch BNB paths.
 */
import { apiFetch } from "@/lib/apiBase";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

export type SolanaCurvePricingState = {
  economicsVersion: number;
  tokenDecimals: number;
  basePriceLamports: bigint;
  priceSlopeLamports: bigint;
};

export function solanaMarginalSpotLamports(
  curve: SolanaCurvePricingState,
  soldTokensRaw: bigint,
): bigint {
  const decimals = Math.max(0, Number(curve.tokenDecimals || 0));
  const tokenScale = 10n ** BigInt(decimals);
  const slopeDenominator =
    Number(curve.economicsVersion || 0) >= 3
      ? tokenScale * 1_000_000_000n
      : tokenScale;

  if (slopeDenominator <= 0n) return curve.basePriceLamports;

  return (
    curve.basePriceLamports +
    (curve.priceSlopeLamports * soldTokensRaw) / slopeDenominator
  );
}

export function solanaMarginalSpotSol(
  curve: SolanaCurvePricingState,
  soldTokensRaw: bigint,
): number {
  const decimals = Math.max(0, Number(curve.tokenDecimals || 0));
  const tokenScale = 10 ** decimals;

  const soldWhole = Number(soldTokensRaw) / tokenScale;
  const baseLamports = Number(curve.basePriceLamports);
  const slopeRaw = Number(curve.priceSlopeLamports);

  if (
    !Number.isFinite(soldWhole) ||
    !Number.isFinite(baseLamports) ||
    !Number.isFinite(slopeRaw)
  ) {
    return 0;
  }

  // V3 slope is expressed per 1e9 whole tokens.
  // Keep this calculation in Number space because fractional lamports are
  // economically meaningful here. BigInt division would floor e.g.
  // 0.886 lamports to 0 and materially understate market cap.
  const slopeLamports =
    Number(curve.economicsVersion || 0) >= 3
      ? (slopeRaw * soldWhole) / 1_000_000_000
      : slopeRaw * soldWhole;

  const spotSol =
    (baseLamports + slopeLamports) / 1_000_000_000;

  return Number.isFinite(spotSol) && spotSol > 0
    ? spotSol
    : 0;
}

export type SolanaCampaignCurveState = {
  campaignAddress: string;
  creator: string;
  mint: string;
  tokenVault: string;
  solVault: string;
  campaignIdHex: string;
  launchAt: number;
  graduationTargetUsdMicros: bigint;
  economicsVersion: number;
  curveKind: number;
  tokenTotalSupply: bigint;
  curveTokenSupply: bigint;
  /** Tokens reserved for the graduation liquidity pool. */
  liquidityTokenSupply: bigint;
  /** Additional protocol/creator reserve allocation. */
  reserveTokenSupply: bigint;
  tokenDecimals: number;
  basePriceLamports: bigint;
  priceSlopeLamports: bigint;
  buyFeeBps: number;
  sellFeeBps: number;
  creatorBuyLockUntil: number;
  createdAt: number;
  soldTokens: bigint;
  netRaisedLamports: bigint;
  totalBuyVolumeLamports: bigint;
  totalSellVolumeLamports: bigint;
  buyerCount: bigint;
  graduated: boolean;
  curveClosed: boolean;
  paused: boolean;
};

function readU64LE(view: DataView, offset: number): bigint {
  const lo = BigInt(view.getUint32(offset, true));
  const hi = BigInt(view.getUint32(offset + 4, true));
  return lo + (hi << 32n);
}

function readI64LE(view: DataView, offset: number): number {
  const n = readU64LE(view, offset);
  // timestamps fit in safe int range
  if (n > 0x7fffffffffffffffn) {
    return Number(n - 0x10000000000000000n);
  }
  return Number(n);
}

function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  // big-endian base conversion
  const digits: number[] = [0];
  for (let i = leading; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % 58;
      carry = Math.floor(x / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(leading);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out || "1";
}

/**
 * Decode full curve-relevant Campaign fields.
 * offset 0: 8-byte Anchor discriminator.
 */
export function decodeSolanaCampaignAccount(
  data: Uint8Array,
  campaignAddress: string,
): SolanaCampaignCurveState {
  if (data.length < 8 + 400) {
    throw new Error(`Campaign account too short (${data.length})`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8; // skip discriminator

  const takePk = () => {
    const slice = data.subarray(o, o + 32);
    o += 32;
    return encodeBase58(slice);
  };
  const take32 = () => {
    const slice = data.subarray(o, o + 32);
    o += 32;
    return slice;
  };
  const takeU64 = () => {
    const v = readU64LE(view, o);
    o += 8;
    return v;
  };
  const takeI64 = () => {
    const v = readI64LE(view, o);
    o += 8;
    return v;
  };
  const takeU16 = () => {
    const v = view.getUint16(o, true);
    o += 2;
    return v;
  };
  const takeU8 = () => {
    const v = view.getUint8(o);
    o += 1;
    return v;
  };

  const campaignId = take32();
  take32(); // generation_id
  takePk(); // generation_config
  take32(); // generation_manifest_hash
  const creator = takePk();
  const mint = takePk();
  const tokenVault = takePk();
  const solVault = takePk();
  take32(); // metadata_hash
  take32(); // cluster_hash
  take32(); // ticker_hash
  take32(); // reservation_id_hash
  takeU64(); // reservation_version
  const launchAt = takeI64();
  const graduationTargetUsdMicros = takeU64();
  takeU8(); // cluster_kind
  const economicsVersion = takeU16();
  const curveKind = takeU8();
  const tokenTotalSupply = takeU64();
  const curveTokenSupply = takeU64();
  const liquidityTokenSupply = takeU64();
  const reserveTokenSupply = takeU64();
  const tokenDecimals = takeU8();
  takeU16(); // curve_supply_bps
  takeU16(); // liquidity_token_bps
  const basePriceLamports = takeU64();
  const priceSlopeLamports = takeU64();
  const buyFeeBps = takeU16();
  const sellFeeBps = takeU16();
  takeU16(); // finalize_fee_bps
  takeU16(); // creator_post_finalize_bps
  takeU16(); // liquidity_post_finalize_bps
  takeU8(); // dex_adapter
  take32(); // trade_route_profile
  take32(); // finalize_route_profile
  take32(); // treasury_profile
  take32(); // dex_profile
  take32(); // oracle_profile
  const creatorBuyLockUntil = takeI64();
  takeU16(); // creator_buy_cap_bps
  const createdAt = takeI64();
  const soldTokens = takeU64();
  const netRaisedLamports = takeU64();
  const totalBuyVolumeLamports = takeU64();
  const totalSellVolumeLamports = takeU64();
  const buyerCount = takeU64();
  takeU64(); // creator_bought_tokens
  takeU16(); // asset_initialization_version
  takeU8(); // mint_authority_revoked
  const graduated = takeU8() !== 0;
  // New layout is 720 bytes with curve_closed at 714 and paused at 715.
  // Old 718-byte accounts store bump at 714 — do not treat that as closed.
  const curveClosed = data.length >= 719 ? takeU8() !== 0 : false;
  const paused = data.length >= 720 ? takeU8() !== 0 : false;

  const campaignIdHex = Array.from(campaignId)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    campaignAddress,
    creator,
    mint,
    tokenVault,
    solVault,
    campaignIdHex,
    launchAt,
    graduationTargetUsdMicros,
    economicsVersion,
    curveKind,
    tokenTotalSupply,
    curveTokenSupply,
    liquidityTokenSupply,
    reserveTokenSupply,
    tokenDecimals,
    basePriceLamports,
    priceSlopeLamports,
    buyFeeBps,
    sellFeeBps,
    creatorBuyLockUntil,
    createdAt,
    soldTokens,
    netRaisedLamports,
    totalBuyVolumeLamports,
    totalSellVolumeLamports,
    buyerCount,
    graduated,
    curveClosed,
    paused,
  };
}

function rpcUrl(): string {
  return (
    String(import.meta.env.VITE_SOLANA_RPC || "").trim() ||
    getPublicRpcUrl(SOLANA_CHAIN_ID) ||
    "https://solana-rpc.publicnode.com"
  );
}

function decodeAccountBytes(raw: Uint8Array, addr: string): SolanaCampaignCurveState | null {
  if (raw.length < 200) return null;
  return decodeSolanaCampaignAccount(raw, addr);
}

export async function fetchSolanaCampaignCurveState(
  campaignAddress: string,
): Promise<SolanaCampaignCurveState | null> {
  const addr = String(campaignAddress || "").trim();
  if (!addr) return null;
  try {
    const res = await apiFetch(`/api/solana/campaign-account?address=${encodeURIComponent(addr)}`, {
      cache: "no-store",
    });
    const json = await res.json().catch(() => null);
    if (json?.found && json?.dataBase64) {
      const bin = Uint8Array.from(atob(String(json.dataBase64)), (c) => c.charCodeAt(0));
      const decoded = decodeAccountBytes(bin, addr);
      if (decoded) return decoded;
    }
  } catch (e) {
    console.warn("[solanaCampaignRead] API read failed", addr, e);
  }
  try {
    const web3 = await loadSolanaWeb3();
    const connection = new web3.Connection(rpcUrl(), {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    });
    const info = await connection.getAccountInfo(new web3.PublicKey(addr), "confirmed");
    if (!info?.data) return null;
    const data = info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data);
    return decodeAccountBytes(data, addr);
  } catch (e) {
    console.warn("[solanaCampaignRead] fetch failed", addr, e);
    return null;
  }
}

/** Prefer campaign PDA; if mint is passed, caller should resolve via trade-auth vaultResolution. */
export async function resolveSolanaCampaignCurve(
  campaignOrMint: string,
  preferredCampaign?: string | null,
): Promise<SolanaCampaignCurveState | null> {
  const preferred = String(preferredCampaign || "").trim();
  if (preferred) {
    const s = await fetchSolanaCampaignCurveState(preferred);
    if (s) return s;
  }
  return fetchSolanaCampaignCurveState(campaignOrMint);
}
