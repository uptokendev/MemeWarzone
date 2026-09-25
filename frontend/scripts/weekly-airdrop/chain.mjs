import { Contract, JsonRpcProvider, Network, Wallet, getAddress } from "ethers";
import { asBigInt, envText, requireEnv } from "./config.mjs";

function rpcUrl(chainId) {
  return envText(`BSC_RPC_HTTP_${chainId}`) || envText("BSC_RPC_HTTP") || envText("RPC_URL");
}

function providerFor(chainId) {
  const raw = rpcUrl(chainId);
  if (!raw) throw new Error(`BSC_RPC_HTTP_${chainId} is required`);
  const url = raw.split(",").map((value) => value.trim()).find(Boolean);
  const network = Network.from(Number(chainId || 97));
  return new JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 });
}

export function configuredVaultAddress(chainId) {
  return envText(`COMMUNITY_REWARDS_VAULT_ADDRESS_${chainId}`) || envText("COMMUNITY_REWARDS_VAULT_ADDRESS") || null;
}

export async function resolvePoolWei(chainId) {
  const fixed = envText("AIRDROP_WEEKLY_POOL_WEI");
  if (fixed) {
    const availableWei = asBigInt(fixed, -1n);
    if (availableWei <= 0n) throw new Error("AIRDROP_WEEKLY_POOL_WEI must be positive");
    return { availableWei, source: "env_fixed", vaultAddress: null };
  }
  const vaultAddress = configuredVaultAddress(chainId);
  if (!vaultAddress) throw new Error("CommunityRewardsVault address is required");
  const vault = new Contract(vaultAddress, ["function warzoneAirdropBalance() view returns (uint256)"], providerFor(chainId));
  const availableWei = BigInt(await vault.warzoneAirdropBalance());
  if (availableWei <= 0n) throw new Error("warzoneAirdropBalance is zero");
  return { availableWei, source: "community_rewards_vault", vaultAddress };
}

