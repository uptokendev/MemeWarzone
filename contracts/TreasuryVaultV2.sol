// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title TreasuryVaultV2
/// @notice Vault that keeps the multisig as admin.
///
///         Two payout lanes:
///         1) Optional capped "operator" payouts (hot-wallet execution) with per-tx + daily caps + pause.
///         2) Trust-minimized user-claimed payouts via Merkle roots (users pay gas; contract pays recipients).
///            A low-privilege "rootPoster" can publish epoch roots; claims are bounded by epoch totals and caps.
///
///         Security posture:
///         - Both payout lanes start paused by default.
///         - Unlimited caps are not allowed for active lanes.
///         - A lane may only be unpaused once its role + caps are explicitly configured.
contract TreasuryVaultV2 {
    address public immutable multisig;
    address public operator;

    // Merkle root posting (low-privilege; does NOT move funds directly)
    address public rootPoster;

    // Safety controls
    uint256 public maxPayoutPerTx;
    uint256 public dailyPayoutCap;
    bool public payoutsPaused;

    // Claim safety controls
    uint256 public maxClaimPerTx;
    uint256 public maxEpochTotal;
    bool public claimsPaused;

    // Merkle roots per epochId
    struct EpochAuthorization {
        uint256 maxAmount;
        uint64 publishAfter;
        uint64 publishDeadline;
        bool authorized;
        bool consumed;
    }

    mapping(uint256 => bytes32) public epochRoot;
    mapping(uint256 => uint256) public epochTotal;
    mapping(uint256 => uint256) public epochClaimedTotal;
    mapping(uint256 => mapping(bytes32 => bool)) public epochLeafClaimed;
    mapping(uint256 => EpochAuthorization) public epochAuthorization;

    // Daily accounting
    uint256 public lastDay;
    uint256 public dailySpent;

    event OperatorUpdated(address indexed operator);
    event RootPosterUpdated(address indexed rootPoster);
    event CapsUpdated(uint256 maxPayoutPerTx, uint256 dailyPayoutCap);
    event PayoutsPaused(bool paused);
    event Payout(address indexed to, uint256 amount);

    event ClaimCapsUpdated(uint256 maxClaimPerTx, uint256 maxEpochTotal);
    event ClaimsPaused(bool paused);
    event EpochAuthorized(uint256 indexed epochId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline);
    event EpochAuthorizationRevoked(uint256 indexed epochId);
    event EpochRootSet(uint256 indexed epochId, bytes32 indexed root, uint256 totalAmount);
    event Claimed(uint256 indexed epochId, address indexed recipient, uint256 amount, bytes32 indexed leaf);
    event Withdraw(address indexed to, uint256 amount);

    modifier onlyMultisig() {
        require(msg.sender == multisig, "not multisig");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    modifier onlyRootPosterOrMultisig() {
        require(msg.sender == rootPoster || msg.sender == multisig, "not rootPoster");
        _;
    }

    constructor(address _multisig, address _operator, address _rootPoster) {
        require(_multisig != address(0), "multisig=0");
        multisig = _multisig;
        operator = _operator;
        rootPoster = _rootPoster;
        payoutsPaused = true;
        claimsPaused = true;
        lastDay = block.timestamp / 1 days;

        emit OperatorUpdated(_operator);
        emit RootPosterUpdated(_rootPoster);
        emit PayoutsPaused(true);
        emit ClaimsPaused(true);
    }

    receive() external payable {}

    /// @notice Admin: update operator.
    function setOperator(address _operator) external onlyMultisig {
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    /// @notice Admin: update rootPoster.
    function setRootPoster(address _rootPoster) external onlyMultisig {
        rootPoster = _rootPoster;
        emit RootPosterUpdated(_rootPoster);
    }

    /// @notice Admin: update payout caps.
    function setCaps(uint256 _maxPayoutPerTx, uint256 _dailyPayoutCap) external onlyMultisig {
        maxPayoutPerTx = _maxPayoutPerTx;
        dailyPayoutCap = _dailyPayoutCap;
        emit CapsUpdated(_maxPayoutPerTx, _dailyPayoutCap);
    }

    /// @notice Admin: pause/unpause operator payouts.
    function setPayoutsPaused(bool paused) external onlyMultisig {
        if (!paused) {
            _requirePayoutLaneConfigured();
        }
        payoutsPaused = paused;
        emit PayoutsPaused(paused);
    }

    /// @notice Admin: update claim caps (Merkle-claim lane).
    function setClaimCaps(uint256 _maxClaimPerTx, uint256 _maxEpochTotal) external onlyMultisig {
        maxClaimPerTx = _maxClaimPerTx;
        maxEpochTotal = _maxEpochTotal;
        emit ClaimCapsUpdated(_maxClaimPerTx, _maxEpochTotal);
    }

    /// @notice Admin: pause/unpause Merkle claims.
    function setClaimsPaused(bool paused) external onlyMultisig {
        if (!paused) {
            _requireClaimLaneConfigured();
        }
        claimsPaused = paused;
        emit ClaimsPaused(paused);
    }

    /// @notice Safe-only: approve a payout epoch the rootPoster may later publish.
    function authorizeEpoch(uint256 epochId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline) external onlyMultisig {
        require(maxAmount > 0, "maxAmount=0");
        require(publishDeadline > publishAfter, "bad window");
        EpochAuthorization storage auth = epochAuthorization[epochId];
        require(!auth.consumed, "auth consumed");
        require(epochRoot[epochId] == bytes32(0), "root already set");
        auth.maxAmount = maxAmount;
        auth.publishAfter = publishAfter;
        auth.publishDeadline = publishDeadline;
        auth.authorized = true;
        emit EpochAuthorized(epochId, maxAmount, publishAfter, publishDeadline);
    }

    function revokeEpoch(uint256 epochId) external onlyMultisig {
        EpochAuthorization storage auth = epochAuthorization[epochId];
        require(auth.authorized && !auth.consumed, "not revocable");
        auth.authorized = false;
        emit EpochAuthorizationRevoked(epochId);
    }

    /// @notice Publish the Merkle root for a Safe-authorized epoch.
    /// @dev rootPoster or multisig can publish. Root is immutable once set.
    function setEpochRoot(uint256 epochId, bytes32 root, uint256 totalAmount) external onlyRootPosterOrMultisig {
        require(root != bytes32(0), "root=0");
        require(epochRoot[epochId] == bytes32(0), "root already set");
        EpochAuthorization storage auth = epochAuthorization[epochId];
        require(auth.authorized && !auth.consumed, "epoch not authorized");
        require(block.timestamp >= auth.publishAfter, "too early");
        require(block.timestamp <= auth.publishDeadline, "auth expired");
        require(totalAmount <= auth.maxAmount, "above authorized max");
        if (maxEpochTotal != 0) {
            require(totalAmount <= maxEpochTotal, "maxEpochTotal");
        }
        auth.consumed = true;
        epochRoot[epochId] = root;
        epochTotal[epochId] = totalAmount;
        emit EpochRootSet(epochId, root, totalAmount);
    }

    /// @notice Claim a Merkle-authorized payout (users pay gas).
    /// @param epochId Epoch identifier used when setting the root.
    /// @param category League category id (string hashed off-chain, passed as bytes32).
    /// @param rank Rank (1..5)
    /// @param recipient Payout recipient address.
    /// @param amount Amount of native token to pay.
    /// @param proof Merkle proof.
    function claim(
        uint256 epochId,
        bytes32 category,
        uint8 rank,
        address payable recipient,
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        require(!claimsPaused, "claims paused");
        require(recipient != address(0), "to=0");
        require(amount > 0, "amount=0");
        bytes32 root = epochRoot[epochId];
        require(root != bytes32(0), "root not set");
        require(amount <= address(this).balance, "insufficient");
        require(amount <= maxClaimPerTx, "maxClaimPerTx");

        bytes32 leaf = keccak256(abi.encode(epochId, category, rank, recipient, amount));
        require(!epochLeafClaimed[epochId][leaf], "already claimed");
        require(MerkleProof.verify(proof, root, leaf), "bad proof");

        uint256 newTotal = epochClaimedTotal[epochId] + amount;
        require(newTotal <= epochTotal[epochId], "exceeds epochTotal");
        epochClaimedTotal[epochId] = newTotal;
        epochLeafClaimed[epochId][leaf] = true;

        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "transfer failed");
        emit Claimed(epochId, recipient, amount, leaf);
    }

    /// @notice Operator: execute a payout under the configured safety controls.
    function payout(address payable to, uint256 amount) external onlyOperator {
        require(!payoutsPaused, "payouts paused");
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        require(amount <= address(this).balance, "insufficient");
        require(amount <= maxPayoutPerTx, "maxPayoutPerTx");

        uint256 d = block.timestamp / 1 days;
        if (d != lastDay) {
            lastDay = d;
            dailySpent = 0;
        }

        require(dailySpent + amount <= dailyPayoutCap, "dailyPayoutCap");
        dailySpent += amount;

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
        emit Payout(to, amount);
    }

    /// @notice Multisig-only emergency/manual withdraw.
    function withdraw(address payable to, uint256 amount) external onlyMultisig {
        require(to != address(0), "to=0");
        require(amount <= address(this).balance, "insufficient");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
        emit Withdraw(to, amount);
    }

    function _requirePayoutLaneConfigured() internal view {
        require(operator != address(0), "operator=0");
        require(maxPayoutPerTx != 0, "maxPayoutPerTx=0");
        require(dailyPayoutCap != 0, "dailyPayoutCap=0");
    }

    function _requireClaimLaneConfigured() internal view {
        require(rootPoster != address(0), "rootPoster=0");
        require(maxClaimPerTx != 0, "maxClaimPerTx=0");
        require(maxEpochTotal != 0, "maxEpochTotal=0");
    }
}
