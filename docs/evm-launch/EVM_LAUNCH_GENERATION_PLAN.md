# EVM launch generation (BNB 56, Robinhood 4663): design

Status: design, for founder approval and for the audit. Nothing here is built or deployed.
Written 2026-09-30. Every "today" fact cites the code on `build/dbc-staging` (`c676ed7f`).

## Founder decisions (2026-09-30): the authority for this generation

- **E1. Own contracts, trading on our site** ("if Pons does it, we do it too"). Our own bonding
  curve per coin, graduation into a permanently locked DEX pool. Doppler is dropped (fork proof and
  findings: `tools/doppler-rehearsal/README.md`, branch `claude/rh-doppler`).
- **E2. Solana's exact numbers everywhere.** Every number below that has a Solana DBC value
  (`docs/dbc/DBC_BUILD_PLAN.md`, D1-D23) uses that value, even where Solana's value came from
  Meteora's whole-percent rounding.
- **E3. The graduation target stays re-priced live** from Chainlink on every buy (today's behaviour,
  `GraduationOracle.nativeTargetForUsd`). The dollar target is exact; Solana fixes it at launch only
  because DBC configs are immutable.
- **E4. Server-signed trading stays on** (`requireAuthorizedTrading`, today's default,
  `LaunchFactory.sol:318`). Recruiter attribution depends on the signed profile, and trading happens on
  our site, as on Pons.
- **E5. The creator first buy comes back** (it existed from `93ff720e` and was removed in `8995d7f0`,
  2026-06-27, for "protected launch v1").
- **E6. Graduated pool fee 0.30% on both chains** (founder, 2026-09-30): Topaz V2 30 bps on BNB,
  Uniswap V3 3000 on Robinhood, the DEXes and lockers already deployed. This is the one deliberate
  difference from Solana's 0.25% (D8): 0.25% does not exist on either DEX we graduate into.
- **E7. Contract size (founder, 2026-09-30).** `LaunchCampaign` is at 24,575 of 24,576 bytes. The new
  implementation drops (a) block-based launch protection (off on mainnet, replaced by the C2 fee) and
  (c) the legacy non-router fee path `_feeSplit` (unreachable: `strictFeeRouting` is always true). It
  keeps (b) the unsigned buy/sell entry points as the Safe-controlled emergency exit if the signing
  server is gone. If space is still short, the C4 escrow moves into its own contract.
- **E8. The creator first buy pays the flat 2%, never the anti-sniper fee** (as D14), and its cost is
  capped below the coin's graduation target so it can never graduate the coin at create.
- **E9. Graduated pool fees reach everyone in native only, on every coin** (founder: "same as Solana",
  whose DAMM v2 pool collects SOL only). Topaz V2 and Uniswap V3 always accrue fees in both tokens, so
  every harvest sells the MEME-side fees for native in the same pool (price-impact bound, chunked) before
  the 80/20 split and the fee choice. This changes both lockers' harvest (new source, new generation).
- **E10. The fee choice works on quote-bound coins too** (BNB quote tokens, Robinhood stocks), as on
  Solana: holder payouts are swapped to native first; buyback spends the quote token in the coin's own
  pool; the creator's keep share is paid in what the pool earned.

## Target economics, one table

| | Today on EVM | New generation (= Solana) |
|---|---|---|
| Trade fee | 2% buy and sell, native side (`LaunchCampaign.sol:537-541, 583-586`) | 2%, unchanged |
| Fee split | league 37.5 (30/70), creator 5, recruiter 12.5 (OG 15), squad 2.5, unlinked to airdrop 15, protocol rest (`TreasuryRouterV3.sol:184-206`, constants) | **creator 5.6**; league, recruiter, squad, airdrop unchanged; protocol the rest (42.5 -> 41.9 linked, 40 -> 39.4 OG) |
| Anti-sniper | none (launch protection exists but is off on mainnet) | fee 50% at launch falling linearly to 2% over 60 s; the creator's first buy pays 2% |
| Creator first buy | not possible | up to 10% of supply, in the create transaction, at 2%, unlocked |
| Creator's later buys through our site | locked 24 h / 6 h / 1 h by tier, capped 0.25 / 1 / 3 native (`CreatorRegistry.sol:146-173`) | escrowed: 20% released at 30 days, then 20% every 7 days, fully free at 58 days |
| Creator buys and leagues | counted | never counted (indexer rule, D13) |
| Graduation target | $15K / $30K / $50K, live re-priced | unchanged (E3) |
| Graduation split of the raise | 2% protocol, then pool 33% of the rest, **creator ~67%** (`LaunchCampaign.sol:702-781`) | **protocol 2.2%, creator 19.8%, pool 78%** |
| Pool tokens | capped at the 14% liquidity allocation (`:719-730`), rest burned | exactly the tokens the pool's native buys at the curve's last price, no cap (D6) |
| Graduated pool | BNB Topaz V2 30 bps; Robinhood Uniswap V3 0.30% | unchanged, 0.30% (E6; Solana 0.25%) |
| LP lock and LP fees | permanent, 80 creator / 20 protocol, permissionless harvest | unchanged |
| Creator fee choice | none: always to the creator | keep / holders / split / buyback & burn, set at launch; LP fees follow the choice (D5, D19) |
| Scheduled launch | on chain: trading opens at `launchAt` | unchanged (EVM can do it on chain; Solana could not) |

