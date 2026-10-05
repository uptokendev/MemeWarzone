import assert from "node:assert/strict";
import test from "node:test";

import {
  airdropStatus,
  atomicToDecimal,
  buildModerationDataset,
  explorerAddressUrl,
  explorerTxUrl,
  leagueStatus,
  moderationCsv,
  parseModerationQuery,
  queryModerationTab,
} from "./moderationLists.js";
import { INTERNAL_WALLETS, internalWalletIndex } from "./moderationInternalWallets.js";

const NOW = "2026-10-05T12:00:00.000Z";
const DEPLOYER = "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H";
const DEVNET = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
const WINNER = "8doLGRWZsKTGcAYg84PGo8agW4WaDdqQynByMnbtwG4R";
const TRADER = "DKMgH5hpqa1CjBkTCeTZNiJuc9K2LJzdVimhxyELzRyC";
const TEST_COIN = "Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA";
const SOL_TX = "3cKDvXaQRmzR7S8wyjrjrqmDHN2xNUGfzNHkdTvQmyJxRsS8ZBh8u6SDdeGZTdWURyVLB2VLkZyBhNZ4YPr3gugH";

function fixtures() {
  return {
    airdrops: [
      {
        id: "a1", reward_type: "airdrop", wallet_address: WINNER, chain: "101", token_symbol: "SOL", amount_raw: "121555160", status: "claimed",
        claim_tx_hash: SOL_TX, created_at: "2026-09-28T00:15:00Z", claimed_at: "2026-09-29T04:48:00Z",
        metadata: { program: "airdrop_creator", epochStart: "2026-09-21T00:00:00Z", winnerRank: 1, activityScore: 14.25, reasonCodes: ["CREATOR_ACTIVE_CAMPAIGN"], uniqueBuyers: 41, claimDeadline: 1795737600 },
        eligible_campaigns: [{ campaignAddress: TEST_COIN }],
        batch_id: "b1", batch_status: "claim_open", native_usd_at_draw: "121.84", batch_published_at: "2026-09-28T00:15:00Z",
      },
      {
        id: "a2", reward_type: "airdrop", wallet_address: TRADER, chain: "101", token_symbol: "SOL", amount_raw: "1000000000", status: "claimable",
        created_at: "2026-09-28T00:15:00Z",
        // Deadline three days out: expires soon.
        metadata: { program: "airdrop_trader", epochStart: "2026-09-21T00:00:00Z", winnerRank: 1, tradeCount: 4, claimDeadline: Math.floor(Date.parse("2026-10-08T00:00:00Z") / 1000) },
        batch_id: "b2", batch_status: "claim_open",
      },
    ],
    leagues: [
      { chain_id: 101, period: "weekly", epoch_start: "2026-09-21T00:00:00Z", epoch_end: "2026-09-28T00:00:00Z", category: "top_earner", rank: 1, recipient_address: DEPLOYER, amount_raw: "5000000", payload: { wallet: DEPLOYER, pnl_raw: "-1000" }, expires_at: "2026-12-28T00:00:00Z", root_at: "2026-09-28T00:15:00Z", claimed_at: "2026-09-29T00:00:00Z", pay_tx: SOL_TX },
      { chain_id: 101, period: "weekly", epoch_start: "2026-09-21T00:00:00Z", epoch_end: "2026-09-28T00:00:00Z", category: "crowd_favorite", rank: 1, recipient_address: WINNER, amount_raw: "7000000", payload: { wallet: WINNER, campaign_address: TEST_COIN, votes_count: 3, unique_voters: 2 }, expires_at: "2026-12-28T00:00:00Z", root_at: "2026-09-28T00:15:00Z" },
      { chain_id: 101, period: "weekly", epoch_start: "2026-09-21T00:00:00Z", epoch_end: "2026-09-28T00:00:00Z", category: "biggest_hit", rank: 1, recipient_address: WINNER, amount_raw: "3000000", payload: { wallet: WINNER, campaign_address: TEST_COIN }, expires_at: "2026-10-01T00:00:00Z", root_at: null },
      { chain_id: 56, period: "monthly", epoch_start: "2026-08-01T00:00:00Z", epoch_end: "2026-09-01T00:00:00Z", category: "top_earner", rank: 1, recipient_address: "0xaaaa000000000000000000000000000000000001", amount_raw: "1000000000000000", payload: { wallet: "0xbbbb000000000000000000000000000000000001" }, expires_at: "2026-11-30T00:00:00Z", root_at: null },
      { chain_id: 56, period: "monthly", epoch_start: "2026-08-01T00:00:00Z", epoch_end: "2026-09-01T00:00:00Z", category: "biggest_hit", rank: 1, recipient_address: "0xaaaa000000000000000000000000000000000001", amount_raw: "1000000000000000", payload: { wallet: "0xcccc000000000000000000000000000000000001" }, expires_at: "2026-11-30T00:00:00Z", root_at: null },
    ],
    recruiters: [
      { id: "114", wallet_address: DEVNET.toLowerCase(), code: "solkillers2", display_name: "Solkillers", is_og: false, status: "active", created_at: "2026-08-15T00:00:00Z", email: "owner@example.test", x_handle: "@sk", solana_wallet: null },
      { id: "124", wallet_address: "2amfraxs9182aeswwrz2trvuxpqxauot4wv1oavjstrb", code: "sol-soldiers", display_name: "SolSoldiers", is_og: false, status: "active", created_at: "2026-09-03T00:00:00Z", email: "owner@example.test" },
      { id: "29", wallet_address: "0x587f000000000000000000000000000000000001", code: "selfie", display_name: "Selfie", is_og: false, status: "active", created_at: "2026-04-01T00:00:00Z", email: "other@example.test" },
      { id: "40", wallet_address: "0x1050000000000000000000000000000000000001", code: "dupa", display_name: "Dup A", is_og: false, status: "active", created_at: "2026-07-01T00:00:00Z" },
    ],
    accounts: [
      { account_id: "acc-114", signup_wallet: DEVNET, code: "solkillers2", display_name: "Solkillers", status: "active", created_at: "2026-08-15T00:00:00Z" },
      { account_id: "acc-orphan", signup_wallet: "0x1050000000000000000000000000000000000001", code: "dupb", display_name: "Dup B", status: "active", created_at: "2026-07-01T00:00:00Z" },
    ],
    payoutWallets: [{ account_id: "acc-114", chain: "solana", wallet_address: DEVNET, verified_at: "2026-08-15T00:00:00Z" }],
    links: [
      { wallet_address: DEPLOYER, recruiter_id: "114", is_active: false, detached_at: "2026-10-04T18:26:44Z", linked_at: "2026-08-17T22:32:00Z", link_source: "referral_cookie" },
      { wallet_address: "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB", recruiter_id: "114", is_active: false, detached_at: "2026-10-04T18:26:44Z", linked_at: "2026-08-17T22:32:00Z" },
      { wallet_address: "0x587f000000000000000000000000000000000001", recruiter_id: "29", is_active: true, detached_at: null, linked_at: "2026-04-09T00:00:00Z" },
    ],
    ledger: [
      { id: "l1", account_id: "acc-114", chain: "solana", chain_id: 101, amount_raw: "671407", status: "failed", created_at: "2026-09-25T00:00:00Z", campaign: TEST_COIN, voided_reason: "founder self-referral test" },
      { id: "l2", account_id: "acc-114", chain: "solana", chain_id: 101, amount_raw: "10000", status: "claimable", created_at: "2026-08-20T00:00:00Z" },
      { id: "l3", account_id: "acc-114", chain: "bnb", chain_id: null, amount_raw: "5", status: "claimable", created_at: "2026-06-28T00:00:00Z" },
      { id: "l4", account_id: "acc-114", chain: "bnb", chain_id: 97, amount_raw: "5", status: "claimable", created_at: "2026-06-28T00:00:00Z" },
    ],
    claims: [],
    laneClaims: [],
    clusterMembers: [{ wallet_address: TRADER, cluster_id: "creator-funding:101:x", risk_level: "medium", restricted: false }],
    riskProfiles: [],
    campaigns: [{ chain_id: 101, campaign_address: TEST_COIN, token_address: null, name: "Kaiju88", symbol: "KJU", hidden: true }],
    profiles: [{ chain_id: 101, address: WINNER, display_name: "KAIJU88" }],
  };
}