export async function markFundingCheck(client, batchId) {
  await client.query("begin");
  try {
    await client.query(
      `update public.reward_ledger
          set status='approved',claimable_at=null,updated_at=now()
        where id in (select reward_ledger_id from public.reward_batch_items where batch_id=$1::uuid)
          and status='claimable'`,
      [batchId],
    );
    await client.query(
      `update public.reward_batch_items set status='approved'
        where batch_id=$1::uuid and status='claimable'`,
      [batchId],
    );
    await client.query(
      `update public.reward_batches
          set status='funding_check',claimable_count=0,
              metadata=coalesce(metadata,'{}'::jsonb)||$2::jsonb,updated_at=now()
        where id=$1::uuid`,
      [batchId, JSON.stringify({ fundingCheckStartedAt: new Date().toISOString() })],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function keepFundingCheck(client, batchId, error) {
  await client.query(
    `update public.reward_batches
        set status='funding_check',claimable_count=0,
            metadata=coalesce(metadata,'{}'::jsonb)||$2::jsonb,updated_at=now()
      where id=$1::uuid`,
    [batchId, JSON.stringify({
      fundingFailed: true,
      fundingError: String(error?.message || error),
      fundingFailedAt: new Date().toISOString(),
    })],
  );
}

export async function markClaimOpen(client, batchId, funding) {
  await client.query("begin");
  try {
    const { rows: ledger } = await client.query(
      `update public.reward_ledger
          set status='claimable',claimable_at=coalesce(claimable_at,now()),claim_error=null,updated_at=now()
        where id in (select reward_ledger_id from public.reward_batch_items where batch_id=$1::uuid)
          and status='approved'
        returning id`,
      [batchId],
    );
    await client.query(
      `update public.reward_batch_items set status='claimable'
        where batch_id=$1::uuid and status='approved'`,
      [batchId],
    );
    const { rows } = await client.query(
      `update public.reward_batches
          set status='claim_open',claimable_count=$2,published_at=coalesce(published_at,now()),
              metadata=coalesce(metadata,'{}'::jsonb)||$3::jsonb,updated_at=now()
        where id=$1::uuid returning *`,
      [batchId, ledger.length, JSON.stringify({
        onChainBatchCreated: true,
        onChainBatchTxHash: funding.txHash || null,
        vaultFundingTxHash: funding.txHash || null,
        onChainBatchBlockNumber: funding.blockNumber || null,
        onChainBatchVerifiedAt: new Date().toISOString(),
        fundingExecutorRequestId: funding.requestId || null,
      })],
    );
    await client.query("commit");
    return rows[0] || null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function readOnChainBatch({ chainId, distributorAddress, contractBatchId }) {
  const distributor = new Contract(distributorAddress, [
    "function owner() view returns (address)",
    "function batches(bytes32) view returns (bytes32 merkleRoot,uint256 totalFunded,uint256 totalClaimed,uint64 claimDeadline,bool paused,bool exists)",
  ], providerFor(chainId));
  const [owner, batch] = await Promise.all([distributor.owner(), distributor.batches(contractBatchId)]);
  return {
    owner: getAddress(owner),
    exists: Boolean(batch.exists),
    merkleRoot: String(batch.merkleRoot),
    totalFunded: BigInt(batch.totalFunded),
    totalClaimed: BigInt(batch.totalClaimed),
    claimDeadline: Number(batch.claimDeadline),
    paused: Boolean(batch.paused),
  };
}

function assertBatchMatches(onChain, { contractBatchId, merkleRoot, total, deadline }) {
  if (!onChain.exists) return false;
  if (onChain.merkleRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
    throw new Error(`On-chain batch ${contractBatchId} has a different Merkle root`);
  }
  if (onChain.totalFunded !== total) {
    throw new Error(`On-chain batch ${contractBatchId} has ${onChain.totalFunded} wei, expected ${total}`);
  }
  if (onChain.claimDeadline !== deadline) {
    throw new Error(`On-chain batch ${contractBatchId} has a different claim deadline`);
  }
  if (onChain.paused) throw new Error(`On-chain batch ${contractBatchId} is paused`);
  return true;
}

async function requestFundingExecution(payload) {
  const url = requireEnv("REWARD_FUNDING_EXECUTOR_URL");
  const token = requireEnv("REWARD_FUNDING_EXECUTOR_TOKEN");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": payload.idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok === false) {
    throw new Error(`Funding executor failed: HTTP ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}

export async function ensureOnChainBatch({ batchId, chainId, distributorAddress, vaultAddress, poolSource, batchMetadata }) {
  const contractBatchId = String(batchMetadata?.contractBatchId || batchMetadata?.merkleBatchId || "");
  const merkleRoot = String(batchMetadata?.merkleRoot || "");
  const total = asBigInt(batchMetadata?.merkleTotalAmount, 0n);
  const deadline = Number(batchMetadata?.claimDeadline || 0);
  if (!/^0x[a-fA-F0-9]{64}$/.test(contractBatchId) || !/^0x[a-fA-F0-9]{64}$/.test(merkleRoot) || total <= 0n) {
    throw new Error("Invalid published Merkle metadata");
  }
  if (poolSource !== "community_rewards_vault" || !vaultAddress) {
    throw new Error("Live weekly airdrops must be funded atomically from CommunityRewardsVault");
  }

  let onChain = await readOnChainBatch({ chainId, distributorAddress, contractBatchId });
  if (assertBatchMatches(onChain, { contractBatchId, merkleRoot, total, deadline })) {
    return {
      alreadyExisted: true,
      owner: onChain.owner,
      contractBatchId,
      merkleRoot,
      totalAmount: total.toString(),
      claimDeadline: deadline,
    };
  }

  // Own-server mode (founder, 2026-09-25): the Coolify job funds with the vault's airdropOperator
  // key. Its reach is what the Safe pre-authorized on the RewardDistributor (batch id + max amount +
  // publish window), checked here before sending so a refusal is explained, not just reverted.
  const operatorKey = envText(`AIRDROP_OPERATOR_PRIVATE_KEY_${chainId}`);
  const execution = operatorKey
    ? await fundDirect({ chainId, operatorKey, vaultAddress, distributorAddress, contractBatchId, merkleRoot, deadline, total })
    : await requestFundingExecution({
    action: "fund_airdrop_batch",
    idempotencyKey: `mwz-airdrop:${chainId}:${contractBatchId}`,
    batchId,
    chainId,
    targetContract: vaultAddress,
    functionName: "fundAirdropBatch",
    functionSignature: "fundAirdropBatch(bytes32,bytes32,uint64,uint256)",
    args: [contractBatchId, merkleRoot, deadline, total.toString()],
    vaultAddress,
    distributorAddress,
    contractBatchId,
    merkleRoot,
    totalAmount: total.toString(),
    claimDeadline: deadline,
  });

  onChain = await readOnChainBatch({ chainId, distributorAddress, contractBatchId });
  if (!assertBatchMatches(onChain, { contractBatchId, merkleRoot, total, deadline })) {
    throw new Error(`Funding executor returned before batch ${contractBatchId} was verifiable on-chain`);
  }

  return {
    alreadyExisted: false,
    owner: onChain.owner,
    contractBatchId,
    merkleRoot,
    totalAmount: total.toString(),
    claimDeadline: deadline,
    requestId: execution.requestId || execution.id || null,
    txHash: execution.txHash || execution.vaultFundingTxHash || null,
    blockNumber: execution.blockNumber || null,
  };
}


async function fundDirect({ chainId, operatorKey, vaultAddress, distributorAddress, contractBatchId, merkleRoot, deadline, total }) {
  const provider = providerFor(chainId);
  const signer = new Wallet(operatorKey, provider);
  const distributor = new Contract(distributorAddress, [
    "function batchAuthorization(bytes32) view returns (uint256 maxAmount,uint64 publishAfter,uint64 publishDeadline,bool authorized,bool consumed)",
  ], provider);
  const vault = new Contract(vaultAddress, [
    "function airdropOperator() view returns (address)",
    "function warzoneAirdropBalance() view returns (uint256)",
    "function fundAirdropBatch(bytes32 batchId,bytes32 merkleRoot,uint64 claimDeadline,uint256 amount)",
  ], signer);
  const [auth, operator, tracked] = await Promise.all([
    distributor.batchAuthorization(contractBatchId),
    vault.airdropOperator(),
    vault.warzoneAirdropBalance(),
  ]);
  if (getAddress(operator) !== getAddress(signer.address)) {
    throw new Error(`AIRDROP_OPERATOR_PRIVATE_KEY_${chainId} is ${signer.address}, but the vault's airdropOperator is ${operator}`);
  }
  if (!auth.authorized || auth.consumed) throw new Error(`Batch ${contractBatchId} is not pre-authorized by the Safe (or already used)`);
  if (total > BigInt(auth.maxAmount)) throw new Error(`Batch total ${total} is above the Safe's authorized max ${auth.maxAmount}`);
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(auth.publishAfter) || now > Number(auth.publishDeadline)) throw new Error(`Batch ${contractBatchId} is outside its authorized publish window`);
  if (total > BigInt(tracked)) throw new Error(`Vault airdrop balance ${tracked} is below the batch total ${total}`);
  const tx = await vault.fundAirdropBatch(contractBatchId, merkleRoot, deadline, total);
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`fundAirdropBatch reverted: ${tx.hash}`);
  return { txHash: tx.hash, blockNumber: receipt.blockNumber, requestId: null };
}
