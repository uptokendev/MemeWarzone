import { Contract, formatEther, type JsonRpcSigner } from "ethers";

import { apiFetch } from "@/lib/apiBase";
import {
  sendSolanaArenaInstruction,
  type SolanaArenaInstructionEnvelope,
  type SolanaArenaPendingPayment,
} from "@/lib/arena/solanaArenaBrowserTransaction";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

const TOURNAMENT_BOOST_ABI = [
  "function boostTournament(bytes32 poolId,bytes32 matchId,uint256 roundNumber,address sideToken,uint256 boostUnits,uint256 unitPriceNativeRaw,uint256 pricingVersion,uint256 oracleTimestamp,uint256 nonce,uint256 deadline,bytes signature) payable",
] as const;

export type TournamentBoostSummarySide = {
  boostUnits: string;
  boostPoints: string;
  grossNativeRaw: string;
  prizeNativeRaw: string;
  protocolNativeRaw: string;
};

export type TournamentBoostState = {
  ok: boolean;
  tournamentId: string;
  roundNumber: number;
  matchId: string;
  battleId: string;
  usdPerBoost: number;
  pointsPerBoost: number;
  split: { prizeBps: number; protocolBps: number; leagueBps: number };
  summary: { left: TournamentBoostSummarySide; right: TournamentBoostSummarySide };
  finalSalvoBoostAllowed: boolean;
  updatedAt?: string;
};

export type TournamentBoostQuote = {
  domain: { verifyingContract: string; chainId: number; name?: string; version?: string };
  value: {
    poolId: string;
    matchId: string;
    roundNumber: string;
    booster: string;
    sideToken: string;
    boostUnits: string;
    unitPriceNativeRaw: string;
    grossNativeRaw: string;
    pricingVersion: string;
    oracleTimestamp: string;
    nonce: string;
    deadline: string;
  };
  signature: string;
};

export type SolanaTournamentBoostQuote = {
  ok: true;
  quoteId: string;
  chainId: number;
  battleId: string;
  tournamentId: string;
  matchId: string;
  roundNumber: number;
  side: "left" | "right";
  targetToken: string;
  boostUnits: string;
  pointsPerBoost: number;
  usdPerBoostMicros: string;
  grossLamports: string;
  prizeLamports: string;
  protocolLamports: string;
  split: { prizeBps: number; protocolBps: number; leagueBps: number };
  competitionId: string;
  fundingId: string;
  transaction: SolanaArenaInstructionEnvelope;
  expiresAt: string;
};

export type SolanaTournamentBoostPayment = {
  ok: true;
  confirmed: boolean;
  idempotent: boolean;
  signature: string;
  receiptPda?: string | null;
  pointsPerBoost: number;
  summary?: TournamentBoostState["summary"];
};

