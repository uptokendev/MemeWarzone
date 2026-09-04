/** 4c.1: tournament start roster. Paid buy-in is required when buy_in_native > 0. */

export function tournamentStartRoster(entries, { buyInNative } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const buyIn = Number(buyInNative || 0);
  if (!(buyIn > 0)) {
    return { ok: true, reason: "no-buy-in", roster: list, unpaid: [] };
  }
  const unpaid = list.filter((entry) => entry?.buyInPaid !== true);
  if (unpaid.length) {
    return {
      ok: false,
      reason: "unpaid-roster",
      roster: [],
      unpaid,
    };
  }
  return { ok: true, reason: "paid", roster: list, unpaid: [] };
}
