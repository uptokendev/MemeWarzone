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
  (option A, released by date; no lock program of our own): released in 5 steps of 20%. The coin
  shows a badge with how much the creator holds and how much is locked. Buys made elsewhere or from
  other wallets cannot be locked, by anyone.
- **D13. No creator buy counts for the leagues** (first buy or locked buys).
- **D14. Anti-sniper fee is a must:** the fee starts high and falls to 2% shortly after launch; the
  creator's first buy in the launch transaction pays the normal 2% (`enableFirstSwapWithMinFee`).
  Exact start fee and duration are set in step 1 (proposal: 50% falling to 2% over 60 s).
- **D15. Every quote token we can offer** (stocks and others) via Meteora TokenBadges + a liquidity
  filter (step 7).

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
| 1 | Config ladder (server): economics module, parity tests, SOL-price steps, config creation + chain readback, API to fetch a launch config | Grok, brief `docs/dbc/grok-step-1-config-ladder.md` | brief v2 written 2026-09-28, follows D1-D15; ready for Grok |
| 2 | Create flow: creator signs createPool only (2 signers) + create screen | Grok | not started |
| 3 | Trading on our site: DBC buy/sell with our referral account | Grok | not started |
| 4 | Indexer: DBC trades into charts, market stats, leagues, battles | Grok | not started |
| 5 | Fee collector routing into league / recruiter / squad / airdrop vaults | Grok | not started |
| 6 | Graduation keeper: migrate, withdraw fees, creator compensation, LP fee claims | Grok | not started |
| 7 | Binding tokens via Meteora TokenBadges + liquidity filter | Grok | not started |

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
