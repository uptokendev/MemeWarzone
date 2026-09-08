// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArenaWarPoolTreasuryV2Claim {
    function claimWinner(bytes32 poolId) external;
}

contract RejectNativeReceiver {
    receive() external payable {
        revert("reject native");
    }
}

contract ReentrantArenaWinner {
    IArenaWarPoolTreasuryV2Claim public treasury;
    bytes32 public poolId;
    bool public attempted;

    function configure(address treasury_, bytes32 poolId_) external {
        treasury = IArenaWarPoolTreasuryV2Claim(treasury_);
        poolId = poolId_;
    }

    function claim() external {
        treasury.claimWinner(poolId);
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            try treasury.claimWinner(poolId) {} catch {}
        }
    }
}
