// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal Topaz v2 volatile pool mock for launch/graduation and LP-fee tests.
contract MockTopazPool is ERC20 {
    using SafeERC20 for IERC20;

    address public token0;
    address public token1;
    address public factory;
    bool public stable;
    uint112 private _r0;
    uint112 private _r1;
    uint32 private _ts;

    mapping(address => uint256) private _claimable0;
    mapping(address => uint256) private _claimable1;

    constructor() ERC20("Mock Topaz LP", "mTLP") {}

    function setTokens(address token0_, address token1_) external {
        _setTokens(token0_, token1_, false);
    }

    function setTokens(address token0_, address token1_, bool stable_) external {
        _setTokens(token0_, token1_, stable_);
    }

    function tokens() external view returns (address, address) {
        return (token0, token1);
    }

    function metadata()
        external
        view
        returns (uint256 decimals0, uint256 decimals1, uint256 reserve0, uint256 reserve1, bool stable_, address token0_, address token1_)
    {
        return (18, 18, _r0, _r1, stable, token0, token1);
    }

    function setTotalSupply(uint256 v) external {
        uint256 current = totalSupply();
        if (v > current) _mint(msg.sender, v - current);
        else if (v < current) _burn(msg.sender, current - v);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setReserves(uint112 r0, uint112 r1) external {
        _r0 = r0;
        _r1 = r1;
        _ts = uint32(block.timestamp);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_r0, _r1, _ts);
    }

    function claimable0(address account) external view returns (uint256) {
        return _claimable0[account];
    }

    function claimable1(address account) external view returns (uint256) {
        return _claimable1[account];
    }

    function fundFees(address account, uint256 amount0, uint256 amount1) external {
        if (amount0 != 0) {
            IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
            _claimable0[account] += amount0;
        }
        if (amount1 != 0) {
            IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
            _claimable1[account] += amount1;
        }
    }

    function claimFees() external {
        uint256 amount0 = _claimable0[msg.sender];
        uint256 amount1 = _claimable1[msg.sender];
        if (amount0 != 0) {
            _claimable0[msg.sender] = 0;
            IERC20(token0).safeTransfer(msg.sender, amount0);
        }
        if (amount1 != 0) {
            _claimable1[msg.sender] = 0;
            IERC20(token1).safeTransfer(msg.sender, amount1);
        }
    }

    /// @dev Test helper: name the Topaz factory this pool reports (the locker checks it at registration, E13).
    function setFactory(address factory_) external {
        factory = factory_;
    }

    function _setTokens(address token0_, address token1_, bool stable_) internal {
        token0 = token0_;
        token1 = token1_;
        stable = stable_;
        if (factory == address(0)) factory = msg.sender;
    }
}
