// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobinhoodV3PoolRepair, RobinhoodV3PriceMath} from "./RobinhoodV3PoolRepair.sol";

interface IRhWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice Robinhood native graduation (MEME/WETH, Uniswap V3 0.30%, full range, permanently locked).
/// Implements IGraduationAdapterV2 exactly. Spec: C5-graduation.md sections 1.8-1.10, 7, 10 and
/// C7-robinhood-adapters.md section 2. Replaces RobinhoodUniswapV3GraduationAdapter, which minted at a
/// griefer's price on a pre-initialized pool and had no caller check.
///
/// Flow of `graduate` (msg.sender = a registered campaign, in Pending, trading just enabled):
/// 1. wrap msg.value (the pool native, plus any native the campaign got back from earlier `repairStep`s);
/// 2. target sqrtT from `curvePriceWad` (wei per whole MEME);
/// 3. find or create+initialize (MEME, WETH, 3000) at sqrtT;
/// 4. if initialized elsewhere, swap the pool itself to sqrtT: free when MEME is too cheap, a sale of
///    at most the spare (memeMax - memeTarget) at >= P when MEME is too expensive;
/// 5. mint full range with the rest of the budget and all WETH, lock the NFT, refund unused MEME and
///    (unwrapped) native to the campaign.
///
/// AUDIT (money path `graduate`): see RobinhoodV3PoolRepair for the shared block. Specific here:
/// - Guard `nonReentrant`; native leaves only as (a) unused WETH, unwrapped and sent to msg.sender (the
///   campaign), computed as `pairedIn + proceeds - pairedMinted` (never `balance`), and (b) repairStep
///   proceeds to msg.sender. `receive` accepts only WETH's unwrap.
/// - Conservation: WETH and MEME balances of this adapter are asserted equal to the entry snapshot.
/// - Native in == native minted + native returned (+0 held). MEME pulled == MEME minted + MEME returned,
///   and MEME sold in the repair was paid by the campaign directly to the pool from its allowance.
contract RobinhoodV3NativeGraduationAdapterV2 is RobinhoodV3PoolRepair {
    constructor(address v3Factory_, address positionManager_, address weth_)
        RobinhoodV3PoolRepair(v3Factory_, positionManager_, weth_)
    {}

    receive() external payable {
        if (msg.sender != WETH) revert InvalidPair();
    }

    /// @notice IGraduationAdapterV2.graduate for the native (WETH) pool. `r.quoteToken` must be 0.
    function graduate(Request calldata r) external payable override nonReentrant returns (Result memory res) {
        _checkCaller(r);
        address paired = _pairedToken(r);
        if (msg.value == 0) revert InvalidRequest();

        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        uint256 memeBefore = IERC20(r.token).balanceOf(address(this));

        // Earlier repairStep proceeds were paid to the campaign as native and come back inside msg.value.
        uint256 stepMemeSold = repairLedger[msg.sender].memeSold;
        delete repairLedger[msg.sender];

        IRhWETH9(WETH).deposit{value: msg.value}();

        bool memeIs0 = r.token < paired;
        Execution memory x = Execution({
            meme: r.token,
            paired: paired,
            memeIs0: memeIs0,
            sqrtTarget: RobinhoodV3PriceMath.sqrtFromPrice(r.curvePriceWad, memeIs0),
            targetPriceWad: r.curvePriceWad,
            memeAvailable: r.memeMax,
            pairedIn: msg.value,
            spare: r.memeMax - r.memeTarget,
            deadline: r.deadline
        });
        (res,,) = _graduateInto(x);
        if (stepMemeSold != 0) res.repaired = true;

        if (IERC20(WETH).balanceOf(address(this)) != wethBefore || IERC20(r.token).balanceOf(address(this)) != memeBefore) {
            revert ConservationBroken();
        }
    }

    function _pairedToken(Request calldata r) internal view override returns (address) {
        if (r.quoteToken != address(0) || r.token == WETH) revert InvalidPair();
        return WETH;
    }

    function _repairStepPriceWad(Request calldata r, address) internal pure override returns (uint256) {
        return r.curvePriceWad;
    }

    function _sendPaired(address, address to, uint256 amount) internal override {
        IRhWETH9(WETH).withdraw(amount);
        _sendNative(to, amount);
    }
}
