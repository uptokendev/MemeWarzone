import { buildBnbBondingProtocolRevenuePosting } from "./financeBondingRevenue.js";
import { selectPendingBnbBondingProtocolRevenue } from "./financeBondingRevenueBackfill.js";

function rowId(row) {
  const value = row?.id;
  return Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown validation error");
}

export async function dryRunBnbBondingProtocolRevenueBackfill(db, options = {}) {
  const rows = await selectPendingBnbBondingProtocolRevenue(db, options);
  const items = [];
  let eligible = 0;
  let invalid = 0;

  for (const row of rows) {
    try {
      const posting = buildBnbBondingProtocolRevenuePosting(row, {
        networkKey: options.networkKey,
        deploymentGeneration: options.deploymentGeneration,
        expectedSourceContract: options.expectedSourceContract,
        decoderVersion: options.decoderVersion,
        policyVersion: options.policyVersion,
        finalizedAt: options.finalizedAt,
      });

      eligible += 1;
      items.push({
        rewardEventId: rowId(row),
        status: "eligible",
        transactionRef: posting.evidence.transactionRef,
        eventIndex: posting.evidence.eventIndex,
        protocolAmountRaw: posting.evidence.grossAmountRaw,
        economicLane: posting.classifications[0]?.economicLane || null,
      });
    } catch (error) {
      invalid += 1;
      items.push({
        rewardEventId: rowId(row),
        status: "invalid",
        error: errorMessage(error),
      });
    }
  }

  return {
    mode: "dry-run",
    chainId: Number(options.chainId),
    networkKey: String(options.networkKey || ""),
    deploymentGeneration: String(options.deploymentGeneration || ""),
    selected: rows.length,
    eligible,
    invalid,
    items,
  };
}
