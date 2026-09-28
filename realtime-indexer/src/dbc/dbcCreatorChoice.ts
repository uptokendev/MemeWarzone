/**
 * DBC step 5b (D5, D19): paying out the creator-fee choice of platform coins.
 * Pure rules only: weeks, the committed secret, the snapshot and buyback moments, the split and the
 * holder allocation. Chain and database work is in dbcCreatorPayouts.ts.
 */
import crypto from "node:crypto";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** Same week as the airdrop runner (frontend/scripts/weekly-airdrop/config.mjs epochWindow): Monday 00:00 UTC. */
export function weekOf(at: Date): { weekId: string; start: Date; end: Date } {
  const start = new Date(at);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() + (day === 0 ? -6 : 1 - day));
  start.setUTCHours(0, 0, 0, 0);
  return { weekId: start.toISOString().slice(0, 10), start, end: new Date(start.getTime() + WEEK_MS) };
}

/** The week just finished, as the Monday run sees it. */
export function previousWeek(now: Date) {
  return weekOf(new Date(now.getTime() - WEEK_MS));
}

/**
 * One secret per week, derived from DBC_BUYBACK_SEED_SECRET. Its sha256 is published before the week
 * starts and the week secret itself after the week ends, so anyone can check every moment afterwards.
 */
export function weekSecret(masterSecret: string, weekId: string): string {
  if (!masterSecret) throw new Error("DBC_BUYBACK_SEED_SECRET is required");
  return crypto.createHmac("sha256", masterSecret).update(`dbc-week:${weekId}`).digest("hex");
}

export function weekCommitment(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function moment(secret: string, label: string, windowStartMs: number, windowMs: number): Date {
  const digest = crypto.createHmac("sha256", secret).update(label).digest();
  const offset = Number(digest.readBigUInt64BE(0) % BigInt(windowMs));
  return new Date(windowStartMs + offset);
}

/** The moment in the week when holder balances are read. */
export function snapshotMoment(secret: string, weekStart: Date): Date {
  return moment(secret, "holders-snapshot", weekStart.getTime(), WEEK_MS);
}

/** Up to perDay buy moments for one coin on one day, sorted. */
export function buybackMoments(secret: string, pool: string, day: Date, perDay: number): Date[] {
  const dayStart = new Date(day);
  dayStart.setUTCHours(0, 0, 0, 0);
  const key = dayStart.toISOString().slice(0, 10);
  const out: Date[] = [];
  for (let i = 0; i < perDay; i += 1) out.push(moment(secret, `buyback:${pool}:${key}:${i}`, dayStart.getTime(), DAY_MS));
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Split: the creator's percent of the unpaid pot; the rest goes to holders. */
export function splitShares(unpaid: bigint, creatorSharePct: number): { creator: bigint; holders: bigint } {
  if (unpaid < 0n) throw new Error("unpaid creator pot is negative");
  const pct = BigInt(Math.trunc(creatorSharePct));
  if (pct < 1n || pct > 99n) throw new Error(`split creator share must be 1..99, got ${creatorSharePct}`);
  const creator = (unpaid * pct) / 100n;
  return { creator, holders: unpaid - creator };
}

export type HolderBalance = { owner: string; amount: bigint };

/** Pro rata by balance, floor, remainder to the largest holder. Shares add up to the pot exactly. */
export function allocateToHolders(pot: bigint, balances: HolderBalance[]): Map<string, bigint> {
  const shares = new Map<string, bigint>();
  const held = balances.filter((b) => b.amount > 0n);
  const supply = held.reduce((sum, b) => sum + b.amount, 0n);
  if (pot <= 0n || supply <= 0n) return shares;
  const raw = held
    .map((b) => ({ owner: b.owner, share: (pot * b.amount) / supply, amount: b.amount }))
    .sort((a, b) => (b.amount === a.amount ? a.owner.localeCompare(b.owner) : b.amount > a.amount ? 1 : -1));
  raw[0].share += pot - raw.reduce((sum, r) => sum + r.share, 0n);
  for (const r of raw) if (r.share > 0n) shares.set(r.owner, (shares.get(r.owner) || 0n) + r.share);
  return shares;
}

/**
 * One leaf per wallet across every coin that pays holders this week, and the minimum applied to that
 * total (a claim's receipt rent would exceed a smaller prize). A wallet below it gets nothing this
 * week; its shares are not handed to others, they stay unpaid in each coin's pot and roll over.
 */
export function holderLeaves(perCoin: Map<string, Map<string, bigint>>, minPayout: bigint): {
  leaves: Map<string, bigint>;
  paidByPool: Map<string, bigint>;
} {
  const totals = new Map<string, bigint>();
  for (const shares of perCoin.values()) for (const [owner, amount] of shares) totals.set(owner, (totals.get(owner) || 0n) + amount);
  const leaves = new Map<string, bigint>();
  for (const [owner, amount] of totals) if (amount >= minPayout) leaves.set(owner, amount);
  const paidByPool = new Map<string, bigint>();
  for (const [pool, shares] of perCoin) {
    let paid = 0n;
    for (const [owner, amount] of shares) if (leaves.has(owner)) paid += amount;
    paidByPool.set(pool, paid);
  }
  return { leaves, paidByPool };
}

export function isPlatformChoice(choice: string | null | undefined): boolean {
  const value = String(choice || "keep").trim().toLowerCase();
  return value === "holders" || value === "split" || value === "buyback";
}
