// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IAlgebraPool} from "./interfaces/core/IAlgebraPool.sol";
import {IAlgebraFactory} from "./interfaces/core/IAlgebraFactory.sol";
import {IAlgebraPluginFactory} from "./interfaces/core/plugin/IAlgebraPluginFactory.sol";
import {IAlgebraMintCallback} from "./interfaces/core/callback/IAlgebraMintCallback.sol";
import {IAlgebraSwapCallback} from "./interfaces/core/callback/IAlgebraSwapCallback.sol";
import {IAlgebraCustomPoolEntryPoint} from "./interfaces/periphery/IAlgebraCustomPoolEntryPoint.sol";
import {IWNativeToken} from "./interfaces/periphery/external/IWNativeToken.sol";
import {IMwzBarkLauncher} from "./interfaces/IMwzBarkLauncher.sol";
import {MwzBarkPlugin} from "./MwzBarkPlugin.sol";
import {MwzV4Token} from "../../gen8/MwzV4Token.sol";

/// @dev The foundation's GraduationOracle (gen-7, reused unchanged): reverts on a stale, incomplete or non-positive
/// round; `maxPriceAge` is immutable there.
interface IMwzBarkOracle {
    function nativeUsdPrice() external view returns (uint256);
    function nativeTargetForUsd(uint256 usdAmount) external view returns (uint256);
    function maxPriceAge() external view returns (uint256);
}

/// @dev MwzBarkReserveLock (t5): holds the 2% creator reserve per coin until its release conditions hold.
interface IMwzBarkReserveLockForLauncher {
    function launcher() external view returns (address);
    function lock(address coin, uint256 amount) external;
}

/// @dev MwzBarkCreatorChoiceVault (t6): the creator's fee choice (holders / split / buyback) per coin.
interface IMwzBarkChoiceVaultForLauncher {
    function launcher() external view returns (address);
    function registerCoin(address coin, address creator, uint8 choice, uint8 creatorPct) external;
}

