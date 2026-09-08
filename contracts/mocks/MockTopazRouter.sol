// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ITopazRouter02} from "../interfaces/ITopazRouter02.sol";
import {MockTopazFactory} from "./MockTopazFactory.sol";
import {MockTopazPool} from "./MockTopazPool.sol";

contract MockTopazRouter is ITopazRouter02 {
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address private immutable _poolFactory;
    address private immutable _wrapped;
    address public feeCollector;

    event LiquidityAdded(address indexed token, uint256 amountToken, uint256 amountETH, address indexed to);
    event TopazLiquidityAdded(address indexed token, bool stable, uint256 amountToken, uint256 amountETH, address indexed to);
    event TopazSwap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address indexed to);

    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    constructor(address poolFactory_, address wrapped_) {
        _poolFactory = poolFactory_;
        _wrapped = wrapped_;
    }

    receive() external payable {}

    function setFeeCollector(address collector) external {
        feeCollector = collector;
    }

    function factory() external view returns (address) {
        return _poolFactory;
    }

    function defaultFactory() external view returns (address) {
        return _poolFactory;
    }

    function poolFactory() external view override returns (address) {
        return _poolFactory;
    }

    function WETH() external view override returns (address) {
        return _wrapped;
    }

    function weth() external view returns (address) {
        return _wrapped;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address to,
        uint256
    )
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        (amountToken, amountETH, liquidity) = _addLiquidity(token, amountTokenDesired, to);
        _emitLiquidity(token, false, amountToken, amountETH, to, false);
    }

    function addLiquidityETH(
        address token,
        bool stable,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address to,
        uint256
    )
        external
        payable
        override
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        require(!stable, "stable pool unsupported");
        (amountToken, amountETH, liquidity) = _addLiquidity(token, amountTokenDesired, to);
        _emitLiquidity(token, stable, amountToken, amountETH, to, true);
    }

    function _addLiquidity(address token, uint256 amountTokenDesired, address to)
        internal
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        amountToken = amountTokenDesired;
        amountETH = msg.value;
        liquidity = amountTokenDesired + msg.value;

        address pool = MockTopazFactory(_poolFactory).getPool(token, _wrapped, false);
        if (pool == address(0)) pool = MockTopazFactory(_poolFactory).createPool(token, _wrapped, false);
        if (token < _wrapped) {
            MockTopazPool(pool).setReserves(uint112(amountTokenDesired), uint112(msg.value));
        } else {
            MockTopazPool(pool).setReserves(uint112(msg.value), uint112(amountTokenDesired));
        }
        MockTopazPool(pool).mint(to, liquidity);
    }

    function _emitLiquidity(address token, bool stable, uint256 amountToken, uint256 amountETH, address to, bool emitTopaz) internal {
        emit LiquidityAdded(token, amountToken, amountETH, to);
        if (emitTopaz) emit TopazLiquidityAdded(token, stable, amountToken, amountETH, to);

        if (to != DEAD) {
            emit LiquidityAdded(token, amountToken, amountETH, DEAD);
            if (emitTopaz) emit TopazLiquidityAdded(token, stable, amountToken, amountETH, DEAD);
        }
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
        require(routes[0].from == _wrapped, "from WBNB");
        uint256 amountOut = _quote(routes[0], msg.value);
        require(amountOut >= amountOutMin, "slippage");
        MockWBNBLike(_wrapped).deposit{value: msg.value}();
        _executeSwap(routes[0], msg.value, amountOut, to);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = amountOut;
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(routes.length == 1, "one hop");
        require(routes[0].to == _wrapped, "to WBNB");
        IERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = _quote(routes[0], amountIn);
        require(amountOut >= amountOutMin, "slippage");
        _executeSwap(routes[0], amountIn, amountOut, address(this));
        MockWBNBLike(_wrapped).withdraw(amountOut);
        (bool ok, ) = payable(to).call{value: amountOut}("");
        require(ok, "native out");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    function _quote(Route memory route, uint256 amountIn) internal view returns (uint256) {
        address pool = MockTopazFactory(_poolFactory).getPool(route.from, route.to, route.stable);
        require(pool != address(0), "no pool");
        (uint112 r0, uint112 r1, ) = MockTopazPool(pool).getReserves();
        bool fromIs0 = route.from == MockTopazPool(pool).token0();
        uint256 reserveIn = fromIs0 ? uint256(r0) : uint256(r1);
        uint256 reserveOut = fromIs0 ? uint256(r1) : uint256(r0);
        uint256 feeBps = MockTopazFactory(_poolFactory).getFee(pool, route.stable);
        require(feeBps < 10_000, "bad fee");
        uint256 amountInAfterFee = amountIn - ((amountIn * feeBps) / 10_000);
        return (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
    }

    function _executeSwap(Route memory route, uint256 amountIn, uint256 amountOut, address to) internal {
        address pool = MockTopazFactory(_poolFactory).getPool(route.from, route.to, route.stable);
        MockTopazPool mockPool = MockTopazPool(pool);
        (uint112 r0, uint112 r1, ) = mockPool.getReserves();
        bool fromIs0 = route.from == mockPool.token0();
        uint256 feeBps = MockTopazFactory(_poolFactory).getFee(pool, route.stable);
        require(feeBps < 10_000, "bad fee");
        uint256 fee = (amountIn * feeBps) / 10_000;
        if (fromIs0) mockPool.setReserves(uint112(uint256(r0) + amountIn), uint112(uint256(r1) - amountOut));
        else mockPool.setReserves(uint112(uint256(r0) - amountOut), uint112(uint256(r1) + amountIn));
        IERC20(route.to).transfer(to, amountOut);
        if (feeCollector != address(0) && fee != 0) {
            IERC20(route.from).approve(pool, fee);
            if (fromIs0) mockPool.fundFees(feeCollector, fee, 0);
            else mockPool.fundFees(feeCollector, 0, fee);
        }
        emit TopazSwap(route.from, route.to, amountIn, amountOut, to);
    }
}

interface MockWBNBLike {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}
