// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Robinhood Testnet ETH/USD AggregatorV3-compatible oracle
/// @notice Testnet-only price feed for MemeWarzone Robinhood chain-46630 staging infrastructure.
/// @dev This contract intentionally refuses Robinhood production chain 4663. Local chain 31337 is
///      permitted only when the constructor explicitly enables rehearsal mode for deterministic CI.
contract RobinhoodTestnetEthUsdOracle {
    uint256 public constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;
    uint256 public constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    uint256 public constant LOCAL_REHEARSAL_CHAIN_ID = 31337;
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;
    string public constant description = "ETH / USD - Robinhood Testnet 46630";
    string public constant SOURCE_VERSION = "mwz-rh46630-eth-usd-aggregator-v1";

    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    error WrongChain(uint256 chainId);
    error ZeroUpdater();
    error UnauthorizedUpdater(address caller);
    error InvalidAnswer(int256 answer);
    error RoundUnavailable(uint80 roundId);

    address public immutable updater;
    uint256 public immutable certifiedChainId;
    bool public immutable localRehearsal;

    uint80 private _latestRoundId;
    mapping(uint80 => Round) private _rounds;

    event AnswerUpdated(uint80 indexed roundId, int256 answer, uint256 updatedAt, address indexed updater);

    constructor(address updater_, int256 initialAnswer, bool allowLocalRehearsal) {
        if (updater_ == address(0)) revert ZeroUpdater();
        if (initialAnswer <= 0) revert InvalidAnswer(initialAnswer);
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid);

        bool localAllowed = allowLocalRehearsal && block.chainid == LOCAL_REHEARSAL_CHAIN_ID;
        if (block.chainid != ROBINHOOD_TESTNET_CHAIN_ID && !localAllowed) revert WrongChain(block.chainid);

        updater = updater_;
        certifiedChainId = block.chainid;
        localRehearsal = localAllowed;
        _writeRound(initialAnswer);
    }

    modifier onlyUpdater() {
        if (msg.sender != updater) revert UnauthorizedUpdater(msg.sender);
        _;
    }

    /// @notice Publish a new positive ETH/USD answer. Every update creates a fresh monotonically increasing round.
    function updateAnswer(int256 newAnswer) external onlyUpdater returns (uint80 roundId) {
        if (newAnswer <= 0) revert InvalidAnswer(newAnswer);
        roundId = _writeRound(newAnswer);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        roundId = _latestRoundId;
        Round memory round = _rounds[roundId];
        return (roundId, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
    }

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory round = _rounds[roundId];
        if (round.updatedAt == 0) revert RoundUnavailable(roundId);
        return (roundId, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
    }

    function _writeRound(int256 answer) private returns (uint80 roundId) {
        roundId = _latestRoundId + 1;
        _latestRoundId = roundId;
        uint256 timestamp = block.timestamp;
        _rounds[roundId] = Round({answer: answer, startedAt: timestamp, updatedAt: timestamp, answeredInRound: roundId});
        emit AnswerUpdated(roundId, answer, timestamp, msg.sender);
    }
}
