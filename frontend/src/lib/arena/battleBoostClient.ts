import { Contract, formatEther } from "ethers";

import { apiFetch } from "@/lib/apiBase";
import type { JsonRpcSigner } from "ethers";
import {
  recoverSolanaArenaPayment,
  sendSolanaArenaInstruction,
  type SolanaArenaInstructionEnvelope,
  type SolanaArenaPendingPayment,
  type SolanaArenaPaymentRecovery,
} from "@/lib/arena/solanaArenaBrowserTransaction";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

const BOOST_BATTLE_ABI = [
  "function boostBattle(bytes32 poolId,address sideToken,uint256 boostUnits,uint256 unitPriceNativeRaw,uint256 pricingVersion,uint256 oracleTimestamp,uint256 nonce,uint256 deadline,bytes signature) payable",
] as const;
const APPROVED_V3_CURVE = "boost_hyperbolic_100_v1";

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
  scoringActive?: boolean;
  scoringReason?: string | null;
  updatedAt?: string;
};

export type SolanaBattleBoostQuote = {
  ok: true;
  quoteId: string;
  product: "normal_battle";
  chainId: number;
  battleId: string;
  side: "left" | "right";
  targetToken: string;
  boostUnits: string;
  pointsPerBoost: 1;
  usdPerBoostMicros: "1000000" | string;
  grossLamports: string;
  prizeLamports: string;
  protocolLamports: string;
  split: { prizeBps: number; protocolBps: number; leagueBps: number };
  competitionId: string;
  fundingId: string;
  transaction: SolanaArenaInstructionEnvelope;
  expiresAt: string;
  newPaymentAllowed: false;
  battlePointsV3?: { scoringVersion?: string | null; boostCurveVersion?: string | null; scoringActive?: boolean; boostPoints?: number | null };
};

export type SolanaBattleBoostPayment = {
  ok: true;
  confirmed: boolean;
  idempotent: boolean;
  signature: string;
  receiptPda?: string | null;
  pointsPerBoost?: number;
  summary?: BattleBoostSummary;
};

export type SolanaBattleBoostRecoveryState = {
  exists: boolean;
  unresolved: boolean;
  status: "none" | "pending" | "submitted" | "confirming" | "recovering" | "verifying" | "confirmed" | "expired" | "failed" | string;
  newPaymentAllowed: boolean;
  confirmed: boolean;
  retryable: boolean;
  quoteId?: string;
  paymentId?: string;
  signature?: string | null;
  receiptPda?: string | null;
  submittedAt?: string | null;
  expiresAt?: string | null;
  reason?: string | null;
  operation?: { product: string; tournamentId: string | null; battleId: string; matchId: string | null; roundNumber: number; wallet: string; targetToken: string; side: string; boostUnits: string; pointsPerBoost: number; chainId: number };
  recovery?: Omit<SolanaArenaPendingPayment, "programId"> & { programId?: string | null } | null;
};

function parseQuote(value: unknown): BattleBoostQuote {
  const quote = value as BattleBoostQuote | null;
  if (!quote?.domain?.verifyingContract || !quote?.value?.poolId || !quote?.value?.booster || !quote?.value?.sideToken || !quote?.signature) throw new Error("Battle Boost quote is incomplete.");
  for (const key of ["boostUnits", "unitPriceNativeRaw", "grossNativeRaw", "pricingVersion", "oracleTimestamp", "nonce", "deadline"] as const) {
    try { BigInt(String(quote.value[key])); } catch { throw new Error(`Battle Boost quote field ${key} is invalid.`); }
  }
  return quote;
}

