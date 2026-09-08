import { Interface, JsonRpcProvider, Network, getAddress, zeroPadValue } from "ethers";

const EVM_REWARD_CHAINS = new Set([56, 97, 4663, 46630]);
const REWARD_DISTRIBUTOR_INTERFACE = new Interface([
  "function claim(bytes32 batchId, uint256 amount, bytes32[] proof)",
  "function hasClaimed(bytes32 batchId, address account) view returns (bool)",
  "event RewardClaimed(bytes32 indexed batchId, address indexed account, uint256 amount)",
]);

export class RewardClaimVerificationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "RewardClaimVerificationError";
    this.code = code;
    this.status = status;
  }
}

function rpcUrlForChain(chainId) {
  const chain = Number(chainId);
  const perChainCandidates = chain === 4663 || chain === 46630
    ? [
        process.env[`ROBINHOOD_RPC_HTTP_${chain}`],
        chain === 46630 ? process.env.ROBINHOOD_TESTNET_RPC_URL : process.env.ROBINHOOD_MAINNET_RPC_URL,
      ]
    : [process.env[`BSC_RPC_HTTP_${chain}`]];
  const perChain = String(perChainCandidates.find(Boolean) || "").trim();
  if (perChain) return perChain.split(",").map((value) => value.trim()).find(Boolean) || "";
  if (chain === 56 || chain === 97) {
    const fallback = String(process.env.BSC_RPC_HTTP || "").trim();
    if (fallback) return fallback.split(",").map((value) => value.trim()).find(Boolean) || "";
  }
  throw new RewardClaimVerificationError(
    "CLAIM_RPC_UNAVAILABLE",
    `Missing chain-specific RPC env required to verify reward claims on chain ${chain}.`,
    503,
  );
}

