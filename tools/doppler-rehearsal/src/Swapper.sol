// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IPoolManager } from "@v4-core/interfaces/IPoolManager.sol";
import { IUnlockCallback } from "@v4-core/interfaces/callback/IUnlockCallback.sol";
import { PoolKey } from "@v4-core/types/PoolKey.sol";
import { BalanceDelta } from "@v4-core/types/BalanceDelta.sol";
import { Currency } from "@v4-core/types/Currency.sol";
import { TickMath } from "@v4-core/libraries/TickMath.sol";

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * Rehearsal-only swap helper: an exact-input swap on a v4 pool through the PoolManager, native ETH as
 * currency0, paying from and to `msg.sender`. The same path any router takes, with no router fees.
 */
contract Swapper is IUnlockCallback {
    IPoolManager public immutable manager;

    struct Job {
        address payer;
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    constructor(address poolManager) {
        manager = IPoolManager(poolManager);
    }

    /// Returns what the payer received of the other currency.
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external payable returns (uint256 out) {
        bytes memory result = manager.unlock(abi.encode(Job(msg.sender, key, zeroForOne, amountIn)));
        out = abi.decode(result, (uint256));
        if (address(this).balance > 0) payable(msg.sender).transfer(address(this).balance);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "not manager");
        Job memory job = abi.decode(data, (Job));
        BalanceDelta delta = manager.swap(
            job.key,
            IPoolManager.SwapParams({
                zeroForOne: job.zeroForOne,
                amountSpecified: -int256(job.amountIn),
                sqrtPriceLimitX96: job.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        _settle(job.key.currency0, job.payer, d0);
        _settle(job.key.currency1, job.payer, d1);
        uint256 out = uint256(uint128(job.zeroForOne ? d1 : d0));
        return abi.encode(out);
    }

    function _settle(Currency currency, address payer, int128 amount) internal {
        if (amount < 0) {
            uint256 owe = uint256(uint128(-amount));
            if (currency.isAddressZero()) {
                manager.settle{ value: owe }();
            } else {
                manager.sync(currency);
                IERC20Min(Currency.unwrap(currency)).transferFrom(payer, address(manager), owe);
                manager.settle();
            }
        } else if (amount > 0) {
            manager.take(currency, payer, uint256(uint128(amount)));
        }
    }

    receive() external payable { }
}
