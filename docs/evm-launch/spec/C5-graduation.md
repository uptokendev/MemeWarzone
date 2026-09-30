# C5. Graduation split, pool size and retry (spec)

Status: audit-level spec for `EVM_LAUNCH_GENERATION_PLAN.md` C5 (and the C7 retry rule). Nothing is built.
"Today" cites `claude/evm-launch-gen` as of 2026-09-30. Applies to `LaunchCampaign` (native),
`BnbQuoteLaunchCampaign` and `RobinhoodStockLaunchCampaign` (quote paths).

## 0. Today, in facts

- The raise is `netRaisedWei`, not the balance (`LaunchCampaign.sol:712`). A buy adds and a sell removes
  `_area(a)-_area(b)` (`:873-879`), so `netRaisedWei == _area(sold)` exactly. `receive()` donations
  (`:341`) never change the raise.
- Price is wei per whole token: `P(s) = basePrice + priceSlope*s/1e18` (`:864-866`). Area:
  `A(x) = x*b/1e18 + k*x²/(2e36)` (`:885-899`). `x*x` is unchecked and safe only for `x ≤ 1e27` (`:888-895`).
- Split today: 2% protocol (`protocolFeeBps`, also the trade fee, `:716`), pool `liquidityBps` 33% of the
  rest, capped at `liquiditySupply` 14% (`:719-730`), creator the rest, **pushed** (`:760-761`).
- The crossing buy calls `_autoFinalizeIfEligible` (`:549, :572`). Only the oracle read is inside the try
  (`:682`). `_finalizeWithTarget` runs unwrapped (`:685`), so any graduation revert (DEX drift `:749`, router
  paused `TreasuryRouterV3.sol:448` under strict routing `LaunchCampaign.sol:811-816`, creator rejecting
  native `:761/:923`) reverts the crossing buy.
- Nothing graduates at sold-out: `SoldOut` (`:536, :560`) stops buys at `curveSupply`, and only
  `netRaisedWei ≥ target` graduates (`:683, :707`).
- Quote paths: crossing sets PENDING (`BnbQuoteLaunchCampaign.sol:211-216`), and PENDING blocks buys and sells
  (`LaunchCampaign.sol:534, :579`). BNB retry is permissionless (`BnbQuoteLaunchCampaign.sol:102`). The
  Robinhood completion is limited to the factory or its owner, with caller-supplied minima
  (`RobinhoodStockLaunchCampaign.sol:97-113`), and it reverts on any residual (`:163`). Both demand
  `memeTokenUsed == memeAmountDesired` (`BnbQuote…:150`, `RobinhoodStock…:160`), which ignores swap slippage
  when sizing the pool.
- Mainnet config: supply 1e27, `curveBps 8400`, `liquidityTokenBps 1400`, `basePrice 1e9`, `slope 850`,
  `liquidityBps 3300` (`LaunchFactory.sol:306-314`; `deploy-bnb-quote-generation.ts:125-130`,
  `deploy-robinhood-quote-generation.ts:113-118`). Allowed targets: $15K/$30K/$50K
  (`LaunchFactory.sol:170-173, 337-344`).
- `LaunchCampaign` is at the EIP-170 limit (`:891-894`). The new graduation code has to move into a linked
  library or a slimmer base. This is a build constraint, not optional.

## 1. Algorithm

### State

`phase ∈ {Trading, Pending, Graduated}`. Keep the public bools `graduationPending` and `launched` as views
of it, because the indexer reads them. New storage: `uint64 pendingSince`, `uint8 pendingTrigger`
(0 = target, 1 = sold out), `address creatorGraduationBeneficiary`, `uint256 pendingCreatorGraduation`,
`uint256 pendingProtocolGraduationFee`, and (quote paths only) `uint256 pendingCreatorQuote`.
Constants: `GRAD_PROTOCOL_BPS = 220`, `GRAD_CREATOR_BPS = 1980`,
`PRICE_BAND_BPS = 50` (native) / `100` (quote), `PAUSE_HONOUR_WINDOW = 72 hours`,
`MAX_NATIVE_REFUND_BPS = 1`. `liquidityBps` and `protocolFeeBps` no longer enter graduation.

