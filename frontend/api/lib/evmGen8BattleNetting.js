/**
 * Wash netting for battle volume on generation 8 coins (audit D-L2).
 *
 * A gen-8 swap needs no capital to repeat inside one transaction: buy and sell in the same transaction cost only
 * the fee and would count twice as battle volume. loadBattleWindowTrades (arenaBattleMetrics.js) passes a gen-8
 * coin's window trades through netGen8BattleTrades: all legs of one transaction by one wallet (tx.from, the
 * market_trades_v wallet for both the bonding rows and the gen8_v4 dex rows) become one trade of the net amount.
 *
 *   net native = sum(buy nativeAmount) - sum(sell nativeAmount) (integer raw); net USD the same over usdAmount
 *   side       = the sign of the net native amount (of the net USD when a leg has no native amount)
 *   amounts    = the absolute nets; a net of 0 leaves no trade
 *   valuation  = unhealthy (usdAmount null) when any leg is unhealthy, so the netted trade is excluded as unpriced
 *   identity   = the last leg (highest logIndex): txHash, logIndex, blockTime, recipient, source, status, quote fields
 *
 * A transaction with one leg is returned as the same object. Only called for gen-8 coins on chains where gen-8 is
 * configured, so no other coin's battle volume changes.
 */

function walletKey(value) {
  return String(value || "").trim().toLowerCase();
}

function sideSign(trade) {
  return String(trade?.side || "").toLowerCase() === "sell" ? -1n : 1n;
}

function rawBigInt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

function logIndexOf(trade) {
  const n = Number(trade?.logIndex ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function netGroup(legs) {
  const last = legs.reduce((a, b) => (logIndexOf(b) >= logIndexOf(a) ? b : a));
  let nativeNet = 0n;
  let nativeKnown = true;
  let usdNet = 0;
  let usdKnown = true;
  for (const leg of legs) {
    const sign = sideSign(leg);
    const raw = rawBigInt(leg.nativeAmount);
    if (raw === null) nativeKnown = false;
    else nativeNet += sign * raw;
    const usd = leg.usdAmount === null || leg.usdAmount === undefined ? null : Number(leg.usdAmount);
    if (leg.valuationHealthy === false || usd === null || !Number.isFinite(usd)) usdKnown = false;
    else usdNet += Number(sign) * usd;
  }
  const signOfNet = nativeKnown ? (nativeNet > 0n ? 1 : nativeNet < 0n ? -1 : 0) : (usdKnown ? Math.sign(usdNet) : 0);
  if (signOfNet === 0) return null;
  return {
    ...last,
    side: signOfNet > 0 ? "buy" : "sell",
    nativeAmount: nativeKnown ? (nativeNet < 0n ? -nativeNet : nativeNet).toString() : null,
    usdAmount: usdKnown ? Math.abs(usdNet) : null,
    valuationHealthy: usdKnown,
    valuationSource: usdKnown ? last.valuationSource : "gen8_netted_leg_unpriced",
    nettedLegs: legs.length,
  };
}

/** Nets the legs of each (txHash, wallet) group; keeps the order of each group's first leg. */
export function netGen8BattleTrades(trades = []) {
  const groups = new Map();
  const order = [];
  for (const trade of trades) {
    const tx = String(trade?.txHash || "").toLowerCase();
    const key = tx ? `${tx}|${walletKey(trade?.wallet)}` : null;
    if (!key) {
      order.push({ single: trade });
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push({ key });
    }
    groups.get(key).push(trade);
  }
  const out = [];
  for (const item of order) {
    if (item.single) {
      out.push(item.single);
      continue;
    }
    const legs = groups.get(item.key);
    if (legs.length === 1) {
      out.push(legs[0]);
      continue;
    }
    const netted = netGroup(legs);
    if (netted) out.push(netted);
  }
  return out;
}
