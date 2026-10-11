// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FeeConfig, IMwzLaunchHook} from "./interfaces/IMwzLaunchHook.sol";
import {MwzV4Token} from "./MwzV4Token.sol";

interface IMwzGraduationOracle {
    function nativeUsdPrice() external view returns (uint256);
    function nativeTargetForUsd(uint256 usdAmount) external view returns (uint256);
    function maxPriceAge() external view returns (uint256);
}

interface IMwzReserveLockForLauncher {
    function launcher() external view returns (address);
    function lock(PoolId id, address token, uint256 amount) external;
}

interface IMwzChoiceVaultForLauncher {
    function launcher() external view returns (address);
    function registerCoin(PoolId id, address token, address creator, uint8 choice, uint8 creatorPct) external;
}

/// @title MwzV4Launcher (EVM generation 8)
/// @notice One transaction: deploy the coin, size the gen-7 price path on chain from the gen-7 GraduationOracle,
/// initialize the V4 pool through the hook, mint A (850M) and B (130M) into the hook-locker, lock the 2% creator
/// reserve until graduation, register the fee choice, and make the creator's optional first buy (bonding rate, up to
/// 70% of supply). Spec: EVM_GEN8_V4_DESIGN.md 2.4 with L1-L5.
///
/// L1: the rates are constants (200 / 100 / 50 / 9000 bps, creator bonding share 560 bps of the fee); no caller picks
///     them. L2: graduation targets are an allow-list ($30K, $50K; $150 on testnets). L3: the oracle price must be
///     readable (the gen-7 oracle reverts on stale, incomplete or non-positive rounds) and inside an immutable sane
///     band; the curve is refused outside gen-7's C8 bounds. No caller-supplied price or tick exists. L4 (D3): every
///     launch carries an EIP-191 authorization from our API signer over the creator, chain, this launcher and the
///     request (gen-7 create-authorization scheme, max 1 day, digest replay map). Trading is never signed.
///     L5 (D4): createPaused (owner) stops launches only; it has no effect on trading, claims or graduation.
///
/// Money path: `launch` (payable) is nonReentrant. The only native it handles is msg.value, which must equal the
/// signed first-buy value and is spent entirely by the exact-input first buy (a partial fill would mean more than 70%
/// of supply, which reverts), so the launcher never keeps native. It has no receive() and no withdraw.
contract MwzV4Launcher is IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;
    using ECDSA for bytes32;

    error NotPoolManager();
    error NotOwner();
    error ZeroAddress();
    error HookMismatch();
    error WiringMismatch();
    error OracleUnsuitable();
    error CreatePaused();
    error NameEmpty();
    error SymbolEmpty();
    error LogoEmpty();
    error UnsupportedGraduationTarget();
    error InvalidFeeChoice();
    error FirstBuyValueMismatch();
    error FirstBuyTooLarge();
    error FirstBuyTooSmall();
    error CreateSignerZero();
    error AuthorizationExpired();
    error AuthorizationTooLong();
    error InvalidAuthorization();
    error AuthorizationReplayed();
    error OraclePriceUnavailable();
    error OraclePriceOutOfBand();
    error TargetOutOfRangeAtPrice();
    error SupplyBoundBroken();
    error CallbackOutsideLaunch();

    uint256 public constant WAD = 1e18;
    uint256 public constant SUPPLY = 1_000_000_000 * WAD;
    uint256 public constant COINS_A = 850_000_000 * WAD; // the bonding range
    uint256 public constant COINS_B = 130_000_000 * WAD; // above graduation
    uint256 public constant CREATOR_RESERVE = 20_000_000 * WAD; // locked until graduation (D6)
    uint256 public constant FIRST_BUY_MAX = 700_000_000 * WAD; // gen-7 rule: 70% of supply

    // L1 / D13: fixed per-coin rates (bps)
    uint16 public constant BONDING_FEE_BPS = 200;
    uint16 public constant POST_FEE_BPS = 100;
    uint16 public constant CREATOR_POST_BPS = 50;
    uint16 public constant SNIPER_START_BPS = 9000;
    uint16 public constant CREATOR_BONDING_BPS = 560; // D2: gen-7's 560 bps of every pre-graduation fee

    // gen-7 LaunchFactoryGen7 constants (curveForMarketCap, C8 bounds)
    uint256 internal constant G7_BPS = 10_000;
    uint256 internal constant G7_CURVE_BPS = 8500;
    uint256 internal constant G7_LIQ_BPS = 1300;
    uint256 internal constant G7_POOL_MARGIN_BPS = 1;
    uint256 internal constant G7_GRAD_BPS = 200;
    uint256 public constant MIN_MARKET_CAP_NATIVE = 1e15;
    uint256 public constant MAX_VIRTUAL_NATIVE = 1e30;

    // L2: graduation targets (USD, 18 decimals)
    uint256 public constant FAST_GRADUATION_USD = 30_000 ether;
    uint256 public constant DEFAULT_GRADUATION_USD = 50_000 ether;
    uint256 public constant TEST_GRADUATION_USD = 150 ether;

    uint256 public constant MAX_AUTH_TTL = 1 days; // gen-7 audit 5
    /// @dev Upper bound on the oracle's own staleness window. The gen-7 oracles use 3600 s (BNB, Chainlink BNB/USD) and
    /// 90000 s (Robinhood, Chainlink ETH/USD with a 24 h heartbeat); 2 days accepts both and refuses a misconfigured one.
    uint256 public constant MAX_ORACLE_AGE = 2 days;
    int24 public constant TICK_SPACING = 10;

    uint8 public constant FEE_CHOICE_KEEP = 1;
    uint8 public constant FEE_CHOICE_HOLDERS = 2;
    uint8 public constant FEE_CHOICE_SPLIT = 3;
    uint8 public constant FEE_CHOICE_BUYBACK = 4;

    bytes32 public constant CREATE_AUTH_TYPE = keccak256("MWZ_GEN8_CREATE_AUTH");

    IPoolManager public immutable poolManager;
    IMwzLaunchHook public immutable hook;
    IMwzGraduationOracle public immutable oracle;
    IMwzReserveLockForLauncher public immutable reserveLock;
    IMwzChoiceVaultForLauncher public immutable choiceVault;
    uint256 public immutable minNativeUsd; // L3 sane band on the oracle price (USD per native, 18 decimals)
    uint256 public immutable maxNativeUsd;

    address public owner; // the MemeWarzone Safe
    address public pendingOwner;
    address public createSigner; // the API create-authorization key
    bool public createPaused = true; // L5: deploys paused
    uint256 public nonce;
    mapping(bytes32 => bool) public usedAuthorizations;

    /// @notice What the creator asks for; the API signs its hash (D3). Metadata fields as gen-7's CampaignRequest.
    struct LaunchRequest {
        string name;
        string symbol;
        string logoURI;
        string xAccount;
        string website;
        string extraLink;
        bytes32 metadataHash; // hash of the off-chain metadata record (description etc.)
        uint256 targetUsd; // graduation market cap, 18 decimals
        uint8 feeChoice; // 1 keep / 2 holders / 3 split / 4 buyback
        uint8 feeCreatorPct; // 1..99 iff split
        uint256 firstBuyValue; // exact msg.value (0 = no first buy)
        uint256 minFirstBuyOut; // slippage bound on the first buy
        uint256 salt; // API-chosen uniqueness for the authorization
    }

    struct CreateAuthorization {
        uint64 deadline;
        bytes signature;
    }

    event Launched(
        address indexed token,
        PoolId indexed id,
        address indexed creator,
        address hookCreator,
        uint256 targetUsd,
        uint256 marketCapNative,
        uint256 virtualNative,
        uint256 virtualToken,
        int24 tickStart,
        int24 tickGrad,
        uint8 feeChoice,
        uint8 feeCreatorPct,
        uint256 firstBuyIn,
        uint256 firstBuyOut
    );
    event LaunchMetadata(
        address indexed token,
        PoolId indexed id,
        string name,
        string symbol,
        string logoURI,
        string xAccount,
        string website,
        string extraLink,
        bytes32 metadataHash
    );
    event CreatePauseUpdated(bool paused);
    event CreateSignerUpdated(address indexed previous, address indexed next);
    event OwnershipTransferStarted(address indexed current, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IPoolManager _pm,
        IMwzLaunchHook _hook,
        IMwzGraduationOracle _oracle,
        IMwzReserveLockForLauncher _reserveLock,
        IMwzChoiceVaultForLauncher _choiceVault,
        address _owner,
        address _createSigner,
        uint256 _minNativeUsd,
        uint256 _maxNativeUsd
    ) {
        if (
            address(_pm) == address(0) || address(_oracle) == address(0) || _owner == address(0) || address(_reserveLock) == address(0)
                || address(_choiceVault) == address(0)
        ) revert ZeroAddress();
        if (_hook.launcher() != address(this) || address(_hook.poolManager()) != address(_pm) || _hook.TICK_SPACING() != TICK_SPACING) {
            revert HookMismatch();
        }
        if (_reserveLock.launcher() != address(this) || _choiceVault.launcher() != address(this)) revert WiringMismatch();
        uint256 age = _oracle.maxPriceAge();
        if (_minNativeUsd == 0 || _maxNativeUsd <= _minNativeUsd || age == 0 || age > MAX_ORACLE_AGE) revert OracleUnsuitable();
        poolManager = _pm;
        hook = _hook;
        oracle = _oracle;
        reserveLock = _reserveLock;
        choiceVault = _choiceVault;
        minNativeUsd = _minNativeUsd;
        maxNativeUsd = _maxNativeUsd;
        owner = _owner;
        createSigner = _createSigner;
        emit OwnershipTransferred(address(0), _owner);
        emit CreateSignerUpdated(address(0), _createSigner);
        emit CreatePauseUpdated(true);
    }

    // ================================================================== admin (launches only)

    /// @notice L5 / D4: pauses or opens launches. Never affects trading, claims or graduation. Opening requires a
    /// create signer.
    function setCreatePaused(bool paused) external onlyOwner {
        if (!paused && createSigner == address(0)) revert CreateSignerZero();
        createPaused = paused;
        emit CreatePauseUpdated(paused);
    }

    /// @notice Rotates the API create-authorization key. address(0) makes every launch fail (a second pause).
    function setCreateSigner(address next) external onlyOwner {
        emit CreateSignerUpdated(createSigner, next);
        createSigner = next;
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ================================================================== curve sizing (gen-7 C8)

    function isGraduationTargetAllowed(uint256 target) public view returns (bool) {
        if (target == FAST_GRADUATION_USD || target == DEFAULT_GRADUATION_USD) return true;
        // testnets: BSC 97, Robinhood 46630; local hardhat 31337
        return target == TEST_GRADUATION_USD && (block.chainid == 97 || block.chainid == 46630 || block.chainid == 31337);
    }

    /// @notice gen-7 LaunchFactoryGen7.curveForMarketCap, same integer math, with its C8 bounds.
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

    /// @notice Pool sqrt prices (coins per native, Q96) of the gen-7 curve at sold = 0 and sold = 850M.
    ///   start: vT / vN          end: (vT - 850M)^2 / (vN * vT)
    function curveSqrtPrices(uint256 vN, uint256 vT) public pure returns (uint160 sqrtStart, uint160 sqrtEnd) {
        uint256 root = Math.sqrt(vN * vT);
        sqrtStart = SafeCast160.toUint160(FullMath.mulDiv(vT, 1 << 96, root));
        sqrtEnd = SafeCast160.toUint160(FullMath.mulDiv(vT - COINS_A, 1 << 96, root));
    }

    /// @notice Nearest tick on the spacing grid to a sqrt price.
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

    /// @notice L3: the target market cap in native at the oracle price now, then the curve and its grid ticks.
    function plan(uint256 targetUsdWad) public view returns (uint256 mc, uint256 vN, uint256 vT, int24 tickStart, int24 tickGrad) {
        uint256 price;
        try oracle.nativeUsdPrice() returns (uint256 p) {
            price = p;
        } catch {
            revert OraclePriceUnavailable();
        }
        if (price < minNativeUsd || price > maxNativeUsd) revert OraclePriceOutOfBand();
        try oracle.nativeTargetForUsd(targetUsdWad) returns (uint256 t) {
            mc = t;
        } catch {
            revert OraclePriceUnavailable();
        }
        (vN, vT) = curveForMarketCap(mc);
        (uint160 s0, uint160 s1) = curveSqrtPrices(vN, vT);
        tickStart = nearestGridTick(s0);
        tickGrad = nearestGridTick(s1);
    }

    function feeConfig() public pure returns (FeeConfig memory) {
        return FeeConfig({
            bondingBps: BONDING_FEE_BPS,
            postBps: POST_FEE_BPS,
            creatorPostBps: CREATOR_POST_BPS,
            sniperStartBps: SNIPER_START_BPS,
            creatorBondingBps: CREATOR_BONDING_BPS
        });
    }

    // ================================================================== create authorization (D3)

    function hashRequest(LaunchRequest calldata req) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(bytes(req.name)),
                keccak256(bytes(req.symbol)),
                keccak256(bytes(req.logoURI)),
                keccak256(bytes(req.xAccount)),
                keccak256(bytes(req.website)),
                keccak256(bytes(req.extraLink)),
                req.metadataHash,
                req.targetUsd,
                req.feeChoice,
                req.feeCreatorPct,
                req.firstBuyValue,
                req.minFirstBuyOut,
                req.salt
            )
        );
    }

    /// @notice The EIP-191 (personal_sign) digest the API signer signs for `creator` and `req`.
    function authorizationDigest(address creator, LaunchRequest calldata req, uint64 deadline) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(CREATE_AUTH_TYPE, block.chainid, address(this), creator, hashRequest(req), deadline))
        );
    }

    function _consumeAuthorization(address creator, LaunchRequest calldata req, CreateAuthorization calldata auth) internal {
        address signer = createSigner;
        if (signer == address(0)) revert CreateSignerZero();
        if (auth.deadline < block.timestamp) revert AuthorizationExpired();
        if (auth.deadline > block.timestamp + MAX_AUTH_TTL) revert AuthorizationTooLong();
        bytes32 digest = authorizationDigest(creator, req, auth.deadline);
        // ECDSA.recover rejects malleable (high-s) signatures and reverts on invalid ones.
        if (digest.recover(auth.signature) != signer) revert InvalidAuthorization();
        if (usedAuthorizations[digest]) revert AuthorizationReplayed();
        usedAuthorizations[digest] = true;
    }

    // ================================================================== launch

    /// @notice Launches a coin for msg.sender (the creator). nonReentrant. Order: checks (pause, request, signature,
    /// oracle), effects (nonce, replay map), then the deployments and calls into our own contracts (token, choice
    /// vault, hook, reserve lock), then the first buy through the PoolManager, then the events.
    function launch(LaunchRequest calldata req, CreateAuthorization calldata auth)
        external
        payable
        nonReentrant
        returns (address token, PoolId id, uint256 firstBuyOut)
    {
        if (createPaused) revert CreatePaused();
        if (bytes(req.name).length == 0) revert NameEmpty();
        if (bytes(req.symbol).length == 0) revert SymbolEmpty();
        if (bytes(req.logoURI).length == 0) revert LogoEmpty();
        if (!isGraduationTargetAllowed(req.targetUsd)) revert UnsupportedGraduationTarget();
        uint8 choice = req.feeChoice;
        if (choice < FEE_CHOICE_KEEP || choice > FEE_CHOICE_BUYBACK) revert InvalidFeeChoice();
        if (choice == FEE_CHOICE_SPLIT ? (req.feeCreatorPct == 0 || req.feeCreatorPct > 99) : req.feeCreatorPct != 0) revert InvalidFeeChoice();
        if (msg.value != req.firstBuyValue) revert FirstBuyValueMismatch();
        _consumeAuthorization(msg.sender, req, auth);

        LaunchPlan memory p;
        (p.mc, p.vN, p.vT, p.tickStart, p.tickGrad) = plan(req.targetUsd);

        bytes32 salt = keccak256(abi.encode(msg.sender, nonce++));
        token = address(new MwzV4Token{salt: salt}(req.name, req.symbol, SUPPLY, address(this)));
        PoolKey memory key = hook.poolKeyFor(token);
        id = key.toId();

        address hookCreator = msg.sender;
        if (choice != FEE_CHOICE_KEEP) {
            hookCreator = address(choiceVault);
            choiceVault.registerCoin(id, token, msg.sender, choice, req.feeCreatorPct);
        }

        MwzV4Token(token).transfer(address(hook), COINS_A + COINS_B);
        MwzV4Token(token).transfer(address(reserveLock), CREATOR_RESERVE);
        reserveLock.lock(id, token, CREATOR_RESERVE);
        hook.createPool(token, hookCreator, p.tickStart, p.tickGrad, COINS_A, COINS_B, feeConfig());

        if (msg.value > 0) {
            firstBuyOut = abi.decode(poolManager.unlock(abi.encode(key, msg.value, msg.sender)), (uint256));
            if (firstBuyOut > FIRST_BUY_MAX) revert FirstBuyTooLarge();
            if (firstBuyOut < req.minFirstBuyOut) revert FirstBuyTooSmall();
        }
        emit Launched(
            token, id, msg.sender, hookCreator, req.targetUsd, p.mc, p.vN, p.vT, p.tickStart, p.tickGrad, choice, req.feeCreatorPct, msg.value, firstBuyOut
        );
        emit LaunchMetadata(token, id, req.name, req.symbol, req.logoURI, req.xAccount, req.website, req.extraLink, req.metadataHash);
    }

    struct LaunchPlan {
        uint256 mc;
        uint256 vN;
        uint256 vT;
        int24 tickStart;
        int24 tickGrad;
    }

    /// @notice The creator's first buy: exact input, all of msg.value, at the coin's bonding rate (the hook gives the
    /// launcher's own swap the bonding rate, never the launch rate). Only from the PoolManager, only inside launch()
    /// (the reentrancy lock is held), so no other swap can ever have this contract as its sender (A11).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_reentrancyGuardEntered()) revert CallbackOutsideLaunch();
        (PoolKey memory key, uint256 amountIn, address creator) = abi.decode(data, (PoolKey, uint256, address));
        BalanceDelta d = poolManager.swap(
            key, SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}), ""
        );
        uint256 owed = uint256(uint128(-d.amount0()));
        // exact input without a limit consumes the input whole unless the pool runs out of coins (> 70%, reverts)
        if (owed != amountIn) revert FirstBuyTooLarge();
        poolManager.settle{value: owed}();
        uint256 out = uint256(uint128(d.amount1()));
        poolManager.take(key.currency1, creator, out);
        return abi.encode(out);
    }
}

library SafeCast160 {
    error SafeCast160Overflow();

    function toUint160(uint256 v) internal pure returns (uint160) {
        if (v > type(uint160).max) revert SafeCast160Overflow();
        return uint160(v);
    }
}
