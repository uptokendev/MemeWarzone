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
 * Boosts are founder-locked to $1 units. Native-chain payment amounts therefore
 * require a short-lived signed quote binding the unit count to a native raw price.
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
    bytes32 public constant RESOLVE_PLACES_TYPEHASH = keccak256(
        "ResolvePoolPlacesV2(bytes32 poolId,bytes32 placesHash,uint256 stakeTotal,uint256 buyInTotal,uint256 boostTotal,uint256 deadline)"
    );
    bytes32 public constant BOOST_QUOTE_TYPEHASH = keccak256(
        "BoostQuote(bytes32 poolId,bytes32 matchId,uint256 roundNumber,address booster,address sideToken,uint256 boostUnits,uint256 unitPriceNativeRaw,uint256 grossNativeRaw,uint256 pricingVersion,uint256 oracleTimestamp,uint256 nonce,uint256 deadline)"
    );

    uint256 public constant GENERATION = 2;
    uint256 public constant ENTRY_LEAGUE_BPS = 2_000;
    uint256 public constant ENTRY_PROTOCOL_BPS = 500;
    uint256 public constant BOOST_PROTOCOL_BPS = 1_000;
    uint256 public constant BPS_DENOM = 10_000;
    /// Tournament places: 1st, 2nd, runner-up.
    uint8 public constant MAX_PLACES = 3;
    uint256 public constant USD_MICROS_PER_NATIVE_DENOM = 1e18;

    struct Places {
        uint8 count;
        address[3] payouts;
        uint256[3] pending;
        bool[3] claimed;
    }
    mapping(bytes32 => Places) internal placesByPool;

    /// Protocol fees fill the operator wallet up to a USD cap; everything
    /// above the cap goes to protocolReceiver (the multisig). Same rule as the
    /// Solana treasury's route_state. nativeUsdMicros = USD per 1 native * 1e6.
    address public operatorReceiver;
    uint256 public operatorCapUsdMicros;
    uint256 public operatorFilledUsdMicros;
    uint256 public nativeUsdMicros;

    mapping(bytes32 => Pool) public pools;
    mapping(bytes32 => mapping(address => uint256)) public buyIns;
    /// Who funded a Boost and how much, so an expired pool can return it.
    /// boostTotal alone is an aggregate; it cannot tell you who to pay.
    mapping(bytes32 => mapping(address => uint256)) public boosts;
    mapping(bytes32 => mapping(address => uint256)) public tournamentRefunds;
    mapping(address => bool) public authorizedCreators;
    mapping(address => mapping(uint256 => bool)) public usedBoostNonces;

    address public resolver;
    address public boostQuoteSigner;
    address public protocolReceiver;
    IPostGradLeagueTreasuryV2 public postGradLeagueTreasury;
    bool public depositsPaused;

    event CreatorAuthorized(address indexed creator, bool allowed);
    event ResolverUpdated(address indexed resolver);
    event BoostQuoteSignerUpdated(address indexed signer);
    event ReceiversUpdated(address indexed protocolReceiver, address indexed postGradLeagueTreasury);
    event DepositsPaused(bool paused);
    event PoolOpened(bytes32 indexed poolId, Kind kind, address ownerA, address ownerB, uint256 stakeAmount, uint256 buyInAmount);
    event StakeDeposited(bytes32 indexed poolId, address indexed owner, uint256 amount);
    event BuyInDeposited(bytes32 indexed poolId, address indexed owner, uint256 amount);
    event PoolLive(bytes32 indexed poolId);
    event BattleBoosted(
        bytes32 indexed poolId,
        address indexed booster,
        address indexed sideToken,
        uint256 boostUnits,
        uint256 unitPriceNativeRaw,
        uint256 grossNativeRaw,
        uint256 pricingVersion,
        uint256 oracleTimestamp,
        uint256 nonce
    );
    event TournamentBoosted(
        bytes32 indexed poolId,
        bytes32 indexed matchId,
        uint256 indexed roundNumber,
        address booster,
        address sideToken,
        uint256 boostUnits,
        uint256 unitPriceNativeRaw,
        uint256 grossNativeRaw,
        uint256 pricingVersion,
        uint256 oracleTimestamp,
        uint256 nonce
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
    event PoolExpired(bytes32 indexed poolId, uint256 resolveDeadline);
    event BoostRefunded(bytes32 indexed poolId, address indexed funder, uint256 amount);
    event PlacesResolved(bytes32 indexed poolId, address[] payouts, uint256[] amounts, uint256 pendingProtocol, uint256 pendingLeague);
    event OperatorFillUpdated(address indexed operator, uint256 capUsdMicros, uint256 nativeUsdMicros);
    event OperatorFilled(bytes32 indexed poolId, uint256 toOperator, uint256 toProtocol, uint256 filledUsdMicros);
    event Claimed(bytes32 indexed poolId, bytes32 bucket, address indexed to, uint256 amount);
    event StakeRefunded(bytes32 indexed poolId, address indexed owner, uint256 amount);
    event BuyInRefunded(bytes32 indexed poolId, address indexed owner, uint256 amount);

    error ZeroAddress();
    error Unauthorized();
    error InvalidState();
    error InvalidAmount();
    error DeadlinePassed();
    error DeadlineNotPassed();
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
    error Replay();
    error InvalidBoostQuote();
    error InvalidPlaces();
    error InvalidPlace();

    modifier onlyCreator() {
        if (!authorizedCreators[msg.sender] && msg.sender != owner()) revert Unauthorized();
        _;
    }

    constructor(
        address initialOwner,
        address resolver_,
        address boostQuoteSigner_,
        address protocolReceiver_,
        address postGradLeagueTreasury_
    ) Ownable(initialOwner) EIP712("ArenaWarPoolTreasury", "2") {
        if (
            initialOwner == address(0) ||
            resolver_ == address(0) ||
            boostQuoteSigner_ == address(0) ||
            protocolReceiver_ == address(0) ||
            postGradLeagueTreasury_ == address(0)
        ) revert ZeroAddress();
        resolver = resolver_;
        boostQuoteSigner = boostQuoteSigner_;
        protocolReceiver = protocolReceiver_;
        postGradLeagueTreasury = IPostGradLeagueTreasuryV2(postGradLeagueTreasury_);
        authorizedCreators[initialOwner] = true;
        emit CreatorAuthorized(initialOwner, true);
        emit ResolverUpdated(resolver_);
        emit BoostQuoteSignerUpdated(boostQuoteSigner_);
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

    function setBoostQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        boostQuoteSigner = signer;
        emit BoostQuoteSignerUpdated(signer);
    }

    function setReceivers(address protocolReceiver_, address postGradLeagueTreasury_) external onlyOwner {
        if (protocolReceiver_ == address(0) || postGradLeagueTreasury_ == address(0)) revert ZeroAddress();
        protocolReceiver = protocolReceiver_;
        postGradLeagueTreasury = IPostGradLeagueTreasuryV2(postGradLeagueTreasury_);
        emit ReceiversUpdated(protocolReceiver_, postGradLeagueTreasury_);
    }

    /// operator_ may be zero to send every protocol lamport to protocolReceiver.
    function setOperatorFill(address operator_, uint256 capUsdMicros, uint256 nativeUsdMicros_) external onlyOwner {
        operatorReceiver = operator_;
        operatorCapUsdMicros = capUsdMicros;
        nativeUsdMicros = nativeUsdMicros_;
        emit OperatorFillUpdated(operator_, capUsdMicros, nativeUsdMicros_);
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

    function boostBattle(
        bytes32 poolId,
        address sideToken,
        uint256 boostUnits,
        uint256 unitPriceNativeRaw,
        uint256 pricingVersion,
        uint256 oracleTimestamp,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.kind != Kind.Battle || pool.state != State.Live) revert InvalidState();
        if (sideToken == address(0)) revert InvalidReference();

        uint256 grossNativeRaw = _consumeBoostQuote(
            poolId,
            bytes32(0),
            0,
            sideToken,
            boostUnits,
            unitPriceNativeRaw,
            pricingVersion,
            oracleTimestamp,
            nonce,
            deadline,
            signature
        );
        pool.boostTotal += grossNativeRaw;
        boosts[poolId][msg.sender] += grossNativeRaw;
        emit BattleBoosted(
            poolId,
            msg.sender,
            sideToken,
            boostUnits,
            unitPriceNativeRaw,
            grossNativeRaw,
            pricingVersion,
            oracleTimestamp,
            nonce
        );
    }

    function boostTournament(
        bytes32 poolId,
        bytes32 matchId,
        uint256 roundNumber,
        address sideToken,
        uint256 boostUnits,
        uint256 unitPriceNativeRaw,
        uint256 pricingVersion,
        uint256 oracleTimestamp,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.kind != Kind.Tournament || pool.state != State.Live) revert InvalidState();
        if (matchId == bytes32(0) || roundNumber == 0 || sideToken == address(0)) revert InvalidReference();

        uint256 grossNativeRaw = _consumeBoostQuote(
            poolId,
            matchId,
            roundNumber,
            sideToken,
            boostUnits,
            unitPriceNativeRaw,
            pricingVersion,
            oracleTimestamp,
            nonce,
            deadline,
            signature
        );
        pool.boostTotal += grossNativeRaw;
        boosts[poolId][msg.sender] += grossNativeRaw;
        emit TournamentBoosted(
            poolId,
            matchId,
            roundNumber,
            msg.sender,
            sideToken,
            boostUnits,
            unitPriceNativeRaw,
            grossNativeRaw,
            pricingVersion,
            oracleTimestamp,
            nonce
        );
    }

    /// @notice Release a pool nobody ever joined, once its deposit window closed.
    /// @dev Permissionless and deadline-gated, with no discretionary override.
    /// It used to let pool.ownerA or the owner cancel before the deadline, which
    /// on a tournament meant its creator could close a pool already holding other
    /// people's entry fees whenever they liked. Refunds meant nothing could be
    /// stolen, but the power itself is the thing: an opponent who is still within
    /// the window should not be cancellable, and no key should be able to end a
    /// contest early. The only exits are now this and settleExpiredPool, both
    /// acting on deadlines fixed when the pool opened.
    function cancelOpenPool(bytes32 poolId) external {
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.state != State.Open) revert InvalidState();
        if (block.timestamp <= pool.depositDeadline) revert DeadlineNotPassed();
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
        _claimFirstPlace(poolId);
    }

    function _claimFirstPlace(bytes32 poolId) internal {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Resolved) revert InvalidState();
        if (msg.sender != pool.winnerPayout) revert NotOwner();
        uint256 amount = pool.pendingWinner;
        if (amount == 0 || pool.claimedWinner) revert NothingToClaim();
        pool.claimedWinner = true;
        pool.pendingWinner = 0;
        Places storage places = placesByPool[poolId];
        places.claimed[0] = true;
        places.pending[0] = 0;
        _pay(msg.sender, amount);
        emit Claimed(poolId, "winner", msg.sender, amount);
    }

    /// Places 1-3 (1-based). Place 1 is the same payout claimWinner pays.
    function claimPlace(bytes32 poolId, uint8 place) external nonReentrant {
        if (place == 1) {
            _claimFirstPlace(poolId);
            return;
        }
        Pool storage pool = pools[poolId];
        if (pool.state != State.Resolved) revert InvalidState();
        Places storage places = placesByPool[poolId];
        if (place == 0 || place > places.count) revert InvalidPlace();
        uint256 idx = place - 1;
        if (msg.sender != places.payouts[idx]) revert NotOwner();
        uint256 amount = places.pending[idx];
        if (amount == 0 || places.claimed[idx]) revert NothingToClaim();
        places.claimed[idx] = true;
        places.pending[idx] = 0;
        _pay(msg.sender, amount);
        emit Claimed(poolId, bytes32(uint256(0x706c616365) << 8 | place), msg.sender, amount);
    }

    function placeOf(bytes32 poolId, uint8 place) external view returns (address payout, uint256 pending, bool claimed) {
        Places storage places = placesByPool[poolId];
        if (place == 0 || place > places.count) revert InvalidPlace();
        uint256 idx = place - 1;
        if (idx == 0) {
            Pool storage pool = pools[poolId];
            return (pool.winnerPayout, pool.pendingWinner, pool.claimedWinner);
        }
        return (places.payouts[idx], places.pending[idx], places.claimed[idx]);
    }

    function placeCount(bytes32 poolId) external view returns (uint8) {
        return placesByPool[poolId].count;
    }

    /// Tournament resolution with 1-3 paid places. The resolver signs the
    /// place list (placesHash = keccak256(abi.encode(payouts, bps))); the
    /// prize (entries + boosts after the fixed league/protocol shares) is split
    /// by bps with the rounding remainder on first place, so nothing strands.
    function resolvePlaces(
        bytes32 poolId,
        address[] calldata payouts,
        uint16[] calldata bps,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.kind != Kind.Tournament || pool.state != State.Live) revert InvalidState();
        if (block.timestamp > deadline) revert SignatureExpired();
        uint256 count = payouts.length;
        if (count == 0 || count > MAX_PLACES || bps.length != count) revert InvalidPlaces();
        uint256 bpsTotal;
        for (uint256 i = 0; i < count; i++) {
            if (payouts[i] == address(0) || bps[i] == 0) revert InvalidPlaces();
            if (buyIns[poolId][payouts[i]] == 0) revert InvalidPlaces();
            for (uint256 j = 0; j < i; j++) {
                if (payouts[j] == payouts[i]) revert InvalidPlaces();
            }
            bpsTotal += bps[i];
        }
        if (bpsTotal != BPS_DENOM) revert InvalidPlaces();

        uint256 stakeTotal = pool.stakeA + pool.stakeB;
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESOLVE_PLACES_TYPEHASH,
                    poolId,
                    keccak256(abi.encode(payouts, bps)),
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
        uint256 boostProtocol = (pool.boostTotal * BOOST_PROTOCOL_BPS) / BPS_DENOM;
        uint256 prize = (entryGross - entryLeague - entryProtocol) + (pool.boostTotal - boostProtocol);

        uint256[] memory amounts = new uint256[](count);
        uint256 others;
        for (uint256 i = 1; i < count; i++) {
            amounts[i] = (prize * bps[i]) / BPS_DENOM;
            others += amounts[i];
        }
        amounts[0] = prize - others;

        pool.state = State.Resolved;
        pool.winnerPayout = payouts[0];
        pool.pendingWinner = amounts[0];
        pool.pendingProtocol = entryProtocol + boostProtocol;
        pool.pendingLeague = entryLeague;
        Places storage places = placesByPool[poolId];
        places.count = uint8(count);
        for (uint256 i = 0; i < count; i++) {
            places.payouts[i] = payouts[i];
            places.pending[i] = amounts[i];
            places.claimed[i] = false;
        }
        emit PoolResolved(poolId, payouts[0], amounts[0], pool.pendingProtocol, pool.pendingLeague, entryGross, pool.boostTotal);
        emit PlacesResolved(poolId, payouts, amounts, pool.pendingProtocol, pool.pendingLeague);
    }

    function claimProtocol(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Resolved) revert InvalidState();
        uint256 amount = pool.pendingProtocol;
        if (amount == 0 || pool.claimedProtocol) revert NothingToClaim();
        pool.claimedProtocol = true;
        pool.pendingProtocol = 0;
        (uint256 toOperator, uint256 toProtocol) = _splitOperatorFill(amount);
        if (toOperator > 0) {
            _pay(operatorReceiver, toOperator);
            emit Claimed(poolId, "operator", operatorReceiver, toOperator);
        }
        if (toProtocol > 0) {
            _pay(protocolReceiver, toProtocol);
            emit Claimed(poolId, "protocol", protocolReceiver, toProtocol);
        }
        emit OperatorFilled(poolId, toOperator, toProtocol, operatorFilledUsdMicros);
    }

    /// Mirrors the Solana treasury's split_operator_fill: the operator takes
    /// the share that fits under its remaining USD cap, the rest goes on.
    function _splitOperatorFill(uint256 amount) internal returns (uint256 toOperator, uint256 toProtocol) {
        if (operatorReceiver == address(0) || nativeUsdMicros == 0 || operatorFilledUsdMicros >= operatorCapUsdMicros) {
            return (0, amount);
        }
        uint256 amountUsd = (amount * nativeUsdMicros) / USD_MICROS_PER_NATIVE_DENOM;
        if (amountUsd == 0) return (0, amount);
        uint256 remainingUsd = operatorCapUsdMicros - operatorFilledUsdMicros;
        uint256 takeUsd = amountUsd < remainingUsd ? amountUsd : remainingUsd;
        toOperator = (amount * takeUsd) / amountUsd;
        toProtocol = amount - toOperator;
        operatorFilledUsdMicros += takeUsd;
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

    /// @notice Release a pool that went Live and was never resolved.
    /// @dev Permissionless and time-gated: the only thing it can do is act on a
    /// resolveDeadline the pool has carried since it opened. Once both sides are
    /// in, a battle or a tournament runs to a winner -- no owner, resolver or
    /// operator can end one early, and cancelOpenPool still only touches Open.
    /// This exists for the other failure: our own resolver never signing. Without
    /// it, stakes, buy-ins and Boosts would sit here permanently, and being
    /// permissionless means nobody can hold them by doing nothing either.
    function settleExpiredPool(bytes32 poolId) external {
        Pool storage pool = pools[poolId];
        if (pool.ownerA == address(0)) revert UnknownPool();
        if (pool.state != State.Live) revert InvalidState();
        if (block.timestamp <= pool.resolveDeadline) revert DeadlineNotPassed();
        pool.state = State.Cancelled;
        emit PoolExpired(poolId, pool.resolveDeadline);
        emit PoolCancelled(poolId);
    }

    /// @notice Take back a Boost from a pool that ended without a winner.
    /// @dev Boosts can only be funded while Live, and until settleExpiredPool
    /// existed a Live pool could only ever resolve -- so there was nothing to
    /// refund and no record of who to refund. Both halves arrive together: the
    /// per-wallet record above, and this.
    function refundBoost(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.state != State.Cancelled) revert InvalidState();
        uint256 amount = boosts[poolId][msg.sender];
        if (amount == 0) revert NothingToClaim();
        boosts[poolId][msg.sender] = 0;
        pool.boostTotal -= amount;
        _pay(msg.sender, amount);
        emit BoostRefunded(poolId, msg.sender, amount);
    }

    function _consumeBoostQuote(
        bytes32 poolId,
        bytes32 matchId,
        uint256 roundNumber,
        address sideToken,
        uint256 boostUnits,
        uint256 unitPriceNativeRaw,
        uint256 pricingVersion,
        uint256 oracleTimestamp,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal returns (uint256 grossNativeRaw) {
        if (boostUnits == 0 || unitPriceNativeRaw == 0 || pricingVersion == 0) revert InvalidBoostQuote();
        if (deadline < block.timestamp) revert SignatureExpired();
        if (oracleTimestamp == 0 || oracleTimestamp > block.timestamp || oracleTimestamp > deadline) revert InvalidBoostQuote();
        if (usedBoostNonces[msg.sender][nonce]) revert Replay();

        grossNativeRaw = unitPriceNativeRaw * boostUnits;
        if (grossNativeRaw == 0 || msg.value != grossNativeRaw) revert InvalidAmount();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    BOOST_QUOTE_TYPEHASH,
                    poolId,
                    matchId,
                    roundNumber,
                    msg.sender,
                    sideToken,
                    boostUnits,
                    unitPriceNativeRaw,
                    grossNativeRaw,
                    pricingVersion,
                    oracleTimestamp,
                    nonce,
                    deadline
                )
            )
        );
        if (digest.recover(signature) != boostQuoteSigner) revert BadSignature();
        usedBoostNonces[msg.sender][nonce] = true;
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
