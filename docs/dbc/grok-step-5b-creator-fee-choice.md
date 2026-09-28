# Grok brief, DBC step 5b: paying out the creator-fee choice

Read `docs/dbc/DBC_BUILD_PLAN.md` first (D5, and the step 5 reviews). Start from `build/dbc-staging`
after step 5 is merged (it is: `f8919bda`). Step 6 may run in parallel; do not touch its files.

## Branch rules (hard)

Own clone; branch `grok/dbc-step-5b` from `origin/build/dbc-staging`; one pull request into
`build/dbc-staging`; never merge. Run every proof yourself and paste the output. Nothing on mainnet.
Do not change the launchpad's airdrop results: trader (code 0) and creator (code 1) leaves, their
amounts and the weekly pot calculation stay exactly as they are.

## What this step delivers

A DBC creator who chose `holders`, `split` or `buyback` at launch gets what they chose. Step 5 already
sets their share aside: every accrual of a platform-mode coin has `creator_pool` lamports that stay on
the collector (7% of the trading fee, `floor(trading_fee x 7 / 100)`). This step pays that money out
and marks it paid. `keep` coins need nothing here (the creator claims from the pool on chain).

Choice fields: `campaigns.meta.dbc.feeChoice` (`keep | holders | split | buyback`) and
`meta.dbc.creatorSharePct` (split only, 1..99 = the creator's percent; holders get the rest). Finalize
writes both (`frontend/api/dbc/create.js` ~600).

## Facts to build on

- **The creator pool is claimed money on the collector**, not a pool counter. Only rows with status
  `claimed`, `routing` or `routed` are on the collector. Never pay out `accrued` or `claiming` rows.
- **The router counts every claimed/routed row's `creator_pool` as held** (`dbcFeeRouter.ts`,
  `collectorNeed`). Paying out must change that: add a paid marker per accrual (for example
  `creator_pool_paid_id` referencing the payout), and the router's held sum must exclude paid rows.
  Test it: after a payout the router's need drops by exactly the paid amount.
- **Solana airdrop claims already exist.** `frontend/scripts/weekly-airdrop/solanaAirdrop.mjs` builds
  one merkle batch per week (PDA `["airdrop_batch", epoch_id]`), leaf =
  `airdrop_leaf(epoch_id, program_code, winner, amount)`, posted by the reward poster with
  `post_airdrop_batch_root`, claimed from `airdrop_vault` with `claim_airdrop`. `program_code` is any
  `u8` and the claim receipt is keyed by (epoch, code, wallet) (`mwz_rewards_treasury/src/lib.rs`
  ~481, ~1089). Codes 0 and 1 are taken. **Holder payouts are code 2, in the same weekly batch.**
  No program change.
- The batch PDA is per epoch and a posted root cannot change. So holder leaves must be built **inside
  the same weekly run** (`run-solana-weekly-airdrop.mjs`), before the root is posted.
- `readSolanaAirdropPool` prices the trader/creator pot from `airdrop_vault`'s balance. The holder
  lamports must not be counted in that pot. Order in the run: (1) compute the trader/creator pot
  exactly as today; (2) deposit the week's holder total from the collector into `airdrop_vault`;
  (3) build the root with codes 0, 1 and 2, `totalLamports` = old total + holder total; (4) post. If
  (2) lands but (4) fails, the next run must see the deposit already made and not deposit again.
- The minimum payout rule applies (`SOLANA_MIN_PAYOUT_LAMPORTS`, 0.005 SOL, `shared/pokerPayout.mjs`
  `solanaMinPayoutLamports`): no leaf below it.

## Build

Every SOL movement uses step 5's pattern: sign, store status + signature + `last_valid_block_height`,
then send; the next pass resolves with `getSignatureStatuses` and `getBlockHeight` (never `getSlot`).
Never reset a send that may have landed. Update rows by id. One table for all three kinds:
`dbc_creator_pool_payouts` (id, pool, kind `holders | creator | buyback`, epoch_id, lamports,
tokens_burned, recipient, signature, last_valid_block_height, status, created_at).

1. **Split, creator part:** once a week (same run), for each `split` coin:
   `floor(unpaid creator_pool x creatorSharePct / 100)` goes to the creator's wallet by System
   transfer from the collector. The rest is the coin's holder amount for the week.
