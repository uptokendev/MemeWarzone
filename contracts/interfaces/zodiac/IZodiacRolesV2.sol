// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The surface of the Zodiac Roles Modifier v2.1.0 (mastercopy 0x9646fDAD06d3e24444381f44362a3B0eB343D337,
/// verified by scripts/verify-zodiac-roles-mastercopy.ts) that the payout watchdog setup uses. Declared here only so
/// scripts/make-safe-batch.ts can encode and re-check the Safe batch from a compiled ABI; nothing in this repository
/// implements it. Enum parameters of the real contract (ParameterType, Operator, ExecutionOptions, Enum.Operation)
/// are uint8 in the ABI, so the selectors and encodings are identical.
/// Setup and audit: docs/evm-launch/audit/PAYOUT_ROLES_MODULE.md.
interface IZodiacRolesV2 {
    /// @dev Roles v2 ConditionFlat: one node of a condition tree in breadth-first order.
    struct ConditionFlat {
        uint8 parent;
        uint8 paramType;
        uint8 operator;
        bytes compValue;
    }

    function setUp(bytes memory initParams) external;

    function owner() external view returns (address);

    function avatar() external view returns (address);

    function target() external view returns (address);

    function isModuleEnabled(address module) external view returns (bool);

    function scopeTarget(bytes32 roleKey, address targetAddress) external;

    function revokeTarget(bytes32 roleKey, address targetAddress) external;

    function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, ConditionFlat[] memory conditions, uint8 options) external;

    function revokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector) external;

    function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp) external;

    function allowances(bytes32 key) external view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp);

    function assignRoles(address module, bytes32[] calldata roleKeys, bool[] calldata memberOf) external;

    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey, bool shouldRevert)
        external
        returns (bool success);
}

/// @notice Zodiac ModuleProxyFactory (0x000000000000aDdB49795b0f9bA5BC298cDda236 on every chain we use).
interface IZodiacModuleProxyFactory {
    function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce) external returns (address proxy);
}

/// @notice The Safe (1.4.1) module manager calls the payout watchdog setup and its off switch use.
interface ISafeModuleManager {
    function enableModule(address module) external;

    function disableModule(address prevModule, address module) external;

    function isModuleEnabled(address module) external view returns (bool);

    function getModulesPaginated(address start, uint256 pageSize) external view returns (address[] memory array, address next);

    function getOwners() external view returns (address[] memory);

    function getThreshold() external view returns (uint256);
}