/// @title MwzBarkLauncher (EVM generation 8 on Barkswap, DogeOS) - launch path and restore
/// @notice The Barkswap custom-pool deployer and plugin factory of every MemeWarzone coin on DogeOS: gen-8's
/// MwzV4Launcher on Algebra Integral 1.2.1, plus (t4) the money side of gen-8's MwzLaunchHook. Spec:
/// docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md sections 2-3 (launcher row, B9); audit:
/// docs/dogeos/barkswap-audit.md (MwzBarkLauncher).
///
/// `launch`, one transaction: signed create (gen-8 D3, with openAt), curve sized on chain from the GraduationOracle
/// (gen-7 curveForMarketCap; oracle band and age, F6), coin CREATE2 with a salt chosen by the create signer so the coin
/// sorts below WDOGE (token0), `plugin.registerPool`, `EP.createCustomPool` (this contract is the deployer and the
/// plugin factory: `beforeCreatePoolHook` returns the shared plugin), `pool.initialize` at the plugin's start price,
/// tick spacing 10, `EP.setFee(pool, 0)` before the dynamic-fee flag (config 135), positions A (850M) and B (130M)
/// minted one-sided on the pool, owned by this contract, 20M to the reserve lock, rounding dust burned, then the optional
/// creator first buy (bonding rate, at most 70% of supply).
///
/// After launch this contract makes exactly three kinds of call into a pool or the entry point: `restore(coin)`
/// (permissionless; re-applies our plugin, lastFee 0 and config 135, nothing else), the one graduation-fee burn
/// (`takeGraduationFee`, inline from the plugin or as the guarded permissionless fallback), and (t4) fee collection and
/// the coin-fee conversion sell. Nothing removes liquidity except the one graduation burn (I6); there is no withdraw.
///
/// Plugin obligations O1-O4 (IMwzBarkLauncher) are met here; each is ticked in the audit file.
contract MwzBarkLauncher is
    IAlgebraPluginFactory,
    IAlgebraMintCallback,
    IAlgebraSwapCallback,
    IMwzBarkLauncher,
    ReentrancyGuardTransient
{
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    error NotOwner();
    error ZeroAddress();
    error WiringMismatch();
    error OracleUnsuitable();
    error CreatePaused();
    error CreateSignerZero();
    error NameEmpty();
    error SymbolEmpty();
    error LogoEmpty();
    error UnsupportedGraduationTarget();
    error InvalidFeeChoice();
    error FirstBuyValueMismatch();
    error FirstBuyTooLarge();
    error FirstBuyTooSmall();
    error OpenAtTooFar();
    error AuthorizationExpired();
    error AuthorizationTooLong();
    error InvalidAuthorization();
    error AuthorizationReplayed();
    error OraclePriceUnavailable();
    error OraclePriceOutOfBand();
    error TargetOutOfRangeAtPrice();
    error SupplyBoundBroken();
    error BadTicks();
    error BadLiquidity();
    error CoinNotBelowWNative();
    error UnexpectedPool();
    error OnlyEntryPoint();
    error BadCallback();
    error MintMismatch();
    error UnknownCoin();
    error UnknownPool();
    error PoolBusy();
    error ForeignPlugin();
    error NotGraduated();
    error PriceBelowGraduation();
    error GraduationFeeAlreadyTaken();
    error GraduationBurnNotNative();
    error CollectMismatch();
    error NothingToRestore();
    error NotWNative();

    // ------------------------------------------------------------------ supply split (spec section 2)
    uint256 public constant WAD = 1e18;
    uint256 public constant SUPPLY = 1_000_000_000 * WAD;
    uint256 public constant COINS_A = 850_000_000 * WAD; // bonding range [tickStart, tickGrad]
    uint256 public constant COINS_B = 130_000_000 * WAD; // above graduation [tickGrad, TICK_MAX]
    uint256 public constant CREATOR_RESERVE = 20_000_000 * WAD; // to the reserve lock (D6)
    uint256 public constant FIRST_BUY_MAX = 700_000_000 * WAD; // gen-7 rule: 70% of supply

    // ------------------------------------------------------------------ gen-7 LaunchFactoryGen7 (curveForMarketCap, C8)
    uint256 internal constant G7_BPS = 10_000;
    uint256 internal constant G7_CURVE_BPS = 8500;
    uint256 internal constant G7_LIQ_BPS = 1300;
    uint256 internal constant G7_POOL_MARGIN_BPS = 1;
    uint256 internal constant G7_GRAD_BPS = 200;
    uint256 public constant MIN_MARKET_CAP_NATIVE = 1e15;
    uint256 public constant MAX_VIRTUAL_NATIVE = 1e30;

    // ------------------------------------------------------------------ graduation targets (gen-8 L2, USD 18 decimals)
    uint256 public constant FAST_GRADUATION_USD = 30_000 ether;
    uint256 public constant DEFAULT_GRADUATION_USD = 50_000 ether;
    uint256 public constant TEST_GRADUATION_USD = 150 ether;
    uint256 public constant DOGEOS_TESTNET_CHAIN_ID = 6_281_971;

    uint256 public constant MAX_AUTH_TTL = 1 days; // gen-7 audit 5
    uint256 public constant MAX_OPEN_DELAY = 30 days; // gen-8 B; the plugin enforces the same bound
    /// @dev Upper bound on the launcher's age input; the DogeOS value is 3600 s (spec section 2).
    uint256 public constant MAX_ORACLE_AGE = 2 days;

    // ------------------------------------------------------------------ pool shape
    int24 public constant TICK_SPACING = 10;
    /// @dev TickMath.maxUsableTick(10): B's top tick (B holds coins for every price above graduation).
    int24 public constant TICK_MAX = 887_270;
    uint8 public constant PLUGIN_CONFIG = 135; // == MwzBarkPlugin.PLUGIN_CONFIG, checked in the constructor
    uint8 internal constant DYNAMIC_FEE_FLAG = 128;
    uint256 public constant GRAD_FEE_BPS = 200; // one-time: floor(liqA x 2%) from A (I6)
    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q192 = 1 << 192;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint8 public constant FEE_CHOICE_KEEP = 1;
    uint8 public constant FEE_CHOICE_HOLDERS = 2;
    uint8 public constant FEE_CHOICE_SPLIT = 3;
    uint8 public constant FEE_CHOICE_BUYBACK = 4;

    /// @dev Same authorization type string as gen-8 (the API signer code is shared); the digest also binds chain id and
    /// this launcher's address, so a gen-8 authorization can never be replayed here or the reverse.
    bytes32 public constant CREATE_AUTH_TYPE = keccak256("MWZ_GEN8_CREATE_AUTH");

    // transient slots
    /// @dev The pool this launcher is creating / minting into / swapping on right now (0 otherwise). Gates the three
    /// callbacks and `beforeCreatePoolHook`.
    bytes32 internal constant T_ACTIVE_POOL = keccak256("mwz.dogeos.bark.launcher.activePool");
    /// @dev Per pool: non-zero only around the coin-fee conversion swap (t4). keccak256(abi.encode(T_CONVERSION, pool)).
    bytes32 internal constant T_CONVERSION = keccak256("mwz.dogeos.bark.launcher.conversion");

    IAlgebraCustomPoolEntryPoint public immutable entryPoint;
    IAlgebraFactory public immutable algebraFactory;
    address public immutable wNative; // WDOGE, token1 of every pool
    MwzBarkPlugin public immutable plugin;
    IMwzBarkOracle public immutable oracle;
    IMwzBarkReserveLockForLauncher public immutable reserveLock;
    IMwzBarkChoiceVaultForLauncher public immutable choiceVault;
    uint256 public immutable minNativeUsd; // F6 band on the oracle price (USD per DOGE, 18 decimals)
    uint256 public immutable maxNativeUsd;
    uint256 public immutable maxOracleAge; // the oracle's own maxPriceAge must not exceed this

    address public owner; // DogeOS deployer key on testnet (spec B9)
    address public pendingOwner;
    address public createSigner; // DogeOS route-authority key (spec B9)
    bool public createPaused = true; // gen-8 L5: deploys paused; launches only
    mapping(bytes32 digest => bool) public usedAuthorizations;

    /// @notice One launched coin. slot 0: pool (20) + openAt (5) + tickStart (3) + tickGrad (3) + gradFeeTaken (1);
    /// slot 1: feeCreator; slot 2: liqA + liqB; slot 3: graduationFee.
    struct Launch {
        address pool; // 0 = not ours
        uint40 openAt;
        int24 tickStart; // A = [tickStart, tickGrad]
        int24 tickGrad; // B = [tickGrad, TICK_MAX]
        bool gradFeeTaken; // I6: the one graduation burn ran
        address feeCreator; // receives the creator amount (t4): the creator, or the choice vault for holders/split/buyback
        uint128 liqA;
        uint128 liqB;
        uint256 graduationFee; // native taken by the graduation burn (0 before); t4 credits it to the graduation book
    }

    mapping(address coin => Launch) public launches;
    mapping(address pool => address coin) public coinOf;

    /// @notice What the creator asks for; the API signs its hash (D3). Same layout and hash as gen-8's
    /// MwzV4Launcher.LaunchRequest. `salt` doubles as the coin's CREATE2 salt input (keccak256(abi.encode(creator,
    /// salt))): the create signer picks it so the coin address sorts below WDOGE.
    struct LaunchRequest {
        string name;
        string symbol;
        string logoURI;
        string xAccount;
        string website;
        string extraLink;
        bytes32 metadataHash;
        uint256 targetUsd; // graduation market cap, 18 decimals
        uint8 feeChoice; // 1 keep / 2 holders / 3 split / 4 buyback
        uint8 feeCreatorPct; // 1..99 iff split
        uint256 firstBuyValue; // exact msg.value (0 = no first buy)
        uint256 minFirstBuyOut; // slippage bound on the first buy
        uint256 salt; // API-chosen; also the coin's CREATE2 salt input
        uint64 openAt; // trading opens (0 or a past time = now); at most now + 30 days
    }

    struct CreateAuthorization {
        uint64 deadline;
        bytes signature;
    }

    /// @dev Curve plan of one launch (memory; keeps the stack shallow).
    struct LaunchPlan {
        uint256 mc;
        uint256 vN;
        uint256 vT;
        int24 tickStart;
        int24 tickGrad;
        uint128 liqA;
        uint128 liqB;
    }

    event Launched(
        address indexed coin,
        address indexed pool,
        address indexed creator,
        address feeCreator,
        uint256 targetUsd,
        uint256 marketCapNative,
        uint256 virtualNative,
        uint256 virtualToken,
        int24 tickStart,
        int24 tickGrad,
        uint128 liqA,
        uint128 liqB,
        uint8 feeChoice,
        uint8 feeCreatorPct,
        uint256 firstBuyIn,
        uint256 firstBuyOut,
        uint40 openAt
    );
    event LaunchMetadata(
        address indexed coin,
        address indexed pool,
        string name,
        string symbol,
        string logoURI,
        string xAccount,
        string website,
        string extraLink,
        bytes32 metadataHash
    );
    /// @notice The one-time graduation fee: `liquidity` = floor(liqA x 2%) burned from A, `amount` native (unwrapped
    /// WDOGE) received; `inlineCall` when the plugin's latching swap triggered it.
    event GraduationFeeTaken(address indexed coin, address indexed pool, uint256 amount, uint128 liquidity, bool inlineCall);
    /// @notice `restore` re-applied our launch settings after a Barkswap admin change.
    event Restored(address indexed coin, address indexed pool, bool pluginReset, bool feeReset, bool configReset);
    event CreatePauseUpdated(bool paused);
    event CreateSignerUpdated(address indexed previous, address indexed next);
    event OwnershipTransferStarted(address indexed current, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Deploy order: plugin, reserve lock and choice vault are deployed first against this contract's predicted
    /// address; this constructor checks each of them points back here.
    constructor(
        IAlgebraCustomPoolEntryPoint entryPoint_,
        address wNative_,
        MwzBarkPlugin plugin_,
        IMwzBarkOracle oracle_,
        IMwzBarkReserveLockForLauncher reserveLock_,
        IMwzBarkChoiceVaultForLauncher choiceVault_,
        address owner_,
        address createSigner_,
        uint256 minNativeUsd_,
        uint256 maxNativeUsd_,
        uint256 maxOracleAge_
    ) {
        if (
            address(entryPoint_) == address(0) || wNative_ == address(0) || address(plugin_) == address(0)
                || address(oracle_) == address(0) || address(reserveLock_) == address(0) || address(choiceVault_) == address(0)
                || owner_ == address(0)
        ) revert ZeroAddress();
        IAlgebraFactory factory_ = IAlgebraFactory(entryPoint_.factory());
        if (address(factory_) == address(0)) revert ZeroAddress();
        if (
            plugin_.launcher() != address(this) || plugin_.wNative() != wNative_ || plugin_.choiceVault() != address(choiceVault_)
                || plugin_.PLUGIN_CONFIG() != PLUGIN_CONFIG || reserveLock_.launcher() != address(this)
                || choiceVault_.launcher() != address(this)
        ) revert WiringMismatch();
        uint256 age = oracle_.maxPriceAge();
        if (
            minNativeUsd_ == 0 || maxNativeUsd_ <= minNativeUsd_ || maxOracleAge_ == 0 || maxOracleAge_ > MAX_ORACLE_AGE || age == 0
                || age > maxOracleAge_
        ) revert OracleUnsuitable();
        entryPoint = entryPoint_;
        algebraFactory = factory_;
        wNative = wNative_;
        plugin = plugin_;
        oracle = oracle_;
        reserveLock = reserveLock_;
        choiceVault = choiceVault_;
        minNativeUsd = minNativeUsd_;
        maxNativeUsd = maxNativeUsd_;
        maxOracleAge = maxOracleAge_;
        owner = owner_;
        createSigner = createSigner_;
        emit OwnershipTransferred(address(0), owner_);
        emit CreateSignerUpdated(address(0), createSigner_);
        emit CreatePauseUpdated(true);
    }

    // ================================================================== admin (launches only)

    /// @notice gen-8 L5: pauses or opens launches. Never affects trading, restore, the graduation fee or (t4) claims.
    function setCreatePaused(bool paused) external onlyOwner {
        if (!paused && createSigner == address(0)) revert CreateSignerZero();
        createPaused = paused;
        emit CreatePauseUpdated(paused);
    }

    /// @notice Rotates the create-authorization key. address(0) makes every launch fail (a second pause).
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

    // ================================================================== curve sizing (gen-7 C8, Barkswap orientation)

    function isGraduationTargetAllowed(uint256 target) public view returns (bool) {
        if (target == FAST_GRADUATION_USD || target == DEFAULT_GRADUATION_USD) return true;
        // testnets: DogeOS Chikyu 6281971 (also the fork's chain id); local hardhat 31337
        return target == TEST_GRADUATION_USD && (block.chainid == DOGEOS_TESTNET_CHAIN_ID || block.chainid == 31337);
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

    /// @notice F6 / gen-8 L3: the target market cap in native at the oracle price now (the oracle refuses a price older
    /// than its maxPriceAge, at most `maxOracleAge`), refused outside the band, then the curve and its grid ticks.
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

    // ================================================================== create authorization (D3, gen-8 unchanged)

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
                req.salt,
                req.openAt
            )
        );
    }

    /// @notice The EIP-191 (personal_sign) digest the create signer signs for `creator` and `req`.
    function authorizationDigest(address creator, LaunchRequest calldata req, uint64 deadline) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(CREATE_AUTH_TYPE, block.chainid, address(this), creator, hashRequest(req), deadline))
        );
    }

    function _consumeAuthorization(address creator, LaunchRequest calldata req, CreateAuthorization calldata auth) private {
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
    /// oracle, ticks), effects (replay map; then, once the coin and pool addresses are known, this contract's record of
    /// the launch), then the deployments and calls (coin, choice vault, plugin, entry point, pool, reserve lock), then
    /// the first buy, then the events. Every external call goes to our own contracts, Barkswap's entry point / factory /
    /// new pool, or WDOGE.
    function launch(LaunchRequest calldata req, CreateAuthorization calldata auth)
        external
        payable
        nonReentrant
        returns (address coin, address pool, uint256 firstBuyOut)
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
        // gen-8 B: 0 or a time already passed opens trading now; later than 30 days is refused
        uint40 openAt = uint40(block.timestamp);
        if (req.openAt > block.timestamp) {
            if (req.openAt > block.timestamp + MAX_OPEN_DELAY) revert OpenAtTooFar();
            openAt = uint40(req.openAt);
        }
        _consumeAuthorization(msg.sender, req, auth);

        LaunchPlan memory p = _planLaunch(req.targetUsd);

        coin = address(new MwzV4Token{salt: _coinSalt(msg.sender, req.salt)}(req.name, req.symbol, SUPPLY, address(this)));
        // O1: the coin is token0 and WDOGE token1 (the plugin's orientation; checked again at initialize)
        if (coin >= wNative) revert CoinNotBelowWNative();
        pool = algebraFactory.computeCustomPoolAddress(address(this), coin, wNative);

        address feeCreator = choice == FEE_CHOICE_KEEP ? msg.sender : address(choiceVault);
        launches[coin] = Launch({
            pool: pool,
            openAt: openAt,
            tickStart: p.tickStart,
            tickGrad: p.tickGrad,
            gradFeeTaken: false,
            feeCreator: feeCreator,
            liqA: p.liqA,
            liqB: p.liqB,
            graduationFee: 0
        });
        coinOf[pool] = coin;
        if (choice != FEE_CHOICE_KEEP) choiceVault.registerCoin(coin, msg.sender, choice, req.feeCreatorPct);

        _createPool(coin, pool, p, openAt);
        _seed(coin, pool, p);

        if (msg.value > 0) {
            firstBuyOut = _firstBuy(pool, msg.value, p.tickGrad);
            if (firstBuyOut < req.minFirstBuyOut) revert FirstBuyTooSmall();
        }
        emit Launched(
            coin,
            pool,
            msg.sender,
            feeCreator,
            req.targetUsd,
            p.mc,
            p.vN,
            p.vT,
            p.tickStart,
            p.tickGrad,
            p.liqA,
            p.liqB,
            choice,
            req.feeCreatorPct,
            msg.value,
            firstBuyOut,
            openAt
        );
        emit LaunchMetadata(coin, pool, req.name, req.symbol, req.logoURI, req.xAccount, req.website, req.extraLink, req.metadataHash);
    }

    /// @dev The curve, its grid ticks (aligned to spacing 10, checked here so the revert reason is ours, not the pool's)
    /// and the liquidity of A and B. A = [tickStart, tickGrad] holds 850M coins, B = [tickGrad, TICK_MAX] 130M; both are
    /// coin-only at the start price (A's lower bound), so liquidity comes from the token0 amount.
    function _planLaunch(uint256 targetUsd) private view returns (LaunchPlan memory p) {
        (p.mc, p.vN, p.vT, p.tickStart, p.tickGrad) = plan(targetUsd);
        if (
            p.tickStart % TICK_SPACING != 0 || p.tickGrad % TICK_SPACING != 0 || TICK_MAX % TICK_SPACING != 0
                || p.tickStart < TickMath.minUsableTick(TICK_SPACING) || p.tickStart >= p.tickGrad || p.tickGrad >= TICK_MAX
        ) revert BadTicks();
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(p.tickStart);
        uint160 sqrtGrad = TickMath.getSqrtPriceAtTick(p.tickGrad);
        p.liqA = LiquidityAmounts.getLiquidityForAmount0(sqrtStart, sqrtGrad, COINS_A);
        p.liqB = LiquidityAmounts.getLiquidityForAmount0(sqrtGrad, TickMath.getSqrtPriceAtTick(TICK_MAX), COINS_B);
        // floor(liqA x 2%) must be non-zero (I6); both are ~1e23 for every target the band allows
        if (p.liqA < BPS || p.liqB == 0) revert BadLiquidity();
    }

    /// @dev O1 + O4: register in the plugin before the pool exists, create it through the entry point (this contract is
    /// the deployer; `beforeCreatePoolHook` returns the plugin only for this pool), initialize at the plugin's stored
    /// start price, tick spacing 10, lastFee 0 while the dynamic-fee flag is still off, then config 135.
    function _createPool(address coin, address pool, LaunchPlan memory p, uint40 openAt) private {
        plugin.registerPool(pool, coin, p.tickStart, p.tickGrad, openAt);
        _tstore(T_ACTIVE_POOL, uint256(uint160(pool)));
        if (entryPoint.createCustomPool(address(this), msg.sender, coin, wNative, "") != pool) revert UnexpectedPool();
        (,,,,,,,, uint160 sqrtStart) = plugin.pools(pool);
        IAlgebraPool(pool).initialize(sqrtStart); // plugin.beforeInitialize: sender, price and token order
        entryPoint.setTickSpacing(pool, TICK_SPACING);
        entryPoint.setFee(pool, 0); // the pool's initialize set the factory default (500); must precede the flag
        entryPoint.setPluginConfig(pool, PLUGIN_CONFIG);
    }

    /// @dev O3: A and B minted on the pool, owned by this contract (the plugin admits only the launcher, to itself, at
    /// or above tickStart, not straddling tickGrad). The mint callback pays coins only. Then the reserve hand-off and the
    /// rounding dust burn: the coin is brand new, so this contract's balance of it is exactly what is left of SUPPLY.
    function _seed(address coin, address pool, LaunchPlan memory p) private {
        (, uint256 a1A, uint128 lA) = IAlgebraPool(pool).mint(address(this), address(this), p.tickStart, p.tickGrad, p.liqA, "");
        (, uint256 a1B, uint128 lB) = IAlgebraPool(pool).mint(address(this), address(this), p.tickGrad, TICK_MAX, p.liqB, "");
        _tstore(T_ACTIVE_POOL, 0);
        if (lA != p.liqA || lB != p.liqB || a1A != 0 || a1B != 0) revert MintMismatch();
        IERC20(coin).safeTransfer(address(reserveLock), CREATOR_RESERVE);
        reserveLock.lock(coin, CREATOR_RESERVE);
        uint256 dust = IERC20(coin).balanceOf(address(this));
        if (dust > 0) IERC20(coin).safeTransfer(DEAD, dust);
    }

    /// @dev O2: the creator first buy, the launcher's only swap besides the conversion (t4). Exact input of all of
    /// msg.value as WDOGE, price limit = the graduation price (it can never cross into B). A partial fill would mean the
    /// buy reached the limit, i.e. more than 70% of supply: it reverts, so no WDOGE stays here. The plugin charges it
    /// the bonding rate (launcher swap, conversion flag clear) and lets it run before openAt.
    function _firstBuy(address pool, uint256 amountIn, int24 tickGrad) private returns (uint256 out) {
        IWNativeToken(wNative).deposit{value: amountIn}();
        _tstore(T_ACTIVE_POOL, uint256(uint160(pool)));
        (int256 a0, int256 a1) =
            IAlgebraPool(pool).swap(msg.sender, false, amountIn.toInt256(), TickMath.getSqrtPriceAtTick(tickGrad), "");
        _tstore(T_ACTIVE_POOL, 0);
        if (a1 != amountIn.toInt256()) revert FirstBuyTooLarge(); // stopped at the limit: more than A could sell
        out = a0 < 0 ? uint256(-a0) : 0;
        if (out > FIRST_BUY_MAX) revert FirstBuyTooLarge();
    }

    // ================================================================== plugin factory hooks (through the entry point)

    /// @notice The entry point forwards the factory's plugin request for a pool whose deployer is this contract. Only
    /// the pool this launcher is creating right now gets the plugin; anything else reverts (and so does the creation).
    function beforeCreatePoolHook(address pool, address, address deployer, address, address, bytes calldata)
        external
        view
        returns (address)
    {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        if (deployer != address(this) || pool == address(0) || pool != address(uint160(_tload(T_ACTIVE_POOL)))) revert UnexpectedPool();
        return address(plugin);
    }

    function afterCreatePoolHook(address, address, address) external view {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
    }

    // ================================================================== pool callbacks

    /// @dev Only the pool this launcher is minting into right now (inside `launch`); coins only (A and B are above or at
    /// the price, so they owe no WDOGE).
    function algebraMintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (msg.sender != address(uint160(_tload(T_ACTIVE_POOL))) || msg.sender == address(0) || amount1Owed != 0) revert BadCallback();
        if (amount0Owed > 0) IERC20(coinOf[msg.sender]).safeTransfer(msg.sender, amount0Owed);
    }

    /// @dev Only the pool this launcher is swapping on right now (the first buy inside `launch`; t4: the conversion
    /// inside `convert`). Pays what the pool is owed: token0 = the coin, token1 = WDOGE.
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(uint160(_tload(T_ACTIVE_POOL))) || msg.sender == address(0)) revert BadCallback();
        if (amount0Delta > 0) IERC20(coinOf[msg.sender]).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(wNative).safeTransfer(msg.sender, uint256(amount1Delta));
    }

    /// @notice IMwzBarkLauncher: true only around the conversion swap on `pool` (t4 sets and clears the flag). Plain
    /// view, no guard, never reverts.
    function conversionInProgress(address pool) external view returns (bool) {
        return _tload(_conversionSlot(pool)) != 0;
    }

    // ================================================================== graduation fee (I6)

    /// @notice The one-time graduation fee: burns floor(liqA x 2%) from A and keeps exactly the burned WDOGE, unwrapped.
    /// The plugin calls it inline from the latching swap's afterSwap (pool unlocked there); anyone may call it later as
    /// the fallback. Both paths pass the same guards: a known pool whose plugin is still ours (a swapped-in plugin could
    /// tax the burn), the pool not mid-swap, the plugin's latch set, the price at or past the graduation price (A then
    /// holds WDOGE only and the burn returns WDOGE only, a fixed amount whatever the price beyond), and not taken before.
    /// nonReentrant; CEI: checks, the once-flag, then burn / collect / unwrap, then the record and the event.
    function takeGraduationFee(address pool) external nonReentrant {
        address coin = coinOf[pool];
        if (coin == address(0)) revert UnknownPool();
        Launch storage l = launches[coin];
        if (l.gradFeeTaken) revert GraduationFeeAlreadyTaken();
        if (IAlgebraPool(pool).plugin() != address(plugin)) revert ForeignPlugin();
        (uint160 price,,,,, bool unlocked) = IAlgebraPool(pool).globalState();
        if (!unlocked) revert PoolBusy();
        (uint160 sqrtGrad,, bool graduated,,,,,,) = plugin.pools(pool);
        if (!graduated) revert NotGraduated();
        if (price < sqrtGrad) revert PriceBelowGraduation();
        l.gradFeeTaken = true;

        int24 tickStart = l.tickStart;
        int24 tickGrad = l.tickGrad;
        uint128 liq = uint128((uint256(l.liqA) * GRAD_FEE_BPS) / BPS);
        (uint256 a0, uint256 a1) = IAlgebraPool(pool).burn(tickStart, tickGrad, liq, "");
        // At a price at or past sqrtGrad (tick >= tickGrad = A's top) A is WDOGE only: unreachable by construction.
        if (a0 != 0) revert GraduationBurnNotNative();
        // Collect exactly the burned principal. A's accrued fees (WDOGE and coin) stay owed to the position for collect (t4).
        (uint128 c0, uint128 c1) = IAlgebraPool(pool).collect(address(this), tickStart, tickGrad, 0, a1.toUint128());
        if (c0 != 0 || c1 != a1) revert CollectMismatch();
        if (a1 > 0) IWNativeToken(wNative).withdraw(a1);
        _bookGraduationFee(l, a1);
        emit GraduationFeeTaken(coin, pool, a1, liq, msg.sender == address(plugin));
    }

    /// @dev t4 extends this: credits the router bucket's graduation book (creator 0%). Until then the record only.
    function _bookGraduationFee(Launch storage l, uint256 amount) private {
        l.graduationFee = amount;
    }

    /// @dev Native arrives only from unwrapping WDOGE (WETH9-style withdraw forwards 2,300 gas: this stays cheap).
    receive() external payable {
        if (msg.sender != wNative) revert NotWNative();
    }

    // ================================================================== restore

    /// @notice Permissionless: re-applies our launch settings to `coin`'s pool if a Barkswap admin changed them: our
    /// plugin (setPlugin also resets the config to 0), lastFee 0 (only possible while the dynamic-fee flag is off, so
    /// the flag is cleared first if needed) and config 135, in that order (O4). Takes no argument but the coin, so it
    /// can set nothing else. nonReentrant; refuses a pool that is mid-swap; reverts `NothingToRestore` if all three
    /// already hold. The tick spacing and community fee are not ours to set and are left alone.
    function restore(address coin) external nonReentrant {
        address pool = launches[coin].pool;
        if (pool == address(0)) revert UnknownCoin();
        (,,,,, bool unlocked) = IAlgebraPool(pool).globalState();
        if (!unlocked) revert PoolBusy();
        bool pluginReset;
        if (IAlgebraPool(pool).plugin() != address(plugin)) {
            entryPoint.setPlugin(pool, address(plugin));
            pluginReset = true;
        }
        (,, uint16 lastFee, uint8 config,,) = IAlgebraPool(pool).globalState();
        bool feeReset = lastFee != 0;
        if (feeReset) {
            if (config & DYNAMIC_FEE_FLAG != 0) {
                entryPoint.setPluginConfig(pool, 0);
                config = 0;
            }
            entryPoint.setFee(pool, 0);
        }
        bool configReset = config != PLUGIN_CONFIG;
        if (configReset) entryPoint.setPluginConfig(pool, PLUGIN_CONFIG);
        if (!pluginReset && !feeReset && !configReset) revert NothingToRestore();
        emit Restored(coin, pool, pluginReset, feeReset, configReset);
    }

    // ================================================================== internals

    function _coinSalt(address creator, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function _conversionSlot(address pool) internal pure returns (bytes32) {
        return keccak256(abi.encode(T_CONVERSION, pool));
    }

    function _tstore(bytes32 slot, uint256 v) internal {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _tload(bytes32 slot) internal view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }
}
