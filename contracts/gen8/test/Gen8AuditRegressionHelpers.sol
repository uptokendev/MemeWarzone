// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY. Not part of the gen-8 production scope. Helpers for the 2026-10-12 fix round (F1 to F5, B) and for the
// re-runs of the AI-audit proofs of concept (audit-A bedf8806, audit-D c10ef8a9) against the fixed contracts.
//   ForceGraduator         - A-1 / D-H1: buy to the graduation price and sell back inside ONE unlock (flash
//                            accounting), optionally calling MwzReserveLock.release between the legs
//   UnlockingOwner         - A-2: a hook owner contract that executes the router change from inside an unlock
//   RevertingOperatorSink  - router whose operator() reverts
//   GasBurningOperatorSink - router whose operator() burns all gas it gets
//   ToggleSink             - router that can be switched to refuse native

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

interface IReleasable {
    function release(PoolId id) external returns (uint256);
}

interface IHookOwnerOps {
    function acceptOwnership() external;
    function proposeTreasuryRouter(address next) external;
    function executeTreasuryRouter() external;
}

contract ForceGraduator is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable pm;
    uint256 public lastNetCost;
    uint256 public lastCoinsLeft;
    uint256 public lastBuyIn;
    uint256 public lastSellOut;
    bool public lastReleaseOk;
    bytes public lastReleaseError;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    /// msg.value must cover the NET cost only; the rest is refunded. lock != 0: try release(id) between the legs.
    function run(PoolKey calldata key, uint256 buyIn, uint160 sqrtGrad, uint160 sqrtStart, address lock, bytes32 id) external payable {
        pm.unlock(abi.encode(key, buyIn, sqrtGrad, sqrtStart, msg.sender, lock, id));
        uint256 left = address(this).balance;
        if (left > 0) {
            (bool ok,) = msg.sender.call{value: left}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, uint256 buyIn, uint160 sqrtGrad, uint160 sqrtStart, address user, address lock, bytes32 id) =
            abi.decode(data, (PoolKey, uint256, uint160, uint160, address, address, bytes32));
        BalanceDelta b = pm.swap(key, SwapParams(true, -int256(buyIn), sqrtGrad), "");
        if (lock != address(0)) {
            (bool ok, bytes memory err) = lock.call(abi.encodeCall(IReleasable.release, (PoolId.wrap(id))));
            lastReleaseOk = ok;
            lastReleaseError = err;
        }
        uint256 coins = uint256(uint128(b.amount1()));
        BalanceDelta s = pm.swap(key, SwapParams(false, -int256(coins), sqrtStart), "");
        int256 net0 = int256(b.amount0()) + int256(s.amount0());
        int256 net1 = int256(b.amount1()) + int256(s.amount1());
        lastBuyIn = uint256(uint128(-b.amount0()));
        lastSellOut = uint256(uint128(s.amount0()));
        require(net0 < 0, "round trip made money?");
        lastNetCost = uint256(-net0);
        pm.settle{value: uint256(-net0)}();
        lastCoinsLeft = uint256(net1);
        if (net1 > 0) pm.take(key.currency1, user, uint256(net1));
        return "";
    }

    receive() external payable {}
}

contract UnlockingOwner is IUnlockCallback {
    IPoolManager public immutable pm;
    IHookOwnerOps public immutable hook;

    constructor(IPoolManager _pm, IHookOwnerOps _hook) {
        pm = _pm;
        hook = _hook;
    }

    function accept() external {
        hook.acceptOwnership();
    }

    function propose(address next) external {
        hook.proposeTreasuryRouter(next);
    }

    function executeInsideUnlock() external {
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        hook.executeTreasuryRouter();
        return "";
    }
}

contract RevertingOperatorSink {
    uint256 public received;

    function operator() external pure returns (address) {
        revert("no operator");
    }

    receive() external payable {
        received += msg.value;
    }
}

contract GasBurningOperatorSink {
    uint256 public received;

    function operator() external view returns (address) {
        uint256 i;
        while (gasleft() > 100) i++;
        return address(uint160(i));
    }

    receive() external payable {
        received += msg.value;
    }
}

contract ToggleSink {
    uint256 public received;
    bool public refuse;

    function setRefuse(bool r) external {
        refuse = r;
    }

    receive() external payable {
        require(!refuse, "refused");
        received += msg.value;
    }
}