function parseSolanaQuote(value: unknown): SolanaBattleBoostQuote {
  const quote = value as SolanaBattleBoostQuote | null;
  if (!quote?.quoteId || quote.product !== "normal_battle" || !quote.transaction?.programId || !quote.transaction.dataBase64 || !Array.isArray(quote.transaction.accounts)) throw new Error("Solana Battle Boost quote is incomplete.");
  if (Number(quote.pointsPerBoost) !== 1 || String(quote.usdPerBoostMicros) !== "1000000") throw new Error("Solana Battle Boost quote has unexpected unit economics.");
  if (Number(quote.split?.prizeBps) !== 9000 || Number(quote.split?.protocolBps) !== 1000 || Number(quote.split?.leagueBps) !== 0) throw new Error("Solana Battle Boost quote has unexpected split economics.");
  if (quote.battlePointsV3?.scoringActive !== true || String(quote.battlePointsV3?.boostCurveVersion || "") !== APPROVED_V3_CURVE) throw new Error("Solana Battle Boost quote is not authorized by the active V3 scoring lock.");
  for (const field of ["boostUnits", "grossLamports", "prizeLamports", "protocolLamports"] as const) {
    try { BigInt(String(quote[field])); } catch { throw new Error(`Solana Battle Boost ${field} is invalid.`); }
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

async function readJson<T>(response: Response, label: string): Promise<T> {
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.ok === false) {
    const error = new Error(String(json?.error || `${label} failed (${response.status})`));
    (error as Error & { code?: string; payment?: unknown }).code = json?.code;
    (error as Error & { code?: string; payment?: unknown }).payment = json?.payment;
    throw error;
  }
  return json as T;
}

function solanaRoute(battleId: string, suffix: string) {
  return `/api/arena/boosts/${encodeURIComponent(battleId)}/${suffix}`;
}

export async function fetchBattleBoostState(battleId: string, signal?: AbortSignal): Promise<BattleBoostState> {
  const res = await apiFetch(`/api/arena/boosts/${encodeURIComponent(battleId)}`, { cache: "no-store", signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) throw new Error(String(json?.error || `Battle Boost state failed (${res.status})`));
  return { ...json, battlePointsV3: normalizeV3Rows(json.battlePointsV3) } as BattleBoostState;
}

export async function fetchSolanaBattleBoostPaymentState(input: { battleId: string; wallet: string; targetToken: string; signal?: AbortSignal }): Promise<SolanaBattleBoostRecoveryState> {
  const qs = new URLSearchParams({ wallet: input.wallet, targetToken: input.targetToken });
  const json = await readJson<{ ok: true; payment: SolanaBattleBoostRecoveryState }>(await apiFetch(`${solanaRoute(input.battleId, "solana-state")}?${qs}`, { cache: "no-store", signal: input.signal }), "Solana Battle Boost state");
  return json.payment;
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

export async function createSolanaBattleBoostQuote(input: { battleId: string; chainId: number; wallet: string; targetToken: string; boostUnits: number }): Promise<SolanaBattleBoostQuote> {
  const auth = await signWalletAction({
    action: "arena_battle_boost_quote", walletAddress: input.wallet, chainId: input.chainId, walletType: "solana",
    signMessage: async (message) => (await signSolanaMessage(message, input.wallet)).signature,
    extraLines: [`Battle: ${input.battleId}`, `Target: ${input.targetToken}`, `Boost Units: ${input.boostUnits}`],
  });
  return parseSolanaQuote(await readJson<unknown>(await apiFetch(solanaRoute(input.battleId, "solana-quote"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: input.wallet, targetToken: input.targetToken, boostUnits: input.boostUnits, auth }),
  }), "Solana Battle Boost quote"));
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

async function paymentAuth(wallet: string, chainId: number, action: string, extraLines: string[]) {
  return signWalletAction({ action, walletAddress: wallet, chainId, walletType: "solana", signMessage: async (message) => (await signSolanaMessage(message, wallet)).signature, extraLines });
}

function battleRecovery(input: { battleId: string; chainId: number; wallet: string; targetToken: string; quoteId?: string; fundingId?: string; programId?: string }): SolanaArenaPaymentRecovery<SolanaBattleBoostPayment> {
  const key = `normal-battle-boost:${input.chainId}:${input.wallet}:${input.battleId}:${input.targetToken}`;
  return {
    key,
    metadata: { quoteId: input.quoteId || "", battleId: input.battleId, targetToken: input.targetToken },
    lookup: async () => {
      const state = await fetchSolanaBattleBoostPaymentState({ battleId: input.battleId, wallet: input.wallet, targetToken: input.targetToken });
      if (input.quoteId && state.quoteId === input.quoteId && state.status === "pending" && !state.signature) return { pending: null, newPaymentAllowed: true };
      const pending = state.unresolved && state.recovery ? { ...state.recovery, programId: state.recovery.programId || input.programId || "" } as SolanaArenaPendingPayment : null;
      return { pending, newPaymentAllowed: state.newPaymentAllowed };
    },
    register: async (pending) => {
      if (!input.quoteId || !input.fundingId) throw new Error("Solana Battle Boost submission is missing its authoritative quote identity.");
      const auth = await paymentAuth(input.wallet, input.chainId, "arena_battle_boost_submission", [`Quote: ${input.quoteId}`, `Funding: ${input.fundingId}`]);
      await readJson(await apiFetch(solanaRoute(input.battleId, "solana-submission"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId: input.quoteId, signature: pending.signature, blockhash: pending.blockhash, lastValidBlockHeight: pending.lastValidBlockHeight, auth }),
      }), "Solana Battle Boost submission");
    },
    reconcile: async (pending) => {
      const quoteId = String(pending.metadata.quoteId || input.quoteId || "").trim();
      if (!quoteId) throw new Error("Durable Battle Boost recovery is missing its authoritative quote.");
      const auth = await paymentAuth(input.wallet, input.chainId, "arena_battle_boost_payment", [`Quote: ${quoteId}`, `Signature: ${pending.signature}`]);
      const response = await apiFetch(solanaRoute(input.battleId, "solana-payment"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId, signature: pending.signature, auth }),
      });
      const json = await response.json().catch(() => ({}));
      if (response.status === 409 && json?.code === "SOLANA_BOOST_PAYMENT_UNVERIFIED") return null;
      if (!response.ok || json?.ok === false) throw new Error(String(json?.error || `Solana Battle Boost reconciliation failed (${response.status})`));
      const result = json as SolanaBattleBoostPayment;
      if (result.confirmed !== true) throw new Error("Solana Battle Boost receipt is not confirmed by backend authority.");
      if (result.signature && String(result.signature) !== pending.signature) throw new Error("Solana Battle Boost receipt signature does not match the preserved payment.");
      return result;
    },
    expire: async (pending) => {
      await readJson(await apiFetch(solanaRoute(input.battleId, "solana-expire"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: pending.metadata.quoteId, signature: pending.signature }),
      }), "Solana Battle Boost expiry");
    },
  };
}

