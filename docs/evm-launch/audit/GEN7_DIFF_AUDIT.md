# Gen-7 internal audit: diff against gen-6

Status: internal review of step 2 (2026-10-08). Not an external audit. Plan: `docs/evm-launch/EVM_GEN7_V2_PLAN.md`.

## Scope

New files only; every gen-6 contract is byte-for-byte unchanged (`git status contracts` shows nothing outside
`contracts/gen7/`), so the live gen-6 bytecode and its audit stay valid.

| Gen-7 file | Gen-6 base | Diff |
|---|---|---|
| `contracts/gen7/LaunchCampaignGen7.sol` | `LaunchCampaign.sol` | +78 / -104 |
| `contracts/gen7/LaunchFactoryGen7.sol` | `LaunchFactory.sol` | +101 / -132 (before the C8 floor below) |
| `contracts/gen7/BnbBasicLaunchFactoryGen7.sol` | `BnbBasicLaunchFactory.sol` | rename + generation 7/6 |
| `contracts/gen7/BnbQuoteLaunchCampaignGen7.sol` | `BnbQuoteLaunchCampaign.sol` | rename + comment |
| `contracts/gen7/RobinhoodStockLaunchCampaignGen7.sol` | `RobinhoodStockLaunchCampaign.sol` | rename |

File-level interfaces are imported from the gen-6 files (identical ABI), not redeclared. Compiler profile is the
audited one: solc 0.8.24, viaIR, optimizer runs 1. Sizes (deployed bytecode, limit 24,576): campaign 20,821,
factory 22,460, BNB factory 23,883, BNB quote campaign 21,182, RH stock campaign 20,910.

Reused unchanged (no bytecode change): `TreasuryRouterV4`, `ProtocolRevenueForwarder`, `CreatorRewardsVaultV2`,
`CreatorRegistry`, `RiskRegistry`, `GraduationOracle`, lockers, all graduation adapters, `LaunchToken(Deployer)`.

## Campaign hunks

### C1 virtual reserves replace base / slope
`InitParams.basePrice/priceSlope` -> `virtualNative/virtualToken`; storage likewise. Init checks:
`virtualNative != 0`; `virtualToken > curveSupply` (so `virtualToken - s > 0` for every reachable `s`);
`70% of supply < curveSupply` (so the first buy can never sell out the curve).
- Reachable only from `initialize*`, which is `_initialized`-guarded as gen-6.

### C2 curve maths
`Y(s) = mulDiv(vN, vT, vT - s, Ceil)`; buy `Y(s+a) - Y(s)`; sell `Y(s) - Y(s-a)`; price `mulDiv(Y(s), 1e18, vT - s)`.
- **Domain:** every caller bounds `s` before the call: `buyExactTokens` / `quoteBuyExactTokens` revert `SoldOut` when
  `sold + a > curveSupply`; `quoteBuyExactBnb` searches `[0, curveSupply - sold]`; `creatorFirstBuy` requires
  `tokens <= curveSupply` at `sold == 0`; sells revert `ExceedsSold` when `a > sold`. With `curveSupply < vT` the
  divisor is never zero.
- **Overflow:** `mulDiv` uses a 512-bit intermediate; the factory bounds `vN <= 1e30` and `vT ~ 1.007e27`, so
  `Y <= vN * vT / (vT - curveSupply) = 6.4 * vN < 2^256`. Price: `Y * 1e18 / (vT - s)` likewise. Checked 0.8 maths elsewhere.
- **Rounding / value leaks:** every trade moves the raise by an exact difference of the one function `Y`, so a
  sequence of trades ending at the same `sold` leaves `netRaisedWei` identical (`netRaisedWei == Y(sold) - Y(0)`
  always; tested after a mixed sequence and on buy-then-sell round trips of 1 wei .. 10M tokens). No trader can gain
  from rounding; gen-6's `Insolvent` guard (`gross > netRaisedWei`) can no longer trigger but is kept.
- **Monotonic:** `Y` strictly increases in `s`; price never falls (tested).
- **Donations:** accounting only (`netRaisedWei`), never `balanceOf`; unchanged from gen-6.

