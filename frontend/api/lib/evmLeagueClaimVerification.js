import {
  AbiCoder,
  Interface,
  JsonRpcProvider,
  Network,
  getAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers";

const EVM_LEAGUE_CHAINS = new Set([56, 97, 4663, 46630]);
const EVM_LEAGUE_INTERFACE = new Interface([
  "function claim(uint256 epochId, bytes32 category, uint8 rank, address recipient, uint256 amount, bytes32[] proof)",
  "function epochLeafClaimed(uint256 epochId, bytes32 leaf) view returns (bool)",
  "event Claimed(uint256 indexed epochId, address indexed recipient, uint256 amount, bytes32 indexed leaf)",
]);

export class EvmLeagueClaimVerificationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "EvmLeagueClaimVerificationError";
    this.code = code;
    this.status = status;
  }
}

function periodCode(period) {
  if (period === "weekly") return 1;
  if (period === "monthly") return 2;
  throw new EvmLeagueClaimVerificationError("LEAGUE_PERIOD_INVALID", "League claim period must be weekly or monthly.", 400);
}

function rpcUrl(chainId) {
  const chain = Number(chainId);
  const perChain = chain === 4663 || chain === 46630
    ? String(
        process.env[`ROBINHOOD_RPC_HTTP_${chain}`] ||
        (chain === 4663 ? process.env.ROBINHOOD_MAINNET_RPC_URL : process.env.ROBINHOOD_TESTNET_RPC_URL) ||
        "",
      ).trim()
    : String(process.env[`BSC_RPC_HTTP_${chain}`] || "").trim();
  if (perChain) return perChain.split(",").map((item) => item.trim()).find(Boolean) || "";
  if (chain === 56 || chain === 97) {
    const fallback = String(process.env.BSC_RPC_HTTP || "").trim();
    if (fallback) return fallback.split(",").map((item) => item.trim()).find(Boolean) || "";
  }
  throw new EvmLeagueClaimVerificationError("LEAGUE_RPC_UNAVAILABLE", `Missing chain-specific League RPC for chain ${chain}.`, 503);
}

function vaultAddress(chainId) {
  const chain = Number(chainId);
  const perChain = String(process.env[`TREASURY_VAULT_V2_ADDRESS_${chain}`] || "").trim();
  if (perChain) return getAddress(perChain);
  if (chain === 56 || chain === 97) {
    const fallback = String(process.env.TREASURY_VAULT_V2_ADDRESS || "").trim();
    if (fallback) return getAddress(fallback);
  }
  throw new EvmLeagueClaimVerificationError(
    "LEAGUE_VAULT_UNAVAILABLE",
    `Missing chain-specific TreasuryVaultV2 address for chain ${chain}.`,
    503,
  );
}

function providerForChain(chainId) {
  const chain = Number(chainId);
  if (!EVM_LEAGUE_CHAINS.has(chain)) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_CHAIN_UNSUPPORTED", "Unsupported EVM League claim chain.", 400);
  }
  const network = Network.from(chain);
  return new JsonRpcProvider(rpcUrl(chain), network, {
    staticNetwork: network,
    batchMaxCount: 1,
    batchStallTime: 0,
  });
}

function sameAddress(left, right) {
  try {
    return getAddress(String(left || "")) === getAddress(String(right || ""));
  } catch {
    return false;
  }
}

