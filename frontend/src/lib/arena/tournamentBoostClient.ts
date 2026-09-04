import { Contract, formatEther, type JsonRpcSigner } from "ethers";

import { apiFetch } from "@/lib/apiBase";
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
    try {
      BigInt(String(quote.value[key]));
    } catch {
      throw new Error(`Tournament Boost quote field ${key} is invalid.`);
    }
  }
  return quote;
}

export async function fetchTournamentBoostState(
  tournamentId: string,
  matchRef: string,
  signal?: AbortSignal,
): Promise<TournamentBoostState> {
  const response = await apiFetch(route(tournamentId, matchRef), { cache: "no-store", signal });
  return readJson<TournamentBoostState>(response);
}

export async function createTournamentBoostQuote(input: {
  tournamentId: string;
  matchRef: string;
  chainId: number;
  wallet: string;
  targetToken: string;
  boostUnits: number;
  roundNumber: number;
  matchId: string;
  signer: JsonRpcSigner;
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
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: input.wallet,
      targetToken: input.targetToken,
      boostUnits: input.boostUnits,
      auth,
    }),
  });
  const json = await readJson<any>(response);
  return { ...json, quote: parseQuote(json.quote) };
}

export async function submitTournamentBoost(input: { signer: JsonRpcSigner; quote: TournamentBoostQuote }) {
  const quote = parseQuote(input.quote);
  const signerChain = Number((await input.signer.provider.getNetwork()).chainId);
  if (signerChain !== Number(quote.domain.chainId)) throw new Error("Wallet chain does not match Tournament Boost quote.");
  const signerAddress = String(await input.signer.getAddress()).toLowerCase();
  if (signerAddress !== String(quote.value.booster || "").toLowerCase()) throw new Error("Tournament Boost quote belongs to another wallet.");

  const contract = new Contract(quote.domain.verifyingContract, TOURNAMENT_BOOST_ABI, input.signer);
  const tx = await contract.boostTournament(
    quote.value.poolId,
    quote.value.matchId,
    BigInt(quote.value.roundNumber),
    quote.value.sideToken,
    BigInt(quote.value.boostUnits),
    BigInt(quote.value.unitPriceNativeRaw),
    BigInt(quote.value.pricingVersion),
    BigInt(quote.value.oracleTimestamp),
    BigInt(quote.value.nonce),
    BigInt(quote.value.deadline),
    quote.signature,
    { value: BigInt(quote.value.grossNativeRaw) },
  );
  const receipt = await tx.wait();
  if (receipt && Number(receipt.status) !== 1) throw new Error("Tournament Boost transaction did not succeed.");
  return { txHash: String(tx.hash || receipt?.hash || ""), receipt };
}

export function formatTournamentBoostNative(raw?: string | null, symbol = "BNB") {
  if (!raw) return `0 ${symbol}`;
  try {
    return `${Number(formatEther(BigInt(raw))).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`;
  } catch {
    return `0 ${symbol}`;
  }
}