### C3 graduation trigger
`_checkGraduationDue` enters Pending only when `sold == curveSupply`; the oracle read on buys is gone.
- **Effects only, no external call** (was: one oracle `try`). Reentrancy surface reduced.
- **Reachable:** only by the buy that sells the last curve token (exact-tokens buy, or a native buy capped at the
  remainder) and by `graduate()` / `repairPool()` / the paused path, which call it under `nonReentrant`.
- **Removed risk:** no oracle staleness or manipulation can stall or force graduation.
- **Liveness:** a coin whose last tokens are never bought stays in Trading (same as pump.fun / Meteora); that is the design.
- `pendingTrigger` is always 1 and `graduationOvershoot` always 0 (fields kept for indexer compatibility).

### C4 split 2 / 0 / 98
Constants only: `GRAD_PROTOCOL_BPS 200`, `GRAD_CREATOR_BPS 0`. The graduation code is unchanged: effects
(`launched`, pull balances) before the `routeFinalize` `try` (escrow + permissionless flush on refusal), then the
adapter call under `nonReentrant`, then burn / reserve transfer. `pendingCreatorGraduation` now only collects adapter
native refunds; `claimCreatorGraduation` is kept for those and for quote residuals.

### C5 first buy 70%, no cost cap
`CREATOR_FIRST_BUY_MAX_SUPPLY_BPS 7000`; the `FirstBuyTooExpensive` check and its oracle read are removed. Still
factory-only, once (`totalBuyVolumeWei == 0`), flat base fee, exact `msg.value`, unlocked, inside the create tx with the
factory's slippage cap and refund (unchanged). Cannot graduate the coin (init check above).
- Business risk, not a code flaw: a creator can hold up to 70% (founder decision 2026-10-08, anti-rug cap dropped).

### C6 launch fee 90%
`ANTI_SNIPER_START_BPS 9000`; formula unchanged (`base + (start - base) * left / 60`), non-increasing in time, floors
toward the base. Init still requires `protocolFeeBps <= start`; the factory caps the base at 75-1000 bps.

### C7 no creator buy cap
No campaign change: the factory passes `creatorBuyCapWei = 0`, which gen-6 already treats as "no cap". Escrow
(20% at 30 days, then 20% every 7 days) unchanged.

## Factory hunks

### C8 curve sizing at create
`_curveForTarget`: `oracle.nativeTargetForUsd(target)` (view, `try`; any revert -> `OraclePriceUnavailable`, create
fails closed; staleness is enforced by `GraduationOracle`) -> `curveForMarketCap(mc, supply, 8500, 1300)`:
`r = Q / ((1 - f) C)` with `Q` = 99.99% of the pool allocation, `vT = C / (1 - r)`, `vN = r^2 * (mc / supply) * vT`.
- **Correctness:** the sold-out price equals `mc / supply` and the pool takes `0.98 R / P = Q` tokens (proved in the
  NatSpec, tested against an independent BigInt implementation at 7 price / target pairs including DOGE $0.03-$1).
- **Pool margin (`POOL_MARGIN_BPS = 1`):** gen-6 reverts graduation (`SupplyBound`) if the pool needs more than its
  budget; rounding in `vT` (floor), `Y` (ceil) and `P` (floor) is many orders below 0.01%, so `memeTarget <= budget`
  always; the ~0.01% left (13k tokens) is burned at graduation, which also keeps the native price band's upper bound active.
- **Bounds:** `vN` in `(0, 1e30]` and **`mc >= MIN_MARKET_CAP_NATIVE` (1e15 wei)**, added during this review:
  without a floor a broken feed could produce a sold-out price that rounds to 0 wei per token, making
  `mulDiv(poolNative, 1e18, price)` revert forever and stranding the coin in Pending. At the floor the price is >= 1e6
  wei per token (rounding <= 1e-6, inside the margin). Real targets are >= 150,000x the floor.
