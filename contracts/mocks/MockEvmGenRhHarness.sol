// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {LaunchToken} from "../token/LaunchToken.sol";
import {IGraduationAdapterV2} from "../interfaces/IGraduationAdapterV2.sol";
import {RobinhoodV3PriceMath} from "../integrations/RobinhoodV3PoolRepair.sol";

interface IMockEvmGenRhRepairAdapter {
    function repairStep(IGraduationAdapterV2.Request calldata r, uint160 sqrtPriceLimitX96)
        external
        returns (uint256 memeSold, uint256 proceeds);
}

/// @notice Test-only factory: isCampaign registry + the locker pointer the adapters bind to.
contract MockEvmGenRhFactory {
    mapping(address => bool) public isCampaign;
    address public permanentLpLocker;

    constructor(address locker) {
        permanentLpLocker = locker;
    }

    function setCampaign(address campaign, bool allowed) external {
        isCampaign[campaign] = allowed;
    }
}

/// @notice Test-only campaign that mirrors what the C5 campaign does around the adapter call:
/// it owns a real LaunchToken (transfers locked until enableTrading), enables trading inside the
/// graduation call immediately before the adapter call, approves exactly memeMax, resets the allowance,
/// and measures everything by balance delta. `repairPool` mirrors the permissionless chunked repair.
contract MockEvmGenRhCampaign {
    using SafeERC20 for IERC20;

    LaunchToken public token;

    // Repair bookkeeping (what the C5 campaign keeps): MEME that left the budget, proceeds it holds.
    uint256 public repairMemeSold;
    uint256 public repairNativeProceeds;
    uint256 public repairQuoteProceeds;

    // Last graduation, measured by deltas.
    uint256 public lastMemeBack;
    uint256 public lastMemeUsed;
    uint256 public lastNativeBack;
    uint256 public lastQuoteBack;
    IGraduationAdapterV2.Result internal _last;

    receive() external payable {}

    function init(bytes32 salt, uint256 supply) external {
        require(address(token) == address(0), "init");
        token = new LaunchToken{salt: salt}("Meme", "MEME", supply, address(this));
        token.mint(address(this), supply);
    }

    function lastResult() external view returns (IGraduationAdapterV2.Result memory) {
        return _last;
    }

    /// @dev A "buyer" receives MEME from the campaign (allowed pre-trading: from == owner).
    function giveMeme(address to, uint256 amount) external {
        IERC20(address(token)).safeTransfer(to, amount);
    }

    function enableTrading() external {
        token.enableTrading();
    }

    /// @dev Raw calls for branch tests: any request, any value.
    function callGraduate(address adapter, IGraduationAdapterV2.Request calldata r, uint256 value)
        external
        returns (IGraduationAdapterV2.Result memory)
    {
        return IGraduationAdapterV2(adapter).graduate{value: value}(r);
    }

    function callRepair(address adapter, IGraduationAdapterV2.Request calldata r, uint160 limit)
        external
        returns (uint256, uint256)
    {
        return IMockEvmGenRhRepairAdapter(adapter).repairStep(r, limit);
    }

    function budgetRemaining(uint256 budget) public view returns (uint256) {
        return budget - repairMemeSold;
    }

    function graduate(
        address adapter,
        address quoteToken,
        uint256 memeTarget,
        uint256 budget,
        uint256 curvePriceWad,
        uint256 poolNative
    ) external returns (IGraduationAdapterV2.Result memory res) {
        IERC20 meme = IERC20(address(token));
        uint256 memeMax = budget - repairMemeSold;
        if (!token.tradingEnabled()) token.enableTrading();

        uint256 nativeIn = poolNative + repairNativeProceeds;
        uint256 quoteProceeds = repairQuoteProceeds;
        if (quoteToken != address(0) && quoteProceeds != 0) IERC20(quoteToken).forceApprove(adapter, quoteProceeds);
        meme.forceApprove(adapter, memeMax);

        uint256 memeBefore = meme.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance - nativeIn;
        uint256 quoteBefore = quoteToken == address(0) ? 0 : IERC20(quoteToken).balanceOf(address(this));

        res = IGraduationAdapterV2(adapter).graduate{value: nativeIn}(
            IGraduationAdapterV2.Request({
                token: address(meme),
                quoteToken: quoteToken,
                memeTarget: memeTarget,
                memeMax: memeMax,
                curvePriceWad: curvePriceWad,
                nativeUsdWad: 0,
                deadline: block.timestamp + 1
            })
        );
        meme.forceApprove(adapter, 0);
        if (quoteToken != address(0)) IERC20(quoteToken).forceApprove(adapter, 0);

        lastMemeBack = meme.balanceOf(address(this)) - (memeBefore - memeMax);
        lastMemeUsed = memeMax - lastMemeBack;
        lastNativeBack = address(this).balance - nativeBefore;
        if (quoteToken != address(0)) {
            lastQuoteBack = IERC20(quoteToken).balanceOf(address(this)) + quoteProceeds - quoteBefore;
        }
        repairNativeProceeds = 0;
        repairQuoteProceeds = 0;
        _last = res;
    }

    function repairPool(
        address adapter,
        address quoteToken,
        uint256 memeTarget,
        uint256 budget,
        uint256 curvePriceWad,
        uint160 limit
    ) external returns (uint256 memeSold, uint256 proceeds) {
        IERC20 meme = IERC20(address(token));
        uint256 memeMax = budget - repairMemeSold;
        meme.forceApprove(adapter, memeMax - memeTarget);
        uint256 memeBefore = meme.balanceOf(address(this));
        (memeSold, proceeds) = IMockEvmGenRhRepairAdapter(adapter).repairStep(
            IGraduationAdapterV2.Request({
                token: address(meme),
                quoteToken: quoteToken,
                memeTarget: memeTarget,
                memeMax: memeMax,
                curvePriceWad: curvePriceWad,
                nativeUsdWad: 0,
                deadline: block.timestamp + 1
            }),
            limit
        );
        meme.forceApprove(adapter, 0);
        require(memeBefore - meme.balanceOf(address(this)) == memeSold, "meme delta");
        repairMemeSold += memeSold;
        if (quoteToken == address(0)) repairNativeProceeds += proceeds;
        else repairQuoteProceeds += proceeds;
    }
}

