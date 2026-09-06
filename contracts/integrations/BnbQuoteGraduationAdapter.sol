// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IBnbQuoteTopazFactory {
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool);
}

interface IBnbQuoteTopazPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

interface IBnbQuoteTopazRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function defaultFactory() external view returns (address);
    function weth() external view returns (address);
    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory amounts);
    function swapExactETHForTokens(
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
    function addLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

interface IBnbQuoteAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IBnbQuoteCampaignFactory {
    function isCampaign(address campaign) external view returns (bool);
}

/// @notice BNB graduation execution boundary for approved non-native quote assets.
/// @dev Bonding remains native BNB. This adapter only executes the graduation-sized
/// WBNB/native -> approved QUOTE acquisition and creates the final volatile MEME/QUOTE
/// Topaz pool with LP minted directly to the factory generation's permanent locker.
contract BnbQuoteGraduationAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    struct QuoteRoute {
        address oracleFeed;
        address acquisitionPool;
        uint256 minimumRouteLiquidityUsdWad;
        uint16 maxSwapSlippageBps;
        uint16 maxOracleDeviationBps;
        uint16 maxPriceImpactBps;
        uint16 maxGraduationPriceDeviationBps;
        bool enabled;
    }

    struct GraduationRequest {
        address campaignToken;
        address quoteToken;
        uint256 memeAmountDesired;
        uint256 finalCurvePriceNativeWad;
        uint256 deadline;
    }

    struct GraduationResult {
        address canonicalPool;
        uint256 lpAmount;
        uint256 nativeLiquidityUsed;
        uint256 quoteTokenAcquired;
        uint256 quoteTokenUsed;
        uint256 memeTokenUsed;
        uint256 finalCurveMemeUsdWad;
        uint256 initialDexMemeUsdWad;
        uint256 priceDeviationBps;
    }

    address public immutable admin;
    address public immutable topazRouter;
    address public immutable topazFactory;
    address public immutable WBNB;
    address public immutable permanentLpLocker;
    address public immutable nativeUsdOracle;
    uint32 public immutable maxOracleAgeSeconds;

    address public campaignFactory;
    bool public campaignFactoryLocked;
    mapping(address => QuoteRoute) public quoteRoutes;

    event CampaignFactoryLocked(address indexed campaignFactory);
    event QuoteRouteConfigured(
        address indexed quoteToken,
        address indexed oracleFeed,
        address indexed acquisitionPool,
        uint256 minimumRouteLiquidityUsdWad,
        uint16 maxSwapSlippageBps,
        uint16 maxOracleDeviationBps,
        uint16 maxPriceImpactBps,
        uint16 maxGraduationPriceDeviationBps,
        bool enabled
    );
    event QuoteGraduationExecuted(
        address indexed campaign,
        address indexed campaignToken,
        address indexed quoteToken,
        address canonicalPool,
        uint256 lpAmount,
        uint256 nativeLiquidityUsed,
        uint256 quoteTokenAcquired,
        uint256 memeTokenUsed,
        uint256 finalCurveMemeUsdWad,
        uint256 initialDexMemeUsdWad,
        uint256 priceDeviationBps
    );

    error OnlyAdmin();
    error ZeroAddress();
    error ContractCodeMissing();
    error FactoryAlreadyLocked();
    error CampaignFactoryMissing();
    error UnauthorizedCampaign();
    error RouteDisabled();
    error InvalidPolicy();
    error InvalidPair();
    error AcquisitionPoolMismatch();
    error FinalPoolAlreadyExists();
    error DeadlineExpired();
    error OracleUnhealthy();
    error OracleStale();
    error RouteLiquidityTooLow();
    error QuoteUnavailable();
    error PriceImpactTooHigh();
    error OracleDeviationTooHigh();
    error GraduationPriceDeviationTooHigh();
    error ZeroLiquidity();
    error LiquidityResidual();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    constructor(
        address topazRouter_,
        address permanentLpLocker_,
        address nativeUsdOracle_,
        uint32 maxOracleAgeSeconds_
    ) {
        if (topazRouter_ == address(0) || permanentLpLocker_ == address(0) || nativeUsdOracle_ == address(0)) {
            revert ZeroAddress();
        }
        if (topazRouter_.code.length == 0 || permanentLpLocker_.code.length == 0 || nativeUsdOracle_.code.length == 0) {
            revert ContractCodeMissing();
        }
        if (maxOracleAgeSeconds_ == 0) revert InvalidPolicy();

        address factory_ = IBnbQuoteTopazRouter(topazRouter_).defaultFactory();
        address wrapped_ = IBnbQuoteTopazRouter(topazRouter_).weth();
        if (factory_ == address(0) || wrapped_ == address(0)) revert ZeroAddress();
        if (factory_.code.length == 0 || wrapped_.code.length == 0) revert ContractCodeMissing();

        admin = msg.sender;
        topazRouter = topazRouter_;
        topazFactory = factory_;
        WBNB = wrapped_;
        permanentLpLocker = permanentLpLocker_;
        nativeUsdOracle = nativeUsdOracle_;
        maxOracleAgeSeconds = maxOracleAgeSeconds_;
    }

    function setCampaignFactoryOnce(address campaignFactory_) external onlyAdmin {
        if (campaignFactoryLocked) revert FactoryAlreadyLocked();
        if (campaignFactory_ == address(0)) revert ZeroAddress();
        if (campaignFactory_.code.length == 0) revert ContractCodeMissing();
        campaignFactory = campaignFactory_;
        campaignFactoryLocked = true;
        emit CampaignFactoryLocked(campaignFactory_);
    }

    function configureQuoteRoute(address quoteToken, QuoteRoute calldata route) external onlyAdmin {
        if (quoteToken == address(0) || route.oracleFeed == address(0) || route.acquisitionPool == address(0)) revert ZeroAddress();
        if (quoteToken == WBNB) revert InvalidPair();
        if (quoteToken.code.length == 0 || route.oracleFeed.code.length == 0 || route.acquisitionPool.code.length == 0) {
            revert ContractCodeMissing();
        }
        if (
            route.minimumRouteLiquidityUsdWad == 0 || route.maxSwapSlippageBps == 0 || route.maxSwapSlippageBps >= BPS ||
            route.maxOracleDeviationBps > BPS || route.maxPriceImpactBps > BPS ||
            route.maxGraduationPriceDeviationBps > BPS
        ) revert InvalidPolicy();

        address canonical = IBnbQuoteTopazFactory(topazFactory).getPool(WBNB, quoteToken, false);
        if (canonical == address(0) || canonical != route.acquisitionPool) revert AcquisitionPoolMismatch();
        if (IBnbQuoteTopazPool(canonical).stable()) revert InvalidPair();

        quoteRoutes[quoteToken] = route;
        emit QuoteRouteConfigured(
            quoteToken,
            route.oracleFeed,
            route.acquisitionPool,
            route.minimumRouteLiquidityUsdWad,
            route.maxSwapSlippageBps,
            route.maxOracleDeviationBps,
            route.maxPriceImpactBps,
            route.maxGraduationPriceDeviationBps,
            route.enabled
        );
    }

    function graduateQuoteLiquidity(GraduationRequest calldata request)
        external
        payable
        nonReentrant
        returns (GraduationResult memory result)
    {
        address factory_ = campaignFactory;
        if (!campaignFactoryLocked || factory_ == address(0)) revert CampaignFactoryMissing();
        if (!IBnbQuoteCampaignFactory(factory_).isCampaign(msg.sender)) revert UnauthorizedCampaign();
        if (block.timestamp > request.deadline) revert DeadlineExpired();
        if (request.campaignToken == address(0) || request.quoteToken == address(0)) revert ZeroAddress();
        if (request.campaignToken == request.quoteToken || request.campaignToken == WBNB || request.quoteToken == WBNB) revert InvalidPair();
        if (request.memeAmountDesired == 0 || msg.value == 0 || request.finalCurvePriceNativeWad == 0) revert ZeroLiquidity();

        QuoteRoute memory route = quoteRoutes[request.quoteToken];
        if (!route.enabled) revert RouteDisabled();

        address acquisitionPool = IBnbQuoteTopazFactory(topazFactory).getPool(WBNB, request.quoteToken, false);
        if (acquisitionPool == address(0) || acquisitionPool != route.acquisitionPool) revert AcquisitionPoolMismatch();
        if (IBnbQuoteTopazPool(acquisitionPool).stable()) revert InvalidPair();

        if (IBnbQuoteTopazFactory(topazFactory).getPool(request.campaignToken, request.quoteToken, false) != address(0)) {
            revert FinalPoolAlreadyExists();
        }

        uint256 nativeUsdWad = _oraclePriceWad(nativeUsdOracle);
        uint256 quoteUsdWad = _oraclePriceWad(route.oracleFeed);
        _requireRouteLiquidity(request.quoteToken, route, nativeUsdWad, quoteUsdWad);

        IBnbQuoteTopazRouter.Route[] memory acquisitionRoute = new IBnbQuoteTopazRouter.Route[](1);
        acquisitionRoute[0] = IBnbQuoteTopazRouter.Route({
            from: WBNB,
            to: request.quoteToken,
            stable: false,
            factory: topazFactory
        });

        uint256 quotedQuoteOut = _quote(msg.value, acquisitionRoute);
        uint256 minimumQuoteOut = Math.mulDiv(quotedQuoteOut, BPS - route.maxSwapSlippageBps, BPS);
        if (minimumQuoteOut == 0) revert QuoteUnavailable();

        uint256 probeNative = msg.value / 100;
        if (probeNative == 0) probeNative = 1;
        uint256 probeQuoteOut = _quote(probeNative, acquisitionRoute);
        uint256 priceImpactBps = _priceImpactBps(msg.value, quotedQuoteOut, probeNative, probeQuoteOut);
        if (priceImpactBps > route.maxPriceImpactBps) revert PriceImpactTooHigh();

        uint8 quoteDecimals = IERC20Metadata(request.quoteToken).decimals();
        uint256 impliedNativeUsdWad = _impliedNativeUsdWad(msg.value, quotedQuoteOut, quoteDecimals, quoteUsdWad);
        if (_deviationBps(impliedNativeUsdWad, nativeUsdWad) > route.maxOracleDeviationBps) revert OracleDeviationTooHigh();

        IERC20 meme = IERC20(request.campaignToken);
        meme.safeTransferFrom(msg.sender, address(this), request.memeAmountDesired);

        uint256 quoteBefore = IERC20(request.quoteToken).balanceOf(address(this));
        uint256[] memory swapAmounts = IBnbQuoteTopazRouter(topazRouter).swapExactETHForTokens{value: msg.value}(
            minimumQuoteOut,
            acquisitionRoute,
            address(this),
            request.deadline
        );
        uint256 quoteAcquired = IERC20(request.quoteToken).balanceOf(address(this)) - quoteBefore;
        if (swapAmounts.length < 2 || quoteAcquired == 0 || quoteAcquired != swapAmounts[swapAmounts.length - 1]) revert QuoteUnavailable();

        meme.forceApprove(topazRouter, request.memeAmountDesired);
        IERC20(request.quoteToken).forceApprove(topazRouter, quoteAcquired);
        (uint256 memeUsed, uint256 quoteUsed, uint256 lpAmount) = IBnbQuoteTopazRouter(topazRouter).addLiquidity(
            request.campaignToken,
            request.quoteToken,
            false,
            request.memeAmountDesired,
            quoteAcquired,
            request.memeAmountDesired,
            quoteAcquired,
            permanentLpLocker,
            request.deadline
        );
        meme.forceApprove(topazRouter, 0);
        IERC20(request.quoteToken).forceApprove(topazRouter, 0);

        if (memeUsed == 0 || quoteUsed == 0 || lpAmount == 0) revert ZeroLiquidity();
        if (memeUsed != request.memeAmountDesired || quoteUsed != quoteAcquired) revert LiquidityResidual();

        address finalPool = IBnbQuoteTopazFactory(topazFactory).getPool(request.campaignToken, request.quoteToken, false);
        if (finalPool == address(0) || IBnbQuoteTopazPool(finalPool).stable()) revert InvalidPair();

        uint256 finalCurveMemeUsdWad = Math.mulDiv(request.finalCurvePriceNativeWad, nativeUsdWad, WAD);
        uint256 initialDexMemeUsdWad = _memeUsdFromQuote(memeUsed, quoteUsed, quoteDecimals, quoteUsdWad);
        uint256 graduationDeviation = _deviationBps(initialDexMemeUsdWad, finalCurveMemeUsdWad);
        if (graduationDeviation > route.maxGraduationPriceDeviationBps) revert GraduationPriceDeviationTooHigh();

        result = GraduationResult({
            canonicalPool: finalPool,
            lpAmount: lpAmount,
            nativeLiquidityUsed: msg.value,
            quoteTokenAcquired: quoteAcquired,
            quoteTokenUsed: quoteUsed,
            memeTokenUsed: memeUsed,
            finalCurveMemeUsdWad: finalCurveMemeUsdWad,
            initialDexMemeUsdWad: initialDexMemeUsdWad,
            priceDeviationBps: graduationDeviation
        });

        emit QuoteGraduationExecuted(
            msg.sender,
            request.campaignToken,
            request.quoteToken,
            finalPool,
            lpAmount,
            msg.value,
            quoteAcquired,
            memeUsed,
            finalCurveMemeUsdWad,
            initialDexMemeUsdWad,
            graduationDeviation
        );
    }

    function _requireRouteLiquidity(address quoteToken, QuoteRoute memory route, uint256 nativeUsdWad, uint256 quoteUsdWad) private view {
        IBnbQuoteTopazPool pool = IBnbQuoteTopazPool(route.acquisitionPool);
        (uint112 reserve0, uint112 reserve1,) = pool.getReserves();
        address token0 = pool.token0();
        address token1 = pool.token1();
        if (!((token0 == WBNB && token1 == quoteToken) || (token1 == WBNB && token0 == quoteToken))) revert InvalidPair();

        uint256 nativeReserve = token0 == WBNB ? uint256(reserve0) : uint256(reserve1);
        uint256 quoteReserve = token0 == quoteToken ? uint256(reserve0) : uint256(reserve1);
        uint8 quoteDecimals = IERC20Metadata(quoteToken).decimals();
        if (quoteDecimals > 36) revert InvalidPolicy();
        uint256 quoteScale = 10 ** uint256(quoteDecimals);
        uint256 nativeUsd = Math.mulDiv(nativeReserve, nativeUsdWad, WAD);
        uint256 quoteUsd = Math.mulDiv(quoteReserve, quoteUsdWad, quoteScale);
        if (nativeUsd + quoteUsd < route.minimumRouteLiquidityUsdWad) revert RouteLiquidityTooLow();
    }

    function _quote(uint256 amountIn, IBnbQuoteTopazRouter.Route[] memory routes) private view returns (uint256 amountOut) {
        uint256[] memory amounts = IBnbQuoteTopazRouter(topazRouter).getAmountsOut(amountIn, routes);
        if (amounts.length < 2 || amounts[amounts.length - 1] == 0) revert QuoteUnavailable();
        return amounts[amounts.length - 1];
    }

    function _oraclePriceWad(address oracle) private view returns (uint256 priceWad) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = IBnbQuoteAggregatorV3(oracle).latestRoundData();
        if (answer <= 0 || roundId == 0 || answeredInRound < roundId || updatedAt == 0 || updatedAt > block.timestamp) revert OracleUnhealthy();
        if (block.timestamp - updatedAt > maxOracleAgeSeconds) revert OracleStale();
        uint8 decimals_ = IBnbQuoteAggregatorV3(oracle).decimals();
        uint256 unsigned = uint256(answer);
        if (decimals_ == 18) return unsigned;
        if (decimals_ < 18) return unsigned * (10 ** uint256(18 - decimals_));
        return unsigned / (10 ** uint256(decimals_ - 18));
    }

    function _priceImpactBps(uint256 fullIn, uint256 fullOut, uint256 probeIn, uint256 probeOut) private pure returns (uint256) {
        if (fullIn == 0 || fullOut == 0 || probeIn == 0 || probeOut == 0) revert QuoteUnavailable();
        uint256 probeRateWad = Math.mulDiv(probeOut, WAD, probeIn);
        uint256 fullRateWad = Math.mulDiv(fullOut, WAD, fullIn);
        if (fullRateWad >= probeRateWad) return 0;
        return Math.mulDiv(probeRateWad - fullRateWad, BPS, probeRateWad);
    }

    function _impliedNativeUsdWad(uint256 nativeIn, uint256 quoteOut, uint8 quoteDecimals, uint256 quoteUsdWad)
        private
        pure
        returns (uint256)
    {
        if (nativeIn == 0 || quoteOut == 0 || quoteDecimals > 36) revert InvalidPolicy();
        uint256 quoteValueUsdWad = Math.mulDiv(quoteOut, quoteUsdWad, 10 ** uint256(quoteDecimals));
        return Math.mulDiv(quoteValueUsdWad, WAD, nativeIn);
    }

    function _memeUsdFromQuote(uint256 memeAmount, uint256 quoteAmount, uint8 quoteDecimals, uint256 quoteUsdWad)
        private
        pure
        returns (uint256)
    {
        if (memeAmount == 0 || quoteAmount == 0 || quoteDecimals > 36) revert InvalidPolicy();
        uint256 quoteValueUsdWad = Math.mulDiv(quoteAmount, quoteUsdWad, 10 ** uint256(quoteDecimals));
        return Math.mulDiv(quoteValueUsdWad, WAD, memeAmount);
    }

    function _deviationBps(uint256 actual, uint256 referenceValue) private pure returns (uint256) {
        if (referenceValue == 0) revert OracleUnhealthy();
        uint256 diff = actual > referenceValue ? actual - referenceValue : referenceValue - actual;
        return Math.mulDiv(diff, BPS, referenceValue);
    }
}
