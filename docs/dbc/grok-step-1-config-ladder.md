# Grok brief, DBC step 1: the config ladder

Read this whole brief before writing code. Read `docs/dbc/DBC_BUILD_PLAN.md` too, but where this
brief is more specific, this brief wins.

## Branch rules (hard)

- Start from `build/dbc-staging` (`git fetch origin && git switch -c grok/dbc-step-1 origin/build/dbc-staging`).
- Commit and push **only** `grok/dbc-step-1`. Never push to, merge into, or open a merge into any
  `build/*` branch. Claude reviews your branch and merges it.
- Do not touch the existing Solana launchpad: nothing under `programs/`, nothing in
  `frontend/api/dev-fix/solana-*`, nothing in the CREATE / BUY / SELL client paths, no test pins.
  If you think one of those must change, stop and write it in your hand-in report instead.
- Do not do anything this brief does not ask for. No refactors, no renames, no "while I was here".
- Nothing on mainnet. Devnet only for the proof script, with its own throwaway keys.

## What we are building and why

MemeWarzone is adding a second Solana launch type on Meteora's Dynamic Bonding Curve (DBC,
program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`), so coins trade on Jupiter while still on
the curve. It has to behave as close as possible to our existing launchpad: same price path, same
targets, same fees, same graduation outcome.

A DBC **config** holds the curve, the fees and the graduation settings, and it can never change.
Most DBC launchpads create configs ahead of time, so the creator's launch transaction only has 2
signers (their wallet + the new token's key). We do the same. Our dollar targets
($15K / $30K / $50K) become SOL amounts at the SOL price of the moment, so we keep a **ladder**:
one config per (target, SOL-price step). A launch picks the config for the current SOL price.

Step 1 is only the server side of that ladder. No UI, no create flow, no trading.

## Today's launchpad: the numbers you must match

Read these from the code, not from memory. Live mainnet GenerationConfig `EsCZKsKD…`:
supply 1,000,000,000, decimals 6, curve supply 84% (840M), liquidity supply 14% (140M), creator
reserve 2% (20M, the remainder), base price 1 lamport, slope 850 nano-lamports, buy/sell fee 2%,
graduation (finalize) fee 2%, liquidity-post-finalize 80%.

- **Price path:** `solanaCurveCostLamports` in `frontend/shared/solanaCampaignCurve.mjs`
  (economics v3). Cost to buy the first `s` raw units =
  `base*s/scale + slope*s^2 / (2 * scale * 1e9 * scale)`, `scale = 1e6`.
- **When the curve closes:** `solanaCurveCloseLamports` in the same file: the target in lamports
  (`targetUsdMicros * 1e9 / solUsdMicros`), **capped at the cost of the full 840M**. The full curve
  is only 300.72 SOL, so a $50K target closes on supply whenever SOL is below about $166.
- **Graduation:** `graduationLiquidityQuote` in `frontend/api/dev-fix/solana-graduation-authorization-v2.js`
  (read it, do not import it into new code, copy the math into the new module with a comment
  naming its source). From the net raised `R`: protocol fee 2% of `R`; the pool gets tokens at the
  curve's final spot price, **capped at the 140M liquidity supply**; the creator gets everything
  else in SOL. Unsold curve tokens and unused liquidity tokens are burned. The 20M reserve goes to
  the creator. At every realistic SOL price the 140M cap binds, so the creator gets 23% to 65% of
  `R`, not 20%. Examples (computed from that code):

  | SOL | target | raised | pool | creator | protocol |
  |---|---|---|---|---|---|
  | $150 | $15K | 100.0 SOL | 57.7% + 140M | 40.3% | 2% |
  | $150 | $30K | 200.0 SOL | 40.8% + 140M | 57.2% | 2% |
  | $150 | $50K | 300.7 SOL (supply) | 33.3% + 140M | 64.7% | 2% |
  | $250 | $15K | 60.0 SOL | 74.5% + 140M | 23.5% | 2% |

## How each DBC config mirrors that

For a target `T` and a SOL-price step `P`:

1. `thresholdLamports = min(ceil(T * 1e9 / P), fullCurveCost)`: the same close rule as today.
2. `soldRaw` = the raw token amount today's curve has sold when it reaches `thresholdLamports`.
3. **Curve:** DBC segments (`buildCurveWithCustomSqrtPrices`, max 16 points) that follow today's
   linear price from the start to `soldRaw`. Pack the points where the price moves fastest (the
   start). The curve must end exactly at `thresholdLamports` with `soldRaw` sold.
4. **Graduation split:** today's `graduationLiquidityQuote` gives `poolLamports`, `poolTokens`
   (≤ 140M), `creatorLamports`, `protocolLamports`. DBC's graduation fee is a whole percent of the
   threshold, with the creator's share of that fee a whole percent:
   - `migrationFeePct = ceil(100 * (1 - poolLamports / thresholdLamports))`: rounding up keeps the
     pool at or below today's 140M.
   - `creatorFeePct = floor(100 * creatorLamports / (thresholdLamports * migrationFeePct / 100))`:
     rounding down keeps our share at or above today's 2%.
   - Both must pass the SDK's `validateMigrationFee` (fee 0..99, creator 0..100).
5. **Supply:** today mints 1B and burns what is unused. DBC mints only what the config needs, so
   `totalTokenSupply = soldRaw + migration base amount + 20M creator reserve`, `leftover = 0`.
   The net result equals today's after burning. Never above 1B.
6. **Creator reserve:** 20M as DBC `lockedVesting`, released in full at migration.
7. **Fees and the rest are fixed for every config:**
   - trade fee 2% flat (`BaseFeeMode.FeeSchedulerLinear`, start = end = 200 bps, 0 periods);
     dynamic fee off; `CollectFeeMode.QuoteToken`; `creatorTradingFeePercentage: 7`;
     `poolCreationFee: 0`; `enableFirstSwapWithMinFee: false`;
   - `MigrationOption.MET_DAMM_V2`; `MigrationFeeOption.Customizable`; graduated pool
     `poolFeeBps: 25`, `MigratedCollectFeeMode.QuoteToken`, dynamic fee disabled;
   - LP split: `creatorPermanentLockedLiquidityPercentage: 80`,
     `partnerPermanentLockedLiquidityPercentage: 20`, everything else 0;
   - `TokenType.SPLToken`, decimals 6, `TokenAuthorityOption.Immutable`;
     `ActivationType.Timestamp`; quote mint = native SOL;
   - `feeClaimer` and `leftoverReceiver` = `DBC_FEE_COLLECTOR`.

The devnet rehearsal `tools/dbc-rehearsal/rehearse-dbc-devnet.mjs` shows every one of these
settings working end to end. Read it before you start. Note: SDK 1.5.13 `client.state.getPool`
returns `{ poolState }`.

## SOL-price steps

Geometric steps of 2%: `index = round(ln(solUsd) / ln(1.02))`, step price `= 1.02^index` in USD
micros (integer, deterministic, identical on every machine: compute with integer or fixed
arithmetic, or pin the rounding and test it). A launch uses the step nearest the live price, so
the SOL target is within about 1% of the exact dollar target. Live price: `readSolUsdMicros({ maxStaleMs: 60_000 })`
from `frontend/api/lib/solUsdMicros.js`. Refuse (503) when the price is stale or missing.

## Deliverables

All new code under `frontend/` (the API image is built from `frontend/` only).

1. `frontend/shared/dbcEconomics.mjs`: every constant above in one place, each with a comment
   naming where today's value comes from. No other file may hard-code these numbers.
2. `frontend/api/lib/dbc/dbcPriceSteps.mjs`: step index and step price.
3. `frontend/api/lib/dbc/dbcLaunchConfigParams.mjs`: pure. `(targetUsdMicros, stepUsdMicros)` →
   `{ configParams, expected: { thresholdLamports, soldRaw, poolLamports, poolTokens,
   creatorLamports, protocolLamports, migrationFeePct, creatorFeePct, totalTokenSupply },
   paramsHash }`. `paramsHash` = sha256 of the canonical JSON of the params, so any change to the
   economics produces a different ladder.
4. `db/migrations/20260929_000001_dbc_launch_configs.sql`: table `dbc_launch_configs` (cluster,
   quote_mint, target_usd_micros, step_index, step_usd_micros, params_hash, config_address,
   threshold_lamports, migration_fee_pct, creator_fee_pct, create_signature, status
   `pending|active|failed`, verified_at, created_at). Unique on
   (cluster, quote_mint, target_usd_micros, step_index, params_hash). Follow the style of the other
   files in `db/migrations/`.
5. `frontend/api/lib/dbc/dbcConfigLadder.js`: `ensureLaunchConfig({ targetUsdMicros, stepIndex })`:
   - returns the active row if it exists;
   - otherwise creates the config on chain, paid by `DBC_CONFIG_PAYER_SECRET` (inline JSON keypair,
     the same inline format our other workers accept), with a fresh config keypair that is thrown
     away after the transaction;
   - **reads the config back from chain and compares every field with the expected params** before
     marking it `active`. A mismatch marks it `failed` and is never served;
   - one creation per key even under concurrent calls (Postgres advisory lock on the key);
   - checks the cluster from the RPC's genesis hash against `SOLANA_CLUSTER` and refuses a mismatch
     (see `SOLANA_GENESIS` in `frontend/src/lib/solanaArenaLayout.mjs`).
6. `GET /api/dbc/launch-config?chainId=101&targetUsd=15000|30000|50000`, returning
   `{ config, targetUsdMicros, stepIndex, stepUsdMicros, thresholdLamports, migrationFeePct,
   creatorFeePct, paramsHash, feeClaimer }`. Only the three targets are accepted. Behind the flag
   `DBC_LAUNCH_ENABLED` (off → the same disabled response shape our other flagged routes use; find
   it, do not invent one). Mount it the way the other `/api/...` routers are mounted in
   `frontend/api/server.mjs`.
7. `frontend/scripts/dbc-warm-configs.mjs` + npm script `cron:dbc-warm-configs`: keeps the current
   step ±2 ready for all three targets. `--dry-run` prints what it would create and sends nothing.
8. Add `@meteora-ag/dynamic-bonding-curve-sdk` **1.5.13 exactly** to `frontend/package.json`.
   Show that `npm run build` in `frontend/` still passes and that no second copy of
   `@solana/web3.js` breaks existing imports.
9. `scripts/dbc/prove-config-ladder-devnet.mjs`: on devnet (genesis
   `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, refuse anything else), with its own throwaway
   payer funded from an airdrop or a key the founder gives:
   - create one config per target at the current step through `ensureLaunchConfig`, read them back;
   - on one of them: createPool, buy to completion with PartialFill, and check that the pool's
     quote reserve reached `thresholdLamports`;
   - print every signature.

