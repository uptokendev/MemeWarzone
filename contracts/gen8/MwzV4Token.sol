// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MwzV4Token (EVM generation 8)
/// @notice Plain fixed-supply ERC20: 18 decimals, 1B supply minted once to the launcher in the constructor. No owner,
/// no tax, no transfer hook, no blacklist, no pause, no mint after construction. Transfers are free from block one.
contract MwzV4Token is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address to) ERC20(name_, symbol_) {
        _mint(to, supply);
    }
}
