// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY. Launcher D for Barkswap (Algebra Integral v1.2.1) custom pools. D is the custom-pool deployer and
// the plugin factory: beforeCreatePoolHook returns the ONE shared plugin P for every pool.
//
// launch(), one transaction: deploy the coin (CREATE2), register the pool in P, EP.createCustomPool, initialize at
// the start price, set tick spacing, set lastFee 0 (plugin-fee mode), set the plugin config, mint position A
// (850M, start..graduation) and B (130M, graduation..max) coin-only, owned by D, send the 20M creator reserve, and
// optionally make the creator's first buy at the bonding rate. D has no function that removes A or B except
// takeGraduationFee (2% of A's liquidity, once, after the latch) and collectLpFees (fees only, LP-fee mode).
// Ticks, prices and liquidities are computed off chain by the research runner (production: on chain).

import {IAlgebraPluginFactory, IAlgebraPoolMin, IAlgebraCustomPoolEntryPoint, IAlgebraFactoryMin, INonfungiblePositionManagerMin, IERC20Min, IWNative} from "./BarkInterfaces.sol";
import {MwzBarkPlugin} from "./MwzBarkPlugin.sol";
import {MwzBarkToken} from "./MwzBarkToken.sol";

contract MwzBarkLauncher is IAlgebraPluginFactory {
    error OnlyEntryPoint();
    error UnexpectedPool();
    error CoinMustBeToken0();
    error BadCallback();
    error Reentrancy();
    error UnknownPool();
    error AlreadyTaken();
    error NotGraduated();
    error PriceBelowGraduation();
    error FirstBuyTooLarge();
    error FirstBuyTooSmall();
    error NotLpFeeMode();

    uint256 public constant WAD = 1e18;
    uint256 public constant SUPPLY = 1_000_000_000 * WAD;
    uint256 public constant COINS_A = 850_000_000 * WAD;
    uint256 public constant COINS_B = 130_000_000 * WAD;
    uint256 public constant CREATOR_RESERVE = 20_000_000 * WAD;
    uint256 public constant FIRST_BUY_MAX = 700_000_000 * WAD;
    uint256 public constant GRAD_FEE_BPS = 200;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable entryPoint;
    address public immutable algebraFactoryAddr; // not named factory(): the coin guard asks contracts for factory()
    address public immutable wNative;
    address public immutable npm;
    address public immutable treasury;
    MwzBarkPlugin public immutable plugin;

    struct LaunchParams {
        string name;
        string symbol;
        bytes32 salt;
        bool guard;
        bool useNpm;
        bool lpFeeMode;
        bool gradInline;
        int24 tickSpacing;
        int24 tickStart;
        int24 tickGrad;
        int24 tickMax;
        uint160 sqrtStart;
        uint160 sqrtGrad;
        uint128 liqA;
        uint128 liqB;
        uint24 bondingFee;
        uint24 postFee;
        uint24 sniperStartFee;
        uint256 minFirstBuyOut;
    }

    struct PoolInfo {
        address coin;
        int24 tickStart;
        int24 tickGrad;
        int24 tickMax;
        bool gradFeeTaken;
        bool viaNpm;
        bool lpFeeMode;
        uint128 liqA;
        uint128 liqB;
        uint160 sqrtGrad;
        uint256 npmIdA;
        uint256 npmIdB;
    }

    mapping(address => PoolInfo) public info;
    address private _expectedPool;
    address private _callbackPool;
    uint256 private _lock = 1;

    event Launched(address indexed coin, address indexed pool, address indexed creator, int24 tickStart, int24 tickGrad, int24 tickMax, uint128 liqA, uint128 liqB, uint256 coinsA, uint256 coinsB, uint256 firstBuyIn, uint256 firstBuyOut);
    event GraduationFeeTaken(address indexed pool, uint256 amount0, uint256 amount1, uint128 liquidityRemoved);
    event LpFeesCollected(address indexed pool, uint256 amount0, uint256 amount1);

    constructor(address _entryPoint, address _factory, address _wNative, address _npm, address _treasury) {
        entryPoint = _entryPoint;
        algebraFactoryAddr = _factory;
        wNative = _wNative;
        npm = _npm;
        treasury = _treasury;
        plugin = new MwzBarkPlugin(address(this), msg.sender);
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------------ launch
    function launch(LaunchParams calldata lp) external payable nonReentrant returns (address coin, address pool, uint256 firstBuyOut) {
        coin = address(
            new MwzBarkToken{salt: keccak256(abi.encode(msg.sender, lp.salt))}(
                lp.name,
                lp.symbol,
                SUPPLY,
                address(this),
                lp.guard ? algebraFactoryAddr : address(0),
                address(plugin)
            )
        );
        if (coin >= wNative) revert CoinMustBeToken0();
        pool = IAlgebraFactoryMin(algebraFactoryAddr).computeCustomPoolAddress(address(this), coin, wNative);
        plugin.register(pool, coin, lp.sqrtGrad, uint40(block.timestamp), lp.lpFeeMode, lp.gradInline, lp.bondingFee, lp.postFee, lp.sniperStartFee);

        _expectedPool = pool;
        if (IAlgebraCustomPoolEntryPoint(entryPoint).createCustomPool(address(this), msg.sender, coin, wNative, "") != pool) revert UnexpectedPool();
        _expectedPool = address(0);
        if (lp.guard) MwzBarkToken(coin).setPool(pool);

        IAlgebraPoolMin(pool).initialize(lp.sqrtStart); // P.beforeInitialize: sender must be this launcher
        if (lp.tickSpacing != 60) IAlgebraCustomPoolEntryPoint(entryPoint).setTickSpacing(pool, lp.tickSpacing);
        if (!lp.lpFeeMode) IAlgebraCustomPoolEntryPoint(entryPoint).setFee(pool, 0); // must precede DYNAMIC_FEE

        PoolInfo storage i = info[pool];
        i.coin = coin;
        i.tickStart = lp.tickStart;
        i.tickGrad = lp.tickGrad;
        i.tickMax = lp.tickMax;
        i.sqrtGrad = lp.sqrtGrad;
        i.lpFeeMode = lp.lpFeeMode;

        uint256 balBefore = IERC20Min(coin).balanceOf(address(this));
        if (lp.useNpm) {
            // NPM mints are made BEFORE the LP-blocking config is switched on (the NPM is the pool's msg.sender).
            i.viaNpm = true;
            IERC20Min(coin).approve(npm, COINS_A + COINS_B);
            (i.npmIdA, i.liqA, , ) = INonfungiblePositionManagerMin(npm).mint(
                INonfungiblePositionManagerMin.MintParams(coin, wNative, address(this), lp.tickStart, lp.tickGrad, COINS_A, 0, 0, 0, address(this), block.timestamp)
            );
            (i.npmIdB, i.liqB, , ) = INonfungiblePositionManagerMin(npm).mint(
                INonfungiblePositionManagerMin.MintParams(coin, wNative, address(this), lp.tickGrad, lp.tickMax, COINS_B, 0, 0, 0, address(this), block.timestamp)
            );
            IAlgebraCustomPoolEntryPoint(entryPoint).setPluginConfig(pool, plugin.CONFIG_BONDING());
        } else {
            IAlgebraCustomPoolEntryPoint(entryPoint).setPluginConfig(pool, plugin.CONFIG_BONDING());
            _callbackPool = pool;
            (, , i.liqA) = IAlgebraPoolMin(pool).mint(address(this), address(this), lp.tickStart, lp.tickGrad, lp.liqA, "");
            (, , i.liqB) = IAlgebraPoolMin(pool).mint(address(this), address(this), lp.tickGrad, lp.tickMax, lp.liqB, "");
            _callbackPool = address(0);
        }
        uint256 used = balBefore - IERC20Min(coin).balanceOf(address(this));

        IERC20Min(coin).transfer(msg.sender, CREATOR_RESERVE);
        uint256 dust = IERC20Min(coin).balanceOf(address(this));
        if (dust > 0) IERC20Min(coin).transfer(DEAD, dust);

        if (msg.value > 0) {
            IWNative(wNative).deposit{value: msg.value}();
            _callbackPool = pool;
            (int256 a0, ) = IAlgebraPoolMin(pool).swap(msg.sender, false, int256(msg.value), MAX_SQRT_RATIO - 1, "");
            _callbackPool = address(0);
            firstBuyOut = uint256(-a0);
            if (firstBuyOut > FIRST_BUY_MAX) revert FirstBuyTooLarge();
            if (firstBuyOut < lp.minFirstBuyOut) revert FirstBuyTooSmall();
        }
        emit Launched(coin, pool, msg.sender, lp.tickStart, lp.tickGrad, lp.tickMax, i.liqA, i.liqB, used, dust, msg.value, firstBuyOut);
    }

    // ------------------------------------------------------------------ plugin factory hooks (via the entry point)
    function beforeCreatePoolHook(address pool, address, address deployer, address, address, bytes calldata) external view returns (address) {
        if (msg.sender != entryPoint) revert OnlyEntryPoint();
        if (pool != _expectedPool || deployer != address(this)) revert UnexpectedPool();
        return address(plugin);
    }

    function afterCreatePoolHook(address, address, address) external view {
        if (msg.sender != entryPoint) revert OnlyEntryPoint();
    }

    // ------------------------------------------------------------------ callbacks
    function algebraMintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (msg.sender != _callbackPool || amount1Owed != 0) revert BadCallback();
        if (amount0Owed > 0) IERC20Min(info[msg.sender].coin).transfer(msg.sender, amount0Owed);
    }

    function algebraSwapCallback(int256, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _callbackPool) revert BadCallback();
        if (amount1Delta > 0) IERC20Min(wNative).transfer(msg.sender, uint256(amount1Delta));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ graduation fee (permissionless, once)
    /// Removes floor(liqA * 2%) from position A after the latch, with the price at or past the graduation price (A is
    /// then entirely native), and sends exactly the removed amounts to the treasury. LP fees stay in the position.
    function takeGraduationFee(address pool) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        PoolInfo storage i = info[pool];
        if (i.coin == address(0)) revert UnknownPool();
        if (i.gradFeeTaken) revert AlreadyTaken();
        if (!plugin.isGraduated(pool)) revert NotGraduated();
        (uint160 price, , , , , ) = IAlgebraPoolMin(pool).globalState();
        if (price < i.sqrtGrad) revert PriceBelowGraduation();
        i.gradFeeTaken = true;
        uint128 liq = uint128((uint256(i.liqA) * GRAD_FEE_BPS) / 10_000);
        if (i.viaNpm) {
            (amount0, amount1) = INonfungiblePositionManagerMin(npm).decreaseLiquidity(
                INonfungiblePositionManagerMin.DecreaseLiquidityParams(i.npmIdA, liq, 0, 0, block.timestamp)
            );
            INonfungiblePositionManagerMin(npm).collect(INonfungiblePositionManagerMin.CollectParams(i.npmIdA, treasury, uint128(amount0), uint128(amount1)));
        } else {
            (amount0, amount1) = IAlgebraPoolMin(pool).burn(i.tickStart, i.tickGrad, liq, "");
            IAlgebraPoolMin(pool).collect(treasury, i.tickStart, i.tickGrad, uint128(amount0), uint128(amount1));
        }
        emit GraduationFeeTaken(pool, amount0, amount1, liq);
    }

    /// LP-fee mode only: poke A and B (burn 0) and send their accrued LP fees to the treasury. Permissionless.
    function collectLpFees(address pool) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        PoolInfo storage i = info[pool];
        if (i.coin == address(0)) revert UnknownPool();
        if (!i.lpFeeMode || i.viaNpm) revert NotLpFeeMode();
        IAlgebraPoolMin(pool).burn(i.tickStart, i.tickGrad, 0, "");
        IAlgebraPoolMin(pool).burn(i.tickGrad, i.tickMax, 0, "");
        (uint128 a0, uint128 a1) = IAlgebraPoolMin(pool).collect(treasury, i.tickStart, i.tickGrad, type(uint128).max, type(uint128).max);
        (uint128 b0, uint128 b1) = IAlgebraPoolMin(pool).collect(treasury, i.tickGrad, i.tickMax, type(uint128).max, type(uint128).max);
        amount0 = uint256(a0) + b0;
        amount1 = uint256(a1) + b1;
        emit LpFeesCollected(pool, amount0, amount1);
    }
}
