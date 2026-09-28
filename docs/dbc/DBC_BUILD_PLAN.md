# Meteora DBC launch type: build plan and progress

This file tracks the build of the DBC launch type. It is separate from `CLAUDE.md`. Every step,
every decision and every review result goes here, so the build does not drift from the plan.

## How we work (founder, 2026-09-28)

1. **As close as possible to what we already have.** Same fees, same rewards, same payouts, same
   graduation outcome. Where DBC forces a difference, it is written in the parity table below with
   the reason. A new difference is not allowed without the founder's decision.
2. **Grok builds, Claude orchestrates. Grok works on its own pull request** (founder, 2026-09-28):
   - Grok uses **its own clone** of the repository (or its own `git worktree`), never the founder's
     working copy at `/mnt/e/network/Zakelijk/MemeWarzone`. Sharing one folder let changes from one
     side appear in the other's uncommitted files.
   - One branch per step, `grok/dbc-step-<n>`, cut from `build/dbc-staging`. Grok pushes only that
     branch and opens **one pull request** from it into `build/dbc-staging`.
   - Grok never merges, never pushes to `build/*` or `fix/*`, never force-pushes someone else's
     branch. Fixes after review go on the same branch, so they land in the same pull request.
   - Claude reviews the pull request (full diff, tests, the brief's hand-in items) and merges it.
3. **Fast.** One brief per step. The founder hands Grok the brief, then hands Grok's output to
   Claude. Claude reviews. After a clear review, the next step's brief.
4. Each step needs the founder's go before the next one starts.
5. Nothing reaches the live branch `build/cross-chain-stabilization-rh-base` until the founder says
   so. The existing launchpad's CREATE / BUY / SELL flow is not touched by any step.

Branches: staging `build/dbc-staging` (cut from `dbea13d6`). Grok: `grok/dbc-step-<n>`.

## Decisions (founder, 2026-09-28): the authority for every brief

These win over anything else in this file or in a brief. A change needs the founder.

**Fees**
- **D1. Trade fee 2%, buy and sell. No extra tax, no transfer tax, no higher fee tiers.**
- **D2. Meteora's 20% of the fee comes out of the protocol share.** On trades built by our site the
  swap names our referral account, which gets 20% of Meteora's cut back. That account must be one no
  fee claim ever closes (the SDK claim closes the claimer's WSOL account).
- **D3. Creator trading fee: `creatorTradingFeePercentage` 7** (7% of the post-Meteora 80% = 5.6% of
  the fee; today 5%, DBC takes whole percents only).
- **D4. The rest of the fee is split exactly as today**, as shares of the whole 2% fee: league 37.5%
  (weekly 30 / monthly 70), recruiter 12.5% (OG 15%), squad 2.5%, protocol the rest. No recruiter
  link: recruiter + squad go to the airdrop. Trades use the trader's link, graduation the creator's.
- **D5. Creator fee choice at launch: keep / give to holders / split / buyback & burn.**
  - Holders: paid through our weekly airdrop pipeline (the same claims people use today).
  - Buyback & burn: no fixed schedule. Buys happen at random moments during the week, the moments
    come from a secret that is published afterwards (as `AIRDROP_DRAW_SEED_SECRET`), each buy moves
    the price by at most ~0.5%, and claim + buy + burn happen in one transaction. With 2% fee each
    way a sniper pays ~4% per round trip, more than any single buyback moves the price.

**Graduation**
- **D6. The pool gets exactly the tokens its SOL needs at the curve's last price, with no cap**
  (the original design; DBC does this natively, proven: DBC final price == pool start price).
  Split of what the curve raised: 2% to us, then the creator gets 20% of the rest (19.6%), the pool
  the other 78.4%. DBC takes whole percents: migration fee 22%, creator share 90% (creator 19.8%,
  us 2.2%, pool 78%). Our graduation share is split like today's graduation fee (D4, creator's link).
- **D7. Meteora's 0.2% liquidity cut at graduation is paid back to the creator from our share** by
  the graduation keeper.
- **D8. Graduated pool: 0.25% fee, SOL-only fee collection, 100% permanently locked, LP fees 80%
  creator / 20% us.**
- **D9. Targets $15K / $30K / $50K** of raised SOL, fixed in SOL at launch from the SOL price step
  (ladder of pre-made configs, 2% steps). If a target would need more than 1B total supply, the
  curve for that config is made steeper so sold + pool + creator reserve fits in 1B (founder: "b").

**Launch**
- **D10. The creator's launch transaction is 2 signers** (wallet + new token key); our server makes
  the configs ahead of time.
- **D11. Creator first buy: up to 10% of supply, in the launch transaction, unlocked.**
- **D12. Any further creator buy through our site is locked** in an existing, proven lock program
  (Jupiter Lock `LocpQguc…`, the same program Meteora's DBC uses for its own vesting)
  **Timing (founder, 2026-09-28, option A): first 20% after 30 days, then 20% every 7 days; fully
  free after 58 days.**
  (option A, released by date; no lock program of our own): released in 5 steps of 20%. The coin
  shows a badge with how much the creator holds and how much is locked. Buys made elsewhere or from
  other wallets cannot be locked, by anyone.
- **D13. No creator buy counts for the leagues** (first buy or locked buys).
- **D14. Anti-sniper fee is a must:** the fee starts high and falls to 2% shortly after launch; the
  creator's first buy in the launch transaction pays the normal 2% (`enableFirstSwapWithMinFee`).
  Exact start fee and duration are set in step 1 (proposal: 50% falling to 2% over 60 s).
- **D15. Every quote token we can offer** (stocks and others) via Meteora TokenBadges + a liquidity
  filter (step 7).

- **D18. Scheduled launches (founder, 2026-09-28): the creator deploys when the timer ends.** DBC
  pools trade from the moment they are created (the program sets the activation point to "now";
  no scheduled trading start exists). So a scheduled DBC launch is a draft with a launch time: the
  countdown runs on the promotion page, deploy is locked until the time (the server refuses earlier),
  and at the time the creator gets a popup on any page (wallet connected) plus our usual
  notifications: "Your launch time has arrived. Deploy now to go live." The deploy is the normal
  step-2 transaction, priced at that moment. If the creator does not come, the coin is simply not
  live yet ("Ready to launch"). Rejected: a pre-signed durable-nonce transaction (3 signers, SOL
  target fixed at scheduling time).
- **D19. After graduation the creator's LP fees follow the fee choice too (founder, 2026-09-28).**
  `keep` coins are unchanged (creator position 80%, owned by the creator). For `holders`, `split` and
  `buyback` the config gives 100% of the permanently locked LP to the partner (our collector) and 0%
  to the creator, because we cannot claim fees from a position the creator owns. The keeper claims
  that position's fees: 20% is routed to `protocol_vault` like today's LP share, 80% goes into the
  coin's creator pool and is paid out by the step 5b path (holders / split / buyback). The graduation
  payout (the creator's 90% of the migration fee) and the 2% creator reserve still go to the creator.

**Today's launchpad (separate from DBC)**
- **D16. Graduation fee routing fixed** (2026-09-28, commit `3c4df96f`, on the work and live branches; gate PASS; keeper + API need a redeploy): the
  keeper sent "linked" for every creator; now the creator's real link decides. Proven on a local
  validator: unlinked -> airdrop 17.5% of the fee, recruiter and squad 0.
- **D17. Token ceiling fixed for existing coins** (program upgrade; branch
  `fix/solana-pool-token-ceiling` `fe6312ac`, candidate `9cce34df…` 1221160 B, gate PASS, K88 proof:
  creator 19.60%, pool 78.40% + 213.85M tokens; devnet upgrade + Squads pending; merge into live only
  after mainnet executes): when the pool needs more than
  the 140M liquidity tokens, it takes the rest from the unsold curve tokens instead of paying the
  SOL to the creator. New coins will be DBC, so the launch setting for new old-style coins is not
  changed.

## Proven before the build (2026-09-28)

- Devnet full lifecycle, every check passed: `tools/dbc-rehearsal/rehearse-dbc-devnet.mjs`.
- Mainnet tiny coin `4YuzaXEm…`: `tools/dbc-rehearsal/canary-dbc-mainnet.mjs`. Creator tx
  689 B / 2 signers; fee 2% exact; Meteora 20%, our referral 20% of that; creator 7% of the rest;
  claims exact; Jupiter routes on the curve; Phantom shows no warning.
- 21 of 25 recent mainnet DBC launches reuse a pre-made config (2 signers). We do the same.

## Parity table: today's Solana launchpad vs DBC

Today's values are read from the live mainnet GenerationConfig `EsCZKsKD…` (2026-09-28) and the
code named in each row.

| | Today | DBC | Why it differs |
|---|---|---|---|
| Supply / decimals | 1B / 6 | 1B max / 6 | none |
| Curve price | linear: 1 lamport + 850 nano-lamports per whole token sold (`solanaCurveCostLamports`) | same path, built from constant-product segments | DBC has no linear curve; segments approximate it (step 1 pins the tolerance) |
| Curve supply | 84%; unsold curve tokens burned at graduation | only what is needed is minted (sold + pool + 2% reserve), never above 1B | same end result (D9) |
| Graduation target | $15K / $30K / $50K, SOL amount re-priced on every buy | same targets, SOL amount fixed at launch from the SOL price step (2% steps) | DBC configs are immutable (D9) |
| Trade fee | 2% buy and sell | 2% buy and sell | none |
| Fee split | league 37.5 (30 weekly / 70 monthly), creator 5, recruiter 12.5 (OG 15), squad 2.5, protocol rest; unlinked recruiter+squad to airdrop | Meteora takes 20% of the fee first, then creator 7% of the rest (5.6% of the fee), the rest to our collector, which splits it exactly as today | Meteora's cut comes out of protocol (founder). Creator 5.6% vs 5% because DBC only takes a whole percent (founder: 7) |
| Referral | none | our collector's referral account on trades from our site gets 20% of Meteora's cut | extra income for us, not on Jupiter trades |
| Graduation fee | 2% of raised to protocol | migration fee 22%: creator 90% of it (19.8% of raised), us 10% (2.2%) | whole percents only (D6) |
| Creator at graduation | intended 20% of what is left after the 2% (19.6%); the code paid 23-65% because of the 140M cap (fixed, D17) | 19.8% of raised, in SOL | whole-% rounding (D6) |
| Pool | tokens calculated from the pool's SOL at the curve's last price, 0.25%, locked forever | same calculation with no cap, 78% of raised, less Meteora's 0.2% (paid back to the creator, D7), 0.25%, 100% locked | none in design |
| Creator reserve | 2% of supply to the creator at graduation | 2% of supply to the creator at graduation (locked vesting, released at migration) | none |
| LP fees after graduation | 80 creator / 20 protocol | 80 creator / 20 us (both positions locked) | none |
| Pool fee collection | both tokens | SOL only | simpler routing into vaults |
| Recruiter / squad / airdrop attribution | trade: trader's link; graduation: creator's link | same | none |

## Correction 2026-09-28 (before step 1), superseded by D6

A first draft copied today's *code* (pool capped at 140M, creator paid 23-65%). The founder's
design was always: pool tokens calculated at the last curve price, creator 20% of what is left
after our 2%. The cap was a flaw in today's launchpad (proof below, fix D17). DBC follows the
design, D6.

## Proof: today's launchpad at K88's settings (local validator, 2026-09-28)

`bash scripts/solana/run-proof-graduation-payout.sh` (test `tests/solana/proof-graduation-payout-mainnet-economics.cjs`),
certified binary `e6ed7df3…`, live mainnet economics, $15K target, SOL $118.59. Measured: raised
126.486 SOL, sold 544.37M, pool 64.92 SOL + 140M tokens (the formula wanted 213.85M; capped),
**creator 59.037 SOL = 46.67%** (intended 19.60% = 24.79 SOL), reserve 20M delivered, 295.63M
unsold burned, finalize fee 2.53 SOL split protocol 2.087 / recruiter 0.379 / squad 0.063.
Price carries over at graduation either way; the pool gets ~35% less SOL than intended.
DBC sizes the pool's tokens from its SOL at the final price with no cap (devnet: DBC final
sqrtPrice == DAMM v2 initSqrtPrice), which is the original design intent (founder).
Open: the graduation-fee split above paid recruiter/squad on an unlinked test route; check it
against the rule "unlinked slices go to the airdrop".

## Steps

| # | Step | Owner | Status |
|---|---|---|---|
| 1 | Config ladder (server): economics module, parity tests, SOL-price steps, config creation + chain readback, API to fetch a launch config | Grok, brief `docs/dbc/grok-step-1-config-ladder.md` | **DONE 2026-09-28**: merged (PR #471 + review fixes), devnet ALL CHECKS PASS |
| 2 | Create flow: creator signs createPool only (2 signers) + create screen + drafts and scheduled launches (D18) | Grok, brief `docs/dbc/grok-step-2-create-flow.md` | **DONE 2026-09-28**: merged (PR #472 + review fixes), devnet ALL CHECKS PASS |
| 3 | Trading on our site: DBC buy/sell, referral account, creator locked buys (D12), post-graduation trading | Grok, brief `docs/dbc/grok-step-3-trading.md` | **DONE 2026-09-28**: merged (PR #473 + review fixes), devnet ALL CHECKS PASS |
| 4 | Indexer: DBC trades into curve_trades, candles, market stats, holders, leagues | Grok, brief `docs/dbc/grok-step-4-indexer.md` | **DONE 2026-09-28**: merged (PR #474 + review fixes), devnet ALL CHECKS PASS; migration `20260929_000005` still to apply |
| 5 | Fee routing: accruals per trade, claim, route to vaults, reward_events, referral sweep | Grok, brief `docs/dbc/grok-step-5-fee-routing.md` | **DONE 2026-09-28**: merged (PR #475, 2 reviews), devnet ALL CHECKS PASS; migration `20260929_000006` still to apply |
| 5b | Creator-fee choice payouts: holders (weekly airdrop rails, code-2 leaves), buyback & burn (random, <= 0.5% impact), split | Grok, brief `docs/dbc/grok-step-5b-creator-fee-choice.md` | brief written 2026-09-28; can run in parallel with step 6 |
| 6 | Graduation keeper, our graduation fee routed, D7 compensation, creator rewards panel, LP fees | Grok, brief `docs/dbc/grok-step-6-graduation.md` | brief written 2026-09-28; starts after step 5 is merged |
| 7 | Binding tokens via Meteora TokenBadges + liquidity filter | Grok | not started |

## Groundwork for steps 3-6 (Claude, 2026-09-28): proven or read from the code

**D12 creator lock: PROVEN on devnet** (`tools/dbc-rehearsal/prove-creator-lock-devnet.mjs`, ALL CHECKS
PASS). One transaction: DBC `swap2` ExactOut (exactly X tokens) + create the escrow's token account +
Jupiter Lock `create_vesting_escrow(X)`: 979 bytes, **2 signers** (creator + a fresh escrow `base`
key). The creator's wallet ends that transaction with none of the tokens; the escrow holds X. Params:
`cliff_unlock_amount` = 20% at the date, `amount_per_period` = 20% x 4 at `frequency`,
`cancel_mode 0`, `update_recipient_mode 0`: cancel and recipient change are refused by the program
(`NotPermitToDoThisAction` 6005); nothing released before the date; then exactly 20% per step.
IDL (v0.4.0, read from chain): `tools/dbc-rehearsal/jup-lock-idl.json`.

**Step 3 (trading), from the code map:**
- The trade panel is inline in `TokenDetails.tsx` (quote effect ~3270, `handlePlaceTrade` ~3762).
  A DBC branch must come **before** the launchpad branches: with no Campaign PDA the launchpad quote
  falls back to hard-coded defaults (~3381) and would show a wrong quote instead of an error.
- Model a DBC trade lib on `solanaMeteoraTrade.ts` (program allowlist, v0 without ALT,
  `signTransaction` + `sendRawTransaction`); `sendWalletV0Transaction` is module-private today.
- After graduation: `loadVerifiedMarket` (`solanaMeteoraTrade.ts:131`) only accepts the
  deterministic customizable pool; a DBC-migrated pool comes from a config and must be accepted from
  `meta`. `tokenA/BProgram` are hard-coded to classic SPL.
- Slippage is a fixed 5% today.

**Step 4 (indexer):**
- Write DBC swaps to `curve_trades` (chain 101, `campaign_address` = the DBC pool, `bnb_amount_raw`
  in the launchpad convention: buy = gross incl. fee, sell = net) so leagues, candles, stats and
  holders work; add a venue marker (there is none today; DAMM rows use `log_index >= 20000`).
- The first buy (D13) needs a flag: nothing marks it today, and finalize's `top_earner` does not
  even exclude the creator (the live board does).
- Decode DBC `EvtSwap2`; the meteora swap indexer already keys only on `meta.solanaGraduation.pool`,
  so a migrated DBC coin is picked up if that meta is written at graduation.

**Step 5 (fee routing):**
- The vaults are plain `VaultState { kind }` PDAs: a System transfer from any wallet credits them;
  no counter to update. Roots and batches only check the balance later.
- Route the collector's share per D4 as raw transfers: league (weekly 30 / monthly 70 of 37.5%),
  recruiter / squad (linked, OG) or airdrop (unlinked), **protocol into `protocol_vault`** so the
  existing hourly `flush_operator_fill` applies the $10k cap and sends the rest to the multisig. Never
  pay the operator directly (it would bypass the cap).
- Per trade also write a `reward_events` row (`matched_activity_source = 'dbc_collector'`, the
  trader's profile via the same lookup as trade signing) so recruiter / squad / airdrop credit works.
- The collector holds user money for as long as it waits: flush promptly, never the deployer key.

**Graduation, a change from today (for the founder):** on DBC the creator's graduation payout
(their 90% of the migration fee), their 2% reserve and their 80% LP fees each need the **creator's
signature** to withdraw, so the creator claims them from a panel on the token page. Today's launchpad
pays the creator inside the graduation transaction. Nothing is lost, it waits until claimed.

## Pre-existing issues found while mapping (today's launchpad, not DBC)

- **The Solana league settlement pot counts post-graduation DAMM swaps.** `meteoraSwapIndexer.ts`
  writes them to `curve_trades`; `computeTotalLeagueFeeRawInRange` does not filter them, but they pay
  no league fee. After the first graduation the pot will exceed the vault and roots will block.
  **Fix before K88 graduates.**
- `meteoraSwapIndexer.ts` only indexes the 50 most recently updated graduated pools.
- `top_earner` at settlement has no creator / campaign / fee-recipient exclusion; the live board has.
- Trade signing's recruiter lookup (`limit 1`, no active filter) and recruiter crediting (prefers the
  active link) can disagree for a wallet with several links.

## Rules found by running it (must hold in every step)

- The SDK's partner-fee claim closes the claimer's WSOL account. The referral account must be an
  account no claim ever closes.
- Measure every amount from the confirmed transaction's own token balances, never from a second
  balance read (RPC lag). Retry until the transaction is readable.
- SDK 1.5.13: `client.state.getPool` returns `{ poolState }`.
- Meteora's keepers only migrate from 10 SOL / 750 USDC, so we run migration ourselves.

## Review log

(Claude writes one entry per Grok hand-in: branch, commit, what was checked, result.)

### Step 1, review 1 (2026-09-28): `grok/dbc-step-1` @ `1509992a`: CHANGES NEEDED

Checked: full diff (14 files), tests re-run in a clean clone (12/12 pass), constants vs D1-D14 (all
match), readback compares every field, advisory lock, migration SQL, route mount, dependency pin.
Good: curve ends exactly at the SOL target, steepening finds the smallest slope that fits 1B,
graduation 19.8 / 2.2 / 78, anti-sniper 50% -> 2% over 60 s, first buy at 2%.

Must fix before merge:
1. **Buffer tokens must be burned, not handed to us (D9).** `tokenSupply` sets pre = post. DBC burns
   `min(leftover, pre - post)` at migration (`get_burnable_amount_post_migration`,
   `migrate_damm_v2_initialize_pool.rs`); with pre = post nothing is burned and the unused 25% swap
   buffer becomes leftover for `leftoverReceiver` (our collector). Set
   `postMigrationTokenSupply = sold + pool tokens + 20M reserve` (rounded up), keep `pre` = what the
   SDK needs (<= 1B). Add `expected.circulatingAfterGraduation` and a test that `pre - post` equals the
   buffer and that `post` equals the circulating amount.
2. **A failed creation must never repeat on chain.** Everything runs in one DB transaction; on a
   readback mismatch the row is marked `failed` and the error rolls that back, while the config is
   already on chain. Every later call creates another config (~0.006 SOL each, forever). Persist the
   `failed` row (commit it, then report the error), refuse to create that key again until an operator
   clears the row (503 with a clear code), and do not insert a row for errors that happen before the
   transaction is sent. Test: two calls after a mismatch -> exactly one on-chain create.
3. **Graduation split rounding must match the program.** DBC computes the pool's quote with
   `Rounding::Up` (`get_migration_quote_amount`): pool = ceil(T x 78 / 100), fee = T - pool. Mirror it.
4. **Price path:** 5-7% at the start / 3.1-3.6% after is accepted (16 constant-product segments cannot
   follow a 1-lamport straight line to 1%). Try equal price-ratio spacing between the 16 points; keep
   whichever has the lower worst tail error and report both.
5. **Devnet proof:** the public faucet failed. Add an optional `DBC_PROVE_FUNDER_KEYPAIR` (path): when
   set, the script funds its throwaway keys from it. Claude runs it with the devnet deployer.
6. Open the pull request into `build/dbc-staging` (rule added 2026-09-28); fixes go on the same branch.

### Step 1, review 2 (2026-09-28): PR #471 @ `eafaf451`: CHANGES NEEDED (one blocker)

Review-1 items verified fixed: buffer burned at migration (`post` = circulating), failed creates
committed and refused afterwards (503 `DBC_CONFIG_FAILED`), pool = ceil(T x 78 / 100), equal
price-ratio packing, funder option. 17/17 tests pass.

Devnet proof (run by Claude, funder = devnet deployer, in-memory DB): **the first createConfig could
not be encoded**, `byte array longer than desired length`. Every target at SOL ~$118 builds curve
liquidities of **148-150 bits** in the first segments (u128 field): e.g. $15K: `149,76,150,98,...`.
Cause: at the 1-lamport start several points land on (almost) the same price; the "+1" bump makes
near-equal adjacent sqrt prices, and liquidity = amount / (1/sqrtLow - 1/sqrtHigh) explodes.

Must fix:
1. Choose the curve points so adjacent sqrt prices are strictly increasing by a real margin (points
   in price space, not bumped duplicates), and fail the build if any liquidity >= 2^128 or any sqrt
   price is outside [MIN_SQRT_PRICE, MAX_SQRT_PRICE].
2. A test that **builds and serializes the real createConfig transaction** (SDK
   `client.partner.createConfig` with a stub connection, or the program coder) for every case in the
   price table (3 targets x 7 SOL prices x 2 fee modes + the devnet $150). It fails today; that is
   the test that was missing.
3. Report the new liquidity bit lengths and the price-path table again.
Claude re-runs the devnet proof after the fix. Minor, not blocking: a send that times out after it
actually landed writes no row, so a retry could create a second config (<= 0.006 SOL); acceptable.

### Step 1, review 3 (2026-09-28): PR #471 @ `b3868a2d`: CHANGES NEEDED (one blocker)

Verified: points in price space, liquidity 94-110 bits (u128 ok), createConfig serializes for all 44
cases, 18/18 tests pass.

Devnet proof (Claude, funder = devnet deployer): the transaction now encodes, and the **DBC program
rejects it: `InvalidTokenSupply` (6020)**. The program requires (`process_create_config.rs`, the
`token_supply` branch):
`min_without_buffer <= post <= pre` and `min_with_buffer <= pre`, where both minimums count the
pool's tokens **including Meteora's 0.2% migration cut**:
`included_base = get_included_protocol_fee_migration_amounts_1(threshold, fee_pct)` in
`migration_handler/concentrated_liquidity.rs`: `quote = ceil(threshold x (100 - fee) / 100)`,
`L = get_initial_liquidity_from_delta_quote(quote, MIN_SQRT_PRICE, migration_sqrt_price)`,
`base = get_delta_amount_base_unsigned_256(migration_sqrt_price, MAX_SQRT_PRICE, L, Rounding::Up)`.
SDK 1.5.13 `getTotalSupplyFromCurve` uses `getMigrationBaseToken` instead and comes out lower, so
`pre` (and possibly `post`) is below the program's minimum.

Must fix:
1. Compute `pre` and `post` from the program's own minimums (mirror the formula above exactly,
   bigint, same rounding), keeping `post` = circulating (sold + pool incl. the 0.2% cut + 20M) and
   the 1B ceiling on `pre`.
2. Add a devnet **simulation** step to `prove-config-ladder-devnet.mjs` that runs
   `simulateTransaction` on createConfig for every one of the 44 ladder cases (free, sends nothing)
   and prints pass/fail per case; the program is the judge. Unit test: the mirrored minimums for a
   known case equal the numbers the program logs/accepts.
Claude re-runs the proof (simulation of 44, then the full lifecycle on one) after the fix.

### Step 1, review 4 (2026-09-28): PR #471 @ `31fccefa` + Claude's `8df36659`: MERGED

Program floors mirrored (SDK 1.5.13 undercounted by 2153 raw on $15K @ $118). Devnet proof run by
Claude (funder = devnet deployer, Helius devnet RPC, in-memory DB): **ALL CHECKS PASS**.
- 44/44 createConfig simulations accepted by the DBC program; both fee modes created + read back.
- First buy 10% in the launch tx paid 2% (957792 on 47889564); a buy ~5 s later paid 44.4%.
- Curve completed at exactly 1.268965644 SOL; migrated; pool quote 987813617 = 78% less the 0.2% cut.
- Migration fee creator 251255196 / us 27917245, exact; mint supply after graduation 95036704139970 ==
  configured circulating (buffer of 301355 raw burned).
Claude's fixes found by running it: readback ignored the program's 20-point curve padding (a correct
config was marked failed: fail-closed worked); proof simulated via VersionedTransaction, waits out the
60 s anti-sniper window, funds the collector, fee sign, and a real supply check (was `|| true`).
Signatures: config `5ZaMhNiU...`, first buy `4tmYXho5...`, complete `3M4aMz2E...`, migrate `24wSZycQ...`.

### Step 2, review 1 (2026-09-28): PR #472 @ `d2e897eb`: CHANGES NEEDED

Checked: diff (36 files), tests re-run in a clean clone (36/36 pass), guards on existing jobs (one line
each, correct), migrations, create.js authorize/finalize, the browser submit path. Good: flow and
structure follow the brief; scheduled lock is server-side; due-popup; drafts carry the DBC fields.

Must fix before merge:
1. **Every launch would fail: placeholder blockhash.** `serializeUnsigned` sets `recentBlockhash` to
   `111...1` and `dbcCreateSubmit.ts` signs and sends that transaction unchanged. Set a fresh blockhash
   in the browser before the mint key and the wallet sign, **simulate before asking the wallet**
   (like `solanaV4CreateSubmit.ts`), and confirm with that transaction's own blockhash and
   `lastValidBlockHeight` (today it confirms against a new one).
2. **The browser must check what it signs.** Before signing, verify: fee payer = the creator, only
   expected programs (DBC, System, SPL Token, Associated Token, Compute Budget, Metaplex metadata),
   the pool, config and mint equal the authorize response. Same idea as the allowlist in
   `solanaMeteoraTrade.ts`. A compromised API must not be able to get a wallet to sign something else.
3. **finalize checks fail open.** `if (owner && owner !== DBC)`, `if (configOnChain && ...)`, creator
   and mint the same way: a missing field passes. Make every check mandatory: owner must be the DBC
   program, config / creator / base mint must be present and equal the token, else 409.
4. **No SDK monkeypatch in production code.** `client.creator.getPoolConfigForNewPool = ...` replaces the
   SDK's chain read with a partial local copy. In production the config is on chain; read it. Inject a
   fake only through `deps` in tests.
5. **`authorize` re-checks the creator limits** (a race between begin and authorize could launch a 4th
   coin) and answers 400, not 500, for a malformed `firstBuyLamports`.
6. **A real devnet proof.** `scripts/dbc/prove-create-devnet.mjs` only prints text. Write it like the
   step-1 proof (optional `DBC_PROVE_FUNDER_KEYPAIR`, in-memory DB, real devnet chain, throwaway creator
   that really signs the begin message): run the real handler operations for (a) a create without a
   first buy, (b) with a first buy under 10% (must pay 2%), (c) a first buy over 10% (refused);
   print the real transaction bytes and signer count; finalize writes the campaign and metadata rows;
   finalize refuses a pool made with another config or creator; a scheduled draft is refused before
   its time. Build and sign the transaction exactly as `dbcCreateSubmit.ts` does. Claude runs it.

### Step 2, review 2 (2026-09-28): PR #472 @ `aae1ff05` + Claude's fix: MERGED

Review-1 items verified: fresh blockhash + simulate before signing; sign-time intent check (fee payer,
program allowlist, pool/config/mint); fail-closed finalize; no SDK monkeypatch; limits re-checked in
authorize. 40/40 tests.
Devnet proof (Claude, funder = devnet deployer): **ALL CHECKS PASS**. No-buy launch 758 B, 2 signers,
campaign + metadata rows written; first buy 0.02 SOL: 978 B, 2 signers, pool reserve 19600000 = buy
less exactly 2%; over-cap first buy refused (`DBC_FIRST_BUY_CAP`); finalize refuses another config
(`DBC_POOL_CONFIG`); scheduled draft refused before its time (`DBC_SCHEDULED_LOCKED`).
Creator cost of a launch with a 0.02 SOL first buy: 0.042 SOL total, so ~0.022 SOL is rent + fees.
Claude's fix found by running it: `dbcCreateIntent.mjs` (the browser path) simulated a legacy
Transaction with a config object, which web3.js 1.x rejects: every launch would have failed.

### Step 3, review 1 (2026-09-28): PR #473 @ `b4f124fd` + Claude's `b6bcdcd1`: MERGED

Grok did not run the proof. Claude ran it (funder = devnet deployer) and fixed what it found:
- `dbcTrade.mjs`: `swapQuote2` reads `virtualPool.poolState.*` (SDK 1.5.13), so every quote threw.
- `api/dbc/locks.js`: the response carried BigInt fields and `JSON.stringify` threw after the row was
  written; handlers inside `try` were returned without `await`, so their errors skipped the catch (the
  same shape as the live TICKER_UNAVAILABLE 500).
- `TokenDetails.tsx`: the 5 s launchpad curve poll and the graduation-handoff effect still ran on DBC
  pages; the launchpad decoder only checks length, so a 424-byte DBC pool read as a campaign. Both now
  skip `isDbcPage`; the quote and trade paths already returned before the launchpad code.
- `create.test.mjs` test 15 pinned the removed `DbcTokenPage`; it now pins the DBC guards.
- The proof compared the referral to a fixed 2% fee. It now decodes `EvtSwap2` and checks the referral
  delta equals the event's referral fee, referral = 20% of Meteora's cut, cut = 20% of the fee, and the
  fee charged is above 2% and never above the quote.

Devnet proof: **ALL CHECKS PASS**. Buy 739 B / 1 signer, quoted 49.20%, charged 48.40% (the fee falls
while the transaction lands), referral 387200 = event; sell 707 B; creator locked buy 1044 B, 2 signers,
creator wallet delta 0, escrow holds the amount, lock-record route accepts it. Tests 15 + 27 pass.
Launchpad create/buy/sell files untouched; `loadVerifiedMarket`'s DBC relaxation is behind a flag.

### Step 4, review 1 (2026-09-28): PR #474 @ `acc81a0a` + Claude's `9adafb2b`: MERGED

Built in parallel with step 3; merged staging in (one package.json script conflict). Fixes:
- A transaction the RPC could not return yet was skipped and the cursor moved past its slot: the trade
  was lost for good. The pass now stops there and the cursor rests on the last slot fully read.
- `getSignatures` stopped after 5 pages; a backlog over 2500 signatures lost its oldest ones while the
  cursor jumped past them. It now pages back to the cursor.
- `dbcPriceFromSqrt` kept 9 decimals (1-2 digits for a memecoin price); now 18.
- The proof's SOL check was `indexed > 0 && spent > 0`, true for anything, and the sell was not checked.
  Every row is now checked against the pool's quote and base vaults and the trader's token account.

Devnet proof: **ALL CHECKS PASS**, 25 checks, every row equal to the chain to the lamport (buy SOL incl.
fee = quote vault in; sell SOL after fee = quote vault out; tokens = base vault and trader deltas;
wallet = trader). Tests: indexer 7, holders 2, market stats 5. The proof's trader is also the fee payer,
so "trader differs from fee payer" is covered by the account layout (payer = index 9 of swap/swap2),
not by a run. Needs `db/migrations/20260929_000005_curve_trades_venue.sql` on staging and production
before the indexer ships (founder applies).

### Step 5, review 1 (2026-09-28): PR #475 @ `2c768e8f`: CHANGES NEEDED

The split maths is right: I re-added the proof's numbers by hand (collector 20,534,400, league
3,105,000 + 7,245,000, recruiter 2,570,000, squad 468,000, airdrop 1,332,000, protocol 5,814,400) and
every lamport is accounted for. The problems are in the claim/route bookkeeping. On a coin that trades,
several of them fire on the first real pass.

1. **The claim blocks every active pool.** `claimPoolPartnerFees` sums the accruals it has, then claims
   **everything the pool owes** (`maxQuoteAmount = owed`). Any trade that the indexer or the accrual
   pass has not reached yet (the indexer runs every 8 s, accrual once an hour) makes claimed > expected.
   With tolerance 0 the pool is then marked `blocked`, for good. The proof passed only because nothing
   traded between the accrual and the claim.
   Fix: claim exactly what was accrued, `maxQuoteAmount = expected` (`claim_trading_fee` pays
   min(max, owed)). If `owed < expected`, block without sending. The rest stays in the pool counter for
   the next pass.
2. **A blocked pool stops routing for every pool.** The router refuses while any row is `blocked`, and
   the worker skips routing if any claim came back blocked. The brief says a mismatch stops routing
   **for that pool**. Blocked rows are already excluded by status, so drop both global gates and log the
   blocked pools on every pass.
3. **The same money can be routed twice.** If the route transaction is sent but not readable within
   30 s, the router throws and the rows stay `claimed`, so the next pass pays the vaults again. The
   claim has the same shape. Fix, for both: sign first, then write status `claiming` / `routing` with the
   signature and `lastValidBlockHeight` **before** sending. At the start of the next pass, resolve
   pending rows with `getSignatureStatuses` (`searchTransactionHistory: true`):
   - landed → `claimed` / `routed` (for a claim, measure the quote-vault outflow of that transaction);
   - failed, or not found with block height past `lastValidBlockHeight` → back to `accrued` / `claimed`;
   - otherwise wait.
   Update rows **by id** (the ids you summed), never `where status = ...`. Add the two statuses and the
   column in the migration.
4. **Wrong trader profile.** `LINK_SQL` sorts active-at-trade-time links first but does not filter, so a
   wallet with no link at trade time gets its latest link anyway: one made after the trade, or one
   already detached. That trade is paid as linked instead of airdrop. Use the ledger's rule
   (`rewards/ledger.ts:226`): `l.linked_at <= $2 and (l.detached_at is null or l.detached_at > $2)`,
   `order by l.linked_at desc, l.id desc`.
5. **A trade without an activity row blocks all accrual.** It is skipped and read again on every pass
   (oldest first, `limit 500`). Once 500 of them exist, no new trade is accrued anywhere. Select only
   trades that have their activity row, and log how many DBC trades have none.
6. **The collector check ignores money held for creators.** Platform-mode `creator_pool` amounts stay on
   the collector for step 5b. The router should require
   `routed + held creator_pool (claimed / routing / routed) + rent + fee` before it sends. Otherwise
   routing can spend creators' money.

**Tests: the stand-in database has to go.** The proof and tests answer SQL from a hand-written stand-in
that re-implements each query, including the same wrong link sort. It proves the chain amounts, not the
SQL. Run the proof and a new integration test against a throwaway Postgres:
`initdb` into a temp dir, `pg_ctl -o "-p 55432" start`, apply `db/migrations/*dbc*` plus the minimum
`curve_trades` / `activity_events` / `campaigns` / `reward_events` / `epochs` / `wallet_recruiter_links` /
`recruiters` / `indexer_state` columns, then stop and remove it. The integration test (chain stubbed) must cover:
- a trade accrued after the claim was built;
- claim sent but unreadable, then resolved as landed, then resolved as failed;
- route sent but unreadable (no second route);
- one blocked pool while another routes;
- the link-at-time cases (none, before, after, detached).

The devnet proof must add:
- a trade between the accrual and the claim (claimed == accrued, the counter keeps the rest, the next
  pass claims it);
- one swap naming the referral account, then the sweep: the referral balance goes to `protocol_vault`
  to the lamport, the referral account still exists, and a later swap naming it succeeds.

### Step 5, review 2 (2026-09-28): PR #475 @ `9c8a08c7` + Claude's fix: MERGED

All six review-1 items verified in code. Tests run on a throwaway Postgres (unit 12, integration 8).
Claude's fix: the pending resolver compared `getSlot()` with `lastValidBlockHeight`. On mainnet the slot
runs about 20M ahead of block height, so every not-yet-visible claim or route counted as expired and
could be sent twice. It now uses `getBlockHeight()`. A send error after `sendRawTransaction` no longer
resets rows; they stay pending until the signature fails or its blockhash really expires.
Devnet proof (Claude, funder = devnet deployer): **ALL CHECKS PASS**. Linked / OG / unlinked profiles,
fees from EvtSwap2. A trade between accrual and claim stayed on the pool counter (6,249,600) and was
claimed on the next pass. Every vault delta equals its slice to the lamport. The referral sweep paid
336,000 to `protocol_vault`, the referral account stayed open, and a later swap naming it succeeded.
Note for step 5b: `creator_pool` stays counted as held on the collector for every claimed/routed row,
until 5b adds a paid status.