### Entering Pending

This happens at the end of a buy, after the fee is routed and the refund is sent. It also happens inside
`graduate()` when that is called while still in Trading.

- `sold == curveSupply` → Pending, trigger 1. No oracle is read.
- else `try oracle.nativeTargetForUsd(target)`: if `netRaisedWei ≥ nt` → Pending, trigger 0. If the oracle
  reverts, stay in Trading (as today, `:687`).
- Effects only: `pendingSince = now`, snapshot `graduationBalance = netRaisedWei`, `finalCurvePrice = P(sold)`
  and overshoot, then emit `GraduationPending(caller, trigger, raise, nativeTarget, lastPrice)`.
  **The crossing buy makes no DEX, router or adapter call**, so it cannot be reverted by graduation.

### `graduate()`: external, `nonReentrant`, permissionless

1. **Checks.** If `phase == Trading`, apply the entry rule above and revert `GraduationNotDue` if nothing is due.
   Require `phase == Pending`. If `paused || graduationPaused`, revert `GraduationPaused` only while
   `now < pendingSince + PAUSE_HONOUR_WINDOW`.
2. `R = graduation.graduationBalance`, `s = sold`, `P = b + k*s/1e18`, rounded down.
3. `protocol = R*220/10000` (down) and `creator = R*1980/10000` (down). `poolNative = R - protocol - creator`.
   **The pool takes the rounding dust, at most 2 wei.**
4. `T = mulDiv(poolNative, 1e18, P)`, rounded down. The pool price `poolNative/T` is therefore ≥ P, with a
   relative error below 1e-20.
5. `budget = totalSupply - creatorReserve - sold` (unsold curve tokens plus the liquidity allocation, from
   accounting and never `balanceOf`). C4 escrowed tokens are part of `sold` and are not touched.
   `require(T ≤ budget)`. The factory bound (§2) makes this unreachable, and it reverts `SupplyBound`.
6. **Effects.** `phase = Graduated`, `launched = true`, `finalizedAt`,
   `creatorGraduationBeneficiary = owner()`, `pendingCreatorGraduation += creator`.
7. **Protocol.** `try IRouter(feeRecipient).routeFinalize{value: protocol}(finalizeRouteProfile)` (the creator's
   profile, fixed at init, `:317`). On `catch`: `pendingProtocolGraduationFee += protocol` and emit
   `ProtocolGraduationFeeEscrowed`.
8. **Pool.** `token.enableTrading()`, then `safeTransfer(adapter, budget)` (the adapter gets the whole budget,
   §7). Snapshot the token and native balances, then call
   `adapter.graduate{value: poolNative}(req{memeTarget: T, memeMax: budget, curvePriceWad: P, nativeUsdWad})`.
   `nativeUsdWad` is 0 on the native path. On quote paths it is `GraduationOracle.nativeUsdPrice()`
   (`GraduationOracle.sol:38`).
9. **Verify from balance deltas, not from the returned struct.**
   `memeBack = Δbalance(token)`, `memeUsed = budget - memeBack`, `nativeBack = Δbalance(native)`.
   - `nativeBack ≤ poolNative * 1/10000`, otherwise `AdapterResultInvalid`.
   - The pool equals the canonical pool for (token, WETH or quote, 0.30%), and the locker reports the
     position locked.
   - **Price band.** Let `start` be the pool price after the mint: native wei per whole token, or USD on quote
     paths, compared against `P * nativeUsd`. `start ≥ P*(1 - band)` must always hold.
     `start ≤ P*(1 + band)` must hold unless `memeBack == 0`, meaning the budget was used up absorbing a
     donation (§4). Otherwise revert `StartPriceOutOfBand`.
10. `pendingCreatorGraduation += nativeBack`: the refund dust goes to the creator's pull balance, never stays
    locked. Quote residual goes to `pendingCreatorQuote`.