function fakeDb(data = fixtures()) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      assert.match(sql.trim(), /^select/i, "moderation reads only");
      if (sql.includes("from public.reward_ledger l")) return { rows: data.airdrops };
      if (sql.includes("from public.league_epoch_winners w")) return { rows: data.leagues };
      if (sql.includes("from public.recruiters")) return { rows: data.recruiters };
      if (sql.includes("from public.recruiter_accounts")) return { rows: data.accounts };
      if (sql.includes("from public.recruiter_payout_wallets")) return { rows: data.payoutWallets };
      if (sql.includes("from public.wallet_recruiter_links")) return { rows: data.links };
      if (sql.includes("from public.recruiter_reward_ledger")) return { rows: data.ledger };
      if (sql.includes("from public.recruiter_reward_claims")) return { rows: data.claims };
      if (sql.includes("solana_reward_lane_claims lc")) return { rows: data.laneClaims };
      if (sql.includes("from public.cluster_members")) return { rows: data.clusterMembers };
      if (sql.includes("from public.wallet_risk_profiles")) return { rows: data.riskProfiles };
      if (sql.includes("from public.campaigns")) return { rows: data.campaigns };
      if (sql.includes("from public.user_profiles")) return { rows: data.profiles };
      if (sql.includes("from public.wallet_profiles")) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

