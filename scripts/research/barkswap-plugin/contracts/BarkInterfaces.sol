// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

// RESEARCH ONLY. Minimal interfaces for the deployed Algebra Integral v1.2.1 contracts (Barkswap on DogeOS
// Chikyu). Shapes copied from the GPL interfaces of cryptoalgebra/Algebra tag v1.2.1-integral; no BUSL code.

interface IAlgebraPlugin {
    function defaultPluginConfig() external view returns (uint8);
    function handlePluginFee(uint256 pluginFee0, uint256 pluginFee1) external returns (bytes4);
    function beforeInitialize(address sender, uint160 sqrtPriceX96) external returns (bytes4);
    function afterInitialize(address sender, uint160 sqrtPriceX96, int24 tick) external returns (bytes4);
    function beforeModifyPosition(address sender, address recipient, int24 bottomTick, int24 topTick, int128 desiredLiquidityDelta, bytes calldata data)
        external
        returns (bytes4 selector, uint24 pluginFee);
    function afterModifyPosition(
        address sender,
        address recipient,
        int24 bottomTick,
        int24 topTick,
        int128 desiredLiquidityDelta,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external returns (bytes4);
    function beforeSwap(address sender, address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bool withPaymentInAdvance, bytes calldata data)
        external
        returns (bytes4 selector, uint24 feeOverride, uint24 pluginFee);
    function afterSwap(
        address sender,
        address recipient,
        bool zeroToOne,
        int256 amountRequired,
        uint160 limitSqrtPrice,
        int256 amount0,
        int256 amount1,
        bytes calldata data
    ) external returns (bytes4);
    function beforeFlash(address sender, address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external returns (bytes4);
    function afterFlash(address sender, address recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1, bytes calldata data)
        external
        returns (bytes4);
}

interface IAlgebraPluginFactory {
    function beforeCreatePoolHook(address pool, address creator, address deployer, address token0, address token1, bytes calldata data)
        external
        returns (address);
    function afterCreatePoolHook(address plugin, address pool, address deployer) external;
}

interface IAlgebraPoolMin {
    function initialize(uint160 initialPrice) external;
    function mint(address leftoversRecipient, address recipient, int24 bottomTick, int24 topTick, uint128 liquidityDesired, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1, uint128 liquidityActual);
    function burn(int24 bottomTick, int24 topTick, uint128 amount, bytes calldata data) external returns (uint256 amount0, uint256 amount1);
    function collect(address recipient, int24 bottomTick, int24 topTick, uint128 amount0Requested, uint128 amount1Requested)
        external
        returns (uint128 amount0, uint128 amount1);
    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function globalState() external view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked);
    function setPluginConfig(uint8 newConfig) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IAlgebraCustomPoolEntryPoint {
    function createCustomPool(address deployer, address creator, address tokenA, address tokenB, bytes calldata data) external returns (address);
    function setTickSpacing(address pool, int24 newTickSpacing) external;
    function setPluginConfig(address pool, uint8 newConfig) external;
    function setFee(address pool, uint16 newFee) external;
}

interface IAlgebraFactoryMin {
    function computeCustomPoolAddress(address deployer, address token0, address token1) external view returns (address);
}

interface INonfungiblePositionManagerMin {
    struct MintParams {
        address token0;
        address token1;
        address deployer;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

interface IERC20Min {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

interface IWNative is IERC20Min {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IGraduationView {
    function isGraduated(address pool) external view returns (bool);
}

interface IBarkLauncherGradFee {
    function takeGraduationFee(address pool) external returns (uint256 amount0, uint256 amount1);
}
