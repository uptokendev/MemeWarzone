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
  *Superseded by the audit 2 fix below: 25%, plus a per-campaign cap at the step's stop.*
- **Stock route struct keeps 8 fields** (the factory reads that tuple at create). `maxOracleDeviationBps` and
  `maxPriceImpactBps` are reserved: since E11 `configureStockRoute` requires both to be **0** (`InvalidPolicy`),
  so no stored limit exists that nothing enforces (impact probe deleted, band fixed at 200 bps).
  `maxSwapSlippageBps <= 300` is enforced at configuration; enabling a route reads both feeds.
  *Superseded by the audit 2/5 fix below: <= 100, and a route is fixed at its first configuration.*
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

### Audit 2/5 fixes as built (branch `claude/evm-rh`, 2026-09-30)

Three findings against the Robinhood adapters, fixed one commit each. Every EXPLOIT test is now a `HOLDS:`
test that runs the same attack steps. Files: `RobinhoodV3PoolRepair.sol`, `RobinhoodV3NativeGraduationAdapterV2.sol`,
`RobinhoodStockGraduationAdapterV2.sol`, the adapter steps of `scripts/deploy-robinhood-quote-generation.ts`.

**1. HIGH (audits 2/5): the stock adapter's admin was the deployer EOA and could re-point any route instantly.**
`admin = msg.sender`, immutable; `configureStockRoute` overwrote feed, pool, fee tier, depth floor and slippage
at any time, also for coins already Pending. A 100x feed divided the acquisition minimum by 100, and
`graduate()` is permissionless, so one key could sandwich every Pending stock coin.
- `admin` is a constructor argument (non-zero) on both adapters (`RobinhoodV3PoolRepair` constructor). The deploy
  script resolves it with `resolveAdapterAdmin`: `RH_ADAPTER_ADMIN`, default the Safe `0x1edcEdf5…` on 4663,
  which must have code and must not be the deployer; on a testnet it defaults to the deployer. The script binds
  `setCampaignFactoryOnce` itself only when the deployer is the admin; otherwise the bind is recorded in
  `adapterBindActions` / `next` as a Safe action. Verification args carry the admin.
- `configureStockRoute`: the first configuration of a stock (stored `oracleFeed != 0`) fixes `oracleFeed`,
  `acquisitionPool` and `acquisitionFeeTier` for the life of the adapter. A later call must repeat them, may only
  raise `minimumRouteLiquidityUsdWad` and lower `maxSwapSlippageBps`, and may flip `enabled` either way
  (`RouteFixed` otherwise). Re-enabling restores nothing looser than what was fixed, so it is allowed (an
  operator disables a stock while its feed is stale and re-enables it).
- `MAX_SWAP_SLIPPAGE_BPS` 300 -> **100** (audit 2 low).
- Audit block. *Reentrancy:* no new external call; `configureStockRoute` stays `onlyAdmin`, reads (views) before
  its single storage write. *CEI:* the fixed-route check is a storage read before the feed reads and the write.
  *Reachable states:* a route can go unset -> fixed(enabled or not) -> tightened/disabled/re-enabled; it can never
  return to unset or change feed/pool/tier. *Overflow:* comparisons only. *Griefing:* what remains to the admin
  (the Safe) is disabling a route or raising its depth floor, which leaves Pending coins in Pending (retryable,
  E12 native fallback after 7 days); it cannot move money. A Chainlink proxy that is later migrated cannot be
  followed: that stock's route is disabled and a new adapter generation carries the new feed.
- Tests: `audit5-quote-adapter-admin.spec.ts` "HOLDS (Robinhood stock adapter, was EXPLOIT)"; `audit2-rh-stock-repair.spec.ts`
  "HOLDS (was trust note)"; `evmgen-rh-adapters.unit.spec.ts` constructor admin refusals and "feed, pool and fee
  tier are fixed at first configuration".

**2. MEDIUM (audit 2): a repair step plus a ~5-10% ETH/STOCK move froze stock graduation.**
`repairStep` stopped at the oracle estimate + 5%. If STOCK then fell vs ETH, the fresh (acquisition-derived)
target was above the step's stop; reaching it meant moving the price back up through the ranges the step had
filled with MEME, i.e. paying STOCK, which the callback refuses (`RepairInvariantBroken`) until the 7-day fallback.
- `REPAIR_STEP_MARGIN_BPS` 500 -> **2500**: a move of up to ~20% (target +25%) leaves the fresh target below
  the stop, and `graduate` only sells down. At spacing 60 the final 25% is at most 38 initialized ticks
  (~1.4M gas at the measured ~37.5k per crossed tick).
