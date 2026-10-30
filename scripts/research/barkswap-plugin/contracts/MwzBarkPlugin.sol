// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY. One shared Algebra Integral v1.2.1 plugin for every MemeWarzone custom pool on Barkswap.
// Written against the GPL plugin interface only (no BUSL base-plugin code).
//
// - beforeInitialize: only our launcher may initialize a registered pool.
// - beforeModifyPosition: only our launcher may ADD liquidity (removing is allowed: only the launcher owns positions).
// - beforeSwap: the fee for this swap, gen-8 rules: launch decay 90% -> 2% over 60 s, 2% bonding, 1% when the
//   pool price at the START of the swap is at or past the graduation price (gen-8 F1). Returned as the plugin fee
//   (LP fee 0) or, per pool, as the override (LP) fee to our own positions.
// - afterSwap: graduation latch (graduated + graduatedAt), then drops its own afterSwap flag (pool is unlocked).
// - handlePluginFee: attributes the pushed fees to msg.sender (the pool). Never reverts (except the research switch).
//
// Every pool is token0 = coin, token1 = wrapped native (the launcher enforces it), so a buy is oneToZero.

import {IAlgebraPlugin, IAlgebraPoolMin, IERC20Min, IGraduationView, IBarkLauncherGradFee} from "./BarkInterfaces.sol";

