// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY. Not part of the gen-8 production scope. Helpers for test/gen8 (local hardhat) and the fork suite.
//   V4DirectTrader     - how bots trade: their own PoolManager.unlock callback, no router (from the research proof)
//   V4PlainSeeder      - a hookless pool with the same A/B shape, for the gas baseline (from the research proof)
//   V4Attacker         - outside add / remove / donate / initialize against the hooked pool (from the research proof)
//   RejectingCreator   - a creator contract without receive(); can accept rights and claim to an EOA
//   ReentrantClaimer   - a creator contract that re-enters the hook from its receive()
//   MockPriceFeed      - Chainlink-style feed for the gen-7 GraduationOracle in local tests
//   NativeSink         - accepts native, counts it
//   RevertingSink      - rejects native
//   MockHolderDistributor - records createBatch calls

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract V4DirectTrader is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable pm;
    address private _user;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    /// amountSpecified < 0: exact input; > 0: exact output. sqrtLimit 0 = no limit.
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 sqrtLimit, bytes calldata hookData)
        external
        payable
        returns (int128 a0, int128 a1)
    {
        _user = msg.sender;
        if (sqrtLimit == 0) sqrtLimit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        bytes memory r = pm.unlock(abi.encode(key, SwapParams(zeroForOne, amountSpecified, sqrtLimit), hookData));
        (a0, a1) = abi.decode(r, (int128, int128));
        _user = address(0);
        uint256 left = address(this).balance;
        if (left > 0) {
            (bool ok,) = msg.sender.call{value: left}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, SwapParams memory p, bytes memory hookData) = abi.decode(data, (PoolKey, SwapParams, bytes));
        BalanceDelta d = pm.swap(key, p, hookData);
        _settle(key.currency0, d.amount0());
        _settle(key.currency1, d.amount1());
        return abi.encode(d.amount0(), d.amount1());
    }

    function _settle(Currency c, int128 amt) internal {
        if (amt < 0) {
            uint256 owe = uint256(uint128(-amt));
            if (c.isAddressZero()) {
                pm.settle{value: owe}();
            } else {
                pm.sync(c);
                IERC20(Currency.unwrap(c)).transferFrom(_user, address(pm), owe);
                pm.settle();
            }
        } else if (amt > 0) {
            pm.take(c, _user, uint256(uint128(amt)));
        }
    }

    receive() external payable {}
}

contract V4PlainSeeder is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    function seed(address token, int24 spacing, int24 tickStart, int24 tickGrad, uint256 coinsA, uint256 coinsB) external returns (PoolKey memory key) {
        key = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(token), 0, spacing, IHooks(address(0)));
        pm.initialize(key, TickMath.getSqrtPriceAtTick(tickStart));
        int24 minTick = TickMath.minUsableTick(spacing);
        uint160 sG = TickMath.getSqrtPriceAtTick(tickGrad);
        uint128 lA = LiquidityAmounts.getLiquidityForAmount1(sG, TickMath.getSqrtPriceAtTick(tickStart), coinsA);
        uint128 lB = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(minTick), sG, coinsB);
        pm.unlock(abi.encode(key, tickGrad, tickStart, minTick, lA, lB));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, int24 tickGrad, int24 tickStart, int24 minTick, uint128 lA, uint128 lB) =
            abi.decode(data, (PoolKey, int24, int24, int24, uint128, uint128));
        (BalanceDelta a,) = pm.modifyLiquidity(key, ModifyLiquidityParams(tickGrad, tickStart, int256(uint256(lA)), 0), "");
        (BalanceDelta b,) = pm.modifyLiquidity(key, ModifyLiquidityParams(minTick, tickGrad, int256(uint256(lB)), 0), "");
        uint256 owe = uint256(uint128(-a.amount1())) + uint256(uint128(-b.amount1()));
        pm.sync(key.currency1);
        IERC20(Currency.unwrap(key.currency1)).transfer(address(pm), owe);
        pm.settle();
        return "";
    }
}

contract V4Attacker is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    uint8 constant ADD = 1;
    uint8 constant REMOVE = 2;
    uint8 constant DONATE = 3;

    function tryAdd(PoolKey calldata key, int24 lower, int24 upper, uint128 liq) external payable {
        pm.unlock(abi.encode(ADD, key, lower, upper, int256(uint256(liq))));
    }

    function tryRemove(PoolKey calldata key, int24 lower, int24 upper, uint128 liq) external {
        pm.unlock(abi.encode(REMOVE, key, lower, upper, -int256(uint256(liq))));
    }

    function tryDonate(PoolKey calldata key) external payable {
        pm.unlock(abi.encode(DONATE, key, int24(0), int24(0), int256(msg.value)));
    }

    function tryInitialize(PoolKey calldata key, uint160 sqrtP) external {
        pm.initialize(key, sqrtP);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (uint8 op, PoolKey memory key, int24 lower, int24 upper, int256 amt) = abi.decode(data, (uint8, PoolKey, int24, int24, int256));
        if (op == DONATE) {
            pm.donate(key, uint256(amt), 0, "");
            pm.settle{value: uint256(amt)}();
            return "";
        }
        (BalanceDelta d,) = pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, amt, 0), "");
        int128 a1 = BalanceDeltaLibrary.amount1(d);
        if (a1 < 0) {
            pm.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).transfer(address(pm), uint256(uint128(-a1)));
            pm.settle();
        }
        return "";
    }

    receive() external payable {}
}

