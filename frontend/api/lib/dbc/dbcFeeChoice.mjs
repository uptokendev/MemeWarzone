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

export function feeChoiceLine({ feeChoice, creatorSharePct } = {}) {
  const choice = String(feeChoice || "").trim().toLowerCase();
  if (choice === "split") {
    const creator = Number(creatorSharePct);
    const pct = Number.isFinite(creator) ? Math.trunc(creator) : 0;
    return `Split: ${pct}% to the creator, ${100 - pct}% to holders`;
  }
  if (choice === "holders") return "Holders: LP fees go to holders each week";
  if (choice === "buyback") return "Buyback: LP fees are bought back and burned";
  return null;
}
