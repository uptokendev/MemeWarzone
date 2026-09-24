// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test double for the one LaunchFactory view the route script checks before
///      binding the stock adapter: the factory must name this adapter back.
contract MockStockFactoryPointer {
    address public stockGraduationAdapter;

    constructor(address adapter) {
        stockGraduationAdapter = adapter;
    }
}
