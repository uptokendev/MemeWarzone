// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {IAlgebraPool} from "./interfaces/core/IAlgebraPool.sol";
import {MwzBarkLauncher} from "./MwzBarkLauncher.sol";
import {MwzBarkPlugin} from "./MwzBarkPlugin.sol";
import {MwzFeeMath} from "../../gen8/libraries/MwzFeeMath.sol";

/// @title MwzBarkLaunchLens (EVM generation 8 on Barkswap, DogeOS; gen-8 MwzLaunchLens)
/// @notice Stateless read-only views over MwzBarkLauncher, MwzBarkPlugin and each coin's Algebra pool for the app, the
/// API and aggregators. It holds no funds and no state; it reads the launcher and the plugin through their getters and
/// the pool through `globalState()` / `liquidity()`, and uses the same fee math (MwzFeeMath, internal) as the plugin,
/// so a fee quote and an execution share one implementation. Keyed by coin (gen-8 keyed by V4 PoolId). Swap amounts are
/// quoted by Barkswap's own QuoterV2, which runs the real pool and plugin code (gen-8's previewFill / grossForNet
/// replayed V4 and the V4 output-side fee and have no Algebra counterpart here). Diff audit against gen-8's
/// MwzLaunchLens: docs/dogeos/barkswap-audit.md (MwzBarkLaunchLens).
/// Barkswap orientation: coin = token0, WDOGE = token1, the price (WDOGE per coin) rises on buys; position A =
/// [tickStart, tickGrad] holds only coins at the start price and only WDOGE at or past the graduation price.
contract MwzBarkLaunchLens {
    error UnknownCoin();

    MwzBarkLauncher public immutable launcher;
    MwzBarkPlugin public immutable plugin;

    struct Progress {
        bool graduated; // the one-time graduation latch (the plugin's)
        bool postPhase; // F1: the pool price is at or past the graduation price now (post rate applies)
        uint40 graduatedAt; // block time of the latch, 0 before; the reserve releases from graduatedAt + MwzBarkReserveLock.RESERVE_RELEASE_DELAY
        uint160 sqrtPriceX96;
        uint256 coinsSoldFromA; // coins bought out of A at the launch liquidity, from the pool price (exact before graduation)
        uint256 coinsInA; // what A held at launch
        uint256 nativeInA; // WDOGE currently in A
        uint256 nativeTargetA; // WDOGE in A when A is fully bought (graduation)
    }

    constructor(MwzBarkLauncher _launcher) {
        launcher = _launcher;
        plugin = _launcher.plugin();
    }

    /// @notice The rate (bps of the curve amount) a swap whose pool `sender` is `sender` pays right now, as the plugin
    /// computes it: by the current pool price (F1: inside A the bonding rate with the launch decay from openAt, at or
    /// past the graduation price the post rate). Before openAt only the launcher can swap (others revert
    /// TradingNotOpen). For `sender` = the launcher this is the creator first buy's rate (its conversion pays 0).
    /// On the pool the rate is charged on the input: MwzBarkPlugin.algebraFee(rate, buy) gives the Algebra fee units.
    function currentFeeBps(address coin, address sender) external view returns (uint256) {
        (address pool, uint40 openAt,,,,,,,,) = launcher.launches(coin);
        if (pool == address(0)) revert UnknownCoin();
        (uint160 sqrtGrad,,,,,,,,) = plugin.pools(pool);
        (uint160 sqrtP,,,,,) = IAlgebraPool(pool).globalState();
        return MwzFeeMath.rate(plugin.feeConfig(), sqrtP >= sqrtGrad, sender == address(launcher), openAt, block.timestamp);
    }

    /// @notice B: whether a normal trader can swap now, and when trading opens.
    function tradingOpen(address coin) external view returns (bool open, uint256 openAt) {
        address pool;
        (pool, openAt,,,,,,,,) = launcher.launches(coin);
        if (pool == address(0)) revert UnknownCoin();
        open = block.timestamp >= openAt;
    }

    /// @notice Bonding progress from the pool price (design 6.4: coins sold from A / A).
    function progress(address coin) external view returns (Progress memory p) {
        (address pool,, int24 tickStart,, bool gradFeeTaken,,, uint128 liqA,,) = launcher.launches(coin);
        if (pool == address(0)) revert UnknownCoin();
        (uint160 sqrtGrad,, bool graduated, uint40 graduatedAt,,,,,) = plugin.pools(pool);
        (uint160 sqrtP,,,,,) = IAlgebraPool(pool).globalState();
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(tickStart);
        p.graduated = graduated;
        p.graduatedAt = graduatedAt;
        p.postPhase = sqrtP >= sqrtGrad;
        p.sqrtPriceX96 = sqrtP;
        p.coinsInA = SqrtPriceMath.getAmount0Delta(sqrtStart, sqrtGrad, liqA, true);
        p.nativeTargetA = SqrtPriceMath.getAmount1Delta(sqrtStart, sqrtGrad, liqA, false);
        if (sqrtP <= sqrtStart) return p;
        uint160 hi = sqrtP > sqrtGrad ? sqrtGrad : sqrtP;
        p.coinsSoldFromA = p.coinsInA - SqrtPriceMath.getAmount0Delta(hi, sqrtGrad, liqA, false);
        // after the one graduation burn A holds 98% of its liquidity; nativeInA then reflects the current position size
        uint128 liqNow = gradFeeTaken ? liqA - uint128((uint256(liqA) * 200) / 10_000) : liqA;
        p.nativeInA = SqrtPriceMath.getAmount1Delta(sqrtStart, hi, liqNow, false);
    }

    /// @notice The coin's pool as Algebra reports it, plus whether our launch settings still hold (what `restore`
    /// re-applies: our plugin, lastFee 0, config 135). `launchSettings == false` means a Barkswap admin changed the pool
    /// and the keeper should call MwzBarkLauncher.restore(coin).
    struct PoolView {
        address pool;
        uint160 sqrtPriceX96;
        int24 tick;
        uint128 liquidity; // in-range liquidity now
        uint16 lastFee; // Algebra fee units (1e6)
        uint8 pluginConfig;
        uint16 communityFee; // Barkswap's cut, Algebra community-fee units (1e3)
        bool unlocked; // false only while the pool is inside a swap / mint / burn / flash (a mid-operation price)
        bool launchSettings;
    }

    /// @notice The coin's Algebra pool state and whether our launch settings still hold.
    function poolState(address coin) external view returns (PoolView memory v) {
        (address pool,,,,,,,,,) = launcher.launches(coin);
        if (pool == address(0)) revert UnknownCoin();
        v.pool = pool;
        (v.sqrtPriceX96, v.tick, v.lastFee, v.pluginConfig, v.communityFee, v.unlocked) = IAlgebraPool(pool).globalState();
        v.liquidity = IAlgebraPool(pool).liquidity();
        v.launchSettings =
            IAlgebraPool(pool).plugin() == address(plugin) && v.lastFee == 0 && v.pluginConfig == plugin.PLUGIN_CONFIG();
    }

    /// @notice What the coin's fees amount to right now, in the launcher's book order [creator bonding, router bonding,
    /// creator post, router post] (MwzBarkFeeBooks; the order of FeesCollected / CoinFeesConverted).
    struct Owed {
        address feeCreator; // may claim creatorOwed: the creator, the choice vault, or a transferred-to address
        address pendingCreator; // proposed by feeCreator, not yet accepted (0 = none)
        uint256 creatorOwed; // native, claimable now (MwzBarkLauncher.claimCreator)
        uint256[4] coinBooks; // coins collected, waiting for convert
        uint256[4] uncollectedNative; // WDOGE fees the plugin booked since the last collect (net of Barkswap's cut; an estimate within the plugin's rounding tolerance)
        uint256[4] uncollectedCoin; // coin fees the plugin booked since the last collect (same estimate)
        uint40 lastConvertAt; // 0 = never
        uint256 nextConvertAt; // earliest block time convert may run (launch window and interval)
        bool gradFeeTaken;
        uint256 graduationFee; // native taken by the one graduation burn (router bucket, graduation book)
    }

    /// @notice The coin's owed and pending fee amounts (see Owed). Router amounts are pooled across coins in the
    /// launcher (routerOwed, routerPaid) and are read there.
    function owed(address coin) external view returns (Owed memory o) {
        (address pool, uint40 openAt,,, bool gradFeeTaken, address feeCreator, uint40 lastConvertAt,,, uint256 graduationFee) =
            launcher.launches(coin);
        if (pool == address(0)) revert UnknownCoin();
        o.feeCreator = feeCreator;
        o.pendingCreator = launcher.pendingCreator(coin);
        o.creatorOwed = launcher.creatorOwed(coin);
        (uint128 cb, uint128 rb, uint128 cp, uint128 rp) = launcher.coinFees(coin);
        o.coinBooks = [uint256(cb), rb, cp, rp];
        // the plugin's totals only grow and the launcher's snapshot is an earlier copy of them, so no difference underflows
        MwzBarkPlugin.FeeTotals memory t = plugin.feeTotals(pool);
        MwzBarkPlugin.FeeTotals memory s = launcher.collectedTotals(coin);
        o.uncollectedNative = [
            uint256(t.bondingNative.creator - s.bondingNative.creator),
            t.bondingNative.router - s.bondingNative.router,
            t.postNative.creator - s.postNative.creator,
            t.postNative.router - s.postNative.router
        ];
        o.uncollectedCoin = [
            uint256(t.bondingCoin.creator - s.bondingCoin.creator),
            t.bondingCoin.router - s.bondingCoin.router,
            t.postCoin.creator - s.postCoin.creator,
            t.postCoin.router - s.postCoin.router
        ];
        o.lastConvertAt = lastConvertAt;
        uint256 windowEnd = uint256(openAt) + MwzFeeMath.SNIPER_WINDOW;
        uint256 intervalEnd = uint256(lastConvertAt) + launcher.CONVERT_INTERVAL();
        o.nextConvertAt = windowEnd > intervalEnd ? windowEnd : intervalEnd;
        o.gradFeeTaken = gradFeeTaken;
        o.graduationFee = graduationFee;
    }
}
