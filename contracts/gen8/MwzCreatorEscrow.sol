// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IMwzLaunchHook} from "./interfaces/IMwzLaunchHook.sol";

/// @title MwzCreatorEscrow (EVM generation 8, D5 option E1, the Solana model)
/// @notice Periphery for creator buys made in our app: the app sends the coin creator's buys (other than the first
/// buy in the launch transaction) through `buy`, which swaps in the coin's V4 pool and holds the coins on the gen-7
/// escrow schedule (LaunchCampaignGen7 C4): a buy of `a` at time `s` releases a/5 at s + 30 days + 7 days * k,
/// k = 0..4. Only the buyer (the beneficiary, msg.sender of `buy`) can claim, and only what is released.
/// Buys elsewhere are not escrowed (accepted in D5, as on Solana). No owner, no admin, no fee, no rescue.
/// Anyone may escrow their own buys; the indexer treats every trade through this contract as league-excluded.
contract MwzCreatorEscrow is IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    error ZeroAmount();
    error UnknownPool();
    error Slippage();
    error NothingToClaim();
    error UnexpectedCallback();
    error RefundFailed();

    uint256 public constant ESCROW_CLIFF = 30 days;
    uint256 public constant ESCROW_STEP = 7 days;
    uint256 public constant ESCROW_TRANCHES = 5;

    IPoolManager public immutable poolManager;
    IMwzLaunchHook public immutable hook;

    struct Position {
        Checkpoints.Trace208 cum; // cumulative escrowed coins keyed by buy timestamp
        uint256 claimed;
    }

    mapping(address token => mapping(address beneficiary => Position)) internal _positions;

    event EscrowBuy(PoolId indexed id, address indexed token, address indexed beneficiary, uint256 nativeSpent, uint256 coinsEscrowed);
    event EscrowClaimed(address indexed token, address indexed beneficiary, uint256 amount);

    constructor(IMwzLaunchHook hook_) {
        hook = hook_;
        poolManager = hook_.poolManager();
    }

    /// @notice Buys `token` with all of msg.value in its gen-8 pool (exact input, no price limit) and escrows the
    /// coins for msg.sender. nonReentrant; CEI: the checkpoint is written before the refund, which is the last call.
    function buy(address token, uint256 minOut) external payable nonReentrant returns (uint256 coinsOut, uint256 spent) {
        if (msg.value == 0) revert ZeroAmount();
        PoolKey memory key = hook.poolKeyFor(token);
        PoolId id = key.toId();
        (address creator,,,,,,,,) = hook.pools(id);
        if (creator == address(0)) revert UnknownPool();
        (spent, coinsOut) = abi.decode(poolManager.unlock(abi.encode(key, msg.value)), (uint256, uint256));
        if (coinsOut == 0 || coinsOut < minOut) revert Slippage();
        Checkpoints.Trace208 storage cum = _positions[token][msg.sender].cum;
        // cumulative <= total supply (1e27) < 2^208; one entry per timestamp (same-second buys merge)
        cum.push(uint48(block.timestamp), uint208(cum.latest() + coinsOut));
        emit EscrowBuy(id, token, msg.sender, spent, coinsOut);
        if (msg.value > spent) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - spent}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Only from the PoolManager and only inside `buy` (the reentrancy lock is held).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_reentrancyGuardEntered()) revert UnexpectedCallback();
        (PoolKey memory key, uint256 amountIn) = abi.decode(data, (PoolKey, uint256));
        BalanceDelta d = poolManager.swap(
            key, SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}), ""
        );
        uint256 owed = uint256(uint128(-d.amount0()));
        uint256 out = uint256(uint128(d.amount1()));
        poolManager.settle{value: owed}();
        poolManager.take(key.currency1, address(this), out);
        return abi.encode(owed, out);
    }

    function escrowedTotal(address token, address beneficiary) external view returns (uint256) {
        return _positions[token][beneficiary].cum.latest();
    }

    function claimed(address token, address beneficiary) external view returns (uint256) {
        return _positions[token][beneficiary].claimed;
    }

    /// @notice Coins released by time `t` (gen-7 creatorEscrowVested): (sum_k Cum(t - 30d - 7d*k)) / 5, rounded down.
    function vested(address token, address beneficiary, uint256 t) public view returns (uint256 v) {
        Checkpoints.Trace208 storage cum = _positions[token][beneficiary].cum;
        for (uint256 k; k < ESCROW_TRANCHES; ++k) {
            uint256 offset = ESCROW_CLIFF + k * ESCROW_STEP;
            if (t < offset) break;
            uint256 key = t - offset;
            if (key > type(uint48).max) key = type(uint48).max;
            v += cum.upperLookupRecent(uint48(key));
        }
        return v / ESCROW_TRANCHES;
    }

    function claimable(address token, address beneficiary) public view returns (uint256) {
        return vested(token, beneficiary, block.timestamp) - _positions[token][beneficiary].claimed;
    }

    /// @notice Pull-only; pays msg.sender at most what is released. nonReentrant; CEI.
    function claim(address token) external nonReentrant returns (uint256 amount) {
        amount = claimable(token, msg.sender);
        if (amount == 0) revert NothingToClaim();
        _positions[token][msg.sender].claimed += amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit EscrowClaimed(token, msg.sender, amount);
    }
}
