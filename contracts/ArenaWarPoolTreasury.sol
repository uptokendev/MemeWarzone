// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * Holding escrow for Arena battle stakes, tournament buy-ins, and Support donations.
 * Native asset only. Protocol never pushes user funds — winners / fee receivers pull.
 *
 * Split after resolve: 85% winning campaign owner, 5% protocol, 10% MWL.
 * Support is a donation. Supporters have no claim function.
 * Winner-takes-all: both stakes form one pot. Tie refunds stakes; Support 85% goes to charity.
 */
contract ArenaWarPoolTreasury is ReentrancyGuard, Ownable, EIP712 {
    using ECDSA for bytes32;

    enum Kind {
        Battle,
        Tournament
    }

    enum State {
        Open,
        Live,
        Resolved,
        Cancelled
    }

    struct Pool {
        Kind kind;
        State state;
        address ownerA;
        address ownerB;
        uint96 stakeAmount;
        uint96 buyInAmount;
        uint256 stakeA;
        uint256 stakeB;
        uint256 buyInTotal;
        uint256 supportTotal;
        address winnerPayout;
        uint256 pendingWinner;
        uint256 pendingProtocol;
        uint256 pendingMwl;
        uint256 pendingCharity;
        uint256 depositDeadline;
        uint256 resolveDeadline;
        bool claimedWinner;
        bool claimedProtocol;
        bool claimedMwl;
        bool claimedCharity;
        bool refundedA;
        bool refundedB;
    }

    bytes32 public constant RESOLVE_TYPEHASH =
        keccak256(
            "ResolvePool(bytes32 poolId,address winnerPayout,uint256 stakeTotal,uint256 supportTotal,uint256 buyInTotal,uint256 deadline)"
        );

    uint256 public constant PROTOCOL_BPS = 500;
    uint256 public constant MWL_BPS = 1000;
    uint256 public constant BPS_DENOM = 10_000;

    mapping(bytes32 => Pool) public pools;
    mapping(bytes32 => mapping(address => uint256)) public buyIns;
    mapping(address => bool) public authorizedCreators;

    address public resolver;
    address public protocolReceiver;
    address public mwlReceiver;
    address public charityReceiver;
    bool public depositsPaused;

    event CreatorAuthorized(address indexed creator, bool allowed);
    event ResolverUpdated(address indexed resolver);
    event ReceiversUpdated(address protocolReceiver, address mwlReceiver, address charityReceiver);
    event DepositsPaused(bool paused);
    event PoolOpened(bytes32 indexed poolId, Kind kind, address ownerA, address ownerB, uint256 stakeAmount, uint256 buyInAmount);
    event StakeDeposited(bytes32 indexed poolId, address indexed owner, uint256 amount);
    event BuyInDeposited(bytes32 indexed poolId, address indexed owner, uint256 amount);
    event SupportDonated(bytes32 indexed poolId, address indexed donor, uint256 amount);
    event PoolLive(bytes32 indexed poolId);
    event PoolResolved(bytes32 indexed poolId, address winnerPayout, uint256 pendingWinner, uint256 pendingProtocol, uint256 pendingMwl, uint256 pendingCharity);
    event PoolCancelled(bytes32 indexed poolId);
    event Claimed(bytes32 indexed poolId, bytes32 bucket, address indexed to, uint256 amount);
    event StakeRefunded(bytes32 indexed poolId, address indexed owner, uint256 amount);

    error ZeroAddress();
    error Unauthorized();
    error InvalidState();
    error InvalidAmount();
    error DeadlinePassed();
    error AlreadyDeposited();
    error NotOwner();
    error SignatureExpired();
    error BadSignature();
    error NothingToClaim();
    error TransferFailed();
    error DepositsArePaused();
    error PoolExists();
    error UnknownPool();

    modifier onlyCreator() {
        if (!authorizedCreators[msg.sender] && msg.sender != owner()) revert Unauthorized();
        _;
    }

    constructor(
        address initialOwner,
        address resolver_,
        address protocolReceiver_,
        address mwlReceiver_,
        address charityReceiver_
    ) Ownable(initialOwner) EIP712("ArenaWarPoolTreasury", "1") {
        if (initialOwner == address(0) || resolver_ == address(0)) revert ZeroAddress();
        if (protocolReceiver_ == address(0) || mwlReceiver_ == address(0) || charityReceiver_ == address(0)) revert ZeroAddress();
        resolver = resolver_;
        protocolReceiver = protocolReceiver_;
        mwlReceiver = mwlReceiver_;
        charityReceiver = charityReceiver_;
        authorizedCreators[initialOwner] = true;
        emit CreatorAuthorized(initialOwner, true);
        emit ResolverUpdated(resolver_);
        emit ReceiversUpdated(protocolReceiver_, mwlReceiver_, charityReceiver_);
    }

    receive() external payable {
        revert InvalidAmount();
    }

    function setCreator(address creator, bool allowed) external onlyOwner {
        if (creator == address(0)) revert ZeroAddress();
        authorizedCreators[creator] = allowed;
        emit CreatorAuthorized(creator, allowed);
    }

    function setResolver(address resolver_) external onlyOwner {
        if (resolver_ == address(0)) revert ZeroAddress();
        resolver = resolver_;
        emit ResolverUpdated(resolver_);
    }

    function setReceivers(address protocolReceiver_, address mwlReceiver_, address charityReceiver_) external onlyOwner {
        if (protocolReceiver_ == address(0) || mwlReceiver_ == address(0) || charityReceiver_ == address(0)) revert ZeroAddress();
        protocolReceiver = protocolReceiver_;
        mwlReceiver = mwlReceiver_;
        charityReceiver = charityReceiver_;
        emit ReceiversUpdated(protocolReceiver_, mwlReceiver_, charityReceiver_);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function openBattlePool(
        bytes32 poolId,
        address ownerA,
        address ownerB,
        uint96 stakeAmount,
        uint256 depositDeadline,
        uint256 resolveDeadline
    ) external payable nonReentrant {
        if (poolId == bytes32(0) || ownerA == address(0) || ownerB == address(0) || ownerA == ownerB) revert ZeroAddress();
        if (msg.sender != ownerA && msg.sender != ownerB && !authorizedCreators[msg.sender] && msg.sender != owner()) {
            revert Unauthorized();
        }
        if (stakeAmount == 0) revert InvalidAmount();
        if (depositDeadline <= block.timestamp || resolveDeadline <= depositDeadline) revert DeadlinePassed();
        Pool storage pool = pools[poolId];
        if (pool.ownerA != address(0)) revert PoolExists();
        pool.kind = Kind.Battle;
        pool.state = State.Open;
        pool.ownerA = ownerA;
        pool.ownerB = ownerB;
        pool.stakeAmount = stakeAmount;
        pool.depositDeadline = depositDeadline;
        pool.resolveDeadline = resolveDeadline;
        emit PoolOpened(poolId, Kind.Battle, ownerA, ownerB, stakeAmount, 0);
        if (msg.value != 0) {
            if (msg.sender != ownerA || msg.value != stakeAmount) revert InvalidAmount();
            pool.stakeA = msg.value;
            emit StakeDeposited(poolId, msg.sender, msg.value);
        }
    }

    function openTournamentPool(
        bytes32 poolId,
        uint96 buyInAmount,
        uint256 depositDeadline,
        uint256 resolveDeadline
    ) external onlyCreator {
        if (poolId == bytes32(0)) revert ZeroAddress();
        if (buyInAmount == 0) revert InvalidAmount();
        if (depositDeadline <= block.timestamp || resolveDeadline <= depositDeadline) revert DeadlinePassed();
        Pool storage pool = pools[poolId];
        if (pool.ownerA != address(0) || pool.buyInAmount != 0) revert PoolExists();
        pool.kind = Kind.Tournament;
        pool.state = State.Open;
        pool.ownerA = msg.sender;
        pool.buyInAmount = buyInAmount;
        pool.depositDeadline = depositDeadline;
        pool.resolveDeadline = resolveDeadline;
        emit PoolOpened(poolId, Kind.Tournament, msg.sender, address(0), 0, buyInAmount);
    }

    function depositStake(bytes32 poolId) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.kind != Kind.Battle || pool.state != State.Open) revert InvalidState();
        if (block.timestamp > pool.depositDeadline) revert DeadlinePassed();
        if (msg.value != pool.stakeAmount) revert InvalidAmount();
        if (msg.sender == pool.ownerA) {
            if (pool.stakeA != 0) revert AlreadyDeposited();
            pool.stakeA = msg.value;
        } else if (msg.sender == pool.ownerB) {
            if (pool.stakeB != 0) revert AlreadyDeposited();
            pool.stakeB = msg.value;
        } else {
            revert NotOwner();
        }
        emit StakeDeposited(poolId, msg.sender, msg.value);
        if (pool.stakeA == pool.stakeAmount && pool.stakeB == pool.stakeAmount) {
            pool.state = State.Live;
            emit PoolLive(poolId);
        }
    }

    function depositBuyIn(bytes32 poolId) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.kind != Kind.Tournament || (pool.state != State.Open && pool.state != State.Live)) revert InvalidState();
        if (block.timestamp > pool.depositDeadline) revert DeadlinePassed();
        if (msg.value != pool.buyInAmount) revert InvalidAmount();
        if (buyIns[poolId][msg.sender] != 0) revert AlreadyDeposited();
        buyIns[poolId][msg.sender] = msg.value;
        pool.buyInTotal += msg.value;
        emit BuyInDeposited(poolId, msg.sender, msg.value);
    }

    function donateSupport(bytes32 poolId) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.state != State.Open && pool.state != State.Live) revert InvalidState();
        if (msg.value == 0) revert InvalidAmount();
        pool.supportTotal += msg.value;
        emit SupportDonated(poolId, msg.sender, msg.value);
    }

    function resolve(
        bytes32 poolId,
        address winnerPayout,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.state != State.Open && pool.state != State.Live) revert InvalidState();
        if (block.timestamp > deadline) revert SignatureExpired();
        uint256 stakeTotal = pool.stakeA + pool.stakeB;
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESOLVE_TYPEHASH,
                    poolId,
                    winnerPayout,
                    stakeTotal,
                    pool.supportTotal,
                    pool.buyInTotal,
                    deadline
                )
            )
        );
        if (digest.recover(signature) != resolver) revert BadSignature();

        uint256 prize = stakeTotal + pool.supportTotal + pool.buyInTotal;
        pool.state = State.Resolved;
        pool.winnerPayout = winnerPayout;
        if (prize == 0) {
            emit PoolResolved(poolId, winnerPayout, 0, 0, 0, 0);
            return;
        }
        uint256 protocolAmt = (prize * PROTOCOL_BPS) / BPS_DENOM;
        uint256 mwlAmt = (prize * MWL_BPS) / BPS_DENOM;
        uint256 winnerAmt = prize - protocolAmt - mwlAmt;
        pool.pendingProtocol = protocolAmt;
        pool.pendingMwl = mwlAmt;
        if (winnerPayout == address(0)) {
            pool.pendingCharity = winnerAmt;
        } else {
            pool.pendingWinner = winnerAmt;
        }
        emit PoolResolved(poolId, winnerPayout, pool.pendingWinner, protocolAmt, mwlAmt, pool.pendingCharity);
    }

    function claimWinner(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Resolved) revert InvalidState();
        if (msg.sender != pool.winnerPayout) revert NotOwner();
        uint256 amount = pool.pendingWinner;
        if (amount == 0 || pool.claimedWinner) revert NothingToClaim();
        pool.claimedWinner = true;
        pool.pendingWinner = 0;
        _pay(msg.sender, amount);
        emit Claimed(poolId, "winner", msg.sender, amount);
    }

    function claimProtocol(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Resolved) revert InvalidState();
        uint256 amount = pool.pendingProtocol;
        if (amount == 0 || pool.claimedProtocol) revert NothingToClaim();
        pool.claimedProtocol = true;
        pool.pendingProtocol = 0;
        _pay(protocolReceiver, amount);
        emit Claimed(poolId, "protocol", protocolReceiver, amount);
    }

    function claimMwl(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Resolved) revert InvalidState();
        uint256 amount = pool.pendingMwl;
        if (amount == 0 || pool.claimedMwl) revert NothingToClaim();
        pool.claimedMwl = true;
        pool.pendingMwl = 0;
        _pay(mwlReceiver, amount);
        emit Claimed(poolId, "mwl", mwlReceiver, amount);
    }

    function claimCharity(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Resolved) revert InvalidState();
        uint256 amount = pool.pendingCharity;
        if (amount == 0 || pool.claimedCharity) revert NothingToClaim();
        pool.claimedCharity = true;
        pool.pendingCharity = 0;
        _pay(charityReceiver, amount);
        emit Claimed(poolId, "charity", charityReceiver, amount);
    }

    function refundStake(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        bool timedOut = block.timestamp > pool.depositDeadline && pool.state == State.Open;
        bool cancelled = pool.state == State.Cancelled;
        bool unresolved = pool.state != State.Resolved && block.timestamp > pool.resolveDeadline;
        if (!timedOut && !cancelled && !unresolved) revert InvalidState();
        if (pool.state == State.Open || pool.state == State.Live) {
            pool.state = State.Cancelled;
            emit PoolCancelled(poolId);
        }
        uint256 amount;
        if (msg.sender == pool.ownerA && !pool.refundedA) {
            amount = pool.stakeA;
            pool.refundedA = true;
            pool.stakeA = 0;
        } else if (msg.sender == pool.ownerB && !pool.refundedB) {
            amount = pool.stakeB;
            pool.refundedB = true;
            pool.stakeB = 0;
        } else {
            revert NotOwner();
        }
        if (amount == 0) revert NothingToClaim();
        _pay(msg.sender, amount);
        emit StakeRefunded(poolId, msg.sender, amount);
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
