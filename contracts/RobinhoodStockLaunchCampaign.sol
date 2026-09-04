// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LaunchCampaign, ILaunchFactoryGraduationNotify} from "./LaunchCampaign.sol";

interface IRobinhoodStockGraduationExecutor {
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

interface IRobinhoodStockFactoryOwner {
    function owner() external view returns (address);
}

/// @notice Robinhood Stock Battlefield campaign implementation.
/// @dev Bonding behavior is inherited from LaunchCampaign, but graduation can never silently
/// fall back to the native MEME/WETH finalizer. Threshold crossing commits a pending state;
/// an explicit factory/multisig-authorized completion attempt executes the approved Stock route.
contract RobinhoodStockLaunchCampaign is LaunchCampaign {
    using SafeERC20 for IERC20;

    uint256 private constant STOCK_WAD = 1e18;
    uint256 private constant STOCK_BPS = 10_000;
    uint8 private constant ROUTE_KIND_FINALIZE_STOCK = 1;

    uint256 public stockFinalCurveMemeUsdWad;
    uint256 public stockInitialDexMemeUsdWad;
    uint256 public stockPositionTokenId;

    event StockGraduationCompleted(
        address indexed pool,
        address indexed stockToken,
        uint256 indexed positionTokenId,
        uint256 nativeLiquidityUsed,
        uint256 memeTokenUsed,
        uint256 stockTokenUsed,
        uint256 finalCurveMemeUsdWad,
        uint256 initialDexMemeUsdWad,
        uint256 priceDeviationBps
    );

    error StockCampaignNotConfigured();
    error StockGraduationNotPending();
    error StockGraduationDeadlineExpired();
    error StockGraduationResidual();
    error StockGraduationResultInvalid();
    error OnlyStockGraduationExecutor();

    function isStockCampaignImplementation() external pure returns (bool) {
        return true;
    }

    function graduateIfEligible(uint256, uint256)
        external
        override
        nonReentrant
        returns (uint256 usedTokens, uint256 usedBnb)
    {
        if (!stockGraduationEnabled) revert StockCampaignNotConfigured();
        if (graduationPending) revert GraduationPending();
        uint256 nativeTarget = graduationNativeTarget();
        if (netRaisedWei < nativeTarget) revert ThresholdNotMet();
        _markStockGraduationPending(msg.sender, nativeTarget);
        return (0, 0);
    }

    function completeStockGraduation(uint256 minimumMemeUsed, uint256 minimumStockOut, uint256 deadline)
        external
        nonReentrant
        returns (address pool, uint256 positionTokenId)
    {
        if (msg.sender != factory && msg.sender != IRobinhoodStockFactoryOwner(factory).owner()) {
            revert OnlyStockGraduationExecutor();
        }
        if (!stockGraduationEnabled || stockGraduationAdapter == address(0) || graduationQuoteToken == address(0)) {
            revert StockCampaignNotConfigured();
        }
        if (!graduationPending) revert StockGraduationNotPending();
        if (paused) revert CampaignPaused();
        if (graduationPaused) revert GraduationPaused();
        if (launched) revert Finalized();
        if (deadline < block.timestamp) revert StockGraduationDeadlineExpired();
        if (minimumMemeUsed == 0 || minimumStockOut == 0) revert ZeroAmount();

        GraduationState storage g = graduation;
        uint256 protocolFee = Math.mulDiv(g.graduationBalance, protocolFeeBps, STOCK_BPS);
        if (protocolFee > 0 && feeRecipient != address(0)) {
            _routeFeeOrSendLegacy(protocolFee, ROUTE_KIND_FINALIZE_STOCK, g.graduationBalance);
        }

        uint256 remainingAfterFee = g.graduationBalance - protocolFee;
        uint256 liquidityValue = Math.mulDiv(remainingAfterFee, liquidityBps, STOCK_BPS);
        uint256 memeAmountDesired = Math.mulDiv(liquidityValue, STOCK_WAD, g.finalCurvePrice);
        if (memeAmountDesired == 0 || liquidityValue == 0) revert LiquidityZero();
        if (memeAmountDesired > liquiditySupply) {
            uint256 desiredMeme = memeAmountDesired;
            uint256 desiredNative = liquidityValue;
            memeAmountDesired = liquiditySupply;
            liquidityValue = Math.mulDiv(memeAmountDesired, g.finalCurvePrice, STOCK_WAD);
            if (liquidityValue == 0) revert LiquidityZero();
            emit GraduationLiquidityCapped(desiredMeme, memeAmountDesired, desiredNative, liquidityValue);
        }
        if (minimumMemeUsed > memeAmountDesired) revert Slippage();

        // LaunchToken allows the campaign to move tokens while trading is disabled, but the
        // approved adapter/position manager also need to move MEME during the same transaction.
        // Enabling here is safe because any later adapter/oracle/mint failure reverts this state
        // change together with the rest of the completion attempt, preserving PENDING.
        token.enableTrading();

        IERC20 meme = IERC20(address(token));
        address adapter = stockGraduationAdapter;
        meme.forceApprove(adapter, memeAmountDesired);
        IRobinhoodStockGraduationExecutor.GraduationResult memory result =
            IRobinhoodStockGraduationExecutor(adapter).graduateStockLiquidity{value: liquidityValue}(
                IRobinhoodStockGraduationExecutor.GraduationRequest({
                    campaignToken: address(token),
                    stockToken: graduationQuoteToken,
                    memeAmountDesired: memeAmountDesired,
                    minimumMemeUsed: minimumMemeUsed,
                    minimumStockOut: minimumStockOut,
                    finalCurvePriceNativeWad: g.finalCurvePrice,
                    deadline: deadline
                })
            );
        meme.forceApprove(adapter, 0);

        if (
            result.canonicalPool == address(0) || result.positionTokenId == 0 ||
            result.nativeLiquidityUsed != liquidityValue || result.memeTokenUsed != memeAmountDesired ||
            result.stockTokenUsed == 0 || result.stockTokenUsed != result.stockTokenAcquired
        ) revert StockGraduationResultInvalid();
        if (result.memeTokenResidual != 0 || result.stockTokenResidual != 0) revert StockGraduationResidual();

        g.dexPair = result.canonicalPool;
        g.graduatedLiquidityTokens = result.memeTokenUsed;
        g.graduatedLiquidityBnb = result.nativeLiquidityUsed;
        // Legacy field is retained for ABI continuity. V3 Stock campaigns record the NFT id here;
        // normalized USD continuity lives in the explicit Stock fields below.
        g.graduatedLiquidityLp = result.positionTokenId;
        g.initialDexPrice = 0;

        stockPositionTokenId = result.positionTokenId;
        stockFinalCurveMemeUsdWad = result.finalCurveMemeUsdWad;
        stockInitialDexMemeUsdWad = result.initialDexMemeUsdWad;

        g.burnedUnusedLpTokens = liquiditySupply - result.memeTokenUsed;
        if (g.burnedUnusedLpTokens > 0) token.burn(address(this), g.burnedUnusedLpTokens);
        g.burnedUnsoldTokens = curveSupply - sold;
        if (g.burnedUnsoldTokens > 0) token.burn(address(this), g.burnedUnsoldTokens);
        if (creatorReserve > 0) meme.safeTransfer(owner(), creatorReserve);

        uint256 creatorPayout = remainingAfterFee - result.nativeLiquidityUsed;
        if (creatorPayout > 0) _sendStockNative(owner(), creatorPayout);

        g.postBurnTotalSupply = token.totalSupply();
        launched = true;
        graduationPending = false;
        finalizedAt = block.timestamp;

        if (factory != address(0)) {
            ILaunchFactoryGraduationNotify(factory).notifyCampaignGraduated(creator, g.dexPair);
        }

        emit StockGraduationCompleted(
            result.canonicalPool,
            graduationQuoteToken,
            result.positionTokenId,
            result.nativeLiquidityUsed,
            result.memeTokenUsed,
            result.stockTokenUsed,
            result.finalCurveMemeUsdWad,
            result.initialDexMemeUsdWad,
            result.priceDeviationBps
        );
        emit CampaignFinalized(
            msg.sender,
            g.dexPair,
            g.graduationBalance,
            g.graduationOvershoot,
            result.memeTokenUsed,
            result.nativeLiquidityUsed,
            result.positionTokenId,
            protocolFee,
            creatorPayout,
            g.burnedUnsoldTokens,
            g.burnedUnusedLpTokens,
            g.finalCurvePrice,
            0,
            g.postBurnTotalSupply
        );

        return (result.canonicalPool, result.positionTokenId);
    }

    function _autoFinalizeIfEligible(address caller) internal override {
        if (!stockGraduationEnabled || graduationPending) return;
        try graduationOracle.nativeTargetForUsd(graduationTarget) returns (uint256 nativeTarget) {
            if (netRaisedWei >= nativeTarget) _markStockGraduationPending(caller, nativeTarget);
        } catch {}
    }

    function _sendStockNative(address to, uint256 value) private {
        (bool success,) = payable(to).call{value: value}("");
        if (!success) revert NativeTransferFailed();
    }
}
