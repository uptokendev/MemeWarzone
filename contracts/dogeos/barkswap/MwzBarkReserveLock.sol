// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAlgebraPoolState} from "./interfaces/core/pool/IAlgebraPoolState.sol";
import {MwzBarkLauncher} from "./MwzBarkLauncher.sol";
import {MwzBarkPlugin} from "./MwzBarkPlugin.sol";

interface IMwzBarkChoiceVaultCreator {
    function creatorOf(address coin) external view returns (address);
}

/// @title MwzBarkReserveLock (EVM generation 8 on Barkswap, DogeOS; gen-8 MwzReserveLock, D6 option R2)
/// @notice Holds each coin's 2% creator reserve (20M coins) from launch until graduation, then releases it in one
/// step, as gen-7 does (LaunchCampaignGen7 sends the reserve to the creator at graduation, no vesting).
/// `release` is permissionless once (1) the plugin's graduation latch is set, (2) the coin's Algebra pool is not
/// mid-swap (its reentrancy lock, `globalState().unlocked`, is free: the price must not be a mid-operation price read
/// from inside someone's swap, mint, burn or flash callback), (3) the pool price is at or past the graduation price at
/// release time (F1: a graduation forced by a buy-and-sell-back cannot release the reserve while the price sits back
/// inside A), and (4) at least RESERVE_RELEASE_DELAY (1 h) has passed since the latch (F1 residual, founder go
/// 2026-10-12: a same-block bundle "buy to the graduation price, release, sell back" can no longer release it). It
/// pays the coin's current creator: the launcher's `feeCreator` (after a two-step creator transfer, the new one), or
/// for a holders / split / buyback coin (whose `feeCreator` is the choice vault) the human creator recorded in that
/// vault. Keyed by coin (gen-8 keyed by V4 PoolId; one pool per coin here). Diff audit against gen-8's
/// MwzReserveLock: docs/dogeos/barkswap-audit.md (MwzBarkReserveLock).
/// No owner, no admin, no other way out.
contract MwzBarkReserveLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error OnlyLauncher();
    error ZeroAddress();
    error AlreadyLocked();
    error NotFunded();
    error NothingLocked();
    error NotGraduated();
    error BadAmount();
    error PriceBelowGraduation();
    error PoolBusy();
    error ReserveTooEarly();

    /// @notice Minimum time between the plugin's graduation latch and a release. A constant: it is part of the
    /// contract's rules, not a deploy parameter, and the same on every chain.
    uint256 public constant RESERVE_RELEASE_DELAY = 1 hours;

    struct Reserve {
        address token; // the coin itself; set once at lock and never cleared (the "locked once" marker)
        uint96 amount; // 20M * 1e18 = 2e25 < 2^96
    }

    /// @notice The MwzBarkLauncher (predicted address; the launcher checks `launcher()` in its constructor). The plugin
    /// and the choice vault are read from it at release, so they can never disagree with the launcher's own wiring.
    MwzBarkLauncher public immutable launcher;

    mapping(address coin => Reserve) public reserves;

    event ReserveLocked(address indexed coin, uint256 amount);
    event ReserveReleased(address indexed coin, address indexed to, uint256 amount);

    /// @param launcher_ the MwzBarkLauncher address (predicted; the launcher checks the wiring in its constructor).
    constructor(MwzBarkLauncher launcher_) {
        if (address(launcher_) == address(0)) revert ZeroAddress();
        launcher = launcher_;
    }

    /// @notice Launcher only, in the launch transaction, after it transferred `amount` of the new coin here. The coin
    /// is brand new (deployed in the same transaction), so this contract's balance of it is exactly this reserve.
    function lock(address coin, uint256 amount) external {
        if (msg.sender != address(launcher)) revert OnlyLauncher();
        if (reserves[coin].token != address(0)) revert AlreadyLocked();
        if (coin == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > type(uint96).max) revert BadAmount();
        if (IERC20(coin).balanceOf(address(this)) < amount) revert NotFunded();
        reserves[coin] = Reserve({token: coin, amount: uint96(amount)});
        emit ReserveLocked(coin, amount);
    }

    /// @notice Who `release` pays now: the launcher's `feeCreator` of the coin, or the human creator recorded in the
    /// choice vault when that is the vault. address(0) for an unknown coin.
    function beneficiaryOf(address coin) public view returns (address to) {
        (,,,,, to,,,,) = launcher.launches(coin);
        address vault = address(launcher.choiceVault());
        if (to == vault) to = IMwzBarkChoiceVaultCreator(vault).creatorOf(coin);
    }

    /// @notice Permissionless once the coin graduated at least RESERVE_RELEASE_DELAY ago and its price is at or past
    /// the graduation price now. nonReentrant; CEI: checks (all views), the reserve is zeroed, then the transfer (our
    /// plain ERC20, last call).
    function release(address coin) external nonReentrant returns (uint256 amount) {
        Reserve storage r = reserves[coin];
        amount = r.amount;
        if (amount == 0) revert NothingLocked();
        (address pool,,,,,,,,,) = launcher.launches(coin);
        MwzBarkPlugin plugin = launcher.plugin();
        (uint160 sqrtGrad,, bool graduated, uint40 graduatedAt,,,,,) = plugin.pools(pool);
        if (!graduated) revert NotGraduated();
        (uint160 sqrtP,,,,, bool unlocked) = IAlgebraPoolState(pool).globalState();
        if (!unlocked) revert PoolBusy();
        // Barkswap price is WDOGE per coin (coin = token0): at or past the graduation price means sqrtP >= sqrtGrad
        if (sqrtP < sqrtGrad) revert PriceBelowGraduation();
        if (block.timestamp < uint256(graduatedAt) + RESERVE_RELEASE_DELAY) revert ReserveTooEarly();
        address to = beneficiaryOf(coin);
        if (to == address(0)) revert ZeroAddress();
        r.amount = 0;
        IERC20(r.token).safeTransfer(to, amount);
        emit ReserveReleased(coin, to, amount);
    }
}
