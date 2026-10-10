// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// TEST ONLY. Never deployed to any network. Used by test/MuchfiFork.facts.spec.ts on a Hardhat fork of DogeOS
// Chikyū (6281971) to prove which swap callback MuchFi pools call and how their slot0 decodes.

interface IMuchfiForkTestPool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @dev Swaps directly on one pool and pays the pool from its own token balance. The two subclasses differ
///      ONLY in the callback function name, so a revert in one and success in the other proves the name.
abstract contract MuchfiForkSwapCallerBase {
    address public immutable pool;
    address public immutable token0;
    address public immutable token1;

    constructor(address pool_) {
        pool = pool_;
        token0 = IMuchfiForkTestPool(pool_).token0();
        token1 = IMuchfiForkTestPool(pool_).token1();
    }

    function swapExactIn(bool zeroForOne, uint256 amountIn, uint160 sqrtPriceLimitX96)
        external
        returns (int256 amount0, int256 amount1)
    {
        (amount0, amount1) = IMuchfiForkTestPool(pool).swap(msg.sender, zeroForOne, int256(amountIn), sqrtPriceLimitX96, "");
    }

    function _pay(int256 amount0Delta, int256 amount1Delta) internal {
        require(msg.sender == pool, "not pool");
        if (amount0Delta > 0) require(IERC20(token0).transfer(pool, uint256(amount0Delta)), "pay0");
        if (amount1Delta > 0) require(IERC20(token1).transfer(pool, uint256(amount1Delta)), "pay1");
    }
}

/// @dev Implements only the Uniswap V3 callback name (what our audited originals implement).
contract MuchfiForkUniswapCallbackCaller is MuchfiForkSwapCallerBase {
    constructor(address pool_) MuchfiForkSwapCallerBase(pool_) {}

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _pay(amount0Delta, amount1Delta);
    }
}

/// @dev Implements only the MuchFi callback name.
contract MuchfiForkMuchfiCallbackCaller is MuchfiForkSwapCallerBase {
    constructor(address pool_) MuchfiForkSwapCallerBase(pool_) {}

    function muchfiV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _pay(amount0Delta, amount1Delta);
    }
}

/// @dev slot0 as our originals declare it (`uint8 feeProtocol`, e.g. RobinhoodV3PoolRepair.IRhV3Pool).
interface IMuchfiForkSlot0Uint8 {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @dev slot0 as MuchFi (PancakeV3) returns it (`uint32 feeProtocol`).
interface IMuchfiForkSlot0Uint32 {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool);
}

contract MuchfiForkSlot0Probe {
    function feeProtocolAsUint8(address pool) external view returns (uint8 feeProtocol) {
        (,,,,, feeProtocol,) = IMuchfiForkSlot0Uint8(pool).slot0();
    }

    function feeProtocolAsUint32(address pool) external view returns (uint32 feeProtocol) {
        (,,,,, feeProtocol,) = IMuchfiForkSlot0Uint32(pool).slot0();
    }
}
