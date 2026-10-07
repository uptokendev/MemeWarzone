# Meteora DBC launch type (2026-09-28)

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

### Meteora DBC launch type -- devnet dress rehearsal PASS (2026-09-28)

Why: our bonding curve needs an Ed25519 route authorization per trade (locked on), so Jupiter cannot
route pre-graduation coins. Founder chose Meteora DBC as a new Solana launch type; the existing
launchpad is untouched. `tools/dbc-rehearsal/rehearse-dbc-devnet.mjs` (own deps, devnet genesis
enforced, keys + resumable state in `~/.config/memewarzone/solana-devnet/dbc-rehearsal/`) ran the whole
life of a coin and every check passed against the program's own accounting:
- 2% fee exact on buy and sell (sell: taken from the SOL out). Meteora keeps 20% of the fee; with a
  referral token account on the swap, 20% of Meteora's cut goes to that account (our collector ->
  effectively 16%). Jupiter trades name no referral of ours.
- `creatorTradingFeePercentage` is a whole % of the post-Meteora 80%: 7 -> creator 5.6% of the fee.
- Claims pay exactly the pool's counter, before and **after** graduation (late claims work).
  Measure claims at the pool vault: wallet deltas include returned WSOL-account rent (1488440).
- Graduation: 22% migration fee off the threshold, split 90/10 creator/partner to the lamport; the
  pool gets 78%, less Meteora's **0.2% liquidity migration fee** (`PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS`,
  base + quote). Graduated DAMM v2 pool (customizable config `A8gMrEPJ…`): 0.25%, SOL-only fee
  collection, 100% permanently locked, LP fees 80/20 creator/partner by liquidity.
