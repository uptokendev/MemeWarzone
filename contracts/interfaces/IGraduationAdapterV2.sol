// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The one graduation adapter interface of the EVM launch generation (BNB Topaz native + quote,
/// Robinhood Uniswap V3 native + stock). Spec: docs/evm-launch/spec/C5-graduation.md section 7.
/// Token flow: the campaign approves `memeMax` to the adapter and sends the pool native as msg.value.
/// The adapter pulls MEME with transferFrom(campaign, ...), never holds MEME between calls, returns any
/// native or quote dust to msg.sender and holds nothing afterwards. An existing pool is accepted and its
/// price repaired; the adapter never reverts because a pool exists. The campaign checks every amount by
/// balance delta and does not trust `Result`.
interface IGraduationAdapterV2 {
    struct Request {
        address token; // campaign MEME
        address quoteToken; // address(0) = native pool
        uint256 memeTarget; // MEME that prices the pool at the curve price with no donation
        uint256 memeMax; // >= memeTarget: MEME the adapter may pull from msg.sender (full burn budget)
        uint256 curvePriceWad; // native per MEME at the curve's last price, 1e18
        uint256 nativeUsdWad; // oracle price used by quote paths, 1e18 (0 on native paths)
        uint256 deadline;
    }

    struct Result {
        address pool;
        uint256 positionId; // V3 NFT id; 0 on V2
        uint256 liquidity; // LP amount (V2) or V3 liquidity, held by the locker
        uint256 memeUsed; // memeTarget <= memeUsed <= memeMax, includes repairMemeSold
        uint256 pairedUsed; // native (msg.value) or quote acquired
        uint256 donationFound; // paired-token balance a third party left in the pool
        uint256 startPriceWad; // pool price after the mint, paired per MEME, 1e18
        bool repaired; // an existing pool was found and repaired
        uint256 repairMemeSold; // V3 repair: MEME sold into a pre-made pool
        uint256 repairProceeds; // V3 repair: native/quote received for it, put into the position
    }

    function graduate(Request calldata r) external payable returns (Result memory);
}
