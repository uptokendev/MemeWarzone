# Meteora DBC launch type: build plan and progress

This file tracks the build of the DBC launch type. It is separate from `CLAUDE.md`. Every step,
every decision and every review result goes here, so the build does not drift from the plan.

## How we work (founder, 2026-09-28)

1. **As close as possible to what we already have.** Same fees, same rewards, same payouts, same
   graduation outcome. Where DBC forces a difference, it is written in the parity table below with
   the reason. A new difference is not allowed without the founder's decision.
2. **Grok builds, Claude orchestrates.** Grok works only on its own branch `grok/dbc-step-<n>`
   cut from `build/dbc-staging`, pushes only that branch, and never merges, never pushes to any
   `build/*` branch and never opens a merge into one. Claude reviews the full diff, runs the tests,
   and merges into `build/dbc-staging`.
3. **Fast.** One brief per step. The founder hands Grok the brief, then hands Grok's output to
   Claude. Claude reviews. After a clear review, the next step's brief.
4. Each step needs the founder's go before the next one starts.
5. Nothing reaches the live branch `build/cross-chain-stabilization-rh-base` until the founder says
   so. The existing launchpad's CREATE / BUY / SELL flow is not touched by any step.

Branches: staging `build/dbc-staging` (cut from `dbea13d6`). Grok: `grok/dbc-step-<n>`.

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
| Curve supply | 84%; unsold curve tokens and unused liquidity tokens burned at graduation | only what is needed is minted: tokens sold up to the target + pool tokens + 2% reserve | same end supply; DBC mints less instead of burning |
| Graduation target |  $15K / $30K / $50K, SOL amount re-priced on every buy, capped at the full curve (300.72 SOL, so $50K closes on supply below ~$166 SOL) | same targets and same cap, SOL amount fixed at launch from the SOL price step (2% steps) | DBC configs are immutable |
| Trade fee | 2% buy and sell | 2% buy and sell | none |
| Fee split | league 37.5 (30 weekly / 70 monthly), creator 5, recruiter 12.5 (OG 15), squad 2.5, protocol rest; unlinked recruiter+squad to airdrop | Meteora takes 20% of the fee first, then creator 7% of the rest (5.6% of the fee), the rest to our collector, which splits it exactly as today | Meteora's cut comes out of protocol (founder). Creator 5.6% vs 5% because DBC only takes a whole percent (founder: 7) |
| Referral | none | our collector's referral account on trades from our site gets 20% of Meteora's cut | extra income for us, not on Jupiter trades |
| Graduation fee | 2% of raised to protocol | per config: whole-% migration fee and creator share computed from today's formula (fee rounded up, creator rounded down), so our share stays >= 2% | whole percents only |
| Creator at graduation | everything after the 2% and the pool, in SOL: 23% to 65% of raised depending on target and SOL price (the pool is capped at 140M tokens) | the same per config, within 1 percentage point | whole-% rounding |
| Pool | 140M tokens (cap binds at every realistic SOL price) at the curve's final price, 0.25%, locked forever | same tokens and price (<= 140M), less Meteora's 0.2% liquidity fee, 0.25%, 100% locked | Meteora's 0.2%: the keeper compensates the creator from our share (founder) |
| Creator reserve | 2% of supply to the creator at graduation | 2% of supply to the creator at graduation (locked vesting, released at migration) | none |
| LP fees after graduation | 80 creator / 20 protocol | 80 creator / 20 us (both positions locked) | none |
| Pool fee collection | both tokens | SOL only | simpler routing into vaults |
| Recruiter / squad / airdrop attribution | trade: trader's link; graduation: creator's link | same | none |

## Correction 2026-09-28 (before step 1)

The earlier model "22% graduation fee, 90% to the creator" assumed the creator gets 20% of what is
left after the 2%. Today's code (`graduationLiquidityQuote`) caps the pool at the 140M liquidity
tokens, and at every realistic SOL price that cap binds, so the creator gets 23% to 65%. Per hard
rule 1 each config now carries its own whole-percent split computed from today's formula. Founder
to confirm.

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
| 1 | Config ladder (server): economics module, parity tests, SOL-price buckets, config creation + chain readback, API to fetch a launch config | Grok, brief `docs/dbc/grok-step-1-config-ladder.md` | brief written 2026-09-28 |
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
