// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EvmGenPoolSwap} from "./EvmGenPoolSwap.sol";

interface IRobinhoodV3LockerIntegration {
    function liquidityKind() external view returns (uint8);
    function v3Factory() external view returns (address);
    function positionManager() external view returns (address);
    function WETH() external view returns (address);
    function feeTier() external view returns (uint24);
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool);
}

interface IRobinhoodV3LockerFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IRobinhoodV3LockerPositionManager is IERC721 {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

interface IRobinhoodV3LpRevenueTreasuryRouter {
    function routeLpToken(address token, uint256 amount) external;
}

/// @notice Permanent locker for MemeWarzone Robinhood Chain Uniswap V3 graduation positions.
/// @dev The locker deliberately exposes no NFT transfer, approve, decrease-liquidity, burn,
/// migration or rescue path. Principal remains in the position forever; only earned fees can move.
/// EVM launch generation (E9, docs/evm-launch/spec/C1-C6-fees.md): every harvest sells the MEME-side fees
/// for the paired asset in the same pool with a sqrtPriceLimitX96 at the impact bound (EvmGenPoolSwap), so
/// the pool itself stops the sale (no TWAP guard here: a new pool has one observation slot, and the bound
/// alone makes a sandwich unprofitable, see EvmGenPoolSwap); the unsold rest is carried (`carriedMeme`)
/// into the next harvest, and neither the bound nor a failed sale ever reverts a harvest. Creator and
/// protocol are paid in the paired asset only: WETH on native pools, the stock token on stock-bound pools,
/// both through today's paths (creator transfer with pending fallback, protocol via routeLpToken).
contract PermanentV3PositionLocker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant REQUIRED_LIQUIDITY_KIND = 2;
    uint16 public constant CREATOR_FEE_BPS = 8_000;
    uint16 public constant PROTOCOL_FEE_BPS = 2_000;
    uint16 private constant FEE_BPS = 10_000;
    /// @notice Max price impact of one harvest's MEME sale (0.50%), enforced by the swap's price limit.
    uint16 public constant MEME_SALE_MAX_IMPACT_BPS = 50;

    struct PoolRegistration {
        address campaign;
        address creator;
        address creatorFeeRecipient;
        address pool;
        address token0;
        address token1;
        uint256 tokenId;
        uint128 lockedLiquidity;
        uint24 feeTier;
        uint16 creatorFeeBps;
        uint16 protocolFeeBps;
        bool registered;
        address memeToken;
        address pairedToken;
    }

    address public immutable admin;
    address public treasuryRouter;
    address public integrationSource;
    address public v3Factory;
    address public positionManager;
    address public wrappedNative;
    uint24 public configuredFeeTier;
    uint256 public registrationCount;
    uint256 public pendingPositionCount;

    // Compatibility naming for LaunchFactory/tooling that currently asks whether an LP asset is registered.
    mapping(address => bool) public registeredLpToken;
    mapping(address => bool) public registeredFeeAsset;
    mapping(address => bool) public authorizedIntegrationSource;
    mapping(address => uint256) public lockedBalance;
    mapping(address => PoolRegistration) public poolInfo;
    mapping(address => address) public creatorPayoutRecipient;
    mapping(address => uint256) public pendingPositionByPool;
    mapping(uint256 => address) public positionPool;
    mapping(address => mapping(address => uint256)) public pendingToken;
    mapping(address => uint256) public pendingProtocolToken;
    mapping(address => mapping(address => uint256)) public cumulativeCreatorPaid;
    mapping(address => mapping(address => uint256)) public cumulativeProtocolRouted;
    /// @notice MEME fees collected but not yet sold because of the impact bound, per pool.
    mapping(address => uint256) public carriedMeme;
    // In-flight V3 swap, checked by uniswapV3SwapCallback; zero outside sellMemeForPaired.
    address private activeSwapPool;
    uint256 private activeSwapMaxPay;

    event RevenueConfigUpdated(
        address indexed treasuryRouter,
        address indexed integrationSource,
        address indexed positionManager,
        address v3Factory,
        address wrappedNative,
        uint24 feeTier
    );
    event IntegrationSourceAuthorizationUpdated(address indexed source, bool authorized);
    event V3PositionReceived(address indexed pool, uint256 indexed tokenId, uint128 liquidity);
    event GraduationPoolRegistered(
        address indexed pool,
        address indexed campaign,
        address indexed creator,
        address creatorFeeRecipient,
        address token0,
        address token1,
        uint256 tokenId,
        uint128 lockedLiquidity,
        uint24 feeTier,
        uint16 creatorFeeBps,
        uint16 protocolFeeBps
    );
    event CreatorPayoutRecipientUpdated(address indexed creator, address indexed oldRecipient, address indexed newRecipient);
    event FeesHarvested(address indexed pool, address indexed caller, address indexed token, uint256 collected, uint256 creatorPaid, uint256 protocolRouted);
    event HarvestPaymentPending(address indexed pool, address indexed recipient, address indexed token, uint256 amount, bool protocolShare);
    event PendingTokenClaimed(address indexed recipient, address indexed token, uint256 amount);
    event PendingProtocolTokenRouted(address indexed token, uint256 amount);
    event UnregisteredTokenRecovered(address indexed token, address indexed to, uint256 amount);
    event MemeFeesSold(address indexed pool, address indexed memeToken, uint256 memeSold, uint256 pairedOut, uint256 memeCarried);