interface IMwzHookCreatorRights {
    function acceptCreator(bytes32 id) external;
    function proposeCreator(bytes32 id, address next) external;
    function claimCreator(bytes32 id, address to) external returns (uint256);
    function claimRouter() external returns (uint256);
}

/// A creator that is a contract and rejects native (no receive / fallback).
contract RejectingCreator {
    address public immutable admin;

    constructor() {
        admin = msg.sender;
    }

    function accept(IMwzHookCreatorRights hook, bytes32 id) external {
        require(msg.sender == admin, "admin");
        hook.acceptCreator(id);
    }

    function claimTo(IMwzHookCreatorRights hook, bytes32 id, address to) external returns (uint256) {
        require(msg.sender == admin, "admin");
        return hook.claimCreator(id, to);
    }
}

/// A creator contract whose receive() tries to re-enter the hook (claimCreator / claimRouter) and records the result.
contract ReentrantClaimer {
    IMwzHookCreatorRights public hook;
    bytes32 public id;
    bool public reentered;
    bool public reentrySucceeded;
    bytes public reentryError;
    uint8 public mode; // 1 claimCreator, 2 claimRouter

    function arm(IMwzHookCreatorRights hook_, bytes32 id_, uint8 mode_) external {
        hook = hook_;
        id = id_;
        mode = mode_;
    }

    function accept() external {
        hook.acceptCreator(id);
    }

    function claim() external returns (uint256) {
        return hook.claimCreator(id, address(this));
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        bytes memory data = mode == 1 ? abi.encodeCall(IMwzHookCreatorRights.claimCreator, (id, address(this))) : abi.encodeCall(IMwzHookCreatorRights.claimRouter, ());
        (bool ok, bytes memory err) = address(hook).call(data);
        reentrySucceeded = ok;
        reentryError = err;
    }
}

contract MockPriceFeed {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        roundId++;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

contract NativeSink {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

contract RevertingSink {
    receive() external payable {
        revert("no native");
    }
}

contract MockHolderDistributor {
    struct Batch {
        bytes32 root;
        uint64 claimDeadline;
        uint256 amount;
    }

    mapping(bytes32 => Batch) public batches;

    function createBatch(bytes32 batchId, bytes32 merkleRoot, uint64 claimDeadline) external payable {
        require(batches[batchId].amount == 0, "exists");
        batches[batchId] = Batch(merkleRoot, claimDeadline, msg.value);
    }
}

/// Minimal CREATE2 deployer (the canonical 0x4e59 proxy is used on forks).
contract Create2Deployer {
    event Deployed(address addr, bytes32 salt);

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        bytes memory code = initCode;
        assembly ("memory-safe") {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(addr != address(0), "create2");
        emit Deployed(addr, salt);
    }
}

/// A display pair stand-in that reverts or burns gas on update (I11 tests use hardhat_setCode instead where possible).
contract BadDisplay {
    uint8 public mode; // 0 revert, 1 burn all gas

    constructor(uint8 mode_) {
        mode = mode_;
    }

    function update(address, address, uint256, uint256, uint256, uint256, uint256, uint256) external view {
        if (mode == 0) revert("bad display");
        while (true) {}
    }
}

/// A payout recipient that, while the PoolManager is unlocked by the hook's own payout, swaps in the same pool from its
/// receive() (sells coins it holds) and settles its own deltas. Proves that a reentrant swap during a payout keeps the
/// hook's accounting exact (audit A14).
contract SwapOnReceive {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable pm;
    PoolKey internal _key;
    uint256 public sellAmount;
    bool public swapped;
    int128 public out0;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    function arm(PoolKey calldata key, uint256 amount) external {
        _key = key;
        sellAmount = amount;
    }

    function accept(IMwzHookCreatorRights hook, bytes32 id) external {
        hook.acceptCreator(id);
    }

    function claim(IMwzHookCreatorRights hook, bytes32 id) external returns (uint256) {
        return hook.claimCreator(id, address(this));
    }

    receive() external payable {
        if (swapped || sellAmount == 0 || msg.sender != address(pm)) return;
        swapped = true;
        BalanceDelta d = pm.swap(_key, SwapParams(false, -int256(sellAmount), TickMath.MAX_SQRT_PRICE - 1), "");
        out0 = d.amount0();
        pm.sync(_key.currency1);
        IERC20(Currency.unwrap(_key.currency1)).transfer(address(pm), uint256(uint128(-d.amount1())));
        pm.settle();
        pm.take(_key.currency0, address(this), uint256(uint128(d.amount0())));
    }
}
