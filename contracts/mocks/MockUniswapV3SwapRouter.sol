// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MockUniswapV3Factory} from "./MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

/// @dev Minimal SwapRouter02 V3 exactInputSingle surface for Robinhood staging.
contract MockUniswapV3SwapRouter {
    using SafeERC20 for IERC20;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    address public immutable factory;
    address public immutable WETH9;

    constructor(address factory_, address weth9_) {
        require(factory_ != address(0) && weth9_ != address(0), "zero dependency");
        factory = factory_;
        WETH9 = weth9_;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(msg.value == 0, "wrap native first");
        require(params.recipient != address(0), "zero recipient");
        require(params.amountIn != 0, "zero input");

        address pool = MockUniswapV3Factory(factory).getPool(params.tokenIn, params.tokenOut, params.fee);
        require(pool != address(0), "pool missing");

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenIn).forceApprove(pool, params.amountIn);
        (amountOut, ) = MockUniswapV3Pool(pool).swapExactInput(params.tokenIn, params.amountIn, params.recipient);
        IERC20(params.tokenIn).forceApprove(pool, 0);

        require(amountOut >= params.amountOutMinimum, "too little received");
    }

    function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee_, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        address pool = MockUniswapV3Factory(factory).getPool(tokenIn, tokenOut, fee_);
        require(pool != address(0), "pool missing");
        return MockUniswapV3Pool(pool).quoteExactInput(tokenIn, amountIn);
    }
}