    error OnlyAdmin();
    error OnlyCreator();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyRegistered();
    error PoolNotRegistered();
    error InvalidIntegration();
    error IntegrationLocked();
    error InvalidPositionManager();
    error InvalidPositionSender();
    error InvalidPool();
    error InvalidFeeTier();
    error TokenPairMismatch();
    error PositionMissing();
    error PositionPrincipalChanged();
    error RegisteredFeeAssetRecoveryBlocked();
    error OnlySelf();
    error UnexpectedCallback();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    function configureRevenue(address treasuryRouter_, address integrationSource_) external onlyAdmin {
        if (treasuryRouter_ == address(0) || integrationSource_ == address(0)) revert ZeroAddress();
        if (treasuryRouter_.code.length == 0 || integrationSource_.code.length == 0) revert InvalidIntegration();
        if ((registrationCount != 0 || pendingPositionCount != 0) && integrationSource_ != integrationSource) revert IntegrationLocked();

        IRobinhoodV3LockerIntegration source = IRobinhoodV3LockerIntegration(integrationSource_);
        if (source.liquidityKind() != REQUIRED_LIQUIDITY_KIND) revert InvalidIntegration();
        address factory_ = source.v3Factory();
        address manager_ = source.positionManager();
        address wrapped_ = source.WETH();
        uint24 fee_ = source.feeTier();
        if (factory_ == address(0) || manager_ == address(0) || wrapped_ == address(0)) revert InvalidIntegration();
        if (factory_.code.length == 0 || manager_.code.length == 0 || wrapped_.code.length == 0) revert InvalidIntegration();
        if (fee_ == 0) revert InvalidFeeTier();

        if (integrationSource != address(0) && integrationSource != integrationSource_) {
            authorizedIntegrationSource[integrationSource] = false;
            emit IntegrationSourceAuthorizationUpdated(integrationSource, false);
        }
        treasuryRouter = treasuryRouter_;
        integrationSource = integrationSource_;
        v3Factory = factory_;
        positionManager = manager_;
        wrappedNative = wrapped_;
        configuredFeeTier = fee_;
        authorizedIntegrationSource[integrationSource_] = true;

        emit IntegrationSourceAuthorizationUpdated(integrationSource_, true);
        emit RevenueConfigUpdated(treasuryRouter_, integrationSource_, manager_, factory_, wrapped_, fee_);
    }

    function setIntegrationSourceAuthorized(address sourceAddress, bool authorized) external onlyAdmin {
        if (sourceAddress == address(0)) revert ZeroAddress();
        if (!authorized && sourceAddress == integrationSource) revert InvalidIntegration();
        if (authorized) {
            if (sourceAddress.code.length == 0) revert InvalidIntegration();
            IRobinhoodV3LockerIntegration source = IRobinhoodV3LockerIntegration(sourceAddress);
            if (
                source.liquidityKind() != REQUIRED_LIQUIDITY_KIND ||
                source.v3Factory() != v3Factory ||
                source.positionManager() != positionManager ||
                source.WETH() != wrappedNative ||
                source.feeTier() != configuredFeeTier
            ) revert InvalidIntegration();
        }
        authorizedIntegrationSource[sourceAddress] = authorized;
        emit IntegrationSourceAuthorizationUpdated(sourceAddress, authorized);
    }

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        address manager_ = positionManager;
        if (manager_ == address(0) || msg.sender != manager_) revert InvalidPositionManager();
        if (!authorizedIntegrationSource[operator]) revert InvalidPositionSender();
        if (from != address(0) && from != operator) revert InvalidPositionSender();

        (address token0_, address token1_, uint24 fee_, uint128 liquidity_) = _positionCore(tokenId);
        if (fee_ != configuredFeeTier) revert InvalidFeeTier();
        if (liquidity_ == 0) revert ZeroAmount();

