// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWrappedNativeForForwarder {
    function balanceOf(address account) external view returns (uint256);
    function withdraw(uint256 amount) external;
}

interface INativeSinkAdmin {
    function admin() external view returns (address);
}

/// @title ProtocolRevenueForwarder
/// @notice TreasuryRouterV4's `protocolRevenueVault`. It holds nothing between calls and adds one hop in
///         front of the existing ProtocolRevenueVault (`nativeSink`), so the LP protocol 20% that the
///         permanent lockers route as wrapped native (WBNB on BNB 56, WETH on Robinhood 4663) reaches the
///         same place as the trade-fee protocol share: the vault's operator fill, overflow to the Safe.
///
///         Native in (router trade/finalize/LP-native route): `receive()` forwards exactly `msg.value` to the
///         sink in the same call and reverts if the sink reverts, the same strictness the router sees today.
///         Wrapped native in (router `routeLpToken`, a plain ERC20 transfer with no callback): it sits here
///         until anyone calls `flush()`, which unwraps the whole wrapped balance and forwards the whole native
///         balance to the sink. Any other ERC20 (a quote or stock token on a quote-bound pool, or a token sent
///         here by mistake) leaves only to `admin` through `withdrawToken`.
///
/// @dev Stateless apart from OpenZeppelin's reentrancy flag: three immutables, no setters, no pause, no
///      fallback (a call with data reverts). Rollback is the router's own timelocked
///      propose/accept of the old vault; nothing here needs to be migrated.
///      The unwrap leg: WBNB (WETH9) pays out with `transfer`, i.e. a 2300 gas stipend, so the
///      `msg.sender == wrappedNative` branch of `receive()` does no storage write, no event and no call.
///      Robinhood's WETH (an upgradeable aeWETH proxy) pays out with a full-gas call; the same branch
///      applies. Native that arrives through that branch outside `flush()` (aeWETH `withdrawTo(this, x)`
///      by a third party) and native forced in by selfdestruct both leave through the next `flush()`.
contract ProtocolRevenueForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The Safe. Only it can pull a non-native token out, and only to itself.
    address public immutable admin;
    /// @notice The existing ProtocolRevenueVault. Every native unit that enters leaves to this address.
    address public immutable nativeSink;
    /// @notice WBNB (56) or WETH (4663): the token the lockers route as the LP protocol share.
    address public immutable wrappedNative;

    /// @notice Native forwarded to the sink by `receive()` (router trade, finalize and LP-native routes).
    event Forwarded(address indexed from, uint256 amount);
    /// @notice `flush()` unwrapped `unwrapped` wrapped native and forwarded `forwarded` native to the sink.
    event Flushed(address indexed caller, uint256 unwrapped, uint256 forwarded);
    /// @notice `withdrawToken` sent `amount` of `token` to `admin` (the amount requested, before any
    ///         fee-on-transfer the token itself takes).
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotContract(address account);
    error InvalidSink();
    error SinkAdminMismatch(address sinkAdmin);
    error ZeroAmount();
    error NothingToFlush();
    error UnwrapShortfall(uint256 expected, uint256 received);
    error SinkRejected();
    error OnlyAdmin();

    constructor(address admin_, address nativeSink_, address wrappedNative_) {
        if (admin_ == address(0) || nativeSink_ == address(0) || wrappedNative_ == address(0)) revert ZeroAddress();
        if (nativeSink_ == address(this) || wrappedNative_ == address(this) || admin_ == address(this)) revert InvalidSink();
        if (nativeSink_ == wrappedNative_) revert InvalidSink();
        if (nativeSink_.code.length == 0) revert NotContract(nativeSink_);
        if (wrappedNative_.code.length == 0) revert NotContract(wrappedNative_);
        // The sink must be administered by the same Safe: a forwarder pointed at someone else's vault would
        // hand them the protocol share. ProtocolRevenueVault exposes `admin()` (NativeTreasuryVaultBase);
        // a sink without it reverts here, which is the intended refusal.
        address sinkAdmin = INativeSinkAdmin(nativeSink_).admin();
        if (sinkAdmin != admin_) revert SinkAdminMismatch(sinkAdmin);
        admin = admin_;
        nativeSink = nativeSink_;
        wrappedNative = wrappedNative_;
    }

    /// @notice Native in. From the wrapped-native contract (the unwrap leg of `flush()`): accept and do nothing,
    ///         within WETH9's 2300 gas stipend. From anyone else: forward exactly `msg.value` to the sink now.
    /// @dev Not `nonReentrant` on purpose: the unwrap leg must be accepted while `flush()` holds the guard.
    ///      The forwarding branch touches no storage and forwards only `msg.value`, never the balance, so a
    ///      re-entry through it (the sink's operator or overflow treasury sending value back) cannot move
    ///      anything that was not sent in that same call.
    receive() external payable {
        if (msg.sender == wrappedNative) return;
        if (msg.value == 0) revert ZeroAmount();
        _sendToSink(msg.value);
        emit Forwarded(msg.sender, msg.value);
    }

    /// @notice Permissionless: unwrap the whole wrapped-native balance and forward the whole native balance to
    ///         the sink. Reverts when there is nothing to move, or when the sink rejects the value.
    /// @return unwrapped wrapped native unwrapped in this call
    /// @return forwarded native sent to the sink in this call
    function flush() external nonReentrant returns (uint256 unwrapped, uint256 forwarded) {
        unwrapped = IWrappedNativeForForwarder(wrappedNative).balanceOf(address(this));
        if (unwrapped != 0) {
            uint256 before = address(this).balance;
            IWrappedNativeForForwarder(wrappedNative).withdraw(unwrapped);
            uint256 received = address(this).balance - before;
            if (received < unwrapped) revert UnwrapShortfall(unwrapped, received);
        }
        forwarded = address(this).balance;
        if (forwarded == 0) revert NothingToFlush();
        _sendToSink(forwarded);
        emit Flushed(msg.sender, unwrapped, forwarded);
    }

    /// @notice Admin only, recipient fixed to `admin`: move an ERC20 out. Meant for quote / stock tokens
    ///         routed by quote-bound pools, and for anything sent here by mistake. Wrapped native is not
    ///         excluded, so the Safe can still recover it if the wrapped-native contract ever stops paying
    ///         out on `withdraw` (Robinhood's WETH is an upgradeable proxy); in normal operation wrapped
    ///         native leaves through `flush()` so it counts toward the operator fill.
    function withdrawToken(address token, uint256 amount) external nonReentrant {
        if (msg.sender != admin) revert OnlyAdmin();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(admin, amount);
        emit TokenWithdrawn(token, admin, amount);
    }

    function _sendToSink(uint256 amount) private {
        (bool ok, ) = nativeSink.call{value: amount}("");
        if (!ok) revert SinkRejected();
    }
}