const fakePrices = {
  async hourly() { return new Map(); },
  async valueEvents(asset, buckets, decimals) {
    const price = { SOL: 100, BNB: 600, ETH: 3000 }[asset];
    const total = buckets.reduce((sum, b) => sum + Number(b.raw) / 10 ** decimals, 0);
    return { amountUsd: total * price, priceBasis: "event_time" };
  },
};

async function dataset(overrides) {
  return buildModerationDataset({ db: fakeDb(overrides), priceService: fakePrices, now: NOW, env: {} });
}

test("helpers: decimals, explorer links, statuses", () => {
  assert.equal(atomicToDecimal("121555160", 9), "0.12155516");
  assert.equal(atomicToDecimal("1000000000000000", 18), "0.001");
  assert.equal(atomicToDecimal("0", 9), "0");
  assert.equal(explorerTxUrl(101, SOL_TX), `https://solscan.io/tx/${SOL_TX}`);
  assert.equal(explorerTxUrl(101, "JkuvMVaKxs6CITuSpTaCvQOXfY5X5OhHFHQzo8AmfgydHHi0p1TDUN3q6rx+jxj9kyUpAKcwLmEdYDvYuwdpDg=="), null, "a base64 claim signature is not a tx link");
  assert.equal(explorerAddressUrl(56, "0x1a367016f10b230e28cf1abda2594c47bf60fe34"), "https://bscscan.com/address/0x1a367016f10b230e28cf1abda2594c47bf60fe34");
  assert.equal(explorerAddressUrl(4663, "0x1a367016f10b230e28cf1abda2594c47bf60fe34"), "https://explorer.chain.robinhood.com/address/0x1a367016f10b230e28cf1abda2594c47bf60fe34");
  assert.equal(explorerAddressUrl(101, DEVNET.toLowerCase()), null, "a lower-cased Solana key gets no link");
  assert.equal(airdropStatus({ status: "claimable", deadline: "2026-10-01T00:00:00Z", now: NOW }), "expired");
  assert.equal(airdropStatus({ status: "claimable", laneStatus: "failed", now: NOW }), "voided");
  assert.equal(airdropStatus({ status: "claimable", claimTx: SOL_TX, now: NOW }), "claimed");
  assert.equal(leagueStatus({ rootAt: null, now: NOW }), "pending");
  assert.equal(leagueStatus({ rootAt: "2026-09-28", now: NOW }), "claimable");
  assert.equal(leagueStatus({ rootAt: "2026-09-28", expiresAt: "2026-10-01", now: NOW }), "expired");
  assert.equal(leagueStatus({ payTx: SOL_TX, expiresAt: "2026-10-01", now: NOW }), "claimed");
});

