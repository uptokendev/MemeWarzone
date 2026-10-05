import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
process.env.NOTIFICATION_UNSUBSCRIBE_SECRET = "test-secret";
const { notifyWallet, signUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } = await import("./walletNotify.js");
const { parseMentionHandles, notifySocialPost, notifyRepost, notifyRocket, notifyFollow } = await import("./socialNotify.js");
const { scanRewardNotifications, scanCoinNotifications, buildDigestEmail, runNotificationDigest, tradeUsd, coinPath } = await import("./notificationProducers.js");

const EVM_A = "0x" + "a".repeat(40);
const EVM_B = "0x" + "b".repeat(40);
const SOL = "So11111111111111111111111111111111111111112";

function recordingPool(answer = () => ({ rows: [], rowCount: 1 })) {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text, params }); return answer(text, params); } };
}
const allOn = async () => ({ prefs: null });

test("notifyWallet: writes one deduped row, battles marked handled, others queued for the digest", async () => {
  const pool = recordingPool(() => ({ rows: [{ id: "1" }], rowCount: 1 }));
  const r = await notifyWallet(pool, { wallet: EVM_A.toUpperCase().replace("0X", "0x"), category: "social", kind: "reply", dedupeKey: "k1", title: "t", target: "/post/1" }, { prefsFor: allOn });
  assert.equal(r.inserted, true);
  const { text, params } = pool.calls[0];
  assert.match(text, /on conflict \(wallet_address, dedupe_key\) where dedupe_key is not null do nothing/);
  assert.equal(params[0], EVM_A, "EVM wallets are stored lowercased");
  assert.equal(params[7], "social");
  assert.equal(params[8], "k1");
  assert.match(text, /, null\)\s*on conflict/, "non-battle rows wait for the digest");
  const b = recordingPool(() => ({ rows: [{ id: "2" }], rowCount: 1 }));
  await notifyWallet(b, { wallet: SOL, category: "battles", kind: "challenge" }, { prefsFor: allOn });
  assert.equal(b.calls[0].params[0], SOL, "Solana keeps its case");
  assert.match(b.calls[0].text, /, now\(\)\)\s*on conflict/, "battle rows are already emailed immediately");
});

test("notifyWallet: skips self, unknown categories, bad wallets, and categories fully off; never throws", async () => {
  const pool = recordingPool();
  assert.equal((await notifyWallet(pool, { wallet: EVM_A, actorWallet: EVM_A, category: "social" }, { prefsFor: allOn })).reason, "self");
  assert.equal((await notifyWallet(pool, { wallet: EVM_A, category: "spam" }, { prefsFor: allOn })).reason, "bad_category");
  assert.equal((await notifyWallet(pool, { wallet: "nope", category: "social" }, { prefsFor: allOn })).reason, "no_wallet");
  const off = async () => ({ prefs: { social: { bell: false, email: false } } });
  assert.equal((await notifyWallet(pool, { wallet: EVM_A, category: "social" }, { prefsFor: off })).reason, "off");
  const emailOnly = async () => ({ prefs: { social: { bell: false, email: true } } });
  assert.equal((await notifyWallet(pool, { wallet: EVM_A, category: "social", kind: "x" }, { prefsFor: emailOnly })).inserted, true, "email on still queues for the digest");
  assert.equal(pool.calls.length, 1);
  const broken = { query: async () => { throw new Error("db down"); } };
  assert.equal((await notifyWallet(broken, { wallet: EVM_A, category: "social" }, { prefsFor: allOn })).reason, "error");
});

test("unsubscribe tokens: round trip, tamper and wrong secret refused", () => {
  const t = signUnsubscribeToken(EVM_A, "social");
  assert.deepEqual(verifyUnsubscribeToken(t), { wallet: EVM_A, category: "social" });
  const [payload, sig] = t.split(".");
  const other = Buffer.from(JSON.stringify({ w: EVM_B, c: "social", v: 1 })).toString("base64url");
  assert.equal(verifyUnsubscribeToken(`${other}.${sig}`), null);
  assert.equal(verifyUnsubscribeToken(`${payload}.x${sig.slice(1)}`), null);
  assert.equal(verifyUnsubscribeToken(t, "another-secret"), null);
  assert.equal(signUnsubscribeToken(EVM_A, "nope"), null);
  assert.match(unsubscribeUrl(SOL, "coin"), /^https:\/\/api\.memewar\.zone\/api\/notification-prefs\/unsubscribe\?t=/);
});