function route(tournamentId: string, matchRef: string, suffix = "") {
  return `/api/arena/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchRef)}/boosts${suffix}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.ok === false) {
    throw new Error(String(json?.error || `Tournament Boost request failed (${response.status})`));
  }
  return json as T;
}

function parseQuote(value: unknown): TournamentBoostQuote {
  const quote = value as TournamentBoostQuote | null;
  if (!quote?.domain?.verifyingContract || !quote?.value?.poolId || !quote?.value?.matchId || !quote?.value?.sideToken || !quote?.signature) {
    throw new Error("Tournament Boost quote is incomplete.");
  }
  for (const key of ["roundNumber", "boostUnits", "unitPriceNativeRaw", "grossNativeRaw", "pricingVersion", "oracleTimestamp", "nonce", "deadline"] as const) {
    try { BigInt(String(quote.value[key])); } catch { throw new Error(`Tournament Boost quote field ${key} is invalid.`); }
  }
  return quote;
}

function parseSolanaQuote(value: unknown): SolanaTournamentBoostQuote {
  const quote = value as SolanaTournamentBoostQuote | null;
  if (!quote?.quoteId || !quote?.transaction?.programId || !quote.transaction.dataBase64 || !Array.isArray(quote.transaction.accounts)) {
    throw new Error("Solana Tournament Boost quote is incomplete.");
  }
  if (Number(quote.pointsPerBoost) !== 2 || Number(quote.split?.prizeBps) !== 9000 || Number(quote.split?.protocolBps) !== 1000 || Number(quote.split?.leagueBps) !== 0) {
    throw new Error("Solana Tournament Boost quote has unexpected economics.");
  }
  for (const field of ["boostUnits", "grossLamports", "prizeLamports", "protocolLamports"] as const) {
    try { BigInt(String(quote[field])); } catch { throw new Error(`Solana Tournament Boost ${field} is invalid.`); }
  }
  return quote;
}

export async function fetchTournamentBoostState(tournamentId: string, matchRef: string, signal?: AbortSignal): Promise<TournamentBoostState> {
  const response = await apiFetch(route(tournamentId, matchRef), { cache: "no-store", signal });
  return readJson<TournamentBoostState>(response);
}

export async function createTournamentBoostQuote(input: {
  tournamentId: string; matchRef: string; chainId: number; wallet: string; targetToken: string;
  boostUnits: number; roundNumber: number; matchId: string; signer: JsonRpcSigner;
}) {
  const auth = await signWalletAction({
    action: "arena_tournament_boost_quote",
    walletAddress: input.wallet,
    chainId: input.chainId,
    signer: input.signer,
    extraLines: [
      `Tournament: ${input.tournamentId}`,
      `Round: ${input.roundNumber}`,
      `Match: ${input.matchId}`,
      `Target: ${input.targetToken}`,
      `Boost Units: ${input.boostUnits}`,
    ],
  });
  const response = await apiFetch(route(input.tournamentId, input.matchRef, "/quote"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: input.wallet, targetToken: input.targetToken, boostUnits: input.boostUnits, auth }),
  });
  const json = await readJson<any>(response);
  return { ...json, quote: parseQuote(json.quote) };
}

export async function createSolanaTournamentBoostQuote(input: {
  tournamentId: string; matchRef: string; chainId: number; wallet: string; targetToken: string;
  boostUnits: number; roundNumber: number; matchId: string;
}): Promise<SolanaTournamentBoostQuote> {
  const auth = await signWalletAction({
    action: "arena_tournament_boost_quote",
    walletAddress: input.wallet,
    chainId: input.chainId,
    walletType: "solana",
    signMessage: async (message) => (await signSolanaMessage(message, input.wallet)).signature,
    extraLines: [
      `Tournament: ${input.tournamentId}`,
      `Round: ${input.roundNumber}`,
      `Match: ${input.matchId}`,
      `Target: ${input.targetToken}`,
      `Boost Units: ${input.boostUnits}`,
    ],
  });
  const response = await apiFetch(route(input.tournamentId, input.matchRef, "/solana-quote"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: input.wallet, targetToken: input.targetToken, boostUnits: input.boostUnits, auth }),
  });
  return parseSolanaQuote(await readJson<unknown>(response));
}

export async function submitTournamentBoost(input: { signer: JsonRpcSigner; quote: TournamentBoostQuote }) {
  const quote = parseQuote(input.quote);
  const signerChain = Number((await input.signer.provider.getNetwork()).chainId);
  if (signerChain !== Number(quote.domain.chainId)) throw new Error("Wallet chain does not match Tournament Boost quote.");
  const signerAddress = String(await input.signer.getAddress()).toLowerCase();
  if (signerAddress !== String(quote.value.booster || "").toLowerCase()) throw new Error("Tournament Boost quote belongs to another wallet.");
  const contract = new Contract(quote.domain.verifyingContract, TOURNAMENT_BOOST_ABI, input.signer);
  const tx = await contract.boostTournament(
    quote.value.poolId, quote.value.matchId, BigInt(quote.value.roundNumber), quote.value.sideToken,
    BigInt(quote.value.boostUnits), BigInt(quote.value.unitPriceNativeRaw), BigInt(quote.value.pricingVersion),
    BigInt(quote.value.oracleTimestamp), BigInt(quote.value.nonce), BigInt(quote.value.deadline), quote.signature,
    { value: BigInt(quote.value.grossNativeRaw) },
  );
  const receipt = await tx.wait();
  if (receipt && Number(receipt.status) !== 1) throw new Error("Tournament Boost transaction did not succeed.");
  return { txHash: String(tx.hash || receipt?.hash || ""), receipt };
}

async function reconcileSolanaTournamentBoost(input: {
  tournamentId: string;
  matchRef: string;
  wallet: string;
  chainId: number;
  pending: SolanaArenaPendingPayment;
}): Promise<SolanaTournamentBoostPayment | null> {
  const quoteId = String(input.pending.metadata.quoteId || "").trim();
  if (!quoteId) throw new Error("Stored Tournament Boost recovery is missing its authoritative quote.");
  const auth = await signWalletAction({
    action: "arena_tournament_boost_payment",
    walletAddress: input.wallet,
    chainId: input.chainId,
    walletType: "solana",
    signMessage: async (message) => (await signSolanaMessage(message, input.wallet)).signature,
    extraLines: [`Quote: ${quoteId}`, `Signature: ${input.pending.signature}`],
  });
  const response = await apiFetch(route(input.tournamentId, input.matchRef, "/solana-payment"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteId, signature: input.pending.signature, auth }),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status === 409 && json?.code === "SOLANA_BOOST_PAYMENT_UNVERIFIED") return null;
  if (!response.ok || json?.ok === false) {
    throw new Error(String(json?.error || `Tournament Boost recovery failed (${response.status})`));
  }
  const result = json as SolanaTournamentBoostPayment;
  if (result.confirmed !== true) throw new Error("Solana Tournament Boost receipt is not confirmed by backend authority.");
  if (result.signature && String(result.signature) !== input.pending.signature) {
    throw new Error("Solana Tournament Boost receipt signature does not match the preserved payment.");
  }
  return result;
}

export async function submitSolanaTournamentBoost(input: {
  tournamentId: string; matchRef: string; wallet: string; quote: SolanaTournamentBoostQuote;
}): Promise<SolanaTournamentBoostPayment> {
  const quote = parseSolanaQuote(input.quote);
  if (String(quote.tournamentId) !== String(input.tournamentId)) throw new Error("Solana Tournament Boost quote tournament mismatch.");
  const payment = await sendSolanaArenaInstruction<SolanaTournamentBoostPayment>({
    chainId: quote.chainId,
    wallet: input.wallet,
    transaction: quote.transaction,
    label: "Tournament Boost",
    recovery: {
      key: `tournament-boost:${quote.chainId}:${input.wallet}:${input.tournamentId}:${input.matchRef}`,
      metadata: {
        quoteId: quote.quoteId,
        tournamentId: input.tournamentId,
        matchRef: input.matchRef,
      },
      reconcile: (pending) => reconcileSolanaTournamentBoost({
        tournamentId: String(pending.metadata.tournamentId || input.tournamentId),
        matchRef: String(pending.metadata.matchRef || input.matchRef),
        wallet: input.wallet,
        chainId: quote.chainId,
        pending,
      }),
    },
  });
  return payment.settlement;
}

export function formatTournamentBoostNative(raw?: string | null, symbol = "BNB") {
  if (!raw) return `0 ${symbol}`;
  try { return `${Number(formatEther(BigInt(raw))).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`; }
  catch { return `0 ${symbol}`; }
}

export function formatSolanaBoostLamports(raw?: string | null) {
  try { return `${(Number(BigInt(String(raw || "0"))) / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`; }
  catch { return "0 SOL"; }
}
