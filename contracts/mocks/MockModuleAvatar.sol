// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only stand-in for a Safe as a Zodiac avatar: an owner-run account with a module list. A module may
/// execute through execTransactionFromModule only while enabled (the Safe's GS104 check). The owner calls
/// anything as this account through exec (the Safe's own transactions, e.g. the setup batch).
contract MockModuleAvatar {
    address public immutable owner;
    mapping(address => bool) public isModuleEnabled;
    address[] internal modules;
    mapping(address => bool) internal listed;

    error NotOwner();
    error ModuleNotEnabled(address module);

    constructor(address owner_) {
        owner = owner_;
    }

    receive() external payable {}

    function enableModule(address module) external {
        if (msg.sender != address(this)) revert NotOwner();
        if (!listed[module]) {
            listed[module] = true;
            modules.push(module);
        }
        isModuleEnabled[module] = true;
    }

    function getOwners() external view returns (address[] memory owners) {
        owners = new address[](1);
        owners[0] = owner;
    }

    /// @dev Enabled modules, newest first (the Safe's linked-list order); paging ignored.
    function getModulesPaginated(address, uint256) external view returns (address[] memory array, address next) {
        uint256 n;
        for (uint256 i; i < modules.length; ++i) if (isModuleEnabled[modules[i]]) ++n;
        array = new address[](n);
        uint256 j;
        for (uint256 i = modules.length; i > 0; --i) if (isModuleEnabled[modules[i - 1]]) array[j++] = modules[i - 1];
        next = address(1);
    }

    function disableModule(address, address module) external {
        if (msg.sender != address(this)) revert NotOwner();
        isModuleEnabled[module] = false;
    }

    function exec(address to, uint256 value, bytes calldata data) external payable returns (bytes memory ret) {
        if (msg.sender != owner) revert NotOwner();
        bool ok;
        (ok, ret) = to.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool success) {
        if (!isModuleEnabled[msg.sender]) revert ModuleNotEnabled(msg.sender);
        if (operation == 1) {
            (success, ) = to.delegatecall(data);
        } else {
            (success, ) = to.call{value: value}(data);
        }
    }

    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success, bytes memory ret)
    {
        if (!isModuleEnabled[msg.sender]) revert ModuleNotEnabled(msg.sender);
        if (operation == 1) {
            (success, ret) = to.delegatecall(data);
        } else {
            (success, ret) = to.call{value: value}(data);
        }
    }
}