export async function recoverSolanaBattleBoost(input: { battleId: string; chainId: number; wallet: string; targetToken: string }): Promise<SolanaBattleBoostPayment | null> {
  const state = await fetchSolanaBattleBoostPaymentState({ battleId: input.battleId, wallet: input.wallet, targetToken: input.targetToken });
  if (!state.unresolved || !state.recovery) return null;
  const recovery = battleRecovery({ battleId: input.battleId, chainId: input.chainId, wallet: input.wallet, targetToken: input.targetToken, quoteId: state.quoteId, programId: state.recovery.programId || undefined });
  const result = await recoverSolanaArenaPayment({ chainId: input.chainId, wallet: input.wallet, label: "Battle Boost recovery", recovery });
  return result?.settlement || null;
}

export async function submitSolanaBattleBoost(input: { battleId: string; wallet: string; quote: SolanaBattleBoostQuote }): Promise<SolanaBattleBoostPayment> {
  const quote = parseSolanaQuote(input.quote);
  if (String(quote.battleId) !== String(input.battleId)) throw new Error("Solana Battle Boost quote battle mismatch.");
  const recovery = battleRecovery({ battleId: input.battleId, chainId: quote.chainId, wallet: input.wallet, targetToken: quote.targetToken, quoteId: quote.quoteId, fundingId: quote.fundingId, programId: quote.transaction.programId });
  const result = await sendSolanaArenaInstruction<SolanaBattleBoostPayment>({ chainId: quote.chainId, wallet: input.wallet, transaction: quote.transaction, label: "Battle Boost", recovery });
  return result.settlement;
}

export function formatBoostNative(raw?: string | null, nativeSymbol = "BNB") {
  if (!raw) return `0 ${nativeSymbol}`;
  try { return `${Number(formatEther(BigInt(raw))).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${nativeSymbol}`; }
  catch { return `0 ${nativeSymbol}`; }
}

export function formatBoostLamports(raw?: string | null) {
  try { return `${(Number(BigInt(String(raw || "0"))) / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`; }
  catch { return "0 SOL"; }
}
