// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IRobinhoodStockGraduationHarnessAdapter {
    struct GraduationRequest {
        address campaignToken;
        address stockToken;
        uint256 memeAmountDesired;
        uint256 minimumMemeUsed;
        uint256 minimumStockOut;
        uint256 finalCurvePriceNativeWad;
        uint256 deadline;
    }

    struct GraduationResult {
        address canonicalPool;
        uint256 positionTokenId;
        uint256 nativeLiquidityUsed;
        uint256 stockTokenAcquired;
        uint256 stockTokenUsed;
        uint256 stockTokenResidual;
        uint256 memeTokenUsed;
        uint256 memeTokenResidual;
        uint256 finalCurveMemeUsdWad;
        uint256 initialDexMemeUsdWad;
        uint256 priceDeviationBps;
    }

    function graduateStockLiquidity(GraduationRequest calldata request)
        external
        payable
        returns (GraduationResult memory result);
}

contract MockRobinhoodStockCampaignFactory {
    mapping(address => bool) public isCampaign;

    function setCampaign(address campaign, bool allowed) external {
        isCampaign[campaign] = allowed;
    }
}

contract MockRobinhoodStockCampaignHarness {
    using SafeERC20 for IERC20;

    function execute(
        address adapter,
        IRobinhoodStockGraduationHarnessAdapter.GraduationRequest calldata request
    ) external payable returns (IRobinhoodStockGraduationHarnessAdapter.GraduationResult memory result) {
        IERC20(request.campaignToken).forceApprove(adapter, request.memeAmountDesired);
        result = IRobinhoodStockGraduationHarnessAdapter(adapter).graduateStockLiquidity{value: msg.value}(request);
        IERC20(request.campaignToken).forceApprove(adapter, 0);
    }
}
