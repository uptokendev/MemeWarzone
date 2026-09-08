// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILaunchCampaignCreatorView {
    function creator() external view returns (address);
}

/// @title CreatorRewardsVault
/// @notice Custodies campaign-scoped creator trade fees for later creator claims.
contract CreatorRewardsVault {
    address public immutable admin;
    address public router;

    mapping(address => address) public campaignCreator;
    mapping(address => uint256) public pendingCreatorFees;
    mapping(address => uint256) public lifetimeCreatorFees;
    mapping(address => uint256) public claimedCreatorFees;

    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event CreatorFeeAccrued(
        address indexed campaign,
        address indexed creator,
        uint256 amount,
        uint256 cumulativeAccrued,
        uint256 cumulativeClaimed
    );
    event CreatorFeeClaimed(
        address indexed campaign,
        address indexed creator,
        uint256 amount,
        uint256 cumulativeAccrued,
        uint256 cumulativeClaimed
    );

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlyRouter() {
        require(msg.sender == router, "not router");
        _;
    }

    constructor(address _admin, address _router) {
        require(_admin != address(0), "admin=0");
        require(_router != address(0), "router=0");
        admin = _admin;
        router = _router;
        emit RouterUpdated(address(0), _router);
    }

    receive() external payable {
        revert("direct disabled");
    }

    function setRouter(address newRouter) external onlyAdmin {
        require(newRouter != address(0), "router=0");
        emit RouterUpdated(router, newRouter);
        router = newRouter;
    }

    function accrueTradeFee(address campaign) external payable onlyRouter {
        require(campaign != address(0), "campaign=0");
        require(msg.value > 0, "amount=0");

        address creator = _campaignCreator(campaign);
        pendingCreatorFees[campaign] += msg.value;
        lifetimeCreatorFees[campaign] += msg.value;

        emit CreatorFeeAccrued(
            campaign,
            creator,
            msg.value,
            lifetimeCreatorFees[campaign],
            claimedCreatorFees[campaign]
        );
    }

    function claimCreatorFees(address campaign) external returns (uint256 amount) {
        address creator = _campaignCreator(campaign);
        require(msg.sender == creator, "not creator");

        amount = pendingCreatorFees[campaign];
        require(amount > 0, "amount=0");

        pendingCreatorFees[campaign] = 0;
        claimedCreatorFees[campaign] += amount;

        (bool ok, ) = payable(creator).call{value: amount}("");
        require(ok, "transfer failed");

        emit CreatorFeeClaimed(
            campaign,
            creator,
            amount,
            lifetimeCreatorFees[campaign],
            claimedCreatorFees[campaign]
        );
    }

    function _campaignCreator(address campaign) internal returns (address creator) {
        creator = campaignCreator[campaign];
        address currentCreator = ILaunchCampaignCreatorView(campaign).creator();
        require(currentCreator != address(0), "creator=0");

        if (creator == address(0)) {
            campaignCreator[campaign] = currentCreator;
            return currentCreator;
        }

        require(creator == currentCreator, "creator changed");
    }
}
