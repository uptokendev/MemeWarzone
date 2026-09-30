// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IMockRouterTradeEvmGen {
    function routeTrade(uint8 profile) external payable;
}

interface IMockVaultChoiceEvmGen {
    function setCampaignChoice(address campaign, address creator, uint8 choice, uint8 creatorPct) external;
}

/// @dev LaunchToken stand-in: only the campaign can move tokens until trading is enabled.
contract MockLaunchTokenEvmGen is ERC20 {
    address public immutable campaign;
    bool public tradingEnabled;

    constructor() ERC20("Mock Meme EvmGen", "MEME") {
        campaign = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == campaign, "only campaign");
        _mint(to, amount);
    }

    function enableTrading() external {
        require(msg.sender == campaign, "only campaign");
        tradingEnabled = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!tradingEnabled && from != address(0) && from != campaign) revert("trading disabled");
        super._update(from, to, value);
    }
}

/// @dev The surface CreatorRewardsVaultV2.buybackCurve uses, with LaunchCampaign's semantics: the fee is taken
/// on the curve cost and routed through the router with the signed profile, tokens go to msg.sender, the
/// unspent value is refunded to msg.sender, and crossing the target sets graduationPending.
contract MockCampaignEvmGen {
    MockLaunchTokenEvmGen public token;
    address public router;
    uint256 public feeBps = 200;
    uint256 public basePrice = 1e12; // wei per whole token
    uint256 public slope = 1e3;
    uint256 public sold;
    uint256 public netRaisedWei;
    uint256 public graduationNativeTarget;
    uint256 public maxCostPerBuy = type(uint256).max;
    bool public launched;
    bool public graduationPending;
    bytes32 public expectedSig;
    bool public forceGraduationOnBuy;
    mapping(bytes32 => bool) public used;

    constructor(address router_, uint256 target_) {
        token = new MockLaunchTokenEvmGen();
        router = router_;
        graduationNativeTarget = target_;
    }

    function setFeeBps(uint256 v) external {
        feeBps = v;
    }

    function setMaxCostPerBuy(uint256 v) external {
        maxCostPerBuy = v;
    }

    function setExpectedSig(bytes calldata sig) external {
        expectedSig = keccak256(sig);
    }

    function graduate() external {
        launched = true;
        token.enableTrading();
    }

    /// @dev Routes a trade fee as this campaign (what a trader's buy would do).
    function payFee(uint8 profile) external payable {
        IMockRouterTradeEvmGen(router).routeTrade{value: msg.value}(profile);
    }

    function setForceGraduationOnBuy(bool v) external {
        forceGraduationOnBuy = v;
    }

    function setTarget(uint256 target_) external {
        graduationNativeTarget = target_;
    }

    function setSlope(uint256 slope_) external {
        slope = slope_;
    }

    function mintTo(address to, uint256 amount) external {
        token.mint(to, amount);
    }

    function currentPrice() public view returns (uint256) {
        return basePrice + (slope * sold) / 1e18;
    }

    function quoteBuyExactBnb(uint256 totalIn) public view returns (uint256 tokensOut, uint256 totalCost, uint256 fee) {
        uint256 cost = (totalIn * 10_000) / (10_000 + feeBps);
        if (cost > maxCostPerBuy) cost = maxCostPerBuy;
        fee = (cost * feeBps) / 10_000;
        totalCost = cost + fee;
        tokensOut = (cost * 1e18) / currentPrice();
    }

    function buyExactBnbAuthorized(uint256 minTokensOut, uint8 profile, uint64 deadline, bytes calldata sig)
        external
        payable
        returns (uint256 tokensOut, uint256 totalSpent)
    {
        require(!launched && !graduationPending, "closed");
        require(deadline >= block.timestamp, "expired");
        bytes32 h = keccak256(sig);
        require(h == expectedSig && !used[h], "bad sig");
        used[h] = true;
        uint256 fee;
        (tokensOut, totalSpent, fee) = quoteBuyExactBnb(msg.value);
        require(tokensOut >= minTokensOut, "slippage");
        uint256 cost = totalSpent - fee;
        sold += tokensOut;
        netRaisedWei += cost;
        token.mint(msg.sender, tokensOut);
        if (fee != 0) IMockRouterTradeEvmGen(router).routeTrade{value: fee}(profile);
        if (msg.value > totalSpent) {
            (bool ok, ) = msg.sender.call{value: msg.value - totalSpent}("");
            require(ok, "refund");
        }
        if (netRaisedWei >= graduationNativeTarget || forceGraduationOnBuy) graduationPending = true;
    }

    receive() external payable {}
}

/// @dev Factory stand-in for the vault: isCampaign, permanentLpLocker, and the setCampaignChoice call.
contract MockFactoryEvmGen {
    mapping(address => bool) public isCampaign;
    address public permanentLpLocker;

    constructor(address locker_) {
        permanentLpLocker = locker_;
    }

    function addCampaign(address campaign) external {
        isCampaign[campaign] = true;
    }

    function choose(address vault, address campaign, address creator, uint8 choice, uint8 pct) external {
        IMockVaultChoiceEvmGen(vault).setCampaignChoice(campaign, creator, choice, pct);
    }
}

interface IMockClaimVaultEvmGen {
    function claimCreatorFees(address campaign) external returns (uint256);
}

/// @dev A creator that is a contract: can reject native, or re-enter the claim from receive().
contract MockCreatorActorEvmGen {
    uint8 public mode; // 0 accept, 1 reject, 2 re-enter
    address public vault;
    address public campaign;

    function setMode(uint8 mode_, address vault_, address campaign_) external {
        mode = mode_;
        vault = vault_;
        campaign = campaign_;
    }

    function claim(address vault_, address campaign_) external returns (uint256) {
        return IMockClaimVaultEvmGen(vault_).claimCreatorFees(campaign_);
    }

    receive() external payable {
        if (mode == 1) revert("reject");
        if (mode == 2) IMockClaimVaultEvmGen(vault).claimCreatorFees(campaign);
    }
}