        address pool = IRobinhoodV3LockerFactory(v3Factory).getPool(token0_, token1_, fee_);
        if (pool == address(0)) revert InvalidPool();
        if (pendingPositionByPool[pool] != 0 || registeredLpToken[pool]) revert AlreadyRegistered();

        pendingPositionByPool[pool] = tokenId;
        positionPool[tokenId] = pool;
        pendingPositionCount += 1;
        emit V3PositionReceived(pool, tokenId, liquidity_);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev `expectedTokenA` is the campaign's MEME token and `expectedTokenB` the paired asset (WETH or the
    /// stock token); LaunchFactory passes them in that order. The MEME side is the one sold at harvest.
    /// Signature intentionally matches PermanentLpLocker so the next LaunchFactory generation
    /// can use one registration boundary. lockedLpAmount may be zero for V3; actual NFT liquidity is
    /// read from the canonical position manager and becomes the locked principal invariant.
    function registerGraduatedPool(
        address campaign,
        address creator,
        address creatorFeeRecipient,
        address pool,
        address expectedTokenA,
        address expectedTokenB,
        uint256 lockedLpAmount
    ) external onlyAdmin {
        if (
            campaign == address(0) || creator == address(0) || creatorFeeRecipient == address(0) ||
            pool == address(0) || expectedTokenA == address(0) || expectedTokenB == address(0)
        ) revert ZeroAddress();
        if (registeredLpToken[pool]) revert AlreadyRegistered();

        uint256 tokenId = pendingPositionByPool[pool];
        if (tokenId == 0) revert PositionMissing();
        IRobinhoodV3LockerPositionManager manager = IRobinhoodV3LockerPositionManager(positionManager);
        if (manager.ownerOf(tokenId) != address(this)) revert PositionPrincipalChanged();

        (address token0_, address token1_, uint24 fee_, uint128 liquidity_) = _positionCore(tokenId);
        if (fee_ != configuredFeeTier) revert InvalidFeeTier();
        // expectedTokenA is the MEME side that harvest sells; it can never be the wrapped native.
        if (!_samePair(token0_, token1_, expectedTokenA, expectedTokenB) || expectedTokenA == wrappedNative) revert TokenPairMismatch();
        if (IRobinhoodV3LockerFactory(v3Factory).getPool(token0_, token1_, fee_) != pool) revert InvalidPool();
        if (liquidity_ == 0) revert ZeroAmount();
        if (lockedLpAmount != 0 && lockedLpAmount != uint256(liquidity_)) revert PositionPrincipalChanged();

        delete pendingPositionByPool[pool];
        pendingPositionCount -= 1;
        registrationCount += 1;
        registeredLpToken[pool] = true;
        registeredFeeAsset[token0_] = true;
        registeredFeeAsset[token1_] = true;
        lockedBalance[pool] = uint256(liquidity_);
        creatorPayoutRecipient[creator] = creatorFeeRecipient;
        poolInfo[pool] = PoolRegistration({
            campaign: campaign,
            creator: creator,
            creatorFeeRecipient: creatorFeeRecipient,
            pool: pool,
            token0: token0_,
            token1: token1_,
            tokenId: tokenId,
            lockedLiquidity: liquidity_,
            feeTier: fee_,
            creatorFeeBps: CREATOR_FEE_BPS,
            protocolFeeBps: PROTOCOL_FEE_BPS,
            registered: true,
            memeToken: expectedTokenA,
            pairedToken: expectedTokenB
        });

        emit GraduationPoolRegistered(
            pool,
            campaign,
            creator,
            creatorFeeRecipient,
            token0_,
            token1_,
            tokenId,
            liquidity_,
            fee_,
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

    function harvest(address pool) external nonReentrant returns (uint256 collected0, uint256 collected1) {
        PoolRegistration memory info = poolInfo[pool];
        if (!info.registered) revert PoolNotRegistered();

        IRobinhoodV3LockerPositionManager manager = IRobinhoodV3LockerPositionManager(positionManager);
        if (manager.ownerOf(info.tokenId) != address(this)) revert PositionPrincipalChanged();
        (, , , uint128 liquidityBefore) = _positionCore(info.tokenId);
        if (liquidityBefore != info.lockedLiquidity) revert PositionPrincipalChanged();

        uint256 token0Before = IERC20(info.token0).balanceOf(address(this));
        uint256 token1Before = IERC20(info.token1).balanceOf(address(this));
        manager.collect(
            IRobinhoodV3LockerPositionManager.CollectParams({
                tokenId: info.tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        collected0 = IERC20(info.token0).balanceOf(address(this)) - token0Before;
        collected1 = IERC20(info.token1).balanceOf(address(this)) - token1Before;

        if (manager.ownerOf(info.tokenId) != address(this)) revert PositionPrincipalChanged();
        (, , , uint128 liquidityAfter) = _positionCore(info.tokenId);
        if (liquidityAfter != liquidityBefore) revert PositionPrincipalChanged();

        bool memeIs0 = info.memeToken == info.token0;
        uint256 memeToSell = carriedMeme[pool] + (memeIs0 ? collected0 : collected1);
        uint256 paired = memeIs0 ? collected1 : collected0;
        if (memeToSell != 0) {
            uint256 memeSold;
            uint256 pairedOut;
            try this.sellMemeForPaired(pool, memeIs0, memeToSell) returns (uint256 sold_, uint256 out_) {
                memeSold = sold_;
                pairedOut = out_;
            } catch {}
            carriedMeme[pool] = memeToSell - memeSold;
            paired += pairedOut;
            emit MemeFeesSold(pool, info.memeToken, memeSold, pairedOut, memeToSell - memeSold);
        }

        _splitAndRoute(info, info.pairedToken, paired);
    }

    /// @notice Internal step of harvest, external only so a failed sale reverts atomically inside a try.
    /// @dev Callable by this contract only; runs inside harvest's reentrancy guard.
    function sellMemeForPaired(address pool, bool memeIs0, uint256 amount) external returns (uint256 sold, uint256 out) {
        if (msg.sender != address(this)) revert OnlySelf();
        (bool ok, uint160 limit) =
            EvmGenPoolSwap.v3Limit(pool, memeIs0, MEME_SALE_MAX_IMPACT_BPS, 0, 0);
        if (!ok) return (0, 0);
        activeSwapPool = pool;
        activeSwapMaxPay = amount;
        (sold, out) = EvmGenPoolSwap.v3Swap(pool, memeIs0, amount, limit, address(this));
        activeSwapPool = address(0);
        activeSwapMaxPay = 0;
    }

    /// @notice Pays the pool during sellMemeForPaired only. Any other caller or time reverts.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != activeSwapPool || msg.sender == address(0)) revert UnexpectedCallback();
        PoolRegistration storage info = poolInfo[msg.sender];
        bool memeIs0 = info.memeToken == info.token0;
        EvmGenPoolSwap.v3PayOwed(info.memeToken, memeIs0, amount0Delta, amount1Delta, activeSwapMaxPay);
    }

    function claimPendingToken(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingToken[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        pendingToken[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit PendingTokenClaimed(msg.sender, token, amount);
    }

    function retryPendingProtocolToken(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingProtocolToken[token];
        if (amount == 0) revert ZeroAmount();
        pendingProtocolToken[token] = 0;
        _routeProtocolToken(address(0), token, amount);
        emit PendingProtocolTokenRouted(token, amount);
    }

    function recoverUnregisteredToken(address token, address to, uint256 amount) external onlyAdmin nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (registeredFeeAsset[token]) revert RegisteredFeeAssetRecoveryBlocked();
        IERC20(token).safeTransfer(to, amount);
        emit UnregisteredTokenRecovered(token, to, amount);
    }

    function _splitAndRoute(PoolRegistration memory info, address token, uint256 amount) private {
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

    function _routeProtocolToken(address pool, address token, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        address router_ = treasuryRouter;
        if (router_ == address(0)) {
            pendingProtocolToken[token] += amount;
            emit HarvestPaymentPending(pool, address(0), token, amount, true);
            return false;
        }
        IERC20(token).forceApprove(router_, amount);
        try IRobinhoodV3LpRevenueTreasuryRouter(router_).routeLpToken(token, amount) {
            IERC20(token).forceApprove(router_, 0);
            return true;
        } catch {
            IERC20(token).forceApprove(router_, 0);
            pendingProtocolToken[token] += amount;
            emit HarvestPaymentPending(pool, router_, token, amount, true);
            return false;
        }
    }

    function _tryTransferToken(address token, address to, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _positionCore(uint256 tokenId) private view returns (address token0_, address token1_, uint24 fee_, uint128 liquidity_) {
        (
            uint96 nonce_,
            address operator_,
            address t0,
            address t1,
            uint24 f,
            int24 tickLower_,
            int24 tickUpper_,
            uint128 liq,
            uint256 feeGrowth0_,
            uint256 feeGrowth1_,
            uint128 owed0_,
            uint128 owed1_
        ) = IRobinhoodV3LockerPositionManager(positionManager).positions(tokenId);
        nonce_; operator_; tickLower_; tickUpper_; feeGrowth0_; feeGrowth1_; owed0_; owed1_;
        return (t0, t1, f, liq);
    }

    function _samePair(address a0, address a1, address b0, address b1) private pure returns (bool) {
        return (a0 == b0 && a1 == b1) || (a0 == b1 && a1 == b0);
    }
}