Our 2.2% graduation share is routed like today's graduation fee (`routeFinalize`, creator's link).

## Contract changes

All of them land as **one new generation**: new campaign implementation(s), new factory, new
treasury router, new creator vault. Both mainnet factories hold 0 campaigns, so nothing is migrated.
Every money path below states, for the audit: reentrancy guard, checks-effects-interactions order,
which states can reach it, overflow behaviour, and how it can be griefed.

### C1. TreasuryRouterV4: creator 5.6%

`previewTrade` hard-codes `creator = 500` bps. The new router is V3 with `creator = 560` and protocol
as the remainder; finalize routing unchanged. Nothing else changes. A new router means: new vault
wiring (Safe batches), the lockers authorized on it (propose, 3600 s, accept), and the league, recruiter
and community vaults pointed at it where they check the router. The deploy script already handles all
three cases (`scripts/lib/evmLpLockerWiring.ts`).

### C2. Anti-sniper fee in the campaign

`feeBps(t) = 200 + (5000 - 200) * max(0, 60 - (t - tradingStart)) / 60`, where `tradingStart` is
`launchAt` for a scheduled coin and the create block's timestamp otherwise. The whole fee, including
the anti-sniper part, goes through the router split, the same as on Solana. The creator's first buy
(C3) is charged the flat 200 bps. Maximum fee 5000 bps is a constant; the fee is computed on the
native amount before the curve, so a buy's `maxCost` still bounds what the trader pays.

### C3. Creator first buy at create

`createCampaign*` becomes `payable`. The creator names a token amount of at most 10% of supply; the
factory buys it through the campaign in the same transaction at 200 bps and sends the tokens to the
creator, unlocked. `msg.value` above the exact cost is refunded at the end (CEI: state first, refund
last, `nonReentrant` on the factory). Zero is allowed. It does not start the anti-sniper clock early
for other buyers.

### C4. Creator buy escrow (replaces the tier buy lock)

When the signed actor of a buy is the creator, the tokens go to the campaign's escrow for that
creator instead of the wallet. Release: 20% at 30 days after the buy, then 20% every 7 days.
`claimEscrow()` is pull-only, `nonReentrant`, pays at most the released amount. The tier caps
(`CreatorRegistry`) stay as a size limit. Another wallet of the creator cannot be caught, the same as
on Solana; the coin page shows held and locked amounts.

### C5. Graduation split and pool size

Replaces `LaunchCampaign.sol:702-781`:

