# Grok brief, DBC step 4: the indexer

Read `docs/dbc/DBC_BUILD_PLAN.md` first: decisions D1-D18 and "Groundwork for steps 3-6" (step 4
part). Steps 1 and 2 are merged: DBC coins are `campaigns` rows with `launch_type = 'dbc'`,
`campaign_address` = the DBC pool, `token_address` = the mint, `meta.dbc` (config, target, fee choice,
first buy signature).

## Branch rules (hard)

- Your own clone. Branch `grok/dbc-step-4` from `origin/build/dbc-staging`; push only that branch; one
  pull request into `build/dbc-staging`. Never merge.
- Do not change how launchpad trades are ingested (`solanaIndexer.ts` event decoding and
  `insertTrade` for launchpad rows, `meteoraSwapIndexer.ts` for launchpad graduations). New code sits
  next to them. Guards that skip DBC rows were added in step 2; keep them.
- The proof script must run: execute it yourself on devnet if you can and paste the output.

## What this step delivers

DBC trades land in the same tables as launchpad trades, so the token page (trades list, chart,
stats, holders), the feeds and the leagues work for DBC coins without special cases downstream.

## 1. Ingest

- New `realtime-indexer/src/dbcIndexer.ts`, started like the meteora swap indexer:
  - pools = `campaigns` where `chain_id = 101 and launch_type = 'dbc'` and not migrated;
    **no silent cutoff** (the same rule as the meteora indexer fix: a bound that is reported);
  - `getSignaturesForAddress(pool)` with a cursor per pool (`indexer_state` key `solana:dbc:<pool>`),
    oldest first on backfill;
  - decode the DBC swap events with the SDK's IDL (`DynamicBondingCurveIdl`, event `EvtSwap2`; read
    the IDL for the exact fields: direction, amounts in/out, trading fee, protocol fee, referral fee).
- Write each swap to **`curve_trades`**, launchpad conventions:
  - `chain_id 101`, `campaign_address` = pool, `tx_hash`, `log_index` = event index in the transaction
    (**below 20000**: DBC bonding trades pay the league through our collector, so they count in the
    league pot; 20000+ is reserved for post-graduation pool swaps, which do not),
    `block_number` = slot, `block_time`, `side`, `wallet` = the trader (the swap's owner account, not a
    fee payer that may differ);
  - `token_amount_raw`, `bnb_amount_raw` = **SOL in including the fee for a buy, SOL out after the fee
    for a sell** (settlement inverts the 2% fee from this number: a different convention breaks the
    league pot), `price_bnb`;
  - add a nullable `curve_trades.venue` (`'dbc'` for these rows; existing rows stay null) in a
    migration, so later code can tell venues apart without the `log_index` trick.
- Same fan-out as launchpad trades: `activity_events` (fee lamports in meta), Ably trade publish,
  `token_candles` (`upsertCandle`), `token_stats` (`patchStats`). Candles use the **trade price**; the
  canonical candle materializer's launchpad spot calculator must not be applied to DBC rows (skip
  `venue = 'dbc'` there, or use the trade price for them).

## 2. Market data for DBC coins

- `market_stats` (chain 101) for DBC coins: price from the pool's sqrt price, supply = the config's
  post-migration (circulating) supply, liquidity = the pool's quote reserve, progress to graduation =
  quote reserve / `migrationQuoteThreshold`. Extend `solanaMarketStats.ts` with a DBC branch; the
  launchpad branch is unchanged.
- Holders: `/api/solana/holders` excludes the launchpad Campaign PDA from the count; for a DBC coin
  exclude the pool's base vault instead.

## 3. Leagues (D13)

- The league queries already exclude the creator's own wallet from biggest_hit, top_earner (settlement
  fixed on 2026-09-28) and fastest_finish buyer counts, which covers "no creator buy counts" as long as
  `campaigns.creator_address` is the DBC creator (step 2 writes it). Verify with a test that a DBC
  creator's first buy and locked buys do not appear in any category, and that other wallets' DBC
  trades do.
- The league pot counts DBC bonding trades (log_index < 20000) at the same 0.75% as launchpad trades.
  Step 5 routes exactly that share from our collector into the league vault; this step only has to
  write the rows.

## 4. Hand-off at graduation

- When a pool reports migrated, stop scanning it. Step 6 writes `meta.solanaGraduation`
  (`dex = 'meteora-damm-v2'`, `pool`, `slot`) so the meteora swap indexer picks the graduated pool up
  exactly like a launchpad graduation.

## Tests

- Unit: `EvtSwap2` decode from a recorded devnet transaction (store the fixture); the curve_trades row
  for a buy and a sell (bnb_amount_raw convention, log_index < 20000, venue); market_stats DBC branch
  from a fixture pool; candle materializer skips DBC rows; league categories exclude the DBC creator.
- `scripts/dbc/prove-indexer-devnet.mjs`: create a $150 devnet coin through step 2's handler (or reuse
  one), do two buys and a sell from another wallet, run one `dbcIndexer` pass against an in-memory DB
  (or a local Postgres), and print the rows it wrote next to the transactions' own balance changes;
  they must agree to the lamport.

## Hand-in (PR description)

Branch and commit, every file one line, test output, the proof output, and anything you could not
follow and why.