11. `burn(memeBack)`. Transfer `creatorReserve` to `owner()`. A `LaunchToken` push cannot be rejected
    (`LaunchToken.sol:42-58`). Then `notifyCampaignGraduated` and
    `Graduated(pool, R, protocol, creator, poolNative, memeUsed, memeBack, P, start, repaired)`.

### Pull claims

- `claimCreatorGraduation(address payable to) nonReentrant`: requires
  `msg.sender == creatorGraduationBeneficiary`. Zero the balance, send it, and revert on failure so the
  balance is restored. It can pay to any address, so a contract wallet that rejects native just names another
  recipient. There is no expiry. A quote-token twin covers `pendingCreatorQuote`.
- `flushProtocolGraduationFee() nonReentrant`, permissionless: zero the escrow, then
  `routeFinalize{value}(finalizeRouteProfile)`. If that reverts, the whole call reverts and the escrow stays.
- `excessNativeBalance()` (`:508-518`, `:913-918`) must also subtract `pendingCreatorGraduation` and
  `pendingProtocolGraduationFee`. **Otherwise `rescueExcessNative` (owner = creator) takes the protocol's
  escrowed 2.2%.**

Errors: `GraduationNotDue`, `NotPending`, `SupplyBound`, `AdapterResultInvalid`, `StartPriceOutOfBand`,
`NotBeneficiary`, `NothingToClaim`. `GraduationPaused` and `ClaimFailed` are reused.

## 2. Supply bound

Whole tokens. `P(s) = b + k·s`, `A(s) = b·s + k·s²/2`. At graduation `R = A(s)` and
`T(s) = 0.78·A(s)/P(s)`. For b ≪ k·s this gives `T ≈ 0.39·s`.

The bound: `s + T(s) + 20M ≤ 1B`, where 20M is the 2% reserve. `T` increases with `s`, so the bound only has
to hold at the largest sold, `s = curveSupply`. With `curveSupply = 700M`, `T(700M) = 273.4M` and the total is
993.4M. The 6.6M headroom (2.4% of T) absorbs the price band and repair.
At `curveBps 8400` the bound fails from `s ≈ 704.7M` (computed exactly in integers: 704M fits, 705M does not).

**Rule (supply-aware, no ladder):**

1. `curveSupply` is the hard stop. Set **`curveBps 7000`, `liquidityTokenBps 2800`** (reserve stays 200 bps).
   `setConfig` computes `s + T(s) + reserve ≤ totalSupply` at `s = curveSupply` and refuses a config that
   fails. This runs in the factory, so it costs the campaign no bytes.
2. Sold-out always graduates (trigger 1), even below the USD target. That is the fallback when the oracle
   price has left the range at graduation. It never refuses and never freezes.
3. At create, the factory refuses a target with
   `oracle.nativeTargetForUsd(target) > A(curveSupply)·95%` (`TargetOutOfRangeAtPrice`). If the oracle reverts,
   it refuses (`OraclePriceUnavailable`) and the creator retries.
4. Per chain: **BNB `k = 1080`** (steeper, as in D9 "b") and **Robinhood `k = 850`** (unchanged; not needed).
   `b = 1e9` on both.

Anchors read on 2026-09-30 from Chainlink: BNB/USD **$767.32** (round updated 10:14:31 UTC), ETH/USD **$2,694.94**
(09:33:08 UTC).

**Today's curve, no pool cap. Cells are sold / pool / total, in millions.**

| BNB, k=850 | $100 | $200 | $400 | $767 | $1500 | $3000 |
|---|---|---|---|---|---|---|
| $15K | 593/232/845 | 419/164/603 | 296/116/432 | 213/84/317 | 152/60/232 | 107/42/170 |
| $30K | **839/328/1187** | 593/232/845 | 419/164/603 | 302/118/440 | 216/85/320 | 152/60/232 |
| $50K | **>84%** | **766/299/1085** | 541/212/773 | 390/153/563 | 279/109/408 | 197/77/294 |

The bound breaks below BNB $236.6 ($50K), $142 ($30K) and $71 ($15K). Today the 84% curve also cannot
reach $50K below $166 (`A(840M) = 300.7`).