- `repairStep` stores the pool price it left (`repairLedger[campaign].sqrtReached`, slot0 after the swap). The stock
  `graduate` reads it with the ledger (then deletes the ledger, before any external call) and, when MEME was sold
  by steps and the fresh target is above `sqrtReached`, targets `sqrtReached` instead (`_aboveStepStop`). All MEME
  the steps sold lies at or above that price, and nobody can take it out before graduation (LaunchToken refuses
  transfers from the pool), so reaching `sqrtReached` from wherever the pool is crosses only MEME-free ranges (free).
  The stored price rather than the live one: a third party can move the pool through empty ranges for free and
  must not be able to lower the start price. `_checkContinuity` still decides; beyond the band it is a clean,
  retryable `PriceContinuityFailed`.
- Audit block. *Reentrancy:* no new external call (one `slot0` view inside `nonReentrant` `repairStep`).
  *CEI:* `sqrtReached` is written after the swap like the rest of the ledger; it is the pool's own state after our
  swap, so ordering cannot change it; graduate reads and zeroes it first. *Reachable states:* the cap only applies
  with `ledger.memeSold != 0`; native ignores the field (its step target is P exactly, no drift). *Overflow:* none new
  (price comparisons; `priceFromSqrt` for the reported target). *Griefing:* moving the pool through empty ranges
  after a step changes nothing (stored price); a move past ~20% plus the band keeps the coin Pending, retryable
  when the ratio returns, E12 fallback after 7 days.
- Tests (`audit2-rh-stock-repair.spec.ts`, real V3 bytecode): "HOLDS (was EXPLOIT)": step, then STOCK -10% vs ETH,
  graduation succeeds at **-59 bps** vs the curve in USD (was `RepairInvariantBroken`); "past the step margin":
  STOCK -21% (target +26.6%), the pool stays at the stop, start **-125 bps**; "far past the margin": -30%, clean
  `PriceContinuityFailed`, graduates after the ratio returns. The cap is load-bearing: with it disabled the last two
  revert `RepairInvariantBroken`.

**3. LOW (audit 2): stock prices were computed in raw units and rounded past the band for low-decimal quotes.**
The target was `acquired * 1e18 / memeTarget`, STOCK raw per 1e18 MEME: an integer that is 5 for a 6-decimal $1
quote at a 1.85 gwei curve price, so the pool target and the continuity check rounded by >10%
(`PriceContinuityFailed` on every retry).
- `RobinhoodV3PriceMath.sqrtFromRatio(pairedRaw, memeRaw, memeIs0)` (sqrtFromPrice is now `sqrtFromRatio(p, 1e18)`,
  identical results) and `memeForPaired(paired, sqrt, memeIs0)`. The stock target sqrt comes from
  `(acquired, memeTarget)`; the `repairStep` stop from the oracle fraction `P(1+m)·ETHUSD·unit / (STOCKUSD·1e36·1e4)`;
  `_checkContinuity` from the post-mint sqrtPriceX96 (returned by `_graduateInto`) at full precision; the phase-2 keep
  estimate from the sqrt (shared engine; for the native pair this only tightens the rounding the 1e-9 shading covers).
  `targetPriceWad` / `startPriceWad` remain as reported values only.
- `configureStockRoute` refuses decimals > 18 (was > 36).
- Audit block. *Reentrancy/CEI:* pure math; `_graduateInto` additionally returns the slot0 it already read before the
  refunds. *Reachable states:* unchanged. *Overflow:* all products inside 512-bit `mulDiv`; `s < 2^160`, unit `<= 1e18`
  so `s·unit < 2^220`; `1e18·STOCKUSD` and `P·(1e4+2500)`, `ETHUSD·unit` are checked multiplications that only overflow
  for prices beyond 1e50 (revert, fail closed); a result above 2^256 reverts in `mulDiv`. *Griefing:* none new.
- Tests: `test/audit2-rh-stock-low-decimals.spec.ts` (USDG-like 6-decimal quote on real V3 bytecode): 1e6 / 3e7 /
  1.6e8 tokens sold graduate at **-30 / -31 / -58 bps** (pre-fix: `PriceContinuityFailed` at 1e6, -63 bps at 3e7);
  decimals 19 refused, 18 accepted.

Sizes (runtime, EIP-170 24,576): `RobinhoodStockGraduationAdapterV2` 19,175 B, `RobinhoodV3NativeGraduationAdapterV2`
12,574 B.

Runs after the three fixes: `npx hardhat test` **939 passing, 0 failing** (54 pending, the fork-only specs);
4663 fork `evmgen-rh-graduation.fork.spec.ts` 25/25 (the 18 native specs in one run, the 7 stock specs re-run
after the public RPC pruned the fork block during the 506 s heavy-seeding spec; SPY at 100 bps slippage landed
-4 to -9 bps vs the curve) and `evmgen-rh-core-integration.fork.spec.ts` 3/3.
