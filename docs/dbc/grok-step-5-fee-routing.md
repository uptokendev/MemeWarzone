# Grok brief, DBC step 5: fee routing into our vaults

Read `docs/dbc/DBC_BUILD_PLAN.md` first (D1-D18; "Groundwork for steps 3-6", step 5 part). This step
needs step 4's rows: start from `build/dbc-staging` **after step 4 is merged** (Claude tells you).
Holders / buyback / split payouts of the creator-fee choice are **step 5b**, not here.

## Branch rules (hard)

Own clone; branch `grok/dbc-step-5` from `origin/build/dbc-staging`; push only that branch; one pull
request into `build/dbc-staging`. Never merge. Run the devnet proof yourself where you can and paste
the output. Nothing on mainnet.

## What this step delivers

The part of every DBC trade fee that reaches our collector lands in the same vaults, in the same
proportions, as a launchpad fee today (D4), with recruiter / squad / airdrop credit per trade.

## The money, per trade (from `EvtSwap2`, fee F = trading_fee + protocol_fee + referral_fee)

- Meteora keeps `protocol_fee`; our referral account got `referral_fee` when the trade named it.
- `trading_fee` is 80% of F. Creator mode: the creator's 7% of it stays in the pool for the creator;
  our collector gets `trading_fee - floor(trading_fee x 7 / 100)`. Platform mode (config fee 0%): the
  collector gets the whole `trading_fee`, and sets aside `floor(trading_fee x 7 / 100)` as the
  **creator pool** of that coin (paid out in step 5b by the creator's choice).
- Slices, as shares of the **whole** fee F (today's route, `preview_bnb_route` kind 0):
  | trader profile | league (weekly 30 / monthly 70) | recruiter | squad | airdrop |
  |---|---|---|---|---|
  | linked | 37.5% | 12.5% | 2.5% | 0 |
  | OG | 37.5% | 15% | 2.5% | 0 |
  | unlinked | 37.5% | 0 | 0 | 15% |
  Protocol = what the collector received for that trade minus the slices (minus the creator pool in
  platform mode); rounding dust to protocol. Assert it is never negative. Referral income is protocol.
- Trader profile: the same lookup as trade signing, **at trade time** (`wallet_recruiter_links` +
  `recruiters.is_og`, preferring the link active at the trade's time like `creditRecruiterEarnings`).
- The anti-sniper fee is split the same way (a sniper's 50% fee funds the league like any fee).

## Build

1. **Accrual** (`realtime-indexer/src/dbc/dbcFeeAccruals.ts`): for each DBC trade row from step 4
   (idempotent on tx + log_index) write `dbc_fee_accruals` (pool, tx, log_index, trader, profile,
   F, trading_fee, protocol_fee, referral_fee, collector_amount, league_weekly, league_monthly,
   recruiter, squad, airdrop, protocol, creator_pool, status `accrued|claimed|routed`), and a
   `reward_events` row (chain 101, `matched_activity_source = 'dbc_collector'`, `route_kind='trade'`,
   profile names as today, amounts = the slices) so recruiter / squad / airdrop crediting and the
   weekly jobs work unchanged. Check the `reward_events` constraints on production (the original
   migration had lowercase CHECKs; base58 must pass) and include a migration if needed.
2. **Claim** (`dbcFeeClaimer.ts`): per DBC pool with unclaimed partner fees above a threshold,
   `claimPartnerTradingFee` to the collector (the collector key `DBC_FEE_COLLECTOR_SECRET`, inline
   JSON like our other workers; never the deployer). Measure the claimed lamports **at the pool's quote
   vault in that transaction** (wallet deltas include returned WSOL rent). Reconcile: claimed must equal
   the pool's partner-fee counter drop and the sum of that pool's accrued collector amounts (rounding
   tolerance stated); a mismatch stops routing for that pool and logs it.
3. **Route** (`dbcFeeRouter.ts`, hourly and on demand): for claimed accruals, System-transfer the summed
   slices from the collector to `league_vault` (weekly), `monthly_league_vault`, `recruiter_vault`,
   `squad_vault`, `airdrop_vault`, and **protocol into `protocol_vault`** (never to the operator: the
   existing `flush_operator_fill` applies the $10k cap and sends the rest to the multisig). Creator pool
   amounts stay in a separate collector bucket for step 5b. Mark accruals `routed` with the signature;
   one transaction per run, fail-closed if the collector is short.
4. **Referral sweep**: the referral account (WSOL, owned by the referral key) is swept to
   `protocol_vault` weekly: unwrap by transferring the WSOL out and syncing, **without closing the
   account** (closing it breaks every later swap naming it).
5. Run it inside the indexer next to `solanaFeeEscrowWorker.ts`, same start/stop pattern, flags
   `DBC_FEE_ROUTING_ENABLED`, `DBC_FEE_ROUTING_SEND` (dry run otherwise).

## Tests

- Unit: slices for linked / OG / unlinked, creator vs platform mode, a sniper fee, rounding (sum of
  slices + protocol + creator pool == collector amount exactly); reward_events row shape; reconcile
  mismatch stops routing; router refuses when the collector is short; referral sweep keeps the account.
- `scripts/dbc/prove-fee-routing-devnet.mjs`: a $150 devnet coin from step 2's handler, trades from a
  linked, an OG and an unlinked wallet (link them in the in-memory DB), one indexer pass (step 4), one
  accrual, claim and route pass; print each vault's balance change from the routing transaction and
  compare with the expected slices to the lamport.

## Hand-in (PR description)

Branch and commit, every file one line, test output, proof output, anything you could not follow.
