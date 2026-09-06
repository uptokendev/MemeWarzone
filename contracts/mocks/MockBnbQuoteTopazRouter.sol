// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockTopazFactory} from "./MockTopazFactory.sol";
import {MockTopazPool} from "./MockTopazPool.sol";

interface IMockBnbQuoteWbnb {
    function deposit() external payable;
}

/// @dev Topaz-v2-shaped rehearsal router covering the extra token/token liquidity surface
/// required by approved BNB quote graduations. It intentionally mirrors the production
/// Solidly-style signatures rather than changing the existing native-only rehearsal mock.
contract MockBnbQuoteTopazRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    address private immutable _factory;
    address private immutable _wbnb;

    constructor(address factory_, address wbnb_) {
        _factory = factory_;
        _wbnb = wbnb_;
    }

    receive() external payable {}

    function defaultFactory() external view returns (address) {
        return _factory;
    }

    function poolFactory() external view returns (address) {
        return _factory;
    }

    function weth() external view returns (address) {
        return _wbnb;
    }

    function WETH() external view returns (address) {
        return _wbnb;
    }

    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory amounts) {
        require(routes.length == 1, "one hop");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = _quote(routes[0], amountIn);
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256
    ) external payable returns (uint256[] memory amounts) {
        require(routes.length == 1, "one hop");
        require(routes[0].from == _wbnb, "from WBNB");
        uint256 amountOut = _quote(routes[0], msg.value);
        require(amountOut >= amountOutMin, "slippage");

        IMockBnbQuoteWbnb(_wbnb).deposit{value: msg.value}();
        address pool = MockTopazFactory(_factory).getPool(routes[0].from, routes[0].to, routes[0].stable);
        MockTopazPool mockPool = MockTopazPool(pool);
        (uint112 r0, uint112 r1,) = mockPool.getReserves();
        bool fromIs0 = routes[0].from == mockPool.token0();
        if (fromIs0) mockPool.setReserves(uint112(uint256(r0) + msg.value), uint112(uint256(r1) - amountOut));
        else mockPool.setReserves(uint112(uint256(r0) - amountOut), uint112(uint256(r1) + msg.value));
        require(IERC20(routes[0].to).transfer(to, amountOut), "quote transfer");

        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = amountOut;
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(!stable, "volatile only");
        require(amountADesired >= amountAMin && amountBDesired >= amountBMin, "min");
        address pool = MockTopazFactory(_factory).getPool(tokenA, tokenB, false);
        if (pool == address(0)) pool = MockTopazFactory(_factory).createPool(tokenA, tokenB, false);

        require(IERC20(tokenA).transferFrom(msg.sender, pool, amountADesired), "tokenA transfer");
        require(IERC20(tokenB).transferFrom(msg.sender, pool, amountBDesired), "tokenB transfer");
        amountA = amountADesired;
        amountB = amountBDesired;
        liquidity = amountA + amountB;

        if (tokenA == MockTopazPool(pool).token0()) {
            MockTopazPool(pool).setReserves(uint112(amountA), uint112(amountB));
        } else {
            MockTopazPool(pool).setReserves(uint112(amountB), uint112(amountA));
        }
        MockTopazPool(pool).mint(to, liquidity);
    }

    function addLiquidityETH(
        address token,
        bool stable,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(!stable, "volatile only");
        require(amountTokenDesired >= amountTokenMin && msg.value >= amountETHMin, "min");
        address pool = MockTopazFactory(_factory).getPool(token, _wbnb, false);
        if (pool == address(0)) pool = MockTopazFactory(_factory).createPool(token, _wbnb, false);

        require(IERC20(token).transferFrom(msg.sender, pool, amountTokenDesired), "token transfer");
        IMockBnbQuoteWbnb(_wbnb).deposit{value: msg.value}();
        require(IERC20(_wbnb).transfer(pool, msg.value), "WBNB transfer");
        amountToken = amountTokenDesired;
        amountETH = msg.value;
        liquidity = amountToken + amountETH;

        if (token == MockTopazPool(pool).token0()) {
            MockTopazPool(pool).setReserves(uint112(amountToken), uint112(amountETH));
        } else {
            MockTopazPool(pool).setReserves(uint112(amountETH), uint112(amountToken));
        }
        MockTopazPool(pool).mint(to, liquidity);
    }

    function _quote(Route memory route, uint256 amountIn) private view returns (uint256) {
        require(route.factory == _factory, "factory");
        address pool = MockTopazFactory(_factory).getPool(route.from, route.to, route.stable);
        require(pool != address(0), "no pool");
        (uint112 r0, uint112 r1,) = MockTopazPool(pool).getReserves();
        bool fromIs0 = route.from == MockTopazPool(pool).token0();
        uint256 reserveIn = fromIs0 ? uint256(r0) : uint256(r1);
        uint256 reserveOut = fromIs0 ? uint256(r1) : uint256(r0);
        uint256 feeBps = MockTopazFactory(_factory).getFee(pool, route.stable);
        uint256 amountInAfterFee = amountIn - ((amountIn * feeBps) / 10_000);
        return (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
    }
}
