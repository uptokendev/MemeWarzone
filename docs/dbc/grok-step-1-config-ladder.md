# Grok brief, DBC step 1: the config ladder (v2, follows decisions D1-D17)

Read `docs/dbc/DBC_BUILD_PLAN.md` first, especially **Decisions D1-D17**. They are the authority.
Where this brief and a decision seem to disagree, the decision wins: stop and say so in your
hand-in report instead of choosing yourself.

## Branch rules (hard)

- Work in **your own clone** of the repository, never in `/mnt/e/network/Zakelijk/MemeWarzone`
  (that is the founder's working copy): `git clone https://github.com/uptokendev/MemeWarzone.git`.
- Branch from `build/dbc-staging`: `git switch -c grok/dbc-step-1 origin/build/dbc-staging`.
- Push **only** `grok/dbc-step-1`, then open **one pull request** from it into `build/dbc-staging`
  (`gh pr create --base build/dbc-staging --head grok/dbc-step-1`). Put the hand-in report in the
  pull request description.
- Never merge, never push to `build/*` or `fix/*`. Review fixes go on the same branch, so they land
  in the same pull request. Claude reviews and merges.
- Do not touch the existing Solana launchpad: nothing under `programs/`, nothing in
  `frontend/api/dev-fix/solana-*`, nothing in the existing CREATE / BUY / SELL client paths, no test
  pins, nothing in `scripts/solana/` except new files under `scripts/dbc/`.
- Build only what this brief asks for. No refactors, no renames, no "while I was here".
- Nothing on mainnet. Devnet only, with your own throwaway keys (never a key under
  `~/.config/memewarzone/` or `~/mwz-*.json`).

## What this step is

MemeWarzone adds a second Solana launch type on Meteora's Dynamic Bonding Curve (DBC, program
`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`), so coins trade on Jupiter while still on the curve.

A DBC **config** holds the curve, the fees and the graduation settings, and it can never change
after it is created. Like most DBC launchpads we create configs ahead of time on our server, so the
creator's launch transaction has only 2 signers (D10). Dollar targets become SOL amounts at the SOL
price of the moment, so we keep a **ladder**: one config per (target, SOL-price step, creator-fee
mode). A launch picks the config for the current SOL price.

Step 1 is only the server side of that ladder: build correct configs, create them on chain, verify
them, serve them. No UI, no create flow, no trading screen.

Read `tools/dbc-rehearsal/rehearse-dbc-devnet.mjs` and `tools/dbc-rehearsal/canary-dbc-mainnet.mjs`
before you start: they show every DBC call working on devnet and mainnet, and the traps:
SDK 1.5.13 `client.state.getPool` returns `{ poolState }`; measure amounts from the confirmed
transaction's own token balances, not from a second balance read.

## What every config must contain

### Fixed for every config

- Quote mint: native SOL. `TokenType.SPLToken`, decimals 6, `TokenAuthorityOption.Immutable`,
  `ActivationType.Timestamp`, `MigrationOption.MET_DAMM_V2`, `MigrationFeeOption.Customizable`.
- `feeClaimer` and `leftoverReceiver` = `DBC_FEE_COLLECTOR` (env). `poolCreationFee: 0`.
- **Trade fee (D1, D14):** 2% after launch. Anti-sniper at launch: the fee starts at **50%** and
  falls to **2%** over **60 seconds** (`BaseFeeMode.FeeSchedulerLinear` or `...Exponential`, pick
  the one whose fee at 5 s / 30 s / 60 s you can state in the hand-in). `dynamicFeeEnabled: false`,
  `CollectFeeMode.QuoteToken`. **`enableFirstSwapWithMinFee: true`**, so the creator's own buy in
  the launch transaction pays the normal 2% (D11). Prove that on devnet (below).
- **Graduation (D6):** `migrationFee: { feePercentage: 22, creatorFeePercentage: 90 }`: from what
  the curve raised, creator 19.8%, us 2.2%, pool 78%. The pool gets its tokens from its SOL at the
  curve's last price with no cap (DBC does this itself; do not reserve a fixed pool amount).
