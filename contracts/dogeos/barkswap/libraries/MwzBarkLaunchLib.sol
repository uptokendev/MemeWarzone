// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MwzV4Token} from "../../../gen8/MwzV4Token.sol";
import {IAlgebraPool} from "../interfaces/core/IAlgebraPool.sol";
import {IAlgebraCustomPoolEntryPoint} from "../interfaces/periphery/IAlgebraCustomPoolEntryPoint.sol";
import {IWNativeToken} from "../interfaces/periphery/external/IWNativeToken.sol";

/// @dev The foundation's GraduationOracle (gen-7, reused unchanged): reverts on a stale, incomplete or non-positive
/// round; `maxPriceAge` is immutable there.
interface IMwzBarkOracle {
    function nativeUsdPrice() external view returns (uint256);
    function nativeTargetForUsd(uint256 usdAmount) external view returns (uint256);
    function maxPriceAge() external view returns (uint256);
}

/// @title MwzBarkLaunchLib: the launch and pool-operation half of MwzBarkLauncher, split out for EIP-170
/// @notice A linked library (external / public functions, called by DELEGATECALL from MwzBarkLauncher, as gen-8 links
/// MwzSwapSim). Audit: docs/dogeos/barkswap-audit.md (MwzBarkLauncher, "Size and the library split").
///
/// - `deployCoin`: the coin's CREATE2 (the embedded MwzV4Token creation code). It runs in the launcher's context, so the
///   CREATE2 deployer and the coin's initial holder are the launcher itself: the coin address formula and bytecode are
///   exactly those of the launcher deploying it directly.
/// - `planLaunch` and the pure helpers: the curve planning (gen-7 curveForMarketCap, the Barkswap-orientation sqrt
///   prices, the spacing-10 grid, the tick and liquidity checks). They read no storage; the pure helpers can also be
///   called on the library address.
/// - `restorePool`, `graduationBurn`, `collectFees`: the pool and entry-point calls of the launcher's `restore`,
///   `takeGraduationFee` and `collect`. In the launcher's context the pool and the entry point see the launcher (the
///   pool's deployer and the positions' owner) as the caller, and WDOGE unwraps pay the launcher. The launcher checks
///   every guard, holds its reentrancy lock and does all of its own bookkeeping around these calls.
/// State-changing functions here can only be reached by DELEGATECALL (Solidity's library call guard). No function here
/// reads or writes the launcher's storage; none holds value after it returns.
library MwzBarkLaunchLib {
    using SafeCast for uint256;

    error OraclePriceUnavailable();
    error OraclePriceOutOfBand();
    error TargetOutOfRangeAtPrice();
    error SupplyBoundBroken();
    error BadTicks();
    error BadLiquidity();
    error PoolBusy();
    error NothingToRestore();
    error GraduationBurnNotNative();
    error CollectMismatch();

    // supply split (spec section 2)
    uint256 internal constant WAD = 1e18;
    uint256 internal constant SUPPLY = 1_000_000_000 * WAD;
    uint256 internal constant COINS_A = 850_000_000 * WAD; // bonding range [tickStart, tickGrad]
    uint256 internal constant COINS_B = 130_000_000 * WAD; // above graduation [tickGrad, TICK_MAX]

    // gen-7 LaunchFactoryGen7 (curveForMarketCap, C8)
    uint256 internal constant G7_BPS = 10_000;
    uint256 internal constant G7_CURVE_BPS = 8500;
    uint256 internal constant G7_LIQ_BPS = 1300;
    uint256 internal constant G7_POOL_MARGIN_BPS = 1;
    uint256 internal constant G7_GRAD_BPS = 200;
    uint256 internal constant MIN_MARKET_CAP_NATIVE = 1e15;
    uint256 internal constant MAX_VIRTUAL_NATIVE = 1e30;

    // pool shape
    int24 internal constant TICK_SPACING = 10;
    /// @dev TickMath.maxUsableTick(10) = 887,270, a multiple of 10: B's top tick.
    int24 internal constant TICK_MAX = 887_270;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q192 = 1 << 192;
    uint8 internal constant PLUGIN_CONFIG = 135; // == MwzBarkPlugin.PLUGIN_CONFIG (the launcher checks it at deploy)
    uint8 internal constant DYNAMIC_FEE_FLAG = 128;

    /// @notice Curve plan of one launch.
    struct LaunchPlan {
        uint256 mc; // graduation market cap in native at the oracle price
        uint256 vN; // gen-7 virtual native
        uint256 vT; // gen-7 virtual token
        int24 tickStart; // A = [tickStart, tickGrad]
        int24 tickGrad; // B = [tickGrad, TICK_MAX]
        uint128 liqA;
        uint128 liqB;
    }

    /// @notice Deploys the coin with CREATE2 from the calling launcher (DELEGATECALL context): salt
    /// keccak256(abi.encode(creator, salt)), constructor (name, symbol, 1B, launcher). Same address and bytecode as a
    /// direct `new MwzV4Token{salt}` in the launcher. A repeated (creator, salt, name, symbol) reverts in CREATE2.
    function deployCoin(string calldata name, string calldata symbol, address creator, uint256 salt) external returns (address) {
        return address(new MwzV4Token{salt: keccak256(abi.encode(creator, salt))}(name, symbol, SUPPLY, address(this)));
    }

    /// @notice F6 / gen-8 L3: the target market cap in native at the oracle price now (the oracle refuses a price older
    /// than its maxPriceAge), refused outside the band; the gen-7 curve; its spacing-10 grid ticks; the liquidity of A
    /// and B. Alignment is checked here so a bad plan reverts with our reason, not the pool's. A and B are coin-only at
    /// the start price (A's lower bound), so both liquidities come from the token0 amount, rounded down.
    function planLaunch(IMwzBarkOracle oracle, uint256 minNativeUsd, uint256 maxNativeUsd, uint256 targetUsd)
        external
        view
        returns (LaunchPlan memory p)
    {
        uint256 price;
        try oracle.nativeUsdPrice() returns (uint256 v) {
            price = v;
        } catch {
            revert OraclePriceUnavailable();
        }
        if (price < minNativeUsd || price > maxNativeUsd) revert OraclePriceOutOfBand();
        try oracle.nativeTargetForUsd(targetUsd) returns (uint256 t) {
            p.mc = t;
        } catch {
            revert OraclePriceUnavailable();
        }
        (p.vN, p.vT) = curveForMarketCap(p.mc);
        (uint160 s0, uint160 s1) = curveSqrtPrices(p.vN, p.vT);
        p.tickStart = nearestGridTick(s0);
        p.tickGrad = nearestGridTick(s1);
        if (
            p.tickStart % TICK_SPACING != 0 || p.tickGrad % TICK_SPACING != 0 || p.tickStart < TickMath.minUsableTick(TICK_SPACING)
                || p.tickStart >= p.tickGrad || p.tickGrad >= TICK_MAX
        ) revert BadTicks();
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(p.tickStart);
        uint160 sqrtGrad = TickMath.getSqrtPriceAtTick(p.tickGrad);
        p.liqA = LiquidityAmounts.getLiquidityForAmount0(sqrtStart, sqrtGrad, COINS_A);
        p.liqB = LiquidityAmounts.getLiquidityForAmount0(sqrtGrad, TickMath.getSqrtPriceAtTick(TICK_MAX), COINS_B);
        // floor(liqA x 2%) must be non-zero (I6); both are ~1e23 for every target the band allows
        if (p.liqA < BPS || p.liqB == 0) revert BadLiquidity();
    }

    /// @notice MwzBarkLauncher.restore's pool part, run in the launcher's context (DELEGATECALL, so the entry point
    /// sees the launcher, the pool's deployer, as the caller): re-applies our plugin (setPlugin also resets the config
    /// to 0), lastFee 0 (only possible while the dynamic-fee flag is off, so the flag is cleared first if needed) and
    /// config 135, in that order (O4). Refuses a pool that is mid-swap (`PoolBusy`) and reverts `NothingToRestore` if
    /// all three already hold. Writes nothing else: no fee, tick spacing or community fee.
    function restorePool(IAlgebraCustomPoolEntryPoint entryPoint, address pool, address plugin)
        external
        returns (bool pluginReset, bool feeReset, bool configReset)
    {
        (,,,,, bool unlocked) = IAlgebraPool(pool).globalState();
        if (!unlocked) revert PoolBusy();
        if (IAlgebraPool(pool).plugin() != plugin) {
            entryPoint.setPlugin(pool, plugin);
            pluginReset = true;
        }
        (,, uint16 lastFee, uint8 config,,) = IAlgebraPool(pool).globalState();
        feeReset = lastFee != 0;
        if (feeReset) {
            if (config & DYNAMIC_FEE_FLAG != 0) {
                entryPoint.setPluginConfig(pool, 0);
                config = 0;
            }
            entryPoint.setFee(pool, 0);
        }
        configReset = config != PLUGIN_CONFIG;
        if (configReset) entryPoint.setPluginConfig(pool, PLUGIN_CONFIG);
        if (!pluginReset && !feeReset && !configReset) revert NothingToRestore();
    }

    /// @notice MwzBarkLauncher.takeGraduationFee's pool part, run in the launcher's context (DELEGATECALL: the
    /// position owner and the WDOGE holder are the launcher). The caller has checked every guard and set its once-flag.
    /// Burns `liq` from A = [tickStart, tickGrad]; at a price at or past A's top tick A is WDOGE only, so the burn
    /// returns no coin (`GraduationBurnNotNative`, unreachable by construction). Collects exactly the burned WDOGE
    /// principal (amount0Requested 0, amount1Requested = the burn), so A's accrued fees in both tokens stay owed to the
    /// position for `collect` (`CollectMismatch` otherwise), and unwraps it. Returns the native amount.
    function graduationBurn(address pool, int24 tickStart, int24 tickGrad, uint128 liq, address wNative)
        external
        returns (uint256 a1)
    {
        uint256 a0;
        (a0, a1) = IAlgebraPool(pool).burn(tickStart, tickGrad, liq, "");
        if (a0 != 0) revert GraduationBurnNotNative();
        (uint128 c0, uint128 c1) = IAlgebraPool(pool).collect(address(this), tickStart, tickGrad, 0, a1.toUint128());
        if (c0 != 0 || c1 != a1) revert CollectMismatch();
        if (a1 > 0) IWNativeToken(wNative).withdraw(a1);
    }

    /// @notice MwzBarkLauncher.collect's pool part, run in the launcher's context (DELEGATECALL: the position owner
    /// and the token recipient are the launcher). Zero-amount burns on A = [tickStart, tickGrad] and B = [tickGrad,
    /// TICK_MAX] move each position's accrued fees into its owed amounts (the pool first hands any balance above its
    /// reserves to the in-range liquidity as fees); then both collects take everything owed. Principal is never owed:
    /// the only non-zero burn (the graduation burn) collects exactly its principal in the same call. The WDOGE received
    /// is unwrapped. Returns the coins and the native received.
    function collectFees(address pool, int24 tickStart, int24 tickGrad, address wNative)
        external
        returns (uint256 coins, uint256 native)
    {
        IAlgebraPool(pool).burn(tickStart, tickGrad, 0, "");
        IAlgebraPool(pool).burn(tickGrad, TICK_MAX, 0, "");
        (uint128 a0, uint128 a1) = IAlgebraPool(pool).collect(address(this), tickStart, tickGrad, type(uint128).max, type(uint128).max);
        (uint128 b0, uint128 b1) = IAlgebraPool(pool).collect(address(this), tickGrad, TICK_MAX, type(uint128).max, type(uint128).max);
        coins = uint256(a0) + b0;
        native = uint256(a1) + b1;
        if (native > 0) IWNativeToken(wNative).withdraw(native);
    }

    /// @notice gen-7 LaunchFactoryGen7.curveForMarketCap, same integer math and C8 bounds (gen-8 MwzV4Launcher copy).
    function curveForMarketCap(uint256 mc) public pure returns (uint256 vN, uint256 vT) {
        if (mc < MIN_MARKET_CAP_NATIVE) revert TargetOutOfRangeAtPrice();
        uint256 curve = (SUPPLY * G7_CURVE_BPS) / G7_BPS;
        uint256 poolDesign = (((SUPPLY * G7_LIQ_BPS) / G7_BPS) * (G7_BPS - G7_POOL_MARGIN_BPS)) / G7_BPS;
        uint256 rn = poolDesign * G7_BPS;
        uint256 rd = (G7_BPS - G7_GRAD_BPS) * curve;
        if (rn >= rd) revert SupplyBoundBroken();
        vT = FullMath.mulDiv(curve, rd, rd - rn);
        vN = FullMath.mulDiv(FullMath.mulDiv(FullMath.mulDiv(mc, vT, SUPPLY), rn, rd), rn, rd);
        if (vN == 0 || vN > MAX_VIRTUAL_NATIVE) revert TargetOutOfRangeAtPrice();
    }

    /// @notice Pool sqrt prices (WDOGE per coin, Q64.96; the coin is token0) of the gen-7 curve at sold = 0 and
    /// sold = 850M. gen-7 price at sold s: vN * vT / (vT - s)^2, so
    ///   start: sqrt(vN / vT)          graduation: sqrt(vN * vT / (vT - 850M)^2)
    /// (the inverse of gen-8's V4 coin-per-native prices; same formula as the research proof's off-chain plan).
    function curveSqrtPrices(uint256 vN, uint256 vT) public pure returns (uint160 sqrtStart, uint160 sqrtGrad) {
        uint256 rest = vT - COINS_A; // vT > curve = 850M (curveForMarketCap: rd / (rd - rn) > 1)
        sqrtStart = Math.sqrt(FullMath.mulDiv(vN, Q192, vT)).toUint160();
        sqrtGrad = Math.sqrt(FullMath.mulDiv(vN * vT, Q192, rest * rest)).toUint160();
    }

    /// @notice Nearest tick on the spacing-10 grid to a sqrt price (gen-8 MwzV4Launcher.nearestGridTick).
    function nearestGridTick(uint160 sqrtP) public pure returns (int24) {
        int24 spacing = TICK_SPACING;
        int24 t = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 lo = (t / spacing) * spacing;
        if (t < 0 && t % spacing != 0) lo -= spacing;
        int24 hi = lo + spacing;
        uint160 sLo = TickMath.getSqrtPriceAtTick(lo);
        uint160 sHi = TickMath.getSqrtPriceAtTick(hi);
        return (sqrtP - sLo <= sHi - sqrtP) ? lo : hi;
    }
}