test("mentions: the feed's @handle rule, unique, capped at 10, emails and @@ ignored", () => {
  assert.deepEqual(parseMentionHandles("hey @Alice and @bob_1, also @alice again"), ["alice", "bob_1"]);
  assert.deepEqual(parseMentionHandles("mail me@example.com or @@nope or @ab"), []);
  assert.equal(parseMentionHandles(Array.from({ length: 15 }, (_, i) => `@user${i}x`).join(" ")).length, 10);
});

test("social: reply tells the parent author, mentions resolve, actor and duplicates skipped", async () => {
  const pool = recordingPool((text) => {
    if (/from public\.social_posts/.test(text)) return { rows: [{ author_address: EVM_B }] };
    if (/from public\.user_handles where lower\(handle\)/.test(text)) return { rows: [{ handle: "bob", wallet_key: EVM_B }, { handle: "me", wallet_key: EVM_A }, { handle: "sol", wallet_key: SOL }] };
    return { rows: [] };
  });
  const sent = [];
  const notify = async (_pool, input) => { sent.push(input); return { inserted: true }; };
  const r = await notifySocialPost(pool, { postId: 9, actor: EVM_A, body: "gm @bob @me @sol", parentId: 3, notify });
  assert.equal(r.notified, 2);
  assert.deepEqual(sent.map((s) => [s.kind, s.wallet]), [["reply", EVM_B], ["mention", SOL]]);
  assert.equal(sent[0].target, "/post/3");
  assert.equal(sent[0].dedupeKey, "social:reply:9");
  assert.equal(sent[1].dedupeKey, "social:mention:9");
  assert.ok(sent.every((s) => s.category === "social"));
});

test("social: quote tells the quoted author; repost tells the author once per reposter", async () => {
  const pool = recordingPool((text) => (/from public\.social_posts/.test(text) ? { rows: [{ author_address: EVM_B }] } : { rows: [] }));
  const sent = [];
  const notify = async (_pool, input) => { sent.push(input); return { inserted: true }; };
  await notifySocialPost(pool, { postId: 12, actor: EVM_A, body: "look", quoteOfId: 4, notify });
  assert.deepEqual([sent[0].kind, sent[0].wallet, sent[0].target], ["quote", EVM_B, "/post/12"]);
  await notifyRepost(pool, { postId: 4, actor: EVM_A, notify });
  assert.equal(sent[1].dedupeKey, `social:repost:4:${EVM_A}`);
  const own = recordingPool(() => ({ rows: [{ author_address: EVM_A }] }));
  assert.equal((await notifyRepost(own, { postId: 4, actor: EVM_A, notify })).notified, 0, "reposting your own post");
});

test("notifyFollow: tells the followed wallet once per follower, links to the follower", async () => {
  const sent = [];
  const notify = async (_pool, input) => { sent.push(input); return { inserted: true }; };
  const pool = recordingPool();
  const r = await notifyFollow(pool, { follower: EVM_A, following: SOL, notify });
  assert.equal(r.notified, 1);
  assert.deepEqual([sent[0].wallet, sent[0].kind, sent[0].target], [SOL, "follow", `/profile/${EVM_A}`]);
  assert.equal(sent[0].dedupeKey, `social:follow:${SOL}:${EVM_A}`);
  assert.match(sent[0].title, /followed you$/);
  assert.equal((await notifyFollow(pool, { follower: EVM_A, following: EVM_A, notify })).notified, 0, "following yourself");
});