test("internal wallet list holds the founder keys and takes env additions", () => {
  const index = internalWalletIndex({ MODERATION_INTERNAL_WALLETS: "0xABC0000000000000000000000000000000000001:Ops test" });
  for (const address of [DEPLOYER, DEVNET, "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB"]) assert.ok(index.has(address.toLowerCase()), address);
  assert.equal(index.get("0xabc0000000000000000000000000000000000001").label, "Ops test");
  assert.equal(new Set(INTERNAL_WALLETS.map((w) => w.address.toLowerCase())).size, INTERNAL_WALLETS.length, "no duplicates");
});

test("every query is a mainnet-scoped SELECT", async () => {
  const db = fakeDb();
  await buildModerationDataset({ db, priceService: fakePrices, now: NOW, env: {} });
  const airdrop = db.calls.find((c) => c.sql.includes("from public.reward_ledger l"));
  assert.deepEqual(airdrop.params[0], ["101", "56", "4663"]);
  const league = db.calls.find((c) => c.sql.includes("from public.league_epoch_winners w"));
  assert.deepEqual(league.params[0], [101, 56, 4663]);
  for (const call of db.calls) assert.doesNotMatch(call.sql, /\b(insert|update|delete|truncate|alter|drop)\b/i);
});

test("airdrop rows: amount, USD at draw, reason, status, flags", async () => {
  const data = await dataset();
  const creator = data.airdrops.find((r) => r.program === "airdrop_creator");
  assert.equal(creator.amount, "0.12155516");
  assert.equal(creator.usdBasis, "at_draw");
  assert.equal(creator.amountUsd, Math.round(0.12155516 * 121.84 * 1e6) / 1e6);
  assert.equal(creator.status, "claimed");
  assert.equal(creator.txUrl, `https://solscan.io/tx/${SOL_TX}`);
  assert.equal(creator.profileName, "KAIJU88");
  assert.equal(creator.period, "2026-09-21");
  assert.match(creator.reason, /41 unique buyers/);
  assert.ok(creator.flags.includes("test_coin"), "the only eligible coin is a hidden test coin");
  assert.ok(creator.flags.includes("repeat_winner"), "creator win + two league wins = 3 prizes");
  const trader = data.airdrops.find((r) => r.program === "airdrop_trader");
  assert.equal(trader.status, "claimable");
  assert.equal(trader.usdBasis, "event_time");
  assert.equal(trader.amountUsd, 100);
  assert.ok(trader.flags.includes("expiring"));
  assert.ok(trader.flags.includes("cluster"));
});

test("league rows: coin, test coin, root, statuses and flags", async () => {
  const data = await dataset();
  const top = data.leagues.find((r) => r.chainId === 101 && r.category === "top_earner");
  assert.ok(top.flags.includes("internal"));
  assert.equal(top.status, "claimed");
  assert.equal(top.reason, "PnL -0.000001 SOL");
  const crowd = data.leagues.find((r) => r.category === "crowd_favorite");
  assert.equal(crowd.coinName, "Kaiju88");
  assert.equal(crowd.testCoin, true);
  assert.equal(crowd.rootPosted, true);
  assert.equal(crowd.status, "claimable");
  assert.ok(crowd.flags.includes("test_coin"));
  assert.ok(crowd.flags.includes("repeat_winner"), "two categories in one week");
  const hit = data.leagues.find((r) => r.chainId === 101 && r.category === "biggest_hit");
  assert.equal(hit.status, "expired");
  const bnb = data.leagues.filter((r) => r.chainId === 56);
  assert.equal(bnb.length, 2);
  for (const row of bnb) {
    assert.equal(row.asset, "BNB");
    assert.equal(row.status, "pending");
    assert.ok(row.flags.includes("shared_payout"), "one payout address for two winning wallets");
  }
});

