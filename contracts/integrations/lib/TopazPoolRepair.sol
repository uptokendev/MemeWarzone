// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ITopazRepairFactory {
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool);
    function createPool(address tokenA, address tokenB, bool stable) external returns (address pool);
    function isPool(address pool) external view returns (bool);
}

interface ITopazRepairPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function mint(address to) external returns (uint256 liquidity);
}

/// @notice Shared Topaz V2 pool repair: find or create the volatile MEME/X pair, deposit our paired
/// amount plus the MEME that prices the pool at or above the curve target, mint LP to the locker.
/// Spec: docs/evm-launch/spec/C7-bnb-adapters.md section 4.
///
/// Invariant I1 (before our mint): the pool holds no MEME and totalSupply is 0, because LaunchToken
/// refuses every transfer whose `from` and `msg.sender` are not the campaign. A griefer can only
/// leave X (WBNB or QUOTE) in the pair. The first mint then belongs to us. If I1 is broken the
/// library fails closed (`PoolAlreadyInitialized`).
///
/// Never calls skim or sync: every unit already in the pair is absorbed into the locked position.
library TopazPoolRepair {
    using SafeERC20 for IERC20;

    uint256 internal constant MINIMUM_LIQUIDITY = 1_000;
    uint256 internal constant WAD = 1e18;

    struct Params {
        address factory;
        address meme;
        address paired;
        uint256 pairedAmount; // N: all of it is deposited
        uint256 memeTarget; // Mt
        uint256 memeMax; // Mmax >= Mt
        address memePayer; // campaign; transferFrom into the pair
        address locker;
    }

    struct Outcome {
        address pool;
        uint256 liquidity; // LP minted to the locker (totalSupply - 1000)
        uint256 memeUsed;
        uint256 donationFound; // paired-token balance already in the pair
        uint256 startPriceWad; // paired per MEME, 1e18
        bool repaired; // pair existed before this call
    }

    error InvalidPair();
    error PoolAlreadyInitialized();
    error ZeroLiquidity();
    error PairedDepositMismatch();
    error PriceBelowTarget();
    error ReservesDesynced();

    /// @dev Find or create the volatile MEME/X pool, pull `m` MEME from the campaign straight into it,
    /// transfer `N` of the paired token from this contract into it, mint to the locker, post-check.
    /// Caller must already hold `N` of the paired token. Caller must not hold MEME.
    function repairAndMint(Params memory p) internal returns (Outcome memory out) {
        if (
            p.factory == address(0) || p.meme == address(0) || p.paired == address(0) || p.memePayer == address(0)
                || p.locker == address(0)
        ) revert InvalidPair();
        if (p.meme == p.paired) revert InvalidPair();
        if (p.pairedAmount == 0 || p.memeTarget == 0 || p.memeMax < p.memeTarget) revert ZeroLiquidity();

        ITopazRepairFactory factory_ = ITopazRepairFactory(p.factory);
        address pool = factory_.getPool(p.meme, p.paired, false);
        out.repaired = pool != address(0);
        if (pool == address(0)) {
            pool = factory_.createPool(p.meme, p.paired, false);
        }
        if (pool == address(0) || !factory_.isPool(pool)) revert InvalidPair();
        ITopazRepairPool P = ITopazRepairPool(pool);
        if (P.stable()) revert InvalidPair();
        address t0 = P.token0();
        address t1 = P.token1();
        if (!_samePair(t0, t1, p.meme, p.paired)) revert InvalidPair();
        if (P.totalSupply() != 0) revert PoolAlreadyInitialized();

        uint256 bm = IERC20(p.meme).balanceOf(pool);
        uint256 bx = IERC20(p.paired).balanceOf(pool);
        out.donationFound = bx;

        // T = floor((bx + N) * Mt / N). Pool MEME after mint is min(T, bm + Mmax).
        uint256 Bx = bx + p.pairedAmount;
        uint256 T = Math.mulDiv(Bx, p.memeTarget, p.pairedAmount);
        if (T <= bm) revert PoolAlreadyInitialized();
        uint256 m = T - bm;
        if (m > p.memeMax) m = p.memeMax;

        IERC20(p.meme).safeTransferFrom(p.memePayer, pool, m);
        IERC20(p.paired).safeTransfer(pool, p.pairedAmount);
        if (IERC20(p.paired).balanceOf(pool) != bx + p.pairedAmount) revert PairedDepositMismatch();

        uint256 lp = P.mint(p.locker);
        uint256 supply = P.totalSupply();
        if (lp == 0 || supply != lp + MINIMUM_LIQUIDITY) revert ZeroLiquidity();
        if (P.balanceOf(p.locker) < lp) revert ZeroLiquidity();

        (uint256 r0, uint256 r1,) = P.getReserves();
        uint256 bal0 = IERC20(t0).balanceOf(pool);
        uint256 bal1 = IERC20(t1).balanceOf(pool);
        if (r0 != bal0 || r1 != bal1) revert ReservesDesynced();

        uint256 memeBal = IERC20(p.meme).balanceOf(pool);
        uint256 pairedBal = IERC20(p.paired).balanceOf(pool);
        if (memeBal == 0 || pairedBal == 0) revert ZeroLiquidity();
        // paired/MEME >= N/Mt  <=>  paired * Mt / N >= meme  (floor; construction makes this hold)
        if (Math.mulDiv(pairedBal, p.memeTarget, p.pairedAmount) < memeBal) revert PriceBelowTarget();

        out.pool = pool;
        out.liquidity = lp;
        out.memeUsed = m;
        out.startPriceWad = Math.mulDiv(pairedBal, WAD, memeBal);
    }

    function _samePair(address a0, address a1, address b0, address b1) private pure returns (bool) {
        return (a0 == b0 && a1 == b1) || (a0 == b1 && a1 == b0);
    }
}
