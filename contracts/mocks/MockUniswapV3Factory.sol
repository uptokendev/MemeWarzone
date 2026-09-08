// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

/// @dev Minimal Uniswap V3 factory surface for Robinhood Chain staging.
contract MockUniswapV3Factory {
    address public immutable owner;
    address public positionManager;
    address public swapRouter;

    mapping(bytes32 => address) private _pools;
    mapping(uint24 => int24) public feeAmountTickSpacing;

    event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool);
    event PeripheryConfigured(address indexed positionManager, address indexed swapRouter);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10000] = 200;
    }

    function configurePeriphery(address positionManager_, address swapRouter_) external onlyOwner {
        require(positionManager_ != address(0) && swapRouter_ != address(0), "zero periphery");
        require(positionManager == address(0) && swapRouter == address(0), "periphery already set");
        positionManager = positionManager_;
        swapRouter = swapRouter_;
        emit PeripheryConfigured(positionManager_, swapRouter_);
    }

    function getPool(address tokenA, address tokenB, uint24 fee_) external view returns (address pool) {
        pool = _pools[_key(tokenA, tokenB, fee_)];
    }

    function createPool(address tokenA, address tokenB, uint24 fee_) external returns (address pool) {
        require(tokenA != address(0) && tokenB != address(0), "zero token");
        require(tokenA != tokenB, "same token");
        int24 spacing = feeAmountTickSpacing[fee_];
        require(spacing != 0, "fee disabled");

        bytes32 key = _key(tokenA, tokenB, fee_);
        require(_pools[key] == address(0), "pool exists");

        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        MockUniswapV3Pool created = new MockUniswapV3Pool(token0, token1, fee_, spacing, address(this));
        pool = address(created);
        _pools[key] = pool;

        emit PoolCreated(token0, token1, fee_, spacing, pool);
    }

    function _key(address tokenA, address tokenB, uint24 fee_) internal pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(token0, token1, fee_));
    }
}