test("notifyRocket: tells the author once per rocketer, never for your own post", async () => {
  const sent = [];
  const notify = async (_pool, input) => { sent.push(input); return { inserted: true }; };
  const pool = recordingPool(() => ({ rows: [{ author_address: EVM_B }] }));
  const r = await notifyRocket(pool, { postId: 7, actor: EVM_A, notify });
  assert.equal(r.notified, 1);
  assert.equal(sent[0].wallet, EVM_B);
  assert.equal(sent[0].kind, "rocket");
  assert.equal(sent[0].category, "social");
  assert.equal(sent[0].dedupeKey, `social:rocket:7:${EVM_A}`);
  assert.match(sent[0].title, /rocketed your post$/);
  const own = recordingPool(() => ({ rows: [{ author_address: EVM_A }] }));
  assert.equal((await notifyRocket(own, { postId: 7, actor: EVM_A, notify })).notified, 0, "rocketing your own post");
});

test("rewards scan: league, ledger, recruiter (weekly) and staked battle wins, each with a stable dedupe key", async () => {
  const pool = recordingPool((text) => {
    if (/league_epoch_winners/.test(text)) return { rows: [{ chain_id: 101, period: "weekly", epoch_start: "2026-09-28T00:00:00Z", category: "volume", rank: 2, recipient_address: SOL }] };
    if (/from public\.reward_ledger/.test(text)) return { rows: [{ id: "abc", reward_type: "airdrop", wallet_address: EVM_A, chain: "bnb", token_symbol: "BNB", amount_usd: "12.5" }] };
    if (/recruiter_reward_ledger/.test(text)) return { rows: [{ recruiter_id: "r1", wallet: EVM_B, chain_id: 56, token: "BNB", week: "2026-09-28T00:00:00Z" }] };
    if (/from public\.arena_battles/.test(text)) return { rows: [{ id: "b1", chain_id: 56, winner_token: "0xT1", participants: [{ tokenAddress: "0xt1", ownerWallet: EVM_A, symbol: "WIN" }, { tokenAddress: "0xt2", ownerWallet: EVM_B, symbol: "LOSE" }] }] };
    return { rows: [] };
  });
  const sent = [];
  const notify = async (_pool, input) => { sent.push(input); return { inserted: true }; };
  const out = await scanRewardNotifications(pool, { notify });
  assert.deepEqual(out, { league: 1, ledger: 1, recruiter: 1, battle: 1 });
  assert.deepEqual(sent.map((s) => s.dedupeKey), [
    "reward:league:101:weekly:2026-09-28:volume:2",
    "reward:ledger:abc",
    "reward:recruiter:r1:56:2026-09-28",
    "reward:battle:b1",
  ]);
  assert.equal(sent[3].wallet, EVM_A, "the winner's owner, matched case-insensitively");
  assert.match(sent[3].title, /\$WIN won/);
  assert.ok(sent.every((s) => s.category === "rewards"));
  assert.match(pool.calls[0].text, /c\.claimed_at is null/);
  assert.match(pool.calls[3].text, /coalesce\(stake_native, 0\) > 0/);
});

test("coin scan: launch, graduation, and buys at or above the threshold only", async () => {
  const coin = { chain_id: 56, campaign_address: "0xCAMP", token_address: "0xTOKEN", creator_address: EVM_A, symbol: "MEME" };
  const pool = recordingPool((text) => {
    if (/created_at_chain, created_at\) >= now/.test(text)) return { rows: [coin] };
    if (/graduated_at_chain >= now/.test(text)) return { rows: [coin] };
    if (/market_trades_v/.test(text)) return { rows: [
      { chainId: 56, campaignAddress: "0xcamp", tokenAddress: "0xtoken", wallet: EVM_B, nativeAmountRaw: String(2n * 10n ** 18n), volumeUsd: null, txHash: "0x1", logIndex: 0, creator_address: EVM_A, symbol: "MEME" },
      { chainId: 56, campaignAddress: "0xcamp", tokenAddress: "0xtoken", wallet: EVM_B, nativeAmountRaw: String(10n ** 17n), volumeUsd: null, txHash: "0x2", logIndex: 0, creator_address: EVM_A, symbol: "MEME" },
      { chainId: 101, campaignAddress: "C", tokenAddress: SOL, wallet: SOL, nativeAmountRaw: "0", volumeUsd: "2500", txHash: "sig", logIndex: 1, creator_address: EVM_A, symbol: "SOLX" },
    ] };
    return { rows: [] };
  });
  const sent = [];
  const notify = async (_pool, input) => { sent.push(input); return { inserted: true }; };
  const out = await scanCoinNotifications(pool, { notify, largeBuyUsd: 1000, priceOf: async () => 600 });
  assert.deepEqual(out, { launched: 1, graduated: 1, largeBuy: 2 });
  assert.deepEqual(sent.slice(2).map((s) => s.dedupeKey), ["coin:buy:56:0x1:0", "coin:buy:101:sig:1"]);
  assert.equal(sent[0].target, "/token/0xtoken");
  assert.equal(sent[2].actorWallet, EVM_B, "the creator buying their own coin is skipped by notifyWallet");
  assert.equal(tradeUsd({ chainId: 101, nativeAmountRaw: String(3 * 10 ** 9), volumeUsd: null }, { 101: 150 }), 450);
  assert.equal(coinPath(97, "0xAB", null), "/token/0xab?chainId=97");
});