test("recruiter rows: totals per chain, links, self-referral, internal, shared, voided", async () => {
  const data = await dataset();
  const sk = data.recruiters.find((r) => r.recruiterId === "114");
  assert.equal(sk.wallet, DEVNET, "Solana case restored from the payout wallet");
  assert.equal(sk.walletUrl, `https://solscan.io/account/${DEVNET}`);
  assert.equal(sk.accountId, "acc-114");
  assert.equal(sk.linkedTotal, 2);
  assert.equal(sk.linkedActive, 0);
  assert.equal(sk.linkedDetached, 2);
  assert.deepEqual(Object.keys(sk.chains), ["101"], "the null-chain and testnet rows stay out");
  assert.equal(sk.chains[101].failedVoided, "0.000671407");
  assert.equal(sk.chains[101].claimable, "0.00001");
  assert.equal(sk.chains[101].earned, "0.00001", "voided money is not earned");
  assert.equal(sk.failedVoidedUsd, Math.round(0.000671407 * 100 * 1e6) / 1e6);
  for (const flag of ["internal", "self_referral", "voided", "test_coin"]) assert.ok(sk.flags.includes(flag), flag);
  assert.match(sk.flagNotes.self_referral, /voided as self-referral/);
  assert.match(sk.flagNotes.self_referral, /same sign-up email/, "links the operator wallet, owned by recruiter 124 with the same email");
  assert.ok(data.notes.some((n) => /no chain id/.test(n)));
  const selfie = data.recruiters.find((r) => r.recruiterId === "29");
  assert.ok(selfie.flags.includes("self_referral"));
  const dupA = data.recruiters.find((r) => r.recruiterId === "40");
  const dupB = data.recruiters.find((r) => r.accountId === "acc-orphan");
  assert.equal(dupB.recruiterId, null);
  assert.equal(dupB.source, "recruiter_accounts only");
  assert.ok(dupA.flags.includes("shared_payout"));
  assert.ok(dupB.flags.includes("shared_payout"));
  const ops = data.recruiters.find((r) => r.recruiterId === "124");
  assert.ok(ops.flags.includes("internal"));
});

test("query (test and internal shown): chain, status, flag and search filters, sorting, paging, totals", async () => {
  const T = { includeTest: "1" };
  const data = await dataset();
  const all = queryModerationTab(data, "leagues", parseModerationQuery("leagues", T));
  assert.equal(all.total, 5);
  const bnb = queryModerationTab(data, "leagues", parseModerationQuery("leagues", { ...T, chainId: "56" }));
  assert.equal(bnb.total, 2);
  assert.deepEqual(bnb.totals.chains.map((c) => [c.chainId, c.amounts.amount]), [[56, "0.002"]]);
  assert.equal(bnb.totals.usd.amount, 1.2);
  const flagged = queryModerationTab(data, "leagues", parseModerationQuery("leagues", { ...T, flag: "internal" }));
  assert.equal(flagged.total, 1);
  const search = queryModerationTab(data, "leagues", parseModerationQuery("leagues", { ...T, q: "kaiju" }));
  assert.equal(search.total, 2);
  const sorted = queryModerationTab(data, "leagues", parseModerationQuery("leagues", { ...T, sort: "amount", dir: "desc", limit: "2" }));
  assert.equal(sorted.rows.length, 2);
  assert.equal(sorted.nextOffset, 2);
  assert.equal(sorted.rows[0].amountRaw, "7000000", "0.007 SOL sorts above 0.001 BNB (native amount)");
  const claimed = queryModerationTab(data, "airdrops", parseModerationQuery("airdrops", { ...T, status: "claimed" }));
  assert.equal(claimed.total, 1);
  const recruitersSol = queryModerationTab(data, "recruiters", parseModerationQuery("recruiters", { ...T, chainId: "101" }));
  assert.ok(recruitersSol.rows.every((r) => Object.keys(r.chains).every((k) => k === "101")));
  const byLinked = queryModerationTab(data, "recruiters", parseModerationQuery("recruiters", { ...T, q: DEPLOYER.toLowerCase() }));
  assert.deepEqual(byLinked.rows.map((r) => r.recruiterId), ["114"], "search finds a recruiter by a linked wallet");
  assert.equal(parseModerationQuery("leagues", { ...T, chainId: "97" }).error.includes("Testnets"), true);
  assert.ok(parseModerationQuery("leagues", { ...T, flag: "nope" }).error);
});