**Proposed BNB, k=1080, cap 700M** (\* = sold out, graduates below target):

| | $150 | $200 | $400 | $767 | $1500 | $3000 |
|---|---|---|---|---|---|---|
| $15K | 429/168/617 | 372/145/537 | 263/103/385 | 189/74/284 | 135/53/208 | 95/38/153 |
| $30K | 608/237/865 | 526/206/752 | 372/145/537 | 268/105/393 | 192/75/287 | 135/53/208 |
| $50K | 700/273/993\* | 679/265/965 | 480/188/688 | 346/135/502 | 248/97/364 | 175/69/263 |

`A(700M) = 265.3 BNB`. The create refusal for $50K applies below $198.4 BNB, and $15K/$30K are never refused
above $113.

**Robinhood, k=850, cap 700M:** the maximum is 342/134/496 ($50K at ETH $1000). The create refusal for $50K
applies below ETH $251.9. The whole range from $1K to $10K fits with at least 50% headroom.

Formulas: `s* = (−b + √(b² + 2k·N))/k`, `N = USD/px`. Script:
`scratchpad/c5/{bound,exact,e2,t}.mjs` (throwaway, not committed).

## 3. Retry and exits

- **Trading.** Buy, sell, first buy and escrow (C3/C4).
- **Pending.** Buys, sells and transfers are refused. The token is not enabled, and `raise` and `sold` are
  frozen, so the split is deterministic. The only exit is `graduate()`, which is permissionless. An EVM
  graduation keeper calls it in the next block, and anyone else may too.

What can block `graduate()`, and how each ends:

| Blocker | Resolution |
|---|---|
| Pre-made or donated pool | The adapter repairs it (§7, C7) |
| Router paused, reverting or out of gas | Escrowed and flushed later |
| Creator rejects native | Pull payment, not in the path |
| Stale oracle (quote paths only; native needs none after Pending) | Retry after the next round |
| `paused` / `graduationPaused` | Honoured for 72 h after `pendingSince`, then ignored |
| Low gas from the caller | The call reverts and anyone retries |
| Quote route disabled or illiquid | Open question 1 |

- **Graduated.** Creator claim (any time), protocol flush (permissionless), and `rescueExcessNative`
  (donations only).

## 4. Audit block per money path

**`graduate()`**

- Guard: `nonReentrant`.
- CEI: all state (phase, snapshot, creator credit) is written before the router and adapter calls. After the
  calls, only verification, dust credit, burn and events happen, and a failed check reverts everything.
  An adapter re-entering buy, sell or graduate hits the guard and then `Finalized`.
- Reachable only from Pending, or from Trading when due.
- Overflow: `R ≤ A(700M) ≈ 2.7e20`; `R·1980 < 1e24`; `P ≥ b > 0` (no division by zero); `x² ≤ 4.9e53`, so the
  bound at `:888-895` still holds.

Griefing:

- (a) A creator wallet rejecting native is not in the path.
- (b) A paused router is caught and escrowed.
- (c) An oracle that is stale or reverting only affects quote paths. The retry is permissionless, and
  sold-out needs no oracle.
- (d) A reverting adapter leaves Pending intact, so retry.
- (e) Balance donations do not change `R`, which is accounting. Native donated to the pool is absorbed at
  ≥ P, which costs the donor. When the budget runs out, the start price goes above P, and a donor who then
  sells into the pool extracts `(pn+D) − √((pn+h)(pn+D)) < D`, so it is a loss for them.
- (f) A caller who under-supplies gas makes the `routeFinalize` try fail into escrow. That is harmless: the
  escrow is flushed later.

**`claimCreatorGraduation`**: `nonReentrant`, zero-then-send, reachable in Graduated only. The only grief
possible is against oneself.

**`flushProtocolGraduationFee`**: `nonReentrant`, zero-then-call, and it reverts to restore the escrow. It can
be called by anyone but pays only the router.

**Crossing buy**: it makes no new external calls. It is unchanged except for the Pending effects.

