// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only stand-in for the Safe executing a Transaction Builder batch through MultiSendCallOnly: every
/// call has this contract as msg.sender, and the whole batch reverts if any call reverts (all or nothing).
contract MockSafeBatchExecutor {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    receive() external payable {}

    function execBatch(Call[] calldata calls) external payable {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
