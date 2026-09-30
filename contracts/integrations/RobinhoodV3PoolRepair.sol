// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IGraduationAdapterV2} from "../interfaces/IGraduationAdapterV2.sol";

interface IRhV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24 tickSpacing);
}

interface IRhV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IRhV3PositionManager {
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

    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IRhCampaignFactory {
    function isCampaign(address campaign) external view returns (bool);
    function permanentLpLocker() external view returns (address);
}

interface IRhCampaignToken {
    function token() external view returns (address);
}

/// @notice Price conversions between the curve's "paired per MEME" price and Uniswap V3 sqrtPriceX96.
/// @dev `pairedPerMemeWad` is the paired token's raw amount per 1e18 raw MEME (for the native path: wei per
/// whole MEME, exactly the curve's `curvePriceWad`). Both directions use 512-bit mulDiv; sqrt rounds down.
library RobinhoodV3PriceMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q192 = uint256(1) << 192;
    uint256 internal constant Q128 = uint256(1) << 128;
    uint256 internal constant Q64 = uint256(1) << 64;

    /// @dev TickMath.getSqrtRatioAtTick(-887220) and (887220): the full-range ticks at spacing 60.
    uint160 internal constant MIN_FULL_RANGE_SQRT = 4306310044;
    uint160 internal constant MAX_FULL_RANGE_SQRT = 1457652066949847389969617340386294118487833376468;

    error InvalidPrice();
    error TargetOutOfRange();

    function sqrtFromPrice(uint256 pairedPerMemeWad, bool memeIs0) internal pure returns (uint160) {
        if (pairedPerMemeWad == 0) revert InvalidPrice();
        // token1/token0 in raw units. Case A (MEME = token0): paired/MEME. Case B: MEME/paired.
        uint256 ratioX192 = memeIs0 ? Math.mulDiv(pairedPerMemeWad, Q192, WAD) : Math.mulDiv(WAD, Q192, pairedPerMemeWad);
        uint256 s = Math.sqrt(ratioX192);
        if (s <= MIN_FULL_RANGE_SQRT || s >= MAX_FULL_RANGE_SQRT) revert TargetOutOfRange();
        return uint160(s);
    }

    function priceFromSqrt(uint160 sqrtPriceX96, bool memeIs0) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        if (s == 0) revert InvalidPrice();
        if (memeIs0) {
            // s^2 / 2^192 * 1e18 without overflowing s^2 (s < 2^160).
            return Math.mulDiv(Math.mulDiv(s, s, Q64), WAD, Q128);
        }
        // 1e18 * 2^192 / s^2
        return Math.mulDiv(WAD, Q192, s) / s;
    }
}

