// Owner / internal wallets (founder, 2026-10-05: "Exclude all owner wallets from leagues and
// recruiters"): the indexer copy of the list, league settlement, recruiter credit and recruiter links.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
process.env.ABLY_API_KEY ||= "test:test";

const { OWNER_WALLETS, internalRecruiterLabel, isOwnerWallet, ownerWalletIndex, withoutOwnerRecipients } = await import("./ownerWallets.js");
const { creditRecruiterEarnings, internalExclusion } = await import("./creditRecruiterEarnings.js");
const { pokerPaidPlaces, pokerSplitRaw } = await import("./pokerPayout.js");
// @ts-ignore -- the API's canonical list, plain JS
const apiList = await import("../../../frontend/shared/ownerWallets.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYER = "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H";
const BNB_DEPLOYER = "0x1a367016f10b230e28cf1abda2594c47bf60fe34";
const USER = "CVqCRi5cRVKBriiEuwcWtbx8EJ7inFHhxagagJZjS5Cf";
const owners = ownerWalletIndex({});

test("the indexer list is the API list: same addresses, chains, labels, order", () => {
  assert.deepEqual(
    OWNER_WALLETS.map(({ address, chain, label }) => ({ address, chain, label })),
    apiList.OWNER_WALLETS.map(({ address, chain, label }: any) => ({ address, chain, label })),
  );
  const env = { OWNER_WALLETS: "3SyuXsZfQB3JCjGFTpzioswp8ZkVuf7QGVEYwF6k8nG2:t", MODERATION_INTERNAL_WALLETS: "0xABC0000000000000000000000000000000000001" };
  assert.deepEqual([...ownerWalletIndex(env).entries()], [...apiList.ownerWalletIndex(env).entries()]);
});

test("league settlement: owner rows leave the field, the next wallet moves up, places are counted on what remains", () => {
  const field = [DEPLOYER, "U1", BNB_DEPLOYER, "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9"].map((recipient, i) => ({ recipient, score: BigInt(100 - i), meta: {} }));
  const kept = withoutOwnerRecipients(field, owners);
  assert.deepEqual(kept.map((r) => r.recipient), ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9"]);
  // rank 1 is now U1; the poker field is 9, not 11, so the split is the one a 9-wallet field gets.
  const places = pokerPaidPlaces(kept.length, "weekly");
  assert.equal(places, 3);
  const pot = 1_000_000n;
  const split = pokerSplitRaw(pot, places);
  assert.equal(split.reduce((a, b) => a + b, 0n), pot);
  assert.ok(isOwnerWallet(DEPLOYER.toLowerCase(), owners));
});

test("finalizeEpochWinners filters owners before counting places and skips internal recruiters", () => {
  const src = fs.readFileSync(path.join(here, "../jobs/finalizeEpochWinners.ts"), "utf8");
  const filter = src.indexOf("top = withoutOwnerRecipients(top)");
  assert.ok(filter > 0);
  assert.ok(filter < src.indexOf("const pokerRanks = pokerPaidPlaces(top.length, period)"), "before the poker field is sized");
  assert.ok(src.indexOf("postedRootExists(chainId, period, epochStartIso)") < filter, "a posted root still freezes the epoch first");
  assert.match(src, /if \(await internalRecruiterLabel\(pool, standing\.recruiterId, owners\)\) continue;/);
});

function recruiterRow(row: Record<string, unknown>) {
  return { wallet_address: null, sol: null, bnb: null, evm: null, signup_wallet: null, payout: [], ...row };
}

test("internalRecruiterLabel: signup wallet (stored lowercased), signup metadata or a payout wallet that is ours", async () => {
  const db = (row: any) => ({ query: async () => ({ rows: row ? [recruiterRow(row)] : [] }) });
  assert.ok(await internalRecruiterLabel(db({ wallet_address: "hukfofuuwxc5qfzxzr5dbax4s7w4vjuw8ahv9ld4c2j9" }), 114, owners));
  assert.ok(await internalRecruiterLabel(db({ wallet_address: "x", sol: "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB" }), 124, owners));
  assert.ok(await internalRecruiterLabel(db({ wallet_address: "x", payout: [BNB_DEPLOYER] }), 900, owners));
  assert.equal(await internalRecruiterLabel(db({ wallet_address: USER, payout: [USER] }), 126, owners), null);
  assert.equal(await internalRecruiterLabel(db(null), 1, owners), null);
});

// A fake db for creditRecruiterEarnings: one reward_events slice, a link to `recruiterId`, and that
// recruiter's wallets. Records every write.
function creditDb({ wallet, recruiterId, recruiter }: { wallet: string; recruiterId: number; recruiter: Record<string, unknown> }) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const answer = async (sql: string, params: unknown[] = []) => {
    if (/^\s*insert|^\s*update/i.test(sql)) {
      writes.push({ sql, params });
      return { rows: sql.includes("returning") ? [{ id: "fee-1", recruiter_id: "acct-1" }] : [], rowCount: 1 };
    }
    if (sql.includes("from public.reward_events re")) {
      return { rows: [{ chain_id: 101, tx_hash: "sig1", log_index: 3, occurred_at: new Date("2026-10-05T00:00:00Z"), wallet_address: wallet, campaign_address: "camp", route_kind: "trade", route_profile: "p", raw_amount: "1000", recruiter_amount: "125", fee_event_id: null }] };
    }
    if (sql.includes("from public.wallet_recruiter_links")) return { rows: [{ recruiter_id: recruiterId }] };
    if (sql.includes("left join public.recruiter_accounts a on a.code = r.code")) return { rows: [recruiterRow(recruiter)] };
    if (sql.includes("from public.recruiters where id")) return { rows: [{ id: recruiterId, wallet_address: recruiter.wallet_address, code: "c", display_name: "c" }] };
    return { rows: [] };
  };
  return { writes, query: answer, connect: async () => ({ query: answer, release() {} }) } as any;
}

test("recruiter credit: a trade by one of our wallets credits nobody and is recorded once as excluded", async () => {
  const db = creditDb({ wallet: DEPLOYER, recruiterId: 126, recruiter: { wallet_address: USER } });
  const summary = await creditRecruiterEarnings({ chainIds: [101], db });
  assert.equal(summary.credited, 0);
  assert.equal(summary.excluded, 1);
  assert.equal(summary.excludedRaw.solana, "125");
  assert.ok(!db.writes.some((w: any) => w.sql.includes("recruiter_reward_ledger")), "no ledger row");
  const fee = db.writes.find((w: any) => w.sql.includes("insert into public.recruiter_fee_events"));
  assert.ok(fee, "slice recorded");
  assert.equal(fee.params.length, 7);
  assert.match(fee.sql, /values \(null, .*'failed'/s);
  assert.match(String(fee.params[6]), /earning wallet is ours/);
});

test("recruiter credit: an internal recruiter (signup wallet is ours) earns nothing from a real user's trade", async () => {
  const db = creditDb({ wallet: USER, recruiterId: 114, recruiter: { wallet_address: "hukfofuuwxc5qfzxzr5dbax4s7w4vjuw8ahv9ld4c2j9" } });
  const summary = await creditRecruiterEarnings({ chainIds: [101], db });
  assert.equal(summary.credited, 0);
  assert.equal(summary.excluded, 1);
  assert.ok(!db.writes.some((w: any) => w.sql.includes("recruiter_reward_ledger")));
  assert.match(String(db.writes[0].params[6]), /recruiter 114 is internal/);
});

test("recruiter credit: an ordinary recruiter is still credited exactly as before", async () => {
  const db = creditDb({ wallet: USER, recruiterId: 126, recruiter: { wallet_address: USER } });
  const summary = await creditRecruiterEarnings({ chainIds: [101], db });
  assert.equal(summary.excluded, 0);
  assert.equal(summary.credited, 1);
  assert.ok(db.writes.some((w: any) => w.sql.includes("insert into public.recruiter_reward_ledger")));
});

test("recruiter credit: excluded slices are not retried (only unattributed ones are), dry run writes nothing", async () => {
  const src = fs.readFileSync(path.join(here, "creditRecruiterEarnings.ts"), "utf8");
  assert.match(src, /and \(f\.id is null or \(f\.recruiter_id is null and f\.claim_status <> 'failed'\)\)/);
  const db = creditDb({ wallet: DEPLOYER, recruiterId: 126, recruiter: { wallet_address: USER } });
  const summary = await creditRecruiterEarnings({ chainIds: [101], db, dryRun: true });
  assert.equal(summary.excluded, 1);
  assert.equal(db.writes.length, 0);
  assert.equal(await internalExclusion({ query: async () => ({ rows: [] }) } as any, { recruiterId: null, wallet: USER }, owners), null);
});

test("recruiter links (attribution.ts): an owner wallet or an internal recruiter is refused before anything is written", () => {
  const src = fs.readFileSync(path.join(here, "attribution.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function linkWalletToRecruiterDb"), src.indexOf("export async function linkWalletToRecruiter("));
  const refusal = fn.indexOf("INTERNAL_WALLET_NOT_LINKABLE");
  assert.ok(refusal > 0);
  assert.ok(fn.includes("INTERNAL_RECRUITER_NOT_LINKABLE"));
  assert.ok(refusal < fn.indexOf("ensureWalletProfileDb(db, walletAddress"), "before the first write");
  assert.ok(refusal < fn.indexOf("insert into public.wallet_recruiter_links"));
});
