// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IImportWrappedNative is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

/// @notice Uniswap SwapRouter02 `exactInputSingle` (no deadline field), as Robinhood's 0xCaf681a6.
interface IImportV3SwapRouter {
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

/// @notice The Topaz (Solidly-style) router subset: routes carry (from, to, stable, factory).
interface IImportV2SolidlyRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function defaultFactory() external view returns (address);
    function weth() external view returns (address);

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external payable;

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external;
}

/// @title ImportSwapFeeRouter
/// @notice Change order CO-IMP (docs/evm-launch/CO-IMPORT-SWAP-FEE.md): native <-> token swaps for IMPORTED coins
/// with a fee on the native side, split between the protocol and the coin's creator receiver. Not used by the
/// launchpad (create / buy / sell, campaigns, graduation) or by post-graduation trading.
/// @dev No owner, no admin, no upgrade, no rescue. Fee bps, receivers and venues are immutable; a change is a new
/// deploy. The contract holds nothing between calls. Every amount is measured as a balance delta, never as an
/// absolute balance, so a token or native donation can neither move an amount nor block a call (the exact-zero
/// leftover checks of RobinhoodV3NativeSwapAdapter would let a 1-wei donation brick sells of that token forever).
///
/// Fee: buys `msg.value * (protocolBps + creatorBps) / 10_000` taken before the swap; sells the same share of the
/// native the swap returned, taken after it. Creator share `amount * creatorBps / 10_000`, protocol = fee - creator,
/// so rounding goes to the protocol. `fee > 0` is required, so dust cannot trade fee-free.
contract ImportSwapFeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_BPS = 10_000;
    /// @notice The combined fee may not exceed 1% (CO-IMP I1).
    uint256 public constant MAX_TOTAL_FEE_BPS = 100;
    uint8 public constant VENUE_V2 = 2;
    uint8 public constant VENUE_V3 = 3;

    error ZeroAddress();
    error FeeTooHigh();
    error FeeZero();
    error NoVenue();
    error VenueNotConfigured();
    error WrappedNativeMismatch();
    error DeadlineExpired();
    error ZeroInput();
    error ZeroMinimumOut();
    error InvalidToken();
    error InsufficientOutput();
    error NativeTransferFailed();
    error UnexpectedNativeSender();
    error LeftoverBalance();

    IImportWrappedNative public immutable wrappedNative;
    address public immutable protocolReceiver;
    address public immutable creatorReceiver;
    uint256 public immutable protocolBps;
    uint256 public immutable creatorBps;
    IImportV3SwapRouter public immutable v3Router;
    IImportV2SolidlyRouter public immutable v2Router;
    /// @notice The pool factory every V2 route uses (v2Router.defaultFactory() at deploy), so a caller cannot route
    /// through a factory of their choosing.
    address public immutable v2Factory;
    uint256 public immutable deployedChainId;

    event ImportSwap(
        address indexed trader,
        address indexed token,
        uint8 venue,
        bool isBuy,
        uint256 nativeGross,
        uint256 feeProtocol,
        uint256 feeCreator,
        uint256 tokenAmount,
        address recipient
    );

    constructor(
        address wrappedNative_,
        address protocolReceiver_,
        address creatorReceiver_,
        uint256 protocolBps_,
        uint256 creatorBps_,
        address v3Router_,
        address v2Router_
    ) {
        if (wrappedNative_ == address(0) || protocolReceiver_ == address(0) || creatorReceiver_ == address(0)) {
            revert ZeroAddress();
        }
        if (protocolBps_ + creatorBps_ > MAX_TOTAL_FEE_BPS) revert FeeTooHigh();
        if (protocolBps_ + creatorBps_ == 0) revert FeeZero();
        if (v3Router_ == address(0) && v2Router_ == address(0)) revert NoVenue();
        address factory_;
        if (v2Router_ != address(0)) {
            if (IImportV2SolidlyRouter(v2Router_).weth() != wrappedNative_) revert WrappedNativeMismatch();
            factory_ = IImportV2SolidlyRouter(v2Router_).defaultFactory();
            if (factory_ == address(0)) revert ZeroAddress();
        }
        wrappedNative = IImportWrappedNative(wrappedNative_);
        protocolReceiver = protocolReceiver_;
        creatorReceiver = creatorReceiver_;
        protocolBps = protocolBps_;
        creatorBps = creatorBps_;
        v3Router = IImportV3SwapRouter(v3Router_);
        v2Router = IImportV2SolidlyRouter(v2Router_);
        v2Factory = factory_;
        deployedChainId = block.chainid;
    }

    /// @dev Native arrives only from the wrapped-native unwrap (V3 sells) or the V2 router (V2 sells).
    receive() external payable {
        if (msg.sender != address(wrappedNative) && msg.sender != address(v2Router)) revert UnexpectedNativeSender();
    }

    // ---------------------------------------------------------------- views

    /// @notice (protocol, creator) fee for a native amount: the same split every swap applies.
    function feeSplit(uint256 nativeAmount) public view returns (uint256 feeProtocol, uint256 feeCreator) {
        uint256 fee = (nativeAmount * (protocolBps + creatorBps)) / MAX_BPS;
        feeCreator = (nativeAmount * creatorBps) / MAX_BPS;
        feeProtocol = fee - feeCreator;
    }

    // ---------------------------------------------------------------- buys

    /// @notice Buy `token` with native on a Uniswap-V3-style pool (fee tier `poolFee`).
    /// @param minTokensOut Checked on the recipient's balance delta (fee-on-transfer tokens included).
    function buyV3(address token, uint24 poolFee, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (address(v3Router) == address(0)) revert VenueNotConfigured();
        (uint256 swapIn, uint256 feeProtocol, uint256 feeCreator) = _checkBuy(token, minTokensOut, recipient, deadline);
        uint256 before = IERC20(token).balanceOf(recipient);
        uint256 wrappedBefore = IERC20(address(wrappedNative)).balanceOf(address(this));

        wrappedNative.deposit{value: swapIn}();
        IERC20(address(wrappedNative)).forceApprove(address(v3Router), swapIn);
        v3Router.exactInputSingle(
            IImportV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(wrappedNative),
                tokenOut: token,
                fee: poolFee,
                recipient: recipient,
                amountIn: swapIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(address(wrappedNative)).forceApprove(address(v3Router), 0);
        if (IERC20(address(wrappedNative)).balanceOf(address(this)) != wrappedBefore) revert LeftoverBalance();

        tokensOut = IERC20(token).balanceOf(recipient) - before;
        if (tokensOut < minTokensOut) revert InsufficientOutput();
        _payFees(feeProtocol, feeCreator);
        emit ImportSwap(msg.sender, token, VENUE_V3, true, msg.value, feeProtocol, feeCreator, tokensOut, recipient);
    }

    /// @notice Buy `token` with native on the Topaz (Solidly-style) pool `stable` of v2Factory.
    function buyV2(address token, bool stable, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (address(v2Router) == address(0)) revert VenueNotConfigured();
        (uint256 swapIn, uint256 feeProtocol, uint256 feeCreator) = _checkBuy(token, minTokensOut, recipient, deadline);
        uint256 before = IERC20(token).balanceOf(recipient);
        uint256 nativeBefore = address(this).balance - msg.value;

        v2Router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: swapIn}(
            0, _route(address(wrappedNative), token, stable), recipient, deadline
        );
        // The router spends exactly swapIn; only the fee stays here, and it leaves in _payFees.
        if (address(this).balance != nativeBefore + feeProtocol + feeCreator) revert LeftoverBalance();

        tokensOut = IERC20(token).balanceOf(recipient) - before;
        if (tokensOut < minTokensOut) revert InsufficientOutput();
        _payFees(feeProtocol, feeCreator);
        emit ImportSwap(msg.sender, token, VENUE_V2, true, msg.value, feeProtocol, feeCreator, tokensOut, recipient);
    }

    // ---------------------------------------------------------------- sells

    /// @notice Sell `amountIn` of `token` for native on a Uniswap-V3-style pool. `minNativeOut` is checked on the
    /// amount the recipient gets, after the fee.
    function sellV3(
        address token,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minNativeOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 nativeOut) {
        if (address(v3Router) == address(0)) revert VenueNotConfigured();
        (uint256 received, uint256 tokenBefore) = _pullForSell(token, amountIn, minNativeOut, recipient, deadline);
        uint256 nativeBefore = address(this).balance;
        uint256 wrappedBefore = IERC20(address(wrappedNative)).balanceOf(address(this));

        IERC20(token).forceApprove(address(v3Router), received);
        v3Router.exactInputSingle(
            IImportV3SwapRouter.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: address(wrappedNative),
                fee: poolFee,
                recipient: address(this),
                amountIn: received,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(token).forceApprove(address(v3Router), 0);
        uint256 gross = IERC20(address(wrappedNative)).balanceOf(address(this)) - wrappedBefore;
        wrappedNative.withdraw(gross);
        if (address(this).balance != nativeBefore + gross) revert LeftoverBalance();

        nativeOut = _settleSell(token, VENUE_V3, gross, received, tokenBefore, minNativeOut, recipient);
    }

    /// @notice Sell `amountIn` of `token` for native on the Topaz pool `stable` of v2Factory.
    function sellV2(
        address token,
        bool stable,
        uint256 amountIn,
        uint256 minNativeOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 nativeOut) {
        if (address(v2Router) == address(0)) revert VenueNotConfigured();
        (uint256 received, uint256 tokenBefore) = _pullForSell(token, amountIn, minNativeOut, recipient, deadline);
        uint256 nativeBefore = address(this).balance;

        IERC20(token).forceApprove(address(v2Router), received);
        v2Router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            received, 0, _route(token, address(wrappedNative), stable), address(this), deadline
        );
        IERC20(token).forceApprove(address(v2Router), 0);
        uint256 gross = address(this).balance - nativeBefore;

        nativeOut = _settleSell(token, VENUE_V2, gross, received, tokenBefore, minNativeOut, recipient);
    }

    // ---------------------------------------------------------------- internals

    function _checkBuy(address token, uint256 minTokensOut, address recipient, uint256 deadline)
        internal
        view
        returns (uint256 swapIn, uint256 feeProtocol, uint256 feeCreator)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (msg.value == 0) revert ZeroInput();
        if (minTokensOut == 0) revert ZeroMinimumOut();
        if (token == address(0) || token == address(wrappedNative)) revert InvalidToken();
        if (recipient == address(0)) revert ZeroAddress();
        (feeProtocol, feeCreator) = feeSplit(msg.value);
        if (feeProtocol + feeCreator == 0) revert FeeZero();
        swapIn = msg.value - feeProtocol - feeCreator;
    }

    /// @dev Pulls `amountIn` and returns what actually arrived (fee-on-transfer tokens deliver less). Every token
    /// this contract holds before the call (a donation) is left out of the amount and stays where it is.
    function _pullForSell(address token, uint256 amountIn, uint256 minNativeOut, address recipient, uint256 deadline)
        internal
        returns (uint256 received, uint256 before)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amountIn == 0) revert ZeroInput();
        if (minNativeOut == 0) revert ZeroMinimumOut();
        if (token == address(0) || token == address(wrappedNative)) revert InvalidToken();
        if (recipient == address(0)) revert ZeroAddress();
        before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroInput();
    }

    /// @dev After a sell swap: every pulled token must have left (the balance is back to its pre-pull level; a
    /// donation made before the call stays untouched), then the fee is taken from `gross`, the recipient is paid
    /// (checked against `minNativeOut`), then the two fees.
    function _settleSell(
        address token,
        uint8 venue,
        uint256 gross,
        uint256 received,
        uint256 tokenBefore,
        uint256 minNativeOut,
        address recipient
    ) internal returns (uint256 nativeOut) {
        if (IERC20(token).balanceOf(address(this)) != tokenBefore) revert LeftoverBalance();
        (uint256 feeProtocol, uint256 feeCreator) = feeSplit(gross);
        if (feeProtocol + feeCreator == 0) revert FeeZero();
        nativeOut = gross - feeProtocol - feeCreator;
        if (nativeOut < minNativeOut) revert InsufficientOutput();
        _sendNative(recipient, nativeOut);
        _payFees(feeProtocol, feeCreator);
        emit ImportSwap(msg.sender, token, venue, false, gross, feeProtocol, feeCreator, received, recipient);
    }

    function _payFees(uint256 feeProtocol, uint256 feeCreator) internal {
        if (feeProtocol != 0) _sendNative(protocolReceiver, feeProtocol);
        if (feeCreator != 0) _sendNative(creatorReceiver, feeCreator);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    function _route(address from, address to, bool stable) internal view returns (IImportV2SolidlyRouter.Route[] memory routes) {
        routes = new IImportV2SolidlyRouter.Route[](1);
        routes[0] = IImportV2SolidlyRouter.Route({from: from, to: to, stable: stable, factory: v2Factory});
    }
}