2. **Holders** (`holders` coins, and the non-creator part of `split`):
   - Snapshot: token balances of the mint at one moment in the week, chosen from the week's committed
     secret (below), so nobody can buy just before a known snapshot. Read all token accounts of the
     mint (`getProgramAccounts`, Token program, mint filter) at that moment. The snapshot job runs
     through the week and stores the balances when its moment comes.
   - Excluded: the DBC pool's base vault, the DAMM v2 pool vaults after graduation, Jupiter Lock
     escrows, the creator, the collector, the referral owner and any wallet on
     `publicHidden`/excluded lists the league already uses.
   - Pro rata by balance, floor, remainder to the largest holder. Aggregate per wallet across every
     coin that pays holders that week: **one code-2 leaf per wallet**.
   - A holder whose share is below the minimum gets nothing this week. That part stays in the
     coin's unpaid pool and rolls into next week. It is not given to the other holders.
3. **Buyback & burn** (`buyback` coins):
   - Randomness: one secret per week, `DBC_BUYBACK_SEED_SECRET`, used like `AIRDROP_DRAW_SEED_SECRET`.
     Publish `sha256(secret)` before the week starts and the secret after it ends (a public API
     route). A buy moment for coin C on day D, slot i = `HMAC(secret, C|D|i)` mapped into that day;
     up to `DBC_BUYBACK_MAX_PER_DAY` (default 4) moments.
   - At a moment: size the buy so the quote moves the price by at most 0.5%
     (`DBC_BUYBACK_MAX_IMPACT_BPS=50`, measured with the step-3 quote), capped by the coin's unpaid
     pool. On the curve use `swap2` ExactIn; after graduation use the DAMM v2 pool (step 3's post-grad
     path). **Buy and burn in one transaction**: the swap into the collector's token account, then SPL
     `burn` of exactly the tokens the swap returned. Skip a coin whose curve is above 95% of its
     threshold (a buyback should not be the buy that graduates it).
   - Buybacks must not score in leagues. The collector's buys are trades by the collector wallet:
     exclude the collector (and the referral owner) from every league category the creator is already
     excluded from, and from the pot volume if the pot counts it. Add the test.
   - Record `tokens_burned` from the transaction's own token balances, and check the mint's supply
     dropped by exactly that amount.
4. **Visible on the token page:** one line under the fee choice, plain text:
   `Holders: 0.84 SOL paid so far, next payout Monday` /
   `Buyback: 1.2 SOL bought and 3,400,000 tokens burned so far` /
   `Split: 60% to the creator, 40% to holders`.
   Holders see their code-2 amount in the existing Claim Center (the code needs a label:
   "Coin holder reward").

## Tests (throwaway Postgres, `scripts/dbc/throwaway-postgres.mjs`)

- Split: the creator part and the holder part add up to the unpaid pool exactly; one payout per week.
- Holders: pro rata, exclusions, per-wallet aggregation across coins, below-minimum rolls over,
  the deposit is not made twice when the post fails after it, codes 0/1 leaves and totals unchanged.
- Buyback: moments come from the secret (same secret, same moments), impact cap, 95% skip, the
  collector does not appear in league categories.
- The router's held sum drops by exactly what was paid.

## Proofs

Check first whether the devnet treasury has `post_airdrop_batch_root` (the certified mainnet treasury
is `1840a9e7…`, `config/solana/treasury-binary.certification.json`; devnet ran an older binary). If it
does not, prove the holders part on a local validator with that certified treasury `.so` plus the DBC
program cloned (`solana-test-validator --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN --url devnet`
and the accounts it needs), like `scripts/solana/rehearse-mainnet-treasury-upgrade.sh`. Do not upgrade
devnet.

`scripts/dbc/prove-creator-fee-choice.mjs`: three platform-mode coins (holders, split 60, buyback),
trades from three wallets, one step-4/5 pass, then one 5b run:
- split: the creator's wallet delta equals 60% of that coin's unpaid pool, to the lamport;
- holders: the airdrop vault delta equals the holder total; each holder claims its code-2 leaf and its
  wallet delta equals the leaf amount (minus the claim fee, stated); a below-minimum holder has no leaf
  and the amount is still unpaid;
- buyback: the mint supply dropped by exactly the tokens the swap returned, the price impact of the buy
  was at most 0.5%, and the collector's balance dropped by exactly the buy amount plus the fee;
- the router's held sum after the run equals the previous sum minus everything paid.

## Hand-in (PR description)

Branch and commit, every file one line, test output, proof output, and anything you could not follow
and why. Copy: plain sentences, no em dashes, no slogans.
