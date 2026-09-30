// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev A contract wallet for creator-side tests: forwards arbitrary calls, and rejects plain native
/// transfers while `rejectNative` is set (a Safe without a receive path, a blocked wallet...).
contract MockCreatorWalletEvmGen {
    bool public rejectNative = true;

    function setRejectNative(bool reject) external {
        rejectNative = reject;
    }

    function execute(address target, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {
        require(!rejectNative, "no native");
    }
}
