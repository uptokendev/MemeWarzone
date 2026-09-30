// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockTopazPool} from "./MockTopazPool.sol";

interface IPairTokenSetter {
    function setTokens(address token0, address token1) external;
}

/// @dev Minimal Topaz v2 factory mock with stable/volatile pool separation.
contract MockTopazFactory {
    mapping(bytes32 => address) public pools;
    mapping(address => bool) public isPool;
    uint256 public feeBps = 30;
    address public implementation = address(this);

    function _key(address a, address b, bool stable) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b, stable)) : keccak256(abi.encodePacked(b, a, stable));
    }

    function setFeeBps(uint256 feeBps_) external {
        feeBps = feeBps_;
    }

    function getFee(address, bool) external view returns (uint256) {
        return feeBps;
    }

    function setImplementation(address implementation_) external {
        implementation = implementation_;
    }

    function setPool(address tokenA, address tokenB, bool stable, address pool) external {
        pools[_key(tokenA, tokenB, stable)] = pool;
        isPool[pool] = true;
        MockTopazPool(pool).setTokens(tokenA < tokenB ? tokenA : tokenB, tokenA < tokenB ? tokenB : tokenA, stable);
    }

    function setPair(address tokenA, address tokenB, address pair) external {
        pools[_key(tokenA, tokenB, false)] = pair;
        isPool[pair] = true;
        IPairTokenSetter(pair).setTokens(tokenA < tokenB ? tokenA : tokenB, tokenA < tokenB ? tokenB : tokenA);
    }

    function createPool(address tokenA, address tokenB, bool stable) external returns (address pool) {
        bytes32 key = _key(tokenA, tokenB, stable);
        pool = pools[key];
        if (pool != address(0)) return pool;
        MockTopazPool created = new MockTopazPool();
        created.setTokens(tokenA < tokenB ? tokenA : tokenB, tokenA < tokenB ? tokenB : tokenA, stable);
        pool = address(created);
        pools[key] = pool;
        isPool[pool] = true;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        return this.createPool(tokenA, tokenB, false);
    }

    function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool) {
        return pools[_key(tokenA, tokenB, stable)];
    }

    function getPair(address tokenA, address tokenB) external view returns (address pair) {
        return pools[_key(tokenA, tokenB, false)];
    }
}