function sameBytes32(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function scanLogsBackwards(provider, { address, topics, lookbackBlocks, chunkBlocks }) {
  const latest = await provider.getBlockNumber();
  const floor = Math.max(0, latest - lookbackBlocks + 1);
  const logs = [];
  for (let toBlock = latest; toBlock >= floor;) {
    const fromBlock = Math.max(floor, toBlock - chunkBlocks + 1);
    const chunk = await provider.getLogs({ address, topics, fromBlock, toBlock });
    if (chunk.length) logs.push(...chunk.reverse());
    toBlock = fromBlock - 1;
  }
  return logs;
}

export function buildExpectedEvmLeagueClaim({ chainId, period, epochStart, category, rank, recipient, amountRaw }) {
  const chain = Number(chainId);
  if (!EVM_LEAGUE_CHAINS.has(chain)) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_CHAIN_UNSUPPORTED", "Unsupported EVM League claim chain.", 400);
  }
  const epoch = new Date(epochStart);
  if (Number.isNaN(epoch.getTime())) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_EPOCH_INVALID", "Invalid League epochStart.", 400);
  }
  const normalizedRecipient = getAddress(recipient);
  const normalizedRank = Number(rank);
  const amount = BigInt(String(amountRaw || "0"));
  if (!Number.isInteger(normalizedRank) || normalizedRank < 1 || normalizedRank > 5) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_RANK_INVALID", "Invalid League winner rank.", 400);
  }
  if (amount <= 0n) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_AMOUNT_INVALID", "Invalid League payout amount.", 409);
  }

  const epochStartSec = Math.floor(epoch.getTime() / 1000);
  const coder = AbiCoder.defaultAbiCoder();
  const epochIdHash = keccak256(coder.encode(
    ["uint32", "uint8", "uint64"],
    [chain, periodCode(period), BigInt(epochStartSec)],
  ));
  const epochId = BigInt(epochIdHash);
  const categoryHash = keccak256(toUtf8Bytes(String(category || "").toLowerCase().trim()));
  const leaf = keccak256(coder.encode(
    ["uint256", "bytes32", "uint8", "address", "uint256"],
    [epochId, categoryHash, normalizedRank, normalizedRecipient, amount],
  ));

  return {
    chainId: chain,
    vaultAddress: vaultAddress(chain),
    epochId,
    epochIdHex: zeroPadValue(toBeHex(epochId), 32),
    epochStartSec,
    categoryHash,
    rank: normalizedRank,
    recipient: normalizedRecipient,
    amountRaw: amount.toString(),
    leaf,
  };
}

export function evmLeagueClaimEventTopics(expected) {
  return [
    EVM_LEAGUE_INTERFACE.getEvent("Claimed").topicHash,
    expected.epochIdHex,
    zeroPadValue(expected.recipient, 32),
    expected.leaf,
  ];
}

