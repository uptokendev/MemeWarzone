// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EvmGenPoolSwap, IEvmGenV2Pool, IEvmGenV3Pool, IEvmGenWrappedNative} from "./EvmGenPoolSwap.sol";
import {
    ICreatorRewardsVaultV2,
    IEvmGenCampaignForVault,
    IEvmGenFactoryForVault,
    IEvmGenLockerForVault
} from "./interfaces/ICreatorRewardsVaultV2.sol";

interface IEvmGenHolderDistributor {
    function createBatch(bytes32 batchId, bytes32 merkleRoot, uint64 claimDeadline) external payable;
}

interface IEvmGenV2PoolFactory {
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);
}

interface IEvmGenV3PoolFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IEvmGenLockerPendingClaim {
    function claimPendingToken(address token) external returns (uint256);
}

interface IEvmGenLaunchTokenTrading {
    function tradingEnabled() external view returns (bool);
}

/// @title CreatorRewardsVaultV2
/// @notice The creator fee choice (C6, D5, D19, E10): per campaign keep / holders / split(1..99) / buyback,
/// set once by the factory at create. Trade fees arrive from TreasuryRouterV4 in native; LP fees of non-keep
/// coins arrive from the permanent locker in the pool's paired asset only (E9: WBNB/WETH, or the quote token on
/// quote-bound coins) and are attributed by syncLpFees, which unwraps the wrapped native. Spec and audit block: docs/evm-launch/spec/C1-C6-fees.md.
///
/// Where value can leave this contract (complete list):
/// - native to cfg.creator (claimCreatorFees), quote to cfg.creator (claimCreatorQuote);
/// - native to holderDistributor, only through a proposed batch that survived the admin's veto window and the
///   distributor's own Safe authorization (max amount + publish window);
/// - native to a factory campaign (buybackCurve, tokens come back to this vault and end at DEAD);
/// - wrapped native / quote into the coin's locked pool or the admin-selected canonical quote route pool, with
///   the MEME output hard-coded to DEAD and the native/quote output hard-coded to this vault;
/// - MEME to DEAD (flushBuybackTokens);
/// - admin rescue of the excess above every liability.
/// A compromised operator can therefore pick bad moments within the caps, or propose a bad holder root that
/// the admin can veto for `holderBatchDelay`; it cannot send value to itself.
contract CreatorRewardsVaultV2 is ICreatorRewardsVaultV2, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Choice {
        Unset,
        Keep,
        Holders,
        Split,
        Buyback
    }

    struct Cfg {
        address creator;
        Choice choice;
        uint8 creatorPct;
        address pool; // locked graduation pool, bound by the first syncLpFees
        address quote; // pool's paired token when it is not wrapped native (E10); zero = native pool
    }

    struct HolderBatch {
        bytes32 root;
        uint128 total;
        uint64 executableAt;
        uint64 claimDeadline;
        uint8 status; // 1 proposed, 2 executed, 3 vetoed
    }

    uint8 public constant DEX_TOPAZ_V2 = 1;
    uint8 public constant DEX_UNISWAP_V3 = 2;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint8 public constant BUYBACK_ROUTE_PROFILE = 1; // StandardUnlinked
    uint16 public constant MAX_IMPACT_BPS_LIMIT = 50;
    uint16 public constant TWAP_DEVIATION_BPS = 100;
    uint32 public constant TWAP_WINDOW = 1800;
    uint16 public constant FLAT_TRADE_FEE_BPS = 200;
    uint16 public constant MAX_CURVE_PROGRESS_BPS = 9_500;
    uint256 public constant MAX_BATCH_CAMPAIGNS = 200;
    uint256 public constant MIN_HOLDER_BATCH_DELAY = 24 hours;
    uint256 internal constant BPS = 10_000;

    address public immutable admin;
    address public immutable wrappedNative;
    uint8 public immutable dexKind;
    address public immutable dexFactory;
    uint256 public immutable holderBatchDelay;

    address public router;
    address public factory;
    address public locker;
    address public holderDistributor;
    address public operator;
    bool public operatorPaused;

    uint256 public maxBuyPerTx;
    uint256 public maxBuybackPerCampaignWeek;
    uint256 public minBuyInterval;
    uint256 public maxImpactBps;
    uint256 public maxHolderBatchPerWeek;

    mapping(address => Cfg) public cfg;
    mapping(address => uint256) public creatorBalance;
    mapping(address => uint256) public holderBalance;
    mapping(address => uint256) public buybackBalance;
    mapping(address => uint256) public creatorQuoteBalance;
    mapping(address => uint256) public holderQuoteBalance;
    mapping(address => uint256) public buybackQuoteBalance;
    mapping(address => uint256) public heldBuybackTokens;
    mapping(address => bool) public heldTokenAsset;
    mapping(address => mapping(address => uint256)) public lpSynced;
    mapping(address => address) public quoteRoutePool;

    /// @notice Native owed to someone: every native balance above plus proposed, not yet executed batches.
    uint256 public totalLiabilities;
    mapping(address => uint256) public quoteLiabilities;

    mapping(address => uint256) public buybackWeek;
    mapping(address => uint256) public buybackSpentInWeek;
    mapping(address => uint256) public lastBuybackAt;
    uint256 public holderWeek;
    uint256 public holderProposedInWeek;

    mapping(bytes32 => HolderBatch) public holderBatches;
    mapping(bytes32 => address[]) internal batchCampaigns;
    mapping(bytes32 => uint256[]) internal batchAmounts;

    address private activeSwapPool;
    address private activeSwapTokenIn;
    uint256 private activeSwapMaxPay;

    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event FactoryPinned(address indexed factory, address indexed locker);
    event HolderDistributorPinned(address indexed distributor);
    event OperatorUpdated(address indexed operator, bool paused);
    event CapsUpdated(uint256 maxBuyPerTx, uint256 maxBuybackPerCampaignWeek, uint256 minBuyInterval, uint256 maxImpactBps, uint256 maxHolderBatchPerWeek);
    event QuoteRouteUpdated(address indexed quote, address indexed pool, uint24 feeTier);
    event CampaignChoiceSet(address indexed campaign, address indexed creator, uint8 choice, uint8 creatorPct);
    event TradeFeeAccrued(address indexed campaign, uint256 amount, uint256 toCreator, uint256 toHolders, uint256 toBuyback);
    event LpFeesSynced(address indexed campaign, address indexed pool, address indexed token, uint256 amount);
    event CreatorFeesClaimed(address indexed campaign, address indexed creator, uint256 amount);
    event CreatorQuoteClaimed(address indexed campaign, address indexed creator, address indexed quote, uint256 amount);
    event QuoteConverted(address indexed campaign, bool holders, uint256 quoteSpent, uint256 nativeOut);
    event BuybackNativeConverted(address indexed campaign, uint256 nativeSpent, uint256 quoteOut);
    event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline);
    event HolderBatchVetoed(bytes32 indexed batchId, uint256 total);
    event HolderBatchExecuted(bytes32 indexed batchId, uint256 total);
    event BuybackCurve(address indexed campaign, uint256 nativeSpent, uint256 tokensHeld);
    event BuybackPool(address indexed campaign, address indexed tokenIn, uint256 amountSpent, uint256 memeBurned);
    event BuybackTokensFlushed(address indexed campaign, address indexed token, uint256 amount);
    event ExcessRescued(address indexed token, address indexed to, uint256 amount);
    event ExcessQuoteAttributed(address indexed campaign, address indexed quote, uint256 amount);

    error OnlyAdmin();
    error OnlyRouter();
    error OnlyFactory();
    error OnlyOperator();
    error ZeroAddress();
    error AlreadySet();
    error BadChoice();
    error ChoiceUnset();
    error WrongChoice();
    error NotCreator();
    error NothingToClaim();
    error TransferFailed();
    error UnexpectedSender();
    error PoolMismatch();
    error Insufficient();
    error CapExceeded();
    error TooSoon();
    error BadBatch();
    error CurveState();
    error ImpactTooHigh();
    error NothingSwapped();
    error NoRoute();
    error UnexpectedCallback();
    error Blocked();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator || operatorPaused) revert OnlyOperator();
        _;
    }

    constructor(address admin_, address router_, address wrappedNative_, uint8 dexKind_, address dexFactory_, uint256 holderBatchDelay_) {
        if (admin_ == address(0) || router_ == address(0) || wrappedNative_ == address(0) || dexFactory_ == address(0)) revert ZeroAddress();
        if (dexKind_ != DEX_TOPAZ_V2 && dexKind_ != DEX_UNISWAP_V3) revert BadChoice();
        if (holderBatchDelay_ < MIN_HOLDER_BATCH_DELAY) revert TooSoon();
        admin = admin_;
        router = router_;
        wrappedNative = wrappedNative_;
        dexKind = dexKind_;
        dexFactory = dexFactory_;
        holderBatchDelay = holderBatchDelay_;
        emit RouterUpdated(address(0), router_);
    }

    /// @dev Accepts only WETH/WBNB unwrapping and refunds from a factory campaign during buybackCurve.
    receive() external payable {
        if (msg.sender == wrappedNative) return;
        if (factory != address(0) && IEvmGenFactoryForVault(factory).isCampaign(msg.sender)) return;
        revert UnexpectedSender();
    }

    // ------------------------------------------------------------------ admin

    function setRouter(address newRouter) external onlyAdmin {
        if (newRouter == address(0)) revert ZeroAddress();
        emit RouterUpdated(router, newRouter);
        router = newRouter;
    }

    /// @notice Pins the factory and the locker it created.
    function setFactoryOnce(address factory_) external onlyAdmin {
        if (factory != address(0)) revert AlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        address locker_ = IEvmGenFactoryForVault(factory_).permanentLpLocker();
        if (locker_ == address(0)) revert ZeroAddress();
        factory = factory_;
        locker = locker_;
        emit FactoryPinned(factory_, locker_);
    }

    function setHolderDistributorOnce(address distributor) external onlyAdmin {
        if (holderDistributor != address(0)) revert AlreadySet();
        if (distributor == address(0)) revert ZeroAddress();
        holderDistributor = distributor;
        emit HolderDistributorPinned(distributor);
    }

    function setOperator(address operator_, bool paused_) external onlyAdmin {
        operator = operator_;
        operatorPaused = paused_;
        emit OperatorUpdated(operator_, paused_);
    }

    function setCaps(
        uint256 maxBuyPerTx_,
        uint256 maxBuybackPerCampaignWeek_,
        uint256 minBuyInterval_,
        uint256 maxImpactBps_,
        uint256 maxHolderBatchPerWeek_
    ) external onlyAdmin {
        if (maxImpactBps_ > MAX_IMPACT_BPS_LIMIT) revert ImpactTooHigh();
        maxBuyPerTx = maxBuyPerTx_;
        maxBuybackPerCampaignWeek = maxBuybackPerCampaignWeek_;
        minBuyInterval = minBuyInterval_;
        maxImpactBps = maxImpactBps_;
        maxHolderBatchPerWeek = maxHolderBatchPerWeek_;
        emit CapsUpdated(maxBuyPerTx_, maxBuybackPerCampaignWeek_, minBuyInterval_, maxImpactBps_, maxHolderBatchPerWeek_);
    }

    /// @notice Selects the canonical wrapped-native/quote pool used to turn quote into native (holders) or native
    /// into quote (buyback of a quote-bound coin). The admin chooses only the fee tier (V3); the pool is read
    /// from the DEX factory, so no arbitrary address can be named.
    function setQuoteRoute(address quote, uint24 feeTier) external onlyAdmin {
        if (quote == address(0) || quote == wrappedNative) revert ZeroAddress();
        address pool = dexKind == DEX_TOPAZ_V2
            ? IEvmGenV2PoolFactory(dexFactory).getPool(wrappedNative, quote, false)
            : IEvmGenV3PoolFactory(dexFactory).getPool(wrappedNative, quote, feeTier);
        if (pool == address(0)) revert NoRoute();
        quoteRoutePool[quote] = pool;
        emit QuoteRouteUpdated(quote, pool, feeTier);
    }

    // ------------------------------------------------------------------ choice + accrual

    function setCampaignChoice(address campaign, address creator, uint8 choice, uint8 creatorPct) external {
        if (msg.sender != factory || factory == address(0)) revert OnlyFactory();
        if (campaign == address(0) || creator == address(0)) revert ZeroAddress();
        if (cfg[campaign].choice != Choice.Unset) revert AlreadySet();
        if (choice == uint8(Choice.Unset) || choice > uint8(Choice.Buyback)) revert BadChoice();
        if (choice == uint8(Choice.Split) ? (creatorPct == 0 || creatorPct > 99) : creatorPct != 0) revert BadChoice();
        cfg[campaign] = Cfg({creator: creator, choice: Choice(choice), creatorPct: creatorPct, pool: address(0), quote: address(0)});
        emit CampaignChoiceSet(campaign, creator, choice, creatorPct);
    }

    function isKeep(address campaign) external view returns (bool) {
        return cfg[campaign].choice == Choice.Keep;
    }

    /// @notice Router-only accrual. Deliberately NOT nonReentrant: a buyback's own trade fee re-enters here
    /// from inside buybackCurve. It makes no external call and only adds to balances, so re-entry is harmless.
    /// Reverts for a campaign without a choice, so a direct routeTrade from a non-campaign reverts itself.
    function accrueTradeFee(address campaign) external payable {
        if (msg.sender != router) revert OnlyRouter();
        Cfg storage c = cfg[campaign];
        if (c.choice == Choice.Unset) revert ChoiceUnset();
        (uint256 toCreator, uint256 toHolders, uint256 toBuyback) = _credit(campaign, c, msg.value);
        totalLiabilities += msg.value;
        emit TradeFeeAccrued(campaign, msg.value, toCreator, toHolders, toBuyback);
    }

    // ------------------------------------------------------------------ creator

    function claimCreatorFees(address campaign) external nonReentrant returns (uint256 amount) {
        if (msg.sender != cfg[campaign].creator) revert NotCreator();
        amount = creatorBalance[campaign];
        if (amount == 0) revert NothingToClaim();
        creatorBalance[campaign] = 0;
        totalLiabilities -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit CreatorFeesClaimed(campaign, msg.sender, amount);
    }

    /// @notice E10: the creator part of LP fees on a quote-bound split coin is paid in the quote token.
    function claimCreatorQuote(address campaign) external nonReentrant returns (uint256 amount) {
        Cfg storage c = cfg[campaign];
        if (msg.sender != c.creator) revert NotCreator();
        amount = creatorQuoteBalance[campaign];
        if (amount == 0) revert NothingToClaim();
        creatorQuoteBalance[campaign] = 0;
        quoteLiabilities[c.quote] -= amount;
        IERC20(c.quote).safeTransfer(msg.sender, amount);
        emit CreatorQuoteClaimed(campaign, msg.sender, c.quote, amount);
    }

    // ------------------------------------------------------------------ LP fees (D19)

    /// @notice Permissionless. Attributes to `campaign` what the locker has paid this vault for its pool since
    /// the last sync, under the coin's choice. Binds the pool on first use. Idempotent.
    function syncLpFees(address pool) external nonReentrant returns (uint256 delta) {
        (address campaign, address creatorKey, address recipient, , address paired, bool registered) =
            IEvmGenLockerForVault(locker).poolParties(pool);
        if (!registered || creatorKey != campaign || recipient != address(this)) revert PoolMismatch();
        Cfg storage c = cfg[campaign];
        if (c.choice == Choice.Unset || c.choice == Choice.Keep) revert WrongChoice();
        if (c.pool == address(0)) {
            c.pool = pool;
            if (paired != wrappedNative) c.quote = paired;
        } else if (c.pool != pool) {
            revert PoolMismatch();
        }
        uint256 cumulative = IEvmGenLockerForVault(locker).cumulativeCreatorPaid(pool, paired);
        delta = cumulative - lpSynced[pool][paired];
        if (delta == 0) return 0;
        lpSynced[pool][paired] = cumulative;
        if (paired == wrappedNative) {
            // The locker paid WBNB/WETH; unwrap exactly the attributed amount (reverts if it is not here).
            IEvmGenWrappedNative(wrappedNative).withdraw(delta);
            totalLiabilities += delta;
            _credit(campaign, c, delta);
        } else {
            _creditQuote(campaign, c, paired, delta);
        }
        emit LpFeesSynced(campaign, pool, paired, delta);
    }

    // ------------------------------------------------------------------ holders

    /// @notice E10: turns a quote-bound coin's holder share (quote) into native through the canonical route pool,
    /// bounded like every swap here. Proceeds land in this vault and are credited to the campaign's holders.
    function convertHolderQuote(address campaign, uint256 amountIn) external onlyOperator nonReentrant returns (uint256 spent, uint256 out) {
        Cfg storage c = cfg[campaign];
        if (amountIn == 0 || amountIn > holderQuoteBalance[campaign]) revert Insufficient();
        (spent, out) = _quoteToNative(c.quote, amountIn);
        holderQuoteBalance[campaign] -= spent;
        quoteLiabilities[c.quote] -= spent;
        holderBalance[campaign] += out;
        totalLiabilities += out;
        emit QuoteConverted(campaign, true, spent, out);
    }

    function proposeHolderBatch(
        bytes32 batchId,
        bytes32 root,
        uint64 claimDeadline,
        address[] calldata campaigns,
        uint256[] calldata amounts
    ) external onlyOperator nonReentrant returns (uint256 total) {
        if (holderDistributor == address(0) || batchId == bytes32(0) || root == bytes32(0)) revert BadBatch();
        if (holderBatches[batchId].status != 0) revert AlreadySet();
        uint256 n = campaigns.length;
        if (n == 0 || n != amounts.length || n > MAX_BATCH_CAMPAIGNS) revert BadBatch();
        for (uint256 i; i < n; ++i) {
            address campaign = campaigns[i];
            Choice ch = cfg[campaign].choice;
            if (ch != Choice.Holders && ch != Choice.Split) revert WrongChoice();
            uint256 a = amounts[i];
            if (a == 0 || a > holderBalance[campaign]) revert Insufficient();
            holderBalance[campaign] -= a;
            total += a;
        }
        uint256 week = block.timestamp / 1 weeks;
        if (holderWeek != week) {
            holderWeek = week;
            holderProposedInWeek = 0;
        }
        if (holderProposedInWeek + total > maxHolderBatchPerWeek || total > type(uint128).max) revert CapExceeded();
        holderProposedInWeek += total;
        uint64 executableAt = uint64(block.timestamp + holderBatchDelay);
        holderBatches[batchId] = HolderBatch({root: root, total: uint128(total), executableAt: executableAt, claimDeadline: claimDeadline, status: 1});
        batchCampaigns[batchId] = campaigns;
        batchAmounts[batchId] = amounts;
        emit HolderBatchProposed(batchId, root, total, executableAt, claimDeadline);
    }

    /// @notice Admin veto until executed: every amount goes back to its campaign's holder balance.
    function vetoHolderBatch(bytes32 batchId) external onlyAdmin nonReentrant {
        HolderBatch storage b = holderBatches[batchId];
        if (b.status != 1) revert BadBatch();
        b.status = 3;
        address[] storage cs = batchCampaigns[batchId];
        uint256[] storage as_ = batchAmounts[batchId];
        for (uint256 i; i < cs.length; ++i) holderBalance[cs[i]] += as_[i];
        emit HolderBatchVetoed(batchId, b.total);
    }

    function executeHolderBatch(bytes32 batchId) external onlyOperator nonReentrant {
        HolderBatch storage b = holderBatches[batchId];
        if (b.status != 1) revert BadBatch();
        if (block.timestamp < b.executableAt) revert TooSoon();
        b.status = 2;
        uint256 total = b.total;
        totalLiabilities -= total;
        IEvmGenHolderDistributor(holderDistributor).createBatch{value: total}(batchId, b.root, b.claimDeadline);
        emit HolderBatchExecuted(batchId, total);
    }

    function holderBatchLegs(bytes32 batchId) external view returns (address[] memory, uint256[] memory) {
        return (batchCampaigns[batchId], batchAmounts[batchId]);
    }

    // ------------------------------------------------------------------ buyback

    /// @notice Pre-graduation buyback through the campaign's signed buy path (actor = this vault, profile
    /// StandardUnlinked). Tokens are held here until the token is tradable, then flushed to DEAD.
    function buybackCurve(address campaign, uint256 amountIn, uint256 minOut, uint64 deadline, bytes calldata sig)
        external
        onlyOperator
        nonReentrant
        returns (uint256 tokensOut, uint256 spent)
    {
        if (cfg[campaign].choice != Choice.Buyback || !IEvmGenFactoryForVault(factory).isCampaign(campaign)) revert WrongChoice();
        if (amountIn == 0 || amountIn > buybackBalance[campaign]) revert Insufficient();
        IEvmGenCampaignForVault camp = IEvmGenCampaignForVault(campaign);
        if (camp.launched() || camp.graduationPending()) revert CurveState();
        (, uint256 qTotal, uint256 qFee) = camp.quoteBuyExactBnb(amountIn);
        // C2 anti-sniper window over: the fee is the flat 2% (fee <= 2% of what the buy costs).
        if (qTotal == 0 || qFee * BPS > qTotal * FLAT_TRADE_FEE_BPS) revert CurveState();
        // Never push the curve past 95% of its graduation target.
        if ((camp.netRaisedWei() + amountIn) * BPS > camp.graduationNativeTarget() * MAX_CURVE_PROGRESS_BPS) revert CurveState();
        _useBuybackAllowance(campaign, amountIn);

        uint256 priceBefore = camp.currentPrice();
        address token = camp.token();
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        buybackBalance[campaign] -= amountIn;
        totalLiabilities -= amountIn;

        (, spent) = camp.buyExactBnbAuthorized{value: amountIn}(minOut, BUYBACK_ROUTE_PROFILE, deadline, sig);
        if (spent > amountIn) revert Insufficient();
        // The refund arrived through receive(); the buy's own fee re-entered accrueTradeFee and was credited there.
        uint256 refund = amountIn - spent;
        buybackBalance[campaign] += refund;
        totalLiabilities += refund;

        if (camp.launched() || camp.graduationPending()) revert CurveState();
        if (camp.currentPrice() * BPS > priceBefore * (BPS + maxImpactBps)) revert ImpactTooHigh();
        tokensOut = IERC20(token).balanceOf(address(this)) - tokenBefore;
        if (tokensOut == 0) revert NothingSwapped();
        heldBuybackTokens[campaign] += tokensOut;
        heldTokenAsset[token] = true;
        emit BuybackCurve(campaign, spent, tokensOut);
    }

    /// @notice Permissionless once the token is tradable (after graduation): every held buyback token to DEAD.
    function flushBuybackTokens(address campaign) external nonReentrant returns (uint256 amount) {
        amount = heldBuybackTokens[campaign];
        if (amount == 0) revert NothingToClaim();
        address token = IEvmGenCampaignForVault(campaign).token();
        if (!IEvmGenLaunchTokenTrading(token).tradingEnabled()) revert CurveState();
        heldBuybackTokens[campaign] = 0;
        IERC20(token).safeTransfer(DEAD, amount);
        emit BuybackTokensFlushed(campaign, token, amount);
    }

    /// @notice Post-graduation buyback in the coin's own locked pool, MEME output to DEAD.
    /// Native pool: spends the native buyback balance. Quote-bound pool (E10): spends the quote buyback balance.
    function buybackPool(address campaign, uint256 amountIn) external onlyOperator nonReentrant returns (uint256 spent, uint256 burned) {
        Cfg storage c = cfg[campaign];
        if (c.choice != Choice.Buyback) revert WrongChoice();
        if (c.pool == address(0)) revert PoolMismatch();
        if (amountIn == 0 || amountIn > maxBuyPerTx) revert CapExceeded();
        _checkInterval(campaign);
        address tokenIn;
        if (c.quote == address(0)) {
            if (amountIn > buybackBalance[campaign]) revert Insufficient();
            _useWeekCap(campaign, amountIn);
            tokenIn = wrappedNative;
            IEvmGenWrappedNative(wrappedNative).deposit{value: amountIn}();
            (spent, burned) = _swap(c.pool, tokenIn, amountIn, DEAD, maxImpactBps);
            if (amountIn > spent) IEvmGenWrappedNative(wrappedNative).withdraw(amountIn - spent);
            buybackBalance[campaign] -= spent;
            totalLiabilities -= spent;
        } else {
            if (amountIn > buybackQuoteBalance[campaign]) revert Insufficient();
            tokenIn = c.quote;
            (spent, burned) = _swap(c.pool, tokenIn, amountIn, DEAD, maxImpactBps);
            buybackQuoteBalance[campaign] -= spent;
            quoteLiabilities[tokenIn] -= spent;
        }
        emit BuybackPool(campaign, tokenIn, spent, burned);
    }

    /// @notice E10: a graduated quote-bound buyback coin's native balance becomes quote through the route pool,
    /// then buybackPool spends it in the coin's own pool.
    function convertBuybackNativeToQuote(address campaign, uint256 amountIn) external onlyOperator nonReentrant returns (uint256 spent, uint256 out) {
        Cfg storage c = cfg[campaign];
        if (c.choice != Choice.Buyback || c.quote == address(0)) revert WrongChoice();
        if (amountIn == 0 || amountIn > buybackBalance[campaign]) revert Insufficient();
        if (amountIn > maxBuyPerTx) revert CapExceeded();
        _useWeekCap(campaign, amountIn);
        address pool = quoteRoutePool[c.quote];
        if (pool == address(0)) revert NoRoute();
        IEvmGenWrappedNative(wrappedNative).deposit{value: amountIn}();
        (spent, out) = _swap(pool, wrappedNative, amountIn, address(this), maxImpactBps);
        if (amountIn > spent) IEvmGenWrappedNative(wrappedNative).withdraw(amountIn - spent);
        buybackBalance[campaign] -= spent;
        totalLiabilities -= spent;
        buybackQuoteBalance[campaign] += out;
        quoteLiabilities[c.quote] += out;
        emit BuybackNativeConverted(campaign, spent, out);
    }

    /// @notice Permissionless. If a locker payment to this vault failed (e.g. a pausable stock token was paused
    /// during a harvest) the locker parked it as pendingToken[vault][token]; this pulls it here. It arrives
    /// unattributed (the locker only counts paid amounts), so it is excess until attributeExcessQuote.
    function pullLockerPending(address token) external nonReentrant returns (uint256) {
        return IEvmGenLockerPendingClaim(locker).claimPendingToken(token);
    }

    /// @notice Admin: assigns quote tokens held above every liability to a non-keep campaign bound to that quote,
    /// under its choice. Can only move excess, never another campaign's balance.
    function attributeExcessQuote(address campaign, uint256 amount) external onlyAdmin nonReentrant {
        Cfg storage c = cfg[campaign];
        address quote = c.quote;
        if (quote == address(0) || c.choice == Choice.Keep) revert WrongChoice();
        if (amount == 0 || amount > IERC20(quote).balanceOf(address(this)) - quoteLiabilities[quote]) revert Insufficient();
        _creditQuote(campaign, c, quote, amount);
        emit ExcessQuoteAttributed(campaign, quote, amount);
    }

    // ------------------------------------------------------------------ rescue

    function rescueExcessNative(address payable to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance - totalLiabilities) revert Insufficient();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ExcessRescued(address(0), to, amount);
    }

    /// @notice Only what exceeds the token's liabilities; never a token held for a buyback burn, and never the
    /// wrapped native (LP fees paid in it wait here until syncLpFees).
    function rescueExcessToken(address token, address to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (heldTokenAsset[token] || token == wrappedNative) revert Blocked();
        if (amount > IERC20(token).balanceOf(address(this)) - quoteLiabilities[token]) revert Insufficient();
        IERC20(token).safeTransfer(to, amount);
        emit ExcessRescued(token, to, amount);
    }

    // ------------------------------------------------------------------ V3 callback

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != activeSwapPool || msg.sender == address(0)) revert UnexpectedCallback();
        address tokenIn = activeSwapTokenIn;
        EvmGenPoolSwap.v3PayOwed(tokenIn, tokenIn == IEvmGenV3Pool(msg.sender).token0(), amount0Delta, amount1Delta, activeSwapMaxPay);
    }

    // ------------------------------------------------------------------ internal

    function _credit(address campaign, Cfg storage c, uint256 v) internal returns (uint256 toCreator, uint256 toHolders, uint256 toBuyback) {
        Choice ch = c.choice;
        if (ch == Choice.Keep) toCreator = v;
        else if (ch == Choice.Split) {
            toCreator = (v * c.creatorPct) / 100;
            toHolders = v - toCreator;
        } else if (ch == Choice.Holders) toHolders = v;
        else toBuyback = v;
        if (toCreator != 0) creatorBalance[campaign] += toCreator;
        if (toHolders != 0) holderBalance[campaign] += toHolders;
        if (toBuyback != 0) buybackBalance[campaign] += toBuyback;
    }

    function _creditQuote(address campaign, Cfg storage c, address quote, uint256 v) internal {
        quoteLiabilities[quote] += v;
        uint256 k = c.choice == Choice.Split ? (v * c.creatorPct) / 100 : 0;
        creatorQuoteBalance[campaign] += k;
        if (c.choice == Choice.Buyback) buybackQuoteBalance[campaign] += v;
        else holderQuoteBalance[campaign] += v - k;
    }

    function _quoteToNative(address quote, uint256 amountIn) internal returns (uint256 spent, uint256 out) {
        address pool = quoteRoutePool[quote];
        if (quote == address(0) || pool == address(0)) revert NoRoute();
        (spent, out) = _swap(pool, quote, amountIn, address(this), MAX_IMPACT_BPS_LIMIT);
        IEvmGenWrappedNative(wrappedNative).withdraw(out);
    }

    /// @dev One bounded swap in `pool`. Reverts NothingSwapped when the bound or the TWAP guard allows nothing.
    function _swap(address pool, address tokenIn, uint256 amountIn, address recipient, uint256 impactBps)
        internal
        returns (uint256 spent, uint256 out)
    {
        if (dexKind == DEX_TOPAZ_V2) {
            (spent, out) = EvmGenPoolSwap.v2Plan(pool, tokenIn, amountIn, impactBps, TWAP_DEVIATION_BPS);
            if (spent == 0) revert NothingSwapped();
            EvmGenPoolSwap.v2Execute(pool, tokenIn, spent, out, recipient);
        } else {
            bool zeroForOne = tokenIn == IEvmGenV3Pool(pool).token0();
            (bool ok, uint160 limit) = EvmGenPoolSwap.v3Limit(pool, zeroForOne, impactBps, TWAP_DEVIATION_BPS, TWAP_WINDOW);
            if (!ok) revert NothingSwapped();
            activeSwapPool = pool;
            activeSwapTokenIn = tokenIn;
            activeSwapMaxPay = amountIn;
            (spent, out) = EvmGenPoolSwap.v3Swap(pool, zeroForOne, amountIn, limit, recipient);
            activeSwapPool = address(0);
            activeSwapTokenIn = address(0);
            activeSwapMaxPay = 0;
            if (spent == 0) revert NothingSwapped();
        }
    }

    function _useBuybackAllowance(address campaign, uint256 amount) internal {
        if (amount > maxBuyPerTx) revert CapExceeded();
        _checkInterval(campaign);
        _useWeekCap(campaign, amount);
    }

    function _checkInterval(address campaign) internal {
        uint256 last = lastBuybackAt[campaign];
        if (last != 0 && block.timestamp < last + minBuyInterval) revert TooSoon();
        lastBuybackAt[campaign] = block.timestamp;
    }

    function _useWeekCap(address campaign, uint256 amount) internal {
        uint256 week = block.timestamp / 1 weeks;
        if (buybackWeek[campaign] != week) {
            buybackWeek[campaign] = week;
            buybackSpentInWeek[campaign] = 0;
        }
        if (buybackSpentInWeek[campaign] + amount > maxBuybackPerCampaignWeek) revert CapExceeded();
        buybackSpentInWeek[campaign] += amount;
    }
}
