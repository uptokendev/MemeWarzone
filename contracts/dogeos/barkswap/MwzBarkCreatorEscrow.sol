// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IAlgebraPool} from "./interfaces/core/IAlgebraPool.sol";
import {IAlgebraSwapCallback} from "./interfaces/core/callback/IAlgebraSwapCallback.sol";
import {IWNativeToken} from "./interfaces/periphery/external/IWNativeToken.sol";
import {MwzBarkLauncher} from "./MwzBarkLauncher.sol";

/// @title MwzBarkCreatorEscrow (EVM generation 8 on Barkswap, DogeOS; gen-8 MwzCreatorEscrow, D5 option E1, the
/// Solana model)
/// @notice Periphery for creator buys made in our app: the app sends the coin creator's buys (other than the first
/// buy in the launch transaction) through `buy`, which swaps directly on the coin's Barkswap pool (so our plugin labels
/// it an escrow buy) and holds the coins on the gen-7 escrow schedule (LaunchCampaignGen7 C4): a buy of `a` at time `s`
/// releases a/5 at s + 30 days + 7 days * k, k = 0..4. Only the buyer (the beneficiary, msg.sender of `buy`) can claim,
/// and only what is released. Buys elsewhere are not escrowed (accepted in D5, as on Solana). No owner, no admin, no
/// fee, no rescue. Anyone may escrow their own buys; the indexer treats every trade through this contract as
/// league-excluded. Diff audit against gen-8's MwzCreatorEscrow: docs/dogeos/barkswap-audit.md (MwzBarkCreatorEscrow).
contract MwzBarkCreatorEscrow is IAlgebraSwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using Checkpoints for Checkpoints.Trace208;

    error ZeroAmount();
    error UnknownPool();
    error Slippage();
    error NothingToClaim();
    error UnexpectedCallback();
    error RefundFailed();
    error ZeroAddress();

    uint256 public constant ESCROW_CLIFF = 30 days;
    uint256 public constant ESCROW_STEP = 7 days;
    uint256 public constant ESCROW_TRANCHES = 5;
    /// @dev The pool this escrow is swapping on right now (0 otherwise): set around buy's pool.swap only.
    bytes32 internal constant T_ACTIVE_POOL = keccak256("mwz.dogeos.bark.escrow.activePool");

    /// @notice The MwzBarkLauncher (predicted address: this escrow is deployed before the plugin, which takes its address
    /// as the escrow-buy label, and before the launcher). WDOGE and each coin's pool are read from it at buy time.
    MwzBarkLauncher public immutable launcher;

    struct Position {
        Checkpoints.Trace208 cum; // cumulative escrowed coins keyed by buy timestamp
        uint256 claimed;
    }

    mapping(address token => mapping(address beneficiary => Position)) internal _positions;

    event EscrowBuy(address indexed pool, address indexed token, address indexed beneficiary, uint256 nativeSpent, uint256 coinsEscrowed);
    event EscrowClaimed(address indexed token, address indexed beneficiary, uint256 amount);

    /// @dev No call at construction: the launcher does not exist yet.
    constructor(MwzBarkLauncher launcher_) {
        if (address(launcher_) == address(0)) revert ZeroAddress();
        launcher = launcher_;
    }

    /// @notice Buys `token` with all of msg.value in its Barkswap pool (exact input of msg.value as WDOGE, no price
    /// limit) and escrows the coins for msg.sender. nonReentrant; CEI: the checkpoint is written before the refund,
    /// which is the last call.
    function buy(address token, uint256 minOut) external payable nonReentrant returns (uint256 coinsOut, uint256 spent) {
        if (msg.value == 0) revert ZeroAmount();
        (address pool,,,,,,,,,) = launcher.launches(token);
        if (pool == address(0)) revert UnknownPool();
        bytes32 slot = T_ACTIVE_POOL;
        assembly ("memory-safe") {
            tstore(slot, pool)
        }
        (int256 a0, int256 a1) = IAlgebraPool(pool).swap(
            address(this), false, msg.value.toInt256(), TickMath.MAX_SQRT_PRICE - 1, abi.encode(launcher.wNative(), msg.value)
        );
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
        coinsOut = a0 < 0 ? uint256(-a0) : 0;
        spent = a1 > 0 ? uint256(a1) : 0;
        if (coinsOut == 0 || coinsOut < minOut) revert Slippage();
        Checkpoints.Trace208 storage cum = _positions[token][msg.sender].cum;
        // cumulative <= total supply (1e27) < 2^208; one entry per timestamp (same-second buys merge)
        cum.push(uint48(block.timestamp), uint208(cum.latest() + coinsOut));
        emit EscrowBuy(pool, token, msg.sender, spent, coinsOut);
        if (msg.value > spent) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - spent}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Only from the pool this escrow is swapping on right now (inside `buy`, the reentrancy lock is held;
    /// msg.sender is never address(0), so a cleared slot never matches). A buy owes WDOGE (token1) only: exactly that is
    /// wrapped from the buy's msg.value and paid, never more than msg.value. `data` is buy's own (WDOGE, msg.value):
    /// Algebra hands it back unchanged.
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address active;
        bytes32 slot = T_ACTIVE_POOL;
        assembly ("memory-safe") {
            active := tload(slot)
        }
        if (msg.sender != active || amount0Delta > 0) revert UnexpectedCallback();
        (address wNative, uint256 maxIn) = abi.decode(data, (address, uint256));
        if (amount1Delta > 0) {
            uint256 owed = uint256(amount1Delta);
            if (owed > maxIn) revert UnexpectedCallback();
            IWNativeToken(wNative).deposit{value: owed}();
            IERC20(wNative).safeTransfer(msg.sender, owed);
        }
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
