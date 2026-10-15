// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IAlgebraPlugin} from "./interfaces/core/plugin/IAlgebraPlugin.sol";
import {IAlgebraPoolState} from "./interfaces/core/pool/IAlgebraPoolState.sol";
import {IAlgebraPoolImmutables} from "./interfaces/core/pool/IAlgebraPoolImmutables.sol";
import {IMwzBarkLauncher} from "./interfaces/IMwzBarkLauncher.sol";
import {FeeConfig} from "../../gen8/interfaces/IMwzLaunchHook.sol";
import {MwzFeeMath} from "../../gen8/libraries/MwzFeeMath.sol";

/// @title MwzBarkPlugin (EVM generation 8 on Barkswap, DogeOS)
/// @notice The one shared Algebra Integral 1.2.1 plugin for every MemeWarzone custom pool on Barkswap: the swap side of
/// gen-8's MwzLaunchHook. Spec: docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md sections 2-3; audit:
/// docs/dogeos/barkswap-audit.md (MwzBarkPlugin).
///
/// Every pool is token0 = the coin, token1 = WDOGE (checked at initialize), so a buy is oneToZero (WDOGE in) and the
/// pool price (WDOGE per coin) rises on buys: position A spans [tickStart, tickGrad], position B [tickGrad, max). The
/// start and graduation prices are DERIVED from the registered ticks (TickMath, as gen-8's hook does), so they sit
/// exactly on A's lower and upper tick: below sqrtStart no liquidity exists (F2), at or past sqrtGrad A holds WDOGE only.
///
/// - LP-fee mode (B4): `beforeSwap` returns the swap's fee as Algebra's `overrideFee`; the pool's `lastFee` is 0 (the
///   launcher sets it before the dynamic-fee flag), our positions are the only liquidity, so the fee accrues to the
///   launcher's A/B positions. This plugin never receives, holds or moves fees (pluginFee is always 0).
/// - Rate (gen-8 F1, B): the rate follows the pool price at swap START: inside A the bonding rate with the 60 s launch
///   decay from openAt (MwzFeeMath, the gen-8 schedule), at or past the graduation price the post-graduation rate. No
///   swap before openAt except the launcher's creator first buy (bonding rate). Fees are input-side: a sell pays the
///   rate r of its coin input; a buy pays r/(1+r) of its WDOGE input, so the curve gets input/(1+r) and the fee is
///   r on top of it (gen-7), within the 1e6 fee-unit rounding.
/// - Conversion: the launcher's coin-fee conversion sell (recognised through its transient flag) returns overrideFee 0,
///   which with lastFee 0 is a true 0 fee; it is refused if lastFee is not 0, and inside the 60 s launch window.
/// - `afterSwap`: no sell may leave the price below the start price (F2); per-pool, per-phase fee totals (creator amount
///   on the GROSS fee, router remainder net of the community fee read at swap time; B10); one `BarkSwap` event per
///   swap; the graduation latch + graduatedAt; the inline graduation fee through the launcher (failure tolerated).
/// - Liquidity: only the launcher may add liquidity, to itself, in ranges at or above tickStart that do not straddle
///   tickGrad; the launcher's only non-zero burn is the one graduation burn, of a range at or below tickGrad, refused
///   before the latch, inside A or a second time (defense in depth for I6).
///
/// Reentrancy / CEI (full statement per function in the audit file): every hook acts only on the pool that calls it
/// (msg.sender must be a registered pool) and on that pool's own state; per-swap hand-over is in transient storage keyed
/// by pool (a nested swap on another pool from inside a swap callback cannot clobber it). External calls: the calling
/// pool's views, the launcher's view `conversionInProgress` (only for launcher swaps), and the inline graduation fee,
/// which is the last action of `afterSwap`, after every state write.
contract MwzBarkPlugin is IAlgebraPlugin {
    using SafeCast for uint256;

    error ZeroAddress();
    error BadWiring();
    error NotLauncher();
    error UnknownPool();
    error PoolExists();
    error BadTicks();
    error BadOpenAt();
    error OnlyLauncherMayInitialize();
    error BadStartPrice();
    error BadPoolTokens();
    error LiquidityIsLocked();
    error BadPositionRange();
    error GraduationBurnRefused();
    error TradingNotOpen();
    error ConversionMustSell();
    error ConversionFeeNotZero();
    error ConversionInLaunchWindow();
    error PriceBelowStart();

    // Algebra Integral 1.2.1 plugin config flags (libraries/Plugins.sol)
    uint8 public constant BEFORE_SWAP_FLAG = 1;
    uint8 public constant AFTER_SWAP_FLAG = 2;
    uint8 public constant BEFORE_POSITION_MODIFY_FLAG = 4;
    uint8 public constant DYNAMIC_FEE_FLAG = 128;
    /// @notice The one plugin config of every MemeWarzone pool, at launch and after `restore`: 1 | 2 | 4 | 128 = 135.
    uint8 public constant PLUGIN_CONFIG = BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG | BEFORE_POSITION_MODIFY_FLAG | DYNAMIC_FEE_FLAG;

    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_DENOMINATOR = 1e6; // Algebra fee units: 10_000 = 1%
    uint256 public constant COMMUNITY_FEE_DENOMINATOR = 1e3; // Algebra community fee units: 30 = 3% of the fee
    uint256 internal constant BPS_TO_FEE_UNITS = 100;

    // gen-8 rates (MwzV4Launcher L1 constants), bps of the curve amount (gen-7 definition). Fixed forever (I12).
    uint16 public constant BONDING_FEE_BPS = 200;
    uint16 public constant POST_FEE_BPS = 100;
    uint16 public constant CREATOR_POST_BPS = 50; // of volume after graduation = 50% of the post fee
    uint16 public constant SNIPER_START_BPS = 9000;
    uint16 public constant CREATOR_BONDING_BPS = 560; // D2: share of every bonding fee
    uint256 public constant MAX_OPEN_DELAY = 30 days; // B: openAt in [registration, registration + 30 days]

    uint8 public constant PHASE_BONDING = 0; // swap started with the price inside A (incl. the crossing swap)
    uint8 public constant PHASE_POST = 1; // swap started at or past the graduation price

    uint8 public constant KIND_TRADE = 0; // any other sender, incl. the launcher's creator first buy
    uint8 public constant KIND_CONVERSION = 1; // the launcher's coin-fee conversion sell
    uint8 public constant KIND_ESCROW_BUY = 2; // sender == creatorEscrow
    uint8 public constant KIND_BUYBACK = 3; // sender == choiceVault

    // transient hand-over beforeSwap -> afterSwap, one slot per pool: keccak256(abi.encode(T_SWAP, pool))
    bytes32 internal constant T_SWAP = keccak256("mwz.dogeos.bark.plugin.swap");
    uint256 internal constant HANDOVER_SET = 1 << 255;

    address public immutable launcher;
    address public immutable wNative; // WDOGE, token1 of every pool
    /// @notice Swap-kind labels only (no money or permission depends on them): swaps whose sender is one of these are
    /// labelled escrow buy / choice-vault buyback in `BarkSwap`. Both contracts must call `pool.swap` themselves.
    address public immutable creatorEscrow;
    address public immutable choiceVault;

    /// @dev slot 0: sqrtGrad (20) + openAt (5) + graduated (1) + graduatedAt (5) + gradBurnDone (1) = 32 bytes;
    /// slot 1: coin (20) + tickStart (3) + tickGrad (3); slot 2: sqrtStart.
    struct PoolState {
        uint160 sqrtGrad; // getSqrtPriceAtTick(tickGrad): graduation price (WDOGE per coin, Q64.96); 0 = not ours
        uint40 openAt; // trading opens; the launch-fee decay starts here
        bool graduated; // the latch: false -> true once, never back (I7)
        uint40 graduatedAt; // block time of the latch, 0 before (I17)
        bool gradBurnDone; // the launcher's one graduation burn went through this plugin
        address coin; // token0
        int24 tickStart; // A's lower tick
        int24 tickGrad; // A's upper tick = B's lower tick
        uint160 sqrtStart; // getSqrtPriceAtTick(tickStart): start price = initialize price = the F2 floor
    }

    /// @notice Running totals of the fee booked in one phase and one token. creator + router == the net fee (gross
    /// minus Barkswap's community cut) booked for that phase and token; the creator part is on the gross fee and is
    /// paid first, the router part is the rest (never negative).
    struct FeeBook {
        uint128 creator;
        uint128 router;
    }

    /// @notice Per pool: bonding / post-graduation x WDOGE (buy fees) / coin (sell fees).
    struct FeeTotals {
        FeeBook bondingNative;
        FeeBook bondingCoin;
        FeeBook postNative;
        FeeBook postCoin;
    }

    /// @dev One swap, assembled in afterSwap (memory, keeps the stack shallow).
    struct SwapRecord {
        uint8 kind;
        uint8 phase;
        bool buy;
        bool crossing;
        uint16 rateBps;
        uint24 feeUnits;
        uint16 communityFee;
        uint256 nativeAmount;
        uint256 coinAmount;
        uint256 curveAmount;
        uint256 grossFee;
        uint256 netFee;
        uint256 creatorAmount;
        uint160 priceAfter;
    }

    mapping(address pool => PoolState) public pools;
    mapping(address pool => FeeTotals) internal _fees;

    event PoolRegistered(
        address indexed pool, address indexed coin, int24 tickStart, int24 tickGrad, uint160 sqrtStart, uint160 sqrtGrad, uint40 openAt
    );
    /// @notice One per swap on one of our pools. `sender` is the contract that called pool.swap (a router, the
    /// launcher, the escrow or the choice vault); the trader is the transaction sender. Buy: `nativeAmount` = WDOGE in
    /// (fee included), `coinAmount` = coins out; sell: `coinAmount` = coins in (fee included), `nativeAmount` = WDOGE
    /// out. `curveAmount` is gen-7 volume: the WDOGE that reached the curve on a buy (fee excluded), the WDOGE payout on
    /// a sell. `grossFee`, `netFee` (after Barkswap's community cut) and `creatorAmount` are in `feeToken` (WDOGE on
    /// buys, the coin on sells); the router remainder is netFee - creatorAmount. `rateBps` is the gen-7 rate the plugin
    /// set for the swap (0 for a conversion or when the before-swap hook did not run), `feeUnits` the fee the pool
    /// charged on the input (1e6 units; lastFee instead of the rate if an admin turned the dynamic-fee flag off),
    /// `communityFee` Barkswap's cut at swap time (1e3 units). `phase` is the fee phase by the start price;
    /// `crossing` marks the swap that set the graduation latch. `kind`: 0 trade, 1 conversion, 2 escrow buy,
    /// 3 choice-vault buyback.
    event BarkSwap(
        address indexed pool,
        address indexed coin,
        address indexed sender,
        uint8 kind,
        bool buy,
        uint8 phase,
        bool crossing,
        uint256 nativeAmount,
        uint256 coinAmount,
        uint256 curveAmount,
        address feeToken,
        uint256 grossFee,
        uint256 netFee,
        uint256 creatorAmount,
        uint16 rateBps,
        uint24 feeUnits,
        uint16 communityFee,
        uint160 sqrtPriceAfter
    );
    event Graduated(address indexed pool, address indexed coin, uint160 sqrtPrice, uint40 graduatedAt);
    /// @notice Outcome of the inline graduation-fee call in the latching swap; `ok == false` leaves the fee to the
    /// launcher's permissionless fallback.
    event GraduationFeeInline(address indexed pool, bool ok);
    /// @notice Plugin fees pushed by one of our pools. Never expected (this plugin charges no plugin fee); only possible
    /// if a Barkswap admin installed another plugin that charged one and ours was restored before the pool's 8 h push.
    /// Accepted (a revert would make every later fee-bearing swap of that pool revert) and left in this contract.
    event ForeignPluginFee(address indexed pool, uint256 fee0, uint256 fee1);

    /// @param launcher_ MwzBarkLauncher (custom-pool deployer and plugin factory); its constructor checks
    /// `plugin.launcher() == address(this)`.
    constructor(address launcher_, address wNative_, address creatorEscrow_, address choiceVault_) {
        if (launcher_ == address(0) || wNative_ == address(0) || creatorEscrow_ == address(0) || choiceVault_ == address(0)) {
            revert ZeroAddress();
        }
        if (creatorEscrow_ == launcher_ || choiceVault_ == launcher_ || creatorEscrow_ == choiceVault_) revert BadWiring();
        launcher = launcher_;
        wNative = wNative_;
        creatorEscrow = creatorEscrow_;
        choiceVault = choiceVault_;
    }

    // ================================================================== registration (launcher only)

    /// @notice Registers a pool before it exists (launcher obligation O1): A's ticks [tickStart, tickGrad] and openAt.
    /// The start and graduation prices are derived here from the ticks, so they are exactly A's bounds. Fixed forever.
    /// @dev Launcher only; no external call (TickMath is an internal library). CEI: checks, then one storage write.
    /// Reachable once per pool address, and only while that address has no code, so an existing (foreign) pool can
    /// never be registered. getSqrtPriceAtTick cannot revert: both ticks are inside [MIN_TICK, MAX_TICK).
    function registerPool(address pool, address coin, int24 tickStart, int24 tickGrad, uint40 openAt) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (pool == address(0) || coin == address(0)) revert ZeroAddress();
        if (pools[pool].sqrtGrad != 0 || pool.code.length != 0) revert PoolExists();
        // B needs room above tickGrad: tickGrad < MAX_TICK
        if (tickStart < TickMath.MIN_TICK || tickStart >= tickGrad || tickGrad >= TickMath.MAX_TICK) revert BadTicks();
        if (openAt < block.timestamp || openAt > block.timestamp + MAX_OPEN_DELAY) revert BadOpenAt();
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(tickStart);
        uint160 sqrtGrad = TickMath.getSqrtPriceAtTick(tickGrad);
        pools[pool] = PoolState({
            sqrtGrad: sqrtGrad,
            openAt: openAt,
            graduated: false,
            graduatedAt: 0,
            gradBurnDone: false,
            coin: coin,
            tickStart: tickStart,
            tickGrad: tickGrad,
            sqrtStart: sqrtStart
        });
        emit PoolRegistered(pool, coin, tickStart, tickGrad, sqrtStart, sqrtGrad, openAt);
    }

    // ================================================================== views

    /// @notice The fee totals booked for `pool` (see FeeBook). Read by the launcher's collect to apportion what it
    /// collects between the phase books.
    function feeTotals(address pool) external view returns (FeeTotals memory) {
        return _fees[pool];
    }

    /// @notice The gen-8 rates as gen-8's FeeConfig (bps), for MwzFeeMath and the lens.
    function feeConfig() public pure returns (FeeConfig memory) {
        return FeeConfig({
            bondingBps: BONDING_FEE_BPS,
            postBps: POST_FEE_BPS,
            creatorPostBps: CREATOR_POST_BPS,
            sniperStartBps: SNIPER_START_BPS,
            creatorBondingBps: CREATOR_BONDING_BPS
        });
    }

    /// @notice Algebra fee (1e6 units, charged on the input) for a gen-7 rate in bps: r on a sell, r/(1+r) on a buy
    /// (rounded down). rateBps <= 9000 gives at most 900_000 (sell) / 473_684 (buy), below Algebra's 1e6 cap.
    function algebraFee(uint256 rateBps, bool buy) public pure returns (uint24) {
        uint256 units = rateBps * BPS_TO_FEE_UNITS;
        if (buy) units = (units * FEE_DENOMINATOR) / (FEE_DENOMINATOR + units);
        return units.toUint24();
    }

    function defaultPluginConfig() external pure returns (uint8) {
        return PLUGIN_CONFIG;
    }

    /// @notice IAlgebraDynamicFeePlugin.getCurrentFee (selector of Algebra 1.2.1's interface): the pool's `fee()` view
    /// calls it on the plugin when the dynamic-fee flag is set (msg.sender = the pool), and Barkswap's UI, subgraph and
    /// periphery read `fee()`. Without it `pool.fee()` would revert on our pools.
    /// @return The fee a non-launcher SELL would pay now, in 1e6 units, launch decay included, phase by the current
    /// price (a buy pays r/(1+r) of its input, slightly less); capped at type(uint16).max (6.5535%) because the
    /// Algebra interface is uint16, so during most of the 60 s launch window it reports the cap. 0 for a caller that is
    /// not one of our pools. Informational only: no swap reads it (beforeSwap computes the fee itself).
    function getCurrentFee() external view returns (uint16) {
        PoolState storage st = pools[msg.sender];
        uint160 sqrtGrad = st.sqrtGrad;
        if (sqrtGrad == 0) return 0;
        (uint160 price,,,,,) = IAlgebraPoolState(msg.sender).globalState();
        uint256 rateBps = MwzFeeMath.rate(feeConfig(), price >= sqrtGrad, false, st.openAt, block.timestamp);
        uint256 units = algebraFee(rateBps, false);
        return units > type(uint16).max ? type(uint16).max : uint16(units);
    }

    // ================================================================== initialize and liquidity hooks

    /// @dev Always called by Algebra's initialize when a plugin is set. Only the launcher initializes, only at the
    /// registered start price, and only a pool with the coin as token0 and WDOGE as token1.
    function beforeInitialize(address sender, uint160 sqrtPriceX96) external view returns (bytes4) {
        PoolState storage st = pools[msg.sender];
        if (st.sqrtGrad == 0) revert UnknownPool();
        if (sender != launcher) revert OnlyLauncherMayInitialize();
        if (sqrtPriceX96 != st.sqrtStart) revert BadStartPrice();
        if (IAlgebraPoolImmutables(msg.sender).token0() != st.coin || IAlgebraPoolImmutables(msg.sender).token1() != wNative) {
            revert BadPoolTokens();
        }
        return IAlgebraPlugin.beforeInitialize.selector;
    }

    /// @dev Not in PLUGIN_CONFIG; returns the selector so an admin-set flag cannot brick the pool.
    function afterInitialize(address, uint160, int24) external pure returns (bytes4) {
        return IAlgebraPlugin.afterInitialize.selector;
    }

    /// @dev Adds: only the launcher, for itself, in a range at or above tickStart that does not straddle tickGrad (A is
    /// [tickStart, tickGrad], B [tickGrad, max]). Burns of other owners (none exist unless an admin cleared our config)
    /// pass. The launcher's non-zero burn is the graduation burn: a range inside [tickStart, tickGrad] (so at a price at
    /// or past sqrtGrad it returns WDOGE only, and only from A), only after the latch, with the price at or past the
    /// graduation price, and once. Zero-amount burns (fee pokes) always pass. pluginFee is always 0.
    /// Ticks compare exactly like their sqrt prices (getSqrtPriceAtTick is strictly increasing).
    function beforeModifyPosition(
        address sender,
        address recipient,
        int24 bottomTick,
        int24 topTick,
        int128 liquidityDelta,
        bytes calldata
    ) external returns (bytes4, uint24) {
        PoolState storage st = pools[msg.sender];
        uint160 sqrtGrad = st.sqrtGrad;
        if (sqrtGrad == 0) revert UnknownPool();
        if (liquidityDelta > 0) {
            if (sender != launcher || recipient != launcher) revert LiquidityIsLocked();
            int24 tickGrad = st.tickGrad;
            if (bottomTick < st.tickStart || (bottomTick < tickGrad && topTick > tickGrad)) revert BadPositionRange();
        } else if (liquidityDelta < 0 && sender == launcher) {
            if (bottomTick < st.tickStart || topTick > st.tickGrad) revert BadPositionRange();
            if (!st.graduated || st.gradBurnDone) revert GraduationBurnRefused();
            (uint160 price,,,,,) = IAlgebraPoolState(msg.sender).globalState();
            if (price < sqrtGrad) revert GraduationBurnRefused();
            st.gradBurnDone = true;
        }
        return (IAlgebraPlugin.beforeModifyPosition.selector, 0);
    }

    /// @dev Not in PLUGIN_CONFIG; returns the selector so an admin-set flag cannot brick the pool.
    function afterModifyPosition(address, address, int24, int24, int128, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IAlgebraPlugin.afterModifyPosition.selector;
    }

    // ================================================================== swap hooks

    /// @dev Decides kind, phase and fee from the price at the start of the swap and hands them to afterSwap (transient,
    /// keyed by pool). Returns the fee as overrideFee (LP-fee mode); pluginFee is always 0.
    /// If a Barkswap admin turned the dynamic-fee flag off, a non-zero overrideFee would revert every swap, so the
    /// plugin returns 0 and the pool charges lastFee (0 after launch / restore): trading keeps working, at no fee.
    function beforeSwap(address sender, address, bool zeroToOne, int256, uint160, bool, bytes calldata)
        external
        returns (bytes4, uint24, uint24)
    {
        address pool = msg.sender;
        PoolState storage st = pools[pool];
        uint160 sqrtGrad = st.sqrtGrad;
        if (sqrtGrad == 0) revert UnknownPool();
        bool isLauncher = sender == launcher;
        uint256 openAt = st.openAt;
        if (!isLauncher && block.timestamp < openAt) revert TradingNotOpen();
        uint8 kind = _kind(sender, pool);
        (uint160 price,, uint16 lastFee, uint8 config, uint16 communityFee,) = IAlgebraPoolState(pool).globalState();
        uint8 phase = price >= sqrtGrad ? PHASE_POST : PHASE_BONDING;

        uint256 rateBps;
        uint24 overrideFee;
        uint256 feeUnits;
        if (kind == KIND_CONVERSION) {
            if (!zeroToOne) revert ConversionMustSell();
            // no conversion inside the 60 s launch window (spec Money flow 4)
            if (block.timestamp < openAt + MwzFeeMath.SNIPER_WINDOW) revert ConversionInLaunchWindow();
            // overrideFee 0 = "use lastFee"; only a true 0 fee is a conversion
            if (lastFee != 0) revert ConversionFeeNotZero();
        } else {
            rateBps = MwzFeeMath.rate(feeConfig(), phase == PHASE_POST, isLauncher, openAt, block.timestamp);
            if (config & DYNAMIC_FEE_FLAG != 0) {
                overrideFee = algebraFee(rateBps, !zeroToOne);
                feeUnits = overrideFee;
            } else {
                feeUnits = lastFee;
            }
        }
        _tstore(_slot(pool), _pack(kind, phase, rateBps, feeUnits, communityFee));
        return (IAlgebraPlugin.beforeSwap.selector, overrideFee, 0);
    }

    /// @dev Order: hand-over (or its fallback), F2 (revert early), fee totals, latch, BarkSwap event, Graduated event,
    /// then the inline graduation fee as the last external call.
    function afterSwap(address sender, address, bool zeroToOne, int256, uint160, int256 amount0, int256 amount1, bytes calldata)
        external
        returns (bytes4)
    {
        address pool = msg.sender;
        PoolState storage st = pools[pool];
        uint160 sqrtGrad = st.sqrtGrad;
        if (sqrtGrad == 0) revert UnknownPool();
        (uint160 priceAfter,, uint16 lastFee,, uint16 communityFeeNow,) = IAlgebraPoolState(pool).globalState();
        // F2: no liquidity below the start price; a sell may never leave the price there
        if (zeroToOne && priceAfter < st.sqrtStart) revert PriceBelowStart();

        SwapRecord memory r = _handOver(pool, sender, st, lastFee, communityFeeNow);
        r.buy = !zeroToOne;
        r.priceAfter = priceAfter;
        _book(pool, r, zeroToOne ? _pos(amount0) : _pos(amount1), zeroToOne ? _neg(amount1) : _neg(amount0));

        // Graduation latch: the first swap that leaves the price at or past the graduation price (I7, I17)
        if (!st.graduated && priceAfter >= sqrtGrad) {
            st.graduated = true;
            st.graduatedAt = uint40(block.timestamp);
            r.crossing = true;
        }
        address coin = st.coin;
        _emitSwap(pool, coin, sender, r);
        if (r.crossing) {
            emit Graduated(pool, coin, priceAfter, uint40(block.timestamp));
            _inlineGraduationFee(pool);
        }
        return IAlgebraPlugin.afterSwap.selector;
    }

    // ================================================================== flash and plugin-fee hooks

    /// @dev Not in PLUGIN_CONFIG; returns the selector so an admin-set flag cannot brick flash loans.
    function beforeFlash(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IAlgebraPlugin.beforeFlash.selector;
    }

    /// @dev Not in PLUGIN_CONFIG; returns the selector so an admin-set flag cannot brick flash loans.
    function afterFlash(address, address, uint256, uint256, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IAlgebraPlugin.afterFlash.selector;
    }

    /// @dev Must never revert (a revert reverts the pool's swap / burn / flash that pushes the fee). Records nothing,
    /// moves nothing; an event for our pools only.
    function handlePluginFee(uint256 pluginFee0, uint256 pluginFee1) external returns (bytes4) {
        if (pools[msg.sender].sqrtGrad != 0) emit ForeignPluginFee(msg.sender, pluginFee0, pluginFee1);
        return IAlgebraPlugin.handlePluginFee.selector;
    }

    // ================================================================== internals

    /// @dev Swap kind by the contract that called pool.swap. The launcher's swap is a conversion only while its
    /// transient conversion flag for this pool is set (O2); its other swap, the creator first buy, is a trade.
    function _kind(address sender, address pool) private view returns (uint8) {
        if (sender == launcher) return IMwzBarkLauncher(launcher).conversionInProgress(pool) ? KIND_CONVERSION : KIND_TRADE;
        if (sender == creatorEscrow) return KIND_ESCROW_BUY;
        if (sender == choiceVault) return KIND_BUYBACK;
        return KIND_TRADE;
    }

    /// @dev Reads and clears this pool's hand-over. Without one (only if a Barkswap admin disabled the before-swap hook
    /// but kept the after-swap hook) the swap was charged lastFee: it is booked at that fee, in the phase given by the
    /// latch (the start price is not known here), with rateBps 0; openAt and the conversion rule still apply.
    function _handOver(address pool, address sender, PoolState storage st, uint16 lastFee, uint16 communityFeeNow)
        private
        returns (SwapRecord memory r)
    {
        bytes32 slot = _slot(pool);
        uint256 h = _tload(slot);
        if (h & HANDOVER_SET != 0) {
            _tstore(slot, 0);
            r.feeUnits = uint24(h);
            r.rateBps = uint16(h >> 24);
            r.communityFee = uint16(h >> 40);
            r.phase = uint8(h >> 56);
            r.kind = uint8(h >> 64);
        } else {
            if (sender != launcher && block.timestamp < st.openAt) revert TradingNotOpen();
            r.kind = _kind(sender, pool);
            if (r.kind == KIND_CONVERSION) {
                if (block.timestamp < uint256(st.openAt) + MwzFeeMath.SNIPER_WINDOW) revert ConversionInLaunchWindow();
                if (lastFee != 0) revert ConversionFeeNotZero();
            }
            r.feeUnits = lastFee;
            r.communityFee = communityFeeNow;
            r.phase = st.graduated ? PHASE_POST : PHASE_BONDING;
        }
    }

    /// @dev Fee of this swap from the amounts the pool reports (amountIn includes the fee; Algebra charges the fee on
    /// the input) and the per-phase totals. The estimate differs from the pool's per-step fee by rounding only (see the
    /// audit file, tolerance). Creator first, on the gross fee; router = net - creator, never negative.
    function _book(address pool, SwapRecord memory r, uint256 amountIn, uint256 amountOut) private {
        uint256 gross = (amountIn * r.feeUnits) / FEE_DENOMINATOR; // feeUnits < 1e6, so gross <= amountIn
        uint256 cf = r.communityFee > COMMUNITY_FEE_DENOMINATOR ? COMMUNITY_FEE_DENOMINATOR : r.communityFee;
        uint256 net = gross - (gross * cf) / COMMUNITY_FEE_DENOMINATOR;
        uint256 creator = r.phase == PHASE_BONDING ? (gross * CREATOR_BONDING_BPS) / BPS : (gross * CREATOR_POST_BPS) / POST_FEE_BPS;
        if (creator > net) creator = net; // only if Barkswap's cut exceeds 94.4% (bonding) / 50% (post)
        if (r.buy) {
            r.nativeAmount = amountIn;
            r.coinAmount = amountOut;
            r.curveAmount = amountIn - gross;
        } else {
            r.coinAmount = amountIn;
            r.nativeAmount = amountOut;
            r.curveAmount = amountOut;
        }
        r.grossFee = gross;
        r.netFee = net;
        r.creatorAmount = creator;
        if (net == 0) return;
        FeeTotals storage t = _fees[pool];
        FeeBook storage b = r.phase == PHASE_BONDING ? (r.buy ? t.bondingNative : t.bondingCoin) : (r.buy ? t.postNative : t.postCoin);
        b.creator += creator.toUint128();
        b.router += (net - creator).toUint128();
    }

    function _emitSwap(address pool, address coin, address sender, SwapRecord memory r) private {
        emit BarkSwap(
            pool,
            coin,
            sender,
            r.kind,
            r.buy,
            r.phase,
            r.crossing,
            r.nativeAmount,
            r.coinAmount,
            r.curveAmount,
            r.buy ? wNative : coin,
            r.grossFee,
            r.netFee,
            r.creatorAmount,
            r.rateBps,
            r.feeUnits,
            r.communityFee,
            r.priceAfter
        );
    }

    /// @dev try/catch semantics without copying return data: a revert or a return bomb in the launcher cannot revert the
    /// trade. Out of gas can: the call gets 63/64 of the remaining gas, and if the launcher burns all of it the 1/64 left
    /// may not cover the rest of afterSwap and the pool, so the whole swap reverts (the sender's own choice of gas
    /// limit; it never commits a trade without its fee booking). Last action of afterSwap.
    function _inlineGraduationFee(address pool) private {
        bytes memory data = abi.encodeCall(IMwzBarkLauncher.takeGraduationFee, (pool));
        address target = launcher;
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), target, 0, add(data, 0x20), mload(data), 0, 0)
        }
        emit GraduationFeeInline(pool, ok);
    }

    /// @dev rateBps <= 9000 (< 2^16), feeUnits < 1e6 (< 2^24), communityFee <= 1000 (uint16), phase and kind < 4.
    function _pack(uint8 kind, uint8 phase, uint256 rateBps, uint256 feeUnits, uint16 communityFee) private pure returns (uint256) {
        return HANDOVER_SET | (uint256(kind) << 64) | (uint256(phase) << 56) | (uint256(communityFee) << 40) | (rateBps << 24) | feeUnits;
    }

    function _slot(address pool) private pure returns (bytes32) {
        return keccak256(abi.encode(T_SWAP, pool));
    }

    function _pos(int256 v) private pure returns (uint256) {
        return v > 0 ? uint256(v) : 0;
    }

    function _neg(int256 v) private pure returns (uint256) {
        return v < 0 ? uint256(-v) : 0;
    }

    function _tstore(bytes32 slot, uint256 v) private {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _tload(bytes32 slot) private view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }
}
