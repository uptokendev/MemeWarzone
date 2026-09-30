// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only ERC20 with configurable decimals (e.g. a 6-decimal USDG-like quote).
contract MockERC20Decimals is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply, address to) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _mint(to, supply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
