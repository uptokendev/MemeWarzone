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

function sol(lamports) {
  const value = Number(BigInt(String(lamports || 0))) / 1e9;
  return value >= 1 ? value.toFixed(2) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function whole(raw, decimals = 6) {
  return Math.floor(Number(BigInt(String(raw || 0))) / 10 ** decimals).toLocaleString("en-US");
}

/**
 * One plain line about where this coin's creator fees go, with what has been paid so far when the
 * totals are given (step 5b). Trading fees on the curve and LP fees after graduation both count.
 */
export function feeChoiceLine({ feeChoice, creatorSharePct, totals } = {}) {
  const choice = String(feeChoice || "").trim().toLowerCase();
  const t = totals || {};
  if (choice === "split") {
    const creator = Number(creatorSharePct);
    const pct = Number.isFinite(creator) ? Math.trunc(creator) : 0;
    const base = `Split: ${pct}% to the creator, ${100 - pct}% to holders`;
    return totals ? `${base}. Paid so far: ${sol(t.creatorLamports)} SOL to the creator, ${sol(t.holdersLamports)} SOL to holders.` : base;
  }
  if (choice === "holders") {
    return totals
      ? `Holders: ${sol(t.holdersLamports)} SOL paid to holders so far, next payout Monday.`
      : "Holders: creator fees go to holders each week";
  }
  if (choice === "buyback") {
    return totals
      ? `Buyback: ${sol(t.buybackLamports)} SOL bought and ${whole(t.tokensBurned)} tokens burned so far.`
      : "Buyback: creator fees buy the coin back and burn it";
  }
  return null;
}