## 5. Invariants

1. `protocol + creator + poolNative == R`, and after graduation
   `protocolRouted + pendingProtocolGraduationFee + creatorCredited(incl. nativeBack) + nativeUsed == R`.
2. `sold + memeUsed + burned + creatorReserve == totalSupply` and `postBurnTotalSupply == totalSupply - burned`.
3. `sold + T + creatorReserve ≤ totalSupply` for every config accepted by `setConfig`.
4. `start ≥ P·(1 − band)`, and `start ≤ P·(1 + band)` whenever `memeBack > 0`.
5. `netRaisedWei == A(sold)` in Trading.
6. In Pending, `sold` and `netRaisedWei` are constant.
7. `balance ≥ pendingNativeTotal + pendingCreatorGraduation + pendingProtocolGraduationFee`.
8. No reachable state has a positive native balance without an exit (claim, flush or rescue).

## 6. Tests

- `LaunchCampaign.C5Split.spec.ts`: exact 2.2/19.8/78 with the dust going to the pool; routing to the creator's
  profile; a reverting router escrows and a later flush pays it; a rejecting creator still graduates, then
  claims to another address.
- `LaunchCampaign.C5Retry.spec.ts`: the crossing buy succeeds with a reverting adapter and lands in Pending;
  permissionless retry; oracle revert on the crossing buy followed by a later `graduate()`; sold-out trigger
  below the target; the pause honoured for 72 h, then ignored.
- `LaunchCampaign.C5SupplyBound.spec.ts`: a fuzz over the price range; `setConfig` rejects 8400/850;
  create-time refusal and `OraclePriceUnavailable`.
- `LaunchCampaign.C5Invariants.spec.ts`: the §5 invariants, handler-based, over buy, sell, graduate and claim.
- `LaunchCampaign.C5Rescue.audit.spec.ts`: rescue cannot touch either pending balance.
- `BnbQuoteLaunchCampaign.C5.spec.ts` and `RobinhoodStockLaunchCampaign.C5.spec.ts`: slippage sizes the meme
  side; the residual is burned or credited; Robinhood completion is permissionless.
- `GraduationAdapterPreexistingPool.spec.ts`: an empty V2 pair; a donated and synced pair; a V3 pool initialized
  far above or far below P; a V3 pool with a native-only position. Each must graduate with the start price in
  band, or above it only when `memeBack == 0`.
- Fork lifecycles on real Topaz and Uniswap V3, with a griefer.

## 7. Adapter interface (Topaz V2 and Uniswap V3 authors)

```solidity
// One interface for every graduation adapter (BNB Topaz native + quote, Robinhood V3 native + stock).
// Decided by Claude 2026-09-30; changes only through Claude.
interface IGraduationAdapterV2 {
    struct Request {
        address token;              // campaign MEME
        address quoteToken;         // address(0) = native pool
        uint256 memeTarget;         // Mt: MEME that prices the pool at the curve price with no donation
        uint256 memeMax;            // Mmax >= Mt: MEME the adapter may pull from msg.sender (full burn budget)
        uint256 curvePriceWad;      // native per MEME at the curve's last price, 1e18
        uint256 nativeUsdWad;       // oracle price used by quote paths, 1e18 (0 on native paths)
        uint256 deadline;
    }
    struct Result {
        address pool;
        uint256 positionId;         // V3 NFT id; 0 on V2
        uint256 liquidity;          // LP amount (V2) or V3 liquidity, held by the locker
        uint256 memeUsed;           // Mt <= memeUsed <= Mmax
        uint256 pairedUsed;         // native (msg.value) or quote acquired
        uint256 donationFound;      // paired-token balance a third party left in the pool
        uint256 startPriceWad;      // pool price after the mint, paired per MEME, 1e18
        bool repaired;              // an existing pool was found and repaired
        uint256 repairMemeSold;     // V3 repair: MEME sold into a pre-made pool (part of memeUsed)
        uint256 repairProceeds;     // V3 repair: native/quote received for it (put into the position)
    }
    function graduate(Request calldata r) external payable returns (Result memory);
}
```

