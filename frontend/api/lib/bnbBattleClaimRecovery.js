import { getAddress } from "ethers";

import {
  RewardClaimVerificationError,
  recoverEvmRewardClaim,
} from "./rewardClaimVerification.js";

const BNB_CLAIM_CHAINS = new Set([56, 97]);
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function readMeta(row) {
  const meta = row?.metadata;
  if (!meta) return {};
  if (typeof meta === "object") return meta;
  try {
    const parsed = JSON.parse(String(meta));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function sameAddress(left, right) {
  try {
    return getAddress(String(left || "")) === getAddress(String(right || ""));
  } catch {
    return false;
  }
}

function rowChainId(row) {
  const numeric = Number(row?.chain);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  const metadataChain = Number(readMeta(row).chainId);
  return Number.isInteger(metadataChain) && metadataChain > 0 ? metadataChain : 0;
}

function optionalIdentity(metadata) {
  const epoch = firstString(metadata, ["epoch", "epochId", "epoch_id", "battleEpoch", "battle_epoch"]);
  const version = firstString(metadata, ["version", "battleVersion", "battle_version", "entitlementVersion", "entitlement_version"]);
  return {
    ...(epoch ? { epoch } : {}),
    ...(version ? { version } : {}),
  };
}

function requireBytes32(value, code, message) {
  const text = String(value || "").trim();
  if (!BYTES32_RE.test(text)) throw new RewardClaimVerificationError(code, message, 409);
  return text;
}

function requireAddress(value, code, message) {
  const text = String(value || "").trim();
  if (!ADDRESS_RE.test(text)) throw new RewardClaimVerificationError(code, message, 409);
  try {
    return getAddress(text);
  } catch {
    throw new RewardClaimVerificationError(code, message, 409);
  }
}

export function isBnbNormalBattleReward(row) {
  return String(row?.reward_type || "").trim().toLowerCase() === "battle" && BNB_CLAIM_CHAINS.has(rowChainId(row));
}

export function bnbNormalBattleEntitlementIdentity(row, { requestedChainId, requestedWallet } = {}) {
  if (String(row?.reward_type || "").trim().toLowerCase() !== "battle") {
    throw new RewardClaimVerificationError(
      "BATTLE_CLAIM_TYPE_MISMATCH",
      "Durable BNB recovery accepts only Normal Battle reward entitlements.",
      400,
    );
  }

  const chainId = rowChainId(row);
  if (!BNB_CLAIM_CHAINS.has(chainId)) {
    throw new RewardClaimVerificationError(
      "BATTLE_CLAIM_CHAIN_UNSUPPORTED",
      "Durable Normal Battle recovery accepts only BNB claim chains.",
      400,
    );
  }
  if (requestedChainId != null && Number(requestedChainId) !== chainId) {
    throw new RewardClaimVerificationError(
      "REWARD_CHAIN_MISMATCH",
      "Reward entitlement belongs to a different chain.",
      409,
    );
  }

  const recipient = requireAddress(
    row?.wallet_address,
    "CLAIM_WALLET_MISMATCH",
    "Reward entitlement does not contain a valid EVM recipient.",
  );
  if (requestedWallet && !sameAddress(recipient, requestedWallet)) {
    throw new RewardClaimVerificationError(
      "CLAIM_WALLET_MISMATCH",
      "Connected wallet does not match the Normal Battle entitlement recipient.",
      409,
    );
  }

  const sourceId = String(row?.source_id || "").trim();
  if (!sourceId) {
    throw new RewardClaimVerificationError(
      "BATTLE_SOURCE_ID_MISSING",
      "Normal Battle reward entitlement is missing its Battle/source identity.",
      409,
    );
  }

  const amount = String(row?.amount ?? "").trim();
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new RewardClaimVerificationError(
      "CLAIM_AMOUNT_MISMATCH",
      "Normal Battle reward entitlement amount is invalid.",
      409,
    );
  }

  const asset = String(row?.token_symbol || "").trim().toUpperCase();
  if (asset !== "BNB") {
    throw new RewardClaimVerificationError(
      "BATTLE_CLAIM_ASSET_MISMATCH",
      "BNB Normal Battle recovery requires a native BNB entitlement asset.",
      409,
    );
  }

  const metadata = readMeta(row);
  const contractBatchId = requireBytes32(
    firstString(metadata, ["contractBatchId", "merkleBatchId", "batchIdBytes32", "rewardBatchBytes32", "claimBatchBytes32"]),
    "CLAIM_BATCH_MISMATCH",
    "Normal Battle reward entitlement is missing a valid RewardDistributor batch id.",
  );
  const merkleRoot = requireBytes32(
    firstString(metadata, ["merkleRoot", "root", "claimRoot"]),
    "CLAIM_BATCH_ROOT_MISMATCH",
    "Normal Battle reward entitlement is missing a valid Merkle root.",
  );
  const distributorAddress = requireAddress(
    firstString(metadata, ["distributorAddress", "rewardDistributorAddress", "claimContractAddress", "contractAddress"]),
    "CLAIM_CONTRACT_MISMATCH",
    "Normal Battle reward entitlement is missing a valid RewardDistributor address.",
  );

  return {
    chainId,
    battleSourceId: sourceId,
    ...optionalIdentity(metadata),
    recipient,
    amount,
    asset,
    contractBatchId,
    merkleRoot,
    distributorAddress,
  };
}

export async function recoverBnbNormalBattleClaim({
  row,
  requestedChainId,
  requestedWallet,
  minConfirmations = 1,
  provider = null,
  allowProviderChainMismatch = false,
}) {
  const identity = bnbNormalBattleEntitlementIdentity(row, { requestedChainId, requestedWallet });
  const evidence = await recoverEvmRewardClaim({
    chainId: identity.chainId,
    walletAddress: identity.recipient,
    distributorAddress: identity.distributorAddress,
    batchId: identity.contractBatchId,
    amount: identity.amount,
    expectedMerkleRoot: identity.merkleRoot,
    claimableAt: row?.claimable_at || row?.created_at || null,
    minConfirmations,
    provider,
    allowProviderChainMismatch,
  });
  return {
    claimed: Boolean(evidence?.claimed),
    identity,
    evidence,
  };
}
