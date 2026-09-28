/**
 * D5: keep -> creator-fee config; holders / split / buyback -> platform config.
 */
export const DBC_FEE_CHOICES = Object.freeze(["keep", "holders", "split", "buyback"]);

export function parseFeeChoice(choice, creatorSharePct) {
  const feeChoice = String(choice || "").trim().toLowerCase();
  if (!DBC_FEE_CHOICES.includes(feeChoice)) {
    return { ok: false, error: "creator fee choice must be keep, holders, split or buyback", code: "DBC_BAD_FEE_CHOICE" };
  }
  let share = null;
  if (feeChoice === "split") {
    const n = Number(creatorSharePct);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) {
      return { ok: false, error: "split needs a creator share percent between 1 and 99", code: "DBC_BAD_FEE_SHARE" };
    }
    share = Math.trunc(n);
  }
  return {
    ok: true,
    feeChoice,
    creatorSharePct: share,
    creatorFeeMode: feeChoice === "keep" ? "creator" : "platform",
  };
}
