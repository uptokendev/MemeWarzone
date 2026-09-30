// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * Layouts and interfaces of the Doppler contracts deployed on Robinhood Chain (4663), copied field for
 * field from whetstoneresearch/doppler: Airlock, DopplerHookInitializer, DopplerHookMigrator and
 * StreamableFeesLockerV2 from ffaa7062 (2026-06-30), RehypeDopplerHookInitializer from d44cc0a9
 * (2026-08-17). Those contracts and every type below are unchanged between the two commits.
 * Nothing here is deployed; the rehearsal talks to the contracts already on chain through a fork.
 */
import { PoolKey } from "@v4-core/types/PoolKey.sol";

library RH {
    address constant AIRLOCK = 0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862;
    address constant AIRLOCK_OWNER = 0x21E2ce70511e4FE542a97708e89520471DAa7A66;
    address constant TOKEN_FACTORY = 0x1B37D3a72082029c44B35B604Ea473617580b69a; // DopplerERC20V1Factory
    address constant NO_OP_GOVERNANCE = 0x85f37f74Ef2478A770318bc810177a9835911aD7;
    address constant INITIALIZER = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544; // DopplerHookInitializer
    address constant MIGRATOR = 0x7BF319d8e969f7596B1Bc171Da9ce322f67Ae0c4; // DopplerHookMigrator
    address constant REHYPE = 0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215; // RehypeDopplerHookInitializer
    address constant LOCKER = 0x7B6147AC3F615bdb764e7EbD5f517dac1AD163B8; // StreamableFeesLockerV2
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
}

struct BeneficiaryData {
    address beneficiary;
    uint96 shares;
}

struct Curve {
    int24 tickLower;
    int24 tickUpper;
    uint16 numPositions;
    uint256 shares;
}

/// DopplerHookInitializer.InitData
struct InitData {
    uint24 fee;
    int24 tickSpacing;
    int24 farTick;
    Curve[] curves;
    BeneficiaryData[] beneficiaries;
    address dopplerHook;
    bytes onInitializationDopplerHookCalldata;
    bytes graduationDopplerHookCalldata;
}

enum PoolStatus {
    Uninitialized,
    Initialized,
    Locked,
    Graduated,
    Exited
}

/// RehypeTypes
enum FeeRoutingMode {
    DirectBuyback,
    RouteToBeneficiaryFees
}

struct FeeDistributionInfo {
    uint256 assetFeesToAssetBuybackWad;
    uint256 assetFeesToNumeraireBuybackWad;
    uint256 assetFeesToBeneficiaryWad;
    uint256 assetFeesToLpWad;
    uint256 numeraireFeesToAssetBuybackWad;
    uint256 numeraireFeesToNumeraireBuybackWad;
    uint256 numeraireFeesToBeneficiaryWad;
    uint256 numeraireFeesToLpWad;
}

struct RehypeInitData {
    address numeraire;
    address buybackDst;
    uint24 startFee;
    uint24 endFee;
    uint32 durationSeconds;
    uint32 startingTime;
    FeeRoutingMode feeRoutingMode;
    FeeDistributionInfo feeDistributionInfo;
    BeneficiaryData[] feeBeneficiaries;
}

/// Airlock.CreateParams
struct CreateParams {
    uint256 initialSupply;
    uint256 numTokensToSell;
    address numeraire;
    address tokenFactory;
    bytes tokenFactoryData;
    address governanceFactory;
    bytes governanceFactoryData;
    address poolInitializer;
    bytes poolInitializerData;
    address liquidityMigrator;
    bytes liquidityMigratorData;
    address integrator;
    bytes32 salt;
}

struct VestingSchedule {
    uint64 cliff;
    uint64 duration;
}

interface IAirlock {
    function create(CreateParams calldata createData)
        external
        returns (address asset, address pool, address governance, address timelock, address migrationPool);
    function migrate(address asset) external;
    function owner() external view returns (address);
    function getAssetData(address asset)
        external
        view
        returns (
            address numeraire,
            address timelock,
            address governance,
            address liquidityMigrator,
            address poolInitializer,
            address pool,
            address migrationPool,
            uint256 numTokensToSell,
            uint256 totalSupply,
            address integrator
        );
}

interface IDopplerHookInitializer {
    function getState(address asset)
        external
        view
        returns (
            address numeraire,
            uint256 totalTokensOnBondingCurve,
            address dopplerHook,
            bytes memory graduationDopplerHookCalldata,
            PoolStatus status,
            PoolKey memory poolKey,
            int24 farTick
        );
}

interface IRehype {
    function collectFees(address asset) external returns (int256 fees);
    function claimAirlockOwnerFees(address asset) external returns (uint128 fees0, uint128 fees1);
    function getHookFees(bytes32 poolId)
        external
        view
        returns (
            uint128 fees0,
            uint128 fees1,
            uint128 beneficiaryFees0,
            uint128 beneficiaryFees1,
            uint128 airlockOwnerFees0,
            uint128 airlockOwnerFees1,
            uint24 customFee
        );
}

interface IDopplerHookMigrator {
    /// Public getter of AssetData (the beneficiaries array is omitted by Solidity).
    function getAssetData(address token0, address token1)
        external
        view
        returns (
            bool isToken0,
            PoolKey memory poolKey,
            uint32 lockDuration,
            uint24 feeOrInitialDynamicFee,
            bool useDynamicFee,
            address dopplerHook,
            bytes memory onInitializationCalldata,
            uint8 status
        );
}

interface IStreamableFeesLocker {
    function streams(bytes32 poolId)
        external
        view
        returns (PoolKey memory poolKey, address recipient, uint32 startDate, uint32 lockDuration, bool isUnlocked);
    /// FeesManager: harvests the position's fees and pays the caller its own share.
    function collectFees(bytes32 poolId) external returns (uint128 fees0, uint128 fees1);
    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256);
}
