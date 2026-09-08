import { Contract, Interface, JsonRpcProvider, Network, getAddress } from "ethers";

const EVM_REWARD_CHAINS = new Set([56, 97, 4663, 46630]);
const REWARD_DISTRIBUTOR_INTERFACE = new Interface([
  "function claim(bytes32 batchId, uint256 amount, bytes32[] proof)",
  "function hasClaimed(bytes32 batchId, address account) view returns (bool)",
  "function batches(bytes32 batchId) view returns (bytes32 merkleRoot,uint256 totalFunded,uint256 totalClaimed,uint64 claimDeadline,bool paused,bool exists)",
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

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function recoveryChunkSize() {
  return positiveInteger(process.env.REWARD_CLAIM_RECOVERY_BLOCK_CHUNK, 5_000);
}

function recoverySafetySeconds() {
  return positiveInteger(process.env.REWARD_CLAIM_RECOVERY_SAFETY_SECONDS, 3_600);
}

function explicitRecoveryFromBlock(chainId) {
  const chain = Number(chainId);
  const raw = process.env[`REWARD_CLAIM_RECOVERY_FROM_BLOCK_${chain}`] || process.env.REWARD_CLAIM_RECOVERY_FROM_BLOCK;
  if (raw == null || String(raw).trim() === "") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function assertProviderChain(provider, chainId, allowProviderChainMismatch) {
  if (allowProviderChainMismatch) return;
  let network;
  try {
    network = await provider.getNetwork();
  } catch (error) {
    throw new RewardClaimVerificationError(
      "CLAIM_RPC_UNAVAILABLE",
      `Could not read reward-claim RPC network: ${error?.message || error}`,
      503,
    );
  }
  if (Number(network.chainId) !== Number(chainId)) {
    throw new RewardClaimVerificationError(
      "CLAIM_RPC_CHAIN_MISMATCH",
      `Reward claim RPC is on chain ${network.chainId}, expected ${chainId}.`,
      503,
    );
  }
}

async function blockAtOrBeforeTimestamp(provider, latestBlock, targetTimestamp) {
  let low = 0;
  let high = Math.max(0, Number(latestBlock));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    let block;
    try {
      block = await provider.getBlock(mid);
    } catch (error) {
      throw new RewardClaimVerificationError(
        "CLAIM_RECOVERY_HISTORY_UNAVAILABLE",
        `Could not inspect historical reward-claim block ${mid}: ${error?.message || error}`,
        503,
      );
    }
    if (!block) {
      high = mid - 1;
      continue;
    }
    if (Number(block.timestamp) <= targetTimestamp) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, low - 8);
}

async function recoveryFromBlock({ provider, chainId, latestBlock, claimableAt, fromBlock }) {
  const supplied = fromBlock == null ? explicitRecoveryFromBlock(chainId) : Number(fromBlock);
  if (Number.isInteger(supplied) && supplied >= 0) return Math.min(Number(latestBlock), supplied);

  const timestamp = claimableAt instanceof Date
    ? claimableAt.getTime()
    : claimableAt
      ? new Date(claimableAt).getTime()
      : NaN;
  if (!Number.isFinite(timestamp)) return 0;

  const target = Math.max(0, Math.floor(timestamp / 1000) - recoverySafetySeconds());
  return blockAtOrBeforeTimestamp(provider, latestBlock, target);
}

async function findRewardClaimedLog({ provider, distributorAddress, batchId, walletAddress, amount, fromBlock, latestBlock }) {
  const topics = REWARD_DISTRIBUTOR_INTERFACE.encodeFilterTopics("RewardClaimed", [batchId, walletAddress]);
  const chunk = recoveryChunkSize();
  const expectedAmount = BigInt(String(amount || "0"));
  let sawMismatchedAmount = false;

  let end = Number(latestBlock);
  while (end >= Number(fromBlock)) {
    const start = Math.max(Number(fromBlock), end - chunk + 1);
    let logs;
    try {
      logs = await provider.getLogs({
        address: getAddress(distributorAddress),
        topics,
        fromBlock: start,
        toBlock: end,
      });
    } catch (error) {
      throw new RewardClaimVerificationError(
        "CLAIM_RECOVERY_LOG_SCAN_UNAVAILABLE",
        `Could not scan RewardClaimed logs for blocks ${start}-${end}: ${error?.message || error}`,
        503,
      );
    }

    for (let index = logs.length - 1; index >= 0; index -= 1) {
      const log = logs[index];
      let parsed;
      try {
        parsed = REWARD_DISTRIBUTOR_INTERFACE.parseLog(log);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.name !== "RewardClaimed") continue;
      const eventBatchId = String(parsed.args?.[0] || "");
      const eventAccount = String(parsed.args?.[1] || "");
      const eventAmount = BigInt(parsed.args?.[2] ?? 0n);
      if (!sameBytes32(eventBatchId, batchId) || !sameAddress(eventAccount, walletAddress)) continue;
      if (eventAmount !== expectedAmount) {
        sawMismatchedAmount = true;
        continue;
      }
      return log;
    }

    if (start === Number(fromBlock)) break;
    end = start - 1;
  }

  if (sawMismatchedAmount) {
    throw new RewardClaimVerificationError(
      "CLAIM_AMOUNT_MISMATCH",
      "RewardClaimed event amount does not match the reward entitlement.",
    );
  }
  return null;
}

export async function verifyEvmRewardClaim({
  chainId,
  txHash,
  walletAddress,
  distributorAddress,
  batchId,
  amount,
  minConfirmations = 1,
  provider = null,
  allowProviderChainMismatch = false,
}) {
  const chain = Number(chainId);
  const rpc = provider || providerForChain(chain);
  await assertProviderChain(rpc, chain, allowProviderChainMismatch);
  const [tx, receipt, latestBlock] = await Promise.all([
    rpc.getTransaction(txHash),
    rpc.getTransactionReceipt(txHash),
    rpc.getBlockNumber(),
  ]);

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

export async function recoverEvmRewardClaim({
  chainId,
  walletAddress,
  distributorAddress,
  batchId,
  amount,
  expectedMerkleRoot = "",
  claimableAt = null,
  fromBlock = null,
  minConfirmations = 1,
  provider = null,
  allowProviderChainMismatch = false,
}) {
  const chain = Number(chainId);
  if (chain !== 56 && chain !== 97) {
    throw new RewardClaimVerificationError(
      "CLAIM_RECOVERY_CHAIN_UNSUPPORTED",
      "Durable automatic recovery is enabled only for BNB reward claims in this implementation.",
      400,
    );
  }

  const rpc = provider || providerForChain(chain);
  await assertProviderChain(rpc, chain, allowProviderChainMismatch);
  const distributor = new Contract(distributorAddress, REWARD_DISTRIBUTOR_INTERFACE, rpc);

  let hasClaimed;
  let batch;
  let latestBlock;
  try {
    [hasClaimed, batch, latestBlock] = await Promise.all([
      distributor.hasClaimed(batchId, walletAddress),
      distributor.batches(batchId),
      rpc.getBlockNumber(),
    ]);
  } catch (error) {
    throw new RewardClaimVerificationError(
      "CLAIM_RECOVERY_STATE_UNAVAILABLE",
      `Could not read authoritative RewardDistributor claim state: ${error?.message || error}`,
      503,
    );
  }

  const batchExists = Boolean(batch?.exists ?? batch?.[5]);
  const merkleRoot = String(batch?.merkleRoot ?? batch?.[0] ?? "");
  const totalFunded = BigInt(batch?.totalFunded ?? batch?.[1] ?? 0n);
  const totalClaimed = BigInt(batch?.totalClaimed ?? batch?.[2] ?? 0n);
  if (!batchExists) {
    throw new RewardClaimVerificationError("CLAIM_BATCH_MISSING", "RewardDistributor batch does not exist on-chain.");
  }
  if (expectedMerkleRoot && !sameBytes32(merkleRoot, expectedMerkleRoot)) {
    throw new RewardClaimVerificationError("CLAIM_BATCH_ROOT_MISMATCH", "On-chain batch root does not match the entitlement batch data.");
  }
  const expectedAmount = BigInt(String(amount || "0"));
  if (expectedAmount <= 0n || totalFunded < expectedAmount) {
    throw new RewardClaimVerificationError("CLAIM_AMOUNT_MISMATCH", "On-chain batch funding cannot satisfy the entitlement amount.");
  }

  if (!Boolean(hasClaimed)) {
    return {
      claimed: false,
      verified: true,
      chainId: chain,
      distributorAddress: getAddress(distributorAddress),
      walletAddress: getAddress(walletAddress),
      batchId: String(batchId),
      amount: expectedAmount.toString(),
      merkleRoot,
      totalFunded: totalFunded.toString(),
      totalClaimed: totalClaimed.toString(),
    };
  }

  if (totalClaimed < expectedAmount) {
    throw new RewardClaimVerificationError(
      "CLAIM_RECOVERY_BATCH_ACCOUNTING_MISMATCH",
      "RewardDistributor reports this wallet claimed but batch accounting is below the entitlement amount.",
    );
  }

  const scanFromBlock = await recoveryFromBlock({
    provider: rpc,
    chainId: chain,
    latestBlock,
    claimableAt,
    fromBlock,
  });
  const eventLog = await findRewardClaimedLog({
    provider: rpc,
    distributorAddress,
    batchId,
    walletAddress,
    amount: expectedAmount,
    fromBlock: scanFromBlock,
    latestBlock,
  });
  if (!eventLog) {
    throw new RewardClaimVerificationError(
      "CLAIM_RECOVERY_EVENT_NOT_FOUND",
      "RewardDistributor reports the entitlement claimed, but the matching RewardClaimed event was not found. Refusing another payout request.",
      503,
    );
  }

  const verification = await verifyEvmRewardClaim({
    chainId: chain,
    txHash: eventLog.transactionHash,
    walletAddress,
    distributorAddress,
    batchId,
    amount: expectedAmount,
    minConfirmations,
    provider: rpc,
    allowProviderChainMismatch,
  });

  return {
    ...verification,
    claimed: true,
    recovered: true,
    hasClaimed: true,
    eventMatched: true,
    batchVerified: true,
    merkleRoot,
    totalFunded: totalFunded.toString(),
    totalClaimed: totalClaimed.toString(),
    recoveryFromBlock: scanFromBlock,
  };
}