- Meteora's keepers only migrate at >= 10 SOL / 750 USDC, so we run migration ourselves.
- PartialFill on the completing buy takes only what the curve needs.
- Tx shape: create (config + pool) 1160 B / 16 accounts / 7 writable / 4 signers; buy 673 B / 15 / 6 / 1.
- SDK 1.5.13 `state.getPool` returns `{ poolState }`; cp-amm 1.4 keeps the base fee as raw bytes.
- **Mainnet tiny coin (2026-09-28, `tools/dbc-rehearsal/canary-dbc-mainnet.mjs`, founder's terminal):**
  mint `4YuzaXEm…`, pool `CgAjACtB…`, config `2nmv9vHx…` (100 SOL threshold, never graduates).
  Creator tx = createPool only: **689 B / 14 accounts / 6 writable / 2 signers** (wallet + mint);
  config tx by our side 661 B / 2 signers. **Jupiter routes it on the curve** ("Dynamic Bonding
  Curve") within the first poll. Buy 0.02 SOL: fee 400000 = 2%, Meteora 80000 of which referral
  16000, creator 22400 (7% of 320000), collector 297600 -- read from the tx's own token balances.
- Launch shape decision: 21 of 25 recent mainnet DBC launches reuse a pre-made config (2 signers,
  ~710-760 B); ours = server-made config ladder per dollar target x SOL-price step (0.006 SOL rent
  each), creator signs createPool only. Founder decisions: creator 7%; referral = our collector on
  our own site; Meteora's 0.2% migration liquidity cut is compensated to the creator from our share.
- **Phantom (founder, 2026-09-28):** coin searchable by address in Phantom and in Jupiter-in-Phantom;
  buys went through with no warning, only the standard new/low-liquidity token notices. Creator
  claim paid exactly the pool counter (33378). ALL CHECKS PASS on mainnet.
- **The SDK partner-fee claim closes the claimer's WSOL ATA** (unwraps it). If that ATA is also the
  referral account, every later swap naming it fails. The referral account must be one no claim closes.



### Finance: migration fee lane and DBC pools in LP Harvest (2026-10-06)

- Migration fee flow (code): keeper `dbcGraduationKeeper.ts` withdraw step calls
  `partnerWithdrawMigrationFee` (partner 10% of the 22% fee to the collector, `partner_fee` = quote
  vault outflow), compensate step pays D7 to the creator from the protocol slice
  (`dbc_graduation_compensations`), route step sends the finalize split and writes one
  `reward_events` row: `route_kind 'finalize'`, `matched_activity_source 'dbc_graduation'`,
  `protocol_amount` = protocol remainder. Revenue lane `dbc-migration-fee:101` reads that row
  (SOL-quote coins only; a bound-quote row is in quote units and only counted in a note). VAT lane:
  graduation fees (paid from the coin's raised SOL, not by Meteora).
- No DBC coin has migrated on production (2026-10-06: `dbc_graduation_jobs` empty, no finalize rows).
  DAZILLA `CAfqx…` (config `6GdLrNUh…`, threshold 124.408 SOL, 25.8%) is the only non-hidden DBC
  coin; its partner migration fee at graduation is 2.736984726 SOL. All 3 configs in use (6GdLrNUh…, CKqCXPAp…, FLBwmYah…) have
  fee claimer `3NWtsXix…`.
- LP Harvest shows DBC pools read-only from snapshot `dbc-pools:101:mainnet-beta`
  (`frontend/api/lib/financeDbcPools.js`). No manual DBC harvest route exists; the dbc-fee and
  dbc-grad indexer workers claim.

### Creator first-buy cap: 20% default, 50% for listed creators (founder, 2026-10-06)

**Superseded by DBC v2 economics (2026-10-08) below: 70% for everyone, no latch, the table and env settings are gone.**

- `DBC_FIRST_BUY_MAX_BPS` 1000 -> 2000 (everyone); `DBC_FIRST_BUY_PARTNER_MAX_BPS` = 5000 is the ceiling for
  wallets in `public.creator_first_buy_caps` (migration `db/migrations/20261006_000030_creator_first_buy_caps.sql`).
  Reason: creators want supply control; big partner launches drive traffic. Founder accepts the risk.
- Ours only (server check on the launch-transaction first buy, `api/lib/dbc/dbcFirstBuyCap.js`); Meteora has no
  creator cap. First-buy tokens land in the creator's wallet (DAZILLA: 2.65 SOL -> 77.76M = 10.00%), not the lock.
- Cost at $120 SOL, $15k / $30k / $50k config: 10% 2.66 / 5.20 / 8.60 SOL; 20% 10.47 / 20.67 / 34.33 SOL;
  50% 65.01 / 128.39 / 213.78 SOL. The price rises along the curve, so 5x the tokens costs ~24x the SOL.
- EVM gen-6 `EVM_FIRST_BUY_MAX_SUPPLY_BPS` is pinned at 1000n (was derived from the DBC constant):
  `LaunchCampaign.CREATOR_FIRST_BUY_MAX_SUPPLY_BPS = 1000` is fixed in the live contracts. A per-creator cap on
  BNB/Robinhood needs a new factory (audit first, combined release). Our Solana launchpad already has a
  per-creator cap on-chain (`sync_creator_profile`); its 10% default needs a program upgrade.
- The first-buy quote now sends `quoteMint` (it was dropped, so non-SOL coins were quoted on the SOL curve).
- Each listed wallet has its own `max_bps` (any share up to the ceiling). Default and ceiling are API
  settings `DBC_FIRST_BUY_DEFAULT_BPS` / `DBC_FIRST_BUY_PARTNER_MAX_BPS` (unset = 2000 / 5000), so the
  numbers can move without a release; the table only bounds `max_bps` to 1..10000.

### Referral fee: the finance line overstates it (found 2026-10-07)

- Our referral token account is `AYQNtghqVvzCUHr8Nkuap2Gpe6FZTuB42P7HvTy8K1tS` (WSOL, owner `4T7q9fkg…`).
  Meteora pays it inside each swap that names it; nothing to claim. `dbcReferralSweep.ts` moves it weekly to
  protocol_vault (last run 2026-10-01 19:07 UTC, cursor `solana:dbc:referral-sweep`; it sweeps once 7 days pass).
- `dbc_fee_accruals.referral_fee` records the referral fee of EVERY DBC swap on our pools, whoever the
  referral was. Terminals name their own: of 22 recent swaps with a referral fee, 5 paid our account, 17
  paid ten other accounts. Finance showed 0.1275 SOL (10/6-10/7); our account held 0.0629 SOL on 2026-10-07
  and received ~0.06 SOL in total since 10-01. Fix: store the referral account per accrual and count only ours.

### Anti-rug cap dropped: 60% for everyone, 70% for listed wallets (founder + team, 2026-10-07)

**Superseded by DBC v2 economics (2026-10-08) below: 70% for everyone, no latch, the table and env settings are gone.**

- `DBC_FIRST_BUY_MAX_BPS` = 6000, `DBC_FIRST_BUY_PARTNER_MAX_BPS` = 7000 (API settings can still override).
  Reason: follow the market; the 70% latch is for exclusive partner wallets, a marketing decision.
- Curve reality at $120 SOL: 60% costs 93 / 184 / 306 SOL ($15k / $30k / $50k) and fills ~72-73% of the
  curve; 70% costs 126 / 250 / 415 SOL, ~98-99% of the curve: the first buy all but completes bonding at
  launch. A full-curve first buy inside the create transaction has not been proven on a validator yet.
- pump.fun for comparison (public curve, 30 SOL / 1.073B virtual, 793.1M on the curve): 60% ~38 SOL, 70% ~56 SOL
  of the 85 SOL it raises. Their curve keeps more supply on the curve and starts cheaper.

### Referral fee fix (2026-10-07)

- Indexer: `referralPaidToUs` (dbcIndexer.ts) records `referral_ours` in the activity meta from the swap's
  accounts (our accounts = `DBC_REFERRAL_TOKEN_ACCOUNT(S)` on the indexer); `dbc_fee_accruals.referral_ours`
  (migration 20261007_000010, also added by the indexer). Finance lanes count only `referral_ours is true`.
- Backfill: `frontend/scripts/backfill-dbc-referral-ours.mjs <out.sql>` (read-only, writes SQL for the SQL
  editor). Run 2026-10-07: ours 25 rows / 0.062921655 SOL (= account 0.062891652 + 0.000030003 swept 10-01),
  not ours 87 rows / 0.064994601 SOL.

### DBC v2 economics (founder + team, 2026-10-08) -- built, proven on a local validator

Decisions: graduation by MARKET CAP, only $30K (fast) and $50K (normal, preselected), $15K gone; 1B supply =
85% curve / 13% pool / 2% creator reserve; graduation (migration) fee 2%, creator 0%, all through our finalize
fee routing (dbcGraduationSplit: recruiter / squad / airdrop, protocol the rest); Meteora's 0.2% liquidity
migration fee no longer compensated (D7 off for v2); creator first buy 70% for everyone, no per-wallet latch.
Everything else unchanged (2% trade fee, 90%->2% anti-sniper, fee choices, LP split, creator lock on later buys).
Modelled after stonk.xyz (Raydium LaunchLab, pump.fun curve: 30 SOL / 1.073B virtual, 793.1M on the curve,
graduates at 85 SOL = ~411 SOL MC, 0 migration fee).

- Builder (`api/lib/dbc/dbcLaunchConfigParams.mjs`): threshold = MC x 13 / 98 (`thresholdUsdMicrosForMarketCap`),
  Meteora `buildCurve` with `percentageSupplyOnMigration: 13`, `leftover: 1`, then ONLY its first segment.
  buildCurve's extra segment up to MAX_SQRT_PRICE makes the program demand a 25% swap buffer
  (`getSwapAmountWithBuffer`) that does not fit in 1B; ending at graduation the buffer is 0. SDK field for the
  graduation fee is `migrationFee: { feePercentage, creatorFeePercentage }`.
- Numbers at $120.40 SOL: $30K threshold 33.05 SOL, start MC $731, 70% first buy 14.2 SOL, public 15% for 19.5 SOL,
  our fee 0.661 SOL; $50K threshold 55.09 SOL, start MC $1,218, 70% 23.7 SOL, public 32.5 SOL, fee 1.102 SOL.
  The pool opens at the curve's last price; mint supply stays 1B (~10-14 tokens unused).
- Keeper (`dbcGraduationState.compensationApplies`): D7 only when the config gives the creator a share (v1 22/90);
  v2 goes withdraw -> route -> done. `expectedPartnerMigrationFee` and finance read each config's own percentages
  (`financeDbcPools` had `|| 90`, which read a v2 0% as 90%). `loadCreatorRewards` returns
  `creatorGraduationShare`; the rewards panel hides the payout row for v2 coins. Old coins keep v1 everywhere.
- Proofs (local validator with current mainnet DBC / DAMM v2 / locker / Metaplex; DBC pool authority must be
  funded, it pays the locker rent): `scripts/dbc/rehearse-v2-economics-local.sh` runs
  `prove-v2-economics-local.mjs` (SDK only) and, with `MWZ_DBC_V2_PROOF=prove-v2-flow-local.mjs`, our create API
  (ladder, quote, authorize 70% cap, finalize), browser submit + trade builder, indexer, fee accrual and the
  graduation keeper end to end. Both ALL CHECKS PASS (2026-10-08). Launch tx with first buy: 915 B / 18 accounts / 2 signers.
- `prove-stock-quote-local.mjs` still asks for the removed $15K target; update it before its next run.