test("test and internal rows are hidden by default and counted", async () => {
  const data = await dataset();
  // Leagues: the deployer's top_earner (internal) and both Kaiju88 rows (hidden test coin) are test data.
  const leagues = queryModerationTab(data, "leagues", parseModerationQuery("leagues", {}));
  assert.equal(parseModerationQuery("leagues", {}).includeTest, false, "off by default");
  assert.equal(leagues.includeTest, false);
  assert.equal(leagues.total, 2);
  assert.equal(leagues.testHidden, 3);
  assert.ok(leagues.rows.every((r) => r.chainId === 56 && r.testData === false));
  assert.deepEqual(leagues.totals.chains.map((c) => c.chainId), [56], "totals leave the hidden rows out");
  assert.deepEqual(leagues.facets.chains.map((c) => c.value), ["56"], "facets too");
  const shown = queryModerationTab(data, "leagues", parseModerationQuery("leagues", { includeTest: "1" }));
  assert.equal(shown.total, 5);
  assert.equal(shown.testHidden, 0);
  const crowd = shown.rows.find((r) => r.category === "crowd_favorite");
  assert.deepEqual(crowd.testReasons, ["test_coin"]);
  assert.ok(crowd.flags.includes("test_coin"), "badges stay when shown");
  assert.deepEqual(shown.rows.find((r) => r.category === "top_earner" && r.chainId === 101).testReasons, ["internal_wallet"]);
  // The count follows the other filters: on BNB nothing is hidden.
  assert.equal(queryModerationTab(data, "leagues", parseModerationQuery("leagues", { chainId: "56" })).testHidden, 0);
  assert.equal(queryModerationTab(data, "leagues", parseModerationQuery("leagues", { chainId: "101" })).testHidden, 3);
  // Airdrops: the creator draw on the hidden coin is hidden, the trader draw stays.
  const airdrops = queryModerationTab(data, "airdrops", parseModerationQuery("airdrops", {}));
  assert.deepEqual(airdrops.rows.map((r) => r.program), ["airdrop_trader"]);
  assert.equal(airdrops.testHidden, 1);
  // Recruiters: 114 and 124 (owner-wallet signups, listed ids) and 29 (listed id) are hidden.
  const recruiters = queryModerationTab(data, "recruiters", parseModerationQuery("recruiters", {}));
  assert.deepEqual(recruiters.rows.map((r) => r.recruiterId ?? r.accountId).sort(), ["40", "acc-orphan"]);
  assert.equal(recruiters.testHidden, 3);
  const all = queryModerationTab(data, "recruiters", parseModerationQuery("recruiters", { includeTest: "true" }));
  const r114 = all.rows.find((r) => r.recruiterId === "114");
  assert.deepEqual(r114.testReasons, ["internal_wallet", "test_recruiter"]);
  assert.deepEqual(all.rows.find((r) => r.recruiterId === "29").testReasons, ["test_recruiter"]);
});

