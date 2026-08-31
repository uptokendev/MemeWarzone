// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITreasuryRouterV3Mock {
    function routeTrade(uint8 profile) external payable;
    function routeFinalize(uint8 profile) external payable;
}

contract TreasuryRouterV3ReceiverMock {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

/// Minimal Phase1 V3 fee-router surface for schedule-gating tests that still use the shared V2 DEX fixture.
contract MockPhase1TreasuryRouter {
    receive() external payable {}
    function routeTrade(uint8) external payable {}
    function routeFinalize(uint8) external payable {}
    function route(uint8, uint8) external payable {}
}

contract CommunityRewardsVaultV3Mock {
    uint256 public airdropReceived;
    uint256 public squadReceived;

    function depositAirdrop() external payable {
        airdropReceived += msg.value;
    }

    function depositSquadPool() external payable {
        squadReceived += msg.value;
    }
}

contract RevertingTreasuryRouterV3ReceiverMock {
    receive() external payable {
        revert("receiver reverted");
    }
}

contract TreasuryRouterV3TokenMock is ERC20 {
    constructor() ERC20("Treasury Router Token", "TRT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract CreatorFeeCampaignMock {
    address public immutable creator;

    constructor(address creator_) {
        creator = creator_;
    }

    function routeTrade(address router, uint8 profile) external payable {
        ITreasuryRouterV3Mock(router).routeTrade{value: msg.value}(profile);
    }

    function routeFinalize(address router, uint8 profile) external payable {
        ITreasuryRouterV3Mock(router).routeFinalize{value: msg.value}(profile);
    }
}
