// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY. Test actors for the Barkswap plugin fork proof.

import {IAlgebraPoolMin, IERC20Min} from "./BarkInterfaces.sol";

/// An outsider minting straight into a pool (no NPM), paying from its own balance.
contract DirectMinter {
    function mint(address pool, int24 bottom, int24 top, uint128 liq) external returns (uint256 a0, uint256 a1) {
        (a0, a1, ) = IAlgebraPoolMin(pool).mint(address(this), address(this), bottom, top, liq, abi.encode(pool));
    }

    function algebraMintCallback(uint256 a0, uint256 a1, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "pool");
        if (a0 > 0) IERC20Min(IAlgebraPoolMin(pool).token0()).transfer(pool, a0);
        if (a1 > 0) IERC20Min(IAlgebraPoolMin(pool).token1()).transfer(pool, a1);
    }
}

/// A direct pool trader (no router): exact input, pays from the caller's allowance.
contract DirectSwapper {
    address private _pool;
    address private _payer;

    function swap(address pool, bool zeroToOne, int256 amountIn, uint160 limit) external returns (int256 a0, int256 a1) {
        _pool = pool;
        _payer = msg.sender;
        (a0, a1) = IAlgebraPoolMin(pool).swap(msg.sender, zeroToOne, amountIn, limit, "");
        _pool = address(0);
    }

    function algebraSwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == _pool, "pool");
        if (d0 > 0) IERC20Min(IAlgebraPoolMin(msg.sender).token0()).transferFrom(_payer, msg.sender, uint256(d0));
        if (d1 > 0) IERC20Min(IAlgebraPoolMin(msg.sender).token1()).transferFrom(_payer, msg.sender, uint256(d1));
    }
}
