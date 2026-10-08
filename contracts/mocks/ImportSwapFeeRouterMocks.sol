// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only venues for ImportSwapFeeRouter: fixed-rate swaps (`tokensPerNative` token units per 1e18 native).
/// `takeBps` < 10000 makes a sell pull only part of the approved input, to prove the leftover check.

interface IMockWrapped is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

contract MockImportV2Router {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    address public immutable weth;
    address public immutable defaultFactory;
    uint256 public tokensPerNative;
    uint256 public takeBps = 10_000;
    bool public lastStable;
    address public lastFactory;

    constructor(address weth_, address factory_, uint256 tokensPerNative_) {
        weth = weth_;
        defaultFactory = factory_;
        tokensPerNative = tokensPerNative_;
    }

    receive() external payable {}

    function setTakeBps(uint256 v) external {
        takeBps = v;
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external payable {
        require(block.timestamp <= deadline, "deadline");
        require(routes.length == 1 && routes[0].from == weth, "route");
        lastStable = routes[0].stable;
        lastFactory = routes[0].factory;
        uint256 out = (msg.value * tokensPerNative) / 1e18;
        uint256 before = IERC20(routes[0].to).balanceOf(to);
        IERC20(routes[0].to).transfer(to, out);
        require(IERC20(routes[0].to).balanceOf(to) - before >= amountOutMin, "min");
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external {
        require(block.timestamp <= deadline, "deadline");
        require(routes.length == 1 && routes[0].to == weth, "route");
        lastStable = routes[0].stable;
        lastFactory = routes[0].factory;
        uint256 take = (amountIn * takeBps) / 10_000;
        uint256 before = IERC20(routes[0].from).balanceOf(address(this));
        IERC20(routes[0].from).transferFrom(msg.sender, address(this), take);
        uint256 got = IERC20(routes[0].from).balanceOf(address(this)) - before;
        uint256 out = (got * 1e18) / tokensPerNative;
        require(out >= amountOutMin, "min");
        (bool ok, ) = payable(to).call{value: out}("");
        require(ok, "eth");
    }
}

contract MockImportV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    address public immutable weth;
    uint256 public tokensPerNative;
    uint24 public lastFee;

    constructor(address weth_, uint256 tokensPerNative_) {
        weth = weth_;
        tokensPerNative = tokensPerNative_;
    }

    function fundWrapped() external payable {
        IMockWrapped(weth).deposit{value: msg.value}();
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        lastFee = p.fee;
        uint256 before = IERC20(p.tokenIn).balanceOf(address(this));
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        uint256 got = IERC20(p.tokenIn).balanceOf(address(this)) - before;
        out = p.tokenIn == weth ? (got * tokensPerNative) / 1e18 : (got * 1e18) / tokensPerNative;
        IERC20(p.tokenOut).transfer(p.recipient, out);
        require(out >= p.amountOutMinimum, "min");
    }
}

/// @dev A token whose transfer re-enters a target (the router) once, to prove the guard.
contract MockReenteringImportToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public reentered;
    bool public reentryReverted;

    constructor() ERC20("Reenter", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed) {
            armed = false;
            reentered = true;
            (bool ok, ) = target.call(payload);
            reentryReverted = !ok;
        }
    }
}

contract RevertingNativeReceiver {
    receive() external payable {
        revert("no native");
    }
}
