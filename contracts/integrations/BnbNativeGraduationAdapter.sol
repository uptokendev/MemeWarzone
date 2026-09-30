// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IGraduationAdapterV2} from "../interfaces/IGraduationAdapterV2.sol";
import {TopazPoolRepair} from "./lib/TopazPoolRepair.sol";

interface IBnbNativeWbnb {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IBnbNativeCampaignFactory {
    function isCampaign(address campaign) external view returns (bool);
}

interface IBnbNativeCampaignToken {
    function token() external view returns (address);
}

/// @notice BNB native graduation (MEME/WBNB, Topaz V2 volatile, permanently locked).
/// Implements IGraduationAdapterV2 exactly. Spec: docs/evm-launch/spec/C7-bnb-adapters.md sections 4-6.
/// Replaces the campaign's router.addLiquidityETH path, which reverted on a pre-made pool a griefer
/// had created, donated 1 wei of WBNB into, and synced.
///
/// Flow of `graduate` (msg.sender = a registered campaign, trading just enabled in the same call):
/// 1. wrap msg.value into WBNB;
/// 2. find or create the volatile MEME/WBNB Topaz pool;
/// 3. pull `m` MEME from the campaign straight into the pool and transfer all WBNB into it;
/// 4. mint LP to the locker. A pre-made pool with donated WBNB is absorbed; the price opens at or
///    above the curve target, never below.
///
/// AUDIT (money path `graduate`):
/// - Reentrancy: `nonReentrant`. `Pool.mint` is `nonReentrant` on Topaz. External calls between the
///   balance read and `mint` are LaunchToken (no hooks), WBNB (WETH9, no hooks) and the pool.
/// - CEI: no per-graduation storage. Wrap, then the library (transfers + mint), then refund any
///   leftover WBNB unwrapped to msg.sender, then assert this contract's WBNB and MEME balances equal
///   the entry snapshot (`ConservationBroken`).
/// - Reachable states: only `campaignFactory.isCampaign(msg.sender)` after `setCampaignFactoryOnce`,
///   and only for that campaign's token. Pool absent; present empty; unsynced WBNB donation; synced
///   WBNB donation. `totalSupply > 0` or more MEME in the pool than the target (`T <= bm`) reverts
///   `PoolAlreadyInitialized` (unreachable under I1).
/// - Overflow: `mulDiv` for T and the price; first-mint `sqrt` is Topaz's. `pairedAmount` is msg.value
///   (BNB raise after the 2.2/19.8 split, ~1e20).
/// - Griefing: a pre-made pool is absorbed. Synced or unsynced WBNB becomes locked LP. A front-run
///   `skim` only reduces the donation. Swaps before our mint revert (a zero reserve fails Topaz's
///   `amountOut >= reserve`). Our mint is one call, so it cannot be sandwiched. This adapter has no
///   admin path over funds.
contract BnbNativeGraduationAdapter is IGraduationAdapterV2, ReentrancyGuard {
    address public immutable admin;
    address public immutable topazFactory;
    address public immutable WBNB;
    address public immutable permanentLpLocker;

    address public campaignFactory;
    bool public campaignFactoryLocked;

    event CampaignFactoryLocked(address indexed campaignFactory);
    event NativeGraduationExecuted(
        address indexed campaign,
        address indexed token,
        address indexed pool,
        uint256 liquidity,
        uint256 memeUsed,
        uint256 pairedUsed,
        uint256 donationFound,
        uint256 startPriceWad,
        bool repaired
    );

    error OnlyAdmin();
    error ZeroAddress();
    error ContractCodeMissing();
    error FactoryAlreadyLocked();
    error CampaignFactoryMissing();
    error UnauthorizedCampaign();
    error TokenMismatch();
    error InvalidPair();
    error InvalidRequest();
    error DeadlineExpired();
    error ZeroLiquidity();
    error ConservationBroken();
    error NativeTransferFailed();
    error PoolAlreadyInitialized();
    error PairedDepositMismatch();
    error PriceBelowTarget();
    error ReservesDesynced();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    constructor(address topazFactory_, address wbnb_, address permanentLpLocker_) {
        if (topazFactory_ == address(0) || wbnb_ == address(0) || permanentLpLocker_ == address(0)) revert ZeroAddress();
        if (topazFactory_.code.length == 0 || wbnb_.code.length == 0 || permanentLpLocker_.code.length == 0) {
            revert ContractCodeMissing();
        }
        admin = msg.sender;
        topazFactory = topazFactory_;
        WBNB = wbnb_;
        permanentLpLocker = permanentLpLocker_;
    }

    receive() external payable {
        if (msg.sender != WBNB) revert InvalidPair();
    }

    /// @notice Binds the campaign factory once. `graduate` refuses every caller until this lands.
    function setCampaignFactoryOnce(address campaignFactory_) external onlyAdmin {
        if (campaignFactoryLocked) revert FactoryAlreadyLocked();
        if (campaignFactory_ == address(0)) revert ZeroAddress();
        if (campaignFactory_.code.length == 0) revert ContractCodeMissing();
        campaignFactory = campaignFactory_;
        campaignFactoryLocked = true;
        emit CampaignFactoryLocked(campaignFactory_);
    }

    /// @notice IGraduationAdapterV2.graduate for the native (WBNB) pool. `r.quoteToken` must be 0.
    function graduate(Request calldata r) external payable override nonReentrant returns (Result memory res) {
        _checkCaller(r);
        if (r.quoteToken != address(0) || r.token == WBNB) revert InvalidPair();
        if (msg.value == 0) revert ZeroLiquidity();

        uint256 wbnbBefore = IERC20(WBNB).balanceOf(address(this));
        uint256 memeBefore = IERC20(r.token).balanceOf(address(this));

        IBnbNativeWbnb(WBNB).deposit{value: msg.value}();

        TopazPoolRepair.Outcome memory out = TopazPoolRepair.repairAndMint(
            TopazPoolRepair.Params({
                factory: topazFactory,
                meme: r.token,
                paired: WBNB,
                pairedAmount: msg.value,
                memeTarget: r.memeTarget,
                memeMax: r.memeMax,
                memePayer: msg.sender,
                locker: permanentLpLocker
            })
        );

        uint256 leftover = IERC20(WBNB).balanceOf(address(this)) - wbnbBefore;
        if (leftover != 0) {
            IBnbNativeWbnb(WBNB).withdraw(leftover);
            (bool ok,) = payable(msg.sender).call{value: leftover}("");
            if (!ok) revert NativeTransferFailed();
        }

        if (IERC20(WBNB).balanceOf(address(this)) != wbnbBefore || IERC20(r.token).balanceOf(address(this)) != memeBefore) {
            revert ConservationBroken();
        }

        res = Result({
            pool: out.pool,
            positionId: 0,
            liquidity: out.liquidity,
            memeUsed: out.memeUsed,
            pairedUsed: msg.value,
            donationFound: out.donationFound,
            startPriceWad: out.startPriceWad,
            repaired: out.repaired,
            repairMemeSold: 0,
            repairProceeds: 0
        });
        emit NativeGraduationExecuted(
            msg.sender,
            r.token,
            out.pool,
            out.liquidity,
            out.memeUsed,
            msg.value,
            out.donationFound,
            out.startPriceWad,
            out.repaired
        );
    }

    function _checkCaller(Request calldata r) private view {
        address factory_ = campaignFactory;
        if (!campaignFactoryLocked || factory_ == address(0)) revert CampaignFactoryMissing();
        if (!IBnbNativeCampaignFactory(factory_).isCampaign(msg.sender)) revert UnauthorizedCampaign();
        if (r.token == address(0) || IBnbNativeCampaignToken(msg.sender).token() != r.token) revert TokenMismatch();
        if (block.timestamp > r.deadline) revert DeadlineExpired();
        if (r.memeTarget == 0 || r.memeMax < r.memeTarget || r.curvePriceWad == 0) revert InvalidRequest();
    }
}
