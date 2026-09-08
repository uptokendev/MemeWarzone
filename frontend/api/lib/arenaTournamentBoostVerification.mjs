import { Interface, getAddress, id } from "ethers";

const TOURNAMENT_BOOST_EVENT_ABI = [
  "event TournamentBoosted(bytes32 indexed poolId,bytes32 indexed matchId,uint256 indexed roundNumber,address booster,address sideToken,uint256 boostUnits,uint256 unitPriceNativeRaw,uint256 grossNativeRaw,uint256 pricingVersion,uint256 oracleTimestamp,uint256 nonce)",
];
const tournamentBoostInterface = new Interface(TOURNAMENT_BOOST_EVENT_ABI);

function positiveBigInt(value, label) {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= 0n) throw new Error(`${label} must be positive`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && /must be positive/.test(error.message)) throw error;
    throw new Error(`${label} must be a positive integer`);
  }
}

export function tournamentBoostPoolId(tournamentId) {
  return id(`arena-tournament:${String(tournamentId)}`);
}

export function tournamentBoostMatchId({ tournamentId, roundNumber, matchId }) {
  return id(`arena-tournament-match:${String(tournamentId)}:${Number(roundNumber)}:${String(matchId)}`);
}

export function decodeTournamentBoostLog(log, { treasuryAddress } = {}) {
  if (!log) throw new Error("Tournament Boost transaction log was not found");
  if (treasuryAddress && String(log.address || "").toLowerCase() !== String(treasuryAddress).toLowerCase()) {
    throw new Error("Tournament Boost log was emitted by an unexpected treasury");
  }
  let parsed;
  try {
    parsed = tournamentBoostInterface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    throw new Error("Transaction log is not a TournamentBoosted event");
  }
  if (!parsed || parsed.name !== "TournamentBoosted") throw new Error("Transaction log is not a TournamentBoosted event");
  return {
    poolId: String(parsed.args.poolId),
    matchId: String(parsed.args.matchId),
    roundNumber: BigInt(parsed.args.roundNumber),
    booster: String(parsed.args.booster),
    sideToken: String(parsed.args.sideToken),
    boostUnits: BigInt(parsed.args.boostUnits),
    unitPriceNativeRaw: BigInt(parsed.args.unitPriceNativeRaw),
    grossNativeRaw: BigInt(parsed.args.grossNativeRaw),
    pricingVersion: BigInt(parsed.args.pricingVersion),
    oracleTimestamp: BigInt(parsed.args.oracleTimestamp),
    nonce: BigInt(parsed.args.nonce),
  };
}

export function assertTournamentBoostEventMatches(event, expected = {}) {
  const poolId = tournamentBoostPoolId(expected.tournamentId);
  const matchId = tournamentBoostMatchId(expected);
  const wallet = getAddress(String(expected.wallet));
  const targetToken = getAddress(String(expected.targetToken));
  const units = positiveBigInt(expected.boostUnits, "boostUnits");
  const gross = positiveBigInt(expected.grossNativeRaw, "grossNativeRaw");
  const round = positiveBigInt(expected.roundNumber, "roundNumber");

  if (event.poolId.toLowerCase() !== poolId.toLowerCase()) throw new Error("Tournament Boost pool id mismatch");
  if (event.matchId.toLowerCase() !== matchId.toLowerCase()) throw new Error("Tournament Boost match id mismatch");
  if (event.roundNumber !== round) throw new Error("Tournament Boost round mismatch");
  if (getAddress(event.booster) !== wallet) throw new Error("Tournament Boost booster mismatch");
  if (getAddress(event.sideToken) !== targetToken) throw new Error("Tournament Boost target mismatch");
  if (event.boostUnits !== units) throw new Error("Tournament Boost unit count mismatch");
  if (event.grossNativeRaw !== gross) throw new Error("Tournament Boost gross amount mismatch");
  if (event.unitPriceNativeRaw * event.boostUnits !== event.grossNativeRaw) throw new Error("Tournament Boost signed price math mismatch");
  return event;
}

export async function verifyTournamentBoostPayment({
  provider,
  treasuryAddress,
  txHash,
  logIndex,
  tournamentId,
  roundNumber,
  matchId,
  wallet,
  targetToken,
  boostUnits,
  grossNativeRaw,
}) {
  if (!provider || typeof provider.getTransactionReceipt !== "function") throw new Error("Tournament Boost RPC provider is unavailable");
  const index = Number(logIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error("Tournament Boost log index is invalid");
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Tournament Boost transaction receipt is unavailable");
  if (Number(receipt.status) !== 1) throw new Error("Tournament Boost transaction did not succeed");
  const log = (receipt.logs || []).find((candidate) => Number(candidate.index ?? candidate.logIndex) === index);
  const event = decodeTournamentBoostLog(log, { treasuryAddress });
  assertTournamentBoostEventMatches(event, { tournamentId, roundNumber, matchId, wallet, targetToken, boostUnits, grossNativeRaw });

  let confirmedAt = null;
  if (typeof provider.getBlock === "function" && receipt.blockNumber != null) {
    const block = await provider.getBlock(receipt.blockNumber);
    const timestamp = Number(block?.timestamp);
    if (Number.isFinite(timestamp) && timestamp > 0) confirmedAt = new Date(timestamp * 1000).toISOString();
  }
  return {
    ...event,
    treasuryAddress: getAddress(treasuryAddress),
    txHash: String(receipt.hash || receipt.transactionHash || txHash).toLowerCase(),
    logIndex: index,
    blockNumber: receipt.blockNumber == null ? null : Number(receipt.blockNumber),
    confirmedAt,
  };
}
