/**
 * D22: what a creator accepts by pairing a DBC coin with a stock token. Issuer powers come from the
 * mint as read now (`armed` true = the authority is set today); the rest hold for any stock pairing.
 */
export function dbcStockRisks(symbol, powers = {}) {
  const s = String(symbol || "the stock token");
  const set = (value) => (value == null ? null : Boolean(value));
  return [
    {
      code: "price",
      severity: "info",
      armed: null,
      title: `Your coin is priced in ${s}`,
      detail: `Buyers pay in ${s} and sellers receive ${s}. When the stock falls, your coin is worth fewer dollars even if nobody sells.`,
    },
    {
      code: "pause",
      severity: "high",
      armed: set(powers.pauseAuthority),
      title: `The issuer can pause ${s}`,
      detail: "While it is paused nobody can buy or sell your coin on the curve, and it cannot graduate until the pause is lifted.",
    },
    {
      code: "hook",
      severity: "high",
      armed: set(powers.hookAuthority),
      title: "The issuer can switch on a transfer check",
      detail: `If it does, the curve and the pool can no longer move ${s}, so trading stops until it is switched off.`,
    },
    {
      code: "delegate",
      severity: "high",
      armed: set(powers.permanentDelegate),
      title: `The issuer can move ${s} out of any account`,
      detail: `That includes the curve and the graduated pool, which hold your coin's ${s}.`,
    },
    {
      code: "freeze",
      severity: "high",
      armed: set(powers.freezeAuthority),
      title: `The issuer can freeze ${s} accounts`,
      detail: "A frozen account cannot send or receive the token. USDC has the same power.",
    },
    {
      code: "locked",
      severity: "info",
      armed: null,
      title: "The pool is locked for good",
      detail: `After graduation the liquidity cannot be withdrawn, and the pairing with ${s} never changes.`,
    },
    {
      code: "checked",
      severity: "info",
      armed: null,
      title: "Checked at launch and before graduation",
      detail: `We check that ${s} is not paused and has no transfer check or fee when you launch and again just before graduation. We cannot stop the issuer from changing that later.`,
    },
  ];
}

/** Demote a power nobody holds today to info, so an unset power does not read like a set one. */
export function dbcStockRiskSeverity(risk) {
  return risk.armed === false ? "info" : risk.severity;
}
