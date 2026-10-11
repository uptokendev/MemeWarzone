// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FeeConfig, IMwzLaunchHook} from "./interfaces/IMwzLaunchHook.sol";

interface IMwzChoiceVaultCreator {
    function creatorOf(PoolId id) external view returns (address);
}

/// @title MwzReserveLock (EVM generation 8, D6 option R2)
/// @notice Holds each coin's 2% creator reserve (20M coins) from launch until graduation, then releases it in one
/// step, as gen-7 does (LaunchCampaignGen7 sends the reserve to the creator at graduation, no vesting).
/// `release` is permissionless once the hook's graduation latch is set and pays the coin's current creator: the
/// hook creator, or for a holders / split / buyback coin (whose hook creator is the choice vault) the human creator
/// recorded in that vault. No owner, no admin, no other way out.
contract MwzReserveLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error OnlyLauncher();
    error ZeroAddress();
    error AlreadyLocked();
    error NotFunded();
    error NothingLocked();
    error NotGraduated();
    error BadAmount();

    struct Reserve {
        address token;
        uint96 amount; // 20M * 1e18 = 2e25 < 2^96
    }

    IMwzLaunchHook public immutable hook;
    address public immutable launcher;
    IMwzChoiceVaultCreator public immutable choiceVault;

    mapping(PoolId => Reserve) public reserves;

    event ReserveLocked(PoolId indexed id, address indexed token, uint256 amount);
    event ReserveReleased(PoolId indexed id, address indexed token, address indexed to, uint256 amount);

    /// @param launcher_ the MwzV4Launcher address (predicted; the launcher checks the wiring in its constructor).
    constructor(IMwzLaunchHook hook_, address launcher_, IMwzChoiceVaultCreator choiceVault_) {
        if (address(hook_) == address(0) || launcher_ == address(0) || address(choiceVault_) == address(0)) revert ZeroAddress();
        hook = hook_;
        launcher = launcher_;
        choiceVault = choiceVault_;
    }

    /// @notice Launcher only, in the launch transaction, after it transferred `amount` of the new coin here. The coin
    /// is brand new (deployed in the same transaction), so this contract's balance of it is exactly this reserve.
    function lock(PoolId id, address token, uint256 amount) external {
        if (msg.sender != launcher) revert OnlyLauncher();
        if (reserves[id].token != address(0)) revert AlreadyLocked();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > type(uint96).max) revert BadAmount();
        if (IERC20(token).balanceOf(address(this)) < amount) revert NotFunded();
        reserves[id] = Reserve({token: token, amount: uint96(amount)});
        emit ReserveLocked(id, token, amount);
    }

    function beneficiaryOf(PoolId id) public view returns (address to) {
        (to,,,,,,,,) = hook.pools(id);
        if (to == address(choiceVault)) to = choiceVault.creatorOf(id);
    }

    /// @notice Permissionless once the coin graduated. nonReentrant; CEI: the reserve is zeroed before the transfer.
    function release(PoolId id) external nonReentrant returns (uint256 amount) {
        Reserve storage r = reserves[id];
        amount = r.amount;
        if (amount == 0) revert NothingLocked();
        (,, bool graduated,,,,,,) = hook.pools(id);
        if (!graduated) revert NotGraduated();
        address to = beneficiaryOf(id);
        if (to == address(0)) revert ZeroAddress();
        r.amount = 0;
        IERC20(r.token).safeTransfer(to, amount);
        emit ReserveReleased(id, r.token, to, amount);
    }
}
