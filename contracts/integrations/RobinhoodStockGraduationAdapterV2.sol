// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {RobinhoodV3PoolRepair, RobinhoodV3PriceMath, IRhV3Factory} from "./RobinhoodV3PoolRepair.sol";

interface IRhStockWETH9 {
    function deposit() external payable;
}

/// @dev SwapRouter02 (0xCaf681a6... on 4663). It has no quote function; only exactInputSingle is used.
interface IRhSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IRhAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @notice Robinhood Stock Token graduation (MEME/STOCK, Uniswap V3 0.30%, full range, locked).
/// Implements IGraduationAdapterV2 with `quoteToken` = the configured Stock Token.
/// Spec: C7-robinhood-adapters.md sections 1-3, C5-graduation.md sections 7 and 10.
///
/// Replaces RobinhoodStockTokenGraduationAdapter, whose `quoteExactInputSingle` did not exist on
/// SwapRouter02 (every stock graduation reverted), whose minima were an in-transaction quote (unsound:
/// it reads the pool a front-runner just moved), and which reverted on any V3 rounding residual.
///
/// `graduate`:
/// 1. oracles: ETH/USD and the stock feed, each at most `maxOracleAgeSeconds` old (90,000 s on 4663);
/// 2. acquisition: exactInputSingle WETH->STOCK on the route's canonical pool with
///    `amountOutMinimum = oracleOut * (1 - maxSwapSlippageBps)`, oracleOut = native * ETHUSD / STOCKUSD;
///    the acquired amount is measured by balance delta;
/// 3. MEME/STOCK target P_Q = stockAcquired / memeTarget; repair and mint exactly as the native adapter;
/// 4. USD continuity: the pool's start price (STOCK per MEME x STOCKUSD) must be >= curve USD price
///    (curvePriceWad x ETHUSD) * (1 - 2%), and <= * (1 + 2%) unless the budget was exhausted by a repair
///    (E11: 200 bps; on a 4663 fork SPY landed 63-69 bps below Chainlink, so 100 bps was too tight);
/// 5. unused MEME and STOCK go back to the campaign. Nothing reverts on V3 rounding dust.
///
/// AUDIT (money path `graduate`), in addition to RobinhoodV3PoolRepair's block:
/// - Guard `nonReentrant`. External calls: WETH.deposit, SwapRouter02.exactInputSingle (approval set to
///   exactly msg.value and reset to 0), STOCK transfers (route-configured; a pausing/blocklisting STOCK
///   can only revert the whole call, leaving the campaign in Pending, retryable), the pool, NPM, locker.
/// - Sandwich bound on the acquisition: the adapter receives >= oracleOut*(1 - slippage), slippage is
///   capped at 100 bps at route configuration; the continuity band then bounds the pool start price.
/// - Admin (audits 2/5): `admin` is a constructor argument (the Safe on 4663), and a stock's feed and
///   acquisition pool are fixed at its first configuration; later calls may only tighten or disable.
/// - E11: the acquisition pool's fee tier is at most 3000 (0.30%), refused at configuration
///   (`InvalidFeeTier`) and re-checked at graduation; a 1% pool's own fee alone would eat half the band.
/// - `maxOracleDeviationBps` / `maxPriceImpactBps` are reserved route fields (kept only so the factory's
///   8-field tuple read is unchanged). They must be 0 at configuration (`InvalidPolicy`), so no stored
///   limit exists that the adapter does not enforce. The enforced bounds are `maxSwapSlippageBps` (oracle
///   minimum on the acquisition) and the fixed 200 bps USD band.
/// - Stale feed (weekends exceed 90,000 s on stock feeds): OracleStale, campaign stays in Pending.
/// - Conservation: WETH, STOCK and MEME balances of the adapter are asserted equal to the entry snapshot.
/// - Rebasing / fee-on-transfer stocks are excluded at route configuration (a transfer-in delta check
///   also refuses them at graduation).
contract RobinhoodStockGraduationAdapterV2 is RobinhoodV3PoolRepair {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    /// @notice C5 quote band: the MEME/STOCK start price in USD vs the curve price in USD.
    uint256 public constant QUOTE_PRICE_BAND_BPS = 200;
    /// @notice E11: highest acquisition pool fee tier a route may use (Uniswap V3 0.30%).
    uint24 public constant MAX_ACQUISITION_FEE_TIER = 3000;
    /// @notice Upper bound for a route's acquisition slippage (audit 2: 300 -> 100; the acquisition pool is
    /// <= 0.30% and the start price must land within 200 bps of the curve in USD anyway).
    uint16 public constant MAX_SWAP_SLIPPAGE_BPS = 100;
    /// @notice `repairStep` stops this far above the oracle-estimated target, so a chunk never sells MEME
    /// below the real (acquisition-derived) target, and an ETH/STOCK ratio move between a step and
    /// `graduate` of up to ~20% (target up 25%) still leaves the fresh target below the step's stop, where
    /// `graduate` only sells down. Audit 2: at 5% a ~10% move froze graduation. At spacing 60, 25% is at
    /// most 38 initialized ticks for `graduate` to cross.
    uint256 public constant REPAIR_STEP_MARGIN_BPS = 2500;

    struct StockRoute {
        address oracleFeed; // Chainlink STOCK/USD
        address acquisitionPool; // canonical V3 (WETH, STOCK, acquisitionFeeTier) pool
        uint24 acquisitionFeeTier;
        uint256 minimumRouteLiquidityUsdWad; // STOCK held by the acquisition pool, in USD, depth sanity check
        uint16 maxSwapSlippageBps; // vs the oracle-derived output, <= MAX_SWAP_SLIPPAGE_BPS
        // Reserved: the next two only keep the 8-field route layout LaunchFactory reads at create
        // (IRobinhoodStockGraduationRouteRegistry.stockRoutes). Nothing enforces them (C7.1 deleted the
        // in-transaction impact probe; the start price is bounded by the fixed 200 bps band), so
        // configureStockRoute requires both to be 0: a stored limit that does nothing cannot exist.
        uint16 maxOracleDeviationBps;
        uint16 maxPriceImpactBps;
        bool enabled;
    }

    address public immutable swapRouter;
    address public immutable nativeUsdOracle;
    uint32 public immutable maxOracleAgeSeconds;

    mapping(address => StockRoute) public stockRoutes;

    event StockRouteConfigured(
        address indexed stockToken,
        address indexed oracleFeed,
        address indexed acquisitionPool,
        uint24 acquisitionFeeTier,
        uint256 minimumRouteLiquidityUsdWad,
        uint16 maxSwapSlippageBps,
        uint16 maxOracleDeviationBps,
        uint16 maxPriceImpactBps,
        bool enabled
    );
    event StockAcquired(
        address indexed campaign,
        address indexed stockToken,
        uint256 nativeIn,
        uint256 stockOut,
        uint256 oracleStockOut,
        uint256 minimumStockOut,
        uint256 nativeUsdWad,
        uint256 stockUsdWad
    );

    error RouteDisabled();
    error InvalidPolicy();
    error AcquisitionPoolMismatch();
    error OracleUnhealthy();
    error OracleStale();
    error RouteLiquidityTooLow();
    error AcquisitionFailed();
    error PriceContinuityFailed();
    /// @notice A configured route's feed, pool or fee tier cannot change, and its limits can only tighten.
    error RouteFixed();

    constructor(
        address v3Factory_,
        address positionManager_,
        address swapRouter_,
        address weth_,
        address nativeUsdOracle_,
        uint32 maxOracleAgeSeconds_,
        address admin_
    ) RobinhoodV3PoolRepair(v3Factory_, positionManager_, weth_, admin_) {
        if (swapRouter_ == address(0) || nativeUsdOracle_ == address(0)) revert ZeroAddress();
        if (swapRouter_.code.length == 0 || nativeUsdOracle_.code.length == 0) revert ContractCodeMissing();
        if (maxOracleAgeSeconds_ == 0) revert InvalidPolicy();
        swapRouter = swapRouter_;
        nativeUsdOracle = nativeUsdOracle_;
        maxOracleAgeSeconds = maxOracleAgeSeconds_;
    }

    /// @notice Configure or disable a Stock Token route. Enabling reads both feeds, so a feed that is
    /// already stale refuses the route rather than being discovered at graduation.
    /// Audits 2/5: the first configuration of a stock fixes its feed, acquisition pool and fee tier for
    /// the life of this adapter. Every later call must repeat them exactly and may only tighten the
    /// limits (raise `minimumRouteLiquidityUsdWad`, lower `maxSwapSlippageBps`) or flip `enabled`
    /// (`RouteFixed` otherwise). So no key can re-point a Pending coin's acquisition at a feed or pool
    /// it controls, or loosen its minimum; disabling (or re-enabling what was fixed) is all that is left.
    function configureStockRoute(address stockToken, StockRoute calldata route) external onlyAdmin {
        if (stockToken == address(0) || route.oracleFeed == address(0) || route.acquisitionPool == address(0)) revert ZeroAddress();
        if (stockToken == WETH) revert InvalidPair();
        if (stockToken.code.length == 0 || route.oracleFeed.code.length == 0 || route.acquisitionPool.code.length == 0) {
            revert ContractCodeMissing();
        }
        if (
            route.acquisitionFeeTier == 0 || route.acquisitionFeeTier > MAX_ACQUISITION_FEE_TIER
                || IRhV3Factory(v3Factory).feeAmountTickSpacing(route.acquisitionFeeTier) <= 0
        ) {
            revert InvalidFeeTier();
        }
        if (
            route.maxSwapSlippageBps > MAX_SWAP_SLIPPAGE_BPS || route.maxOracleDeviationBps != 0 || route.maxPriceImpactBps != 0
                || route.minimumRouteLiquidityUsdWad == 0
        ) revert InvalidPolicy();
        if (IERC20Metadata(stockToken).decimals() > 36) revert InvalidPolicy();
        address canonical = IRhV3Factory(v3Factory).getPool(WETH, stockToken, route.acquisitionFeeTier);
        if (canonical == address(0) || canonical != route.acquisitionPool) revert AcquisitionPoolMismatch();
        StockRoute storage current = stockRoutes[stockToken];
        if (current.oracleFeed != address(0)) {
            if (
                route.oracleFeed != current.oracleFeed || route.acquisitionPool != current.acquisitionPool
                    || route.acquisitionFeeTier != current.acquisitionFeeTier
                    || route.minimumRouteLiquidityUsdWad < current.minimumRouteLiquidityUsdWad
                    || route.maxSwapSlippageBps > current.maxSwapSlippageBps
            ) revert RouteFixed();
        }
        if (route.enabled) {
            _oraclePriceWad(nativeUsdOracle);
            _oraclePriceWad(route.oracleFeed);
        }
        stockRoutes[stockToken] = route;
        emit StockRouteConfigured(
            stockToken,
            route.oracleFeed,
            route.acquisitionPool,
            route.acquisitionFeeTier,
            route.minimumRouteLiquidityUsdWad,
            route.maxSwapSlippageBps,
            route.maxOracleDeviationBps,
            route.maxPriceImpactBps,
            route.enabled
        );
    }

    /// @notice IGraduationAdapterV2.graduate for a MEME/STOCK pool. `r.quoteToken` is the Stock Token.
    /// `r.nativeUsdWad` is informational; the adapter reads ETH/USD itself (C5 section 7: minima are
    /// derived by the adapter). Earlier `repairStep` proceeds (STOCK, recorded in `repairLedger`) are
    /// pulled back from the campaign, which must approve exactly that amount of STOCK.
    function graduate(Request calldata r) external payable override nonReentrant returns (Result memory res) {
        _checkCaller(r);
        address stock = _pairedToken(r);
        if (msg.value == 0) revert InvalidRequest();

        uint256[3] memory before = [
            IERC20(WETH).balanceOf(address(this)),
            IERC20(stock).balanceOf(address(this)),
            IERC20(r.token).balanceOf(address(this))
        ];

        RepairLedger memory ledger = repairLedger[msg.sender];
        uint256 stepProceeds = ledger.proceeds;
        bool steppedBefore = ledger.memeSold != 0 || stepProceeds != 0;
        delete repairLedger[msg.sender];

        (uint256 nativeUsdWad, uint256 stockUsdWad, uint256 stockUnit) = _prices(stock);
        uint256 acquired = _acquire(stock, nativeUsdWad, stockUsdWad, stockUnit);
        if (stepProceeds != 0) {
            IERC20(stock).safeTransferFrom(msg.sender, address(this), stepProceeds);
            if (IERC20(stock).balanceOf(address(this)) != before[1] + acquired + stepProceeds) revert AcquisitionFailed();
        }

        uint256 targetWad = Math.mulDiv(acquired, WAD, r.memeTarget);
        bool memeIs0 = r.token < stock;
        uint160 sqrtTarget = RobinhoodV3PriceMath.sqrtFromPrice(targetWad, memeIs0);
        if (ledger.memeSold != 0 && _aboveStepStop(sqrtTarget, ledger.sqrtReached, memeIs0)) {
            sqrtTarget = ledger.sqrtReached;
            targetWad = RobinhoodV3PriceMath.priceFromSqrt(sqrtTarget, memeIs0);
        }
        Execution memory x = Execution({
            meme: r.token,
            paired: stock,
            memeIs0: memeIs0,
            sqrtTarget: sqrtTarget,
            targetPriceWad: targetWad,
            memeAvailable: r.memeMax,
            pairedIn: acquired + stepProceeds,
            spare: r.memeMax - r.memeTarget,
            deadline: r.deadline
        });
        uint256 memeReturned;
        (res, memeReturned,) = _graduateInto(x);
        if (steppedBefore) res.repaired = true;

        _checkContinuity(res.startPriceWad, r.curvePriceWad, nativeUsdWad, stockUsdWad, stockUnit, memeReturned != 0);

        if (
            IERC20(WETH).balanceOf(address(this)) != before[0] || IERC20(stock).balanceOf(address(this)) != before[1]
                || IERC20(r.token).balanceOf(address(this)) != before[2]
        ) revert ConservationBroken();
    }

    /// @notice Minimum STOCK out for `nativeIn` from the oracles alone (what `graduate` enforces).
    function oracleMinimumStockOut(address stockToken, uint256 nativeIn)
        external
        view
        returns (uint256 oracleOut, uint256 minimumOut)
    {
        StockRoute memory route = stockRoutes[stockToken];
        if (!route.enabled) revert RouteDisabled();
        (uint256 nativeUsdWad, uint256 stockUsdWad, uint256 stockUnit) = _prices(stockToken);
        oracleOut = _oracleOut(nativeIn, nativeUsdWad, stockUsdWad, stockUnit);
        minimumOut = Math.mulDiv(oracleOut, BPS - route.maxSwapSlippageBps, BPS);
    }

    // ------------------------------------------------------------------ hooks

    function _pairedToken(Request calldata r) internal view override returns (address stock) {
        stock = r.quoteToken;
        if (stock == address(0) || stock == WETH || stock == r.token || r.token == WETH) revert InvalidPair();
        if (!stockRoutes[stock].enabled) revert RouteDisabled();
    }

    function _repairStepPriceWad(Request calldata r, address stock) internal view override returns (uint256) {
        (uint256 nativeUsdWad, uint256 stockUsdWad, uint256 stockUnit) = _prices(stock);
        // Estimated P_Q = P * ETHUSD / STOCKUSD in STOCK raw per 1e18 MEME, raised by the margin.
        uint256 estimate = Math.mulDiv(Math.mulDiv(r.curvePriceWad, nativeUsdWad, stockUsdWad), stockUnit, WAD);
        return Math.mulDiv(estimate, BPS + REPAIR_STEP_MARGIN_BPS, BPS);
    }

    function _sendPaired(address stock, address to, uint256 amount) internal override {
        IERC20(stock).safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ internals

    function _prices(address stock) private view returns (uint256 nativeUsdWad, uint256 stockUsdWad, uint256 stockUnit) {
        StockRoute memory route = stockRoutes[stock];
        nativeUsdWad = _oraclePriceWad(nativeUsdOracle);
        stockUsdWad = _oraclePriceWad(route.oracleFeed);
        stockUnit = 10 ** uint256(IERC20Metadata(stock).decimals());
    }

    function _acquire(address stock, uint256 nativeUsdWad, uint256 stockUsdWad, uint256 stockUnit)
        private
        returns (uint256 acquired)
    {
        StockRoute memory route = stockRoutes[stock];
        // E11 re-check at graduation (a route stored by any earlier code path cannot bypass it).
        if (route.acquisitionFeeTier > MAX_ACQUISITION_FEE_TIER) revert InvalidFeeTier();
        if (IRhV3Factory(v3Factory).getPool(WETH, stock, route.acquisitionFeeTier) != route.acquisitionPool) {
            revert AcquisitionPoolMismatch();
        }
        // Depth sanity check (not a price protection): the acquisition pool must hold enough STOCK.
        uint256 depthUsd = Math.mulDiv(IERC20(stock).balanceOf(route.acquisitionPool), stockUsdWad, stockUnit);
        if (depthUsd < route.minimumRouteLiquidityUsdWad) revert RouteLiquidityTooLow();

        uint256 oracleOut = _oracleOut(msg.value, nativeUsdWad, stockUsdWad, stockUnit);
        uint256 minimumOut = Math.mulDiv(oracleOut, BPS - route.maxSwapSlippageBps, BPS);
        if (minimumOut == 0) revert AcquisitionFailed();

        IRhStockWETH9(WETH).deposit{value: msg.value}();
        IERC20(WETH).forceApprove(swapRouter, msg.value);
        uint256 stockBefore = IERC20(stock).balanceOf(address(this));
        IRhSwapRouter02(swapRouter).exactInputSingle(
            IRhSwapRouter02.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: stock,
                fee: route.acquisitionFeeTier,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: minimumOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(WETH).forceApprove(swapRouter, 0);
        acquired = IERC20(stock).balanceOf(address(this)) - stockBefore;
        if (acquired < minimumOut) revert AcquisitionFailed();
        emit StockAcquired(msg.sender, stock, msg.value, acquired, oracleOut, minimumOut, nativeUsdWad, stockUsdWad);
    }

    /// @dev Audit 2. The MEME earlier `repairStep`s sold sits in the pool in ranges at or above the price
    /// the last step left it at (`sqrtReached`); nobody can take it out before graduation (LaunchToken
    /// refuses transfers from the pool). Moving the price back up through those ranges would need the
    /// repair to pay STOCK, which the callback refuses (RepairInvariantBroken): a fresh target above the
    /// step stop froze graduation. So when the fresh target is above `sqrtReached`, `sqrtReached` is the
    /// target: reaching it from wherever the pool is now crosses only ranges without MEME (free), the mint
    /// prices at it, and `_checkContinuity` still decides (a start more than 200 bps below the curve in
    /// USD reverts PriceContinuityFailed, retryable). The stored price, not the live one, so a third party
    /// moving the pool through empty ranges cannot lower the start price. A target at or below the stop
    /// is unchanged: `graduate` sells down to it as before.
    function _aboveStepStop(uint160 sqrtTarget, uint160 sqrtReached, bool memeIs0) private pure returns (bool) {
        if (sqrtReached == 0) return false;
        // MEME dearer at the target: token1/token0 higher when MEME is token0, lower when it is token1.
        return memeIs0 ? sqrtTarget > sqrtReached : sqrtTarget < sqrtReached;
    }

    function _checkContinuity(
        uint256 startPriceWad,
        uint256 curvePriceWad,
        uint256 nativeUsdWad,
        uint256 stockUsdWad,
        uint256 stockUnit,
        bool memeLeft
    ) private pure {
        // startPriceWad is STOCK raw per 1e18 MEME; x STOCKUSD / stockUnit = USD per whole MEME (wad).
        uint256 startUsd = Math.mulDiv(startPriceWad, stockUsdWad, stockUnit);
        uint256 curveUsd = Math.mulDiv(curvePriceWad, nativeUsdWad, WAD);
        if (startUsd * BPS < curveUsd * (BPS - QUOTE_PRICE_BAND_BPS)) revert PriceContinuityFailed();
        // Above the band is allowed only when a repair used up the whole budget (C5 section 1.9).
        if (memeLeft && startUsd * BPS > curveUsd * (BPS + QUOTE_PRICE_BAND_BPS)) revert PriceContinuityFailed();
    }

    function _oracleOut(uint256 nativeIn, uint256 nativeUsdWad, uint256 stockUsdWad, uint256 stockUnit)
        private
        pure
        returns (uint256)
    {
        return Math.mulDiv(Math.mulDiv(nativeIn, nativeUsdWad, stockUsdWad), stockUnit, WAD);
    }

    function _oraclePriceWad(address oracle) private view returns (uint256) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = IRhAggregatorV3(oracle).latestRoundData();
        if (roundId == 0 || answer <= 0 || updatedAt == 0 || answeredInRound < roundId) revert OracleUnhealthy();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxOracleAgeSeconds) revert OracleStale();
        uint8 decimals_ = IRhAggregatorV3(oracle).decimals();
        if (decimals_ > 36) revert OracleUnhealthy();
        uint256 unsignedAnswer = uint256(answer);
        if (decimals_ <= 18) return unsignedAnswer * 10 ** uint256(18 - decimals_);
        return unsignedAnswer / 10 ** uint256(decimals_ - 18);
    }
}
