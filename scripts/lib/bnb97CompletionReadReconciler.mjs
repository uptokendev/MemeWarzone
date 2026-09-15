export function completionStateIsFinalized(state) {
  return Boolean(
    state &&
      state.launched === true &&
      state.graduationPending === false &&
      state.dexPair &&
      state.dexPair !== "0x0000000000000000000000000000000000000000" &&
      state.pool &&
      state.pool !== "0x0000000000000000000000000000000000000000" &&
      state.factoryGraduationRecorded === true,
  );
}

export async function reconcileCompletionReadAfterWrite({
  receiptBlockNumber,
  receiptBlockHash,
  finalizedEvent,
  readAtBlock,
  readLatest,
  getBlockHash,
  waitForConfirmations,
  maxConfirmations = 3,
}) {
  if (!finalizedEvent) throw new Error("completion receipt missing CampaignFinalized");
  if (!Number.isInteger(receiptBlockNumber) || receiptBlockNumber < 0) throw new Error("completion receipt blockNumber invalid");
  if (!receiptBlockHash) throw new Error("completion receipt blockHash missing");

  const canonicalHashBefore = await getBlockHash(receiptBlockNumber);
  if (!canonicalHashBefore || canonicalHashBefore.toLowerCase() !== receiptBlockHash.toLowerCase()) {
    throw new Error("completion receipt block is not canonical");
  }

  const receiptBlockState = await readAtBlock(receiptBlockNumber);
  if (receiptBlockState.launched !== true || receiptBlockState.graduationPending !== false) {
    throw new Error("canonical receipt-block state contradicts CampaignFinalized");
  }
  if (!completionStateIsFinalized(receiptBlockState)) {
    throw new Error("canonical receipt-block completion state is incomplete");
  }

  let latestState = await readLatest();
  let endpointLagObserved = !completionStateIsFinalized(latestState);
  let confirmationsObserved = 1;

  if (endpointLagObserved) {
    for (let confirmations = 2; confirmations <= maxConfirmations; confirmations += 1) {
      await waitForConfirmations(confirmations);
      confirmationsObserved = confirmations;
      const canonicalHashNow = await getBlockHash(receiptBlockNumber);
      if (!canonicalHashNow || canonicalHashNow.toLowerCase() !== receiptBlockHash.toLowerCase()) {
        throw new Error("completion receipt block changed during confirmation reconciliation");
      }
      latestState = await readLatest();
      if (completionStateIsFinalized(latestState)) break;
    }
  }

  const canonicalHashAfter = await getBlockHash(receiptBlockNumber);
  if (!canonicalHashAfter || canonicalHashAfter.toLowerCase() !== receiptBlockHash.toLowerCase()) {
    throw new Error("completion receipt block changed after reconciliation");
  }
  if (!completionStateIsFinalized(latestState)) {
    throw new Error("latest RPC state did not converge to canonical completion state");
  }

  return {
    receiptBlockState,
    latestState,
    endpointLagObserved,
    confirmationsObserved,
    canonicalBlockHash: canonicalHashAfter,
  };
}
