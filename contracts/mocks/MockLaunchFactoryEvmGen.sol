// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {LaunchCampaign} from "../LaunchCampaign.sol";

/// @dev Stand-in factory to drive a campaign implementation directly (e.g. the Robinhood stock
/// campaign without a V3 factory): clones, initializes, configures, relays the first buy and records
/// graduation notifications.
contract MockLaunchFactoryEvmGen {
    address public routeAuthority;
    address public lastNotifiedCreator;
    address public lastNotifiedPool;
    uint256 public notifications;

    function setRouteAuthority(address a) external {
        routeAuthority = a;
    }

    function create(address implementation, LaunchCampaign.InitParams memory p) external returns (address campaign) {
        campaign = Clones.clone(implementation);
        p.factory = address(this);
        LaunchCampaign(payable(campaign)).initialize(p);
    }

    function configure(address campaign, address quote, address adapter) external {
        LaunchCampaign(payable(campaign)).configureStockGraduation(quote, adapter);
    }

    function firstBuy(address campaign, uint256 tokens) external payable {
        LaunchCampaign(payable(campaign)).creatorFirstBuy{value: msg.value}(tokens);
    }

    function setPauses(address campaign, bool a, bool b, bool c, bool d) external {
        LaunchCampaign(payable(campaign)).setPauseState(a, b, c, d);
    }

    function notifyCampaignGraduated(address creator, address pool) external {
        lastNotifiedCreator = creator;
        lastNotifiedPool = pool;
        notifications += 1;
    }
}
