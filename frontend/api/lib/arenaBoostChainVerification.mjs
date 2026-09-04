import { Interface, getAddress, id } from "ethers";

const BOOST_EVENT_ABI = [
  "event BattleBoosted(bytes32 indexed poolId,address indexed booster,address indexed sideToken,uint256 boostUnits,uint256 unitPriceNativeRaw,uint256 grossNativeRaw,uint256 pricingVersion,uint256 oracleTimestamp,uint256 nonce)",
];

const boostInterface = new Interface(BOOST_EVENT_ABI);

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

function safeLogIndex(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function battleBoostTreasuryV2Address(chainId, env = process.env) {
  const chain = Number(chainId);
  const address = String(
    env[`ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${chain}`] ||
      env[`ARENA_WAR_POOL_TREASURY_ADDRESS_${chain}`] ||
      "",
  ).trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(`Arena War Pool V2 address is not configured for chain ${chain}`);
  }
  return getAddress(address);
}

export function expectedBattleBoostPoolId(battleId) {
  return id(`arena-battle:${String(battleId)}`);
}

export function decodeBattleBoostLog(log, { treasuryAddress } = {}) {
  if (!log) throw new Error("Battle Boost transaction log was not found");
  if (treasuryAddress && String(log.address || "").toLowerCase() !== String(treasuryAddress).toLowerCase()) {
    throw new Error("Battle Boost log was emitted by an unexpected treasury");
  }
  let parsed;
  try {
    parsed = boostInterface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    throw new Error("Transaction log is not a BattleBoosted event");
  }
  if (!parsed || parsed.name !== "BattleBoosted") throw new Error("Transaction log is not a BattleBoosted event");
  return {
    poolId: String(parsed.args.poolId),
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

export function assertBattleBoostEventMatches(event, expected = {}) {
  const poolId = String(expected.poolId || expectedBattleBoostPoolId(expected.battleId));
  const wallet = getAddress(String(expected.wallet));
  const targetToken = getAddress(String(expected.targetToken));
  const boostUnits = positiveBigInt(expected.boostUnits, "boostUnits");
  const grossNativeRaw = positiveBigInt(expected.grossNativeRaw, "grossNativeRaw");

  if (event.poolId.toLowerCase() !== poolId.toLowerCase()) throw new Error("Battle Boost pool id does not match the battle");
  if (getAddress(event.booster) !== wallet) throw new Error("Battle Boost booster does not match the confirmed wallet");
  if (getAddress(event.sideToken) !== targetToken) throw new Error("Battle Boost side token does not match the confirmed target");
  if (event.boostUnits !== boostUnits) throw new Error("Battle Boost unit count does not match the confirmed event");
  if (event.grossNativeRaw !== grossNativeRaw) throw new Error("Battle Boost gross amount does not match the confirmed event");
  if (event.unitPriceNativeRaw * event.boostUnits !== event.grossNativeRaw) {
    throw new Error("Battle Boost event gross amount does not match its signed unit price");
  }
  return event;
}

export async function verifyBattleBoostPayment({
  provider,
  chainId,
  txHash,
  logIndex,
  battleId,
  wallet,
  targetToken,
  boostUnits,
  grossNativeRaw,
  treasuryAddress = battleBoostTreasuryV2Address(chainId),
}) {
  if (!provider || typeof provider.getTransactionReceipt !== "function") throw new Error("Battle Boost RPC provider is unavailable");
  const index = safeLogIndex(logIndex);
  if (index == null) throw new Error("Battle Boost log index is invalid");

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Battle Boost transaction receipt is not available yet");
  if (Number(receipt.status) !== 1) throw new Error("Battle Boost transaction did not succeed");

  const log = (receipt.logs || []).find((candidate) => Number(candidate.index ?? candidate.logIndex) === index);
  const event = decodeBattleBoostLog(log, { treasuryAddress });
  assertBattleBoostEventMatches(event, { battleId, wallet, targetToken, boostUnits, grossNativeRaw });

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
