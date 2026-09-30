# C7. Robinhood graduation adapters: C7.1, C7.2, stock residual (spec)

Status: audit-level spec for `EVM_LAUNCH_GENERATION_PLAN.md` C7.1 and C7.2 and the stock residual. Nothing is
built. "Today" cites `claude/evm-launch-gen` as of 2026-09-30. Interface assumptions follow
`C5-graduation.md` §1 and §7 (Pending state, permissionless `graduate()`, whole budget handed to the adapter).

## 0. Verified facts (Robinhood mainnet 4663, block 76437299, 2026-09-30, read-only `cast`)

- **SwapRouter02 `0xCaf681a6…` has no quote function.** The legacy selector
  `quoteExactInputSingle(address,address,uint24,uint256)` = `0xb3c64859` is absent from its bytecode, and
  QuoterV2's `0xc6a5026a` is absent too. `cast call` WETH→SPY via `0xb3c64859` reverts with empty data.
  `exactInputSingle` `0x04e45aaf` is present. Its `factory()` and `WETH9()` are the V3 factory `0x1f7d7550…`
  and WETH `0x0Bd7D308…`.
- **QuoterV2 `0x33e885eD…` has `0xc6a5026a`.** It has the same factory and WETH9. A quote of 0.1 WETH → SPY
  (fee 500) returned `350604670602409627` (0.3506 SPY), sqrtAfter `1.48e29`, 0 ticks crossed, gas 111133.
  At SPY/USD $766.41 and ETH/USD $2694.94, that is $268.7 against $269.5, which is consistent.
- Fee tiers: `feeAmountTickSpacing` 100→1, 500→10, 2500→0, **3000→60**, 10000→200.
- Oracle ages at 10:17 UTC: ETH/USD was 2676 s old. **The SPY feed was 70,372 s old** (last update Tuesday
  14:44 UTC), so stock feeds update about once per trading day.
- The chain reports block `gasLimit` 2^50. That is the Arbitrum Nitro signature, and Nitro caps a single
  transaction at 32M gas (open question 2).
- Today's defects:
  - `RobinhoodStockTokenGraduationAdapter.sol:27-30` declares the quote `view` and calls it on `swapRouter`
    (`:308, :317`), so every stock graduation reverts.
  - `RobinhoodUniswapV3GraduationAdapter.sol:137` calls `createAndInitializePoolIfNecessary`, which is a
    no-op on an initialized pool, and `:145` then mints at the griefer's price. `LaunchCampaign.sol:748-749`
    reverts `DexPriceDrift`.
  - The native adapter has no caller check (`:103-116`).
  - `RobinhoodStockLaunchCampaign.sol:160` demands `memeTokenUsed == memeAmountDesired`, and `:163` reverts on
    any residual. A full-range mint at a floor-rounded `sqrtPriceX96` (`:490-496`) leaves wei on one side, so
    this reverts in practice even with C7.1 fixed.
- Token lock: `LaunchToken._update` (`LaunchToken.sol:42-55`) lets a transfer through before `tradingEnabled`
  only when it is a mint, when `from == owner()` (the campaign), or when `msg.sender == owner()`.
  **Buyers hold MEME but cannot move it.** A pool can never send MEME out either, because then
  `from == pool` and `msg.sender == pool`.

## 1. C7.1: stock acquisition without an in-transaction quote

QuoterV2 is callable from a contract. Its `quoteExactInputSingle` is non-view. Internally it calls
`pool.swap`, catches the revert it raises in its own callback and **returns normally**, so a caller makes a
plain `CALL`. The interface must not be declared `view`: under `STATICCALL` the pool's `slot0` write fails,
QuoterV2 cannot parse the reason, and it reverts. `RobinhoodV3Quoter.sol` behaves the same way.

**Either quoter is unsound as protection.** A quote taken in the same transaction reads the same pool that
a front-runner has just moved. `minimumStockOut = quote × (1 − slippage)` therefore bounds nothing. The
probe-based impact check (`:315-321`) has the same flaw.

