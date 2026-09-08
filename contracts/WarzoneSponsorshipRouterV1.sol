// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IEventPrizeVaultV1 {
    function depositForEvent(bytes32 eventId) external payable;
}

/**
 * @title WarzoneSponsorshipRouterV1
 * @notice Native-chain event sponsorship router. A trusted quote signer binds the
 *         event, sponsor, tier/version, USD reference snapshot, native quote,
 *         oracle timestamp, nonce and expiry. Payments split 70/20/10.
 */
contract WarzoneSponsorshipRouterV1 is Ownable, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

    uint256 public constant GENERATION = 1;
    uint256 public constant EVENT_BPS = 7_000;
    uint256 public constant MARKETING_BPS = 2_000;
    uint256 public constant BPS_DENOM = 10_000;

    bytes32 public constant SPONSORSHIP_QUOTE_TYPEHASH = keccak256(
        "SponsorshipQuote(bytes32 eventId,address sponsor,bytes32 pricingTier,uint256 pricingVersion,uint256 minimumUsdMicros,uint256 requestedUsdMicros,uint256 minimumNativeRaw,uint256 requestedNativeRaw,uint256 nativeUsdReferenceMicros,uint256 oracleTimestamp,uint256 nonce,uint256 deadline)"
    );

    address public quoteSigner;
    address public marketingReceiver;
    address public protocolReceiver;
    IEventPrizeVaultV1 public eventPrizeVault;
    bool public paymentsPaused;

    mapping(bytes32 => bool) public enabledEvents;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    event QuoteSignerUpdated(address indexed signer);
    event ReceiversUpdated(address indexed marketingReceiver, address indexed protocolReceiver);
    event EventPrizeVaultUpdated(address indexed vault);
    event EventEnabled(bytes32 indexed eventId, bool enabled);
    event PaymentsPaused(bool paused);
    event SponsorshipPaid(
        bytes32 indexed eventId,
        address indexed sponsor,
        uint256 indexed nonce,
        bytes32 pricingTier,
        uint256 pricingVersion,
        uint256 minimumUsdMicros,
        uint256 requestedUsdMicros,
        uint256 nativeUsdReferenceMicros,
        uint256 oracleTimestamp,
        uint256 grossNativeRaw,
        uint256 eventNativeRaw,
        uint256 marketingNativeRaw,
        uint256 protocolNativeRaw
    );

    error ZeroAddress();
    error InvalidEvent();
    error InvalidAmount();
    error InvalidQuote();
    error QuoteExpired();
    error BadSignature();
    error Replay();
    error PaymentsArePaused();
    error TransferFailed();

    constructor(
        address initialOwner,
        address quoteSigner_,
        address eventPrizeVault_,
        address marketingReceiver_,
        address protocolReceiver_
    ) Ownable(initialOwner) EIP712("WarzoneSponsorshipRouter", "1") {
        if (
            initialOwner == address(0) ||
            quoteSigner_ == address(0) ||
            eventPrizeVault_ == address(0) ||
            marketingReceiver_ == address(0) ||
            protocolReceiver_ == address(0)
        ) revert ZeroAddress();
        quoteSigner = quoteSigner_;
        eventPrizeVault = IEventPrizeVaultV1(eventPrizeVault_);
        marketingReceiver = marketingReceiver_;
        protocolReceiver = protocolReceiver_;
        emit QuoteSignerUpdated(quoteSigner_);
        emit EventPrizeVaultUpdated(eventPrizeVault_);
        emit ReceiversUpdated(marketingReceiver_, protocolReceiver_);
    }

    receive() external payable {
        revert InvalidAmount();
    }

    function setQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        quoteSigner = signer;
        emit QuoteSignerUpdated(signer);
    }

    function setEventPrizeVault(address vault) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        eventPrizeVault = IEventPrizeVaultV1(vault);
        emit EventPrizeVaultUpdated(vault);
    }

    function setReceivers(address marketingReceiver_, address protocolReceiver_) external onlyOwner {
        if (marketingReceiver_ == address(0) || protocolReceiver_ == address(0)) revert ZeroAddress();
        marketingReceiver = marketingReceiver_;
        protocolReceiver = protocolReceiver_;
        emit ReceiversUpdated(marketingReceiver_, protocolReceiver_);
    }

    function setEventEnabled(bytes32 eventId, bool enabled) external onlyOwner {
        if (eventId == bytes32(0)) revert InvalidEvent();
        enabledEvents[eventId] = enabled;
        emit EventEnabled(eventId, enabled);
    }

    function setPaymentsPaused(bool paused) external onlyOwner {
        paymentsPaused = paused;
        emit PaymentsPaused(paused);
    }

    function paySponsorship(
        bytes32 eventId,
        bytes32 pricingTier,
        uint256 pricingVersion,
        uint256 minimumUsdMicros,
        uint256 requestedUsdMicros,
        uint256 minimumNativeRaw,
        uint256 requestedNativeRaw,
        uint256 nativeUsdReferenceMicros,
        uint256 oracleTimestamp,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable nonReentrant {
        if (paymentsPaused) revert PaymentsArePaused();
        if (!enabledEvents[eventId]) revert InvalidEvent();
        if (deadline < block.timestamp) revert QuoteExpired();
        if (
            pricingTier == bytes32(0) ||
            pricingVersion == 0 ||
            minimumUsdMicros == 0 ||
            requestedUsdMicros < minimumUsdMicros ||
            nativeUsdReferenceMicros == 0 ||
            oracleTimestamp == 0
        ) revert InvalidQuote();
        if (requestedNativeRaw < minimumNativeRaw || minimumNativeRaw == 0 || msg.value != requestedNativeRaw) {
            revert InvalidAmount();
        }
        if (usedNonces[msg.sender][nonce]) revert Replay();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SPONSORSHIP_QUOTE_TYPEHASH,
                    eventId,
                    msg.sender,
                    pricingTier,
                    pricingVersion,
                    minimumUsdMicros,
                    requestedUsdMicros,
                    minimumNativeRaw,
                    requestedNativeRaw,
                    nativeUsdReferenceMicros,
                    oracleTimestamp,
                    nonce,
                    deadline
                )
            )
        );
        if (digest.recover(signature) != quoteSigner) revert BadSignature();

        usedNonces[msg.sender][nonce] = true;

        uint256 marketingAmount = (msg.value * MARKETING_BPS) / BPS_DENOM;
        uint256 protocolAmount = (msg.value * (BPS_DENOM - EVENT_BPS - MARKETING_BPS)) / BPS_DENOM;
        uint256 eventAmount = msg.value - marketingAmount - protocolAmount;

        eventPrizeVault.depositForEvent{value: eventAmount}(eventId);
        _pay(marketingReceiver, marketingAmount);
        _pay(protocolReceiver, protocolAmount);

        emit SponsorshipPaid(
            eventId,
            msg.sender,
            nonce,
            pricingTier,
            pricingVersion,
            minimumUsdMicros,
            requestedUsdMicros,
            nativeUsdReferenceMicros,
            oracleTimestamp,
            msg.value,
            eventAmount,
            marketingAmount,
            protocolAmount
        );
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
