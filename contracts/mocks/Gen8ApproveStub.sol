// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test stand-in for MwzCreatorChoiceVault.approveHolderBatch(bytes32,bytes32,uint256,uint64).
/// It has no 3-arg approve, so a Roles scope for selector 0xc62732bb is what the test exercises.
contract Gen8ApproveStub {
    event Approved(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline);

    function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline) external {
        emit Approved(batchId, root, total, claimDeadline);
    }
}
