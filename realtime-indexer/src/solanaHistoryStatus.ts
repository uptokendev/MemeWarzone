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

/**
 * Head catch-up for a campaign whose history walk is complete.
 *
 * The history walk runs once, from the newest signature down to creation, and then only resumes
 * *below* its oldest cursor. New trades rely on the live tip listener. When that listener loses
 * trades (2026-09-25: the DB pool starved and KAIJU88's first seven trades were never stored), a
 * "complete" campaign was skipped forever and the gap never healed. The repair pass now asks the
 * chain for the campaign's newest signature and, if it is newer than the last slot covered, scans
 * down to that slot again (ingestion is deduplicated, so re-seen trades are no-ops).
 *
 * A campaign completed before this existed has no headSlot yet: its first catch-up scans down to
 * creation once, then records the head.
 */
export function headCatchUpPlan(input: {
  headSlot?: number | null;
  creationSlot?: number | null;
  newestSlot?: number | null;
}): { run: boolean; floorSlot: number; reason: string } {
  const newest = Number(input.newestSlot || 0);
  const head = Number(input.headSlot || 0);
  const creation = Number(input.creationSlot || 0);
  if (!(newest > 0)) return { run: false, floorSlot: head || creation, reason: "no-signatures" };
  if (head > 0) {
    return newest > head
      ? { run: true, floorSlot: head, reason: "new-signatures" }
      : { run: false, floorSlot: head, reason: "up-to-date" };
  }
  return { run: true, floorSlot: creation > 0 ? creation : 0, reason: "first-catch-up" };
}