Specification:

- Delete both quote calls and the impact probe. Keep `_requireRouteLiquidity` (`:444-449`) as a depth
  sanity check.
- Derive the minimum from the oracles:
  `oracleOut = nativeIn × nativeUsd / stockUsd` (scaled to the stock's decimals) and
  `minOut = oracleOut × (1 − maxSwapSlippageBps)`.
- `exactInputSingle` on SwapRouter02 with `amountOutMinimum = minOut`, and account from the balance delta,
  as `:344-345` does today. Caller-supplied minima (`RobinhoodStockLaunchCampaign.sol:97, :113`) go, because
  `graduate()` is permissionless (C5).
- **Sandwich bound.** The adapter receives at least `oracleOut·(1 − slippage)`. The extraction ceiling is
  `slippage + |oracle basis|` of pool native, less the attacker's two pool fees. A stale stock feed during
  market hours widens the basis, so keep `maxSwapSlippageBps` at 300 or lower. Today's route policy uses
  500 for deviation and 300 for slippage (`config/robinhood/mainnet-stock-routes.json`).
- The MEME/STOCK start price is `stockAcquired / T`. The USD continuity check (`:435-441`) against
  `P × nativeUsd` stays, with the C5 quote band (100 bps).

## 2. C7.2: repairing a pre-made pool

### Claim

Before `graduate()`, the canonical pool `(MEME, Q, 3000)`, with Q = WETH or STOCK, holds **zero MEME**. Every
position in it holds only Q and lies at MEME prices ≤ the current price. It is a bid.

Proof. In `UniswapV3Pool._modifyPosition`, a position `[a,b]` owes token0 iff `sqrtC < sqrtB`, and token1
iff `sqrtC > sqrtA`. In each case the amount rounds **up**, so it is at least 1 wei. Paying MEME into the
pool requires a transfer with `from ≠ campaign`, and the token blocks it (§0). So:

- **Case A** (MEME = token0, `p = P`): every position has `sqrtB ≤ sqrtC`, which is Q below price.
- **Case B** (MEME = token1, `p = 1/P`): every position has `sqrtA ≥ sqrtC`, which is Q above `p`, meaning
  MEME price ≤ current.

Price can move freely through zero-liquidity regions. Moving it into a bid from above needs MEME in. Moving it
out of MEME-bearing ranges from below needs MEME out, and that transfer reverts. So the property holds for
every reachable pool state. `flash` and `collect` of MEME are impossible for the same reason.

### Target

With `P` = the curve price in wei per whole token (C5 `curvePriceWad`), and `sqrt(x)` rounded down:

- Case A: `sqrtT = sqrt(mulDiv(P, 2^192, 1e18))`.
- Case B: `sqrtT = sqrt(mulDiv(1e18, 2^192, P))`.
- Stock path: `P_Q = stockAcquired·1e18 / T` replaces `P`.

`zeroForOne = sqrtC > sqrtT`, and `tokenIn = zeroForOne ? token0 : token1`.

| | MEME too expensive (P_C > P) | MEME too cheap (P_C < P) |
|---|---|---|
| A (MEME t0) | `sqrtC > sqrtT`, zeroForOne, **MEME in (sale)** | `sqrtC < sqrtT`, oneForZero, Q in |
| B (MEME t1) | `sqrtC < sqrtT`, oneForZero, **MEME in (sale)** | `sqrtC > sqrtT`, zeroForOne, Q in |

- **Q-in direction.** It traverses `(P_C, P]`. By the claim, no position overlaps this range, so the active
  liquidity is 0. `computeSwapStep` with `L = 0` returns `amountIn = amountOut = fee = 0` and jumps to the
  step target, and the loop ends at `sqrtPriceLimitX96 = sqrtT`.
  **Cost is exactly zero. No range can make us buy MEME or pay Q.**
- **Sale direction.** It traverses `[P, P_C)` and fills the griefer's bids at marginal prices in that
  interval, so every unit sells at ≥ P **before the 0.30% fee**, and the fee accrues to the bid owners. Proceeds
  satisfy `r ≥ 0.997·P·s`. That 0.3% on the sold tokens is the only possible cost, and it comes out of
  otherwise-burned supply.
  The claim therefore **holds with that qualification**: the repair never pays Q, never buys MEME, and sells
  only at ≥ P·0.997.

### Algorithm (`adapter.graduate`, and `repairStep` for chunking)

1. Check `sqrtT` is within `(getSqrtRatioAtTick(-887220), getSqrtRatioAtTick(887220))`, the full-range ticks at
   spacing 60, or revert `TargetOutOfRange`. This is unreachable: the C5 curve spans ticks about
   ±143k..±207k.
2. `pool = NPM.createAndInitializePoolIfNecessary(t0, t1, 3000, sqrtT)`. That covers a missing pool and a
   pool that exists but is uninitialized. Require `pool == factory.getPool(t0, t1, 3000)`.
3. Read `slot0`. If `sqrtC == sqrtT`, skip. Otherwise call `IUniswapV3Pool(pool).swap` directly (no router):
   - `recipient`: the adapter inside `graduate()`, or the campaign in `repairStep`.
   - `zeroForOne` as in the table.
   - `sqrtPriceLimitX96 = sqrtT` inside `graduate()`. In `repairStep` it is a caller-supplied limit, required
     to lie between `sqrtC` and `sqrtT` inclusive.
   - Q-in: `amountSpecified = +1` (exact input). V3 rejects 0 (`AS`), and this wei is never consumed.
   - Sale: `amountSpecified = +(memeMax − T − repairMemeSold)`, the spare, as exact input.
4. `uniswapV3SwapCallback(d0, d1, data)`:
   - Require `msg.sender == _activePool` (transient storage, set just before step 3 and cleared right after).
   - If the owed token is Q, require that the owed amount is 0 (`RepairInvariantBroken`).
   - If the owed token is MEME, require `owed ≤ spare`. Pay with `transferFrom(campaign, pool, owed)`. That is
     allowed before `enableTrading` because `from == owner()`, and it is spent from an exact allowance the
     campaign grants for the spare and resets to 0.
5. After the repair, if `sqrtC ≠ sqrtT`, the spare ran out and the price is still above P. Continue: C5 §1.9
   accepts `start > P` only when `memeBack == 0`.
6. Mint full range `[-887220, 887220]` via NPM with MEME `T + unused spare` and Q `poolQ + r`, `min = 0`, to
   the adapter. The price is pinned by step 3, and slippage is checked after the mint against `slot0`. Then
   `safeTransferFrom` to the locker, as today (`:164-168`). Return all unused MEME and Q to the campaign.
   `startPriceWad` comes from `slot0` after the mint.

**Chunking.** Each initialized tick crossed in the sale direction costs about 20-30k gas. A griefer who seeds
1,000+ ticks between P and P_C can push a one-shot repair past 32M.

- The campaign therefore exposes `repairPool(uint160 limit)`: permissionless, Pending only, `nonReentrant`.
  It calls `adapter.repairStep`, credits the Q proceeds to `repairQuoteProceeds` and adds the MEME sold to
  `repairMemeSold`.
- Progress is monotone. Pushing the price back through filled ranges needs MEME out, which reverts, so a
  griefer can only re-open the empty gap directly above.
- New bids cost the griefer a mint, at about 200-400k gas per tick, against our 20-30k to cross each one.
- `graduate()` forwards `repairQuoteProceeds` as `Request.repairProceeds`.

### Stock path (MEME/STOCK)

The griefer can hold STOCK, so the pool can hold STOCK-only liquidity. The proof uses only "the pool holds no
MEME", so **the same conclusion holds**. Three places differ:

- The target depends on the acquisition, so the acquisition runs first (§1).
- Proceeds and residual are in STOCK.
- The STOCK contract is Robinhood's, and it can pause or blocklist. Any revert then leaves Pending and is
  retried; nothing is stranded, because the call is atomic.

A rebasing or fee-on-transfer stock breaks every V3 pool. That is excluded at route configuration.

## 3. Stock residual (replaces `RobinhoodStockLaunchCampaign.sol:158-163`)

- Drop both equality checks. Verify from balance deltas instead (C5 §1.9): `memeUsed + memeBack == budget`,
  `quoteUsed + quoteBack == stockAcquired + repairProceeds`.
- `memeBack` is burned.
- `quoteBack` goes to `pendingCreatorQuote` (pull), and native dust goes to `pendingCreatorGraduation`.
- Graduation **never reverts on a residual**. It reverts only when conservation fails, which is a bug and not
  dust.

## 4. What C5 must carry for these adapters

- The crossing buy only enters Pending. `graduate()` and `repairPool()` are permissionless.
- `Request` gains `uint256 repairProceeds`. The spare is `memeMax − memeTarget − repairMemeSold`.
  The C5 §5 conservation invariant 2 gains `+ repairMemeSold`.
- **Conflict with C5 §1.9.** `nativeBack ≤ 1 bp` must be waived when `memeBack == 0`. After a budget-exhausted
  repair, the WETH the griefer paid can exceed what the tokens left in the budget can pair.
- The adapter restricts `graduate` and `repairStep` to `factory.isCampaign`, locked once (as `:247-254`). It
  exposes `liquidityKind/v3Factory/positionManager/WETH/feeTier/getPool` for
  `PermanentV3PositionLocker.configureRevenue`.
- C5 §7's "QuoterV2 on Robinhood" becomes the oracle minimum from §1.

## 5. Audit block

- **Reentrancy.** `graduate`, `repairStep` and campaign `repairPool` are `nonReentrant`. The callback is not,
  and is guarded by `_activePool`, which is transient and single-use.
- **Trusted calls.** The only external calls between `enableTrading` and the lock go to WETH, the canonical
  pool, NPM, SwapRouter02, the configured STOCK and the locker. Creator and protocol payments are pull or
  escrow (C5).
- **CEI.** The campaign writes Pending bookkeeping before the call, and verifies deltas after. Every failure
  reverts the whole call.
- **Reachable states.** `repairPool` only in Pending. `graduate` only in Pending, or when due. The callback
  only inside our own swap.
- **Overflow.**
  - `mulDiv` is 512-bit, and `P ≤ ~6e11` wei per token, so `sqrtT < 2^160` is checked.
  - `amountSpecified ≤ 1e27 < 2^255`.
  - Limit validity: V3 requires `MIN_SQRT_RATIO < limit < MAX_SQRT_RATIO` on the correct side. Step 1 and the
    direction rule guarantee it, so the `SPL` revert is unreachable.
- **Griefing.**
  - (a) A wrong price with no liquidity: the move is free.
  - (b) Bids above P: filled at ≥ 0.997·P.
  - (c) Bids larger than the spare: the pool opens above P, and a round trip loses for the griefer (C5 §4e).
  - (d) Tick seeding: handled by chunking.
  - (e) Sandwich of the repair: a front-run can only add bids, which we fill at ≥ P·0.997. The back-run sells
    that MEME at ≤ P·0.997, so the attacker's PnL is ≤ 0.
  - (f) Pools at 100/500/10000 are irrelevant: we use `getPool(…,3000)` only, and the indexer and app must
    pin 3000.
  - (g) The acquisition sandwich is bounded by the oracle minimum.
  - (h) A stale stock feed (weekends exceed 90,000 s): stay in Pending and retry.

## 6. Invariants

1. Before graduation, the MEME balance of any pool is 0.
2. The repair pays 0 Q, and `r ≥ 0.997·P·repairMemeSold`.
3. After `graduate()`, `slot0 == sqrtT`, or the MEME left over is 0.
4. Conservation of MEME and Q across campaign, adapter, pool and locker. The adapter holds 0 afterwards.
5. The locker holds exactly one position for the pool, at fee 3000, full range.

## 7. Fork test plan (`RobinhoodGraduationRepair.fork.spec.ts`)

Setup:

- Hardhat fork of 4663 at a pinned **weekday** block, so the SPY feed is fresh. Mine one block first
  (CLAUDE.md, fork lesson).
- Deploy the new generation locally against the real factory, NPM, SwapRouter02, WETH and Chainlink.
- Create campaigns until both orderings exist (MEME < WETH and MEME > WETH), and do the same for STOCK.

Scenarios, each crossed with both orderings:

1. No pool.
2. `createPool` only, left uninitialized.
3. Pool initialized at P/1000, then at 1000·P, with no liquidity.
4. The same prices, with WETH bids in the sale range. Run this small, and larger than the spare (the exhausted
   case).
5. Bids below P only.
6. 1,500 one-tick bids. Measure the gas, and show that `repairPool` chunks to completion.
7. Griefer attacks, which must all revert: mint a MEME-bearing position, transfer MEME, and push the price back
   mid-repair.
8. Wrong-price pools at fees 500 and 10000.
9. Stock (SPY, acquisition pool `0xDDCBBa36…`):
   - The same matrix on MEME/SPY.
   - A sandwich of the acquisition inside and outside the slippage bound.
   - A dust residual that must not revert.
   - A stale feed via `hardhat_setStorageAt`: the call reverts, then the retry succeeds.

Assert:

- `slot0 == sqrtT`, or the budget is exhausted with `start > P`.
- The Q-in repair cost is 0 wei.
- Proceeds are ≥ 0.997·P·sold.
- All C5 conservation invariants hold, and the adapter balances are 0.
- The locker holds the NFT.
- The griefer's round-trip PnL is ≤ 0.
- The crossing buy never reverts.

## 8. Deploy scripts

- **`scripts/deploy-robinhood-quote-generation.ts`**
  - Today it reuses `RH_V3_GRADUATION_ROUTER` from prerequisites (`:193`) and passes it to the factory
    (`:216-221`). It must instead deploy the new native adapter (factory, NPM, WETH, **3000**) before the
    factory, and later call `setCampaignFactoryOnce` on it.
  - Assert `feeAmountTickSpacing(3000) == 60` on chain.
  - The stock adapter (`:236-245`) keeps `swapRouter` for `exactInputSingle` only; no quoter argument.
  - Call `setCampaignFactoryOnce` in-script. Today that is done separately by
    `configure-robinhood-stock-routes.ts:104`.
  - Keep `MAX_ORACLE_AGE_SECONDS` 90,000 (`:73`). Add a per-route stock feed age check at route configuration.
  - The factory wires the locker (`LaunchFactory.sol:298-303, 589-595`), unchanged.
  - Record the new addresses in `config/verification/mainnet-contracts.json`.
- **`scripts/deploy-robinhood-stock-campaign-implementation.ts`**
  - Deploy the new `RobinhoodStockLaunchCampaign`.
  - Keep the `whenMutable` guard (`:13, :60-69`).
  - Additionally assert `factory.stockGraduationAdapter()` equals the new adapter. The Safe batch (`:101-102`)
    must run before create is unpaused.

## 9. Open questions

1. Who gets repair surplus native or STOCK when the spare is exhausted? The default here is creator pull
   (C5 §1.10). The alternative is the 10/90 protocol/creator split.
2. Confirm Robinhood Chain's per-transaction gas cap (assumed Nitro 32M). It sets the chunking threshold.

## 10. As built (evm-rh, 2026-09-30)

Files: `contracts/integrations/RobinhoodV3PoolRepair.sol` (shared engine + `RobinhoodV3PriceMath`),
`RobinhoodV3NativeGraduationAdapterV2.sol`, `RobinhoodStockGraduationAdapterV2.sol`. The old
`RobinhoodUniswapV3GraduationAdapter` / `RobinhoodStockTokenGraduationAdapter` are left untouched for the
deployed generation and are not reused. Both new adapters implement `IGraduationAdapterV2` unchanged.

### Deviations from sections 1-4, and why

- **Phase 2 of the repair (not in section 2).** Phase 1 sells at most the spare (`memeMax - memeTarget`). If it
  is used up with the price still above P and the paired side cannot pair the MEME left at the current price,
  a plain mint leaves real MEME behind with the pool above P. The C5 campaign rejects exactly that, so a
  griefer could freeze a **sold-out** graduation (spare only ~6.6M tokens vs T ~273M) for a few ETH of bids,
  most of which they get back. Phase 2 sells the excess (`memeLeft - pairedHave/price * (1 - 1e-9)`), still
  limited at the target (so every unit still sells at >= P before fee). Afterwards the MEME side binds the
  mint. Proven on the fork: sold-out coin, bids 5-100x the spare, graduation completes, start in [P, 2.56P].
- **Rounding dust into the pool.** V3 liquidity rounding leaves <= ~3e4 wei (bound `MAX_MEME_DUST = 1e12`).
  Core's `graduate()` checks `memeUsed >= memeTarget` and, for the exhausted case, `memeBack == 0` exactly.
  The adapter therefore transfers that dust into the pool instead of back (inert: V3 never accounts
  balances outside its callbacks), so memeUsed is exactly memeMax when MEME binds and >= memeTarget otherwise.
- **Chunked repair lives on the adapter as `repairStep(Request, uint160 limit)`**, callable only by a
  registered campaign for its own token. It cannot be permissionless on the adapter alone: before
  `enableTrading` only the campaign can move MEME, and filling bids needs MEME. It needs a campaign entry
  point (section 2 "Chunking"; see "Open" below). Proceeds go to the campaign (native unwrapped / STOCK);
  `repairLedger[campaign]` records them; the stock adapter pulls the STOCK back at graduate.
- **Stock `repairStep` target** is the oracle estimate of P_Q raised by 5% (`REPAIR_STEP_MARGIN_BPS`), so a
  chunk never sells below the acquisition-derived target; at spacing 60 the final 5% is <= 9 ticks.
- **Stock route struct keeps 8 fields** (the factory reads that tuple at create). `maxOracleDeviationBps` and
  `maxPriceImpactBps` are reserved: since E11 `configureStockRoute` requires both to be **0** (`InvalidPolicy`),
  so no stored limit exists that nothing enforces (impact probe deleted, band fixed at 200 bps).
  `maxSwapSlippageBps <= 300` is enforced at configuration; enabling a route reads both feeds.
- `nativeUsdWad` in the request is informational for the stock adapter; it reads ETH/USD itself.

### Audit per money path

**`NativeV2.graduate` / `StockV2.graduate`** (`nonReentrant`)
- Reachable only from `factory.isCampaign(msg.sender)` after `setCampaignFactoryOnce`, only for
  `campaign.token() == r.token`, before `r.deadline`, with `memeTarget > 0`, `memeMax >= memeTarget`, P > 0,
  `msg.value > 0`. Stock: route enabled, both feeds fresh (<= 90,000 s), acquisition pool canonical.
- CEI: ledger read and zeroed first; then external calls (WETH deposit; stock: SwapRouter02
  `exactInputSingle` with approval exactly `msg.value`, reset to 0; pool create/init via NPM; pool swap(s);
  pull MEME; NPM mint with exact approvals, reset to 0; NFT safe-transfer to the locker; refunds). No state
  that later code relies on is written after an external call except the transient callback context.
- Conservation asserted on chain: the adapter's WETH, MEME and STOCK balances equal the entry snapshot
  (`ConservationBroken`). Refunds are computed from deltas, never `balanceOf`, so tokens donated to the
  adapter can neither inflate `nativeBack` nor be swept.
- Overflow: 512-bit mulDiv throughout; sqrt target range-checked to the +-887220 tick ratios
  (`TargetOutOfRange`), which keeps every swap limit inside V3's bounds; `amountSpecified <= 1e27`.
- Griefing: (a) wrong empty price: free move, 0 wei paid (fork: 1/1000x and 1000x, both orderings);
  (b) bids above P: sold at >= 0.997 P (asserted); (c) bids beyond the spare: phase 2, no freeze;
  (d) bids below P: untouched; (e) MEME-bearing mint, MEME transfer to the pool, pushing the price back
  through filled ranges mid-repair: all revert (LaunchToken lock); (f) decoy pools at 500/10000 ignored;
  (g) acquisition sandwich beyond 3%: `Too little received`, retryable; (h) stale stock feed: `OracleStale`.

**`repairStep`** (`nonReentrant`): same caller checks; limit strictly between the current price and the step
target (`InvalidRepairLimit`); MEME paid from the campaign's exact allowance inside the callback; proceeds
sent to the campaign after the ledger is updated; balances asserted unchanged.

Its only caller is the campaign's permissionless **`LaunchCampaign.repairPool(uint160 sqrtPriceLimitX96)`**
(built 2026-09-30; full audit block in C5-graduation.md "Chunked pool repair"). In short:
- Entry rule identical to `graduate()` (shared `_openGraduation`): Pending or due, after `launchAt`, 72 h
  pause-honour rule, binding checks. `nonReentrant` on the campaign as well as the adapter.
- The campaign approves only the spare `(B - repairMemeSold) - T`, sends the same Request graduate() would
  (`memeMax = B - repairMemeSold`), resets the allowance, and requires the measured MEME / native / STOCK
  deltas to equal what `repairStep` returned (so its figures equal `repairLedger`); no native may arrive on a
  stock coin.
- **MEME moves without `enableTrading`**: the callback's `transferFrom(campaign, pool, owed)` is allowed by
  `LaunchToken` because `from` is the token's owner. Holders stay locked; nothing leaves the pool.
- Native proceeds are held in `repairNativeHeld` (excluded from `excessNativeBalance`) and added to
  graduate()'s `msg.value`, where the native adapter wraps and pairs them. STOCK proceeds are held in
  `repairQuoteHeld`, approved exactly to the stock adapter at graduate, pulled back by it, and never credited
  to the creator (only the residual is). Both are zeroed before graduate()'s external calls.
- Conservation: `B = repairMemeSold + memeUsed + burned`; `graduatedLiquidityTokens` includes the steps.

**`uniswapV3SwapCallback`** (not guarded, runs inside our own swap): requires `msg.sender == _active.pool`
(set right before `pool.swap`, deleted right after); refuses to pay the paired token; pays MEME only up to the
spare, once. Called directly by anyone: `UnauthorizedCallback`.

### Tests

- `test/evmgen-rh-graduation.fork.spec.ts` (4663 fork, 25): every scenario of section 7 in both orderings.
- `test/evmgen-rh-core-integration.fork.spec.ts` (4663 fork, 3): the real C5 campaign/factory, including heavy
  tick seeding repaired through `LaunchCampaign.repairPool` under a reduced block gas cap.
- `test/evmgen-rh-adapters.unit.spec.ts` (13): branches on mocks.
- Un-skipped against real V3 bytecode on the plain network (`test/helpers/evmgenRhRealV3.ts`):
  `LaunchFactoryLiquidityKinds` (V3 NFT auto-registration + `setNativeGraduationAdapter` acceptance),
  `RobinhoodV3GraduationAdapter` (graduate + 80/20 harvest), `RobinhoodStockGraduationCompletion`.

### Open

1. **Resolved 2026-09-30: core now has `repairPool`** (C5-graduation.md "Chunked pool repair";
   `test/evmgen-rh-core-integration.fork.spec.ts` runs it through the real campaign). Original note: heavy tick seeding pushes a one-shot `graduate()` past the 32M Nitro cap:
   measured on the 4663 fork, 401 initialized ticks cost 16.45M gas in one graduation, ~37.5k per crossed
   tick, so **~816 one-tick bids freeze a coin** (the griefer's mints are cheap at 0.05 gwei). With the
   harness campaign's `repairPool` the same pool repairs in 6 steps (max 4.06M gas each) and the final
   graduation costs 1.04M. Without a campaign entry point (Pending only,
   `nonReentrant`, permissionless: approve `budget - repairMemeSold - memeTarget`, call
   `adapter.repairStep(req, limit)`, reset allowance, subtract `repairMemeSold` from the budget, add the native
   proceeds to the pool native at graduate and keep them out of `excessNativeBalance`, approve STOCK proceeds
   to the stock adapter at graduate), such a coin stays in Pending.
2. **Resolved by E11 (below).** **Stock band vs acquisition cost.** On the fork a $23K acquisition of SPY landed 8-80 bps below the
   Chainlink rate (fee 0.05% + impact + basis), against the 100 bps band. Routes at fee 10000 (MSTR) cannot
   pass the band at all. Either restrict routes to fee <= 3000 or widen the quote band to slippage + band.

### E11 as built (branch `claude/evm-core`, 2026-09-30): band 200 bps, acquisition pools <= 0.30%

Founder decision E11. `contracts/integrations/RobinhoodStockGraduationAdapterV2.sol`:
- `QUOTE_PRICE_BAND_BPS` 100 -> **200** (`_checkContinuity`): the MEME/STOCK start price in USD must be
  `>= curveUsd * (1 - 2%)`, and `<= curveUsd * (1 + 2%)` unless a repair used up the whole budget (unchanged rule).
- `MAX_ACQUISITION_FEE_TIER = 3000`. `configureStockRoute` refuses `acquisitionFeeTier > 3000` (`InvalidFeeTier`,
  checked before the tick-spacing read, so a valid 1% tier is refused by E11, not by accident), and `_acquire`
  re-checks it at every graduation. The graduated MEME/STOCK pool itself is always `POOL_FEE = 3000`.
- `maxOracleDeviationBps` / `maxPriceImpactBps` must be 0 at configuration (reserved; see Deviations).
- No other logic changed; the factory's 8-field `stockRoutes` read is unchanged.

Audit block (the diff):
- **Reentrancy.** No new external call. `configureStockRoute` is `onlyAdmin` and writes after its reads (the
  feeds and `getPool` are views); `graduate` keeps `nonReentrant`. The re-check in `_acquire` is a pure storage read
  before any external call.
- **CEI.** Unchanged ordering: checks (fee tier, canonical pool, depth, oracle minimum) all precede WETH deposit and
  the swap. The re-check adds one more check at the top.
- **Reachable states.** A route with tier > 3000 can no longer be stored, so graduation's re-check is defence in
  depth (it also covers a route stored by any future code path). A route that was valid stays valid.
- **Overflow.** `startUsd * 1e4` and `curveUsd * (1e4 +- 200)`: both operands are wad USD prices (< 1e40 for any
  real price), far from 2^256. `BPS - 200` cannot underflow.
- **Griefing.** A wider band gives a sandwicher of the acquisition no extra room: the acquisition minimum is still
  `oracleOut * (1 - maxSwapSlippageBps)` (<= 3%), and the band only decides whether the pool start price is accepted.
  The lower edge is what the widening moves: a start price up to 2% below the curve's USD price is now accepted,
  i.e. the pool may open up to 2% cheaper (in USD) than the last curve buy. That is the founder's trade-off: at 100 bps
  real SPY fills (63-69 bps below Chainlink plus fee) left no margin and the coin sat in Pending. A 1% acquisition
  pool would spend half the band on its own fee, hence the 0.30% cap.
- **Tests.** Unit: `evmgen-rh-adapters.unit.spec.ts` ("E11: band is 200 bps; ... fee 10000 is refused", reserved
  fields refused when non-zero). Fork (4663): `evmgen-rh-graduation.fork.spec.ts` stock specs assert |dev| <= 200 bps
  and "stock E11: a route through a 1% pool (fee 10000) is refused" (7 stock specs passing; SPY landed +2 to +7 bps).
