import { Contract, formatEther } from "ethers";

import { apiFetch } from "@/lib/apiBase";
import type { JsonRpcSigner } from "ethers";
import { signWalletAction } from "@/lib/walletActionAuth";

const BOOST_BATTLE_ABI = [
  "function boostBattle(bytes32 poolId,address sideToken,uint256 boostUnits,uint256 unitPriceNativeRaw,uint256 pricingVersion,uint256 oracleTimestamp,uint256 nonce,uint256 deadline,bytes signature) payable",
] as const;

export type BattleBoostQuote = {
  domain: { verifyingContract: string; chainId: number };
  value: {
    poolId: string; booster: string; sideToken: string; boostUnits: string; unitPriceNativeRaw: string;
    grossNativeRaw: string; pricingVersion: string; oracleTimestamp: string; nonce: string; deadline: string;
  };
  signature: string;
};

export type BattleBoostSummary = {
  left?: { boostUnits?: string; grossNativeRaw?: string; poolNativeRaw?: string; protocolNativeRaw?: string };
  right?: { boostUnits?: string; grossNativeRaw?: string; poolNativeRaw?: string; protocolNativeRaw?: string };
  total?: { boostUnits?: string; grossNativeRaw?: string; poolNativeRaw?: string; protocolNativeRaw?: string };
};

export type BattlePointsV3BoostState = {
  battleId: string;
  tokenId: string;
  side: "left" | "right";
  scoringVersion: "battle_points_v3" | string;
  weights: { mcap: number; holders: number; volume: number; boost: number };
  boostCurveVersion: string;
  /** Agent 2 normalized name. Agent 3 currently serializes this confirmed aggregate as boostUnits. */
  confirmedBoostUnits: string;
  boostUnits: string;
  boostPoints: number | null;
  mcapPoints: number | null;
  holderPoints: number | null;
  volumePoints: number | null;
  totalPoints: number | null;
  metricsUpdatedAt?: string | null;
};

export type BattleBoostState = {
  ok: boolean;
  battleId: string;
  chainId: number;
  summary: BattleBoostSummary;
  battlePointsV3?: BattlePointsV3BoostState[];
  /** Backend-owned authoritative-total status. */
  scoringActive?: boolean;
  scoringReason?: string | null;
  updatedAt?: string;
};

function parseQuote(value: unknown): BattleBoostQuote {
  const quote = value as BattleBoostQuote | null;
  if (!quote?.domain?.verifyingContract || !quote?.value?.poolId || !quote?.value?.booster || !quote?.value?.sideToken || !quote?.signature) throw new Error("Battle Boost quote is incomplete.");
  for (const key of ["boostUnits", "unitPriceNativeRaw", "grossNativeRaw", "pricingVersion", "oracleTimestamp", "nonce", "deadline"] as const) {
    try { BigInt(String(quote.value[key])); } catch { throw new Error(`Battle Boost quote field ${key} is invalid.`); }
  }
  return quote;
}

function normalizeV3Rows(rows: unknown): BattlePointsV3BoostState[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter(Boolean).map((row: any) => ({
    ...row,
    boostUnits: String(row.boostUnits ?? row.confirmedBoostUnits ?? "0"),
    confirmedBoostUnits: String(row.confirmedBoostUnits ?? row.boostUnits ?? "0"),
    boostCurveVersion: String(row.boostCurveVersion || ""),
    boostPoints: row.boostPoints == null ? null : Number(row.boostPoints),
    totalPoints: row.totalPoints == null ? null : Number(row.totalPoints),
  })) as BattlePointsV3BoostState[];
}

export async function fetchBattleBoostState(battleId: string, signal?: AbortSignal): Promise<BattleBoostState> {
  const res = await apiFetch(`/api/arena/boosts/${encodeURIComponent(battleId)}`, { cache: "no-store", signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) throw new Error(String(json?.error || `Battle Boost state failed (${res.status})`));
  return { ...json, battlePointsV3: normalizeV3Rows(json.battlePointsV3) } as BattleBoostState;
}

export async function createBattleBoostQuote(input: {
  battleId: string; chainId: number; wallet: string; targetToken: string; boostUnits: number; signer: JsonRpcSigner;
}) {
  const auth = await signWalletAction({
    action: "arena_battle_boost_quote", walletAddress: input.wallet, chainId: input.chainId, signer: input.signer,
    extraLines: [`Battle: ${input.battleId}`, `Target: ${input.targetToken}`, `Boost Units: ${input.boostUnits}`],
  });
  const res = await apiFetch("/api/arena/boosts/quote", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ battleId: input.battleId, chainId: input.chainId, wallet: input.wallet, targetToken: input.targetToken, boostUnits: input.boostUnits, auth }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) throw new Error(String(json?.error || `Battle Boost quote failed (${res.status})`));
  return { ...json, quote: parseQuote(json.quote) };
}

export async function submitBattleBoost(input: { signer: JsonRpcSigner; quote: BattleBoostQuote }) {
  const quote = parseQuote(input.quote);
  const signerChain = Number((await input.signer.provider.getNetwork()).chainId);
  if (signerChain !== Number(quote.domain.chainId)) throw new Error("Wallet chain does not match Battle Boost quote.");
  const signerAddress = String(await input.signer.getAddress()).toLowerCase();
  if (signerAddress !== String(quote.value.booster || "").toLowerCase()) throw new Error("Battle Boost quote belongs to another wallet.");
  const contract = new Contract(quote.domain.verifyingContract, BOOST_BATTLE_ABI, input.signer);
  const tx = await contract.boostBattle(
    quote.value.poolId, quote.value.sideToken, BigInt(quote.value.boostUnits), BigInt(quote.value.unitPriceNativeRaw),
    BigInt(quote.value.pricingVersion), BigInt(quote.value.oracleTimestamp), BigInt(quote.value.nonce), BigInt(quote.value.deadline), quote.signature,
    { value: BigInt(quote.value.grossNativeRaw) },
  );
  const receipt = await tx.wait();
  if (receipt && Number(receipt.status) !== 1) throw new Error("Battle Boost transaction did not succeed.");
  return { txHash: String(tx.hash || receipt?.hash || ""), receipt };
}

export function formatBoostNative(raw?: string | null, nativeSymbol = "BNB") {
  if (!raw) return `0 ${nativeSymbol}`;
  try { return `${Number(formatEther(BigInt(raw))).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${nativeSymbol}`; }
  catch { return `0 ${nativeSymbol}`; }
}