**Token flow: the adapter pulls.** The campaign approves `memeMax` to the adapter and sends the pool native
as `msg.value`. The adapter moves MEME with `transferFrom(campaign, <pool or NPM path>, m)` and never
holds MEME between calls; the unused allowance is reset to 0 by the campaign after the call. The campaign
enables token transfers inside the same `graduate()` transaction immediately before the adapter call, so
no third party can move MEME before the pool is minted (invariant I1: before the graduation transaction,
no MEME can reach any pool). Native or quote dust is returned to `msg.sender`; the adapter holds nothing
afterwards. The campaign checks every amount by balance delta, not by trusting `Result`.

**The adapter must:**

- Accept only factory-registered campaigns, as the BNB quote adapter does (`BnbQuoteGraduationAdapter.sol:243-244`).
- On quote paths, swap the native to the quote asset with minima it derives itself: a Chainlink-derived minimum on Robinhood
  (C7.1: an in-transaction quote reads the pool a front-runner just moved), `getAmountsOut` and the oracle on BNB. It then sizes the meme side from the **quote actually
  acquired**, at `curvePriceWad × nativeUsd`.
- Put the whole-range position or LP into the permanent locker and register it.
- Return every unused meme token, and any native dust, to `msg.sender` before returning.
- Return the quote residual to `msg.sender` too.
- Hold nothing afterwards.
- Report `startPriceWad` from pool state after the mint (V2 reserves, V3 `slot0`).

**Pre-existing pool contract.** The adapter must never revert because a pool exists.

- **V2 (Topaz).** If the pair exists, bypass the router, which reverts on one-sided reserves. Transfer both
  sides straight into the pair and `mint(locker)`, with the meme side sized as
  `(ourNative + donated)/P` and capped by the budget.
  **This also applies to today's BNB native path**, not only quote coins (C7.3). The native path goes through
  `TopazRouterAdapter.addLiquidityETH` (`:72-99`), so a donated and synced pair freezes it too. Prove this on
  a fork.
- **V3 (Uniswap).** If the pool is initialized at `p0 ≠ P`, swap to P with a `sqrtPriceLimitX96` limit, then
  mint. Before graduation the pool can hold only native or quote (`LaunchToken.sol:52`). So the move either
  crosses nothing or sells meme at a price ≥ P. Tokens and native gained in the repair come from and go into
  the budget and the position. If it is not initialized, initialize it at P.

## 8. Cross-section note (C3)

The 10% creator first buy costs `A(100M)`: 4.35 ETH at k=850, and 5.5 BNB at k=1080. That is more than a $15K
target once ETH is above $3,448 or BNB is above $2,727, so the first buy alone would graduate the coin inside
the create transaction. C3 should cap the first-buy cost below the native target, for example at ≤ 50% of it.

## 9. Open question

1. **Quote coin whose route dies.** If the quote route is disabled or illiquid, the coin stays in Pending
   indefinitely. Today there is deliberately no native fallback (`BnbQuoteLaunchCampaign.sol:39-40`). The
   proposal is that after 7 days in Pending, anyone may graduate the coin into the native pool with the same
   split and emit `QuoteBindingAbandoned`. The alternative is to keep holders frozen until the Safe re-enables
   the route. This needs a founder decision.

## 10. Reconciliation with the adapter sections (Claude, 2026-09-30)

- The interface in §7 is the single interface for all four adapters; `memeBudget` is `memeMax`
  everywhere. The V3 repair reports `repairMemeSold` and `repairProceeds` in `Result` (not `Request`);
  MEME conservation is `memeUsed (incl. repairMemeSold) + returned + burned == budget`.
- The 1 bp cap on returned native (§1.9) does not apply when the repair exhausted the spare MEME
  (`memeUsed == memeMax`): the leftover native or quote then goes to the creator's pull balance (as
  §1.10). A griefer's seeded bids can only raise the start price, never lower it.
- Robinhood quote paths take their minimum out from Chainlink, not QuoterV2 (C7.1).
