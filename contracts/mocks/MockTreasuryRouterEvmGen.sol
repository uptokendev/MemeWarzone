// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMockEvmGenVault {
    function accrueTradeFee(address campaign) external payable;
}

/// @dev Test router for the EVM launch generation. Accrues 5.6% of every trade fee to the creator
/// vault for msg.sender (so a campaign whose fee choice is unset reverts, as with the real V4 +
/// CreatorRewardsVaultV2), keeps the rest, and records every call. Can be told to revert.
contract MockTreasuryRouterEvmGen {
    address public creatorRewardsVault;
    bool public revertTrade;
    bool public revertFinalize;
    uint256 public tradeTotal;
    uint256 public finalizeTotal;
    uint256 public tradeCalls;
    uint256 public finalizeCalls;
    uint8 public lastTradeProfile;
    uint8 public lastFinalizeProfile;
    uint256 public lastTradeValue;

    bytes public reenterData;
    bool public reenterAttempted;
    bool public reenterSucceeded;
    bytes4 public reenterRevertSelector;

    event TradeRouted(address indexed campaign, uint8 profile, uint256 value);
    event FinalizeRouted(address indexed campaign, uint8 profile, uint256 value);

    function setCreatorRewardsVault(address vault) external {
        creatorRewardsVault = vault;
    }

    function setReverts(bool trade, bool finalize_) external {
        revertTrade = trade;
        revertFinalize = finalize_;
    }

    /// @dev When set, every route call first tries msg.sender.call(data) (a re-entry attempt) and
    /// records the outcome instead of reverting.
    function setReenter(bytes calldata data) external {
        reenterData = data;
    }

    function _tryReenter() internal {
        if (reenterData.length == 0) return;
        reenterAttempted = true;
        (bool ok, bytes memory ret) = msg.sender.call(reenterData);
        reenterSucceeded = ok;
        if (!ok && ret.length >= 4) reenterRevertSelector = bytes4(ret);
    }

    function routeTrade(uint8 profile) external payable {
        require(!revertTrade, "trade paused");
        _tryReenter();
        tradeTotal += msg.value;
        tradeCalls += 1;
        lastTradeProfile = profile;
        lastTradeValue = msg.value;
        uint256 creatorPart = (msg.value * 560) / 10_000;
        if (creatorRewardsVault != address(0) && creatorPart != 0) {
            IMockEvmGenVault(creatorRewardsVault).accrueTradeFee{value: creatorPart}(msg.sender);
        }
        emit TradeRouted(msg.sender, profile, msg.value);
    }

    function routeFinalize(uint8 profile) external payable {
        require(!revertFinalize, "finalize paused");
        _tryReenter();
        finalizeTotal += msg.value;
        finalizeCalls += 1;
        lastFinalizeProfile = profile;
        emit FinalizeRouted(msg.sender, profile, msg.value);
    }
}
