// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRobinhoodWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

interface IRobinhoodV3SwapRouter {
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
}

/// @notice Native ETH <-> token adapter for Robinhood Chain Uniswap-V3-compatible pools.
/// @dev Keeps the public trading UX native while the underlying pool remains WETH/token.
///      The adapter holds no principal after a successful trade and has no privileged owner path.
contract RobinhoodV3NativeSwapAdapter is ReentrancyGuard {
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

    function buyExactNativeIn(
        address tokenOut,
        uint24 fee,
        uint256 amountOutMinimum,
        address recipient
    ) external payable nonReentrant returns (uint256 amountOut) {
        require(msg.value > 0, "zero input");
        require(tokenOut != address(0) && tokenOut != address(wrappedNative), "invalid token");
        require(recipient != address(0), "zero recipient");
        require(fee > 0, "zero fee");

        wrappedNative.deposit{value: msg.value}();
        IERC20(address(wrappedNative)).forceApprove(address(swapRouter), msg.value);

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

        IERC20(address(wrappedNative)).forceApprove(address(swapRouter), 0);
        require(IERC20(address(wrappedNative)).balanceOf(address(this)) == 0, "wrapped dust");

        emit NativeBuy(msg.sender, tokenOut, fee, msg.value, amountOut, recipient);
    }

    function sellExactTokenIn(
        address tokenIn,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        address recipient
    ) external nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0, "zero input");
        require(tokenIn != address(0) && tokenIn != address(wrappedNative), "invalid token");
        require(recipient != address(0), "zero recipient");
        require(fee > 0, "zero fee");

        IERC20 token = IERC20(tokenIn);
        token.safeTransferFrom(msg.sender, address(this), amountIn);
        token.forceApprove(address(swapRouter), amountIn);

        amountOut = swapRouter.exactInputSingle(
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
        wrappedNative.withdraw(amountOut);

        (bool ok, ) = payable(recipient).call{value: amountOut}("");
        require(ok, "native transfer failed");
        require(token.balanceOf(address(this)) == 0, "token dust");
        require(IERC20(address(wrappedNative)).balanceOf(address(this)) == 0, "wrapped dust");
        require(address(this).balance == 0, "native dust");

        emit NativeSell(msg.sender, tokenIn, fee, amountIn, amountOut, recipient);
    }
}
