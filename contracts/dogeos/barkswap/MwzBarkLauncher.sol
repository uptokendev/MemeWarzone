// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
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
import {MwzBarkLaunchLib, IMwzBarkOracle} from "./libraries/MwzBarkLaunchLib.sol";
import {MwzBarkFeeBooks} from "./libraries/MwzBarkFeeBooks.sol";
import {MwzFeeMath} from "../../gen8/libraries/MwzFeeMath.sol";

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

/// @title MwzBarkLauncher (EVM generation 8 on Barkswap, DogeOS)
/// @notice The Barkswap custom-pool deployer and plugin factory of every MemeWarzone coin on DogeOS: gen-8's
/// MwzV4Launcher on Algebra Integral 1.2.1, plus the money side of gen-8's MwzLaunchHook. Spec:
/// docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md sections 2-3 (launcher row, B9, Money flow, B10, B11);
/// audit: docs/dogeos/barkswap-audit.md (MwzBarkLauncher).
///
/// `launch`, one transaction: signed create (gen-8 D3, with openAt), curve sized on chain from the GraduationOracle
/// (gen-7 curveForMarketCap; oracle band and age, F6), coin CREATE2 with a salt chosen by the create signer so the coin
/// sorts below WDOGE (token0), `plugin.registerPool`, `EP.createCustomPool` (this contract is the deployer and the
/// plugin factory: `beforeCreatePoolHook` returns the shared plugin), `pool.initialize` at the plugin's start price,
/// tick spacing 10, `EP.setFee(pool, 0)` before the dynamic-fee flag (config 135), positions A (850M) and B (130M)
/// minted one-sided on the pool, owned by this contract, 20M to the reserve lock, rounding dust burned, then the optional
/// creator first buy (bonding rate, at most 70% of supply). EIP-170 split: the coin deployment, the curve planning and
/// the pool calls of restore / the graduation burn / collect live in the linked library MwzBarkLaunchLib (DELEGATECALL,
/// so the coin's CREATE2 deployer, the pool's caller and the positions' owner are still this contract); the pure book
/// arithmetic lives in the linked library MwzBarkFeeBooks.
///
/// Money side (LP-fee mode, B4/B5): every fee accrues to this contract's A/B positions of the coin's own pool.
/// - `collect(coin)` (permissionless) takes the accrued fees, never principal, and books exactly what it received,
///   steered by the plugin's per-phase totals since the last collect: WDOGE is unwrapped and credited at once (creator
///   amount to `creatorOwed[coin]`, the router remainder to the router bucket's bonding or post book); coins wait in the
///   coin's four pending coin books.
/// - `convert(coin)` (permissionless) sells the pending coins in the coin's pool at 0 fee: always min(pending, the most
///   a 1% price impact allows), never below the start price (F2), at most once per 10 minutes per coin, never inside the
///   60 s launch window; the same fraction from every pending book, the DOGE back to those books pro rata.
/// - Router bucket (gen-8 F3/F4): `claimRouter` by the router, its operator or the owner; `routerPaid(router)` holds the
///   post-conversion net books (amount, bonding, graduation; B11); a router change behind 48 h parks the bucket for the
///   old router (`payParkedRouter`). The one-time graduation fee goes to the graduation book (creator 0%).
/// - Creator: `claimCreator(coin, to)` by the coin's `feeCreator`, two-step `proposeCreator` / `acceptCreator`.
///
/// After launch this contract makes exactly these calls into a pool or the entry point: `restore(coin)` (our plugin,
/// lastFee 0, config 135, nothing else), the one graduation-fee burn plus the collect of exactly its principal,
/// `collect`'s zero-amount burns and fee collects, and `convert`'s sell. Nothing removes liquidity except the one
/// graduation burn (I6); there is no withdraw.
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
    error NotWNative();
    error NothingToCollect();
    error NothingToConvert();
    error ConversionInLaunchWindow();
    error ConversionTooSoon();
    error ConversionFeeNotZero();
    error NotCreator();
    error NotPendingCreator();
    error NothingOwed();
    error SendFailed();
    error NotRouterCaller();
    error NoPendingRouter();
    error TimelockActive();

    // ------------------------------------------------------------------ supply split (spec section 2)
    uint256 public constant SUPPLY = MwzBarkLaunchLib.SUPPLY;
    uint256 public constant COINS_A = MwzBarkLaunchLib.COINS_A; // bonding range [tickStart, tickGrad]
    uint256 public constant COINS_B = MwzBarkLaunchLib.COINS_B; // above graduation [tickGrad, TICK_MAX]
    uint256 public constant CREATOR_RESERVE = 20_000_000 * 1e18; // to the reserve lock (D6)
    uint256 public constant FIRST_BUY_MAX = 700_000_000 * 1e18; // gen-7 rule: 70% of supply

    // ------------------------------------------------------------------ graduation targets (gen-8 L2, USD 18 decimals)
    uint256 public constant FAST_GRADUATION_USD = 30_000 ether;
    uint256 public constant DEFAULT_GRADUATION_USD = 50_000 ether;
    uint256 public constant TEST_GRADUATION_USD = 150 ether;
    uint256 public constant DOGEOS_TESTNET_CHAIN_ID = 6_281_971;

    uint256 public constant MAX_AUTH_TTL = 1 days; // gen-7 audit 5
    uint256 public constant MAX_OPEN_DELAY = 30 days; // gen-8 B; the plugin enforces the same bound
    /// @dev Upper bound on the constructor's `maxOracleAge_` input (not the oracle's own age); DogeOS passes 3600 s.
    uint256 public constant MAX_ORACLE_AGE_INPUT = 2 days;

    // ------------------------------------------------------------------ pool shape
    int24 public constant TICK_SPACING = MwzBarkLaunchLib.TICK_SPACING;
    /// @dev TickMath.maxUsableTick(10): B's top tick (B holds coins for every price above graduation).
    int24 public constant TICK_MAX = MwzBarkLaunchLib.TICK_MAX;
    uint8 public constant PLUGIN_CONFIG = MwzBarkLaunchLib.PLUGIN_CONFIG; // 135 == MwzBarkPlugin.PLUGIN_CONFIG (constructor)
    uint256 public constant GRAD_FEE_BPS = 200; // one-time: floor(liqA x 2%) from A (I6)
    uint256 internal constant BPS = 10_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------------ money side (deploy-time constants, audit "convert")
    /// @notice A conversion moves the pool price down by at most 1% per call (sqrt factor ceil(sqrt(0.99) x 1e9)).
    uint256 public constant CONVERT_IMPACT_BPS = 100;
    uint256 internal constant CONVERT_SQRT_FACTOR_E9 = 994_987_438;
    /// @notice Minimum time between two conversions of the same coin.
    uint256 public constant CONVERT_INTERVAL = 10 minutes;
    uint256 public constant ROUTER_TIMELOCK = 48 hours; // gen-8 A4
    uint256 internal constant OPERATOR_READ_GAS = 30_000; // gen-8 F4: gas cap for reading the router's operator()

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
    /// @dev Per pool: non-zero only around the coin-fee conversion swap in `convert`. keccak256(abi.encode(T_CONVERSION,
    /// pool)).
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
    /// slot 1: feeCreator (20) + lastConvertAt (5); slot 2: liqA + liqB; slot 3: graduationFee.
    struct Launch {
        address pool; // 0 = not ours
        uint40 openAt;
        int24 tickStart; // A = [tickStart, tickGrad]
        int24 tickGrad; // B = [tickGrad, TICK_MAX]
        bool gradFeeTaken; // I6: the one graduation burn ran
        address feeCreator; // receives the creator amount: the creator, or the choice vault for holders/split/buyback
        uint40 lastConvertAt; // block time of the coin's last conversion (0 = never)
        uint128 liqA;
        uint128 liqB;
        uint256 graduationFee; // native taken by the graduation burn (0 before), credited to the graduation book
    }

    /// @notice A coin's collected sell fees, in coins, waiting for `convert`: per phase, the creator amount and the
    /// router remainder (MwzBarkFeeBooks order). Their sum equals this contract's balance of the coin (books ==
    /// balances; coins sent here directly are not booked and stay inert).
    struct CoinBooks {
        uint128 creatorBonding;
        uint128 routerBonding;
        uint128 creatorPost;
        uint128 routerPost;
    }

    /// @notice Cumulative native paid to (or parked for) one router address (gen-8 RouterPaid). B11: `bondingFees` is
    /// the NET bonding DOGE credited to the router bucket (after Barkswap's cut, the creator's amount and coin
    /// conversion), `gradFees` the graduation fees; the rest of `amount` is the router's post-graduation DOGE, plus
    /// rounding and unbooked surplus (MwzBarkFeeBooks.apportion).
    struct RouterPaid {
        uint256 amount;
        uint256 bondingFees;
        uint256 gradFees;
    }

    mapping(address coin => Launch) public launches;
    mapping(address pool => address coin) public coinOf;

    /// @notice Native owed to each coin's `feeCreator` (collected and converted creator amounts).
    mapping(address coin => uint256) public creatorOwed;
    mapping(address coin => address) public pendingCreator;
    mapping(address coin => CoinBooks) public coinFees;
    /// @dev The plugin's fee totals of the coin's pool at the coin's last collect (collect books the difference).
    mapping(address coin => MwzBarkPlugin.FeeTotals) internal _collectedTotals;

    /// @notice Router bucket (native wei) not yet paid out, and the net bonding / graduation DOGE inside it (B11).
    /// uint128: DogeOS's whole native supply is far below 2^128 wei.
    uint128 public routerOwed;
    uint128 public pendingBondingFees;
    uint256 public pendingGradFees;
    mapping(address router => RouterPaid) public routerPaid;
    /// @notice F3: buckets accrued under a previous router, owed to that router only (payParkedRouter).
    mapping(address router => RouterPaid) public routerParked;
    uint256 public parkedOwed; // sum of routerParked[*].amount
    address public treasuryRouter; // MwzBarkFeeSplitter (t5)
    address public pendingRouter;
    uint256 public routerEta;

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
    /// WDOGE) received and credited to the router bucket's graduation book; `inlineCall` when the plugin's latching swap
    /// triggered it.
    event GraduationFeeTaken(address indexed coin, address indexed pool, uint256 amount, uint128 liquidity, bool inlineCall);
    /// @notice `restore` re-applied our launch settings after a Barkswap admin change.
    event Restored(address indexed coin, address indexed pool, bool pluginReset, bool feeReset, bool configReset);
    /// @notice One collect: `native` WDOGE received (unwrapped) and `coins` received, and how each was booked, in
    /// MwzBarkFeeBooks order [creator bonding, router bonding, creator post, router post]. `nativeBooks` are credited
    /// now (creator amounts to creatorOwed, router amounts to the bucket); `coinBooks` are added to the pending coin
    /// books for `convert`.
    event FeesCollected(address indexed coin, uint256 native, uint256 coins, uint256[4] nativeBooks, uint256[4] coinBooks);
    /// @notice One conversion: `coinsIn` of the `pending` coins (the four books' sum before the call) sold for
    /// `nativeOut` at 0 fee; `coins` drawn from and `native` credited to each pending book (same order), the same
    /// fraction coinsIn / pending from every book (D1: every pending sell row converts by that fraction at the average
    /// price nativeOut / coinsIn).
    event CoinFeesConverted(
        address indexed coin, uint256 pending, uint256 coinsIn, uint256 nativeOut, uint256[4] coins, uint256[4] native
    );
    event CreatorClaimed(address indexed coin, address indexed to, uint256 amount);
    event CreatorProposed(address indexed coin, address indexed current, address indexed proposed);
    event CreatorTransferred(address indexed coin, address indexed previous, address indexed next);
    event RouterClaimed(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees);
    event RouterParked(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees);
    event RouterProposed(address indexed router, uint256 eta);
    event RouterChanged(address indexed previous, address indexed next);
    event RouterProposalCancelled(address indexed router);
    event CreatePauseUpdated(bool paused);
    event CreateSignerUpdated(address indexed previous, address indexed next);
    event OwnershipTransferStarted(address indexed current, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Deploy order: plugin, reserve lock, choice vault and fee splitter are deployed first against this
    /// contract's predicted address; this constructor checks the first three point back here.
    constructor(
        IAlgebraCustomPoolEntryPoint entryPoint_,
        address wNative_,
        MwzBarkPlugin plugin_,
        IMwzBarkOracle oracle_,
        IMwzBarkReserveLockForLauncher reserveLock_,
        IMwzBarkChoiceVaultForLauncher choiceVault_,
        address owner_,
        address createSigner_,
        address treasuryRouter_,
        uint256 minNativeUsd_,
        uint256 maxNativeUsd_,
        uint256 maxOracleAge_
    ) {
        if (
            address(entryPoint_) == address(0) || wNative_ == address(0) || address(plugin_) == address(0)
                || address(oracle_) == address(0) || address(reserveLock_) == address(0) || address(choiceVault_) == address(0)
                || owner_ == address(0) || treasuryRouter_ == address(0)
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
            minNativeUsd_ == 0 || maxNativeUsd_ <= minNativeUsd_ || maxOracleAge_ == 0 || maxOracleAge_ > MAX_ORACLE_AGE_INPUT
                || age == 0 || age > maxOracleAge_
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
        treasuryRouter = treasuryRouter_;
        emit OwnershipTransferred(address(0), owner_);
        emit CreateSignerUpdated(address(0), createSigner_);
        emit RouterChanged(address(0), treasuryRouter_);
        emit CreatePauseUpdated(true);
    }

    // ================================================================== admin (launches and the router destination)

    /// @notice gen-8 L5: pauses or opens launches. Never affects trading, restore, the graduation fee, collect, convert
    /// or claims.
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

    /// @notice gen-8 A4: the owner can only redirect where the router bucket is paid, behind a 48 h timelock. It can
    /// never change books, creators, creator balances, fees or liquidity.
    function proposeTreasuryRouter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingRouter = next;
        uint256 eta = block.timestamp + ROUTER_TIMELOCK;
        routerEta = eta;
        emit RouterProposed(next, eta);
    }

    function cancelTreasuryRouter() external onlyOwner {
        address p = pendingRouter;
        if (p == address(0)) revert NoPendingRouter();
        pendingRouter = address(0);
        routerEta = 0;
        emit RouterProposalCancelled(p);
    }

    /// @notice gen-8 A4 / F3: the bucket accrued under the old router is parked for the old router (paid to it by anyone
    /// through payParkedRouter), so a redirect never takes fees earned before it. No external call: the change cannot
    /// fail or be steered by the old router.
    function executeTreasuryRouter() external onlyOwner {
        address p = pendingRouter;
        if (p == address(0)) revert NoPendingRouter();
        if (block.timestamp < routerEta) revert TimelockActive();
        address old = treasuryRouter;
        uint256 amount = routerOwed;
        if (amount != 0) {
            uint256 bonding = pendingBondingFees;
            uint256 grad = pendingGradFees;
            routerOwed = 0;
            pendingBondingFees = 0;
            pendingGradFees = 0;
            RouterPaid storage k = routerParked[old];
            k.amount += amount;
            k.bondingFees += bonding;
            k.gradFees += grad;
            parkedOwed += amount;
            emit RouterParked(old, amount, bonding, grad);
        }
        treasuryRouter = p;
        pendingRouter = address(0);
        routerEta = 0;
        emit RouterChanged(old, p);
    }

    // ================================================================== views

    function isGraduationTargetAllowed(uint256 target) public view returns (bool) {
        if (target == FAST_GRADUATION_USD || target == DEFAULT_GRADUATION_USD) return true;
        // testnets: DogeOS Chikyu 6281971 (also the fork's chain id); local hardhat 31337
        return target == TEST_GRADUATION_USD && (block.chainid == DOGEOS_TESTNET_CHAIN_ID || block.chainid == 31337);
    }

    /// @notice The launch plan for a target at the oracle price now (MwzBarkLaunchLib.planLaunch: oracle band and age,
    /// gen-7 curve, spacing-10 ticks, liquidity of A and B). The pure helpers (curveForMarketCap, curveSqrtPrices,
    /// nearestGridTick) are public on the library itself.
    function plan(uint256 targetUsd) external view returns (MwzBarkLaunchLib.LaunchPlan memory) {
        return MwzBarkLaunchLib.planLaunch(oracle, minNativeUsd, maxNativeUsd, targetUsd);
    }

    /// @notice The plugin's fee totals of the coin's pool at the coin's last collect: plugin.feeTotals(pool) minus this
    /// is what the next collect will book (within Algebra's rounding).
    function collectedTotals(address coin) external view returns (MwzBarkPlugin.FeeTotals memory) {
        return _collectedTotals[coin];
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
    /// the first buy, then the events. Every external call goes to our own contracts and linked library, Barkswap's
    /// entry point / factory / new pool, or WDOGE.
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

        MwzBarkLaunchLib.LaunchPlan memory p = MwzBarkLaunchLib.planLaunch(oracle, minNativeUsd, maxNativeUsd, req.targetUsd);

        // DELEGATECALL: the CREATE2 deployer and the coin's initial holder are this contract
        coin = MwzBarkLaunchLib.deployCoin(req.name, req.symbol, msg.sender, req.salt);
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
            lastConvertAt: 0,
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

    /// @dev O1 + O4: register in the plugin before the pool exists, create it through the entry point (this contract is
    /// the deployer; `beforeCreatePoolHook` returns the plugin only for this pool), initialize at the plugin's stored
    /// start price, tick spacing 10, lastFee 0 while the dynamic-fee flag is still off, then config 135.
    /// The tick spacing is set only if the factory default differs: Algebra's `setTickSpacing` reverts
    /// `invalidNewTickSpacing` on an unchanged value, so an unconditional call would stop every launch the day
    /// Barkswap's default becomes 10 (audit gate 0, L-1). `setFee` and `setPluginConfig` have no such check.
    function _createPool(address coin, address pool, MwzBarkLaunchLib.LaunchPlan memory p, uint40 openAt) private {
        plugin.registerPool(pool, coin, p.tickStart, p.tickGrad, openAt);
        _tstore(T_ACTIVE_POOL, uint256(uint160(pool)));
        if (entryPoint.createCustomPool(address(this), msg.sender, coin, wNative, "") != pool) revert UnexpectedPool();
        (,,,,,,,, uint160 sqrtStart) = plugin.pools(pool);
        IAlgebraPool(pool).initialize(sqrtStart); // plugin.beforeInitialize: sender, price and token order
        if (IAlgebraPool(pool).tickSpacing() != TICK_SPACING) entryPoint.setTickSpacing(pool, TICK_SPACING);
        entryPoint.setFee(pool, 0); // the pool's initialize set the factory default (500); must precede the flag
        entryPoint.setPluginConfig(pool, PLUGIN_CONFIG);
    }

    /// @dev O3: A and B minted on the pool, owned by this contract (the plugin admits only the launcher, to itself, at
    /// or above tickStart, not straddling tickGrad). The mint callback pays coins only. Then the reserve hand-off and the
    /// rounding dust burn: the coin is brand new, so this contract's balance of it is exactly what is left of SUPPLY.
    function _seed(address coin, address pool, MwzBarkLaunchLib.LaunchPlan memory p) private {
        (, uint256 a1A, uint128 lA) = IAlgebraPool(pool).mint(address(this), address(this), p.tickStart, p.tickGrad, p.liqA, "");
        (, uint256 a1B, uint128 lB) = IAlgebraPool(pool).mint(address(this), address(this), p.tickGrad, TICK_MAX, p.liqB, "");
        _tstore(T_ACTIVE_POOL, 0);
        if (lA != p.liqA || lB != p.liqB || a1A != 0 || a1B != 0) revert MintMismatch();
        IERC20(coin).safeTransfer(address(reserveLock), CREATOR_RESERVE);
        reserveLock.lock(coin, CREATOR_RESERVE);
        uint256 dust = IERC20(coin).balanceOf(address(this));
        if (dust > 0) IERC20(coin).safeTransfer(DEAD, dust);
    }

    /// @dev O2: the creator first buy, the launcher's only swap besides the conversion. Exact input of all of msg.value
    /// as WDOGE, price limit = the graduation price (it can never cross into B). A partial fill would mean the buy
    /// reached the limit, i.e. more than 70% of supply: it reverts, so no WDOGE stays here. The plugin charges it the
    /// bonding rate (launcher swap, conversion flag clear) and lets it run before openAt.
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
    /// the price, so they owe no WDOGE). msg.sender is never address(0), so a cleared slot (0) never matches.
    function algebraMintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (msg.sender != address(uint160(_tload(T_ACTIVE_POOL))) || amount1Owed != 0) revert BadCallback();
        if (amount0Owed > 0) IERC20(coinOf[msg.sender]).safeTransfer(msg.sender, amount0Owed);
    }

    /// @dev Only the pool this launcher is swapping on right now (the first buy inside `launch`, the conversion inside
    /// `convert`). Pays what the pool is owed: token0 = the coin, token1 = WDOGE.
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(uint160(_tload(T_ACTIVE_POOL)))) revert BadCallback();
        if (amount0Delta > 0) IERC20(coinOf[msg.sender]).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(wNative).safeTransfer(msg.sender, uint256(amount1Delta));
    }

    /// @notice IMwzBarkLauncher: true only around the conversion swap on `pool` (set and cleared in `convert`). Plain
    /// view, no guard, never reverts.
    function conversionInProgress(address pool) external view returns (bool) {
        return _tload(_conversionSlot(pool)) != 0;
    }

    // ================================================================== graduation fee (I6)

    /// @notice The one-time graduation fee: burns floor(liqA x 2%) from A and keeps exactly the burned WDOGE, unwrapped,
    /// in the router bucket's graduation book (creator 0%). The plugin calls it inline from the latching swap's
    /// afterSwap (pool unlocked there); anyone may call it later as the fallback. Both paths pass the same guards: a
    /// known pool whose plugin is still ours (a swapped-in plugin could tax the burn), the pool not mid-swap, the
    /// plugin's latch set, the price at or past the graduation price (A then holds WDOGE only and the burn returns WDOGE
    /// only, a fixed amount whatever the price beyond), and not taken before.
    /// nonReentrant; CEI: checks, the once-flag, then burn / collect / unwrap (MwzBarkLaunchLib.graduationBurn,
    /// DELEGATECALL), then the books and the event.
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
        // burn from A, collect exactly the burned principal (WDOGE only), unwrap; A's accrued fees stay for collect
        uint256 a1 = MwzBarkLaunchLib.graduationBurn(pool, tickStart, tickGrad, liq, wNative);
        // The graduation book: the router bucket, creator 0%, net base = the whole burn (a liquidity burn, not a swap
        // fee, so Barkswap's community fee does not cut it; B11).
        l.graduationFee = a1;
        routerOwed = (uint256(routerOwed) + a1).toUint128();
        pendingGradFees += a1;
        emit GraduationFeeTaken(coin, pool, a1, liq, msg.sender == address(plugin));
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
    /// already hold. The tick spacing and community fee are not ours to set and are left alone. The pool and
    /// entry-point calls run in MwzBarkLaunchLib.restorePool (DELEGATECALL, so the entry point sees this contract).
    function restore(address coin) external nonReentrant {
        address pool = launches[coin].pool;
        if (pool == address(0)) revert UnknownCoin();
        (bool pluginReset, bool feeReset, bool configReset) = MwzBarkLaunchLib.restorePool(entryPoint, pool, address(plugin));
        emit Restored(coin, pool, pluginReset, feeReset, configReset);
    }

    // ================================================================== money side: collect and convert

    /// @notice Permissionless (keeper): takes the fees accrued to the coin's positions A and B into this contract's
    /// books. Fees only, never principal: zero-amount burns move the accrued fees into the positions' owed amounts
    /// (and make the pool hand any excess balance to them as fees), then the collects take everything owed; principal
    /// is never owed (the one graduation burn collects exactly its principal in the same call). What arrives is booked
    /// exactly (books == balances), split by the plugin's per-phase totals since the coin's last collect
    /// (MwzBarkFeeBooks.apportion): WDOGE unwrapped and credited now (creator amounts to creatorOwed, router amounts to
    /// the bucket), coins to the pending coin books for `convert`.
    /// @dev nonReentrant. CEI: checks; the plugin's totals read and the new snapshot stored (effects that depend on no
    /// external outcome); interactions with the coin's own pool only (two zero burns, two collects; the pool calls only
    /// our plugin's beforeModifyPosition and transfers our plain coin and WDOGE) and the WDOGE unwrap; then the books,
    /// which depend on the amounts the pool returned, and the event. No third-party code runs inside.
    function collect(address coin) external nonReentrant {
        Launch storage l = launches[coin];
        address pool = l.pool;
        if (pool == address(0)) revert UnknownCoin();
        MwzBarkPlugin.FeeTotals memory t = plugin.feeTotals(pool);
        MwzBarkPlugin.FeeTotals memory s = _collectedTotals[coin];
        // the plugin's totals only grow, so each difference is >= 0 (checked: a decrease would revert, never mis-book)
        uint256[4] memory dN = [
            uint256(t.bondingNative.creator - s.bondingNative.creator),
            t.bondingNative.router - s.bondingNative.router,
            t.postNative.creator - s.postNative.creator,
            t.postNative.router - s.postNative.router
        ];
        uint256[4] memory dC = [
            uint256(t.bondingCoin.creator - s.bondingCoin.creator),
            t.bondingCoin.router - s.bondingCoin.router,
            t.postCoin.creator - s.postCoin.creator,
            t.postCoin.router - s.postCoin.router
        ];
        _collectedTotals[coin] = t;

        // zero burns + collects on A and B, WDOGE unwrapped (MwzBarkLaunchLib.collectFees, in this contract's context)
        (uint256 coins, uint256 native) = MwzBarkLaunchLib.collectFees(pool, l.tickStart, l.tickGrad, wNative);
        if (coins == 0 && native == 0 && dN[0] + dN[1] + dN[2] + dN[3] + dC[0] + dC[1] + dC[2] + dC[3] == 0) {
            revert NothingToCollect();
        }

        uint256[4] memory n = MwzBarkFeeBooks.apportion(native, dN);
        uint256[4] memory c = MwzBarkFeeBooks.apportion(coins, dC);
        _creditNative(coin, n);
        CoinBooks storage k = coinFees[coin];
        k.creatorBonding = (uint256(k.creatorBonding) + c[0]).toUint128();
        k.routerBonding = (uint256(k.routerBonding) + c[1]).toUint128();
        k.creatorPost = (uint256(k.creatorPost) + c[2]).toUint128();
        k.routerPost = (uint256(k.routerPost) + c[3]).toUint128();
        emit FeesCollected(coin, native, coins, n, c);
    }

    /// @notice Permissionless (keeper): sells the coin's pending coin fees for DOGE in the coin's own pool, at 0 fee
    /// (the plugin recognises the conversion by the transient flag and returns overrideFee 0 on lastFee 0). Always the
    /// full capped amount: exact input of everything pending with a price limit of 1% below the current price, or the
    /// start price if that is higher (F2), so the pool sells min(pending, what the cap allows) whoever calls. At most
    /// once per CONVERT_INTERVAL per coin, never inside the 60 s launch window. The coins are drawn pro rata from the
    /// four pending books and the DOGE goes back to them in the same proportions, then is credited like collected
    /// WDOGE (MwzBarkFeeBooks.draw).
    /// @dev nonReentrant. CEI: checks (coin, window, interval, our plugin installed, lastFee 0, pending, a price limit
    /// below the price); effect: the interval stamp; interaction: the swap (the pool calls our plugin's hooks, our swap
    /// callback, which pays the coins owed from the booked balance, and transfers WDOGE here); then the books, which
    /// depend on the filled amount, the unwrap and the event. A revert anywhere leaves every book and the stamp
    /// unchanged.
    function convert(address coin) external nonReentrant returns (uint256 coinsIn, uint256 nativeOut) {
        Launch storage l = launches[coin];
        address pool = l.pool;
        if (pool == address(0)) revert UnknownCoin();
        if (block.timestamp < uint256(l.openAt) + MwzFeeMath.SNIPER_WINDOW) revert ConversionInLaunchWindow();
        if (block.timestamp < uint256(l.lastConvertAt) + CONVERT_INTERVAL) revert ConversionTooSoon();
        CoinBooks storage k = coinFees[coin];
        uint256[4] memory b = [uint256(k.creatorBonding), k.routerBonding, k.creatorPost, k.routerPost];
        uint256 pending = b[0] + b[1] + b[2] + b[3];
        // 0 fee by this contract's own checks, whatever hooks an admin left on: our plugin (it returns overrideFee 0 for
        // a conversion and never a plugin fee; a foreign plugin could tax the sell) and lastFee 0 (what the pool charges
        // when the override is 0 or the before-swap hook is off)
        if (IAlgebraPool(pool).plugin() != address(plugin)) revert ForeignPlugin();
        (uint160 price,, uint16 lastFee,,,) = IAlgebraPool(pool).globalState();
        if (lastFee != 0) revert ConversionFeeNotZero();
        uint160 limit = uint160(FullMath.mulDivRoundingUp(price, CONVERT_SQRT_FACTOR_E9, 1e9));
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(l.tickStart); // == the plugin's sqrtStart (same ticks, same TickMath)
        if (limit < sqrtStart) limit = sqrtStart;
        // nothing pending, or the price is at the start price (no coin can be sold without breaking F2)
        if (pending == 0 || limit >= price) revert NothingToConvert();
        l.lastConvertAt = uint40(block.timestamp);

        bytes32 flag = _conversionSlot(pool);
        _tstore(T_ACTIVE_POOL, uint256(uint160(pool)));
        _tstore(flag, 1);
        (int256 a0, int256 a1) = IAlgebraPool(pool).swap(address(this), true, pending.toInt256(), limit, "");
        _tstore(flag, 0);
        _tstore(T_ACTIVE_POOL, 0);
        coinsIn = a0 > 0 ? uint256(a0) : 0;
        nativeOut = a1 < 0 ? uint256(-a1) : 0;
        if (coinsIn == 0) revert NothingToConvert();

        (uint256[4] memory taken, uint256[4] memory got) = MwzBarkFeeBooks.draw(b, coinsIn, pending, nativeOut);
        k.creatorBonding = uint128(b[0] - taken[0]);
        k.routerBonding = uint128(b[1] - taken[1]);
        k.creatorPost = uint128(b[2] - taken[2]);
        k.routerPost = uint128(b[3] - taken[3]);
        if (nativeOut > 0) IWNativeToken(wNative).withdraw(nativeOut);
        _creditNative(coin, got);
        emit CoinFeesConverted(coin, pending, coinsIn, nativeOut, taken, got);
    }

    /// @dev Credits native amounts in MwzBarkFeeBooks order: both creator amounts to the coin's creatorOwed, both router
    /// amounts to the bucket, the router bonding amount also to the bonding counter (B11 base). Checked additions.
    function _creditNative(address coin, uint256[4] memory n) private {
        uint256 creator = n[0] + n[2];
        if (creator != 0) creatorOwed[coin] += creator;
        uint256 router = n[1] + n[3];
        if (router != 0) {
            routerOwed = (uint256(routerOwed) + router).toUint128();
            pendingBondingFees = (uint256(pendingBondingFees) + n[1]).toUint128();
        }
    }

    // ================================================================== money side: creator

    /// @notice Two-step creator hand-over (gen-8 4.6), step 1, by the coin's current feeCreator. address(0) cancels.
    function proposeCreator(address coin, address next) external {
        address cur = launches[coin].feeCreator;
        if (cur == address(0)) revert UnknownCoin();
        if (msg.sender != cur) revert NotCreator();
        pendingCreator[coin] = next;
        emit CreatorProposed(coin, cur, next);
    }

    /// @notice Step 2, by the proposed address. From then on only it can claim (including what was owed before).
    function acceptCreator(address coin) external {
        if (msg.sender != pendingCreator[coin]) revert NotPendingCreator();
        Launch storage l = launches[coin];
        emit CreatorTransferred(coin, l.feeCreator, msg.sender);
        l.feeCreator = msg.sender;
        pendingCreator[coin] = address(0);
    }

    /// @notice The coin's feeCreator sends the coin's whole native creator balance to any address.
    /// @dev nonReentrant; CEI: checks, the balance zeroed, then the payout as the last call. A recipient that rejects
    /// native reverts the claim and the balance stays (gen-8 A13).
    function claimCreator(address coin, address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != launches[coin].feeCreator) revert NotCreator(); // feeCreator is never 0 for a launched coin
        if (to == address(0)) revert ZeroAddress();
        amount = creatorOwed[coin];
        if (amount == 0) revert NothingOwed();
        creatorOwed[coin] = 0;
        _send(to, amount);
        emit CreatorClaimed(coin, to, amount);
    }

    // ================================================================== money side: router bucket (gen-8 F3 / F4)

    /// @notice Pays the router bucket to the current router. F4: only that router, its operator (its operator(), read
    /// gas-capped; a router without one has none) or the owner, so a third party cannot move routerPaid between the
    /// splitter operator's plan and its route.
    function claimRouter() external nonReentrant returns (uint256 amount) {
        address r = treasuryRouter;
        if (msg.sender != r && msg.sender != owner && msg.sender != _routerOperator(r)) revert NotRouterCaller();
        amount = routerOwed;
        if (amount == 0) revert NothingOwed();
        uint256 bonding = pendingBondingFees;
        uint256 grad = pendingGradFees;
        routerOwed = 0;
        pendingBondingFees = 0;
        pendingGradFees = 0;
        _payRouter(r, amount, bonding, grad);
    }

    /// @notice F3: pays a parked bucket to the router it was accrued under. Anyone may call; the money can only go to
    /// that router. A router that refuses native reverts the call and the bucket stays parked.
    function payParkedRouter(address r) external nonReentrant returns (uint256 amount) {
        RouterPaid storage k = routerParked[r];
        amount = k.amount;
        if (amount == 0) revert NothingOwed();
        uint256 bonding = k.bondingFees;
        uint256 grad = k.gradFees;
        delete routerParked[r];
        parkedOwed -= amount;
        _payRouter(r, amount, bonding, grad);
    }

    /// @dev The router's operator() (MwzBarkFeeSplitter.operator), or address(0) if it has none, reverts, burns the gas
    /// cap or returns short data. Static call: the router cannot change state here.
    function _routerOperator(address r) private view returns (address op) {
        (bool ok, bytes memory ret) = r.staticcall{gas: OPERATOR_READ_GAS}(abi.encodeWithSignature("operator()"));
        if (ok && ret.length >= 32) op = address(uint160(uint256(bytes32(ret))));
    }

    /// @dev Callers hold the lock and have zeroed the source; here the cumulative paid record, then the payout.
    function _payRouter(address r, uint256 amount, uint256 bonding, uint256 grad) private {
        RouterPaid storage p = routerPaid[r];
        p.amount += amount;
        p.bondingFees += bonding;
        p.gradFees += grad;
        _send(r, amount);
        emit RouterClaimed(r, amount, bonding, grad);
    }

    /// @dev Native transfer with all gas and no return-data copy (a return bomb cannot make the caller pay for it).
    function _send(address to, uint256 amount) private {
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
        if (!ok) revert SendFailed();
    }

    // ================================================================== internals

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
