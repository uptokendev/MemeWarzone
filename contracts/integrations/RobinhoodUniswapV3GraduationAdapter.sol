// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ITopazRouter02} from "../interfaces/ITopazRouter02.sol";

interface IRobinhoodV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24 tickSpacing);
}

interface IRobinhoodV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IRobinhoodWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice Compatibility boundary between the existing MemeWarzone graduation ABI and Uniswap V3.
/// @dev LaunchCampaign continues to call ITopazRouter02 unchanged. This adapter translates that
/// call into a full-range V3 NFT position and exposes getPool(address,address,bool) itself so the
/// existing poolFactory()/getPool() lookup resolves to the canonical V3 pool.
contract RobinhoodUniswapV3GraduationAdapter is ITopazRouter02 {
    using SafeERC20 for IERC20;

    uint8 public constant LIQUIDITY_KIND_V3_NFT = 2;
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;

    address public immutable v3Factory;
    address public immutable positionManager;
    address public immutable override WETH;
    uint24 public immutable feeTier;

    error ZeroAddress();
    error StablePoolUnsupported();
    error DeadlineExpired();
    error InvalidFeeTier();
    error InvalidPair();
    error ZeroLiquidity();
    error NativeRefundFailed();
    error SqrtPriceOverflow();

    constructor(address v3Factory_, address positionManager_, address weth_, uint24 feeTier_) {
        if (v3Factory_ == address(0) || positionManager_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        if (v3Factory_.code.length == 0 || positionManager_.code.length == 0 || weth_.code.length == 0) revert ZeroAddress();
        int24 spacing = IRobinhoodV3Factory(v3Factory_).feeAmountTickSpacing(feeTier_);
        if (spacing <= 0) revert InvalidFeeTier();
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        WETH = weth_;
        feeTier = feeTier_;
    }

    receive() external payable {
        if (msg.sender != WETH) revert InvalidPair();
    }

    function liquidityKind() external pure returns (uint8) {
        return LIQUIDITY_KIND_V3_NFT;
    }

    /// @dev Deliberately returns this adapter. LaunchCampaign then calls the legacy
    /// getPool(tokenA, tokenB, stable) selector below, which resolves the real V3 pool.
    function poolFactory() external view override returns (address) {
        return address(this);
    }

    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool) {
        if (stable) revert StablePoolUnsupported();
        return IRobinhoodV3Factory(v3Factory).getPool(tokenA, tokenB, feeTier);
    }

    function addLiquidityETH(
        address token,
        bool stable,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        override
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        if (stable) revert StablePoolUnsupported();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (token == WETH) revert InvalidPair();
        if (amountTokenDesired == 0 || msg.value == 0) revert ZeroLiquidity();
        if (amountTokenDesired < amountTokenMin || msg.value < amountETHMin) revert ZeroLiquidity();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amountTokenDesired);
        IRobinhoodWETH9(WETH).deposit{value: msg.value}();

        bool tokenIs0 = token < WETH;
        address token0 = tokenIs0 ? token : WETH;
        address token1 = tokenIs0 ? WETH : token;
        uint256 amount0Desired = tokenIs0 ? amountTokenDesired : msg.value;
        uint256 amount1Desired = tokenIs0 ? msg.value : amountTokenDesired;
        uint256 amount0Min = tokenIs0 ? amountTokenMin : amountETHMin;
        uint256 amount1Min = tokenIs0 ? amountETHMin : amountTokenMin;

        uint160 sqrtPriceX96 = _sqrtPriceX96(amount0Desired, amount1Desired);
        IRobinhoodV3PositionManager manager = IRobinhoodV3PositionManager(positionManager);
        manager.createAndInitializePoolIfNecessary(token0, token1, feeTier, sqrtPriceX96);

        int24 spacing = IRobinhoodV3Factory(v3Factory).feeAmountTickSpacing(feeTier);
        if (spacing <= 0) revert InvalidFeeTier();
        (int24 tickLower, int24 tickUpper) = _fullRangeTicks(spacing);

        IERC20(token0).forceApprove(positionManager, amount0Desired);
        IERC20(token1).forceApprove(positionManager, amount1Desired);
        (, uint128 mintedLiquidity, uint256 amount0, uint256 amount1) = manager.mint(
            IRobinhoodV3PositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: feeTier,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: to,
                deadline: deadline
            })
        );
        IERC20(token0).forceApprove(positionManager, 0);
        IERC20(token1).forceApprove(positionManager, 0);
        if (mintedLiquidity == 0 || amount0 == 0 || amount1 == 0) revert ZeroLiquidity();

        amountToken = tokenIs0 ? amount0 : amount1;
        amountETH = tokenIs0 ? amount1 : amount0;
        liquidity = uint256(mintedLiquidity);

        uint256 unusedToken = amountTokenDesired - amountToken;
        uint256 unusedWeth = msg.value - amountETH;
        if (unusedToken != 0) IERC20(token).safeTransfer(msg.sender, unusedToken);
        if (unusedWeth != 0) {
            IRobinhoodWETH9(WETH).withdraw(unusedWeth);
            (bool ok, ) = payable(msg.sender).call{value: unusedWeth}("");
            if (!ok) revert NativeRefundFailed();
        }
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) private pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert ZeroLiquidity();
        uint256 ratioX192 = Math.mulDiv(amount1, uint256(1) << 192, amount0);
        uint256 sqrtRatio = Math.sqrt(ratioX192);
        if (sqrtRatio == 0 || sqrtRatio > type(uint160).max) revert SqrtPriceOverflow();
        return uint160(sqrtRatio);
    }

    function _fullRangeTicks(int24 spacing) private pure returns (int24 tickLower, int24 tickUpper) {
        tickLower = (MIN_TICK / spacing) * spacing;
        tickUpper = (MAX_TICK / spacing) * spacing;
    }
}