1. `raise` = the curve's native balance (overshoot included, as today).
2. Protocol 2.2% via `routeFinalize` (creator's link profile).
3. Creator 19.8%: pull payment (`pendingCreatorGraduation`), never pushed, so a creator wallet that
   rejects native cannot block graduation.
4. Pool native = the remaining 78%. Pool tokens = pool native / the curve's last price. Minted from
   the unsold curve tokens plus the liquidity allocation; what is left is burned.
5. **The supply must always cover it.** Per chain, the curve (`basePrice`, `slope`) is chosen so that
   at every allowed target and over the whole native price range we accept, sold + pool + 2% reserve
   stays under 1B. The factory refuses a target the current price would push past that bound (checked
   against the oracle at create and again at graduation, with a documented fallback). This is D9
   without a config ladder, because the target is live (E3).

### C6. Creator fee choice

A new `CreatorRewardsVaultV2`, funded by the router like today, keeps a per-campaign choice set once
at create: `keep`, `holders`, `split(creatorPct 1..99)`, `buyback`.

- `keep`: the creator claims as today (`claimCreatorFees`).
- `holders` and the holders part of `split`: a bounded operator (the existing payout operator role,
  per-week cap) moves the amount into the community vault, and the weekly airdrop pays it with a holder
  code, like Solana's code-2 leaves. Only the operator can move it, only to the community vault.
- `buyback`: the operator buys the coin at random moments during the week (seed published afterwards,
  D5), at most ~0.5% price impact per buy, and the bought tokens go to `0x…dEaD`. Before graduation the
  buy is a signed curve buy; after, a swap in the locked pool. The vault releases native only to the
  campaign or the pool swap path, never to a wallet.
- LP fees after graduation follow the choice (D19): for anything but `keep`, the locker's creator
  share of harvests is paid into the vault under the coin's choice instead of to the creator.

### C7. The three graduation bugs

1. **Robinhood stock graduation always reverts.** `RobinhoodStockTokenGraduationAdapter.sol:308, 317`
   call `quoteExactInputSingle` on SwapRouter02 (`0xCaf681a6…`), which has no such function. Use
   QuoterV2 (`0x33e885eD…`, already verified on chain) or quote on chain from pool state.
2. **Robinhood native: a pre-made pool freezes the coin.** `createAndInitializePoolIfNecessary`
   (`RobinhoodUniswapV3GraduationAdapter.sol:137`) accepts a pool someone initialized at a wrong
   price; graduation then reverts `DexPriceDrift` (`LaunchCampaign.sol:749`), and because the
   crossing buy reverts with it, nobody can buy past the target.
   Fix: accept an existing pool and move its price to the curve price before adding liquidity. Before
   graduation the coin cannot be transferred (`LaunchToken.sol:42-55`), so a pre-made pool can only
   hold native, all on one side of its price. Moving the price toward our price either crosses no
   liquidity (free) or sells our tokens into the griefer's native at better than our price. Either way
   the repair cannot cost the coin, and graduation always completes. Graduation failure must also
   never revert the crossing buy: the buy lands, graduation retries permissionlessly.
3. **BNB quote coins: a pre-made pool freezes them forever.** `BnbQuoteGraduationAdapter.sol:257-259`
   reverts `FinalPoolAlreadyExists`. Same fix idea for a V2 pair: accept the pair, add our side
   directly and mint, and size our token side so the resulting price is our price; any native a
   griefer donated is absorbed into the locked position.

The Robinhood stock path also reverts on any residual (`RobinhoodStockLaunchCampaign.sol:163`);
normal V3 rounding may leave dust. Handle dust explicitly (burn or add to the vault), never revert.

### DEX fee tier: decided, 0.30% (E6)

- **Robinhood:** the Uniswap V3 factory `0x1f7d7550…` has no 0.25% tier (read on chain 2026-09-30:
  `feeAmountTickSpacing` 100 -> 1, 500 -> 10, 2500 -> 0, 3000 -> 60, 10000 -> 200). Graduation stays on
  V3 3000 with `PermanentV3PositionLocker`.
- **BNB:** Topaz is a V2 fork with a fixed 30 bps volatile fee; `PermanentLpLocker` requires it
  (`PermanentLpLocker.sol:34`). Graduation stays on Topaz.

## What does not change

CREATE / BUY / SELL stay signed transactions from our site; the create gains the optional first-buy
value, the buy gains the anti-sniper fee. Leagues, recruiter, squad, airdrop, arena and the vaults
keep their contracts. The existing quote paths (BNB quote tokens, Robinhood stocks) keep their shape
with the C5 split and the C7 fixes.

## Order of work

1. ~~Founder: approve this design and answer the two DEX questions.~~ Done 2026-09-30 (E6).
2. Audit-level spec per change (C1-C7): state machine, invariants, griefing analysis.
3. Build with tests: unit, then the full lifecycle on a local fork of each mainnet (real Topaz or
   PancakeSwap, real Uniswap, real Chainlink), including a griefer who pre-makes the pool.
4. Deploy on BSC testnet and Robinhood testnet, run the lifecycle and a real graduation + harvest.
5. External audit of the diff. Then mainnet deploy through the Safe, closed, canary, open.
6. App and indexer: anti-sniper fee in quotes, first-buy field, escrow display, fee-choice screens
   (the Solana ones, chain-aware), new router and vault addresses.
