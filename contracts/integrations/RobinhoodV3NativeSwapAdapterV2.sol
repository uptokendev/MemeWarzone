// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRobinhoodWETH9, IRobinhoodV3SwapRouter} from "./RobinhoodV3NativeSwapAdapter.sol";

/// @notice Native ETH <-> token adapter for Robinhood Chain Uniswap-V3-compatible pools.
/// @dev Replacement for RobinhoodV3NativeSwapAdapter (docs/evm-launch/CO-IMPORT-SWAP-FEE.md appendix A.2). Same
///      external interface and events. The only behavioural change: the end-of-call checks compare against the
///      balances measured at the start of the call instead of requiring exact zero, and the sell amount is the
///      wrapped-native balance delta. A token, wrapped-native or forced native donation is ignored and stays where
///      it is; it can no longer make every later buy or sell revert. No owner, no rescue, no upgrade.
contract RobinhoodV3NativeSwapAdapterV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IRobinhoodV3SwapRouter public immutable swapRouter;
    IRobinhoodWETH9 public immutable wrappedNative;

    event NativeBuy(
        address indexed trader,
        address indexed token,
        uint24 indexed fee,
        uint256 nativeIn,
        uint256 tokenOut,
        address recipient
    );
    event NativeSell(
        address indexed trader,
        address indexed token,
        uint24 indexed fee,
        uint256 tokenIn,
        uint256 nativeOut,
        address recipient
    );

    constructor(address swapRouter_, address wrappedNative_) {
        require(swapRouter_ != address(0) && wrappedNative_ != address(0), "zero dependency");
        swapRouter = IRobinhoodV3SwapRouter(swapRouter_);
        wrappedNative = IRobinhoodWETH9(wrappedNative_);
    }

    receive() external payable {
        require(msg.sender == address(wrappedNative), "native only from WETH");
    }

    /// @param deadline Latest timestamp this swap may execute at.
    /// @return amountOut The router's reported output (the pool's transfer to `recipient`), as before.
    function buyExactNativeIn(
        address tokenOut,
        uint24 fee,
        uint256 amountOutMinimum,
        address recipient,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "deadline");
        require(msg.value > 0, "zero input");
        require(amountOutMinimum > 0, "zero minimum out");
        require(tokenOut != address(0) && tokenOut != address(wrappedNative), "invalid token");
        require(recipient != address(0), "zero recipient");
        require(recipient != address(this), "invalid recipient");
        require(fee > 0, "zero fee");

        IERC20 wrapped = IERC20(address(wrappedNative));
        uint256 wrappedBefore = wrapped.balanceOf(address(this));

        wrappedNative.deposit{value: msg.value}();
        wrapped.forceApprove(address(swapRouter), msg.value);

        amountOut = swapRouter.exactInputSingle(
            IRobinhoodV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(wrappedNative),
                tokenOut: tokenOut,
                fee: fee,
                recipient: recipient,
                amountIn: msg.value,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        wrapped.forceApprove(address(swapRouter), 0);
        // The whole input was spent: the wrapped balance is back at its start-of-call level (a donation stays).
        require(wrapped.balanceOf(address(this)) == wrappedBefore, "wrapped dust");

        emit NativeBuy(msg.sender, tokenOut, fee, msg.value, amountOut, recipient);
    }

    /// @param deadline See buyExactNativeIn.
    /// @return amountOut The native paid to `recipient`: the wrapped-native balance delta of the swap.
    function sellExactTokenIn(
        address tokenIn,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "deadline");
        require(amountIn > 0, "zero input");
        require(amountOutMinimum > 0, "zero minimum out");
        require(tokenIn != address(0) && tokenIn != address(wrappedNative), "invalid token");
        require(recipient != address(0), "zero recipient");
        require(recipient != address(this), "invalid recipient");
        require(fee > 0, "zero fee");

        IERC20 token = IERC20(tokenIn);
        IERC20 wrapped = IERC20(address(wrappedNative));
        uint256 tokenBefore = token.balanceOf(address(this));
        uint256 wrappedBefore = wrapped.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;

        token.safeTransferFrom(msg.sender, address(this), amountIn);
        // Uniswap V3 pools do not support fee-on-transfer input; requiring the full amount also means the router
        // can only ever spend the caller's tokens, never a donation.
        require(token.balanceOf(address(this)) - tokenBefore == amountIn, "token in mismatch");
        token.forceApprove(address(swapRouter), amountIn);

        swapRouter.exactInputSingle(
            IRobinhoodV3SwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: address(wrappedNative),
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        token.forceApprove(address(swapRouter), 0);
        require(token.balanceOf(address(this)) == tokenBefore, "token dust");
        amountOut = wrapped.balanceOf(address(this)) - wrappedBefore;
        require(amountOut >= amountOutMinimum, "insufficient output");

        wrappedNative.withdraw(amountOut);
        require(wrapped.balanceOf(address(this)) == wrappedBefore, "wrapped dust");
        require(address(this).balance == nativeBefore + amountOut, "native dust");

        (bool ok, ) = payable(recipient).call{value: amountOut}("");
        require(ok, "native transfer failed");

        emit NativeSell(msg.sender, tokenIn, fee, amountIn, amountOut, recipient);
    }
}
