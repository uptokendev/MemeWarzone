// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRobinhoodV3QuoterFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IRobinhoodV3QuoterPool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @notice Single-hop exact-input quoter for Robinhood Chain Uniswap-V3-compatible pools.
/// @dev The live 46630 swap router is a real SwapRouter02, which exposes no quoting at all
///      (the staged mock router did, which is why quoting only ever worked there). This
///      restores quoting the way Uniswap does it: simulate the swap, then revert with the
///      result so nothing is ever settled.
///
///      Every entry point is non-view because the simulation calls a state-mutating pool
///      method. Callers quote with eth_call / staticCall, so no balance, allowance or
///      approval is required and no state can change.
contract RobinhoodV3Quoter {
    /// @dev Uniswap's own bounds; the swap must be allowed to move price freely.
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970342 - 1;

    IRobinhoodV3QuoterFactory public immutable factory;

    error PoolNotFound();
    error UnexpectedCallback();
    error QuoteFailed();

    constructor(address factory_) {
        require(factory_ != address(0), "zero factory");
        factory = IRobinhoodV3QuoterFactory(factory_);
    }

    /// @notice Exact-input quote for one pool hop.
    /// @dev Signature matches what the frontend already calls on the staged mock router,
    ///      so only the target address changes.
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn
    ) external returns (uint256 amountOut) {
        if (amountIn == 0 || amountIn > uint256(type(int256).max)) revert QuoteFailed();
        address pool = factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0) || pool.code.length == 0) revert PoolNotFound();

        bool zeroForOne = tokenIn < tokenOut;
        try
            IRobinhoodV3QuoterPool(pool).swap(
                address(this),
                zeroForOne,
                int256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                abi.encode(pool)
            )
        {
            // The callback always reverts, so a plain return means this is not a
            // conforming V3 pool. Never report a quote we did not actually compute.
            revert QuoteFailed();
        } catch (bytes memory reason) {
            return _decodeRevertedAmount(reason);
        }
    }

    /// @dev Reached inside the simulated swap. Reverting here unwinds the swap, so the
    ///      pool is never actually traded against.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external view {
        address pool = abi.decode(data, (address));
        if (msg.sender != pool) revert UnexpectedCallback();

        // The negative delta is what the pool would pay out.
        int256 outDelta = amount0Delta < amount1Delta ? amount0Delta : amount1Delta;
        if (outDelta >= 0) revert QuoteFailed();
        uint256 amountOut = uint256(-outDelta);

        assembly {
            let ptr := mload(0x40)
            mstore(ptr, amountOut)
            revert(ptr, 32)
        }
    }

    function _decodeRevertedAmount(bytes memory reason) private pure returns (uint256) {
        // Anything other than our own 32-byte payload is a real failure (for example an
        // insufficient-liquidity revert) and must not be reported as a zero quote.
        if (reason.length != 32) revert QuoteFailed();
        return abi.decode(reason, (uint256));
    }
}