function providerForChain(chainId) {
  const chain = Number(chainId);
  if (!EVM_REWARD_CHAINS.has(chain)) {
    throw new RewardClaimVerificationError("UNSUPPORTED_CLAIM_CHAIN", "Unsupported EVM reward claim chain.", 400);
  }
  const network = Network.from(chain);
  return new JsonRpcProvider(rpcUrlForChain(chain), network, {
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

export function rewardClaimEventTopics(batchId, walletAddress) {
  return [
    REWARD_DISTRIBUTOR_INTERFACE.getEvent("RewardClaimed").topicHash,
    String(batchId),
    zeroPadValue(getAddress(walletAddress), 32),
  ];
}

export async function verifyEvmRewardClaim({
  chainId,
  txHash,
  walletAddress,
  distributorAddress,
  batchId,
  amount,
  minConfirmations = 1,
}) {
  const chain = Number(chainId);
  const provider = providerForChain(chain);
  const [network, tx, receipt, latestBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
    provider.getBlockNumber(),
  ]);

  if (Number(network.chainId) !== chain) {
    throw new RewardClaimVerificationError("CLAIM_CHAIN_MISMATCH", `Reward claim RPC returned chain ${network.chainId}, expected ${chain}.`, 503);
  }
  if (!tx || !receipt) {
    throw new RewardClaimVerificationError(
      "CLAIM_TX_NOT_FOUND",
      "Claim transaction is not available on the configured chain yet. Retry after confirmation.",
      409,
    );
  }
  if (Number(receipt.status) !== 1) {
    throw new RewardClaimVerificationError("CLAIM_TX_REVERTED", "Claim transaction reverted on-chain.");
  }
  if (!sameAddress(tx.to, distributorAddress)) {
    throw new RewardClaimVerificationError("CLAIM_CONTRACT_MISMATCH", "Claim transaction targeted the wrong distributor contract.");
  }
  if (!sameAddress(tx.from, walletAddress)) {
    throw new RewardClaimVerificationError("CLAIM_WALLET_MISMATCH", "Claim transaction sender does not match the reward wallet.");
  }

  let parsed;
  try {
    parsed = REWARD_DISTRIBUTOR_INTERFACE.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.name !== "claim") {
    throw new RewardClaimVerificationError("CLAIM_CALL_MISMATCH", "Transaction is not a RewardDistributor claim call.");
  }

  const txBatchId = String(parsed.args?.[0] || "");
  const txAmount = BigInt(parsed.args?.[1] ?? 0n);
  if (!sameBytes32(txBatchId, batchId)) {
    throw new RewardClaimVerificationError("CLAIM_BATCH_MISMATCH", "Claim transaction batch does not match the reward entitlement.");
  }
  if (txAmount !== BigInt(String(amount || "0"))) {
    throw new RewardClaimVerificationError("CLAIM_AMOUNT_MISMATCH", "Claim transaction amount does not match the reward entitlement.");
  }

  let matchedEvent = null;
  for (const log of receipt.logs || []) {
    if (!sameAddress(log.address, distributorAddress)) continue;
    try {
      const event = REWARD_DISTRIBUTOR_INTERFACE.parseLog(log);
      if (!event || event.name !== "RewardClaimed") continue;
      const eventBatchId = String(event.args?.[0] || "");
      const eventAccount = String(event.args?.[1] || "");
      const eventAmount = BigInt(event.args?.[2] ?? 0n);
      if (
        sameBytes32(eventBatchId, batchId) &&
        sameAddress(eventAccount, walletAddress) &&
        eventAmount === BigInt(String(amount || "0"))
      ) {
        matchedEvent = event;
        break;
      }
    } catch {}
  }
  if (!matchedEvent) {
    throw new RewardClaimVerificationError(
      "CLAIM_EVENT_MISSING",
      "Confirmed transaction does not contain the expected RewardClaimed event.",
    );
  }

  const confirmations = Math.max(0, Number(latestBlock) - Number(receipt.blockNumber) + 1);
  const requiredConfirmations = Math.max(1, Number(minConfirmations) || 1);
  if (confirmations < requiredConfirmations) {
    throw new RewardClaimVerificationError(
      "CLAIM_CONFIRMATIONS_PENDING",
      `Claim transaction has ${confirmations}/${requiredConfirmations} required confirmations.`,
      409,
    );
  }

  return {
    verified: true,
    chainId: chain,
    txHash: String(receipt.hash || txHash),
    blockNumber: Number(receipt.blockNumber),
    confirmations,
    distributorAddress: getAddress(distributorAddress),
    walletAddress: getAddress(walletAddress),
    batchId: String(batchId),
    amount: BigInt(String(amount || "0")).toString(),
  };
}

export async function discoverEvmRewardClaim({
  chainId,
  walletAddress,
  distributorAddress,
  batchId,
  amount,
  minConfirmations = 1,
  lookbackBlocks = positiveIntEnv("EVM_CLAIM_RECONCILE_LOOKBACK_BLOCKS", 2_000_000),
  chunkBlocks = positiveIntEnv("EVM_CLAIM_RECONCILE_CHUNK_BLOCKS", 50_000),
}) {
  const chain = Number(chainId);
  const provider = providerForChain(chain);
  const distributor = getAddress(distributorAddress);
  const wallet = getAddress(walletAddress);

  const callData = REWARD_DISTRIBUTOR_INTERFACE.encodeFunctionData("hasClaimed", [batchId, wallet]);
  const rawClaimed = await provider.call({ to: distributor, data: callData });
  const [claimed] = REWARD_DISTRIBUTOR_INTERFACE.decodeFunctionResult("hasClaimed", rawClaimed);
  if (!claimed) return null;

  const logs = await scanLogsBackwards(provider, {
    address: distributor,
    topics: rewardClaimEventTopics(batchId, wallet),
    lookbackBlocks,
    chunkBlocks,
  });
  const expectedAmount = BigInt(String(amount || "0"));
  for (const log of logs) {
    let event;
    try {
      event = REWARD_DISTRIBUTOR_INTERFACE.parseLog(log);
    } catch {
      continue;
    }
    if (!event || event.name !== "RewardClaimed") continue;
    if (BigInt(event.args?.[2] ?? 0n) !== expectedAmount) continue;
    return verifyEvmRewardClaim({
      chainId: chain,
      txHash: log.transactionHash,
      walletAddress: wallet,
      distributorAddress: distributor,
      batchId,
      amount: expectedAmount.toString(),
      minConfirmations,
    });
  }

  throw new RewardClaimVerificationError(
    "CLAIM_EVENT_NOT_DISCOVERED",
    "RewardDistributor reports this reward claimed, but its exact RewardClaimed event was not found in the configured reconciliation window.",
    409,
  );
}