- **Overflow:** `supply * bps <= 1e31`; `rn, rd <= ~1e31`; nested `mulDiv`s with 512-bit intermediates.
- Targets: `$30K` / `$50K` everywhere, `$150` on 97 / 46630 / 6281971, any on 31337 (as gen-6's test rule).
- `_validateConfig` now checks `r < 1` via `curveForMarketCap(MIN_MARKET_CAP_NATIVE, ...)` and, since F5, refuses a
  curve of 70% or less with the campaign's own integer comparison (`supply * 7000 / 1e4 >= supply * curveBps / 1e4`
  -> `InvalidCurveBps`); `setConfig` stays `whenMutable`. Because `r >= 1` needs a curve of ~50.5% or less, F5 shadows
  that branch from `setConfig`; `SupplyBoundBroken` stays reachable there through an empty pool (`liquidityTokenBps` 0).

### Other factory changes
Default config 8500 / 1300, default target `$50K`, generation 7/6, `creatorBuyCapWei: 0` (eligibility checks kept).
Removed: base/slope config, `_curveArea`, `_requireTargetInRange`, `MAX_BASE_PRICE`, `MAX_PRICE_SLOPE`,
`MAX_TARGET_OF_CURVE_BPS`. Everything else (pauses, route authority, registries, fee-choice wiring, locker binding,
quote / stock create paths) is gen-6 text.

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | Medium | No lower bound on the target market cap: a broken oracle could strand a coin in Pending (division by a zero price at graduation) | Fixed: `MIN_MARKET_CAP_NATIVE` |
| F2 | Info | `pendingTrigger` / `graduationOvershoot` are now constant | Kept for indexer compatibility; documented |
| F3 | Info | `Insolvent` check is unreachable on gen-7 (path-independent curve) | Kept as defence in depth |
| F4 | Business | Creator may hold up to 70% of supply | Founder decision 2026-10-08 |
| F5 | Low | `setConfig` accepted a curve of 70% or less, which every create then refuses in the campaign's init (`InvalidCurveBps`). Owner-only and fails closed, but a misconfigured factory would brick creates until `setConfig` again (only while no coin exists) | Fixed: `_validateConfig` mirrors the init check (`FIRST_BUY_MAX_SUPPLY_BPS`); tested at 7000 (refused) and 7001 (accepted) |

## Tests

- New: `test/evmgen7-core.spec.ts` (23 passing): config, targets, oracle sizing across BNB / ETH / DOGE prices,
  `curveForMarketCap` reference and bounds, oracle failure, `setConfig` bound, exact buy/sell maths, round trips,
  monotonic price, native buy maximality, 70% first buy and refusal, 90% launch fee, uncapped escrowed creator buys,
  graduation at $30K / $50K (2% routed, 0% creator, pool 99.99% of 13%, burn, reserve), 70% + 15% graduation, router
  refusal escrow + flush.
- Port of every gen-6 core suite to gen-7 (`test/evmgen7-core-{antisniper, audit-fixes, escrow, firstbuy, graduation,
  lifecycle, quote, quote-fallback, repair}.spec.ts`): 88 passing. No gen-6 test dropped. Six that tested removed
  gen-6 behaviour are marked `REPLACED` and test the gen-7 rule instead:
  - firstbuy: cost cap -> no cost cap at a $20,000 native price, oracle failure fails create closed;
  - firstbuy: tier cap on later creator buys -> escrowed, uncapped, also above the tier cap;
  - graduation: oracle trigger -> not due until sold out, a dead oracle cannot stop the sold-out buy;
  - graduation: linear-curve supply bound -> `setConfig` 8500/1300 accepted, unfit pools and sub-floor market caps refused;
  - graduation fuzz: every factory-sized curve graduates inside its 13% pool and burns only the ~0.01% margin;
  - repair: not due one token short of sold out; a dead oracle blocks neither Pending nor a native step.
- Gen-7 total: 111 passing, 0 failing.
- Gen-6 regression (`evmgen-core-*`, `evmgen-fees-*`, `LaunchFactory*`, `evmgen-hardening-*`, non-fork): 202 passing.
- Still to do in later steps: BNB / RH fork specs on gen-7, testnet lifecycle, mainnet-fork rehearsal, external audit.