interface IMockEvmGenRhPool {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Test-only griefer: seeds positions straight on a V3 pool, and tries the attacks C7 section 7
/// says must fail. Pays owed tokens from its own balance.
contract MockEvmGenRhGriefer {
    using SafeERC20 for IERC20;

    function mintRange(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity) public {
        IMockEvmGenRhPool(pool).mint(address(this), tickLower, tickUpper, liquidity, abi.encode(pool));
    }

    /// @dev `count` adjacent ranges of `width` ticks starting at `firstLower`.
    function mintLadder(address pool, int24 firstLower, int24 width, uint256 count, uint128 liquidity) external {
        for (uint256 i = 0; i < count; i++) {
            int24 lower = firstLower + int24(int256(i)) * width;
            mintRange(pool, lower, lower + width, liquidity);
        }
    }

    function swapExactIn(address pool, bool zeroForOne, int256 amount, uint160 limit) external {
        IMockEvmGenRhPool(pool).swap(address(this), zeroForOne, amount, limit, abi.encode(pool));
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "pool");
        if (amount0Owed != 0) IERC20(IMockEvmGenRhPool(pool).token0()).safeTransfer(pool, amount0Owed);
        if (amount1Owed != 0) IERC20(IMockEvmGenRhPool(pool).token1()).safeTransfer(pool, amount1Owed);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "pool");
        if (amount0Delta > 0) IERC20(IMockEvmGenRhPool(pool).token0()).safeTransfer(pool, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(IMockEvmGenRhPool(pool).token1()).safeTransfer(pool, uint256(amount1Delta));
    }

    function withdraw(address token, address to) external {
        IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }
}

/// @notice Test-only V3 factory surface with a configurable tick spacing (constructor refusal tests).
contract MockEvmGenRhSpacingFactory {
    int24 public spacing;

    constructor(int24 spacing_) {
        spacing = spacing_;
    }

    function feeAmountTickSpacing(uint24) external view returns (int24) {
        return spacing;
    }

    function getPool(address, address, uint24) external pure returns (address) {
        return address(0);
    }
}

/// @notice Exposes RobinhoodV3PriceMath for unit tests.
contract MockEvmGenRhPriceMath {
    function sqrtFromPrice(uint256 p, bool memeIs0) external pure returns (uint160) {
        return RobinhoodV3PriceMath.sqrtFromPrice(p, memeIs0);
    }

    function priceFromSqrt(uint160 s, bool memeIs0) external pure returns (uint256) {
        return RobinhoodV3PriceMath.priceFromSqrt(s, memeIs0);
    }
}
