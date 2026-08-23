export type SolanaRepairState = "complete" | "incomplete" | "repairing" | "unknown";

export type SolanaHistoryStatus = {
  historyComplete: boolean;
  lastIndexedSlot: number | null;
  creationSlot: number | null;
  repairState: SolanaRepairState;
};

export function deriveSolanaHistoryComplete(input: {
  leaseRunning: boolean;
  storedHistoryComplete?: boolean | null;
  storedRepairState?: string | null;
}): { historyComplete: boolean; repairState: SolanaRepairState } {
  if (input.leaseRunning) {
    return { historyComplete: false, repairState: "repairing" };
  }
  const stored = String(input.storedRepairState || "").toLowerCase();
  if (stored === "complete" && input.storedHistoryComplete === true) {
    return { historyComplete: true, repairState: "complete" };
  }
  if (stored === "incomplete") {
    return { historyComplete: false, repairState: "incomplete" };
  }
  return { historyComplete: false, repairState: "unknown" };
}

export function repairStateFromBackfill(result: {
  skipped?: boolean;
  incomplete?: boolean;
  failed?: number;
  reachedCreationSlot?: boolean;
}): { historyComplete: boolean; repairState: SolanaRepairState } | null {
  if (result.skipped) return null;
  const complete =
    result.reachedCreationSlot === true &&
    result.incomplete !== true &&
    Number(result.failed || 0) === 0;
  return {
    historyComplete: complete,
    repairState: complete ? "complete" : "incomplete",
  };
}