- **Graduated pool (D8):** `poolFeeBps: 25`, `MigratedCollectFeeMode.QuoteToken`, dynamic fee off;
  `creatorPermanentLockedLiquidityPercentage: 80`, `partnerPermanentLockedLiquidityPercentage: 20`,
  every other liquidity percentage 0.
- **Creator reserve (as today):** 2% of 1B = 20M tokens to the creator at graduation, as DBC
  `lockedVesting` released in full when the pool migrates. Find the smallest valid `lockedVesting`
  shape the SDK accepts for "everything at migration" and write it down.

### Per config

- **Target (D9):** $15K, $30K or $50K of raised SOL. `migrationQuoteThreshold` =
  `ceil(targetUsdMicros * 1e9 / stepUsdMicros)` lamports.
- **Price path:** today's launchpad sells along a straight line: price per whole token =
  1 lamport + 850 nano-lamports x (whole tokens sold). Source: `solanaCurveCostLamports` in
  `frontend/shared/solanaCampaignCurve.mjs` (economics v3), cumulative cost of the first `s` raw
  units = `base*s/1e6 + slope*s^2/(2*1e6*1e9*1e6)`. Build the DBC curve with
  `buildCurveWithCustomSqrtPrices` (max 16 points) so it follows that line from the start to the
  threshold. Pack the points where the price moves fastest (the start).
