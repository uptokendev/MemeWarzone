// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMockUniswapV3PeripheryRegistry {
    function positionManager() external view returns (address);
    function swapRouter() external view returns (address);
}

/// @dev Deterministic one-position V3-style pool used only for MemeWarzone staging acceptance.
/// It intentionally does not emulate ticks. It preserves the interfaces and invariants MWZ needs:
/// sorted token pair, fee tier, initialized price, locked liquidity reserves, swaps and LP fee accrual.
contract MockUniswapV3Pool {
    using SafeERC20 for IERC20;

    uint256 private constant FEE_DENOMINATOR = 1_000_000;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable factory;

    uint160 public sqrtPriceX96;
    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public positionTokenId;
    uint256 public claimable0;
    uint256 public claimable1;

    event Initialize(uint160 sqrtPriceX96);
    event LiquiditySeeded(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    event Swap(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount, address recipient);
    event FeesCollected(uint256 indexed tokenId, address indexed recipient, uint256 amount0, uint256 amount1);

    modifier onlyPositionManager() {
        require(msg.sender == IMockUniswapV3PeripheryRegistry(factory).positionManager(), "only position manager");
        _;
    }

    modifier onlySwapRouter() {
        require(msg.sender == IMockUniswapV3PeripheryRegistry(factory).swapRouter(), "only swap router");
        _;
    }

    constructor(address token0_, address token1_, uint24 fee_, int24 tickSpacing_, address factory_) {
        require(token0_ != address(0) && token1_ != address(0), "zero token");
        require(token0_ < token1_, "unsorted");
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        factory = factory_;
    }

    function initialize(uint160 sqrtPriceX96_) external {
        require(sqrtPriceX96 == 0, "already initialized");
        require(sqrtPriceX96_ != 0, "zero price");
        sqrtPriceX96 = sqrtPriceX96_;
        emit Initialize(sqrtPriceX96_);
    }

    function seedLiquidity(uint256 tokenId, uint256 amount0, uint256 amount1) external onlyPositionManager {
        require(sqrtPriceX96 != 0, "not initialized");
        require(tokenId != 0, "zero token id");
        require(amount0 != 0 && amount1 != 0, "zero liquidity");
        if (positionTokenId == 0) positionTokenId = tokenId;
        require(positionTokenId == tokenId, "single position only");

        IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
        reserve0 += amount0;
        reserve1 += amount1;

        emit LiquiditySeeded(tokenId, amount0, amount1);
    }

    function quoteExactInput(address tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        require(amountIn != 0, "zero input");
        require(tokenIn == token0 || tokenIn == token1, "bad token");
        uint256 reserveIn = tokenIn == token0 ? reserve0 : reserve1;
        uint256 reserveOut = tokenIn == token0 ? reserve1 : reserve0;
        require(reserveIn != 0 && reserveOut != 0, "empty pool");

        uint256 feeAmount = (amountIn * uint256(fee)) / FEE_DENOMINATOR;
        uint256 amountInAfterFee = amountIn - feeAmount;
        amountOut = (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
    }

    function swapExactInput(address tokenIn, uint256 amountIn, address recipient)
        external
        onlySwapRouter
        returns (uint256 amountOut, uint256 feeAmount)
    {
        require(recipient != address(0), "zero recipient");
        address tokenOut = tokenIn == token0 ? token1 : token0;
        require(tokenIn == token0 || tokenIn == token1, "bad token");

        amountOut = quoteExactInput(tokenIn, amountIn);
        feeAmount = (amountIn * uint256(fee)) / FEE_DENOMINATOR;

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenIn == token0) {
            require(reserve1 >= amountOut, "insufficient out");
            reserve0 += amountIn;
            reserve1 -= amountOut;
            claimable0 += feeAmount;
        } else {
            require(reserve0 >= amountOut, "insufficient out");
            reserve1 += amountIn;
            reserve0 -= amountOut;
            claimable1 += feeAmount;
        }
        IERC20(tokenOut).safeTransfer(recipient, amountOut);

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, feeAmount, recipient);
    }

    function collectFees(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)
        external
        onlyPositionManager
        returns (uint256 amount0, uint256 amount1)
    {
        require(tokenId == positionTokenId && tokenId != 0, "unknown position");
        require(recipient != address(0), "zero recipient");

        amount0 = claimable0 < uint256(amount0Max) ? claimable0 : uint256(amount0Max);
        amount1 = claimable1 < uint256(amount1Max) ? claimable1 : uint256(amount1Max);

        if (amount0 != 0) {
            claimable0 -= amount0;
            reserve0 -= amount0;
            IERC20(token0).safeTransfer(recipient, amount0);
        }
        if (amount1 != 0) {
            claimable1 -= amount1;
            reserve1 -= amount1;
            IERC20(token1).safeTransfer(recipient, amount1);
        }

        emit FeesCollected(tokenId, recipient, amount0, amount1);
    }
}