contract MwzBarkPlugin is IAlgebraPlugin, IGraduationView {
    error OnlyLauncher();
    error OnlyOwner();
    error UnknownPool();
    error OnlyLauncherMayInitialize();
    error LiquidityIsLocked();
    error NotOpen();
    error ResearchRevert();
    error AlreadyRegistered();
    error NothingToConvert();
    error BadCallback();

    uint8 public constant CONFIG_BONDING = 1 | 2 | 4 | 128; // BEFORE_SWAP | AFTER_SWAP | BEFORE_POSITION_MODIFY | DYNAMIC_FEE
    uint8 public constant CONFIG_GRADUATED = 1 | 4 | 128; // afterSwap no longer needed once the latch is set
    uint256 internal constant DENOM = 1e6;
    uint256 public constant SNIPER_WINDOW = 60;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;

    address public immutable launcher;
    address public immutable owner; // research only: flips the handlePluginFee revert switch

    struct PoolCfg {
        uint160 sqrtGrad; // graduation price (token1 per token0, Q64.96)
        uint40 openAt;
        uint40 graduatedAt;
        bool registered;
        bool graduated;
        bool lpFeeMode; // false: fee returned as pluginFee (LP fee 0); true: fee returned as overrideFee (LP fee)
        bool gradInline; // true: the latch also takes the 2% graduation fee inside afterSwap
        uint24 bondingFee; // 1e6 units, gen-7 definition (buys: on top of the curve cost)
        uint24 postFee;
        uint24 sniperStartFee;
        address coin;
    }

    mapping(address => PoolCfg) public pools;
    mapping(address => uint256) public feesCoin; // plugin fees pushed by pool (token0)
    mapping(address => uint256) public feesNative; // plugin fees pushed by pool (token1)
    mapping(address => uint256) public convertedNative; // coin fees swapped to native by convertCoinFees
    bool public researchRevertHandle;
    address private _converting;

    event PoolRegistered(address indexed pool, address indexed coin, uint160 sqrtGrad, uint40 openAt, bool lpFeeMode);
    event Graduated(address indexed pool, uint160 price, int24 tick, uint256 graduatedAt);
    event InlineGraduationFee(address indexed pool, bool ok);
    event PluginFeeReceived(address indexed pool, uint256 fee0, uint256 fee1);
    event UnknownPluginFee(address indexed sender, uint256 fee0, uint256 fee1);
    event CoinFeesConverted(address indexed pool, uint256 coinIn, uint256 nativeOut);

    constructor(address _launcher, address _owner) {
        launcher = _launcher;
        owner = _owner;
    }

    // ------------------------------------------------------------------ admin (launcher / research owner)
    function register(address pool, address coin, uint160 sqrtGrad, uint40 openAt, bool lpFeeMode, bool gradInline, uint24 bondingFee, uint24 postFee, uint24 sniperStartFee)
        external
    {
        if (msg.sender != launcher) revert OnlyLauncher();
        PoolCfg storage p = pools[pool];
        if (p.registered) revert AlreadyRegistered();
        p.registered = true;
        p.coin = coin;
        p.sqrtGrad = sqrtGrad;
        p.openAt = openAt;
        p.lpFeeMode = lpFeeMode;
        p.gradInline = gradInline;
        p.bondingFee = bondingFee;
        p.postFee = postFee;
        p.sniperStartFee = sniperStartFee;
        emit PoolRegistered(pool, coin, sqrtGrad, openAt, lpFeeMode);
    }

    function setResearchRevertHandle(bool on) external {
        if (msg.sender != owner) revert OnlyOwner();
        researchRevertHandle = on;
    }

    // ------------------------------------------------------------------ views
    function isGraduated(address pool) external view returns (bool) {
        return pools[pool].graduated;
    }

    /// The gen-7 rate (1e6 units) a swap by `sender` would pay now, by the pool price at the start of the swap.
    function rateOf(address pool, address sender) public view returns (uint24) {
        PoolCfg storage p = pools[pool];
        (uint160 price, , , , , ) = IAlgebraPoolMin(pool).globalState();
        return _rate(p, price, sender);
    }

    function _rate(PoolCfg storage p, uint160 price, address sender) internal view returns (uint24) {
        if (price >= p.sqrtGrad) return p.postFee;
        if (sender == launcher) return p.bondingFee;
        uint256 open = p.openAt;
        if (block.timestamp < open) revert NotOpen();
        uint256 end = open + SNIPER_WINDOW;
        if (block.timestamp >= end) return p.bondingFee;
        return uint24(p.bondingFee + (uint256(p.sniperStartFee - p.bondingFee) * (end - block.timestamp)) / SNIPER_WINDOW);
    }

    function defaultPluginConfig() external pure returns (uint8) {
        return CONFIG_BONDING;
    }

    // ------------------------------------------------------------------ hooks
    function beforeInitialize(address sender, uint160) external view returns (bytes4) {
        if (!pools[msg.sender].registered) revert UnknownPool();
        if (sender != launcher) revert OnlyLauncherMayInitialize();
        return IAlgebraPlugin.beforeInitialize.selector;
    }

    function afterInitialize(address, uint160, int24) external pure returns (bytes4) {
        return IAlgebraPlugin.afterInitialize.selector;
    }

    function beforeModifyPosition(address sender, address, int24, int24, int128 liquidityDelta, bytes calldata) external view returns (bytes4, uint24) {
        if (!pools[msg.sender].registered) revert UnknownPool();
        if (liquidityDelta > 0 && sender != launcher) revert LiquidityIsLocked();
        return (IAlgebraPlugin.beforeModifyPosition.selector, 0);
    }

    function afterModifyPosition(address, address, int24, int24, int128, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IAlgebraPlugin.afterModifyPosition.selector;
    }

    function beforeSwap(address sender, address, bool zeroToOne, int256, uint160, bool, bytes calldata) external view returns (bytes4, uint24, uint24) {
        PoolCfg storage p = pools[msg.sender];
        if (!p.registered) revert UnknownPool();
        (uint160 price, , , , , ) = IAlgebraPoolMin(msg.sender).globalState();
        uint256 rate = _rate(p, price, sender);
        // Algebra takes the fee out of the INPUT. gen-7 charges buys r ON TOP of the curve cost, so a buy
        // (native in, oneToZero) is charged r / (1 + r) of its input; a sell (coin in) r of its input.
        uint24 charged = uint24(zeroToOne ? rate : (rate * DENOM) / (DENOM + rate));
        if (p.lpFeeMode) return (IAlgebraPlugin.beforeSwap.selector, charged, 0);
        return (IAlgebraPlugin.beforeSwap.selector, 0, charged);
    }

    function afterSwap(address, address, bool, int256, uint160, int256, int256, bytes calldata) external returns (bytes4) {
        PoolCfg storage p = pools[msg.sender];
        if (!p.registered) revert UnknownPool();
        if (!p.graduated) {
            (uint160 price, int24 tick, , , , ) = IAlgebraPoolMin(msg.sender).globalState();
            if (price >= p.sqrtGrad) {
                p.graduated = true;
                p.graduatedAt = uint40(block.timestamp);
                emit Graduated(msg.sender, price, tick, block.timestamp);
                // The pool runs _unlock() before _afterSwap, so the plugin may reconfigure it here.
                IAlgebraPoolMin(msg.sender).setPluginConfig(CONFIG_GRADUATED);
                if (p.gradInline) {
                    try IBarkLauncherGradFee(launcher).takeGraduationFee(msg.sender) {
                        emit InlineGraduationFee(msg.sender, true);
                    } catch {
                        emit InlineGraduationFee(msg.sender, false);
                    }
                }
            }
        }
        return IAlgebraPlugin.afterSwap.selector;
    }

    function beforeFlash(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IAlgebraPlugin.beforeFlash.selector;
    }

    function afterFlash(address, address, uint256, uint256, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IAlgebraPlugin.afterFlash.selector;
    }

    /// Called by a pool right after it transferred plugin fees to this contract (every >= 8 h). msg.sender is the
    /// pool, so fees are attributed per pool. Must never revert: a revert here reverts the user's swap.
    function handlePluginFee(uint256 fee0, uint256 fee1) external returns (bytes4) {
        if (researchRevertHandle) revert ResearchRevert();
        if (pools[msg.sender].registered) {
            feesCoin[msg.sender] += fee0;
            feesNative[msg.sender] += fee1;
            emit PluginFeeReceived(msg.sender, fee0, fee1);
        } else {
            emit UnknownPluginFee(msg.sender, fee0, fee1);
        }
        return IAlgebraPlugin.handlePluginFee.selector;
    }

    // ------------------------------------------------------------------ coin fees -> native (research)
    /// Sells this pool's coin plugin fees into the same pool. The plugin's own swap skips every hook and the plugin
    /// fee; with lastFee 0 it pays no LP fee and therefore no community fee either. Permissionless.
    function convertCoinFees(address pool) external returns (uint256 nativeOut) {
        PoolCfg storage p = pools[pool];
        if (!p.registered) revert UnknownPool();
        uint256 amount = feesCoin[pool];
        if (amount == 0) revert NothingToConvert();
        feesCoin[pool] = 0;
        _converting = pool;
        (, int256 a1) = IAlgebraPoolMin(pool).swap(address(this), true, int256(amount), MIN_SQRT_RATIO + 1, "");
        _converting = address(0);
        nativeOut = uint256(-a1);
        feesNative[pool] += nativeOut;
        convertedNative[pool] += nativeOut;
        emit CoinFeesConverted(pool, amount, nativeOut);
    }

    function algebraSwapCallback(int256 amount0Delta, int256, bytes calldata) external {
        if (msg.sender != _converting || _converting == address(0)) revert BadCallback();
        if (amount0Delta > 0) IERC20Min(pools[msg.sender].coin).transfer(msg.sender, uint256(amount0Delta));
    }
}