test("digest: one email per wallet, only categories with email on, stop link per category", async () => {
  const rows = [
    { id: "00000000-0000-0000-0000-000000000001", wallet_address: EVM_A, category: "social", title: "@bob replied to your post", body: "gm", metadata_json: { target: "/post/3" }, created_at: new Date().toISOString() },
    { id: "00000000-0000-0000-0000-000000000002", wallet_address: EVM_A, category: "coin", title: "$MEME graduated", body: "", metadata_json: { target: "/token/0x1" }, created_at: new Date().toISOString() },
    { id: "00000000-0000-0000-0000-000000000003", wallet_address: SOL, category: "rewards", title: "Airdrop ready to claim", body: "", metadata_json: {}, created_at: new Date().toISOString() },
  ];
  const mail = buildDigestEmail(EVM_A, rows.slice(0, 2));
  assert.equal(mail.subject, "MemeWarzone: 2 new notifications");
  assert.match(mail.text, /Replies, reposts and @mentions \(1\)/);
  assert.match(mail.text, /Stop replies, reposts and @mentions emails: https:\/\/api\.memewar\.zone\/api\/notification-prefs\/unsubscribe\?t=/);
  assert.match(mail.text, /Stop your coin events emails:/);
  assert.doesNotMatch(mail.text, /—/, "no em dashes in copy");

  const pool = recordingPool((text) => (/select id, wallet_address/.test(text) ? { rows } : { rows: [], rowCount: 1 }));
  const mails = [];
  const out = await runNotificationDigest(pool, {
    send: async (m) => { mails.push(m); return { ok: true }; },
    emailFor: async (w) => (w === EVM_A ? "a@example.com" : null),
    prefsFor: async (w) => ({ prefs: w === EVM_A ? { coin: { email: false } } : null }),
  });
  assert.deepEqual(out, { wallets: 2, emailed: 1, skipped: 1, failed: 0 });
  assert.equal(mails.length, 1);
  assert.doesNotMatch(mails[0].text, /graduated/, "coin email is off for this wallet");
  const marked = pool.calls.filter((c) => /set emailed_at = now\(\)/.test(c.text)).flatMap((c) => c.params[0]);
  assert.equal(marked.length, 3, "every row is handled, mailed or not, so nothing is mailed twice");
});

test("digest: a provider failure keeps recent rows for the next run", async () => {
  const fresh = { id: "00000000-0000-0000-0000-00000000000a", wallet_address: EVM_A, category: "social", title: "x", body: "", metadata_json: {}, created_at: new Date().toISOString() };
  const stale = { ...fresh, id: "00000000-0000-0000-0000-00000000000b", created_at: new Date(Date.now() - 30 * 3_600_000).toISOString() };
  const pool = recordingPool((text) => (/select id, wallet_address/.test(text) ? { rows: [fresh, stale] } : { rows: [], rowCount: 1 }));
  const out = await runNotificationDigest(pool, { send: async () => { throw new Error("429"); }, emailFor: async () => "a@example.com", prefsFor: allOn });
  assert.equal(out.failed, 1);
  const marked = pool.calls.filter((c) => /set emailed_at/.test(c.text)).flatMap((c) => c.params[0]);
  assert.deepEqual(marked, [stale.id]);
});
