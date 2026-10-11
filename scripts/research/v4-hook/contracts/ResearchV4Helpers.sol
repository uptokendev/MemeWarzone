// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY helpers for the fork proof:
//   V4DirectTrader  - how bots trade: their own PoolManager.unlock callback, no router
//   V4PlainSeeder   - a hookless pool with the same A/B shape, for the gas baseline
//   V4Attacker      - tries outside add / remove / donate / initialize against the hooked pool

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
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

    /// Hookless pool, static LP fee 0, same spacing and the same one-sided A/B ranges.
    function seed(address token, int24 spacing, int24 tickStart, int24 tickGrad, uint256 coinsA, uint256 coinsB)
        external
        returns (PoolKey memory key)
    {
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

    /// Outside liquidity add: one-sided coins at a price above the current one (no native needed).
    function tryAdd(PoolKey calldata key, int24 lower, int24 upper, uint128 liq) external payable {
        pm.unlock(abi.encode(ADD, key, lower, upper, int256(uint256(liq))));
    }

    /// Remove liquidity from the same ranges the hook owns (positions are keyed by owner, so this
    /// can only ever touch the attacker's own, empty, position).
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

/// A creator that is a contract and rejects native (no receive / fallback). It can still accept creator
/// rights and claim its fees to any EOA.
interface IMwzHookCreatorRights {
    function acceptCreator(bytes32 id) external;
    function claimCreator(bytes32 id, address to) external returns (uint256);
}

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
