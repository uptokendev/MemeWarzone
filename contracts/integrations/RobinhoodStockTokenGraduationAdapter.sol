// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IRobinhoodStockV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24 tickSpacing);
}

interface IRobinhoodStockV3Router {
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
    function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        external
        view
        returns (uint256 amountOut);
}

interface IRobinhoodStockV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IRobinhoodStockWETH is IERC20 {
    function deposit() external payable;
}

interface IRobinhoodStockAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IRobinhoodStockCampaignFactory {
    function isCampaign(address campaign) external view returns (bool);
}

/// @notice Stock Battlefield graduation execution boundary for Robinhood Chain.
/// @dev This contract is intentionally separate from RobinhoodUniswapV3GraduationAdapter.
/// It only supports Stock Tokens explicitly configured by the adapter admin, only accepts
/// calls from campaigns belonging to the configured MemeWarzone factory, and mints the
/// resulting MEME/Stock position directly to the permanent V3 locker.
contract RobinhoodStockTokenGraduationAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant LIQUIDITY_KIND_V3_NFT = 2;
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;

    struct StockRoute {
        address oracleFeed;
        address acquisitionPool;
        uint24 acquisitionFeeTier;
        uint256 minimumRouteLiquidityUsdWad;
        uint16 maxSwapSlippageBps;
        uint16 maxOracleDeviationBps;
        uint16 maxPriceImpactBps;
        bool enabled;
    }

    struct GraduationRequest {
        address campaignToken;
        address stockToken;
        uint256 memeAmountDesired;
        uint256 minimumMemeUsed;
        uint256 minimumStockOut;
        uint256 finalCurvePriceNativeWad;
        uint256 deadline;
    }

    struct GraduationResult {
        address canonicalPool;
        uint256 positionTokenId;
        uint256 nativeLiquidityUsed;
        uint256 stockTokenAcquired;
        uint256 stockTokenUsed;
        uint256 stockTokenResidual;
        uint256 memeTokenUsed;
        uint256 memeTokenResidual;
        uint256 finalCurveMemeUsdWad;
        uint256 initialDexMemeUsdWad;
        uint256 priceDeviationBps;
    }

    address public immutable admin;
    address public immutable v3Factory;
    address public immutable positionManager;
    address public immutable swapRouter;
    address public immutable WETH;
    address public immutable permanentPositionLocker;
    address public immutable nativeUsdOracle;
    uint24 public immutable feeTier;
    uint32 public immutable maxOracleAgeSeconds;

    address public campaignFactory;
    bool public campaignFactoryLocked;
    mapping(address => StockRoute) public stockRoutes;

    event CampaignFactoryLocked(address indexed campaignFactory);
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
    event StockGraduationExecuted(
        address indexed campaign,
        address indexed campaignToken,
        address indexed stockToken,
        address canonicalPool,
        uint256 positionTokenId,
        uint256 nativeLiquidityUsed,
        uint256 stockTokenAcquired,
        uint256 stockTokenUsed,
        uint256 stockTokenResidual,
        uint256 memeTokenUsed,
        uint256 memeTokenResidual,
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
    error InvalidFeeTier();
    error InvalidPolicy();
    error DeadlineExpired();
    error ZeroLiquidity();
    error InvalidPair();
    error AcquisitionPoolMismatch();
    error OracleUnhealthy();
    error OracleStale();
    error RouteLiquidityTooLow();
    error SlippageTooHigh();
    error PriceImpactTooHigh();
    error OracleDeviationTooHigh();
    error PriceContinuityFailed();
    error PositionMintFailed();
    error SqrtPriceOverflow();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    constructor(
        address v3Factory_,
        address positionManager_,
        address swapRouter_,
        address weth_,
        address permanentPositionLocker_,
        address nativeUsdOracle_,
        uint24 memePoolFeeTier_,
        uint32 maxOracleAgeSeconds_
    ) {
        if (
            v3Factory_ == address(0) || positionManager_ == address(0) || swapRouter_ == address(0) ||
            weth_ == address(0) || permanentPositionLocker_ == address(0) || nativeUsdOracle_ == address(0)
        ) revert ZeroAddress();
        if (
            v3Factory_.code.length == 0 || positionManager_.code.length == 0 || swapRouter_.code.length == 0 ||
            weth_.code.length == 0 || permanentPositionLocker_.code.length == 0 || nativeUsdOracle_.code.length == 0
        ) revert ContractCodeMissing();
        if (memePoolFeeTier_ == 0 || IRobinhoodStockV3Factory(v3Factory_).feeAmountTickSpacing(memePoolFeeTier_) <= 0) {
            revert InvalidFeeTier();
        }
        if (maxOracleAgeSeconds_ == 0) revert InvalidPolicy();
        admin = msg.sender;
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        swapRouter = swapRouter_;
        WETH = weth_;
        permanentPositionLocker = permanentPositionLocker_;
        nativeUsdOracle = nativeUsdOracle_;
        feeTier = memePoolFeeTier_;
        maxOracleAgeSeconds = maxOracleAgeSeconds_;
    }

    receive() external payable {
        if (msg.sender != WETH) revert InvalidPair();
    }

    function liquidityKind() external pure returns (uint8) {
        return LIQUIDITY_KIND_V3_NFT;
    }

    function poolFactory() external view returns (address) {
        return address(this);
    }

    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool) {
        if (stable) revert InvalidPair();
        return IRobinhoodStockV3Factory(v3Factory).getPool(tokenA, tokenB, feeTier);
    }

    function setCampaignFactoryOnce(address campaignFactory_) external onlyAdmin {
        if (campaignFactoryLocked) revert FactoryAlreadyLocked();
        if (campaignFactory_ == address(0)) revert ZeroAddress();
        if (campaignFactory_.code.length == 0) revert ContractCodeMissing();
        campaignFactory = campaignFactory_;
        campaignFactoryLocked = true;
        emit CampaignFactoryLocked(campaignFactory_);
    }

    function configureStockRoute(address stockToken, StockRoute calldata route) external onlyAdmin {
        if (stockToken == address(0) || route.oracleFeed == address(0) || route.acquisitionPool == address(0)) revert ZeroAddress();
        if (stockToken == WETH) revert InvalidPair();
        if (stockToken.code.length == 0 || route.oracleFeed.code.length == 0 || route.acquisitionPool.code.length == 0) {
            revert ContractCodeMissing();
        }
        if (route.acquisitionFeeTier == 0 || IRobinhoodStockV3Factory(v3Factory).feeAmountTickSpacing(route.acquisitionFeeTier) <= 0) {
            revert InvalidFeeTier();
        }
        if (
            route.maxSwapSlippageBps > BPS || route.maxOracleDeviationBps > BPS || route.maxPriceImpactBps > BPS ||
            route.minimumRouteLiquidityUsdWad == 0
        ) revert InvalidPolicy();
        address canonicalAcquisitionPool = IRobinhoodStockV3Factory(v3Factory).getPool(WETH, stockToken, route.acquisitionFeeTier);
        if (canonicalAcquisitionPool == address(0) || canonicalAcquisitionPool != route.acquisitionPool) revert AcquisitionPoolMismatch();
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

    function graduateStockLiquidity(GraduationRequest calldata request)
        external
        payable
        nonReentrant
        returns (GraduationResult memory result)
    {
        address factory_ = campaignFactory;
        if (!campaignFactoryLocked || factory_ == address(0)) revert CampaignFactoryMissing();
        if (!IRobinhoodStockCampaignFactory(factory_).isCampaign(msg.sender)) revert UnauthorizedCampaign();
        if (block.timestamp > request.deadline) revert DeadlineExpired();
        if (request.campaignToken == address(0) || request.stockToken == address(0)) revert ZeroAddress();
        if (request.campaignToken == request.stockToken || request.campaignToken == WETH || request.stockToken == WETH) revert InvalidPair();
        if (request.memeAmountDesired == 0 || msg.value == 0 || request.finalCurvePriceNativeWad == 0) revert ZeroLiquidity();

        StockRoute memory route = stockRoutes[request.stockToken];
        if (!route.enabled) revert RouteDisabled();
        address canonicalAcquisitionPool = IRobinhoodStockV3Factory(v3Factory).getPool(WETH, request.stockToken, route.acquisitionFeeTier);
        if (canonicalAcquisitionPool == address(0) || canonicalAcquisitionPool != route.acquisitionPool) revert AcquisitionPoolMismatch();

        uint256 nativeUsdWad = _oraclePriceWad(nativeUsdOracle);
        uint256 stockUsdWad = _oraclePriceWad(route.oracleFeed);
        _requireRouteLiquidity(request.stockToken, route, stockUsdWad);

        uint256 quotedStockOut = IRobinhoodStockV3Router(swapRouter).quoteExactInputSingle(
            WETH, request.stockToken, route.acquisitionFeeTier, msg.value
        );
        if (quotedStockOut == 0 || request.minimumStockOut == 0 || request.minimumStockOut > quotedStockOut) revert SlippageTooHigh();
        uint256 slippageBps = Math.mulDiv(quotedStockOut - request.minimumStockOut, BPS, quotedStockOut);
        if (slippageBps > route.maxSwapSlippageBps) revert SlippageTooHigh();

        uint256 probeNative = msg.value / 100;
        if (probeNative == 0) probeNative = 1;
        uint256 probeStockOut = IRobinhoodStockV3Router(swapRouter).quoteExactInputSingle(
            WETH, request.stockToken, route.acquisitionFeeTier, probeNative
        );
        uint256 priceImpactBps = _priceImpactBps(msg.value, quotedStockOut, probeNative, probeStockOut);
        if (priceImpactBps > route.maxPriceImpactBps) revert PriceImpactTooHigh();

        uint8 stockDecimals = IERC20Metadata(request.stockToken).decimals();
        uint256 impliedNativeUsdWad = _impliedNativeUsdWad(msg.value, quotedStockOut, stockDecimals, stockUsdWad);
        uint256 oracleDeviationBps = _deviationBps(impliedNativeUsdWad, nativeUsdWad);
        if (oracleDeviationBps > route.maxOracleDeviationBps) revert OracleDeviationTooHigh();

        IERC20(request.campaignToken).safeTransferFrom(msg.sender, address(this), request.memeAmountDesired);
        IRobinhoodStockWETH(WETH).deposit{value: msg.value}();
        IERC20(WETH).forceApprove(swapRouter, msg.value);
        uint256 stockBefore = IERC20(request.stockToken).balanceOf(address(this));
        uint256 stockAcquired = IRobinhoodStockV3Router(swapRouter).exactInputSingle(
            IRobinhoodStockV3Router.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: request.stockToken,
                fee: route.acquisitionFeeTier,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: request.minimumStockOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(WETH).forceApprove(swapRouter, 0);
        uint256 stockDelta = IERC20(request.stockToken).balanceOf(address(this)) - stockBefore;
        if (stockAcquired == 0 || stockDelta != stockAcquired || stockAcquired < request.minimumStockOut) revert ZeroLiquidity();

        result = _mintLockedPosition(request, stockAcquired, nativeUsdWad, stockUsdWad);
        result.nativeLiquidityUsed = msg.value;
        result.stockTokenAcquired = stockAcquired;

        if (result.memeTokenResidual != 0) IERC20(request.campaignToken).safeTransfer(msg.sender, result.memeTokenResidual);
        if (result.stockTokenResidual != 0) IERC20(request.stockToken).safeTransfer(msg.sender, result.stockTokenResidual);

        emit StockGraduationExecuted(
            msg.sender,
            request.campaignToken,
            request.stockToken,
            result.canonicalPool,
            result.positionTokenId,
            result.nativeLiquidityUsed,
            result.stockTokenAcquired,
            result.stockTokenUsed,
            result.stockTokenResidual,
            result.memeTokenUsed,
            result.memeTokenResidual,
            result.finalCurveMemeUsdWad,
            result.initialDexMemeUsdWad,
            result.priceDeviationBps
        );
    }

    function _mintLockedPosition(
        GraduationRequest calldata request,
        uint256 stockAcquired,
        uint256 nativeUsdWad,
        uint256 stockUsdWad
    ) private returns (GraduationResult memory result) {
        bool memeIs0 = request.campaignToken < request.stockToken;
        address token0 = memeIs0 ? request.campaignToken : request.stockToken;
        address token1 = memeIs0 ? request.stockToken : request.campaignToken;
        uint256 amount0Desired = memeIs0 ? request.memeAmountDesired : stockAcquired;
        uint256 amount1Desired = memeIs0 ? stockAcquired : request.memeAmountDesired;
        uint256 amount0Min = memeIs0 ? request.minimumMemeUsed : request.minimumStockOut;
        uint256 amount1Min = memeIs0 ? request.minimumStockOut : request.minimumMemeUsed;
        uint160 sqrtPriceX96 = _sqrtPriceX96(amount0Desired, amount1Desired);

        IRobinhoodStockV3PositionManager manager = IRobinhoodStockV3PositionManager(positionManager);
        result.canonicalPool = manager.createAndInitializePoolIfNecessary(token0, token1, feeTier, sqrtPriceX96);
        if (result.canonicalPool == address(0)) revert InvalidPair();
        if (IRobinhoodStockV3Factory(v3Factory).getPool(token0, token1, feeTier) != result.canonicalPool) revert InvalidPair();

        int24 spacing = IRobinhoodStockV3Factory(v3Factory).feeAmountTickSpacing(feeTier);
        if (spacing <= 0) revert InvalidFeeTier();
        (int24 tickLower, int24 tickUpper) = _fullRangeTicks(spacing);
        IERC20(token0).forceApprove(positionManager, amount0Desired);
        IERC20(token1).forceApprove(positionManager, amount1Desired);
        uint128 mintedLiquidity;
        uint256 amount0;
        uint256 amount1;
        (result.positionTokenId, mintedLiquidity, amount0, amount1) = manager.mint(
            IRobinhoodStockV3PositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: feeTier,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: permanentPositionLocker,
                deadline: request.deadline
            })
        );
        IERC20(token0).forceApprove(positionManager, 0);
        IERC20(token1).forceApprove(positionManager, 0);
        if (result.positionTokenId == 0 || mintedLiquidity == 0 || amount0 == 0 || amount1 == 0) revert PositionMintFailed();

        result.memeTokenUsed = memeIs0 ? amount0 : amount1;
        result.stockTokenUsed = memeIs0 ? amount1 : amount0;
        if (result.memeTokenUsed < request.minimumMemeUsed || result.stockTokenUsed == 0) revert PositionMintFailed();
        result.memeTokenResidual = request.memeAmountDesired - result.memeTokenUsed;
        result.stockTokenResidual = stockAcquired - result.stockTokenUsed;

        uint8 memeDecimals = IERC20Metadata(request.campaignToken).decimals();
        uint8 stockDecimals = IERC20Metadata(request.stockToken).decimals();
        result.finalCurveMemeUsdWad = Math.mulDiv(request.finalCurvePriceNativeWad, nativeUsdWad, WAD);
        uint256 usedStockUsdValueWad = Math.mulDiv(result.stockTokenUsed, stockUsdWad, _pow10(stockDecimals));
        result.initialDexMemeUsdWad = Math.mulDiv(usedStockUsdValueWad, _pow10(memeDecimals), result.memeTokenUsed);
        result.priceDeviationBps = _deviationBps(result.initialDexMemeUsdWad, result.finalCurveMemeUsdWad);
        if (result.priceDeviationBps > stockRoutes[request.stockToken].maxOracleDeviationBps) revert PriceContinuityFailed();
    }

    function _requireRouteLiquidity(address stockToken, StockRoute memory route, uint256 stockUsdWad) private view {
        uint8 stockDecimals = IERC20Metadata(stockToken).decimals();
        uint256 stockBalance = IERC20(stockToken).balanceOf(route.acquisitionPool);
        uint256 quoteLiquidityUsdWad = Math.mulDiv(stockBalance, stockUsdWad, _pow10(stockDecimals));
        if (quoteLiquidityUsdWad < route.minimumRouteLiquidityUsdWad) revert RouteLiquidityTooLow();
    }

    function _oraclePriceWad(address oracle) private view returns (uint256) {
        IRobinhoodStockAggregatorV3 feed = IRobinhoodStockAggregatorV3(oracle);
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        if (roundId == 0 || answer <= 0 || updatedAt == 0 || answeredInRound < roundId) revert OracleUnhealthy();
        if (block.timestamp > updatedAt + maxOracleAgeSeconds) revert OracleStale();
        uint8 decimals_ = feed.decimals();
        if (decimals_ > 36) revert OracleUnhealthy();
        uint256 unsignedAnswer = uint256(answer);
        if (decimals_ == 18) return unsignedAnswer;
        if (decimals_ < 18) return unsignedAnswer * _pow10(uint8(18 - decimals_));
        return unsignedAnswer / _pow10(uint8(decimals_ - 18));
    }

    function _impliedNativeUsdWad(uint256 nativeIn, uint256 stockOut, uint8 stockDecimals, uint256 stockUsdWad)
        private
        pure
        returns (uint256)
    {
        uint256 stockUsdValueWad = Math.mulDiv(stockOut, stockUsdWad, _pow10(stockDecimals));
        return Math.mulDiv(stockUsdValueWad, WAD, nativeIn);
    }

    function _priceImpactBps(uint256 amountIn, uint256 amountOut, uint256 probeIn, uint256 probeOut)
        private
        pure
        returns (uint256)
    {
        if (amountIn == 0 || amountOut == 0 || probeIn == 0 || probeOut == 0) revert ZeroLiquidity();
        uint256 expectedAtProbeRate = Math.mulDiv(probeOut, amountIn, probeIn);
        if (expectedAtProbeRate == 0 || amountOut >= expectedAtProbeRate) return 0;
        return Math.mulDiv(expectedAtProbeRate - amountOut, BPS, expectedAtProbeRate);
    }

    function _deviationBps(uint256 observed, uint256 reference) private pure returns (uint256) {
        if (reference == 0) revert OracleUnhealthy();
        uint256 delta = observed > reference ? observed - reference : reference - observed;
        return Math.mulDiv(delta, BPS, reference);
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) private pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert ZeroLiquidity();
        uint256 ratioX192 = Math.mulDiv(amount1, uint256(1) << 192, amount0);
        uint256 sqrtRatio = Math.sqrt(ratioX192);
        if (sqrtRatio == 0 || sqrtRatio > type(uint160).max) revert SqrtPriceOverflow();
        return uint160(sqrtRatio);
    }

    function _fullRangeTicks(int24 spacing) private pure returns (int24 tickLower, int24 tickUpper) {
        tickLower = (MIN_TICK / spacing) * spacing;
        tickUpper = (MAX_TICK / spacing) * spacing;
    }

    function _pow10(uint8 decimals_) private pure returns (uint256) {
        if (decimals_ > 36) revert InvalidPolicy();
        return 10 ** uint256(decimals_);
    }
}
