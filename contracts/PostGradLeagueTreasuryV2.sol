// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PostGradLeagueTreasuryV2
 * @notice Chain-native receiver for Arena V2 competition league allocations.
 *         Every accepted source pool is credited once and split 60/40 between
 *         its bound Monthly MWL epoch and Quarterly reserve epoch.
 *         Historical V1 league routing is intentionally untouched.
 */
contract PostGradLeagueTreasuryV2 is Ownable, ReentrancyGuard {
    uint256 public constant GENERATION = 2;
    uint256 public constant MONTHLY_BPS = 6_000;
    uint256 public constant BPS_DENOM = 10_000;

    address public monthlyReceiver;
    address public quarterlyReceiver;
    bool public depositsPaused;

    uint256 public pendingMonthly;
    uint256 public pendingQuarterly;

    mapping(bytes32 => uint256) public pendingMonthlyByEpoch;
    mapping(bytes32 => uint256) public pendingQuarterlyByEpoch;
    mapping(address => bool) public authorizedSources;
    mapping(bytes32 => bool) public creditedSourcePools;

    event SourceAuthorized(address indexed source, bool allowed);
    event ReceiversUpdated(address indexed monthlyReceiver, address indexed quarterlyReceiver);
    event DepositsPaused(bool paused);
    event CompetitionShareCredited(
        bytes32 indexed sourcePool,
        bytes32 indexed monthlyEpoch,
        bytes32 indexed quarterlyEpoch,
        uint256 grossNativeRaw,
        uint256 monthlyNativeRaw,
        uint256 quarterlyNativeRaw,
        address source
    );
    event MonthlyClaimed(bytes32 indexed epoch, address indexed receiver, uint256 amount);
    event QuarterlyClaimed(bytes32 indexed epoch, address indexed receiver, uint256 amount);

    error ZeroAddress();
    error Unauthorized();
    error InvalidAmount();
    error InvalidReference();
    error AlreadyCredited();
    error DepositsArePaused();
    error NothingToClaim();
    error TransferFailed();

    constructor(address initialOwner, address monthlyReceiver_, address quarterlyReceiver_) Ownable(initialOwner) {
        if (initialOwner == address(0) || monthlyReceiver_ == address(0) || quarterlyReceiver_ == address(0)) {
            revert ZeroAddress();
        }
        monthlyReceiver = monthlyReceiver_;
        quarterlyReceiver = quarterlyReceiver_;
        emit ReceiversUpdated(monthlyReceiver_, quarterlyReceiver_);
    }

    receive() external payable {
        revert InvalidAmount();
    }

    function setSource(address source, bool allowed) external onlyOwner {
        if (source == address(0)) revert ZeroAddress();
        authorizedSources[source] = allowed;
        emit SourceAuthorized(source, allowed);
    }

    function setReceivers(address monthlyReceiver_, address quarterlyReceiver_) external onlyOwner {
        if (monthlyReceiver_ == address(0) || quarterlyReceiver_ == address(0)) revert ZeroAddress();
        monthlyReceiver = monthlyReceiver_;
        quarterlyReceiver = quarterlyReceiver_;
        emit ReceiversUpdated(monthlyReceiver_, quarterlyReceiver_);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function depositCompetitionShare(
        bytes32 sourcePool,
        bytes32 monthlyEpoch,
        bytes32 quarterlyEpoch
    ) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        if (!authorizedSources[msg.sender]) revert Unauthorized();
        if (msg.value == 0) revert InvalidAmount();
        if (sourcePool == bytes32(0) || monthlyEpoch == bytes32(0) || quarterlyEpoch == bytes32(0)) {
            revert InvalidReference();
        }
        if (creditedSourcePools[sourcePool]) revert AlreadyCredited();

        creditedSourcePools[sourcePool] = true;

        uint256 monthlyAmount = (msg.value * MONTHLY_BPS) / BPS_DENOM;
        uint256 quarterlyAmount = msg.value - monthlyAmount;

        pendingMonthly += monthlyAmount;
        pendingQuarterly += quarterlyAmount;
        pendingMonthlyByEpoch[monthlyEpoch] += monthlyAmount;
        pendingQuarterlyByEpoch[quarterlyEpoch] += quarterlyAmount;

        emit CompetitionShareCredited(
            sourcePool,
            monthlyEpoch,
            quarterlyEpoch,
            msg.value,
            monthlyAmount,
            quarterlyAmount,
            msg.sender
        );
    }

    function claimMonthly(bytes32 epoch) external nonReentrant {
        if (epoch == bytes32(0)) revert InvalidReference();
        uint256 amount = pendingMonthlyByEpoch[epoch];
        if (amount == 0) revert NothingToClaim();
        pendingMonthlyByEpoch[epoch] = 0;
        pendingMonthly -= amount;
        _pay(monthlyReceiver, amount);
        emit MonthlyClaimed(epoch, monthlyReceiver, amount);
    }

    function claimQuarterly(bytes32 epoch) external nonReentrant {
        if (epoch == bytes32(0)) revert InvalidReference();
        uint256 amount = pendingQuarterlyByEpoch[epoch];
        if (amount == 0) revert NothingToClaim();
        pendingQuarterlyByEpoch[epoch] = 0;
        pendingQuarterly -= amount;
        _pay(quarterlyReceiver, amount);
        emit QuarterlyClaimed(epoch, quarterlyReceiver, amount);
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