/// @notice Shared Robinhood Uniswap V3 graduation engine: pre-made pool repair, full-range mint, lock.
/// Spec: docs/evm-launch/spec/C7-robinhood-adapters.md section 2, C5-graduation.md sections 7 and 10.
///
/// Why the repair is safe (C7 section 2, "Claim"): before `graduate()` no pool can hold MEME, because
/// `LaunchToken` refuses every transfer whose `from` and `msg.sender` are not the campaign. So every
/// position in the canonical (MEME, Q, 3000) pool is a Q-only bid at a MEME price at or below the
/// current price. Moving the price toward the curve price P therefore either (a) crosses zero liquidity
/// (MEME too cheap: the move costs exactly 0 and pays no Q), or (b) sells spare MEME into bids at
/// marginal prices >= P before the 0.30% pool fee (MEME too expensive). The callback refuses to pay Q
/// and refuses to pay more MEME than the spare, so a broken assumption reverts instead of costing money.
///
/// AUDIT
/// - Reentrancy: `graduate` and `repairStep` are `nonReentrant`. The swap callback is not (it runs
///   inside our own swap) and is gated by `_active.pool`, set immediately before `pool.swap` and
///   cleared immediately after; it is single-use (the spare allowance is zeroed on use).
/// - CEI: the adapter keeps no balances. Per call it (1) validates, (2) swaps / mints with external
///   calls only to WETH, the canonical pool, NPM, SwapRouter02 (stock path), the route's STOCK and the
///   locker, (3) refunds computed amounts and asserts its own balances are back to the entry snapshot
///   (`ConservationBroken`). The only storage written is the transient callback context and the
///   per-campaign repair ledger (`repairStep` writes it after the swap; the values it records are the
///   swap's balance deltas, so reordering cannot change them; graduate reads and zeroes it before any
///   external call that could observe it).
/// - Reachable states: only `campaignFactory.isCampaign(msg.sender)` callers, and only for their own
///   token (`campaign.token() == r.token`). The callback only while `_active.pool == msg.sender`.
/// - Overflow: prices go through 512-bit mulDiv; sqrt targets are range-checked to the full-range
///   ticks (+-887220), which also keeps every swap limit strictly inside V3's (MIN, MAX) sqrt ratio,
///   so the pool's `SPL` revert is unreachable. `amountSpecified` <= memeMax <= 1e27 < 2^255.
/// - Griefing: see C7 section 5 (a)-(h); the relevant ones here: bids above P are filled at >= 0.997*P;
///   bids beyond the spare leave the pool above P (allowed only with memeBack == 0, C5 section 1.9);
///   heavy tick seeding is chunked with `repairStep`, whose progress is monotone because pushing the
///   price back through filled ranges needs MEME out of the pool, which the token refuses. Stray tokens
///   sent to this contract are never swept into a graduation (every amount is a delta), so a donation to
///   the adapter cannot inflate `nativeBack`.
abstract contract RobinhoodV3PoolRepair is IGraduationAdapterV2, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant LIQUIDITY_KIND_V3_NFT = 2;
    uint24 public constant POOL_FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    int24 internal constant FULL_RANGE_LOWER = -887220;
    int24 internal constant FULL_RANGE_UPPER = 887220;
    /// @notice Upper bound of the MEME a full-range mint can leave unused when the MEME side binds
    /// (V3 liquidity rounding: at most ~1/sqrt(price) raw units, ~3.2e4 at the curve's price range).
    /// A campaign treats `memeBack <= MAX_MEME_DUST` as "the budget was used up" (C5 sections 1.9, 10).
    uint256 public constant MAX_MEME_DUST = 1e12;

    address public immutable admin;
    address public immutable v3Factory;
    address public immutable positionManager;
    address public immutable WETH;

    address public campaignFactory;
    address public permanentPositionLocker;
    bool public campaignFactoryLocked;

    struct RepairLedger {
        uint256 memeSold; // MEME sold into the pool by repairStep, cumulative, until graduate
        uint256 proceeds; // paired token (native for the native adapter, STOCK for the stock adapter) sent to the campaign
    }

    /// @notice Repair done by `repairStep` for a campaign and not yet consumed by its `graduate`.
    mapping(address => RepairLedger) public repairLedger;

    struct CallbackContext {
        address pool;
        bool memeIs0;
        address meme;
        address payer;
        uint256 spare;
    }

    CallbackContext private _active;

    event CampaignFactoryLocked(address indexed campaignFactory, address indexed permanentPositionLocker);
    event PoolRepaired(
        address indexed campaign,
        address indexed pool,
        bool memeSale,
        uint160 sqrtPriceBefore,
        uint160 sqrtPriceAfter,
        uint256 memeSold,
        uint256 proceeds,
        bool inGraduation
    );
    event V3GraduationExecuted(
        address indexed campaign,
        address indexed token,
        address indexed pool,
        address pairedToken,
        uint256 positionId,
        uint256 liquidity,
        uint256 memeUsed,
        uint256 memeReturned,
        uint256 pairedUsed,
        uint256 pairedReturned,
        uint256 startPriceWad,
        uint256 targetPriceWad
    );

    event MemeDustToPool(address indexed campaign, address indexed pool, uint256 amount);

    error OnlyAdmin();
    error ZeroAddress();
    error ContractCodeMissing();
    error InvalidFeeTier();
    error FactoryAlreadyLocked();
    error CampaignFactoryMissing();
    error UnauthorizedCampaign();
    error TokenMismatch();
    error InvalidPair();
    error InvalidRequest();
    error DeadlineExpired();
    error PoolMismatch();
    error NothingToRepair();
    error InvalidRepairLimit();
    error UnauthorizedCallback();
    error RepairInvariantBroken();
    error ZeroLiquidity();
    error ConservationBroken();
    error NativeTransferFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    /// @param admin_ The only key that may bind the campaign factory (and, on the stock adapter, configure
    /// routes). A constructor argument, not msg.sender (audits 2/5): the deploy script passes the Safe and
    /// refuses the deployer on 4663. Immutable, no transfer.
    constructor(address v3Factory_, address positionManager_, address weth_, address admin_) {
        if (v3Factory_ == address(0) || positionManager_ == address(0) || weth_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        if (v3Factory_.code.length == 0 || positionManager_.code.length == 0 || weth_.code.length == 0) {
            revert ContractCodeMissing();
        }
        // Decision E6: 0.30%. The full-range ticks and the range check in RobinhoodV3PriceMath are
        // spacing-60 constants, so anything else is refused here rather than mis-minted later.
        if (IRhV3Factory(v3Factory_).feeAmountTickSpacing(POOL_FEE) != TICK_SPACING) revert InvalidFeeTier();
        admin = admin_;
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        WETH = weth_;
    }

    // ------------------------------------------------------------------ locker integration surface

    function liquidityKind() external pure returns (uint8) {
        return LIQUIDITY_KIND_V3_NFT;
    }

    function feeTier() external pure returns (uint24) {
        return POOL_FEE;
    }

    /// @dev Legacy lookup shape used by LaunchFactory/PermanentV3PositionLocker: this adapter answers getPool.
    function poolFactory() external view returns (address) {
        return address(this);
    }

    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool) {
        if (stable) revert InvalidPair();
        return IRhV3Factory(v3Factory).getPool(tokenA, tokenB, POOL_FEE);
    }

    /// @notice Binds the campaign factory (and the locker it deployed) once. Nothing works before this.
    function setCampaignFactoryOnce(address campaignFactory_) external onlyAdmin {
        if (campaignFactoryLocked) revert FactoryAlreadyLocked();
        if (campaignFactory_ == address(0)) revert ZeroAddress();
        if (campaignFactory_.code.length == 0) revert ContractCodeMissing();
        address locker = IRhCampaignFactory(campaignFactory_).permanentLpLocker();
        if (locker == address(0)) revert ZeroAddress();
        if (locker.code.length == 0) revert ContractCodeMissing();
        campaignFactory = campaignFactory_;
        permanentPositionLocker = locker;
        campaignFactoryLocked = true;
        emit CampaignFactoryLocked(campaignFactory_, locker);
    }

    // ------------------------------------------------------------------ hooks for the two adapters

    /// @dev Validates the request's paired side and returns the paired token (WETH or the STOCK).
    function _pairedToken(Request calldata r) internal view virtual returns (address);

    /// @dev The price `repairStep` may move to, in paired per MEME (wad). Native: exactly P. Stock: an
    /// oracle estimate, raised by a margin so a chunk never sells below the final (acquisition-derived) target.
    function _repairStepPriceWad(Request calldata r, address paired) internal view virtual returns (uint256);

    /// @dev Sends paired token the adapter holds to `to` (native adapter: unwrap WETH and send native).
    function _sendPaired(address paired, address to, uint256 amount) internal virtual;

    // ------------------------------------------------------------------ permissionless chunked repair

    /// @notice One chunk of a pre-made pool repair (C7 section 2, "Chunking"), for pools seeded with more
    /// ticks than one graduation transaction can cross. Callable only by a registered campaign (the
    /// campaign's `repairPool(limit)` is the permissionless entry point), only for its own token.
    /// @param r The same request the campaign would pass to `graduate` now; `memeMax` is the remaining
    /// budget (the campaign subtracts MEME already sold by earlier steps). The spare is `memeMax - memeTarget`
    /// and the campaign must approve exactly that much MEME to this adapter.
    /// @param sqrtPriceLimitX96 Where this chunk stops, between the current price and the step target
    /// (inclusive of the target, exclusive of the current price). 0 = go all the way to the step target.
    /// @return memeSold MEME moved from the campaign into the pool.
    /// @return proceeds Paired token received for it and sent to the campaign (native on the native adapter).
    function repairStep(Request calldata r, uint160 sqrtPriceLimitX96)
        external
        nonReentrant
        returns (uint256 memeSold, uint256 proceeds)
    {
        _checkCaller(r);
        address paired = _pairedToken(r);
        bool memeIs0 = r.token < paired;
        uint160 sqrtStop = RobinhoodV3PriceMath.sqrtFromPrice(_repairStepPriceWad(r, paired), memeIs0);

        address pool = IRhV3Factory(v3Factory).getPool(r.token, paired, POOL_FEE);
        if (pool == address(0)) revert NothingToRepair();
        (uint160 sqrtC,,,,,,) = IRhV3Pool(pool).slot0();
        if (sqrtC == 0 || sqrtC == sqrtStop) revert NothingToRepair();

        uint160 limit = sqrtPriceLimitX96 == 0 ? sqrtStop : sqrtPriceLimitX96;
        bool valid = sqrtC > sqrtStop ? (limit >= sqrtStop && limit < sqrtC) : (limit <= sqrtStop && limit > sqrtC);
        if (!valid) revert InvalidRepairLimit();

        uint256 pairedBefore = IERC20(paired).balanceOf(address(this));
        uint256 memeBefore = IERC20(r.token).balanceOf(address(this));
        (memeSold, proceeds) = _swapToward(pool, r.token, paired, memeIs0, limit, r.memeMax - r.memeTarget, sqrtC, false);

        RepairLedger storage ledger = repairLedger[msg.sender];
        ledger.memeSold += memeSold;
        ledger.proceeds += proceeds;
        if (proceeds != 0) _sendPaired(paired, msg.sender, proceeds);

        if (IERC20(paired).balanceOf(address(this)) != pairedBefore || IERC20(r.token).balanceOf(address(this)) != memeBefore) {
            revert ConservationBroken();
        }
    }

    // ------------------------------------------------------------------ V3 swap callback

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        CallbackContext memory ctx = _active;
        if (ctx.pool == address(0) || msg.sender != ctx.pool) revert UnauthorizedCallback();
        int256 memeOwed = ctx.memeIs0 ? amount0Delta : amount1Delta;
        int256 pairedOwed = ctx.memeIs0 ? amount1Delta : amount0Delta;
        // The repair never pays the paired token: in the Q-in direction the active liquidity is zero.
        if (pairedOwed > 0) revert RepairInvariantBroken();
        if (memeOwed > 0) {
            uint256 owed = uint256(memeOwed);
            if (owed > ctx.spare) revert RepairInvariantBroken();
            _active.spare = 0;
            // Allowed before enableTrading: `from` is the campaign (the token's owner).
            IERC20(ctx.meme).safeTransferFrom(ctx.payer, msg.sender, owed);
        }
    }

    // ------------------------------------------------------------------ internals

    function _checkCaller(Request calldata r) internal view {
        address factory_ = campaignFactory;
        if (!campaignFactoryLocked || factory_ == address(0)) revert CampaignFactoryMissing();
        if (!IRhCampaignFactory(factory_).isCampaign(msg.sender)) revert UnauthorizedCampaign();
        if (r.token == address(0) || IRhCampaignToken(msg.sender).token() != r.token) revert TokenMismatch();
        if (block.timestamp > r.deadline) revert DeadlineExpired();
        if (r.memeTarget == 0 || r.memeMax < r.memeTarget || r.curvePriceWad == 0) revert InvalidRequest();
    }

    /// @dev Moves the pool price from `sqrtC` toward `limit`. MEME-in (sale) spends at most `spare`,
    /// paid by the campaign from its allowance inside the callback; the paired-in direction must cost 0.
    /// Proceeds (paired token) land on this adapter and are measured by balance delta.
    function _swapToward(
        address pool,
        address meme,
        address paired,
        bool memeIs0,
        uint160 limit,
        uint256 spare,
        uint160 sqrtC,
        bool inGraduation
    ) internal returns (uint256 memeSold, uint256 proceeds) {
        bool zeroForOne = sqrtC > limit;
        bool memeIn = zeroForOne == memeIs0;
        if (memeIn && spare == 0) return (0, 0);

        _active = CallbackContext({pool: pool, memeIs0: memeIs0, meme: meme, payer: msg.sender, spare: memeIn ? spare : 0});
        uint256 pairedBefore = IERC20(paired).balanceOf(address(this));
        // Paired-in: +1 wei exact input (V3 rejects 0); with zero active liquidity it is never consumed.
        (int256 amount0, int256 amount1) =
            IRhV3Pool(pool).swap(address(this), zeroForOne, memeIn ? int256(spare) : int256(1), limit, "");
        delete _active;

        int256 memeDelta = memeIs0 ? amount0 : amount1;
        int256 pairedDelta = memeIs0 ? amount1 : amount0;
        if (memeDelta < 0 || pairedDelta > 0) revert RepairInvariantBroken();
        if (!memeIn && (memeDelta != 0 || pairedDelta != 0)) revert RepairInvariantBroken();
        memeSold = uint256(memeDelta);
        proceeds = IERC20(paired).balanceOf(address(this)) - pairedBefore;
        if (proceeds != uint256(-pairedDelta)) revert RepairInvariantBroken();

        (uint160 sqrtAfter,,,,,,) = IRhV3Pool(pool).slot0();
        // Exact input stops at the limit or when the spare is spent; nothing else is possible.
        if (sqrtAfter != limit && !(memeIn && memeSold == spare)) revert RepairInvariantBroken();
        emit PoolRepaired(msg.sender, pool, memeIn, sqrtC, sqrtAfter, memeSold, proceeds, inGraduation);
    }

    struct Execution {
        address meme;
        address paired;
        bool memeIs0;
        uint160 sqrtTarget;
        uint256 targetPriceWad;
        uint256 memeAvailable; // memeMax (remaining budget)
        uint256 pairedIn; // paired token the adapter holds for this graduation before the repair
        uint256 spare;
        uint256 deadline;
    }

    /// @dev Find-or-create the canonical pool, repair its price to the target, mint the full-range
    /// position, lock it, refund the rest to msg.sender. The paired token `pairedIn` must already be on
    /// this adapter (wrapped native, or acquired STOCK plus pulled repair proceeds).
    function _graduateInto(Execution memory x) internal returns (Result memory res, uint256 memeReturned, uint256 pairedReturned) {
        res.pool = _preparePool(x, res);
        (res.repairMemeSold, res.repairProceeds) = _repairInGraduation(res.pool, x);
        res.repaired = res.repairMemeSold != 0 || res.repairProceeds != 0;
        (memeReturned, pairedReturned) = _mintLockRefund(x, res);
        emit V3GraduationExecuted(
            msg.sender,
            x.meme,
            res.pool,
            x.paired,
            res.positionId,
            res.liquidity,
            res.memeUsed,
            memeReturned,
            res.pairedUsed,
            pairedReturned,
            res.startPriceWad,
            x.targetPriceWad
        );
    }

    function _preparePool(Execution memory x, Result memory res) private returns (address pool) {
        (address t0, address t1) = x.memeIs0 ? (x.meme, x.paired) : (x.paired, x.meme);
        address existing = IRhV3Factory(v3Factory).getPool(t0, t1, POOL_FEE);
        if (existing != address(0)) res.donationFound = IERC20(x.paired).balanceOf(existing);
        pool = IRhV3PositionManager(positionManager).createAndInitializePoolIfNecessary(t0, t1, POOL_FEE, x.sqrtTarget);
        if (pool == address(0) || pool != IRhV3Factory(v3Factory).getPool(t0, t1, POOL_FEE)) revert PoolMismatch();
    }

    function _mintLockRefund(Execution memory x, Result memory res)
        private
        returns (uint256 memeReturned, uint256 pairedReturned)
    {
        uint256 memeForMint = x.memeAvailable - res.repairMemeSold;
        uint256 pairedForMint = x.pairedIn + res.repairProceeds;
        // Pull the rest of the budget; the unused part goes straight back below.
        IERC20(x.meme).safeTransferFrom(msg.sender, address(this), memeForMint);

        (uint256 memeMinted, uint256 pairedMinted) = _mintAndLock(res, x, memeForMint, pairedForMint);
        res.memeUsed = res.repairMemeSold + memeMinted;
        res.pairedUsed = pairedMinted;
        memeReturned = memeForMint - memeMinted;
        pairedReturned = pairedForMint - pairedMinted;

        (uint160 sqrtAfter,,,,,,) = IRhV3Pool(res.pool).slot0();
        // The pool opens above the target only when the budget was used up absorbing bids; then the
        // MEME that comes back is V3 rounding dust (C5 sections 1.9 and 10).
        if (sqrtAfter != x.sqrtTarget && memeReturned > MAX_MEME_DUST) revert RepairInvariantBroken();
        res.startPriceWad = RobinhoodV3PriceMath.priceFromSqrt(sqrtAfter, x.memeIs0);

        // V3 rounding dust goes into the pool instead of back, so the campaign's exact checks hold:
        // (a) MEME side bound the mint (budget used up): memeUsed == memeMax exactly;
        // (b) the paired side bound it: memeUsed >= memeTarget despite liquidity/sqrt rounding down.
        // A token balance the pool does not account is inert (V3 reads balances only as
        // before/after deltas inside its own callbacks), so this is a burn of <= MAX_MEME_DUST wei.
        uint256 dust;
        if (memeReturned != 0 && memeReturned <= MAX_MEME_DUST) {
            dust = memeReturned;
        } else {
            uint256 memeTarget = x.memeAvailable - x.spare;
            if (res.memeUsed < memeTarget && memeTarget - res.memeUsed <= MAX_MEME_DUST) dust = memeTarget - res.memeUsed;
        }
        if (dust != 0) {
            IERC20(x.meme).safeTransfer(res.pool, dust);
            memeReturned -= dust;
            res.memeUsed += dust;
            emit MemeDustToPool(msg.sender, res.pool, dust);
        }

        if (memeReturned != 0) IERC20(x.meme).safeTransfer(msg.sender, memeReturned);
        if (pairedReturned != 0) _sendPaired(x.paired, msg.sender, pairedReturned);
    }

    /// @dev Phase 1 (C7 section 2): move the price to the target, selling at most the spare
    /// (memeMax - memeTarget) when MEME is too expensive; free when it is too cheap.
    /// Phase 2, only when phase 1 used up the spare with the price still above the target: the MEME we
    /// hold then prices the pool, and if it is more than the paired side can pair at the current price,
    /// minting would leave real MEME behind with the pool above the curve (C5 forbids that: a griefer
    /// could freeze a sold-out graduation, whose spare is small, for the price of a few bids). So the
    /// excess is sold as well, still limited at the target, i.e. still at >= P before fee. Afterwards
    /// the MEME side binds the mint (at the lower price the paired side only grew), so what returns is
    /// rounding dust, and the surplus paired token goes back to the campaign (creator pull, C5 1.10).
    function _repairInGraduation(address pool, Execution memory x) private returns (uint256 memeSold, uint256 proceeds) {
        (uint160 sqrtC,,,,,,) = IRhV3Pool(pool).slot0();
        if (sqrtC == x.sqrtTarget) return (0, 0);
        (memeSold, proceeds) = _swapToward(pool, x.meme, x.paired, x.memeIs0, x.sqrtTarget, x.spare, sqrtC, true);

        (uint160 sqrtNow,,,,,,) = IRhV3Pool(pool).slot0();
        if (sqrtNow == x.sqrtTarget) return (memeSold, proceeds);
        uint256 priceNow = RobinhoodV3PriceMath.priceFromSqrt(sqrtNow, x.memeIs0);
        // MEME the paired side can pair at the current price, shaded down by 1e-9 so the rounding of this
        // estimate can only leave the MEME side binding.
        uint256 keep = Math.mulDiv(x.pairedIn + proceeds, RobinhoodV3PriceMath.WAD - 1e9, priceNow);
        uint256 memeLeft = x.memeAvailable - memeSold;
        if (memeLeft <= keep) return (memeSold, proceeds);
        (uint256 sold2, uint256 proceeds2) =
            _swapToward(pool, x.meme, x.paired, x.memeIs0, x.sqrtTarget, memeLeft - keep, sqrtNow, true);
        memeSold += sold2;
        proceeds += proceeds2;
    }

    function _mintAndLock(Result memory res, Execution memory x, uint256 memeAmount, uint256 pairedAmount)
        private
        returns (uint256 memeMinted, uint256 pairedMinted)
    {
        IRhV3PositionManager.MintParams memory params;
        params.fee = POOL_FEE;
        params.tickLower = FULL_RANGE_LOWER;
        params.tickUpper = FULL_RANGE_UPPER;
        params.recipient = address(this);
        params.deadline = x.deadline;
        // Minima stay 0 on purpose: the price was pinned by the repair in this same call and is checked
        // against the target after the mint (here and, by balance delta, in the campaign).
        if (x.memeIs0) {
            (params.token0, params.token1) = (x.meme, x.paired);
            (params.amount0Desired, params.amount1Desired) = (memeAmount, pairedAmount);
        } else {
            (params.token0, params.token1) = (x.paired, x.meme);
            (params.amount0Desired, params.amount1Desired) = (pairedAmount, memeAmount);
        }
        IERC20(params.token0).forceApprove(positionManager, params.amount0Desired);
        IERC20(params.token1).forceApprove(positionManager, params.amount1Desired);
        (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1) = IRhV3PositionManager(positionManager).mint(params);
        IERC20(params.token0).forceApprove(positionManager, 0);
        IERC20(params.token1).forceApprove(positionManager, 0);
        if (tokenId == 0 || liquidity == 0) revert ZeroLiquidity();
        // NPM.mint uses _mint, not _safeMint: mint to this adapter, then safe-transfer so the locker's
        // onERC721Received records the position (the locker authorizes this adapter as the operator).
        IRhV3PositionManager(positionManager).safeTransferFrom(address(this), permanentPositionLocker, tokenId);
        res.positionId = tokenId;
        res.liquidity = uint256(liquidity);
        (memeMinted, pairedMinted) = x.memeIs0 ? (used0, used1) : (used1, used0);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
