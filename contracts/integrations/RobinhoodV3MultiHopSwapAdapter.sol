// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IRobinhoodMultiHopWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

interface IRobinhoodMultiHopV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IRobinhoodMultiHopV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        external
        view
        returns (uint256 amountOut);
}

/// @notice Atomic native ETH <-> MEME execution for Robinhood Stock Battlefield markets.
/// @dev A configured canonical route is always WETH <-> Stock Token <-> MEME. The trader
/// never has to hold or approve the intermediate Stock Token. The existing direct-native
/// RobinhoodV3NativeSwapAdapter remains the execution boundary for MEME/WETH markets.
contract RobinhoodV3MultiHopSwapAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    struct MarketRoute {
        address stockToken;
        uint24 nativeStockFee;
        uint24 stockMemeFee;
        uint16 maxPriceImpactBps;
        bool enabled;
    }

    struct RouteQuote {
        address stockToken;
        uint256 intermediateOut;
        uint256 finalOut;
        uint256 firstLegPriceImpactBps;
        uint256 secondLegPriceImpactBps;
        uint64 quotedAt;
    }

    address public immutable admin;
    IRobinhoodMultiHopV3Factory public immutable v3Factory;
    IRobinhoodMultiHopV3Router public immutable swapRouter;
    IRobinhoodMultiHopWETH9 public immutable wrappedNative;

    mapping(address => MarketRoute) public marketRoutes;

    event MarketRouteConfigured(
        address indexed memeToken,
        address indexed stockToken,
        uint24 nativeStockFee,
        uint24 stockMemeFee,
        uint16 maxPriceImpactBps,
        bool enabled
    );

    event StockRouteNativeBuy(
        address indexed trader,
        address indexed memeToken,
        address indexed stockToken,
        uint256 nativeIn,
        uint256 stockIntermediate,
        uint256 memeOut,
        address recipient
    );

    event StockRouteNativeSell(
        address indexed trader,
        address indexed memeToken,
        address indexed stockToken,
        uint256 memeIn,
        uint256 stockIntermediate,
        uint256 nativeOut,
        address recipient
    );

    error OnlyAdmin();
    error ZeroAddress();
    error ContractCodeMissing();
    error InvalidRoute();
    error RouteDisabled();
    error RoutePoolUnavailable();
    error DeadlineExpired();
    error ZeroInput();
    error InvalidMinimumOutput();
    error MinimumOutputUnreachable();
    error PriceImpactTooHigh(uint256 firstLegBps, uint256 secondLegBps, uint256 maximumBps);
    error ResidualBalance(address asset);
    error NativeTransferFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    constructor(address v3Factory_, address swapRouter_, address wrappedNative_) {
        if (v3Factory_ == address(0) || swapRouter_ == address(0) || wrappedNative_ == address(0)) {
            revert ZeroAddress();
        }
        if (v3Factory_.code.length == 0 || swapRouter_.code.length == 0 || wrappedNative_.code.length == 0) {
            revert ContractCodeMissing();
        }

        admin = msg.sender;
        v3Factory = IRobinhoodMultiHopV3Factory(v3Factory_);
        swapRouter = IRobinhoodMultiHopV3Router(swapRouter_);
        wrappedNative = IRobinhoodMultiHopWETH9(wrappedNative_);
    }

    receive() external payable {
        if (msg.sender != address(wrappedNative)) revert InvalidRoute();
    }

    /// @notice Configure the one canonical Stock Battlefield execution route for a MEME token.
    /// @dev The caller cannot provide an execution router or Stock Token at trade time.
    function configureMarketRoute(
        address memeToken,
        address stockToken,
        uint24 nativeStockFee,
        uint24 stockMemeFee,
        uint16 maxPriceImpactBps,
        bool enabled
    ) external onlyAdmin {
        if (memeToken == address(0) || stockToken == address(0)) revert ZeroAddress();
        if (
            memeToken == stockToken || memeToken == address(wrappedNative) || stockToken == address(wrappedNative) ||
            nativeStockFee == 0 || stockMemeFee == 0 || maxPriceImpactBps > BPS
        ) revert InvalidRoute();
        if (memeToken.code.length == 0 || stockToken.code.length == 0) revert ContractCodeMissing();

        if (enabled) _requireCanonicalPools(memeToken, stockToken, nativeStockFee, stockMemeFee);

        marketRoutes[memeToken] = MarketRoute({
            stockToken: stockToken,
            nativeStockFee: nativeStockFee,
            stockMemeFee: stockMemeFee,
            maxPriceImpactBps: maxPriceImpactBps,
            enabled: enabled
        });

        emit MarketRouteConfigured(
            memeToken,
            stockToken,
            nativeStockFee,
            stockMemeFee,
            maxPriceImpactBps,
            enabled
        );
    }

    function routeHealth(address memeToken)
        external
        view
        returns (
            bool configured,
            bool enabled,
            address stockToken,
            address nativeStockPool,
            address stockMemePool,
            bool poolsValid
        )
    {
        MarketRoute memory route = marketRoutes[memeToken];
        stockToken = route.stockToken;
        configured = stockToken != address(0);
        enabled = route.enabled;
        if (!configured) return (configured, enabled, stockToken, address(0), address(0), false);

        nativeStockPool = v3Factory.getPool(address(wrappedNative), stockToken, route.nativeStockFee);
        stockMemePool = v3Factory.getPool(stockToken, memeToken, route.stockMemeFee);
        poolsValid = nativeStockPool != address(0) && stockMemePool != address(0);
    }

    /// @notice Current onchain two-hop quote. Execution re-quotes in the execution transaction,
    /// so it never trusts a stale offchain amount as authoritative.
    function quoteBuyWithNative(address memeToken, uint256 nativeIn)
        external
        view
        returns (RouteQuote memory quote)
    {
        if (nativeIn == 0) revert ZeroInput();
        return _quoteBuy(memeToken, nativeIn);
    }

    function quoteSellForNative(address memeToken, uint256 memeIn)
        external
        view
        returns (RouteQuote memory quote)
    {
        if (memeIn == 0) revert ZeroInput();
        return _quoteSell(memeToken, memeIn);
    }

    /// @notice Atomically execute ETH -> WETH -> Stock Token -> MEME.
    function buyWithNative(
        address memeToken,
        uint256 minimumStockOut,
        uint256 minimumMemeOut,
        uint256 deadline,
        address recipient
    ) external payable nonReentrant returns (uint256 memeOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (msg.value == 0) revert ZeroInput();
        if (minimumStockOut == 0 || minimumMemeOut == 0) revert InvalidMinimumOutput();
        if (recipient == address(0) || recipient == address(this)) revert ZeroAddress();

        MarketRoute memory route = _requireRoute(memeToken);
        RouteQuote memory quote = _quoteBuyWithRoute(memeToken, msg.value, route);
        if (minimumStockOut > quote.intermediateOut || minimumMemeOut > quote.finalOut) {
            revert MinimumOutputUnreachable();
        }

        uint256 nativeBefore = address(this).balance - msg.value;
        uint256 wethBefore = IERC20(address(wrappedNative)).balanceOf(address(this));
        uint256 stockBefore = IERC20(route.stockToken).balanceOf(address(this));
        uint256 memeBefore = IERC20(memeToken).balanceOf(address(this));

        wrappedNative.deposit{value: msg.value}();
        IERC20(address(wrappedNative)).forceApprove(address(swapRouter), msg.value);
        uint256 stockOut = swapRouter.exactInputSingle(
            IRobinhoodMultiHopV3Router.ExactInputSingleParams({
                tokenIn: address(wrappedNative),
                tokenOut: route.stockToken,
                fee: route.nativeStockFee,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: minimumStockOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(address(wrappedNative)).forceApprove(address(swapRouter), 0);

        IERC20(route.stockToken).forceApprove(address(swapRouter), stockOut);
        memeOut = swapRouter.exactInputSingle(
            IRobinhoodMultiHopV3Router.ExactInputSingleParams({
                tokenIn: route.stockToken,
                tokenOut: memeToken,
                fee: route.stockMemeFee,
                recipient: recipient,
                amountIn: stockOut,
                amountOutMinimum: minimumMemeOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(route.stockToken).forceApprove(address(swapRouter), 0);

        _requireUnchangedBalance(address(wrappedNative), wethBefore);
        _requireUnchangedBalance(route.stockToken, stockBefore);
        _requireUnchangedBalance(memeToken, memeBefore);
        if (address(this).balance != nativeBefore) revert ResidualBalance(address(0));

        emit StockRouteNativeBuy(
            msg.sender,
            memeToken,
            route.stockToken,
            msg.value,
            stockOut,
            memeOut,
            recipient
        );
    }

    /// @notice Atomically execute MEME -> Stock Token -> WETH -> ETH.
    function sellForNative(
        address memeToken,
        uint256 memeIn,
        uint256 minimumStockOut,
        uint256 minimumNativeOut,
        uint256 deadline,
        address recipient
    ) external nonReentrant returns (uint256 nativeOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (memeIn == 0) revert ZeroInput();
        if (minimumStockOut == 0 || minimumNativeOut == 0) revert InvalidMinimumOutput();
        if (recipient == address(0) || recipient == address(this)) revert ZeroAddress();

        MarketRoute memory route = _requireRoute(memeToken);
        RouteQuote memory quote = _quoteSellWithRoute(memeToken, memeIn, route);
        if (minimumStockOut > quote.intermediateOut || minimumNativeOut > quote.finalOut) {
            revert MinimumOutputUnreachable();
        }

        uint256 nativeBefore = address(this).balance;
        uint256 wethBefore = IERC20(address(wrappedNative)).balanceOf(address(this));
        uint256 stockBefore = IERC20(route.stockToken).balanceOf(address(this));
        uint256 memeBefore = IERC20(memeToken).balanceOf(address(this));

        IERC20 meme = IERC20(memeToken);
        meme.safeTransferFrom(msg.sender, address(this), memeIn);
        meme.forceApprove(address(swapRouter), memeIn);
        uint256 stockOut = swapRouter.exactInputSingle(
            IRobinhoodMultiHopV3Router.ExactInputSingleParams({
                tokenIn: memeToken,
                tokenOut: route.stockToken,
                fee: route.stockMemeFee,
                recipient: address(this),
                amountIn: memeIn,
                amountOutMinimum: minimumStockOut,
                sqrtPriceLimitX96: 0
            })
        );
        meme.forceApprove(address(swapRouter), 0);

        IERC20(route.stockToken).forceApprove(address(swapRouter), stockOut);
        nativeOut = swapRouter.exactInputSingle(
            IRobinhoodMultiHopV3Router.ExactInputSingleParams({
                tokenIn: route.stockToken,
                tokenOut: address(wrappedNative),
                fee: route.nativeStockFee,
                recipient: address(this),
                amountIn: stockOut,
                amountOutMinimum: minimumNativeOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(route.stockToken).forceApprove(address(swapRouter), 0);

        wrappedNative.withdraw(nativeOut);
        (bool ok,) = payable(recipient).call{value: nativeOut}("");
        if (!ok) revert NativeTransferFailed();

        _requireUnchangedBalance(memeToken, memeBefore);
        _requireUnchangedBalance(route.stockToken, stockBefore);
        _requireUnchangedBalance(address(wrappedNative), wethBefore);
        if (address(this).balance != nativeBefore) revert ResidualBalance(address(0));

        emit StockRouteNativeSell(
            msg.sender,
            memeToken,
            route.stockToken,
            memeIn,
            stockOut,
            nativeOut,
            recipient
        );
    }

    function _quoteBuy(address memeToken, uint256 nativeIn) private view returns (RouteQuote memory quote) {
        return _quoteBuyWithRoute(memeToken, nativeIn, _requireRoute(memeToken));
    }

    function _quoteBuyWithRoute(address memeToken, uint256 nativeIn, MarketRoute memory route)
        private
        view
        returns (RouteQuote memory quote)
    {
        _requireCanonicalPools(memeToken, route.stockToken, route.nativeStockFee, route.stockMemeFee);
        (quote.intermediateOut, quote.firstLegPriceImpactBps) = _quoteLeg(
            address(wrappedNative), route.stockToken, route.nativeStockFee, nativeIn
        );
        (quote.finalOut, quote.secondLegPriceImpactBps) = _quoteLeg(
            route.stockToken, memeToken, route.stockMemeFee, quote.intermediateOut
        );
        _requireImpact(route, quote.firstLegPriceImpactBps, quote.secondLegPriceImpactBps);
        quote.stockToken = route.stockToken;
        quote.quotedAt = uint64(block.timestamp);
    }

    function _quoteSell(address memeToken, uint256 memeIn) private view returns (RouteQuote memory quote) {
        return _quoteSellWithRoute(memeToken, memeIn, _requireRoute(memeToken));
    }

    function _quoteSellWithRoute(address memeToken, uint256 memeIn, MarketRoute memory route)
        private
        view
        returns (RouteQuote memory quote)
    {
        _requireCanonicalPools(memeToken, route.stockToken, route.nativeStockFee, route.stockMemeFee);
        (quote.intermediateOut, quote.firstLegPriceImpactBps) = _quoteLeg(
            memeToken, route.stockToken, route.stockMemeFee, memeIn
        );
        (quote.finalOut, quote.secondLegPriceImpactBps) = _quoteLeg(
            route.stockToken, address(wrappedNative), route.nativeStockFee, quote.intermediateOut
        );
        _requireImpact(route, quote.firstLegPriceImpactBps, quote.secondLegPriceImpactBps);
        quote.stockToken = route.stockToken;
        quote.quotedAt = uint64(block.timestamp);
    }

    function _quoteLeg(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        private
        view
        returns (uint256 amountOut, uint256 priceImpactBps)
    {
        if (amountIn == 0) revert ZeroInput();
        amountOut = swapRouter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn);
        if (amountOut == 0) revert InvalidRoute();

        uint256 probeIn = amountIn / 100;
        if (probeIn == 0) probeIn = 1;
        uint256 probeOut = swapRouter.quoteExactInputSingle(tokenIn, tokenOut, fee, probeIn);
        if (probeOut == 0) revert InvalidRoute();

        uint256 expectedAtProbeRate = Math.mulDiv(probeOut, amountIn, probeIn);
        if (expectedAtProbeRate != 0 && amountOut < expectedAtProbeRate) {
            priceImpactBps = Math.mulDiv(expectedAtProbeRate - amountOut, BPS, expectedAtProbeRate);
        }
    }

    function _requireRoute(address memeToken) private view returns (MarketRoute memory route) {
        route = marketRoutes[memeToken];
        if (route.stockToken == address(0) || !route.enabled) revert RouteDisabled();
    }

    function _requireCanonicalPools(
        address memeToken,
        address stockToken,
        uint24 nativeStockFee,
        uint24 stockMemeFee
    ) private view {
        if (
            v3Factory.getPool(address(wrappedNative), stockToken, nativeStockFee) == address(0) ||
            v3Factory.getPool(stockToken, memeToken, stockMemeFee) == address(0)
        ) revert RoutePoolUnavailable();
    }

    function _requireImpact(MarketRoute memory route, uint256 firstLegBps, uint256 secondLegBps) private pure {
        if (firstLegBps > route.maxPriceImpactBps || secondLegBps > route.maxPriceImpactBps) {
            revert PriceImpactTooHigh(firstLegBps, secondLegBps, route.maxPriceImpactBps);
        }
    }

    function _requireUnchangedBalance(address asset, uint256 expectedBalance) private view {
        if (IERC20(asset).balanceOf(address(this)) != expectedBalance) revert ResidualBalance(asset);
    }
}
