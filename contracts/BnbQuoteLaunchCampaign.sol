// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LaunchCampaign, ILaunchFactoryGraduationNotify} from "./LaunchCampaign.sol";

interface IBnbQuoteGraduationExecutor {
    struct GraduationRequest {
        address campaignToken;
        address quoteToken;
        uint256 memeAmountDesired;
        uint256 finalCurvePriceNativeWad;
        uint256 deadline;
    }

    struct GraduationResult {
        address canonicalPool;
        uint256 lpAmount;
        uint256 nativeLiquidityUsed;
        uint256 quoteTokenAcquired;
        uint256 quoteTokenUsed;
        uint256 memeTokenUsed;
        uint256 finalCurveMemeUsdWad;
        uint256 initialDexMemeUsdWad;
        uint256 priceDeviationBps;
    }

    function graduateQuoteLiquidity(GraduationRequest calldata request)
        external
        payable
        returns (GraduationResult memory result);
}

/// @notice New-generation BNB campaign implementation for approved non-native quote graduation.
/// @dev All bonding behavior is inherited unchanged from LaunchCampaign. Crossing the threshold
/// commits PENDING. Any caller may deterministically retry; unsafe attempts revert atomically and
/// leave PENDING intact. There is deliberately no fallback to native MEME/WBNB.
contract BnbQuoteLaunchCampaign is LaunchCampaign {
    using SafeERC20 for IERC20;

    uint256 private constant QUOTE_WAD = 1e18;
    uint256 private constant QUOTE_BPS = 10_000;
    uint256 private constant QUOTE_RETRY_DEADLINE_SECONDS = 15 minutes;
    uint8 private constant ROUTE_KIND_FINALIZE_QUOTE = 1;

    uint256 public quoteFinalCurveMemeUsdWad;
    uint256 public quoteInitialDexMemeUsdWad;
    bytes32 public quoteCatalogBindingHash;

    event QuoteCatalogBindingConfigured(bytes32 indexed quoteCatalogBindingHash);
    event QuoteGraduationCompleted(
        address indexed pool,
        address indexed quoteToken,
        uint256 lpAmount,
        uint256 nativeLiquidityUsed,
        uint256 memeTokenUsed,
        uint256 quoteTokenUsed,
        uint256 finalCurveMemeUsdWad,
        uint256 initialDexMemeUsdWad,
        uint256 priceDeviationBps
    );

    error QuoteCampaignNotConfigured();
    error QuoteGraduationNotPending();
    error QuoteGraduationResultInvalid();
    error QuoteCatalogBindingMissing();
    error QuoteCatalogBindingLocked();

    function isBnbQuoteCampaignImplementation() external pure returns (bool) {
        return true;
    }

    function configureQuoteCatalogBinding(bytes32 bindingHash) external onlyFactory {
        if (bindingHash == bytes32(0)) revert QuoteCatalogBindingMissing();
        if (quoteCatalogBindingHash != bytes32(0) || sold != 0 || netRaisedWei != 0 || launched || graduationPending) {
            revert QuoteCatalogBindingLocked();
        }
        quoteCatalogBindingHash = bindingHash;
        emit QuoteCatalogBindingConfigured(bindingHash);
    }

    function graduateIfEligible(uint256, uint256)
        external
        override
        nonReentrant
        returns (uint256 usedTokens, uint256 usedBnb)
    {
        if (!stockGraduationEnabled || quoteCatalogBindingHash == bytes32(0)) revert QuoteCampaignNotConfigured();
        if (graduationPending) revert GraduationPending();
        uint256 nativeTarget = graduationNativeTarget();
        if (netRaisedWei < nativeTarget) revert ThresholdNotMet();
        _markStockGraduationPending(msg.sender, nativeTarget);
        return (0, 0);
    }

    /// @notice Permissionless deterministic retry for a PENDING approved-quote graduation.
    /// @dev The adapter derives all minimums from its approved route policy and fresh on-chain
    /// quote. If validation/execution fails, this entire call reverts and PENDING remains true.
    function retryQuoteGraduation() external nonReentrant returns (address pool, uint256 lpAmount) {
        if (!stockGraduationEnabled || stockGraduationAdapter == address(0) || graduationQuoteToken == address(0)) {
            revert QuoteCampaignNotConfigured();
        }
        if (quoteCatalogBindingHash == bytes32(0)) revert QuoteCatalogBindingMissing();
        if (!graduationPending) revert QuoteGraduationNotPending();
        if (paused) revert CampaignPaused();
        if (graduationPaused) revert GraduationPaused();
        if (launched) revert Finalized();

        GraduationState storage g = graduation;
        uint256 protocolFee = Math.mulDiv(g.graduationBalance, protocolFeeBps, QUOTE_BPS);
        if (protocolFee > 0 && feeRecipient != address(0)) {
            _routeFeeOrSendLegacy(protocolFee, ROUTE_KIND_FINALIZE_QUOTE, g.graduationBalance);
        }

        uint256 remainingAfterFee = g.graduationBalance - protocolFee;
        uint256 liquidityValue = Math.mulDiv(remainingAfterFee, liquidityBps, QUOTE_BPS);
        uint256 memeAmountDesired = Math.mulDiv(liquidityValue, QUOTE_WAD, g.finalCurvePrice);
        if (memeAmountDesired == 0 || liquidityValue == 0) revert LiquidityZero();
        if (memeAmountDesired > liquiditySupply) {
            uint256 desiredMeme = memeAmountDesired;
            uint256 desiredNative = liquidityValue;
            memeAmountDesired = liquiditySupply;
            liquidityValue = Math.mulDiv(memeAmountDesired, g.finalCurvePrice, QUOTE_WAD);
            if (liquidityValue == 0) revert LiquidityZero();
            emit GraduationLiquidityCapped(desiredMeme, memeAmountDesired, desiredNative, liquidityValue);
        }

        token.enableTrading();

        IERC20 meme = IERC20(address(token));
        address adapter = stockGraduationAdapter;
        meme.forceApprove(adapter, memeAmountDesired);
        IBnbQuoteGraduationExecutor.GraduationResult memory result =
            IBnbQuoteGraduationExecutor(adapter).graduateQuoteLiquidity{value: liquidityValue}(
                IBnbQuoteGraduationExecutor.GraduationRequest({
                    campaignToken: address(token),
                    quoteToken: graduationQuoteToken,
                    memeAmountDesired: memeAmountDesired,
                    finalCurvePriceNativeWad: g.finalCurvePrice,
                    deadline: block.timestamp + QUOTE_RETRY_DEADLINE_SECONDS
                })
            );
        meme.forceApprove(adapter, 0);

        if (
            result.canonicalPool == address(0) || result.lpAmount == 0 ||
            result.nativeLiquidityUsed != liquidityValue || result.memeTokenUsed != memeAmountDesired ||
            result.quoteTokenUsed == 0 || result.quoteTokenUsed != result.quoteTokenAcquired
        ) revert QuoteGraduationResultInvalid();

        g.dexPair = result.canonicalPool;
        g.graduatedLiquidityTokens = result.memeTokenUsed;
        g.graduatedLiquidityBnb = result.nativeLiquidityUsed;
        g.graduatedLiquidityLp = result.lpAmount;
        g.initialDexPrice = 0;
        quoteFinalCurveMemeUsdWad = result.finalCurveMemeUsdWad;
        quoteInitialDexMemeUsdWad = result.initialDexMemeUsdWad;

        g.burnedUnusedLpTokens = liquiditySupply - result.memeTokenUsed;
        if (g.burnedUnusedLpTokens > 0) token.burn(address(this), g.burnedUnusedLpTokens);
        g.burnedUnsoldTokens = curveSupply - sold;
        if (g.burnedUnsoldTokens > 0) token.burn(address(this), g.burnedUnsoldTokens);
        if (creatorReserve > 0) meme.safeTransfer(owner(), creatorReserve);

        uint256 creatorPayout = remainingAfterFee - result.nativeLiquidityUsed;
        if (creatorPayout > 0) _sendQuoteNative(owner(), creatorPayout);

        g.postBurnTotalSupply = token.totalSupply();
        launched = true;
        graduationPending = false;
        finalizedAt = block.timestamp;

        if (factory != address(0)) {
            ILaunchFactoryGraduationNotify(factory).notifyCampaignGraduated(creator, g.dexPair);
        }

        emit QuoteGraduationCompleted(
            result.canonicalPool,
            graduationQuoteToken,
            result.lpAmount,
            result.nativeLiquidityUsed,
            result.memeTokenUsed,
            result.quoteTokenUsed,
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
            result.lpAmount,
            protocolFee,
            creatorPayout,
            g.burnedUnsoldTokens,
            g.burnedUnusedLpTokens,
            g.finalCurvePrice,
            0,
            g.postBurnTotalSupply
        );

        return (result.canonicalPool, result.lpAmount);
    }

    function _autoFinalizeIfEligible(address caller) internal override {
        if (!stockGraduationEnabled || graduationPending) return;
        try graduationOracle.nativeTargetForUsd(graduationTarget) returns (uint256 nativeTarget) {
            if (netRaisedWei >= nativeTarget) _markStockGraduationPending(caller, nativeTarget);
        } catch {}
    }

    function _sendQuoteNative(address to, uint256 value) private {
        (bool success,) = payable(to).call{value: value}("");
        if (!success) revert NativeTransferFailed();
    }
}
