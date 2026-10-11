// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY. Plain fixed-supply ERC20: no tax, no hooks, no owner. Transfers are untaxed.
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MwzV4Token is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address to) ERC20(name_, symbol_) {
        _mint(to, supply);
    }
}
