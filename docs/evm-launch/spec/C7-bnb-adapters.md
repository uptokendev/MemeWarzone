# C7.3 and the BNB graduation paths: accept a pre-made Topaz pool and repair it

Status: spec for the audit. Nothing built. Written 2026-09-30 against `claude/evm-launch-gen`.
Parent: `docs/evm-launch/EVM_LAUNCH_GENERATION_PLAN.md` (C5, C7, E6).

## 1. Verified facts

Topaz source is the BscScan-verified source (Etherscan v2 API, chain 56, compiler 0.8.19), read
2026-09-30. It is Velodrome V2 code (`Pool`, `PoolFactory`, `Router` with `Route{from,to,stable,factory}`).
The testnet deployment has the same upstream (`deployments/bscTestnet/minimal-topaz.json`,
`topazdex/topaz-contacts@858d93c0`).

| Fact (BSC mainnet, block ~124.89M) | Value |
|---|---|
| Our `TopazRouterAdapter` `0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a` | `topazRouter()` = `0x1E98c8226e7d452e1888e3d3d2F929346321c6c3`, `poolFactory()` = `0x65E6cD0eF5D3467030103cf3d433034E570b5784`, `WETH()` = WBNB `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| Topaz router `0x1E98c822…` | `defaultFactory()` = `0x65E6cD0e…`, `weth()` = WBNB |
| Pool factory `0x65E6cD0e…` | `implementation()` = `0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678`; `volatileFee` 30, `stableFee` 5, `MAX_FEE` 300; `isPaused` false; 25 pools |
| Fee manager and pauser | `0xF407739E81574A3C9A3195bCb85eE694C94e540c`, a Safe, threshold 2 of 3 (Topaz, not us) |
| A real pool (WBNB/USDT volatile `0xe030E948…`) | EIP-1167 clone of `0xdC942D8e…`; `getFee` = **15** (`customFee` set), not 30 |
| Live BNB factory `0x632061cA…` | router `0x5c3135Df…`, `live` true, `createPaused` false, `campaignsCount` 0 |

What the Topaz source says (Pool = `0xdC942D8e…/contracts/Pool.sol`, Router = `0x1E98c822…/contracts/Router.sol`,
Factory = `0x65E6cD0e…/contracts/factories/PoolFactory.sol`):

- **Uniswap-V2-like, with Velodrome differences.** `mint` (Pool 305-329): first mint
  `L = sqrt(a0*a1) - 1000`, `MINIMUM_LIQUIDITY = 1000` minted to `address(1)` (Pool 29, 315); later mints
  `min(a0*S/r0, a1*S/r1)`; reverts if `L < 1000` (323). `a_i = balance_i - reserve_i`. Reserves are
  `uint256`, not `uint112`. `skim` and `sync` exist, permissionless, `nonReentrant` (390-399). Swap fees
  leave the pool into a `PoolFees` contract (`_update0/_update1`), so reserves equal balances except for
  donations. Volatile curve is `x*y`.
- **No swap is possible while either reserve is 0**: `amount0Out >= _reserve0 || amount1Out >= _reserve1`
  reverts (Pool 357), and `0 >= 0` is true. Nobody can trade a pre-made pool before our mint.
- **Pool creation is permissionless and deterministic** (Factory 116-129: `createPool`, CREATE2 clone,
  salt `(token0, token1, stable)`). `initialize` stores only the factory, tokens, `stable`, a `PoolFees`
  and decimals. The pool creator has no role. A griefer-made pool is identical to one our router makes.
- **Fee is per factory, overridable per pool by the fee manager** (Factory 100-113: `setCustomFee` for
  any existing pool, up to 300 bps or 0). Swaps read `getFee` live (Pool 377-378).
- **Router refuses a one-sided pool**: `_addLiquidity` uses desired amounts only if both reserves are 0
  (Router 189); otherwise `quoteLiquidity` reverts `InsufficientLiquidity` when either reserve is 0
  (Router 88). `mint` itself has no pause check; `swap` does (Pool 354).

Our side, today:

- `LaunchToken._update` (`contracts/token/LaunchToken.sol:42-55`) before `enableTrading` allows only
  mints, `from == owner()` or `msg.sender == owner()` (owner = the campaign). It is OZ v5's single hook,
  so it covers `transfer`, `transferFrom` (msg.sender is the spender) and transfers into a pool.
  A holder cannot move MEME into a pool; the router cannot pull it.
- The campaign only sends MEME to `msg.sender` of a buy (`LaunchCampaign.sol:609`, buyer = `msg.sender`,
  `:447-476`), to `owner()` at graduation (`:759`), and to the DEX router under a transient approval
  (`:733-743`). A pool cannot be `msg.sender` of a buy. No token rescue exists (only native, `:513`).
- `enableTrading` runs inside the graduation call (`LaunchCampaign.sol:732`, `BnbQuoteLaunchCampaign.sol:131`).
- `PermanentLpLocker.registerGraduatedPool` (`contracts/PermanentLpLocker.sol:131-189`) checks
  `pool.factory() == topazFactory`, not stable, `getFee(pool,false) == 30` (`:34, :149-151`), token pair,
  LP balance. **It has no creator check**: it accepts a pool a third party created. The factory calls it
  from `notifyCampaignGraduated` with `lockedLpAmount` = the locker's whole LP balance
  (`contracts/LaunchFactory.sol:533-555`), inside the graduation transaction.

## 2. The two freezes today

**Quote path (C7.3).** `BnbQuoteGraduationAdapter.sol:257-259` reverts `FinalPoolAlreadyExists` when
the MEME/QUOTE pool exists. Anyone calls `createPool(meme, quote, false)` for the price of gas, once the
MEME address is known. `retryQuoteGraduation` then reverts forever and the coin stays PENDING with its
raise locked. Removing the check alone is not enough: with a donated and synced QUOTE balance the
router path (`:302-312`) reverts in `quoteLiquidity`.

**Native path.** `LaunchCampaign._finalizeWithTarget` (`:702-781`) calls `router.addLiquidityETH`
(`TopazRouterAdapter.sol:72-113` forwards to Topaz). Griefer: `createPool(meme, WBNB, false)`, send 1 wei
WBNB, `sync()`. Reserves become `(0, 1)`, `totalSupply` 0. Router 189 is false, Router 88 reverts. No
division by zero, no wrong ratio: a clean revert. Because `_finalizeWithTarget` runs in the **success
block** of the `try` in `_autoFinalizeIfEligible` (`:681-688`), which `catch` does not cover, the crossing
buy reverts too: nobody can buy past the target. `graduateIfEligible` (`:521-530`) reverts the same way.
Cost to the griefer: two transactions and 1 wei. **This is live on the open mainnet factory today**
(0 campaigns so far).

Donation without `sync`: reserves stay `(0,0)`, the router uses the desired amounts, `mint` counts the
donation into `a1`, and the pool opens above the curve price. `_requirePriceWithinTolerance` (`:748-749`)
does not see it because it prices from the router's return values, not pool state.

## 3. The invariant the repair rests on

**I1. Before our mint, the MEME balance of any MEME/X pool is 0, so `totalSupply` is 0.** A first mint
needs `sqrt(a0*a1) >= 2000`; with `a_meme = 0` it underflows and reverts (Pool 314). So a griefer can
hold only X in the pool, and cannot own LP.

I1 holds today by `LaunchToken.sol:42-55` plus the campaign's send paths. **C3 (creator first buy) and
C4 (escrow) must not add any path where the campaign sends MEME to a caller-chosen address** (a
`buyFor(recipient)` with `recipient = pool` breaks I1). The fork tests below pin I1.

## 4. Repair algorithm (one internal library, both adapters)

Inputs: pool `P` (MEME/X volatile, X = WBNB or QUOTE), our X amount `N` (all of it is deposited),
`Mt` = MEME that prices the pool at the target with no donation, `Mmax >= Mt` = MEME the adapter may use.
The target price is the ratio of our own amounts, `N / Mt` (native path: `Mt = N * 1e18 / finalCurvePrice`
as computed by the campaign; quote path: `N = quoteAcquired`, so the target embeds the acquisition rate
exactly as today).

1. `P = factory.getPool(meme, X, false)`; if zero, `factory.createPool(meme, X, false)`. Require
   `P.stable() == false`, `factory.isPool(P)`.
2. Require `P.totalSupply() == 0`, else revert `PoolAlreadyInitialized` (unreachable under I1; fail closed).
3. Read balances `bm = MEME.balanceOf(P)` (0 under I1, handled anyway) and `bx = X.balanceOf(P)`
   (synced plus unsynced donation). Do not call `skim` or `sync`: every unit in the pool becomes ours.
4. `Bx = bx + N`, `T = mulDiv(Bx, Mt, N)` (floor). If `T <= bm` revert `PoolAlreadyInitialized`
   (only reachable if I1 broke). Else `m = min(T - bm, Mmax)`.
5. Transfer `m` MEME and `N` X into `P`, then `P.mint(locker)` in the same call.
6. Post-checks: `P.totalSupply() == L + 1000`, `P.balanceOf(locker) >= L`, `L > 0`; reserves equal
   balances; pool price `Bx / (bm + m)`.

Maths. After the mint the pool holds `(bm + m, Bx)`. With no cap, `bm + m = floor(Bx*Mt/N)`, so price
`Bx/(bm+m) >= N/Mt`, above target by less than one MEME wei in the denominator (relative `1/Mt`,
`Mt ~ 1e26`). With `bx = 0` this is exactly `m = Mt`: identical to an unrepaired pool. The donation
`bx` is matched by `bx*Mt/N` extra MEME taken from the budget that would otherwise be burned, so the
price is exact and the extra supply is fully backed. If the cap binds (`bx > N*(Mmax - Mt)/Mt`), the
pool opens **above** the target, never below; arbitrage then moves the donation to holders who sell.
LP: `L = sqrt(m * a_x) - 1000` with `a_x = N + (unsynced part of bx)`. We own `L/(L+1000)` of a pool that
holds everything, so the only cost is the 1000 dead LP-wei every fresh pool pays. Order of magnitude:
`Mt ~ 1e26`, `N ~ 4e19` gives `L ~ 6e22`. Overflow: `Bx*Mt < 1e27*1e30`, use `Math.mulDiv`.

## 5. What each BNB adapter implements (C5 interface, provisional)

Assumed C5 shape (another author owns it): the campaign approves `Mmax` MEME and calls one function
with the X side (native as `msg.value`); the adapter returns the pool, LP, `memeUsed`, `pairedUsed`,
`donationFound`, `poolPriceWad`. Recommended: the adapter pulls `m` MEME with `transferFrom(campaign, P, m)`
straight into the pool (allowed pre-trading because `from == owner()`), so it never holds MEME and
refunds nothing.

- **`BnbNativeGraduationAdapter` (new).** Wraps `msg.value` with `WBNB.deposit`, runs section 4 with
  X = WBNB, LP to the locker. No router call. `pairedUsed == msg.value` always.
  `TopazRouterAdapter` stays unchanged: the factory constructor still needs its `poolFactory()`/`WETH()`
  (CLAUDE.md, "Two Topaz addresses").
- **`BnbQuoteGraduationAdapter` (new version).** Keep `:242-285` (factory lock, route policy, oracle,
  liquidity, impact, oracle-deviation) and the acquisition swap (`:291-298`). Delete `:257-259`. Replace
  `:300-317` with section 4 (X = QUOTE, `N = quoteAcquired`). The USD deviation check (`:322-325`)
  becomes one-sided on the post-mint pool price. Read reserves as `uint256` (`:18` declares `uint112`;
  Topaz returns `uint256`, and the ABI decoder reverts on a value above 2^112).
- Both: `nonReentrant`, only `factory.isCampaign(msg.sender)`, deadline, no admin path over funds, no
  balance kept between calls.

Campaign-side consequences (Claude): the DEX price check must use `poolPriceWad` and be one-sided;
`BnbQuoteLaunchCampaign.sol:148-152` equality checks become `memeUsed in [Mt, Mmax]`; the crossing buy
must not revert when graduation fails (C7.2 rule).

## 6. Audit block

- **Reentrancy.** Adapter `nonReentrant`; `Pool.mint/skim/sync/swap` are `nonReentrant`. The only
  external calls between reading balances and `mint` are MEME (ours, no hooks), WBNB (WETH9, no hooks)
  and the QUOTE token. QUOTE routes must be plain ERC20: no hooks, no fee-on-transfer, no rebasing; the
  adapter checks the pool's QUOTE balance rose by exactly `N` before `mint`.
- **CEI.** No adapter storage changes per graduation. Campaign: state (`launched`, amounts) before the
  adapter call, creator pull-payment after.
- **Reachable states.** Pool absent; present with `(0,0)`; with unsynced X; with synced X; paused factory
  (mint still works; quote acquisition swap reverts and PENDING retries); `totalSupply > 0` or
  `bm > 0` unreachable under I1, fail closed.
- **Over/underflow.** `mulDiv` everywhere; the `- bm` step is guarded; checked arithmetic elsewhere.
- **Griefing.** Pre-made pool: absorbed. Donation (synced or not): becomes our locked LP. Front-run
  `skim` of unsynced X: only reduces the donation. Swaps before our mint: impossible (Pool 357). Our mint
  is one call: no sandwich. The quote path's acquisition swap stays sandwichable: `minimumQuoteOut`
  (`:273-274`) is derived from a spot quote the attacker can move first, so the real bound is
  `maxOracleDeviationBps` (`:284-285`), not `maxSwapSlippageBps`. Keep the oracle bound tight.
- **Residual third-party powers (Topaz Safe).** `setCustomFee` on a pre-made pool before graduation
  makes `registerGraduatedPool` revert `InvalidTradingFee` (freeze); after graduation it changes the
  pool's fee (E6 then no longer holds). `setPauseState` halts post-graduation trading. Neither is
  reachable by a griefer.

## 7. Invariants

1. Graduation succeeds in every pool state reachable under I1.
2. Pool price after mint `>= curve target`, equal to it within 1 wei MEME when no donation or no cap.
3. `pairedUsed == N`; `Mt <= memeUsed <= Mmax`; nothing stays in the adapter.
4. The locker holds `L = totalSupply - 1000`; registration succeeds when `getFee == 30`.
5. MEME supply never exceeds the cap: repair uses only tokens the campaign would otherwise burn.

## 8. BSC mainnet-fork test plan (`BNB_FORK=1`, real Topaz)

Mine one block first (CLAUDE.md, fork proofs). Real factory `0x65E6cD0e…`, WBNB, a real QUOTE route
(USDT or BTCB WBNB pool). Each case runs a full campaign to the target, then asserts invariants 1-5,
the locker registration, a post-graduation buy and sell through the Topaz router, and a harvest split
80/20.

1. No pool (baseline). Amounts equal today's.
2. Griefer `createPool` only, native and quote.
3. `createPool` + WBNB (or QUOTE) donation, no sync.
4. `createPool` + donation + `sync` (reserves `(0,X)`): today's code reverts; the new adapter succeeds.
5. Donation large enough to hit the `Mmax` cap: price above target, never below.
6. Front-run `skim` between donation and graduation.
7. Griefer attempts to get MEME into the pool: `transfer`, `approve`+`transferFrom`, router
   `addLiquidity`, a buy from a contract: all revert `TradingNotEnabled` or leave `bm == 0`.
8. Factory paused (impersonate the Topaz Safe): native succeeds; quote stays PENDING, succeeds after
   unpause.
9. `setCustomFee(pool, 25)` before graduation (impersonated Safe): documents the freeze (open question 1).
10. The crossing buy lands when graduation cannot (with the campaign change).
11. Gas for create+mint vs today's router path.

## 9. Deploy script changes (BNB)

- `scripts/deploy-evm-treasury-router-v3.ts`: deploy the C1 router (creator 560 bps) and the C6 creator
  vault instead of V3; the rest is unchanged (other author).
- `scripts/deploy-bnb-quote-generation.ts`: deploy `BnbNativeGraduationAdapter` and the new
  `BnbQuoteGraduationAdapter` after the factory (both need its locker, `:500-511`), `setCampaignFactoryOnce`
  on both, wire both into the factory (setter name from C5), read every immutable back. Before any
  deploy, read on chain and refuse on mismatch: `volatileFee == 30`, factory `implementation`, WBNB,
  `assertTopazRoutersFit` (`:329`). Record both in the deployment JSON and
  `config/verification/mainnet-contracts.json`. The rehearsal spec must run this script, not a copy.

## 10. Open questions

1. Topaz's fee manager can set a custom fee on a pre-made pool and freeze registration
   (`PermanentLpLocker.sol:149-151`). Accept any fee at registration and record it, or keep 30 and accept
   that dependency on the Topaz Safe? (Locker is Claude's.)
2. C5 author: pull (`transferFrom` into the pool) or push (campaign transfers first, adapter refunds)?

## 11. As built: review of PR #479, Low findings closed (2026-09-30, branch `claude/review-479`)

`BnbQuoteGraduationAdapter` deployed bytecode 13,361 bytes (limit 24,576).

- **L3 (contract). `configureQuoteRoute` checks route liquidity when a route goes live**
  (`contracts/integrations/BnbQuoteGraduationAdapter.sol:287-294`). When `route.enabled` and the stored
  route is not enabled (first set, or re-enable after a disable), it reads both feeds
  (`_oraclePriceWad`, same staleness/health rules as `graduate`) and runs `_requireRouteLiquidity`
  against the new floor, reverting `RouteLiquidityTooLow`. Before this, a route whose pool sat below its
  own floor could be enabled; creators could bind to it and every such coin failed graduation on quote
  and waited 7 days for the native fallback.
  - Reentrancy: views only (`getReserves`, `token0/1`, `decimals`, `latestRoundData`); no value moves;
    `onlyAdmin`. CEI: the check runs before the single storage write and the event.
  - Reachable states: disabled first set is not checked (it binds nothing); enabled-to-enabled
    tightening is not checked, so the admin can always raise the floor on a live route, and `graduate`
    re-checks the floor on every call. Enabling with a stale or unhealthy feed reverts.
  - Over/underflow: `mulDiv`; quote decimals capped at 36 as in `graduate`.
  - Griefing: pool depth is read at configure time, so a donor can inflate reserves to get a route
    enabled only by the admin's own call, and `graduate` re-checks depth then. A griefer who drains the
    pool can delay a (re-)enable, never block a live route's graduation beyond what `graduate` already
    refuses.
  - Tests: `test/evmgen-bnb-adapters.unit.spec.ts:622` (thin first set refused, disabled set allowed,
    re-enable refused until deep, exact floor accepted, live-route tightening allowed), `:657` (stale
    feed refused); fork `test/review479-real-usdt-pool.fork.spec.ts:99` (real Topaz USDT/WBNB pool,
    ~$1.2k: refused at the $50k floor; the same route accepted after deepening the pool to ~$200k).
  - `scripts/configure-bnb-quote-routes.ts` keeps its off-chain pre-check (WBNB balance x2); the
    contract's synced-reserve check is now the authority. Its spec fixture
    (`test/BnbQuoteRoutesConfigure.spec.ts`) seeded only WBNB and never synced, so it now seeds the
    quote side at the feed price and syncs.
- **L1 (test).** `test/audit3-quote-acquisition.fork.spec.ts:205` grid now runs 10-90 bps moves, so
  sandwiches are actually accepted and measured (15 accepted rows on the 2026-09-30 block, both sigma 0
  and 90). Asserts: every accepted row loses the attacker money; worst pool shortfall vs the honest run
  is under the 100 bps `maxOracleDeviationBps` bound (measured 77 bps at sigma 90 / 80 bps move);
  every 100-500 bps row is refused. The sigma-90 rows had never executed (the attacker was not funded
  for 9x the pool and the catch counted the setup failure as a refusal); the attacker is now funded and
  a failed attacker step fails the test (`:269`).
- **L2 (test).** `test/audit5-quote-adapter-admin.spec.ts:136` restores the original exploit sequence:
  feed swap reverts `RouteFeedImmutable`, the 100x front-run is applied, and the permissionless
  graduate between the swaps is refused `OracleDeviationTooHigh` with the pool reserves and the
  campaign's native unchanged.
- **L4 (test).** `test/evmgen-bnb-adapters.unit.spec.ts:667`: a 6-decimal quote graduates with
  `pairedUsed` exactly the AMM output and above the 6-decimal `minimumQuoteOut`; with the quote feed at
  $0.995 and 10 bps slippage, the oracle minimum (~80.08e6) sits above the pool output (~79.68e6) and the
  swap refuses.
- **L5 (config).** `config/verification/mainnet-contracts.json`: the existing entry stays for the
  deployed adapter `0xfdF80819…` (old 4-argument constructor, noted); a placeholder entry for the new
  generation's adapter lists the 5-argument constructor (Safe, Topaz router, locker, BNB/USD feed, 3600).
