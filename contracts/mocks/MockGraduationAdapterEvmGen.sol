// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IGraduationAdapterV2} from "../interfaces/IGraduationAdapterV2.sol";
import {MockTopazFactory} from "./MockTopazFactory.sol";
import {MockTopazPool} from "./MockTopazPool.sol";

interface IMockEvmGenCampaign {
    function graduate() external returns (address);
    function buyExactTokens(uint256 amountOut, uint256 maxCost) external payable returns (uint256);
}

/// @dev IGraduationAdapterV2 test double. Pulls MEME from the campaign into a MockTopazPool, keeps the
/// native (or "acquires" quote from its own pre-funded balance at a fixed rate), mints LP to the locker and reports.
/// Behaviour knobs let tests drive every branch of LaunchCampaign.graduate().
contract MockGraduationAdapterEvmGen is IGraduationAdapterV2 {
    MockTopazFactory public immutable topazFactory;
    address public immutable wrapped;
    address public locker;

    bool public shouldRevert;
    bool public useAllMeme; // pull memeMax (a budget-exhausting repair)
    uint256 public extraMeme; // pull memeTarget + extraMeme
    uint256 public memeShortfall; // pull memeTarget - memeShortfall
    uint256 public nativeRefund; // wei of msg.value sent back
    uint256 public startPriceBpsDelta; // report startPrice = P * (1e4 + delta) / 1e4 ...
    bool public startPriceBelow; // ... or P * (1e4 - delta) / 1e4
    bool public lieAboutMemeUsed;
    uint256 public quoteResidual; // quote paths: quote returned to the campaign
    uint256 public quotePerNative = 2; // quote paths: quote acquired = msg.value * quotePerNative
    bool public reenter;

    Request public lastRequest;
    uint256 public lastValue;
    uint256 public calls;

    constructor(address topazFactory_, address wrapped_) {
        topazFactory = MockTopazFactory(topazFactory_);
        wrapped = wrapped_;
    }

    receive() external payable {}

    /// @dev Route-registry views the factories read at create (BNB quote + Robinhood stock).
    function quoteRoutes(address)
        external
        pure
        returns (address, address, uint256, uint16, uint16, uint16, uint16, bool)
    {
        return (address(0), address(0), 0, 0, 0, 0, 0, true);
    }

    function stockRoutes(address)
        external
        pure
        returns (address, address, uint24, uint256, uint16, uint16, uint16, bool)
    {
        return (address(0), address(0), 0, 0, 0, 0, 0, true);
    }

    function setLocker(address locker_) external {
        locker = locker_;
    }

    function setBehaviour(
        bool shouldRevert_,
        bool useAllMeme_,
        uint256 extraMeme_,
        uint256 memeShortfall_,
        uint256 nativeRefund_,
        uint256 startPriceBpsDelta_,
        bool startPriceBelow_
    ) external {
        shouldRevert = shouldRevert_;
        useAllMeme = useAllMeme_;
        extraMeme = extraMeme_;
        memeShortfall = memeShortfall_;
        nativeRefund = nativeRefund_;
        startPriceBpsDelta = startPriceBpsDelta_;
        startPriceBelow = startPriceBelow_;
    }

    function setLie(bool lie) external {
        lieAboutMemeUsed = lie;
    }

    function setQuote(uint256 residual, uint256 perNative) external {
        quoteResidual = residual;
        quotePerNative = perNative;
    }

    function setReenter(bool on) external {
        reenter = on;
    }

    function graduate(Request calldata r) external payable returns (Result memory res) {
        require(!shouldRevert, "adapter down");
        calls += 1;
        lastRequest = r;
        lastValue = msg.value;
        if (reenter) {
            IMockEvmGenCampaign(msg.sender).graduate();
        }
        address paired = r.quoteToken == address(0) ? wrapped : r.quoteToken;
        address pool = topazFactory.createPool(r.token, paired, false);
        uint256 m = useAllMeme ? r.memeMax : r.memeTarget + extraMeme - memeShortfall;
        IERC20(r.token).transferFrom(msg.sender, pool, m);
        uint256 paired_ = msg.value;
        if (r.quoteToken != address(0)) {
            paired_ = msg.value * quotePerNative;
            IERC20(r.quoteToken).transfer(pool, paired_);
            if (quoteResidual != 0) IERC20(r.quoteToken).transfer(msg.sender, quoteResidual);
        }
        MockTopazPool(pool).mint(locker, 1e18);
        if (nativeRefund != 0) {
            (bool ok, ) = msg.sender.call{value: nativeRefund}("");
            require(ok, "refund");
        }
        uint256 start = r.curvePriceWad;
        if (startPriceBpsDelta != 0) {
            start = startPriceBelow
                ? (r.curvePriceWad * (10_000 - startPriceBpsDelta)) / 10_000
                : (r.curvePriceWad * (10_000 + startPriceBpsDelta)) / 10_000;
        }
        res = Result({
            pool: pool,
            positionId: 0,
            liquidity: 1e18,
            memeUsed: lieAboutMemeUsed ? m + 1 : m,
            pairedUsed: paired_,
            donationFound: 0,
            startPriceWad: start,
            repaired: useAllMeme,
            repairMemeSold: 0,
            repairProceeds: 0
        });
    }
}
