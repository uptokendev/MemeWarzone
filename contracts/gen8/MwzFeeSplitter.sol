// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMwzLaunchHook} from "./interfaces/IMwzLaunchHook.sol";

interface IMwzCommunityRewardsVault {
    function depositAirdrop() external payable;
    function depositSquadPool() external payable;
}

/// @title MwzFeeSplitter (EVM generation 8, D1 option A, design 3.4)
/// @notice The gen-8 TreasuryRouter: receives the hook's router bucket (MwzLaunchHook.claimRouter) and splits it,
/// one run at a time, into the existing reward vaults. Per-trade attribution (recruiter / squad / airdrop by the
/// trader's recruiter link) is computed off chain by the indexer from HookFee events, exactly as Solana DBC does
/// today; this contract bounds what the operator can do with it:
/// - every wei received since the last run is routed in the run (sum == received; nothing left, nothing invented);
/// - league = floor(3750 * B / 10000) exactly, B = the full pre-graduation fees in the run, split 30 / 70 into the
///   weekly league vault and the monthly league treasury;
/// - recruiter + squad + airdrop between 1500 and 1750 bps of B plus between 1750 and 2000 bps of G (graduation
///   fees in the run), squad at most 250 bps of (B + G);
/// - protocol = the remainder (it includes the router part of post-graduation fees, 0.5% of volume, D9);
/// - accrualRoot (Merkle root of the per-trade slice rows) is emitted so anyone can recompute the run.
/// B and G are not operator inputs: the hook records, per payee, the cumulative amount paid and the bonding and
/// graduation fees inside it (MwzLaunchHook.routerPaid), and this contract routes the difference since its last run.
/// Destinations are fixed at deploy. There is no withdraw, no rescue and no other way for value to leave.
/// A stolen operator key can only move value between airdrop and recruiter / squad inside the band, and only to
/// these vaults. If the operator never runs, the funds wait here; the admin (Safe) can run the same bounded route.
contract MwzFeeSplitter is ReentrancyGuard {
    error ZeroAddress();
    error NotOperator();
    error NotAdmin();
    error UnexpectedSender();
    error BadRunId();
    error NothingToRoute();
    error OutOfBand();
    error Underfunded();
    error SendFailed();

    uint256 public constant BPS = 10_000;
    uint256 public constant LEAGUE_BPS = 3_750; // of bonding fees, profile-independent
    uint256 public constant WEEKLY_LEAGUE_BPS = 3_000; // of the league share; the monthly treasury gets the rest
    uint256 public constant TRADE_RSA_MIN_BPS = 1_500; // recruiter + squad + airdrop, of bonding fees
    uint256 public constant TRADE_RSA_MAX_BPS = 1_750;
    uint256 public constant GRAD_RSA_MIN_BPS = 1_750; // recruiter + squad + airdrop, of graduation fees
    uint256 public constant GRAD_RSA_MAX_BPS = 2_000;
    uint256 public constant SQUAD_MAX_BPS = 250; // of bonding + graduation fees

    IMwzLaunchHook public immutable hook;
    IPoolManager public immutable poolManager;
    address public immutable admin;
    address public immutable weeklyLeagueVault;
    address public immutable monthlyLeagueTreasury;
    address public immutable recruiterRewardsVault;
    IMwzCommunityRewardsVault public immutable communityRewardsVault;
    address public immutable protocolRevenueVault;

    address public operator;
    uint256 public runs;
    uint256 public routedAmount;
    uint256 public routedBondingFees;
    uint256 public routedGradFees;

    struct Run {
        uint256 total;
        uint256 bondingFees;
        uint256 gradFees;
        uint256 weeklyLeague;
        uint256 monthlyLeague;
        uint256 recruiter;
        uint256 squad;
        uint256 airdrop;
        uint256 protocol;
    }

    event OperatorUpdated(address indexed previous, address indexed next);
    event Routed(uint256 indexed runId, bytes32 indexed accrualRoot, address indexed caller, Run run);

    constructor(
        IMwzLaunchHook hook_,
        address admin_,
        address weeklyLeagueVault_,
        address monthlyLeagueTreasury_,
        address recruiterRewardsVault_,
        IMwzCommunityRewardsVault communityRewardsVault_,
        address protocolRevenueVault_,
        address operator_
    ) {
        if (
            address(hook_) == address(0) || admin_ == address(0) || weeklyLeagueVault_ == address(0) || monthlyLeagueTreasury_ == address(0)
                || recruiterRewardsVault_ == address(0) || address(communityRewardsVault_) == address(0) || protocolRevenueVault_ == address(0)
        ) revert ZeroAddress();
        hook = hook_;
        poolManager = hook_.poolManager();
        admin = admin_;
        weeklyLeagueVault = weeklyLeagueVault_;
        monthlyLeagueTreasury = monthlyLeagueTreasury_;
        recruiterRewardsVault = recruiterRewardsVault_;
        communityRewardsVault = communityRewardsVault_;
        protocolRevenueVault = protocolRevenueVault_;
        operator = operator_;
        emit OperatorUpdated(address(0), operator_);
    }

    /// @dev Native arrives only from the PoolManager (the hook's router payout is burn claim + take).
    receive() external payable {
        if (msg.sender != address(poolManager)) revert UnexpectedSender();
    }

    /// @notice The admin (Safe) sets or clears the operator key (a Zodiac Roles scoped key, as gen-7).
    function setOperator(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        emit OperatorUpdated(operator, next);
        operator = next;
    }

    /// @notice What the next run must route: received from the hook since the last run, and the bonding and
    /// graduation fees inside it. Includes nothing still owed in the hook (route() claims that first).
    function pending() public view returns (uint256 total, uint256 bondingFees, uint256 gradFees) {
        (uint256 paid, uint256 paidBonding, uint256 paidGrad) = hook.routerPaid(address(this));
        return (paid - routedAmount, paidBonding - routedBondingFees, paidGrad - routedGradFees);
    }

    /// @notice The exact league amounts and the recruiter + squad + airdrop band for a run.
    function bands(uint256 bondingFees, uint256 gradFees)
        public
        pure
        returns (uint256 weekly, uint256 monthly, uint256 rsaMin, uint256 rsaMax, uint256 squadMax)
    {
        uint256 league = (bondingFees * LEAGUE_BPS) / BPS;
        weekly = (league * WEEKLY_LEAGUE_BPS) / BPS;
        monthly = league - weekly;
        rsaMin = (bondingFees * TRADE_RSA_MIN_BPS) / BPS + (gradFees * GRAD_RSA_MIN_BPS) / BPS;
        rsaMax = (bondingFees * TRADE_RSA_MAX_BPS) / BPS + (gradFees * GRAD_RSA_MAX_BPS) / BPS;
        squadMax = ((bondingFees + gradFees) * SQUAD_MAX_BPS) / BPS;
    }

    /// @notice One bounded run. Operator or admin. `runId` must be the next number (a resubmitted run reverts).
    /// @dev nonReentrant. Checks, then effects (run counter and routed totals), then the payouts; any failed payout
    /// reverts the whole run (nothing is half-routed). The hook claim at the start is the permissionless
    /// claimRouter (pays this contract only while it is the hook's current router).
    function route(uint256 runId, uint256 recruiter, uint256 squad, uint256 airdrop, bytes32 accrualRoot)
        external
        nonReentrant
        returns (Run memory r)
    {
        if (msg.sender != operator && msg.sender != admin) revert NotOperator();
        if (runId != runs + 1) revert BadRunId();
        if (hook.treasuryRouter() == address(this) && hook.routerOwed() != 0) hook.claimRouter();

        (uint256 paid, uint256 paidBonding, uint256 paidGrad) = hook.routerPaid(address(this));
        r.total = paid - routedAmount;
        r.bondingFees = paidBonding - routedBondingFees;
        r.gradFees = paidGrad - routedGradFees;
        if (r.total == 0) revert NothingToRoute();
        (uint256 weekly, uint256 monthly, uint256 rsaMin, uint256 rsaMax, uint256 squadMax) = bands(r.bondingFees, r.gradFees);
        uint256 rsa = recruiter + squad + airdrop;
        if (rsa < rsaMin || rsa > rsaMax || squad > squadMax) revert OutOfBand();
        uint256 committed = weekly + monthly + rsa;
        if (committed > r.total) revert OutOfBand();
        if (address(this).balance < r.total) revert Underfunded();
        r.weeklyLeague = weekly;
        r.monthlyLeague = monthly;
        r.recruiter = recruiter;
        r.squad = squad;
        r.airdrop = airdrop;
        r.protocol = r.total - committed;

        runs = runId;
        routedAmount = paid;
        routedBondingFees = paidBonding;
        routedGradFees = paidGrad;

        _send(weeklyLeagueVault, weekly);
        _send(monthlyLeagueTreasury, monthly);
        _send(recruiterRewardsVault, recruiter);
        if (airdrop != 0) communityRewardsVault.depositAirdrop{value: airdrop}();
        if (squad != 0) communityRewardsVault.depositSquadPool{value: squad}();
        _send(protocolRevenueVault, r.protocol);
        emit Routed(runId, accrualRoot, msg.sender, r);
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert SendFailed();
    }
}
