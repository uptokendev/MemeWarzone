// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title EventPrizeVaultV1
 * @notice Chain-level sponsorship prize custody with event-separated native balances.
 *         The sponsorship router credits events; configured event receivers pull prizes.
 */
contract EventPrizeVaultV1 is Ownable, ReentrancyGuard {
    uint256 public constant GENERATION = 1;

    address public router;
    bool public depositsPaused;

    mapping(bytes32 => address) public eventReceivers;
    mapping(bytes32 => uint256) public eventBalances;

    event RouterUpdated(address indexed router);
    event DepositsPaused(bool paused);
    event EventReceiverUpdated(bytes32 indexed eventId, address indexed receiver);
    event EventPrizeCredited(bytes32 indexed eventId, address indexed source, uint256 amount, uint256 newBalance);
    event EventPrizeClaimed(bytes32 indexed eventId, address indexed receiver, uint256 amount);

    error ZeroAddress();
    error Unauthorized();
    error InvalidAmount();
    error InvalidEvent();
    error DepositsArePaused();
    error NothingToClaim();
    error TransferFailed();

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    receive() external payable {
        revert InvalidAmount();
    }

    function setRouter(address router_) external onlyOwner {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;
        emit RouterUpdated(router_);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function setEventReceiver(bytes32 eventId, address receiver) external onlyOwner {
        if (eventId == bytes32(0)) revert InvalidEvent();
        if (receiver == address(0)) revert ZeroAddress();
        eventReceivers[eventId] = receiver;
        emit EventReceiverUpdated(eventId, receiver);
    }

    function depositForEvent(bytes32 eventId) external payable {
        if (depositsPaused) revert DepositsArePaused();
        if (msg.sender != router) revert Unauthorized();
        if (eventId == bytes32(0) || eventReceivers[eventId] == address(0)) revert InvalidEvent();
        if (msg.value == 0) revert InvalidAmount();
        eventBalances[eventId] += msg.value;
        emit EventPrizeCredited(eventId, msg.sender, msg.value, eventBalances[eventId]);
    }

    function claimEventPrize(bytes32 eventId) external nonReentrant {
        address receiver = eventReceivers[eventId];
        if (receiver == address(0) || msg.sender != receiver) revert Unauthorized();
        uint256 amount = eventBalances[eventId];
        if (amount == 0) revert NothingToClaim();
        eventBalances[eventId] = 0;
        (bool ok, ) = payable(receiver).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit EventPrizeClaimed(eventId, receiver, amount);
    }
}
