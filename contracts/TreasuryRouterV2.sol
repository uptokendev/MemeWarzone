// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ICommunityRewardsVaultV2 {
    function depositAirdrop() external payable;
    function depositSquadPool() external payable;
}

contract TreasuryRouterV2 {
    using SafeERC20 for IERC20;

    uint16 internal constant ROUTE_BPS = 10_000;

    enum RouteKind {
        Trade,
        Finalize
    }

    enum RouteProfile {
        StandardLinked,
        StandardUnlinked,
        OgLinked
    }

    struct RouteAmounts {
        uint256 league;
        uint256 recruiter;
        uint256 airdrop;
        uint256 squad;
        uint256 protocol;
    }

    struct LeagueSplit {
        uint256 weekly;
        uint256 monthly;
    }

    address public immutable admin;
    uint64 public immutable upgradeDelay;

    address public weeklyLeagueVault;
    address public pendingWeeklyLeagueVault;
    uint64 public pendingWeeklyLeagueVaultSince;

    address public monthlyLeagueTreasury;
    address public pendingMonthlyLeagueTreasury;
    uint64 public pendingMonthlyLeagueTreasurySince;

    address public recruiterRewardsVault;
    address public pendingRecruiterRewardsVault;
    uint64 public pendingRecruiterRewardsVaultSince;

    address public communityRewardsVault;
    address public pendingCommunityRewardsVault;
    uint64 public pendingCommunityRewardsVaultSince;

    address public protocolRevenueVault;
    address public pendingProtocolRevenueVault;
    uint64 public pendingProtocolRevenueVaultSince;

    address public pendingAuthorizedLpLocker;
    uint64 public pendingAuthorizedLpLockerSince;

    uint16 public weeklyLeagueBps = 3_000;
    uint16 public monthlyLeagueBps = 7_000;

    // Compatibility pointer for tooling that expects a primary locker address.
    address public permanentLpLocker;
    mapping(address => bool) public authorizedLpLocker;
    // After the first locker is authorized, additional lockers must use the delayed propose/accept path.
    bool public anyLpLockerAuthorized;

    bool public forwardingPaused;

    event Forwarded(address indexed vault, uint256 amount);
    event ForwardFailed(address indexed vault, uint256 amount);
    event ForwardingPaused(bool paused);

    event WeeklyLeagueVaultProposed(address indexed newVault, uint64 executeAfter);
    event WeeklyLeagueVaultActivated(address indexed oldVault, address indexed newVault);
    event MonthlyLeagueTreasuryProposed(address indexed newTreasury, uint64 executeAfter);
    event MonthlyLeagueTreasuryActivated(address indexed oldTreasury, address indexed newTreasury);

    event RecruiterRewardsVaultProposed(address indexed newVault, uint64 executeAfter);
    event RecruiterRewardsVaultUpdated(address indexed oldVault, address indexed newVault);
    event CommunityRewardsVaultProposed(address indexed newVault, uint64 executeAfter);
    event CommunityRewardsVaultUpdated(address indexed oldVault, address indexed newVault);
    event ProtocolRevenueVaultProposed(address indexed newVault, uint64 executeAfter);
    event ProtocolRevenueVaultUpdated(address indexed oldVault, address indexed newVault);
    event LpLockerAuthorizationProposed(address indexed locker, uint64 executeAfter);
    event LpLockerEmergencyDisabled(address indexed locker);
    event LeagueSplitUpdated(uint16 weeklyBps, uint16 monthlyBps);
    event AuthorizedLpLockerUpdated(address indexed locker, bool allowed);
    event PrimaryLpLockerUpdated(address indexed oldLocker, address indexed newLocker);

    event LpNativeRouted(address indexed locker, address indexed protocolRevenueVault, uint256 amount);
    event LpTokenRouted(address indexed locker, address indexed token, address indexed protocolRevenueVault, uint256 amount);
    event LeagueRouted(uint256 weeklyAmount, uint256 monthlyAmount);

    event RouteExecuted(
        RouteKind indexed kind,
        RouteProfile indexed profile,
        uint256 amountIn,
        uint256 leagueAmount,
        uint256 recruiterAmount,
        uint256 airdropAmount,
        uint256 squadAmount,
        uint256 protocolAmount
    );

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlyAuthorizedLpLocker() {
        require(authorizedLpLocker[msg.sender], "not lp locker");
        _;
    }

    constructor(
        address _admin,
        address _weeklyLeagueVault,
        address _monthlyLeagueTreasury,
        uint64 _upgradeDelaySeconds
    ) {
        require(_admin != address(0), "admin=0");
        require(_weeklyLeagueVault != address(0), "weekly=0");
        require(_monthlyLeagueTreasury != address(0), "monthly=0");
        require(_upgradeDelaySeconds >= 1 hours, "delay too small");
        admin = _admin;
        weeklyLeagueVault = _weeklyLeagueVault;
        monthlyLeagueTreasury = _monthlyLeagueTreasury;
        upgradeDelay = _upgradeDelaySeconds;
    }

    receive() external payable {
        _forward(msg.value);
    }

    function forward() external {
        _forward(address(this).balance);
    }

    function route(RouteKind kind, RouteProfile profile) external payable returns (RouteAmounts memory amounts) {
        require(!forwardingPaused, "routing paused");
        require(msg.value > 0, "amount=0");
        require(recruiterRewardsVault != address(0), "recruiterVault=0");
        require(communityRewardsVault != address(0), "communityVault=0");
        require(protocolRevenueVault != address(0), "protocolVault=0");

        amounts = previewRoute(msg.value, kind, profile);

        if (amounts.league != 0) {
            _routeLeague(amounts.league);
        }
        if (amounts.recruiter != 0) {
            _sendValue(recruiterRewardsVault, amounts.recruiter, true);
        }
        if (amounts.airdrop != 0) {
            (bool ok, ) = communityRewardsVault.call{value: amounts.airdrop}(
                abi.encodeWithSelector(ICommunityRewardsVaultV2.depositAirdrop.selector)
            );
            require(ok, "airdrop route failed");
        }
        if (amounts.squad != 0) {
            (bool ok, ) = communityRewardsVault.call{value: amounts.squad}(
                abi.encodeWithSelector(ICommunityRewardsVaultV2.depositSquadPool.selector)
            );
            require(ok, "squad route failed");
        }
        if (amounts.protocol != 0) {
            _sendValue(protocolRevenueVault, amounts.protocol, true);
        }

        emit RouteExecuted(
            kind,
            profile,
            msg.value,
            amounts.league,
            amounts.recruiter,
            amounts.airdrop,
            amounts.squad,
            amounts.protocol
        );
    }

    function routeLpNative() external payable onlyAuthorizedLpLocker {
        require(!forwardingPaused, "routing paused");
        require(msg.value > 0, "amount=0");
        require(protocolRevenueVault != address(0), "protocolVault=0");

        _sendValue(protocolRevenueVault, msg.value, true);
        emit LpNativeRouted(msg.sender, protocolRevenueVault, msg.value);
    }

    function routeLpToken(address token, uint256 amount) external onlyAuthorizedLpLocker {
        require(!forwardingPaused, "routing paused");
        require(token != address(0), "token=0");
        require(amount > 0, "amount=0");
        require(protocolRevenueVault != address(0), "protocolVault=0");

        IERC20(token).safeTransferFrom(msg.sender, protocolRevenueVault, amount);
        emit LpTokenRouted(msg.sender, token, protocolRevenueVault, amount);
    }

    function previewRoute(uint256 amount, RouteKind kind, RouteProfile profile) public pure returns (RouteAmounts memory amounts) {
        require(amount > 0, "amount=0");

        uint256 leagueBps;
        uint256 recruiterBps;
        uint256 airdropBps;
        uint256 squadBps;

        if (kind == RouteKind.Trade) {
            if (profile == RouteProfile.StandardLinked) {
                leagueBps = 3750;
                recruiterBps = 1250;
                squadBps = 250;
            } else if (profile == RouteProfile.StandardUnlinked) {
                leagueBps = 3750;
                airdropBps = 1500;
            } else {
                leagueBps = 3750;
                recruiterBps = 1500;
                squadBps = 250;
            }
        } else {
            if (profile == RouteProfile.StandardLinked) {
                recruiterBps = 1500;
                squadBps = 250;
            } else if (profile == RouteProfile.StandardUnlinked) {
                airdropBps = 1750;
            } else {
                recruiterBps = 1750;
                squadBps = 250;
            }
        }

        amounts.league = (amount * leagueBps) / ROUTE_BPS;
        amounts.recruiter = (amount * recruiterBps) / ROUTE_BPS;
        amounts.airdrop = (amount * airdropBps) / ROUTE_BPS;
        amounts.squad = (amount * squadBps) / ROUTE_BPS;
        amounts.protocol = amount - amounts.league - amounts.recruiter - amounts.airdrop - amounts.squad;
    }

    function previewLeagueSplit(uint256 leagueAmount) public view returns (LeagueSplit memory split) {
        split.weekly = (leagueAmount * weeklyLeagueBps) / ROUTE_BPS;
        split.monthly = leagueAmount - split.weekly;
    }

    function setRecruiterRewardsVault(address newVault) external onlyAdmin {
        require(recruiterRewardsVault == address(0), "use propose");
        requireContract(newVault);
        emit RecruiterRewardsVaultUpdated(address(0), newVault);
        recruiterRewardsVault = newVault;
    }

    function proposeRecruiterRewardsVault(address newVault) external onlyAdmin {
        requireContract(newVault);
        pendingRecruiterRewardsVault = newVault;
        pendingRecruiterRewardsVaultSince = uint64(block.timestamp);
        emit RecruiterRewardsVaultProposed(newVault, uint64(block.timestamp) + upgradeDelay);
    }

    function acceptRecruiterRewardsVault() external onlyAdmin {
        address newVault = _acceptPending(pendingRecruiterRewardsVault, pendingRecruiterRewardsVaultSince);
        address old = recruiterRewardsVault;
        recruiterRewardsVault = newVault;
        pendingRecruiterRewardsVault = address(0);
        pendingRecruiterRewardsVaultSince = 0;
        emit RecruiterRewardsVaultUpdated(old, newVault);
    }

    function setCommunityRewardsVault(address newVault) external onlyAdmin {
        require(communityRewardsVault == address(0), "use propose");
        requireContract(newVault);
        emit CommunityRewardsVaultUpdated(address(0), newVault);
        communityRewardsVault = newVault;
    }

    function proposeCommunityRewardsVault(address newVault) external onlyAdmin {
        requireContract(newVault);
        pendingCommunityRewardsVault = newVault;
        pendingCommunityRewardsVaultSince = uint64(block.timestamp);
        emit CommunityRewardsVaultProposed(newVault, uint64(block.timestamp) + upgradeDelay);
    }

    function acceptCommunityRewardsVault() external onlyAdmin {
        address newVault = _acceptPending(pendingCommunityRewardsVault, pendingCommunityRewardsVaultSince);
        address old = communityRewardsVault;
        communityRewardsVault = newVault;
        pendingCommunityRewardsVault = address(0);
        pendingCommunityRewardsVaultSince = 0;
        emit CommunityRewardsVaultUpdated(old, newVault);
    }

    function setProtocolRevenueVault(address newVault) external onlyAdmin {
        require(protocolRevenueVault == address(0), "use propose");
        requireContract(newVault);
        emit ProtocolRevenueVaultUpdated(address(0), newVault);
        protocolRevenueVault = newVault;
    }

    function proposeProtocolRevenueVault(address newVault) external onlyAdmin {
        requireContract(newVault);
        pendingProtocolRevenueVault = newVault;
        pendingProtocolRevenueVaultSince = uint64(block.timestamp);
        emit ProtocolRevenueVaultProposed(newVault, uint64(block.timestamp) + upgradeDelay);
    }

    function acceptProtocolRevenueVault() external onlyAdmin {
        address newVault = _acceptPending(pendingProtocolRevenueVault, pendingProtocolRevenueVaultSince);
        address old = protocolRevenueVault;
        protocolRevenueVault = newVault;
        pendingProtocolRevenueVault = address(0);
        pendingProtocolRevenueVaultSince = 0;
        emit ProtocolRevenueVaultUpdated(old, newVault);
    }

    function setLeagueSplit(uint16 newWeeklyBps, uint16 newMonthlyBps) external onlyAdmin {
        require(uint256(newWeeklyBps) + uint256(newMonthlyBps) == ROUTE_BPS, "bad split");
        weeklyLeagueBps = newWeeklyBps;
        monthlyLeagueBps = newMonthlyBps;
        emit LeagueSplitUpdated(newWeeklyBps, newMonthlyBps);
    }

    function setAuthorizedLpLocker(address locker, bool allowed) external onlyAdmin {
        if (!allowed) {
            _emergencyDisableLpLocker(locker);
            return;
        }
        require(locker != address(0), "locker=0");
        require(!anyLpLockerAuthorized || authorizedLpLocker[locker], "use propose");
        authorizedLpLocker[locker] = true;
        anyLpLockerAuthorized = true;
        emit AuthorizedLpLockerUpdated(locker, true);
    }

    function proposeAuthorizedLpLocker(address locker) external onlyAdmin {
        require(locker != address(0), "locker=0");
        pendingAuthorizedLpLocker = locker;
        pendingAuthorizedLpLockerSince = uint64(block.timestamp);
        emit LpLockerAuthorizationProposed(locker, uint64(block.timestamp) + upgradeDelay);
    }

    function acceptAuthorizedLpLocker() external onlyAdmin {
        address locker = _acceptPending(pendingAuthorizedLpLocker, pendingAuthorizedLpLockerSince);
        pendingAuthorizedLpLocker = address(0);
        pendingAuthorizedLpLockerSince = 0;
        authorizedLpLocker[locker] = true;
        anyLpLockerAuthorized = true;
        emit AuthorizedLpLockerUpdated(locker, true);
    }

    function emergencyDisableLpLocker(address locker) external onlyAdmin {
        _emergencyDisableLpLocker(locker);
    }

    function setPrimaryLpLocker(address newLocker) external onlyAdmin {
        require(newLocker != address(0), "locker=0");
        require(authorizedLpLocker[newLocker], "locker not authorized");
        emit PrimaryLpLockerUpdated(permanentLpLocker, newLocker);
        permanentLpLocker = newLocker;
    }

    function proposeWeeklyLeagueVault(address newVault) external onlyAdmin {
        requireContract(newVault);
        pendingWeeklyLeagueVault = newVault;
        pendingWeeklyLeagueVaultSince = uint64(block.timestamp);
        emit WeeklyLeagueVaultProposed(newVault, uint64(block.timestamp) + upgradeDelay);
    }

    function acceptWeeklyLeagueVault() external onlyAdmin {
        address newVault = pendingWeeklyLeagueVault;
        require(newVault != address(0), "no pending");
        require(pendingWeeklyLeagueVaultSince != 0, "no pending");
        require(block.timestamp >= pendingWeeklyLeagueVaultSince + upgradeDelay, "delay");

        address old = weeklyLeagueVault;
        weeklyLeagueVault = newVault;
        pendingWeeklyLeagueVault = address(0);
        pendingWeeklyLeagueVaultSince = 0;
        emit WeeklyLeagueVaultActivated(old, newVault);
    }

    function proposeMonthlyLeagueTreasury(address newTreasury) external onlyAdmin {
        requireContract(newTreasury);
        pendingMonthlyLeagueTreasury = newTreasury;
        pendingMonthlyLeagueTreasurySince = uint64(block.timestamp);
        emit MonthlyLeagueTreasuryProposed(newTreasury, uint64(block.timestamp) + upgradeDelay);
    }

    function acceptMonthlyLeagueTreasury() external onlyAdmin {
        address newTreasury = pendingMonthlyLeagueTreasury;
        require(newTreasury != address(0), "no pending");
        require(pendingMonthlyLeagueTreasurySince != 0, "no pending");
        require(block.timestamp >= pendingMonthlyLeagueTreasurySince + upgradeDelay, "delay");

        address old = monthlyLeagueTreasury;
        monthlyLeagueTreasury = newTreasury;
        pendingMonthlyLeagueTreasury = address(0);
        pendingMonthlyLeagueTreasurySince = 0;
        emit MonthlyLeagueTreasuryActivated(old, newTreasury);
    }

    function setForwardingPaused(bool paused) external onlyAdmin {
        forwardingPaused = paused;
        emit ForwardingPaused(paused);
    }

    function _forward(uint256 amount) internal {
        if (forwardingPaused) return;
        if (amount == 0) return;

        _sendValue(weeklyLeagueVault, amount, false);
    }

    function _routeLeague(uint256 leagueAmount) internal {
        LeagueSplit memory split = previewLeagueSplit(leagueAmount);
        if (split.weekly != 0) {
            _sendValue(weeklyLeagueVault, split.weekly, true);
        }
        if (split.monthly != 0) {
            _sendValue(monthlyLeagueTreasury, split.monthly, true);
        }
        emit LeagueRouted(split.weekly, split.monthly);
    }

    function _sendValue(address to, uint256 amount, bool revertOnFailure) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) {
            if (revertOnFailure) revert("route failed");
            emit ForwardFailed(to, amount);
            return;
        }
        emit Forwarded(to, amount);
    }

    function requireContract(address target) internal view {
        require(target != address(0), "target=0");
        uint256 size;
        assembly {
            size := extcodesize(target)
        }
        require(size > 0, "not contract");
    }

    function _acceptPending(address pending, uint64 since) internal view returns (address) {
        require(pending != address(0) && since != 0, "no pending");
        require(block.timestamp >= since + upgradeDelay, "delay");
        return pending;
    }

    function _emergencyDisableLpLocker(address locker) internal {
        require(locker != address(0), "locker=0");
        authorizedLpLocker[locker] = false;
        if (permanentLpLocker == locker) {
            emit PrimaryLpLockerUpdated(permanentLpLocker, address(0));
            permanentLpLocker = address(0);
        }
        emit AuthorizedLpLockerUpdated(locker, false);
        emit LpLockerEmergencyDisabled(locker);
    }
}