- **1B supply ceiling (D9):** total supply = tokens sold up to the threshold + pool tokens at the
  last price + 20M reserve. Only that is minted (`leftover: 0`). If the straight line would need
  more than 1,000,000,000 tokens (it does for $30K and $50K at today's SOL price), make **that
  config's** line steeper (raise the slope, keep the 1 lamport start) until the total is exactly
  1B or less. Report which configs were steepened and by how much.
- **Creator-fee mode (D3, D5):** two variants of every config:
  - `creator`: `creatorTradingFeePercentage: 7`, the creator claims it (choice "keep");
  - `platform`: `creatorTradingFeePercentage: 0`, the creator's share lands with our collector and
    is paid out later to holders, buyback & burn or the split (choices "holders", "buyback",
    "split"; step 5 does that payout).

### SOL-price steps

Geometric steps of 2%: `index = round(ln(solUsd) / ln(1.02))`, step price `= 1.02^index` in USD
micros. Integer, deterministic, identical on every machine: pin the rounding and test it. Live
price: `readSolUsdMicros({ maxStaleMs: 60_000 })` from `frontend/api/lib/solUsdMicros.js`. Refuse
(503) when the price is stale or missing.

## Deliverables

All runtime code under `frontend/` (the API image is built from `frontend/` only).

1. `frontend/shared/dbcEconomics.mjs`: every constant above in one place, each with a comment
   naming the decision (D-number) or today's source. No other file may hard-code these numbers.
2. `frontend/api/lib/dbc/dbcPriceSteps.mjs`: step index and step price.
3. `frontend/api/lib/dbc/dbcLaunchConfigParams.mjs`: pure.
   `(targetUsdMicros, stepUsdMicros, creatorFeeMode)` ->
   `{ configParams, expected: { thresholdLamports, soldRaw, poolLamports, poolTokens,
   creatorGraduationLamports, ourGraduationLamports, reserveTokens, totalTokenSupply, slopeUsed,
   steepened }, paramsHash }`. `paramsHash` = sha256 of the canonical JSON of the params.
4. `db/migrations/20260929_000001_dbc_launch_configs.sql`: table `dbc_launch_configs`
   (cluster, quote_mint, target_usd_micros, step_index, step_usd_micros, creator_fee_mode,
   params_hash, config_address, threshold_lamports, total_token_supply, create_signature,
   status `pending|active|failed`, verified_at, created_at); unique on (cluster, quote_mint,
   target_usd_micros, step_index, creator_fee_mode, params_hash). Follow `db/migrations/` style.
5. `frontend/api/lib/dbc/dbcConfigLadder.js`: `ensureLaunchConfig({ targetUsdMicros, stepIndex,
   creatorFeeMode })`:
   - returns the active row if it exists;
   - otherwise creates the config on chain, paid by `DBC_CONFIG_PAYER_SECRET` (inline JSON
     keypair), with a fresh config keypair thrown away after the transaction;
   - **reads the config back from chain and compares every field with the expected params**
     before marking it `active`; a mismatch marks it `failed` and it is never served;
   - one creation per key even under concurrent calls (Postgres advisory lock on the key);
   - checks the cluster from the RPC's genesis hash against `SOLANA_CLUSTER`
     (`SOLANA_GENESIS` in `frontend/src/lib/solanaArenaLayout.mjs`) and refuses a mismatch.
6. `GET /api/dbc/launch-config?chainId=101&targetUsd=15000|30000|50000&creatorFeeMode=creator|platform`
   -> `{ config, targetUsdMicros, stepIndex, stepUsdMicros, creatorFeeMode, thresholdLamports,
   totalTokenSupply, paramsHash, feeClaimer }`. Only these values are accepted, plus a **$150 test
   target when `SOLANA_CLUSTER=devnet`** (a real target costs ~130 SOL to fill; devnet cannot).
   Behind `DBC_LAUNCH_ENABLED`: off -> the same disabled response our other flagged routes use
   (find it, do not invent one). Mount it like the other routers in `frontend/api/server.mjs`.
7. `frontend/scripts/dbc-warm-configs.mjs` + npm script `cron:dbc-warm-configs`: keeps the current
   step ±2 ready for every target and both fee modes. `--dry-run` prints and sends nothing.
8. Add `@meteora-ag/dynamic-bonding-curve-sdk` **1.5.13 exactly** to `frontend/package.json`. Show
   that `npm run build` in `frontend/` still passes and no second `@solana/web3.js` breaks imports.
9. `scripts/dbc/prove-config-ladder-devnet.mjs`, devnet only (genesis
   `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, refuse anything else), its own throwaway keys:
   - create the $150 test config through `ensureLaunchConfig`, both fee modes, read them back;
   - on the `creator` one: createPool **with the creator's first buy of 10%** in the same
     transaction; measure that it paid 2%, not the anti-sniper fee;
   - a second wallet buys ~5 s later: measure the fee it paid;
   - buy to completion (PartialFill), migrate to DAMM v2 (`DAMM_V2_MIGRATION_FEE_ADDRESS[6]`),
     withdraw both migration fees, and check from the transactions: creator 19.8% / us 2.2% of the
     threshold, pool quote = 78% less Meteora's 0.2%, pool price == last curve price, pool tokens
     == pool SOL / last price, total supply == expected, creator reserve delivered;
   - print every signature.

## Tests (node:test, next to the code, `*.test.mjs`)

- Price path: for each target and SOL prices $50, $100, $118, $150, $200, $250, $400: cumulative
  cost of the DBC curve vs today's line at 50 points. Worst deviation ≤ 1% where not steepened;
  exact (±1 lamport) at the threshold. Print a table.
- Supply: `totalTokenSupply` ≤ 1B for every case; list the steepened cases with their slope.
- Graduation: creator 19.8% / us 2.2% / pool 78% of the threshold, per case, from the params.
- Anti-sniper: the fee at 0 s, 5 s, 30 s, 60 s, 120 s from the built params.
- `paramsHash` stable for equal input, different when any economic value changes.
- Step math: known prices -> known indices; neighbours differ by 2%.
- Ladder with a fake chain and fake DB: create; readback mismatch -> `failed`, not served; two
  concurrent calls -> one creation; stale price -> 503; flag off -> disabled response; unknown
  target or fee mode -> 400; $150 target refused unless devnet.
- `validateConfigParameters` from the SDK passes for every generated config.

## Hand-in report (in the pull request description, and paste the PR link to the founder)

- Branch and final commit hash; every file added or changed, one line each.
- Full test output and the tables (price path, supply/steepened, graduation, anti-sniper fee).
- Devnet proof: every signature and config address, and the measured numbers.
- Anything in this brief you could not follow, and why. Do not work around it silently.
- No user-visible text is expected in this step. If you add an error message a user can see, write
  it plainly: no em dashes, no slogans.