## Tests (node:test, next to the code, `*.test.mjs`)

- **Price path parity:** for each target and SOL prices $50, $100, $150, $200, $250, $400: compare
  the DBC curve's cumulative cost (SDK `getQuoteFromInputAmount` / swap math on the built config)
  with `solanaCurveCostLamports` at 50 points from 1% to 100% of `soldRaw`. Report the worst
  deviation. It must be ≤ 1% everywhere, and exact (±1 lamport) at the threshold.
- **Graduation parity:** at the same prices: DBC pool tokens ≤ today's `poolTokens` and within 1%
  of it; creator SOL within 1 whole percentage point of today's; our SOL ≥ today's 2%. Print a
  table like the one above for the hand-in.
- **Supply:** `totalTokenSupply` equals today's post-burn supply within rounding, never above 1B.
- `paramsHash` stable for equal input, different when any economic value changes.
- Step math: known prices map to known indices; neighbours differ by 2%.
- Ladder with a fake chain and a fake DB: create, readback mismatch → `failed` and not served,
  two concurrent calls → one creation, stale price → 503, flag off → disabled response, unknown
  target → 400.
- `validateConfigParameters` from the SDK passes for every generated config.

## Hand-in report (paste this back to the founder)

- Branch and final commit hash.
- Every file added or changed, one line each.
- Full test output.
- The parity tables (price path worst deviation per case; graduation per case).
- Devnet proof: every signature and the config addresses.
- Any place where you could not follow this brief, and why. Do not work around it silently.
- User-visible text: none is expected in this step. If you add any error message a user can see,
  write it plainly, no em dashes, no slogans.