export async function verifyEvmLeagueClaimTransaction({
  chainId,
  period,
  epochStart,
  category,
  rank,
  recipient,
  amountRaw,
  txHash,
  minConfirmations = 1,
}) {
  const expected = buildExpectedEvmLeagueClaim({ chainId, period, epochStart, category, rank, recipient, amountRaw });
  const provider = providerForChain(expected.chainId);
  const [network, tx, receipt, latestBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
    provider.getBlockNumber(),
  ]);

  if (Number(network.chainId) !== expected.chainId) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_CHAIN_MISMATCH", `League RPC returned chain ${network.chainId}, expected ${expected.chainId}.`, 503);
  }
  if (!tx || !receipt) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_TX_NOT_FOUND", "League claim transaction is not available yet.");
  }
  if (Number(receipt.status) !== 1) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_TX_REVERTED", "League claim transaction reverted on-chain.");
  }
  if (!sameAddress(tx.to, expected.vaultAddress)) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_VAULT_MISMATCH", "League claim targeted the wrong TreasuryVaultV2 contract.");
  }

  let parsed;
  try {
    parsed = EVM_LEAGUE_INTERFACE.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.name !== "claim") {
    throw new EvmLeagueClaimVerificationError("LEAGUE_CALL_MISMATCH", "Transaction is not a TreasuryVaultV2 League claim.");
  }
  if (BigInt(parsed.args?.[0] ?? 0n) !== expected.epochId) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_EPOCH_MISMATCH", "League claim epoch does not match the entitlement.");
  }
  if (!sameBytes32(parsed.args?.[1], expected.categoryHash)) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_CATEGORY_MISMATCH", "League claim category does not match the entitlement.");
  }
  if (Number(parsed.args?.[2]) !== expected.rank) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_RANK_MISMATCH", "League claim rank does not match the entitlement.");
  }
  if (!sameAddress(parsed.args?.[3], expected.recipient)) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_RECIPIENT_MISMATCH", "League claim recipient does not match the winner.");
  }
  if (BigInt(parsed.args?.[4] ?? 0n) !== BigInt(expected.amountRaw)) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_AMOUNT_MISMATCH", "League claim amount does not match the entitlement.");
  }

  let matchedEvent = false;
  for (const log of receipt.logs || []) {
    if (!sameAddress(log.address, expected.vaultAddress)) continue;
    try {
      const event = EVM_LEAGUE_INTERFACE.parseLog(log);
      if (!event || event.name !== "Claimed") continue;
      if (
        BigInt(event.args?.[0] ?? 0n) === expected.epochId &&
        sameAddress(event.args?.[1], expected.recipient) &&
        BigInt(event.args?.[2] ?? 0n) === BigInt(expected.amountRaw) &&
        sameBytes32(event.args?.[3], expected.leaf)
      ) {
        matchedEvent = true;
        break;
      }
    } catch {}
  }
  if (!matchedEvent) {
    throw new EvmLeagueClaimVerificationError("LEAGUE_EVENT_MISSING", "Confirmed transaction does not contain the exact expected League Claimed event.");
  }

  const confirmations = Math.max(0, Number(latestBlock) - Number(receipt.blockNumber) + 1);
  const requiredConfirmations = Math.max(1, Number(minConfirmations) || 1);
  if (confirmations < requiredConfirmations) {
    throw new EvmLeagueClaimVerificationError(
      "LEAGUE_CONFIRMATIONS_PENDING",
      `League claim has ${confirmations}/${requiredConfirmations} required confirmations.`,
      409,
    );
  }

  return {
    verified: true,
    ...expected,
    epochId: expected.epochId.toString(),
    txHash: String(receipt.hash || txHash),
    blockNumber: Number(receipt.blockNumber),
    confirmations,
  };
}

export async function discoverEvmLeagueClaimTransaction({
  chainId,
  period,
  epochStart,
  category,
  rank,
  recipient,
  amountRaw,
  minConfirmations = 1,
  lookbackBlocks = positiveIntEnv("EVM_CLAIM_RECONCILE_LOOKBACK_BLOCKS", 2_000_000),
  chunkBlocks = positiveIntEnv("EVM_CLAIM_RECONCILE_CHUNK_BLOCKS", 50_000),
}) {
  const expected = buildExpectedEvmLeagueClaim({ chainId, period, epochStart, category, rank, recipient, amountRaw });
  const provider = providerForChain(expected.chainId);
  const callData = EVM_LEAGUE_INTERFACE.encodeFunctionData("epochLeafClaimed", [expected.epochId, expected.leaf]);
  const rawClaimed = await provider.call({ to: expected.vaultAddress, data: callData });
  const [claimed] = EVM_LEAGUE_INTERFACE.decodeFunctionResult("epochLeafClaimed", rawClaimed);
  if (!claimed) return null;

  const logs = await scanLogsBackwards(provider, {
    address: expected.vaultAddress,
    topics: evmLeagueClaimEventTopics(expected),
    lookbackBlocks,
    chunkBlocks,
  });
  for (const log of logs) {
    return verifyEvmLeagueClaimTransaction({
      chainId: expected.chainId,
      period,
      epochStart,
      category,
      rank: expected.rank,
      recipient: expected.recipient,
      amountRaw: expected.amountRaw,
      txHash: log.transactionHash,
      minConfirmations,
    });
  }

  throw new EvmLeagueClaimVerificationError(
    "LEAGUE_EVENT_NOT_DISCOVERED",
    "TreasuryVaultV2 reports this League leaf claimed, but its exact Claimed event was not found in the configured reconciliation window.",
    409,
  );
}