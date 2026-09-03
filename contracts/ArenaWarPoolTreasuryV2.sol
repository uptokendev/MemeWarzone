// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IPostGradLeagueTreasuryV2 {
    function depositCompetitionShare(bytes32 sourcePool, bytes32 monthlyEpoch, bytes32 quarterlyEpoch) external payable;
}

/**
 * @title ArenaWarPoolTreasuryV2
 * @notice Versioned Arena competition treasury for new Battle/Tournament pools.
 *
 * Entry/buy-in settlement:
 * 75% competition prize / 20% Post-Grad League / 5% protocol.
 *
 * Paid Boost settlement:
 * 90% competition prize / 10% protocol / 0% League.
 *
 * Historical ArenaWarPoolTreasury V1 is intentionally left untouched.
 */
contract ArenaWarPoolTreasuryV2 is ReentrancyGuard, Ownable, EIP712 {
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
        uint256 boostTotal;
        address winnerPayout;
        uint256 pendingWinner;
        uint256 pendingProtocol;
        uint256 pendingLeague;
        uint256 depositDeadline;
        uint256 resolveDeadline;
        bool claimedWinner;
        bool claimedProtocol;
        bool claimedLeague;
        bool refundedA;
        bool refundedB;
    }

    bytes32 public constant RESOLVE_TYPEHASH = keccak256(
        "ResolvePoolV2(bytes32 poolId,address winnerPayout,uint256 stakeTotal,uint256 buyInTotal,uint256 boostTotal,uint256 deadline)"
    );

    uint256 public constant GENERATION = 2;
    uint256 public constant ENTRY_LEAGUE_BPS = 2_000;
    uint256 public constant ENTRY_PROTOCOL_BPS = 500;
    uint256 public constant BOOST_PROTOCOL_BPS = 1_000;
    uint256 public constant BPS_DENOM = 10_000;

    mapping(bytes32 => Pool) public pools;
    mapping(bytes32 => mapping(address => uint256)) public buyIns;
    mapping(bytes32 => mapping(address => uint256)) public tournamentRefunds;
    mapping(address => bool) public authorizedCreators;

    address public resolver;
    address public protocolReceiver;
    IPostGradLeagueTreasuryV2 public postGradLeagueTreasury;
    bool public depositsPaused;

    event CreatorAuthorized(address indexed creator, bool allowed);
    event ResolverUpdated(address indexed resolver);
    event ReceiversUpdated(address indexed protocolReceiver, address indexed postGradLeagueTreasury);
    event DepositsPaused(bool paused);
    event PoolOpened(bytes32 indexed poolId, Kind kind, address ownerA, address ownerB, uint256 stakeAmount, uint256 buyInAmount);
    event StakeDeposited(bytes32 indexed poolId, address indexed owner, uint256 amount);
    event BuyInDeposited(bytes32 indexed poolId, address indexed owner, uint256 amount);
    event PoolLive(bytes32 indexed poolId);
    event BattleBoosted(bytes32 indexed poolId, address indexed booster, address indexed sideToken, uint256 grossNativeRaw);
    event TournamentBoosted(
        bytes32 indexed poolId,
        bytes32 indexed matchId,
        uint256 indexed roundNumber,
        address booster,
        address sideToken,
        uint256 grossNativeRaw
    );
    event PoolResolved(
        bytes32 indexed poolId,
        address indexed winnerPayout,
        uint256 pendingWinner,
        uint256 pendingProtocol,
        uint256 pendingLeague,
        uint256 entryGross,
        uint256 boostGross
    );
    event PoolCancelled(bytes32 indexed poolId);
    event Claimed(bytes32 indexed poolId, bytes32 bucket, address indexed to, uint256 amount);
    event StakeRefunded(bytes32 indexed poolId, address indexed owner, uint256 amount);
    event BuyInRefunded(bytes32 indexed poolId, address indexed owner, uint256 amount);

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
    error WinnerRequired();
    error InvalidReference();

    modifier onlyCreator() {
        if (!authorizedCreators[msg.sender] && msg.sender != owner()) revert Unauthorized();
        _;
    }

    constructor(
        address initialOwner,
        address resolver_,
        address protocolReceiver_,
        address postGradLeagueTreasury_
    ) Ownable(initialOwner) EIP712("ArenaWarPoolTreasury", "2") {
        if (
            initialOwner == address(0) ||
            resolver_ == address(0) ||
            protocolReceiver_ == address(0) ||
            postGradLeagueTreasury_ == address(0)
        ) revert ZeroAddress();
        resolver = resolver_;
        protocolReceiver = protocolReceiver_;
        postGradLeagueTreasury = IPostGradLeagueTreasuryV2(postGradLeagueTreasury_);
        authorizedCreators[initialOwner] = true;
        emit CreatorAuthorized(initialOwner, true);
        emit ResolverUpdated(resolver_);
        emit ReceiversUpdated(protocolReceiver_, postGradLeagueTreasury_);
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

    function setReceivers(address protocolReceiver_, address postGradLeagueTreasury_) external onlyOwner {
        if (protocolReceiver_ == address(0) || postGradLeagueTreasury_ == address(0)) revert ZeroAddress();
        protocolReceiver = protocolReceiver_;
        postGradLeagueTreasury = IPostGradLeagueTreasuryV2(postGradLeagueTreasury_);
        emit ReceiversUpdated(protocolReceiver_, postGradLeagueTreasury_);
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
        if (poolId == bytes32(0)) revert InvalidReference();
        if (depositDeadline <= block.timestamp || resolveDeadline <= depositDeadline) revert DeadlinePassed();
        Pool storage pool = pools[poolId];
        if (pool.ownerA != address(0)) revert PoolExists();

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
        if (pool.kind != Kind.Tournament || pool.state != State.Open) revert InvalidState();
        if (block.timestamp > pool.depositDeadline) revert DeadlinePassed();
        if (pool.buyInAmount == 0 || msg.value != pool.buyInAmount) revert InvalidAmount();
        if (buyIns[poolId][msg.sender] != 0) revert AlreadyDeposited();

        buyIns[poolId][msg.sender] = msg.value;
        pool.buyInTotal += msg.value;
        emit BuyInDeposited(poolId, msg.sender, msg.value);
    }

    function setTournamentLive(bytes32 poolId) external onlyCreator {
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.kind != Kind.Tournament || pool.state != State.Open) revert InvalidState();
        if (msg.sender != pool.ownerA && msg.sender != owner()) revert Unauthorized();
        pool.state = State.Live;
        emit PoolLive(poolId);
    }

    function boostBattle(bytes32 poolId, address sideToken) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.kind != Kind.Battle || pool.state != State.Live) revert InvalidState();
        if (sideToken == address(0) || msg.value == 0) revert InvalidAmount();
        pool.boostTotal += msg.value;
        emit BattleBoosted(poolId, msg.sender, sideToken, msg.value);
    }

    function boostTournament(
        bytes32 poolId,
        bytes32 matchId,
        uint256 roundNumber,
        address sideToken
    ) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.kind != Kind.Tournament || pool.state != State.Live) revert InvalidState();
        if (matchId == bytes32(0) || roundNumber == 0 || sideToken == address(0) || msg.value == 0) revert InvalidReference();
        pool.boostTotal += msg.value;
        emit TournamentBoosted(poolId, matchId, roundNumber, msg.sender, sideToken, msg.value);
    }

    function cancelOpenPool(bytes32 poolId) external {
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.state != State.Open) revert InvalidState();
        bool expired = block.timestamp > pool.depositDeadline;
        bool authorized = msg.sender == pool.ownerA || msg.sender == owner();
        if (!expired && !authorized) revert Unauthorized();
        pool.state = State.Cancelled;
        emit PoolCancelled(poolId);
    }

    function resolve(
        bytes32 poolId,
        address winnerPayout,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.state != State.Live) revert InvalidState();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (winnerPayout == address(0)) revert WinnerRequired();

        uint256 stakeTotal = pool.stakeA + pool.stakeB;
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESOLVE_TYPEHASH,
                    poolId,
                    winnerPayout,
                    stakeTotal,
                    pool.buyInTotal,
                    pool.boostTotal,
                    deadline
                )
            )
        );
        if (digest.recover(signature) != resolver) revert BadSignature();

        uint256 entryGross = stakeTotal + pool.buyInTotal;
        uint256 entryLeague = (entryGross * ENTRY_LEAGUE_BPS) / BPS_DENOM;
        uint256 entryProtocol = (entryGross * ENTRY_PROTOCOL_BPS) / BPS_DENOM;
        uint256 entryPrize = entryGross - entryLeague - entryProtocol;

        uint256 boostProtocol = (pool.boostTotal * BOOST_PROTOCOL_BPS) / BPS_DENOM;
        uint256 boostPrize = pool.boostTotal - boostProtocol;

        pool.state = State.Resolved;
        pool.winnerPayout = winnerPayout;
        pool.pendingWinner = entryPrize + boostPrize;
        pool.pendingProtocol = entryProtocol + boostProtocol;
        pool.pendingLeague = entryLeague;

        emit PoolResolved(
            poolId,
            winnerPayout,
            pool.pendingWinner,
            pool.pendingProtocol,
            pool.pendingLeague,
            entryGross,
            pool.boostTotal
        );
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

    function claimLeague(bytes32 poolId, bytes32 monthlyEpoch, bytes32 quarterlyEpoch) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Resolved) revert InvalidState();
        if (monthlyEpoch == bytes32(0) || quarterlyEpoch == bytes32(0)) revert InvalidReference();
        uint256 amount = pool.pendingLeague;
        if (amount == 0 || pool.claimedLeague) revert NothingToClaim();
        pool.claimedLeague = true;
        pool.pendingLeague = 0;
        postGradLeagueTreasury.depositCompetitionShare{value: amount}(poolId, monthlyEpoch, quarterlyEpoch);
        emit Claimed(poolId, "league", address(postGradLeagueTreasury), amount);
    }

    function refundStake(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Cancelled || pool.kind != Kind.Battle) revert InvalidState();
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

    function refundBuyIn(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Cancelled || pool.kind != Kind.Tournament) revert InvalidState();
        uint256 amount = buyIns[poolId][msg.sender];
        if (amount == 0 || tournamentRefunds[poolId][msg.sender] != 0) revert NothingToClaim();
        tournamentRefunds[poolId][msg.sender] = amount;
        buyIns[poolId][msg.sender] = 0;
        pool.buyInTotal -= amount;
        _pay(msg.sender, amount);
        emit BuyInRefunded(poolId, msg.sender, amount);
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
