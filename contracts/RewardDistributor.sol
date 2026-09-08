// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RewardDistributor is Ownable, Pausable, ReentrancyGuard {
    error RootZero();
    error AmountZero();
    error BatchExists(bytes32 batchId);
    error BatchMissing(bytes32 batchId);
    error BatchPaused(bytes32 batchId);
    error BatchExpired(bytes32 batchId);
    error BatchStillOpen(bytes32 batchId);
    error AlreadyClaimed(bytes32 batchId, address account);
    error InvalidProof();
    error TransferFailed();
    error InsufficientUnclaimed();
    error InsufficientExcessNative();
    error NotBatchOperator(address caller);
    error ZeroAddress();
    error BatchNotAuthorized(bytes32 batchId);
    error BatchAuthConsumed(bytes32 batchId);
    error BatchTooEarly(bytes32 batchId);
    error BatchAuthExpired(bytes32 batchId);
    error BatchAboveAuthorizedMax(bytes32 batchId);
    error BadPublishWindow();

    struct Batch {
        bytes32 merkleRoot;
        uint256 totalFunded;
        uint256 totalClaimed;
        uint64 claimDeadline;
        bool paused;
        bool exists;
    }

    struct BatchAuthorization {
        uint256 maxAmount;
        uint64 publishAfter;
        uint64 publishDeadline;
        bool authorized;
        bool consumed;
    }

    mapping(bytes32 => Batch) public batches;
    mapping(bytes32 => mapping(address => bool)) public hasClaimed;
    mapping(bytes32 => BatchAuthorization) public batchAuthorization;

    address public batchOperator;
    uint256 public totalOutstandingRewards;

    event BatchOperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event BatchAuthorized(bytes32 indexed batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline);
    event BatchAuthorizationRevoked(bytes32 indexed batchId);
    event BatchCreated(bytes32 indexed batchId, bytes32 indexed merkleRoot, uint256 totalFunded, uint64 claimDeadline);
    event BatchPauseUpdated(bytes32 indexed batchId, bool paused);
    event RewardClaimed(bytes32 indexed batchId, address indexed account, uint256 amount);
    event UnclaimedRecovered(bytes32 indexed batchId, address indexed recipient, uint256 amount);
    event ExcessNativeRescued(address indexed recipient, uint256 amount);

    modifier onlyOwnerOrBatchOperator() {
        if (msg.sender != owner() && msg.sender != batchOperator) revert NotBatchOperator(msg.sender);
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    receive() external payable {}

    function setBatchOperator(address newOperator) external onlyOwner {
        emit BatchOperatorUpdated(batchOperator, newOperator);
        batchOperator = newOperator;
    }

    function authorizeBatch(bytes32 batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline) external onlyOwner {
        if (batchId == bytes32(0)) revert RootZero();
        if (maxAmount == 0) revert AmountZero();
        if (publishDeadline <= publishAfter) revert BadPublishWindow();
        BatchAuthorization storage auth = batchAuthorization[batchId];
        if (auth.consumed) revert BatchAuthConsumed(batchId);
        if (batches[batchId].exists) revert BatchExists(batchId);
        auth.maxAmount = maxAmount;
        auth.publishAfter = publishAfter;
        auth.publishDeadline = publishDeadline;
        auth.authorized = true;
        emit BatchAuthorized(batchId, maxAmount, publishAfter, publishDeadline);
    }

    function revokeBatch(bytes32 batchId) external onlyOwner {
        BatchAuthorization storage auth = batchAuthorization[batchId];
        if (!auth.authorized || auth.consumed) revert BatchNotAuthorized(batchId);
        auth.authorized = false;
        emit BatchAuthorizationRevoked(batchId);
    }

    function createBatch(bytes32 batchId, bytes32 merkleRoot, uint64 claimDeadline) external payable onlyOwnerOrBatchOperator {
        if (batchId == bytes32(0) || merkleRoot == bytes32(0)) revert RootZero();
        if (msg.value == 0) revert AmountZero();
        if (batches[batchId].exists) revert BatchExists(batchId);
        BatchAuthorization storage auth = batchAuthorization[batchId];
        if (!auth.authorized || auth.consumed) revert BatchNotAuthorized(batchId);
        if (block.timestamp < auth.publishAfter) revert BatchTooEarly(batchId);
        if (block.timestamp > auth.publishDeadline) revert BatchAuthExpired(batchId);
        if (msg.value > auth.maxAmount) revert BatchAboveAuthorizedMax(batchId);
        auth.consumed = true;

        batches[batchId] = Batch({
            merkleRoot: merkleRoot,
            totalFunded: msg.value,
            totalClaimed: 0,
            claimDeadline: claimDeadline,
            paused: false,
            exists: true
        });
        totalOutstandingRewards += msg.value;

        emit BatchCreated(batchId, merkleRoot, msg.value, claimDeadline);
    }

    function setBatchPaused(bytes32 batchId, bool paused_) external onlyOwner {
        Batch storage batch = _batch(batchId);
        batch.paused = paused_;
        emit BatchPauseUpdated(batchId, paused_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function claim(bytes32 batchId, uint256 amount, bytes32[] calldata proof) external nonReentrant whenNotPaused {
        Batch storage batch = _batch(batchId);
        if (batch.paused) revert BatchPaused(batchId);
        if (batch.claimDeadline != 0 && block.timestamp > batch.claimDeadline) revert BatchExpired(batchId);
        if (hasClaimed[batchId][msg.sender]) revert AlreadyClaimed(batchId, msg.sender);
        if (amount == 0) revert AmountZero();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verify(proof, batch.merkleRoot, leaf)) revert InvalidProof();
        if (batch.totalFunded - batch.totalClaimed < amount) revert InsufficientUnclaimed();

        hasClaimed[batchId][msg.sender] = true;
        batch.totalClaimed += amount;
        totalOutstandingRewards -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit RewardClaimed(batchId, msg.sender, amount);
    }

    function recoverUnclaimed(bytes32 batchId, address payable recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        Batch storage batch = _batch(batchId);
        if (batch.claimDeadline == 0 || block.timestamp <= batch.claimDeadline) revert BatchStillOpen(batchId);

        uint256 unclaimedAmount = batch.totalFunded - batch.totalClaimed;
        if (unclaimedAmount == 0) revert AmountZero();
        batch.totalFunded = batch.totalClaimed;
        totalOutstandingRewards -= unclaimedAmount;

        (bool ok,) = recipient.call{value: unclaimedAmount}("");
        if (!ok) revert TransferFailed();

        emit UnclaimedRecovered(batchId, recipient, unclaimedAmount);
    }

    function rescueExcessNative(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();
        uint256 excess = address(this).balance - totalOutstandingRewards;
        if (amount > excess) revert InsufficientExcessNative();

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit ExcessNativeRescued(recipient, amount);
    }

    function unclaimed(bytes32 batchId) external view returns (uint256) {
        Batch storage batch = _batch(batchId);
        return batch.totalFunded - batch.totalClaimed;
    }

    function excessNativeBalance() external view returns (uint256) {
        return address(this).balance - totalOutstandingRewards;
    }

    function _batch(bytes32 batchId) internal view returns (Batch storage batch) {
        batch = batches[batchId];
        if (!batch.exists) revert BatchMissing(batchId);
    }
}
