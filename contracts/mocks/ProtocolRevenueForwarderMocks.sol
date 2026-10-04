// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IForwarderUnderTest {
    function flush() external returns (uint256, uint256);
}

/// @notice Test sink for ProtocolRevenueForwarder: exposes `admin()` like ProtocolRevenueVault and can accept,
///         revert, re-enter `flush()` (bubbling or catching the inner revert) or send value back into the
///         forwarder's `receive()` once.
contract ForwarderTestSink {
    uint8 public constant ACCEPT = 0;
    uint8 public constant REVERT = 1;
    uint8 public constant REENTER_FLUSH_BUBBLE = 2;
    uint8 public constant REENTER_FLUSH_CATCH = 3;
    uint8 public constant SEND_BACK_ONCE = 4;

    address public admin;
    address public forwarder;
    uint8 public mode;
    bool private sentBack;
    bytes public lastInnerRevert;
    uint256 public received;
    uint256 public calls;

    constructor(address admin_) {
        admin = admin_;
    }

    function configure(address forwarder_, uint8 mode_) external {
        forwarder = forwarder_;
        mode = mode_;
        sentBack = false;
    }

    receive() external payable {
        calls += 1;
        received += msg.value;
        if (mode == REVERT) revert("SINK_REVERT");
        if (mode == REENTER_FLUSH_BUBBLE) {
            IForwarderUnderTest(forwarder).flush();
        } else if (mode == REENTER_FLUSH_CATCH) {
            try IForwarderUnderTest(forwarder).flush() {} catch (bytes memory reason) {
                lastInnerRevert = reason;
            }
        } else if (mode == SEND_BACK_ONCE && !sentBack) {
            sentBack = true;
            (bool ok, ) = forwarder.call{value: msg.value / 2}("");
            require(ok, "send back failed");
        }
    }
}

/// @notice A sink whose `admin()` does not exist: the forwarder constructor must refuse it.
contract ForwarderSinkWithoutAdmin {
    receive() external payable {}
}

/// @notice Forces native into `target` with selfdestruct (no receive() runs), as anyone could.
contract ForwarderForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
