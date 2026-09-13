import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";

function normalizeAddress(value) {
  return getAddress(String(value));
}

function bigint(value) {
  return BigInt(value ?? 0);
}

function appendSnapshot(file, snapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`, "utf8");
}

export async function captureBsc97LiveBalanceEvidence({
  provider,
  senderAddress,
  contractAddress,
  sendTransaction,
  evidenceFile = process.env.AGENT5_BSC97_BALANCE_EVIDENCE_FILE,
  kind = "claim",
}) {
  if (!provider || typeof provider.getBalance !== "function") throw new Error("balance evidence provider is required");
  if (typeof sendTransaction !== "function") throw new Error("balance evidence sendTransaction callback is required");
  if (!evidenceFile) throw new Error("AGENT5_BSC97_BALANCE_EVIDENCE_FILE is required");

  const sender = normalizeAddress(senderAddress);
  const contract = normalizeAddress(contractAddress);

  const beforeObservedBlock = Number(await provider.getBlockNumber());
  const [senderBefore, contractBefore] = await Promise.all([
    provider.getBalance(sender),
    provider.getBalance(contract),
  ]);

  const tx = await sendTransaction();
  const receipt = await tx.wait();

  const afterObservedBlock = Number(await provider.getBlockNumber());
  const [senderAfter, contractAfter] = await Promise.all([
    provider.getBalance(sender),
    provider.getBalance(contract),
  ]);

  const gasPrice = bigint(receipt?.gasPrice ?? receipt?.effectiveGasPrice ?? tx?.gasPrice ?? 0n);
  const gasUsed = bigint(receipt?.gasUsed ?? 0n);
  const snapshot = {
    schemaVersion: 1,
    kind,
    txHash: String(receipt?.hash || tx?.hash || ""),
    sender,
    contractAddress: contract,
    before: {
      sampledAt: new Date().toISOString(),
      observedBlockNumber: beforeObservedBlock,
      senderBalanceWei: String(senderBefore),
      contractBalanceWei: String(contractBefore),
    },
    after: {
      sampledAt: new Date().toISOString(),
      observedBlockNumber: afterObservedBlock,
      settlementBlockNumber: Number(receipt?.blockNumber ?? 0),
      senderBalanceWei: String(senderAfter),
      contractBalanceWei: String(contractAfter),
    },
    gasUsedWeiUnits: String(gasUsed),
    gasPriceWei: String(gasPrice),
    gasCostWei: String(gasUsed * gasPrice),
  };

  if (!snapshot.txHash) throw new Error("balance evidence transaction hash is unavailable");
  appendSnapshot(evidenceFile, snapshot);
  return { tx, receipt, snapshot };
}

export function loadBsc97LiveBalanceEvidence(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  const records = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return new Map(records.map((record) => [String(record.txHash).toLowerCase(), record]));
}

export function buildBsc97ObservedBalanceProof({ snapshot, txHash, blockNumber, contractAddress, recipient, amount }) {
  const normalizedTxHash = String(txHash || "");
  const normalizedRecipient = normalizeAddress(recipient);
  const normalizedContract = normalizeAddress(contractAddress);
  const expectedAmount = bigint(amount);

  const unavailable = (reason) => ({
    available: false,
    reason,
    txHash: normalizedTxHash,
    blockNumber: Number(blockNumber ?? 0),
    recipient: normalizedRecipient,
    amountWei: String(expectedAmount),
  });

  if (!snapshot) return unavailable("before_balance_not_sampled_before_transaction");
  if (String(snapshot.txHash || "").toLowerCase() !== normalizedTxHash.toLowerCase()) return unavailable("transaction_snapshot_mismatch");
  if (normalizeAddress(snapshot.sender) !== normalizedRecipient) return unavailable("recipient_before_balance_not_sampled_before_transaction");
  if (normalizeAddress(snapshot.contractAddress) !== normalizedContract) return unavailable("contract_before_balance_not_sampled_before_transaction");

  const recipientBefore = bigint(snapshot.before?.senderBalanceWei);
  const recipientAfter = bigint(snapshot.after?.senderBalanceWei);
  const contractBefore = bigint(snapshot.before?.contractBalanceWei);
  const contractAfter = bigint(snapshot.after?.contractBalanceWei);
  const gasCost = bigint(snapshot.gasCostWei);
  const recipientNetCredit = recipientAfter - recipientBefore + gasCost;
  const contractDebit = contractBefore - contractAfter;

  assert.equal(recipientNetCredit, expectedAmount, `recipient credit mismatch for ${normalizedTxHash}`);
  assert.equal(contractDebit, expectedAmount, `contract debit mismatch for ${normalizedTxHash}`);

  return {
    available: true,
    method: "live_pre_tx_and_post_settlement_samples",
    txHash: normalizedTxHash,
    blockNumber: Number(blockNumber ?? snapshot.after?.settlementBlockNumber ?? 0),
    recipient: normalizedRecipient,
    amountWei: String(expectedAmount),
    beforeObservedBlockNumber: Number(snapshot.before?.observedBlockNumber ?? 0),
    afterObservedBlockNumber: Number(snapshot.after?.observedBlockNumber ?? 0),
    settlementBlockNumber: Number(snapshot.after?.settlementBlockNumber ?? 0),
    recipientBalanceBeforeWei: String(recipientBefore),
    recipientBalanceAfterWei: String(recipientAfter),
    gasCostWei: String(gasCost),
    recipientNetCreditWei: String(recipientNetCredit),
    contractBalanceBeforeWei: String(contractBefore),
    contractBalanceAfterWei: String(contractAfter),
    contractDebitWei: String(contractDebit),
  };
}
