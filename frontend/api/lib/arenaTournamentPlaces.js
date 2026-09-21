/**
 * Tournament places policy: how many paid places a tournament has and who
 * fills them, derived from the finished bracket.
 *
 * Founder rule (2026-09-21): a tournament with many participants should pay a
 * 1st, a 2nd and a small runner-up prize instead of winner-takes-all. The
 * thresholds below are the initial setting and are meant to be tuned; the
 * programs on both chains accept any 1-3 places whose bps sum to 10000.
 *
 *   < 8 entrants   -> winner takes all
 *   8 .. 15        -> 70 / 30
 *   16 and up      -> 60 / 30 / 10
 *
 * Ranking from a single-elimination bracket:
 *   1st  the winner of the final
 *   2nd  the loser of the final
 *   3rd  the semi-finalist who lost to the champion (the closest run), or,
 *        if that cannot be determined, the first semi-final loser in bracket
 *        order. Brackets without a semi-final round pay at most two places.
 */

export const PLACE_TIERS = Object.freeze([
  { minEntrants: 16, bps: [6_000, 3_000, 1_000] },
  { minEntrants: 8, bps: [7_000, 3_000] },
  { minEntrants: 0, bps: [10_000] },
]);

export function placesForEntrantCount(entrantCount) {
  const n = Number(entrantCount);
  if (!Number.isFinite(n) || n < 2) return [10_000];
  for (const tier of PLACE_TIERS) {
    if (n >= tier.minEntrants) return tier.bps.slice();
  }
  return [10_000];
}

function ident(value) {
  return String(value ?? "").trim();
}

function tokensEqual(a, b) {
  const x = ident(a);
  const y = ident(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // EVM addresses are case-insensitive; Solana keys are not.
  return /^0x/i.test(x) && /^0x/i.test(y) && x.toLowerCase() === y.toLowerCase();
}

function bracketRounds(bracket) {
  let value = bracket;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const rounds = Array.isArray(value?.rounds) ? value.rounds : Array.isArray(value) ? value : [];
  return rounds.map((round) => (Array.isArray(round?.matches) ? round.matches : []));
}

function loserOf(match) {
  const winner = ident(match?.winner);
  const a = ident(match?.tokenA ?? match?.token_a);
  const b = ident(match?.tokenB ?? match?.token_b);
  if (!winner) return "";
  if (tokensEqual(winner, a)) return b;
  if (tokensEqual(winner, b)) return a;
  return "";
}

/**
 * Ranked tokens [1st, 2nd, 3rd?] from a finished bracket, or [] when the
 * bracket is not terminal (no single decided final).
 */
export function rankTournamentPlaces(bracket) {
  const rounds = bracketRounds(bracket);
  if (!rounds.length) return [];
  const finalRound = rounds[rounds.length - 1];
  if (finalRound.length !== 1) return [];
  const final = finalRound[0];
  const champion = ident(final?.winner);
  if (!champion) return [];
  const a = ident(final?.tokenA ?? final?.token_a);
  const b = ident(final?.tokenB ?? final?.token_b);
  if (!tokensEqual(champion, a) && !tokensEqual(champion, b)) return [];
  const ranked = [champion];
  const runnerUp = loserOf(final);
  if (runnerUp) ranked.push(runnerUp);
  if (rounds.length >= 2) {
    const semis = rounds[rounds.length - 2];
    const losers = semis.map((match) => ({ loser: loserOf(match), winner: ident(match?.winner) })).filter((x) => x.loser);
    const closest = losers.find((x) => tokensEqual(x.winner, champion)) || losers[0];
    if (closest && !ranked.some((t) => tokensEqual(t, closest.loser))) ranked.push(closest.loser);
  }
  return ranked;
}

/**
 * Places ready for the program: [{ asset, wallet, bps }], joined to the
 * tournament's entries for owner wallets. Fewer ranked tokens than the tier
 * allows collapses to the places that exist (bps re-normalized so the last
 * paid place absorbs the rest). Returns { ok:false, reason } when a ranked
 * token has no paid entry.
 */
export function buildTournamentPlaces({ bracket, entries, entrantCount }) {
  const ranked = rankTournamentPlaces(bracket);
  if (!ranked.length) return { ok: false, reason: "bracket-not-terminal" };
  const tiers = placesForEntrantCount(entrantCount ?? (Array.isArray(entries) ? entries.length : 0));
  const count = Math.min(tiers.length, ranked.length);
  const bps = tiers.slice(0, count);
  const dropped = tiers.slice(count).reduce((sum, v) => sum + v, 0);
  if (dropped) bps[bps.length - 1] += dropped;
  const places = [];
  for (let i = 0; i < count; i += 1) {
    const token = ranked[i];
    const entry = (entries || []).find((e) => tokensEqual(e.token_address ?? e.tokenAddress, token));
    const wallet = ident(entry?.owner_wallet ?? entry?.ownerWallet);
    if (!entry || !wallet) return { ok: false, reason: `no-paid-entry-for-place-${i + 1}` };
    if (places.some((p) => tokensEqual(p.wallet, wallet))) return { ok: false, reason: `duplicate-wallet-at-place-${i + 1}` };
    places.push({ asset: token, wallet, bps: bps[i] });
  }
  if (places.reduce((sum, p) => sum + p.bps, 0) !== 10_000) return { ok: false, reason: "bps-not-10000" };
  return { ok: true, places, ranked };
}
