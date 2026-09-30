// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EvmGenPoolSwap} from "./EvmGenPoolSwap.sol";

interface ITopazPoolFeeSource {
    function claimFees() external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function factory() external view returns (address);
}

interface ITopazPoolFactory {
    function getFee(address pool, bool stable) external view returns (uint256);
}

interface ILpRevenueTreasuryRouter {
    function routeLpNative() external payable;
    function routeLpToken(address token, uint256 amount) external;
}

/// @notice Shared permanent locker for approved Topaz LP tokens and fee harvests.
/// @dev Registered LP principal has no withdrawal, transfer, approval, migration, or rescue path.
/// EVM launch generation (E9, docs/evm-launch/spec/C1-C6-fees.md): every harvest sells the MEME-side fees
/// for the paired asset in the same pair, bounded by price impact (EvmGenPoolSwap), before the 80/20 split,
/// so creator and protocol are paid in the paired asset only: WBNB on native pools, the quote token on
/// quote-bound pools, both through today's paths (creator transfer with pending fallback, protocol via
/// routeLpToken). What the bound does not allow in one harvest is carried (`carriedMeme`) into the next
/// one; neither the bound nor a failed sale ever reverts a harvest.
contract PermanentLpLocker is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant CREATOR_FEE_BPS = 8_000;
    uint16 public constant PROTOCOL_FEE_BPS = 2_000;
    /// @dev Must match the live Topaz volatile v2 factory fee (0.30%). This is a
    /// pool-fee check, not an extra locker charge. Harvested LP fees still split 80/20.
    // TODO(founder) Q4: accept any Topaz volatile pool fee at registration (and record it) instead of
    // requiring 30 bps. Not decided; today's 30 bps requirement stays.
    uint16 public constant REQUIRED_POOL_FEE_BPS = 30;
    uint16 internal constant FEE_BPS = 10_000;
    /// @notice Max price impact of one harvest's MEME sale (0.50%: sells <= 0.25% of the MEME reserve).
    uint16 public constant MEME_SALE_MAX_IMPACT_BPS = 50;
    /// @notice The sale is skipped (carried) while spot is worse than the pair's 30 min TWAP by more than this.
    uint16 public constant MEME_SALE_MAX_TWAP_DEVIATION_BPS = 100;


    struct PoolRegistration {
        address campaign;
        address creator;
        address creatorFeeRecipient;
        address pool;
        address token0;
        address token1;
        uint256 lockedLpAmount;
        uint16 creatorFeeBps;
        uint16 protocolFeeBps;
        bool registered;
        address memeToken;
        address pairedToken;
    }

    address public immutable admin;
    address public treasuryRouter;
    address public topazFactory;
    /// @notice MEME fees collected but not yet sold because of the impact bound, per pool.
    mapping(address => uint256) public carriedMeme;

    mapping(address => bool) public registeredLpToken;
    mapping(address => bool) public registeredFeeAsset;
    mapping(address => uint256) public lockedBalance;
    mapping(address => mapping(address => uint256)) public lockedByDepositor;
    mapping(address => PoolRegistration) public poolInfo;
    mapping(address => address) public creatorPayoutRecipient;
    mapping(address => mapping(address => uint256)) public pendingToken;
    mapping(address => uint256) public pendingNative;
    mapping(address => uint256) public pendingProtocolToken;
    uint256 public pendingProtocolNative;
    mapping(address => mapping(address => uint256)) public cumulativeCreatorPaid;
    mapping(address => mapping(address => uint256)) public cumulativeProtocolRouted;

    event LpTokenRegistered(address indexed lpToken);
    event RevenueConfigUpdated(address indexed treasuryRouter, address indexed topazFactory);
    event GraduationPoolRegistered(
        address indexed pool,
        address indexed campaign,
        address indexed creator,
        address creatorFeeRecipient,
        address token0,
        address token1,
        uint256 lockedLpAmount,
        uint16 creatorFeeBps,
        uint16 protocolFeeBps
    );
    event CreatorPayoutRecipientUpdated(address indexed creator, address indexed oldRecipient, address indexed newRecipient);
    event LpPermanentlyLocked(address indexed lpToken, address indexed depositor, uint256 amount, uint256 totalLocked);
    event FeesHarvested(address indexed pool, address indexed caller, address indexed token, uint256 collected, uint256 creatorPaid, uint256 protocolRouted);
    event HarvestPaymentPending(address indexed pool, address indexed recipient, address indexed token, uint256 amount, bool protocolShare);
    event PendingTokenClaimed(address indexed recipient, address indexed token, uint256 amount);
    event PendingNativeClaimed(address indexed recipient, uint256 amount);
    event PendingProtocolTokenRouted(address indexed token, uint256 amount);
    event PendingProtocolNativeRouted(uint256 amount);
    event UnregisteredTokenRecovered(address indexed token, address indexed to, uint256 amount);
    event MemeFeesSold(address indexed pool, address indexed memeToken, uint256 memeSold, uint256 pairedOut, uint256 memeCarried);

    error OnlyAdmin();
    error OnlyCreator();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyRegistered();
    error PoolNotRegistered();
    error LpTokenNotRegistered();
    error RegisteredLpRecoveryBlocked();
    error RegisteredFeeAssetRecoveryBlocked();
    error InvalidTopazFactory();
    error StablePoolUnsupported();
    error InvalidTradingFee();
    error TokenPairMismatch();
    error LockedLpMissing();
    error LpPrincipalChanged();
    error NativeClaimFailed();
    error OnlySelf();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    receive() external payable {}

    function configureRevenue(address treasuryRouter_, address topazFactory_) external onlyAdmin {
        if (treasuryRouter_ == address(0) || topazFactory_ == address(0)) revert ZeroAddress();
        treasuryRouter = treasuryRouter_;
        topazFactory = topazFactory_;
        emit RevenueConfigUpdated(treasuryRouter_, topazFactory_);
    }

    function registerLpToken(address lpToken) external onlyAdmin {
        if (registeredLpToken[lpToken]) revert AlreadyRegistered();
        _registerLpToken(lpToken, true, address(this));
    }

    /// @dev `expectedTokenA` is the campaign's MEME token and `expectedTokenB` the paired asset (WBNB or the
    /// quote token); LaunchFactory passes them in that order. The MEME side is the one sold at harvest.
    function registerGraduatedPool(
        address campaign,
        address creator,
        address creatorFeeRecipient,
        address pool,
        address expectedTokenA,
        address expectedTokenB,
        uint256 lockedLpAmount
    ) external onlyAdmin {
        if (campaign == address(0) || creator == address(0) || creatorFeeRecipient == address(0) || pool == address(0)) revert ZeroAddress();
        if (expectedTokenA == address(0) || expectedTokenB == address(0)) revert ZeroAddress();
        if (poolInfo[pool].registered) revert AlreadyRegistered();
        if (lockedLpAmount == 0) revert ZeroAmount();

        ITopazPoolFeeSource topazPool = ITopazPoolFeeSource(pool);
        address configuredFactory = topazFactory;
        if (configuredFactory != address(0) && topazPool.factory() != configuredFactory) revert InvalidTopazFactory();
        if (topazPool.stable()) revert StablePoolUnsupported();
        if (configuredFactory != address(0) && ITopazPoolFactory(configuredFactory).getFee(pool, false) != REQUIRED_POOL_FEE_BPS) {
            revert InvalidTradingFee();
        }

        address token0_ = topazPool.token0();
        address token1_ = topazPool.token1();
        if (!_samePair(token0_, token1_, expectedTokenA, expectedTokenB)) revert TokenPairMismatch();
        if (IERC20(pool).balanceOf(address(this)) < lockedLpAmount) revert LockedLpMissing();

        _registerLpToken(pool, false, address(this));
        registeredFeeAsset[token0_] = true;
        registeredFeeAsset[token1_] = true;
        lockedBalance[pool] += lockedLpAmount;
        lockedByDepositor[pool][address(this)] += lockedLpAmount;
        creatorPayoutRecipient[creator] = creatorFeeRecipient;
        poolInfo[pool] = PoolRegistration({
            campaign: campaign,
            creator: creator,
            creatorFeeRecipient: creatorFeeRecipient,
            pool: pool,
            token0: token0_,
            token1: token1_,
            lockedLpAmount: lockedLpAmount,
            creatorFeeBps: CREATOR_FEE_BPS,
            protocolFeeBps: PROTOCOL_FEE_BPS,
            registered: true,
            memeToken: expectedTokenA,
            pairedToken: expectedTokenB
        });

        emit LpPermanentlyLocked(pool, address(this), lockedLpAmount, lockedBalance[pool]);
        emit GraduationPoolRegistered(
            pool,
            campaign,
            creator,
            creatorFeeRecipient,
            token0_,
            token1_,
            lockedLpAmount,
            CREATOR_FEE_BPS,
            PROTOCOL_FEE_BPS
        );
    }

    function updateCreatorPayoutRecipient(address newRecipient) external {
        if (newRecipient == address(0)) revert ZeroAddress();
        address old = creatorPayoutRecipient[msg.sender];
        if (old == address(0)) revert OnlyCreator();
        creatorPayoutRecipient[msg.sender] = newRecipient;
        emit CreatorPayoutRecipientUpdated(msg.sender, old, newRecipient);
    }

    function lock(address lpToken, uint256 amount) external nonReentrant {
        if (!registeredLpToken[lpToken]) revert LpTokenNotRegistered();
        if (amount == 0) revert ZeroAmount();

        lockedBalance[lpToken] += amount;
        lockedByDepositor[lpToken][msg.sender] += amount;
        IERC20(lpToken).safeTransferFrom(msg.sender, address(this), amount);

        emit LpPermanentlyLocked(lpToken, msg.sender, amount, lockedBalance[lpToken]);
    }

    /// @notice Permissionless. Claims the pair's fees, sells the MEME side (bounded) for the paired asset in
    /// the same pair, then splits the paired asset 80/20. Never reverts because of the bound or a failed sale.
    /// @return collected0 token0 fees claimed now; collected1 token1 fees claimed now.
    function harvest(address pool) external nonReentrant returns (uint256 collected0, uint256 collected1) {
        PoolRegistration memory info = poolInfo[pool];
        if (!info.registered) revert PoolNotRegistered();

        uint256 principalBefore = IERC20(pool).balanceOf(address(this));
        if (principalBefore < info.lockedLpAmount) revert LpPrincipalChanged();

        uint256 token0Before = IERC20(info.token0).balanceOf(address(this));
        uint256 token1Before = IERC20(info.token1).balanceOf(address(this));
        ITopazPoolFeeSource(pool).claimFees();
        collected0 = IERC20(info.token0).balanceOf(address(this)) - token0Before;
        collected1 = IERC20(info.token1).balanceOf(address(this)) - token1Before;

        if (IERC20(pool).balanceOf(address(this)) < principalBefore) revert LpPrincipalChanged();

        bool memeIs0 = info.memeToken == info.token0;
        uint256 memeCollected = memeIs0 ? collected0 : collected1;
        uint256 paired = memeIs0 ? collected1 : collected0;

        uint256 memeToSell = carriedMeme[pool] + memeCollected;
        uint256 memeSold;
        uint256 pairedOut;
        if (memeToSell != 0) {
            try this.sellMemeForPaired(pool, info.memeToken, memeToSell) returns (uint256 sold_, uint256 out_) {
                memeSold = sold_;
                pairedOut = out_;
            } catch {}
            carriedMeme[pool] = memeToSell - memeSold;
            emit MemeFeesSold(pool, info.memeToken, memeSold, pairedOut, memeToSell - memeSold);
        }

        _splitAndRoute(info, info.pairedToken, paired + pairedOut);
    }

    /// @notice Internal step of harvest, external only so a failed sale reverts atomically inside a try.
    /// @dev Callable by this contract only. Not nonReentrant: it runs inside harvest's guard.
    function sellMemeForPaired(address pool, address memeToken, uint256 amount) external returns (uint256 sold, uint256 out) {
        if (msg.sender != address(this)) revert OnlySelf();
        (sold, out) = EvmGenPoolSwap.v2Plan(pool, memeToken, amount, MEME_SALE_MAX_IMPACT_BPS, MEME_SALE_MAX_TWAP_DEVIATION_BPS);
        if (sold == 0) return (0, 0);
        EvmGenPoolSwap.v2Execute(pool, memeToken, sold, out, address(this));
    }

    /// @notice One view for CreatorRewardsVaultV2 (same shape on the V3 locker).
    function poolParties(address pool)
        external
        view
        returns (address campaign, address creator, address creatorFeeRecipient, address memeToken, address pairedToken, bool registered)
    {
        PoolRegistration storage info = poolInfo[pool];
        return (info.campaign, info.creator, info.creatorFeeRecipient, info.memeToken, info.pairedToken, info.registered);
    }

    function claimPendingToken(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingToken[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        pendingToken[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit PendingTokenClaimed(msg.sender, token, amount);
    }

    function claimPendingNative() external nonReentrant returns (uint256 amount) {
        amount = pendingNative[msg.sender];
        if (amount == 0) revert ZeroAmount();
        pendingNative[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) {
            pendingNative[msg.sender] = amount;
            revert NativeClaimFailed();
        }
        emit PendingNativeClaimed(msg.sender, amount);
    }

    function retryPendingProtocolToken(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingProtocolToken[token];
        if (amount == 0) revert ZeroAmount();
        pendingProtocolToken[token] = 0;
        _routeProtocolToken(address(0), token, amount);
        emit PendingProtocolTokenRouted(token, amount);
    }

    function retryPendingProtocolNative() external nonReentrant returns (uint256 amount) {
        amount = pendingProtocolNative;
        if (amount == 0) revert ZeroAmount();
        pendingProtocolNative = 0;
        _routeProtocolNative(address(0), amount);
        emit PendingProtocolNativeRouted(amount);
    }

    function recoverUnregisteredToken(address token, address to, uint256 amount) external onlyAdmin nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (registeredLpToken[token]) revert RegisteredLpRecoveryBlocked();
        if (registeredFeeAsset[token]) revert RegisteredFeeAssetRecoveryBlocked();

        IERC20(token).safeTransfer(to, amount);
        emit UnregisteredTokenRecovered(token, to, amount);
    }

    function _registerLpToken(address lpToken, bool lockExisting, address depositor) internal {
        if (lpToken == address(0)) revert ZeroAddress();
        if (registeredLpToken[lpToken]) return;
        registeredLpToken[lpToken] = true;
        emit LpTokenRegistered(lpToken);

        if (lockExisting) {
            uint256 currentBalance = IERC20(lpToken).balanceOf(address(this));
            if (currentBalance > 0) {
                lockedBalance[lpToken] = currentBalance;
                lockedByDepositor[lpToken][depositor] = currentBalance;
                emit LpPermanentlyLocked(lpToken, depositor, currentBalance, currentBalance);
            }
        }
    }

    function _splitAndRoute(PoolRegistration memory info, address token, uint256 amount) internal {
        if (amount == 0) return;
        uint256 creatorAmount = (amount * info.creatorFeeBps) / FEE_BPS;
        uint256 protocolAmount = amount - creatorAmount;
        address recipient = creatorPayoutRecipient[info.creator];
        if (recipient == address(0)) recipient = info.creatorFeeRecipient;

        if (_tryTransferToken(token, recipient, creatorAmount)) {
            cumulativeCreatorPaid[info.pool][token] += creatorAmount;
        } else {
            pendingToken[recipient][token] += creatorAmount;
            emit HarvestPaymentPending(info.pool, recipient, token, creatorAmount, false);
        }

        if (_routeProtocolToken(info.pool, token, protocolAmount)) {
            cumulativeProtocolRouted[info.pool][token] += protocolAmount;
        }

        emit FeesHarvested(info.pool, msg.sender, token, amount, creatorAmount, protocolAmount);
    }

    function _routeProtocolToken(address pool, address token, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        address router = treasuryRouter;
        if (router == address(0)) {
            pendingProtocolToken[token] += amount;
            emit HarvestPaymentPending(pool, address(0), token, amount, true);
            return false;
        }
        IERC20(token).forceApprove(router, amount);
        try ILpRevenueTreasuryRouter(router).routeLpToken(token, amount) {
            IERC20(token).forceApprove(router, 0);
            return true;
        } catch {
            IERC20(token).forceApprove(router, 0);
            pendingProtocolToken[token] += amount;
            emit HarvestPaymentPending(pool, router, token, amount, true);
            return false;
        }
    }

    function _routeProtocolNative(address pool, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        address router = treasuryRouter;
        if (router == address(0)) {
            pendingProtocolNative += amount;
            emit HarvestPaymentPending(pool, address(0), address(0), amount, true);
            return false;
        }
        try ILpRevenueTreasuryRouter(router).routeLpNative{value: amount}() {
            return true;
        } catch {
            pendingProtocolNative += amount;
            emit HarvestPaymentPending(pool, router, address(0), amount, true);
            return false;
        }
    }

    function _tryTransferToken(address token, address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _samePair(address a0, address a1, address b0, address b1) internal pure returns (bool) {
        return (a0 == b0 && a1 == b1) || (a0 == b1 && a1 == b0);
    }
}
