// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TopazPoolRepair} from "../integrations/lib/TopazPoolRepair.sol";

/// @notice Test-only wrapper so unit tests can drive every branch of TopazPoolRepair.
contract TopazPoolRepairHarness {
    function repairAndMint(
        address factory,
        address meme,
        address paired,
        uint256 pairedAmount,
        uint256 memeTarget,
        uint256 memeMax,
        address memePayer,
        address locker
    ) external returns (TopazPoolRepair.Outcome memory) {
        return TopazPoolRepair.repairAndMint(
            TopazPoolRepair.Params({
                factory: factory,
                meme: meme,
                paired: paired,
                pairedAmount: pairedAmount,
                memeTarget: memeTarget,
                memeMax: memeMax,
                memePayer: memePayer,
                locker: locker
            })
        );
    }
}
