// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICreatorRewardsVaultV2} from "../interfaces/ICreatorRewardsVaultV2.sol";

/// @dev Minimal CreatorRewardsVaultV2 stand-in: the choice is set once by the factory, and accrual
/// for a campaign without a choice reverts (the real vault's rule, C6).
contract MockCreatorRewardsVaultEvmGen is ICreatorRewardsVaultV2 {
    struct Cfg {
        address creator;
        uint8 choice;
        uint8 creatorPct;
    }

    address public factory;
    mapping(address => Cfg) public cfg;
    mapping(address => uint256) public accrued;

    function setFactory(address factory_) external {
        factory = factory_;
    }

    function setCampaignChoice(address campaign, address creator, uint8 choice, uint8 creatorPct) external {
        require(msg.sender == factory, "only factory");
        require(cfg[campaign].choice == 0, "choice set");
        require(choice >= 1 && choice <= 4, "choice");
        cfg[campaign] = Cfg(creator, choice, creatorPct);
    }

    function accrueTradeFee(address campaign) external payable {
        require(cfg[campaign].choice != 0, "choice unset");
        accrued[campaign] += msg.value;
    }

    receive() external payable {}
}
