# Notifications (CO-5, built 2026-10-03)

One bell feed for four categories, each with a bell and an email toggle per wallet
(`wallet_notification_prefs`, Command Center > Notifications): `battles`, `social`, `rewards`, `coin`.

- **Storage = the bell table.** Every producer writes `public.prepare_mode_notifications` through
  `notifyWallet` (`frontend/api/lib/walletNotify.js`). Migration `20261003_000004` adds `category`,
  `dedupe_key` (unique per wallet: every producer is safe to re-run) and `emailed_at` (the digest
  queue). A row is written when the bell OR the email is on; the bell/Notifications tab hide a
  category whose bell is off.
- **Wallet keys are the flexible form** (EVM lowercased, Solana base58 as-is). The bell used to
  query EVM only (client `isEvmAddress`, server `normalizeAddress` without chain id): Solana
  wallets never saw a notification. Both now accept Solana.
- **Battles** (`arenaNotify.js`): challenge, counter, declined, accepted (new). Bell row + immediate
  email; the row is written already handled so the digest skips it. The battle e2e
  (`scripts/e2e-arena-battle-flow.mjs`) asserts the three bell rows.
- **Social** (`socialNotify.js`, hooked fire-and-forget in `api/feed/posts.js`): reply -> parent
  author, quote -> quoted author, repost (on toggle only, once per reposter), @mentions (feed's
  `MENTION_RE`, resolved via `user_handles`, max 10 per post). Never the actor, once per post.
- **Rewards + coin events** (`notificationProducers.js`, `npm run cron:notification-scan`, every
  5 min): league/MWL prizes with a published root and no claim; `reward_ledger` status claimable;
  recruiter earnings (one per recruiter per chain per week); staked battle wins (same rule as
  `/arena/war-pools/claimable`); coin launch, graduation, large buy (`NOTIFY_LARGE_BUY_USD`,
  default 500 (founder 2026-10-03), live native price). Tournament places are not covered yet.
- **Email digest** (`npm run cron:notification-digest`, hourly): one email per wallet with a
  verified address for social/rewards/coin, only categories whose email is on, max 20 items, a
  stop link per category. Provider failure: rows younger than 24 h are retried next run.
- **Unsubscribe**: `GET/POST /api/notification-prefs/unsubscribe?t=` (HMAC token over wallet +
  category, `NOTIFICATION_UNSUBSCRIBE_SECRET`, else derived from `RESEND_API_KEY`). GET only shows a
  confirm button; mail scanners cannot unsubscribe anyone.
