// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @notice Per-coin rates, fixed at launch and never changed (invariant I12).
/// All values are basis points (10_000 = 100%).
struct FeeConfig {
    uint16 bondingBps; // fee on the curve amount before graduation, <= 200
    uint16 postBps; // fee on the curve amount after graduation, <= 100
    uint16 creatorPostBps; // creator share of the curve amount after graduation, <= postBps
    uint16 sniperStartBps; // launch rate at t = 0, bondingBps <= sniperStartBps <= 9000
    uint16 creatorBondingBps; // creator share of every pre-graduation fee (D2), <= 1000
}

/// @notice Read-only view of MwzLaunchHook used by the periphery (lens, launcher, reserve lock, vault, splitter).
interface IMwzLaunchHook {
    function poolManager() external view returns (IPoolManager);
    function launcher() external view returns (address);
    function TICK_SPACING() external view returns (int24);

    function pools(PoolId id)
        external
        view
        returns (
            address creator,
            uint40 launchTime,
            bool graduated,
            int24 tickGrad,
            int24 tickStart,
            uint128 liqA,
            uint128 liqB,
            uint160 sqrtGrad,
            FeeConfig memory fees
        );

    function creatorOwed(PoolId id) external view returns (uint256);
    function routerOwed() external view returns (uint128);
    function treasuryRouter() external view returns (address);
    function routerPaid(address router) external view returns (uint256 amount, uint256 bondingFees, uint256 gradFees);
    function poolKeyFor(address token) external view returns (PoolKey memory);

    function createPool(address token, address creator, int24 tickStart, int24 tickGrad, uint256 coinsA, uint256 coinsB, FeeConfig calldata fees)
        external
        returns (PoolKey memory key);
    function claimCreator(PoolId id, address to) external returns (uint256 amount);
    function claimRouter() external returns (uint256 amount);
}
