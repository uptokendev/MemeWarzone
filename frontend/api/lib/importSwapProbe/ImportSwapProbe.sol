// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Never deployed. The import scanner places this runtime code at a throwaway address through an
 * eth_call state override, so one read-only call buys a token on its own pool with a little wrapped
 * native and sells everything it received straight back. The token's own transfer code runs both
 * ways, which pool quotes never do: transfer blocks and transfer taxes show up here.
 *
 * The sell goes through the venue's public router (approve + router pulls with transferFrom), the
 * path a wallet sell takes: a trap token can let transfer() through and block transferFrom().
 *
 * Regenerate the bytecode with `node scripts/build-import-swap-probe.mjs` (frontend/).
 */

interface IWETHLike {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}

interface IV2PairLike {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IV2RouterLike {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// SwapRouter02 (Uniswap) and SmartRouter (PancakeSwap) share this struct: no deadline field.
interface IV3RouterLike {
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

interface IV3PoolLike {
    function token0() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

contract ImportSwapProbe {
    uint8 internal constant KIND_V2 = 2;
    uint8 internal constant KIND_V3 = 3;
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128739 + 1;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970342 - 1;

    address internal activePool;

    struct Result {
        bool buyOk;
        uint256 tokenOut; // what the pool said it sent
        uint256 tokenReceived; // what arrived (buy tax = the difference)
        bool sellOk;
        uint256 tokenIntoPool; // the pool's token balance increase on the sell (sell tax = received minus this)
        uint256 nativeBack; // wrapped native returned by the sell
        bytes sellError;
    }

    function probe(uint8 kind, address pool, address router, address weth, address token, uint256 v2FeeBps, uint24 v3Fee)
        external
        payable
        returns (Result memory r)
    {
        IWETHLike(weth).deposit{value: msg.value}();
        try this.buyStep(kind, pool, weth, token, msg.value, v2FeeBps) returns (uint256 out) {
            r.buyOk = true;
            r.tokenOut = out;
        } catch {
            return r;
        }
        r.tokenReceived = IERC20Like(token).balanceOf(address(this));
        if (r.tokenReceived == 0) return r;
        uint256 nativeBefore = IWETHLike(weth).balanceOf(address(this));
        uint256 poolBefore = IERC20Like(token).balanceOf(pool);
        try this.sellStep(kind, router, weth, token, r.tokenReceived, v3Fee) {
            r.sellOk = true;
            uint256 poolAfter = IERC20Like(token).balanceOf(pool);
            r.tokenIntoPool = poolAfter > poolBefore ? poolAfter - poolBefore : 0;
            r.nativeBack = IWETHLike(weth).balanceOf(address(this)) - nativeBefore;
        } catch (bytes memory err) {
            r.sellError = err;
        }
    }

    /// External only so probe() can try/catch it; reachable by this contract alone.
    function buyStep(uint8 kind, address pool, address weth, address token, uint256 amountIn, uint256 v2FeeBps)
        external
        returns (uint256 tokenOut)
    {
        require(msg.sender == address(this), "self");
        if (kind == KIND_V2) {
            require(IWETHLike(weth).transfer(pool, amountIn), "weth");
            return _v2SwapOut(pool, weth, v2FeeBps);
        }
        require(kind == KIND_V3, "kind");
        bool zeroForOne = IV3PoolLike(pool).token0() == weth;
        (int256 a0, int256 a1) = _v3Swap(pool, zeroForOne, amountIn, weth);
        int256 out = zeroForOne ? a1 : a0;
        return uint256(-out);
    }

    /// Sells like a wallet does: approve the public router, the router pulls with transferFrom.
    function sellStep(uint8 kind, address router, address weth, address token, uint256 amountIn, uint24 v3Fee) external {
        require(msg.sender == address(this), "self");
        _approve(token, router, amountIn);
        if (kind == KIND_V2) {
            address[] memory path = new address[](2);
            path[0] = token;
            path[1] = weth;
            IV2RouterLike(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, 0, path, address(this), block.timestamp);
            return;
        }
        require(kind == KIND_V3, "kind");
        IV3RouterLike(router).exactInputSingle(
            IV3RouterLike.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: weth,
                fee: v3Fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// Buys straight on the pair with the wrapped native already sent to it.
    function _v2SwapOut(address pair, address tokenIn, uint256 feeBps) internal returns (uint256 amountOut) {
        (uint112 r0, uint112 r1,) = IV2PairLike(pair).getReserves();
        bool inIs0 = IV2PairLike(pair).token0() == tokenIn;
        uint256 reserveIn = inIs0 ? r0 : r1;
        uint256 reserveOut = inIs0 ? r1 : r0;
        uint256 amountIn = IERC20Like(tokenIn).balanceOf(pair) - reserveIn;
        uint256 withFee = amountIn * (10000 - feeBps);
        amountOut = (withFee * reserveOut) / (reserveIn * 10000 + withFee);
        // 0.1% under the curve, so a fee rounding difference never fails the pair's K check.
        amountOut = (amountOut * 999) / 1000;
        require(amountOut > 0, "zero out");
        IV2PairLike(pair).swap(inIs0 ? 0 : amountOut, inIs0 ? amountOut : 0, address(this), "");
    }

    function _v3Swap(address pool, bool zeroForOne, uint256 amountIn, address payToken)
        internal
        returns (int256 a0, int256 a1)
    {
        activePool = pool;
        (a0, a1) = IV3PoolLike(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            abi.encode(payToken)
        );
        activePool = address(0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    function _v3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        require(msg.sender == activePool && activePool != address(0), "pool");
        address payToken = abi.decode(data, (address));
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        _pay(payToken, msg.sender, owed);
    }

    /// Tolerates tokens whose transfer returns nothing.
    function _pay(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer");
    }

    /// Same tolerance for approve.
    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "approve");
    }
}
