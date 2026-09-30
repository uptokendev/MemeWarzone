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
