// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IGraduationAdapterV2} from "../interfaces/IGraduationAdapterV2.sol";
import {TopazPoolRepair} from "./lib/TopazPoolRepair.sol";

interface IBnbQuoteTopazFactory {
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool);
    function getFee(address pool, bool stable) external view returns (uint256);
}

interface IBnbQuoteTopazPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
}

interface IBnbQuoteTopazRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function defaultFactory() external view returns (address);
    function weth() external view returns (address);
    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory amounts);
    function swapExactETHForTokens(
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}

interface IBnbQuoteAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IBnbQuoteCampaignFactory {
    function isCampaign(address campaign) external view returns (bool);
}

interface IBnbQuoteCampaignToken {
    function token() external view returns (address);
}

/// @notice BNB quote graduation (MEME/QUOTE Topaz V2 volatile, permanently locked).
/// Implements IGraduationAdapterV2. Bonding remains native BNB; this adapter swaps the pool native
/// for the approved quote and mints the MEME/QUOTE pair. Spec: C7-bnb-adapters.md sections 4-6.
///
/// A pre-made MEME/QUOTE pool is accepted and repaired: the `FinalPoolAlreadyExists` revert is gone,
/// and liquidity is minted straight into the pair (the Topaz router refuses a one-sided pool).
///
/// AUDIT (money path `graduate`):
/// - Reentrancy: `nonReentrant`. Topaz `mint`/`swap` are `nonReentrant`. External calls: LaunchToken
///   (no hooks), the quote token (routes must be plain ERC20: no hooks, no fee-on-transfer, no
///   rebase — the library requires the pair's QUOTE balance rose by exactly N), WBNB inside the
///   router swap, the Topaz router, the acquisition pool (view) and the final pool.
/// - CEI: no per-graduation storage. Validate, swap native -> QUOTE onto this adapter, library
///   (MEME pull into the pair + QUOTE transfer + mint), one-sided USD check, refund leftover native
///   or quote to msg.sender, assert this contract's MEME and QUOTE balances equal the entry snapshot.
/// - Reachable states: only `campaignFactory.isCampaign(msg.sender)` after `setCampaignFactoryOnce`,
///   and only for that campaign's token, with an enabled route. Pool absent / empty / unsynced QUOTE
///   / synced QUOTE. Factory paused: the acquisition swap reverts and PENDING retries (Claude).
///   `totalSupply > 0` or `T <= bm` reverts `PoolAlreadyInitialized`.
/// - Overflow: `mulDiv` everywhere; quote decimals capped at 36.
/// - Griefing: pre-made pool absorbed. Donation (synced or not) becomes locked LP. Front-run `skim`
///   only reduces the donation. Swaps before our mint are impossible (zero reserve). The acquisition
///   swap is sandwichable in the pool, but `minimumQuoteOut` is priced from the two oracle feeds
///   (`msg.value * nativeUsd / quoteUsd * (1 - poolFee - maxSwapSlippageBps)`), never from a spot
///   quote the attacker can move. Spot `getAmountsOut` is an extra impact / deviation check only.
///   All four route bps caps are hard-capped at 100 and cannot be raised after the route is first
///   set. MEME is sized from `quoteAcquired` at the curve USD price, so the pool opens at or above
///   the curve, never below.
/// - Admin (`configureQuoteRoute`): the immutable `admin` is a constructor argument (the Safe on
///   mainnet). It sets route policy only. It cannot move funds, cannot change a quote token's
///   oracle feed after the first configure, and cannot loosen a limit. After first set it may only
///   tighten the four bps caps, raise the liquidity floor, or disable the route (E12 native
///   fallback then takes over after 7 days in Pending). There is no transferAdmin.
contract BnbQuoteGraduationAdapter is IGraduationAdapterV2, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    /// @notice Hard cap on every route bps limit. 100 = 1%.
    uint16 public constant MAX_ROUTE_LIMIT_BPS = 100;

    struct QuoteRoute {
        address oracleFeed;
        address acquisitionPool;
        uint256 minimumRouteLiquidityUsdWad;
        uint16 maxSwapSlippageBps;
        uint16 maxOracleDeviationBps;
        uint16 maxPriceImpactBps;
        uint16 maxGraduationPriceDeviationBps;
        bool enabled;
    }

    address public immutable admin;
    address public immutable topazRouter;
    address public immutable topazFactory;
    address public immutable WBNB;
    address public immutable permanentLpLocker;
    address public immutable nativeUsdOracle;
    uint32 public immutable maxOracleAgeSeconds;

    address public campaignFactory;
    bool public campaignFactoryLocked;
    mapping(address => QuoteRoute) public quoteRoutes;

    event CampaignFactoryLocked(address indexed campaignFactory);
    event QuoteRouteConfigured(
        address indexed quoteToken,
        address indexed oracleFeed,
        address indexed acquisitionPool,
        uint256 minimumRouteLiquidityUsdWad,
        uint16 maxSwapSlippageBps,
        uint16 maxOracleDeviationBps,
        uint16 maxPriceImpactBps,
        uint16 maxGraduationPriceDeviationBps,
        bool enabled
    );
    event QuoteGraduationExecuted(
        address indexed campaign,
        address indexed campaignToken,
        address indexed quoteToken,
        address canonicalPool,
        uint256 lpAmount,
        uint256 nativeLiquidityUsed,
        uint256 quoteTokenAcquired,
        uint256 memeTokenUsed,
        uint256 finalCurveMemeUsdWad,
        uint256 initialDexMemeUsdWad,
        uint256 priceDeviationBps
    );

    error OnlyAdmin();
    error ZeroAddress();
    error ContractCodeMissing();
    error FactoryAlreadyLocked();
    error CampaignFactoryMissing();
    error UnauthorizedCampaign();
    error TokenMismatch();
    error RouteDisabled();
    error InvalidPolicy();
    error InvalidPair();
    error InvalidRequest();
    error AcquisitionPoolMismatch();
    error DeadlineExpired();
    error OracleUnhealthy();
    error OracleStale();
    error RouteLiquidityTooLow();
    error QuoteUnavailable();
    error PriceImpactTooHigh();
    error OracleDeviationTooHigh();
    error GraduationPriceDeviationTooHigh();
    error ZeroLiquidity();
    error ConservationBroken();
    error NativeTransferFailed();
    error PoolAlreadyInitialized();
    error PairedDepositMismatch();
    error PriceBelowTarget();
    error ReservesDesynced();
    error RouteFeedImmutable();
    error RouteLimitLoosened();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    /// @notice `admin_` is a constructor argument. Tests and the testnet rehearsal pass an EOA;
    /// mainnet passes the Safe. Code at `admin_` is not required.
    ///
    /// AUDIT (constructor):
    /// - No funds. Sets immutables only.
    /// - `admin_` is never `msg.sender`. Zero address is refused. There is no transferAdmin,
    ///   setAdmin, or Ownable. A leaked deployer key cannot retarget feeds or raise the sandwich
    ///   bound; only the address passed here can call `configureQuoteRoute`.
    /// - Router, locker, native oracle, factory and WBNB must have code. `admin_` may be an EOA.
    constructor(
        address admin_,
        address topazRouter_,
        address permanentLpLocker_,
        address nativeUsdOracle_,
        uint32 maxOracleAgeSeconds_
    ) {
        if (
            admin_ == address(0) || topazRouter_ == address(0) || permanentLpLocker_ == address(0)
                || nativeUsdOracle_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (topazRouter_.code.length == 0 || permanentLpLocker_.code.length == 0 || nativeUsdOracle_.code.length == 0) {
            revert ContractCodeMissing();
        }
        if (maxOracleAgeSeconds_ == 0) revert InvalidPolicy();

        address factory_ = IBnbQuoteTopazRouter(topazRouter_).defaultFactory();
        address wrapped_ = IBnbQuoteTopazRouter(topazRouter_).weth();
        if (factory_ == address(0) || wrapped_ == address(0)) revert ZeroAddress();
        if (factory_.code.length == 0 || wrapped_.code.length == 0) revert ContractCodeMissing();

        admin = admin_;
        topazRouter = topazRouter_;
        topazFactory = factory_;
        WBNB = wrapped_;
        permanentLpLocker = permanentLpLocker_;
        nativeUsdOracle = nativeUsdOracle_;
        maxOracleAgeSeconds = maxOracleAgeSeconds_;
    }

    receive() external payable {}

    /// @notice Binds the campaign factory once. `graduate` refuses every caller until this lands.
    function setCampaignFactoryOnce(address campaignFactory_) external onlyAdmin {
        if (campaignFactoryLocked) revert FactoryAlreadyLocked();
        if (campaignFactory_ == address(0)) revert ZeroAddress();
        if (campaignFactory_.code.length == 0) revert ContractCodeMissing();
        campaignFactory = campaignFactory_;
        campaignFactoryLocked = true;
        emit CampaignFactoryLocked(campaignFactory_);
    }

    /// @notice Set or tighten a quote route. First call locks the oracle feed. Later calls may only
    /// lower the four bps caps (each <= 100), raise the liquidity floor, or disable the route.
    ///
    /// AUDIT (`configureQuoteRoute`):
    /// - Reentrancy: no external calls that send value. Views: `getPool`, `stable`, `code.length`.
    /// - CEI: storage write is the last effect; the event follows.
    /// - Reachable states: only `admin`. First configure (`oracleFeed == 0`) accepts any feed and
    ///   any limits in (0, 100] for slippage and [0, 100] for the other three bps fields. A later
    ///   call with a different feed reverts `RouteFeedImmutable`. A later call that raises any bps
    ///   cap or lowers the liquidity floor reverts `RouteLimitLoosened`. Disable (`enabled = false`)
    ///   is always a tightening. Re-enable is allowed when every limit is the same or tighter.
    ///   The acquisition pool must stay the canonical volatile WBNB/quote Topaz pool.
    /// - Overflow: uint16 caps compared as uint16; `minimumRouteLiquidityUsdWad` is uint256.
    /// - Griefing: a leaked admin key cannot retarget the feed or open the sandwich bound past
    ///   100 bps. The worst it can do is disable the route, after which E12's native fallback
    ///   takes over once the coin has been Pending for 7 days. No funds sit in this contract
    ///   between graduations, and this function never moves tokens. The admin cannot move funds.
    function configureQuoteRoute(address quoteToken, QuoteRoute calldata route) external onlyAdmin {
        if (quoteToken == address(0) || route.oracleFeed == address(0) || route.acquisitionPool == address(0)) revert ZeroAddress();
        if (quoteToken == WBNB) revert InvalidPair();
        if (quoteToken.code.length == 0 || route.oracleFeed.code.length == 0 || route.acquisitionPool.code.length == 0) {
            revert ContractCodeMissing();
        }
        if (
            route.minimumRouteLiquidityUsdWad == 0 || route.maxSwapSlippageBps == 0
                || route.maxSwapSlippageBps > MAX_ROUTE_LIMIT_BPS || route.maxOracleDeviationBps > MAX_ROUTE_LIMIT_BPS
                || route.maxPriceImpactBps > MAX_ROUTE_LIMIT_BPS
                || route.maxGraduationPriceDeviationBps > MAX_ROUTE_LIMIT_BPS
        ) revert InvalidPolicy();

        address canonical = IBnbQuoteTopazFactory(topazFactory).getPool(WBNB, quoteToken, false);
        if (canonical == address(0) || canonical != route.acquisitionPool) revert AcquisitionPoolMismatch();
        if (IBnbQuoteTopazPool(canonical).stable()) revert InvalidPair();

        QuoteRoute storage existing = quoteRoutes[quoteToken];
        if (existing.oracleFeed != address(0)) {
            if (route.oracleFeed != existing.oracleFeed) revert RouteFeedImmutable();
            if (route.acquisitionPool != existing.acquisitionPool) revert AcquisitionPoolMismatch();
            if (
                route.maxSwapSlippageBps > existing.maxSwapSlippageBps
                    || route.maxOracleDeviationBps > existing.maxOracleDeviationBps
                    || route.maxPriceImpactBps > existing.maxPriceImpactBps
                    || route.maxGraduationPriceDeviationBps > existing.maxGraduationPriceDeviationBps
                    || route.minimumRouteLiquidityUsdWad < existing.minimumRouteLiquidityUsdWad
            ) revert RouteLimitLoosened();
        }

        quoteRoutes[quoteToken] = route;
        emit QuoteRouteConfigured(
            quoteToken,
            route.oracleFeed,
            route.acquisitionPool,
            route.minimumRouteLiquidityUsdWad,
            route.maxSwapSlippageBps,
            route.maxOracleDeviationBps,
            route.maxPriceImpactBps,
            route.maxGraduationPriceDeviationBps,
            route.enabled
        );
    }

    /// @notice IGraduationAdapterV2.graduate for a MEME/QUOTE pool. `r.quoteToken` is the bound quote.
    /// `msg.value` is the pool native; it is swapped for QUOTE and all of the acquired QUOTE is deposited.
    /// MEME is sized from that acquired QUOTE at the curve USD price so the pool opens at or above
    /// the curve, never below. `memeUsed` may be below `r.memeTarget`; the campaign burns the rest.
    ///
    /// AUDIT (money path `graduate`, L1 sizing + oracle min):
    /// - Reentrancy / CEI / conservation: unchanged from the contract-level block. `_curveMemeTarget`
    ///   (pure) runs after `quoteAcquired` is known and before the library pull.
    /// - Overflow: `mulDiv`. Quote decimals capped at 36. `sizedTarget <= r.memeMax`. `poolFeeBps`
    ///   and `maxSwapSlippageBps` each < BPS; their sum is refused if it reaches BPS.
    /// - Griefing: `minimumQuoteOut` is `msg.value * nativeUsd / quoteUsd * (1 - poolFee -
    ///   maxSwapSlippageBps)` from the campaign's `nativeUsdWad` (or this adapter's native feed if
    ///   zero) and the route's fixed quote feed. A front-run that moves the acquisition pool cannot
    ///   lower that bound. Spot `getAmountsOut` only feeds the extra impact and oracle-deviation
    ///   checks; it is never the swap's `amountOutMin`. A sandwich on the acquisition still cannot
    ///   open the pool below the curve in USD, because fewer quote tokens produce fewer MEME at the
    ///   same USD ratio. The donation path still absorbs extra QUOTE at that same ratio, or above
    ///   if `memeMax` binds.
    function graduate(Request calldata r) external payable override nonReentrant returns (Result memory res) {
        _checkCaller(r);
        if (r.quoteToken == address(0) || r.token == r.quoteToken || r.token == WBNB || r.quoteToken == WBNB) revert InvalidPair();
        if (msg.value == 0) revert ZeroLiquidity();

        QuoteRoute memory route = quoteRoutes[r.quoteToken];
        if (!route.enabled) revert RouteDisabled();

        address acquisitionPool = IBnbQuoteTopazFactory(topazFactory).getPool(WBNB, r.quoteToken, false);
        if (acquisitionPool == address(0) || acquisitionPool != route.acquisitionPool) revert AcquisitionPoolMismatch();
        if (IBnbQuoteTopazPool(acquisitionPool).stable()) revert InvalidPair();

        uint256 nativeUsdWad = _oraclePriceWad(nativeUsdOracle);
        uint256 quoteUsdWad = _oraclePriceWad(route.oracleFeed);
        _requireRouteLiquidity(r.quoteToken, route, nativeUsdWad, quoteUsdWad);

        IBnbQuoteTopazRouter.Route[] memory acquisitionRoute = new IBnbQuoteTopazRouter.Route[](1);
        acquisitionRoute[0] = IBnbQuoteTopazRouter.Route({
            from: WBNB,
            to: r.quoteToken,
            stable: false,
            factory: topazFactory
        });

        uint8 quoteDecimals = IERC20Metadata(r.quoteToken).decimals();
        if (quoteDecimals > 36) revert InvalidPolicy();
        uint256 curveNativeUsd = r.nativeUsdWad == 0 ? nativeUsdWad : r.nativeUsdWad;
        uint256 oracleQuoteOut =
            Math.mulDiv(Math.mulDiv(msg.value, curveNativeUsd, WAD), 10 ** uint256(quoteDecimals), quoteUsdWad);
        uint256 poolFeeBps = IBnbQuoteTopazFactory(topazFactory).getFee(acquisitionPool, false);
        if (poolFeeBps >= BPS) revert InvalidPolicy();
        uint256 haircutBps = uint256(route.maxSwapSlippageBps) + poolFeeBps;
        if (haircutBps >= BPS) revert InvalidPolicy();
        uint256 minimumQuoteOut = Math.mulDiv(oracleQuoteOut, BPS - haircutBps, BPS);
        if (minimumQuoteOut == 0) revert QuoteUnavailable();

        uint256 quotedQuoteOut = _quote(msg.value, acquisitionRoute);
        uint256 probeNative = msg.value / 100;
        if (probeNative == 0) probeNative = 1;
        uint256 probeQuoteOut = _quote(probeNative, acquisitionRoute);
        uint256 priceImpactBps = _priceImpactBps(msg.value, quotedQuoteOut, probeNative, probeQuoteOut);
        if (priceImpactBps > route.maxPriceImpactBps) revert PriceImpactTooHigh();

        uint256 impliedNativeUsdWad = _impliedNativeUsdWad(msg.value, quotedQuoteOut, quoteDecimals, quoteUsdWad);
        if (_deviationBps(impliedNativeUsdWad, nativeUsdWad) > route.maxOracleDeviationBps) revert OracleDeviationTooHigh();

        uint256 quoteBeforeAdapter = IERC20(r.quoteToken).balanceOf(address(this));
        uint256 memeBeforeAdapter = IERC20(r.token).balanceOf(address(this));

        uint256 quoteBefore = IERC20(r.quoteToken).balanceOf(address(this));
        uint256[] memory swapAmounts = IBnbQuoteTopazRouter(topazRouter).swapExactETHForTokens{value: msg.value}(
            minimumQuoteOut,
            acquisitionRoute,
            address(this),
            r.deadline
        );
        uint256 quoteAcquired = IERC20(r.quoteToken).balanceOf(address(this)) - quoteBefore;
        if (swapAmounts.length < 2 || quoteAcquired == 0 || quoteAcquired != swapAmounts[swapAmounts.length - 1]) {
            revert QuoteUnavailable();
        }

        uint256 curveUsd = r.nativeUsdWad == 0 ? nativeUsdWad : r.nativeUsdWad;
        uint256 sizedTarget = _curveMemeTarget(quoteAcquired, quoteDecimals, quoteUsdWad, r.curvePriceWad, curveUsd);
        if (sizedTarget > r.memeMax) sizedTarget = r.memeMax;

        TopazPoolRepair.Outcome memory out = TopazPoolRepair.repairAndMint(
            TopazPoolRepair.Params({
                factory: topazFactory,
                meme: r.token,
                paired: r.quoteToken,
                pairedAmount: quoteAcquired,
                memeTarget: sizedTarget,
                memeMax: r.memeMax,
                memePayer: msg.sender,
                locker: permanentLpLocker
            })
        );

        uint256 finalCurveMemeUsdWad = Math.mulDiv(r.curvePriceWad, curveUsd, WAD);
        uint256 memeBal = IERC20(r.token).balanceOf(out.pool);
        uint256 quoteBal = IERC20(r.quoteToken).balanceOf(out.pool);
        uint256 initialDexMemeUsdWad = _memeUsdFromQuote(memeBal, quoteBal, quoteDecimals, quoteUsdWad);
        uint256 graduationDeviation;
        if (initialDexMemeUsdWad < finalCurveMemeUsdWad) {
            graduationDeviation = Math.mulDiv(finalCurveMemeUsdWad - initialDexMemeUsdWad, BPS, finalCurveMemeUsdWad);
            if (graduationDeviation > route.maxGraduationPriceDeviationBps) revert GraduationPriceDeviationTooHigh();
        }

        uint256 quoteLeftover = IERC20(r.quoteToken).balanceOf(address(this)) - quoteBeforeAdapter;
        if (quoteLeftover != 0) IERC20(r.quoteToken).safeTransfer(msg.sender, quoteLeftover);
        uint256 nativeLeftover = address(this).balance;
        if (nativeLeftover != 0) {
            (bool ok,) = payable(msg.sender).call{value: nativeLeftover}("");
            if (!ok) revert NativeTransferFailed();
        }

        if (
            IERC20(r.quoteToken).balanceOf(address(this)) != quoteBeforeAdapter
                || IERC20(r.token).balanceOf(address(this)) != memeBeforeAdapter
        ) revert ConservationBroken();

        res = Result({
            pool: out.pool,
            positionId: 0,
            liquidity: out.liquidity,
            memeUsed: out.memeUsed,
            pairedUsed: quoteAcquired,
            donationFound: out.donationFound,
            startPriceWad: out.startPriceWad,
            repaired: out.repaired,
            repairMemeSold: 0,
            repairProceeds: 0
        });

        emit QuoteGraduationExecuted(
            msg.sender,
            r.token,
            r.quoteToken,
            out.pool,
            out.liquidity,
            msg.value,
            quoteAcquired,
            out.memeUsed,
            finalCurveMemeUsdWad,
            initialDexMemeUsdWad,
            graduationDeviation
        );
    }

    function _checkCaller(Request calldata r) private view {
        address factory_ = campaignFactory;
        if (!campaignFactoryLocked || factory_ == address(0)) revert CampaignFactoryMissing();
        if (!IBnbQuoteCampaignFactory(factory_).isCampaign(msg.sender)) revert UnauthorizedCampaign();
        if (r.token == address(0) || IBnbQuoteCampaignToken(msg.sender).token() != r.token) revert TokenMismatch();
        if (block.timestamp > r.deadline) revert DeadlineExpired();
        if (r.memeTarget == 0 || r.memeMax < r.memeTarget || r.curvePriceWad == 0) revert InvalidRequest();
    }

    /// @dev MEME that prices `quoteAmount` of the quote token at the curve USD price.
    /// Floor division so the pool opens at or above the curve, never below.
    ///
    /// AUDIT: pure, no funds. Inputs are the swap's actual output and the two USD feeds already
    /// validated in `graduate`. Zero `target` fails closed (`ZeroLiquidity`). Decimals > 36 is
    /// refused (`InvalidPolicy`) so `10 ** decimals` cannot overflow.
    function _curveMemeTarget(
        uint256 quoteAmount,
        uint8 quoteDecimals,
        uint256 quoteUsdWad,
        uint256 curvePriceWad,
        uint256 nativeUsdWad
    ) private pure returns (uint256 target) {
        if (quoteAmount == 0 || quoteDecimals > 36 || quoteUsdWad == 0 || curvePriceWad == 0 || nativeUsdWad == 0) {
            revert InvalidPolicy();
        }
        uint256 curveUsd = Math.mulDiv(curvePriceWad, nativeUsdWad, WAD);
        if (curveUsd == 0) revert InvalidRequest();
        uint256 quoteValueUsdWad = Math.mulDiv(quoteAmount, quoteUsdWad, 10 ** uint256(quoteDecimals));
        target = Math.mulDiv(quoteValueUsdWad, WAD, curveUsd);
        if (target == 0) revert ZeroLiquidity();
    }

    function _requireRouteLiquidity(address quoteToken, QuoteRoute memory route, uint256 nativeUsdWad, uint256 quoteUsdWad) private view {
        IBnbQuoteTopazPool pool = IBnbQuoteTopazPool(route.acquisitionPool);
        (uint256 reserve0, uint256 reserve1,) = pool.getReserves();
        address token0 = pool.token0();
        address token1 = pool.token1();
        if (!((token0 == WBNB && token1 == quoteToken) || (token1 == WBNB && token0 == quoteToken))) revert InvalidPair();

        uint256 nativeReserve = token0 == WBNB ? reserve0 : reserve1;
        uint256 quoteReserve = token0 == quoteToken ? reserve0 : reserve1;
        uint8 quoteDecimals = IERC20Metadata(quoteToken).decimals();
        if (quoteDecimals > 36) revert InvalidPolicy();
        uint256 quoteScale = 10 ** uint256(quoteDecimals);
        uint256 nativeUsd = Math.mulDiv(nativeReserve, nativeUsdWad, WAD);
        uint256 quoteUsd = Math.mulDiv(quoteReserve, quoteUsdWad, quoteScale);
        if (nativeUsd + quoteUsd < route.minimumRouteLiquidityUsdWad) revert RouteLiquidityTooLow();
    }

    function _quote(uint256 amountIn, IBnbQuoteTopazRouter.Route[] memory routes) private view returns (uint256 amountOut) {
        uint256[] memory amounts = IBnbQuoteTopazRouter(topazRouter).getAmountsOut(amountIn, routes);
        if (amounts.length < 2 || amounts[amounts.length - 1] == 0) revert QuoteUnavailable();
        return amounts[amounts.length - 1];
    }

    function _oraclePriceWad(address oracle) private view returns (uint256 priceWad) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = IBnbQuoteAggregatorV3(oracle).latestRoundData();
        if (answer <= 0 || roundId == 0 || answeredInRound < roundId || updatedAt == 0 || updatedAt > block.timestamp) revert OracleUnhealthy();
        if (block.timestamp - updatedAt > maxOracleAgeSeconds) revert OracleStale();
        uint8 decimals_ = IBnbQuoteAggregatorV3(oracle).decimals();
        uint256 unsigned = uint256(answer);
        if (decimals_ == 18) return unsigned;
        if (decimals_ < 18) return unsigned * (10 ** uint256(18 - decimals_));
        return unsigned / (10 ** uint256(decimals_ - 18));
    }

    function _priceImpactBps(uint256 fullIn, uint256 fullOut, uint256 probeIn, uint256 probeOut) private pure returns (uint256) {
        if (fullIn == 0 || fullOut == 0 || probeIn == 0 || probeOut == 0) revert QuoteUnavailable();
        uint256 probeRateWad = Math.mulDiv(probeOut, WAD, probeIn);
        uint256 fullRateWad = Math.mulDiv(fullOut, WAD, fullIn);
        if (fullRateWad >= probeRateWad) return 0;
        return Math.mulDiv(probeRateWad - fullRateWad, BPS, probeRateWad);
    }

    function _impliedNativeUsdWad(uint256 nativeIn, uint256 quoteOut, uint8 quoteDecimals, uint256 quoteUsdWad)
        private
        pure
        returns (uint256)
    {
        if (nativeIn == 0 || quoteOut == 0 || quoteDecimals > 36) revert InvalidPolicy();
        uint256 quoteValueUsdWad = Math.mulDiv(quoteOut, quoteUsdWad, 10 ** uint256(quoteDecimals));
        return Math.mulDiv(quoteValueUsdWad, WAD, nativeIn);
    }

    function _memeUsdFromQuote(uint256 memeAmount, uint256 quoteAmount, uint8 quoteDecimals, uint256 quoteUsdWad)
        private
        pure
        returns (uint256)
    {
        if (memeAmount == 0 || quoteAmount == 0 || quoteDecimals > 36) revert InvalidPolicy();
        uint256 quoteValueUsdWad = Math.mulDiv(quoteAmount, quoteUsdWad, 10 ** uint256(quoteDecimals));
        return Math.mulDiv(quoteValueUsdWad, WAD, memeAmount);
    }

    function _deviationBps(uint256 actual, uint256 referenceValue) private pure returns (uint256) {
        if (referenceValue == 0) revert OracleUnhealthy();
        uint256 diff = actual > referenceValue ? actual - referenceValue : referenceValue - actual;
        return Math.mulDiv(diff, BPS, referenceValue);
    }
}