test("voided winners and a test recruiter's league prize are test data; env adds recruiter ids", async () => {
  const data = fixtures();
  data.leagues.push(
    { chain_id: 101, period: "weekly", epoch_start: "2026-09-21T00:00:00Z", epoch_end: "2026-09-28T00:00:00Z", category: "recruiter_league", rank: 1, recipient_address: TRADER, amount_raw: "1000", payload: { wallet: TRADER, recruiterId: 40 }, expires_at: "2026-12-28T00:00:00Z", root_at: "2026-09-28T00:15:00Z" },
  );
  data.airdrops.push({ id: "a3", reward_type: "airdrop", wallet_address: TRADER, chain: "101", amount_raw: "5", status: "voided", created_at: "2026-09-28T00:15:00Z", metadata: { program: "airdrop_trader" } });
  const built = await buildModerationDataset({ db: fakeDb(data), priceService: fakePrices, now: NOW, env: { MODERATION_TEST_RECRUITER_IDS: "40, x" } });
  const league = built.leagues.find((r) => r.category === "recruiter_league");
  assert.deepEqual(league.testReasons, ["test_recruiter"]);
  assert.equal("_recruiterId" in league, false, "internal field does not leak");
  assert.deepEqual(built.airdrops.find((r) => r.id === "airdrop:a3").testReasons, ["voided"]);
  assert.ok(built.recruiters.find((r) => r.recruiterId === "40").testData);
});

test("CSV follows the toggle and names the test reason", async () => {
  const data = await dataset();
  const hidden = queryModerationTab(data, "leagues", parseModerationQuery("leagues", {}), { page: false }).rows;
  const shown = queryModerationTab(data, "leagues", parseModerationQuery("leagues", { includeTest: "1" }), { page: false }).rows;
  const off = moderationCsv("leagues", hidden);
  const on = moderationCsv("leagues", shown);
  assert.equal(off.trim().split("\r\n").length, 1 + 2);
  assert.equal(on.trim().split("\r\n").length, 1 + 5);
  assert.match(on.split("\r\n")[0], /,Flags,Test or internal$/);
  assert.match(on, /Prize from a hidden test coin/);
  assert.doesNotMatch(off, /Kaiju88/);
});

test("CSV: header, escaping, formula guard, email column only when allowed", async () => {
  const data = await dataset();
  const rows = queryModerationTab(data, "recruiters", parseModerationQuery("recruiters", { includeTest: "1" }), { page: false }).rows;
  const withEmail = moderationCsv("recruiters", rows);
  assert.match(withEmail.split("\r\n")[0], /^Recruiter id,Account id,Code,Name,Handle,Email,Wallet,/);
  assert.match(withEmail, /owner@example\.test/);
  const noEmail = moderationCsv("recruiters", rows, { includeEmail: false });
  assert.doesNotMatch(noEmail.split("\r\n")[0], /Email/);
  assert.doesNotMatch(noEmail, /@example\.test/);
  const tricky = moderationCsv("airdrops", [{ ...data.airdrops[0], reason: '=HYPERLINK("x"), "quoted"', flags: [], flagNotes: {} }]);
  assert.match(tricky, /"'=HYPERLINK\(""x""\), ""quoted"""/);
  const leagues = moderationCsv("leagues", data.leagues);
  assert.equal(leagues.trim().split("\r\n").length, 1 + data.leagues.length);
});

test("a missing table is a note, not a failure", async () => {
  const db = fakeDb();
  const inner = db.query.bind(db);
  db.query = async (sql, params) => {
    if (sql.includes("from public.cluster_members")) { const e = new Error("missing"); e.code = "42P01"; throw e; }
    return inner(sql, params);
  };
  const data = await buildModerationDataset({ db, priceService: fakePrices, now: NOW, env: {} });
  assert.ok(data.notes.some((n) => n.startsWith("Wallet clusters could not be read")));
});
